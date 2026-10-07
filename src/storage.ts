// Sync for a user's profile, conversations, and saved scripts.
//
// Each device keeps a full copy in the browser and calls POST /api/sync with
// the edits it has made and the cursor from its last sync. The server applies
// the edits (newest edit wins, per item) and returns everything stored since
// that cursor, so every device converges on the same data.

const KINDS = new Set(["profile", "convo", "script"]);
const MAX_CHANGES = 200;
const MAX_ITEM_CHARS = 1_000_000; // D1 rows top out around 2 MB
const MAX_RETURNED = 500;
const ID_RE = /^[\w-]{1,64}$/;

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
  const since = Number.isFinite(body?.since) && body.since > 0 ? Math.floor(body.since) : 0;
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

  const { results } = await db
    .prepare(
      `SELECT kind, id, data, updated_at, server_at, deleted FROM items
       WHERE user_id = ?1 AND server_at > ?2
       ORDER BY server_at ASC LIMIT ?3`,
    )
    .bind(userId, since, MAX_RETURNED)
    .all<Row>();

  const items = results.map((r) => ({
    kind: r.kind,
    id: r.id,
    data: r.data === null ? null : JSON.parse(r.data),
    updated_at: r.updated_at,
    deleted: r.deleted === 1,
  }));
  const more = results.length === MAX_RETURNED;
  // Rows from one batch share a server_at. When the page is full, back the
  // cursor up by 1 ms so a batch split across pages is re-sent rather than
  // skipped (re-applying an item is harmless: newest edit still wins).
  const cursor = more ? results[results.length - 1].server_at - 1 : Math.max(since, now);
  return { items, cursor, more };
}

export async function deleteAll(db: D1Database, userId: string) {
  await db.prepare("DELETE FROM items WHERE user_id = ?1").bind(userId).run();
}
