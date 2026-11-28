import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_ID } from "../src/build-id.js";
import type { CardVectorWriteResult } from "../src/cards.js";
import { LEASE_TTL_MS } from "../src/distill.js";
import { openSqlite } from "../src/sqlite.js";
import { openStore, VECTORS_REV_KEY, type LeaseInfo } from "../src/store.js";
import {
  createWorkerController,
  type WorkerController,
  type WorkerControllerOptions,
} from "../src/worker/controller.js";
import type { EventsMessage, WorkerStatus } from "../src/worker/protocol.js";
import { insertProject, insertSession, makeV2PartsDb, type V2TestDb } from "./v2-db.js";
import {
  harnessController,
  scriptedWorkers,
  workerHarness,
  workerInit,
  type ScriptedWorker,
} from "./worker-harness.js";

/**
 * Main's side of the worker (`createWorkerController`): how it starts each
 * generation and times it out, what counts as a failure, how it restarts and
 * when it gives up (inline) or stops for good, its watchdog, its vector
 * writes and signal posts, and how it stops. Scripted workers under fake
 * timers drive one event at a time; the inline harness, over a real store,
 * covers crashes inside and around a commit.
 */

// ── Scripted workers under fake timers ──────────────────────────────────────

type Recorded = {
  storeOpens: Array<string | undefined>;
  stopped: string[];
  inline: Array<{ reason: string; takeOver: readonly string[] }>;
  logs: string[];
  statuses: WorkerStatus[];
};

const INIT = workerInit({ storePath: "/scratch/store.db", sourcePath: "/scratch/opencode.db" });

function scriptedController(
  overrides: Partial<WorkerControllerOptions> = {},
  /** Starts that reject, from generation 1 on. */
  failStarts = 0,
): {
  controller: WorkerController;
  scripted: ReturnType<typeof scriptedWorkers>;
  record: Recorded;
} {
  const scripted = scriptedWorkers();
  scripted.failStarts(failStarts);
  const record: Recorded = { storeOpens: [], stopped: [], inline: [], logs: [], statuses: [] };
  const controller = createWorkerController({
    start: scripted.start,
    instanceId: "inst",
    init: INIT,
    log: (line) => record.logs.push(line),
    onStoreOpen: async (warning) => {
      record.storeOpens.push(warning);
      return { ok: true };
    },
    onStopped: (reason) => record.stopped.push(reason),
    onInline: (reason, takeOver) => record.inline.push({ reason, takeOver }),
    onStatus: (status) => record.statuses.push(status),
    readLease: () => undefined,
    ...overrides,
  });
  return { controller, scripted, record };
}

