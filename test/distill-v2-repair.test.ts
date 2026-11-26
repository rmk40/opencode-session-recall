import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDistiller,
  PROGRESS_STALE_MS,
  RECONCILE_PROGRESS_KEY,
  REPAIR_GEN_KEY,
  REPAIR_PROGRESS_KEY,
  type Distiller,
  type DistillSync,
} from "../src/distill.js";
import { isUnavailableText } from "../src/digest.js";
import { createFetchGate } from "../src/fetch-gate.js";
import type { HistorySource } from "../src/history/source.js";
import {
  changedNote,
  createV2HistorySource,
  cutNote,
  openOpencodeDb,
  type V2SourceOptions,
} from "../src/history/v2.js";
import { V2_PROJECTOR_GEN } from "../src/history/v2-project.js";
import { createV2Sync, inspectCheckpoint, type V2SyncOptions } from "../src/history/v2-sync.js";
import { openSqlite, type ReadOnlyDb, type SqliteDb } from "../src/sqlite.js";
import { openStore, type Store } from "../src/store.js";
import type { Limits } from "../src/types.js";
import { makeFakeHarness, openV1Store, TEST_LIMITS } from "./helpers.js";
import {
  insertMessage,
  insertPart,
  insertProject,
  insertSession,
  limitSpy,
  makeV2PartsDb,
  type SessionInsert,
  type V2TestDb,
} from "./v2-db.js";

/**
 * The v2 distiller's repair machinery against a real opencode 2.4-shaped
 * database: projector generations and range hashes on every write, the loss
 * guard, the repair sweep, the per-poll range check, cut messages followed
 * through their continuations, and all of it staying off without a
 * generation. Every history statement goes through the LIMIT spy.
 */

const PROJECT = "prj_repair";
const DIR = "/workspace/repair";
/** Far in the past: rows and sessions written at these times are outside
 *  every poll window, so only the cold pass, the sweep and the range check
 *  (or an explicit signal) read them, and no reply counts as still running. */
const T0 = 1_000_000;
const GEN = V2_PROJECTOR_GEN;

const noYield = async (): Promise<void> => {};

let v2db: V2TestDb;
let reader: ReadOnlyDb & { statements: string[] };
let storeDir: string;
let storeDb: SqliteDb;
let store: Store;
const distillers: Distiller[] = [];
const seqs = new Map<string, number>();

