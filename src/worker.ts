import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { CRISIS_SYSTEM_NOTE, crisisCheck } from "./crisis";
import { buildSystem, COACHES, MODES, turnReminder, type CoachId, type ModeId, type Profile, type Style } from "./prompt";
import { CHANNELS, ScriptSchema, scriptRequest, type ChannelId } from "./script";
import { JournalSchema, journalRequest } from "./journal";
import { MAX_MEMORIES, MAX_MEMORY_CHARS, MEMORY_SYSTEM, MemorySchema, memoryRequest } from "./memory";
import { authMode, getUserId } from "./auth";
import { deleteAll, StorageFullError, sync, SyncError } from "./storage";
import { anthropicUserId, costMicros, monthlyLimitMicros, recordUsage, spentThisMonth, type TokenUsage } from "./usage";
import {
  guestCookie,
  guestIdFrom,
  guestKeys,
  guestMessageLimit,
  guestMessagesLeft,
  GUEST_MAX_CHARS,
  GUEST_MAX_MESSAGES,
  GUEST_MAX_TOKENS,
  refundGuestMessage,
  reserveGuestMessage,
  settleGuestCost,
  type GuestKeys,
} from "./guest";

// Model rule: anything that works with the user's personal details (their
// profile, situations, people, memory) uses Opus, for quality. Only work that
// never sees personal details may use Sonnet. Today every AI call is personal:
// chat, scripts, journal, and memory updates.
const MODEL = "claude-opus-5-5";
const MAX_MESSAGES = 120;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_PROFILE_CHARS = 4_000;

interface ChatRequest {
  coach: CoachId;
  style: Style;
  mode: ModeId | null;
  profile: Profile;
  today: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

class BadRequest extends Error {}

// Own keys only: `"constructor" in COACHES` is true, and would crash later.
const isKey = (obj: object, key: unknown): boolean => typeof key === "string" && Object.hasOwn(obj, key);

function str(v: unknown, max: number, name: string): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new BadRequest(`${name} must be text`);
  if (v.length > max) throw new BadRequest(`${name} is too long`);
  return v;
}

function parseMemory(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_MEMORIES * 2) throw new BadRequest("Invalid memory");
  return v.map((m) => str(m, MAX_MEMORY_CHARS * 2, "Memory").trim()).filter(Boolean);
}

// Fields shared by every endpoint: who's coaching, how, and who they're coaching.
function parseCommon(body: any) {
  if (!body || typeof body !== "object") throw new BadRequest("Invalid request");
  if (!isKey(COACHES, body.coach)) throw new BadRequest("Unknown coach");
  if (body.style !== "direct" && body.style !== "gentle") throw new BadRequest("Unknown style");
  const p = body.profile ?? {};
  const profile: Profile = {
    name: str(p.name, 100, "Name"),
    about: str(p.about, MAX_PROFILE_CHARS, "About you"),
    work: str(p.work, MAX_PROFILE_CHARS, "Work"),
    people: str(p.people, MAX_PROFILE_CHARS, "People"),
    memory: parseMemory(p.memory),
  };
  return {
    coach: body.coach as CoachId,
    style: body.style as Style,
    profile,
    today: str(body.today, 60, "Date") || new Date().toDateString(),
  };
}

function parseRequest(body: any): ChatRequest {
  const common = parseCommon(body);
  if (body.mode !== null && !isKey(MODES, body.mode)) throw new BadRequest("Unknown mode");

  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) throw new BadRequest("No messages");
  if (msgs.length > MAX_MESSAGES) {
    throw new BadRequest("This conversation is too long. Start a new one to keep going.");
  }
  const messages = msgs.map((m: any, i: number) => {
    const role = i % 2 === 0 ? "user" : "assistant";
    if (m?.role !== role) throw new BadRequest("Messages must alternate, starting with you");
    const content = str(m.content, MAX_MESSAGE_CHARS, "Message");
    if (!content.trim()) throw new BadRequest("Empty message");
    return { role, content } as const;
  });
  if (messages[messages.length - 1].role !== "user") throw new BadRequest("Last message must be yours");

  return { ...common, mode: body.mode, messages };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function friendlyError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The server's API key isn't set up correctly.";
  if (err instanceof Anthropic.RateLimitError) return "The coach is busy right now. Try again in a minute.";
  if (err instanceof Anthropic.BadRequestError) return "The coach couldn't process that request.";
  if (err instanceof Anthropic.InternalServerError) return "The coach service had a hiccup. Try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the coach service. Try again.";
  return "Something went wrong. Try again.";
}

