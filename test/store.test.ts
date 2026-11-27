import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite, type Row, type SqliteDb, type SqlValue } from "../src/sqlite.js";
import {
  appendedRows,
  boundWeakAnchors,
  buildMatch,
  CARDS_DELETED_KEY,
  CARDS_REV_KEY,
  CARDS_STAMPED_KEY,
  openStore,
  pluginBuild,
  REPAIR_STATE_PAGE,
  VECTORS_REV_KEY,
  WEAK_MATCH_ROWS,
  type AppendLayout,
  type Card,
  type CardCounters,
  type FtsHit,
  type PartTextRow,
  type RangeHash,
  type SessionTail,
  type SettledBase,
  type Store,
  type StoredRows,
  type StoreIdentity,
  type StoreOptions,
  type StoreRefusal,
} from "../src/store.js";
import { parseQuery } from "../src/query.js";
import { openV1Store } from "./helpers.js";
import { mulberry32 } from "./perf-helpers.js";
import {
  changedParts,
  recordRowMutations,
  rowsByPart,
  touchedParts,
  type RowMutation,
} from "./row-mutations.js";

// These tests run against the REAL node:sqlite driver (Node >= 22.5). Under
// vitest there is no `Bun` global, so openSqlite selects node:sqlite.

const V1: StoreIdentity = { host: "opencode-v1" };
const v2 = (source: string): StoreIdentity => ({ host: "opencode-v2", source });

const tmpDirs: string[] = [];

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "recall-store-"));
  tmpDirs.push(dir);
  return join(dir, "store.db");
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

async function fresh(now?: () => number): Promise<{ db: SqliteDb; store: Store }> {
  const db = await openSqlite(freshDbPath());
  if (!db) throw new Error("openSqlite returned null");
  const store = openV1Store(db, now ? { now } : undefined);
  if (!store) throw new Error("openStore returned null");
  return { db, store };
}

/** A fresh store whose connection lists, while recording, every statement
 *  that writes a slim-index row or its FTS entry ({@link recordRowMutations}). */
async function recordedStore(): Promise<{
  db: SqliteDb;
  store: Store;
  recorded: ReturnType<typeof recordRowMutations>;
}> {
  const db = await openSqlite(freshDbPath());
  if (!db) throw new Error("openSqlite returned null");
  const recorded = recordRowMutations(db);
  const store = openV1Store(recorded.db);
  if (!store) throw new Error("openStore returned null");
  return { db, store, recorded };
}

/** Each statement {@link recordRowMutations} listed, as `<table> <op>
 *  <part>`, sorted: a removed row's part read through the rows before the
 *  write ({@link rowsByPart}), an added or updated one's through the rows
 *  after it. */
function statementsOf(
  mutations: RowMutation[],
  before: Map<string, Row>,
  after: Map<string, Row>,
): string[] {
  const partOf = (rows: Map<string, Row>): Map<number, string> =>
    new Map([...rows].map(([part, row]) => [Number(row.id), part]));
  const removed = partOf(before);
  const written = partOf(after);
  return mutations
    .map((m) => {
      const part =
        m.id === "session"
          ? "session"
          : ((m.op === "remove" ? removed : written).get(m.id) ?? `rowid ${m.id}`);
      return `${m.table} ${m.op} ${part}`;
    })
    .sort();
}

/** The statements {@link statementsOf} lists for a write that overwrites
 *  each `updated` and `text` part's row in place (replacing the index entry
 *  of the `text` ones only), and deletes or inserts each `removed` or
 *  `added` part's row with its index entry. A part in both was deleted and
 *  inserted again under a new rowid. */
function diffStatements(o: {
  updated?: string[];
  text?: string[];
  removed?: string[];
  added?: string[];
}): string[] {
  return [
    ...[...(o.updated ?? []), ...(o.text ?? [])].map((part) => `part_text update ${part}`),
    ...(o.text ?? []).flatMap((part) => [`part_fts remove ${part}`, `part_fts add ${part}`]),
    ...(o.removed ?? []).flatMap((part) => [`part_text remove ${part}`, `part_fts remove ${part}`]),
    ...(o.added ?? []).flatMap((part) => [`part_text add ${part}`, `part_fts add ${part}`]),
  ].sort();
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
    distillState: "metadata",
    distilledThrough: null,
    embedding: null,
    embeddingGen: null,
    nlSummary: "",
    summaryHash: "",
    ...over,
  };
}

function makePart(partId: string, raw: string, over: Partial<PartTextRow> = {}): PartTextRow {
  return {
    partId,
    messageId: `m-${partId}`,
    prevMessageId: null,
    nextMessageId: null,
    class: "human-text",
    timeCreated: 1000,
    raw,
    norm: raw,
    ...over,
  };
}

function sessions(hits: { sessionId: string }[]): string[] {
  return hits.map((h) => h.sessionId);
}

