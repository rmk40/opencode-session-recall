/**
 * v2 event-loop stall gates, gated behind RECALL_PERF=1
 * like test/perf.test.ts (the verbose reporter prints passing gates' numbers):
 *
 *     RECALL_PERF=1 npx vitest run test/perf-v2.test.ts --reporter=verbose
 *
 * On opencode v2 the plugin runs inside the shared service process, so a long
 * synchronous slice stalls every session, not just one TUI. This builds a
 * large synthetic opencode v2 database (thousands of small sessions, a few
 * 4,000-row sessions, and some multi-megabyte rows, including rows over the
 * page byte ceiling), then measures the gaps a `setInterval(0)` probe sees
 * during a full v2 cold pass, one poll cycle, a `listSessions` call, and an
 * append re-distill of a 4,000-row session.
 * Budget: no code slice over 50 ms, GC pauses excluded.
 *
 * The other gates measure, each on its own database: a tail write over a
 * 5,000-row card; a full write that changes, appends and evicts one row of a
 * 5,000-row card, once with rows of a few repeated words and once with rows
 * of a real session's spread of tokens (about 4,500 characters of text and
 * normalized text each), whose longest slice (the transaction included) has
 * a budget of 35 ms and its total, from the first read of the stored rows
 * to the commit, one of 150 ms; an append of one message to the second
 * card, whose whole re-distill has the same slice budget (each write must
 * write only the rows that differ); a repair sweep over 400 stale cards (half of them with part
 * rows an older build never read, the rest rebuilt by suppressed writes) in a
 * 12,000-card store; a child session's write and then its deletion in a
 * 12,000-card store whose root has 2,400 other children, each of which
 * recomputes the root's rollup; paged discovery of 10,501 sessions and of a
 * root's 2,400 children, through the runtime's own paging; and one range
 * check over a 500-row session. Each records its total time. The last runs
 * the first search after a restart over 12,000 sessions through the runtime
 * the plugin creates, once with no cold pass and once during one with more
 * work than the search, and bounds how much the pass slows the search.
 *
 * Every gate asserts its longest slice with V8's garbage-collection pauses
 * taken out (`…MaxSliceMs`) and logs the raw stall (`…MaxStallMs`) and the
 * longest GC pause (`…MaxGcPauseMs`) beside it. On a loaded machine a major
 * collection alone can pause the loop past the budget. That pause still
 * depends on the code under test, since its length follows the heap the
 * process retains: a raw stall that grows from run to run while the slices
 * pass points at retained memory.
 *
 * When the budget fails the report names the slowest synchronous calls it
 * could attribute (opencode.db statements and store reads and transactions)
 * and the calls inside the worst stall, so the offending path is visible
 * rather than the budget being loosened. Every gate logs the load average.
 *
 * The longest slice of the cold pass is one session's first write: the
 * replaceSessionParts transaction that inserts a 4,000-row session's rows,
 * which stays whole so readers never see half a session. A later full write
 * reads the stored rows a page at a time before its transaction, which writes
 * only the rows that differ. The derivation before it yields
 * cooperatively (deriveCardCooperative), and concurrent workers yield between
 * their writes, so one slice holds at most one such transaction. An append
 * reads the stored rows and derives the merged card over every retained row
 * the same way before its appendSessionParts transaction, which reads only
 * the rows it evicts.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDistiller,
  RECONCILE_PROGRESS_KEY,
  type Distiller,
  type DistillSync,
  type PollMeta,
} from "../src/distill.js";
import { createFetchGate } from "../src/fetch-gate.js";
import type { HistorySession } from "../src/history/model.js";
import type { HistorySource } from "../src/history/source.js";
import { openStore, type Store } from "../src/store.js";
import { openSqlite, type ReadOnlyDb, type SqliteDb } from "../src/sqlite.js";
import { createV2HistorySource, openOpencodeDb } from "../src/history/v2.js";
import { V2_PROJECTOR_GEN } from "../src/history/v2-project.js";
import {
  createV2Sync,
  POLL_CURSOR_KEY,
  POLL_WATERMARK_KEY,
  SESSION_CURSOR_KEY,
  SESSION_WATERMARK_KEY,
  type V2SyncOptions,
} from "../src/history/v2-sync.js";
import { DEFAULTS, DISCOVERY_LIMIT, type SearchOutput } from "../src/types.js";
import { discoverSessions, v2RuntimeFactory, type V2Runtime } from "../src/host/v2-runtime.js";
import { search } from "../src/search.js";
import { listAllChildren } from "../src/sessions.js";
import { makeContext, toolResultText } from "./helpers.js";
import {
  loadAverage,
  perfCorpus,
  perfMessageText,
  stallProbe,
  type Stalls,
} from "./perf-helpers.js";
import {
  insertMessage,
  insertPart,
  insertProject,
  insertSession,
  limitSpy,
  makeV2Db,
  makeV2PartsDb,
  type V2TestDb,
} from "./v2-db.js";
import { changedParts, recordRowMutations, rowsByPart, touchedParts } from "./row-mutations.js";

/**
 * The first-search gate opens opencode.db inside the runtime, through
 * `openOpencodeDb`, which is wrapped here while `spied` is set so that the
 * history readers and the sync read through the LIMIT spy. A violation would
 * surface only as an error inside the runtime, so the spy's throws are
 * recorded and checked after the gate. The other gates wrap the handles they
 * open themselves.
 */
const history = vi.hoisted(() => ({ spied: false, reads: 0, violations: [] as string[] }));

vi.mock("../src/history/v2.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/history/v2.js")>();
  const { limitSpy } = await import("./v2-db.js");
  return {
    ...actual,
    openOpencodeDb: async (path: string) => {
      const opened = await actual.openOpencodeDb(path);
      if (!opened.ok || !history.spied) return opened;
      const spy = limitSpy(opened.db);
      const checked = <T>(sql: string, run: () => T): T => {
        if (/\bsession_(message|part)\b/.test(sql)) history.reads++;
        try {
          return run();
        } catch (error) {
          history.violations.push(error instanceof Error ? error.message : String(error));
          throw error;
        } finally {
          // Only violations matter here, so the spy's statement log is
          // emptied rather than kept for every statement of a cold pass.
          spy.statements.length = 0;
        }
      };
      return {
        ...opened,
        db: {
          get: (sql: string, params?: unknown[]) =>
            checked(sql, () => spy.get(sql, params as Parameters<typeof spy.get>[1])),
          all: (sql: string, params?: unknown[]) =>
            checked(sql, () => spy.all(sql, params as Parameters<typeof spy.all>[1])),
          close: () => spy.close(),
        },
      };
    },
  };
});

const ENABLED = process.env.RECALL_PERF === "1";
const BUDGET_MS = 50;
/** The slice budget of a full write over a card that already holds the
 *  session's rows. */
const DIFF_BUDGET_MS = 35;
/** Its total, from the first read of the stored rows to the commit. */
const DIFF_TOTAL_BUDGET_MS = 150;

const SMALL_SESSIONS = 3_000;
const RECENT_SESSIONS = 600;
const BIG_SESSIONS = 3;
const BIG_SESSION_ROWS = 4_000;
const LOADED_HUGE_ROW_BYTES = 3 * 1024 * 1024; // under the 4 MiB page ceiling
const OVERSIZED_ROW_BYTES = 6 * 1024 * 1024; // over it: a placeholder
const APPEND_ROWS = 200;

/** Stale cards the repair sweep rebuilds, in a store of this many cards: the
 *  rest of the store is what makes its whole-store reads long. */
const SWEEP_SESSIONS = 400;
const SWEEP_STORE_CARDS = 12_000;
const SWEEP_TOTAL_BUDGET_MS = 30_000;
/** Children of the root whose child is written and then deleted, in a store
 *  of SWEEP_STORE_CARDS cards: each change recomputes the root's rollup. */
const FAMILY_CHILDREN = 2_400;
const CHILD_TOTAL_BUDGET_MS = 1_000;
/** Sessions discovery lists, one root's children among them. */
const DISCOVERY_SESSIONS = 10_501;
const ROOT_CHILDREN = 2_400;
const LISTING_TOTAL_BUDGET_MS = 1_000;
/** Rows of the session one range check reads, and checks measured. */
const RANGE_SESSION_ROWS = 500;
const RANGE_CHECKS = 8;
const RANGE_CHECK_TOTAL_BUDGET_MS = 250;
/** Sessions the first search after a restart runs over, and how many times
 *  as long it may take while a cold pass runs as with none running. */
const FIRST_SEARCH_SESSIONS = 12_000;
const FIRST_SEARCH_SLOWDOWN_MAX = 2;

