import { afterAll, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite, SqliteBusyError, type ReadOnlyDb, type SqliteDb } from "../src/sqlite.js";
import {
  BUSY_READ_ATTEMPTS,
  openReadStore,
  openStore,
  retryOnBusy,
  type Card,
  type PartTextRow,
  type Store,
  type StoreIdentity,
} from "../src/store.js";
import { openScratchReader, storeFileState } from "./helpers.js";
import { readerStatements } from "./worker-harness.js";

/**
 * The store connection that only reads: what it refuses to open, how it
 * retries a lock, what it serves, and that it never changes the store's
 * database file or WAL. Store files are inspected only through
 * `storeFileState`, from a child process, while any connection is open.
 */

const V1: StoreIdentity = { host: "opencode-v1" };
const v2 = (source: string): StoreIdentity => ({ host: "opencode-v2", source });

/** Spawning the child process that reads store files can take a while on a
 *  loaded machine. */
const FILE_STATE_TIMEOUT_MS = 60_000;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "recall-read-store-"));
  dirs.push(dir);
  return dir;
}

const freshPath = (): string => join(freshDir(), "store.db");

/** A store at `path` opened for writing as `identity`, after one statement,
 *  so its `-wal` and `-shm` exist. */
async function openWriter(
  path: string,
  identity: StoreIdentity = V1,
): Promise<{ db: SqliteDb; store: Store }> {
  const db = await openSqlite(path);
  if (!db) throw new Error("openSqlite returned null");
  const opened = openStore(db, identity);
  if (!opened.ok) throw new Error(`openStore refused: ${opened.reason}`);
  opened.store.cardCounters();
  return { db, store: opened.store };
}

/** A writer that holds the store in SQLite's exclusive locking mode, so no
 *  other connection can read it until `release()`. */
async function exclusiveWriter(path: string): Promise<{ db: SqliteDb; release: () => void }> {
  const writer = await openWriter(path);
  writer.db.exec("PRAGMA locking_mode=EXCLUSIVE");
  writer.store.setMeta("marker", "locked");
  return {
    db: writer.db,
    release: () => {
      writer.db.exec("PRAGMA locking_mode=NORMAL");
      // The lock is released at the connection's next statement.
      writer.store.cardCounters();
    },
  };
}

function makeCard(sessionId: string, over: Partial<Card> = {}): Card {
  return {
    sessionId,
    parentId: null,
    rootId: sessionId,
    title: "",
    slug: "",
    directory: "",
    projectId: "",
    agent: null,
    model: null,
    timeCreated: 1000,
    timeUpdated: 1000,
    partCount: 0,
    retainedChars: 0,
    summaryHead: "",
    outcomeHead: "",
    inventory: "",
    files: [],
    tools: [],
    errors: [],
    familyRollup: [],
    distillState: "full",
    distilledThrough: null,
    embedding: null,
    embeddingGen: null,
    nlSummary: "",
    summaryHash: "",
    ...over,
  };
}

function makePart(partId: string, raw: string): PartTextRow {
  return {
    partId,
    messageId: `m-${partId}`,
    prevMessageId: null,
    nextMessageId: null,
    class: "human-text",
    timeCreated: 1000,
    raw,
    norm: raw,
  };
}

/** The busy error a read handle raises for a lock another connection holds. */
const busyError = (detail = "locked"): SqliteBusyError =>
  new SqliteBusyError("SQLITE_BUSY", new Error(detail));

/** Retry options that wait one turn per attempt: the clock passes any
 *  backoff at its first reading. */
function instantRetry(): { pause: () => Promise<void>; now: () => number; pauses: () => number } {
  let t = 0;
  let pauses = 0;
  return {
    pause: async () => {
      pauses++;
    },
    now: () => (t += 1_000),
    pauses: () => pauses,
  };
}

const READ_METHODS = [
  "allCards",
  "cardCounters",
  "cardSessionIds",
  "cardVectorsPage",
  "cardWriteRev",
  "cardsPage",
  "cardsSince",
  "ftsSearch",
  "ftsSearchPausing",
  "getCard",
  "getMeta",
  "leaseStatus",
];

