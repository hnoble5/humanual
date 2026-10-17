// Browser test for the Plan section and the trip to Stripe and back.
//
// Stripe itself is stood in for: the test answers the app's /api/billing*
// requests with made-up plans, so it needs no Stripe keys, charges nothing,
// and never leaves this machine. (The server side is covered by
// tests/unit/billing.test.ts.) Run against the local server with the dev
// sign-in turned on:
//   1. .dev.vars has DEV_AUTH=true and no Clerk keys
//   2. npx wrangler d1 migrations apply humanual --local
//   3. npm run dev               (in one terminal)
//   4. npm run test:billing      (in another)
//
// Uses your installed Chrome (playwright-core doesn't download a browser).
// Set CHROME_PATH to use a different Chromium.
import { chromium } from "playwright-core";

const U = "http://127.0.0.1:8787";
const user = "billing" + Date.now().toString(36);
const results = [];
const ok = (name, cond, extra = "") => { results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`); };

const PLANS = [
  { plan: "monthly", amount: 600, currency: "usd", interval: "month" },
  { plan: "yearly", amount: 5000, currency: "usd", interval: "year" },
];
const FREE = { plan: "free", status: null, interval: null, periodEnd: null, cancelAtPeriodEnd: false, pastDue: false, canManage: false, usedPercent: 40, plans: PLANS };
const RENEWS = Date.UTC(2026, 10, 17, 12);
const FOUNDING = { ...FREE, plan: "founding", status: "active", interval: "month", periodEnd: RENEWS, canManage: true, usedPercent: 5 };

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" });
const errors = [];

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));

  // Pretend payments are set up on the server.
  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), billing: true } });
  });
  let plan = FREE;
  const statusRequests = [];
  await page.route("**/api/billing?**", (route) => (statusRequests.push(route.request().url()), route.fulfill({ json: plan })));
  await page.route("**/api/billing", (route) => (statusRequests.push(route.request().url()), route.fulfill({ json: plan })));
  let checkoutBody = null;
  await page.route("**/api/billing/checkout", (route) => {
    checkoutBody = route.request().postDataJSON();
    ok("checkout request carries the sign-in", route.request().headers()["x-dev-user"] === user);
    // Stand-in for Stripe: "pay", then come straight back as Stripe would.
    plan = FOUNDING;
    return route.fulfill({ json: { url: `${U}/?billing=success` } });
  });
  let portalOpened = false;
  await page.route("**/api/billing/portal", (route) => ((portalOpened = true), route.fulfill({ json: { url: `${U}/#journal` } })));

  // 1. Sign in and finish the welcome screen.
  await page.goto(U);
  await page.waitForSelector("#signin:not([hidden])");
  await page.fill("#dev-user", user);
  await page.click("#dev-signin button[type=submit]");
  await page.waitForSelector("#onboarding:not([hidden])");
  await page.fill("#ob-name", "Heather");
  await page.check("#ob-age");
  await page.click("#onboard-form button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");

  // 2. Free plan in Settings.
  await page.click("#open-settings");
  await page.waitForSelector("#plan-field:not([hidden]) .plan-buttons");
  const free = await page.textContent("#plan-body");
  ok("free plan is shown", free.includes("Free plan"), free.slice(0, 60));
  ok("this month's use is shown", free.includes("40%"));
  const buttons = await page.$$eval("#plan-body .plan-buttons .btn", (b) => b.map((x) => x.textContent.trim()));
  ok("both prices offered, from Stripe's prices", buttons[0] === "$6 a month" && buttons[1].startsWith("$50 a year"), buttons.join(" | "));
  ok("yearly shows the saving", buttons[1].includes("Saves $22 a year"));

  // 3. Subscribe: off to "Stripe" and back.
  await Promise.all([
    page.waitForRequest("**/api/billing/checkout"),
    page.click("#plan-body .plan-buttons .btn >> nth=0"),
  ]);
  ok("checkout asked for the monthly plan", checkoutBody?.plan === "monthly", JSON.stringify(checkoutBody));
  await page.waitForSelector("#settings[open] #plan-body .plan-note", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector("#plan-body")?.textContent.includes("Thank you for becoming a founding member"), null, { timeout: 10000 });
  ok("back from checkout: thank-you and active plan", true);
  ok("the return checked Stripe directly", statusRequests.some((u) => u.includes("refresh=1")));
  ok("the ?billing= flag is cleared from the address", !page.url().includes("billing="), page.url());
  const member = await page.textContent("#plan-body");
  ok("member view shows price and renewal date", member.includes("Founding member") && member.includes("$6 a month") && member.includes("Renews on"), member.slice(0, 120));
  ok("member view has Manage billing", (await page.textContent("#plan-body .plan-buttons")).includes("Manage billing"));

  // 4. Manage billing goes to the portal.
  await page.click("#plan-body .plan-buttons .btn");
  await page.waitForURL(`${U}/#journal`, { timeout: 10000 });
  ok("Manage billing opens the portal", portalOpened);

  // 5. Canceled but still paid up, and a failed payment.
  plan = { ...FOUNDING, cancelAtPeriodEnd: true };
  await page.goto(U);
  await page.waitForSelector("#app:not([hidden])");
  await page.click("#open-settings");
  await page.waitForFunction(() => document.querySelector("#plan-body")?.textContent.includes("Your plan is canceled"));
  ok("a canceled plan says when it ends", (await page.textContent("#plan-body")).includes("You keep it until"));
  await page.keyboard.press("Escape");
  plan = { ...FOUNDING, status: "past_due", pastDue: true };
  await page.click("#open-settings");
  await page.waitForFunction(() => document.querySelector("#plan-body")?.textContent.includes("didn't go through"));
  ok("a failed payment asks to update the card", true);
  await page.keyboard.press("Escape");

  // 6. A free user at their limit gets a way to the plans from the chat.
  plan = FREE;
  await page.route("**/api/chat", (route) =>
    route.fulfill({ status: 429, json: { error: "You've used this month's free coaching.", code: "limit", upgrade: true } }));
  await page.click(".view-btn[data-view=chat]");
  await page.click(".mode-card >> nth=0");
  await page.fill("#input", "Hi");
  await page.press("#input", "Enter");
  await page.waitForSelector(".error button:has-text('See plans')", { timeout: 10000 });
  ok("limit message offers See plans", true);
  await page.click(".error button:has-text('See plans')");
  await page.waitForSelector("#settings[open] #plan-field:not([hidden]) .plan-buttons");
  ok("See plans opens the Plan section", true);

  // 7. Guests never see a Plan section.
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.route("**/api/config", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), billing: true } });
  });
  await guest.goto(U);
  await guest.waitForSelector("#signin:not([hidden])");
  const guestButton = await guest.$("#continue-guest");
  if (guestButton) {
    await guestButton.click();
    await guest.waitForSelector("#onboarding:not([hidden])");
    await guest.fill("#ob-name", "G");
    await guest.check("#ob-age");
    await guest.click("#onboard-form button[type=submit]");
    await guest.waitForSelector("#app:not([hidden])");
    await guest.click("#open-settings");
    ok("guests don't see a Plan section", await guest.isHidden("#plan-field"));
  } else {
    ok("guest option found", false);
  }
} catch (err) {
  ok("test ran to the end", false, err.message.split("\n")[0]);
} finally {
  await browser.close();
}

ok("no page errors", errors.length === 0, errors.join("; "));
console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
