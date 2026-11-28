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
 *  why the file cannot be read. `busy` names the busy code when the probe
 *  statement found a lock another connection held ({@link SqliteBusyError}),
 *  which may be gone on a later attempt. */
export type ReadOnlyOpenResult =
  | { ok: true; db: ReadOnlyDb }
  | { ok: false; reason: string; busy?: string };

/** SQLite's primary result code for a lock another connection holds. Its
 *  extended codes keep it in their low byte. */
const SQLITE_BUSY = 5;

/** The names of `SQLITE_BUSY` and its extended codes, by number. */
const BUSY_CODE_NAMES: Readonly<Record<number, string>> = {
  5: "SQLITE_BUSY",
  261: "SQLITE_BUSY_RECOVERY",
  517: "SQLITE_BUSY_SNAPSHOT",
  773: "SQLITE_BUSY_TIMEOUT",
};

/**
 * A statement SQLite refused because another connection held a lock it
 * needed: `SQLITE_BUSY` or one of its extended codes (`SQLITE_BUSY_RECOVERY`
 * while another connection rebuilds the WAL index after a crash,
 * `SQLITE_BUSY_SNAPSHOT`, `SQLITE_BUSY_TIMEOUT`). Raised in place of the
 * driver's error by a handle opened with `busyError` set
 * ({@link openSqliteReadOnly}). The same statement may succeed once the lock
 * is released. `code` names the code and `cause` is the driver's error.
 */
export class SqliteBusyError extends Error {
  readonly code: string;
  constructor(code: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message.includes(code) ? message : `${message} (${code})`, { cause });
    this.name = "SqliteBusyError";
    this.code = code;
  }
}

/** The busy code an error from either driver carries, or undefined when it is
 *  not a busy error. `bun:sqlite` names the extended code in `code`;
 *  `node:sqlite` sets `code` to `ERR_SQLITE_ERROR` and numbers the extended
 *  code in `errcode`. */
function busyCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, errcode } = error as { code?: unknown; errcode?: unknown };
  if (typeof code === "string" && code.startsWith("SQLITE_")) {
    return code.startsWith("SQLITE_BUSY") ? code : undefined;
  }
  if (code === "ERR_SQLITE_ERROR" && typeof errcode === "number") {
    if ((errcode & 0xff) !== SQLITE_BUSY) return undefined;
    return BUSY_CODE_NAMES[errcode] ?? "SQLITE_BUSY";
  }
  return undefined;
}

/** Whether `error`, from either driver or as a {@link SqliteBusyError}, is
 *  SQLite reporting a lock another connection held (`SQLITE_BUSY` or one of
 *  its extended codes). */
export function isBusyError(error: unknown): boolean {
  return error instanceof SqliteBusyError || busyCodeOf(error) !== undefined;
}

/** `error` as a {@link SqliteBusyError} when it is a busy error, else as is. */
function typedBusy(error: unknown): unknown {
  if (error instanceof SqliteBusyError) return error;
  const code = busyCodeOf(error);
  return code === undefined ? error : new SqliteBusyError(code, error);
}

/** SQLite's primary result codes for a database file that is damaged
 *  (`SQLITE_CORRUPT`) or not a database at all (`SQLITE_NOTADB`). */
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

/**
 * Whether `error`, from either driver, says the database file is damaged or
 * is not a database: `SQLITE_CORRUPT` (with its extended codes) or
 * `SQLITE_NOTADB`. Retrying the statement or reopening the file cannot fix
 * either.
 */
export function isCorruptError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, errcode } = error as { code?: unknown; errcode?: unknown };
  if (typeof code === "string" && code.startsWith("SQLITE_")) {
    return code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB";
  }
  if (code === "ERR_SQLITE_ERROR" && typeof errcode === "number") {
    const primary = errcode & 0xff;
    return primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB;
  }
  return false;
}

/**
 * The `THREADSAFE` compile option of the SQLite library the driver links, read
 * from `PRAGMA compile_options` on a throwaway in-memory connection: 0 means
 * the library must not be used from more than one thread at all, 1 and 2
 * allow one connection per thread. Undefined when no driver loads or the
 * option is not listed.
 */
export async function sqliteThreadSafety(): Promise<number | undefined> {
  const db = await openSqlite(":memory:");
  if (!db) return undefined;
  try {
    for (const row of db.all("PRAGMA compile_options")) {
      const option = row.compile_options;
      if (typeof option === "string" && option.startsWith("THREADSAFE=")) {
        const value = Number(option.slice("THREADSAFE=".length));
        return Number.isInteger(value) ? value : undefined;
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    try {
      db.close();
    } catch {
      // A throwaway connection; its close cannot matter.
    }
  }
}

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
 * throws; every failure is a `{ ok: false, reason }`, with `busy` naming the
 * code when the probe found another connection's lock.
 *
 * With `busyError`, the handle's `get` and `all` throw a
 * {@link SqliteBusyError} in place of the driver's error whenever SQLite
 * reports `SQLITE_BUSY` or one of its extended codes; every other error is
 * thrown as the driver raised it.
 */
export async function openSqliteReadOnly(
  path: string,
  opts: { busyTimeoutMs?: number; busyError?: boolean } = {},
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
    const reason = `cannot read ${path}: ${describeError(error)}`;
    const busyCode = busyCodeOf(error);
    return busyCode === undefined ? { ok: false, reason } : { ok: false, reason, busy: busyCode };
  }
  if (opts.busyError !== true)
    return { ok: true, db: { get: db.get, all: db.all, close: db.close } };
  return {
    ok: true,
    db: {
      get: (sql, params) => {
        try {
          return db.get(sql, params);
        } catch (error) {
          throw typedBusy(error);
        }
      },
      all: (sql, params) => {
        try {
          return db.all(sql, params);
        } catch (error) {
          throw typedBusy(error);
        }
      },
      close: db.close,
    },
  };
}
