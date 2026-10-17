// Per-user AI usage: what each signed-in user has cost this month, and whether
// they've reached their allowance. Every AI call is checked before it runs and
// recorded after, so one user can't run up the bill for everyone.

/**
 * Claude Opus 5.5 list prices in USD per million tokens, which is the same as
 * micro-dollars per token. Update these if the model or prices change:
 * https://platform.claude.com/docs/en/about-claude/pricing
 */
export const PRICES = {
  input: 4,
  cacheWrite: 5, // 5-minute cache write
  cacheRead: 0.2,
  output: 20,
} as const;

/** Used when USER_MONTHLY_LIMIT_USD isn't set: the free allowance. */
export const DEFAULT_MONTHLY_LIMIT_USD = 5;

/** Used when PAID_MONTHLY_LIMIT_USD isn't set: the allowance on a paid plan. */
export const DEFAULT_PAID_MONTHLY_LIMIT_USD = 3;

/** The token counts the Anthropic API reports on every response. */
export interface TokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

const n = (v: number | null | undefined) => (typeof v === "number" && v > 0 ? Math.round(v) : 0);

/** Estimated cost of one response, in micro-dollars. */
export function costMicros(u: TokenUsage): number {
  return Math.ceil(
    n(u.input_tokens) * PRICES.input +
      n(u.cache_creation_input_tokens) * PRICES.cacheWrite +
      n(u.cache_read_input_tokens) * PRICES.cacheRead +
      n(u.output_tokens) * PRICES.output,
  );
}

/** The billing month a moment falls in, UTC: "2026-10". */
export function monthKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

const usdToMicros = (setting: string | undefined, fallback: number) => {
  const usd = Number(setting);
  return Math.round((setting !== undefined && setting !== "" && Number.isFinite(usd) && usd >= 0 ? usd : fallback) * 1_000_000);
};

/**
 * The monthly allowance in micro-dollars: USER_MONTHLY_LIMIT_USD for everyone,
 * or PAID_MONTHLY_LIMIT_USD for users on a paid plan. A bad or missing setting
 * falls back to the default.
 */
export function monthlyLimitMicros(
  env: { USER_MONTHLY_LIMIT_USD?: string; PAID_MONTHLY_LIMIT_USD?: string },
  paid = false,
): number {
  return paid
    ? usdToMicros(env.PAID_MONTHLY_LIMIT_USD, DEFAULT_PAID_MONTHLY_LIMIT_USD)
    : usdToMicros(env.USER_MONTHLY_LIMIT_USD, DEFAULT_MONTHLY_LIMIT_USD);
}

/** What this user has cost so far this month, in micro-dollars. */
export async function spentThisMonth(db: D1Database, userId: string, now = Date.now()): Promise<number> {
  const row = await db
    .prepare("SELECT cost_micros FROM usage WHERE user_id = ? AND month = ?")
    .bind(userId, monthKey(now))
    .first<{ cost_micros: number }>();
  return row?.cost_micros ?? 0;
}

/** Adds one AI response to this user's monthly total. */
export async function recordUsage(db: D1Database, userId: string, u: TokenUsage, now = Date.now()): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage (user_id, month, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, month) DO UPDATE SET
         requests = requests + 1,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
         cost_micros = cost_micros + excluded.cost_micros,
         updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      monthKey(now),
      n(u.input_tokens),
      n(u.output_tokens),
      n(u.cache_read_input_tokens),
      n(u.cache_creation_input_tokens),
      costMicros(u),
      now,
    )
    .run();
}

/**
 * The id Anthropic sees for this user (the API's metadata.user_id): a SHA-256
 * hash of the sign-in id, so Anthropic can tell users apart for abuse handling
 * without learning who anyone is.
 */
export async function anthropicUserId(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`humanual:${userId}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
