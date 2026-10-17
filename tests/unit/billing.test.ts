// Unit tests for payments (src/billing.ts) against the real schema in SQLite,
// with a stand-in for the Stripe API. No network calls.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { createTestDb } from "./d1-shim.ts";
import {
  BillingError,
  createCheckout,
  createPortal,
  customerOf,
  ensureCustomer,
  getBilling,
  handleWebhook,
  hasPaidPlan,
  isPaidStatus,
  planSummary,
  syncCustomer,
} from "../../src/billing.ts";
import { monthlyLimitMicros } from "../../src/usage.ts";

const WHSEC = "whsec_test_secret";
const real = new Stripe("sk_test_unused");

function sub(over: Record<string, any> = {}) {
  return {
    id: "sub_1",
    object: "subscription",
    status: "active",
    created: 1_790_000_000,
    cancel_at_period_end: false,
    cancel_at: null,
    metadata: { clerk_user_id: "user_a" },
    items: { data: [{ current_period_end: 1_792_000_000, price: { id: "price_m", lookup_key: "humanual_founding_monthly" } }] },
    ...over,
  };
}

/** A fake Stripe client that records calls. `subs` is what subscriptions.list returns. */
function fakeStripe(state: { subs?: any[] } = {}) {
  const calls: Record<string, any[]> = {};
  const log = (name: string, args: any) => ((calls[name] ??= []).push(args), args);
  let customers = 0;
  const stripe = {
    customers: {
      create: async (params: any, opts: any) => (log("customers.create", { params, opts }), { id: `cus_${++customers}` }),
    },
    prices: {
      list: async (params: any) => {
        log("prices.list", params);
        const all = [
          { id: "price_m", lookup_key: "humanual_founding_monthly", unit_amount: 600, currency: "usd", recurring: { interval: "month" } },
          { id: "price_y", lookup_key: "humanual_founding_yearly", unit_amount: 5000, currency: "usd", recurring: { interval: "year" } },
        ];
        return { data: all.filter((p) => params.lookup_keys.includes(p.lookup_key)) };
      },
    },
    checkout: { sessions: { create: async (params: any) => (log("checkout", params), { url: "https://checkout.stripe.com/c/test" }) } },
    billingPortal: { sessions: { create: async (params: any) => (log("portal", params), { url: "https://billing.stripe.com/p/test" }) } },
    subscriptions: { list: async (params: any) => (log("subscriptions.list", params), { data: state.subs ?? [] }) },
    webhooks: real.webhooks,
  };
  return { stripe: stripe as unknown as Stripe, calls };
}

