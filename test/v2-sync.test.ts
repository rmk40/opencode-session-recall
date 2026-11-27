import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDistiller,
  type Distiller,
  type DistillSignal,
  type DistillSync,
  type PollMeta,
} from "../src/distill.js";
import { createFetchGate } from "../src/fetch-gate.js";
import { openStore, type Store } from "../src/store.js";
import { openSqlite, type ReadOnlyDb, type SqliteDb, type SqlValue } from "../src/sqlite.js";
import { createV2HistorySource, openOpencodeDb } from "../src/history/v2.js";
import { createV2EventMapper } from "../src/history/v2-events.js";
import { sessions as sessionsTool } from "../src/sessions.js";
import {
  createV2Sync,
  POLL_CURSOR_KEY,
  POLL_ROW_CURSOR_KEY,
  POLL_WATERMARK_KEY,
  SESSION_WATERMARK_KEY,
  type V2SyncOptions,
} from "../src/history/v2-sync.js";
import { DISCOVERY_LIMIT } from "../src/types.js";
import {
  insertMessage,
  insertProject,
  insertSession,
  limitSpy,
  makeV2Db,
  type SessionInsert,
  type V2TestDb,
} from "./v2-db.js";
import { runTool, TEST_LIMITS } from "./helpers.js";

/**
 * The v2 distiller's freshness without events:
 * the poll, checkpoints, unsettled tails, metadata-only changes, reverts,
 * in-place tail growth and deletion reconcile, against a real temp
 * opencode.db written by a separate connection.
 */

const PROJECT = "prj_sync";
const DIR = "/workspace/sync";

let v2db: V2TestDb;
let reader: ReadOnlyDb & { statements: string[] };
let storeDir: string;
let storeDb: SqliteDb;
let store: Store;
let distiller: Distiller | undefined;
let seq = 0;

const user = (text: string, at: number) => ({ text, time: { created: at } });
const assistant = (text: string, at: number, completed = true) => ({
  agent: "build",
  model: { id: "m", providerID: "p" },
  content: [{ type: "text", text }],
  time: completed ? { created: at, completed: at + 1 } : { created: at },
});

function addSession(id: string, at: number, extra: Partial<SessionInsert> = {}): void {
  insertSession(v2db.db, {
    id,
    project_id: PROJECT,
    directory: DIR,
    title: `Title ${id}`,
    time_created: at,
    time_updated: at,
    ...extra,
  });
}

function addRow(sessionID: string, type: string, data: unknown, at: number, id?: string): string {
  const messageID = id ?? `msg_${++seq}`;
  insertMessage(v2db.db, {
    id: messageID,
    session_id: sessionID,
    type,
    seq: ++seq,
    time_created: at,
    data,
  });
  return messageID;
}

function hits(token: string): string[] {
  return store.ftsSearch({ strong: [token], weak: [] }).map((hit) => hit.sessionId);
}

async function waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function startDistiller(
  sync: V2SyncOptions = {},
  wrap: (inner: DistillSync) => DistillSync = (inner) => inner,
  extra: { appendThresholdParts?: number } = {},
): Distiller {
  const source = createV2HistorySource(reader, { yieldBetween: async () => {} });
  const created = createDistiller({
    source,
    store,
    gate: createFetchGate({ concurrency: 2 }),
    limits: { ...TEST_LIMITS, coldPass: true, distillDelayMs: 0 },
    instanceId: `sync-${Math.random()}`,
    discover: async () => {
      const listing = await source.listSessions({ scope: "global", limit: DISCOVERY_LIMIT });
      if (!listing.ok) throw new Error(listing.error);
      return listing.items;
    },
    sync: wrap(
      createV2Sync(reader, {
        pollIntervalMs: 15,
        sessionScanEveryMs: 0,
        yieldBetween: async () => {},
        ...sync,
      }),
    ),
    idleDebounceMs: 5,
    yieldBetween: async () => {},
    ...extra,
  });
  created.start();
  distiller = created;
  return created;
}

async function restart(sync: V2SyncOptions = {}): Promise<Distiller> {
  await distiller?.stop();
  const next = startDistiller(sync);
  await waitFor(() => next.status().coldPass === "done");
  return next;
}

beforeEach(async () => {
  seq = 0;
  v2db = await makeV2Db();
  insertProject(v2db.db, { id: PROJECT, worktree: DIR });
  const opened = await openOpencodeDb(v2db.path);
  if (!opened.ok) throw new Error(opened.reason);
  // Every session_message statement the sync and source issue binds LIMIT ?.
  reader = limitSpy(opened.db);
  storeDir = mkdtempSync(join(tmpdir(), "recall-v2-sync-"));
  const db = await openSqlite(join(storeDir, "store.db"));
  if (!db) throw new Error("no sqlite");
  storeDb = db;
  const result = openStore(db, { host: "opencode-v2", source: v2db.path });
  if (!result.ok) throw new Error(result.reason);
  store = result.store;
});

afterEach(async () => {
  await distiller?.stop();
  distiller = undefined;
  storeDb.close();
  reader.close();
  v2db.cleanup();
  rmSync(storeDir, { recursive: true, force: true });
});

