// Unit tests for request handling in src/worker.ts that don't call the AI.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTestDb } from "./d1-shim.ts";
import { recordUsage } from "../../src/usage.ts";

// The Worker imports the prompt Markdown files as text (a wrangler rule), which
// Node can't do on its own, so bundle it the same way first. The bundle goes
// under node_modules so its own imports (the SDK, Clerk) still resolve.
const out = fileURLToPath(new URL("../../node_modules/.cache/humanual-test/worker.mjs", import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL("../../src/worker.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".md": "text" },
  outfile: out,
  logLevel: "error",
});
const worker = (await import(pathToFileURL(out).href)).default;

const APP = "app.example.com";
const DEMO_HOST = "coach.example.com";
const env = (extra: Record<string, unknown> = {}) =>
  ({ ANTHROPIC_API_KEY: "sk-ant-test", APP_HOSTS: APP, ASSETS: { fetch: async () => new Response("asset") }, ...extra }) as any;

const post = (host: string, path: string, body: unknown) =>
  new Request(`https://${host}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const chat = { coach: "junie", style: "direct", mode: null, messages: [{ role: "user", content: "hi" }] };
const AI_PATHS = ["/api/chat", "/api/script", "/api/journal", "/api/remember"];

test("the coach never answers on the public demo address", async () => {
  for (const path of AI_PATHS) {
    const res = await worker.fetch(post(DEMO_HOST, path, chat), env());
    assert.equal(res.status, 403, path);
    assert.match((await res.json()).error, /only answers in the Humanual app/);
  }
});

const CLERK = { CLERK_SECRET_KEY: "sk_test_x", CLERK_PUBLISHABLE_KEY: "pk_test_x" };

test("the coach needs a signed-in user on the app address (guest trial needs the database)", async () => {
  for (const path of AI_PATHS) {
    const res = await worker.fetch(post(APP, path, chat), env(CLERK));
    assert.equal(res.status, 401, path);
    assert.equal((await res.json()).code, "signin");
  }
});

// ---------- guest trial (src/guest.ts) ----------

const GUEST_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const asGuest = (path: string, body: unknown, cookie = "") => {
  const req = post(APP, path, body);
  req.headers.set("cf-connecting-ip", "203.0.113.7");
  if (cookie) req.headers.set("cookie", cookie);
  return req;
};
const useUpTrial = async (db: D1Database) =>
  db.exec(`INSERT INTO guest_usage (key, messages, cost_micros, updated_at) VALUES ('guest:${GUEST_ID}', 5, 0, 0)`);

test("a guest gets past the coach chat gate", async () => {
  // An invalid coach gets a 400 from input checking: past the sign-in gate, no AI called.
  const res = await worker.fetch(asGuest("/api/chat", { ...chat, coach: "nobody" }), env({ ...CLERK, DB: createTestDb() }));
  assert.equal(res.status, 400);
});

test("a guest who has used the free messages is told to make an account, with no AI call", async () => {
  const db = createTestDb();
  await useUpTrial(db);
  const res = await worker.fetch(asGuest("/api/chat", chat, `hm_guest=${GUEST_ID}`), env({ ...CLERK, DB: db }));
  assert.equal(res.status, 429);
  const data = await res.json();
  assert.equal(data.code, "guest_limit");
  assert.match(data.error, /5 free coach messages.*Create a free account/);
  assert.equal(data.crisis, undefined);
});

test("a guest over the limit who writes something alarming is pointed to crisis help, not just sign-up", async () => {
  const db = createTestDb();
  await db.exec(`INSERT INTO guest_usage (key, messages, cost_micros, updated_at) VALUES ('day:${new Date().toISOString().slice(0, 10)}', 0, 99000000, 0)`);
  const crisisChat = { ...chat, messages: [{ role: "user", content: "I want to kill myself" }] };
  const res = await worker.fetch(asGuest("/api/chat", crisisChat, `hm_guest=${GUEST_ID}`), env({ ...CLERK, DB: db }));
  assert.equal(res.status, 429);
  const data = await res.json();
  assert.equal(data.crisis, true);
  assert.match(data.error, /988/);
  // A brand-new guest is given a cookie even when turned away.
  const fresh = await worker.fetch(asGuest("/api/chat", chat), env({ ...CLERK, DB: db }));
  assert.match(fresh.headers.get("set-cookie") ?? "", /^hm_guest=[0-9a-f-]{36};/);
});

test("guests can't send long conversations, or requests from other sites", async () => {
  const e = env({ ...CLERK, DB: createTestDb() });
  const long = { ...chat, messages: [{ role: "user", content: "x".repeat(12_001) }] };
  const res = await worker.fetch(asGuest("/api/chat", long), e);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, "guest_long");
  // A form post from another site (text/plain, no preflight) is refused.
  const plain = asGuest("/api/chat", chat);
  plain.headers.set("content-type", "text/plain");
  assert.equal((await worker.fetch(plain, e)).status, 403);
  const elsewhere = asGuest("/api/chat", chat);
  elsewhere.headers.set("origin", "https://evil.example");
  assert.equal((await worker.fetch(elsewhere, e)).status, 403);
  // Same-site requests are fine (400 here only because of the invalid coach).
  const same = asGuest("/api/chat", { ...chat, coach: "nobody" });
  same.headers.set("origin", `https://${APP}`);
  assert.equal((await worker.fetch(same, e)).status, 400);
});