test("only active, trialing and past_due subscriptions count as paid", () => {
  for (const s of ["active", "trialing", "past_due"]) assert.ok(isPaidStatus(s), s);
  for (const s of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused", null, undefined]) assert.ok(!isPaidStatus(s), String(s));
});

test("a customer is created once per user, with an idempotency key", async () => {
  const db = createTestDb();
  const { stripe, calls } = fakeStripe();
  const first = await ensureCustomer(stripe, db, "user_a", "a@example.com");
  const again = await ensureCustomer(stripe, db, "user_a", "a@example.com");
  assert.equal(first, again);
  assert.equal(calls["customers.create"].length, 1);
  const { params, opts } = calls["customers.create"][0];
  assert.equal(params.email, "a@example.com");
  assert.equal(params.metadata.clerk_user_id, "user_a");
  assert.equal(opts.idempotencyKey, "humanual-customer-user_a");
});

test("checkout opens a subscription for the chosen price, tagged with the user", async () => {
  const db = createTestDb();
  const { stripe, calls } = fakeStripe();
  const url = await createCheckout(stripe, db, {
    userId: "user_a",
    email: null,
    plan: "yearly",
    origin: "https://app.example.com",
    automaticTax: false,
  });
  assert.equal(url, "https://checkout.stripe.com/c/test");
  const s = calls.checkout[0];
  assert.equal(s.mode, "subscription");
  assert.equal(s.customer, "cus_1");
  assert.deepEqual(s.line_items, [{ price: "price_y", quantity: 1 }]);
  assert.equal(s.client_reference_id, "user_a");
  assert.equal(s.subscription_data.metadata.clerk_user_id, "user_a");
  assert.equal(s.success_url, "https://app.example.com/?billing=success");
  assert.equal(s.automatic_tax, undefined, "tax stays off until it's turned on");
  assert.equal(s.payment_method_types, undefined, "payment methods come from the Dashboard");
  assert.match(s.integration_identifier, /-[a-z]{8}$/);
});

test("with tax on, checkout calculates tax and saves the address it collects", async () => {
  const db = createTestDb();
  const { stripe, calls } = fakeStripe();
  await createCheckout(stripe, db, { userId: "u", email: null, plan: "monthly", origin: "https://a.example", automaticTax: true });
  assert.deepEqual(calls.checkout[0].automatic_tax, { enabled: true });
  assert.deepEqual(calls.checkout[0].customer_update, { address: "auto" });
});

test("someone already subscribed is sent to Manage billing instead of a second checkout", async () => {
  const db = createTestDb();
  const { stripe } = fakeStripe({ subs: [sub()] });
  await ensureCustomer(stripe, db, "user_a", null);
  await syncCustomer(stripe, db, "cus_1");
  await assert.rejects(
    createCheckout(stripe, db, { userId: "user_a", email: null, plan: "monthly", origin: "https://a.example", automaticTax: false }),
    (err) => err instanceof BillingError && err.status === 409,
  );
});

test("the portal needs a customer, and returns to the app", async () => {
  const db = createTestDb();
  const { stripe, calls } = fakeStripe();
  await assert.rejects(createPortal(stripe, db, "user_a", "https://a.example"), (e) => e instanceof BillingError && e.status === 404);
  await ensureCustomer(stripe, db, "user_a", null);
  assert.equal(await createPortal(stripe, db, "user_a", "https://a.example"), "https://billing.stripe.com/p/test");
  assert.deepEqual(calls.portal[0], { customer: "cus_1", return_url: "https://a.example/" });
});

test("syncing copies the subscription from Stripe, and a cancellation ends the paid plan", async () => {
  const db = createTestDb();
  const state: { subs: any[] } = { subs: [sub()] };
  const { stripe } = fakeStripe(state);
  await ensureCustomer(stripe, db, "user_a", null);

  const row = await syncCustomer(stripe, db, "cus_1", 1000);
  assert.equal(row?.status, "active");
  assert.equal(row?.subscription_id, "sub_1");
  assert.equal(row?.price_lookup_key, "humanual_founding_monthly");
  assert.equal(row?.current_period_end, 1_792_000_000_000);
  assert.ok(await hasPaidPlan(db, "user_a"));

  state.subs = [sub({ cancel_at: 1_792_000_000 })];
  assert.equal((await syncCustomer(stripe, db, "cus_1"))?.cancel_at_period_end, 1, "still paid until the period ends");
  assert.ok(await hasPaidPlan(db, "user_a"));

  state.subs = [sub({ status: "canceled" })];
  await syncCustomer(stripe, db, "cus_1");
  assert.ok(!(await hasPaidPlan(db, "user_a")));
});

test("with two subscriptions, the one that grants access wins", async () => {
  const db = createTestDb();
  const { stripe } = fakeStripe({
    subs: [sub({ id: "sub_new", status: "incomplete_expired", created: 2 }), sub({ id: "sub_old", status: "active", created: 1 })],
  });
  await ensureCustomer(stripe, db, "user_a", null);
  assert.equal((await syncCustomer(stripe, db, "cus_1"))?.subscription_id, "sub_old");
});

test("an unknown customer is only taken if Humanual's checkout tagged the subscription", async () => {
  const db = createTestDb();
  assert.equal(await syncCustomer(fakeStripe({ subs: [sub({ metadata: {} })] }).stripe, db, "cus_x"), null);
  const row = await syncCustomer(fakeStripe({ subs: [sub({ metadata: { clerk_user_id: "user_b" } })] }).stripe, db, "cus_y");
  assert.equal(row?.user_id, "user_b");
  assert.equal((await getBilling(db, "user_b"))?.customer_id, "cus_y");
});

test("events are traced back to their customer", () => {
  const ev = (type: string, object: any) => ({ type, data: { object } }) as any;
  assert.equal(customerOf(ev("checkout.session.completed", { object: "checkout.session", mode: "subscription", customer: "cus_1" })), "cus_1");
  assert.equal(customerOf(ev("checkout.session.completed", { object: "checkout.session", mode: "payment", customer: "cus_1" })), null);
  assert.equal(customerOf(ev("customer.subscription.updated", { object: "subscription", customer: "cus_2" })), "cus_2");
  assert.equal(customerOf(ev("invoice.payment_failed", { object: "invoice", customer: { id: "cus_3" } })), "cus_3");
  assert.equal(customerOf(ev("charge.refunded", { object: "charge", customer: "cus_4" })), null);
});

const webhookEnv = (db: D1Database) => ({ DB: db, STRIPE_API_KEY: "sk_test_unused", STRIPE_WEBHOOK_SECRET: WHSEC }) as unknown as Env;

async function signed(payload: object, secret = WHSEC) {
  const body = JSON.stringify(payload);
  const header = await real.webhooks.generateTestHeaderStringAsync({
    payload: body,
    secret,
    cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });
  return new Request("https://coach.example.com/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body,
  });
}

