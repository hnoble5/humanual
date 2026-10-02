// Browser test for sign-in + sync across two devices (a "laptop" and a "phone").
//
// Run against the local server with the dev sign-in turned on:
//   1. .dev.vars has DEV_AUTH=true and no Clerk keys
//   2. npx wrangler d1 migrations apply humanual --local
//   3. npm run dev            (in one terminal)
//   4. npm run test:e2e       (in another)
//
// Uses your installed Chrome (playwright-core doesn't download a browser).
// Doesn't call the AI, so it costs nothing to run.
import { chromium } from "playwright-core";

const U = "http://127.0.0.1:8787";
const user = "e2e" + Date.now().toString(36);
const results = [];
const ok = (name, cond, extra = "") => { results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`); };

async function api(body, devUser = user, method = "POST") {
  const res = await fetch(`${U}/api/sync`, {
    method, headers: { "content-type": "application/json", "x-dev-user": devUser }, body: method === "POST" ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
const device = async (label) => {
  const ctx = await browser.newContext({ viewport: label === "phone" ? { width: 390, height: 844 } : { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${label} console: ${m.text()}`); });
  return { ctx, page };
};

try {
  // 1. Laptop: sign in, onboard.
  const laptop = await device("laptop");
  await laptop.page.goto(U);
  await laptop.page.waitForSelector("#signin:not([hidden])");
  ok("sign-in screen shows first", true);
  await laptop.page.fill("#dev-user", user);
  await laptop.page.click("#dev-signin button[type=submit]");
  await laptop.page.waitForSelector("#onboarding:not([hidden])");
  ok("new account goes to welcome screen", true);
  const storageNote = await laptop.page.textContent("#ob-storage");
  ok("welcome says data is saved to account", storageNote.includes("account"), storageNote);
  await laptop.page.fill("#ob-name", "Heather");
  await laptop.page.check("#ob-age");
  await laptop.page.click("#onboard-form button[type=submit]");
  await laptop.page.waitForSelector("#app:not([hidden])");
  await laptop.page.waitForFunction(() => document.querySelector("#sync-status")?.textContent === "Synced", null, { timeout: 15000 });
  ok("laptop shows Synced after onboarding", true);
  ok("account row shows test user", (await laptop.page.textContent("#account-email")).includes(user));

  const server1 = await api({ since: 0 });
  const prof = server1.items.find((i) => i.kind === "profile");
  ok("profile reached the server", prof?.data?.name === "Heather");
  ok("access code not synced", prof && !("accessCode" in prof.data));

  // 2. Seed a conversation + script on the server as if made on another device.
  const now = Date.now();
  await api({ changes: [
    { kind: "convo", id: "c-seed", updated_at: now, data: { id: "c-seed", title: "Seeded chat about the dentist", coach: "otis", style: "direct", mode: "everyday", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "**Short version:** call them." }], crisis: false, updated: now } },
    { kind: "script", id: "s-seed", updated_at: now, data: { id: "s-seed", channel: "phone", task: "Book dentist", details: "", coach: "junie", created: now, updated: now, script: { title: "Seeded dentist script", energy: "low", stakes: "low", norm: "", opener: "Hi", ask: "Can I book?", responses: [{ if: "When?", say: "Tuesday" }], stall: "One sec", exit: "I'll call back", closer: "Thanks", message: "", alternative: "", comfort: [] } } },
  ] });

  // 3. Phone: same user, fresh device. Should skip welcome and show everything.
  const phone = await device("phone");
  await phone.page.goto(U);
  await phone.page.fill("#dev-user", user);
  await phone.page.click("#dev-signin button[type=submit]");
  await phone.page.waitForSelector("#app:not([hidden])", { timeout: 15000 });
  ok("phone skips welcome (profile came from account)", await phone.page.isHidden("#onboarding"));
  const phoneList = await phone.page.textContent("#convo-list");
  ok("phone sees the seeded conversation", phoneList.includes("Seeded chat about the dentist"));
  await phone.page.locator("button[aria-label=\"Open menu\"]:visible").click();
  await phone.page.click('.view-btn[data-view="scripts"]');
  await phone.page.waitForSelector("#saved-list .saved-item");
  ok("phone sees the seeded script", (await phone.page.textContent("#saved-list")).includes("Seeded dentist script"));

  // 4. Phone edits profile -> laptop picks it up on next sync.
  await phone.page.locator("button[aria-label=\"Open menu\"]:visible").click();
  await phone.page.click("#open-settings");
  await phone.page.fill('#settings-form textarea[name="about"]', "Phone calls are the hardest for me.");
  await phone.page.click('#settings-form button[value="save"]');
  // Wait for the edit to reach the server (the status can still read "Synced"
  // from the previous sync for a moment before the save registers).
  for (let i = 0; i < 30; i++) {
    const p = (await api({ since: 0 })).items.find((x) => x.kind === "profile");
    if (p?.data?.about) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await laptop.page.reload();
  await laptop.page.waitForSelector("#app:not([hidden])");
  await laptop.page.waitForFunction(() => document.querySelector("#sync-status")?.textContent === "Synced", null, { timeout: 15000 });
  await laptop.page.click("#open-settings");
  const about = await laptop.page.inputValue('#settings-form textarea[name="about"]');
  if (about !== "Phone calls are the hardest for me.") {
    const srv = (await api({ since: 0 })).items.find((i) => i.kind === "profile");
    const local = await laptop.page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => /settings|outbox|cursor/.test(k))));
    console.log("DIAG server profile:", JSON.stringify(srv));
    console.log("DIAG laptop storage:", JSON.stringify(local));
  }
  ok("laptop gets profile edit made on phone", about === "Phone calls are the hardest for me.", about);
  await laptop.page.keyboard.press("Escape");

  // 5. Laptop deletes the script -> gone on phone after sync.
  await laptop.page.click('.view-btn[data-view="scripts"]');
  await laptop.page.click("#saved-list .saved-item button.open");
  laptop.page.once("dialog", (d) => d.accept());
  await laptop.page.click('#script-out button:has-text("Delete")');
  await laptop.page.waitForFunction(() => document.querySelector("#sync-status")?.textContent === "Synced", null, { timeout: 15000 });
  await phone.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await phone.page.waitForFunction(() => !document.querySelector("#saved-list")?.textContent.includes("Seeded dentist script"), null, { timeout: 15000 });
  ok("delete on laptop reaches phone", true);

  // 6. Data saved before accounts moves into the account on first sign-in.
  const legacyUser = user + "L";
  const legacy = await device("legacy");
  await legacy.ctx.addInitScript(() => {
    if (localStorage.getItem("seeded")) return;
    localStorage.setItem("seeded", "1");
    localStorage.setItem("humanual.settings.v1", JSON.stringify({ name: "Old Me", coach: "junie", style: "gentle", about: "", work: "", people: "", accessCode: "" }));
    localStorage.setItem("humanual.scripts.v1", JSON.stringify([{ id: "old-1", channel: "phone", task: "x", details: "", coach: "junie", created: 1000, script: { title: "Old local script", energy: "low", stakes: "low", norm: "", opener: "a", ask: "b", responses: [], stall: "c", exit: "d", closer: "e", message: "", alternative: "", comfort: [] } }]));
  });
  await legacy.page.goto(U);
  await legacy.page.fill("#dev-user", legacyUser);
  await legacy.page.click("#dev-signin button[type=submit]");
  await legacy.page.waitForSelector("#app:not([hidden])", { timeout: 15000 });
  await legacy.page.waitForFunction(() => document.querySelector("#sync-status")?.textContent === "Synced", null, { timeout: 15000 });
  const migrated = await api({ since: 0 }, legacyUser);
  ok("pre-account data uploaded to new account", migrated.items.some((i) => i.id === "old-1") && migrated.items.some((i) => i.kind === "profile" && i.data.name === "Old Me"));
  const legacyLeft = await legacy.page.evaluate(() => localStorage.getItem("humanual.scripts.v1"));
  ok("old unscoped copy removed after moving", legacyLeft === null);

  // 7. Sign out clears this user's data from the device.
  await phone.page.locator("button[aria-label=\"Open menu\"]:visible").click();
  await phone.page.click("#sign-out");
  await phone.page.waitForSelector("#signin:not([hidden])");
  const leftovers = await phone.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("humanual.u.")));
  ok("sign-out clears user data from device", leftovers.length === 0, leftovers.join(","));

  // 8. Offline: laptop goes offline, app still opens with saved data.
  await laptop.ctx.setOffline(true);
  await laptop.page.reload().catch(() => {});
  await laptop.page.waitForSelector("#app:not([hidden])", { timeout: 15000 }).catch(() => {});
  ok("app opens offline with saved data", await laptop.page.isVisible("#app"));
  await laptop.ctx.setOffline(false);

  await api(null, user, "DELETE");
  await api(null, legacyUser, "DELETE");
} catch (e) {
  results.push("ERROR  " + e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(results.join("\n"));
console.log(errors.length ? "Page errors:\n" + errors.join("\n") : "No page errors.");
process.exitCode = results.every((r) => r.startsWith("PASS")) ? 0 : 1;