describe("v2 distiller freshness", () => {
  it("distills new messages from the poll alone, with no events", async () => {
    const at = Date.now();
    addSession("ses_1", at - 10_000);
    addRow("ses_1", "user", user("alphaneedle question", at - 9_000), at - 9_000);
    const d = startDistiller();
    await waitFor(() => d.status().coldPass === "done");
    expect(hits("alphaneedle")).toEqual(["ses_1"]);
    expect(store.getCard("ses_1")?.distillCursor).toEqual(expect.any(String));

    // A new turn arrives; the session row's times do not move (v2 does not
    // bump time_updated on output), and no event is delivered.
    addRow("ses_1", "user", user("betaneedle followup", Date.now()), Date.now());
    await waitFor(() => hits("betaneedle").length > 0);
    expect(hits("betaneedle")).toEqual(["ses_1"]);
    expect(Number(store.getMeta(POLL_WATERMARK_KEY))).toBeGreaterThan(0);
  });

  it("patches a metadata-only rename from the session scan", async () => {
    const at = Date.now();
    addSession("ses_1", at - 10_000);
    addRow("ses_1", "user", user("gammaneedle", at - 9_000), at - 9_000);
    const d = startDistiller();
    await waitFor(() => d.status().coldPass === "done");
    const rev = Number(store.getMeta("cards_rev"));

    v2db.db.run("UPDATE session_v2 SET title = ?, time_updated = ? WHERE id = ?", [
      "Renamed by hand",
      Date.now(),
      "ses_1",
    ]);
    await waitFor(() => store.getCard("ses_1")?.title === "Renamed by hand");
    expect(Number(store.getMeta("cards_rev"))).toBeGreaterThan(rev);
    expect(Number(store.getMeta(SESSION_WATERMARK_KEY))).toBeGreaterThan(0);
  });

  it("re-reads an unsettled tail until a running compaction completes in place", async () => {
    // Older than the poll's first window, so only the unsettled-tail
    // re-read can notice the in-place change.
    const at = Date.now();
    addSession("ses_1", at - 70_000);
    addRow("ses_1", "user", user("deltaneedle", at - 69_000), at - 69_000);
    const compaction = addRow(
      "ses_1",
      "compaction",
      { status: "running", reason: "auto" },
      at - 68_000,
    );
    const d = startDistiller();
    await waitFor(() => d.status().coldPass === "done");
    expect(hits("epsilonsummary")).toEqual([]);

    // Completes in place: same row, no new row, nothing past any watermark.
    v2db.db.run("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?", [
      JSON.stringify({ status: "completed", reason: "auto", summary: "epsilonsummary of work" }),
      Date.now(),
      compaction,
    ]);
    await waitFor(() => hits("epsilonsummary").length > 0);
  });

  it("re-reads an assistant that was still streaming when it was distilled", async () => {
    // Older than the poll's first window, so only the unsettled-tail
    // re-read can notice the in-place change.
    const at = Date.now();
    addSession("ses_1", at - 70_000);
    addRow("ses_1", "user", user("zetaneedle", at - 69_000), at - 69_000);
    const reply = addRow(
      "ses_1",
      "assistant",
      assistant("partial", at - 68_000, false),
      at - 68_000,
    );
    const d = startDistiller();
    await waitFor(() => d.status().coldPass === "done");

    v2db.db.run("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?", [
      JSON.stringify(assistant("partial then etaneedle answer", at - 68_000, true)),
      Date.now(),
      reply,
    ]);
    await waitFor(() => hits("etaneedle").length > 0);
  });

  it("never stamps a checkpoint over content read from a tail that moved mid-fetch", async () => {
    // Older than the poll's first window, so no new-row signal helps: only
    // the checkpoint decides whether the session is read again.
    const at = Date.now();
    addSession("ses_1", at - 70_000);
    addRow("ses_1", "user", user("omicronneedle", at - 69_000), at - 69_000);
    let streaming: string | undefined;
    // Interleaving: the tail is checkpointed (only the user row), then a reply
    // starts streaming before the messages are fetched, so the fetch reads
    // its partial text.
    const d = startDistiller({}, (inner) => ({
      ...inner,
      async checkpoint(sessionID) {
        const cp = await inner.checkpoint(sessionID);
        streaming ??= addRow(
          "ses_1",
          "assistant",
          assistant("partial words", at - 68_000, false),
          at - 68_000,
        );
        return cp;
      },
    }));
    await waitFor(() => d.status().coldPass === "done");
    expect(hits("partial")).toEqual(["ses_1"]);

    // The reply completes in place. A checkpoint describing only the user row
    // would call the card "grown", append nothing past the reply, and stamp
    // the completed tail as fresh over the partial text.
    v2db.db.run("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?", [
      JSON.stringify(assistant("partial words then pineedle", at - 68_000, true)),
      Date.now(),
      streaming!,
    ]);
    await waitFor(() => hits("pineedle").length > 0);
  });

  it("treats a tail changed in place, a revert, and appended rows differently", async () => {
    const at = Date.now();
    addSession("ses_1", at - 10_000);
    addRow("ses_1", "user", user("thetaneedle", at - 9_000), at - 9_000);
    const reply = addRow("ses_1", "assistant", assistant("done", at - 8_000), at - 8_000);
    const sync = createV2Sync(reader, { yieldBetween: async () => {} });
    const cp = await sync.checkpoint("ses_1");
    expect(cp?.settled).toBe(true);
    expect(await sync.compare("ses_1", cp?.cursor)).toBe("fresh");
    expect(await sync.compare("ses_1", null)).toBe("rewritten");
    expect(await sync.compare("ses_1", "not json")).toBe("rewritten");

    addRow("ses_1", "user", user("more", Date.now()), Date.now());
    expect(await sync.compare("ses_1", cp?.cursor)).toBe("grown");

    v2db.db.run("UPDATE session_message SET time_updated = ? WHERE id = ?", [
      Date.now() + 5,
      reply,
    ]);
    expect(await sync.compare("ses_1", cp?.cursor)).toBe("rewritten");

    const cp2 = await sync.checkpoint("ses_1");
    v2db.db.run("DELETE FROM session_message WHERE session_id = ? AND seq >= ?", ["ses_1", 2]);
    expect(await sync.compare("ses_1", cp2?.cursor)).toBe("rewritten");
  });

  it("re-distills a reverted session in full on the next cold pass", async () => {
    const at = Date.now();
    addSession("ses_1", at - 10_000);
    addRow("ses_1", "user", user("iotaneedle", at - 9_000), at - 9_000);
    addRow("ses_1", "user", user("kappaneedle reverted", at - 8_000), at - 8_000);
    const d = startDistiller();
    await waitFor(() => d.status().coldPass === "done");
    expect(hits("kappaneedle")).toEqual(["ses_1"]);

    v2db.db.run("DELETE FROM session_message WHERE session_id = ? AND seq = ?", ["ses_1", seq]);
    await restart();
    expect(hits("kappaneedle")).toEqual([]);
    expect(hits("iotaneedle")).toEqual(["ses_1"]);
  });

  it("removes a deleted session's card on the poll's reconcile, with no event and no cold pass", async () => {
    const at = Date.now();
    addSession("ses_1", at - 10_000);
    addSession("ses_2", at - 10_000);
    addRow("ses_1", "user", user("omeganeedle", at - 9_000), at - 9_000);
    addRow("ses_2", "user", user("psineedle", at - 9_000), at - 9_000);
    const d = startDistiller({ reconcileEveryMs: 30 });
    await waitFor(() => d.status().coldPass === "done");
    expect(store.getCard("ses_2")).toBeDefined();

    v2db.db.run("DELETE FROM session_message WHERE session_id = ?", ["ses_2"]);
    v2db.db.run("DELETE FROM session_v2 WHERE id = ?", ["ses_2"]);
    await waitFor(() => store.getCard("ses_2") === undefined);
    expect(hits("psineedle")).toEqual([]);
    expect(store.getCard("ses_1")).toBeDefined();
    expect(d.status().coldPass).toBe("done"); // no new cold pass ran
  });

  it("removes cards of sessions opencode deleted, on the cold pass", async () => {
    const at = Date.now();
    addSession("ses_1", at - 10_000);
    addSession("ses_2", at - 10_000);
    addRow("ses_1", "user", user("lambdaneedle", at - 9_000), at - 9_000);
    addRow("ses_2", "user", user("muneedle", at - 9_000), at - 9_000);
    const d = startDistiller();
    await waitFor(() => d.status().coldPass === "done");
    expect(store.getCard("ses_2")).toBeDefined();

    v2db.db.run("DELETE FROM session_message WHERE session_id = ?", ["ses_2"]);
    v2db.db.run("DELETE FROM session_v2 WHERE id = ?", ["ses_2"]);
    await restart();
    expect(store.getCard("ses_2")).toBeUndefined();
    expect(hits("muneedle")).toEqual([]);
    expect(store.getCard("ses_1")).toBeDefined();
  });

  it("skips an unchanged session on a restart's cold pass", async () => {
    const at = Date.now();
    addSession("ses_1", at - 10_000);
    addRow("ses_1", "user", user("nuneedle", at - 9_000), at - 9_000);
    const d = startDistiller();
    await waitFor(() => d.status().coldPass === "done");
    expect(d.status().distilledCount).toBe(1);
    const again = await restart();
    expect(again.status().distilledCount).toBe(0);
  });

  it("hands its poll a liveness check that turns false once the distiller stops", async () => {
    const at = Date.now();
    addSession("ses_1", at - 10_000);
    addRow("ses_1", "user", user("xineedle", at - 9_000), at - 9_000);
    let live: (() => boolean) | undefined;
    const d = startDistiller({}, (inner) => ({
      ...inner,
      poll: (meta, check) => {
        live ??= check;
        return inner.poll(meta, check);
      },
    }));
    await waitFor(() => live !== undefined);
    expect(live!()).toBe(true);
    await d.stop();
    expect(live!()).toBe(false);
  });
});

