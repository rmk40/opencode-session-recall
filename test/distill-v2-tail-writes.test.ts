import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDistiller, type Distiller, type DistillSync } from "../src/distill.js";
import { createFetchGate } from "../src/fetch-gate.js";
import type { HistorySource } from "../src/history/source.js";
import { createV2HistorySource, openOpencodeDb } from "../src/history/v2.js";
import { V2_PROJECTOR_GEN } from "../src/history/v2-project.js";
import { createV2Sync, inspectCheckpoint, type V2SyncOptions } from "../src/history/v2-sync.js";
import { openSqlite, type ReadOnlyDb, type SqliteDb } from "../src/sqlite.js";
import { openStore, type Store } from "../src/store.js";
import type { Limits } from "../src/types.js";
import { TEST_LIMITS } from "./helpers.js";
import {
  insertMessage,
  insertPart,
  insertProject,
  insertSession,
  limitSpy,
  makeV2PartsDb,
  type V2TestDb,
} from "./v2-db.js";

/**
 * How the v2 distiller writes a session whose tail is still running, against
 * a real opencode 2.4-shaped database: which reads re-read only the tail past
 * its settled boundary and which fall back to a full read, the settled base
 * full and append writes record, the checkpoint a read whose tail moved
 * keeps, and the range hashes writes over a running tail take. No poll runs
 * unless a test starts one: each step signals the distiller itself. Every
 * history statement goes through the LIMIT spy.
 */

const PROJECT = "prj_tailw";
const DIR = "/workspace/tailw";
/** Settled rows are written at these times, outside every poll window. */
const T0 = 1_000_000;
const GEN = V2_PROJECTOR_GEN;

const noYield = async (): Promise<void> => {};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let v2db: V2TestDb;
let reader: ReadOnlyDb & { statements: string[] };
let storeDir: string;
let storeDb: SqliteDb;
let store: Store;
const distillers: Distiller[] = [];
const seqs = new Map<string, number>();
/** Strictly increasing times for rows that change while a test runs. */
let tick = 0;

beforeEach(async () => {
  seqs.clear();
  tick = 0;
  v2db = await makeV2PartsDb();
  v2db.db.exec("PRAGMA synchronous = OFF");
  insertProject(v2db.db, { id: PROJECT, worktree: DIR });
  const opened = await openOpencodeDb(v2db.path);
  if (!opened.ok) throw new Error(opened.reason);
  reader = limitSpy(opened.db);
  storeDir = mkdtempSync(join(tmpdir(), "recall-v2-tailw-"));
  const db = await openSqlite(join(storeDir, "store.db"));
  if (!db) throw new Error("no sqlite");
  storeDb = db;
  const result = openStore(db, { host: "opencode-v2", source: v2db.path });
  if (!result.ok) throw new Error(result.reason);
  store = result.store;
});

afterEach(async () => {
  await Promise.all(distillers.splice(0).map((d) => d.stop()));
  storeDb.close();
  reader.close();
  v2db.cleanup();
  rmSync(storeDir, { recursive: true, force: true });
});

// ── opencode.db writers ──────────────────────────────────────────────────────

const text = (value: string) => ({ type: "text", text: value });

function addSession(id: string): void {
  insertSession(v2db.db, {
    id,
    project_id: PROJECT,
    directory: DIR,
    title: `Title ${id}`,
    time_created: T0,
    time_updated: T0,
  });
}

function nextSeq(sessionID: string): number {
  const n = (seqs.get(sessionID) ?? 0) + 1;
  seqs.set(sessionID, n);
  return n;
}

function addUser(sessionID: string, value: string): string {
  const seq = nextSeq(sessionID);
  const id = `msg_${sessionID}_${seq}`;
  insertMessage(v2db.db, {
    id,
    session_id: sessionID,
    type: "user",
    seq,
    time_created: T0 + seq,
    data: { text: value, time: { created: T0 + seq } },
  });
  return id;
}

function replyData(at: number, completed: boolean) {
  return {
    agent: "build",
    model: { id: "m", providerID: "p" },
    content: [],
    time: completed ? { created: at, completed: at + 1 } : { created: at },
  };
}

/** An assistant row with one text part row per value. A running one has no
 *  completion time and is updated at `updated` (default: now, so it counts
 *  as running rather than abandoned). */
