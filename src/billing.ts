// Paid plans through Stripe: hosted Checkout to subscribe, the Stripe customer
// portal to change or cancel, and webhooks that keep the `billing` table (D1)
// in step with Stripe. The coach reads that table to pick a user's monthly AI
// allowance (src/usage.ts).
//
// Stripe is the source of truth. Whenever anything happens to a customer's
// subscription, we re-read their subscriptions from Stripe instead of trusting
// the order events arrive in, so a late or repeated event can't leave the
// wrong status behind.
import Stripe from "stripe";

/** The prices a user can pick, by Stripe lookup key. Live and test mode use the same keys. */
export const PLANS = {
  monthly: "humanual_founding_monthly",
  yearly: "humanual_founding_yearly",
} as const;
export type PlanChoice = keyof typeof PLANS;

/**
 * Subscription statuses that unlock the paid allowance. past_due keeps access
 * while Stripe retries a failed card; once retries run out the status moves on
 * (canceled or unpaid, per the Dashboard's revenue recovery settings).
 */
const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);

/** Tags these sessions in the Stripe Dashboard, so this flow can be told apart from others. */
const INTEGRATION_ID = "humanual-founding-checkout-qwhzmrtk";

/** The webhook events Stripe should send (README, "Payments"). */
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

export interface BillingRow {
  user_id: string;
  customer_id: string;
  subscription_id: string | null;
  status: string | null;
  price_lookup_key: string | null;
  current_period_end: number | null;
  cancel_at_period_end: number;
  updated_at: number;
}

export class BillingError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** True when payments are set up on this server (both Stripe secrets present). */
export function billingEnabled(env: Pick<Env, "STRIPE_API_KEY" | "STRIPE_WEBHOOK_SECRET">): boolean {
  return Boolean(env.STRIPE_API_KEY && env.STRIPE_WEBHOOK_SECRET);
}

export function stripeClient(env: Pick<Env, "STRIPE_API_KEY">): Stripe {
  return new Stripe(env.STRIPE_API_KEY!, {
    // Workers have fetch, not Node's http module.
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
    appInfo: { name: "Humanual", url: "https://humanual.elitetestautomation.com" },
  });
}

export const isPaidStatus = (status: string | null | undefined) => Boolean(status && PAID_STATUSES.has(status));

export async function getBilling(db: D1Database, userId: string): Promise<BillingRow | null> {
  return db.prepare("SELECT * FROM billing WHERE user_id = ?").bind(userId).first<BillingRow>();
}

/** Whether this user is on a paid plan right now. */
export async function hasPaidPlan(db: D1Database, userId: string): Promise<boolean> {
  const row = await db.prepare("SELECT status FROM billing WHERE user_id = ?").bind(userId).first<{ status: string | null }>();
  return isPaidStatus(row?.status);
}

/**
 * The user's Stripe customer, created the first time they open checkout. The
 * idempotency key stops a double click from making two customers; the UNIQUE
 * user_id keeps one row even if two requests race.
 */
export async function ensureCustomer(
  stripe: Stripe,
  db: D1Database,
  userId: string,
  email: string | null,
  now = Date.now(),
): Promise<string> {
  const existing = await getBilling(db, userId);
  if (existing) return existing.customer_id;

  const customer = await stripe.customers.create(
    { ...(email ? { email } : {}), metadata: { clerk_user_id: userId } },
    { idempotencyKey: `humanual-customer-${userId}` },
  );
  await db
    .prepare("INSERT INTO billing (user_id, customer_id, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING")
    .bind(userId, customer.id, now)
    .run();
  return (await getBilling(db, userId))!.customer_id;
}

async function priceFor(stripe: Stripe, plan: PlanChoice): Promise<Stripe.Price> {
  const { data } = await stripe.prices.list({ lookup_keys: [PLANS[plan]], active: true, limit: 1 });
  if (!data[0]) throw new BillingError("That plan isn't available right now.", 503);
  return data[0];
}

/** The plans' prices as Stripe has them, for the app to show. */
export async function listPlans(stripe: Stripe) {
  const { data } = await stripe.prices.list({ lookup_keys: Object.values(PLANS), active: true, limit: 10 });
  const byKey = new Map(data.map((p) => [p.lookup_key, p]));
  return (Object.keys(PLANS) as PlanChoice[]).flatMap((plan) => {
    const p = byKey.get(PLANS[plan]);
    return p ? [{ plan, amount: p.unit_amount ?? 0, currency: p.currency, interval: p.recurring?.interval ?? null }] : [];
  });
}

