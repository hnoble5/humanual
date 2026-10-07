// Records the demo's replies from the real coach and writes public/demo/samples.json.
//
//   1. npm run dev                (local server, with ANTHROPIC_API_KEY in .dev.vars)
//   2. npm run demo:record        (in another terminal)
//
// This calls Claude (about 40 requests for everything), so it costs a little.
// Rerun it after changing the prompts so the demo matches how the coach
// behaves now. To redo only some parts and keep the rest of the file, name them:
//   npm run demo:record -- journal memory
// Parts: conversations, scripts, journal, memory.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { JOURNAL, PROFILE, SAMPLES, SCRIPTS } from "./demo-spec.mjs";

const U = process.env.HUMANUAL_URL ?? "http://127.0.0.1:8787";
const OUT = new URL("../public/demo/samples.json", import.meta.url);
const PARTS = ["conversations", "scripts", "journal", "memory"];
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : PARTS;
for (const p of wanted) if (!PARTS.includes(p)) throw new Error(`Unknown part "${p}". Use: ${PARTS.join(", ")}`);

let devVars = "";
try { devVars = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"); } catch {}
const accessCode = devVars.match(/^ACCESS_CODE\s*=\s*"?([^"\r\n]*)"?/m)?.[1] ?? "";
const headers = { "content-type": "application/json", "x-access-code": accessCode, "x-dev-user": "demo-recorder" };
const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

async function post(path, body) {
  const res = await fetch(`${U}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

async function chat(sample, messages) {
  const res = await post("/api/chat", { coach: sample.coach, style: sample.style, mode: sample.mode, profile: PROFILE, today, messages });
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
  const res = await post("/api/script", { coach: s.coach, style: "direct", profile: PROFILE, today, channel: s.channel, task: s.task, details: "" });
  const data = await res.json();
  if (!data.script) throw new Error(`script "${s.task}": ${data.error ?? "no script"}`);
  console.log(`recorded script: ${s.task}`);
  return { channel: s.channel, coach: s.coach, task: s.task, script: data.script };
}

async function recordJournal(j) {
  const res = await post("/api/journal", { coach: j.coach, style: j.style, profile: PROFILE, today, text: j.text, replaying: j.replaying });
  const data = await res.json();
  if (!data.card) throw new Error(`journal "${j.label}": ${data.error ?? "no card"}`);
  console.log(`recorded journal: ${j.label}`);
  return { ...j, card: data.card };
}

// Builds what the coach would remember after the sample conversations and journal entries, in order.
async function recordMemory(data) {
  let memory = [];
  const exchanges = [
    ...data.conversations.map((c) => c.messages.map((m) => `${m.role === "user" ? "The user wrote" : "The coach replied"}:\n${m.content}`).join("\n\n")),
    ...data.journal.map((j) => `From the user's journal:\n${j.text}${j.replaying ? `\n\nSomething they keep replaying: ${j.replaying}` : ""}`),
  ];
  for (const exchange of exchanges) {
    const res = await post("/api/remember", { memory, exchange, today });
    memory = (await res.json()).memory;
  }
  console.log(`recorded memory: ${memory.length} items`);
  return memory;
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

const data = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
if (wanted.includes("conversations")) data.conversations = await inBatches(SAMPLES, 3, recordSample);
if (wanted.includes("scripts")) data.scripts = await inBatches(SCRIPTS, 4, recordScript);
if (wanted.includes("journal")) data.journal = await inBatches(JOURNAL, 3, recordJournal);
if (wanted.includes("memory")) data.memory = await retry(recordMemory, data);

mkdirSync(new URL("../public/demo/", import.meta.url), { recursive: true });
const { conversations, scripts, journal, memory } = data;
writeFileSync(OUT, JSON.stringify({ recorded: new Date().toISOString().slice(0, 10), profile: PROFILE, conversations, scripts, journal, memory }, null, 2) + "\n");
console.log(`wrote ${OUT.pathname}`);