function addReply(
  sessionID: string,
  values: string[],
  o: { running?: boolean; updated?: number } = {},
): string {
  const seq = nextSeq(sessionID);
  const id = `msg_${sessionID}_${seq}`;
  const at = T0 + seq;
  insertMessage(v2db.db, {
    id,
    session_id: sessionID,
    type: "assistant",
    seq,
    time_created: at,
    time_updated: o.running ? (o.updated ?? Date.now()) : at,
    data: replyData(at, !o.running),
  });
  values.forEach((value, ordinal) => {
    insertPart(v2db.db, {
      message_id: id,
      session_id: sessionID,
      ordinal,
      time_created: at,
      data: text(value),
    });
  });
  return id;
}

/** Another part row on a reply, as opencode writes one: the message row is
 *  left as it was. */
function addPart(messageID: string, sessionID: string, ordinal: number, value: string): void {
  insertPart(v2db.db, {
    message_id: messageID,
    session_id: sessionID,
    ordinal,
    time_created: T0,
    time_updated: Date.now() + ++tick,
    data: text(value),
  });
}

/** Complete a running reply in place. */
function complete(messageID: string): void {
  const row = v2db.db.get("SELECT seq FROM session_message WHERE id = ?", [messageID]);
  v2db.db.run("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?", [
    JSON.stringify(replyData(T0 + Number(row?.seq), true)),
    Date.now() + ++tick,
    messageID,
  ]);
}

// ── Store helpers ────────────────────────────────────────────────────────────

const hits = (token: string): string[] =>
  store.ftsSearch({ strong: [token], weak: [] }).map((hit) => hit.sessionId);

const spansOf = (id: string): number[][] =>
  store.getRangeHashes(id).map((span) => [span.startSeq, span.endSeq]);

const storedText = (id: string): string[] =>
  storeDb
    .all("SELECT raw FROM part_text WHERE session_id = ? ORDER BY id", [id])
    .map((row) => String(row.raw));

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(2);
  }
}

// ── Distiller harness ────────────────────────────────────────────────────────

type Write = { method: string; result: unknown };

const WRITES = new Set([
  "replaceSessionParts",
  "appendSessionParts",
  "replaceSessionTail",
  "refreshCardMeta",
]);

type StartOptions = {
  limits?: Partial<Limits>;
  sync?: V2SyncOptions;
  pageMessages?: number;
  appendThresholdParts?: number;
  wrapSync?: (inner: DistillSync) => DistillSync;
  wrapSource?: (inner: HistorySource) => HistorySource;
  /** Runs before each tail write reaches the store. */
  beforeTail?: () => void;
};

type Started = {
  distiller: Distiller;
  /** Every card write, in order, with the store's verdict. */
  writes: Write[];
  /** The message ids of every page read, in order. */
  pages: string[][];
  /** Every range digest read, with the seq it read after. */
  digests: Array<{ id: string; after: number }>;
  logs: string[];
};

function start(o: StartOptions = {}): Started {
  const writes: Write[] = [];
  const pages: string[][] = [];
  const digests: Array<{ id: string; after: number }> = [];
  const logs: string[] = [];
  const base = createV2HistorySource(reader, { yieldBetween: noYield });
  const counted: HistorySource = {
    ...base,
    messagePage: async (page) => {
      const read = await base.messagePage(page);
      pages.push(read.items.map((msg) => msg.info.id));
      return read;
    },
  };
  const inner = createV2Sync(reader, {
    // No poll unless asked for: each step signals the distiller.
    pollIntervalMs: 1e9,
    sessionScanEveryMs: 1e12,
    reconcileEveryMs: 1e12,
    yieldBetween: noYield,
    ...o.sync,
  });
  const countedSync: DistillSync = {
    ...inner,
    rangeDigest: async (id, after, limit) => {
      digests.push({ id, after });
      return inner.rangeDigest!(id, after, limit);
    },
  };
  const recorded = new Proxy(store, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      if (typeof prop === "string" && WRITES.has(prop)) {
        return (...args: unknown[]) => {
          if (prop === "replaceSessionTail") o.beforeTail?.();
          const result = method.apply(target, args);
          writes.push({ method: prop, result });
          return result;
        };
      }
      return method.bind(target);
    },
  });
  const distiller = createDistiller({
    source: o.wrapSource ? o.wrapSource(counted) : counted,
    store: recorded,
    gate: createFetchGate({ concurrency: 2 }),
    limits: {
      ...TEST_LIMITS,
      coldPass: false,
      distillDelayMs: 0,
      distillConcurrency: 1,
      ...o.limits,
    },
    instanceId: `tailw-${Math.random()}`,
    sync: o.wrapSync ? o.wrapSync(countedSync) : countedSync,
    projectorGen: GEN,
    idleDebounceMs: 1,
    yieldBetween: noYield,
    log: (message) => logs.push(message),
    ...(o.pageMessages !== undefined && { pageMessages: o.pageMessages }),
    ...(o.appendThresholdParts !== undefined && { appendThresholdParts: o.appendThresholdParts }),
  });
  distillers.push(distiller);
  distiller.start();
  return { distiller, writes, pages, digests, logs };
}

