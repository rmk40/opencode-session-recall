import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDistiller,
  type Distiller,
  type DistillSync,
  type PollMeta,
} from "../src/distill.js";
import { createFetchGate } from "../src/fetch-gate.js";
import { openStore, type Store } from "../src/store.js";
import { openSqlite, type ReadOnlyDb, type SqliteDb } from "../src/sqlite.js";
import { createV2HistorySource, openOpencodeDb } from "../src/history/v2.js";
import {
  createV2Sync,
  POLL_CURSOR_KEY,
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
import { TEST_LIMITS } from "./helpers.js";

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
});

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
    const signals = await sync.poll(meta);
    const metaIds = signals.filter((s) => s.type === "meta").map((s) => s.sessionID);
    expect(metaIds.sort()).toEqual(["ses_idle", "ses_null"]);
  });

  it("pages a window by (time, session) and moves the watermark once it drains", async () => {
    const at = Date.now();
    addSession("ses_a", at - 10_000);
    addSession("ses_b", at - 10_000);
    addRow("ses_a", "user", user("a", at - 3_000), at - 3_000);
    addRow("ses_b", "user", user("b", at - 1_000), at - 1_000);
    const sync = createV2Sync(reader, {
      pollSessionLimit: 1,
      sessionScanEveryMs: 1e12,
      overlapMs: 0,
      yieldBetween: async () => {},
    });
    const meta = memoryMeta();
    meta.set(POLL_WATERMARK_KEY, String(at - 5_000));
    const first = await sync.poll(meta);
    expect(first.map((s) => s.sessionID)).toEqual(["ses_a"]);
    // A full page keeps the watermark and records its position.
    expect(meta.values.get(POLL_WATERMARK_KEY)).toBe(String(at - 5_000));
    expect(meta.values.get(POLL_CURSOR_KEY)).toBe(JSON.stringify([at - 3_000, "ses_a"]));
    const second = await sync.poll(meta);
    expect(second.map((s) => s.sessionID)).toEqual(["ses_b"]);
    expect(meta.values.get(POLL_WATERMARK_KEY)).toBe(String(at - 1_000));
    expect(meta.values.get(POLL_CURSOR_KEY)).toBe("");
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
      for (const signal of await sync.poll(meta)) {
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
      yieldBetween: async () => {},
    });
    const meta = memoryMeta();
    meta.set(POLL_WATERMARK_KEY, String(at - 4_000));
    expect(await drain(sync, meta, "turn-ended", ids)).toEqual(ids);
    expect(Number(meta.values.get(POLL_WATERMARK_KEY))).toBe(at - 1_000);
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
    const signals = await sync.poll(memoryMeta());
    expect(signals.map((s) => s.sessionID)).toEqual(["ses_new"]);
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
    expect(store.patchCardMeta("ses_1", { directory: "/elsewhere" })).toBe(true);
    const after = store.getCard("ses_1");
    expect(after).toEqual({ ...before, directory: "/elsewhere" });
    expect(Number(store.getMeta("cards_rev"))).toBe(rev + 1);
    expect(store.patchCardMeta("ses_missing", { title: "x" })).toBe(false);
    expect(Number(store.getMeta("cards_rev"))).toBe(rev + 1);
  });
});