/** One poll as the distiller runs it: dispatch (here: return) the signals,
 *  then commit the watermarks. */
async function pollOnce(
  sync: ReturnType<typeof createV2Sync>,
  meta: PollMeta,
): Promise<DistillSignal[]> {
  const result = await sync.poll(meta);
  expect(result.failures).toEqual([]);
  result.commit();
  return result.signals;
}

describe("v2 poll queries", () => {
  function memoryMeta(): PollMeta & { values: Map<string, string> } {
    const values = new Map<string, string>();
    return {
      values,
      get: (key) => values.get(key),
      set: (key, value) => void values.set(key, value),
    };
  }

  it("compares session recency with NULL time_idle and time_compacting", async () => {
    const at = Date.now();
    addSession("ses_null", at - 1_000, { time_idle: null });
    v2db.db.run("UPDATE session_v2 SET time_compacting = NULL WHERE id = ?", ["ses_null"]);
    addSession("ses_idle", at - 50_000, { time_idle: at - 500 });
    const sync = createV2Sync(reader, { sessionScanEveryMs: 0, yieldBetween: async () => {} });
    const meta = memoryMeta();
    meta.set(SESSION_WATERMARK_KEY, String(at - 10_000));
    const signals = await pollOnce(sync, meta);
    const metaIds = signals.filter((s) => s.type === "meta").map((s) => s.sessionID);
    expect(metaIds.sort()).toEqual(["ses_idle", "ses_null"]);
  });

  it("patches each scanned session's archive time, null for one that is not archived", async () => {
    const at = Date.now();
    addSession("ses_arch", at - 1_000, { time_archived: at - 1_500 });
    addSession("ses_live", at - 1_000);
    const sync = createV2Sync(reader, { sessionScanEveryMs: 0, yieldBetween: async () => {} });
    const meta = memoryMeta();
    meta.set(SESSION_WATERMARK_KEY, String(at - 10_000));
    const patches = (await pollOnce(sync, meta)).flatMap((s) =>
      s.type === "meta" ? [[s.sessionID, s.patch?.timeArchived]] : [],
    );
    expect(patches.sort()).toEqual([
      ["ses_arch", at - 1_500],
      ["ses_live", null],
    ]);
  });

  it("pages a window by (time, message) and moves the watermark once it drains", async () => {
    const at = Date.now();
    addSession("ses_a", at - 10_000);
    addSession("ses_b", at - 10_000);
    const fromA = addRow("ses_a", "user", user("a", at - 3_000), at - 3_000);
    addRow("ses_b", "user", user("b", at - 1_000), at - 1_000);
    const sync = createV2Sync(reader, {
      pollSessionLimit: 1,
      sessionScanEveryMs: 1e12,
      overlapMs: 0,
      now: () => at,
      yieldBetween: async () => {},
    });
    const meta = memoryMeta();
    meta.set(POLL_WATERMARK_KEY, String(at - 5_000));
    const first = await pollOnce(sync, meta);
    expect(first.map((s) => s.sessionID)).toEqual(["ses_a"]);
    // A full poll keeps the watermark and records the last row it read.
    expect(meta.values.get(POLL_WATERMARK_KEY)).toBe(String(at - 5_000));
    expect(meta.values.get(POLL_ROW_CURSOR_KEY)).toBe(JSON.stringify([at - 3_000, fromA]));
    const second = await pollOnce(sync, meta);
    expect(second.map((s) => s.sessionID)).toEqual(["ses_b"]);
    // Drained: the watermark moves to the poll's start.
    expect(meta.values.get(POLL_WATERMARK_KEY)).toBe(String(at));
    expect(meta.values.get(POLL_ROW_CURSOR_KEY)).toBe("");
  });

  /** Poll until every id in `want` has been signalled, or give up after `max`. */
  async function drain(
    sync: ReturnType<typeof createV2Sync>,
    meta: PollMeta,
    type: "turn-ended" | "meta",
    want: string[],
    max = 20,
  ): Promise<string[]> {
    const seen = new Set<string>();
    for (let i = 0; i < max && want.some((id) => !seen.has(id)); i++) {
      for (const signal of await pollOnce(sync, meta)) {
        if (signal.type === type) seen.add(signal.sessionID);
      }
    }
    return [...seen].sort();
  }

  it("never stalls on a page filled by the overlap window, even with equal timestamps", async () => {
    const at = Date.now();
    const ids = ["ses_a", "ses_b", "ses_c", "ses_d"];
    for (const id of ids) addSession(id, at - 20_000);
    // Three sessions share one timestamp inside the overlap; one is later.
    for (const id of ids.slice(0, 3)) addRow(id, "user", user(id, at - 2_000), at - 2_000);
    addRow("ses_d", "user", user("d", at - 1_000), at - 1_000);
    const sync = createV2Sync(reader, {
      pollSessionLimit: 1,
      sessionScanEveryMs: 1e12,
      overlapMs: 5_000,
      now: () => at,
      yieldBetween: async () => {},
    });
    const meta = memoryMeta();
    meta.set(POLL_WATERMARK_KEY, String(at - 4_000));
    expect(await drain(sync, meta, "turn-ended", ids)).toEqual(ids);
    expect(Number(meta.values.get(POLL_WATERMARK_KEY))).toBe(at);
  });

  it("never stalls the session scan on equal recency either", async () => {
    const at = Date.now();
    const ids = ["ses_a", "ses_b", "ses_c"];
    for (const id of ids) addSession(id, at - 2_000);
    const sync = createV2Sync(reader, {
      sessionScanLimit: 1,
      sessionScanEveryMs: 0,
      overlapMs: 5_000,
      yieldBetween: async () => {},
    });
    const meta = memoryMeta();
    meta.set(SESSION_WATERMARK_KEY, String(at - 4_000));
    expect(await drain(sync, meta, "meta", ids)).toEqual(ids);
    expect(Number(meta.values.get(SESSION_WATERMARK_KEY))).toBe(at - 2_000);
  });

  it("keys a checkpoint on the same recency the session scan uses", async () => {
    const at = Date.now();
    addSession("ses_k", at - 20_000);
    addRow("ses_k", "user", user("k", at - 19_000), at - 19_000);
    const sync = createV2Sync(reader, { yieldBetween: async () => {} });
    const cp = await sync.checkpoint("ses_k");
    expect(await sync.compare("ses_k", cp?.cursor)).toBe("fresh");
    // Only time_compacting moves: the scan sees the session as changed, so the
    // checkpoint must too.
    v2db.db.run("UPDATE session_v2 SET time_compacting = ? WHERE id = ?", [at, "ses_k"]);
    expect(await sync.compare("ses_k", cp?.cursor)).toBe("grown");
  });

  it("keeps draining a window from its position after downtime clamps the watermark", async () => {
    const at = Date.now();
    for (const id of ["ses_a", "ses_a2", "ses_b", "ses_c"]) addSession(id, at - 120_000);
    addRow("ses_a", "user", user("a", at - 60_000), at - 60_000, "msg_a");
    // Shares the cursor's timestamp but sorts after it: not yet processed.
    addRow("ses_a2", "user", user("a2", at - 60_000), at - 60_000, "msg_a2");
    addRow("ses_b", "user", user("b", at - 40_000), at - 40_000);
    addRow("ses_c", "user", user("c", at - 1_000), at - 1_000);
    // A window was mid-drain (after ses_a's row) when the service went down;
    // the lookback now clamps the watermark past ses_b.
    const sync = createV2Sync(reader, {
      maxLookbackMs: 10_000,
      overlapMs: 0,
      sessionScanEveryMs: 1e12,
      now: () => at,
      yieldBetween: async () => {},
    });
    const meta = memoryMeta();
    meta.set(POLL_WATERMARK_KEY, String(at - 90_000));
    meta.set(POLL_ROW_CURSOR_KEY, JSON.stringify([at - 60_000, "msg_a"]));
    const signals = await pollOnce(sync, meta);
    expect(signals.map((s) => s.sessionID)).toEqual(["ses_a2", "ses_b", "ses_c"]);

    // An older build's position by session is read again from its time.
    const older = memoryMeta();
    older.set(POLL_WATERMARK_KEY, String(at - 90_000));
    older.set(POLL_CURSOR_KEY, JSON.stringify([at - 60_000, "ses_a"]));
    const again = await pollOnce(sync, older);
    expect(again.map((s) => s.sessionID)).toEqual(["ses_a", "ses_a2", "ses_b", "ses_c"]);
    expect(older.values.get(POLL_CURSOR_KEY)).toBe("");
  });

  it("commits nothing until told to, and isolates a failing session scan", async () => {
    const at = Date.now();
    addSession("ses_a", at - 20_000);
    addRow("ses_a", "user", user("a", at - 2_000), at - 2_000);
    // A reader whose session_v2 scan throws; the message poll still works.
    const failingScan: ReadOnlyDb = {
      ...reader,
      all: (sql, params) => {
        if (/FROM session_v2/.test(sql) && /ORDER BY r/.test(sql)) throw new Error("scan broke");
        return reader.all(sql, params);
      },
    };
    const sync = createV2Sync(failingScan, {
      overlapMs: 0,
      sessionScanEveryMs: 0,
      now: () => at,
      yieldBetween: async () => {},
    });
    const meta = memoryMeta();
    meta.set(POLL_WATERMARK_KEY, String(at - 5_000));
    meta.set(SESSION_WATERMARK_KEY, String(at - 5_000));
    const result = await sync.poll(meta);
    expect(result.signals.map((s) => s.sessionID)).toEqual(["ses_a"]);
    expect(result.failures).toEqual(["session scan: scan broke"]);
    // Not yet committed: a crash before dispatch would re-read the window.
    expect(meta.values.get(POLL_WATERMARK_KEY)).toBe(String(at - 5_000));
    result.commit();
    expect(meta.values.get(POLL_WATERMARK_KEY)).toBe(String(at));
    // The failed scan's window did not move.
    expect(meta.values.get(SESSION_WATERMARK_KEY)).toBe(String(at - 5_000));
  });

  it("fails a page holding a row without a key instead of repeating or skipping it", async () => {
    // Unreachable with the real schema; forced here through the reader.
    const keyless: ReadOnlyDb = {
      ...reader,
      all: (sql, params) =>
        /FROM session_message/.test(sql) && /ORDER BY time_created ASC, id ASC/.test(sql)
          ? [
              { id: null, session_id: null, time_created: null },
              { id: "msg_x", session_id: "ses_x", time_created: 1 },
            ]
          : reader.all(sql, params),
    };
    const sync = createV2Sync(keyless, {
      pollSessionLimit: 1,
      sessionScanEveryMs: 1e12,
      yieldBetween: async () => {},
    });
    const meta = memoryMeta();
    meta.set(POLL_WATERMARK_KEY, "1000");
    const result = await sync.poll(meta);
    expect(result.signals).toEqual([]);
    expect(result.failures[0]).toMatch(/ended on a row without a key/);
    result.commit();
    expect(meta.values.get(POLL_WATERMARK_KEY)).toBe("1000");
    expect(meta.values.get(POLL_ROW_CURSOR_KEY)).toBeUndefined();
  });

  it("applies the overlap once on a first poll with no watermark", async () => {
    const at = Date.now();
    addSession("ses_old", at - 20_000);
    addSession("ses_new", at - 20_000);
    // Inside one overlap of now, and inside two but not one.
    addRow("ses_new", "user", user("n", at - 3_000), at - 3_000);
    addRow("ses_old", "user", user("o", at - 7_000), at - 7_000);
    const sync = createV2Sync(reader, {
      sessionScanEveryMs: 1e12,
      overlapMs: 5_000,
      now: () => at,
      yieldBetween: async () => {},
    });
    const signals = await pollOnce(sync, memoryMeta());
    expect(signals.map((s) => s.sessionID)).toEqual(["ses_new"]);
  });

  describe("the message window, read in row pages", () => {
    /** A yield that fails the poll past `max` calls, so a window that never
     *  drains fails its test instead of hanging the run. `onYield` runs at
     *  each call first. */
    const bounded = (onYield: () => void = () => {}, max = 1_000): (() => Promise<void>) => {
      let calls = 0;
      return async () => {
        onYield();
        if (++calls > max) throw new Error("the poll did not end");
      };
    };
    /** The message poll's row reads, told apart from every other statement. */
    const POLL_READ = /FROM session_message[\s\S]*ORDER BY time_created ASC, id ASC/;

    const turnEnded = (signals: DistillSignal[]): string[] =>
      signals.filter((s) => s.type === "turn-ended").map((s) => s.sessionID);

    type RowAt = [sessionID: string, time: number, messageID?: string];

    /**
     * In one transaction, the sessions `ids` and one user row per entry of
     * `list`, its time relative to `at`. The sessions were last updated at
     * `updated` (relative too): by default long enough ago that the session
     * scan finds none of them, so every turn-ended signal comes from the
     * message window.
     */
    function seed(at: number, ids: string[], list: RowAt[], updated = -600_000): void {
      v2db.db.tx(() => {
        for (const id of ids) addSession(id, at + updated);
        for (const [sessionID, time, id] of list) {
          addRow(sessionID, "user", user(sessionID, at + time), at + time, id);
        }
      });
    }

    it("reads the window pollPageRows rows per statement, each statement after a yield", async () => {
      const at = Date.now();
      seed(
        at,
        ["ses_a", "ses_b", "ses_c"],
        [
          ["ses_a", -7_000],
          ["ses_b", -6_000],
          ["ses_c", -5_000],
          ["ses_a", -4_000],
          ["ses_b", -3_000],
          ["ses_c", -2_000],
          ["ses_a", -1_000],
        ],
      );
      const events: string[] = [];
      const watched: ReadOnlyDb = {
        ...reader,
        all: (sql, params = []) => {
          const found = reader.all(sql, params);
          if (POLL_READ.test(sql)) {
            events.push(`read ${String(params[params.length - 1])}: ${found.length}`);
          }
          return found;
        },
      };
      const sync = createV2Sync(watched, {
        pollPageRows: 3,
        overlapMs: 0,
        sessionScanEveryMs: 1e12,
        now: () => at,
        yieldBetween: bounded(() => void events.push("yield")),
      });
      const meta = memoryMeta();
      meta.set(POLL_WATERMARK_KEY, String(at - 10_000));
      expect(turnEnded(await pollOnce(sync, meta))).toEqual(["ses_a", "ses_b", "ses_c"]);
      expect(events.filter((e) => e.startsWith("read"))).toEqual([
        "read 3: 3",
        "read 3: 3",
        "read 3: 1",
      ]);
      events.forEach((event, i) => {
        if (event.startsWith("read")) expect(events[i - 1]).toBe("yield");
      });
      expect(meta.values.get(POLL_WATERMARK_KEY)).toBe(String(at));
      expect(meta.values.get(POLL_ROW_CURSOR_KEY)).toBe("");
    });

    it("splits sessions past the limit by where their first row falls, whatever the page size", async () => {
      const at = Date.now();
      // ses_b has rows on both sides of where the first poll stops, so the
      // second poll signals it again.
      seed(
        at,
        ["ses_a", "ses_b", "ses_c", "ses_d"],
        [
          ["ses_a", -6_000],
          ["ses_b", -5_000],
          ["ses_a", -4_000],
          ["ses_c", -3_000],
          ["ses_b", -2_000],
          ["ses_d", -1_000],
        ],
      );
      for (const pollPageRows of [1, 2, 4, 2_000]) {
        const sync = createV2Sync(reader, {
          pollSessionLimit: 2,
          pollPageRows,
          overlapMs: 0,
          sessionScanEveryMs: 1e12,
          now: () => at,
          yieldBetween: bounded(),
        });
        const meta = memoryMeta();
        meta.set(POLL_WATERMARK_KEY, String(at - 10_000));
        const polls: string[][] = [];
        for (let i = 0; i < 3; i++) polls.push(turnEnded(await pollOnce(sync, meta)));
        expect(polls, `pollPageRows ${pollPageRows}`).toEqual([
          ["ses_a", "ses_b"],
          ["ses_c", "ses_b"],
          ["ses_d"],
        ]);
        expect(meta.values.get(POLL_WATERMARK_KEY)).toBe(String(at));
        expect(meta.values.get(POLL_ROW_CURSOR_KEY)).toBe("");
      }
    });

    it("reads rows sharing one time_created once each, across page boundaries and polls", async () => {
      const at = Date.now();
      const ids = ["ses_1", "ses_2", "ses_3", "ses_4", "ses_5", "ses_6"];
      // Written out of id order: the keyset orders them, not the insert.
      seed(
        at,
        ids,
        [4, 1, 6, 2, 5, 3].map((n): RowAt => [`ses_${n}`, -2_000, `msg_eq_${n}`]),
      );
      const sync = createV2Sync(reader, {
        pollSessionLimit: 4,
        pollPageRows: 2,
        overlapMs: 0,
        sessionScanEveryMs: 1e12,
        now: () => at,
        yieldBetween: bounded(),
      });
      const meta = memoryMeta();
      meta.set(POLL_WATERMARK_KEY, String(at - 5_000));
      expect(turnEnded(await pollOnce(sync, meta))).toEqual(ids.slice(0, 4));
      expect(meta.values.get(POLL_WATERMARK_KEY)).toBe(String(at - 5_000));
      expect(turnEnded(await pollOnce(sync, meta))).toEqual(ids.slice(4));
      expect(meta.values.get(POLL_WATERMARK_KEY)).toBe(String(at));
      expect(meta.values.get(POLL_ROW_CURSOR_KEY)).toBe("");
    });

    it("signals, by the next poll, a row committed behind its position while it read", async () => {
      const at = Date.now();
      seed(
        at,
        ["ses_a", "ses_b", "ses_c", "ses_late"],
        [
          ["ses_a", -3_000],
          ["ses_b", -2_000],
          ["ses_c", -1_000],
        ],
      );
      let yields = 0;
      const sync = createV2Sync(reader, {
        pollPageRows: 2,
        overlapMs: 5_000,
        sessionScanEveryMs: 1e12,
        now: () => at,
        yieldBetween: bounded(() => {
          // Before the second page: the first one has read past at - 2_500.
          if (++yields === 2) addRow("ses_late", "user", user("late", at - 2_500), at - 2_500);
        }),
      });
      const meta = memoryMeta();
      meta.set(POLL_WATERMARK_KEY, String(at - 4_000));
      const first = turnEnded(await pollOnce(sync, meta));
      expect(first).toEqual(expect.arrayContaining(["ses_a", "ses_b", "ses_c"]));
      const second = turnEnded(await pollOnce(sync, meta));
      expect([...first, ...second]).toContain("ses_late");
    });

    it("signals, by the next poll, a row committed at a time it had passed while newer writes arrived", async () => {
      const at = Date.now();
      seed(
        at,
        ["ses_a", "ses_b", "ses_c", "ses_late", "ses_new"],
        [
          ["ses_a", -3_000],
          ["ses_b", -2_500],
          ["ses_c", -2_000],
        ],
      );
      let yields = 0;
      const sync = createV2Sync(reader, {
        pollPageRows: 2,
        overlapMs: 5_000,
        sessionScanEveryMs: 1e12,
        now: () => at,
        yieldBetween: bounded(() => {
          // Before the second page, the first has read past at - 2_800. A row
          // lands there, and so do writes more than the overlap newer than it.
          if (++yields !== 2) return;
          v2db.db.tx(() => {
            addRow("ses_late", "user", user("late", at - 2_800), at - 2_800);
            for (const t of [6_000, 7_000, 8_000]) {
              addRow("ses_new", "user", user("new", at + t), at + t);
            }
          });
        }),
      });
      const meta = memoryMeta();
      meta.set(POLL_WATERMARK_KEY, String(at - 4_000));
      expect(turnEnded(await pollOnce(sync, meta))).toEqual(["ses_a", "ses_b", "ses_c"]);
      expect(turnEnded(await pollOnce(sync, meta))).toContain("ses_late");
    });

    it("moves the watermark to the poll's start once a window drains, whether or not it read a row", async () => {
      const at = Date.now();
      seed(at, ["ses_a"], [["ses_a", -3_000, "msg_a"]]);
      const sync = createV2Sync(reader, {
        overlapMs: 0,
        sessionScanEveryMs: 1e12,
        now: () => at,
        yieldBetween: bounded(),
      });
      // A window resumed past its last row.
      const resumed = memoryMeta();
      resumed.set(POLL_WATERMARK_KEY, String(at - 5_000));
      resumed.set(POLL_ROW_CURSOR_KEY, JSON.stringify([at - 3_000, "msg_a"]));
      expect(turnEnded(await pollOnce(sync, resumed))).toEqual([]);
      expect(resumed.values.get(POLL_WATERMARK_KEY)).toBe(String(at));
      expect(resumed.values.get(POLL_ROW_CURSOR_KEY)).toBe("");
      // A fresh window with nothing past its watermark.
      const fresh = memoryMeta();
      fresh.set(POLL_WATERMARK_KEY, String(at - 2_000));
      expect(turnEnded(await pollOnce(sync, fresh))).toEqual([]);
      expect(fresh.values.get(POLL_WATERMARK_KEY)).toBe(String(at));
      expect(fresh.values.get(POLL_ROW_CURSOR_KEY)).toBe("");
    });

    it("drains a window with a page size and a session limit below one as if each were one", async () => {
      const at = Date.now();
      seed(
        at,
        ["ses_a", "ses_b", "ses_c"],
        [
          ["ses_a", -3_000],
          ["ses_b", -2_000],
          ["ses_c", -1_000],
        ],
      );
      const sync = createV2Sync(reader, {
        pollPageRows: 0,
        pollSessionLimit: 0,
        overlapMs: 0,
        sessionScanEveryMs: 1e12,
        now: () => at,
        yieldBetween: bounded(),
      });
      const meta = memoryMeta();
      meta.set(POLL_WATERMARK_KEY, String(at - 5_000));
      const polls: string[][] = [];
      for (let i = 0; i < 3; i++) polls.push(turnEnded(await pollOnce(sync, meta)));
      expect(polls).toEqual([["ses_a"], ["ses_b"], ["ses_c"]]);
      expect(meta.values.get(POLL_WATERMARK_KEY)).toBe(String(at));
    });

    describe("an older build's position by session", () => {
      it("skips no session behind a position that lies past the watermark", async () => {
        const at = Date.now();
        // By session, the older build had handled every session up to ses_z
        // at at - 2_000, ses_a and ses_b included; the row window reads them
        // again rather than leave either out.
        seed(
          at,
          ["ses_a", "ses_b", "ses_c", "ses_z"],
          [
            ["ses_a", -3_000],
            ["ses_b", -2_000],
            ["ses_c", -1_000],
          ],
        );
        const sync = createV2Sync(reader, {
          overlapMs: 0,
          sessionScanEveryMs: 1e12,
          now: () => at,
          yieldBetween: bounded(),
        });
        const meta = memoryMeta();
        meta.set(POLL_WATERMARK_KEY, String(at - 5_000));
        meta.set(POLL_CURSOR_KEY, JSON.stringify([at - 2_000, "ses_z"]));
        expect(turnEnded(await pollOnce(sync, meta))).toEqual(["ses_a", "ses_b", "ses_c"]);
        expect(meta.values.get(POLL_WATERMARK_KEY)).toBe(String(at));
        expect(meta.values.get(POLL_CURSOR_KEY)).toBe("");
      });

      it("stays until the window drains while the row position moves the window on", async () => {
        const at = Date.now();
        seed(
          at,
          ["ses_a", "ses_b"],
          [
            ["ses_a", -3_000],
            ["ses_b", -2_000],
          ],
        );
        const sync = createV2Sync(reader, {
          pollSessionLimit: 1,
          overlapMs: 0,
          sessionScanEveryMs: 1e12,
          now: () => at,
          yieldBetween: bounded(),
        });
        const older = JSON.stringify([at - 4_000, "ses_q"]);
        const meta = memoryMeta();
        meta.set(POLL_WATERMARK_KEY, String(at - 5_000));
        meta.set(POLL_CURSOR_KEY, older);
        expect(turnEnded(await pollOnce(sync, meta))).toEqual(["ses_a"]);
        expect(meta.values.get(POLL_CURSOR_KEY)).toBe(older);
        // The second poll goes on from the row position, not from the older
        // bound again, which would read ses_a and stop there on every poll.
        expect(turnEnded(await pollOnce(sync, meta))).toEqual(["ses_b"]);
        expect(meta.values.get(POLL_CURSOR_KEY)).toBe("");
        expect(meta.values.get(POLL_ROW_CURSOR_KEY)).toBe("");
        expect(meta.values.get(POLL_WATERMARK_KEY)).toBe(String(at));
      });
    });

    describe("a liveness check", () => {
      it("ends the poll with no signals and nothing to commit at whichever check it is false", async () => {
        const at = Date.now();
        // Recently updated sessions, so the session scan has signals too, and
        // five rows the message window reads in three pages of two.
        seed(
          at,
          ["ses_a", "ses_b", "ses_c"],
          [
            ["ses_a", -900],
            ["ses_b", -800],
            ["ses_c", -700],
            ["ses_a", -600],
            ["ses_b", -500],
          ],
          -1_000,
        );
        const make = () =>
          createV2Sync(reader, {
            pollPageRows: 2,
            overlapMs: 0,
            sessionScanEveryMs: 0,
            now: () => at,
            yieldBetween: bounded(),
          });
        const start = () => {
          const meta = memoryMeta();
          meta.set(POLL_WATERMARK_KEY, String(at - 5_000));
          meta.set(SESSION_WATERMARK_KEY, String(at - 5_000));
          return meta;
        };
        let checks = 0;
        const full = await make().poll(start(), () => ++checks > 0);
        expect(full.signals.length).toBeGreaterThan(0);
        // One check after each page's yield and one before the session scan.
        expect(checks).toBeGreaterThanOrEqual(4);
        for (let k = 1; k <= checks; k++) {
          let n = 0;
          const meta = start();
          const before = new Map(meta.values);
          // True for the checks before the k-th, false from it on.
          const result = await make().poll(meta, () => ++n < k);
          expect({ k, signals: result.signals, failures: result.failures }).toEqual({
            k,
            signals: [],
            failures: [],
          });
          result.commit();
          expect(meta.values, `false from check ${k}`).toEqual(before);
          // Nothing was lost: the next poll reads the whole window.
          const next = turnEnded(await pollOnce(make(), meta));
          expect(new Set(next), `after check ${k}`).toEqual(new Set(["ses_a", "ses_b", "ses_c"]));
        }
      });

      it("ends the poll with no signals when it turns false at the session scan's yield", async () => {
        const at = Date.now();
        seed(
          at,
          ["ses_a", "ses_b", "ses_c"],
          [
            ["ses_a", -900],
            ["ses_b", -800],
            ["ses_c", -700],
            ["ses_a", -600],
            ["ses_b", -500],
          ],
          -1_000,
        );
        let alive = true;
        let yields = 0;
        const sync = createV2Sync(reader, {
          pollPageRows: 2,
          overlapMs: 0,
          sessionScanEveryMs: 0,
          now: () => at,
          // The message window's three pages of two yield first; the fourth
          // yield is the session scan's.
          yieldBetween: bounded(() => {
            if (++yields === 4) alive = false;
          }),
        });
        const meta = memoryMeta();
        meta.set(POLL_WATERMARK_KEY, String(at - 5_000));
        meta.set(SESSION_WATERMARK_KEY, String(at - 5_000));
        const result = await sync.poll(meta, () => alive);
        expect(yields).toBe(4);
        expect(result.signals).toEqual([]);
      });
    });

    describe("at the default page size and session limit", () => {
      /** `count` sessions, each with four rows at `time(session, round)`. */
      function many(
        at: number,
        count: number,
        time: (session: number, round: number) => number,
      ): string[] {
        const ids = Array.from({ length: count }, (_, s) => `ses_${String(s).padStart(3, "0")}`);
        v2db.db.tx(() => {
          for (const id of ids) addSession(id, at - 600_000);
          const list: Array<[number, string]> = [];
          ids.forEach((id, s) => {
            for (let round = 0; round < 4; round++) list.push([time(s, round), id]);
          });
          list.sort((a, b) => a[0] - b[0]);
          for (const [t, id] of list) addRow(id, "user", user(id, at + t), at + t);
        });
        return ids;
      }

      it("signals 500 sessions in one poll, once each, with the watermark at the poll's start", async () => {
        const at = Date.now();
        // Each session's rows spread over both 2,000-row pages of the window.
        many(at, 500, (s, round) => -10_000 + round * 500 + s);
        const limits: SqlValue[] = [];
        const watched: ReadOnlyDb = {
          ...reader,
          all: (sql, params = []) => {
            if (POLL_READ.test(sql)) limits.push(params[params.length - 1]!);
            return reader.all(sql, params);
          },
        };
        const sync = createV2Sync(watched, {
          sessionScanEveryMs: 1e12,
          now: () => at,
          yieldBetween: bounded(),
        });
        const meta = memoryMeta();
        meta.set(POLL_WATERMARK_KEY, String(at - 20_000));
        // What grouping the window's rows by session finds.
        const grouped = v2db.db.all(
          `SELECT session_id, max(time_created) AS t FROM session_message
           WHERE time_created > ? GROUP BY session_id`,
          [at - 20_000 - 5_000],
        );
        const signals = turnEnded(await pollOnce(sync, meta));
        expect(new Set(signals).size).toBe(signals.length);
        expect([...signals].sort()).toEqual(grouped.map((row) => String(row.session_id)).sort());
        expect(signals).toHaveLength(500);
        expect(meta.values.get(POLL_WATERMARK_KEY)).toBe(String(at));
        expect(meta.values.get(POLL_ROW_CURSOR_KEY)).toBe("");
        expect(limits).toEqual([2_000, 2_000]);
      });

      it("leaves a 501st session to the next poll, from where its first row falls", async () => {
        const at = Date.now();
        // Each session's four rows in a run: the first 2,000-row page holds
        // sessions 0 to 499 whole, and the 501st starts the second page.
        const ids = many(at, 501, (s, round) => -10_000 + s * 4 + round);
        const sync = createV2Sync(reader, {
          sessionScanEveryMs: 1e12,
          now: () => at,
          yieldBetween: bounded(),
        });
        const meta = memoryMeta();
        meta.set(POLL_WATERMARK_KEY, String(at - 20_000));
        expect(turnEnded(await pollOnce(sync, meta))).toEqual(ids.slice(0, 500));
        expect(meta.values.get(POLL_WATERMARK_KEY)).toBe(String(at - 20_000));
        expect(turnEnded(await pollOnce(sync, meta))).toEqual([ids[500]]);
        expect(meta.values.get(POLL_WATERMARK_KEY)).toBe(String(at));
        expect(meta.values.get(POLL_ROW_CURSOR_KEY)).toBe("");
      });
    });
  });
});

