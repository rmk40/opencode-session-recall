/**
 * v2 event-loop stall gate, gated behind RECALL_PERF=1
 * like test/perf.test.ts:
 *
 *     RECALL_PERF=1 npx vitest run test/perf-v2.test.ts
 *
 * On opencode v2 the plugin runs inside the shared service process, so a long
 * synchronous slice stalls every session, not just one TUI. This builds a
 * large synthetic opencode v2 database (thousands of small sessions, a few
 * 4,000-row sessions, and some multi-megabyte rows, including rows over the
 * page byte ceiling), then measures the longest gap a `setInterval(0)` probe
 * sees during a full v2 cold pass, one poll cycle, a `listSessions` call, and
 * an append re-distill of a 4,000-row session (distillAppend derives the merged
 * card synchronously inside the store transaction, over every retained row).
 * Budget: no slice over 50 ms.
 *
 * When the budget fails the report names the slowest synchronous calls it
 * could attribute (opencode.db statements and store transactions) and the
 * calls inside the worst stall, so the offending path is visible rather than
 * the budget being loosened.
 *
 * Status (2026-09-28, Apple Silicon, Node): all three pass. The cold pass
 * peaks at 38 to 48 ms, now set by one 4,000-row replaceSessionParts
 * transaction (32 to 46 ms), which stays whole for per-session atomicity;
 * the derivation yields cooperatively (deriveCardCooperative). The poll
 * peaks near 3 ms and listSessions under 12 ms. Before the cooperative
 * derivation the cold pass peaked at 93 to 153 ms. The append of 200 rows to
 * a 4,002-part session peaks at 37.6 to 41.3 ms, set by its one
 * appendSessionParts transaction (36 to 39 ms); the whole append takes about
 * 110 ms.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDistiller, type PollMeta } from "../src/distill.js";
import { createFetchGate } from "../src/fetch-gate.js";
import { openStore } from "../src/store.js";
import { openSqlite, type ReadOnlyDb, type SqliteDb } from "../src/sqlite.js";
import { createV2HistorySource, openOpencodeDb } from "../src/history/v2.js";
import { V2_PROJECTOR_GEN } from "../src/history/v2-project.js";
import {
  createV2Sync,
  POLL_CURSOR_KEY,
  POLL_WATERMARK_KEY,
  SESSION_CURSOR_KEY,
  SESSION_WATERMARK_KEY,
} from "../src/history/v2-sync.js";
import { DEFAULTS, DISCOVERY_LIMIT } from "../src/types.js";
import { insertProject, insertSession, makeV2Db } from "./v2-db.js";

const ENABLED = process.env.RECALL_PERF === "1";
const BUDGET_MS = 50;

const SMALL_SESSIONS = 3_000;
const RECENT_SESSIONS = 600;
const BIG_SESSIONS = 3;
const BIG_SESSION_ROWS = 4_000;
const LOADED_HUGE_ROW_BYTES = 3 * 1024 * 1024; // under the 4 MiB page ceiling
const OVERSIZED_ROW_BYTES = 6 * 1024 * 1024; // over it: a placeholder
const APPEND_ROWS = 200;

type SlowCall = { what: string; ms: number };

/** The longest gap between ticks of a 0 ms interval while it runs, and
 *  where it was (start and end times). */
function stallProbe(): {
  reset(): void;
  max(): number;
  worst(): { from: number; to: number };
  stop(): void;
} {
  let last = performance.now();
  let max = 0;
  let worst = { from: 0, to: 0 };
  const timer = setInterval(() => {
    const now = performance.now();
    if (now - last > max) {
      max = now - last;
      worst = { from: last, to: now };
    }
    last = now;
  }, 0);
  return {
    reset() {
      max = 0;
      last = performance.now();
    },
    max: () => max,
    worst: () => worst,
    stop: () => clearInterval(timer),
  };
}

/** Record every synchronous call: the slowest, and a timeline to place the
 *  worst stall (calls that ran inside it, and the last one before it). */
function slowLog(): {
  note(what: string, ms: number): void;
  top(n: number): SlowCall[];
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

describe.skipIf(!ENABLED)("perf: v2 event-loop stalls", () => {
  it(`cold pass, one poll, listSessions and an append never block the loop over ${BUDGET_MS} ms`, async () => {
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
        results.coldPassMaxSliceMs = probe.max();
        coldWorst = probe.worst();
        results.coldPassTotalMs = performance.now() - coldStart;
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
        results.pollMaxSliceMs = probe.max();
        results.pollTotalMs = performance.now() - pollStart;
        results.pollSignals = signals.length;

        // ── listSessions ──
        probe.reset();
        const listStart = performance.now();
        const listing = await source.listSessions({ scope: "global", limit: DISCOVERY_LIMIT });
        results.listMaxSliceMs = probe.max();
        results.listTotalMs = performance.now() - listStart;
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
        results.appendMaxSliceMs = probe.max();
        appendWorst = probe.worst();
        results.appendTotalMs = performance.now() - appendStart;
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
        "v2 perf:",
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

  it(`a tail write over a 5,000-row card never blocks the loop over ${BUDGET_MS} ms`, async () => {
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
        results.tailWriteMaxSliceMs = probe.max();

        // Nothing changed: no write at all.
        probe.reset();
        const quietStart = performance.now();
        distiller.onEvent({ type: "turn-ended", sessionID: sid });
        await new Promise((resolve) => setTimeout(resolve, 200));
        results.unchangedMaxSliceMs = probe.max();
        results.unchangedWindowMs = performance.now() - quietStart;
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
        "v2 tail write perf:",
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
});