describe("sqlite adapter", () => {
  it("opens a working db and rolls back a throwing tx", async () => {
    const db = await openSqlite(freshDbPath());
    expect(db).not.toBeNull();
    if (!db) return;
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    db.run("INSERT INTO t(v) VALUES(?)", ["kept"]);
    expect(() =>
      db.tx(() => {
        db.run("INSERT INTO t(v) VALUES(?)", ["discarded"]);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const rows = db.all("SELECT v FROM t");
    expect(rows.map((r) => r.v)).toEqual(["kept"]);
    db.close();
  });

  it("reports a real changes count and lastInsertRowid", async () => {
    const db = await openSqlite(freshDbPath());
    if (!db) throw new Error("open failed");
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    const first = db.run("INSERT INTO t(v) VALUES(?)", ["a"]);
    expect(first.changes).toBe(1);
    expect(first.lastInsertRowid).toBe(1);
    const noMatch = db.run("UPDATE t SET v=? WHERE id=?", ["z", 999]);
    expect(noMatch.changes).toBe(0);
    expect(db.get("SELECT v FROM t WHERE id=?", [12345])).toBeUndefined();
    db.close();
  });
});

/** Column names of `table` over the raw connection. */
function columnNames(db: SqliteDb, table: string): string[] {
  return db.all(`PRAGMA table_info(${table})`).map((r) => String(r.name));
}

/** One `meta` value over the raw connection, bypassing any Store. */
function rawMeta(db: SqliteDb, key: string): string | undefined {
  const row = db.get("SELECT value FROM meta WHERE key=?", [key]);
  return typeof row?.value === "string" ? row.value : undefined;
}

/** Everything a refusal must leave untouched: every meta row, the schema DDL,
 *  and the row counts of the data tables. */
function snapshot(db: SqliteDb): unknown {
  return {
    meta: db.all("SELECT key, value FROM meta ORDER BY key"),
    schema: db.all("SELECT type, name, sql FROM sqlite_master ORDER BY type, name"),
    cards: db.all("SELECT session_id FROM card ORDER BY session_id"),
    parts: db.get("SELECT COUNT(*) AS n FROM part_text"),
  };
}

/** Whether the file holds `card_repair_pending`, a partial index over the
 *  cards with a repair reason that some builds of schema 5 create on open. */
function hasRepairIndex(db: SqliteDb): boolean {
  return (
    db.get("SELECT name FROM sqlite_master WHERE type='index' AND name='card_repair_pending'") !==
    undefined
  );
}

/** Create the repair-pending index in the store at `path`, as a build that
 *  creates it on open leaves the file. Throws when the index is there. */
async function addRepairIndex(path: string): Promise<void> {
  const db = await openSqlite(path);
  if (!db) throw new Error("open failed");
  db.exec("CREATE INDEX card_repair_pending ON card(session_id) WHERE repair_reason IS NOT NULL");
  db.close();
}

/** A connection that records every read statement (`get` and `all`) and runs
 *  `afterRead`, once, right after the next one returns. */
function watchReads(db: SqliteDb): {
  db: SqliteDb;
  reads: Array<{ sql: string; params?: SqlValue[] }>;
  afterNextRead: (fn: () => void) => void;
} {
  const reads: Array<{ sql: string; params?: SqlValue[] }> = [];
  let pending: (() => void) | undefined;
  const after = <T>(result: T): T => {
    const run = pending;
    pending = undefined;
    run?.();
    return result;
  };
  return {
    reads,
    afterNextRead: (fn) => {
      pending = fn;
    },
    db: {
      ...db,
      get(sql, params) {
        reads.push({ sql, params });
        return after(db.get(sql, params));
      },
      all(sql, params) {
        reads.push({ sql, params });
        return after(db.all(sql, params));
      },
    },
  };
}

/**
 * Open `path` on a fresh connection as `identity` and assert a refusal with
 * `reason` that wrote nothing: the connection's `total_changes()` stays 0 and
 * the file matches its pre-open snapshot.
 */
async function expectRefusal(
  path: string,
  identity: StoreIdentity,
  reason: StoreRefusal,
  opts?: StoreOptions,
): Promise<void> {
  const probe = await openSqlite(path);
  if (!probe) throw new Error("probe open failed");
  const before = snapshot(probe);
  probe.close();

  const db = await openSqlite(path);
  if (!db) throw new Error("reopen failed");
  expect(openStore(db, identity, opts)).toEqual({ ok: false, reason });
  expect(db.get("SELECT total_changes() AS n")?.n).toBe(0);
  expect(snapshot(db)).toEqual(before);
  db.close();
}

/**
 * Wrap a real connection to observe how {@link openStore} ends its transaction
 * and, optionally, make `exec` throw on a statement matching `fail.exec` or
 * `run` throw when a bound parameter equals `fail.runParam`.
 */
function instrument(
  db: SqliteDb,
  fail: { exec?: RegExp; runParam?: string } = {},
): { db: SqliteDb; txOutcomes: Array<"committed" | "rolled-back"> } {
  const txOutcomes: Array<"committed" | "rolled-back"> = [];
  const wrapped: SqliteDb = {
    ...db,
    exec(sql) {
      if (fail.exec?.test(sql)) throw new Error(`injected failure: ${sql}`);
      db.exec(sql);
    },
    run(sql, params) {
      if (fail.runParam !== undefined && params?.includes(fail.runParam)) {
        throw new Error(`injected failure: ${sql}`);
      }
      return db.run(sql, params);
    },
    tx(fn) {
      try {
        const result = db.tx(fn);
        txOutcomes.push("committed");
        return result;
      } catch (error) {
        txOutcomes.push("rolled-back");
        throw error;
      }
    },
  };
  return { db: wrapped, txOutcomes };
}

/**
 * Hand-build a populated schema-3 store (the last pre-fence layout: the current
 * DDL minus `card.distill_cursor`, no host stamp) carrying one card with a
 * summary and a current-generation vector, its slim-index and FTS rows, the
 * semantic/revision stamps, and a held distill lease: everything a v1 install
 * has on disk at upgrade time.
 */
async function buildV3Store(path: string): Promise<void> {
  const db = await openSqlite(path);
  if (!db) throw new Error("open failed");
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE card (
      session_id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '',
      directory TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '',
      agent TEXT, model TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      part_count INTEGER NOT NULL DEFAULT 0, retained_chars INTEGER NOT NULL DEFAULT 0,
      summary_head TEXT NOT NULL DEFAULT '', outcome_head TEXT NOT NULL DEFAULT '',
      inventory TEXT NOT NULL DEFAULT '',
      files TEXT NOT NULL DEFAULT '[]', tools TEXT NOT NULL DEFAULT '[]',
      errors TEXT NOT NULL DEFAULT '[]', family_rollup TEXT NOT NULL DEFAULT '[]',
      distill_state TEXT NOT NULL DEFAULT 'metadata',
      distilled_through TEXT,
      embedding BLOB,
      embedding_gen INTEGER,
      nl_summary TEXT NOT NULL DEFAULT '',
      summary_hash TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX card_updated ON card(time_updated DESC);
    CREATE INDEX card_root ON card(root_id);
    CREATE INDEX card_project ON card(project_id);
    CREATE TABLE part_text (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, part_id TEXT NOT NULL,
      message_id TEXT NOT NULL, prev_message_id TEXT, next_message_id TEXT,
      class TEXT NOT NULL, time_created INTEGER NOT NULL,
      raw TEXT NOT NULL, norm TEXT NOT NULL
    );
    CREATE INDEX part_text_session ON part_text(session_id);
    CREATE UNIQUE INDEX part_text_part ON part_text(part_id);
    CREATE VIRTUAL TABLE part_fts USING fts5(
      raw, norm, content='part_text', content_rowid='id',
      tokenize="unicode61 tokenchars '_-./'"
    );
  `);
  const meta: Array<[string, string]> = [
    ["schema_version", "3"],
    ["semantic_model", "model-x:4"],
    ["cards_rev", "11"],
    ["vectors_rev", "5"],
    ["summary_rev", "2"],
    [
      "distill_lease",
      JSON.stringify({
        holder: "proc-a",
        heartbeat: 1234,
        ttl: 30_000,
        build: "schema3.gen4",
        gen: 4,
      }),
    ],
  ];
  for (const [key, value] of meta) {
    db.run("INSERT INTO meta(key, value) VALUES(?, ?)", [key, value]);
  }
  db.run(
    "INSERT INTO card(session_id, root_id, title, time_created, time_updated, distill_state, distilled_through, inventory, embedding, embedding_gen, nl_summary, summary_hash) VALUES(?, ?, ?, ?, ?, 'full', ?, ?, ?, ?, ?, ?)",
    [
      "s-v3",
      "s-v3",
      "V3 session",
      1000,
      2000,
      "m1",
      "sprocket linker",
      new Uint8Array([9, 8, 7, 6]),
      4,
      "Linked the sprockets.",
      "h3",
    ],
  );
  db.run(
    "INSERT INTO part_text(session_id, part_id, message_id, class, time_created, raw, norm) VALUES(?, ?, ?, ?, ?, ?, ?)",
    [
      "s-v3",
      "p1",
      "m1",
      "human-text",
      1000,
      "sprocket linker zorblequin",
      "sprocket linker zorblequin",
    ],
  );
  db.run("INSERT INTO part_fts(rowid, raw, norm) VALUES(?, ?, ?)", [
    1,
    "sprocket linker zorblequin",
    "sprocket linker zorblequin",
  ]);
  db.close();
}

/** Create a fresh current-schema store at `path` as `identity` and seed one
 *  card so a later rebuild would be visible. */
async function buildCurrentStore(path: string, identity: StoreIdentity): Promise<void> {
  const db = await openSqlite(path);
  if (!db) throw new Error("open failed");
  const opened = openStore(db, identity);
  if (!opened.ok) throw new Error(`openStore refused: ${opened.reason}`);
  opened.store.replaceSessionParts("s1", [makePart("p1", "keeper_marker")], makeCard("s1"));
  db.close();
}

/** The family rollup {@link buildV4Store} gives its root card. */
const V4_ROLLUP = [{ sessionId: "C", messageId: "mC", snippet: "Child work" }];

/** The checkpoint {@link buildV4Store} gives a v2-host root card. */
const V4_CURSOR = '{"v":1,"seq":7}';

/**
 * Hand-build a populated schema-4 store (the v3 layout plus
 * `card.distill_cursor`, with host stamps) for `identity`: a root card with a
 * summary, a family rollup, a current-generation vector and, for the v2 host,
 * a checkpoint; a child card; both sessions' slim-index and FTS rows; and the
 * revision and vector counters.
 */
async function buildV4Store(path: string, identity: StoreIdentity): Promise<void> {
  const db = await openSqlite(path);
  if (!db) throw new Error("open failed");
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE card (
      session_id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '',
      directory TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '',
      agent TEXT, model TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      part_count INTEGER NOT NULL DEFAULT 0, retained_chars INTEGER NOT NULL DEFAULT 0,
      summary_head TEXT NOT NULL DEFAULT '', outcome_head TEXT NOT NULL DEFAULT '',
      inventory TEXT NOT NULL DEFAULT '',
      files TEXT NOT NULL DEFAULT '[]', tools TEXT NOT NULL DEFAULT '[]',
      errors TEXT NOT NULL DEFAULT '[]', family_rollup TEXT NOT NULL DEFAULT '[]',
      distill_state TEXT NOT NULL DEFAULT 'metadata',
      distilled_through TEXT,
      embedding BLOB,
      embedding_gen INTEGER,
      nl_summary TEXT NOT NULL DEFAULT '',
      summary_hash TEXT NOT NULL DEFAULT '',
      distill_cursor TEXT
    );
    CREATE INDEX card_updated ON card(time_updated DESC);
    CREATE INDEX card_root ON card(root_id);
    CREATE INDEX card_project ON card(project_id);
    CREATE TABLE part_text (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, part_id TEXT NOT NULL,
      message_id TEXT NOT NULL, prev_message_id TEXT, next_message_id TEXT,
      class TEXT NOT NULL, time_created INTEGER NOT NULL,
      raw TEXT NOT NULL, norm TEXT NOT NULL
    );
    CREATE INDEX part_text_session ON part_text(session_id);
    CREATE UNIQUE INDEX part_text_part ON part_text(part_id);
    CREATE VIRTUAL TABLE part_fts USING fts5(
      raw, norm, content='part_text', content_rowid='id',
      tokenize="unicode61 tokenchars '_-./'"
    );
  `);
  const meta: Array<[string, string]> = [
    ["schema_version", "4"],
    ["store_host", identity.host],
    ["semantic_model", "model-x:4"],
    ["cards_rev", "11"],
    ["vectors_rev", "5"],
  ];
  if (identity.host === "opencode-v2") meta.push(["source_db", identity.source]);
  for (const [key, value] of meta) {
    db.run("INSERT INTO meta(key, value) VALUES(?, ?)", [key, value]);
  }
  db.run(
    "INSERT INTO card(session_id, root_id, title, time_created, time_updated, distill_state, distilled_through, inventory, family_rollup, embedding, embedding_gen, nl_summary, summary_hash, distill_cursor) VALUES(?, ?, ?, ?, ?, 'full', ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "R",
      "R",
      "V4 root",
      1000,
      3000,
      "mR",
      "gizmo planner",
      JSON.stringify(V4_ROLLUP),
      new Uint8Array([1, 2, 3, 4]),
      4,
      "Planned the gizmos.",
      "h4",
      identity.host === "opencode-v2" ? V4_CURSOR : null,
    ],
  );
  db.run(
    "INSERT INTO card(session_id, parent_id, root_id, title, time_created, time_updated, distill_state, distilled_through) VALUES(?, ?, ?, ?, ?, ?, 'full', ?)",
    ["C", "R", "R", "V4 child", 1000, 2000, "mC"],
  );
  const parts: Array<[string, string, string, string]> = [
    ["R", "pR", "mR", "gizmo planner wobblefrond"],
    ["C", "pC", "mC", "child task snorkelwick"],
  ];
  parts.forEach(([sessionId, partId, messageId, text], i) => {
    db.run(
      "INSERT INTO part_text(id, session_id, part_id, message_id, class, time_created, raw, norm) VALUES(?, ?, ?, ?, 'human-text', 1000, ?, ?)",
      [i + 1, sessionId, partId, messageId, text, text],
    );
    db.run("INSERT INTO part_fts(rowid, raw, norm) VALUES(?, ?, ?)", [i + 1, text, text]);
  });
  db.close();
}

describe("store migration", () => {
  it("creates schema v5 on a fresh db, stamped for the v1 host with no source", async () => {
    const { db, store } = await fresh();
    expect(store.getMeta("schema_version")).toBe("5");
    expect(store.getMeta("store_host")).toBe("opencode-v1");
    expect(store.getMeta("source_db")).toBeUndefined();
    expect(columnNames(db, "card")).toContain("distill_cursor");
    expect(store.allCards()).toEqual([]);
    db.close();
  });

  it("stamps the v2 host and its source on a fresh db", async () => {
    const db = await openSqlite(freshDbPath());
    if (!db) throw new Error("open failed");
    const opened = openStore(db, v2("/data/opencode.db"));
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.store.getMeta("schema_version")).toBe("5");
    expect(opened.store.getMeta("store_host")).toBe("opencode-v2");
    expect(opened.store.getMeta("source_db")).toBe("/data/opencode.db");
    db.close();
  });

  it("drops everything and rebuilds when the on-disk version is older than v1", async () => {
    const path = freshDbPath();
    const db1 = await openSqlite(path);
    const store1 = db1 && openV1Store(db1);
    if (!db1 || !store1) throw new Error("open failed");
    store1.upsertCard(makeCard("s1"));
    // Simulate a pre-v1 layout: an older version stamp plus a foreign table.
    store1.setMeta("schema_version", "0");
    db1.exec("CREATE TABLE junk(x)");
    db1.close();

    const db2 = await openSqlite(path);
    if (!db2) throw new Error("reopen failed");
    const store2 = openV1Store(db2);
    if (!store2) throw new Error("reopen store failed");
    expect(store2.getMeta("schema_version")).toBe("5");
    expect(store2.getMeta("store_host")).toBe("opencode-v1");
    expect(store2.allCards()).toEqual([]);
    expect(db2.get("SELECT name FROM sqlite_master WHERE name='junk'")).toBeUndefined();
    db2.close();
  });

  it("rebuilds a foreign layout with no stamp for whichever host opens it, stamping it", async () => {
    // No meta table at all: not a store any host owns, so any host may claim it.
    const path = freshDbPath();
    const db1 = await openSqlite(path);
    if (!db1) throw new Error("open failed");
    db1.exec("CREATE TABLE foreign_thing(x); INSERT INTO foreign_thing VALUES (1);");
    db1.close();

    const db2 = await openSqlite(path);
    if (!db2) throw new Error("reopen failed");
    const opened = openStore(db2, v2("/data/opencode.db"));
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.store.getMeta("schema_version")).toBe("5");
    expect(opened.store.getMeta("store_host")).toBe("opencode-v2");
    expect(opened.store.getMeta("source_db")).toBe("/data/opencode.db");
    expect(db2.get("SELECT name FROM sqlite_master WHERE name='foreign_thing'")).toBeUndefined();
    db2.close();
  });

  it("chains a populated v1 store additively to v5, preserving cards/FTS/vectors/stamps", async () => {
    const path = freshDbPath();
    // Build a v1-shaped store by hand (the v1 card table has no summary columns),
    // populated with a card, its slim-index/FTS rows, a persisted vector, and the
    // semantic-model stamp — exactly what an existing install carries.
    const db1 = await openSqlite(path);
    if (!db1) throw new Error("open failed");
    db1.exec("PRAGMA journal_mode=WAL;");
    db1.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE card (
        session_id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '',
        directory TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '',
        agent TEXT, model TEXT,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
        part_count INTEGER NOT NULL DEFAULT 0, retained_chars INTEGER NOT NULL DEFAULT 0,
        summary_head TEXT NOT NULL DEFAULT '', outcome_head TEXT NOT NULL DEFAULT '',
        inventory TEXT NOT NULL DEFAULT '',
        files TEXT NOT NULL DEFAULT '[]', tools TEXT NOT NULL DEFAULT '[]',
        errors TEXT NOT NULL DEFAULT '[]', family_rollup TEXT NOT NULL DEFAULT '[]',
        distill_state TEXT NOT NULL DEFAULT 'metadata',
        distilled_through TEXT,
        embedding BLOB
      );
      CREATE TABLE part_text (
        id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, part_id TEXT NOT NULL,
        message_id TEXT NOT NULL, prev_message_id TEXT, next_message_id TEXT,
        class TEXT NOT NULL, time_created INTEGER NOT NULL,
        raw TEXT NOT NULL, norm TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE part_fts USING fts5(
        raw, norm, content='part_text', content_rowid='id',
        tokenize="unicode61 tokenchars '_-./'"
      );
    `);
    db1.run("INSERT INTO meta(key, value) VALUES(?, ?)", ["schema_version", "1"]);
    db1.run("INSERT INTO meta(key, value) VALUES(?, ?)", ["semantic_model", "model-x:rep2"]);
    db1.run("INSERT INTO meta(key, value) VALUES(?, ?)", ["cards_rev", "7"]);
    const vector = new Uint8Array([1, 2, 3, 4]);
    db1.run(
      "INSERT INTO card(session_id, root_id, title, time_created, time_updated, distill_state, inventory, embedding) VALUES(?, ?, ?, ?, ?, 'full', ?, ?)",
      ["s-v1", "s-v1", "V1 session", 1000, 2000, "widget parser", vector],
    );
    db1.run(
      "INSERT INTO part_text(session_id, part_id, message_id, class, time_created, raw, norm) VALUES(?, ?, ?, ?, ?, ?, ?)",
      [
        "s-v1",
        "p1",
        "m1",
        "human-text",
        1000,
        "widget parser florplaxle",
        "widget parser florplaxle",
      ],
    );
    db1.run("INSERT INTO part_fts(rowid, raw, norm) VALUES(?, ?, ?)", [
      1,
      "widget parser florplaxle",
      "widget parser florplaxle",
    ]);
    db1.close();

    // Reopen with the current (v5) code: additive upgrade chaining
    // v1->v2->v3->v4->v5, no rebuild.
    const db2 = await openSqlite(path);
    if (!db2) throw new Error("reopen failed");
    const store2 = openV1Store(db2);
    if (!store2) throw new Error("reopen store failed");

    expect(store2.getMeta("schema_version")).toBe("5");
    expect(store2.getMeta("store_host")).toBe("opencode-v1");
    expect(columnNames(db2, "card")).toContain("distill_cursor");
    // Everything survived: card, its vector, the semantic stamp, cards_rev.
    expect(store2.getMeta("semantic_model")).toBe("model-x:rep2");
    expect(store2.getMeta("cards_rev")).toBe("7");
    const card = store2.allCards({ withEmbeddings: true })[0];
    expect(card?.sessionId).toBe("s-v1");
    expect(card?.inventory).toBe("widget parser");
    expect(card?.embedding).not.toBeNull();
    // The v2 summary columns default empty; the v3 generation column reads NULL
    // for the pre-existing row (unknown/legacy generation).
    expect(card?.nlSummary).toBe("");
    expect(card?.summaryHash).toBe("");
    expect(card?.embeddingGen).toBeNull();
    // The FTS index survived the migration.
    expect(store2.ftsSearch({ strong: ["florplaxle"], weak: [] }).length).toBeGreaterThan(0);
    store2.writeSummary("s-v1", "Did widget parser work.", "hash1");
    const after = store2.getCard("s-v1");
    expect(after?.nlSummary).toBe("Did widget parser work.");
    expect(after?.summaryHash).toBe("hash1");
    // A vector write at the current generation lands and stamps embedding_gen.
    store2.writeCardEmbeddings("model-x:rep2", 4, [
      {
        sessionId: "s-v1",
        embedding: new Uint8Array([5, 6, 7, 8]),
        expectedSummaryHash: "hash1",
      },
    ]);
    expect(store2.getCard("s-v1")?.embeddingGen).toBe(4);
    db2.close();
  });

  it("chains a populated v2 store additively to v5, preserving cards/FTS/vectors/summaries", async () => {
    const path = freshDbPath();
    // Build a v2-shaped store by hand: the v2 card table HAS the summary columns
    // but NOT embedding_gen. Populate it as a real install would be.
    const db1 = await openSqlite(path);
    if (!db1) throw new Error("open failed");
    db1.exec("PRAGMA journal_mode=WAL;");
    db1.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE card (
        session_id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '',
        directory TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '',
        agent TEXT, model TEXT,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
        part_count INTEGER NOT NULL DEFAULT 0, retained_chars INTEGER NOT NULL DEFAULT 0,
        summary_head TEXT NOT NULL DEFAULT '', outcome_head TEXT NOT NULL DEFAULT '',
        inventory TEXT NOT NULL DEFAULT '',
        files TEXT NOT NULL DEFAULT '[]', tools TEXT NOT NULL DEFAULT '[]',
        errors TEXT NOT NULL DEFAULT '[]', family_rollup TEXT NOT NULL DEFAULT '[]',
        distill_state TEXT NOT NULL DEFAULT 'metadata',
        distilled_through TEXT,
        embedding BLOB,
        nl_summary TEXT NOT NULL DEFAULT '',
        summary_hash TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE part_text (
        id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, part_id TEXT NOT NULL,
        message_id TEXT NOT NULL, prev_message_id TEXT, next_message_id TEXT,
        class TEXT NOT NULL, time_created INTEGER NOT NULL,
        raw TEXT NOT NULL, norm TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE part_fts USING fts5(
        raw, norm, content='part_text', content_rowid='id',
        tokenize="unicode61 tokenchars '_-./'"
      );
    `);
    db1.run("INSERT INTO meta(key, value) VALUES(?, ?)", ["schema_version", "2"]);
    db1.run("INSERT INTO meta(key, value) VALUES(?, ?)", ["semantic_model", "model-x:rep3"]);
    db1.run("INSERT INTO meta(key, value) VALUES(?, ?)", ["cards_rev", "9"]);
    const vector = new Uint8Array([1, 2, 3, 4]);
    db1.run(
      "INSERT INTO card(session_id, root_id, title, time_created, time_updated, distill_state, inventory, embedding, nl_summary, summary_hash) VALUES(?, ?, ?, ?, ?, 'full', ?, ?, ?, ?)",
      [
        "s-v2",
        "s-v2",
        "V2 session",
        1000,
        2000,
        "gadget indexer",
        vector,
        "Built the indexer.",
        "h9",
      ],
    );
    db1.run(
      "INSERT INTO part_text(session_id, part_id, message_id, class, time_created, raw, norm) VALUES(?, ?, ?, ?, ?, ?, ?)",
      [
        "s-v2",
        "p1",
        "m1",
        "human-text",
        1000,
        "gadget indexer quibblefax",
        "gadget indexer quibblefax",
      ],
    );
    db1.run("INSERT INTO part_fts(rowid, raw, norm) VALUES(?, ?, ?)", [
      1,
      "gadget indexer quibblefax",
      "gadget indexer quibblefax",
    ]);
    db1.close();

    // Reopen with the current (v5) code: additive v2->v3->v4->v5 steps.
    const db2 = await openSqlite(path);
    if (!db2) throw new Error("reopen failed");
    const store2 = openV1Store(db2);
    if (!store2) throw new Error("reopen store failed");

    expect(store2.getMeta("schema_version")).toBe("5");
    expect(store2.getMeta("store_host")).toBe("opencode-v1");
    expect(columnNames(db2, "card")).toContain("distill_cursor");
    // Card, vector, summary, stamp, and cards_rev all survived.
    expect(store2.getMeta("semantic_model")).toBe("model-x:rep3");
    expect(store2.getMeta("cards_rev")).toBe("9");
    const card = store2.allCards({ withEmbeddings: true })[0];
    expect(card?.sessionId).toBe("s-v2");
    expect(card?.embedding).not.toBeNull();
    expect(card?.nlSummary).toBe("Built the indexer.");
    expect(card?.summaryHash).toBe("h9");
    // The pre-existing row reads the new column as NULL (unknown generation).
    expect(card?.embeddingGen).toBeNull();
    // The FTS index survived.
    expect(store2.ftsSearch({ strong: ["quibblefax"], weak: [] }).length).toBeGreaterThan(0);
    db2.close();
  });

  it("upgrades a populated v3 store additively to v5 for the v1 host, keeping every row and stamp", async () => {
    const path = freshDbPath();
    await buildV3Store(path);

    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    const store = openV1Store(db);
    if (!store) throw new Error("reopen store failed");

    expect(store.getMeta("schema_version")).toBe("5");
    expect(store.getMeta("store_host")).toBe("opencode-v1");
    expect(store.getMeta("source_db")).toBeUndefined();
    expect(columnNames(db, "card")).toContain("distill_cursor");
    expect(db.get("SELECT distill_cursor FROM card WHERE session_id='s-v3'")?.distill_cursor).toBe(
      null,
    );
    // Stamps and counters, including the lease row, are untouched.
    expect(store.getMeta("semantic_model")).toBe("model-x:4");
    expect(store.getMeta("cards_rev")).toBe("11");
    expect(store.getMeta("vectors_rev")).toBe("5");
    expect(store.getMeta("summary_rev")).toBe("2");
    expect(store.leaseStatus()).toEqual({
      holder: "proc-a",
      build: "schema3.gen4",
      gen: 4,
      heartbeat: 1234,
      ttl: 30_000,
    });
    // The card keeps its summary, vector and vector generation.
    const card = store.getCard("s-v3");
    expect(card).toMatchObject({
      title: "V3 session",
      inventory: "sprocket linker",
      distillState: "full",
      distilledThrough: "m1",
      nlSummary: "Linked the sprockets.",
      summaryHash: "h3",
      embeddingGen: 4,
    });
    expect(Array.from(card?.embedding ?? [])).toEqual([9, 8, 7, 6]);
    // The slim index and its FTS mirror survived.
    expect(sessions(store.ftsSearch({ strong: ["zorblequin"], weak: [] }))).toEqual(["s-v3"]);
    db.close();
  });

  it("opens a migrated store with a warning when the WAL switch fails", async () => {
    // The migration commits before the WAL switch, so a failing switch must not
    // turn a committed schema 5 store into an `error` refusal.
    const path = freshDbPath();
    await buildV3Store(path);
    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    const spy = instrument(db, { exec: /journal_mode=WAL/ });
    const opened = openStore(spy.db, V1);
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.warning).toContain("could not enable WAL");
    expect(opened.store.getMeta("schema_version")).toBe("5");
    expect(opened.store.getCard("s-v3")?.title).toBe("V3 session");
    opened.store.upsertCard(makeCard("s-new"));
    expect(opened.store.getCard("s-new")).toBeDefined();
    db.close();
  });

  it("refuses as `error` and keeps a v3 store intact when its migration throws", async () => {
    // Two failure points: the first statement of the v3 -> v4 step (the ALTER),
    // and a later one (the host stamp write, after the ALTER has run). Either
    // way the whole migration rolls back.
    for (const fail of [{ exec: /ADD COLUMN distill_cursor/ }, { runParam: "store_host" }]) {
      const path = freshDbPath();
      await buildV3Store(path);
      const db = await openSqlite(path);
      if (!db) throw new Error("reopen failed");
      const spy = instrument(db, fail);
      expect(openStore(spy.db, V1)).toEqual({ ok: false, reason: "error" });
      expect(spy.txOutcomes).toEqual(["rolled-back"]);
      db.close();

      const clean = await openSqlite(path);
      if (!clean) throw new Error("reopen failed");
      expect(rawMeta(clean, "schema_version")).toBe("3");
      expect(rawMeta(clean, "store_host")).toBeUndefined();
      expect(columnNames(clean, "card")).not.toContain("distill_cursor");
      expect(clean.get("SELECT title FROM card WHERE session_id='s-v3'")?.title).toBe("V3 session");
      expect(clean.get("SELECT COUNT(*) AS n FROM part_text")?.n).toBe(1);
      clean.close();

      // Nothing was lost: a clean open then migrates it normally.
      const retry = await openSqlite(path);
      const store = retry && openV1Store(retry);
      if (!retry || !store) throw new Error("retry open failed");
      expect(store.getMeta("schema_version")).toBe("5");
      expect(store.getCard("s-v3")?.nlSummary).toBe("Linked the sprockets.");
      retry.close();
    }
  });

  it("existingOnly refuses, untouched, a store it would rebuild or migrate", async () => {
    // Identity matches, but the schema stamp is damaged: the rebuilding
    // open would drop every card.
    const damaged = freshDbPath();
    const seed = await openSqlite(damaged);
    if (!seed) throw new Error("open failed");
    const seeded = openStore(seed, v2("/data/opencode.db"));
    if (!seeded.ok) throw new Error(seeded.reason);
    seeded.store.upsertCard(makeCard("s1"));
    seed.run("UPDATE meta SET value = 'garbage' WHERE key = 'schema_version'");
    seed.close();
    await expectRefusal(damaged, v2("/data/opencode.db"), "needs-rebuild", {
      existingOnly: true,
    });

    // A pre-fence store for its own (v1) host would be migrated.
    const legacy = freshDbPath();
    await buildV3Store(legacy);
    await expectRefusal(legacy, { host: "opencode-v1" }, "needs-migration", {
      existingOnly: true,
    });

    // A current store opens as usual.
    const current = freshDbPath();
    const fresh = await openSqlite(current);
    if (!fresh) throw new Error("open failed");
    if (!openStore(fresh, v2("/data/opencode.db")).ok) throw new Error("seed refused");
    expect(openStore(fresh, v2("/data/opencode.db"), { existingOnly: true }).ok).toBe(true);
    fresh.close();
  });

  it("refuses a v3 store for the v2 host without migrating it", async () => {
    // A pre-fence store implies the v1 host, so the v2 host must not upgrade it:
    // schema_version stays 3, no distill_cursor column, no host stamp.
    const path = freshDbPath();
    await buildV3Store(path);
    await expectRefusal(path, v2("/data/opencode.db"), "host-mismatch");

    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    expect(rawMeta(db, "schema_version")).toBe("3");
    expect(rawMeta(db, "store_host")).toBeUndefined();
    expect(columnNames(db, "card")).not.toContain("distill_cursor");
    db.close();
  });

  it("refuses a current store owned by the v1 host when the v2 host opens it", async () => {
    const path = freshDbPath();
    await buildCurrentStore(path, V1);
    await expectRefusal(path, v2("/data/opencode.db"), "host-mismatch");
  });

  it("refuses a current store owned by the v2 host when the v1 host opens it", async () => {
    const path = freshDbPath();
    await buildCurrentStore(path, v2("/data/opencode.db"));
    await expectRefusal(path, V1, "host-mismatch");
  });

  it("refuses a current store whose host stamp is missing instead of guessing an owner", async () => {
    const path = freshDbPath();
    await buildCurrentStore(path, V1);
    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    db.run("DELETE FROM meta WHERE key='store_host'");
    db.close();
    await expectRefusal(path, V1, "host-mismatch");
  });

  it("refuses a v2-host store distilled from a different source database", async () => {
    const path = freshDbPath();
    await buildCurrentStore(path, v2("/data/a/opencode.db"));
    await expectRefusal(path, v2("/data/b/opencode.db"), "source-mismatch");
  });

  it("requires a source for the v2 host and forbids one for v1, in the type", () => {
    // @ts-expect-error the v2 host must name its source database
    const noSource: StoreIdentity = { host: "opencode-v2" };
    // @ts-expect-error the v1 host reads over HTTP and has no source database
    const v1Source: StoreIdentity = { host: "opencode-v1", source: "/data/opencode.db" };
    expect([noSource.host, v1Source.host]).toEqual(["opencode-v2", "opencode-v1"]);
  });

  it("refuses a v2-host store whose source stamp is missing", async () => {
    // The type makes a v2 open without a source unrepresentable, so a v2 store
    // without a source stamp only arises from a hand edit. It is refused, not
    // adopted by whichever source opens it next.
    const path = freshDbPath();
    await buildCurrentStore(path, v2("/data/opencode.db"));
    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    db.run("DELETE FROM meta WHERE key='source_db'");
    db.close();
    await expectRefusal(path, v2("/data/opencode.db"), "source-mismatch");
  });

  it("opens a store whose host and source both match, keeping its data", async () => {
    const path = freshDbPath();
    await buildCurrentStore(path, v2("/data/opencode.db"));
    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    const opened = openStore(db, v2("/data/opencode.db"));
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.store.getCard("s1")).not.toBeUndefined();
    expect(sessions(opened.store.ftsSearch({ strong: ["keeper_marker"], weak: [] }))).toEqual([
      "s1",
    ]);
    db.close();
  });

  it("rolls the fence transaction back on a refusal instead of committing it", async () => {
    const path = freshDbPath();
    await buildCurrentStore(path, v2("/data/opencode.db"));
    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    const spy = instrument(db);
    expect(openStore(spy.db, V1)).toEqual({ ok: false, reason: "host-mismatch" });
    expect(spy.txOutcomes).toEqual(["rolled-back"]);
    db.close();
  });

  it("leaves a refused file's journal mode alone and switches an accepted one to WAL", async () => {
    const path = freshDbPath();
    await buildCurrentStore(path, v2("/data/opencode.db"));
    const raw = await openSqlite(path);
    if (!raw) throw new Error("reopen failed");
    raw.exec("PRAGMA journal_mode=DELETE;");
    raw.close();

    await expectRefusal(path, V1, "host-mismatch");
    const after = await openSqlite(path);
    if (!after) throw new Error("reopen failed");
    expect(after.get("PRAGMA journal_mode")?.journal_mode).toBe("delete");
    after.close();

    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    const opened = openStore(db, v2("/data/opencode.db"));
    expect(opened.ok).toBe(true);
    expect(db.get("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    db.close();
  });

  it("refuses a store whose schema is newer than the code, for either host", async () => {
    const path = freshDbPath();
    await buildCurrentStore(path, V1);
    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    db.run("UPDATE meta SET value='6' WHERE key='schema_version'");
    db.close();
    await expectRefusal(path, V1, "newer");
    // A foreign host stamp is checked before the schema stamp, so the other
    // host is refused as a mismatch rather than as a newer format.
    await expectRefusal(path, v2("/data/opencode.db"), "host-mismatch");
  });

  it("refuses a foreign-stamped store with a missing or unparseable schema stamp", async () => {
    // Without the stamp-first check these would fall through to a rebuild:
    // the v1 host wiping the v2 host's store.
    for (const damage of [
      "DELETE FROM meta WHERE key='schema_version'",
      "UPDATE meta SET value='not-a-number' WHERE key='schema_version'",
    ]) {
      const path = freshDbPath();
      await buildCurrentStore(path, v2("/data/opencode.db"));
      const db = await openSqlite(path);
      if (!db) throw new Error("reopen failed");
      db.run(damage);
      db.close();
      await expectRefusal(path, V1, "host-mismatch");
    }
  });

  it("refuses a pre-fence schema stamp that carries a foreign host stamp", async () => {
    const path = freshDbPath();
    await buildV3Store(path);
    const raw = await openSqlite(path);
    if (!raw) throw new Error("reopen failed");
    raw.run("INSERT INTO meta(key, value) VALUES('store_host', 'opencode-v2')");
    raw.close();

    await expectRefusal(path, V1, "host-mismatch");
    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    expect(rawMeta(db, "schema_version")).toBe("3");
    expect(columnNames(db, "card")).not.toContain("distill_cursor");
    db.close();
  });

  it("preserves data when reopening a store already at the current version", async () => {
    const path = freshDbPath();
    const db1 = await openSqlite(path);
    const store1 = db1 && openV1Store(db1);
    if (!db1 || !store1) throw new Error("open failed");
    store1.replaceSessionParts(
      "s1",
      [makePart("p1", "durable_marker survives restart")],
      makeCard("s1"),
    );
    db1.close();

    // A cold process restart must NOT wipe an in-version store.
    const db2 = await openSqlite(path);
    const store2 = db2 && openV1Store(db2);
    if (!db2 || !store2) throw new Error("reopen failed");
    expect(store2.getCard("s1")).not.toBeUndefined();
    expect(sessions(store2.ftsSearch({ strong: ["durable_marker"], weak: [] }))).toEqual(["s1"]);
    db2.close();
  });

  it.each([
    { name: "v1", identity: V1 },
    { name: "v2", identity: v2("/data/opencode.db") },
  ])(
    "upgrades a populated v4 store for the $name host additively to v5, keeping cards, rollups, FTS rows and counters",
    async ({ identity }) => {
      const path = freshDbPath();
      await buildV4Store(path, identity);

      const db = await openSqlite(path);
      if (!db) throw new Error("reopen failed");
      const opened = openStore(db, identity);
      if (!opened.ok) throw new Error(opened.reason);
      const store = opened.store;

      expect(store.getMeta("schema_version")).toBe("5");
      expect(store.getMeta("store_host")).toBe(identity.host);
      expect(store.getMeta("source_db")).toBe(
        identity.host === "opencode-v2" ? identity.source : undefined,
      );
      expect(store.getMeta("semantic_model")).toBe("model-x:4");
      expect(store.getCard("R")).toEqual(
        makeCard("R", {
          title: "V4 root",
          timeUpdated: 3000,
          inventory: "gizmo planner",
          familyRollup: V4_ROLLUP,
          distillState: "full",
          distilledThrough: "mR",
          embedding: new Uint8Array([1, 2, 3, 4]),
          embeddingGen: 4,
          nlSummary: "Planned the gizmos.",
          summaryHash: "h4",
          ...(identity.host === "opencode-v2" && { distillCursor: V4_CURSOR }),
        }),
      );
      expect(store.getCard("C")).toMatchObject({ parentId: "R", rootId: "R", title: "V4 child" });
      expect(sessions(store.ftsSearch({ strong: ["wobblefrond"], weak: [] }))).toEqual(["R"]);
      expect(sessions(store.ftsSearch({ strong: ["snorkelwick"], weak: [] }))).toEqual(["C"]);
      // The counters carry over; nothing this build stamps has been written yet.
      expect(store.cardStats()).toEqual({
        cards: 2,
        fullCards: 2,
        repairPending: 0,
        cardsRev: 11,
        cardsStamped: 0,
        cardsDeleted: 0,
        vectorsRev: 5,
      });
      // Migrated cards carry no generation and no stamped revision, and the
      // range-hash table exists, empty.
      expect(store.staleCards(1).map((c) => c.sessionId)).toEqual(["R", "C"]);
      expect(store.cardsSince(0, 10)).toEqual([]);
      expect(store.getRangeHashes("R")).toEqual([]);

      // The first stamped write takes the revision after the migrated counter.
      expect(store.patchCardMeta("C", { title: "Renamed child" })).toEqual({ changed: true });
      expect(store.getCard("C")?.writeRev).toBe(12);
      expect(store.cardStats()).toMatchObject({ cardsRev: 12, cardsStamped: 1 });
      db.close();
    },
  );

  it("existingOnly refuses a v4 store as needing migration, without writing", async () => {
    const path = freshDbPath();
    await buildV4Store(path, v2("/data/opencode.db"));
    await expectRefusal(path, v2("/data/opencode.db"), "needs-migration", { existingOnly: true });
  });

  it("refuses a v4 store with no host stamp instead of treating it as pre-fence", async () => {
    // Schema 4 is past the fence: its owner must be stamped, never implied.
    const path = freshDbPath();
    await buildV4Store(path, V1);
    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    db.run("DELETE FROM meta WHERE key='store_host'");
    db.close();
    await expectRefusal(path, V1, "host-mismatch");
  });

  it("refuses as `error` and keeps a v4 store intact when its migration throws midway", async () => {
    // The range-hash table is created after the card columns are added, so
    // failing there proves the earlier ALTERs roll back with it.
    const path = freshDbPath();
    await buildV4Store(path, V1);
    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    const spy = instrument(db, { exec: /CREATE TABLE range_hash/ });
    expect(openStore(spy.db, V1)).toEqual({ ok: false, reason: "error" });
    expect(spy.txOutcomes).toEqual(["rolled-back"]);
    db.close();

    const clean = await openSqlite(path);
    if (!clean) throw new Error("reopen failed");
    expect(rawMeta(clean, "schema_version")).toBe("4");
    expect(columnNames(clean, "card")).not.toContain("projector_gen");
    expect(columnNames(clean, "card")).not.toContain("write_rev");
    expect(clean.get("SELECT name FROM sqlite_master WHERE name='range_hash'")).toBeUndefined();
    expect(clean.get("SELECT COUNT(*) AS n FROM card")?.n).toBe(2);
    clean.close();

    const retry = await openSqlite(path);
    const store = retry && openV1Store(retry);
    if (!retry || !store) throw new Error("retry open failed");
    expect(store.getMeta("schema_version")).toBe("5");
    expect(store.getCard("R")?.familyRollup).toEqual(V4_ROLLUP);
    retry.close();
  });
});

