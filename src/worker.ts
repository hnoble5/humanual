import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { CRISIS_SYSTEM_NOTE, crisisCheck } from "./crisis";
import { buildSystem, COACHES, MODES, turnReminder, type CoachId, type ModeId, type Profile, type Style } from "./prompt";
import { CHANNELS, ScriptSchema, scriptRequest, type ChannelId } from "./script";
import { authMode, getUserId } from "./auth";
import { deleteAll, sync, SyncError } from "./storage";

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

function str(v: unknown, max: number, name: string): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new BadRequest(`${name} must be text`);
  if (v.length > max) throw new BadRequest(`${name} is too long`);
  return v;
}

// Fields shared by every endpoint: who's coaching, how, and who they're coaching.
function parseCommon(body: any) {
  if (!body || typeof body !== "object") throw new BadRequest("Invalid request");
  if (!(body.coach in COACHES)) throw new BadRequest("Unknown coach");
  if (body.style !== "direct" && body.style !== "gentle") throw new BadRequest("Unknown style");
  const p = body.profile ?? {};
  const profile: Profile = {
    name: str(p.name, 100, "Name"),
    about: str(p.about, MAX_PROFILE_CHARS, "About you"),
    work: str(p.work, MAX_PROFILE_CHARS, "Work"),
    people: str(p.people, MAX_PROFILE_CHARS, "People"),
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
  if (body.mode !== null && !(body.mode in MODES)) throw new BadRequest("Unknown mode");

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

const ACCESS_ERROR = { error: "Enter the access code in Settings to use the coach.", code: "access" };
const SIGNIN_ERROR = { error: "Please sign in again.", code: "signin" };

/**
 * Checks the access code and, once sign-in is set up, that the request is
 * signed in. Returns the user id (null while sign-in isn't configured), or the
 * error response to send.
 */
async function guard(request: Request, env: Env): Promise<{ userId: string | null } | Response> {
  if (env.ACCESS_CODE && request.headers.get("x-access-code") !== env.ACCESS_CODE) {
    return json(ACCESS_ERROR, 401);
  }
  if (authMode(request, env) === "none") return { userId: null };
  const userId = await getUserId(request, env);
  return userId ? { userId } : json(SIGNIN_ERROR, 401);
}

async function guardModel(request: Request, env: Env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "The server's API key isn't set up yet." }, 500);
  return guard(request, env);
}

async function handleSync(request: Request, env: Env): Promise<Response> {
  if (authMode(request, env) === "none") return json({ error: "Sync isn't set up on this server." }, 501);
  const auth = await guard(request, env);
  if (auth instanceof Response) return auth;
  const userId = auth.userId!;

  if (request.method === "DELETE") {
    await deleteAll(env.DB, userId);
    return json({ ok: true });
  }
  try {
    return json(await sync(env.DB, userId, await request.json()));
  } catch (err) {
    if (err instanceof SyncError) return json({ error: err.message }, 400);
    if (err instanceof SyntaxError) return json({ error: "Invalid request" }, 400);
    console.error("sync failed", err);
    return json({ error: "Couldn't sync right now. Your changes are kept on this device." }, 500);
  }
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  const auth = await guardModel(request, env);
  if (auth instanceof Response) return auth;

  let req: ChatRequest;
  try {
    req = parseRequest(await request.json());
  } catch (err) {
    return json({ error: err instanceof BadRequest ? err.message : "Invalid request" }, 400);
  }

  const latest = req.messages[req.messages.length - 1].content;
  const crisis = crisisCheck(latest);

  // The per-turn reminder (and crisis note, when flagged) goes after the latest
  // user message, where it has the most pull. It's never saved in history.
  const messages: BetaMessageParam[] = [
    ...req.messages,
    { role: "system", content: crisis ? `${CRISIS_SYSTEM_NOTE}

${turnReminder(req)}` : turnReminder(req) },
  ];

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium" },
    // Caches the whole prefix (system + history) so each new turn only pays for what's new.
    cache_control: { type: "ephemeral" },
    // If a safety classifier declines, retry server-side on Anthropic's recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: buildSystem(req),
    messages,
  });

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const send = (event: object) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        if (crisis) send({ t: "crisis" });
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            send({ t: "text", v: event.delta.text });
          }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === "refusal") {
          send({ t: "refusal" });
        } else {
          send({ t: "done", stop: final.stop_reason });
        }
      } catch (err) {
        if (!stream.aborted) {
          console.error("chat stream failed", err);
          send({ t: "error", message: friendlyError(err) });
        }
      } finally {
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

  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function handleScript(request: Request, env: Env): Promise<Response> {
  const auth = await guardModel(request, env);
  if (auth instanceof Response) return auth;

  let req;
  try {
    const body: any = await request.json();
    const common = parseCommon(body);
    if (!(body.channel in CHANNELS)) throw new BadRequest("Pick where this happens");
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
      system: buildSystem({ ...req, mode: "everyday" }),
      messages: [{ role: "user", content: scriptRequest(req.channel, req.task, req.details) }],
    });
    if (response.stop_reason === "refusal") {
      return json({ error: "The coach couldn't write a script for that one. Try rewording it." }, 422);
    }
    if (!response.parsed_output) return json({ error: "The script came back incomplete. Try again." }, 502);
    return json({ script: response.parsed_output });
  } catch (err) {
    console.error("script failed", err);
    return json({ error: friendlyError(err) }, 502);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return handleChat(request, env);
    }
    if (url.pathname === "/api/script") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return handleScript(request, env);
    }
    if (url.pathname === "/api/sync") {
      if (request.method !== "POST" && request.method !== "DELETE") return json({ error: "Method not allowed" }, 405);
      return handleSync(request, env);
    }
    if (url.pathname === "/api/config") {
      const auth = authMode(request, env);
      return json({
        accessCodeRequired: Boolean(env.ACCESS_CODE),
        auth,
        clerkPublishableKey: auth === "clerk" ? env.CLERK_PUBLISHABLE_KEY : undefined,
      });
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
