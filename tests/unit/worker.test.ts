// Unit tests for request handling in src/worker.ts that don't call the AI.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";

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

test("guests reach the coach on the app address with no code or sign-in", async () => {
  // An invalid coach gets a 400 from input checking, which proves the request
  // got past every gate without calling the AI.
  for (const path of AI_PATHS.slice(0, 3)) {
    const res = await worker.fetch(post(APP, path, { ...chat, coach: "nobody" }), env());
    assert.equal(res.status, 400, path);
  }
});

test("the app address list is case- and space-tolerant, and localhost always works", async () => {
  const e = env({ APP_HOSTS: " Other.example.com , APP.example.com " });
  assert.equal((await worker.fetch(post(APP, "/api/chat", { ...chat, coach: "nobody" }), e)).status, 400);
  const local = await worker.fetch(post("localhost", "/api/chat", { ...chat, coach: "nobody" }), env({ APP_HOSTS: "" }));
  assert.equal(local.status, 400);
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
  const clerk = env({ CLERK_SECRET_KEY: "sk_test_x", CLERK_PUBLISHABLE_KEY: "pk_test_x" });
  assert.equal((await worker.fetch(post(DEMO_HOST, "/api/sync", { since: 0 }), clerk)).status, 403);
});

test("inherited property names are rejected as unknown, not a crash", async () => {
  for (const [field, value] of [["coach", "constructor"], ["coach", "__proto__"], ["mode", "toString"]]) {
    const res = await worker.fetch(post(APP, "/api/chat", { ...chat, [field]: value }), env());
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