describe("archive state in recall_sessions", () => {
  type Listing = { ok: boolean; sessions: Array<{ id: string; archived: boolean }> };

  /** What recall_sessions, listing from the cards, reports for a session's
   *  archive state. */
  async function listedArchived(id: string): Promise<boolean | undefined> {
    const tool = sessionsTool(
      createV2HistorySource(reader, { yieldBetween: async () => {} }),
      true,
      TEST_LIMITS,
      { cards: () => store.allCards() },
    );
    const out = await runTool<Listing>(tool, { scope: "global", since: "1d" });
    expect(out.ok).toBe(true);
    return out.sessions.find((s) => s.id === id)?.archived;
  }

  it("follows an archive and an unarchive with no new messages through the session scan", async () => {
    const at = Date.now();
    addSession("ses_1", at - 10_000);
    addRow("ses_1", "user", user("archneedle", at - 9_000), at - 9_000);
    const d = startDistiller();
    await waitFor(() => d.status().coldPass === "done");
    expect(await listedArchived("ses_1")).toBe(false);

    // opencode moves the session's time_updated with its archive time.
    const archivedAt = Date.now();
    v2db.db.run("UPDATE session_v2 SET time_archived = ?, time_updated = ? WHERE id = ?", [
      archivedAt,
      archivedAt,
      "ses_1",
    ]);
    await waitFor(() => store.getCard("ses_1")?.timeArchived === archivedAt);
    expect(await listedArchived("ses_1")).toBe(true);

    v2db.db.run("UPDATE session_v2 SET time_archived = NULL, time_updated = ? WHERE id = ?", [
      archivedAt + 1,
      "ses_1",
    ]);
    await waitFor(() => store.getCard("ses_1")?.timeArchived === undefined);
    expect(await listedArchived("ses_1")).toBe(false);
    expect(hits("archneedle")).toEqual(["ses_1"]);
  });

  it("follows an archive and an unarchive from their events alone", async () => {
    const at = Date.now();
    addSession("ses_1", at - 10_000);
    addRow("ses_1", "user", user("archneedle", at - 9_000), at - 9_000);
    const d = startDistiller({ sessionScanEveryMs: 1e12 });
    await waitFor(() => d.status().coldPass === "done");
    const mapper = createV2EventMapper({ emit: (signal) => d.onEvent(signal) });
    try {
      // Only the session row changes, and no poll window sees it.
      v2db.db.run("UPDATE session_v2 SET time_archived = ? WHERE id = ?", [at, "ses_1"]);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(store.getCard("ses_1")?.timeArchived).toBeUndefined();

      mapper.map({ type: "session.archived", data: { sessionID: "ses_1" } });
      await waitFor(() => store.getCard("ses_1")?.timeArchived === at);
      expect(await listedArchived("ses_1")).toBe(true);

      v2db.db.run("UPDATE session_v2 SET time_archived = NULL WHERE id = ?", ["ses_1"]);
      mapper.map({ type: "session.unarchived", data: { sessionID: "ses_1" } });
      await waitFor(() => store.getCard("ses_1")?.timeArchived === undefined);
      expect(await listedArchived("ses_1")).toBe(false);
    } finally {
      mapper.dispose();
    }
  });
});