describe("openReadStore before it opens the file", () => {
  it.each([":memory:", "", "   "])("refuses %j as missing", async (path) => {
    expect(await openReadStore(path, V1)).toEqual({ ok: false, reason: "missing" });
  });

  it(
    "refuses a path with no file as missing, creating nothing",
    async () => {
      const path = freshPath();
      expect(await openReadStore(path, V1)).toEqual({ ok: false, reason: "missing" });
      expect(storeFileState(path)).toEqual({ db: "absent", wal: "absent", shm: "absent" });
    },
    FILE_STATE_TIMEOUT_MS,
  );

  it("refuses a path below a regular file as missing", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "plain"), "not a directory");
    expect(await openReadStore(join(dir, "plain", "store.db"), V1)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses a path it cannot stat as an error, with the reason",
    async () => {
      const dir = freshDir();
      chmodSync(dir, 0o000);
      try {
        const result = await openReadStore(join(dir, "store.db"), V1);
        expect(result).toMatchObject({ ok: false, reason: "error" });
        expect(result.ok === false && result.detail).toMatch(/EACCES|permission/i);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  it.each<{ name: string; build: (path: string) => Promise<void> }>([
    {
      name: "a database in rollback-journal mode",
      build: async (path) => {
        const db = await openSqlite(path);
        if (!db) throw new Error("openSqlite returned null");
        db.exec("CREATE TABLE notes (body TEXT)");
        db.close();
      },
    },
    {
      name: "a WAL store whose last connection closed",
      build: async (path) => {
        (await openWriter(path)).db.close();
      },
    },
    {
      name: "a WAL store with a -wal file and no -shm",
      build: async (path) => {
        (await openWriter(path)).db.close();
        writeFileSync(`${path}-wal`, "");
      },
    },
    {
      name: "a WAL store with a -shm file and no -wal",
      build: async (path) => {
        (await openWriter(path)).db.close();
        writeFileSync(`${path}-shm`, "");
      },
    },
  ])(
    "refuses $name as no-wal, creating nothing",
    async ({ build }) => {
      const path = freshPath();
      await build(path);
      const before = storeFileState(path);
      expect(await openReadStore(path, V1)).toEqual({ ok: false, reason: "no-wal" });
      expect(storeFileState(path)).toEqual(before);
    },
    FILE_STATE_TIMEOUT_MS,
  );

  it(
    "refuses a store openStore has just created as no-wal until the writer runs a statement",
    async () => {
      const path = freshPath();
      const db = await openSqlite(path);
      if (!db) throw new Error("openSqlite returned null");
      const opened = openStore(db, V1);
      if (!opened.ok) throw new Error(opened.reason);
      expect(await openReadStore(path, V1)).toEqual({ ok: false, reason: "no-wal" });
      expect(storeFileState(path)).toMatchObject({ wal: "absent", shm: "absent" });

      opened.store.cardCounters();
      const reader = await openReadStore(path, V1);
      expect(reader.ok).toBe(true);
      if (reader.ok) reader.close();
      db.close();
    },
    FILE_STATE_TIMEOUT_MS,
  );
});

describe("openReadStore's fence", () => {
  it.each<{
    name: string;
    identity?: StoreIdentity;
    reader?: StoreIdentity;
    seed?: string;
    reason: string;
  }>([
    {
      name: "a store stamped for the other host",
      identity: v2("/data/opencode.db"),
      reader: V1,
      reason: "host-mismatch",
    },
    {
      name: "a store distilled from another source",
      identity: v2("/data/a/opencode.db"),
      reader: v2("/data/b/opencode.db"),
      reason: "source-mismatch",
    },
    {
      name: "a schema newer than this build",
      seed: "UPDATE meta SET value='6' WHERE key='schema_version'",
      reason: "newer",
    },
    {
      name: "a schema openStore would migrate",
      seed: "UPDATE meta SET value='4' WHERE key='schema_version'",
      reason: "needs-migration",
    },
    {
      name: "a store with no schema stamp",
      seed: "DELETE FROM meta WHERE key='schema_version'",
      reason: "needs-rebuild",
    },
    {
      name: "an unparseable schema stamp",
      seed: "UPDATE meta SET value='five' WHERE key='schema_version'",
      reason: "needs-rebuild",
    },
  ])(
    "refuses $name as $reason, changing neither the database file nor its WAL",
    async ({ identity = V1, reader = identity, seed, reason }) => {
      const scratch = await openScratchReader({
        identity,
        readerIdentity: reader,
        ...(seed && { seed: (_store: Store, db: SqliteDb) => db.run(seed) }),
      });
      try {
        expect(scratch.opened).toEqual({ ok: false, reason });
        const before = storeFileState(scratch.path);
        expect(await openReadStore(scratch.path, reader)).toEqual({ ok: false, reason });
        const after = storeFileState(scratch.path);
        expect(after.db).toEqual(before.db);
        expect(after.wal).toEqual(before.wal);
      } finally {
        scratch.cleanup();
      }
    },
    FILE_STATE_TIMEOUT_MS,
  );

  it("refuses a database without the store's meta table as needs-rebuild", async () => {
    const path = freshPath();
    const db = await openSqlite(path);
    if (!db) throw new Error("openSqlite returned null");
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE notes (body TEXT)");
    db.run("INSERT INTO notes (body) VALUES (?)", ["foreign layout"]);
    try {
      expect(await openReadStore(path, V1)).toEqual({ ok: false, reason: "needs-rebuild" });
    } finally {
      db.close();
    }
  });

  it("refuses a file that is not a database as an error, with the driver's reason", async () => {
    const path = freshPath();
    writeFileSync(path, "this is not a sqlite database ".repeat(200));
    writeFileSync(`${path}-wal`, "");
    writeFileSync(`${path}-shm`, "");
    const result = await openReadStore(path, V1);
    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect(result.ok === false && result.detail).toEqual(expect.any(String));
  });
});

describe("openReadStore's acceptSource", () => {
  const stamped = "/data/a/opencode.db";

  it("accepts the stamped source when acceptSource agrees, and returns the stamp as the source", async () => {
    const acceptSource = vi.fn(async (source: string) => source === stamped);
    const scratch = await openScratchReader({
      identity: v2(stamped),
      readerIdentity: v2("/data/./a/opencode.db"),
      readOptions: { acceptSource },
    });
    try {
      expect(scratch.opened).toMatchObject({ ok: true, source: stamped });
      expect(acceptSource.mock.calls).toEqual([[stamped]]);
    } finally {
      scratch.cleanup();
    }
  });

  it("refuses source-mismatch when acceptSource declines the stamp", async () => {
    const acceptSource = vi.fn(() => false);
    const scratch = await openScratchReader({
      identity: v2(stamped),
      readerIdentity: v2("/data/b/opencode.db"),
      readOptions: { acceptSource },
    });
    try {
      expect(scratch.opened).toEqual({ ok: false, reason: "source-mismatch" });
      expect(acceptSource).toHaveBeenCalledTimes(1);
    } finally {
      scratch.cleanup();
    }
  });

  it.each<{ name: string; identity: StoreIdentity; reader: StoreIdentity; result: object }>([
    {
      name: "the stamped source is the reader's",
      identity: v2(stamped),
      reader: v2(stamped),
      result: { ok: true, source: stamped },
    },
    {
      name: "the store is the other host's",
      identity: V1,
      reader: v2(stamped),
      result: { ok: false, reason: "host-mismatch" },
    },
    {
      name: "the reader is the v1 host",
      identity: v2(stamped),
      reader: V1,
      result: { ok: false, reason: "host-mismatch" },
    },
    {
      name: "both are the v1 host",
      identity: V1,
      reader: V1,
      result: { ok: true, source: undefined },
    },
  ])("never asks acceptSource when $name", async ({ identity, reader, result }) => {
    const acceptSource = vi.fn(() => true);
    const scratch = await openScratchReader({
      identity,
      readerIdentity: reader,
      readOptions: { acceptSource },
    });
    try {
      expect(scratch.opened).toMatchObject(result);
      expect(acceptSource).not.toHaveBeenCalled();
    } finally {
      scratch.cleanup();
    }
  });

  it("refuses as an error, without throwing, when acceptSource throws", async () => {
    const scratch = await openScratchReader({
      identity: v2(stamped),
      readerIdentity: v2("/data/b/opencode.db"),
      readOptions: {
        acceptSource: () => {
          throw new Error("cannot resolve the source");
        },
      },
    });
    try {
      expect(scratch.opened).toEqual({
        ok: false,
        reason: "error",
        detail: "cannot resolve the source",
      });
    } finally {
      scratch.cleanup();
    }
  });
});

describe("an open read store", () => {
  it("serves the writer's cards, slim index, counters, meta and lease through the read methods alone", async () => {
    const recorded = readerStatements();
    const scratch = await openScratchReader({
      seed: (store) => {
        store.replaceSessionParts(
          "s1",
          [makePart("p1", "durable_marker in the slim index")],
          makeCard("s1", { title: "First" }),
        );
        store.replaceSessionParts("s2", [], makeCard("s2", { title: "Second" }));
        store.writeCardEmbeddings("model-x:4", 4, [
          { sessionId: "s1", embedding: new Uint8Array([1, 2, 3, 4]), expectedSummaryHash: "" },
        ]);
        store.acquireLease("holder", 30_000, "build-tag", 4);
      },
      readOptions: { wrapReader: recorded.wrap },
    });
    try {
      if (!scratch.opened.ok) throw new Error(scratch.opened.reason);
      const reader = scratch.opened.store;
      const writer = scratch.writer;
      expect(scratch.opened.source).toBeUndefined();

      expect(Object.getPrototypeOf(reader)).toBe(Object.prototype);
      expect(Object.keys(reader).sort()).toEqual(READ_METHODS);
      const methods = reader as unknown as Record<string, unknown>;
      for (const write of [
        "setMeta",
        "upsertCard",
        "replaceSessionParts",
        "writeCardEmbeddings",
        "deleteSession",
        "acquireLease",
        "heartbeatLease",
        "releaseLease",
        "checkpoint",
        "setAutoCheckpoint",
      ]) {
        expect(methods[write]).toBeUndefined();
      }

      expect(reader.getCard("s1")).toEqual(writer.getCard("s1"));
      expect(reader.cardWriteRev("s1")).toBe(writer.cardWriteRev("s1"));
      expect(reader.allCards({ withEmbeddings: true })).toEqual(
        writer.allCards({ withEmbeddings: true }),
      );
      expect(reader.cardsSince(0, 10)).toEqual(writer.cardsSince(0, 10));
      expect(reader.cardsPage(undefined, 10)).toEqual(writer.cardsPage(undefined, 10));
      expect(reader.cardVectorsPage(undefined, 10)).toEqual(writer.cardVectorsPage(undefined, 10));
      expect(reader.cardCounters()).toEqual(writer.cardCounters());
      expect(reader.cardSessionIds()).toEqual(["s1", "s2"]);
      const query = { strong: ["durable_marker"], weak: [] };
      expect(reader.ftsSearch(query).map((hit) => hit.sessionId)).toEqual(["s1"]);
      const paused = await reader.ftsSearchPausing(query, async () => {});
      expect(paused.map((hit) => hit.sessionId)).toEqual(["s1"]);
      expect(reader.getMeta("schema_version")).toBe("5");
      expect(reader.leaseStatus()).toEqual(writer.leaseStatus());
      expect(reader.leaseStatus()?.holder).toBe("holder");

      // The open and every read ran statements that only read: no BEGIN,
      // no write and no pragma that sets anything.
      expect(recorded.statements.length).toBeGreaterThan(0);
      expect(recorded.nonReads()).toEqual([]);
    } finally {
      scratch.cleanup();
    }
  });

  it("reads beside a writer's open transaction at once, seeing the state before it", async () => {
    const scratch = await openScratchReader();
    try {
      if (!scratch.opened.ok) throw new Error(scratch.opened.reason);
      const reader = scratch.opened.store;
      scratch.writerDb.exec("BEGIN IMMEDIATE");
      scratch.writerDb.run("INSERT INTO meta (key, value) VALUES (?, ?)", ["marker", "pending"]);
      expect(reader.getMeta("marker")).toBeUndefined();
      scratch.writerDb.exec("COMMIT");
      expect(reader.getMeta("marker")).toBe("pending");
    } finally {
      scratch.cleanup();
    }
  });

  it("reads through a connection with query_only set, no busy wait and the read-only flag", async () => {
    let handle: ReadOnlyDb | undefined;
    const scratch = await openScratchReader({
      readOptions: {
        wrapReader: (db) => {
          handle = db;
          return db;
        },
      },
    });
    try {
      if (!scratch.opened.ok || !handle) throw new Error("the reader did not open");
      expect(Object.keys(handle).sort()).toEqual(["all", "close", "get"]);
      expect(handle.get("PRAGMA query_only")).toEqual({ query_only: 1 });
      expect(handle.get("PRAGMA busy_timeout")).toEqual({ timeout: 0 });
      expect(handle.get("PRAGMA journal_mode")).toEqual({ journal_mode: "wal" });

      const write = "INSERT INTO meta (key, value) VALUES ('marker', 'x') RETURNING key";
      expect(() => handle!.get(write)).toThrow();
      // With query_only lifted, the read-only flag still refuses the write.
      handle.get("PRAGMA query_only = 0");
      expect(() => handle!.get(write)).toThrow(/readonly/i);
      expect(scratch.writer.getMeta("marker")).toBeUndefined();

      // An error that is not a lock is thrown as the driver raised it.
      let thrown: unknown;
      try {
        handle.get("SELECT * FROM no_such_table");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(SqliteBusyError);
      expect((thrown as Error).message).toMatch(/no such table/);
    } finally {
      scratch.cleanup();
    }
  });

  it(
    "never changes the database file or its WAL, and leaves the WAL in place when it closes last",
    async () => {
      const path = freshPath();
      const writer = await openWriter(path);
      // Every commit stays in the WAL, so a checkpoint would show in the
      // database file.
      writer.store.setAutoCheckpoint(0);
      for (let i = 0; i < 40; i++) {
        writer.store.replaceSessionParts(
          `s${i}`,
          [makePart(`p${i}`, `wal frame text ${i} `.repeat(40))],
          makeCard(`s${i}`, { title: `Session ${i}` }),
        );
      }
      const before = storeFileState(path);
      expect(before.wal).not.toBe("absent");
      expect(before.wal !== "absent" && before.wal.size).toBeGreaterThan(4096);

      const opened = await openReadStore(path, V1);
      if (!opened.ok) throw new Error(opened.reason);
      const reader = opened.store;
      expect(reader.allCards()).toHaveLength(40);
      expect(reader.cardsPage(undefined, 100)).toHaveLength(40);
      expect(reader.ftsSearch({ strong: ["frame"], weak: [] }).length).toBeGreaterThan(0);
      reader.cardCounters();
      reader.leaseStatus();
      const reading = storeFileState(path);
      expect(reading.db).toEqual(before.db);
      expect(reading.wal).toEqual(before.wal);

      // The writer sees the reader's lock and leaves the WAL as it is.
      writer.db.close();
      const writerClosed = storeFileState(path);
      expect(writerClosed.db).toEqual(before.db);
      expect(writerClosed.wal).toEqual(before.wal);

      opened.close();
      opened.close();
      const after = storeFileState(path);
      expect(after.db).toEqual(before.db);
      expect(after.wal).toEqual(before.wal);
    },
    FILE_STATE_TIMEOUT_MS,
  );
});

describe("openReadStore while another connection holds a lock", () => {
  it("refuses busy, naming the code, after every attempt found the store locked", async () => {
    const path = freshPath();
    const writer = await exclusiveWriter(path);
    try {
      const retry = instantRetry();
      const result = await openReadStore(path, V1, { busyRetry: { attempts: 3, ...retry } });
      expect(result).toMatchObject({ ok: false, reason: "busy" });
      expect(result.ok === false && result.detail).toContain("SQLITE_BUSY");
      expect(retry.pauses()).toBe(2);
    } finally {
      writer.db.close();
    }
  });

  it("opens on a later attempt once the lock is released", async () => {
    const path = freshPath();
    const writer = await exclusiveWriter(path);
    try {
      const retry = instantRetry();
      const result = await openReadStore(path, V1, {
        busyRetry: {
          now: retry.now,
          pause: async () => {
            await retry.pause();
            if (retry.pauses() === 1) writer.release();
          },
        },
      });
      expect(result.ok).toBe(true);
      expect(retry.pauses()).toBe(1);
      if (result.ok) {
        expect(result.store.getMeta("marker")).toBe("locked");
        result.close();
      }
    } finally {
      writer.db.close();
    }
  });

  /** A `wrapReader` whose handles throw `fail(n)` from their first read, for
   *  the n-th open, counting opens and each handle's closes. */
  function failingReads(fail: (open: number) => Error | undefined): {
    wrapReader: (db: ReadOnlyDb) => ReadOnlyDb;
    opens: () => number;
    closes: number[];
  } {
    const closes: number[] = [];
    return {
      closes,
      opens: () => closes.length,
      wrapReader: (db) => {
        const open = closes.length;
        closes.push(0);
        const error = fail(open);
        let failed = false;
        const check = (): void => {
          if (error && !failed) {
            failed = true;
            throw error;
          }
        };
        return {
          get: (sql, params) => {
            check();
            return db.get(sql, params);
          },
          all: (sql, params) => {
            check();
            return db.all(sql, params);
          },
          close: () => {
            closes[open]!++;
            db.close();
          },
        };
      },
    };
  }

  it("reopens the connection for each attempt whose fence found a lock, closing the busy one", async () => {
    const scratch = await openScratchReader();
    try {
      const reads = failingReads((open) => (open < 2 ? busyError("recovering") : undefined));
      const result = await openReadStore(scratch.path, V1, {
        busyRetry: instantRetry(),
        wrapReader: reads.wrapReader,
      });
      expect(result.ok).toBe(true);
      expect(reads.opens()).toBe(3);
      expect(reads.closes).toEqual([1, 1, 0]);
      if (result.ok) {
        result.close();
        result.close();
      }
      expect(reads.closes).toEqual([1, 1, 1]);
    } finally {
      scratch.cleanup();
    }
  });

  it("refuses busy after BUSY_READ_ATTEMPTS fences found a lock, closing each connection", async () => {
    const scratch = await openScratchReader();
    try {
      const reads = failingReads(() => busyError("recovering"));
      const result = await openReadStore(scratch.path, V1, {
        busyRetry: instantRetry(),
        wrapReader: reads.wrapReader,
      });
      expect(result).toMatchObject({ ok: false, reason: "busy" });
      expect(result.ok === false && result.detail).toContain("recovering");
      expect(reads.opens()).toBe(BUSY_READ_ATTEMPTS);
      expect(reads.closes).toEqual(Array.from({ length: BUSY_READ_ATTEMPTS }, () => 1));
    } finally {
      scratch.cleanup();
    }
  });

  it("refuses an error that is not a lock at once, without another attempt", async () => {
    const scratch = await openScratchReader();
    try {
      const reads = failingReads(() => new Error("disk I/O error"));
      const result = await openReadStore(scratch.path, V1, {
        busyRetry: instantRetry(),
        wrapReader: reads.wrapReader,
      });
      expect(result).toEqual({ ok: false, reason: "error", detail: "disk I/O error" });
      expect(reads.closes).toEqual([1]);
    } finally {
      scratch.cleanup();
    }
  });
});

describe("retryOnBusy", () => {
  it("returns the first result without waiting", async () => {
    const retry = instantRetry();
    expect(await retryOnBusy(() => 7, retry)).toBe(7);
    expect(retry.pauses()).toBe(0);
  });

  it("runs a read that found a lock again until it succeeds", async () => {
    let calls = 0;
    const read = async (): Promise<string> => {
      calls++;
      if (calls < 3) throw busyError();
      return "read";
    };
    expect(await retryOnBusy(read, instantRetry())).toBe("read");
    expect(calls).toBe(3);
  });

  it("throws the last busy error after BUSY_READ_ATTEMPTS attempts by default", async () => {
    const errors: SqliteBusyError[] = [];
    const read = (): never => {
      const error = busyError(`attempt ${errors.length + 1}`);
      errors.push(error);
      throw error;
    };
    let thrown: unknown;
    try {
      await retryOnBusy(read, instantRetry());
    } catch (error) {
      thrown = error;
    }
    expect(errors).toHaveLength(BUSY_READ_ATTEMPTS);
    expect(thrown).toBe(errors[BUSY_READ_ATTEMPTS - 1]);
  });

  it("throws any other error at once", async () => {
    const retry = instantRetry();
    let calls = 0;
    const read = (): never => {
      calls++;
      throw new Error("no such table: card");
    };
    await expect(retryOnBusy(read, retry)).rejects.toThrow("no such table: card");
    expect(calls).toBe(1);
    expect(retry.pauses()).toBe(0);
  });

  it.each([
    { attempts: 2, runs: 2 },
    { attempts: 0, runs: BUSY_READ_ATTEMPTS },
    { attempts: -1, runs: BUSY_READ_ATTEMPTS },
    { attempts: 2.5, runs: BUSY_READ_ATTEMPTS },
    { attempts: Number.NaN, runs: BUSY_READ_ATTEMPTS },
  ])("runs a read $runs times when attempts is $attempts", async ({ attempts, runs }) => {
    let calls = 0;
    const read = (): never => {
      calls++;
      throw busyError();
    };
    await expect(retryOnBusy(read, { ...instantRetry(), attempts })).rejects.toBeInstanceOf(
      SqliteBusyError,
    );
    expect(calls).toBe(runs);
  });

  it("waits 1, 2, 4, 8 and then 16 ms of clock time between attempts", async () => {
    let clock = 0;
    const startedAt: number[] = [];
    const read = (): never => {
      startedAt.push(clock);
      throw busyError();
    };
    await expect(
      retryOnBusy(read, {
        attempts: 7,
        now: () => clock,
        pause: async () => {
          clock += 1;
        },
      }),
    ).rejects.toBeInstanceOf(SqliteBusyError);
    const waits = startedAt.slice(1).map((at, i) => at - startedAt[i]!);
    expect(waits).toEqual([1, 2, 4, 8, 16, 16]);
  });

  it("spends at least one turn in every wait, and a bounded number under a clock that never moves", async () => {
    // A clock that has passed the backoff at its first reading still waits a turn.
    const jumping = instantRetry();
    let calls = 0;
    const read = (): string => {
      if (++calls < 3) throw busyError();
      return "read";
    };
    expect(await retryOnBusy(read, jumping)).toBe("read");
    expect(jumping.pauses()).toBe(2);

    let pauses = 0;
    let stoppedCalls = 0;
    const stoppedRead = (): string => {
      if (++stoppedCalls < 2) throw busyError();
      return "read";
    };
    const result = await retryOnBusy(stoppedRead, {
      now: () => 0,
      pause: async () => {
        pauses++;
      },
    });
    expect(result).toBe("read");
    expect(pauses).toBeGreaterThan(0);
    expect(pauses).toBeLessThanOrEqual(10_000);
  });

  it("waits on the real clock by default", async () => {
    const startedAt: number[] = [];
    const read = (): string => {
      startedAt.push(performance.now());
      if (startedAt.length < 2) throw busyError();
      return "read";
    };
    expect(await retryOnBusy(read)).toBe("read");
    expect(startedAt[1]! - startedAt[0]!).toBeGreaterThanOrEqual(1);
  });
});
