// Unit tests for sync (src/storage.ts) against the real schema in SQLite.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteAll, sync } from "../../src/storage.ts";
import { createTestDb } from "./d1-shim.ts";

const convo = (id: string, at: number) => ({ kind: "convo", id, updated_at: at, data: { id, title: id } });

test("newest edit wins per item", async () => {
  const db = createTestDb();
  await sync(db, "u1", { changes: [convo("c1", 2000)] });
  await sync(db, "u1", { changes: [{ ...convo("c1", 1000), data: { id: "c1", title: "older" } }] });
  const { items } = await sync(db, "u1", { since: 0 });
  assert.equal(items.find((i) => i.id === "c1")?.data.title, "c1");
});

test("users never see each other's items", async () => {
  const db = createTestDb();
  await sync(db, "u1", { changes: [convo("c1", 1000)] });
  const { items } = await sync(db, "u2", { since: 0 });
  assert.equal(items.length, 0);
});

test("delete-all leaves deletion markers that other devices receive", async () => {
  const db = createTestDb();
  const first = await sync(db, "u1", {
    changes: [convo("c1", 1000), { kind: "journal", id: "j1", updated_at: 1000, data: { id: "j1" } }],
  });
  // Another device already synced up to here.
  const otherCursor = first.cursor as number;

  // Worst case: the delete is stamped in the very millisecond that device's
  // sync ran (the server's "now", 2 s after the cursor it handed back).
  await deleteAll(db, "u1", otherCursor + 2_000);

  const { items } = await sync(db, "u1", { since: otherCursor });
  const byKey = new Map(items.map((i) => [`${i.kind}:${i.id}`, i]));
  assert.equal(byKey.get("convo:c1")?.deleted, true);
  assert.equal(byKey.get("journal:j1")?.deleted, true);
  assert.equal(byKey.get("convo:c1")?.data, null);
  // A profile marker is written even though this user never saved a profile:
  // it's what tells other devices to wipe themselves.
  assert.equal(byKey.get("profile:me")?.deleted, true);
});

test("an older edit from a device that missed delete-all can't bring data back", async () => {
  const db = createTestDb();
  await sync(db, "u1", { changes: [convo("c1", 1000)] });
  await deleteAll(db, "u1", 5000);
  await sync(db, "u1", { changes: [convo("c1", 4000)] });
  const { items } = await sync(db, "u1", { since: 0 });
  assert.equal(items.find((i) => i.id === "c1")?.deleted, true);
});

test("a newer edit after delete-all is kept (starting fresh works)", async () => {
  const db = createTestDb();
  await deleteAll(db, "u1", 5000);
  await sync(db, "u1", { changes: [{ kind: "profile", id: "me", updated_at: 6000, data: { name: "New" } }] });
  const { items } = await sync(db, "u1", { since: 0 });
  const profile = items.find((i) => i.kind === "profile");
  assert.equal(profile?.deleted, false);
  assert.equal(profile?.data.name, "New");
});

test("pages through many rows with the same server time without repeats or gaps", async () => {
  const db = createTestDb();
  // A delete-all stamps every row with one server time; 1,234 rows is more
  // than two full pages.
  const values = Array.from({ length: 1234 }, (_, i) => `('u1', 'convo', 'c${String(i).padStart(4, "0")}', NULL, 1, 7777, 1)`);
  await db.exec(`INSERT INTO items (user_id, kind, id, data, updated_at, server_at, deleted) VALUES ${values.join(",")}`);

  const seen: string[] = [];
  let cursor: unknown = 0;
  for (let page = 0; page < 10; page++) {
    const res = await sync(db, "u1", { since: cursor });
    seen.push(...res.items.map((i) => i.id));
    cursor = res.cursor;
    if (!res.more) break;
  }
  assert.equal(seen.length, 1234, "every row exactly once");
  assert.equal(new Set(seen).size, 1234);
});

test("a garbled cursor starts over instead of failing", async () => {
  const db = createTestDb();
  await sync(db, "u1", { changes: [convo("c1", 1000)] });
  for (const since of ["nonsense", "1|bogus|x", -5, null, { a: 1 }]) {
    const { items } = await sync(db, "u1", { since });
    assert.equal(items.length, 1, JSON.stringify(since));
  }
});

test("an edit time far in the future is pulled back to the server's time", async () => {
  const db = createTestDb();
  const before = Date.now();
  await sync(db, "u1", { changes: [convo("c1", before + 10 * 365 * 24 * 3600 * 1000)] });
  const stored = (await sync(db, "u1", { since: 0 })).items[0].updated_at;
  assert.ok(stored <= Date.now() + 60_000, `stored ${stored}`);
  // So a later real edit from another device still wins.
  await sync(db, "u1", { changes: [{ ...convo("c1", Date.now() + 120_000), data: { id: "c1", title: "later" } }] });
  assert.equal((await sync(db, "u1", { since: 0 })).items[0].data.title, "later");
});

test("a full account refuses new data but still accepts deletes and shrinking edits", async () => {
  const db = createTestDb();
  const big = "x".repeat(900_000);
  // Fill to just under the cap directly, as 55 items of ~900 KB.
  const values = Array.from({ length: 55 }, (_, i) =>
    `('u1', 'convo', 'big${i}', '${JSON.stringify({ t: big })}', 1, 1, 0)`);
  await db.exec(`INSERT INTO items (user_id, kind, id, data, updated_at, server_at, deleted) VALUES ${values.join(",")}`);

  await assert.rejects(
    sync(db, "u1", { changes: [{ kind: "convo", id: "new", updated_at: 2, data: { t: big } }] }),
    /account is full/
  );
  // Shrinking an item and deleting one both go through.
  await sync(db, "u1", { changes: [{ kind: "convo", id: "big0", updated_at: 2, data: { t: "small" } }] });
  await sync(db, "u1", { changes: [{ kind: "convo", id: "big1", updated_at: 2, data: null, deleted: true }] });
  const { items } = await sync(db, "u1", { since: 0 });
  assert.equal(items.find((i) => i.id === "big0")?.data.t, "small");
  assert.equal(items.find((i) => i.id === "big1")?.deleted, true);
  assert.equal(items.some((i) => i.id === "new"), false);
});