describe("the repair-pending index across opens", () => {
  it.each<{
    name: string;
    identity: StoreIdentity;
    build?: (path: string) => Promise<void>;
    cards: number;
  }>([
    { name: "a new file", identity: V1, cards: 0 },
    {
      name: "a v4 store it migrates",
      identity: V1,
      build: (path) => buildV4Store(path, V1),
      cards: 2,
    },
    {
      name: "a current store without it",
      identity: v2("/data/opencode.db"),
      build: (path) => buildCurrentStore(path, v2("/data/opencode.db")),
      cards: 1,
    },
    {
      name: "a current store an earlier build gave it",
      identity: v2("/data/opencode.db"),
      build: async (path) => {
        await buildCurrentStore(path, v2("/data/opencode.db"));
        await addRepairIndex(path);
      },
      cards: 1,
    },
  ])(
    "an open leaves no index on $name, keeping the cards and the schema version",
    async ({ identity, build, cards }) => {
      const path = freshDbPath();
      await build?.(path);
      const db = await openSqlite(path);
      if (!db) throw new Error("open failed");
      const opened = openStore(db, identity);
      if (!opened.ok) throw new Error(opened.reason);
      expect(hasRepairIndex(db)).toBe(false);
      expect(opened.store.getMeta("schema_version")).toBe("5");
      expect(opened.store.allCards()).toHaveLength(cards);
      db.close();
    },
  );

  it.each<{ reason: StoreRefusal; owner: StoreIdentity; opener: StoreIdentity; edit?: string }>([
    {
      reason: "newer",
      owner: V1,
      opener: V1,
      edit: "UPDATE meta SET value='6' WHERE key='schema_version'",
    },
    { reason: "host-mismatch", owner: V1, opener: v2("/data/opencode.db") },
    {
      reason: "source-mismatch",
      owner: v2("/data/a/opencode.db"),
      opener: v2("/data/b/opencode.db"),
    },
  ])(
    "a $reason refusal leaves a store an earlier build gave it as it was",
    async ({ reason, owner, opener, edit }) => {
      const path = freshDbPath();
      await buildCurrentStore(path, owner);
      await addRepairIndex(path);
      if (edit) {
        const raw = await openSqlite(path);
        if (!raw) throw new Error("reopen failed");
        raw.run(edit);
        raw.close();
      }
      await expectRefusal(path, opener, reason);
      const db = await openSqlite(path);
      if (!db) throw new Error("reopen failed");
      expect(hasRepairIndex(db)).toBe(true);
      db.close();
    },
  );

  it("an existingOnly open takes a current store an earlier build gave it as it is, and still counts repair-pending cards", async () => {
    const path = freshDbPath();
    const identity = v2("/data/opencode.db");
    const seed = await openSqlite(path);
    if (!seed) throw new Error("open failed");
    const seeded = openStore(seed, identity);
    if (!seeded.ok) throw new Error(seeded.reason);
    for (const id of ["s1", "s2"]) seeded.store.replaceSessionParts(id, [], makeCard(id));
    seeded.store.markRepairPending("s1", "malformed");
    seed.close();
    await addRepairIndex(path);
    const probe = await openSqlite(path);
    if (!probe) throw new Error("probe open failed");
    const before = snapshot(probe);
    probe.close();

    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    const opened = openStore(db, identity, { existingOnly: true });
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.store.repairPendingCount()).toBe(1);
    expect(hasRepairIndex(db)).toBe(true);
    expect(db.get("SELECT total_changes() AS n")?.n).toBe(0);
    expect(snapshot(db)).toEqual(before);
    db.close();
  });
});

describe("pluginBuild", () => {
  it("tags the schema, representation generation and host", () => {
    expect(pluginBuild("opencode-v1")).toBe("schema5.gen4.opencode-v1");
    expect(pluginBuild("opencode-v2")).toBe("schema5.gen4.opencode-v2");
  });

  it("adds the projector generation when the host stamps one", () => {
    expect(pluginBuild("opencode-v2", 3)).toBe("schema5.gen4.proj3.opencode-v2");
    expect(pluginBuild("opencode-v2", 0)).toBe("schema5.gen4.proj0.opencode-v2");
  });
});

describe("cards CRUD", () => {
  it("round-trips a card, omitting the embedding unless asked", async () => {
    const { db, store } = await fresh();
    const embedding = new Uint8Array([1, 2, 3, 4]);
    const card = makeCard("s1", {
      parentId: "root1",
      rootId: "root1",
      title: "Deploy work",
      files: ["src/a.ts", "src/b.ts"],
      tools: ["bash", "edit"],
      errors: ["ECONNRESET"],
      familyRollup: [{ sessionId: "child1", messageId: "m9", snippet: "did the thing" }],
      distillState: "full",
      distilledThrough: "m42",
      embedding,
    });
    store.upsertCard(card);

    const got = store.getCard("s1");
    expect(got).toEqual(card);

    // allCards() omits the embedding blob by default.
    const listed = store.allCards();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.embedding).toBeNull();
    expect(listed[0]?.files).toEqual(["src/a.ts", "src/b.ts"]);

    // ...but returns it on request.
    expect(store.allCards({ withEmbeddings: true })[0]?.embedding).toEqual(embedding);

    // upsert overwrites in place.
    store.upsertCard(makeCard("s1", { title: "Renamed" }));
    expect(store.getCard("s1")?.title).toBe("Renamed");
    expect(store.allCards()).toHaveLength(1);

    // cardSessionIds() lists the same sessions without loading the cards.
    store.upsertCard(makeCard("s2"));
    expect(store.cardSessionIds().sort()).toEqual(["s1", "s2"]);
    // cardCount() counts them; a deleted session's card leaves the count.
    expect(store.cardCount()).toBe(2);
    store.deleteSession("s2");
    expect(store.cardCount()).toBe(1);
    db.close();
  });

  it("writeCardEmbeddings stamps model+generation, sets blobs, bumps vectors_rev, skips cards_rev", async () => {
    const { db, store } = await fresh();
    store.upsertCard(makeCard("s1"));
    store.upsertCard(makeCard("s2"));

    const vec = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    store.writeCardEmbeddings("minishlab/potion-base-8M", 4, [
      { sessionId: "s1", embedding: vec, expectedSummaryHash: "" },
    ]);

    expect(store.getMeta("semantic_model")).toBe("minishlab/potion-base-8M");
    const withEmb = store.allCards({ withEmbeddings: true });
    expect(withEmb.find((c) => c.sessionId === "s1")?.embedding).toEqual(vec);
    expect(withEmb.find((c) => c.sessionId === "s1")?.embeddingGen).toBe(4); // generation stamped
    expect(withEmb.find((c) => c.sessionId === "s2")?.embedding).toBeNull(); // untouched
    // Vectors are invisible to the lexical layer (no cards_rev bump), but
    // vectors_rev advances so another process's snapshot reloads.
    expect(store.getMeta("cards_rev")).toBeUndefined();
    expect(store.getMeta("vectors_rev")).toBe("1");

    // An unknown session id updates nothing and does not throw.
    expect(() =>
      store.writeCardEmbeddings("minishlab/potion-base-8M", 4, [
        { sessionId: "ghost", embedding: vec, expectedSummaryHash: "" },
      ]),
    ).not.toThrow();
    expect(store.getCard("ghost")).toBeUndefined();
    expect(store.getMeta("vectors_rev")).toBe("2"); // every write bumps it
    db.close();
  });

  it("writeCardEmbeddings skips a row whose summary_hash changed since the snapshot", async () => {
    const { db, store } = await fresh();
    store.upsertCard(makeCard("s1"));
    // A summary landed after the embed snapshot was taken (hash "h2", vector
    // cleared). A write-back that expected the pre-summary hash must NOT clobber
    // the cleared vector with the stale, summary-less one.
    store.writeSummary("s1", "the new summary", "h2");
    const stale = new Uint8Array([1, 2, 3, 4]);
    store.writeCardEmbeddings("m", 4, [
      { sessionId: "s1", embedding: stale, expectedSummaryHash: "" },
    ]);
    expect(store.getCard("s1")?.embedding).toBeNull(); // race lost, vector stays cleared

    // A write-back carrying the current hash lands normally.
    store.writeCardEmbeddings("m", 4, [
      { sessionId: "s1", embedding: stale, expectedSummaryHash: "h2" },
    ]);
    expect(store.allCards({ withEmbeddings: true })[0]?.embedding).toEqual(stale);
    db.close();
  });

  it("rejects a lower-generation write wholesale even under a different model stamp (no clear-all bypass)", async () => {
    const { db, store } = await fresh();
    store.upsertCard(makeCard("s1"));
    const hi = new Uint8Array([9, 9, 9, 9]);
    const lo = new Uint8Array([1, 1, 1, 1]);

    // A generation-5 writer establishes a vector under ITS OWN stamp (the
    // generation folds into the stamp, so a different generation always means a
    // different stamp — the branch the old same-stamp test never exercised).
    store.writeCardEmbeddings("model-a:5", 5, [
      { sessionId: "s1", embedding: hi, expectedSummaryHash: "" },
    ]);
    expect(store.getCard("s1")?.embeddingGen).toBe(5);
    expect(store.getMeta("semantic_model")).toBe("model-a:5");
    const revAfterHi = store.getMeta("vectors_rev");

    // A lagging generation-4 writer arrives with a DIFFERENT stamp. Its
    // stamp-mismatch clear-all would null the gen-5 row's generation and let the
    // per-row guard pass — so it must be refused WHOLESALE: no clear, no stamp
    // change, no row write, no vectors_rev bump. The returned rev is unchanged.
    const rejectedRev = store.writeCardEmbeddings("model-b:4", 4, [
      { sessionId: "s1", embedding: lo, expectedSummaryHash: "" },
    ]);
    expect(store.allCards({ withEmbeddings: true })[0]?.embedding).toEqual(hi); // unchanged
    expect(store.getCard("s1")?.embeddingGen).toBe(5); // still gen 5
    expect(store.getMeta("semantic_model")).toBe("model-a:5"); // stamp NOT advanced
    expect(store.getMeta("vectors_rev")).toBe(revAfterHi); // no bump
    expect(rejectedRev.committed).toBe(false); // reported as not-committed
    expect(String(rejectedRev.revision)).toBe(revAfterHi); // returns the unchanged revision

    // Same generation may rewrite under its own stamp (equal passes the check)...
    store.writeCardEmbeddings("model-a:5", 5, [
      { sessionId: "s1", embedding: lo, expectedSummaryHash: "" },
    ]);
    expect(store.allCards({ withEmbeddings: true })[0]?.embedding).toEqual(lo);

    // ...and a HIGHER generation upgrades it, its clear-all allowed.
    store.writeCardEmbeddings("model-c:6", 6, [
      { sessionId: "s1", embedding: hi, expectedSummaryHash: "" },
    ]);
    expect(store.allCards({ withEmbeddings: true })[0]?.embedding).toEqual(hi);
    expect(store.getCard("s1")?.embeddingGen).toBe(6);
    expect(store.getMeta("semantic_model")).toBe("model-c:6");
    db.close();
  });
});

describe("slim part index", () => {
  it("makes replaced parts searchable and drops the old ones", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts(
      "s1",
      [makePart("p1", "the wrangler deploy step"), makePart("p2", "ECONNRESET during upload")],
      makeCard("s1"),
    );
    expect(sessions(store.ftsSearch({ strong: ["wrangler"], weak: [] }))).toEqual(["s1"]);
    expect(sessions(store.ftsSearch({ strong: ["ECONNRESET"], weak: [] }))).toEqual(["s1"]);

    store.replaceSessionParts(
      "s1",
      [makePart("p3", "a totally different topic entirely")],
      makeCard("s1"),
    );
    expect(store.ftsSearch({ strong: ["wrangler"], weak: [] })).toEqual([]);
    expect(sessions(store.ftsSearch({ strong: ["different"], weak: [] }))).toEqual(["s1"]);
    db.close();
  });

  it("carries drill-down targets on each hit", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts(
      "s1",
      [
        makePart("p1", "unique_marker_bravo appears", {
          messageId: "m2",
          prevMessageId: "m1",
          nextMessageId: "m3",
          class: "reasoning",
        }),
      ],
      makeCard("s1"),
    );
    const hit = store.ftsSearch({ strong: ["unique_marker_bravo"], weak: [] })[0];
    expect(hit).toMatchObject({
      sessionId: "s1",
      partId: "p1",
      messageId: "m2",
      prevMessageId: "m1",
      nextMessageId: "m3",
      class: "reasoning",
    });
    expect(hit?.score).toBeTypeOf("number");
    db.close();
  });

  it("deleteSession removes the card, its parts, and its FTS matches", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [makePart("p1", "unique_marker_alpha here")], makeCard("s1"));
    expect(store.getCard("s1")).not.toBeUndefined();

    store.deleteSession("s1");
    expect(store.getCard("s1")).toBeUndefined();
    expect(store.ftsSearch({ strong: ["unique_marker_alpha"], weak: [] })).toEqual([]);
    expect(db.get("SELECT count(*) AS c FROM part_text WHERE session_id=?", ["s1"])?.c).toBe(0);
    db.close();
  });

  it("leaves a second session untouched when the first is replaced", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [makePart("p1", "sessionone content zulu")], makeCard("s1"));
    store.replaceSessionParts("s2", [makePart("p2", "sessiontwo content yankee")], makeCard("s2"));
    store.replaceSessionParts("s1", [makePart("p3", "sessionone rewritten xray")], makeCard("s1"));

    expect(sessions(store.ftsSearch({ strong: ["yankee"], weak: [] }))).toEqual(["s2"]);
    expect(store.ftsSearch({ strong: ["zulu"], weak: [] })).toEqual([]);
    expect(sessions(store.ftsSearch({ strong: ["xray"], weak: [] }))).toEqual(["s1"]);
    db.close();
  });

  it("appendSessionParts enforces the FTS row cap, evicting oldest and keeping newest", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts(
      "s1",
      [makePart("p1", "marker1"), makePart("p2", "marker2"), makePart("p3", "marker3")],
      makeCard("s1"),
    );

    // Append 3 more with a cap of 4: 6 total → keep the newest 4 (marker3..marker6).
    let recomputedCount = -1;
    store.appendSessionParts(
      "s1",
      [makePart("p4", "marker4"), makePart("p5", "marker5"), makePart("p6", "marker6")],
      4,
      { checkpointMessageId: "m-p3", firstNewMessageId: "m-p4" },
      (allRows) => {
        recomputedCount = allRows.length;
        return makeCard("s1", { partCount: allRows.length });
      },
    );

    expect(recomputedCount).toBe(4); // recompute saw exactly the surviving rows
    expect(store.getCard("s1")?.partCount).toBe(4);
    expect(db.get("SELECT count(*) AS c FROM part_text WHERE session_id=?", ["s1"])?.c).toBe(4);
    expect(store.ftsSearch({ strong: ["marker1"], weak: [] })).toEqual([]); // oldest evicted
    expect(store.ftsSearch({ strong: ["marker2"], weak: [] })).toEqual([]);
    expect(sessions(store.ftsSearch({ strong: ["marker3"], weak: [] }))).toEqual(["s1"]); // newest kept
    expect(store.ftsSearch({ strong: ["marker6"], weak: [] }).map((h) => h.partId)).toEqual(["p6"]);
    // The surviving checkpoint row's dangling next pointer now crosses the seam.
    expect(db.get("SELECT next_message_id AS n FROM part_text WHERE part_id=?", ["p3"])?.n).toBe(
      "m-p4",
    );
    db.close();
  });

  it("appendSessionParts skips excess new rows when overflow exceeds the old row count", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [makePart("p0", "onlyold")], makeCard("s1"));

    // old 1 + new 10, cap 5 → evict the 1 old row and skip the 5 oldest new rows,
    // inserting only the newest 5 (new5..new9).
    const newRows = Array.from({ length: 10 }, (_, i) => makePart(`n${i}`, `newrow${i}`));
    let recomputedCount = -1;
    store.appendSessionParts(
      "s1",
      newRows,
      5,
      { checkpointMessageId: "m-p0", firstNewMessageId: "m-n0" },
      (allRows) => {
        recomputedCount = allRows.length;
        return makeCard("s1", { partCount: allRows.length });
      },
    );

    expect(recomputedCount).toBe(5);
    expect(db.get("SELECT count(*) AS c FROM part_text WHERE session_id=?", ["s1"])?.c).toBe(5);
    expect(store.ftsSearch({ strong: ["onlyold"], weak: [] })).toEqual([]); // old evicted
    expect(store.ftsSearch({ strong: ["newrow0"], weak: [] })).toEqual([]); // oldest new skipped
    expect(store.ftsSearch({ strong: ["newrow4"], weak: [] })).toEqual([]); // still within the skip
    expect(sessions(store.ftsSearch({ strong: ["newrow5"], weak: [] }))).toEqual(["s1"]); // first kept
    expect(sessions(store.ftsSearch({ strong: ["newrow9"], weak: [] }))).toEqual(["s1"]); // newest kept
    db.close();
  });
});

describe("fts query construction", () => {
  it("matches on strong anchors alone (AND); weak anchors never narrow", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [makePart("p1", "alpha bravo charlie")], makeCard("s1"));
    store.replaceSessionParts("s2", [makePart("p2", "alpha delta")], makeCard("s2"));
    store.replaceSessionParts("s3", [makePart("p3", "charlie zebra")], makeCard("s3"));

    // All strong anchors required.
    expect(sessions(store.ftsSearch({ strong: ["alpha", "bravo"], weak: [] }))).toEqual(["s1"]);
    expect(sessions(store.ftsSearch({ strong: ["alpha", "delta"], weak: [] }))).toEqual(["s2"]);
    // A strong anchor no row satisfies excludes everything, even though alpha hits.
    expect(store.ftsSearch({ strong: ["alpha", "bravo", "delta"], weak: [] })).toEqual([]);
    // Weak-only is an OR union.
    expect(sessions(store.ftsSearch({ strong: [], weak: ["bravo", "delta"] })).sort()).toEqual([
      "s1",
      "s2",
    ]);
    // When strong anchors exist the weak anchors are dropped entirely — they must
    // NOT require a weak match. Both charlie rows return, though s3 has neither
    // bravo nor delta.
    expect(
      sessions(store.ftsSearch({ strong: ["charlie"], weak: ["bravo", "delta"] })).sort(),
    ).toEqual(["s1", "s3"]);
    // No anchors at all -> no query, no rows.
    expect(store.ftsSearch({ strong: [], weak: [] })).toEqual([]);
    db.close();
  });

  it("treats injection-shaped anchors as literal quoted text without error", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [makePart("p1", "foo appears here alone")], makeCard("s1"));
    // If the OR leaked into FTS syntax this would match s1 (which contains foo).
    // Quoted, it is the literal phrase "foo or bar" and matches nothing here.
    expect(store.ftsSearch({ strong: ['foo" OR "bar'], weak: [] })).toEqual([]);
    for (const anchor of ["NEAR(", "*", 'a" AND b', '""', "  "]) {
      expect(() => store.ftsSearch({ strong: [anchor], weak: [] })).not.toThrow();
      expect(store.ftsSearch({ strong: [anchor], weak: [] })).toEqual([]);
    }
    db.close();
  });

  it("keeps path-like anchors whole (tokenchars) and folds case", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [makePart("p1", "edited src/corpus.ts today")], makeCard("s1"));
    store.replaceSessionParts("s2", [makePart("p2", "the corpus module")], makeCard("s2"));
    store.replaceSessionParts(
      "s3",
      [makePart("p3", "GHOSTAUTH_LIVE_TUI flag set")],
      makeCard("s3"),
    );

    // The path is one token: it matches its exact form...
    expect(sessions(store.ftsSearch({ strong: ["src/corpus.ts"], weak: [] }))).toEqual(["s1"]);
    // ...and a bare component does NOT match the path row.
    expect(sessions(store.ftsSearch({ strong: ["corpus"], weak: [] }))).toEqual(["s2"]);
    // unicode61 folds case: a lowercase anchor matches an uppercase identifier.
    expect(sessions(store.ftsSearch({ strong: ["ghostauth_live_tui"], weak: [] }))).toEqual(["s3"]);
    db.close();
  });

  it("ranks the anchor in shorter text above the same anchor in longer text", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts(
      "short",
      [makePart("p1", "ECONNRESET wrangler deploy")],
      makeCard("short"),
    );
    store.replaceSessionParts(
      "long",
      [makePart("p2", `${"padding ".repeat(60)}ECONNRESET${" tail".repeat(60)}`)],
      makeCard("long"),
    );
    expect(sessions(store.ftsSearch({ strong: ["ECONNRESET"], weak: [] }))).toEqual([
      "short",
      "long",
    ]);
    db.close();
  });
});

describe("plain-word slim-index lookup", () => {
  // Eight filler sessions whose 480 rows all hold common words ("app" in
  // every row, "desktop", "sign" and "in" in half), and a tenth of them
  // "inference"; three target sessions hold the rare words. Under a 100-row
  // budget the common words are never ORed.
  const BUDGET = 100;

  async function wordStore(): Promise<{ db: SqliteDb; store: Store; scored: string[] }> {
    const db = await openSqlite(freshDbPath());
    if (!db) throw new Error("openSqlite returned null");
    // The MATCH expression of every lookup statement that scores rows.
    const scored: string[] = [];
    const recording: SqliteDb = {
      ...db,
      all: (sql, params) => {
        if (sql.includes("bm25(part_fts)")) scored.push(String(params?.[0]));
        return db.all(sql, params);
      },
    };
    const store = openV1Store(recording);
    if (!store) throw new Error("openStore returned null");
    for (let s = 0; s < 8; s++) {
      const rows = Array.from({ length: 60 }, (_, r) =>
        makePart(
          `f${s}-${r}`,
          `${r % 2 === 0 ? "desktop app" : "sign in to the app"} ${r % 10 === 0 ? "inference" : "notes"} ${s}`,
        ),
      );
      store.replaceSessionParts(`filler-${s}`, rows, makeCard(`filler-${s}`));
    }
    store.replaceSessionParts(
      "gov",
      [makePart("g1", "the governed rollout plan")],
      makeCard("gov"),
    );
    store.replaceSessionParts(
      "launch",
      [makePart("l1", "launcher crash on sign in")],
      makeCard("launch"),
    );
    store.replaceSessionParts(
      "both",
      [makePart("b1", "governed inference in the desktop launcher")],
      makeCard("both"),
    );
    return { db, store, scored };
  }

  const lookup = (store: Store, query: string) =>
    new Set(
      sessions(
        store.ftsSearch({ strong: [], weak: parseQuery(query).tokens, weakRowBudget: BUDGET }),
      ),
    );

  it("still finds the sessions holding a query's distinctive words", async () => {
    const { db, store } = await wordStore();
    const prose = lookup(store, "desktop app launcher sign in governed inference");
    for (const target of ["gov", "launch", "both"]) expect(prose.has(target)).toBe(true);
    expect([...lookup(store, "app launcher")].sort()).toEqual(["both", "launch"]);
    expect([...lookup(store, "governed")].sort()).toEqual(["both", "gov"]);
    // Every word is common: none is distinctive, so nothing is looked up.
    expect(lookup(store, "sign in app").size).toBe(0);
    // A strong anchor is looked up whatever its frequency.
    expect(store.ftsSearch({ strong: ["app"], weak: [], weakRowBudget: BUDGET })).toHaveLength(200);
    db.close();
  });

  it("scores at most the budget's rows where an OR of every word matches the index", async () => {
    const { db, store, scored } = await wordStore();
    const words = parseQuery("desktop app launcher sign in governed inference").tokens;
    store.ftsSearch({ strong: [], weak: words, weakRowBudget: BUDGET });
    const matched = (match: string): number =>
      Number(db.get("SELECT count(*) AS n FROM part_fts WHERE part_fts MATCH ?", [match])?.n);
    expect(scored).toHaveLength(1);
    expect(matched(scored[0]!)).toBeLessThanOrEqual(BUDGET);
    // The left-out words only rank: the rows are the kept words' rows.
    expect(matched(scored[0]!)).toBe(matched('"launcher" OR "governed" OR "inference"'));
    expect(matched(words.map((word) => `"${word}"`).join(" OR "))).toBe(483);
    db.close();
  });
});

