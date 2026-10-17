// The guest trial: people who haven't made an account can send a few coach
// chat messages before signing up. Only coach chat is open to guests; scripts,
// journal and memory still need an account.
//
// The count lives on the server, keyed by a random id in a cookie, so clearing
// the page's saved data doesn't reset it. A guest who also clears cookies gets
// a new id, so two backstops keep anonymous use from running up the API bill:
//  - a daily message cap per network (IP address, stored only as a hash)
//  - a daily spending cap across all guests together
// Settings (wrangler.jsonc vars): GUEST_MESSAGE_LIMIT, GUEST_IP_DAILY_MESSAGES,
// GUEST_DAILY_LIMIT_USD. GUEST_MESSAGE_LIMIT "0" turns the trial off.

export const GUEST_COOKIE = "hm_guest";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const GUEST_DEFAULTS = { messages: 5, ipPerDay: 15, dailyUsd: 2 } as const;

/**
 * Size limits on one guest request, so a single message can't cost much: a
 * short conversation, a modest amount of text, and a shorter reply budget
 * (coach replies are under ~120 words, so this still leaves room to think).
 */
export const GUEST_MAX_MESSAGES = 12;
export const GUEST_MAX_CHARS = 12_000;
export const GUEST_MAX_TOKENS = 6_000;

type GuestEnv = {
  GUEST_MESSAGE_LIMIT?: string;
  GUEST_IP_DAILY_MESSAGES?: string;
  GUEST_DAILY_LIMIT_USD?: string;
};

/** A non-negative whole number from a setting, or the fallback when missing or invalid. */
function count(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Free coach messages per guest. 0 means the trial is off. */
export const guestMessageLimit = (env: GuestEnv) => count(env.GUEST_MESSAGE_LIMIT, GUEST_DEFAULTS.messages);
/** Guest messages per network per day. */
export const guestIpDailyLimit = (env: GuestEnv) => count(env.GUEST_IP_DAILY_MESSAGES, GUEST_DEFAULTS.ipPerDay);
/** What all guests together may cost per day, in micro-dollars. */
export function guestDailyLimitMicros(env: GuestEnv): number {
  const usd = Number(env.GUEST_DAILY_LIMIT_USD);
  const ok = env.GUEST_DAILY_LIMIT_USD !== undefined && env.GUEST_DAILY_LIMIT_USD !== "" && Number.isFinite(usd) && usd >= 0;
  return Math.round((ok ? usd : GUEST_DEFAULTS.dailyUsd) * 1_000_000);
}

/** The UTC day a moment falls in: "2026-10-17". */
export const dayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** The guest id from the request's cookie, or null if there isn't a valid one. */
export function guestIdFrom(request: Request): string | null {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === GUEST_COOKIE) {
      const id = rest.join("=").trim().toLowerCase();
      return ID_PATTERN.test(id) ? id : null;
    }
  }
  return null;
}

/** The Set-Cookie value that gives a browser its guest id. */
export function guestCookie(id: string): string {
  return `${GUEST_COOKIE}=${id}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The three counters one guest message adds to. */
export async function guestKeys(request: Request, guestId: string, now = Date.now()) {
  const day = dayKey(now);
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  return {
    guest: `guest:${guestId}`,
    ip: `ip:${(await sha256(`humanual-ip:${ip}`)).slice(0, 32)}:${day}`,
    day: `day:${day}`,
  };
}
export type GuestKeys = Awaited<ReturnType<typeof guestKeys>>;

async function read(db: D1Database, keys: string[]): Promise<Map<string, { messages: number; cost_micros: number }>> {
  const { results } = await db
    .prepare(`SELECT key, messages, cost_micros FROM guest_usage WHERE key IN (${keys.map(() => "?").join(", ")})`)
    .bind(...keys)
    .all<{ key: string; messages: number; cost_micros: number }>();
  return new Map(results.map((r) => [r.key, r]));
}

/** Free messages this guest has left (for the page to show before they chat). */
export async function guestMessagesLeft(db: D1Database, env: GuestEnv, guestId: string | null): Promise<number> {
  const limit = guestMessageLimit(env);
  if (!limit) return 0;
  // Always asks the database, even for a new guest, so a missing table shows
  // up here (and the page doesn't advertise a trial the server can't run).
  const key = `guest:${guestId ?? "new"}`;
  const used = (await read(db, [key])).get(key)?.messages ?? 0;
  return Math.max(0, limit - used);
}

const UPSERT = `INSERT INTO guest_usage (key, messages, cost_micros, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT (key) DO UPDATE SET
    messages = MAX(0, messages + excluded.messages),
    cost_micros = cost_micros + excluded.cost_micros,
    updated_at = excluded.updated_at`;

function add(db: D1Database, keys: string[], messages: number, cost: number, now: number) {
  return db.batch(keys.map((k) => db.prepare(UPSERT).bind(k, messages, cost, now)));
}
const all = (keys: GuestKeys) => [keys.guest, keys.ip, keys.day];

export type Reservation =
  | { ok: true; left: number }
  | { ok: false; reason: "used" | "busy" };

/**
 * Checks the limits and, if this message is allowed, counts it straight away
 * (before the AI runs), so a guest can't slip extra messages in by sending
 * several at once. Two requests in the very same instant could both get
 * through; that's at most a message or two over, which is fine for a trial.
 *
 * `estimate` is the most this message could cost (micro-dollars). It's
 * charged up front, so many messages sent at once can't all slip under the
 * daily spending cap; settleGuestCost swaps in the real cost afterwards.
 *
 * A message that looks like a crisis is still answered after the guest's own
 * free messages run out, so nobody in trouble hits a sign-up wall. The network
 * and daily caps still apply to it.
 */
export async function reserveGuestMessage(
  db: D1Database,
  env: GuestEnv,
  keys: GuestKeys,
  { crisis = false, estimate = 0, now = Date.now() } = {},
): Promise<Reservation> {
  const limit = guestMessageLimit(env);
  const rows = await read(db, all(keys));
  const used = rows.get(keys.guest)?.messages ?? 0;
  const spent = rows.get(keys.day)?.cost_micros ?? 0;
  const cap = guestDailyLimitMicros(env);
  if (spent >= cap || spent + estimate > cap) return { ok: false, reason: "busy" };
  if ((rows.get(keys.ip)?.messages ?? 0) >= guestIpDailyLimit(env)) return { ok: false, reason: "busy" };
  if (used >= limit && !crisis) return { ok: false, reason: "used" };
  await add(db, all(keys), 1, estimate, now);
  return { ok: true, left: Math.max(0, limit - used - 1) };
}

/**
 * Gives the guest their message back when the coach failed before saying
 * anything. Only the guest's own count: the network's count and the cost
 * stay, so repeated failing requests still run into the backstops.
 */
export async function refundGuestMessage(db: D1Database, keys: GuestKeys, now = Date.now()) {
  await add(db, [keys.guest], -1, 0, now);
}

/**
 * Replaces the up-front estimate with what the reply really cost
 * (micro-dollars, src/usage.ts costMicros), on the guest's, the network's and
 * the day's totals.
 */
export async function settleGuestCost(db: D1Database, keys: GuestKeys, estimate: number, cost: number, now = Date.now()) {
  if (cost !== estimate) await add(db, all(keys), 0, cost - estimate, now);
}
