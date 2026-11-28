import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite } from "../../src/sqlite.js";
import { openReadStore, openStore } from "../../src/store.js";
import { storeFileState } from "../helpers.js";
import {
  insertMessage,
  insertProject,
  insertSession,
  makeV2PartsDb,
  type V2TestDb,
} from "../v2-db.js";
import { STALL_WORKER, startCompiledWorker, type CompiledWorker } from "./worker-runner.js";

/**
 * The compiled worker (`dist/distill-worker.js`, and the stall entry built
 * from the same handler) in real `node:worker_threads` threads: its whole
 * life over a scratch store and `opencode.db`, the main thread's
 * responsiveness while the worker is blocked in SQLite, a thread ended in
 * the middle of a statement, and many generations started and crashed in a
 * row.
 */

let dir: string;
let v2: V2TestDb;
let storePath: string;
let sourcePath: string;
const workers: CompiledWorker[] = [];

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "recall-compiled-worker-")));
  storePath = join(dir, "store.db");
  v2 = await makeV2PartsDb();
  insertProject(v2.db, { id: "prj", worktree: "/w" });
  for (const [id, at] of [
    ["ses_a", 1_000],
    ["ses_b", 2_000],
  ] as const) {
    insertSession(v2.db, {
      id,
      project_id: "prj",
      directory: "/w",
      time_created: at,
      time_updated: at + 200,
    });
    insertMessage(v2.db, {
      id: `msg_${id}`,
      session_id: id,
      type: "user",
      seq: 1,
      time_created: at + 100,
      data: { text: `a question about ${id}`, time: { created: at + 100 } },
    });
  }
  sourcePath = realpathSync(v2.path);
});

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.terminate();
  v2.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(pred: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

async function start(o: Parameters<typeof startCompiledWorker>[0] = {}): Promise<CompiledWorker> {
  const worker = await startCompiledWorker({ readyTimeoutMs: 20_000, ...o });
  workers.push(worker);
  return worker;
}

/** End `worker`'s thread and wait for its exit. */
async function end(worker: CompiledWorker): Promise<void> {
  workers.splice(workers.indexOf(worker), 1);
  await worker.terminate();
}

/** The lease row's holder, read on a connection of the test's own. */
async function leaseHolder(): Promise<string | undefined> {
  const db = await openSqlite(storePath);
  if (!db) throw new Error("no sqlite");
  try {
    const row = db.get("SELECT value FROM meta WHERE key = 'distill_lease'");
    return row ? (JSON.parse(String(row.value)) as { holder: string }).holder : undefined;
  } finally {
    db.close();
  }
}

/** The longest gap between this thread's timer ticks while it runs. */
function gapMeter(): { stop(): number } {
  let last = performance.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 5);
  return {
    stop() {
      clearInterval(timer);
      return Math.max(longest, performance.now() - last);
    },
  };
}

/** How many OS threads this process runs now. */
function threadCount(): number {
  if (process.platform === "linux") {
    const match = /^Threads:\s+(\d+)$/m.exec(readFileSync("/proc/self/status", "utf8"));
    return Number(match?.[1]);
  }
  const out = execFileSync("ps", ["-M", "-p", String(process.pid)], { encoding: "utf8" });
  return out.trim().split("\n").length - 1;
}

describe("the published worker in a thread", () => {
  it("opens the store, takes the lease, distills, and stops with the lease released and nothing written after", async () => {
    const worker = await start();
    expect(worker.messages[0]?.type).toBe("ready");
    const store = await worker.init({ storePath, sourcePath, limits: { coldPass: true } });
    expect(store).toMatchObject({ type: "store", ok: true });
    const status = await worker.next("status");
    expect(status.status).toMatchObject({ holderId: "compiled/w1", distill: { leaseHeld: true } });

    const reader = await openReadStore(storePath, { host: "opencode-v2", source: sourcePath });
    if (!reader.ok) throw new Error(`the reader did not open: ${reader.reason}`);
    try {
      await waitFor(
        () =>
          reader.store.getCard("ses_a")?.distillState === "full" &&
          reader.store.getCard("ses_b")?.distillState === "full",
        "both cards",
      );
      expect(reader.store.leaseStatus()?.holder).toBe("compiled/w1");
    } finally {
      reader.close();
    }

    await worker.stop();
    const atStopped = storeFileState(storePath);
    await sleep(500);
    expect(storeFileState(storePath)).toEqual(atStopped);
    await end(worker);
    expect(storeFileState(storePath)).toEqual(atStopped);
    expect(await leaseHolder()).toBe("");
    expect(worker.errors).toEqual([]);
    expect(worker.messages.filter((m) => m.type === "fatal")).toEqual([]);
    const stoppedAt = worker.messages.findIndex((m) => m.type === "stopped");
    expect(worker.messages.slice(stoppedAt + 1)).toEqual([]);
  }, 60_000);
});

