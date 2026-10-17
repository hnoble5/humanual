// Unit tests for per-user AI usage (src/usage.ts) against the real schema in SQLite.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicUserId, costMicros, monthKey, monthlyLimitMicros, recordUsage, spentThisMonth } from "../../src/usage.ts";
import { createTestDb } from "./d1-shim.ts";

test("cost uses each token type's price", () => {
  // 1M of each: $4 input + $5 cache write + $0.20 cache read + $20 output.
  const m = 1_000_000;
  assert.equal(
    costMicros({ input_tokens: m, cache_creation_input_tokens: m, cache_read_input_tokens: m, output_tokens: m }),
    29_200_000,
  );
  assert.equal(costMicros({}), 0);
  assert.equal(costMicros({ input_tokens: null, output_tokens: -5 }), 0);
});

test("usage adds up per user per month", async () => {
  const db = createTestDb();
  const oct = Date.UTC(2026, 9, 17);
  const nov = Date.UTC(2026, 10, 1);
  await recordUsage(db, "u1", { input_tokens: 1000, output_tokens: 500 }, oct);
  await recordUsage(db, "u1", { cache_read_input_tokens: 10_000, output_tokens: 500 }, oct);
  await recordUsage(db, "u2", { output_tokens: 1000 }, oct);
  assert.equal(await spentThisMonth(db, "u1", oct), 4_000 + 10_000 + 2_000 + 10_000);
  assert.equal(await spentThisMonth(db, "u2", oct), 20_000);
  // A new month starts from zero.
  assert.equal(await spentThisMonth(db, "u1", nov), 0);
});

test("months are UTC", () => {
  assert.equal(monthKey(Date.UTC(2026, 9, 31, 23, 59)), "2026-10");
  assert.equal(monthKey(Date.UTC(2026, 10, 1, 0, 0)), "2026-11");
});

test("the monthly limit setting falls back to $5 when missing or invalid", () => {
  assert.equal(monthlyLimitMicros({}), 5_000_000);
  assert.equal(monthlyLimitMicros({ USER_MONTHLY_LIMIT_USD: "nope" }), 5_000_000);
  assert.equal(monthlyLimitMicros({ USER_MONTHLY_LIMIT_USD: "-1" }), 5_000_000);
  assert.equal(monthlyLimitMicros({ USER_MONTHLY_LIMIT_USD: "2.5" }), 2_500_000);
  assert.equal(monthlyLimitMicros({ USER_MONTHLY_LIMIT_USD: "0" }), 0);
});

test("Anthropic gets a stable hash, never the sign-in id", async () => {
  const a = await anthropicUserId("user_2abc");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, await anthropicUserId("user_2abc"));
  assert.notEqual(a, await anthropicUserId("user_2abd"));
  assert.ok(!a.includes("user_2abc"));
});