const SIGNIN_ERROR = { error: "Please sign in again.", code: "signin" };

/**
 * True when this address serves the full app: one of APP_HOSTS (set in
 * wrangler.jsonc), or localhost for development. Those hosts sit behind
 * Cloudflare Access, which decides who gets in. Every other address (the
 * public demo at coach.) gets no AI at all, so nobody can spend the API credit
 * from outside.
 */
function isAppHost(request: Request, env: Env) {
  const host = new URL(request.url).hostname;
  if (host === "localhost" || host === "127.0.0.1") return true;
  return (env.APP_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean).includes(host);
}

/** Sync needs a signed-in user. Returns their id, or the error response to send. */
async function requireUser(request: Request, env: Env): Promise<{ userId: string } | Response> {
  const userId = await getUserId(request, env);
  return userId ? { userId } : json(SIGNIN_ERROR, 401);
}

/** Who a coach call is for: their sign-in id, and the hashed id Anthropic sees. */
interface ModelUser {
  userId: string;
  metadata: { user_id: string };
  /** Set for a guest on the free trial (src/guest.ts). isNew: the browser needs its cookie. */
  guest?: { id: string; isNew: boolean };
}

const COACH_SIGNIN_ERROR = { error: "Sign in to talk with the coach.", code: "signin" };
const LIMIT_ERROR = {
  error: "You've used this month's coaching. It resets on the 1st.",
  code: "limit",
};

/**
 * A request with no sign-in at all, on an endpoint guests may use, while the
 * guest trial is on. A sign-in that was sent but didn't check out is not a
 * guest: that person needs to sign in again.
 */
async function guestUser(request: Request, env: Env): Promise<ModelUser | null> {
  if (request.headers.get("authorization")?.trim() || request.headers.get("x-dev-user")?.trim()) return null;
  if (!env.DB || !guestMessageLimit(env)) return null;
  const existing = guestIdFrom(request);
  const id = existing ?? crypto.randomUUID();
  const userId = `guest:${id}`;
  return { userId, metadata: { user_id: await anthropicUserId(userId) }, guest: { id, isNew: !existing } };
}

/**
 * The coach endpoints: app hosts only, signed-in users only, and only while the
 * user is under their monthly allowance. Every AI call is tied to one account,
 * so usage can be tracked, capped and (later) billed per user. Two exceptions:
 * coach chat lets guests try a few messages (src/guest.ts; their limits are
 * checked once the message is read), and local development with no sign-in
 * set up at all runs as a single "local" user.
 */
async function guardModel(
  request: Request,
  env: Env,
  { allowGuest = false } = {},
): Promise<ModelUser | Response> {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "The server's API key isn't set up yet." }, 500);
  if (!isAppHost(request, env)) return json({ error: "The coach only answers in the Humanual app." }, 403);

  let userId: string | null;
  if (authMode(request, env) === "none") {
    const host = new URL(request.url).hostname;
    if (host !== "localhost" && host !== "127.0.0.1") {
      return json({ error: "Sign-in isn't set up on this server, so the coach is off." }, 501);
    }
    userId = "local";
  } else {
    userId = await getUserId(request, env);
    if (!userId) {
      const guest = allowGuest ? await guestUser(request, env) : null;
      return guest ?? json(COACH_SIGNIN_ERROR, 401);
    }
  }

  if (env.DB && (await spentThisMonth(env.DB, userId)) >= monthlyLimitMicros(env)) {
    return json(LIMIT_ERROR, 429);
  }
  return { userId, metadata: { user_id: await anthropicUserId(userId) } };
}

/**
 * Adds a response's tokens to the user's monthly total (or, for a guest, to the
 * guest trial's totals). Never fails the reply.
 */
async function track(env: Env, user: ModelUser, usage: TokenUsage | null | undefined) {
  if (!env.DB || !usage) return;
  try {
    await recordUsage(env.DB, user.userId, usage);
  } catch (err) {
    console.error("usage record failed", err);
  }
}