/** Signal one re-distill and return the card writes it made, once `done`
 *  holds for them and nothing more follows. */
async function redistill(
  h: Started,
  sessionID: string,
  type: "turn-ended" | "removal" = "turn-ended",
  done: (writes: Write[]) => boolean = (writes) => writes.length > 0,
): Promise<Write[]> {
  const from = h.writes.length;
  h.distiller.onEvent({ type, sessionID });
  await waitFor(() => done(h.writes.slice(from)));
  await sleep(20);
  return h.writes.slice(from);
}

const methods = (writes: Write[]): string[] => writes.map((write) => write.method);

/** The range check's completed sweeps, from its log lines. */
function rangeSweeps(logs: string[]): Array<{ ranges: number; changed: number }> {
  return logs.flatMap((line) => {
    const m = /range check sweep \d+ done: (\d+) range\(s\), (\d+) changed/.exec(line);
    return m ? [{ ranges: Number(m[1]), changed: Number(m[2]) }] : [];
  });
}

// ── Tail reads ───────────────────────────────────────────────────────────────

describe("v2 tail re-reads", () => {
  it("read only the messages past the boundary and merge them with the settled base", async () => {
    addSession("ses_a");
    for (let i = 1; i <= 5; i++) addUser("ses_a", `settled${i}word`);
    addReply("ses_a", ["settledreply"]);
    const boundary = addUser("ses_a", "boundaryword");
    const reply = addReply("ses_a", ["draftword"], { running: true });
    const h = start({ pageMessages: 2 });
    expect(methods(await redistill(h, "ses_a"))).toEqual(["replaceSessionParts"]);
    expect(store.getCard("ses_a")?.settledBase).toMatchObject({ seq: 7, messageId: boundary });

    addPart(reply, "ses_a", 1, "grownword");
    const from = h.pages.length;
    expect(methods(await redistill(h, "ses_a"))).toEqual(["replaceSessionTail"]);
    // One page: the running reply, then the boundary message that ends the read.
    expect(h.pages.slice(from)).toEqual([[reply, boundary]]);
    expect(hits("grownword")).toEqual(["ses_a"]);
    expect(hits("settled1word")).toEqual(["ses_a"]);
    expect(store.getCard("ses_a")).toMatchObject({ partCount: 9, summaryHead: "settled1word" });
  });

  /** A card with a settled base through seq 2 whose running reply then grew
   *  a part. */
  async function grownTail(): Promise<Started> {
    addSession("ses_a");
    addUser("ses_a", "openingword");
    addUser("ses_a", "secondword");
    const reply = addReply("ses_a", ["draftword"], { running: true });
    const h = start();
    await redistill(h, "ses_a");
    expect(store.getCard("ses_a")?.settledBase).toMatchObject({ seq: 2 });
    addPart(reply, "ses_a", 1, "grownword");
    return h;
  }

  it.each<{ name: string; bar: () => void; signal?: "removal" }>([
    { name: "a removal signal", bar: () => {}, signal: "removal" },
    { name: "a repair reason", bar: () => void store.markRepairPending("ses_a", "malformed") },
    {
      name: "a card at another projector generation",
      bar: () =>
        storeDb.run("UPDATE card SET projector_gen = NULL WHERE session_id = ?", ["ses_a"]),
    },
    {
      // A whole base through the first message, while the checkpoint's
      // boundary is the second.
      name: "a base that belongs to another boundary",
      bar: () => {
        const base = {
          ...store.getCard("ses_a")?.settledBase,
          seq: 1,
          messageId: "msg_ses_a_1",
          rows: 1,
          partCount: 1,
        };
        storeDb.run("UPDATE card SET settled_base = ? WHERE session_id = ?", [
          JSON.stringify(base),
          "ses_a",
        ]);
        expect(store.getCard("ses_a")?.settledBase).toMatchObject({ seq: 1 });
      },
    },
  ])("read in full instead after $name", async ({ bar, signal }) => {
    const h = await grownTail();
    bar();
    expect(methods(await redistill(h, "ses_a", signal))).toEqual(["replaceSessionParts"]);
    expect(hits("grownword")).toEqual(["ses_a"]);
  });
});

