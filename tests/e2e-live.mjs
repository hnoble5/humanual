// Live browser test of the journal and memory, using the real coach.
//
//   1. npm run dev            (dev sign-in on, ANTHROPIC_API_KEY in .dev.vars)
//   2. npm run test:live      (in another terminal)
//
// Calls Claude about five times (a journal reply, memory updates, one chat
// reply), so it costs a little. Checks that a journal entry gets a reply card,
// that what the user wrote is remembered and synced, and that a brand-new
// conversation knows it.
import { chromium } from "playwright-core";

const U = process.env.HUMANUAL_URL ?? "http://127.0.0.1:8787";
const user = "live" + Date.now().toString(36);
const results = [];
const ok = (name, cond, extra = "") => results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);
const serverItems = async () => (await (await fetch(`${U}/api/sync`, {
  method: "POST", headers: { "content-type": "application/json", "x-dev-user": user }, body: JSON.stringify({ since: 0 }),
})).json()).items;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(U);
  await page.fill("#dev-user", user);
  await page.click("#dev-signin button[type=submit]");
  await page.fill("#ob-name", "Sam");
  await page.check("#ob-age");
  await page.click("#onboard-form button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");

  // Journal entry -> reply card.
  await page.click(".view-btn[data-view=journal]");
  await page.fill("#journal-text", "My sister Maya called to ask if I can help her move apartments on Saturday the 17th. I said yes even though big moves wipe me out, and now I'm dreading it.");
  await page.click("#journal-go");
  await page.waitForFunction(() => document.querySelector("#journal-out .norm"), null, { timeout: 120_000 });
  ok("journal entry gets a reply card", true, (await page.textContent("#journal-out h3")).trim());
  ok("entry listed under past entries", (await page.$$eval("#entry-list .saved-item", (n) => n.length)) === 1);

  // Memory picks up the sister and the move, and syncs with the profile.
  let memory = [];
  for (let i = 0; i < 60 && !memory.some((m) => /maya/i.test(m)); i++) {
    await page.waitForTimeout(2000);
    memory = (await serverItems()).find((x) => x.kind === "profile")?.data?.memory?.map((m) => m.text) ?? [];
  }
  ok("memory remembers Maya and synced", memory.some((m) => /maya/i.test(m)), memory.join(" | "));
  ok("journal entry synced", (await serverItems()).some((x) => x.kind === "journal" && x.data?.card));
  await page.click("#open-settings");
  ok("settings shows the memory", (await page.textContent("#memory-list")).toLowerCase().includes("maya"));
  await page.click("#settings .sheet-head button");

  // A new conversation knows it without being told.
  await page.click(".view-btn[data-view=chat]");
  await page.click("#new-chat");
  await page.fill("#input", "Quick question: what's my sister's name, and what did I agree to help her with?");
  await page.click("#send");
  await page.waitForFunction(() => document.querySelectorAll("#messages .msg.coach .md").length === 1 && !document.querySelector("#send.stop"), null, { timeout: 120_000 });
  const reply = await page.textContent("#messages .msg.coach .md");
  ok("new conversation remembers", /maya/i.test(reply) && /mov/i.test(reply), reply.slice(0, 160).replace(/\s+/g, " "));
} catch (err) {
  ok("test ran to the end", false, err.message.split("\n")[0]);
} finally {
  await browser.close();
}
ok("no page errors", errors.length === 0, errors.join(" | "));
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