describe("persisted vectors across metadata changes", () => {
  const vector = new Uint8Array([1, 2, 3, 4]);

  async function embeddedCard(extra: { appendThresholdParts?: number } = {}) {
    const at = Date.now();
    addSession("ses_1", at - 70_000);
    addRow("ses_1", "user", user("rhoneedle", at - 69_000), at - 69_000);
    const d = startDistiller({ sessionScanEveryMs: 1e12 }, undefined, extra);
    await waitFor(() => d.status().coldPass === "done");
    const card = store.getCard("ses_1")!;
    store.writeCardEmbeddings("model", 4, [
      { sessionId: "ses_1", embedding: vector, expectedSummaryHash: card.summaryHash },
    ]);
    expect(store.getCard("ses_1")?.embedding).toEqual(vector);
    return d;
  }

  it("patchCardMeta drops the vector only when title or directory change", async () => {
    const d = await embeddedCard();
    await d.stop();
    expect(store.patchCardMeta("ses_1", { projectId: "prj_other" })).toEqual({ changed: true });
    // An unchanged title writes nothing.
    expect(store.patchCardMeta("ses_1", { title: "Title ses_1" })).toEqual({ changed: false });
    expect(store.getCard("ses_1")?.embedding).toEqual(vector);
    const rev = Number(store.getMeta("cards_rev"));
    expect(store.patchCardMeta("ses_1", { title: "Renamed" })).toEqual({ changed: true });
    expect(store.getCard("ses_1")).toMatchObject({
      title: "Renamed",
      embedding: null,
      embeddingGen: null,
    });
    expect(Number(store.getMeta("cards_rev"))).toBe(rev + 1);
  });

  it("drops the vector when an empty append refreshes a renamed card", async () => {
    // Append-eligible, with the session scan off: the rename reaches the card
    // only through the empty append a non-content row triggers.
    await embeddedCard({ appendThresholdParts: 0 });
    v2db.db.run("UPDATE session_v2 SET title = ? WHERE id = ?", ["Renamed quietly", "ses_1"]);
    addRow("ses_1", "idle", { outcome: "succeeded", time: { created: 0 } }, Date.now());
    await waitFor(() => store.getCard("ses_1")?.title === "Renamed quietly");
    expect(store.getCard("ses_1")).toMatchObject({ embedding: null, embeddingGen: null });
  });
});

describe("store.patchCardMeta", () => {
  it("patches only the given fields, bumps cards_rev, and reports unknown sessions", async () => {
    const at = Date.now();
    addSession("ses_1", at - 10_000);
    addRow("ses_1", "user", user("xineedle", at - 9_000), at - 9_000);
    const d = startDistiller();
    await waitFor(() => d.status().coldPass === "done");
    await d.stop();
    const before = store.getCard("ses_1");
    const rev = Number(store.getMeta("cards_rev"));
    expect(store.patchCardMeta("ses_1", { directory: "/elsewhere" })).toEqual({ changed: true });
    const after = store.getCard("ses_1");
    expect(after).toEqual({ ...before, directory: "/elsewhere", writeRev: rev + 1 });
    expect(Number(store.getMeta("cards_rev"))).toBe(rev + 1);
    expect(store.patchCardMeta("ses_missing", { title: "x" })).toEqual({ changed: false });
    expect(Number(store.getMeta("cards_rev"))).toBe(rev + 1);
  });
});