// ── Falling back to a full read ──────────────────────────────────────────────

describe("v2 tail re-reads falling back to a full read", () => {
  it.each([
    { name: "the read stops at the cap", pageMessages: 1, reads: 1 },
    { name: "the read reaches the base", pageMessages: 50, reads: 3 },
  ])("when the tail alone fills the row cap ($name)", async ({ pageMessages, reads }) => {
    addSession("ses_a");
    addUser("ses_a", "firstword");
    addUser("ses_a", "secondword");
    const reply = addReply("ses_a", ["draftword"], { running: true });
    const h = start({ pageMessages, limits: { ftsRowsPerSession: 3 } });
    await redistill(h, "ses_a");
    expect(store.getCard("ses_a")?.settledBase).toMatchObject({ seq: 2, rows: 2 });

    addPart(reply, "ses_a", 1, "moreword");
    addPart(reply, "ses_a", 2, "lastword");
    const from = h.pages.length;
    expect(methods(await redistill(h, "ses_a"))).toEqual(["replaceSessionParts"]);
    // The tail read's first page holds `reads` messages and is its only
    // page; the full read follows it.
    const pages = h.pages.slice(from);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(reads);
    expect(storedText("ses_a")).toEqual(["draftword", "moreword", "lastword"]);
  });

  it.each([
    { cap: 3, method: "replaceSessionParts" },
    { cap: 10, method: "replaceSessionTail" },
  ])(
    "when a shorter tail would need rows a write evicted back, and not otherwise (cap $cap)",
    async ({ cap, method }) => {
      addSession("ses_a");
      addUser("ses_a", "firstword");
      addUser("ses_a", "secondword");
      const reply = addReply("ses_a", ["draftone", "drafttwo"], { running: true });
      const h = start({ limits: { ftsRowsPerSession: cap } });
      await redistill(h, "ses_a");
      // Under the lower cap the first message's row was evicted.
      expect(hits("firstword")).toEqual(cap === 3 ? [] : ["ses_a"]);

      v2db.db.run("DELETE FROM session_part WHERE message_id = ? AND ordinal = ?", [reply, 1]);
      expect(methods(await redistill(h, "ses_a"))).toEqual([method]);
      expect(storedText("ses_a")).toEqual(["firstword", "secondword", "draftone"]);
    },
  );

  it("when another write replaced the card's base during the tail read", async () => {
    addSession("ses_a");
    addUser("ses_a", "openingword");
    const reply = addReply("ses_a", ["draftword"], { running: true });
    let interfere = false;
    const h = start({
      beforeTail: () => {
        if (!interfere) return;
        interfere = false;
        storeDb.run("UPDATE card SET settled_base = NULL WHERE session_id = ?", ["ses_a"]);
      },
    });
    await redistill(h, "ses_a");

    addPart(reply, "ses_a", 1, "grownword");
    interfere = true;
    const writes = await redistill(h, "ses_a", "turn-ended", (w) =>
      w.some((write) => write.method === "replaceSessionParts"),
    );
    expect(writes).toEqual([
      { method: "replaceSessionTail", result: { changed: false, refused: "base-changed" } },
      { method: "replaceSessionParts", result: { changed: true } },
    ]);
    expect(hits("grownword")).toEqual(["ses_a"]);
    expect(store.getCard("ses_a")?.settledBase).toMatchObject({ seq: 1 });
  });

  it("when a row below the base runs again", async () => {
    // Against this clock a reply updated more than 5 s ago is abandoned, so
    // it counts as settled.
    let clock = T0 + 10_000;
    addSession("ses_a");
    addUser("ses_a", "openingword");
    addReply("ses_a", ["stalledword"], { running: true, updated: T0 + 2 });
    addUser("ses_a", "followword");
    addReply("ses_a", ["draftword"], { running: true, updated: T0 + 20_000 });
    const h = start({ sync: { now: () => clock, abandonAfterMs: 5_000 } });
    await redistill(h, "ses_a");
    expect(store.getCard("ses_a")?.settledBase).toMatchObject({ seq: 3 });

    // The stalled reply counts as running again: the boundary moves below
    // the base, while the rows through the base are unchanged.
    clock = T0 + 3_000;
    expect(methods(await redistill(h, "ses_a"))).toEqual(["replaceSessionParts"]);
    expect(store.getCard("ses_a")?.settledBase).toMatchObject({ seq: 1 });
  });
});

