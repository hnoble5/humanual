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

const env = (extra: Record<string, unknown> = {}) =>
  ({ ANTHROPIC_API_KEY: "sk-ant-test", ASSETS: { fetch: async () => new Response("asset") }, ...extra }) as any;

const post = (host: string, path: string, body: unknown) =>
  new Request(`https://${host}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const chat = { coach: "junie", style: "direct", mode: null, messages: [{ role: "user", content: "hi" }] };

test("AI endpoints refuse on a public address with no access code and no sign-in", async () => {
  for (const path of ["/api/chat", "/api/script", "/api/journal", "/api/remember"]) {
    const res = await worker.fetch(post("app.example.com", path, chat), env());
    assert.equal(res.status, 503, path);
    assert.match((await res.json()).error, /isn't available/);
  }
});

test("with an access code set, a missing code is a 401, not the backstop", async () => {
  const res = await worker.fetch(post("app.example.com", "/api/chat", chat), env({ ACCESS_CODE: "s3cret" }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "access");
});

test("inherited property names are rejected as unknown, not a crash", async () => {
  const e = env({ ACCESS_CODE: "s3cret" });
  for (const [field, value] of [["coach", "constructor"], ["coach", "__proto__"], ["mode", "toString"]]) {
    const req = post("app.example.com", "/api/chat", { ...chat, [field]: value });
    req.headers.set("x-access-code", "s3cret");
    const res = await worker.fetch(req, e);
    assert.equal(res.status, 400, `${field}=${value}`);
    assert.match((await res.json()).error, /Unknown/);
  }
});

test("unexpected errors come back as JSON", async () => {
  const broken = env({ ACCESS_CODE: "s3cret", ASSETS: { fetch: async () => { throw new Error("boom"); } } });
  const res = await worker.fetch(new Request("https://app.example.com/"), broken);
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /Something went wrong/);
});