async function handleSync(request: Request, env: Env): Promise<Response> {
  if (authMode(request, env) === "none") return json({ error: "Sync isn't set up on this server." }, 501);
  if (!isAppHost(request, env)) return json({ error: "Sync only works in the Humanual app." }, 403);
  const auth = await requireUser(request, env);
  if (auth instanceof Response) return auth;
  const userId = auth.userId;

  if (request.method === "DELETE") {
    await deleteAll(env.DB, userId);
    return json({ ok: true });
  }
  try {
    return json(await sync(env.DB, userId, await request.json()));
  } catch (err) {
    if (err instanceof StorageFullError) return json({ error: err.message, code: "full" }, 413);
    if (err instanceof SyncError) return json({ error: err.message }, 400);
    if (err instanceof SyntaxError) return json({ error: "Invalid request" }, 400);
    console.error("sync failed", err);
    return json({ error: "Couldn't sync right now. Your changes are kept on this device." }, 500);
  }
}

/** Why a guest's message wasn't answered, with a way forward. */
function guestBlocked(reason: "used" | "busy", env: Env, crisis: boolean, user: ModelUser): Response {
  const error =
    reason === "used"
      ? `You've used your ${guestMessageLimit(env)} free coach messages. Create a free account to keep talking with the coach. Your conversations come with you.`
      : "The free trial is full right now. Create a free account to keep talking with the coach.";
  const res = json(
    crisis
      ? { error: `If you're in crisis or thinking about hurting yourself, call or text 988 (US) now. ${error}`, code: "guest_limit", crisis: true }
      : { error, code: "guest_limit" },
    429,
  );
  if (user.guest?.isNew) res.headers.append("set-cookie", guestCookie(user.guest.id));
  return res;
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  const user = await guardModel(request, env, { allowGuest: true });
  if (user instanceof Response) return user;

  // Guests have no sign-in token, so make sure the request comes from the app
  // itself: JSON (which another site can't send without the browser asking
  // first) and, when the browser says, from this same address.
  if (user.guest) {
    const origin = request.headers.get("origin");
    const jsonBody = (request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
    if (!jsonBody || (origin && origin !== new URL(request.url).origin)) return json({ error: "Invalid request" }, 403);
  }

  let req: ChatRequest;
  try {
    req = parseRequest(await request.json());
  } catch (err) {
    return json({ error: err instanceof BadRequest ? err.message : "Invalid request" }, 400);
  }

  const latest = req.messages[req.messages.length - 1].content;
  const crisis = crisisCheck(latest);
  const system = buildSystem(req);
  const reminder = turnReminder(req);

  // Guests: count this message against the free trial before the AI runs.
  let keys: GuestKeys | null = null;
  let guestLeft = 0;
  let estimate = 0;
  if (user.guest) {
    const chars = req.messages.reduce((n, m) => n + m.content.length, 0);
    if (req.messages.length > GUEST_MAX_MESSAGES || chars > GUEST_MAX_CHARS) {
      return json(
        { error: "That's longer than the free trial allows. Start a new conversation, or create a free account for longer ones.", code: "guest_long" },
        413,
      );
    }
    // The most this reply could cost: everything sent as a fresh cache write
    // (about 3 characters per token, generously) plus a full-length reply.
    const inputChars = chars + JSON.stringify(system).length + reminder.length + CRISIS_SYSTEM_NOTE.length;
    estimate = costMicros({ cache_creation_input_tokens: Math.ceil(inputChars / 3), output_tokens: GUEST_MAX_TOKENS });
    try {
      keys = await guestKeys(request, user.guest.id);
      const reserved = await reserveGuestMessage(env.DB, env, keys, { crisis, estimate });
      if (!reserved.ok) return guestBlocked(reserved.reason, env, crisis, user);
      guestLeft = reserved.left;
    } catch (err) {
      // The trial's table isn't there (migration not applied yet) or D1 is down:
      // behave as before the trial existed.
      console.error("guest trial check failed", err);
      return json(COACH_SIGNIN_ERROR, 401);
    }
  }

  // The per-turn reminder (and crisis note, when flagged) goes after the latest
  // user message, where it has the most pull. It's never saved in history.
  const messages: BetaMessageParam[] = [
    ...req.messages,
    { role: "system", content: crisis ? `${CRISIS_SYSTEM_NOTE}

${reminder}` : reminder },
  ];

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: user.guest ? GUEST_MAX_TOKENS : 16000,
    output_config: { effort: "medium" },
    // Caches the whole prefix (system + history) so each new turn only pays for what's new.
    cache_control: { type: "ephemeral" },
    // If a safety classifier declines, retry server-side on Anthropic's recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    metadata: user.metadata,
    system,
    messages,
  });

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const send = (event: object) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      // Token counts as the stream reports them, so usage is still recorded
      // when the browser disconnects partway (the tokens are billed either way).
      const usage: TokenUsage = {};
      const merge = (u: TokenUsage | null | undefined) => {
        for (const [k, v] of Object.entries(u ?? {})) if (typeof v === "number") (usage as any)[k] = v;
      };
      let said = false; // any text sent: a guest keeps the message counted
      try {
        if (keys) send({ t: "guest", left: guestLeft });
        if (crisis) send({ t: "crisis" });
        for await (const event of stream) {
          if (event.type === "message_start") merge(event.message.usage);
          else if (event.type === "message_delta") merge(event.usage);
          else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            said = true;
            send({ t: "text", v: event.delta.text });
          }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === "refusal") {
          send({ t: "refusal" });
          // No answer, so a guest doesn't lose a free message for it.
          if (keys && !said) await refundGuestMessage(env.DB, keys).catch(() => {});
        } else {
          send({ t: "done", stop: final.stop_reason });
        }
      } catch (err) {
        if (!stream.aborted) {
          console.error("chat stream failed", err);
          send({ t: "error", message: friendlyError(err) });
          // The coach failed before saying anything: don't use up a free message.
          if (keys && !said) await refundGuestMessage(env.DB, keys).catch(() => {});
        }
      } finally {
        // Before closing: once the response ends, the Worker may stop running.
        if (keys) {
          // Swap the guest's up-front estimate for the real cost (0 if the
          // call never got going).
          await settleGuestCost(env.DB, keys, estimate, costMicros(usage)).catch((err) =>
            console.error("guest cost record failed", err),
          );
        } else if (Object.keys(usage).length) {
          await track(env, user, usage);
        }
        try {
          controller.close();
        } catch {
          // already closed because the browser disconnected
        }
      }
    },
    cancel() {
      stream.abort();
    },
  });

  const headers = new Headers({
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
  });
  if (user.guest?.isNew) headers.append("set-cookie", guestCookie(user.guest.id));
  return new Response(body, { headers });
}