describe("a worker blocked in SQLite", () => {
  it("keeps the main thread ticking while the worker holds a write transaction for 2 s", async () => {
    const worker = await start({ entry: STALL_WORKER, stall: { ms: 2_000, afterTx: 1 } });
    const meter = gapMeter();
    const started = Date.now();
    const store = await worker.init({ storePath, sourcePath, timeoutMs: 20_000 });
    const took = Date.now() - started;
    const gap = meter.stop();
    console.log(
      `stalled worker: store result after ${took} ms; the main thread's longest gap ${gap.toFixed(1)} ms`,
    );
    expect(store.ok).toBe(true);
    // The fence's transaction held the worker for its 2 s.
    expect(took).toBeGreaterThanOrEqual(1_900);
    expect(gap).toBeLessThan(250);
  }, 60_000);

  it("waits behind an outside connection's write lock without holding up the main thread", async () => {
    const seed = await openSqlite(storePath);
    if (!seed) throw new Error("no sqlite");
    const seeded = openStore(seed, { host: "opencode-v2", source: sourcePath });
    if (!seeded.ok) throw new Error(seeded.reason);
    seed.close();

    const outside = await openSqlite(storePath);
    if (!outside) throw new Error("no sqlite");
    try {
      outside.exec("BEGIN IMMEDIATE");
      const worker = await start();
      const meter = gapMeter();
      const started = Date.now();
      let releasedAt = 0;
      setTimeout(() => {
        outside.exec("COMMIT");
        releasedAt = Date.now();
      }, 2_000);
      const store = await worker.init({ storePath, sourcePath, timeoutMs: 20_000 });
      const arrivedAt = Date.now();
      const gap = meter.stop();
      console.log(
        `locked store: store result after ${arrivedAt - started} ms; the main thread's longest gap ${gap.toFixed(1)} ms`,
      );
      expect(store.ok).toBe(true);
      expect(releasedAt).toBeGreaterThan(0);
      expect(arrivedAt).toBeGreaterThanOrEqual(releasedAt);
      expect(gap).toBeLessThan(250);
    } finally {
      outside.close();
    }
  }, 60_000);

  it("lets a replacement started after the exit of a thread terminated mid-statement open the store and take its lease over", async () => {
    const flag = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const cell = new Int32Array(flag);
    // Transactions 1 and 2 are the fence and the lease acquire; the third,
    // the cold pass's first write, runs the long statement.
    const first = await start({
      entry: STALL_WORKER,
      stall: { rows: 40_000_000, afterTx: 3, flag },
    });
    const store = await first.init({ storePath, sourcePath, limits: { coldPass: true } });
    expect(store.ok).toBe(true);
    await waitFor(() => Atomics.load(cell, 0) === 1, "the long statement");
    expect(await leaseHolder()).toBe("compiled/w1");

    const asked = Date.now();
    void first.worker.terminate();
    let exitedAt = 0;
    void first.exited.then(() => (exitedAt = Date.now()));
    await first.exited;
    workers.splice(workers.indexOf(first), 1);
    console.log(
      `terminated mid-statement: the thread exited ${exitedAt - asked} ms after terminate()`,
    );

    // Started only after the exit, as the controller does.
    const second = await start({ generation: 2 });
    const started = Date.now();
    const reopened = await second.init({
      storePath,
      sourcePath,
      limits: { coldPass: true },
      holderId: "compiled/w2",
      takeOver: "compiled/w1",
    });
    expect(reopened.ok).toBe(true);
    // The dead thread's transaction holds no lock: the open does not wait
    // out a busy timeout.
    expect(Date.now() - started).toBeLessThan(4_000);
    const status = await second.next("status");
    expect(status.status.distill.leaseHeld).toBe(true);
    expect(await leaseHolder()).toBe("compiled/w2");
    await second.stop();
    expect(await leaseHolder()).toBe("");
  }, 90_000);
});

describe("many generations", () => {
  it("starts, crashes and restarts 20 times, leaving no lease holder and no extra thread", async () => {
    // A first round brings up what the process keeps for any thread (libuv's
    // pool among them), so the count after it is the baseline.
    const warm = await start({ generation: 100 });
    await warm.init({ storePath, sourcePath, limits: { coldPass: false } });
    await warm.stop();
    await end(warm);
    await sleep(200);
    const baseline = threadCount();

    let predecessor: string | undefined;
    for (let round = 1; round <= 20; round++) {
      const worker = await start({ generation: round });
      const holderId = `compiled/w${round}`;
      const store = await worker.init({
        storePath,
        sourcePath,
        limits: { coldPass: true },
        holderId,
        ...(predecessor !== undefined && { takeOver: predecessor }),
      });
      expect(store.ok).toBe(true);
      const status = await worker.next("status");
      // Each one takes its crashed predecessor's live lease at once.
      expect(status.status.distill.leaseHeld).toBe(true);
      if (round < 20) {
        await end(worker);
        expect(await leaseHolder()).toBe(holderId);
      } else {
        await worker.stop();
        await end(worker);
      }
      predecessor = holderId;
    }
    expect(await leaseHolder()).toBe("");

    const settle = Date.now();
    let after = threadCount();
    while (after > baseline && Date.now() - settle < 5_000) {
      await sleep(100);
      after = threadCount();
    }
    console.log(`threads: ${baseline} before 20 generations, ${after} after`);
    expect(after).toBeLessThanOrEqual(baseline);
  }, 180_000);
});