/** Wait for `pred`, failing after ten minutes. */
async function until(pred: () => boolean, what: string): Promise<void> {
  const start = performance.now();
  while (!pred()) {
    if (performance.now() - start > 600_000) throw new Error(`${what} did not finish`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type SlowCall = { what: string; ms: number };

/** Record every synchronous call: the slowest, and a timeline to place the
 *  worst stall (calls that ran inside it, and the last one before it). */
function slowLog(): {
  note(what: string, ms: number): void;
  top(n: number): SlowCall[];
  /** The slowest calls that started inside `window`. */
  topIn(window: { from: number; to: number }, n: number): SlowCall[];
  around(window: { from: number; to: number }): Array<{ at: number; what: string; ms: number }>;
} {
  const calls: SlowCall[] = [];
  const timeline: Array<{ at: number; what: string; ms: number }> = [];
  return {
    note(what, ms) {
      if (ms > 5) calls.push({ what, ms: Math.round(ms * 10) / 10 });
      timeline.push({ at: performance.now() - ms, what, ms: Math.round(ms * 10) / 10 });
    },
    top: (n) => [...calls].sort((a, b) => b.ms - a.ms).slice(0, n),
    topIn: ({ from, to }, n) =>
      timeline
        .filter((e) => e.at >= from && e.at <= to)
        .sort((a, b) => b.ms - a.ms)
        .slice(0, n)
        .map(({ what, ms }) => ({ what, ms })),
    around: ({ from, to }) => {
      // The slow calls inside the stall, and the last call before it.
      const inside = timeline.filter((e) => e.at >= from && e.at <= to && e.ms > 1);
      const before = timeline.filter((e) => e.at < from).slice(-1);
      return [...before, ...inside].map((e) => ({ ...e, at: Math.round(e.at - from) }));
    },
  };
}

function timedReader(inner: ReadOnlyDb, log: ReturnType<typeof slowLog>): ReadOnlyDb {
  const label = (sql: string) => `opencode.db: ${sql.replace(/\s+/g, " ").slice(0, 90)}`;
  return {
    get: (sql, params) => {
      const start = performance.now();
      try {
        return inner.get(sql, params);
      } finally {
        log.note(label(sql), performance.now() - start);
      }
    },
    all: (sql, params) => {
      const start = performance.now();
      try {
        return inner.all(sql, params);
      } finally {
        log.note(label(sql), performance.now() - start);
      }
    },
    close: () => inner.close(),
  };
}

function timedStoreDb(inner: SqliteDb, log: ReturnType<typeof slowLog>): SqliteDb {
  return {
    ...inner,
    tx(fn) {
      const start = performance.now();
      try {
        return inner.tx(fn);
      } finally {
        log.note("store transaction", performance.now() - start);
      }
    },
    run(sql, params) {
      const start = performance.now();
      try {
        return inner.run(sql, params);
      } finally {
        log.note(`store: ${sql.slice(0, 60)}`, performance.now() - start);
      }
    },
    all(sql, params) {
      const start = performance.now();
      try {
        return inner.all(sql, params);
      } finally {
        // A card read names its long column list first, so keep its FROM.
        const flat = sql.replace(/\s+/g, " ");
        const from = flat.indexOf(" FROM ");
        const label = from > 40 ? `${flat.slice(0, 30)} …${flat.slice(from, from + 40)}` : flat;
        log.note(`store: ${label.slice(0, 80)}`, performance.now() - start);
      }
    },
  };
}

const words = [
  "migration",
  "checkout",
  "parser",
  "websocket",
  "lease",
  "cursor",
  "rollback",
  "sprocket",
  "latency",
  "budget",
];
const sentence = (i: number, n = 12) =>
  Array.from({ length: n }, (_, k) => words[(i + k * 7) % words.length]).join(" ");

// ── Fixtures for the sweep, discovery and range-check gates ──────────────────

/** The pause the v2 runtime runs between discovery pages and distiller
 *  steps. */
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Session discovery as the v2 runtime runs it. */
const discover = (source: HistorySource): Promise<HistorySession[]> =>
  discoverSessions(source, macrotask);

/** The read-only opencode.db connection a gate reads through (timed, and
 *  failing any unbounded history statement), and a v2 store beside it. */
async function openFixture(
  v2: V2TestDb,
  storeDir: string,
  slow: ReturnType<typeof slowLog>,
): Promise<{ reader: ReadOnlyDb; storeDb: SqliteDb; store: Store; close: () => void }> {
  const opened = await openOpencodeDb(v2.path);
  if (!opened.ok) throw new Error(opened.reason);
  const reader = limitSpy(timedReader(opened.db, slow));
  const storeDb = await openSqlite(join(storeDir, "store.db"));
  if (!storeDb) throw new Error("no sqlite");
  const result = openStore(timedStoreDb(storeDb, slow), { host: "opencode-v2", source: v2.path });
  if (!result.ok) throw new Error(result.reason);
  return {
    reader,
    storeDb,
    store: result.store,
    close: () => {
      reader.close();
      storeDb.close();
    },
  };
}

const textItem = (text: string) => ({ type: "text", text });
const toolItem = (id: string, command: string, output: string, t: number) => ({
  type: "tool",
  id,
  name: "bash",
  state: {
    status: "completed",
    input: { command },
    content: [{ type: "text", text: output }],
    metadata: {},
  },
  time: { created: t, completed: t + 1 },
});
const userData = (text: string, t: number) => ({ text, time: { created: t } });
const replyData = (content: unknown[], t: number) => ({
  agent: "build",
  model: { id: "m", providerID: "p" },
  content,
  time: { created: t, completed: t + 1 },
});

const round1 = (n: number): number => Math.round(n * 10) / 10;
const rounded = (results: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(results).map(([k, v]) => [k, round1(v)]));
/** A gate's stall numbers under `prefix`. */
const stallFields = (prefix: string, s: Stalls): Record<string, number> => ({
  [`${prefix}MaxSliceMs`]: s.maxOutsideGcMs,
  [`${prefix}MaxStallMs`]: s.maxMs,
  [`${prefix}MaxGcPauseMs`]: s.maxGcMs,
});

describe.skipIf(!ENABLED)("perf: v2 event-loop stalls", () => {
  it(`cold pass, one poll, listSessions and an append keep each code slice under ${BUDGET_MS} ms excluding GC pauses`, async () => {
    const v2 = await makeV2Db();
    const storeDir = mkdtempSync(join(tmpdir(), "recall-perf-v2-"));
    try {
      // ── Build the synthetic opencode.db (one writer transaction) ──
      const built = performance.now();
      const at = Date.now();
      let seq = 0;
      const w = v2.db;
      const add = (sid: string, type: string, data: unknown, t: number) => {
        w.run(
          `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [`msg_${++seq}`, sid, type, seq, t, t, JSON.stringify(data)],
        );
      };
      const user = (text: string, t: number) => ({ text, time: { created: t } });
      const reply = (text: string, t: number) => ({
        agent: "build",
        model: { id: "m", providerID: "p" },
        content: [{ type: "text", text }],
        time: { created: t, completed: t + 1 },
      });
      w.tx(() => {
        insertProject(w, { id: "prj", worktree: "/workspace/perf" });
        for (let i = 0; i < SMALL_SESSIONS; i++) {
          const sid = `ses_small_${i}`;
          // The newest RECENT_SESSIONS fall inside the poll's window below.
          const t =
            i < SMALL_SESSIONS - RECENT_SESSIONS
              ? at - 10_000_000 + i * 1_000
              : at - 1_200_000 + (i - (SMALL_SESSIONS - RECENT_SESSIONS)) * 1_000;
          insertSession(w, {
            id: sid,
            project_id: "prj",
            directory: "/workspace/perf",
            time_created: t,
            time_updated: t + 500,
          });
          add(sid, "user", user(sentence(i), t), t);
          add(sid, "assistant", reply(sentence(i + 1, 40), t + 10), t + 10);
          add(sid, "user", user(sentence(i + 2), t + 20), t + 20);
          add(sid, "assistant", reply(sentence(i + 3, 40), t + 30), t + 30);
        }
        for (let b = 0; b < BIG_SESSIONS; b++) {
          const sid = `ses_big_${b}`;
          const t = at - 1_000_000 + b * 100_000;
          insertSession(w, {
            id: sid,
            project_id: "prj",
            directory: "/workspace/perf",
            time_created: t,
            time_updated: t + BIG_SESSION_ROWS * 10,
          });
          for (let r = 0; r < BIG_SESSION_ROWS; r++) {
            const rt = t + r * 10;
            if (r % 2 === 0) add(sid, "user", user(sentence(r), rt), rt);
            else add(sid, "assistant", reply(sentence(r, 60), rt), rt);
          }
          // One loaded multi-megabyte reply and one over the page ceiling.
          const rt = t + BIG_SESSION_ROWS * 10;
          add(sid, "assistant", reply("x".repeat(LOADED_HUGE_ROW_BYTES), rt), rt);
          add(sid, "assistant", reply("y".repeat(OVERSIZED_ROW_BYTES), rt + 1), rt + 1);
        }
      });
      const buildMs = performance.now() - built;

      const slow = slowLog();
      const opened = await openOpencodeDb(v2.path);
      if (!opened.ok) throw new Error(opened.reason);
      const reader = timedReader(opened.db, slow);
      const rawStoreDb = await openSqlite(join(storeDir, "store.db"));
      if (!rawStoreDb) throw new Error("no sqlite");
      const storeDb = timedStoreDb(rawStoreDb, slow);
      const openedStore = openStore(storeDb, { host: "opencode-v2", source: v2.path });
      if (!openedStore.ok) throw new Error(openedStore.reason);
      const store = openedStore.store;

      const source = createV2HistorySource(reader);
      const sync = createV2Sync(reader, { pollIntervalMs: 3_600_000 });
      const probe = stallProbe();
      let coldWorst = { from: 0, to: 0 };
      let appendWorst = { from: 0, to: 0 };
      const results: Record<string, number> = {};
      const load = loadAverage();
      try {
        // ── Cold pass ──
        probe.reset();
        const coldStart = performance.now();
        const distiller = createDistiller({
          source,
          store,
          gate: createFetchGate({ concurrency: DEFAULTS.concurrency }),
          limits: { ...DEFAULTS, distillDelayMs: 0 },
          instanceId: "perf-v2",
          discover: async () => {
            const listing = await source.listSessions({ scope: "global", limit: DISCOVERY_LIMIT });
            if (!listing.ok) throw new Error(listing.error);
            return listing.items;
          },
          sync,
          yieldBetween: () => new Promise((resolve) => setTimeout(resolve, 0)),
          log: () => {},
        });
        distiller.start();
        while (distiller.status().coldPass !== "done") {
          if (performance.now() - coldStart > 600_000) throw new Error("cold pass did not finish");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        coldWorst = probe.worst();
        results.coldPassTotalMs = performance.now() - coldStart;
        Object.assign(results, stallFields("coldPass", await probe.stalls()));
        await distiller.stop();

        // ── One poll cycle (both queries; the session scan is due on a first poll) ──
        const meta: PollMeta = {
          get: (key) => store.getMeta(key),
          set: (key, value) => store.setMeta(key, value),
        };
        // A watermark 30 minutes back: the poll pages through the recent
        // sessions (more than one page of 500) and the session scan sees them.
        meta.set(POLL_WATERMARK_KEY, String(at - 1_800_000));
        meta.set(POLL_CURSOR_KEY, "");
        meta.set(SESSION_WATERMARK_KEY, String(at - 1_800_000));
        meta.set(SESSION_CURSOR_KEY, "");
        probe.reset();
        const pollStart = performance.now();
        const polled = await sync.poll(meta);
        polled.commit();
        const signals = polled.signals;
        results.pollTotalMs = performance.now() - pollStart;
        Object.assign(results, stallFields("poll", await probe.stalls()));
        results.pollSignals = signals.length;

        // ── listSessions ──
        probe.reset();
        const listStart = performance.now();
        const listing = await source.listSessions({ scope: "global", limit: DISCOVERY_LIMIT });
        results.listTotalMs = performance.now() - listStart;
        Object.assign(results, stallFields("list", await probe.stalls()));
        results.listed = listing.ok ? listing.items.length : -1;
        results.cards = store.allCards().length;

        // ── Append re-distill of a big session ──
        // distillAppend derives the merged card synchronously inside the
        // store transaction (over every retained row), so it gets its own
        // measurement. ses_big_0 is far over appendThresholdParts; the new
        // rows are settled, so the tail compares as appended.
        const appendSid = "ses_big_0";
        const partsBefore = store.getCard(appendSid)?.partCount ?? 0;
        const appendAt = at + 60_000;
        w.tx(() => {
          for (let r = 0; r < APPEND_ROWS; r++) {
            const rt = appendAt + r;
            if (r % 2 === 0) add(appendSid, "user", user(sentence(r), rt), rt);
            else add(appendSid, "assistant", reply(sentence(r, 60), rt), rt);
          }
          w.run("UPDATE session_v2 SET time_updated = ? WHERE id = ?", [
            appendAt + APPEND_ROWS,
            appendSid,
          ]);
        });
        let appendCalls = 0;
        const appendParts = store.appendSessionParts.bind(store);
        store.appendSessionParts = (...args) => {
          appendCalls++;
          return appendParts(...args);
        };
        const appender = createDistiller({
          source,
          store,
          gate: createFetchGate({ concurrency: DEFAULTS.concurrency }),
          limits: { ...DEFAULTS, coldPass: false, distillDelayMs: 0 },
          instanceId: "perf-v2-append",
          sync,
          idleDebounceMs: 1,
          yieldBetween: () => new Promise((resolve) => setTimeout(resolve, 0)),
          log: () => {},
        });
        appender.start();
        probe.reset();
        const appendStart = performance.now();
        appender.onEvent({ type: "turn-ended", sessionID: appendSid });
        while ((store.getCard(appendSid)?.partCount ?? 0) <= partsBefore) {
          if (performance.now() - appendStart > 60_000) throw new Error("append did not land");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        appendWorst = probe.worst();
        results.appendTotalMs = performance.now() - appendStart;
        Object.assign(results, stallFields("append", await probe.stalls()));
        results.appendCalls = appendCalls;
        results.appendPartsBefore = partsBefore;
        await appender.stop();
      } finally {
        probe.stop();
        reader.close();
        rawStoreDb.close();
      }

      const round = (n: number) => Math.round(n * 10) / 10;
      console.log(
        `v2 perf (load ${load}):`,
        JSON.stringify(
          {
            buildMs: round(buildMs),
            ...Object.fromEntries(Object.entries(results).map(([k, v]) => [k, round(v)])),
          },
          null,
          1,
        ),
      );
      console.log("slowest synchronous calls:", JSON.stringify(slow.top(8)));
      console.log(
        "calls around the worst cold-pass stall (ms relative to its start):",
        JSON.stringify(slow.around(coldWorst)),
      );
      console.log(
        "calls around the worst append stall (ms relative to its start):",
        JSON.stringify(slow.around(appendWorst)),
      );

      expect(results.cards).toBe(SMALL_SESSIONS + BIG_SESSIONS);
      expect(results.coldPassMaxSliceMs).toBeLessThan(BUDGET_MS);
      expect(results.pollMaxSliceMs).toBeLessThan(BUDGET_MS);
      expect(results.listMaxSliceMs).toBeLessThan(BUDGET_MS);
      expect(results.appendCalls).toBe(1);
      expect(results.appendMaxSliceMs).toBeLessThan(BUDGET_MS);
    } finally {
      v2.cleanup();
      rmSync(storeDir, { recursive: true, force: true });
    }
  }, 900_000);

  it(`a tail write over a 5,000-row card keeps each code slice under ${BUDGET_MS} ms excluding GC pauses`, async () => {
    const TAIL_BUDGET_TOTAL_MS = 1_000;
    const v2 = await makeV2Db();
    const storeDir = mkdtempSync(join(tmpdir(), "recall-perf-v2-tail-"));
    try {
      const at = Date.now();
      const w = v2.db;
      const sid = "ses_streaming";
      let seq = 0;
      const add = (type: string, data: unknown, t: number, updated = t) => {
        const id = `msg_${++seq}`;
        w.run(
          `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, sid, type, seq, t, updated, JSON.stringify(data)],
        );
        return id;
      };
      const running = (text: string, t: number) => ({
        agent: "build",
        model: { id: "m", providerID: "p" },
        content: [{ type: "text", text }],
        time: { created: t },
      });
      // 5,000 settled rows of about 1,800 characters each, then a reply that
      // is still running (updated now, so it is not abandoned).
      const t0 = at - 10_000_000;
      w.tx(() => {
        insertProject(w, { id: "prj", worktree: "/workspace/perf" });
        insertSession(w, {
          id: sid,
          project_id: "prj",
          directory: "/workspace/perf",
          time_created: t0,
          time_updated: t0,
        });
        for (let r = 0; r < 5_000; r++) {
          add("user", { text: sentence(r, 200), time: { created: t0 + r } }, t0 + r);
        }
      });
      const reply = add("assistant", running("streaming words", t0 + 5_000), t0 + 5_000, at);

      const slow = slowLog();
      const opened = await openOpencodeDb(v2.path);
      if (!opened.ok) throw new Error(opened.reason);
      const reader = timedReader(opened.db, slow);
      const rawStoreDb = await openSqlite(join(storeDir, "store.db"));
      if (!rawStoreDb) throw new Error("no sqlite");
      const openedStore = openStore(timedStoreDb(rawStoreDb, slow), {
        host: "opencode-v2",
        source: v2.path,
      });
      if (!openedStore.ok) throw new Error(openedStore.reason);
      const store = openedStore.store;
      let tailWrites = 0;
      const replaceTail = store.replaceSessionTail.bind(store);
      store.replaceSessionTail = (...args) => {
        tailWrites++;
        return replaceTail(...args);
      };
      const source = createV2HistorySource(reader);
      const distiller = createDistiller({
        source,
        store,
        gate: createFetchGate({ concurrency: DEFAULTS.concurrency }),
        limits: { ...DEFAULTS, coldPass: false, distillDelayMs: 0 },
        instanceId: "perf-v2-tail",
        sync: createV2Sync(reader, { pollIntervalMs: 3_600_000 }),
        projectorGen: V2_PROJECTOR_GEN,
        idleDebounceMs: 1,
        yieldBetween: () => new Promise((resolve) => setTimeout(resolve, 0)),
        log: () => {},
      });
      const probe = stallProbe();
      const results: Record<string, number> = {};
      const load = loadAverage();
      try {
        distiller.start();
        // The first write reads in full and records the settled base.
        distiller.onEvent({ type: "turn-ended", sessionID: sid });
        const firstStart = performance.now();
        while (store.getCard(sid)?.settledBase === undefined) {
          if (performance.now() - firstStart > 120_000) throw new Error("no first write");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        results.fullWriteMs = performance.now() - firstStart;

        // The reply grows: a tail write.
        w.run("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?", [
          JSON.stringify(running("streaming words and more of them", t0 + 5_000)),
          at + 1,
          reply,
        ]);
        probe.reset();
        const tailStart = performance.now();
        distiller.onEvent({ type: "turn-ended", sessionID: sid });
        while (tailWrites === 0) {
          if (performance.now() - tailStart > 60_000) throw new Error("no tail write");
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        results.tailWriteTotalMs = performance.now() - tailStart;
        Object.assign(results, stallFields("tailWrite", await probe.stalls()));

        // Nothing changed: no write at all.
        probe.reset();
        const quietStart = performance.now();
        distiller.onEvent({ type: "turn-ended", sessionID: sid });
        await new Promise((resolve) => setTimeout(resolve, 200));
        results.unchangedWindowMs = performance.now() - quietStart;
        Object.assign(results, stallFields("unchanged", await probe.stalls()));
        results.tailWrites = tailWrites;
        results.storedRows = store.sessionRowCount(sid);
        await distiller.stop();
      } finally {
        probe.stop();
        reader.close();
        rawStoreDb.close();
      }
      const round = (n: number) => Math.round(n * 10) / 10;
      console.log(
        `v2 tail write perf (load ${load}):`,
        JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, round(v)]))),
      );
      console.log("slowest synchronous calls:", JSON.stringify(slow.top(8)));

      expect(results.storedRows).toBe(DEFAULTS.ftsRowsPerSession);
      expect(results.tailWrites).toBe(1);
      expect(results.tailWriteMaxSliceMs).toBeLessThan(BUDGET_MS);
      expect(results.tailWriteTotalMs).toBeLessThan(TAIL_BUDGET_TOTAL_MS);
      expect(results.unchangedMaxSliceMs).toBeLessThan(BUDGET_MS);
    } finally {
      v2.cleanup();
      rmSync(storeDir, { recursive: true, force: true });
    }
  }, 300_000);

  it.each([
    { what: "a full write that changes, appends and evicts one row", write: "full", rows: "plain" },
    { what: "a full write that changes, appends and evicts one row", write: "full", rows: "real" },
    { what: "an append of one message that evicts one row", write: "append", rows: "real" },
  ] as const)(
    `$what of a 5,000-row card of $rows rows keeps each code slice under ${DIFF_BUDGET_MS} ms excluding GC pauses`,
    async ({ write, rows: kind }) => {
      /** A message's text: ten words repeated, whose slim-index row is about
       *  1,700 characters of text and normalized text, or text with a real
       *  session's spread of tokens, whose row is about 5,000. */
      const messageText = (r: number): string =>
        kind === "plain" ? sentence(r, 200) : perfMessageText(r, 2_400);
      const ROWS = DEFAULTS.ftsRowsPerSession;
      const v2 = await makeV2Db();
      const storeDir = mkdtempSync(join(tmpdir(), "recall-perf-v2-diff-"));
      try {
        const at = Date.now();
        const w = v2.db;
        const sid = "ses_rewritten";
        let seq = 0;
        const add = (text: string, t: number) => {
          const id = `msg_${++seq}`;
          w.run(
            `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, sid, "user", seq, t, t, JSON.stringify(userData(text, t))],
          );
          return id;
        };
        // A full card: one settled row per message.
        const t0 = at - 10_000_000;
        w.tx(() => {
          insertProject(w, { id: "prj", worktree: "/workspace/perf" });
          insertSession(w, {
            id: sid,
            project_id: "prj",
            directory: "/workspace/perf",
            time_created: t0,
            time_updated: t0,
          });
          for (let r = 0; r < ROWS; r++) add(messageText(r), t0 + r);
        });

        const slow = slowLog();
        const opened = await openOpencodeDb(v2.path);
        if (!opened.ok) throw new Error(opened.reason);
        const reader = limitSpy(timedReader(opened.db, slow));
        const rawStoreDb = await openSqlite(join(storeDir, "store.db"));
        if (!rawStoreDb) throw new Error("no sqlite");
        const recorded = recordRowMutations(rawStoreDb);
        const openedStore = openStore(timedStoreDb(recorded.db, slow), {
          host: "opencode-v2",
          source: v2.path,
        });
        if (!openedStore.ok) throw new Error(openedStore.reason);
        const store = openedStore.store;
        /** Writes of the rows: the first write's replace, then the measured
         *  write's replace or append. */
        let writes = 0;
        /** When the measured write began: its first read of the stored card
         *  or rows, or the write itself. */
        let writeStart: number | undefined;
        let writeEnd = 0;
        const startWrite = () => (writeStart ??= performance.now());
        for (const method of ["replaceSessionParts", "appendSessionParts"] as const) {
          const inner = store[method].bind(store) as (...args: unknown[]) => unknown;
          (store as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
            startWrite();
            try {
              return inner(...args);
            } finally {
              writeEnd = performance.now();
              writes++;
            }
          };
        }
        for (const read of ["cardWriteRev", "sessionRows"] as const) {
          const inner = store[read].bind(store) as (...args: unknown[]) => unknown;
          (store as unknown as Record<string, unknown>)[read] = (...args: unknown[]) => {
            startWrite();
            return inner(...args);
          };
        }
        let appends = 0;
        const append = store.appendSessionParts.bind(store);
        store.appendSessionParts = (...args) => {
          appends++;
          return append(...args);
        };
        const distiller = createDistiller({
          source: createV2HistorySource(reader),
          store,
          gate: createFetchGate({ concurrency: DEFAULTS.concurrency }),
          limits: { ...DEFAULTS, coldPass: false, distillDelayMs: 0 },
          instanceId: "perf-v2-diff",
          sync: createV2Sync(reader, { pollIntervalMs: 3_600_000 }),
          projectorGen: V2_PROJECTOR_GEN,
          idleDebounceMs: 1,
          yieldBetween: macrotask,
          log: () => {},
        });
        const probe = stallProbe();
        const results: Record<string, number> = {};
        const load = loadAverage();
        const written = async (count: number, what: string) => {
          const start = performance.now();
          while (writes < count) {
            if (performance.now() - start > 120_000) throw new Error(`no ${what}`);
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        };
        /** The part ids of the rows the write wrote, and of those it changed. */
        let touched = {
          rows: [] as string[] | "session",
          fts: [] as string[] | "session",
          changed: [] as string[],
          changedText: [] as string[],
          expected: [] as unknown[],
        };
        /** The measured write's longest stall. */
        let worst = { from: 0, to: 0 };
        try {
          distiller.start();
          const firstStart = performance.now();
          distiller.onEvent({ type: "turn-ended", sessionID: sid });
          await written(1, "first write");
          results.firstWriteMs = performance.now() - firstStart;
          // A row's text and normalized text together, averaged.
          const rowsRead = store.sessionRows(sid, 0, ROWS);
          results.rowChars =
            rowsRead.reduce((sum, row) => sum + row.raw.length + row.norm.length, 0) /
            rowsRead.length;

          // For a full write, one row among the newest 64 changes, which the
          // checkpoint's fingerprint covers, so the re-read is a full one.
          // Either way one message is added, so the row cap evicts the oldest
          // row.
          const changedText = "rewritten sprocket paragraph";
          if (write === "full") {
            w.run("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?", [
              JSON.stringify(userData(changedText, t0 + ROWS - 10)),
              at + 1,
              `msg_${ROWS - 10}`,
            ]);
          }
          const appended = add(`appended websocket paragraph ${messageText(ROWS)}`, at + 2);
          w.run("UPDATE session_v2 SET time_updated = ? WHERE id = ?", [at + 2, sid]);
          const before = rowsByPart(rawStoreDb, sid);
          writeStart = undefined;
          recorded.record(true);
          probe.reset();
          const redistillStart = performance.now();
          distiller.onEvent({ type: "turn-ended", sessionID: sid });
          await written(2, `${write} write`);
          results.redistillTotalMs = performance.now() - redistillStart;
          results.appends = appends;
          results.writeTotalMs = writeEnd - (writeStart ?? writeEnd);
          // What runs after the write's transaction in the same slice counts
          // toward it, so the window stays open until the re-distill is done.
          await new Promise((resolve) => setTimeout(resolve, 50));
          recorded.record(false);
          Object.assign(results, stallFields("redistill", await probe.stalls()));
          worst = probe.worst();
          Object.assign(
            results,
            stallFields(
              "write",
              await probe.stalls({ from: writeStart ?? writeEnd, to: Infinity }),
            ),
          );
          const after = rowsByPart(rawStoreDb, sid);
          results.storedRows = after.size;
          results.rowMutations = recorded.mutations.length;
          const partOf = (messageId: string) =>
            [...after.values(), ...before.values()].find((row) => row.message_id === messageId)
              ?.part_id;
          touched = {
            rows: touchedParts(recorded.mutations, "part_text", before, after),
            fts: touchedParts(recorded.mutations, "part_fts", before, after),
            changed: changedParts(before, after),
            changedText: changedParts(before, after, ["raw", "norm"]),
            // The evicted oldest row, the appended one and the row before it,
            // whose next pointer now names the appended message. A full write
            // also changes one row and the oldest row left, which names no
            // previous message once the capped read stops at its own.
            expected: (write === "full"
              ? [`msg_1`, `msg_2`, `msg_${ROWS - 10}`, `msg_${ROWS}`, appended]
              : [`msg_1`, `msg_${ROWS}`, appended]
            )
              .map(partOf)
              .sort(),
          };
          const rows = store.sessionRows(sid, 0, ROWS);
          expect(rows[0]?.messageId).toBe("msg_2");
          expect(rows.at(-1)?.messageId).toBe(appended);
          if (write === "full") {
            expect(rows.find((row) => row.messageId === `msg_${ROWS - 10}`)?.raw).toContain(
              changedText,
            );
          }
        } finally {
          await distiller.stop();
          probe.stop();
          reader.close();
          rawStoreDb.close();
        }
        console.log(
          `v2 ${write} write perf, ${kind} rows (load ${load}):`,
          JSON.stringify(rounded(results)),
        );
        console.log("slowest synchronous calls:", JSON.stringify(slow.top(8)));
        console.log(
          `calls around the worst ${write} write stall (ms relative to its start):`,
          JSON.stringify(slow.around(worst)),
        );
        const rowsWritten = touched.rows === "session" ? "session" : touched.rows.length;
        const ftsWritten = touched.fts === "session" ? "session" : touched.fts.length;
        console.log("rows written:", JSON.stringify({ rows: rowsWritten, fts: ftsWritten }));

        expect(results.storedRows).toBe(ROWS);
        expect(results.appends).toBe(write === "append" ? 1 : 0);
        // Only the rows that differ were written, and of those the index
        // entries of the ones whose text differs.
        expect(touched.changed).toEqual(touched.expected);
        expect(touched.rows).toEqual(touched.changed);
        expect(touched.fts).toEqual(touched.changedText);
        expect(results.writeMaxSliceMs).toBeLessThan(DIFF_BUDGET_MS);
        if (write === "full") {
          expect(results.writeTotalMs).toBeLessThan(DIFF_TOTAL_BUDGET_MS);
        } else {
          // An append reads only the appended messages, so the whole
          // re-distill keeps to the slice budget. Its total, which counts the
          // card's inventory derived again over every row it keeps, is
          // logged.
          expect(results.redistillMaxSliceMs).toBeLessThan(DIFF_BUDGET_MS);
        }
      } finally {
        v2.cleanup();
        rmSync(storeDir, { recursive: true, force: true });
      }
    },
    300_000,
  );

  it(`a repair sweep over ${SWEEP_SESSIONS} stale cards in a ${SWEEP_STORE_CARDS}-card store keeps each code slice under ${BUDGET_MS} ms excluding GC pauses`, async () => {
    const v2 = await makeV2PartsDb();
    v2.db.exec("PRAGMA synchronous = OFF");
    const storeDir = mkdtempSync(join(tmpdir(), "recall-perf-v2-sweep-"));
    const slow = slowLog();
    try {
      const at = Date.now();
      // Old enough that no poll window covers it and no reply counts as running.
      const t0 = at - 30 * 86_400_000;
      const w = v2.db;
      /** Each session's first reply, with whether the sweep finds it changed. */
      const firstReply = new Map<string, { id: string; changed: boolean }>();
      w.tx(() => {
        insertProject(w, { id: "prj", worktree: "/workspace/perf" });
        for (let s = 0; s < SWEEP_SESSIONS; s++) {
          const sid = `ses_sweep_${String(s).padStart(4, "0")}`;
          const t = t0 + s * 1_000;
          insertSession(w, {
            id: sid,
            project_id: "prj",
            directory: "/workspace/perf",
            title: `Sweep ${sentence(s, 4)}`,
            time_created: t,
            time_updated: t + 100,
          });
          for (let m = 1; m <= 8; m++) {
            const id = `msg_${sid}_${m}`;
            const mt = t + m;
            if (m % 2 === 1) {
              insertMessage(w, {
                id,
                session_id: sid,
                type: "user",
                seq: m,
                time_created: mt,
                data: userData(sentence(s + m, 30), mt),
              });
              continue;
            }
            const items = [
              textItem(sentence(s + m, 60)),
              toolItem(`call_${sid}_${m}`, `rg ${sentence(m, 3)}`, sentence(s, 80), mt),
              textItem(sentence(s * m, 40)),
            ];
            // One reply keeps its content inline, as opencode wrote it
            // before 2.4; the others are part rows.
            const inline = m === 4;
            insertMessage(w, {
              id,
              session_id: sid,
              type: "assistant",
              seq: m,
              time_created: mt,
              data: replyData(inline ? items : [], mt),
            });
            if (!inline) {
              items.forEach((data, ordinal) =>
                insertPart(w, { message_id: id, session_id: sid, ordinal, time_created: mt, data }),
              );
            }
            if (m === 2) firstReply.set(sid, { id, changed: s % 2 === 0 });
          }
        }
      });

      const fx = await openFixture(v2, storeDir, slow);
      const source = createV2HistorySource(fx.reader);
      const inner = createV2Sync(fx.reader, { pollIntervalMs: 3_600_000 });
      // The filler cards below stand for sessions of a long-used store that
      // this opencode.db does not hold: the deletion reconcile keeps them.
      const sync: DistillSync = { ...inner, missing: async () => [] };
      let onLog: ((line: string) => void) | undefined;
      const logs: string[] = [];
      const running: Distiller[] = [];
      const distiller = (instanceId: string): Distiller => {
        const created = createDistiller({
          source,
          store: fx.store,
          gate: createFetchGate({ concurrency: DEFAULTS.concurrency }),
          limits: { ...DEFAULTS, distillDelayMs: 0 },
          instanceId,
          discover: () => discover(source),
          sync,
          projectorGen: V2_PROJECTOR_GEN,
          yieldBetween: macrotask,
          log: (line) => {
            logs.push(`${instanceId}: ${line}`);
            onLog?.(line);
          },
        });
        running.push(created);
        return created;
      };
      const results: Record<string, number> = {};
      const marks: Record<string, number> = {};
      const probe = stallProbe();
      let load = "";
      try {
        // 1. Every card built at the current generation.
        const builder = distiller("perf-v2-sweep-build");
        builder.start();
        await until(
          () => builder.status().coldPass === "done" && builder.repair()?.sweep?.running === false,
          "the first build",
        );
        await builder.stop();
        running.splice(running.indexOf(builder), 1);

        // 2. The rest of a long-used store: cards at the current generation
        // for sessions the sweep never reads.
        const corpus = perfCorpus({ now: at });
        for (let i = 0; i < SWEEP_STORE_CARDS - SWEEP_SESSIONS; i++) {
          fx.store.replaceSessionParts(corpus.id(i), [], {
            ...corpus.card(i),
            projectorGen: V2_PROJECTOR_GEN,
          });
        }

        // 3. Content an older build never read: a new part row on half the
        // first replies. Then every sweep card as an older build leaves it,
        // with no generation and no range hashes.
        w.tx(() => {
          for (const [sid, reply] of firstReply) {
            if (!reply.changed) continue;
            insertPart(w, {
              message_id: reply.id,
              session_id: sid,
              ordinal: 3,
              time_created: t0,
              data: textItem(`a late part ${sentence(7, 20)}`),
            });
          }
        });
        for (const sid of firstReply.keys()) {
          fx.storeDb.run("UPDATE card SET projector_gen = NULL WHERE session_id = ?", [sid]);
          fx.store.clearRangeHashes(sid);
        }
        expect(fx.store.staleCards(V2_PROJECTOR_GEN)).toHaveLength(SWEEP_SESSIONS);

        // 4. A new distiller. Its cold pass leaves the stale cards to the
        // sweep that follows it; the sweep is measured from the pass's end.
        let revAtSweepStart = 0;
        onLog = (line) => {
          if (line.includes("] cold pass done")) {
            marks.coldDone = performance.now();
            marks.coldMaxStall = probe.max();
            revAtSweepStart = fx.store.cardStats().cardsRev;
            probe.reset();
          } else if (line.includes("] repair sweep done")) {
            marks.sweepDone = performance.now();
          }
        };
        const sweeper = distiller("perf-v2-sweep");
        load = loadAverage();
        probe.reset();
        const start = performance.now();
        sweeper.start();
        await until(() => marks.sweepDone !== undefined, "the sweep");
        results.coldPassMs = marks.coldDone! - start;
        results.coldPassMaxStallMs = marks.coldMaxStall!;
        results.sweepTotalMs = marks.sweepDone! - marks.coldDone!;
        Object.assign(
          results,
          stallFields("sweep", await probe.stalls({ from: marks.coldDone!, to: marks.sweepDone! })),
        );
        results.rebuilt = sweeper.repair()?.sweep?.done ?? -1;
        results.changedWrites = fx.store.cardStats().cardsRev - revAtSweepStart;
        results.stillStale = fx.store.staleCards(V2_PROJECTOR_GEN).length;
        results.cards = fx.store.cardCount();
      } catch (error) {
        console.log("distiller log:", JSON.stringify(logs.slice(-30)));
        throw error;
      } finally {
        await Promise.all(running.map((d) => d.stop()));
        probe.stop();
        fx.close();
      }

      console.log(`v2 repair sweep perf (load ${load}):`, JSON.stringify(rounded(results)));
      if (marks.sweepDone !== undefined) {
        console.log(
          "slowest synchronous calls in the sweep:",
          JSON.stringify(slow.topIn({ from: marks.coldDone!, to: marks.sweepDone }, 8)),
        );
      }

      expect(results.cards).toBe(SWEEP_STORE_CARDS);
      expect(results.rebuilt).toBe(SWEEP_SESSIONS);
      expect(results.stillStale).toBe(0);
      // Only the sessions with new content changed what readers see; the
      // rest were suppressed writes.
      expect(results.changedWrites).toBe(SWEEP_SESSIONS / 2);
      expect(results.sweepTotalMs).toBeLessThan(SWEEP_TOTAL_BUDGET_MS);
      expect(results.sweepMaxSliceMs).toBeLessThan(BUDGET_MS);
    } finally {
      v2.cleanup();
      rmSync(storeDir, { recursive: true, force: true });
    }
  }, 900_000);

  it(`a child write and a child deletion in a ${SWEEP_STORE_CARDS}-card store keep each code slice under ${BUDGET_MS} ms excluding GC pauses`, async () => {
    const v2 = await makeV2PartsDb();
    v2.db.exec("PRAGMA synchronous = OFF");
    const storeDir = mkdtempSync(join(tmpdir(), "recall-perf-v2-child-"));
    const slow = slowLog();
    try {
      const at = Date.now();
      const t0 = at - 2 * 86_400_000;
      const w = v2.db;
      const root = "ses_family_root";
      const child = "ses_family_child";
      let seq = 0;
      const say = (sid: string, text: string, t: number): string => {
        const id = `msg_${sid}_${++seq}`;
        insertMessage(w, {
          id,
          session_id: sid,
          type: "user",
          seq,
          time_created: t,
          data: userData(text, t),
        });
        return id;
      };
      w.tx(() => {
        insertProject(w, { id: "prj", worktree: "/workspace/perf" });
        for (const [sid, parent] of [
          [root, null],
          [child, root],
        ] as const) {
          insertSession(w, {
            id: sid,
            project_id: "prj",
            directory: "/workspace/perf",
            parent_id: parent,
            title: `Family ${sid}`,
            time_created: t0,
            time_updated: t0 + 10,
          });
          for (let m = 0; m < 4; m++) say(sid, sentence(m, 30), t0 + m);
        }
      });

      const fx = await openFixture(v2, storeDir, slow);
      const source = createV2HistorySource(fx.reader);
      const inner = createV2Sync(fx.reader, { pollIntervalMs: 3_600_000 });
      // The filler cards stand for sessions this opencode.db does not hold.
      const sync: DistillSync = { ...inner, missing: async () => [] };
      const logs: string[] = [];
      const distiller = createDistiller({
        source,
        store: fx.store,
        gate: createFetchGate({ concurrency: DEFAULTS.concurrency }),
        limits: { ...DEFAULTS, distillDelayMs: 0 },
        instanceId: "perf-v2-child",
        discover: () => discover(source),
        sync,
        projectorGen: V2_PROJECTOR_GEN,
        idleDebounceMs: 1,
        yieldBetween: macrotask,
        log: (line) => logs.push(line),
      });
      const rollup = () => fx.store.getCard(root)?.familyRollup ?? [];
      const results: Record<string, number> = {};
      const windows: Record<string, { from: number; to: number }> = {};
      const probe = stallProbe();
      let load = "";
      try {
        distiller.start();
        await until(
          () =>
            distiller.status().coldPass === "done" && distiller.repair()?.sweep?.running !== true,
          "the first build",
        );
        expect(rollup().map((entry) => entry.sessionId)).toEqual([child]);

        // The rest of a long-used store, the root's other children among it,
        // all older than the child's next message.
        const corpus = perfCorpus({ now: t0 });
        for (let i = 0; i < SWEEP_STORE_CARDS - 2; i++) {
          const card = { ...corpus.card(i), projectorGen: V2_PROJECTOR_GEN };
          const member = i < FAMILY_CHILDREN ? { rootId: root, parentId: root } : {};
          fx.store.replaceSessionParts(corpus.id(i), [], { ...card, ...member });
        }
        load = loadAverage();

        // The child gets a message: its write recomputes the root's rollup.
        const message = say(child, sentence(9, 30), at);
        w.run("UPDATE session_v2 SET time_updated = ? WHERE id = ?", [at, child]);
        probe.reset();
        let start = performance.now();
        distiller.onEvent({ type: "turn-ended", sessionID: child });
        await until(
          () => rollup()[0]?.sessionId === child && rollup()[0]?.messageId === message,
          "the child write",
        );
        windows.write = { from: start, to: performance.now() };
        results.writeTotalMs = windows.write.to - start;
        Object.assign(results, stallFields("write", await probe.stalls(windows.write)));
        results.writeRollup = rollup().length;

        // The child is deleted: the root's rollup is recomputed without it.
        probe.reset();
        start = performance.now();
        distiller.onEvent({ type: "deleted", sessionID: child });
        await until(
          () => rollup().length > 0 && rollup().every((entry) => entry.sessionId !== child),
          "the child deletion",
        );
        windows.delete = { from: start, to: performance.now() };
        results.deleteTotalMs = windows.delete.to - start;
        Object.assign(results, stallFields("delete", await probe.stalls(windows.delete)));
        results.deleteRollup = rollup().length;
        results.cards = fx.store.cardCount();
      } catch (error) {
        console.log("distiller log:", JSON.stringify(logs.slice(-30)));
        throw error;
      } finally {
        await distiller.stop();
        probe.stop();
        fx.close();
      }

      console.log(
        `v2 child write and deletion perf (load ${load}):`,
        JSON.stringify(rounded(results)),
      );
      for (const [name, window] of Object.entries(windows)) {
        console.log(
          `slowest synchronous calls in the ${name}:`,
          JSON.stringify(slow.topIn(window, 6)),
        );
      }

      expect(results.cards).toBe(SWEEP_STORE_CARDS - 1);
      expect(results.writeRollup).toBe(12);
      expect(results.deleteRollup).toBe(12);
      expect(results.writeMaxSliceMs).toBeLessThan(BUDGET_MS);
      expect(results.deleteMaxSliceMs).toBeLessThan(BUDGET_MS);
      expect(results.writeTotalMs).toBeLessThan(CHILD_TOTAL_BUDGET_MS);
      expect(results.deleteTotalMs).toBeLessThan(CHILD_TOTAL_BUDGET_MS);
    } finally {
      v2.cleanup();
      rmSync(storeDir, { recursive: true, force: true });
    }
  }, 600_000);

  it(`paged discovery of ${DISCOVERY_SESSIONS} sessions and a ${ROOT_CHILDREN}-child root keep each code slice under ${BUDGET_MS} ms excluding GC pauses`, async () => {
    const v2 = await makeV2PartsDb();
    v2.db.exec("PRAGMA synchronous = OFF");
    const slow = slowLog();
    try {
      const at = Date.now();
      const w = v2.db;
      let archived = 0;
      w.tx(() => {
        insertProject(w, { id: "prj", worktree: "/workspace/perf" });
        const add = (id: string, i: number, parent: string | null) => {
          const t = at - 90 * 86_400_000 + i * 60_000;
          // One in twenty archived: discovery includes them.
          const archive = i % 20 === 0;
          if (archive) archived++;
          insertSession(w, {
            id,
            project_id: "prj",
            directory: `/workspace/perf/${i % 12}`,
            parent_id: parent,
            title: `${sentence(i, 6)} ${i}`,
            time_created: t,
            time_updated: t + 30_000,
            time_archived: archive ? t + 60_000 : null,
          });
        };
        add("ses_root", 0, null);
        for (let c = 0; c < ROOT_CHILDREN; c++) {
          add(`ses_${(c * 7_919).toString(36).padStart(5, "0")}_child`, c + 1, "ses_root");
        }
        for (let s = 0; s < DISCOVERY_SESSIONS - ROOT_CHILDREN - 1; s++) {
          add(
            `ses_${(s * 104_729).toString(36).padStart(6, "0")}_solo`,
            ROOT_CHILDREN + 1 + s,
            null,
          );
        }
      });
      const opened = await openOpencodeDb(v2.path);
      if (!opened.ok) throw new Error(opened.reason);
      const reader = limitSpy(timedReader(opened.db, slow));
      const source = createV2HistorySource(reader);
      const results: Record<string, number> = {};
      const probe = stallProbe();
      const load = loadAverage();
      try {
        probe.reset();
        let start = performance.now();
        const sessions = await discover(source);
        results.discoveryTotalMs = performance.now() - start;
        Object.assign(results, stallFields("discovery", await probe.stalls()));
        results.listed = sessions.length;
        results.distinct = new Set(sessions.map((s) => s.id)).size;
        results.archived = sessions.filter((s) => s.time.archived != null).length;

        // The children as `recall_sessions` lists them for a parent.
        probe.reset();
        start = performance.now();
        const children = await listAllChildren(source, "ses_root");
        results.childrenTotalMs = performance.now() - start;
        Object.assign(results, stallFields("children", await probe.stalls()));
        if (!children.ok) throw new Error(children.error);
        results.children = children.items.length;
        results.childrenTruncated = children.truncated ? 1 : 0;
      } finally {
        probe.stop();
        reader.close();
      }

      console.log(`v2 paged discovery perf (load ${load}):`, JSON.stringify(rounded(results)));
      console.log("slowest synchronous calls:", JSON.stringify(slow.top(4)));

      expect(results.listed).toBe(DISCOVERY_SESSIONS);
      expect(results.distinct).toBe(DISCOVERY_SESSIONS);
      expect(results.archived).toBe(archived);
      expect(results.children).toBe(ROOT_CHILDREN);
      expect(results.childrenTruncated).toBe(0);
      expect(results.discoveryMaxSliceMs).toBeLessThan(BUDGET_MS);
      expect(results.childrenMaxSliceMs).toBeLessThan(BUDGET_MS);
      expect(results.discoveryTotalMs).toBeLessThan(LISTING_TOTAL_BUDGET_MS);
      expect(results.childrenTotalMs).toBeLessThan(LISTING_TOTAL_BUDGET_MS);
    } finally {
      v2.cleanup();
    }
  }, 300_000);

  it(`one range check over a ${RANGE_SESSION_ROWS}-row session keeps each code slice under ${BUDGET_MS} ms excluding GC pauses`, async () => {
    const v2 = await makeV2PartsDb();
    v2.db.exec("PRAGMA synchronous = OFF");
    const storeDir = mkdtempSync(join(tmpdir(), "recall-perf-v2-range-"));
    const slow = slowLog();
    try {
      const at = Date.now();
      const t0 = at - 30 * 86_400_000;
      const w = v2.db;
      const sid = "ses_range";
      w.tx(() => {
        insertProject(w, { id: "prj", worktree: "/workspace/perf" });
        insertSession(w, {
          id: sid,
          project_id: "prj",
          directory: "/workspace/perf",
          time_created: t0,
          time_updated: t0 + RANGE_SESSION_ROWS,
        });
        for (let seq = 1; seq <= RANGE_SESSION_ROWS; seq++) {
          const id = `msg_${seq}`;
          const t = t0 + seq;
          if (seq % 2 === 1) {
            insertMessage(w, {
              id,
              session_id: sid,
              type: "user",
              seq,
              time_created: t,
              data: userData(sentence(seq, 30), t),
            });
            continue;
          }
          insertMessage(w, {
            id,
            session_id: sid,
            type: "assistant",
            seq,
            time_created: t,
            data: replyData([], t),
          });
          insertPart(w, {
            message_id: id,
            session_id: sid,
            ordinal: 0,
            time_created: t,
            data: textItem(sentence(seq, 60)),
          });
          insertPart(w, {
            message_id: id,
            session_id: sid,
            ordinal: 1,
            time_created: t,
            data: toolItem(`call_${seq}`, `rg ${sentence(seq, 3)}`, sentence(seq, 80), t),
          });
        }
      });

      const fx = await openFixture(v2, storeDir, slow);
      const source = createV2HistorySource(fx.reader);
      const options: V2SyncOptions = { pollIntervalMs: 200, reconcileEveryMs: 1e12 };
      const inner = createV2Sync(fx.reader, options);
      /** One range check: from the end of the poll before it to its saved
       *  progress, with its digest read. */
      type Check = {
        from: number;
        digestStart: number;
        digestEnd: number;
        rows: number;
        saved: number;
      };
      const checks: Check[] = [];
      let checking = false;
      let pollEnd = 0;
      const sync: DistillSync = {
        ...inner,
        rangeDigest: async (id, after, limit) => {
          // Digests before `checking` are the first build's own and those of
          // checks that ran before the measurement started.
          const check: Check | undefined = checking
            ? { from: pollEnd, digestStart: performance.now(), digestEnd: 0, rows: 0, saved: 0 }
            : undefined;
          if (check) checks.push(check);
          const rows = await inner.rangeDigest!(id, after, limit);
          if (check) {
            check.digestEnd = performance.now();
            check.rows = rows.length;
          }
          return rows;
        },
        poll: async (meta) => {
          const result = await inner.poll(meta);
          pollEnd = performance.now();
          return result;
        },
      };
      const setMeta = fx.store.setMeta.bind(fx.store);
      fx.store.setMeta = (key, value) => {
        setMeta(key, value);
        const last = checks[checks.length - 1];
        if (key === RECONCILE_PROGRESS_KEY && last && last.saved === 0)
          last.saved = performance.now();
      };
      const logs: string[] = [];
      const distiller = createDistiller({
        source,
        store: fx.store,
        gate: createFetchGate({ concurrency: DEFAULTS.concurrency }),
        limits: { ...DEFAULTS, distillDelayMs: 0 },
        instanceId: "perf-v2-range",
        discover: () => discover(source),
        sync,
        projectorGen: V2_PROJECTOR_GEN,
        yieldBetween: macrotask,
        log: (line) => logs.push(line),
      });
      const probe = stallProbe();
      const load = loadAverage();
      const results: Record<string, number> = {};
      const measuredChecks: Array<{ totalMs: number; digestMs: number } & Stalls> = [];
      let span = { from: 0, to: 0 };
      try {
        distiller.start();
        await until(
          () =>
            distiller.status().coldPass === "done" && distiller.repair()?.sweep?.running === false,
          "the first build",
        );
        probe.reset();
        checking = true;
        await until(
          () => checks.filter((c) => c.saved > 0).length >= RANGE_CHECKS,
          "the range checks",
        );
        await distiller.stop();
        const done = checks.filter((c) => c.saved > 0).slice(0, RANGE_CHECKS);
        span = { from: done[0]!.from, to: done[done.length - 1]!.saved };
        for (const check of done) {
          const stalls = await probe.stalls({ from: check.from, to: check.saved });
          measuredChecks.push({
            totalMs: check.saved - check.digestStart,
            digestMs: check.digestEnd - check.digestStart,
            ...stalls,
          });
          results.rows = check.rows;
        }
      } finally {
        await distiller.stop();
        probe.stop();
        fx.close();
      }
      const worst = (pick: (c: (typeof measuredChecks)[number]) => number): number =>
        Math.max(...measuredChecks.map(pick));
      const median = (pick: (c: (typeof measuredChecks)[number]) => number): number =>
        [...measuredChecks.map(pick)].sort((a, b) => a - b)[Math.floor(measuredChecks.length / 2)]!;
      Object.assign(results, {
        checks: measuredChecks.length,
        checkMedianMs: median((c) => c.totalMs),
        checkMaxMs: worst((c) => c.totalMs),
        digestMedianMs: median((c) => c.digestMs),
        digestMaxMs: worst((c) => c.digestMs),
        checkMaxSliceMs: worst((c) => c.maxOutsideGcMs),
        checkMaxStallMs: worst((c) => c.maxMs),
        checkMaxGcPauseMs: worst((c) => c.maxGcMs),
        reindexed: logs.filter((line) => line.includes("re-indexing")).length,
      });

      console.log(`v2 range check perf (load ${load}):`, JSON.stringify(rounded(results)));
      console.log(
        "slowest synchronous calls while the checks ran:",
        JSON.stringify(slow.topIn(span, 4)),
      );

      expect(results.checks).toBe(RANGE_CHECKS);
      expect(results.rows).toBe(RANGE_SESSION_ROWS);
      expect(results.reindexed).toBe(0);
      expect(results.checkMaxSliceMs).toBeLessThan(BUDGET_MS);
      expect(results.checkMaxMs).toBeLessThan(RANGE_CHECK_TOTAL_BUDGET_MS);
    } finally {
      v2.cleanup();
      rmSync(storeDir, { recursive: true, force: true });
    }
  }, 300_000);

  it(`the first search after a restart over ${FIRST_SEARCH_SESSIONS} sessions takes under ${FIRST_SEARCH_SLOWDOWN_MAX} times as long during a cold pass, keeping each code slice under ${BUDGET_MS} ms excluding GC pauses`, async () => {
    const v2 = await makeV2PartsDb();
    v2.db.exec("PRAGMA synchronous = OFF");
    const storeDir = mkdtempSync(join(tmpdir(), "recall-perf-v2-first-"));
    const storePath = join(storeDir, "store.db");
    const running: V2Runtime[] = [];
    Object.assign(history, { spied: true, reads: 0, violations: [] });
    try {
      const at = Date.now();
      const corpus = perfCorpus({ now: at });
      const t0 = at - 30 * 86_400_000;
      const w = v2.db;
      // Each session's text holds a perfCorpus card's, so the distiller
      // derives cards of realistic size and the first search builds an index
      // over them.
      w.tx(() => {
        insertProject(w, { id: "prj", worktree: "/workspace/perf" });
        for (let i = 0; i < FIRST_SEARCH_SESSIONS; i++) {
          const sid = corpus.id(i);
          const card = corpus.card(i);
          const t = t0 + i * 10;
          insertSession(w, {
            id: sid,
            project_id: "prj",
            directory: "/workspace/perf",
            title: card.title,
            time_created: t,
            time_updated: t + 5,
          });
          insertMessage(w, {
            id: `msg_${sid}_1`,
            session_id: sid,
            type: "user",
            seq: 1,
            time_created: t + 1,
            data: userData(`${card.summaryHead} ${card.files.join(" ")}`, t + 1),
          });
          insertMessage(w, {
            id: `msg_${sid}_2`,
            session_id: sid,
            type: "assistant",
            seq: 2,
            time_created: t + 2,
            data: replyData([textItem(`${card.outcomeHead} ${card.inventory}`)], t + 2),
          });
        }
      });
      /** A runtime as the plugin creates it, with the cold pass on or off. */
      const open = async (coldPass: boolean): Promise<V2Runtime> => {
        const factory = v2RuntimeFactory({
          options: {
            ephemeral: false,
            storePath,
            opencodeDbPath: v2.path,
            semantic: undefined,
            limits: { ...DEFAULTS, coldPass },
            summaries: false,
          },
          channel: "latest",
          log: () => {},
        });
        const runtime = await factory.create(await factory.resolve());
        running.push(runtime);
        return runtime;
      };
      const close = async (runtime: V2Runtime): Promise<void> => {
        running.splice(running.indexOf(runtime), 1);
        await runtime.dispose();
      };
      const firstSearch = async (runtime: V2Runtime): Promise<SearchOutput> => {
        const tool = search(runtime.sourceFor("prj"), true, runtime.options.limits, runtime.deps);
        const text = toolResultText(
          await tool.execute(
            { query: corpus.query(0), scope: "global" } as never,
            makeContext().ctx,
          ),
        );
        return JSON.parse(text) as SearchOutput;
      };

      // 1. Every session indexed.
      const results: Record<string, number> = {};
      let start = performance.now();
      const builder = await open(true);
      await until(
        () =>
          builder.distiller.status().coldPass === "done" &&
          builder.repair()?.sweep?.running !== true,
        "the first build",
      );
      results.buildMs = performance.now() - start;
      await close(builder);

      // 2. Every checkpoint cleared, so the next cold pass re-reads and
      // re-derives each session: more work than the search's card build, as
      // a long-used store's pass over thousands of real sessions is.
      const raw = await openSqlite(storePath);
      if (!raw) throw new Error("no sqlite");
      raw.run("UPDATE card SET distill_cursor = NULL", []);
      raw.close();

      const probe = stallProbe();
      const load = loadAverage();
      try {
        // 3. The first search of a runtime that runs no cold pass.
        const quiet = await open(false);
        probe.reset();
        start = performance.now();
        const alone = await firstSearch(quiet);
        results.aloneMs = performance.now() - start;
        Object.assign(results, stallFields("alone", await probe.stalls()));
        results.aloneOk = alone.ok ? 1 : 0;
        await close(quiet);

        // 4. The first search of a runtime whose cold pass is under way.
        start = performance.now();
        const busy = await open(true);
        await until(
          () =>
            busy.distiller.status().coldPass === "running" &&
            busy.distiller.status().examinedCount > 0,
          "the cold pass",
        );
        results.coldPassStartMs = performance.now() - start;
        const examinedBefore = busy.distiller.status().examinedCount;
        probe.reset();
        start = performance.now();
        const during = await firstSearch(busy);
        results.duringMs = performance.now() - start;
        Object.assign(results, stallFields("during", await probe.stalls()));
        results.duringOk = during.ok ? 1 : 0;
        results.examinedDuring = busy.distiller.status().examinedCount - examinedBefore;
        start = performance.now();
        await until(() => busy.distiller.status().coldPass === "done", "the cold pass");
        results.coldPassRestMs = performance.now() - start;
        results.examined = busy.distiller.status().examinedCount;
        results.slowdown = results.duringMs / results.aloneMs;
      } finally {
        probe.stop();
      }

      console.log(`v2 first search perf (load ${load}):`, JSON.stringify(rounded(results)));

      // Every history statement the runtimes ran passed the LIMIT spy.
      expect(history.reads).toBeGreaterThan(0);
      expect(history.violations).toEqual([]);
      expect(results.aloneOk).toBe(1);
      expect(results.duringOk).toBe(1);
      // The pass slowed down during the search but kept going, then finished.
      expect(results.examinedDuring).toBeGreaterThan(0);
      expect(results.examined).toBe(FIRST_SEARCH_SESSIONS);
      expect(results.slowdown).toBeLessThan(FIRST_SEARCH_SLOWDOWN_MAX);
      expect(results.aloneMaxSliceMs).toBeLessThan(BUDGET_MS);
      expect(results.duringMaxSliceMs).toBeLessThan(BUDGET_MS);
    } finally {
      await Promise.all(running.map((runtime) => runtime.dispose()));
      history.spied = false;
      v2.cleanup();
      rmSync(storeDir, { recursive: true, force: true });
    }
  }, 900_000);
});
