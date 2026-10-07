// Records the demo's replies from the real coach and writes public/demo/samples.json.
//
//   1. npm run dev                (local server, with ANTHROPIC_API_KEY in .dev.vars)
//   2. npm run demo:record        (in another terminal)
//
// This calls Claude (about 25 requests), so it costs a little. Rerun it after
// changing the prompts so the demo matches how the coach behaves now.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { PROFILE, SAMPLES, SCRIPTS } from "./demo-spec.mjs";

const U = process.env.HUMANUAL_URL ?? "http://127.0.0.1:8787";
const OUT = new URL("../public/demo/samples.json", import.meta.url);

let devVars = "";
try { devVars = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"); } catch {}
const accessCode = devVars.match(/^ACCESS_CODE\s*=\s*"?([^"\r\n]*)"?/m)?.[1] ?? "";
const headers = { "content-type": "application/json", "x-access-code": accessCode, "x-dev-user": "demo-recorder" };
const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

async function chat(sample, messages) {
  const res = await fetch(`${U}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ coach: sample.coach, style: sample.style, mode: sample.mode, profile: PROFILE, today, messages }),
  });
  if (!res.ok) throw new Error(`${sample.id}: HTTP ${res.status} ${await res.text()}`);
  let text = "";
  let outcome = null;
  for (const line of (await res.text()).split("\n")) {
    if (!line) continue;
    const ev = JSON.parse(line);
    if (ev.t === "text") text += ev.v;
    else if (ev.t !== "crisis") outcome = ev;
  }
  if (outcome?.t !== "done") throw new Error(`${sample.id}: reply ended with ${JSON.stringify(outcome)}`);
  return text.trim();
}

async function recordSample(sample) {
  const messages = [];
  for (const user of sample.turns) {
    messages.push({ role: "user", content: user });
    messages.push({ role: "assistant", content: await chat(sample, messages) });
  }
  console.log(`recorded ${sample.id} (${sample.turns.length} turns)`);
  return { id: sample.id, label: sample.label, mode: sample.mode, coach: sample.coach, style: sample.style, messages };
}

async function recordScript(s) {
  const res = await fetch(`${U}/api/script`, {
    method: "POST",
    headers,
    body: JSON.stringify({ coach: s.coach, style: "direct", profile: PROFILE, today, channel: s.channel, task: s.task, details: "" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.script) throw new Error(`script "${s.task}": ${data.error ?? res.status}`);
  console.log(`recorded script: ${s.task}`);
  return { channel: s.channel, coach: s.coach, task: s.task, script: data.script };
}

// The dev server restarts whenever a file changes, which kills requests in flight.
async function retry(fn, item) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(item);
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(`retrying after: ${err.message.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// A few at a time, so a long run doesn't hit rate limits.
async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map((item) => retry(fn, item)))));
  }
  return out;
}

const conversations = await inBatches(SAMPLES, 3, recordSample);
const scripts = await inBatches(SCRIPTS, 4, recordScript);

mkdirSync(new URL("../public/demo/", import.meta.url), { recursive: true });
writeFileSync(OUT, JSON.stringify({ recorded: new Date().toISOString().slice(0, 10), profile: PROFILE, conversations, scripts }, null, 2) + "\n");
console.log(`wrote ${OUT.pathname}`);
