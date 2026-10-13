// A small stand-in for Cloudflare D1, backed by Node's built-in SQLite, so the
// sync code can be tested against the real schema without running a Worker.
// Covers only what src/storage.ts uses: prepare().bind().all()/run(), and batch().
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

export function createTestDb(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  }

  const statement = (sql: string, args: unknown[] = []) => {
    const run = () => sqlite.prepare(sql).run(...(args as any[]));
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      all: async () => ({ results: sqlite.prepare(sql).all(...(args as any[])), success: true, meta: {} }),
      first: async () => sqlite.prepare(sql).get(...(args as any[])) ?? null,
      run: async () => (run(), { success: true, meta: {} }),
      _run: run,
    };
  };

  return {
    prepare: (sql: string) => statement(sql),
    // D1 runs a batch as one transaction.
    batch: async (stmts: any[]) => {
      sqlite.exec("BEGIN");
      try {
        for (const s of stmts) s._run();
        sqlite.exec("COMMIT");
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
      return stmts.map(() => ({ success: true, meta: {} }));
    },
    // Lets tests set up rows directly.
    exec: async (sql: string) => (sqlite.exec(sql), { count: 0, duration: 0 }),
  } as unknown as D1Database;
}