beforeEach(async () => {
  seqs.clear();
  v2db = await makeV2PartsDb();
  // A throwaway writer: no fsync per row.
  v2db.db.exec("PRAGMA synchronous = OFF");
  insertProject(v2db.db, { id: PROJECT, worktree: DIR });
  const opened = await openOpencodeDb(v2db.path);
  if (!opened.ok) throw new Error(opened.reason);
  reader = limitSpy(opened.db);
  storeDir = mkdtempSync(join(tmpdir(), "recall-v2-repair-"));
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

function addSession(id: string, extra: Partial<SessionInsert> = {}): void {
  insertSession(v2db.db, {
    id,
    project_id: PROJECT,
    directory: DIR,
    title: `Title ${id}`,
    time_created: T0,
    time_updated: T0,
    ...extra,
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

function replyData(o: { inline?: unknown[]; completed?: boolean; extra?: object }, at: number) {
  return {
    agent: "build",
    model: { id: "m", providerID: "p" },
    content: o.inline ?? [],
    time: o.completed === false ? { created: at } : { created: at, completed: at + 1 },
    ...o.extra,
  };
}

/** An assistant row with `parts` as part rows (ordinals from 0) and
 *  `inline` as its `data.content`. */
function addReply(
  sessionID: string,
  o: { parts?: unknown[]; inline?: unknown[]; completed?: boolean; extra?: object } = {},
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
    data: replyData(o, at),
  });
  (o.parts ?? []).forEach((data, ordinal) => {
    insertPart(v2db.db, { message_id: id, session_id: sessionID, ordinal, time_created: at, data });
  });
  return id;
}

/** A row that is not content (opencode's idle marker). */
function addIdle(sessionID: string): void {
  const seq = nextSeq(sessionID);
  insertMessage(v2db.db, {
    id: `msg_${sessionID}_${seq}`,
    session_id: sessionID,
    type: "idle",
    seq,
    time_created: T0 + seq,
    data: { outcome: "succeeded", time: { created: T0 + seq } },
  });
}

/** Rewrite a user row's text in place, as an edit or revert would. */
function rewriteUser(messageID: string, value: string): void {
  v2db.db.run("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?", [
    JSON.stringify({ text: value, time: { created: T0 } }),
    T0 + 50_000,
    messageID,
  ]);
}

/** Rewrite a part row's content, leaving its message row as it was. */
function rewritePart(
  messageID: string,
  ordinal: number,
  data: { type: string } & Record<string, unknown>,
): void {
  v2db.db.run(
    "UPDATE session_part SET type = ?, data = ?, time_updated = ? WHERE message_id = ? AND ordinal = ?",
    [data.type, JSON.stringify(data), T0 + 50_000, messageID, ordinal],
  );
}

// ── Store helpers ────────────────────────────────────────────────────────────

/** Make cards look as an older build left them: no projector generation and
 *  no range hashes. */
function makeStale(ids: string[]): void {
  for (const id of ids) {
    storeDb.run("UPDATE card SET projector_gen = NULL WHERE session_id = ?", [id]);
    store.clearRangeHashes(id);
  }
}

const hits = (token: string): string[] =>
  store.ftsSearch({ strong: [token], weak: [] }).map((hit) => hit.sessionId);

const staleIds = (): string[] => store.staleCards(GEN).map((card) => card.sessionId);

const spansOf = (id: string): number[][] =>
  store.getRangeHashes(id).map((span) => [span.startSeq, span.endSeq]);

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}

// ── Distiller harness ────────────────────────────────────────────────────────

type StartOptions = {
  /** Default: the v2 host's generation. `null` passes none. */
  projectorGen?: number | null;
  limits?: Partial<Limits>;
  sync?: V2SyncOptions;
  source?: V2SourceOptions;
  wrapSync?: (inner: DistillSync) => DistillSync;
  wrapSource?: (inner: HistorySource) => HistorySource;
  appendThresholdParts?: number;
  pageMessages?: number;
  onSessionDistilled?: (sessionID: string) => void;
  onColdPassDone?: () => void;
  coldPassRetryMs?: number;
  leaseRetryMs?: number;
};

type Started = {
  distiller: Distiller;
  logs: string[];
  /** Sessions whose range digest was read, one entry per read. */
  digests: string[];
  /** Sessions looked up by id (the sweep and re-distills). */
  lookups: string[];
};

function startDistiller(o: StartOptions = {}): Started {
  const logs: string[] = [];
  const digests: string[] = [];
  const lookups: string[] = [];
  const base = createV2HistorySource(reader, { yieldBetween: noYield, ...o.source });
  const counted: HistorySource = {
    ...base,
    getSession: async (id, opts) => {
      lookups.push(id);
      return base.getSession(id, opts);
    },
  };
  const source = o.wrapSource ? o.wrapSource(counted) : counted;
  const inner = createV2Sync(reader, {
    pollIntervalMs: 10,
    sessionScanEveryMs: 1e12,
    reconcileEveryMs: 1e12,
    yieldBetween: noYield,
    ...o.sync,
  });
  const countedSync: DistillSync = {
    ...inner,
    rangeDigest: async (id, after, limit) => {
      digests.push(id);
      return inner.rangeDigest!(id, after, limit);
    },
  };
  const projectorGen = o.projectorGen === undefined ? GEN : o.projectorGen;
  const distiller = createDistiller({
    source,
    store,
    gate: createFetchGate({ concurrency: 2 }),
    limits: { ...TEST_LIMITS, distillDelayMs: 0, distillConcurrency: 1, ...o.limits },
    instanceId: `repair-${Math.random()}`,
    discover: async () => {
      const listing = await source.listSessions({
        scope: "global",
        limit: 1_000,
        order: "id",
        archived: "include",
      });
      if (!listing.ok) throw new Error(listing.error);
      return listing.items;
    },
    sync: o.wrapSync ? o.wrapSync(countedSync) : countedSync,
    ...(projectorGen !== null && { projectorGen }),
    idleDebounceMs: 2,
    yieldBetween: noYield,
    log: (message) => logs.push(message),
    ...(o.appendThresholdParts !== undefined && { appendThresholdParts: o.appendThresholdParts }),
    ...(o.pageMessages !== undefined && { pageMessages: o.pageMessages }),
    ...(o.onSessionDistilled && { onSessionDistilled: o.onSessionDistilled }),
    ...(o.onColdPassDone && { onColdPassDone: o.onColdPassDone }),
    ...(o.coldPassRetryMs !== undefined && { coldPassRetryMs: o.coldPassRetryMs }),
    ...(o.leaseRetryMs !== undefined && { leaseRetryMs: o.leaseRetryMs }),
  });
  distillers.push(distiller);
  distiller.start();
  return { distiller, logs, digests, lookups };
}

async function coldPassDone(h: Started): Promise<void> {
  await waitFor(() => h.distiller.status().coldPass === "done");
}

/** Run a distiller until its cold pass and repair sweep are done, then stop
 *  it: a store built at the current generation. */
async function built(o: StartOptions = {}): Promise<void> {
  const h = startDistiller(o);
  await coldPassDone(h);
  await waitFor(() => h.distiller.repair()?.sweep?.running === false);
  await h.distiller.stop();
}

/** The range check's completed sweeps, from its log lines. */
function rangeSweeps(logs: string[]): Array<{ ranges: number; changed: number }> {
  return logs.flatMap((line) => {
    const m = /range check sweep \d+ done: (\d+) range\(s\), (\d+) changed/.exec(line);
    return m ? [{ ranges: Number(m[1]), changed: Number(m[2]) }] : [];
  });
}

/** Wait for `count` sweeps after the first `from` that checked `ranges`
 *  ranges and found nothing. */
async function cleanSweeps(h: Started, ranges: number, count = 1, from = 0): Promise<void> {
  await waitFor(
    () =>
      rangeSweeps(h.logs)
        .slice(from)
        .filter((s) => s.ranges === ranges && s.changed === 0).length >= count,
  );
}

const reindexed = (logs: string[]): string[] => logs.filter((line) => line.includes("re-indexing"));

const cardsRev = (): string | undefined => store.getMeta("cards_rev");

// ── Writes ───────────────────────────────────────────────────────────────────

describe("v2 distiller writes", () => {
  it("stamps the projector generation, the archive time and range hashes on a full write", async () => {
    addSession("ses_live");
    addUser("ses_live", "a question");
    addReply("ses_live", { parts: [text("an answer")] });
    addSession("ses_arch", { time_archived: T0 + 5 });
    addUser("ses_arch", "alphaneedle archived work");
    const h = startDistiller();
    await coldPassDone(h);

    expect(store.getCard("ses_live")).toMatchObject({ projectorGen: GEN });
    expect(store.getCard("ses_live")?.timeArchived).toBeUndefined();
    // Discovery includes archived sessions.
    expect(store.getCard("ses_arch")).toMatchObject({ projectorGen: GEN, timeArchived: T0 + 5 });
    expect(hits("alphaneedle")).toEqual(["ses_arch"]);
    expect(store.getRangeHashes("ses_live")).toEqual([
      {
        startSeq: 1,
        endSeq: 2,
        rowCount: 2,
        hash: expect.any(String),
        sweepGen: expect.any(Number),
      },
    ]);
  });

  it("extends a card by append only at the distiller's own generation", async () => {
    addSession("ses_a");
    addUser("ses_a", "first");
    addUser("ses_a", "second");
    // A host without a generation writes the card and no range hashes.
    let h = startDistiller({ projectorGen: null, appendThresholdParts: 0 });
    await coldPassDone(h);
    expect(store.getCard("ses_a")?.projectorGen).toBeUndefined();
    expect(spansOf("ses_a")).toEqual([]);
    await h.distiller.stop();

    // The cold pass is off, so only the signals below write.
    addUser("ses_a", "betaneedle third");
    h = startDistiller({ appendThresholdParts: 0, limits: { coldPass: false } });
    h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
    await waitFor(() => store.getCard("ses_a")?.projectorGen === GEN);
    // Not extended: the full write hashed the whole session.
    expect(spansOf("ses_a")).toEqual([[1, 3]]);
    expect(hits("betaneedle")).toEqual(["ses_a"]);

    // At its generation, the next change is an append, which hashes only
    // the rows it read.
    addUser("ses_a", "gammaneedle fourth");
    h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
    await waitFor(() => store.getRangeHashes("ses_a").length === 2);
    expect(spansOf("ses_a")).toEqual([
      [1, 3],
      [4, 4],
    ]);
    expect(hits("gammaneedle")).toEqual(["ses_a"]);
    // The range check walks both spans and finds them current.
    await cleanSweeps(h, 2);
    expect(reindexed(h.logs)).toEqual([]);
  });

  it("hashes the rows an append moved past even when none of them was a message", async () => {
    addSession("ses_a");
    addUser("ses_a", "first");
    addUser("ses_a", "second");
    const h = startDistiller({ appendThresholdParts: 0 });
    await cleanSweeps(h, 1);

    addIdle("ses_a");
    h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
    await waitFor(() => store.getRangeHashes("ses_a").length === 2);
    expect(spansOf("ses_a")).toEqual([
      [1, 2],
      [3, 3],
    ]);
    expect(inspectCheckpoint(store.getCard("ses_a")?.distillCursor)?.seq).toBe(3);
    const from = rangeSweeps(h.logs).length;
    await cleanSweeps(h, 2, 1, from);
    expect(reindexed(h.logs)).toEqual([]);
  });

  it("logs once that the lease is held by another build", async () => {
    expect(store.acquireLease("rival-process", 30_000, "schema4.gen5.opencode-v2", 5)).toBe(true);
    const h = startDistiller({ leaseRetryMs: 5 });
    // Several retries.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(h.distiller.status().leaseHeld).toBe(false);
    expect(
      h.logs.filter((line) =>
        line.includes("lease held by rival-process running build schema4.gen5.opencode-v2"),
      ),
    ).toHaveLength(1);
  });
});

// ── Loss guard ───────────────────────────────────────────────────────────────

describe("v2 distiller loss guard", () => {
  it("keeps a card whose re-read lost content and marks it repair-pending", async () => {
    addSession("ses_a");
    addUser("ses_a", "a question");
    const reply = addReply("ses_a", { parts: [text("deltakeep answer")] });
    const distilled: string[] = [];
    const h = startDistiller({ onSessionDistilled: (id) => distilled.push(id) });
    await coldPassDone(h);
    const rev = cardsRev();

    // opencode starts writing a part type this build does not read.
    rewritePart(reply, 0, { type: "future-part", text: "deltakeep answer, rewritten" });
    h.distiller.onEvent({ type: "removal", sessionID: "ses_a" });
    await waitFor(() => store.getCard("ses_a")?.repairReason !== undefined);

    const card = store.getCard("ses_a")!;
    expect(card.repairReason).toMatch(/^projection lost content: /);
    expect(card.repairReason).toMatch(/1 part rows of unknown types/);
    expect(card.repairReason).toMatch(/1 completed assistant messages empty despite part rows/);
    expect(hits("deltakeep")).toEqual(["ses_a"]);
    expect(cardsRev()).toBe(rev);
    expect(distilled).toEqual([]);
    expect(h.logs.some((line) => line.includes("ses_a kept its card"))).toBe(true);
  });

  it("writes a first card from a lossy read, then marks it repair-pending", async () => {
    addSession("ses_new");
    addUser("ses_new", "epsilonfirst prompt");
    addReply("ses_new", { parts: [{ type: "future-part", text: "unread" }] });
    const h = startDistiller();
    await coldPassDone(h);
    await waitFor(() => h.distiller.repair()?.sweep?.running === false);
    // The cold pass wrote the card and marked it.
    expect(
      h.logs.some((line) =>
        line.includes("session ses_new is repair-pending: projection lost content"),
      ),
    ).toBe(true);
    const card = store.getCard("ses_new")!;
    expect(card.projectorGen).toBe(GEN);
    expect(hits("epsilonfirst")).toEqual(["ses_new"]);
    expect(h.distiller.status().distilledCount).toBe(1);
    // The mark was recorded at this generation, so the sweep that follows
    // keeps it.
    expect(card.repairReason).toMatch(/unknown types/);
    expect(h.distiller.repair()?.sweep?.repairPending).toBe(1);
  });

  it("never treats a reply still streaming as loss, but does once it completes empty", async () => {
    addSession("ses_a");
    addUser("ses_a", "zetaprompt");
    // A tool part in a state the projector does not render: the reply shows
    // nothing yet, as a reply that just started streaming does.
    const pending = { type: "tool", id: "call_1", name: "bash", state: { status: "pending" } };
    const reply = addReply("ses_a", { parts: [pending], completed: false });
    const h = startDistiller();
    await coldPassDone(h);
    expect(store.getCard("ses_a")).toMatchObject({ distilledThrough: reply });
    expect(store.getCard("ses_a")?.repairReason).toBeUndefined();
    const rev = cardsRev();

    // The same rows, now completed: a finished reply with part rows that
    // projects nothing has lost content.
    v2db.db.run("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?", [
      JSON.stringify(replyData({ completed: true }, T0 + 2)),
      T0 + 50_000,
      reply,
    ]);
    h.distiller.onEvent({ type: "removal", sessionID: "ses_a" });
    await waitFor(() => store.getCard("ses_a")?.repairReason !== undefined);
    expect(store.getCard("ses_a")?.repairReason).toMatch(/empty despite part rows/);
    expect(cardsRev()).toBe(rev);
  });
});

// ── Repair sweep ─────────────────────────────────────────────────────────────

describe("v2 repair sweep", () => {
  it("rebuilds stale cards after the cold pass, sessions with part rows first, archived included", async () => {
    addSession("ses_parts", { time_updated: T0 + 100 });
    addUser("ses_parts", "a question");
    addReply("ses_parts", { parts: [text("etaparts answer")] });
    addSession("ses_newest", { time_updated: T0 + 300 });
    addUser("ses_newest", "inline question");
    addReply("ses_newest", { inline: [text("inline answer")] });
    addSession("ses_arch", { time_updated: T0 + 200, time_archived: T0 + 250 });
    addUser("ses_arch", "thetaarchived prompt");
    await built();
    const rev = cardsRev();
    makeStale(["ses_parts", "ses_newest", "ses_arch"]);
    expect(staleIds()).toEqual(["ses_newest", "ses_arch", "ses_parts"]);

    const h = startDistiller();
    await waitFor(
      () =>
        h.distiller.repair()?.sweep?.done === 3 && h.distiller.repair()?.sweep?.running === false,
    );
    // The cold pass left every stale card to the sweep.
    expect(h.distiller.status().distilledCount).toBe(0);
    expect(h.lookups.slice(0, 3)).toEqual(["ses_parts", "ses_newest", "ses_arch"]);
    expect(h.distiller.repair()?.sweep).toEqual({
      pending: 0,
      repairPending: 0,
      done: 3,
      gen: GEN,
      at: expect.any(Number),
      running: false,
    });
    expect(staleIds()).toEqual([]);
    expect(store.getCard("ses_arch")).toMatchObject({ projectorGen: GEN, timeArchived: T0 + 250 });
    // Nothing they hold changed, so no write was visible to readers.
    expect(cardsRev()).toBe(rev);
    // The suppressed writes recorded range hashes, which later checks find
    // current.
    await cleanSweeps(h, 3);
    expect(reindexed(h.logs)).toEqual([]);
  });

  it("resumes an interrupted sweep from the cards still stale, and reports a holder that went away as stalled", async () => {
    for (const [id, t] of [
      ["ses_1", 300],
      ["ses_2", 200],
      ["ses_3", 100],
    ] as const) {
      addSession(id, { time_updated: T0 + t });
      addUser(id, `prompt of ${id}`);
    }
    await built();
    makeStale(["ses_1", "ses_2", "ses_3"]);

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    const h = startDistiller({
      wrapSource: (inner) => ({
        ...inner,
        getSession: async (id, opts) => {
          if (id === "ses_2") {
            entered = true;
            await blocked;
          }
          return inner.getSession(id, opts);
        },
      }),
    });
    await waitFor(() => entered);
    expect(h.distiller.repair()?.sweep).toMatchObject({ running: true, gen: GEN, pending: 3 });

    // Another process reads the shared progress; once it is older than the
    // staleness bound, the sweep is reported stalled rather than running.
    const late = createDistiller({
      source: createV2HistorySource(reader, { yieldBetween: noYield }),
      store,
      gate: createFetchGate({ concurrency: 1 }),
      limits: { ...TEST_LIMITS, coldPass: false },
      instanceId: "late-reader",
      projectorGen: GEN,
      now: () => Date.now() + PROGRESS_STALE_MS + 60_000,
    });
    distillers.push(late);
    expect(late.repair()?.sweep).toMatchObject({ running: false, stalled: true });

    const stopping = h.distiller.stop();
    release();
    await stopping;
    expect(store.getCard("ses_1")?.projectorGen).toBe(GEN);
    expect(staleIds()).toEqual(["ses_2", "ses_3"]);

    const next = startDistiller();
    await waitFor(
      () => staleIds().length === 0 && next.distiller.repair()?.sweep?.running === false,
    );
    expect(next.lookups).toEqual(["ses_2", "ses_3"]);
    expect(next.distiller.repair()?.sweep).toMatchObject({ pending: 0, done: 2, repairPending: 0 });
  });

  it("marks malformed and loss-guarded cards with a reason, so they leave the stale set", async () => {
    addSession("ses_bad", { time_updated: T0 + 300 });
    addUser("ses_bad", "iotabad prompt");
    const bad = addReply("ses_bad", { parts: [text("an answer")] });
    addSession("ses_lost", { time_updated: T0 + 200 });
    addUser("ses_lost", "kappalost prompt");
    const lost = addReply("ses_lost", { parts: [text("an answer")] });
    addSession("ses_ok", { time_updated: T0 + 100 });
    addUser("ses_ok", "lambdaok prompt");
    addReply("ses_ok", { parts: [text("an answer")] });
    await built();
    v2db.db.run("UPDATE session_part SET data = ? WHERE message_id = ?", ["{not json", bad]);
    rewritePart(lost, 0, { type: "future-part" });
    makeStale(["ses_bad", "ses_lost", "ses_ok"]);

    const h = startDistiller();
    await waitFor(() => h.distiller.repair()?.sweep?.repairPending === 2);
    await waitFor(() => h.distiller.repair()?.sweep?.running === false);
    expect(store.getCard("ses_bad")?.repairReason).toMatch(/^malformed: /);
    expect(store.getCard("ses_lost")?.repairReason).toMatch(/^projection lost content: /);
    expect(store.getCard("ses_ok")).toMatchObject({ projectorGen: GEN });
    expect(store.getCard("ses_ok")?.repairReason).toBeUndefined();
    expect(staleIds()).toEqual([]);
    expect(h.distiller.repair()?.sweep).toMatchObject({ pending: 0, repairPending: 2, done: 1 });
    // Both keep what they held.
    expect(hits("iotabad")).toEqual(["ses_bad"]);
    expect(hits("kappalost")).toEqual(["ses_lost"]);
    expect(store.getCard("ses_bad")?.projectorGen).toBeUndefined();
  });

  it("rebuilds a card an older build overwrote with a version 1 checkpoint, whatever its generation", async () => {
    addSession("ses_a");
    addUser("ses_a", "a prompt");
    await built();
    const cp = JSON.parse(store.getCard("ses_a")!.distillCursor!) as Record<string, unknown>;
    const v1 = { v: 1, seq: cp.seq, msgId: cp.msgId, msgUpdated: cp.msgUpdated };
    storeDb.run("UPDATE card SET distill_cursor = ? WHERE session_id = ?", [
      JSON.stringify({ ...v1, sessKey: cp.sessKey, unsettled: null }),
      "ses_a",
    ]);
    expect(store.getCard("ses_a")?.projectorGen).toBe(GEN);
    expect(staleIds()).toEqual(["ses_a"]);

    const h = startDistiller();
    await waitFor(() => staleIds().length === 0 && h.distiller.repair()?.sweep?.running === false);
    expect(h.distiller.status().distilledCount).toBe(0);
    expect(h.lookups).toEqual(["ses_a"]);
    expect(inspectCheckpoint(store.getCard("ses_a")?.distillCursor)?.version).toBe(2);
  });

  it("leaves a card whose fetch failed stale and unmarked, and retries it", async () => {
    addSession("ses_a");
    addUser("ses_a", "a prompt");
    await built();
    makeStale(["ses_a"]);
    let failures = 1;
    const h = startDistiller({
      coldPassRetryMs: 30,
      wrapSource: (inner) => ({
        ...inner,
        getSession: async (id, opts) => {
          if (failures > 0) {
            failures--;
            throw new Error("transport down");
          }
          return inner.getSession(id, opts);
        },
      }),
    });
    await waitFor(() =>
      h.logs.some((line) => line.includes("repair sweep done: 0 rebuilt, 1 failed")),
    );
    expect(store.getCard("ses_a")?.repairReason).toBeUndefined();
    await waitFor(() => staleIds().length === 0 && h.distiller.repair()?.sweep?.running === false);
    expect(h.distiller.repair()?.sweep).toMatchObject({ pending: 0, done: 1, repairPending: 0 });
  });

  it("leaves a card whose session is gone to the deletion reconcile, unmarked", async () => {
    addSession("ses_gone");
    addUser("ses_gone", "a prompt");
    await built();
    v2db.db.run("DELETE FROM session_message WHERE session_id = ?", ["ses_gone"]);
    v2db.db.run("DELETE FROM session_v2 WHERE id = ?", ["ses_gone"]);
    makeStale(["ses_gone"]);

    // No reconcile, so the card is still there when the sweep reaches it.
    const h = startDistiller({ wrapSync: (inner) => ({ ...inner, missing: async () => [] }) });
    await waitFor(
      () => h.lookups.includes("ses_gone") && h.distiller.repair()?.sweep?.running === false,
    );
    expect(store.getCard("ses_gone")?.repairReason).toBeUndefined();
    expect(staleIds()).toEqual(["ses_gone"]);
    expect(h.distiller.repair()?.sweep).toMatchObject({ pending: 1, done: 0, repairPending: 0 });
  });

  it("keeps repair reasons within a generation and clears them for a new one", async () => {
    addSession("ses_a");
    addUser("ses_a", "a prompt");
    await built();
    makeStale(["ses_a"]);
    store.markRepairPending("ses_a", "an earlier failure");

    // Recorded under this generation: the card stays out of the sweep.
    store.setMeta(REPAIR_GEN_KEY, String(GEN));
    store.setMeta(REPAIR_PROGRESS_KEY, "");
    let h = startDistiller();
    await waitFor(() => h.distiller.repair()?.sweep?.running === false);
    expect(store.getCard("ses_a")).toMatchObject({ repairReason: "an earlier failure" });
    expect(store.getCard("ses_a")?.projectorGen).toBeUndefined();
    expect(h.distiller.repair()?.sweep).toMatchObject({ pending: 0, repairPending: 1, done: 0 });
    await h.distiller.stop();

    // Recorded under an older one: cleared first, then the card is retried.
    store.setMeta(REPAIR_GEN_KEY, String(GEN - 1));
    store.setMeta(REPAIR_PROGRESS_KEY, "");
    h = startDistiller();
    await waitFor(() => h.distiller.repair()?.sweep?.running === false);
    expect(store.getCard("ses_a")?.repairReason).toBeUndefined();
    expect(store.getCard("ses_a")?.projectorGen).toBe(GEN);
    expect(store.getMeta(REPAIR_GEN_KEY)).toBe(String(GEN));
    expect(h.distiller.repair()?.sweep).toMatchObject({ pending: 0, repairPending: 0, done: 1 });
  });
});

// ── Range check ──────────────────────────────────────────────────────────────

describe("v2 range check", () => {
  it("finds a part-only change in a settled session", async () => {
    addSession("ses_a");
    addUser("ses_a", "a question");
    const reply = addReply("ses_a", { parts: [text("a first draft")] });
    const h = startDistiller();
    await cleanSweeps(h, 1);

    rewritePart(reply, 0, text("a muneedle revision"));
    await waitFor(() => hits("muneedle").length > 0);
    expect(
      h.logs.some((line) => /ses_a changed in rows 1 and on \(hash differs\)/.test(line)),
    ).toBe(true);
  });

  it("finds an older rewrite and an older deletion", async () => {
    addSession("ses_a");
    const opener = addUser("ses_a", "nuold opener");
    addReply("ses_a", { parts: [text("an answer")] });
    addUser("ses_a", "a later prompt");
    const h = startDistiller();
    await cleanSweeps(h, 1);

    rewriteUser(opener, "xinew opener");
    await waitFor(() => hits("xinew").length > 0);
    expect(hits("nuold")).toEqual([]);

    // The first row is gone: the span that recorded it holds a row fewer.
    v2db.db.run("DELETE FROM session_message WHERE id = ?", [opener]);
    await waitFor(() => hits("xinew").length === 0);
    expect(
      h.logs.some((line) => line.includes("ses_a changed in rows 1 and on (rows missing)")),
    ).toBe(true);
  });

  it("finds a rewrite that lands between a card's commit and its first check", async () => {
    addSession("ses_a");
    const opener = addUser("ses_a", "omicronold opener");
    addUser("ses_a", "a later prompt");
    let rewritten = false;
    const h = startDistiller({
      onColdPassDone: () => {
        if (rewritten) return;
        rewritten = true;
        rewriteUser(opener, "pinew opener");
      },
    });
    await waitFor(() => hits("pinew").length > 0);
    expect(rangeSweeps(h.logs)[0]).toEqual({ ranges: 1, changed: 1 });
  });

  it("records hashes read before the write's own read, so a change in between is found once", async () => {
    addSession("ses_a");
    const opener = addUser("ses_a", "rhoold opener");
    addUser("ses_a", "a later prompt");
    let injected = false;
    const h = startDistiller({
      // The checkpoint covers only the newest row, so it cannot see the
      // change to the first one.
      sync: { fingerprintRows: 1 },
      wrapSync: (inner) => ({
        ...inner,
        rangeDigest: async (id, after, limit) => {
          const rows = await inner.rangeDigest!(id, after, limit);
          if (!injected) {
            injected = true;
            rewriteUser(opener, "sigmanew opener");
          }
          return rows;
        },
      }),
    });
    await coldPassDone(h);
    // The write read the rows after its digest, so its card is current.
    expect(hits("sigmanew")).toEqual(["ses_a"]);
    // Its hashes are older than what it read: one re-index, then quiet.
    await cleanSweeps(h, 1);
    expect(rangeSweeps(h.logs)[0]).toEqual({ ranges: 1, changed: 1 });
    expect(reindexed(h.logs)).toHaveLength(1);
  });

  it("re-indexes a session with no stored hash once, through a suppressed write that records them", async () => {
    addSession("ses_a");
    addUser("ses_a", "a question");
    addReply("ses_a", { parts: [text("an answer")] });
    await built();
    const rev = cardsRev();
    store.clearRangeHashes("ses_a");

    const distilled: string[] = [];
    const h = startDistiller({ onSessionDistilled: (id) => distilled.push(id) });
    await waitFor(() => store.getRangeHashes("ses_a").length > 0);
    expect(
      h.logs.some((line) => line.includes("ses_a changed in rows 1 and on (no stored hash)")),
    ).toBe(true);
    const from = rangeSweeps(h.logs).length;
    await cleanSweeps(h, 1, 2, from);
    expect(reindexed(h.logs)).toHaveLength(1);
    // The re-index changed nothing readers see.
    expect(cardsRev()).toBe(rev);
    expect(distilled).toEqual([]);
    // Every process can read where the check is.
    const reconcile = h.distiller.repair()?.reconcile;
    expect(reconcile?.sweep).toBeGreaterThanOrEqual(3);
    expect(reconcile?.previousStartedAt).toEqual(expect.any(Number));
  });

  it("never checks or re-indexes below the floor of a session longer than the row cap", async () => {
    addSession("ses_long");
    let low = "";
    let high = "";
    v2db.db.tx(() => {
      for (let i = 1; i <= 520; i++) {
        const id = addUser("ses_long", `row number ${i}`);
        if (i === 3) low = id;
        if (i === 518) high = id;
      }
    });
    const h = startDistiller({ limits: { ftsRowsPerSession: 5 }, pageMessages: 10 });
    await cleanSweeps(h, 1);
    // The write read the newest ten rows, 511 to 520.
    expect(inspectCheckpoint(store.getCard("ses_long")?.distillCursor)).toEqual({
      version: 2,
      seq: 520,
      settled: true,
      floor: 511,
    });
    // The first span starts at the floor, so no hash covers a row below it.
    expect(spansOf("ses_long")).toEqual([[511, 520]]);

    rewriteUser(low, "tauneedle below the floor");
    const from = rangeSweeps(h.logs).length;
    await cleanSweeps(h, 1, 2, from);
    expect(reindexed(h.logs)).toEqual([]);

    rewriteUser(high, "upsilonneedle above the floor");
    await waitFor(() => hits("upsilonneedle").length > 0);
    expect(reindexed(h.logs)).toHaveLength(1);
    expect(hits("tauneedle")).toEqual([]);
    const after = rangeSweeps(h.logs).length;
    await cleanSweeps(h, 1, 1, after);
    expect(reindexed(h.logs)).toHaveLength(1);
  });

  it("checks only settled current-generation cards without a reason", async () => {
    addSession("ses_old");
    addUser("ses_old", "a prompt");
    addSession("ses_marked");
    addUser("ses_marked", "another prompt");
    addSession("ses_ok");
    addUser("ses_ok", "a third prompt");
    // A reply still streaming now: its card's checkpoint is unsettled.
    addSession("ses_streaming");
    insertMessage(v2db.db, {
      id: "msg_streaming",
      session_id: "ses_streaming",
      type: "assistant",
      seq: 1,
      time_created: Date.now(),
      data: replyData({ inline: [text("partial words")], completed: false }, Date.now()),
    });
    await built();
    expect(inspectCheckpoint(store.getCard("ses_streaming")?.distillCursor)?.settled).toBe(false);
    // Repair-pending under this generation, so the sweep leaves it too.
    store.markRepairPending("ses_marked", "kept");
    store.setMeta(REPAIR_GEN_KEY, String(GEN));
    // An older card the sweep would rebuild, kept stale by a gone session
    // the reconcile is told not to drop.
    makeStale(["ses_old"]);
    v2db.db.run("DELETE FROM session_message WHERE session_id = ?", ["ses_old"]);
    v2db.db.run("DELETE FROM session_v2 WHERE id = ?", ["ses_old"]);
    const h = startDistiller({ wrapSync: (inner) => ({ ...inner, missing: async () => [] }) });
    await cleanSweeps(h, 1, 2);
    // Only ses_ok is ever checked.
    expect(rangeSweeps(h.logs).every((s) => s.ranges <= 1)).toBe(true);
    expect(reindexed(h.logs)).toEqual([]);
    expect(h.logs.some((line) => /session ses_(old|marked|streaming) changed/.test(line))).toBe(
      false,
    );
  });
});

// ── Cut messages ─────────────────────────────────────────────────────────────

describe("v2 distiller cut messages", () => {
  /** A reply whose six ~405-byte parts do not fit a 1,500-byte page: a read
   *  returns the first three and a placeholder. */
  function longReply(sessionID: string): string {
    const parts = Array.from({ length: 6 }, (_, i) =>
      text(i === 5 ? `phineedle ${"5".repeat(370)}` : String(i).repeat(380)),
    );
    return addReply(sessionID, { parts });
  }

  it("follows a cut message through its continuations into the card", async () => {
    addSession("ses_cut");
    addUser("ses_cut", "a question");
    const reply = longReply("ses_cut");
    const continued: Array<number | undefined> = [];
    const h = startDistiller({
      source: { pageByteCeiling: 1_500 },
      wrapSource: (inner) => ({
        ...inner,
        getMessage: async (sessionID, messageID, opts) => {
          continued.push(opts?.partOrdinal);
          return inner.getMessage(sessionID, messageID, opts);
        },
      }),
    });
    await coldPassDone(h);
    expect(continued).toEqual([3]);
    expect(hits("phineedle")).toEqual(["ses_cut"]);
    const card = store.getCard("ses_cut")!;
    expect(card.distilledThrough).toBe(reply);
    // The user's text and all six parts.
    expect(card.partCount).toBe(7);
    expect(inspectCheckpoint(card.distillCursor)).toEqual({ version: 2, seq: 2, settled: true });
  });

  it("counts a message the row cap leaves cut in the checkpoint", async () => {
    addSession("ses_cut");
    addUser("ses_cut", "a question");
    longReply("ses_cut");
    const h = startDistiller({
      source: { pageByteCeiling: 1_500 },
      limits: { ftsRowsPerSession: 2 },
    });
    await coldPassDone(h);
    expect(hits("phineedle")).toEqual([]);
    expect(inspectCheckpoint(store.getCard("ses_cut")?.distillCursor)).toEqual({
      version: 2,
      seq: 2,
      settled: true,
      floor: 2,
      cut: 1,
    });
  });

  it("counts a message the source cannot continue, and never makes its note the outcome", async () => {
    addSession("ses_head");
    addUser("ses_head", "a question");
    addReply("ses_head", { inline: [text("chifinal earlier answer")] });
    // An envelope that leaves no room for its first part on the page.
    addReply("ses_head", { parts: [text("f".repeat(800))], extra: { padding: "e".repeat(900) } });
    const h = startDistiller({
      source: { pageByteCeiling: 1_500 },
      wrapSource: (inner) => ({
        ...inner,
        getMessage: async () => ({ ok: false, reason: "unsupported", error: "no continuation" }),
      }),
    });
    await coldPassDone(h);
    const card = store.getCard("ses_head")!;
    expect(card.outcomeHead).toBe("chifinal earlier answer");
    expect(inspectCheckpoint(card.distillCursor)).toEqual({
      version: 2,
      seq: 3,
      settled: true,
      cut: 1,
    });
  });

  it("recognizes the notes that end a cut message as placeholders", () => {
    for (const note of [cutNote(3, 1_215, 3), cutNote(5, 0, 20), changedNote(2, 2)]) {
      expect(isUnavailableText(note), note).toBe(true);
    }
    for (const value of [
      "[unavailable: 3 more items over the read cap]",
      `${cutNote(3, 1_215, 3)} trailing`,
      "[unavailable: some more items left out while the row changed, continued from ordinal 2]",
    ]) {
      expect(isUnavailableText(value), value).toBe(false);
    }
  });
});

// ── Inert without a generation ───────────────────────────────────────────────

describe("repair machinery without a projector generation", () => {
  it("stays off on a v2 sync host that passes no generation", async () => {
    addSession("ses_a");
    addUser("ses_a", "a question");
    addReply("ses_a", { parts: [text("an answer")] });
    let polls = 0;
    let withParts = 0;
    const h = startDistiller({
      projectorGen: null,
      wrapSync: (inner) => ({
        ...inner,
        poll: async (meta) => {
          polls++;
          return inner.poll(meta);
        },
        withParts: async (ids) => {
          withParts++;
          return inner.withParts!(ids);
        },
      }),
    });
    await coldPassDone(h);
    const at = polls;
    await waitFor(() => polls >= at + 3);

    expect(store.getCard("ses_a")?.projectorGen).toBeUndefined();
    expect(store.getRangeHashes("ses_a")).toEqual([]);
    expect(h.digests).toEqual([]);
    expect(withParts).toBe(0);
    expect(h.distiller.repair()).toBeUndefined();
    for (const key of [REPAIR_PROGRESS_KEY, RECONCILE_PROGRESS_KEY, REPAIR_GEN_KEY]) {
      expect(store.getMeta(key), key).toBeUndefined();
    }
  });

  it("stays off on the v1 host", async () => {
    const harness = makeFakeHarness();
    const db = await openSqlite(join(storeDir, "v1-store.db"));
    if (!db) throw new Error("no sqlite");
    const v1store = openV1Store(db);
    if (!v1store) throw new Error("no v1 store");
    try {
      const distiller = createDistiller({
        source: harness.source,
        store: v1store,
        gate: createFetchGate({ concurrency: 2 }),
        limits: { ...TEST_LIMITS, distillDelayMs: 0 },
        instanceId: "v1-inert",
      });
      distillers.push(distiller);
      distiller.start();
      await waitFor(() => distiller.status().coldPass === "done");
      await distiller.stop();

      const cards = v1store.allCards();
      expect(cards.length).toBeGreaterThan(0);
      for (const card of cards) {
        expect(card.projectorGen, card.sessionId).toBeUndefined();
        expect(card.distillCursor, card.sessionId).toBeUndefined();
        expect(v1store.getRangeHashes(card.sessionId), card.sessionId).toEqual([]);
      }
      expect(distiller.repair()).toBeUndefined();
      for (const key of [REPAIR_PROGRESS_KEY, RECONCILE_PROGRESS_KEY, REPAIR_GEN_KEY]) {
        expect(v1store.getMeta(key), key).toBeUndefined();
      }
    } finally {
      db.close();
    }
  });
});

// ── Kept cards, span walks, floors and skipped repairs ───────────────────────

/** An assistant row still streaming: written at `T0` but updated now, so it
 *  is outside every poll window while the tail counts as running. */
function addStreamingReply(sessionID: string, parts: unknown[]): string {
  const seq = nextSeq(sessionID);
  const id = `msg_${sessionID}_${seq}`;
  insertMessage(v2db.db, {
    id,
    session_id: sessionID,
    type: "assistant",
    seq,
    time_created: T0 + seq,
    time_updated: Date.now(),
    data: replyData({ completed: false }, T0 + seq),
  });
  parts.forEach((data, ordinal) => {
    insertPart(v2db.db, { message_id: id, session_id: sessionID, ordinal, time_created: T0, data });
  });
  return id;
}

/** A session's stored slim-index rows, in insertion order. */
const storedRows = (id: string): unknown[] =>
  storeDb.all(
    "SELECT part_id, message_id, prev_message_id, next_message_id, raw FROM part_text WHERE session_id = ? ORDER BY id",
    [id],
  );

const lookupsOf = (h: Started, id: string): number => h.lookups.filter((x) => x === id).length;

/** Stored range hashes without the sweep each was last confirmed in. */
const hashesOf = (id: string): unknown[] =>
  store.getRangeHashes(id).map(({ startSeq, endSeq, rowCount, hash }) => ({
    startSeq,
    endSeq,
    rowCount,
    hash,
  }));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("v2 kept cards", () => {
  it("stops re-reading a kept session once its turn completes", async () => {
    addSession("ses_a");
    addUser("ses_a", "a prompt");
    const reply = addStreamingReply("ses_a", [
      text("streaming words"),
      { type: "future-part", text: "unread" },
    ]);
    const h = startDistiller();
    await coldPassDone(h);
    const kept = (): number => h.logs.filter((line) => line.includes("ses_a kept its card")).length;
    // Still running: every poll reads it again, and the loss keeps the card.
    await waitFor(() => kept() >= 2);

    v2db.db.run("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?", [
      JSON.stringify(replyData({}, T0 + 2)),
      Date.now(),
      reply,
    ]);
    const before = kept();
    await waitFor(() => kept() > before);
    await sleep(30);
    const reads = lookupsOf(h, "ses_a");
    await sleep(150);
    expect(lookupsOf(h, "ses_a")).toBe(reads);
    expect(store.getCard("ses_a")?.repairReason).toMatch(/unknown types/);
  });

  it("keeps the card, its rows and its checkpoint when an append over the row cap lost content", async () => {
    addSession("ses_a");
    for (let i = 1; i <= 3; i++) addUser("ses_a", `lambdaword${i} words`);
    const h = startDistiller({ appendThresholdParts: 0, limits: { ftsRowsPerSession: 3 } });
    await cleanSweeps(h, 1);
    const card = store.getCard("ses_a")!;
    const rows = storedRows("ses_a");

    addReply("ses_a", { parts: [text("munew answer"), { type: "future-part", text: "unread" }] });
    h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
    await waitFor(() => store.getCard("ses_a")?.repairReason !== undefined);
    expect(store.getCard("ses_a")).toEqual({
      ...card,
      repairReason: expect.stringMatching(/1 part rows of unknown types/) as unknown as string,
    });
    expect(storedRows("ses_a")).toEqual(rows);
    expect(hits("lambdaword1")).toEqual(["ses_a"]);
    expect(hits("munew")).toEqual([]);
    expect(h.logs.some((line) => line.includes("ses_a kept its card"))).toBe(true);
  });
});

describe("v2 continuation counts", () => {
  /** A reply whose six ~405-byte parts do not fit a 1,500-byte page: the
   *  page holds the first three and a continuation reads the rest. */
  function longReply(sessionID: string, last: unknown): string {
    const parts = Array.from({ length: 6 }, (_, i) =>
      i === 5 ? last : text(String(i).repeat(380)),
    );
    return addReply(sessionID, { parts });
  }

  function countContinuations(continued: Array<number | undefined>) {
    return (inner: HistorySource): HistorySource => ({
      ...inner,
      getMessage: async (sessionID, messageID, opts) => {
        continued.push(opts?.partOrdinal);
        return inner.getMessage(sessionID, messageID, opts);
      },
    });
  }

  it("keeps the card when an unknown part type turns up only in a continuation", async () => {
    addSession("ses_cut");
    addUser("ses_cut", "a question");
    const reply = longReply("ses_cut", text("phiword answer"));
    const continued: Array<number | undefined> = [];
    const h = startDistiller({
      source: { pageByteCeiling: 1_500 },
      wrapSource: countContinuations(continued),
    });
    await coldPassDone(h);
    expect(hits("phiword")).toEqual(["ses_cut"]);
    const rev = cardsRev();

    rewritePart(reply, 5, { type: "future-part", text: "phiword answer" });
    h.distiller.onEvent({ type: "removal", sessionID: "ses_cut" });
    await waitFor(() => store.getCard("ses_cut")?.repairReason !== undefined);
    expect(store.getCard("ses_cut")?.repairReason).toMatch(/1 part rows of unknown types/);
    expect(hits("phiword")).toEqual(["ses_cut"]);
    expect(cardsRev()).toBe(rev);
    // Both reads continued the message from its fourth part.
    expect(continued).toEqual([3, 3]);
  });

  it("indexes a continued part whose own text reads like a placeholder", async () => {
    addSession("ses_cut");
    addUser("ses_cut", "a question");
    const reply = longReply("ses_cut", text("[unavailable: data is not valid JSON]"));
    const continued: Array<number | undefined> = [];
    const h = startDistiller({
      source: { pageByteCeiling: 1_500 },
      wrapSource: countContinuations(continued),
    });
    await coldPassDone(h);
    expect(continued).toEqual([3]);
    expect(h.distiller.status().quarantinedCount).toBe(0);
    expect(store.getCard("ses_cut")).toMatchObject({ distilledThrough: reply, partCount: 7 });
    expect(store.getCard("ses_cut")?.repairReason).toBeUndefined();
  });

  it("quarantines a session whose continued part does not decode", async () => {
    addSession("ses_cut");
    addUser("ses_cut", "a question");
    const reply = longReply("ses_cut", text("replaced below"));
    v2db.db.run("UPDATE session_part SET data = ? WHERE message_id = ? AND ordinal = ?", [
      "{not json",
      reply,
      5,
    ]);
    const h = startDistiller({ source: { pageByteCeiling: 1_500 } });
    await coldPassDone(h);
    expect(h.distiller.status().quarantinedCount).toBe(1);
    expect(store.getCard("ses_cut")).toBeUndefined();
  });
});

describe("v2 range check walks", () => {
  it("finds a stored span whose every row was deleted", async () => {
    addSession("ses_a");
    addUser("ses_a", "first");
    addUser("ses_a", "second");
    const h = startDistiller({ appendThresholdParts: 0 });
    await cleanSweeps(h, 1);
    const middle = addUser("ses_a", "kappagone middle");
    h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
    await waitFor(() => store.getRangeHashes("ses_a").length === 2);
    addUser("ses_a", "fourth");
    h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
    await waitFor(() => store.getRangeHashes("ses_a").length === 3);
    expect(spansOf("ses_a")).toEqual([
      [1, 2],
      [3, 3],
      [4, 4],
    ]);
    expect(hits("kappagone")).toEqual(["ses_a"]);

    v2db.db.run("DELETE FROM session_message WHERE id = ?", [middle]);
    await waitFor(() => hits("kappagone").length === 0);
    expect(
      h.logs.some((line) => line.includes("ses_a changed in rows 3 and on (rows missing)")),
    ).toBe(true);
  });

  it("checks a session that keeps receiving rows, and finds an older part-only change", async () => {
    addSession("ses_a");
    const at = Date.now();
    insertMessage(v2db.db, {
      id: "msg_open",
      session_id: "ses_a",
      type: "user",
      seq: nextSeq("ses_a"),
      time_created: at,
      data: { text: "a prompt", time: { created: at } },
    });
    const reply = "msg_reply";
    insertMessage(v2db.db, {
      id: reply,
      session_id: "ses_a",
      type: "assistant",
      seq: nextSeq("ses_a"),
      time_created: at,
      data: replyData({}, at),
    });
    insertPart(v2db.db, {
      message_id: reply,
      session_id: "ses_a",
      ordinal: 0,
      time_created: at,
      data: text("a first draft"),
    });
    // Appends never re-read the reply, and the checkpoint covers only its
    // newest row, so only the range check can see the reply change.
    const h = startDistiller({ appendThresholdParts: 0, sync: { fingerprintRows: 1 } });
    await coldPassDone(h);

    let appending = true;
    const appender = (async () => {
      while (appending) {
        const seq = nextSeq("ses_a");
        const now = Date.now();
        insertMessage(v2db.db, {
          id: `msg_more_${seq}`,
          session_id: "ses_a",
          type: "user",
          seq,
          time_created: now,
          data: { text: `more ${seq}`, time: { created: now } },
        });
        await sleep(15);
      }
    })();
    try {
      await waitFor(
        () => (inspectCheckpoint(store.getCard("ses_a")?.distillCursor)?.seq ?? 0) >= 4,
      );
      rewritePart(reply, 0, text("a sigmanew revision"));
      await waitFor(() => hits("sigmanew").length > 0, 8_000);
      expect(
        h.logs.some((line) => /ses_a changed in rows \d+ and on \(hash differs\)/.test(line)),
      ).toBe(true);
    } finally {
      appending = false;
      await appender;
    }
  });
});

describe("v2 range hash writes", () => {
  it("takes no digest while a running tail stays running, and keeps the stored hashes", async () => {
    addSession("ses_a");
    addUser("ses_a", "a prompt");
    addReply("ses_a", { parts: [text("an answer")] });
    const h = startDistiller();
    await cleanSweeps(h, 1);
    const stored = hashesOf("ses_a");

    addStreamingReply("ses_a", [text("omicronword partial")]);
    h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
    await waitFor(() => hits("omicronword").length > 0);
    const digests = h.digests.filter((id) => id === "ses_a").length;
    const reads = lookupsOf(h, "ses_a");
    // Every poll reads the running tail again.
    await waitFor(() => lookupsOf(h, "ses_a") >= reads + 3);
    expect(h.digests.filter((id) => id === "ses_a").length).toBe(digests);
    expect(hashesOf("ses_a")).toEqual(stored);
  });

  it("keeps the stored hashes when the card refuses the write", async () => {
    addSession("ses_a");
    addUser("ses_a", "a prompt");
    await built();
    // A newer build wrote this card.
    storeDb.run("UPDATE card SET projector_gen = ? WHERE session_id = ?", [GEN + 1, "ses_a"]);
    const stored = hashesOf("ses_a");
    expect(stored).toHaveLength(1);

    addUser("ses_a", "a later prompt");
    const h = startDistiller({ limits: { coldPass: false } });
    h.distiller.onEvent({ type: "removal", sessionID: "ses_a" });
    await waitFor(() => h.digests.includes("ses_a"));
    await sleep(50);
    expect(store.getCard("ses_a")?.projectorGen).toBe(GEN + 1);
    expect(hashesOf("ses_a")).toEqual(stored);
  });
});

describe("v2 floors", () => {
  it("never re-indexes a change below the floor in the block that holds it", async () => {
    addSession("ses_long");
    let below = "";
    v2db.db.tx(() => {
      for (let i = 1; i <= 520; i++) {
        const id = addUser("ses_long", `row number ${i}`);
        if (i === 505) below = id;
      }
    });
    const h = startDistiller({ limits: { ftsRowsPerSession: 5 }, pageMessages: 10 });
    await cleanSweeps(h, 1);
    expect(inspectCheckpoint(store.getCard("ses_long")?.distillCursor)?.floor).toBe(511);

    rewriteUser(below, "chineedle below the floor");
    const from = rangeSweeps(h.logs).length;
    await cleanSweeps(h, 1, 2, from);
    expect(reindexed(h.logs)).toEqual([]);
  });

  it("moves the checkpoint's floor up when an append evicts rows at the row cap", async () => {
    addSession("ses_a");
    const opener = addUser("ses_a", "nuword1 words");
    addUser("ses_a", "nuword2 words");
    const h = startDistiller({ appendThresholdParts: 0, limits: { ftsRowsPerSession: 2 } });
    await cleanSweeps(h, 1);
    // The write read the whole session: no floor.
    expect(inspectCheckpoint(store.getCard("ses_a")?.distillCursor)?.floor).toBeUndefined();

    addUser("ses_a", "nuword3 words");
    h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
    await waitFor(() => hits("nuword3").length > 0);
    // The first row was evicted: the oldest row left is the second message's,
    // and the span that held both is trimmed to the floor.
    expect(inspectCheckpoint(store.getCard("ses_a")?.distillCursor)?.floor).toBe(2);
    expect(spansOf("ses_a")).toEqual([
      [2, 2],
      [3, 3],
    ]);
    // The range check finds the trimmed spans current.
    const between = rangeSweeps(h.logs).length;
    await cleanSweeps(h, 2, 1, between);
    expect(reindexed(h.logs)).toEqual([]);
    addUser("ses_a", "nuword4 words");
    h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
    await waitFor(() => hits("nuword4").length > 0);
    expect(inspectCheckpoint(store.getCard("ses_a")?.distillCursor)?.floor).toBe(3);
    expect(spansOf("ses_a")).toEqual([
      [3, 3],
      [4, 4],
    ]);
    expect(hits("nuword2")).toEqual([]);

    // The first span now lies wholly below the floor, so a change there is
    // never checked.
    rewriteUser(opener, "xiword changed below the floor");
    const from = rangeSweeps(h.logs).length;
    await cleanSweeps(h, 2, 2, from);
    expect(reindexed(h.logs)).toEqual([]);
  });
});

describe("v2 repair sweep requeue", () => {
  /** Hold the first session lookup (the re-distill's) until released, and
   *  hold discovery until that lookup started, so the sweep meets the
   *  session while its re-distill is in flight. */
  function holdFirstLookup(fail: boolean) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const redistilling = new Promise<void>((resolve) => (started = resolve));
    let first = true;
    const wrap = (inner: HistorySource): HistorySource => ({
      ...inner,
      listSessions: async (o) => {
        await redistilling;
        return inner.listSessions(o);
      },
      getSession: async (id, o) => {
        if (first) {
          first = false;
          started();
          await held;
          if (fail) throw new Error("lookup failed");
        }
        return inner.getSession(id, o);
      },
    });
    return { wrap, release: () => release() };
  }

  it("rebuilds a stale card the sweep skipped once the re-distill that held it runs", async () => {
    addSession("ses_a");
    addUser("ses_a", "a prompt");
    await built();
    makeStale(["ses_a"]);
    const hold = holdFirstLookup(false);
    try {
      const h = startDistiller({ wrapSource: hold.wrap });
      h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
      await waitFor(() => h.logs.some((line) => line.includes("left 1 card(s) it skipped stale")));
      expect(staleIds()).toEqual(["ses_a"]);

      // The tail is unchanged, but the card is below the generation.
      hold.release();
      await waitFor(() => store.getCard("ses_a")?.projectorGen === GEN);
      expect(staleIds()).toEqual([]);
    } finally {
      hold.release();
    }
  });

  it("retries a card the sweep skipped when the re-distill that held it fails", async () => {
    addSession("ses_a");
    addUser("ses_a", "a prompt");
    await built();
    makeStale(["ses_a"]);
    const hold = holdFirstLookup(true);
    try {
      const h = startDistiller({ wrapSource: hold.wrap, coldPassRetryMs: 20 });
      h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
      await waitFor(() => h.logs.some((line) => line.includes("left 1 card(s) it skipped stale")));
      expect(staleIds()).toEqual(["ses_a"]);

      hold.release();
      await waitFor(() => h.logs.some((line) => line.includes("ses_a re-distill failed")));
      await waitFor(() => store.getCard("ses_a")?.projectorGen === GEN);
      expect(staleIds()).toEqual([]);
    } finally {
      hold.release();
    }
  });
});

describe("v2 bounded re-reads and raised floors", () => {
  it("re-reads a card kept after an append loss within the row cap, and replaces it once the loss is past it", async () => {
    addSession("ses_a");
    addUser("ses_a", "one");
    addUser("ses_a", "two");
    /** The message ids each page read of ses_a returned, in order. */
    const pages: string[][] = [];
    const h = startDistiller({
      appendThresholdParts: 0,
      pageMessages: 1,
      limits: { ftsRowsPerSession: 2 },
      wrapSource: (inner) => ({
        ...inner,
        messagePage: async (o) => {
          const page = await inner.messagePage(o);
          if (o.sessionID === "ses_a") pages.push(page.items.map((msg) => msg.info.id));
          return page;
        },
      }),
    });
    await cleanSweeps(h, 1);
    const kept = (): number => h.logs.filter((line) => line.includes("ses_a kept its card")).length;

    // A turn with a part type this build does not read: the append keeps the
    // card and marks it.
    const lossy = addReply("ses_a", {
      parts: [text("alphaturn reply"), { type: "future-part", text: "unread" }],
    });
    h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
    await waitFor(() => kept() === 1);
    expect(store.getCard("ses_a")?.repairReason).toMatch(/unknown types/);

    // The first turn after it: the capped read still reaches the lossy reply.
    const first = addUser("ses_a", "betaturn prompt");
    h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
    await waitFor(() => kept() === 2);

    // The second: the capped read stops at the first one, so the card is
    // replaced and loses its mark.
    const from = pages.length;
    addUser("ses_a", "gammaturn prompt");
    h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
    await waitFor(() => hits("gammaturn").length > 0);
    const read = pages.slice(from).flat();
    expect(read).toContain(first);
    expect(read).not.toContain(lossy);
    expect(read).not.toContain("msg_ses_a_2");
    expect(store.getCard("ses_a")?.repairReason).toBeUndefined();
    expect(hits("betaturn")).toEqual(["ses_a"]);
    expect(hits("alphaturn")).toEqual([]);
  });

  it("trims an append's own hashes to the floor it raised", async () => {
    addSession("ses_a");
    addUser("ses_a", "one");
    addUser("ses_a", "two");
    const h = startDistiller({ appendThresholdParts: 0, limits: { ftsRowsPerSession: 2 } });
    await cleanSweeps(h, 1);
    expect(spansOf("ses_a")).toEqual([[1, 2]]);

    // Three rows into a card of two: the floor moves past every stored row,
    // into the rows the append read.
    addUser("ses_a", "three");
    addUser("ses_a", "four");
    addUser("ses_a", "omegafive prompt");
    h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
    await waitFor(() => hits("omegafive").length > 0);
    expect(inspectCheckpoint(store.getCard("ses_a")?.distillCursor)?.floor).toBe(4);
    expect(spansOf("ses_a")).toEqual([[4, 5]]);
    const from = rangeSweeps(h.logs).length;
    await cleanSweeps(h, 1, 2, from);
    expect(reindexed(h.logs)).toEqual([]);
  });

  it("resumes a range walk at a floor an evicting append raised since", async () => {
    addSession("ses_a");
    v2db.db.tx(() => {
      for (let i = 1; i <= 1_000; i++) addUser("ses_a", `row number ${i}`);
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    const h = startDistiller({
      appendThresholdParts: 0,
      limits: { ftsRowsPerSession: 1_000 },
      wrapSync: (inner) => ({
        ...inner,
        // The poll after the walk stopped inside the card waits until the
        // append below has landed, so the next walk resumes over it.
        poll: async (meta) => {
          const at = JSON.parse(store.getMeta(RECONCILE_PROGRESS_KEY) ?? "{}") as {
            session?: string;
            after?: number;
          };
          if (!held && at.session === "ses_a" && at.after === 500) {
            held = true;
            await released;
          }
          return inner.poll(meta);
        },
      }),
    });
    try {
      await waitFor(() => held, 20_000);
      expect(spansOf("ses_a")).toEqual([
        [1, 500],
        [501, 1_000],
      ]);
      v2db.db.tx(() => {
        for (let i = 1_001; i <= 1_601; i++) addUser("ses_a", `row number ${i}`);
      });
      h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
      await waitFor(
        () => inspectCheckpoint(store.getCard("ses_a")?.distillCursor)?.floor === 602,
        20_000,
      );
      expect(spansOf("ses_a")).toEqual([
        [602, 1_000],
        [1_001, 1_500],
        [1_501, 1_601],
      ]);
    } finally {
      release();
    }
    // The walk resumes at the floor, not at 500, and finds every span current.
    await waitFor(() => rangeSweeps(h.logs).length >= 1, 20_000);
    expect(reindexed(h.logs)).toEqual([]);
    expect(rangeSweeps(h.logs)[0]).toEqual({ ranges: 4, changed: 0 });
  }, 60_000);

  it("records no append floor and reads no history for it without a projector generation", async () => {
    addSession("ses_a");
    addUser("ses_a", "one");
    addUser("ses_a", "two");
    let seqReads = 0;
    const h = startDistiller({
      projectorGen: null,
      appendThresholdParts: 0,
      limits: { ftsRowsPerSession: 2 },
      wrapSync: (inner) => ({
        ...inner,
        seqOf: async (sessionID, messageID) => {
          seqReads++;
          return inner.seqOf!(sessionID, messageID);
        },
      }),
    });
    await coldPassDone(h);
    addUser("ses_a", "rhothree prompt");
    h.distiller.onEvent({ type: "turn-ended", sessionID: "ses_a" });
    await waitFor(() => hits("rhothree").length > 0);
    // The append evicted the first row, but the floor serves only range
    // checks, which are off.
    expect(hits("one")).toEqual([]);
    expect(inspectCheckpoint(store.getCard("ses_a")?.distillCursor)?.floor).toBeUndefined();
    expect(seqReads).toBe(0);
  });
});