describe("plain-word lookup past the budget", () => {
  // Under a 20-row budget: "cache", "invalidation" and "pool" are in 30 rows
  // each, and only "cache" and "invalidation" share a row (in "pair").
  // "rollout" is in 12 rows and "canary" in 25: the one row holding both (in
  // "both") is the oldest and as long as the 11 holding only "rollout".
  const BUDGET = 20;

  type Recorded = { scored: string[]; listed: string[] };

  /** A store whose lookup statements are recorded: `scored` the MATCH of
   *  each one ranked by `bm25()`, `listed` of each one listed by rowid. */
  async function recordingStore(): Promise<{ db: SqliteDb; store: Store } & Recorded> {
    const db = await openSqlite(freshDbPath());
    if (!db) throw new Error("openSqlite returned null");
    const scored: string[] = [];
    const listed: string[] = [];
    const recording: SqliteDb = {
      ...db,
      all: (sql, params) => {
        if (sql.includes("bm25(part_fts)")) scored.push(String(params?.[0]));
        else if (sql.includes("part_fts MATCH")) listed.push(String(params?.[0]));
        return db.all(sql, params);
      },
    };
    const store = openV1Store(recording);
    if (!store) throw new Error("openStore returned null");
    return { db, store, scored, listed };
  }

  function writer(store: Store) {
    return (sessionId: string, texts: string[], timeCreated = 1000) =>
      store.replaceSessionParts(
        sessionId,
        texts.map((text, i) =>
          makePart(`${sessionId}-${i}`, text, { timeCreated: timeCreated + i }),
        ),
        makeCard(sessionId),
      );
  }

  const many = (n: number, text: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => text(i));

  async function commonStore(): Promise<{ db: SqliteDb; store: Store } & Recorded> {
    const { db, store, scored, listed } = await recordingStore();
    const write = writer(store);
    write(
      "filler",
      many(40, (i) => `notes filler ${i}`),
    );
    write("pair", ["cache invalidation storm"]);
    write(
      "cache-only",
      many(29, (i) => `cache warmed ${i}`),
    );
    write(
      "invalidation-only",
      many(29, (i) => `invalidation queued ${i}`),
    );
    write(
      "pool-only",
      many(30, (i) => `pool drained ${i}`),
    );
    write("both", ["rollout canary step"], 1);
    write(
      "rollout-only",
      many(11, () => "rollout plan step"),
    );
    write(
      "canary-only",
      many(24, (i) => `canary build ${i}`),
    );
    scored.length = 0;
    listed.length = 0;
    return { db, store, scored, listed };
  }

  const lookup = (store: Store, words: string[], limit?: number, weakRowBudget = BUDGET) =>
    store.ftsSearch({ strong: [], weak: words, weakRowBudget, limit });

  it("lists the rows holding every common word without scoring them", async () => {
    const { db, store, scored, listed } = await commonStore();
    const hits = lookup(store, ["cache", "invalidation"]);
    expect(sessions(hits)).toEqual(["pair"]);
    expect(listed).toEqual(['"cache" AND "invalidation"']);
    // bm25() would read all 59 rows of the two words to weigh them.
    expect(scored).toEqual([]);
    db.close();
  });

  it("skips common words that never share a row", async () => {
    const { db, store, scored, listed } = await commonStore();
    expect(lookup(store, ["cache", "pool"])).toEqual([]);
    // The one statement is the list of rows holding both, which finds none.
    expect(listed).toEqual(['"cache" AND "pool"']);
    expect(scored).toEqual([]);
    db.close();
  });

  it("ranks a row holding a left-out word above rows holding only the kept word", async () => {
    const { db, store } = await commonStore();
    // No row holds all three words. "rollout" matches 12 rows, more than the
    // 5 returned; without "canary" in the ranking the older "both" row would
    // tie and come last.
    const hits = lookup(store, ["rollout", "canary", "notes"], 5);
    expect(hits.every((hit) => Number.isFinite(hit.score))).toBe(true);
    expect(hits).toHaveLength(5);
    expect(hits[0]!.sessionId).toBe("both");
    expect(new Set(sessions(hits.slice(1)))).toEqual(new Set(["rollout-only"]));
    db.close();
  });

  it("returns the row holding every word when the other word is past the ranking cap", async () => {
    // Under a 300-row budget "migration" (202 rows) is kept and "cache"
    // (1,501 rows) is past the 1,500-row ranking cap, so it adds nothing to
    // the kept lookup, where the one older "migration cache" row ties with
    // the 201 newer "migration plan" rows and comes 202nd of 200.
    const { db, store, scored } = await recordingStore();
    const write = writer(store);
    write("full", ["migration cache"], 1);
    write(
      "caches",
      many(1_500, (i) => `cache warmed ${i}`),
    );
    write(
      "plans",
      many(201, () => "migration plan"),
      2_000,
    );
    scored.length = 0;
    const hits = lookup(store, ["cache", "migration"], undefined, 300);
    expect(hits).toHaveLength(200);
    expect(hits[0]!.partId).toBe("full-0");
    expect(sessions(hits.slice(1))).toEqual(Array.from({ length: 199 }, () => "plans"));
    expect(scored).toEqual(['"migration"']);
    db.close();
  });

  it("lists the rows holding every word newest first, then the kept lookup's others once each", async () => {
    // Both words are kept. "deploy rollback" outranks the longer, newer
    // "deploy rollback after release" under bm25(), but the rows holding both
    // words come first newest first, and the kept lookup does not repeat them.
    const { db, store } = await recordingStore();
    writer(store)("s", [
      "deploy rollback",
      "deploy plan",
      "rollback plan",
      "deploy rollback after release",
      "deploy",
    ]);
    const parts = (hits: FtsHit[]) => hits.map((hit) => hit.partId);
    const top = lookup(store, ["deploy", "rollback"], 3);
    expect(parts(top).slice(0, 2)).toEqual(["s-3", "s-0"]);
    expect(top[2]!.partId).not.toMatch(/^s-[03]$/);
    expect(top.slice(0, 2).map((hit) => hit.score)).toEqual([-Infinity, -Infinity]);
    const all = parts(lookup(store, ["deploy", "rollback"], 10));
    expect(all.slice(0, 2)).toEqual(["s-3", "s-0"]);
    expect([...all].sort()).toEqual(["s-0", "s-1", "s-2", "s-3", "s-4"]);
    db.close();
  });
});

describe("plain-word anchor selection", () => {
  const rowsFrom =
    (rows: Record<string, number>) =>
    (anchor: string): number =>
      rows[anchor] ?? 0;

  it("keeps every word, in the given order, while their rows add up to at most the budget", () => {
    expect(boundWeakAnchors(["c", "a", "b"], rowsFrom({ c: 3, a: 1, b: 6 }), 10)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("keeps the rarest words while their rows fit the budget, and none after", () => {
    // Rarest first: d (1), a (3 in all), c (7); b would make 12.
    const rows = rowsFrom({ a: 2, b: 5, c: 4, d: 1 });
    expect(boundWeakAnchors(["a", "b", "c", "d"], rows, 7)).toEqual(["a", "c", "d"]);
  });

  it("leaves out a word whose rows alone reach the budget", () => {
    expect(boundWeakAnchors(["x", "y"], rowsFrom({ x: 10, y: 3 }), 10)).toEqual(["y"]);
    expect(boundWeakAnchors(["x"], rowsFrom({ x: 9 }), 10)).toEqual(["x"]);
    expect(boundWeakAnchors(["x", "y"], rowsFrom({ x: 10, y: 10 }), 10)).toEqual([]);
  });

  it("prefers the earlier of equally common words", () => {
    const rows = rowsFrom({ x: 4, y: 4, z: 4 });
    expect(boundWeakAnchors(["x", "y", "z"], rows, 10)).toEqual(["x", "y"]);
    expect(boundWeakAnchors(["z", "y", "x"], rows, 10)).toEqual(["z", "y"]);
  });

  it("counts a repeated word once, keeping one copy when it fits and none when too common", () => {
    const asked: string[] = [];
    const counting = (anchor: string): number => {
      asked.push(anchor);
      return rowsFrom({ a: 3, b: 2 })(anchor);
    };
    expect(boundWeakAnchors(["a", "b", "a"], counting, 100)).toEqual(["a", "b"]);
    expect(asked).toEqual(["a", "b"]);
    expect(boundWeakAnchors(["a", "b", "a"], rowsFrom({ a: 10, b: 2 }), 10)).toEqual(["b"]);
  });

  // One session, written in one transaction: "common" in 12 rows, "mid" in
  // 4, "rare" and "launcher" in r0 only.
  async function anchorStore(): Promise<{
    db: SqliteDb;
    store: Store;
    counts: Array<{ anchor: string; cap: number }>;
    matches: string[];
  }> {
    const db = await openSqlite(freshDbPath());
    if (!db) throw new Error("openSqlite returned null");
    const counts: Array<{ anchor: string; cap: number }> = [];
    const matches: string[] = [];
    const recording: SqliteDb = {
      ...db,
      get: (sql, params) => {
        if (sql.includes("count(*)") && sql.includes("part_fts MATCH")) {
          counts.push({ anchor: String(params?.[0]), cap: Number(params?.[1]) });
        }
        return db.get(sql, params);
      },
      all: (sql, params) => {
        if (sql.includes("bm25(part_fts)")) matches.push(String(params?.[0]));
        return db.all(sql, params);
      },
    };
    const store = openV1Store(recording);
    if (!store) throw new Error("openStore returned null");
    const text = (r: number): string =>
      r === 0 ? "common mid rare launcher" : r < 4 ? "common mid" : "common";
    store.replaceSessionParts(
      "s",
      Array.from({ length: 12 }, (_, r) => makePart(`r${r}`, text(r))),
      makeCard("s"),
    );
    counts.length = 0;
    matches.length = 0;
    return { db, store, counts, matches };
  }

  const parts = (hits: { partId: string }[]): string[] => hits.map((h) => h.partId);

  it("looks a strong anchor up without counting or ORing the plain words", async () => {
    const { db, store, counts, matches } = await anchorStore();
    const hits = store.ftsSearch({ strong: ["launcher"], weak: ["common", "mid"] });
    expect(parts(hits)).toEqual(["r0"]);
    expect(matches).toEqual(['"launcher"']);
    expect(counts).toEqual([]);
    db.close();
  });

  it("bounds the plain words when no strong anchor survives quoting", async () => {
    const { db, store, matches } = await anchorStore();
    const hits = store.ftsSearch({
      strong: ['""', "  "],
      weak: ["common", "rare"],
      weakRowBudget: 5,
    });
    // "common" (12 rows) is past the budget but ranks with the kept "rare".
    expect(matches).toEqual(['("rare") AND ("common" OR "rare")']);
    expect(parts(hits)).toEqual(["r0"]);
    db.close();
  });

  it("ORs every plain word as before when their rows fit the budget together", async () => {
    const { db, store, matches } = await anchorStore();
    const words = ["mid", "rare", "common", "launcher"];
    // 4 + 1 + 12 + 1 = 18 rows.
    expect(store.ftsSearch({ strong: [], weak: words })).toHaveLength(12);
    store.ftsSearch({ strong: [], weak: words, weakRowBudget: 18 });
    store.ftsSearch({ strong: [], weak: words, weakRowBudget: 17 });
    expect(matches).toEqual([
      buildMatch([], words),
      buildMatch([], words),
      `(${buildMatch([], ["mid", "rare", "launcher"])}) AND (${buildMatch([], words)})`,
    ]);
    db.close();
  });

  it("counts and keeps words under a positive budget rounded down, else the default", async () => {
    const { db, store, counts } = await anchorStore();
    const lookup = (weakRowBudget: number | undefined) => {
      counts.length = 0;
      const hits = store.ftsSearch({ strong: [], weak: ["common"], weakRowBudget });
      return { hits: hits.length, caps: counts.map((c) => c.cap) };
    };
    // "common" is in 12 rows: a budget of 12 leaves it out, 13 keeps it.
    expect(lookup(12.9)).toEqual({ hits: 0, caps: [12] });
    expect(lookup(13)).toEqual({ hits: 12, caps: [13] });
    for (const invalid of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(lookup(invalid), String(invalid)).toEqual({ hits: 12, caps: [WEAK_MATCH_ROWS] });
    }
    db.close();
  });
});

describe("meta and lease", () => {
  it("round-trips meta values", async () => {
    const { db, store } = await fresh();
    expect(store.getMeta("coldpass_cursor")).toBeUndefined();
    store.setMeta("coldpass_cursor", "abc");
    expect(store.getMeta("coldpass_cursor")).toBe("abc");
    store.setMeta("coldpass_cursor", "def");
    expect(store.getMeta("coldpass_cursor")).toBe("def");
    db.close();
  });

  it("acquires, defends, expires, hearts, and releases the distill lease", async () => {
    let clock = 1_000_000;
    const ttl = 5_000;
    const { db, store } = await fresh(() => clock);

    // Fresh acquire, and idempotent re-acquire by the same holder. The build tag
    // and generation ride the lease value for cross-process diagnosis.
    expect(store.acquireLease("A", ttl, "schema5.gen4.opencode-v1", 4)).toBe(true);
    expect(store.acquireLease("A", ttl, "schema5.gen4.opencode-v1", 4)).toBe(true);
    expect(store.leaseStatus()).toMatchObject({
      holder: "A",
      build: "schema5.gen4.opencode-v1",
      gen: 4,
    });

    // A second holder is refused while A's lease is fresh.
    clock = 1_000_100;
    expect(store.acquireLease("B", ttl, "schema5.gen4.opencode-v1", 4)).toBe(false);

    // A heartbeat (only the holder's own) extends the lease and preserves build/gen.
    expect(store.heartbeatLease("A")).toBe(true);
    expect(store.heartbeatLease("B")).toBe(false);
    expect(store.leaseStatus()).toMatchObject({
      holder: "A",
      build: "schema5.gen4.opencode-v1",
      gen: 4,
    });

    // Past the ORIGINAL acquire + ttl but within heartbeat + ttl: still A's.
    clock = 1_005_050;
    expect(store.acquireLease("B", ttl, "schema5.gen4.opencode-v1", 4)).toBe(false);

    // Past heartbeat + ttl: B, a DIFFERENT build, takes over the expired lease —
    // and leaseStatus now names it (the mixed-version diagnosis path).
    clock = 1_005_101;
    expect(store.acquireLease("B", ttl, "schema9.gen7", 7)).toBe(true);
    expect(store.leaseStatus()).toMatchObject({ holder: "B", build: "schema9.gen7", gen: 7 });

    // A no longer holds it, so A cannot release; B can.
    expect(store.releaseLease("A")).toBe(false);
    expect(store.releaseLease("B")).toBe(true);
    // A released lease has no holder (the sentinel); build/gen fall away.
    expect(store.leaseStatus()?.holder).toBe("");

    // A released lease is immediately acquirable by anyone.
    clock = 1_005_102;
    expect(store.acquireLease("A", ttl, "schema5.gen4.opencode-v1", 4)).toBe(true);
    db.close();
  });

  it("lets only one of two connections acquire the lease (changes-count, not read-check-write)", async () => {
    const path = freshDbPath();
    const dbA = await openSqlite(path);
    const storeA = dbA && openV1Store(dbA);
    const dbB = await openSqlite(path);
    const storeB = dbB && openV1Store(dbB);
    if (!dbA || !storeA || !dbB || !storeB) throw new Error("two-handle open failed");

    // Two separate connections race for the same fresh lease row.
    const a = storeA.acquireLease("A", 30_000, "buildA", 4);
    const b = storeB.acquireLease("B", 30_000, "buildB", 4);
    expect([a, b].filter(Boolean)).toHaveLength(1); // exactly one winner

    // The loser cannot then take a fresh lease while the winner's is live — the
    // conditional UPDATE's changes count refuses it, not an app-level re-check.
    const loser = a ? { store: storeB, id: "B" } : { store: storeA, id: "A" };
    expect(loser.store.acquireLease(loser.id, 30_000, "buildX", 4)).toBe(false);
    dbA.close();
    dbB.close();
  });
});

// ── Revision accounting and write suppression ────────────────────────────────

/** A range-hash fixture over the ~500 rows starting at `startSeq`. */
function rangeHash(startSeq: number, hash = `h${startSeq}`): RangeHash {
  return { startSeq, endSeq: startSeq + 499, rowCount: 500, hash, sweepGen: 1 };
}

/** How many revisions no write stamped, as a caller reads it with the rows
 *  it hands a write ({@link StoredRows.unstamped}). */
function unstampedOf(store: Store): number {
  const { cardsRev, cardsStamped } = store.cardCounters();
  return cardsRev - cardsStamped;
}

/** Run `write` and report its result and how far each revision counter moved. */
function counterMoves<T>(
  store: Store,
  write: () => T,
): { result: T; rev: number; stamped: number; deleted: number; vectors: number } {
  const before = store.cardStats();
  const result = write();
  const after = store.cardStats();
  return {
    result,
    rev: after.cardsRev - before.cardsRev,
    stamped: after.cardsStamped - before.cardsStamped,
    deleted: after.cardsDeleted - before.cardsDeleted,
    vectors: after.vectorsRev - before.vectorsRev,
  };
}

const VECTOR = new Uint8Array([1, 2, 3, 4]);

/** Persist {@link VECTOR} on a card, under the summary hash it currently holds. */
function embed(store: Store, sessionId: string): void {
  store.writeCardEmbeddings("model-x:4", 4, [
    {
      sessionId,
      embedding: VECTOR,
      expectedSummaryHash: store.getCard(sessionId)?.summaryHash ?? "",
    },
  ]);
}

describe("revision accounting", () => {
  it("moves cards_rev and cards_stamped together: one per changing write, none otherwise", async () => {
    const { db, store } = await fresh();
    const card = makeCard("s1", { distillState: "full", distilledThrough: "m-p1" });
    const rows = [makePart("p1", "alpha")];
    const meta = { title: "", directory: "", projectId: "prj", timeUpdated: 2000 };
    const rollup = [{ sessionId: "c1", messageId: "m1" }];
    const steps: Array<{
      name: string;
      write: () => { changed: boolean };
      changed: boolean;
      revs: number;
    }> = [
      {
        name: "first replace",
        write: () => store.replaceSessionParts("s1", rows, card),
        changed: true,
        revs: 1,
      },
      {
        name: "identical replace",
        write: () => store.replaceSessionParts("s1", rows, card),
        changed: false,
        revs: 0,
      },
      {
        name: "append of a row",
        write: () =>
          store.appendSessionParts(
            "s1",
            [makePart("p2", "beta")],
            0,
            { checkpointMessageId: "m-p1", firstNewMessageId: "m-p2" },
            (all) => ({ ...card, partCount: all.length }),
          ),
        changed: true,
        revs: 1,
      },
      {
        name: "project patch",
        write: () => store.patchCardMeta("s1", { projectId: "prj" }),
        changed: true,
        revs: 1,
      },
      {
        name: "same project patch",
        write: () => store.patchCardMeta("s1", { projectId: "prj" }),
        changed: false,
        revs: 0,
      },
      {
        name: "metadata refresh",
        write: () => store.refreshCardMeta("s1", meta, null),
        changed: true,
        revs: 1,
      },
      {
        name: "same metadata refresh",
        write: () => store.refreshCardMeta("s1", meta, null),
        changed: false,
        revs: 0,
      },
      {
        name: "rollup",
        write: () => store.setFamilyRollup("s1", rollup),
        changed: true,
        revs: 1,
      },
      {
        name: "same rollup",
        write: () => store.setFamilyRollup("s1", rollup),
        changed: false,
        revs: 0,
      },
      {
        name: "summary",
        write: () => store.writeSummary("s1", "Summary.", "h1"),
        changed: true,
        revs: 1,
      },
      {
        name: "same summary",
        write: () => store.writeSummary("s1", "Summary.", "h1"),
        changed: false,
        revs: 0,
      },
      // Readers never see a repair reason, so recording one allocates nothing.
      {
        name: "repair mark",
        write: () => store.markRepairPending("s1", "malformed"),
        changed: true,
        revs: 0,
      },
      { name: "delete", write: () => store.deleteSession("s1"), changed: true, revs: 1 },
      { name: "repeated delete", write: () => store.deleteSession("s1"), changed: false, revs: 0 },
    ];
    for (const step of steps) {
      const moved = counterMoves(store, step.write);
      expect(moved.result.changed, step.name).toBe(step.changed);
      expect(moved.rev, step.name).toBe(step.revs);
      expect(moved.stamped, step.name).toBe(step.revs);
      const stored = store.getCard("s1");
      if (stored && step.revs > 0) {
        expect(stored.writeRev, step.name).toBe(store.cardStats().cardsRev);
      }
    }
    expect(store.cardStats()).toMatchObject({ cardsRev: 7, cardsStamped: 7, cardsDeleted: 1 });
    db.close();
  });

  it("moves only vectors_rev on a vector write, leaving the card's stamped revision", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [], makeCard("s1"));
    const moved = counterMoves(store, () => embed(store, "s1"));
    expect(moved).toMatchObject({ rev: 0, stamped: 0, deleted: 0, vectors: 1 });
    expect(store.getCard("s1")?.writeRev).toBe(1);
    db.close();
  });

  it("deleteSession removes the session's range hashes with its card and counts the deletion", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [makePart("p1", "doomed_marker")], makeCard("s1"), {
      rangeHashes: [rangeHash(0)],
    });
    store.putRangeHashes("s2", [rangeHash(0)]);
    const moved = counterMoves(store, () => store.deleteSession("s1"));
    expect(moved).toMatchObject({ result: { changed: true }, rev: 1, stamped: 1, deleted: 1 });
    expect(store.getCard("s1")).toBeUndefined();
    expect(store.ftsSearch({ strong: ["doomed_marker"], weak: [] })).toEqual([]);
    expect(store.getRangeHashes("s1")).toEqual([]);
    expect(store.getRangeHashes("s2")).toEqual([rangeHash(0)]);
    db.close();
  });

  it("upsertCard writes outside the accounting, keeping the stamped revision, repair reason and store-owned columns", async () => {
    const { db, store } = await fresh();
    const rollup = [{ sessionId: "c1", messageId: "m1" }];
    store.replaceSessionParts("s1", [], makeCard("s1"));
    store.setFamilyRollup("s1", rollup);
    store.writeSummary("s1", "Summary.", "h1");
    store.markRepairPending("s1", "malformed");
    const moved = counterMoves(store, () =>
      store.upsertCard(makeCard("s1", { title: "Upserted" })),
    );
    expect(moved).toMatchObject({ rev: 0, stamped: 0 });
    expect(store.getCard("s1")).toMatchObject({
      title: "Upserted",
      familyRollup: rollup,
      nlSummary: "Summary.",
      summaryHash: "h1",
      writeRev: 3,
      repairReason: "malformed",
    });
    db.close();
  });
});

describe("replace suppression", () => {
  it("writes only the checkpoint, generation and range hashes for an identical replace, keeping the vector", async () => {
    const { db, store } = await fresh();
    const rows = [makePart("p1", "alpha"), makePart("p2", "beta", { prevMessageId: "m-p1" })];
    const card = makeCard("s1", {
      distillState: "full",
      distillCursor: "cursor-1",
      projectorGen: 1,
    });
    store.replaceSessionParts("s1", rows, card);
    embed(store, "s1");
    const before = store.getCard("s1")!;

    // The incoming card carries no vector, as a re-derived card never does.
    const moved = counterMoves(store, () =>
      store.replaceSessionParts(
        "s1",
        rows,
        { ...card, distillCursor: "cursor-2", projectorGen: 2 },
        { rangeHashes: [rangeHash(0)] },
      ),
    );
    expect(moved).toMatchObject({ result: { changed: false }, rev: 0, stamped: 0 });
    expect(store.getCard("s1")).toEqual({ ...before, distillCursor: "cursor-2", projectorGen: 2 });
    expect(store.getRangeHashes("s1")).toEqual([rangeHash(0)]);
    expect(sessions(store.ftsSearch({ strong: ["beta"], weak: [] }))).toEqual(["s1"]);
    db.close();
  });

  it("neither compares nor overwrites the stored summary and family rollup", async () => {
    const { db, store } = await fresh();
    const rows = [makePart("p1", "alpha")];
    const rollup = [{ sessionId: "c1", messageId: "m1", snippet: "child" }];
    store.replaceSessionParts("s1", rows, makeCard("s1"));
    store.writeSummary("s1", "Summary.", "h1");
    store.setFamilyRollup("s1", rollup);

    // A re-derived card carries an empty summary and rollup.
    expect(store.replaceSessionParts("s1", rows, makeCard("s1"))).toEqual({ changed: false });
    expect(
      store.replaceSessionParts("s1", rows, makeCard("s1", { title: "Renamed" })),
    ).toMatchObject({ changed: true });
    expect(store.getCard("s1")).toMatchObject({
      title: "Renamed",
      nlSummary: "Summary.",
      summaryHash: "h1",
      familyRollup: rollup,
    });

    // A first write takes the card's rollup.
    store.replaceSessionParts("s2", [], makeCard("s2", { familyRollup: rollup }));
    expect(store.getCard("s2")?.familyRollup).toEqual(rollup);
    db.close();
  });

  it.each<{ name: string; card?: Partial<Card>; rows?: (rows: PartTextRow[]) => PartTextRow[] }>([
    { name: "a card title", card: { title: "Renamed" } },
    { name: "a card list field", card: { files: ["src/a.ts"] } },
    { name: "the card's archive time", card: { timeArchived: 5000 } },
    { name: "the card's distilled-through message", card: { distilledThrough: "m-p9" } },
    { name: "a row's text", rows: (r) => [r[0]!, { ...r[1]!, raw: "gamma" }] },
    { name: "a row's next pointer", rows: (r) => [{ ...r[0]!, nextMessageId: "m-p2" }, r[1]!] },
    { name: "the row order", rows: (r) => [r[1]!, r[0]!] },
    { name: "the row count", rows: (r) => [r[0]!] },
  ])("rewrites with a revision when $name differs", async ({ card, rows: change }) => {
    const { db, store } = await fresh();
    const rows = [makePart("p1", "alpha"), makePart("p2", "beta")];
    store.replaceSessionParts("s1", rows, makeCard("s1"));
    const moved = counterMoves(store, () =>
      store.replaceSessionParts("s1", change ? change(rows) : rows, makeCard("s1", card)),
    );
    expect(moved).toMatchObject({ result: { changed: true }, rev: 1, stamped: 1 });
    expect(store.getCard("s1")?.writeRev).toBe(2);
    db.close();
  });
});