async function handleScript(request: Request, env: Env): Promise<Response> {
  const user = await guardModel(request, env);
  if (user instanceof Response) return user;

  let req;
  try {
    const body: any = await request.json();
    const common = parseCommon(body);
    if (!isKey(CHANNELS, body.channel)) throw new BadRequest("Pick where this happens");
    const task = str(body.task, 2_000, "What you need to do").trim();
    if (!task) throw new BadRequest("Describe what you need to do");
    req = { ...common, channel: body.channel as ChannelId, task, details: str(body.details, 4_000, "Details").trim() };
  } catch (err) {
    return json({ error: err instanceof BadRequest ? err.message : "Invalid request" }, 400);
  }

  // A script card is the wrong tool for a crisis: send them to help and to the coach chat.
  if (crisisCheck(`${req.task}\n${req.details}`)) return json({ crisis: true });

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  try {
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium", format: betaZodOutputFormat(ScriptSchema) },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      metadata: user.metadata,
      system: buildSystem({ ...req, mode: "everyday" }),
      messages: [{ role: "user", content: scriptRequest(req.channel, req.task, req.details) }],
    });
    await track(env, user, response.usage);
    if (response.stop_reason === "refusal") {
      return json({ error: "The coach couldn't write a script for that one. Try rewording it." }, 422);
    }
    if (!response.parsed_output) return json({ error: "The script came back incomplete. Try again." }, 502);
    const { safety_concern, ...script } = response.parsed_output;
    if (safety_concern) return json({ crisis: true });
    return json({ script });
  } catch (err) {
    console.error("script failed", err);
    return json({ error: friendlyError(err) }, 502);
  }
}

async function handleJournal(request: Request, env: Env): Promise<Response> {
  const user = await guardModel(request, env);
  if (user instanceof Response) return user;

  let req;
  try {
    const body: any = await request.json();
    const common = parseCommon(body);
    const text = str(body.text, 8_000, "Journal entry").trim();
    if (!text) throw new BadRequest("Write something first");
    req = { ...common, text, replaying: str(body.replaying, 1_000, "What you keep replaying").trim() };
  } catch (err) {
    return json({ error: err instanceof BadRequest ? err.message : "Invalid request" }, 400);
  }

  // A journal card is the wrong reply to a crisis: send them to help and to the coach chat.
  if (crisisCheck(`${req.text}\n${req.replaying}`)) return json({ crisis: true });

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  try {
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium", format: betaZodOutputFormat(JournalSchema) },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      metadata: user.metadata,
      system: buildSystem({ ...req, mode: "journal" }),
      messages: [{ role: "user", content: journalRequest(req.text, req.replaying) }],
    });
    await track(env, user, response.usage);
    if (response.stop_reason === "refusal") {
      return json({ error: "The coach couldn't reply to that one. Try rewording it." }, 422);
    }
    if (!response.parsed_output) return json({ error: "The reply came back incomplete. Try again." }, 502);
    const { safety_concern, ...card } = response.parsed_output;
    if (safety_concern) return json({ crisis: true });
    return json({ card });
  } catch (err) {
    console.error("journal failed", err);
    return json({ error: friendlyError(err) }, 502);
  }
}

