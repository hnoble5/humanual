-- Adds 'journal' (journal entries) to the kinds of item a user can keep.
-- SQLite can't change a CHECK constraint in place, so the table is rebuilt.
CREATE TABLE items_new (
  user_id    TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('profile', 'convo', 'script', 'journal')),
  id         TEXT    NOT NULL,
  data       TEXT,
  updated_at INTEGER NOT NULL,
  server_at  INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, kind, id)
);
INSERT INTO items_new SELECT user_id, kind, id, data, updated_at, server_at, deleted FROM items;
DROP TABLE items;
ALTER TABLE items_new RENAME TO items;
CREATE INDEX items_by_sync ON items (user_id, server_at);