describe("writes over stored rows", () => {
  const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "theta", "kappa"];
  const CLASSES = ["human-text", "assistant-text", "tool-input", "tool-output"];
  const MESSAGES = ["m-1", "m-2", "m-3", "m-4", "m-5"];

  /** The rows a caller reads before a replace, as the distiller reads them. */
  const preRead = (store: Store, sessionId: string): StoredRows => ({
    writeRev: store.cardWriteRev(sessionId) ?? null,
    unstamped: unstampedOf(store),
    rows: store.sessionRows(sessionId, 0, 100_000),
  });

  /** A session's rows as readers see them: every field, in rowid order. */
  const rowsOf = (db: SqliteDb, sessionId: string): unknown[] =>
    db.all(
      `SELECT part_id, message_id, prev_message_id, next_message_id, class, time_created, raw, norm
       FROM part_text WHERE session_id = ? ORDER BY id`,
      [sessionId],
    );

  /** What the index finds for each word, and for plain-word pairs, every hit
   *  with its score, in a fixed order. */
  const ftsView = (store: Store): string[][] =>
    WORDS.flatMap((word, i) => [
      store.ftsSearch({ strong: [word], weak: [], limit: 10_000 }),
      store.ftsSearch({ strong: [], weak: [word, WORDS[(i + 3) % WORDS.length]!], limit: 10_000 }),
    ]).map((hits) => hits.map((hit) => `${hit.sessionId}/${hit.partId} ${hit.score}`).sort());

  /** Throws unless the FTS index holds exactly the rows `part_text` holds. */
  const checkIndex = (db: SqliteDb): void => {
    db.run("INSERT INTO part_fts(part_fts, rank) VALUES('integrity-check', 1)");
  };

  /** A card as two stores must hold it: their revisions differ. */
  const comparable = (card: Card | undefined): Partial<Card> | undefined => {
    if (!card) return undefined;
    const copy: Partial<Card> = { ...card };
    delete copy.writeRev;
    return copy;
  };

  const pick = <T>(rand: () => number, items: readonly T[]): T =>
    items[Math.floor(rand() * items.length)]!;
  const words = (rand: () => number): string =>
    Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(rand, WORDS)).join(" ");
  let parts = 0;
  const newRow = (rand: () => number): PartTextRow => {
    const raw = words(rand);
    return makePart(`p${parts++}`, raw, {
      messageId: pick(rand, MESSAGES),
      prevMessageId: rand() < 0.3 ? null : pick(rand, MESSAGES),
      nextMessageId: rand() < 0.3 ? null : pick(rand, MESSAGES),
      class: pick(rand, CLASSES),
      timeCreated: 1000 + Math.floor(rand() * 50),
      norm: rand() < 0.5 ? raw : words(rand),
    });
  };
  const indexIn = (rand: () => number, rows: PartTextRow[]): number =>
    Math.floor(rand() * rows.length);
  const changeOne = (
    rows: PartTextRow[],
    rand: () => number,
    change: (row: PartTextRow) => PartTextRow,
  ): PartTextRow[] => {
    const at = indexIn(rand, rows);
    return rows.map((row, i) => (i === at ? change(row) : row));
  };

  /** Random edits of a session's rows. `moves` marks the edits that add a
   *  row before a row that stays, or move one, which rewrite every row
   *  after it. */
  const EDITS: Array<{
    name: string;
    moves?: true;
    run: (rows: PartTextRow[], rand: () => number) => PartTextRow[];
  }> = [
    { name: "append", run: (rows, rand) => [...rows, newRow(rand), newRow(rand)] },
    { name: "evict the oldest", run: (rows, rand) => rows.slice(1 + Math.floor(rand() * 3)) },
    {
      name: "remove one",
      run: (rows, rand) => {
        const at = indexIn(rand, rows);
        return rows.filter((_, i) => i !== at);
      },
    },
    {
      name: "change the text",
      run: (rows, rand) => changeOne(rows, rand, (row) => ({ ...row, raw: words(rand) })),
    },
    {
      name: "change the normalized text",
      run: (rows, rand) => changeOne(rows, rand, (row) => ({ ...row, norm: words(rand) })),
    },
    {
      name: "change a pointer",
      run: (rows, rand) =>
        changeOne(rows, rand, (row) =>
          rand() < 0.5
            ? { ...row, prevMessageId: row.prevMessageId ? null : pick(rand, MESSAGES) }
            : { ...row, nextMessageId: row.nextMessageId ? null : pick(rand, MESSAGES) },
        ),
    },
    {
      name: "change the message, class and time",
      run: (rows, rand) =>
        changeOne(rows, rand, (row) => ({
          ...row,
          messageId: pick(rand, MESSAGES),
          class: pick(rand, CLASSES),
          timeCreated: row.timeCreated + 1,
        })),
    },
    {
      name: "insert before a stored row",
      moves: true,
      run: (rows, rand) => {
        const at = indexIn(rand, rows);
        return [...rows.slice(0, at), newRow(rand), ...rows.slice(at)];
      },
    },
    {
      name: "move one",
      moves: true,
      run: (rows, rand) => {
        const from = indexIn(rand, rows);
        const moved = rows.filter((_, i) => i !== from);
        moved.splice(indexIn(rand, moved), 0, rows[from]!);
        return moved;
      },
    },
    { name: "nothing", run: (rows) => rows },
  ];

  it("diffed replaces leave the rows, index and card a delete-all and insert-all write leaves, writing only the rows that differ", async () => {
    // Replaced with rows read inside the transaction, with rows read before
    // it, and by deleting the session and writing every row again.
    const inTx = await recordedStore();
    const prepared = await recordedStore();
    const rewritten = await recordedStore();
    const tally = new Map<string, number>();
    const count = (what: string) => tally.set(what, (tally.get(what) ?? 0) + 1);
    const SEQUENCES = 12;
    const STEPS = 12;
    for (let s = 0; s < SEQUENCES; s++) {
      const rand = mulberry32(7_000 + s);
      // Each sequence writes its own session; the earlier ones stay stored.
      const sid = `s${s}`;
      const cardOf = (rows: PartTextRow[], step: number) =>
        makeCard(sid, {
          distillState: "full",
          partCount: rows.length,
          title: rand() < 0.5 ? "Steady" : `Title ${step}`,
          distillCursor: `c-${step}`,
        });
      let rows = Array.from({ length: 20 + Math.floor(rand() * 40) }, () => newRow(rand));
      for (const { store } of [inTx, prepared, rewritten]) {
        store.replaceSessionParts(sid, rows, cardOf(rows, 0));
      }
      for (let step = 1; step <= STEPS; step++) {
        let moves = false;
        const names: string[] = [];
        for (let e = 1 + Math.floor(rand() * 3); e > 0; e--) {
          const edit = rows.length < 5 ? EDITS[0]! : pick(rand, EDITS);
          rows = edit.run(rows, rand);
          moves ||= edit.moves === true;
          names.push(edit.name);
        }
        const where = `sequence ${s}, step ${step}: ${names.join(", ")}`;
        const card = cardOf(rows, step);
        const before = [rowsByPart(inTx.db, sid), rowsByPart(prepared.db, sid)];
        const stored = preRead(prepared.store, sid);
        inTx.recorded.record(true);
        prepared.recorded.record(true);
        const result = inTx.store.replaceSessionParts(sid, rows, card);
        expect(prepared.store.replaceSessionParts(sid, rows, card, { stored }), where).toEqual(
          result,
        );
        inTx.recorded.record(false);
        prepared.recorded.record(false);
        rewritten.store.deleteSession(sid);
        rewritten.store.replaceSessionParts(sid, rows, card);
        expect(result.refused, where).toBeUndefined();
        count(result.changed ? "changed" : "suppressed");
        if (moves) count("moves");

        const expected = {
          rows: rowsOf(rewritten.db, sid),
          card: comparable(rewritten.store.getCard(sid)),
          fts: ftsView(rewritten.store),
        };
        [inTx, prepared].forEach((ctx, i) => {
          expect(rowsOf(ctx.db, sid), where).toEqual(expected.rows);
          expect(comparable(ctx.store.getCard(sid)), where).toEqual(expected.card);
          expect(ftsView(ctx.store), where).toEqual(expected.fts);
          checkIndex(ctx.db);

          const after = rowsByPart(ctx.db, sid);
          const changed = changedParts(before[i]!, after);
          const changedText = changedParts(before[i]!, after, ["raw", "norm"]);
          const written = touchedParts(ctx.recorded.mutations, "part_text", before[i]!, after);
          const indexed = touchedParts(ctx.recorded.mutations, "part_fts", before[i]!, after);
          // Every statement wrote one row of this session.
          expect(written, where).not.toBe("session");
          expect(indexed, where).not.toBe("session");
          if (written === "session" || indexed === "session") return;
          expect(
            [...written, ...indexed].filter((part) => !after.has(part) && !before[i]!.has(part)),
            where,
          ).toEqual([]);
          if (moves) {
            expect(written, where).toEqual(expect.arrayContaining(changed));
          } else {
            // Without a row added before one that stays, or a part moved,
            // the rows written are exactly the rows that differ, and the
            // index entries written those whose text differs.
            expect(written, where).toEqual(changed);
            expect(indexed, where).toEqual(changedText);
            if (changed.length > 0) count("rows written exactly");
          }
        });
      }
    }
    // Every kind of write ran: suppressed, changed, exact and moving.
    expect(tally.get("suppressed") ?? 0).toBeGreaterThan(0);
    expect(tally.get("moves") ?? 0).toBeGreaterThan(SEQUENCES);
    expect(tally.get("rows written exactly") ?? 0).toBeGreaterThan(SEQUENCES);
    for (const ctx of [inTx, prepared, rewritten]) ctx.db.close();
  }, 60_000);

  /** s1 with six rows, one per word, and one range hash. */
  async function seeded() {
    const ctx = await recordedStore();
    const rows = WORDS.slice(0, 6).map((word, i) =>
      makePart(`q${i}`, word, { messageId: `m-${i}`, prevMessageId: i > 0 ? `m-${i - 1}` : null }),
    );
    const card = makeCard("s1", { distillState: "full", partCount: rows.length });
    ctx.store.replaceSessionParts("s1", rows, card, { rangeHashes: [rangeHash(0)] });
    // The next rows: the oldest evicted, one changed, one appended.
    const next = [
      ...rows.slice(1, 3),
      { ...rows[3]!, raw: "lambda", norm: "lambda" },
      ...rows.slice(4),
      makePart("q9", "omega", { messageId: "m-9" }),
    ];
    return { ...ctx, rows, card, next };
  }

  /** Everything a refused or failed replace must leave as it was. */
  const state = (db: SqliteDb, store: Store) => ({
    rows: rowsOf(db, "s1"),
    rowids: db.all("SELECT id FROM part_text ORDER BY id"),
    card: store.getCard("s1"),
    hashes: store.getRangeHashes("s1"),
    fts: ftsView(store),
    counters: store.cardStats(),
  });

  it.each<{
    name: string;
    race?: (ctx: Awaited<ReturnType<typeof seeded>>) => void;
    read?: (stored: StoredRows) => StoredRows;
  }>([
    {
      name: "a stamped write moved the card's revision",
      race: ({ store }) => store.writeSummary("s1", "Summary.", "h1"),
    },
    {
      name: "another replace changed the rows, keeping their number",
      race: ({ store, rows, card }) =>
        store.replaceSessionParts(
          "s1",
          rows.map((row) => ({ ...row, raw: `${row.raw} kappa` })),
          card,
        ),
    },
    { name: "the session was deleted", race: ({ store }) => store.deleteSession("s1") },
    {
      name: "the session holds another number of rows",
      read: (stored) => ({ ...stored, rows: stored.rows.slice(1) }),
    },
  ])("a replace refuses rows read before $name, writing nothing", async (o) => {
    const ctx = await seeded();
    const stored = (o.read ?? ((rows: StoredRows) => rows))(preRead(ctx.store, "s1"));
    o.race?.(ctx);
    const before = state(ctx.db, ctx.store);
    const write = (extra?: { stored: StoredRows }) =>
      ctx.store.replaceSessionParts("s1", ctx.next, ctx.card, {
        rangeHashes: [rangeHash(500)],
        replaceRangeHashes: true,
        ...extra,
      });

    ctx.recorded.record(true);
    expect(write({ stored })).toEqual({ changed: false, refused: "base-changed" });
    ctx.recorded.record(false);
    expect(ctx.recorded.mutations).toEqual([]);
    expect(state(ctx.db, ctx.store)).toEqual(before);

    // The same write against the rows stored now is accepted.
    expect(write()).toEqual({ changed: true });
    expect(rowsOf(ctx.db, "s1")).toEqual(
      ctx.next.map((row) => ({
        part_id: row.partId,
        message_id: row.messageId,
        prev_message_id: row.prevMessageId,
        next_message_id: row.nextMessageId,
        class: row.class,
        time_created: row.timeCreated,
        raw: row.raw,
        norm: row.norm,
      })),
    );
    checkIndex(ctx.db);
    ctx.db.close();
  });

  it("a replace removes index entries with the text the rows hold when it writes, not the text read before", async () => {
    const ctx = await seeded();
    const stored = preRead(ctx.store, "s1");
    // A write that moves no counter at all rewrites a row the caller read,
    // keeping the index whole.
    olderWrite(ctx.db, false);

    expect(ctx.store.replaceSessionParts("s1", ctx.next, ctx.card, { stored })).toEqual({
      changed: true,
    });
    checkIndex(ctx.db);
    expect(ctx.store.ftsSearch({ strong: ["mu"], weak: [] })).toEqual([]);
    expect(sessions(ctx.store.ftsSearch({ strong: ["lambda"], weak: [] }))).toEqual(["s1"]);
    ctx.db.close();
  });

  /** A write as an older build makes it: it rewrites q3's text to "mu",
   *  keeping the index whole, stamps no revision on the card and, when
   *  `counted`, moves `cards_rev` alone. */
  function olderWrite(db: SqliteDb, counted: boolean): void {
    const row = db.get("SELECT id, raw, norm FROM part_text WHERE part_id = 'q3'")!;
    db.run("INSERT INTO part_fts(part_fts, rowid, raw, norm) VALUES('delete', ?, ?, ?)", [
      row.id!,
      row.raw!,
      row.norm!,
    ]);
    db.run("UPDATE part_text SET raw = 'mu', norm = 'mu' WHERE id = ?", [row.id!]);
    db.run("INSERT INTO part_fts(rowid, raw, norm) VALUES(?, 'mu', 'mu')", [row.id!]);
    if (counted) {
      db.run("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = ?", [CARDS_REV_KEY]);
    }
  }

  /** The index finds each word in exactly the rows whose text holds it. */
  function indexAgrees(ctx: { db: SqliteDb; store: Store }, words: string[]): void {
    for (const word of words) {
      const found = ctx.store
        .ftsSearch({ strong: [word], weak: [], limit: 1_000 })
        .map((hit) => hit.partId)
        .sort();
      const held = ctx.db
        .all("SELECT part_id, raw, norm FROM part_text")
        .filter((row) => `${String(row.raw)} ${String(row.norm)}`.split(/\s+/).includes(word))
        .map((row) => String(row.part_id))
        .sort();
      expect(found, word).toEqual(held);
    }
    checkIndex(ctx.db);
  }

  it.each([
    { name: "its text", change: (row: PartTextRow) => ({ ...row, raw: "lambda", norm: "lambda" }) },
    { name: "only its pointer", change: (row: PartTextRow) => ({ ...row, nextMessageId: "m-x" }) },
  ])(
    "a replace that changes $name, over a row an older build rewrote after it was read, keeps the index on the rows",
    async ({ change }) => {
      const words = ["delta", "mu", "lambda", "alpha"];
      for (const counted of [true, false]) {
        const ctx = await seeded();
        const next = ctx.rows.map((row) => (row.partId === "q3" ? change(row) : row));
        const stored = preRead(ctx.store, "s1");
        olderWrite(ctx.db, counted);
        const result = ctx.store.replaceSessionParts("s1", next, ctx.card, { stored });
        if (counted) {
          // The moved counter shows the write: the rows are refused, and the
          // same write against the rows stored now is accepted.
          expect(result).toEqual({ changed: false, refused: "base-changed" });
          expect(ctx.store.replaceSessionParts("s1", next, ctx.card)).toEqual({ changed: true });
        } else {
          // Nothing shows it: the write goes ahead, and the index entry of
          // the row it overwrites follows the text the row held.
          expect(result).toEqual({ changed: true });
        }
        expect(rowsOf(ctx.db, "s1").map((row) => (row as Row).raw)).toEqual(
          next.map((row) => row.raw),
        );
        indexAgrees(ctx, words);
        // The rows match what was written, so writing them again changes
        // nothing.
        expect(
          ctx.store.replaceSessionParts("s1", next, ctx.card, {
            stored: preRead(ctx.store, "s1"),
          }),
        ).toEqual({ changed: false });
        ctx.db.close();
      }
    },
  );

  it.each([
    { name: "an index entry's removal", statement: /VALUES\('delete'/ },
    { name: "a row's deletion", statement: /^DELETE FROM part_text WHERE id=\?/ },
    { name: "a row's overwrite", statement: /^UPDATE part_text SET message_id=/ },
    { name: "a row's insertion", statement: /^INSERT INTO part_text\(/ },
    { name: "an index entry's insertion", statement: /^INSERT INTO part_fts\(rowid,/ },
    { name: "the card's write", statement: /^INSERT INTO card\(/ },
  ])("a diffed replace rolls back whole when $name fails", async ({ statement }) => {
    for (const readFirst of [false, true]) {
      const db = await openSqlite(freshDbPath());
      if (!db) throw new Error("openSqlite returned null");
      let failing = false;
      let failed = 0;
      const store = openV1Store({
        ...db,
        run(sql, params) {
          if (failing && statement.test(sql)) {
            failed++;
            throw new Error("injected failure");
          }
          return db.run(sql, params);
        },
      });
      if (!store) throw new Error("openStore returned null");
      const rows = WORDS.slice(0, 6).map((word, i) => makePart(`q${i}`, word));
      const card = makeCard("s1", { distillState: "full", partCount: rows.length });
      store.replaceSessionParts("s1", rows, card, { rangeHashes: [rangeHash(0)] });
      const next = [
        ...rows.slice(1, 3),
        { ...rows[3]!, raw: "lambda" },
        ...rows.slice(4),
        makePart("q9", "omega"),
      ];
      const before = state(db, store);
      const stored = readFirst ? preRead(store, "s1") : undefined;

      failing = true;
      expect(() =>
        store.replaceSessionParts("s1", next, card, {
          rangeHashes: [rangeHash(500)],
          replaceRangeHashes: true,
          ...(stored && { stored }),
        }),
      ).toThrow("injected failure");
      failing = false;
      expect(failed).toBe(1);
      expect(state(db, store)).toEqual(before);
      checkIndex(db);
      expect(store.replaceSessionParts("s1", next, card, stored && { stored })).toEqual({
        changed: true,
      });
      checkIndex(db);
      db.close();
    }
  });

  /** A fresh store whose connection lists, while recording, every statement
   *  it reads with, and every row it writes ({@link recordRowMutations}). */
  async function readingStore() {
    const raw = await openSqlite(freshDbPath());
    if (!raw) throw new Error("openSqlite returned null");
    const reads: string[] = [];
    let on = false;
    const recorded = recordRowMutations({
      ...raw,
      all: (sql, params) => {
        if (on) reads.push(sql);
        return raw.all(sql, params);
      },
      get: (sql, params) => {
        if (on) reads.push(sql);
        return raw.get(sql, params);
      },
    });
    const store = openV1Store(recorded.db);
    if (!store) throw new Error("openStore returned null");
    const record = (value: boolean) => {
      on = value;
      if (value) reads.length = 0;
      recorded.record(value);
    };
    return { db: raw, store, reads, mutations: recorded.mutations, record };
  }

  /** The card an append's `recompute` builds in these tests: the surviving
   *  rows' part ids and next pointers, in order, stand in for its content. */
  const appendedCard = (sid: string, all: PartTextRow[]): Card =>
    makeCard(sid, {
      distillState: "full",
      partCount: all.length,
      retainedChars: all.reduce((sum, row) => sum + row.raw.length, 0),
      inventory: all.map((row) => `${row.partId}>${row.nextMessageId}`).join(" "),
    });

  /** Rows of `messages` in order, one to three each, each pointing at its
   *  neighbouring messages; the newest's rows point at no next message, or
   *  now and then at another one. */
  const messageRows = (rand: () => number, messages: string[], before: string | null) =>
    messages.flatMap((messageId, m) =>
      Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ({
        ...newRow(rand),
        messageId,
        prevMessageId: m > 0 ? messages[m - 1]! : before,
        nextMessageId: m + 1 < messages.length ? messages[m + 1]! : rand() < 0.7 ? null : "m-other",
      })),
    );

  const IDS_READ = "SELECT id FROM part_text WHERE session_id=? ORDER BY id";
  const EVICTED_READ = "SELECT id, raw, norm FROM part_text WHERE session_id=? ORDER BY id LIMIT ?";

  it("appends over rows read before the write store what appends over the rows read inside it store, reading only the evicted rows' text", async () => {
    const inTx = await recordedStore();
    const prepared = await readingStore();
    const tally = { evicted: 0, skipped: 0, repointed: 0 };
    for (let c = 0; c < 40; c++) {
      const rand = mulberry32(9_000 + c);
      const sid = `a${c}`;
      const old = Array.from({ length: 3 + Math.floor(rand() * 10) }, (_, i) => `${sid}-m${i}`);
      const added = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, i) => `${sid}-n${i}`);
      const storedRows = messageRows(rand, old, null);
      const rows = messageRows(rand, added, old.at(-1)!);
      for (const { store } of [inTx, prepared]) {
        store.replaceSessionParts(sid, storedRows, appendedCard(sid, storedRows));
      }
      const boundary = { checkpointMessageId: old.at(-1)!, firstNewMessageId: added[0]! };
      // Room for every row, for some stored rows less, or for fewer than the
      // new rows alone.
      const total = storedRows.length + rows.length;
      const cap = pick(rand, [
        0,
        total + 2,
        total - 1 - Math.floor(rand() * storedRows.length),
        Math.max(1, rows.length - 1),
      ]);
      const where = `case ${c}, cap ${cap}`;
      const seen: PartTextRow[][] = [];
      const recompute = (all: PartTextRow[]) => {
        seen.push(all);
        return appendedCard(sid, all);
      };

      const result = inTx.store.appendSessionParts(sid, rows, cap, boundary, recompute);
      const stored = preRead(prepared.store, sid);
      const layout = appendedRows(stored.rows, rows, cap, boundary);
      prepared.record(true);
      expect(
        prepared.store.appendSessionParts(sid, rows, cap, boundary, recompute, { stored }),
        where,
      ).toEqual(result);
      prepared.record(false);

      expect(seen[1], where).toEqual(seen[0]);
      expect(seen[1], where).toEqual(layout.rows);
      expect(rowsOf(prepared.db, sid), where).toEqual(rowsOf(inTx.db, sid));
      expect(prepared.store.getCard(sid), where).toEqual({
        ...inTx.store.getCard(sid),
        writeRev: prepared.store.getCard(sid)?.writeRev,
      });
      expect(ftsView(prepared.store), where).toEqual(ftsView(inTx.store));
      checkIndex(prepared.db);
      // The slim index is read for the session's rowids and, when the cap
      // evicts rows, for those rows' indexed text, and for nothing else.
      expect(
        [...new Set(prepared.reads.filter((sql) => /\bpart_text\b/.test(sql)))],
        where,
      ).toEqual(layout.evict > 0 ? [IDS_READ, EVICTED_READ] : [IDS_READ]);
      if (layout.evict > 0) tally.evicted++;
      if (layout.inserted.length < rows.length) tally.skipped++;
      if (layout.repointed.length > 0) tally.repointed++;
    }
    // Appends that evict stored rows, skip new ones and repoint the
    // checkpoint's rows all ran.
    expect(tally.evicted).toBeGreaterThan(0);
    expect(tally.skipped).toBeGreaterThan(0);
    expect(tally.repointed).toBeGreaterThan(0);
    inTx.db.close();
    prepared.db.close();
  });

  it.each<{
    name: string;
    race?: (ctx: Awaited<ReturnType<typeof seeded>>) => void;
    read?: (stored: StoredRows) => StoredRows;
  }>([
    {
      name: "a stamped write moved the card's revision",
      race: ({ store }) => store.writeSummary("s1", "Summary.", "h1"),
    },
    {
      name: "another replace changed the rows, keeping their number",
      race: ({ store, rows, card }) =>
        store.replaceSessionParts(
          "s1",
          rows.map((row) => ({ ...row, raw: `${row.raw} kappa` })),
          card,
        ),
    },
    { name: "the session was deleted", race: ({ store }) => store.deleteSession("s1") },
    {
      name: "the session holds another number of rows",
      read: (stored) => ({ ...stored, rows: stored.rows.slice(1) }),
    },
  ])("an append refuses rows read before $name, writing nothing", async (o) => {
    const ctx = await seeded();
    const stored = (o.read ?? ((rows: StoredRows) => rows))(preRead(ctx.store, "s1"));
    o.race?.(ctx);
    const before = state(ctx.db, ctx.store);
    let recomputed = 0;
    const append = (extra?: { stored: StoredRows }) =>
      ctx.store.appendSessionParts(
        "s1",
        [makePart("q9", "omega", { messageId: "m-9", prevMessageId: "m-5" })],
        6,
        { checkpointMessageId: "m-5", firstNewMessageId: "m-9" },
        (all) => {
          recomputed++;
          return appendedCard("s1", all);
        },
        { rangeHashes: [rangeHash(500)], replaceRangeHashes: true, ...extra },
      );

    ctx.recorded.record(true);
    expect(append({ stored })).toEqual({ changed: false, refused: "base-changed" });
    ctx.recorded.record(false);
    expect(recomputed).toBe(0);
    expect(ctx.recorded.mutations).toEqual([]);
    expect(state(ctx.db, ctx.store)).toEqual(before);

    // The same append over the rows stored now is accepted.
    expect(append()).toEqual({ changed: true });
    expect(recomputed).toBe(1);
    checkIndex(ctx.db);
    ctx.db.close();
  });

  it.each([
    { name: "an index entry's removal", statement: /VALUES\('delete'/ },
    { name: "a row's deletion", statement: /^DELETE FROM part_text WHERE id=\?/ },
    { name: "a row's insertion", statement: /^INSERT INTO part_text\(/ },
    { name: "an index entry's insertion", statement: /^INSERT INTO part_fts\(rowid,/ },
    {
      name: "a row's repointing",
      statement: /^UPDATE part_text SET next_message_id=\? WHERE id=\?/,
    },
    { name: "the card's write", statement: /^INSERT INTO card\(/ },
  ])(
    "an append over rows read before it rolls back whole when $name fails",
    async ({ statement }) => {
      const db = await openSqlite(freshDbPath());
      if (!db) throw new Error("openSqlite returned null");
      let failing = false;
      let failed = 0;
      const store = openV1Store({
        ...db,
        run(sql, params) {
          if (failing && statement.test(sql)) {
            failed++;
            throw new Error("injected failure");
          }
          return db.run(sql, params);
        },
      });
      if (!store) throw new Error("openStore returned null");
      const rows = WORDS.slice(0, 6).map((word, i) =>
        makePart(`q${i}`, word, { messageId: `m-${i}` }),
      );
      store.replaceSessionParts("s1", rows, appendedCard("s1", rows), {
        rangeHashes: [rangeHash(0)],
      });
      const before = state(db, store);
      const stored = preRead(store, "s1");
      const append = () =>
        store.appendSessionParts(
          "s1",
          [makePart("q9", "omega", { messageId: "m-9", prevMessageId: "m-5" })],
          6,
          { checkpointMessageId: "m-5", firstNewMessageId: "m-9" },
          (all) => appendedCard("s1", all),
          { stored, rangeHashes: [rangeHash(500)], replaceRangeHashes: true },
        );

      failing = true;
      expect(append).toThrow("injected failure");
      failing = false;
      expect(failed).toBe(1);
      expect(state(db, store)).toEqual(before);
      checkIndex(db);
      expect(append()).toEqual({ changed: true });
      checkIndex(db);
      db.close();
    },
  );

  // ── Which rows a diff keeps, overwrites and rewrites ──

  /** A row as {@link rowsOf} reads it. */
  const asStored = (row: PartTextRow) => ({
    part_id: row.partId,
    message_id: row.messageId,
    prev_message_id: row.prevMessageId,
    next_message_id: row.nextMessageId,
    class: row.class,
    time_created: row.timeCreated,
    raw: row.raw,
    norm: row.norm,
  });

  /** The rows of s1 each diff below starts from: parts a to d, in order,
   *  one word each. */
  const [A, B, C, D] = ["a", "b", "c", "d"].map((part, i) =>
    makePart(part, WORDS[i]!, {
      messageId: `m-${part}`,
      prevMessageId: i > 0 ? `m-${"abcd"[i - 1]}` : null,
    }),
  ) as [PartTextRow, PartTextRow, PartTextRow, PartTextRow];
  const X = makePart("x", "omega");
  const Y = makePart("y", "sigma");

  it.each<{
    name: string;
    next: PartTextRow[];
    updated?: string[];
    text?: string[];
    removed?: string[];
    added?: string[];
  }>([
    {
      name: "changes a row's next pointer",
      next: [A, { ...B, nextMessageId: "m-c" }, C, D],
      updated: ["b"],
    },
    {
      name: "clears a row's previous pointer",
      next: [A, B, { ...C, prevMessageId: null }, D],
      updated: ["c"],
    },
    {
      name: "changes a row's normalized text only",
      next: [A, { ...B, norm: "beta zeta" }, C, D],
      text: ["b"],
    },
    {
      name: "inserts a row before rows that stay",
      next: [A, B, X, C, D],
      removed: ["c", "d"],
      added: ["x", "c", "d"],
    },
    { name: "moves a row to the end", next: [A, C, D, B], removed: ["b"], added: ["b"] },
    {
      name: "moves a row to the front",
      next: [D, A, B, C],
      removed: ["a", "b", "c"],
      added: ["a", "b", "c"],
    },
    {
      name: "replaces a part after a row whose text changes",
      next: [{ ...A, raw: "alpha kappa" }, Y, C, D],
      text: ["a"],
      removed: ["b", "c", "d"],
      added: ["y", "c", "d"],
    },
  ])(
    "a replace that $name overwrites the rows it matches in place and rewrites every row from the first it cannot match",
    async ({ next, ...expected }) => {
      for (const readFirst of [false, true]) {
        const ctx = await recordedStore();
        const card = makeCard("s1", { distillState: "full", partCount: 4 });
        ctx.store.replaceSessionParts("s1", [A, B, C, D], card);
        const before = rowsByPart(ctx.db, "s1");
        const stored = readFirst ? { stored: preRead(ctx.store, "s1") } : undefined;
        ctx.recorded.record(true);
        expect(ctx.store.replaceSessionParts("s1", next, card, stored)).toEqual({ changed: true });
        ctx.recorded.record(false);
        const after = rowsByPart(ctx.db, "s1");
        const where = readFirst ? "rows read before" : "rows read inside";
        expect(statementsOf(ctx.recorded.mutations, before, after), where).toEqual(
          diffStatements(expected),
        );
        expect(rowsOf(ctx.db, "s1"), where).toEqual(next.map(asStored));
        // A row written again, or new, is inserted after every row the
        // write keeps; every other row keeps its rowid.
        const newest = Math.max(
          ...[...before]
            .filter(([part]) => !expected.removed?.includes(part))
            .map(([, row]) => Number(row.id)),
        );
        for (const [part, row] of after) {
          if (expected.added?.includes(part)) {
            expect(Number(row.id), `${where}: ${part}`).toBeGreaterThan(newest);
          } else {
            expect(row.id, `${where}: ${part}`).toBe(before.get(part)?.id);
          }
        }
        checkIndex(ctx.db);
        ctx.db.close();
      }
    },
  );

  // ── Rows read from a card with no revision ──

  /** s1 as {@link seeded} stores it, with the card carrying no revision, as
   *  a build that stamps none leaves it. */
  async function unstamped() {
    const ctx = await seeded();
    ctx.db.run("UPDATE card SET write_rev = NULL WHERE session_id = 's1'");
    return ctx;
  }

  /** The one-row append {@link seeded}'s s1 takes: its checkpoint is m-5
   *  and its cap of six rows evicts the oldest. */
  const appendOne = (
    ctx: Awaited<ReturnType<typeof seeded>>,
    opts: { stored: StoredRows; rangeHashes?: RangeHash[]; replaceRangeHashes?: boolean },
    gen?: number,
  ) =>
    ctx.store.appendSessionParts(
      "s1",
      [makePart("q9", "omega", { messageId: "m-9", prevMessageId: "m-5" })],
      6,
      { checkpointMessageId: "m-5", firstNewMessageId: "m-9" },
      (all) => ({
        ...appendedCard("s1", all),
        ...(gen !== undefined && { projectorGen: gen }),
      }),
      opts,
    );

  it.each(["replace", "append"] as const)(
    "a %s takes rows read from a card no stamped write has touched, and refuses them once one has",
    async (kind) => {
      const write = (ctx: Awaited<ReturnType<typeof seeded>>, stored: StoredRows) =>
        kind === "replace"
          ? ctx.store.replaceSessionParts("s1", ctx.next, ctx.card, { stored })
          : appendOne(ctx, { stored });

      const taken = await unstamped();
      const stored = preRead(taken.store, "s1");
      expect(stored.writeRev).toBeNull();
      expect(write(taken, stored)).toEqual({ changed: true });
      const word = kind === "replace" ? "lambda" : "omega";
      expect(sessions(taken.store.ftsSearch({ strong: [word], weak: [] }))).toEqual(["s1"]);
      expect(taken.store.ftsSearch({ strong: ["alpha"], weak: [] })).toEqual([]);
      checkIndex(taken.db);
      taken.db.close();

      const refused = await unstamped();
      const early = preRead(refused.store, "s1");
      refused.store.writeSummary("s1", "Summary.", "h1");
      const before = state(refused.db, refused.store);
      expect(write(refused, early)).toEqual({ changed: false, refused: "base-changed" });
      expect(state(refused.db, refused.store)).toEqual(before);
      refused.db.close();
    },
  );

  it.each(["replace", "append"] as const)(
    "a %s over rows read before it is refused below the stored generation, writing nothing",
    async (kind) => {
      const ctx = await seeded();
      ctx.store.replaceSessionParts("s1", ctx.rows, { ...ctx.card, projectorGen: 2 });
      const stored = preRead(ctx.store, "s1");
      const before = state(ctx.db, ctx.store);
      const hashes = { rangeHashes: [rangeHash(500)], replaceRangeHashes: true };
      // The append evicts the oldest row and inserts its own before its card
      // reaches the generation check.
      const result =
        kind === "replace"
          ? ctx.store.replaceSessionParts(
              "s1",
              ctx.next,
              { ...ctx.card, projectorGen: 1 },
              { stored, ...hashes },
            )
          : appendOne(ctx, { stored, ...hashes }, 1);
      expect(result).toEqual({ changed: false, refused: "older-generation" });
      expect(state(ctx.db, ctx.store)).toEqual(before);
      expect(ctx.store.getCard("s1")?.projectorGen).toBe(2);
      checkIndex(ctx.db);
      ctx.db.close();
    },
  );

  // ── The layout an append leaves ──

  /** Stored rows: m-1's, then two of the checkpoint message m-2, one
   *  pointing at no next message and one at another message already. */
  const O1 = makePart("o1", "alpha", { messageId: "m-1", nextMessageId: "m-2" });
  const O2 = makePart("o2", "beta", { messageId: "m-2", prevMessageId: "m-1" });
  const O3 = makePart("o3", "gamma", {
    messageId: "m-2",
    prevMessageId: "m-1",
    nextMessageId: "m-x",
  });
  const N1 = makePart("n1", "delta", { messageId: "m-3", prevMessageId: "m-2" });
  const N2 = makePart("n2", "epsilon", { messageId: "m-3", prevMessageId: "m-2" });
  /** An appended row of the checkpoint message itself. */
  const N0 = makePart("n0", "zeta", { messageId: "m-2", prevMessageId: "m-1" });
  const toFirst = (row: PartTextRow): PartTextRow => ({ ...row, nextMessageId: "m-3" });

  it.each<{ name: string; rows: PartTextRow[]; cap: number; layout: AppendLayout }>([
    {
      name: "no row cap",
      rows: [N1, N2],
      cap: 0,
      layout: { evict: 0, repointed: [1], inserted: [N1, N2], rows: [O1, toFirst(O2), O3, N1, N2] },
    },
    {
      name: "a cap the rows fill exactly",
      rows: [N1, N2],
      cap: 5,
      layout: { evict: 0, repointed: [1], inserted: [N1, N2], rows: [O1, toFirst(O2), O3, N1, N2] },
    },
    {
      name: "a cap that evicts the oldest stored row",
      rows: [N1, N2],
      cap: 4,
      layout: { evict: 1, repointed: [1], inserted: [N1, N2], rows: [toFirst(O2), O3, N1, N2] },
    },
    {
      name: "a cap only the appended rows fit",
      rows: [N1, N2],
      cap: 2,
      layout: { evict: 3, repointed: [], inserted: [N1, N2], rows: [N1, N2] },
    },
    {
      name: "a cap below the appended rows",
      rows: [N1, N2],
      cap: 1,
      layout: { evict: 3, repointed: [], inserted: [N2], rows: [N2] },
    },
    {
      // As the append over rows read inside its transaction repoints every
      // row of the checkpoint message after inserting.
      name: "an appended row of the checkpoint message",
      rows: [N0, N1],
      cap: 0,
      layout: {
        evict: 0,
        repointed: [1],
        inserted: [toFirst(N0), N1],
        rows: [O1, toFirst(O2), O3, toFirst(N0), N1],
      },
    },
  ])(
    "appendedRows lays out an append under $name, leaving its inputs as they were",
    ({ rows, cap, layout }) => {
      const stored = [O1, O2, O3];
      const copies = structuredClone({ stored, rows });
      expect(
        appendedRows(stored, rows, cap, { checkpointMessageId: "m-2", firstNewMessageId: "m-3" }),
      ).toEqual(layout);
      // The distiller lays the rows out before the write and the store again
      // from the same rows.
      expect({ stored, rows }).toEqual(copies);
    },
  );
});

describe("append suppression", () => {
  /** A session whose stored checkpoint row (`m-p2`) already points at `next`. */
  async function seeded(next: string | null) {
    const ctx = await fresh();
    const card = makeCard("s1", {
      distillState: "full",
      distilledThrough: "m-p2",
      partCount: 2,
      distillCursor: "cursor-1",
    });
    ctx.store.replaceSessionParts(
      "s1",
      [makePart("p1", "alpha"), makePart("p2", "beta", { nextMessageId: next })],
      card,
    );
    return { ...ctx, card };
  }
  const boundary = { checkpointMessageId: "m-p2", firstNewMessageId: "m-p3" };

  it("writes only the checkpoint and range hashes when nothing is added, evicted or repointed and the card matches", async () => {
    const { db, store, card } = await seeded("m-p3");
    embed(store, "s1");
    const before = store.getCard("s1")!;
    const moved = counterMoves(store, () =>
      store.appendSessionParts("s1", [], 0, boundary, () => ({ ...card, distillCursor: "c-2" }), {
        rangeHashes: [rangeHash(0)],
      }),
    );
    expect(moved).toMatchObject({ result: { changed: false }, rev: 0, stamped: 0 });
    expect(store.getCard("s1")).toEqual({ ...before, distillCursor: "c-2" });
    expect(store.getRangeHashes("s1")).toEqual([rangeHash(0)]);
    db.close();
  });

  it.each([
    { name: "adds a row", rows: [makePart("p3", "gamma")], cap: 0, next: "m-p3" },
    { name: "evicts a row under the cap", rows: [], cap: 1, next: "m-p3" },
    { name: "repoints the checkpoint row", rows: [], cap: 0, next: null },
  ])(
    "rewrites with a revision when it $name, even though the card matches",
    async ({ rows, cap, next }) => {
      const { db, store, card } = await seeded(next);
      const moved = counterMoves(store, () =>
        store.appendSessionParts("s1", rows, cap, boundary, () => card),
      );
      expect(moved).toMatchObject({ result: { changed: true }, rev: 1, stamped: 1 });
      db.close();
    },
  );

  it.each([
    { name: "adds, evicts and repoints nothing", rows: [], cap: 0, next: "m-p3", rev: 0 },
    { name: "adds a row", rows: [makePart("p3", "gamma")], cap: 0, next: "m-p3", rev: 1 },
    { name: "evicts a row under the cap", rows: [], cap: 1, next: "m-p3", rev: 1 },
    { name: "repoints the checkpoint row", rows: [], cap: 0, next: null, rev: 1 },
  ])(
    "over rows read before it, allocates a revision only for a row it changes, when it $name",
    async ({ rows, cap, next, rev }) => {
      const { db, store, card } = await seeded(next);
      embed(store, "s1");
      const before = store.getCard("s1")!;
      const stored = {
        writeRev: store.cardWriteRev("s1") ?? null,
        unstamped: unstampedOf(store),
        rows: store.sessionRows("s1", 0, 100),
      };
      const moved = counterMoves(store, () =>
        store.appendSessionParts(
          "s1",
          rows,
          cap,
          boundary,
          () => ({ ...card, distillCursor: "c-2" }),
          { stored, rangeHashes: [rangeHash(0)] },
        ),
      );
      expect(moved).toMatchObject({ result: { changed: rev > 0 }, rev, stamped: rev });
      expect(store.getRangeHashes("s1")).toEqual([rangeHash(0)]);
      if (rev === 0) {
        // Only the checkpoint is stored; the card keeps its revision and vector.
        expect(store.getCard("s1")).toEqual({ ...before, distillCursor: "c-2" });
      } else {
        expect(store.getCard("s1")?.writeRev).toBe(store.cardStats().cardsRev);
      }
      if (next === null) {
        expect(store.sessionRows("s1", 0, 10).map((row) => row.nextMessageId)).toEqual([
          null,
          "m-p3",
        ]);
      }
      db.close();
    },
  );
});

describe("metadata and owned-column writes", () => {
  const meta = { title: "T", directory: "/d", projectId: "prj", timeUpdated: 1000 };

  /** A stamped card matching {@link meta}, archived and carrying a vector. */
  async function seeded() {
    const ctx = await fresh();
    ctx.store.replaceSessionParts(
      "s1",
      [],
      makeCard("s1", { ...meta, timeArchived: 7000, distillCursor: "old" }),
    );
    embed(ctx.store, "s1");
    return { ...ctx, before: ctx.store.getCard("s1")! };
  }

  it("refreshCardMeta writes nothing for an unknown session", async () => {
    const { db, store } = await fresh();
    const moved = counterMoves(store, () => store.refreshCardMeta("ghost", meta, "c"));
    expect(moved).toMatchObject({ result: { changed: false }, rev: 0 });
    expect(store.getCard("ghost")).toBeUndefined();
    db.close();
  });

  it("refreshCardMeta stores only the checkpoint when nothing differs, leaving an omitted archive time", async () => {
    const { db, store, before } = await seeded();
    const moved = counterMoves(store, () => store.refreshCardMeta("s1", meta, "new"));
    expect(moved).toMatchObject({ result: { changed: false }, rev: 0 });
    expect(store.getCard("s1")).toEqual({ ...before, distillCursor: "new" });
    db.close();
  });

  it.each<{ name: string; change: Partial<Card> }>([
    { name: "project", change: { projectId: "prj-2" } },
    { name: "recency", change: { timeUpdated: 2000 } },
    { name: "archive time", change: { timeArchived: 8000 } },
  ])(
    "refreshCardMeta writes a changed $name with a revision and keeps the vector",
    async ({ change }) => {
      const { db, store, before } = await seeded();
      const moved = counterMoves(store, () =>
        store.refreshCardMeta("s1", { ...meta, ...change }, "new"),
      );
      expect(moved).toMatchObject({ result: { changed: true }, rev: 1, stamped: 1 });
      expect(store.getCard("s1")).toEqual({
        ...before,
        ...change,
        distillCursor: "new",
        writeRev: 2,
      });
      db.close();
    },
  );

  it.each<{ name: string; change: Partial<Card> }>([
    { name: "title", change: { title: "T2" } },
    { name: "directory", change: { directory: "/d2" } },
  ])("refreshCardMeta drops the vector when the embedded $name changes", async ({ change }) => {
    const { db, store, before } = await seeded();
    expect(store.refreshCardMeta("s1", { ...meta, ...change }, "new")).toEqual({ changed: true });
    expect(store.getCard("s1")).toEqual({
      ...before,
      ...change,
      embedding: null,
      embeddingGen: null,
      distillCursor: "new",
      writeRev: 2,
    });
    db.close();
  });

  it("setFamilyRollup rewrites only the rollup, with a revision, keeping the vector", async () => {
    const { db, store, before } = await seeded();
    const rollup = [{ sessionId: "c1", messageId: "m1", snippet: "child" }];
    const moved = counterMoves(store, () => store.setFamilyRollup("s1", rollup));
    expect(moved).toMatchObject({ result: { changed: true }, rev: 1, stamped: 1 });
    expect(store.getCard("s1")).toEqual({ ...before, familyRollup: rollup, writeRev: 2 });
    expect(store.setFamilyRollup("ghost", rollup)).toEqual({ changed: false });
    expect(store.getCard("ghost")).toBeUndefined();
    db.close();
  });

  it("writeSummary stamps a changed summary or hash and drops the vector, and skips an unchanged one", async () => {
    const { db, store } = await seeded();
    expect(store.writeSummary("s1", "Summary.", "h1")).toEqual({ changed: true });
    expect(store.getCard("s1")).toMatchObject({ nlSummary: "Summary.", embedding: null });

    // The hash alone differing is still a change.
    embed(store, "s1");
    expect(store.writeSummary("s1", "Summary.", "h2")).toEqual({ changed: true });
    expect(store.getCard("s1")?.embedding).toBeNull();

    embed(store, "s1");
    const moved = counterMoves(store, () => store.writeSummary("s1", "Summary.", "h2"));
    expect(moved).toMatchObject({ result: { changed: false }, rev: 0 });
    expect(store.getCard("s1")?.embedding).toEqual(VECTOR);

    expect(counterMoves(store, () => store.writeSummary("ghost", "S", "h"))).toMatchObject({
      result: { changed: false },
      rev: 0,
    });
    db.close();
  });
});

describe("archive time patches", () => {
  it("patchCardMeta writes the archive time with a revision only when it changes, and null clears it", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [], makeCard("s1", { title: "T" }));
    embed(store, "s1");
    const steps: Array<{
      name: string;
      patch: { title?: string; timeArchived?: number | null };
      changed: boolean;
      archived: number | undefined;
    }> = [
      { name: "archive", patch: { timeArchived: 5000 }, changed: true, archived: 5000 },
      { name: "same archive time", patch: { timeArchived: 5000 }, changed: false, archived: 5000 },
      { name: "archive time left out", patch: { title: "T" }, changed: false, archived: 5000 },
      { name: "archived again", patch: { timeArchived: 6000 }, changed: true, archived: 6000 },
      { name: "unarchive", patch: { timeArchived: null }, changed: true, archived: undefined },
      {
        name: "unarchive again",
        patch: { timeArchived: null },
        changed: false,
        archived: undefined,
      },
    ];
    for (const step of steps) {
      const moved = counterMoves(store, () => store.patchCardMeta("s1", step.patch));
      expect(moved.result.changed, step.name).toBe(step.changed);
      expect(moved.rev, step.name).toBe(step.changed ? 1 : 0);
      const card = store.getCard("s1");
      expect(card?.timeArchived, step.name).toBe(step.archived);
      if (step.changed) expect(card?.writeRev, step.name).toBe(store.cardStats().cardsRev);
      // The archive time is not part of the embedded text.
      expect(card?.embedding, step.name).toEqual(VECTOR);
    }
    db.close();
  });
});

describe("tail writes", () => {
  /** The settled base of a card distilled against a running tail: messages
   *  m-1 and m-2, one slim-index row each. */
  const base: SettledBase = {
    seq: 2,
    messageId: "m-2",
    rows: 2,
    partCount: 2,
    summaryHead: "alpha",
    outcomeHead: "beta",
    files: ["src/a.ts"],
    tools: ["bash"],
    errors: [],
    cut: 0,
  };
  const baseRows = [
    makePart("p1", "alpha", { messageId: "m-1", nextMessageId: "m-2" }),
    makePart("p2", "beta", { messageId: "m-2", prevMessageId: "m-1", nextMessageId: "m-3" }),
  ];
  /** A row of the tail, whose message follows the base's newest one. */
  const tailRow = (partId: string, raw: string, messageId = "m-3"): PartTextRow =>
    makePart(partId, raw, { messageId, prevMessageId: "m-2" });
  /** The store the running test seeded: a tail carries the card's revision
   *  as it reads now, as a caller that just read the card's rows would. */
  let current: Store | undefined;
  const tail = (over: Partial<SessionTail> = {}): SessionTail => ({
    base,
    evict: 0,
    rows: [tailRow("p3", "gammaold")],
    firstMessageId: "m-3",
    writeRev: current?.cardWriteRev("s1") ?? null,
    unstamped: current ? unstampedOf(current) : 0,
    ...over,
  });
  const found = (store: Store, word: string): string[] =>
    sessions(store.ftsSearch({ strong: [word], weak: [] }));

  /** s1 as a full write over its running tail stores it, with one range hash. */
  async function seeded() {
    const ctx = await recordedStore();
    current = ctx.store;
    const card = makeCard("s1", {
      distillState: "full",
      distilledThrough: "m-3",
      partCount: 3,
      distillCursor: "c-1",
      projectorGen: 2,
      settledBase: base,
    });
    ctx.store.replaceSessionParts("s1", [...baseRows, tailRow("p3", "gammaold")], card, {
      rangeHashes: [rangeHash(0)],
    });
    const rows = () =>
      ctx.db.all(
        "SELECT part_id, message_id, prev_message_id, next_message_id, raw FROM part_text WHERE session_id = ? ORDER BY id",
        ["s1"],
      );
    return { ...ctx, card, rows };
  }

  it("replaces the rows past the base, keeps the base's, and stores the card with one revision", async () => {
    const { db, store, card, rows } = await seeded();
    const next = [tailRow("p3", "gammanew"), tailRow("p4", "delta")];
    const moved = counterMoves(store, () =>
      store.replaceSessionTail("s1", tail({ rows: next }), {
        ...card,
        partCount: 4,
        distillCursor: "c-2",
      }),
    );
    expect(moved).toMatchObject({ result: { changed: true }, rev: 1, stamped: 1 });
    expect(store.getCard("s1")).toMatchObject({
      partCount: 4,
      distillCursor: "c-2",
      settledBase: base,
      writeRev: store.cardStats().cardsRev,
    });
    expect(rows().map((row) => row.part_id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(found(store, "alpha")).toEqual(["s1"]);
    expect(found(store, "gammanew")).toEqual(["s1"]);
    expect(found(store, "gammaold")).toEqual([]);
    db.close();
  });

  it.each<{ name: string; next: PartTextRow[]; rows: string[]; fts: string[] }>([
    {
      name: "a row added",
      next: [tailRow("p3", "gammaold"), tailRow("p4", "delta")],
      rows: ["p4"],
      fts: ["p4"],
    },
    {
      name: "a row's text changed",
      next: [tailRow("p3", "gammanew")],
      rows: ["p3"],
      fts: ["p3"],
    },
    {
      name: "a row's pointer changed",
      next: [{ ...tailRow("p3", "gammaold"), nextMessageId: "m-4" }],
      rows: ["p3"],
      fts: [],
    },
  ])("writes only the tail rows that differ, with $name", async ({ next, rows, fts }) => {
    const { db, store, card, recorded } = await seeded();
    const before = rowsByPart(db, "s1");
    recorded.record(true);
    expect(
      store.replaceSessionTail("s1", tail({ rows: next }), { ...card, partCount: 2 + next.length }),
    ).toEqual({ changed: true });
    recorded.record(false);
    const after = rowsByPart(db, "s1");
    expect(touchedParts(recorded.mutations, "part_text", before, after)).toEqual(rows);
    expect(touchedParts(recorded.mutations, "part_fts", before, after)).toEqual(fts);
    expect(changedParts(before, after)).toEqual(rows);
    db.close();
  });

  it.each<{ name: string; next: PartTextRow[]; removed: string[]; added: string[] }>([
    {
      name: "a row removed from its middle",
      next: [tailRow("p3", "gamma"), tailRow("p5", "epsilon")],
      removed: ["p4"],
      added: [],
    },
    {
      name: "a row added before rows that stay",
      next: [
        tailRow("p3", "gamma"),
        tailRow("p6", "zeta"),
        tailRow("p4", "delta"),
        tailRow("p5", "epsilon"),
      ],
      removed: ["p4", "p5"],
      added: ["p6", "p4", "p5"],
    },
  ])(
    "diffs a previous tail of several rows with $name, rewriting every row from the first it cannot match",
    async ({ next, removed, added }) => {
      const ctx = await recordedStore();
      current = ctx.store;
      const card = makeCard("s1", {
        distillState: "full",
        distilledThrough: "m-3",
        partCount: 5,
        projectorGen: 2,
        settledBase: base,
      });
      const old = [tailRow("p3", "gamma"), tailRow("p4", "delta"), tailRow("p5", "epsilon")];
      ctx.store.replaceSessionParts("s1", [...baseRows, ...old], card);
      const before = rowsByPart(ctx.db, "s1");
      ctx.recorded.record(true);
      expect(
        ctx.store.replaceSessionTail("s1", tail({ rows: next }), {
          ...card,
          partCount: 2 + next.length,
        }),
      ).toEqual({ changed: true });
      ctx.recorded.record(false);
      const after = rowsByPart(ctx.db, "s1");
      // No statement touches the base's rows or the tail rows before the change.
      expect(statementsOf(ctx.recorded.mutations, before, after)).toEqual(
        diffStatements({ removed, added }),
      );
      expect(
        ctx.db
          .all("SELECT part_id FROM part_text WHERE session_id = 's1' ORDER BY id")
          .map((row) => row.part_id),
      ).toEqual(["p1", "p2", ...next.map((row) => row.partId)]);
      for (const [part, row] of after) {
        if (!added.includes(part)) expect(row.id, part).toBe(before.get(part)?.id);
      }
      ctx.db.run("INSERT INTO part_fts(part_fts, rank) VALUES('integrity-check', 1)");
      expect(found(ctx.store, "beta")).toEqual(["s1"]);
      ctx.db.close();
    },
  );

  it.each<{ name: string; first: string | null; next: PartTextRow[] }>([
    { name: "a new first message", first: "m-5", next: [tailRow("p5", "epsilon", "m-5")] },
    { name: "none when the tail has no message", first: null, next: [] },
  ])("points the base's newest message at $name, leaving older ones", async ({ first, next }) => {
    const { db, store, card, rows } = await seeded();
    expect(
      store.replaceSessionTail("s1", tail({ rows: next, firstMessageId: first }), {
        ...card,
        partCount: 2 + next.length,
      }),
    ).toEqual({ changed: true });
    expect(rows().map((row) => [row.message_id, row.next_message_id])).toEqual([
      ["m-1", "m-2"],
      ["m-2", first],
      ...next.map((row) => [row.messageId, null]),
    ]);
    db.close();
  });

  it("evicts the base's oldest rows, from the index too", async () => {
    const { db, store, card, rows } = await seeded();
    const next = [tailRow("p3", "gammaold"), tailRow("p4", "delta")];
    expect(
      store.replaceSessionTail("s1", tail({ evict: 1, rows: next }), { ...card, partCount: 3 }),
    ).toEqual({ changed: true });
    expect(rows().map((row) => row.part_id)).toEqual(["p2", "p3", "p4"]);
    expect(found(store, "alpha")).toEqual([]);
    expect(found(store, "beta")).toEqual(["s1"]);
    db.close();
  });

  it("writes only the checkpoint, generation and settled base when no row and nothing a reader sees changed", async () => {
    const { db, store, card } = await seeded();
    embed(store, "s1");
    const before = store.getCard("s1");
    const later: SettledBase = { ...base, seq: 3 };
    const moved = counterMoves(store, () =>
      store.replaceSessionTail(
        "s1",
        tail(),
        { ...card, distillCursor: "c-2", projectorGen: 3, settledBase: later },
        { rangeHashes: [rangeHash(500)] },
      ),
    );
    expect(moved).toMatchObject({ result: { changed: false }, rev: 0, stamped: 0 });
    expect(store.getCard("s1")).toEqual({
      ...before,
      distillCursor: "c-2",
      projectorGen: 3,
      settledBase: later,
    });
    expect(store.getRangeHashes("s1")).toEqual([rangeHash(0), rangeHash(500)]);
    db.close();
  });

  it.each<{ name: string; tail: Partial<SessionTail>; card?: Partial<Card> }>([
    { name: "replaces a tail row", tail: { rows: [tailRow("p3", "gammanew")] } },
    { name: "evicts a base row", tail: { evict: 1 } },
    { name: "repoints the base's newest message", tail: { firstMessageId: "m-9" } },
    { name: "changes the card", tail: {}, card: { title: "Renamed" } },
  ])("rewrites with a revision when the write $name", async ({ tail: over, card: change }) => {
    const { db, store, card } = await seeded();
    const moved = counterMoves(store, () =>
      store.replaceSessionTail("s1", tail(over), { ...card, ...change }),
    );
    expect(moved).toMatchObject({ result: { changed: true }, rev: 1, stamped: 1 });
    expect(store.getCard("s1")?.writeRev).toBe(store.cardStats().cardsRev);
    db.close();
  });

  it("matches the stored base whatever order the caller's fields come in", async () => {
    const { db, store, card } = await seeded();
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as SettledBase;
    expect(store.replaceSessionTail("s1", tail({ base: reordered, rows: [] }), card)).toEqual({
      changed: true,
    });
    db.close();
  });

  /** The seeded card with its settled base replaced (or dropped), as another
   *  write over the same rows would store it. */
  function rewriteBase(store: Store, card: Card, next: SettledBase | undefined): void {
    const rewritten: Card = { ...card };
    if (next) rewritten.settledBase = next;
    else delete rewritten.settledBase;
    store.replaceSessionParts("s1", [...baseRows, tailRow("p3", "gammaold")], rewritten);
  }

  it.each<{
    name: string;
    setup?: (store: Store, card: Card) => void;
    tail?: Partial<SessionTail>;
  }>([
    {
      name: "the card holds another base",
      setup: (store, card) => rewriteBase(store, card, { ...base, seq: 3 }),
    },
    {
      name: "the card holds no base",
      setup: (store, card) => rewriteBase(store, card, undefined),
    },
    { name: "the session has no card", setup: (store) => void store.deleteSession("s1") },
    {
      name: "the card holds fewer rows than its base",
      setup: (store, card) => rewriteBase(store, card, { ...base, rows: 4 }),
      tail: { base: { ...base, rows: 4 } },
    },
    { name: "the eviction is negative", tail: { evict: -1 } },
    { name: "the eviction passes the base", tail: { evict: 3 } },
    { name: "the eviction is not a whole row count", tail: { evict: 0.5 } },
    { name: "the card was written since its rows were read", tail: { writeRev: 0 } },
    // The caller read one revision fewer that no write stamped than the
    // store holds now: an older build wrote since, moving cards_rev alone.
    { name: "an older build wrote since its rows were read", tail: { unstamped: -1 } },
  ])("refuses as base-changed and writes nothing when $name", async ({ setup, tail: over }) => {
    const { db, store, card, rows } = await seeded();
    setup?.(store, card);
    const before = store.getCard("s1");
    const storedRows = rows();
    const hashes = store.getRangeHashes("s1");
    const moved = counterMoves(store, () =>
      store.replaceSessionTail(
        "s1",
        tail({ rows: [tailRow("p4", "refusedword")], ...over }),
        { ...card, partCount: 3 },
        { rangeHashes: [rangeHash(500)], replaceRangeHashes: true },
      ),
    );
    expect(moved).toMatchObject({
      result: { changed: false, refused: "base-changed" },
      rev: 0,
      stamped: 0,
    });
    expect(store.getCard("s1")).toEqual(before);
    expect(rows()).toEqual(storedRows);
    expect(store.getRangeHashes("s1")).toEqual(hashes);
    expect(found(store, "refusedword")).toEqual([]);
    db.close();
  });

  it("refuses a tail whose card is below the stored generation, writing nothing", async () => {
    const { db, store, card, rows } = await seeded();
    const before = store.getCard("s1");
    const storedRows = rows();
    const moved = counterMoves(store, () =>
      store.replaceSessionTail(
        "s1",
        tail({ evict: 1, rows: [tailRow("p4", "rolledback", "m-4")], firstMessageId: "m-4" }),
        { ...card, partCount: 2, projectorGen: 1 },
        { rangeHashes: [rangeHash(500)], replaceRangeHashes: true },
      ),
    );
    expect(moved).toMatchObject({
      result: { changed: false, refused: "older-generation" },
      rev: 0,
      stamped: 0,
    });
    expect(store.getCard("s1")).toEqual(before);
    expect(rows()).toEqual(storedRows);
    expect(found(store, "alpha")).toEqual(["s1"]);
    expect(found(store, "rolledback")).toEqual([]);
    expect(store.getRangeHashes("s1")).toEqual([rangeHash(0)]);
    db.close();
  });

  it("keeps the stored generation unless the recomputed card names one", async () => {
    const { db, store, card } = await seeded();
    const unstamped: Card = { ...card };
    delete unstamped.projectorGen;
    store.replaceSessionTail("s1", tail({ rows: [tailRow("p3", "gammanew")] }), unstamped);
    expect(store.getCard("s1")?.projectorGen).toBe(2);
    store.replaceSessionTail("s1", tail({ rows: [tailRow("p3", "gammanewer")] }), {
      ...card,
      projectorGen: 3,
    });
    expect(store.getCard("s1")?.projectorGen).toBe(3);
    db.close();
  });

  it("stores range hashes with the write, replacing the session's only when asked", async () => {
    const { db, store, card } = await seeded();
    store.replaceSessionTail("s1", tail({ rows: [tailRow("p3", "gammanew")] }), card, {
      rangeHashes: [rangeHash(500)],
    });
    expect(store.getRangeHashes("s1")).toEqual([rangeHash(0), rangeHash(500)]);
    store.replaceSessionTail("s1", tail({ rows: [tailRow("p3", "gammanewer")] }), card, {
      rangeHashes: [rangeHash(500, "trimmed")],
      replaceRangeHashes: true,
    });
    expect(store.getRangeHashes("s1")).toEqual([rangeHash(500, "trimmed")]);
    db.close();
  });

  it("keeps the repair reason, as an append does", async () => {
    const { db, store, card } = await seeded();
    store.markRepairPending("s1", "malformed");
    expect(
      store.replaceSessionTail("s1", tail({ rows: [tailRow("p3", "gammanew")] }), card),
    ).toEqual({ changed: true });
    expect(store.getCard("s1")?.repairReason).toBe("malformed");
    db.close();
  });
});

describe("settled base", () => {
  const base: SettledBase = {
    seq: 4,
    messageId: "m-p2",
    rows: 2,
    partCount: 2,
    summaryHead: "alpha",
    outcomeHead: "",
    files: [],
    tools: [],
    errors: ["boom"],
    cut: 1,
  };

  it("is written with every replace, suppressed or not, and never makes one change", async () => {
    const { db, store } = await fresh();
    const rows = [makePart("p1", "alpha"), makePart("p2", "beta")];
    const card = makeCard("s1", { distillState: "full", distillCursor: "c-1", settledBase: base });
    store.replaceSessionParts("s1", rows, card);
    expect(store.getCard("s1")?.settledBase).toEqual(base);

    const later: SettledBase = { ...base, seq: 5, rows: 1 };
    let moved = counterMoves(store, () =>
      store.replaceSessionParts("s1", rows, { ...card, distillCursor: "c-2", settledBase: later }),
    );
    expect(moved).toMatchObject({ result: { changed: false }, rev: 0 });
    expect(store.getCard("s1")).toMatchObject({ distillCursor: "c-2", settledBase: later });

    // A card written against a settled tail carries no base: the stored one goes.
    const settled: Card = { ...card, distillCursor: "c-3" };
    delete settled.settledBase;
    moved = counterMoves(store, () => store.replaceSessionParts("s1", rows, settled));
    expect(moved).toMatchObject({ result: { changed: false }, rev: 0 });
    expect(store.getCard("s1")?.settledBase).toBeUndefined();

    moved = counterMoves(store, () =>
      store.replaceSessionParts("s1", rows, { ...card, title: "Renamed" }),
    );
    expect(moved).toMatchObject({ result: { changed: true }, rev: 1 });
    expect(store.getCard("s1")?.settledBase).toEqual(base);
    db.close();
  });

  it("is written by an append, suppressed or not", async () => {
    const { db, store } = await fresh();
    const card = makeCard("s1", {
      distillState: "full",
      distilledThrough: "m-p2",
      distillCursor: "c-1",
    });
    store.replaceSessionParts(
      "s1",
      [makePart("p1", "alpha"), makePart("p2", "beta", { nextMessageId: "m-p3" })],
      card,
    );
    const boundary = { checkpointMessageId: "m-p2", firstNewMessageId: "m-p3" };
    let moved = counterMoves(store, () =>
      store.appendSessionParts("s1", [], 0, boundary, () => ({ ...card, settledBase: base })),
    );
    expect(moved).toMatchObject({ result: { changed: false }, rev: 0 });
    expect(store.getCard("s1")?.settledBase).toEqual(base);

    const later: SettledBase = { ...base, seq: 5 };
    moved = counterMoves(store, () =>
      store.appendSessionParts("s1", [makePart("p3", "gamma")], 0, boundary, (all) => ({
        ...card,
        partCount: all.length,
        settledBase: later,
      })),
    );
    expect(moved).toMatchObject({ result: { changed: true }, rev: 1 });
    expect(store.getCard("s1")?.settledBase).toEqual(later);
    db.close();
  });

  it("is dropped by refreshCardMeta with the checkpoint it belongs to, and kept by patchCardMeta", async () => {
    const { db, store } = await fresh();
    const meta = { title: "T", directory: "/d", projectId: "prj", timeUpdated: 1000 };
    const card = makeCard("s1", { ...meta, distillCursor: "c-1", settledBase: base });
    store.replaceSessionParts("s1", [], card);
    expect(store.patchCardMeta("s1", { title: "T2" })).toEqual({ changed: true });
    expect(store.getCard("s1")?.settledBase).toEqual(base);

    // Nothing differs: only the checkpoint is written, and the base goes.
    expect(store.refreshCardMeta("s1", { ...meta, title: "T2" }, "c-2")).toEqual({
      changed: false,
    });
    expect(store.getCard("s1")?.distillCursor).toBe("c-2");
    expect(store.getCard("s1")?.settledBase).toBeUndefined();

    // Something differs: the same.
    store.replaceSessionParts("s1", [], card);
    expect(store.getCard("s1")?.settledBase).toEqual(base);
    expect(store.refreshCardMeta("s1", { ...meta, timeUpdated: 2000 }, "c-3")).toEqual({
      changed: true,
    });
    expect(store.getCard("s1")?.settledBase).toBeUndefined();
    db.close();
  });

  it("reads a stored value that is not a whole base as none", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [], makeCard("s1", { settledBase: base }));
    const withoutCut: Record<string, unknown> = { ...base };
    delete withoutCut.cut;
    for (const stored of [
      "not json",
      "[]",
      "null",
      JSON.stringify(withoutCut),
      JSON.stringify({ ...base, seq: null }),
      JSON.stringify({ ...base, messageId: 3 }),
      JSON.stringify({ ...base, rows: -1 }),
      JSON.stringify({ ...base, cut: 1.5 }),
      JSON.stringify({ ...base, files: [1] }),
      JSON.stringify({ ...base, summaryHead: null }),
    ]) {
      db.run("UPDATE card SET settled_base = ? WHERE session_id = ?", [stored, "s1"]);
      expect(store.getCard("s1")?.settledBase, stored).toBeUndefined();
    }
    // A base with no message of its own is whole.
    const empty: SettledBase = { ...base, messageId: null, rows: 0 };
    db.run("UPDATE card SET settled_base = ? WHERE session_id = ?", [JSON.stringify(empty), "s1"]);
    expect(store.getCard("s1")?.settledBase).toEqual(empty);
    db.close();
  });
});

describe("repair reasons", () => {
  it("records a reason without a revision, reporting whether it changed", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [], makeCard("s1"));
    const moved = counterMoves(store, () => store.markRepairPending("s1", "malformed"));
    expect(moved).toMatchObject({ result: { changed: true }, rev: 0, stamped: 0 });
    expect(store.getCard("s1")?.repairReason).toBe("malformed");
    expect(store.markRepairPending("s1", "malformed")).toEqual({ changed: false });
    expect(store.markRepairPending("s1", "missing")).toEqual({ changed: true });
    expect(store.getCard("s1")?.repairReason).toBe("missing");
    expect(store.markRepairPending("ghost", "malformed")).toEqual({ changed: false });
    expect(store.cardStats().repairPending).toBe(1);
    db.close();
  });

  it.each<{ name: string; card: Partial<Card> }>([
    { name: "a suppressed", card: {} },
    { name: "a changing", card: { title: "Rebuilt" } },
    { name: "a higher-generation", card: { projectorGen: 3 } },
  ])("clears the reason on $name replace", async ({ card }) => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [], makeCard("s1", { projectorGen: 2 }));
    store.markRepairPending("s1", "malformed");
    expect(
      store.replaceSessionParts("s1", [], makeCard("s1", { projectorGen: 2, ...card })),
    ).not.toHaveProperty("refused");
    expect(store.getCard("s1")?.repairReason).toBeUndefined();
    db.close();
  });

  it("keeps the reason through an append, which does not rebuild the card", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [makePart("p1", "alpha")], makeCard("s1"));
    store.markRepairPending("s1", "malformed");
    store.appendSessionParts(
      "s1",
      [makePart("p2", "beta")],
      0,
      { checkpointMessageId: "m-p1", firstNewMessageId: "m-p2" },
      (all) => makeCard("s1", { partCount: all.length }),
    );
    expect(store.getCard("s1")).toMatchObject({ partCount: 2, repairReason: "malformed" });
    db.close();
  });

  it("clearRepairReasons clears every reason and counts them", async () => {
    const { db, store } = await fresh();
    for (const id of ["s1", "s2", "s3"]) store.replaceSessionParts(id, [], makeCard(id));
    store.markRepairPending("s1", "malformed");
    store.markRepairPending("s2", "missing");
    expect(store.clearRepairReasons()).toBe(2);
    expect(store.allCards().map((c) => c.repairReason)).toEqual([undefined, undefined, undefined]);
    expect(store.cardStats().repairPending).toBe(0);
    expect(store.clearRepairReasons()).toBe(0);
    db.close();
  });
});

