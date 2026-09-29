import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite, type SqliteDb } from "../src/sqlite.js";
import {
  openStore,
  pluginBuild,
  type Card,
  type PartTextRow,
  type Store,
  type StoreIdentity,
  type StoreOptions,
  type StoreRefusal,
} from "../src/store.js";
import { openV1Store } from "./helpers.js";

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

/** Create a fresh v4 store at `path` as `identity` and seed one card so a later
 *  rebuild would be visible. */
async function buildV4Store(path: string, identity: StoreIdentity): Promise<void> {
  const db = await openSqlite(path);
  if (!db) throw new Error("open failed");
  const opened = openStore(db, identity);
  if (!opened.ok) throw new Error(`openStore refused: ${opened.reason}`);
  opened.store.replaceSessionParts("s1", [makePart("p1", "keeper_marker")], makeCard("s1"));
  db.close();
}

describe("store migration", () => {
  it("creates schema v4 on a fresh db, stamped for the v1 host with no source", async () => {
    const { db, store } = await fresh();
    expect(store.getMeta("schema_version")).toBe("4");
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
    expect(opened.store.getMeta("schema_version")).toBe("4");
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
    expect(store2.getMeta("schema_version")).toBe("4");
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
    expect(opened.store.getMeta("schema_version")).toBe("4");
    expect(opened.store.getMeta("store_host")).toBe("opencode-v2");
    expect(opened.store.getMeta("source_db")).toBe("/data/opencode.db");
    expect(db2.get("SELECT name FROM sqlite_master WHERE name='foreign_thing'")).toBeUndefined();
    db2.close();
  });

  it("chains a populated v1 store additively to v4, preserving cards/FTS/vectors/stamps", async () => {
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

    // Reopen with the current (v4) code: additive upgrade chaining
    // v1->v2->v3->v4, no rebuild.
    const db2 = await openSqlite(path);
    if (!db2) throw new Error("reopen failed");
    const store2 = openV1Store(db2);
    if (!store2) throw new Error("reopen store failed");

    expect(store2.getMeta("schema_version")).toBe("4");
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

  it("chains a populated v2 store additively to v4, preserving cards/FTS/vectors/summaries", async () => {
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

    // Reopen with the current (v4) code: additive v2->v3->v4 steps.
    const db2 = await openSqlite(path);
    if (!db2) throw new Error("reopen failed");
    const store2 = openV1Store(db2);
    if (!store2) throw new Error("reopen store failed");

    expect(store2.getMeta("schema_version")).toBe("4");
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

  it("upgrades a populated v3 store additively to v4 for the v1 host, keeping every row and stamp", async () => {
    const path = freshDbPath();
    await buildV3Store(path);

    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    const store = openV1Store(db);
    if (!store) throw new Error("reopen store failed");

    expect(store.getMeta("schema_version")).toBe("4");
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
    // turn a committed schema 4 store into an `error` refusal.
    const path = freshDbPath();
    await buildV3Store(path);
    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    const spy = instrument(db, { exec: /journal_mode=WAL/ });
    const opened = openStore(spy.db, V1);
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.warning).toContain("could not enable WAL");
    expect(opened.store.getMeta("schema_version")).toBe("4");
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
      expect(store.getMeta("schema_version")).toBe("4");
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

  it("refuses a v4 store owned by the v1 host when the v2 host opens it", async () => {
    const path = freshDbPath();
    await buildV4Store(path, V1);
    await expectRefusal(path, v2("/data/opencode.db"), "host-mismatch");
  });

  it("refuses a v4 store owned by the v2 host when the v1 host opens it", async () => {
    const path = freshDbPath();
    await buildV4Store(path, v2("/data/opencode.db"));
    await expectRefusal(path, V1, "host-mismatch");
  });

  it("refuses a v4 store whose host stamp is missing instead of guessing an owner", async () => {
    const path = freshDbPath();
    await buildV4Store(path, V1);
    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    db.run("DELETE FROM meta WHERE key='store_host'");
    db.close();
    await expectRefusal(path, V1, "host-mismatch");
  });

  it("refuses a v2-host store distilled from a different source database", async () => {
    const path = freshDbPath();
    await buildV4Store(path, v2("/data/a/opencode.db"));
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
    await buildV4Store(path, v2("/data/opencode.db"));
    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    db.run("DELETE FROM meta WHERE key='source_db'");
    db.close();
    await expectRefusal(path, v2("/data/opencode.db"), "source-mismatch");
  });

  it("opens a store whose host and source both match, keeping its data", async () => {
    const path = freshDbPath();
    await buildV4Store(path, v2("/data/opencode.db"));
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
    await buildV4Store(path, v2("/data/opencode.db"));
    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    const spy = instrument(db);
    expect(openStore(spy.db, V1)).toEqual({ ok: false, reason: "host-mismatch" });
    expect(spy.txOutcomes).toEqual(["rolled-back"]);
    db.close();
  });

  it("leaves a refused file's journal mode alone and switches an accepted one to WAL", async () => {
    const path = freshDbPath();
    await buildV4Store(path, v2("/data/opencode.db"));
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
    await buildV4Store(path, V1);
    const db = await openSqlite(path);
    if (!db) throw new Error("reopen failed");
    db.run("UPDATE meta SET value='5' WHERE key='schema_version'");
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
      await buildV4Store(path, v2("/data/opencode.db"));
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
});

describe("pluginBuild", () => {
  it("tags the schema, representation generation and host", () => {
    expect(pluginBuild("opencode-v1")).toBe("schema4.gen4.opencode-v1");
    expect(pluginBuild("opencode-v2")).toBe("schema4.gen4.opencode-v2");
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
    expect(store.acquireLease("A", ttl, "schema4.gen4.opencode-v1", 4)).toBe(true);
    expect(store.acquireLease("A", ttl, "schema4.gen4.opencode-v1", 4)).toBe(true);
    expect(store.leaseStatus()).toMatchObject({
      holder: "A",
      build: "schema4.gen4.opencode-v1",
      gen: 4,
    });

    // A second holder is refused while A's lease is fresh.
    clock = 1_000_100;
    expect(store.acquireLease("B", ttl, "schema4.gen4.opencode-v1", 4)).toBe(false);

    // A heartbeat (only the holder's own) extends the lease and preserves build/gen.
    expect(store.heartbeatLease("A")).toBe(true);
    expect(store.heartbeatLease("B")).toBe(false);
    expect(store.leaseStatus()).toMatchObject({
      holder: "A",
      build: "schema4.gen4.opencode-v1",
      gen: 4,
    });

    // Past the ORIGINAL acquire + ttl but within heartbeat + ttl: still A's.
    clock = 1_005_050;
    expect(store.acquireLease("B", ttl, "schema4.gen4.opencode-v1", 4)).toBe(false);

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
    expect(store.acquireLease("A", ttl, "schema4.gen4.opencode-v1", 4)).toBe(true);
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
