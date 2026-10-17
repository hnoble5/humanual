-- The guest trial (src/guest.ts): people without an account get a few free
-- coach messages. Counted here, on the server, so clearing the browser doesn't
-- reset them. One row per counter, keyed by what it counts:
--   guest:<id>        one guest browser, for all time (GUEST_MESSAGE_LIMIT)
--   ip:<hash>:<day>   one network per UTC day (GUEST_IP_DAILY_MESSAGES); the
--                     address is stored only as a hash
--   day:<day>         all guests together per UTC day (GUEST_DAILY_LIMIT_USD)
-- cost_micros is the estimated Anthropic bill in millionths of a dollar.
CREATE TABLE guest_usage (
  key         TEXT    PRIMARY KEY,
  messages    INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