describe("staleCards", () => {
  it("returns nothing when no generation is given", async () => {
    const { db, store } = await fresh();
    store.upsertCard(makeCard("no-gen"));
    store.upsertCard(makeCard("v1-cursor", { projectorGen: 1, distillCursor: '{"v":1}' }));
    expect(store.staleCards()).toEqual([]);
    db.close();
  });

  it("lists cards below the generation or with a v1 checkpoint, newest first, leaving out repair-pending ones", async () => {
    const { db, store } = await fresh();
    const cards = [
      makeCard("no-gen", { timeUpdated: 7000 }),
      makeCard("below", { projectorGen: 1, timeUpdated: 6000 }),
      makeCard("current", { projectorGen: 2, timeUpdated: 5000, distillCursor: '{"v":2}' }),
      makeCard("above", { projectorGen: 3, timeUpdated: 4000 }),
      makeCard("v1-cursor", { projectorGen: 2, timeUpdated: 3000, distillCursor: '{"v":1}' }),
      makeCard("v1-above", { projectorGen: 3, timeUpdated: 2000, distillCursor: '{"v":1}' }),
      makeCard("pending", { projectorGen: 1, timeUpdated: 9000 }),
    ];
    for (const card of cards) store.upsertCard(card);
    store.markRepairPending("pending", "malformed");
    expect(store.staleCards(2)).toEqual([
      { sessionId: "no-gen", timeUpdated: 7000 },
      { sessionId: "below", timeUpdated: 6000 },
      { sessionId: "v1-cursor", timeUpdated: 3000 },
      { sessionId: "v1-above", timeUpdated: 2000 },
    ]);
    db.close();
  });

  it("reads a malformed checkpoint as not v1 instead of throwing", async () => {
    const { db, store } = await fresh();
    store.upsertCard(makeCard("garbled", { projectorGen: 2, distillCursor: "{not json" }));
    store.upsertCard(makeCard("scalar", { projectorGen: 2, distillCursor: "1" }));
    expect(store.staleCards(2)).toEqual([]);
    expect(
      store
        .staleCards(3)
        .map((c) => c.sessionId)
        .sort(),
    ).toEqual(["garbled", "scalar"]);
    db.close();
  });
});

