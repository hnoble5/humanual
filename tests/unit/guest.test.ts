// Unit tests for the guest trial (src/guest.ts) against the real schema in SQLite.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayKey,
  guestCookie,
  guestDailyLimitMicros,
  guestIdFrom,
  guestIpDailyLimit,
  guestKeys,
  guestMessageLimit,
  guestMessagesLeft,
  refundGuestMessage,
  reserveGuestMessage,
  settleGuestCost,
} from "../../src/guest.ts";
import { createTestDb } from "./d1-shim.ts";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const req = (ip = "203.0.113.7", cookie = "") =>
  new Request("https://humanual.app/api/chat", { headers: { "cf-connecting-ip": ip, cookie } });

test("settings fall back to the defaults when missing or invalid, and 0 is allowed", () => {
  assert.equal(guestMessageLimit({}), 5);
  assert.equal(guestMessageLimit({ GUEST_MESSAGE_LIMIT: "nope" }), 5);
  assert.equal(guestMessageLimit({ GUEST_MESSAGE_LIMIT: "-1" }), 5);
  assert.equal(guestMessageLimit({ GUEST_MESSAGE_LIMIT: "2.5" }), 5);
  assert.equal(guestMessageLimit({ GUEST_MESSAGE_LIMIT: "0" }), 0);
  assert.equal(guestIpDailyLimit({}), 15);
  assert.equal(guestDailyLimitMicros({}), 2_000_000);
  assert.equal(guestDailyLimitMicros({ GUEST_DAILY_LIMIT_USD: "0.5" }), 500_000);
});

test("the guest id comes only from a well-formed cookie", () => {
  assert.equal(guestIdFrom(req(undefined, `a=1; hm_guest=${ID}; b=2`)), ID);
  assert.equal(guestIdFrom(req(undefined, "hm_guest=not-an-id")), null);
  assert.equal(guestIdFrom(req(undefined, "")), null);
  assert.match(guestCookie(ID), /^hm_guest=0f8fad5b-.*; HttpOnly; Secure; SameSite=Lax$/);
});

test("the network is stored only as a hash, and counters are per UTC day", async () => {
  const day = Date.UTC(2026, 9, 17, 23, 59);
  const keys = await guestKeys(req(), ID, day);
  assert.equal(keys.guest, `guest:${ID}`);
  assert.equal(keys.day, "day:2026-10-17");
  assert.doesNotMatch(keys.ip, /203\.0\.113/);
  assert.equal(dayKey(Date.UTC(2026, 9, 18, 0, 0)), "2026-10-18");
});

test("a guest gets exactly five messages, counted down", async () => {
  const db = createTestDb();
  const keys = await guestKeys(req(), ID);
  const lefts = [];
  for (let i = 0; i < 5; i++) {
    const r = await reserveGuestMessage(db, {}, keys);
    assert.equal(r.ok, true);
    if (r.ok) lefts.push(r.left);
  }
  assert.deepEqual(lefts, [4, 3, 2, 1, 0]);
  assert.deepEqual(await reserveGuestMessage(db, {}, keys), { ok: false, reason: "used" });
  assert.equal(await guestMessagesLeft(db, {}, ID), 0);
  assert.equal(await guestMessagesLeft(db, {}, null), 5);
});

test("a crisis message is still answered after the free messages run out", async () => {
  const db = createTestDb();
  const keys = await guestKeys(req(), ID);
  for (let i = 0; i < 5; i++) await reserveGuestMessage(db, {}, keys);
  assert.equal((await reserveGuestMessage(db, {}, keys, { crisis: true })).ok, true);
});

test("a failed reply gives the guest's message back, but not the network's", async () => {
  const db = createTestDb();
  const env = { GUEST_IP_DAILY_MESSAGES: "1" };
  const keys = await guestKeys(req(), ID);
  await reserveGuestMessage(db, env, keys);
  await refundGuestMessage(db, keys);
  assert.equal(await guestMessagesLeft(db, env, ID), 5);
  assert.deepEqual(await reserveGuestMessage(db, env, keys), { ok: false, reason: "busy" });
});

test("the worst-case cost is held up front, so messages sent at once can't all slip under the daily cap", async () => {
  const db = createTestDb();
  const env = { GUEST_DAILY_LIMIT_USD: "1" };
  const a = await guestKeys(req("198.51.100.1"), crypto.randomUUID());
  const b = await guestKeys(req("198.51.100.2"), crypto.randomUUID());
  assert.equal((await reserveGuestMessage(db, env, a, { estimate: 600_000 })).ok, true);
  // Nothing has been settled yet, and $0.60 + $0.60 would pass $1.
  assert.deepEqual(await reserveGuestMessage(db, env, b, { estimate: 600_000 }), { ok: false, reason: "busy" });
  // The first reply really cost $0.05: the hold is released and b fits.
  await settleGuestCost(db, a, 600_000, 50_000);
  assert.equal((await reserveGuestMessage(db, env, b, { estimate: 600_000 })).ok, true);
});

test("a new cookie on the same network still hits the network's daily cap", async () => {
  const db = createTestDb();
  const env = { GUEST_IP_DAILY_MESSAGES: "3" };
  for (let i = 0; i < 3; i++) {
    const keys = await guestKeys(req(), crypto.randomUUID());
    assert.equal((await reserveGuestMessage(db, env, keys)).ok, true);
  }
  const fresh = await guestKeys(req(), crypto.randomUUID());
  assert.deepEqual(await reserveGuestMessage(db, env, fresh), { ok: false, reason: "busy" });
  // A different network is unaffected.
  const elsewhere = await guestKeys(req("198.51.100.9"), crypto.randomUUID());
  assert.equal((await reserveGuestMessage(db, env, elsewhere)).ok, true);
});

test("once guests together reach the day's spending cap, no guest is answered, even in a crisis", async () => {
  const db = createTestDb();
  const env = { GUEST_DAILY_LIMIT_USD: "1" };
  const keys = await guestKeys(req(), ID);
  await reserveGuestMessage(db, env, keys);
  await settleGuestCost(db, keys, 0, 1_000_000); // $1.00
  const other = await guestKeys(req("198.51.100.9"), crypto.randomUUID());
  assert.deepEqual(await reserveGuestMessage(db, env, other), { ok: false, reason: "busy" });
  assert.deepEqual(await reserveGuestMessage(db, env, other, { crisis: true }), { ok: false, reason: "busy" });
});
