-- How much of the AI each signed-in user has used, one row per user per month
-- (UTC, "2026-10"). The coach checks this before every AI call and stops when a
-- user reaches their monthly allowance (USER_MONTHLY_LIMIT_USD).
-- cost_micros is the estimated Anthropic bill in millionths of a dollar.
CREATE TABLE usage (
  user_id            TEXT    NOT NULL,
  month              TEXT    NOT NULL,
  requests           INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros        INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (user_id, month)
);
