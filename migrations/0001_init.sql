-- One row per thing a user keeps: their profile, each conversation, each saved script.
-- `data` is the same JSON the browser stores. Deletes keep a tombstone row
-- (data NULL, deleted 1) so other devices learn about them on their next sync.
CREATE TABLE items (
  user_id    TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('profile', 'convo', 'script')),
  id         TEXT    NOT NULL,
  data       TEXT,
  updated_at INTEGER NOT NULL, -- when the user made the edit (client clock, ms); newest edit wins
  server_at  INTEGER NOT NULL, -- when the server stored it (ms); the sync cursor
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, kind, id)
);

CREATE INDEX items_by_sync ON items (user_id, server_at);