test("scripts, journal and memory still need an account", async () => {
  const e = env({ ...CLERK, DB: createTestDb() });
  for (const path of AI_PATHS.slice(1)) {
    const res = await worker.fetch(asGuest(path, chat), e);
    assert.equal(res.status, 401, path);
    assert.equal((await res.json()).code, "signin");
  }
});

test("a sign-in that doesn't check out means sign in again, not guest", async () => {
  const req = asGuest("/api/chat", chat);
  req.headers.set("authorization", "Bearer not-a-real-token");
  const res = await worker.fetch(req, env({ ...CLERK, DB: createTestDb() }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "signin");
});

test("GUEST_MESSAGE_LIMIT 0 turns the guest trial off", async () => {
  const res = await worker.fetch(asGuest("/api/chat", chat), env({ ...CLERK, DB: createTestDb(), GUEST_MESSAGE_LIMIT: "0" }));
  assert.equal(res.status, 401);
});

test("before the guest table exists, guests are asked to sign in as before (no crash)", async () => {
  const noTable = createTestDb();
  await noTable.exec("DROP TABLE guest_usage");
  const res = await worker.fetch(asGuest("/api/chat", chat), env({ ...CLERK, DB: noTable }));
  assert.equal(res.status, 401);
  const config = await (await worker.fetch(new Request(`https://${APP}/api/config`), env({ ...CLERK, DB: noTable }))).json();
  assert.equal(config.guestMessages, 0);
});

test("config tells the page how many free messages this guest has left", async () => {
  const db = createTestDb();
  const e = env({ ...CLERK, DB: db });
  const fresh = await (await worker.fetch(new Request(`https://${APP}/api/config`), e)).json();
  assert.equal(fresh.guestMessages, 5);
  assert.equal(fresh.guestLeft, 5);
  await useUpTrial(db);
  const used = await (
    await worker.fetch(new Request(`https://${APP}/api/config`, { headers: { cookie: `hm_guest=${GUEST_ID}` } }), e)
  ).json();
  assert.equal(used.guestLeft, 0);
  // No trial on the demo address.
  const demo = await (await worker.fetch(new Request(`https://${DEMO_HOST}/api/config`), e)).json();
  assert.equal(demo.guestMessages, 0);
});

test("with no sign-in set up, the coach only runs on localhost", async () => {
  const res = await worker.fetch(post(APP, "/api/chat", chat), env());
  assert.equal(res.status, 501);
});

test("a signed-in user gets past every gate", async () => {
  // An invalid coach gets a 400 from input checking, which proves the request
  // got past every gate without calling the AI.
  const dev = env({ DEV_AUTH: "true", DB: createTestDb() });
  for (const path of AI_PATHS.slice(0, 3)) {
    const req = post("localhost", path, { ...chat, coach: "nobody" });
    req.headers.set("x-dev-user", "alice");
    assert.equal((await worker.fetch(req, dev)).status, 400, path);
  }
});

test("a user over their monthly allowance is stopped before the AI is called", async () => {
  const db = createTestDb();
  // $4 + $2 of output: over a $5 allowance.
  await recordUsage(db, "dev_alice", { output_tokens: 200_000 });
  await recordUsage(db, "dev_alice", { output_tokens: 100_000 });
  const e = env({ DEV_AUTH: "true", DB: db, USER_MONTHLY_LIMIT_USD: "5" });
  for (const path of AI_PATHS) {
    const req = post("localhost", path, chat);
    req.headers.set("x-dev-user", "alice");
    const res = await worker.fetch(req, e);
    assert.equal(res.status, 429, path);
    assert.equal((await res.json()).code, "limit");
  }
  // Someone else on the same server is unaffected.
  const bob = post("localhost", "/api/chat", { ...chat, coach: "nobody" });
  bob.headers.set("x-dev-user", "bob");
  assert.equal((await worker.fetch(bob, e)).status, 400);
});

test("config tells the page whether this address serves the full app", async () => {
  const app = await (await worker.fetch(new Request(`https://${APP}/api/config`), env())).json();
  const demo = await (await worker.fetch(new Request(`https://${DEMO_HOST}/api/config`), env())).json();
  assert.equal(app.fullApp, true);
  assert.equal(demo.fullApp, false);
  assert.equal("accessCodeRequired" in app, false);
});

test("sync needs a signed-in user, and never runs on the demo address", async () => {
  const dev = env({ DEV_AUTH: "true" });
  const anon = await worker.fetch(post("localhost", "/api/sync", { since: 0 }), dev);
  assert.equal(anon.status, 401);
  assert.equal((await anon.json()).code, "signin");
  assert.equal((await worker.fetch(post(DEMO_HOST, "/api/sync", { since: 0 }), env(CLERK))).status, 403);
});

test("inherited property names are rejected as unknown, not a crash", async () => {
  for (const [field, value] of [["coach", "constructor"], ["coach", "__proto__"], ["mode", "toString"]]) {
    const res = await worker.fetch(post("localhost", "/api/chat", { ...chat, [field]: value }), env());
    assert.equal(res.status, 400, `${field}=${value}`);
    assert.match((await res.json()).error, /Unknown/);
  }
});

test("unexpected errors come back as JSON", async () => {
  const broken = env({ ASSETS: { fetch: async () => { throw new Error("boom"); } } });
  const res = await worker.fetch(new Request(`https://${APP}/`), broken);
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /Something went wrong/);
});

test("old and www addresses redirect to humanual.app, keeping the path", async () => {
  const cases = [
    ["https://www.humanual.app/scripts?x=1", "https://humanual.app/scripts?x=1"],
    ["https://humanual.elitetestautomation.com/", "https://humanual.app/"],
    ["https://coach.elitetestautomation.com/demo", "https://demo.humanual.app/demo"],
  ];
  for (const [from, to] of cases) {
    const res = await worker.fetch(new Request(from), env());
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get("location"), to, from);
  }
  const post = await worker.fetch(new Request("https://humanual.elitetestautomation.com/api/chat", { method: "POST" }), env());
  assert.equal(post.status, 308);
  // The real addresses are served, not redirected.
  assert.equal((await worker.fetch(new Request("https://humanual.app/"), env({ APP_HOSTS: "humanual.app" }))).status, 200);
});