describe("projector generation guard", () => {
  it("refuses a replace below the stored generation and writes nothing", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts(
      "s1",
      [makePart("p1", "newer_marker")],
      makeCard("s1", { projectorGen: 2, title: "Newer" }),
      { rangeHashes: [rangeHash(0, "kept")] },
    );
    store.markRepairPending("s1", "malformed");
    const before = store.getCard("s1");
    const moved = counterMoves(store, () =>
      store.replaceSessionParts(
        "s1",
        [makePart("p2", "older_marker")],
        makeCard("s1", { projectorGen: 1, title: "Older" }),
        { rangeHashes: [rangeHash(0, "older")] },
      ),
    );
    expect(moved).toMatchObject({
      result: { changed: false, refused: "older-generation" },
      rev: 0,
      stamped: 0,
    });
    expect(store.getCard("s1")).toEqual(before);
    expect(sessions(store.ftsSearch({ strong: ["newer_marker"], weak: [] }))).toEqual(["s1"]);
    expect(store.ftsSearch({ strong: ["older_marker"], weak: [] })).toEqual([]);
    expect(store.getRangeHashes("s1")).toEqual([rangeHash(0, "kept")]);
    db.close();
  });

  it("accepts a replace at or above the stored generation, or one naming none", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [], makeCard("s1", { projectorGen: 2 }));
    const same = makeCard("s1", { projectorGen: 2, title: "Same" });
    expect(store.replaceSessionParts("s1", [], same)).toEqual({ changed: true });
    const higher = makeCard("s1", { projectorGen: 3, title: "Higher" });
    expect(store.replaceSessionParts("s1", [], higher)).toEqual({ changed: true });
    expect(store.getCard("s1")?.projectorGen).toBe(3);
    const none = makeCard("s1", { title: "None" });
    expect(store.replaceSessionParts("s1", [], none)).toEqual({ changed: true });
    db.close();
  });

  it("keeps the stored generation through an append unless its card names one", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [makePart("p1", "alpha")], makeCard("s1", { projectorGen: 2 }));
    store.appendSessionParts(
      "s1",
      [makePart("p2", "beta")],
      0,
      { checkpointMessageId: "m-p1", firstNewMessageId: "m-p2" },
      (all) => makeCard("s1", { partCount: all.length }),
    );
    expect(store.getCard("s1")?.projectorGen).toBe(2);
    store.appendSessionParts(
      "s1",
      [makePart("p3", "gamma")],
      0,
      { checkpointMessageId: "m-p2", firstNewMessageId: "m-p3" },
      (all) => makeCard("s1", { partCount: all.length, projectorGen: 3 }),
    );
    expect(store.getCard("s1")?.projectorGen).toBe(3);
    db.close();
  });

  it("refuses an append whose card is below the stored generation, rolling the whole append back", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [makePart("p1", "alpha")], makeCard("s1", { projectorGen: 2 }));
    const before = store.getCard("s1");
    // A cap of one row makes the append evict the stored row before the
    // generation check runs.
    const moved = counterMoves(store, () =>
      store.appendSessionParts(
        "s1",
        [makePart("p2", "rolledback_marker")],
        1,
        { checkpointMessageId: "m-p1", firstNewMessageId: "m-p2" },
        (all) => makeCard("s1", { partCount: all.length, projectorGen: 1 }),
        { rangeHashes: [rangeHash(0)] },
      ),
    );
    expect(moved).toMatchObject({
      result: { changed: false, refused: "older-generation" },
      rev: 0,
      stamped: 0,
    });
    expect(store.getCard("s1")).toEqual(before);
    expect(store.ftsSearch({ strong: ["rolledback_marker"], weak: [] })).toEqual([]);
    expect(sessions(store.ftsSearch({ strong: ["alpha"], weak: [] }))).toEqual(["s1"]);
    expect(store.getRangeHashes("s1")).toEqual([]);
    db.close();
  });
});