test("the webhook rejects anything not signed with the endpoint's secret", async () => {
  const db = createTestDb();
  const { stripe } = fakeStripe({ subs: [sub()] });
  const event = { id: "evt_1", type: "customer.subscription.updated", data: { object: { object: "subscription", customer: "cus_1" } } };

  const unsigned = new Request("https://x/api/stripe/webhook", { method: "POST", body: JSON.stringify(event) });
  assert.equal((await handleWebhook(unsigned, webhookEnv(db), stripe)).status, 400);
  assert.equal((await handleWebhook(await signed(event, "whsec_wrong"), webhookEnv(db), stripe)).status, 400);
  assert.equal(await getBilling(db, "user_a"), null, "nothing was stored");
});

test("a signed subscription event updates the user's plan", async () => {
  const db = createTestDb();
  const { stripe } = fakeStripe({ subs: [sub()] });
  await ensureCustomer(stripe, db, "user_a", null);
  const event = { id: "evt_2", type: "customer.subscription.created", data: { object: { object: "subscription", customer: "cus_1" } } };
  const res = await handleWebhook(await signed(event), webhookEnv(db), stripe);
  assert.equal(res.status, 200);
  assert.ok(await hasPaidPlan(db, "user_a"));
});

test("if Stripe can't be reached, the webhook answers 500 so Stripe retries", async () => {
  const db = createTestDb();
  const { stripe } = fakeStripe();
  (stripe as any).subscriptions.list = async () => {
    throw new Error("network down");
  };
  const event = { id: "evt_3", type: "invoice.paid", data: { object: { object: "invoice", customer: "cus_1" } } };
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await handleWebhook(await signed(event), webhookEnv(db), stripe)).status, 500);
  } finally {
    console.error = original;
  }
});

test("the plan summary the app shows", () => {
  assert.deepEqual(planSummary(null), {
    plan: "free",
    status: null,
    interval: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    pastDue: false,
    canManage: false,
  });
  const s = planSummary({
    user_id: "u",
    customer_id: "c",
    subscription_id: "s",
    status: "past_due",
    price_lookup_key: "humanual_founding_yearly",
    current_period_end: 5,
    cancel_at_period_end: 1,
    updated_at: 0,
  });
  assert.equal(s.plan, "founding");
  assert.equal(s.interval, "year");
  assert.ok(s.pastDue && s.cancelAtPeriodEnd && s.canManage);
});

test("paid members get the paid allowance", () => {
  const env = { USER_MONTHLY_LIMIT_USD: "0.5", PAID_MONTHLY_LIMIT_USD: "3" };
  assert.equal(monthlyLimitMicros(env), 500_000);
  assert.equal(monthlyLimitMicros(env, true), 3_000_000);
  assert.equal(monthlyLimitMicros({}, true), 3_000_000, "defaults to $3");
  assert.equal(monthlyLimitMicros({ PAID_MONTHLY_LIMIT_USD: "x" }, true), 3_000_000);
});
