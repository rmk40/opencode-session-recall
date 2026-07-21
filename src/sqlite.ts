/**
 * SQLite driver adapter.
 *
 * opencode runs on Bun, where `bun:sqlite` is built in; tests and other Node
 * runtimes use `node:sqlite` (Node >= 22.5). Both are stdlib, so the store
 * carries zero npm dependencies. This is the ONLY module that touches a runtime
 * SQLite binding, and it does so exclusively through dynamic `import()` behind
 * variable specifiers so `src/` stays free of Node/Bun types (see AGENTS.md) and
 * so the bundler never tries to inline a native driver. Every open failure is
 * swallowed into a `null` return: a missing driver degrades the plugin to
 * ephemeral mode rather than throwing.
 */

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

/**
 * Minimal, driver-neutral surface over a SQLite connection.
 *
 * `run` returns both `changes` and `lastInsertRowid` (a deliberate, minimal
 * extension of the sketch's `{ changes }`): the per-session FTS mirror needs the
 * rowid assigned to each freshly inserted `part_text` row, and both drivers
 * report it natively. `get` normalizes the drivers' "no row" sentinel (bun
 * returns `null`, node returns `undefined`) to `undefined`.
 */
export type SqliteDb = {
  exec(sql: string): void;
  run(sql: string, params?: SqlValue[]): { changes: number; lastInsertRowid: number };
  get(sql: string, params?: SqlValue[]): Row | undefined;
  all(sql: string, params?: SqlValue[]): Row[];
  /** BEGIN IMMEDIATE / COMMIT, rolling back (best-effort) if `fn` throws. */
  tx<T>(fn: () => T): T;
  close(): void;
};

// ── Minimal structural typings for the two stdlib drivers ────────────────
// `src/` has no @types/node and no bun types, so we declare only the surface we
// use and cast the dynamic-import result through `unknown`. Widening the
// specifiers to `string` keeps tsc from resolving (and failing on) `bun:sqlite`,
// for which no type declarations exist.

type DriverRunResult = { changes: number | bigint; lastInsertRowid: number | bigint };

type NodeStatement = {
  run(...params: SqlValue[]): DriverRunResult;
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
};
type NodeDatabase = {
  exec(sql: string): void;
  prepare(sql: string): NodeStatement;
  close(): void;
};
type NodeSqliteModule = { DatabaseSync: new (path: string) => NodeDatabase };

type BunStatement = {
  // Older Bun returned `undefined` from run(); we fall back to `changes()` then.
  run(...params: SqlValue[]): DriverRunResult | undefined;
  get(...params: SqlValue[]): Row | null | undefined;
  all(...params: SqlValue[]): Row[];
};
type BunDatabase = {
  exec(sql: string): void;
  query(sql: string): BunStatement;
  close(): void;
};
type BunSqliteModule = {
  Database: new (path: string, options: { create: boolean }) => BunDatabase;
};

const NODE_SQLITE: string = "node:sqlite";
const BUN_SQLITE: string = "bun:sqlite";

type Primitives = {
  exec(sql: string): void;
  run(sql: string, params: SqlValue[]): { changes: number; lastInsertRowid: number };
  get(sql: string, params: SqlValue[]): Row | undefined;
  all(sql: string, params: SqlValue[]): Row[];
  close(): void;
};

/** Wrap driver primitives with the shared transaction and default-param logic. */
function makeSqliteDb(p: Primitives): SqliteDb {
  function tx<T>(fn: () => T): T {
    p.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      p.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        p.exec("ROLLBACK");
      } catch {
        // A failed rollback must not mask the original error.
      }
      throw error;
    }
  }
  return {
    exec: (sql) => p.exec(sql),
    run: (sql, params = []) => p.run(sql, params),
    get: (sql, params = []) => p.get(sql, params),
    all: (sql, params = []) => p.all(sql, params),
    tx,
    close: () => p.close(),
  };
}

/** node:sqlite primitives. Prepared statements are cached per SQL string. */
function nodePrimitives(db: NodeDatabase): Primitives {
  const cache = new Map<string, NodeStatement>();
  const stmt = (sql: string): NodeStatement => {
    let cached = cache.get(sql);
    if (!cached) {
      cached = db.prepare(sql);
      cache.set(sql, cached);
    }
    return cached;
  };
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => {
      const r = stmt(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    get: (sql, params) => {
      const row = stmt(sql).get(...params);
      return row == null ? undefined : row;
    },
    all: (sql, params) => stmt(sql).all(...params),
    close: () => db.close(),
  };
}

/** bun:sqlite primitives. `db.query` returns a per-connection cached statement. */
function bunPrimitives(db: BunDatabase): Primitives {
  const changesNow = (): number => {
    const row = db.query("SELECT changes() AS c").get();
    return Number(row?.c ?? 0);
  };
  // Symmetric fallback to changesNow: when run() reports no numeric rowid, query
  // the connection's last_insert_rowid() rather than defaulting to 0 — a silent 0
  // would desync the external-content FTS mirror (it inserts under this rowid).
  const lastRowidNow = (): number => {
    const row = db.query("SELECT last_insert_rowid() AS r").get();
    return Number(row?.r ?? 0);
  };
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => {
      const r = db.query(sql).run(...params);
      const changes =
        typeof r?.changes === "number"
          ? r.changes
          : typeof r?.changes === "bigint"
            ? Number(r.changes)
            : changesNow();
      const lastInsertRowid =
        r?.lastInsertRowid == null ? lastRowidNow() : Number(r.lastInsertRowid);
      return { changes, lastInsertRowid };
    },
    get: (sql, params) => {
      const row = db.query(sql).get(...params);
      return row == null ? undefined : row;
    },
    all: (sql, params) => db.query(sql).all(...params),
    close: () => db.close(),
  };
}

/**
 * Open a SQLite database, preferring `bun:sqlite` when running under Bun and
 * falling back to `node:sqlite`. Returns `null` on any import or open failure so
 * the caller can degrade rather than crash.
 */
export async function openSqlite(path: string): Promise<SqliteDb | null> {
  try {
    if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
      const mod = (await import(BUN_SQLITE)) as unknown as BunSqliteModule;
      return makeSqliteDb(bunPrimitives(new mod.Database(path, { create: true })));
    }
    const mod = (await import(NODE_SQLITE)) as unknown as NodeSqliteModule;
    return makeSqliteDb(nodePrimitives(new mod.DatabaseSync(path)));
  } catch {
    return null;
  }
}