/** Run what is due now and the promise chains it starts. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Settle-state of a promise, without waiting for it. */
function tracked<T>(promise: Promise<T>): { settled: boolean; value?: T } {
  const state: { settled: boolean; value?: T } = { settled: false };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

async function ready(worker: ScriptedWorker, buildId = BUILD_ID): Promise<void> {
  worker.emit({ type: "ready", buildId });
  await flush();
}

/** Ready, init and a store result that opens: the generation runs. */
async function run(worker: ScriptedWorker, warning?: string): Promise<void> {
  await ready(worker);
  const init = worker.last("init");
  if (!init) throw new Error("no init was sent");
  worker.emit({
    type: "store",
    id: init.id,
    ok: true,
    ...(warning !== undefined && { warning }),
  });
  await flush();
}

function status(over: { leaseHeld?: boolean; holderId?: string } = {}): WorkerStatus {
  return {
    holderId: over.holderId ?? "inst/w1",
    distill: {
      leaseHeld: over.leaseHeld ?? true,
      coldPass: "done",
      distilledCount: 0,
      knownCount: 0,
      examinedCount: 0,
      quarantinedCount: 0,
      skippedCount: 0,
      failingCount: 0,
    },
    discoveryTruncated: false,
    longestStoreCallMs: 0,
  };
}

/** A lease row whose heartbeat is `age` ms old whenever it is read. */
function leaseOf(holder: string, age: number, ttl = LEASE_TTL_MS): () => LeaseInfo {
  return () => ({ holder, build: "b", gen: 1, heartbeat: Date.now() - age, ttl });
}

const failures = (record: Recorded): string[] =>
  record.logs.filter((line) => /^worker generation \d+ failed/.test(line));

describe("the controller with scripted workers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("starting a generation", () => {
    it("starts generation 1 at creation, as <instanceId>/w1, and sends init only after ready", async () => {
      const { controller, scripted } = scriptedController();
      await flush();
      expect(scripted.workers).toHaveLength(1);
      expect(controller.generation()).toBe(1);
      expect(controller.holderId()).toBe("inst/w1");
      expect(controller.mode()).toEqual({ kind: "worker" });
      const worker = scripted.worker(1);
      expect(worker.received).toEqual([]);

      await ready(worker);
      const init = worker.last("init");
      expect(init).toMatchObject({ ...INIT, type: "init", generation: 1, holderId: "inst/w1" });
      expect(init).not.toHaveProperty("takeOver");
      expect(init?.deadline).toBe(Date.now() + 10_000);
    });

    it("fails a generation that reports no ready within 10 s of its start", async () => {
      const { scripted, record } = scriptedController();
      await flush();
      await advance(9_999);
      expect(scripted.worker(1).terminations).toBe(0);
      await advance(1);
      expect(scripted.worker(1).terminations).toBe(1);
      expect(failures(record)).toEqual([
        "worker generation 1 failed (1 of 3): no ready within 10000 ms of starting",
      ]);
    });

    it("fails a generation that reports no store result within 10 s of init", async () => {
      const { scripted, record } = scriptedController();
      await flush();
      await advance(5_000);
      await ready(scripted.worker(1));
      await advance(9_999);
      expect(scripted.worker(1).terminations).toBe(0);
      await advance(1);
      expect(scripted.worker(1).terminations).toBe(1);
      expect(failures(record)).toEqual([
        "worker generation 1 failed (1 of 3): no store result within 10000 ms of init",
      ]);
    });

    it("takes a worker's wait for the store lock as no failure, moving its store deadline past each wait", async () => {
      const waits: string[] = [];
      const { controller, scripted, record } = scriptedController({
        onWaiting: (reason) => waits.push(reason),
      });
      await flush();
      await ready(scripted.worker(1));
      await advance(9_000);
      const reason = "another process holds the store's write lock";
      scripted.worker(1).emit({ type: "waiting", reason, attempt: 1, retryInMs: 30_000 });
      await flush();
      expect(controller.mode()).toEqual({ kind: "worker", detail: `waiting (${reason})` });
      expect(waits).toEqual([reason]);
      // Past init's 10 s deadline, and still within the wait it announced.
      await advance(39_000);
      expect(scripted.worker(1).terminations).toBe(0);
      expect(failures(record)).toEqual([]);

      const init = scripted.worker(1).last("init");
      scripted.worker(1).emit({ type: "store", id: init?.id, ok: true });
      await flush();
      expect(controller.mode()).toEqual({ kind: "worker" });
      expect(record.storeOpens).toHaveLength(1);
      expect(record.stopped).toEqual([]);
    });

    it("still fails a worker that goes quiet after it announced a wait for the store lock", async () => {
      const { scripted, record } = scriptedController();
      await flush();
      await ready(scripted.worker(1));
      scripted.worker(1).emit({ type: "waiting", reason: "locked", attempt: 1, retryInMs: 1_000 });
      await flush();
      await advance(10_999);
      expect(failures(record)).toEqual([]);
      await advance(1);
      expect(failures(record)).toEqual([
        "worker generation 1 failed (1 of 3): no store result within 11000 ms of a wait for the store lock",
      ]);
    });

    it("counts a ready from another build as a failure and sends no init", async () => {
      const { scripted, record } = scriptedController();
      await flush();
      await ready(scripted.worker(1), "another-build");
      expect(scripted.worker(1).last("init")).toBeUndefined();
      expect(scripted.worker(1).terminations).toBe(1);
      expect(failures(record)).toEqual([
        `worker generation 1 failed (1 of 3): build mismatch: main has ${BUILD_ID}, the worker another-build`,
      ]);
    });

    it.each([
      [
        "an error event",
        (w: ScriptedWorker) => w.error(new Error("boom")),
        "worker error: boom",
        true,
      ],
      [
        "an exit main did not ask for",
        (w: ScriptedWorker) => w.exit(),
        "the worker exited unexpectedly",
        false,
      ],
      [
        "a fatal crash",
        (w: ScriptedWorker) => w.emit({ type: "fatal", kind: "crash", reason: "it broke" }),
        "it broke",
        true,
      ],
    ] as const)("fails a generation on %s", async (_label, act, reason, needsExit) => {
      const { scripted, record } = scriptedController();
      await flush();
      await ready(scripted.worker(1));
      act(scripted.worker(1));
      await flush();
      expect(scripted.worker(1).terminations).toBe(1);
      expect(failures(record)).toEqual([`worker generation 1 failed (1 of 3): ${reason}`]);
      if (needsExit) scripted.worker(1).exit();
      await advance(1_000);
      expect(scripted.workers).toHaveLength(2);
    });

    it.each([
      ["refuses", async () => ({ ok: false as const, reason: "busy: locked" })],
      [
        "throws",
        async (): Promise<{ ok: true }> => {
          throw new Error("no reader");
        },
      ],
    ])(
      "fails a generation whose store reader %s after the worker opened the store",
      async (_label, onStoreOpen) => {
        const { controller, scripted, record } = scriptedController({ onStoreOpen });
        await flush();
        await run(scripted.worker(1));
        expect(scripted.worker(1).terminations).toBe(1);
        const [line] = failures(record);
        expect(line).toMatch(
          /^worker generation 1 failed \(1 of 3\): main could not open its store reader \((busy: locked|no reader)\)$/,
        );
        expect(tracked(controller.settled()).settled).toBe(false);
      },
    );

    it("fails a generation whose starter rejects, and starts the next one after the delay", async () => {
      const { scripted, record } = scriptedController({}, 1);
      await flush();
      expect(failures(record)).toEqual([
        "worker generation 1 failed (1 of 3): the worker did not start: the worker module did not load",
      ]);
      expect(scripted.workers).toHaveLength(0);
      await advance(1_000);
      expect(scripted.workers).toHaveLength(1);
      expect(scripted.workers[0]?.generation).toBe(2);
    });

    it("counts a generation's failure once however many ways it fails", async () => {
      const { scripted, record } = scriptedController();
      await flush();
      await ready(scripted.worker(1));
      scripted.worker(1).emit({ type: "fatal", kind: "crash", reason: "first" });
      scripted.worker(1).error(new Error("second"));
      await advance(20_000);
      scripted.worker(1).exit();
      await flush();
      expect(failures(record)).toEqual(["worker generation 1 failed (1 of 3): first"]);
    });
  });

  describe("restarts", () => {
    it("starts each replacement after its predecessor's exit, 1 s and then 5 s later", async () => {
      const { scripted } = scriptedController();
      await flush();
      await ready(scripted.worker(1));
      scripted.worker(1).emit({ type: "fatal", kind: "crash", reason: "crashed" });
      await flush();
      // Asked to end, the thread has not yet: nothing replaces it.
      await advance(60_000);
      expect(scripted.workers).toHaveLength(1);
      scripted.worker(1).exit();
      await advance(999);
      expect(scripted.workers).toHaveLength(1);
      await advance(1);
      expect(scripted.workers).toHaveLength(2);

      await ready(scripted.worker(2));
      scripted.worker(2).emit({ type: "fatal", kind: "crash", reason: "crashed again" });
      await flush();
      scripted.worker(2).exit();
      await advance(4_999);
      expect(scripted.workers).toHaveLength(2);
      await advance(1);
      expect(scripted.workers).toHaveLength(3);
    });

    it("reports a failed generation as restarting with no status until its replacement's store opens", async () => {
      const { controller, scripted } = scriptedController({ restartDelaysMs: [1_000, 1_000] });
      await flush();
      await run(scripted.worker(1));
      scripted.worker(1).emit({ type: "status", status: status() });
      expect(controller.status()?.distill.leaseHeld).toBe(true);
      scripted.worker(1).emit({ type: "fatal", kind: "crash", reason: "disk stalled" });
      await flush();
      expect(controller.mode()).toEqual({ kind: "worker", detail: "restarting (disk stalled)" });
      expect(controller.status()).toBeUndefined();
      // A late status of the failed generation changes nothing.
      scripted.worker(1).emit({ type: "status", status: status() });
      expect(controller.status()).toBeUndefined();
      scripted.worker(1).exit();
      await advance(1_000);
      await ready(scripted.worker(2));
      expect(controller.mode()).toEqual({ kind: "worker", detail: "restarting (disk stalled)" });
      scripted.worker(2).emit({ type: "store", id: scripted.worker(2).last("init")?.id, ok: true });
      await flush();
      expect(controller.mode()).toEqual({ kind: "worker" });
    });

    it("names every earlier generation whose thread has ended in its replacement's init, the most recent four", async () => {
      const { controller, scripted } = scriptedController({
        restartDelaysMs: [0],
        maxFailures: 6,
      });
      await flush();
      const takeOvers: unknown[] = [];
      for (const generation of [1, 2, 3, 4, 5, 6]) {
        await ready(scripted.worker(generation));
        takeOvers.push(scripted.worker(generation).last("init")?.takeOver);
        if (generation === 6) break;
        scripted.worker(generation).exit();
        await flush();
      }
      expect(controller.holderId()).toBe("inst/w6");
      expect(takeOvers).toEqual([
        undefined,
        ["inst/w1"],
        ["inst/w1", "inst/w2"],
        ["inst/w1", "inst/w2", "inst/w3"],
        ["inst/w1", "inst/w2", "inst/w3", "inst/w4"],
        ["inst/w2", "inst/w3", "inst/w4", "inst/w5"],
      ]);
    });

    it("names a generation main never heard take the lease once its thread has ended", async () => {
      // Its reader does not open, so main reads no lease row, and the
      // generation fails before any status of it arrives.
      const { scripted } = scriptedController({
        restartDelaysMs: [0, 0],
        onStoreOpen: async () => ({ ok: false, reason: "no-wal" }),
      });
      await flush();
      await ready(scripted.worker(1));
      scripted.worker(1).emit({ type: "store", id: scripted.worker(1).last("init")?.id, ok: true });
      await flush();
      // Asked to end, its thread has not: no replacement and no takeover yet.
      await advance(60_000);
      expect(scripted.workers).toHaveLength(1);
      scripted.worker(1).exit();
      await flush();
      await ready(scripted.worker(2));
      expect(scripted.worker(2).last("init")).toMatchObject({
        holderId: "inst/w2",
        takeOver: ["inst/w1"],
      });
    });

    it("runs the distiller inline after the third failure, once the last thread has exited", async () => {
      const { controller, scripted, record } = scriptedController({ restartDelaysMs: [0, 0] });
      const settled = tracked(controller.settled());
      await flush();
      for (const generation of [1, 2, 3]) {
        await ready(scripted.worker(generation));
        scripted
          .worker(generation)
          .emit({ type: "fatal", kind: "crash", reason: `crash ${generation}` });
        await flush();
        if (generation < 3) {
          scripted.worker(generation).exit();
          await flush();
        }
      }
      expect(scripted.worker(3).terminations).toBe(1);
      expect(controller.mode()).toEqual({ kind: "worker", detail: "restarting (crash 3)" });
      expect(record.inline).toEqual([]);
      expect(settled.settled).toBe(false);

      scripted.worker(3).exit();
      await flush();
      expect(controller.mode()).toEqual({ kind: "inline", reason: "crash 3" });
      // Every generation's thread has ended: any of them may be in the row.
      expect(record.inline).toEqual([
        { reason: "crash 3", takeOver: ["inst/w1", "inst/w2", "inst/w3"] },
      ]);
      expect(settled.settled).toBe(true);
      expect(controller.post({ type: "turn-ended", sessionID: "s" })).toBe(false);
      await advance(60_000);
      expect(scripted.workers).toHaveLength(3);
    });

    it("goes inline after as many failures as maxFailures says", async () => {
      const { controller, scripted, record } = scriptedController({ maxFailures: 1 }, 1);
      await flush();
      expect(scripted.workers).toEqual([]);
      expect(controller.mode()).toEqual({
        kind: "inline",
        reason: "the worker did not start: the worker module did not load",
      });
      expect(record.inline).toEqual([
        {
          reason: "the worker did not start: the worker module did not load",
          takeOver: ["inst/w1"],
        },
      ]);
    });
  });

  describe("store results", () => {
    it("runs the generation on store ok: the reader opens, settled resolves and queued signals go out", async () => {
      const { controller, scripted, record } = scriptedController();
      const settled = tracked(controller.settled());
      await flush();
      expect(controller.post({ type: "turn-ended", sessionID: "s1" })).toBe(true);
      expect(controller.post({ type: "deleted", sessionID: "s2" })).toBe(true);
      await ready(scripted.worker(1));
      await flush();
      expect(scripted.worker(1).last("events")).toBeUndefined();

      await run(scripted.worker(1), "journal_mode stays delete");
      expect(record.storeOpens).toEqual(["journal_mode stays delete"]);
      expect(record.logs).toContain("store: journal_mode stays delete");
      expect(settled.settled).toBe(true);
      expect(scripted.worker(1).last("events")?.signals).toEqual([
        { type: "turn-ended", sessionID: "s1" },
        { type: "deleted", sessionID: "s2" },
      ]);
    });

    it("stops indexing for good on a store refusal, with no retry", async () => {
      const { controller, scripted, record } = scriptedController();
      const settled = tracked(controller.settled());
      await flush();
      controller.post({ type: "turn-ended", sessionID: "s1" });
      await ready(scripted.worker(1));
      const init = scripted.worker(1).last("init");
      scripted
        .worker(1)
        .emit({ type: "store", id: init?.id, ok: false, reason: "source-mismatch" });
      await flush();
      expect(controller.mode()).toEqual({ kind: "stopped", reason: "source-mismatch" });
      expect(record.stopped).toEqual(["source-mismatch"]);
      expect(record.storeOpens).toEqual([]);
      expect(scripted.worker(1).terminations).toBe(1);
      expect(settled.settled).toBe(true);
      expect(controller.drainEvents()).toEqual([]);
      expect(controller.post({ type: "turn-ended", sessionID: "s1" })).toBe(false);

      scripted.worker(1).exit();
      await advance(60_000);
      expect(scripted.workers).toHaveLength(1);
      expect(failures(record)).toEqual([]);
    });

    it("stops indexing for good on a fatal store, failing the writes that wait", async () => {
      const { controller, scripted, record } = scriptedController();
      await flush();
      await run(scripted.worker(1));
      const write = controller.writeVectors("m", 1, []);
      scripted
        .worker(1)
        .emit({ type: "fatal", kind: "store", reason: "the store file is damaged: x" });
      await flush();
      expect(await write).toEqual({ status: "failed", error: "indexing stopped" });
      expect(controller.mode()).toEqual({
        kind: "stopped",
        reason: "the store file is damaged: x",
      });
      expect(record.stopped).toEqual(["the store file is damaged: x"]);
      expect(scripted.worker(1).terminations).toBe(1);
      scripted.worker(1).exit();
      await advance(60_000);
      expect(scripted.workers).toHaveLength(1);
    });
  });

  describe("the watchdog", () => {
    /** The lease row the reader sees, computed at each read. */
    let lease: () => LeaseInfo | undefined;
    let leaseError: Error | undefined;
    const readLease = (): LeaseInfo | undefined => {
      if (leaseError) throw leaseError;
      return lease();
    };

    beforeEach(() => {
      lease = () => undefined;
      leaseError = undefined;
    });

    async function watched(last: WorkerStatus | undefined): Promise<{
      scripted: ReturnType<typeof scriptedWorkers>;
      record: Recorded;
    }> {
      const { scripted, record } = scriptedController({ readLease });
      await flush();
      await run(scripted.worker(1));
      if (last) scripted.worker(1).emit({ type: "status", status: last });
      return { scripted, record };
    }

    it("fails a generation whose lease heartbeat is older than the lease's TTL", async () => {
      const { scripted, record } = await watched(status());
      lease = leaseOf("inst/w1", 30_001);
      await advance(4_999);
      expect(failures(record)).toEqual([]);
      await advance(1);
      expect(scripted.worker(1).terminations).toBe(1);
      expect(failures(record)).toEqual([
        "worker generation 1 failed (1 of 3): its lease heartbeat is older than 30000 ms",
      ]);
    });

    it("uses LEASE_TTL_MS for a lease row without a TTL", async () => {
      const { record } = await watched(status());
      lease = leaseOf("inst/w1", LEASE_TTL_MS + 1, 0);
      await advance(5_000);
      expect(failures(record)).toEqual([
        `worker generation 1 failed (1 of 3): its lease heartbeat is older than ${LEASE_TTL_MS} ms`,
      ]);
    });

    it.each([
      ["before its first status", undefined],
      ["whose last status says it holds no lease", status({ leaseHeld: false })],
    ])(
      "fails a generation %s when the lease row names it with a stale heartbeat",
      async (_label, last) => {
        const { scripted, record } = await watched(last);
        lease = leaseOf("inst/w1", 60_000);
        await advance(5_000);
        expect(scripted.worker(1).terminations).toBe(1);
        expect(failures(record)).toEqual([
          "worker generation 1 failed (1 of 3): its lease heartbeat is older than 30000 ms",
        ]);
      },
    );

    const calm: Array<[string, WorkerStatus | undefined, () => LeaseInfo | undefined]> = [
      ["no status yet and a fresh heartbeat", undefined, leaseOf("inst/w1", 1_000)],
      ["a lease row naming another holder", status(), leaseOf("other/w1", 60_000)],
      ["no status yet and a row naming another holder", undefined, leaseOf("other/w1", 60_000)],
      ["a heartbeat exactly at the TTL", status(), leaseOf("inst/w1", 30_000)],
      ["a longer TTL on the row", status(), leaseOf("inst/w1", 30_001, 60_000)],
      ["no lease row", status(), () => undefined],
    ];
    it.each(calm)("leaves a generation alone with %s", async (_label, last, row) => {
      const { scripted, record } = await watched(last);
      lease = row;
      await advance(20_000);
      expect(failures(record)).toEqual([]);
      expect(scripted.worker(1).terminations).toBe(0);
    });

    it("ignores a lease read that throws", async () => {
      const { scripted, record } = await watched(status());
      leaseError = new Error("SQLITE_BUSY");
      await advance(20_000);
      expect(failures(record)).toEqual([]);
      expect(scripted.worker(1).terminations).toBe(0);
    });

    it("does not trip once a stop is pending", async () => {
      const { controller, scripted, record } = scriptedController({ readLease });
      await flush();
      await run(scripted.worker(1));
      scripted.worker(1).emit({ type: "status", status: status() });
      lease = leaseOf("inst/w1", 60_000);
      void controller.stop(60_000);
      await advance(20_000);
      expect(failures(record)).toEqual([]);
      expect(scripted.worker(1).terminations).toBe(0);
    });
  });

  describe("vector writes", () => {
    it("fail at once while no generation runs", async () => {
      const { controller, scripted } = scriptedController();
      await flush();
      expect(await controller.writeVectors("m", 1, [])).toEqual({
        status: "failed",
        error: "the store writer is not running",
      });
      await run(scripted.worker(1));
      void controller.stop(1_000);
      expect(await controller.writeVectors("m", 1, [])).toEqual({
        status: "failed",
        error: "the store writer is not running",
      });
    });

    it.each([
      [
        "committed with a revision",
        { outcome: "committed", revision: 7 },
        { status: "committed", revision: 7 },
      ],
      [
        "committed without a revision",
        { outcome: "committed" },
        { status: "failed", error: "the write failed" },
      ],
      ["refused", { outcome: "refused", reason: "older" }, { status: "refused", reason: "older" }],
      [
        "failed",
        { outcome: "failed", reason: "disk I/O" },
        { status: "failed", error: "disk I/O" },
      ],
    ] as const)("settle a reply %s as its outcome", async (_label, reply, expected) => {
      const { controller, scripted } = scriptedController();
      await flush();
      await run(scripted.worker(1));
      const write = controller.writeVectors("m", 3, []);
      const sent = scripted.worker(1).last("vectors");
      expect(sent).toMatchObject({ model: "m", representation: 3, rows: [] });
      scripted.worker(1).emit({ type: "reply", id: sent?.id, ...reply });
      expect(await write).toEqual(expected);
    });

    it("transfer only the embeddings that are whole buffers of their own", async () => {
      const { controller, scripted } = scriptedController();
      await flush();
      await run(scripted.worker(1));
      const whole = new Uint8Array(8);
      const view = new Uint8Array(new ArrayBuffer(16), 4, 8);
      void controller.writeVectors("m", 1, [
        { sessionId: "a", embedding: whole, expectedSummaryHash: "" },
        { sessionId: "b", embedding: view, expectedSummaryHash: "" },
      ]);
      const entry = scripted.worker(1).received.find((r) => r.message.type === "vectors");
      expect(entry?.transfer).toHaveLength(1);
      expect(entry?.transfer?.[0]).toBe(whole.buffer);
    });

    it("fail a ninth write while eight wait for their replies", async () => {
      const { controller, scripted } = scriptedController();
      await flush();
      await run(scripted.worker(1));
      const waiting = Array.from({ length: 8 }, () => tracked(controller.writeVectors("m", 1, [])));
      expect(await controller.writeVectors("m", 1, [])).toEqual({
        status: "failed",
        error: "too many vector writes are waiting",
      });
      expect(waiting.every((w) => !w.settled)).toBe(true);
    });

    it("fail a write with no reply within 10 s, and ignore its late reply", async () => {
      const { controller, scripted } = scriptedController();
      await flush();
      await run(scripted.worker(1));
      const write = tracked(controller.writeVectors("m", 1, []));
      const sent = scripted.worker(1).last("vectors");
      expect(sent?.deadline).toBe(Date.now() + 10_000);
      await advance(9_999);
      expect(write.settled).toBe(false);
      await advance(1);
      expect(write.value).toEqual({
        status: "failed",
        error: "no acknowledgement before the deadline",
      });
      scripted.worker(1).emit({ type: "reply", id: sent?.id, outcome: "committed", revision: 1 });
      await flush();
      expect(write.value).toEqual({
        status: "failed",
        error: "no acknowledgement before the deadline",
      });
    });

    it("fail the writes that wait when their generation fails", async () => {
      const { controller, scripted } = scriptedController();
      await flush();
      await run(scripted.worker(1));
      const write = controller.writeVectors("m", 1, []);
      scripted.worker(1).emit({ type: "fatal", kind: "crash", reason: "crashed" });
      expect(await write).toEqual({ status: "failed", error: "the worker failed: crashed" });
    });
  });

  describe("stop and terminate", () => {
    it("returns the first stop's promise on every call and resolves true on stopped", async () => {
      const { controller, scripted } = scriptedController();
      await flush();
      await run(scripted.worker(1));
      const first = controller.stop(1_000);
      expect(controller.stop(5_000)).toBe(first);
      await flush();
      const stops = scripted.worker(1).received.filter((r) => r.message.type === "stop");
      expect(stops).toHaveLength(1);
      const stop = stops[0]?.message as { id: number; deadline: number };
      expect(stop.deadline).toBe(Date.now() + 1_000);
      expect(controller.post({ type: "turn-ended", sessionID: "s" })).toBe(false);
      scripted.worker(1).emit({ type: "stopped", id: stop.id });
      expect(await first).toBe(true);
    });

    it.each([
      ["at its deadline", async () => advance(1_000)],
      [
        "when the thread exits first",
        async (w: ScriptedWorker) => {
          w.exit();
          await flush();
        },
      ],
    ] as const)("resolves false %s", async (_label, end) => {
      const { controller, scripted, record } = scriptedController();
      await flush();
      await run(scripted.worker(1));
      const stopped = tracked(controller.stop(1_000));
      await flush();
      await end(scripted.worker(1));
      await flush();
      expect(stopped).toEqual({ settled: true, value: false });
      // Asked to stop, its exit is no failure.
      expect(failures(record)).toEqual([]);
    });

    it("resolves false with no live generation, cancelling the restart and resolving settled", async () => {
      const { controller, scripted } = scriptedController();
      const settled = tracked(controller.settled());
      await flush();
      await ready(scripted.worker(1));
      scripted.worker(1).emit({ type: "fatal", kind: "crash", reason: "crashed" });
      scripted.worker(1).exit();
      await flush();
      expect(await controller.stop(1_000)).toBe(false);
      await flush();
      expect(settled.settled).toBe(true);
      await advance(60_000);
      expect(scripted.workers).toHaveLength(1);
    });

    it("sends no init to a generation asked to stop before it was ready", async () => {
      const { controller, scripted } = scriptedController();
      await flush();
      void controller.stop(1_000);
      await flush();
      await ready(scripted.worker(1));
      expect(scripted.worker(1).last("init")).toBeUndefined();
      expect(scripted.worker(1).last("stop")).toBeDefined();
      // Nor does the missing ready count against it.
      await advance(20_000);
      expect(scripted.worker(1).terminations).toBe(0);
    });

    it("waits at most its bound for the thread's exit on terminate", async () => {
      const { controller, scripted } = scriptedController();
      await flush();
      await run(scripted.worker(1));
      const write = controller.writeVectors("m", 1, []);
      const ended = tracked(controller.terminate(500));
      await flush();
      expect(scripted.worker(1).terminations).toBe(1);
      expect(await write).toEqual({ status: "failed", error: "the worker ended" });
      await advance(499);
      expect(ended.settled).toBe(false);
      await advance(1);
      expect(ended.settled).toBe(true);
    });

    it("returns from terminate at the thread's exit", async () => {
      const { controller, scripted } = scriptedController();
      await flush();
      await run(scripted.worker(1));
      const ended = tracked(controller.terminate(10_000));
      await flush();
      scripted.worker(1).exit();
      await flush();
      expect(ended.settled).toBe(true);
    });

    it("starts its first generation only once an earlier worker on the store has ended", async () => {
      let ended!: () => void;
      const startAfter = new Promise<void>((resolve) => (ended = resolve));
      const { controller, scripted } = scriptedController({ startAfter });
      await advance(60_000);
      expect(scripted.workers).toHaveLength(0);
      expect(controller.mode()).toEqual({
        kind: "worker",
        detail: "waiting (an earlier worker on this store has not ended)",
      });
      await controller.exited();
      ended();
      await flush();
      expect(scripted.workers).toHaveLength(1);
      expect(controller.mode()).toEqual({ kind: "worker" });
    });

    it("starts no generation after a stop during the wait for an earlier worker", async () => {
      let ended!: () => void;
      const startAfter = new Promise<void>((resolve) => (ended = resolve));
      const { controller, scripted } = scriptedController({ startAfter });
      await flush();
      expect(await controller.stop(1_000)).toBe(false);
      ended();
      await advance(60_000);
      expect(scripted.workers).toHaveLength(0);
    });

    it("settles exited at the current generation's exit, with no bound", async () => {
      const { controller, scripted } = scriptedController();
      await flush();
      await run(scripted.worker(1));
      const exited = tracked(controller.exited());
      const terminated = tracked(controller.terminate(1_000));
      await advance(600_000);
      expect(terminated.settled).toBe(true);
      expect(exited.settled).toBe(false);
      scripted.worker(1).exit();
      await flush();
      expect(exited.settled).toBe(true);
    });

    it("starts no generation once retired, a pending restart included", async () => {
      const { controller, scripted, record } = scriptedController();
      await flush();
      await run(scripted.worker(1));
      scripted.worker(1).emit({ type: "fatal", kind: "crash", reason: "crashed" });
      scripted.worker(1).exit();
      await flush();
      controller.retire();
      await advance(60_000);
      expect(scripted.workers).toHaveLength(1);
      expect(failures(record)).toHaveLength(1);
      expect(record.inline).toEqual([]);
    });

    it("takes a reader refusal after retire as the stop under way, not a failure", async () => {
      const { controller, scripted, record } = scriptedController({
        onStoreOpen: async () => ({ ok: false, reason: "the runtime is disposed" }),
      });
      await flush();
      await ready(scripted.worker(1));
      controller.retire();
      scripted.worker(1).emit({ type: "store", id: scripted.worker(1).last("init")?.id, ok: true });
      await flush();
      expect(failures(record)).toEqual([]);
      expect(scripted.worker(1).terminations).toBe(0);
      // The stop still reaches it, and it ends as asked.
      const stopped = tracked(controller.stop(1_000));
      await flush();
      const stop = scripted.worker(1).last("stop");
      expect(stop).toBeDefined();
      scripted.worker(1).emit({ type: "stopped", id: stop?.id });
      await flush();
      expect(stopped.value).toBe(true);
      await advance(60_000);
      expect(scripted.workers).toHaveLength(1);
    });

    it("ends a worker whose start was pending at the stop, counting no failure, and terminate waits for its exit", async () => {
      const scripted = scriptedWorkers();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { controller, record } = scriptedController({
        start: async (generation) => {
          await gate;
          return scripted.start(generation);
        },
      });
      await flush();
      expect(await controller.stop(1_000)).toBe(false);
      const ended = tracked(controller.terminate(10_000));
      await flush();
      expect(ended.settled).toBe(false);
      release();
      await flush();
      expect(scripted.worker(1).terminations).toBeGreaterThan(0);
      expect(ended.settled).toBe(false);
      scripted.worker(1).exit();
      await flush();
      expect(ended.settled).toBe(true);
      expect(failures(record)).toEqual([]);
      await advance(60_000);
      expect(scripted.workers).toHaveLength(1);
    });
  });

  describe("generations", () => {
    it("drops replies and status from a generation that is no longer current", async () => {
      const { controller, scripted, record } = scriptedController({ restartDelaysMs: [0, 0] });
      await flush();
      await run(scripted.worker(1));
      scripted.worker(1).emit({ type: "fatal", kind: "crash", reason: "crashed" });
      scripted.worker(1).exit();
      await flush();
      await run(scripted.worker(2));
      const write = tracked(controller.writeVectors("m", 1, []));
      const sent = scripted.worker(2).last("vectors");

      const old = scripted.worker(1);
      old.emit({ type: "status", status: status({ holderId: "inst/w1" }) });
      old.emit({ type: "reply", id: sent?.id, outcome: "committed", revision: 9 });
      // The current worker's channel, but another generation's envelope.
      scripted.worker(2).emit({ type: "status", status: status(), generation: 1 });
      scripted.worker(2).emitRaw({ type: "status", status: status() });
      await flush();
      expect(controller.status()).toBeUndefined();
      expect(record.statuses).toEqual([]);
      expect(write.settled).toBe(false);

      scripted.worker(2).emit({ type: "reply", id: sent?.id, outcome: "committed", revision: 1 });
      await flush();
      expect(write.value).toEqual({ status: "committed", revision: 1 });
    });

    it("keeps the current generation's last status and log lines", async () => {
      const { controller, scripted, record } = scriptedController();
      await flush();
      await run(scripted.worker(1));
      const last = status({ leaseHeld: false });
      scripted.worker(1).emit({ type: "status", status: status() });
      scripted.worker(1).emit({ type: "status", status: last });
      scripted.worker(1).emit({ type: "log", line: "worker says hi", dropped: 3 });
      expect(controller.status()).toEqual(last);
      expect(record.statuses).toHaveLength(2);
      expect(record.logs.slice(-2)).toEqual(["worker: 3 log line(s) dropped", "worker says hi"]);
    });
  });

  describe("posting signals", () => {
    const batchesOf = (worker: ScriptedWorker): EventsMessage[] =>
      worker.received.map((r) => r.message).filter((m): m is EventsMessage => m.type === "events");

    it("sends queued signals on the next turn, in messages of at most 256, at most two waiting on an ack", async () => {
      const { controller, scripted } = scriptedController();
      await flush();
      await run(scripted.worker(1));
      for (let i = 0; i < 600; i++) controller.post({ type: "turn-ended", sessionID: `s${i}` });
      expect(scripted.worker(1).last("events")).toBeUndefined();
      await flush();
      expect(batchesOf(scripted.worker(1)).map((b) => b.signals.length)).toEqual([256, 256]);
      await advance(60_000);
      expect(batchesOf(scripted.worker(1))).toHaveLength(2);
      // The rest wait in the outbox.
      expect(controller.drainEvents().map((s) => s.sessionID)).toEqual(
        Array.from({ length: 88 }, (_, i) => `s${512 + i}`),
      );
    });

    it("posts the next batch once one is acknowledged, and ignores an ack of no waiting batch", async () => {
      const { scripted, controller } = scriptedController();
      await flush();
      await run(scripted.worker(1));
      for (let i = 0; i < 600; i++) controller.post({ type: "turn-ended", sessionID: `s${i}` });
      await flush();
      const [first, second] = batchesOf(scripted.worker(1));
      scripted.worker(1).emit({ type: "ack", batch: 999 });
      expect(batchesOf(scripted.worker(1))).toHaveLength(2);
      scripted.worker(1).emit({ type: "ack", batch: second?.batch });
      const batches = batchesOf(scripted.worker(1));
      expect(batches.map((b) => b.signals.length)).toEqual([256, 256, 88]);
      expect(new Set(batches.map((b) => b.batch)).size).toBe(3);
      expect(batches.flatMap((b) => b.signals.map((s) => s.sessionID))).toEqual(
        Array.from({ length: 600 }, (_, i) => `s${i}`),
      );
      // Both waiting batches are acknowledged and the outbox is empty.
      scripted.worker(1).emit({ type: "ack", batch: first?.batch });
      expect(batchesOf(scripted.worker(1))).toHaveLength(3);
    });

    it("keeps coalescing signals in the outbox while two batches wait on an ack", async () => {
      const { controller, scripted } = scriptedController();
      await flush();
      await run(scripted.worker(1));
      controller.post({ type: "turn-ended", sessionID: "a" });
      await flush();
      controller.post({ type: "turn-ended", sessionID: "b" });
      await flush();
      expect(batchesOf(scripted.worker(1))).toHaveLength(2);
      controller.post({ type: "turn-ended", sessionID: "c" });
      controller.post({ type: "meta", sessionID: "c", patch: { title: "one" } });
      controller.post({ type: "turn-ended", sessionID: "c" });
      controller.post({ type: "meta", sessionID: "c", patch: { title: "two" } });
      await advance(60_000);
      expect(batchesOf(scripted.worker(1))).toHaveLength(2);
      scripted.worker(1).emit({ type: "ack", batch: batchesOf(scripted.worker(1))[0]?.batch });
      expect(batchesOf(scripted.worker(1))[2]?.signals).toEqual([
        { type: "meta", sessionID: "c", patch: { title: "two" } },
        { type: "turn-ended", sessionID: "c" },
      ]);
    });

    it("gives the batches an exited generation never acknowledged to its replacement, ahead of newer signals", async () => {
      const { controller, scripted } = scriptedController({ restartDelaysMs: [0, 0] });
      await flush();
      await run(scripted.worker(1));
      controller.post({ type: "deleted", sessionID: "s1" });
      controller.post({ type: "meta", sessionID: "s2", patch: { title: "a" } });
      await flush();
      controller.post({ type: "meta", sessionID: "s2", patch: { title: "b" } });
      controller.post({ type: "turn-ended", sessionID: "s3" });
      await flush();
      expect(batchesOf(scripted.worker(1))).toHaveLength(2);
      // Queued behind the two batches waiting on their ack.
      controller.post({ type: "meta", sessionID: "s2", patch: { directory: "/d" } });
      await flush();

      scripted.worker(1).exit();
      await flush();
      await run(scripted.worker(2));
      expect(batchesOf(scripted.worker(2)).flatMap((b) => b.signals)).toEqual([
        { type: "deleted", sessionID: "s1" },
        { type: "meta", sessionID: "s2", patch: { title: "b", directory: "/d" } },
        { type: "turn-ended", sessionID: "s3" },
      ]);
    });

    it("gives no acknowledged batch to the replacement", async () => {
      const { controller, scripted } = scriptedController({ restartDelaysMs: [0, 0] });
      await flush();
      await run(scripted.worker(1));
      controller.post({ type: "deleted", sessionID: "s1" });
      await flush();
      controller.post({ type: "deleted", sessionID: "s2" });
      await flush();
      const [first] = batchesOf(scripted.worker(1));
      scripted.worker(1).emit({ type: "ack", batch: first?.batch });
      scripted.worker(1).exit();
      await flush();
      await run(scripted.worker(2));
      expect(batchesOf(scripted.worker(2)).flatMap((b) => b.signals)).toEqual([
        { type: "deleted", sessionID: "s2" },
      ]);
    });

    it("gives the unacknowledged batches of the last generation to the distiller taking over", async () => {
      const { controller, scripted, record } = scriptedController({ maxFailures: 1 });
      await flush();
      await run(scripted.worker(1));
      controller.post({ type: "deleted", sessionID: "s1" });
      await flush();
      controller.post({ type: "turn-ended", sessionID: "s2" });
      scripted.worker(1).exit();
      await flush();
      expect(record.inline).toHaveLength(1);
      expect(controller.drainEvents()).toEqual([
        { type: "deleted", sessionID: "s1" },
        { type: "turn-ended", sessionID: "s2" },
      ]);
    });

    it("puts a batch whose send failed back in the outbox", async () => {
      const { controller, scripted, record } = scriptedController();
      await flush();
      await run(scripted.worker(1));
      scripted.worker(1).failPosts(1);
      controller.post({ type: "deleted", sessionID: "gone" });
      controller.post({ type: "meta", sessionID: "named", patch: { title: "t" } });
      await flush();
      expect(batchesOf(scripted.worker(1))).toEqual([]);
      expect(record.logs).toContain("worker message failed: the port is closed");
      expect(controller.drainEvents()).toEqual([
        { type: "deleted", sessionID: "gone" },
        { type: "meta", sessionID: "named", patch: { title: "t" } },
      ]);
    });

    it("takes no signal once quiesced, and drops the queued ones", async () => {
      const { controller } = scriptedController();
      await flush();
      expect(controller.post({ type: "turn-ended", sessionID: "s1" })).toBe(true);
      controller.quiesce();
      expect(controller.drainEvents()).toEqual([]);
      expect(controller.post({ type: "turn-ended", sessionID: "s2" })).toBe(false);
    });

    it("hands the queued signals over through drainEvents", async () => {
      const { controller } = scriptedController();
      await flush();
      controller.post({ type: "turn-ended", sessionID: "s1" });
      controller.post({ type: "meta", sessionID: "s1", patch: { title: "t" } });
      expect(controller.drainEvents()).toEqual([
        { type: "meta", sessionID: "s1", patch: { title: "t" } },
        { type: "turn-ended", sessionID: "s1" },
      ]);
      expect(controller.drainEvents()).toEqual([]);
    });
  });
});

