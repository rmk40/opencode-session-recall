import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite, type SqliteDb } from "../src/sqlite.js";
import { openStore, type Card, type PartTextRow, type Store } from "../src/store.js";

// These tests run against the REAL node:sqlite driver (Node >= 22.5). Under
// vitest there is no `Bun` global, so openSqlite selects node:sqlite.

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
  const store = openStore(db, now ? { now } : undefined);
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

describe("store migration", () => {
  it("creates schema v1 on a fresh db", async () => {
    const { db, store } = await fresh();
    expect(store.getMeta("schema_version")).toBe("1");
    expect(store.allCards()).toEqual([]);
    db.close();
  });

  it("drops everything and rebuilds when the on-disk version is older", async () => {
    const path = freshDbPath();
    const db1 = await openSqlite(path);
    const store1 = db1 && openStore(db1);
    if (!db1 || !store1) throw new Error("open failed");
    store1.upsertCard(makeCard("s1"));
    // Simulate an older layout: an earlier version stamp plus a foreign table.
    store1.setMeta("schema_version", "0");
    db1.exec("CREATE TABLE junk(x)");
    db1.close();

    const db2 = await openSqlite(path);
    if (!db2) throw new Error("reopen failed");
    const store2 = openStore(db2);
    if (!store2) throw new Error("reopen store failed");
    expect(store2.getMeta("schema_version")).toBe("1");
    expect(store2.allCards()).toEqual([]);
    expect(db2.get("SELECT name FROM sqlite_master WHERE name='junk'")).toBeUndefined();
    db2.close();
  });

  it("returns null when the on-disk schema is newer than the code", async () => {
    const path = freshDbPath();
    const db1 = await openSqlite(path);
    const store1 = db1 && openStore(db1);
    if (!db1 || !store1) throw new Error("open failed");
    store1.setMeta("schema_version", "999");
    db1.close();

    const db2 = await openSqlite(path);
    if (!db2) throw new Error("reopen failed");
    expect(openStore(db2)).toBeNull();
    db2.close();
  });

  it("preserves data when reopening a store already at the current version", async () => {
    const path = freshDbPath();
    const db1 = await openSqlite(path);
    const store1 = db1 && openStore(db1);
    if (!db1 || !store1) throw new Error("open failed");
    store1.replaceSessionParts(
      "s1",
      [makePart("p1", "durable_marker survives restart")],
      makeCard("s1"),
    );
    db1.close();

    // A cold process restart must NOT wipe an in-version store.
    const db2 = await openSqlite(path);
    const store2 = db2 && openStore(db2);
    if (!db2 || !store2) throw new Error("reopen failed");
    expect(store2.getCard("s1")).not.toBeUndefined();
    expect(sessions(store2.ftsSearch({ strong: ["durable_marker"], weak: [] }))).toEqual(["s1"]);
    db2.close();
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
    db.close();
  });

  it("writeCardEmbeddings stamps the model, sets blobs in one pass, and skips cards_rev", async () => {
    const { db, store } = await fresh();
    store.upsertCard(makeCard("s1"));
    store.upsertCard(makeCard("s2"));

    const vec = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    store.writeCardEmbeddings("minishlab/potion-base-8M", [{ sessionId: "s1", embedding: vec }]);

    expect(store.getMeta("semantic_model")).toBe("minishlab/potion-base-8M");
    const withEmb = store.allCards({ withEmbeddings: true });
    expect(withEmb.find((c) => c.sessionId === "s1")?.embedding).toEqual(vec);
    expect(withEmb.find((c) => c.sessionId === "s2")?.embedding).toBeNull(); // untouched
    // Vectors are invisible to the lexical layer, so no reader-reload trigger.
    expect(store.getMeta("cards_rev")).toBeUndefined();

    // An unknown session id updates nothing and does not throw.
    expect(() =>
      store.writeCardEmbeddings("minishlab/potion-base-8M", [
        { sessionId: "ghost", embedding: vec },
      ]),
    ).not.toThrow();
    expect(store.getCard("ghost")).toBeUndefined();
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

    // Fresh acquire, and idempotent re-acquire by the same holder.
    expect(store.acquireLease("A", ttl)).toBe(true);
    expect(store.acquireLease("A", ttl)).toBe(true);

    // A second holder is refused while A's lease is fresh.
    clock = 1_000_100;
    expect(store.acquireLease("B", ttl)).toBe(false);

    // A heartbeat (only the holder's own) extends the lease.
    expect(store.heartbeatLease("A")).toBe(true);
    expect(store.heartbeatLease("B")).toBe(false);

    // Past the ORIGINAL acquire + ttl but within heartbeat + ttl: still A's.
    clock = 1_005_050;
    expect(store.acquireLease("B", ttl)).toBe(false);

    // Past heartbeat + ttl: B takes over the expired lease.
    clock = 1_005_101;
    expect(store.acquireLease("B", ttl)).toBe(true);

    // A no longer holds it, so A cannot release; B can.
    expect(store.releaseLease("A")).toBe(false);
    expect(store.releaseLease("B")).toBe(true);

    // A released lease is immediately acquirable by anyone.
    clock = 1_005_102;
    expect(store.acquireLease("A", ttl)).toBe(true);
    db.close();
  });

  it("lets only one of two connections acquire the lease (changes-count, not read-check-write)", async () => {
    const path = freshDbPath();
    const dbA = await openSqlite(path);
    const storeA = dbA && openStore(dbA);
    const dbB = await openSqlite(path);
    const storeB = dbB && openStore(dbB);
    if (!dbA || !storeA || !dbB || !storeB) throw new Error("two-handle open failed");

    // Two separate connections race for the same fresh lease row.
    const a = storeA.acquireLease("A", 30_000);
    const b = storeB.acquireLease("B", 30_000);
    expect([a, b].filter(Boolean)).toHaveLength(1); // exactly one winner

    // The loser cannot then take a fresh lease while the winner's is live — the
    // conditional UPDATE's changes count refuses it, not an app-level re-check.
    const loser = a ? { store: storeB, id: "B" } : { store: storeA, id: "A" };
    expect(loser.store.acquireLease(loser.id, 30_000)).toBe(false);
    dbA.close();
    dbB.close();
  });
});