describe("range hashes", () => {
  it("upserts by start seq, lists ascending, and clears one session's", async () => {
    const { db, store } = await fresh();
    store.putRangeHashes("s1", [rangeHash(500), rangeHash(0)]);
    store.putRangeHashes("s2", [rangeHash(0, "other")]);
    expect(store.getRangeHashes("s1")).toEqual([rangeHash(0), rangeHash(500)]);

    const rehashed: RangeHash = {
      startSeq: 0,
      endSeq: 620,
      rowCount: 621,
      hash: "rehashed",
      sweepGen: 2,
    };
    const moved = counterMoves(store, () => store.putRangeHashes("s1", [rehashed]));
    expect(moved).toMatchObject({ rev: 0, stamped: 0 });
    expect(store.getRangeHashes("s1")).toEqual([rehashed, rangeHash(500)]);
    store.putRangeHashes("s1", []);
    expect(store.getRangeHashes("s1")).toHaveLength(2);

    expect(store.clearRangeHashes("s1")).toBe(2);
    expect(store.getRangeHashes("s1")).toEqual([]);
    expect(store.clearRangeHashes("s1")).toBe(0);
    expect(store.getRangeHashes("s2")).toEqual([rangeHash(0, "other")]);
    db.close();
  });

  it("stores a changing replace's and an append's range hashes with the write", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [makePart("p1", "alpha")], makeCard("s1"), {
      rangeHashes: [rangeHash(0)],
    });
    store.appendSessionParts(
      "s1",
      [makePart("p2", "beta")],
      0,
      { checkpointMessageId: "m-p1", firstNewMessageId: "m-p2" },
      (all) => makeCard("s1", { partCount: all.length }),
      { rangeHashes: [rangeHash(0, "regrown"), rangeHash(500)] },
    );
    expect(store.getRangeHashes("s1")).toEqual([rangeHash(0, "regrown"), rangeHash(500)]);
    db.close();
  });
});

describe("change listing and stats", () => {
  const revs = (cards: Card[]) => cards.map((c) => [c.sessionId, c.writeRev]);

  it("cardsSince lists cards stamped after a revision, oldest first, each at its latest revision", async () => {
    const { db, store } = await fresh();
    for (const id of ["s1", "s2", "s3"]) store.replaceSessionParts(id, [], makeCard(id));
    store.patchCardMeta("s1", { title: "Again" });
    store.upsertCard(makeCard("unstamped"));
    expect(revs(store.cardsSince(0, 10))).toEqual([
      ["s2", 2],
      ["s3", 3],
      ["s1", 4],
    ]);
    expect(revs(store.cardsSince(2, 10))).toEqual([
      ["s3", 3],
      ["s1", 4],
    ]);
    // Paging continues from the last card's revision.
    expect(revs(store.cardsSince(0, 2))).toEqual([
      ["s2", 2],
      ["s3", 3],
    ]);
    expect(revs(store.cardsSince(3, 2))).toEqual([["s1", 4]]);
    expect(store.cardsSince(4, 10)).toEqual([]);
    db.close();
  });

  it.each([0, -3, Number.NaN, 1.5])("cardsSince reads a limit of %s as one card", async (limit) => {
    const { db, store } = await fresh();
    for (const id of ["s1", "s2", "s3"]) store.replaceSessionParts(id, [], makeCard(id));
    expect(revs(store.cardsSince(0, limit))).toEqual([["s1", 1]]);
    db.close();
  });

  it("cardsSince returns vectors only on request", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [], makeCard("s1"));
    embed(store, "s1");
    expect(store.cardsSince(0, 1)[0]?.embedding).toBeNull();
    expect(store.cardsSince(0, 1, { withEmbeddings: true })[0]?.embedding).toEqual(VECTOR);
    db.close();
  });

  it("cardsPage lists every card in session-id order after a key, stamped or not", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s3", [], makeCard("s3"));
    store.replaceSessionParts("s1", [], makeCard("s1"));
    store.upsertCard(makeCard("s2"));
    expect(sessions(store.cardsPage(undefined, 10))).toEqual(["s1", "s2", "s3"]);
    expect(sessions(store.cardsPage(undefined, 2))).toEqual(["s1", "s2"]);
    expect(sessions(store.cardsPage("s2", 2))).toEqual(["s3"]);
    expect(store.cardsPage("s3", 10)).toEqual([]);
    db.close();
  });

  it("cardsPage never lists a card rewritten during a walk twice", async () => {
    const { db, store } = await fresh();
    for (const id of ["s1", "s2", "s3"]) store.replaceSessionParts(id, [], makeCard(id));
    const first = store.cardsPage(undefined, 2);
    store.patchCardMeta("s1", { title: "Again" });
    const rest = store.cardsPage(first.at(-1)?.sessionId, 2);
    expect([...sessions(first), ...sessions(rest)]).toEqual(["s1", "s2", "s3"]);
    db.close();
  });

  it.each([0, -3, Number.NaN, 1.5])(
    "cardsPage and cardVectorsPage read a limit of %s as one card",
    async (limit) => {
      const { db, store } = await fresh();
      for (const id of ["s1", "s2", "s3"]) store.replaceSessionParts(id, [], makeCard(id));
      expect(sessions(store.cardsPage(undefined, limit))).toEqual(["s1"]);
      expect(sessions(store.cardVectorsPage(undefined, limit))).toEqual(["s1"]);
      db.close();
    },
  );

  it("cardsPage returns vectors only on request", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [], makeCard("s1"));
    embed(store, "s1");
    expect(store.cardsPage(undefined, 1)[0]?.embedding).toBeNull();
    expect(store.cardsPage(undefined, 1, { withEmbeddings: true })[0]?.embedding).toEqual(VECTOR);
    db.close();
  });

  it("cardVectorsPage lists each card's vector and revision in id order, cards without either included", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s2", [], makeCard("s2"));
    store.replaceSessionParts("s1", [], makeCard("s1"));
    embed(store, "s1");
    store.upsertCard(makeCard("s3"));

    const rows = store.cardVectorsPage(undefined, 10);
    expect(rows).toEqual([
      { sessionId: "s1", embedding: VECTOR, embeddingGen: 4, writeRev: 2 },
      { sessionId: "s2", embedding: null, embeddingGen: null, writeRev: 1 },
      { sessionId: "s3", embedding: null, embeddingGen: null },
    ]);
    expect(rows[2]).not.toHaveProperty("writeRev");
    expect(sessions(store.cardVectorsPage("s1", 1))).toEqual(["s2"]);
    db.close();
  });

  describe("rollup reads", () => {
    const rollup = [{ sessionId: "c1", messageId: "m1", snippet: "hint" }];
    /** A root and two children, the child `c1` holding a rollup from when it
     *  was a root, and another family's child inserted between them. */
    async function family() {
      const opened = await fresh();
      const { store } = opened;
      store.upsertCard(makeCard("r", { title: "Root", familyRollup: rollup }));
      store.upsertCard(
        makeCard("c1", {
          rootId: "r",
          parentId: "r",
          title: "Child one",
          summaryHead: "head one",
          timeUpdated: 2000,
          distilledThrough: "m1",
          familyRollup: rollup,
        }),
      );
      store.upsertCard(makeCard("x", { rootId: "other", parentId: "other" }));
      store.upsertCard(makeCard("c0", { rootId: "r", parentId: "r", summaryHead: "head zero" }));
      return opened;
    }

    it("rollupFieldsPage lists every card's rollup fields in id order, the stored rollup for roots only", async () => {
      const { db, store } = await family();
      expect(store.rollupFieldsPage(undefined, 2)).toEqual([
        {
          sessionId: "c0",
          rootId: "r",
          title: "",
          summaryHead: "head zero",
          timeUpdated: 1000,
          distilledThrough: null,
          familyRollup: [],
        },
        {
          sessionId: "c1",
          rootId: "r",
          title: "Child one",
          summaryHead: "head one",
          timeUpdated: 2000,
          distilledThrough: "m1",
          familyRollup: [],
        },
      ]);
      const rest = store.rollupFieldsPage("c1", 10);
      expect(sessions(rest)).toEqual(["r", "x"]);
      expect(rest[0]?.familyRollup).toEqual(rollup);
      db.close();
    });

    it("familyPage lists one root's family, the root included, a page at a time", async () => {
      const { db, store } = await family();
      const first = store.familyPage("r", undefined, 2);
      expect(sessions(first.cards)).toEqual(["r", "c1"]);
      expect(first.cards[0]?.familyRollup).toEqual(rollup);
      expect(first.next).toBeDefined();
      const second = store.familyPage("r", first.next, 2);
      expect(sessions(second.cards)).toEqual(["c0"]);
      expect(second).not.toHaveProperty("next");
      expect(store.familyPage("none", undefined, 2)).toEqual({ cards: [] });
      db.close();
    });

    it("familyPage ends with an empty page when the last page is full", async () => {
      const { db, store } = await family();
      const first = store.familyPage("r", undefined, 3);
      expect(sessions(first.cards)).toEqual(["r", "c1", "c0"]);
      expect(store.familyPage("r", first.next, 3)).toEqual({ cards: [] });
      db.close();
    });

    it("familyPage keeps a rewritten card's place and lists one written again after a delete last", async () => {
      const { db, store } = await family();
      const first = store.familyPage("r", undefined, 1);
      store.patchCardMeta("r", { title: "Renamed" });
      store.deleteSession("c1");
      store.upsertCard(makeCard("c1", { rootId: "r", parentId: "r", title: "Back again" }));
      const rest = store.familyPage("r", first.next, 10);
      expect(sessions([...first.cards, ...rest.cards])).toEqual(["r", "c0", "c1"]);
      expect(rest.cards.at(-1)?.title).toBe("Back again");
      db.close();
    });

    it.each([0, -3, Number.NaN, 1.5])(
      "rollupFieldsPage and familyPage read a limit of %s as one card",
      async (limit) => {
        const { db, store } = await family();
        expect(sessions(store.rollupFieldsPage(undefined, limit))).toEqual(["c0"]);
        expect(sessions(store.familyPage("r", undefined, limit).cards)).toEqual(["r"]);
        db.close();
      },
    );
  });

  it("cardStats counts cards, full cards and repair-pending cards, reading unset counters as zero", async () => {
    const { db, store } = await fresh();
    expect(store.cardStats()).toEqual({
      cards: 0,
      fullCards: 0,
      repairPending: 0,
      cardsRev: 0,
      cardsStamped: 0,
      cardsDeleted: 0,
      vectorsRev: 0,
    });
    store.replaceSessionParts("s1", [], makeCard("s1", { distillState: "full" }));
    store.replaceSessionParts("s2", [], makeCard("s2"));
    store.replaceSessionParts("gone", [], makeCard("gone"));
    store.deleteSession("gone");
    store.markRepairPending("s2", "malformed");
    embed(store, "s1");
    expect(store.cardStats()).toEqual({
      cards: 2,
      fullCards: 1,
      repairPending: 1,
      cardsRev: 4,
      cardsStamped: 4,
      cardsDeleted: 1,
      vectorsRev: 1,
    });
    db.close();
  });

  it("cardCounters reads the counters cardStats reports, unset ones as zero, an older build's revisions included", async () => {
    const { db, store } = await fresh();
    const statsCounters = (): CardCounters => {
      const { cardsRev, cardsStamped, cardsDeleted, vectorsRev } = store.cardStats();
      return { cardsRev, cardsStamped, cardsDeleted, vectorsRev };
    };
    expect(store.cardCounters()).toEqual({
      cardsRev: 0,
      cardsStamped: 0,
      cardsDeleted: 0,
      vectorsRev: 0,
    });
    store.replaceSessionParts("s1", [], makeCard("s1"));
    store.replaceSessionParts("gone", [], makeCard("gone"));
    store.deleteSession("gone");
    embed(store, "s1");
    expect(store.cardCounters()).toEqual({
      cardsRev: 3,
      cardsStamped: 3,
      cardsDeleted: 1,
      vectorsRev: 1,
    });
    expect(store.cardCounters()).toEqual(statsCounters());

    // An older build bumps cards_rev alone: each of its writes widens the gap
    // to cards_stamped, and a stamped write between them leaves it as it is.
    const olderWrite = (): void =>
      store.setMeta(CARDS_REV_KEY, String(store.cardCounters().cardsRev + 1));
    olderWrite();
    store.patchCardMeta("s1", { title: "Stamped" });
    olderWrite();
    expect(store.cardCounters()).toEqual({
      cardsRev: 6,
      cardsStamped: 4,
      cardsDeleted: 1,
      vectorsRev: 1,
    });
    expect(store.cardCounters()).toEqual(statsCounters());
    db.close();
  });

  it("cardCounters reads every counter at one moment while another connection writes", async () => {
    const path = freshDbPath();
    const raw = await openSqlite(path);
    if (!raw) throw new Error("open failed");
    const watched = watchReads(raw);
    const store = openV1Store(watched.db);
    if (!store) throw new Error("openStore returned null");
    store.replaceSessionParts("s1", [], makeCard("s1"));
    store.replaceSessionParts("gone", [], makeCard("gone"));
    store.deleteSession("gone");
    embed(store, "s1");
    const other = await openSqlite(path);
    if (!other) throw new Error("second open failed");
    /** Another process moves every counter on by 10. */
    const writeElsewhere = (): void => {
      other.run("UPDATE meta SET value = CAST(value AS INTEGER) + 10 WHERE key IN (?, ?, ?, ?)", [
        CARDS_REV_KEY,
        CARDS_STAMPED_KEY,
        CARDS_DELETED_KEY,
        VECTORS_REV_KEY,
      ]);
    };
    const before = store.cardCounters();

    watched.afterNextRead(writeElsewhere);
    expect(store.cardCounters()).toEqual(before);
    const moved: CardCounters = {
      cardsRev: before.cardsRev + 10,
      cardsStamped: before.cardsStamped + 10,
      cardsDeleted: before.cardsDeleted + 10,
      vectorsRev: before.vectorsRev + 10,
    };
    expect(store.cardCounters()).toEqual(moved);

    // Two separate reads straddle the same write.
    watched.afterNextRead(writeElsewhere);
    const rev = Number(store.getMeta(CARDS_REV_KEY));
    const stamped = Number(store.getMeta(CARDS_STAMPED_KEY));
    expect([rev, stamped]).toEqual([moved.cardsRev, moved.cardsStamped + 10]);
    other.close();
    raw.close();
  });

  it.each([
    { name: "on its own", withIndex: false },
    {
      name: "with the index an earlier build creates over those cards",
      withIndex: true,
    },
  ])(
    "repairPendingCount counts the cards with a repair reason $name, however the reason is set or cleared",
    async ({ withIndex }) => {
      const { db, store } = await fresh();
      for (const id of ["s1", "s2", "s3", "s4"]) store.replaceSessionParts(id, [], makeCard(id));
      if (withIndex) {
        db.exec(
          "CREATE INDEX card_repair_pending ON card(session_id) WHERE repair_reason IS NOT NULL",
        );
      }
      const steps: Array<{ name: string; act: () => unknown; pending: number }> = [
        { name: "no reason yet", act: () => undefined, pending: 0 },
        {
          name: "two marked",
          act: () => {
            store.markRepairPending("s1", "malformed");
            store.markRepairPending("s2", "missing");
          },
          pending: 2,
        },
        {
          name: "a raw update sets one",
          act: () => db.run("UPDATE card SET repair_reason = 'lost' WHERE session_id = 's3'"),
          pending: 3,
        },
        {
          name: "a marked card marked again",
          act: () => store.markRepairPending("s1", "malformed again"),
          pending: 3,
        },
        {
          name: "a raw update clears one",
          act: () => db.run("UPDATE card SET repair_reason = NULL WHERE session_id = 's2'"),
          pending: 2,
        },
        {
          name: "a replace clears one",
          act: () => store.replaceSessionParts("s3", [], makeCard("s3", { title: "Rebuilt" })),
          pending: 1,
        },
        {
          name: "a marked card deleted",
          act: () => {
            store.markRepairPending("s4", "malformed");
            store.deleteSession("s4");
          },
          pending: 1,
        },
        { name: "every reason cleared", act: () => store.clearRepairReasons(), pending: 0 },
      ];
      for (const step of steps) {
        step.act();
        expect(store.repairPendingCount(), step.name).toBe(step.pending);
        expect(store.cardStats().repairPending, step.name).toBe(step.pending);
      }
      expect(hasRepairIndex(db)).toBe(withIndex);
      db.close();
    },
  );

  it("repairPendingCount reads the card table in bounded pages", async () => {
    const raw = await openSqlite(freshDbPath());
    if (!raw) throw new Error("open failed");
    const watched = watchReads(raw);
    const store = openV1Store(watched.db);
    if (!store) throw new Error("openStore returned null");
    const ids = Array.from({ length: REPAIR_STATE_PAGE + 3 }, (_, i) => `s${i}`);
    for (const id of ids) store.replaceSessionParts(id, [], makeCard(id));
    store.markRepairPending("s2", "malformed");
    watched.reads.length = 0;
    expect(store.repairPendingCount()).toBe(1);
    expect(watched.reads).toHaveLength(2);
    for (const { sql, params } of watched.reads) {
      expect(sql).toMatch(/ LIMIT \?$/);
      expect(params?.at(-1)).toBe(REPAIR_STATE_PAGE);
    }
    raw.close();
  });

  it("spaceStats reports the file's pages and the free pages a delete leaves", async () => {
    const { db, store } = await fresh();
    store.replaceSessionParts("s1", [makePart("p1", "lorem ".repeat(20_000))], makeCard("s1"));
    const before = store.spaceStats();
    expect(before.pageSize).toBe(db.get("PRAGMA page_size")?.page_size);
    expect(before.pageCount).toBe(db.get("PRAGMA page_count")?.page_count);
    store.deleteSession("s1");
    expect(store.spaceStats().freelistCount).toBeGreaterThan(before.freelistCount);
    db.close();
  });
});