// ── The inline harness over a real store ────────────────────────────────────

describe("the controller over the inline harness", () => {
  let dir: string;
  let v2: V2TestDb;
  let storePath: string;
  let sourcePath: string;
  const controllers: WorkerController[] = [];

  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "recall-worker-controller-")));
    v2 = await makeV2PartsDb();
    insertProject(v2.db, { id: "prj", worktree: "/w" });
    insertSession(v2.db, {
      id: "ses_a",
      project_id: "prj",
      directory: "/w",
      time_created: 1_000,
      time_updated: 1_200,
    });
    storePath = join(dir, "store.db");
    sourcePath = realpathSync(v2.path);
  });

  afterEach(async () => {
    for (const controller of controllers.splice(0)) {
      await controller.stop(2_000);
      await controller.terminate(2_000);
    }
    v2.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
      await sleep(5);
    }
  }

  function start(
    coldPass: boolean,
    failStarts = 0,
  ): ReturnType<typeof harnessController> & {
    harness: ReturnType<typeof workerHarness>;
  } {
    const harness = workerHarness();
    harness.failStarts(failStarts);
    const made = harnessController(
      harness,
      workerInit({ storePath, sourcePath, limits: { coldPass } }),
    );
    controllers.push(made.controller);
    return { ...made, harness };
  }

  async function meta(key: string): Promise<string | undefined> {
    const db = await openSqlite(storePath);
    if (!db) throw new Error("no sqlite");
    try {
      const row = db.get("SELECT value FROM meta WHERE key = ?", [key]);
      return row === undefined ? undefined : String(row.value);
    } finally {
      db.close();
    }
  }

  const leaseHolder = async (): Promise<string | undefined> => {
    const raw = await meta("distill_lease");
    return raw === undefined ? undefined : (JSON.parse(raw) as { holder: string }).holder;
  };

  async function running(controller: WorkerController, generation: number): Promise<void> {
    await waitFor(
      () => controller.generation() === generation && controller.status() !== undefined,
      `generation ${generation} to run`,
    );
  }

  it("fails the write and rolls it back when the worker crashes before its commit", async () => {
    const { controller, harness } = start(false);
    await controller.settled();
    await running(controller, 1);
    harness.side(1)?.arm({ at: "before-commit" });
    const result: CardVectorWriteResult = await controller.writeVectors("m", 1, []);
    expect(result).toEqual({
      status: "failed",
      error: "the worker failed: the worker exited unexpectedly",
    });
    expect(await meta(VECTORS_REV_KEY)).toBeUndefined();

    await running(controller, 2);
    // The next generation's first write is the store's first.
    expect(await controller.writeVectors("m", 1, [])).toEqual({ status: "committed", revision: 1 });
  });

  it("fails the write whose commit landed when the worker crashes before replying", async () => {
    const { controller, harness } = start(false);
    await controller.settled();
    await running(controller, 1);
    harness.side(1)?.arm({ at: "after-commit" });
    expect(await controller.writeVectors("m", 1, [])).toEqual({
      status: "failed",
      error: "the worker failed: the worker exited unexpectedly",
    });
    expect(await meta(VECTORS_REV_KEY)).toBe("1");

    await running(controller, 2);
    expect(await controller.writeVectors("m", 1, [])).toEqual({ status: "committed", revision: 2 });
  });

  it("resolves stop false and leaves the lease held when the worker crashes during shutdown", async () => {
    const { controller, harness, record } = start(true);
    await controller.settled();
    await waitFor(() => controller.status()?.distill.leaseHeld === true, "the lease");
    harness.side(1)?.arm({ at: "during-shutdown" });
    expect(await controller.stop(2_000)).toBe(false);
    expect(await leaseHolder()).toBe("harness/w1");
    // Asked to stop, the generation is not replaced.
    await sleep(200);
    expect(harness.sides).toHaveLength(1);
    expect(record.logs.filter((l) => /failed/.test(l))).toEqual([]);
  });

  it("starts a replacement that takes its crashed predecessor's live lease over at once", async () => {
    const { controller, harness } = start(true);
    await controller.settled();
    await waitFor(() => controller.status()?.distill.leaseHeld === true, "the lease");
    expect(await leaseHolder()).toBe("harness/w1");
    harness.side(1)?.crash();

    await waitFor(
      () => controller.generation() === 2 && controller.status()?.distill.leaseHeld === true,
      "the replacement to hold the lease",
    );
    expect(harness.side(2)?.received[0]).toMatchObject({
      type: "init",
      holderId: "harness/w2",
      takeOver: ["harness/w1"],
    });
    expect(await leaseHolder()).toBe("harness/w2");
  });

  it("goes inline after three starts that fail", async () => {
    const { controller, harness, record } = start(true, 3);
    await controller.settled();
    expect(controller.mode()).toEqual({
      kind: "inline",
      reason: "the worker did not start: the worker module did not load",
    });
    expect(record.inline).toEqual([
      {
        reason: "the worker did not start: the worker module did not load",
        // No thread ran: each start that failed counts as ended.
        takeOver: ["harness/w1", "harness/w2", "harness/w3"],
      },
    ]);
    expect(harness.sides).toHaveLength(0);
  });

  it("stops for good when the worker refuses the store", async () => {
    const db = await openSqlite(storePath);
    if (!db) throw new Error("no sqlite");
    const seeded = openStore(db, { host: "opencode-v2", source: "/elsewhere/opencode.db" });
    if (!seeded.ok) throw new Error(seeded.reason);
    db.close();

    const { controller, harness, record } = start(true);
    await controller.settled();
    expect(controller.mode()).toEqual({ kind: "stopped", reason: "source-mismatch" });
    expect(record.stopped).toEqual(["source-mismatch"]);
    expect(record.storeOpens).toEqual([]);
    await sleep(200);
    expect(harness.sides).toHaveLength(1);
    expect(harness.side(1)?.ended).toBe(true);
  });
});