// ── Row cap ──────────────────────────────────────────────────────────────────

describe("v2 tail re-reads under the row cap", () => {
  it("evict the base's oldest rows for a longer tail, raising the floor and trimming its hashes", async () => {
    addSession("ses_a");
    addUser("ses_a", "firstword");
    addUser("ses_a", "secondword");
    const reply = addReply("ses_a", ["draftone"], { running: true });
    const h = start({ limits: { ftsRowsPerSession: 4 } });
    await redistill(h, "ses_a");
    expect(spansOf("ses_a")).toEqual([[1, 2]]);

    addPart(reply, "ses_a", 1, "drafttwo");
    addPart(reply, "ses_a", 2, "draftthree");
    expect(methods(await redistill(h, "ses_a"))).toEqual(["replaceSessionTail"]);
    expect(storedText("ses_a")).toEqual(["secondword", "draftone", "drafttwo", "draftthree"]);
    expect(hits("firstword")).toEqual([]);
    const card = store.getCard("ses_a");
    expect(inspectCheckpoint(card?.distillCursor)?.floor).toBe(2);
    expect(card?.settledBase).toMatchObject({ seq: 2, rows: 1 });
    expect(spansOf("ses_a")).toEqual([[2, 2]]);
  });
});

// ── Checkpoints and settled bases ────────────────────────────────────────────

