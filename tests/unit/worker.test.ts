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

test("the coach needs a signed-in user on the app address", async () => {
  for (const path of AI_PATHS) {
    const res = await worker.fetch(post(APP, path, chat), env(CLERK));
    assert.equal(res.status, 401, path);
    assert.equal((await res.json()).code, "signin");
  }
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

// ---------- payments ----------

const STRIPE = { STRIPE_API_KEY: "sk_test_unused", STRIPE_WEBHOOK_SECRET: "whsec_unused" };

async function payingUser(db: D1Database, user: string, status = "active") {
  await db.exec(
    `INSERT INTO billing (user_id, customer_id, subscription_id, status, updated_at) VALUES ('${user}', 'cus_${user}', 'sub_${user}', '${status}', 0)`,
  );
}

test("members get the paid allowance; free users at their limit are offered the plan", async () => {
  const db = createTestDb();
  // $1 of output each: over the $0.50 free allowance, under the $3 paid one.
  await recordUsage(db, "dev_alice", { output_tokens: 50_000 });
  await recordUsage(db, "dev_bob", { output_tokens: 50_000 });
  await payingUser(db, "dev_bob");
  const e = env({ DEV_AUTH: "true", DB: db, USER_MONTHLY_LIMIT_USD: "0.5", PAID_MONTHLY_LIMIT_USD: "3", ...STRIPE });

  const alice = post("localhost", "/api/chat", chat);
  alice.headers.set("x-dev-user", "alice");
  const res = await worker.fetch(alice, e);
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.code, "limit");
  assert.equal(body.upgrade, true);

  const bob = post("localhost", "/api/chat", { ...chat, coach: "nobody" });
  bob.headers.set("x-dev-user", "bob");
  assert.equal((await worker.fetch(bob, e)).status, 400, "bob gets past the limit check");

  // A canceled member is back on the free allowance.
  await db.exec("UPDATE billing SET status = 'canceled'");
  const bob2 = post("localhost", "/api/chat", chat);
  bob2.headers.set("x-dev-user", "bob");
  assert.equal((await worker.fetch(bob2, e)).status, 429);
});

test("with payments off, nobody is offered a plan they can't buy", async () => {
  const db = createTestDb();
  await recordUsage(db, "dev_alice", { output_tokens: 50_000 });
  const req = post("localhost", "/api/chat", chat);
  req.headers.set("x-dev-user", "alice");
  const res = await worker.fetch(req, env({ DEV_AUTH: "true", DB: db, USER_MONTHLY_LIMIT_USD: "0.5" }));
  assert.equal(res.status, 429);
  assert.equal((await res.json()).upgrade, undefined);
});

test("billing endpoints are off until Stripe is set up, and need the app address and a sign-in", async () => {
  const get = (host: string) => new Request(`https://${host}/api/billing`);
  assert.equal((await worker.fetch(get(APP), env(CLERK))).status, 501);
  assert.equal((await worker.fetch(get(DEMO_HOST), env({ ...CLERK, ...STRIPE }))).status, 403);
  assert.equal((await worker.fetch(get(APP), env({ ...CLERK, ...STRIPE }))).status, 401);
  assert.equal((await worker.fetch(post(APP, "/api/billing/checkout", { plan: "monthly" }), env({ ...CLERK, ...STRIPE }))).status, 401);
  assert.equal((await worker.fetch(post(APP, "/api/billing/portal", {}), env({ ...CLERK, ...STRIPE }))).status, 401);
});

test("checkout only accepts the two plans", async () => {
  for (const plan of ["lifetime", "constructor", undefined]) {
    const req = post("localhost", "/api/billing/checkout", { plan });
    req.headers.set("x-dev-user", "alice");
    const res = await worker.fetch(req, env({ DEV_AUTH: "true", DB: createTestDb(), ...STRIPE }));
    assert.equal(res.status, 400, String(plan));
  }
});

test("the Stripe webhook answers on the public address too, but only to signed requests", async () => {
  const req = new Request(`https://${DEMO_HOST}/api/stripe/webhook`, { method: "POST", body: "{}" });
  assert.equal((await worker.fetch(req, env({ DB: createTestDb(), ...STRIPE }))).status, 400);
  assert.equal((await worker.fetch(new Request(`https://${DEMO_HOST}/api/stripe/webhook`, { method: "POST", body: "{}" }), env())).status, 501);
});

test("config says whether payments are on", async () => {
  const off = await (await worker.fetch(new Request(`https://${APP}/api/config`), env(CLERK))).json();
  const on = await (await worker.fetch(new Request(`https://${APP}/api/config`), env({ ...CLERK, ...STRIPE }))).json();
  assert.equal(off.billing, false);
  assert.equal(on.billing, true);
});
