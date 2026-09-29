/**
 * SQLite driver adapter.
 *
 * opencode runs on Bun, where `bun:sqlite` is built in; tests and other Node
 * runtimes use `node:sqlite` (Node >= 22.5). Both are stdlib, so the store
 * carries zero npm dependencies. This is the ONLY module that touches a runtime
 * SQLite binding, and it does so exclusively through dynamic `import()` behind
 * variable specifiers so `src/` stays free of Node/Bun types (see AGENTS.md) and
 * so the bundler never tries to inline a native driver. Every open failure is
 * swallowed: {@link openSqlite} returns `null` (a missing driver degrades the
 * plugin to ephemeral mode rather than throwing), and {@link openSqliteReadOnly}
 * returns `{ ok: false, reason }`.
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
type NodeSqliteModule = {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NodeDatabase;
};

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
  Database: new (path: string, options: { create?: boolean; readonly?: boolean }) => BunDatabase;
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

/** A read-only handle: statements that return rows, and close. No `exec`,
 *  `run` or `tx`, in the type or on the object, so a write cannot even be
 *  attempted by accident (and `query_only` refuses one sent through `get`). */
export type ReadOnlyDb = Pick<SqliteDb, "get" | "all" | "close">;

/** The outcome of {@link openSqliteReadOnly}: a verified read-only handle, or
 *  why the file cannot be read. */
export type ReadOnlyOpenResult = { ok: true; db: ReadOnlyDb } | { ok: false; reason: string };

/** How long a read waits on a lock before failing. Short on purpose: a WAL
 *  reader almost never waits, and a stalled read would stall the host. */
const READ_ONLY_BUSY_TIMEOUT_MS = 500;

/** A driver error as one line, with the SQLite code when the driver has one
 *  (`bun:sqlite` sets `code`, `node:sqlite` sets `errstr`). */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const shaped = error as Error & { code?: unknown; errstr?: unknown };
  const code =
    typeof shaped.code === "string" && shaped.code.startsWith("SQLITE_")
      ? shaped.code
      : typeof shaped.errstr === "string"
        ? shaped.errstr
        : undefined;
  return code && !error.message.includes(code) ? `${error.message} (${code})` : error.message;
}

/**
 * Open another program's SQLite file strictly read-only: `bun:sqlite` with
 * `{ readonly: true }` under Bun (the same SQLite build opencode writes with,
 * so two libraries never hold POSIX locks on one file in one process), else
 * `node:sqlite` with `{ readOnly: true }`. Then `PRAGMA query_only = 1`, a
 * short `busy_timeout`, and a probe statement.
 *
 * The probe is load-bearing: Bun's constructor succeeds lazily and an
 * unreadable file (a WAL database whose `-shm` cannot be created fails with
 * `SQLITE_CANTOPEN`, a non-database file, a missing file) surfaces only on the
 * first statement. `:memory:` is rejected by name: an in-memory database is a
 * different, empty database, never the one another process uses. Never
 * throws; every failure is a `{ ok: false, reason }`.
 */
export async function openSqliteReadOnly(
  path: string,
  opts: { busyTimeoutMs?: number } = {},
): Promise<ReadOnlyOpenResult> {
  if (path === ":memory:") {
    return { ok: false, reason: "in-memory database (:memory:) has no file to read" };
  }
  if (path.trim() === "") return { ok: false, reason: "empty database path" };

  let db: SqliteDb;
  try {
    if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
      const mod = (await import(BUN_SQLITE)) as unknown as BunSqliteModule;
      db = makeSqliteDb(bunPrimitives(new mod.Database(path, { readonly: true })));
    } else {
      const mod = (await import(NODE_SQLITE)) as unknown as NodeSqliteModule;
      db = makeSqliteDb(nodePrimitives(new mod.DatabaseSync(path, { readOnly: true })));
    }
  } catch (error) {
    return { ok: false, reason: `cannot open ${path}: ${describeError(error)}` };
  }

  const requested = opts.busyTimeoutMs ?? READ_ONLY_BUSY_TIMEOUT_MS;
  // A non-finite value (NaN, Infinity) would interpolate as invalid SQL.
  const busy = Number.isFinite(requested)
    ? Math.max(0, Math.floor(requested))
    : READ_ONLY_BUSY_TIMEOUT_MS;
  try {
    db.exec("PRAGMA query_only = 1");
    db.exec(`PRAGMA busy_timeout = ${busy}`);
    db.get("SELECT count(*) AS n FROM sqlite_master");
  } catch (error) {
    try {
      db.close();
    } catch {
      // The probe's error is the one worth reporting.
    }
    return { ok: false, reason: `cannot read ${path}: ${describeError(error)}` };
  }
  return { ok: true, db: { get: db.get, all: db.all, close: db.close } };
}