// Updates the list of things the coach remembers after a chat reply or journal entry.
async function handleRemember(request: Request, env: Env): Promise<Response> {
  const user = await guardModel(request, env);
  if (user instanceof Response) return user;

  let memories: string[], exchange: string, today: string;
  try {
    const body: any = await request.json();
    memories = parseMemory(body?.memory);
    exchange = str(body?.exchange, 30_000, "Exchange").trim();
    if (!exchange) throw new BadRequest("Nothing to remember");
    today = str(body?.today, 60, "Date") || new Date().toDateString();
  } catch (err) {
    return json({ error: err instanceof BadRequest ? err.message : "Invalid request" }, 400);
  }

  // Crisis exchanges never go into memory. The app already skips them; this is
  // the backstop. A false positive only means one exchange isn't remembered.
  if (crisisCheck(exchange)) return json({ memory: memories });

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  try {
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "low", format: betaZodOutputFormat(MemorySchema) },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      metadata: user.metadata,
      system: MEMORY_SYSTEM,
      messages: [{ role: "user", content: memoryRequest(memories, exchange, today) }],
    });
    await track(env, user, response.usage);
    if (response.stop_reason === "refusal" || !response.parsed_output) return json({ memory: memories });
    const updated = response.parsed_output.memories
      .map((m) => m.trim().slice(0, MAX_MEMORY_CHARS))
      .filter(Boolean)
      .slice(0, MAX_MEMORIES);
    return json({ memory: updated });
  } catch (err) {
    console.error("remember failed", err);
    return json({ error: friendlyError(err) }, 502);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      // Anything unexpected still gets a JSON reply the app can show.
      console.error("unhandled error", err);
      return json({ error: "Something went wrong. Try again." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Addresses that only redirect: www, and where Humanual lived before it had
 * its own domain. Old links and installed apps keep working.
 */
const MOVED_HOSTS: Record<string, string> = {
  "www.humanual.app": "humanual.app",
  "humanual.elitetestautomation.com": "humanual.app",
  "coach.elitetestautomation.com": "demo.humanual.app",
};

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const movedTo = MOVED_HOSTS[url.hostname];
  if (movedTo) {
    url.hostname = movedTo;
    // 308 keeps the method and body, so a stray API call isn't turned into a GET.
    return Response.redirect(url.toString(), request.method === "GET" || request.method === "HEAD" ? 301 : 308);
  }
  if (url.pathname === "/api/chat") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    return handleChat(request, env);
  }
  if (url.pathname === "/api/script") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    return handleScript(request, env);
  }
  if (url.pathname === "/api/remember") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    return handleRemember(request, env);
  }
  if (url.pathname === "/api/journal") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    return handleJournal(request, env);
  }
  if (url.pathname === "/api/sync") {
    if (request.method !== "POST" && request.method !== "DELETE") return json({ error: "Method not allowed" }, 405);
    return handleSync(request, env);
  }
  if (url.pathname === "/api/config") {
    const auth = authMode(request, env);
    const fullApp = isAppHost(request, env);
    // The guest trial: how many free coach messages guests get, and how many
    // this browser has left. 0 when it's off (or its table isn't set up yet).
    let guestMessages = 0;
    let guestLeft = 0;
    if (fullApp && auth !== "none" && env.DB) {
      try {
        guestMessages = guestMessageLimit(env);
        guestLeft = await guestMessagesLeft(env.DB, env, guestIdFrom(request));
      } catch (err) {
        console.error("guest trial lookup failed", err);
        guestMessages = guestLeft = 0;
      }
    }
    return json({
      // false on the public demo address: the app sends visitors to /demo.
      fullApp,
      auth,
      clerkPublishableKey: auth === "clerk" ? env.CLERK_PUBLISHABLE_KEY : undefined,
      guestMessages,
      guestLeft,
    });
  }
  if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
  return env.ASSETS.fetch(request);
}
