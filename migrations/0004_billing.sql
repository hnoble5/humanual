-- Each signed-in user's Stripe customer and their Humanual subscription, one
-- row per user. The row is created when they first open checkout, and kept up
-- to date by Stripe's webhooks (src/billing.ts). Stripe is the source of
-- truth; this is a copy so the coach can check someone's plan without calling
-- Stripe on every message.
CREATE TABLE billing (
  user_id              TEXT    PRIMARY KEY,
  customer_id          TEXT    NOT NULL UNIQUE,
  subscription_id      TEXT,              -- NULL until they subscribe
  status               TEXT,              -- Stripe's subscription status: active, past_due, canceled, ...
  price_lookup_key     TEXT,              -- which price they're on, e.g. humanual_founding_monthly
  current_period_end   INTEGER,           -- when the paid-for period ends (ms)
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER NOT NULL   -- ms
);