describe("v2 writes over a running tail", () => {
  it("record the settled base with a full write, and none once the tail settles", async () => {
    addSession("ses_a");
    addUser("ses_a", "openingword");
    addReply("ses_a", ["answerword"]);
    const boundary = addUser("ses_a", "followword");
    const reply = addReply("ses_a", ["draftword"], { running: true });
    const h = start();
    await redistill(h, "ses_a");
    const card = store.getCard("ses_a");
    expect(inspectCheckpoint(card?.distillCursor)).toMatchObject({ settled: false, boundary: 3 });
    expect(card?.settledBase).toMatchObject({
      seq: 3,
      messageId: boundary,
      rows: 3,
      partCount: 3,
      summaryHead: "openingword",
      cut: 0,
    });

    complete(reply);
    expect(methods(await redistill(h, "ses_a"))).toEqual(["replaceSessionTail"]);
    const settled = store.getCard("ses_a");
    expect(inspectCheckpoint(settled?.distillCursor)).toMatchObject({ settled: true });
    expect(settled?.settledBase).toBeUndefined();
  });

  it.each([
    { name: "a new turn", turn: true, boundary: 3, rows: 3 },
    { name: "a running reply alone", turn: false, boundary: 2, rows: 2 },
  ])("record the settled base with an append of $name", async ({ turn, boundary, rows }) => {
    addSession("ses_a");
    addUser("ses_a", "openingword");
    const answer = addReply("ses_a", ["answerword"]);
    const h = start({ appendThresholdParts: 0 });
    await redistill(h, "ses_a");
    expect(store.getCard("ses_a")?.settledBase).toBeUndefined();

    const follow = turn ? addUser("ses_a", "followword") : answer;
    const reply = addReply("ses_a", ["draftword"], { running: true });
    expect(methods(await redistill(h, "ses_a"))).toEqual(["appendSessionParts"]);
    const card = store.getCard("ses_a");
    expect(inspectCheckpoint(card?.distillCursor)).toMatchObject({ settled: false, boundary });
    expect(card?.settledBase).toMatchObject({
      seq: boundary,
      messageId: follow,
      rows,
      partCount: rows,
      summaryHead: "openingword",
    });

    addPart(reply, "ses_a", 1, "grownword");
    expect(methods(await redistill(h, "ses_a"))).toEqual(["replaceSessionTail"]);
    expect(hits("grownword")).toEqual(["ses_a"]);
  });

  it("keep the unsettled checkpoint taken before a read whose tail moved, so the next read is a tail", async () => {
    addSession("ses_a");
    addUser("ses_a", "openingword");
    const reply = addReply("ses_a", ["draftword"], { running: true });
    let race: (() => void) | undefined;
    let before: string | undefined;
    const h = start({
      wrapSync: (inner) => ({
        ...inner,
        async checkpoint(sessionID) {
          const cp = await inner.checkpoint(sessionID);
          const move = race;
          if (move) {
            race = undefined;
            before = cp?.cursor;
            move();
          }
          return cp;
        },
      }),
    });
    // The reply grows between the checkpoint and the read.
    race = () => addPart(reply, "ses_a", 1, "racedword");
    expect(methods(await redistill(h, "ses_a"))).toEqual(["replaceSessionParts"]);
    expect(hits("racedword")).toEqual(["ses_a"]);
    const card = store.getCard("ses_a");
    expect(before).toBeDefined();
    expect(JSON.parse(card?.distillCursor ?? "null")).toEqual(JSON.parse(before ?? "null"));
    expect(inspectCheckpoint(card?.distillCursor)).toMatchObject({ settled: false, boundary: 1 });
    expect(card?.settledBase).toMatchObject({ seq: 1 });

    expect(methods(await redistill(h, "ses_a"))).toEqual(["replaceSessionTail"]);
  });

  it("write nothing when the lease moves during a tail read", async () => {
    addSession("ses_a");
    addUser("ses_a", "openingword");
    const reply = addReply("ses_a", ["draftword"], { running: true });
    let steal = false;
    let stolen = false;
    const h = start({
      wrapSource: (inner) => ({
        ...inner,
        messagePage: async (page) => {
          const read = await inner.messagePage(page);
          if (steal) {
            steal = false;
            stolen = true;
            store.setMeta(
              "distill_lease",
              JSON.stringify({
                holder: "rival",
                heartbeat: Date.now(),
                ttl: 30_000,
                build: "x",
                gen: 1,
              }),
            );
          }
          return read;
        },
      }),
    });
    await redistill(h, "ses_a");
    const before = store.getCard("ses_a");

    addPart(reply, "ses_a", 1, "grownword");
    steal = true;
    const from = h.writes.length;
    h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
    await waitFor(() => stolen);
    await sleep(50);
    expect(h.writes.slice(from)).toEqual([]);
    expect(store.getCard("ses_a")).toEqual(before);
    expect(hits("grownword")).toEqual([]);
    store.releaseLease("rival");
  });
});

// ── Range hashes ─────────────────────────────────────────────────────────────

describe("v2 range hashes over a running tail", () => {
  it("cover the settled rows through the boundary, then only the rows past it once the tail settles", async () => {
    addSession("ses_a");
    addUser("ses_a", "openingword");
    addReply("ses_a", ["answerword"]);
    addUser("ses_a", "followword");
    const reply = addReply("ses_a", ["draftword"], { running: true });
    const h = start();
    await redistill(h, "ses_a");
    expect(spansOf("ses_a")).toEqual([[1, 3]]);
    expect(h.digests).toEqual([{ id: "ses_a", after: -1 }]);

    // While the tail runs, its re-reads digest nothing.
    addPart(reply, "ses_a", 1, "grownword");
    expect(methods(await redistill(h, "ses_a"))).toEqual(["replaceSessionTail"]);
    expect(h.digests).toHaveLength(1);

    // The write that settles it digests only the rows past the boundary.
    complete(reply);
    expect(methods(await redistill(h, "ses_a"))).toEqual(["replaceSessionTail"]);
    expect(h.digests.slice(1)).toEqual([{ id: "ses_a", after: 3 }]);
    expect(spansOf("ses_a")).toEqual([
      [1, 3],
      [4, 4],
    ]);

    // The range check finds both spans current: the completed turn re-indexes
    // nothing.
    await h.distiller.stop();
    const checker = start({ sync: { pollIntervalMs: 5 } });
    await waitFor(() => rangeSweeps(checker.logs).length > 0);
    expect(rangeSweeps(checker.logs)[0]).toEqual({ ranges: 2, changed: 0 });
    expect(checker.logs.filter((line) => line.includes("re-indexing"))).toEqual([]);
  });
});