/** A hosted Checkout page for a new subscription. Returns its URL. */
export async function createCheckout(
  stripe: Stripe,
  db: D1Database,
  opts: { userId: string; email: string | null; plan: PlanChoice; origin: string; automaticTax: boolean },
): Promise<string> {
  const row = await getBilling(db, opts.userId);
  if (isPaidStatus(row?.status)) {
    throw new BillingError("You already have a plan. Use Manage billing to change it.", 409);
  }
  const customer = await ensureCustomer(stripe, db, opts.userId, opts.email);
  const price = await priceFor(stripe, opts.plan);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: opts.userId,
    line_items: [{ price: price.id, quantity: 1 }],
    subscription_data: { metadata: { clerk_user_id: opts.userId } },
    allow_promotion_codes: true,
    integration_identifier: INTEGRATION_ID,
    // Tax only when Stripe Tax is set up (README, "Sales tax"). Saving the
    // address Checkout collects lets renewals use it too.
    ...(opts.automaticTax ? { automatic_tax: { enabled: true }, customer_update: { address: "auto" as const } } : {}),
    success_url: `${opts.origin}/?billing=success`,
    cancel_url: `${opts.origin}/?billing=cancel`,
  });
  if (!session.url) throw new BillingError("Couldn't open checkout. Try again.", 502);
  return session.url;
}

/** The Stripe customer portal, where users change plans, update cards, cancel, and see invoices. */
export async function createPortal(stripe: Stripe, db: D1Database, userId: string, origin: string): Promise<string> {
  const row = await getBilling(db, userId);
  if (!row) throw new BillingError("You don't have a plan yet.", 404);
  const session = await stripe.billingPortal.sessions.create({ customer: row.customer_id, return_url: `${origin}/` });
  return session.url;
}

// A customer normally has one subscription. If they somehow have more (two
// checkouts in two tabs), the one that grants access wins, then the newest.
function bestSubscription(subs: Stripe.Subscription[]): Stripe.Subscription | null {
  return [...subs].sort((a, b) => Number(isPaidStatus(b.status)) - Number(isPaidStatus(a.status)) || b.created - a.created)[0] ?? null;
}

/**
 * Copies a customer's current subscription from Stripe into the billing
 * table. Safe to run any number of times, in any order.
 */
export async function syncCustomer(stripe: Stripe, db: D1Database, customerId: string, now = Date.now()): Promise<BillingRow | null> {
  let userId = (
    await db.prepare("SELECT user_id FROM billing WHERE customer_id = ?").bind(customerId).first<{ user_id: string }>()
  )?.user_id;

  const { data } = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 });
  const sub = bestSubscription(data);

  if (!userId) {
    // Not one of ours (made in the Dashboard, or another product): only take it
    // if Humanual's checkout tagged it with the user.
    const tagged = sub?.metadata?.clerk_user_id;
    if (!tagged) return null;
    userId = tagged;
  }

  const item = sub?.items.data[0];
  await db
    .prepare(
      `INSERT INTO billing (user_id, customer_id, subscription_id, status, price_lookup_key, current_period_end, cancel_at_period_end, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         customer_id = excluded.customer_id,
         subscription_id = excluded.subscription_id,
         status = excluded.status,
         price_lookup_key = excluded.price_lookup_key,
         current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end,
         updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      customerId,
      sub?.id ?? null,
      sub?.status ?? null,
      item?.price.lookup_key ?? null,
      item?.current_period_end ? item.current_period_end * 1000 : null,
      sub ? Number(Boolean(sub.cancel_at_period_end || sub.cancel_at)) : 0,
      now,
    )
    .run();
  return getBilling(db, userId);
}

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : v?.id ?? null);

/** Which customer an event is about, for the events we listen to. */
export function customerOf(event: Stripe.Event): string | null {
  const obj = event.data.object as { object?: string; customer?: string | { id: string } | null; mode?: string };
  if (event.type === "checkout.session.completed" && obj.mode !== "subscription") return null;
  if (obj.object === "checkout.session" || obj.object === "subscription" || obj.object === "invoice") {
    return idOf(obj.customer);
  }
  return null;
}

/**
 * Handles a webhook request: checks Stripe's signature, then re-syncs the
 * customer the event is about. Answers 400 to anything not signed by Stripe.
 */
export async function handleWebhook(request: Request, env: Env, stripe = stripeClient(env)): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  const body = await request.text();
  let event: Stripe.Event;
  try {
    if (!signature) throw new Error("missing signature");
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      env.STRIPE_WEBHOOK_SECRET!,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  const customerId = customerOf(event);
  if (!customerId) return new Response("ignored", { status: 200 });
  try {
    await syncCustomer(stripe, env.DB, customerId);
  } catch (err) {
    // A 500 makes Stripe retry the event later, with backoff, for up to 3 days.
    console.error("stripe webhook sync failed", event.type, event.id, err);
    return new Response("sync failed", { status: 500 });
  }
  return new Response("ok", { status: 200 });
}

/** What the app shows under Plan in Settings. */
export function planSummary(row: BillingRow | null) {
  const paid = isPaidStatus(row?.status);
  return {
    plan: paid ? "founding" : "free",
    status: row?.status ?? null,
    interval: row?.price_lookup_key === PLANS.yearly ? "year" : row?.price_lookup_key === PLANS.monthly ? "month" : null,
    periodEnd: row?.current_period_end ?? null,
    cancelAtPeriodEnd: Boolean(row?.cancel_at_period_end),
    pastDue: row?.status === "past_due",
    // Anyone who has ever opened checkout has a customer, and so a portal with their invoices.
    canManage: Boolean(row),
  };
}
