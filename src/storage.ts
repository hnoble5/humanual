// Sync for a user's profile, conversations, saved scripts, and journal entries.
//
// Each device keeps a full copy in the browser and calls POST /api/sync with
// the edits it has made and the cursor from its last sync. The server applies
// the edits (newest edit wins, per item) and returns everything stored since
// that cursor, so every device converges on the same data.

const KINDS = new Set(["profile", "convo", "script", "journal"]);
const MAX_CHANGES = 200;
const MAX_ITEM_CHARS = 1_000_000; // D1 rows top out around 2 MB
const MAX_RETURNED = 500;
const ID_RE = /^[\w-]{1,64}$/;
const CURSOR_LOOKBACK_MS = 2_000;

export class SyncError extends Error {}

interface Change {
  kind: string;
  id: string;
  data: unknown;
  updated_at: number;
  deleted: boolean;
}

interface Row {
  kind: string;
  id: string;
  data: string | null;
  updated_at: number;
  server_at: number;
  deleted: number;
}

function parseChanges(raw: unknown): Change[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new SyncError("changes must be a list");
  if (raw.length > MAX_CHANGES) throw new SyncError("Too many changes at once");
  return raw.map((c: any) => {
    if (!c || !KINDS.has(c.kind) || typeof c.id !== "string" || !ID_RE.test(c.id)) {
      throw new SyncError("Invalid change");
    }
    if (!Number.isFinite(c.updated_at) || c.updated_at <= 0) throw new SyncError("Invalid change time");
    const deleted = c.deleted === true;
    if (!deleted && (c.data === null || typeof c.data !== "object")) throw new SyncError("Missing data");
    return { kind: c.kind, id: c.id, data: deleted ? null : c.data, updated_at: Math.floor(c.updated_at), deleted };
  });
}

export async function sync(db: D1Database, userId: string, body: any) {
  const changes = parseChanges(body?.changes);
  const since = parseCursor(body?.since);
  const now = Date.now();

  if (changes.length) {
    // Upsert, but only when this edit is at least as new as the stored one.
    const stmt = db.prepare(
      `INSERT INTO items (user_id, kind, id, data, updated_at, server_at, deleted)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (user_id, kind, id) DO UPDATE SET
         data = excluded.data, updated_at = excluded.updated_at,
         server_at = excluded.server_at, deleted = excluded.deleted
       WHERE excluded.updated_at >= items.updated_at`,
    );
    const batch = changes.map((c) => {
      const json = c.deleted ? null : JSON.stringify(c.data);
      if (json && json.length > MAX_ITEM_CHARS) {
        throw new SyncError("A conversation is too large to save. Start a new one.");
      }
      return stmt.bind(userId, c.kind, c.id, json, c.updated_at, now, c.deleted ? 1 : 0);
    });
    await db.batch(batch);
  }

  // Rows come back in (server_at, kind, id) order. A full page ends with a
  // cursor naming its last row, so the next page starts right after it, even
  // when many rows share one server_at (a delete-all writes hundreds at once).
  const { results } = await db
    .prepare(
      `SELECT kind, id, data, updated_at, server_at, deleted FROM items
       WHERE user_id = ?1 AND (server_at > ?2 OR (server_at = ?2 AND (kind, id) > (?3, ?4)))
       ORDER BY server_at ASC, kind ASC, id ASC LIMIT ?5`,
    )
    .bind(userId, since.at, since.kind, since.id, MAX_RETURNED)
    .all<Row>();

  const items = results.map((r) => ({
    kind: r.kind,
    id: r.id,
    data: r.data === null ? null : JSON.parse(r.data),
    updated_at: r.updated_at,
    deleted: r.deleted === 1,
  }));
  const more = results.length === MAX_RETURNED;
  const last = results[results.length - 1];
  // Between pages: resume right after the last row sent. At the end: look back
  // a couple of seconds rather than stopping at "now", so a write stamped in
  // the same moment by another request (or still committing) isn't skipped.
  // Re-sending an item is harmless: the newest edit still wins.
  const cursor: string | number = more
    ? `${last.server_at}|${last.kind}|${last.id}`
    : Math.max(since.at, now - CURSOR_LOOKBACK_MS);
  return { items, cursor, more };
}

// The browser treats the cursor as opaque: it's a number (a time, meaning
// "everything after this"), or "time|kind|id" partway through a page run.
// Anything else starts from the beginning, which is always safe to re-apply.
function parseCursor(raw: unknown): { at: number; kind: string; id: string } {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return { at: Math.floor(raw), kind: "\uffff", id: "" };
  if (typeof raw === "string") {
    const m = /^(\d{1,16})\|([a-z]{1,16})\|([\w-]{1,64})$/.exec(raw);
    if (m && KINDS.has(m[2])) return { at: Number(m[1]), kind: m[2], id: m[3] };
  }
  return { at: 0, kind: "\uffff", id: "" };
}

/**
 * Deletes everything a user keeps. Rows become deletion markers (data gone,
 * deleted = 1) rather than vanishing, so the user's other devices learn about
 * it on their next sync and clear their copies. A profile marker is always
 * written: that's the signal for a device to wipe itself.
 */
export async function deleteAll(db: D1Database, userId: string, now = Date.now()) {
  await db.batch([
    db
      .prepare(
        `UPDATE items SET data = NULL, deleted = 1, updated_at = MAX(updated_at, ?2), server_at = ?2
         WHERE user_id = ?1`,
      )
      .bind(userId, now),
    db
      .prepare(
        `INSERT INTO items (user_id, kind, id, data, updated_at, server_at, deleted)
         VALUES (?1, 'profile', 'me', NULL, ?2, ?2, 1)
         ON CONFLICT (user_id, kind, id) DO NOTHING`,
      )
      .bind(userId, now),
  ]);
}
