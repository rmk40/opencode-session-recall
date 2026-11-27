import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { createDistiller, type Distiller } from "../src/distill.js";
import { createFetchGate } from "../src/fetch-gate.js";
import type { HistorySession } from "../src/history/model.js";
import { createV1HistorySource } from "../src/history/v1.js";
import { openSqlite, type SqliteDb } from "../src/sqlite.js";
import type { Card, Store, WalCheckpoint } from "../src/store.js";
import { openV1Store, PROJECT_DIR, session, TEST_LIMITS } from "./helpers.js";

/**
 * The lease holder's WAL checkpoints, on the v1 host: its connection's own
 * automatic checkpoints turned off while it holds the lease and given back
 * when it loses the lease or stops, its timed checkpoints and their cadence,
 * the checkpoint at the start of a background slice and the yield that
 * follows a long one. Timers are fake, so a timed checkpoint runs only when a
 * test moves the clock.
 */

const tmpDirs: string[] = [];
const distillers: Distiller[] = [];
const dbs: SqliteDb[] = [];

afterEach(async () => {
  await Promise.all(distillers.splice(0).map((d) => d.stop()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function openStoreFile(
  now?: () => number,
): Promise<{ path: string; db: SqliteDb; store: Store }> {
  const dir = mkdtempSync(join(tmpdir(), "recall-checkpoints-"));
  tmpDirs.push(dir);
  const path = join(dir, "store.db");
  const db = await openSqlite(path);
  if (!db) throw new Error("no sqlite");
  dbs.push(db);
  const store = openV1Store(db, now ? { now } : undefined);
  if (!store) throw new Error("openStore returned null");
  return { path, db, store };
}

/** The connection's `wal_autocheckpoint` setting, in pages. */
const autoCheckpoint = (db: SqliteDb): number =>
  Number(db.get("PRAGMA wal_autocheckpoint")?.wal_autocheckpoint);

/** A source nothing fetches through: a cold pass here finds every session up
 *  to date, and every other distiller runs none. */
const unused = {} as unknown as OpencodeClient;
const source = createV1HistorySource({ scoped: unused, unscoped: unused });

function start(
  store: Store,
  o: {
    instanceId?: string;
    now?: () => number;
    yieldBetween?: () => Promise<void>;
    /** Runs a cold pass over these sessions; none without them. */
    sessions?: HistorySession[];
    onColdPassDone?: () => void;
    leaseRetryMs?: number;
    log?: (line: string) => void;
  } = {},
): Distiller {
  const distiller = createDistiller({
    source,
    store,
    gate: createFetchGate({ concurrency: 2 }),
    limits: {
      ...TEST_LIMITS,
      distillDelayMs: 0,
      distillConcurrency: 1,
      coldPass: o.sessions !== undefined,
    },
    instanceId: o.instanceId ?? "holder",
    discover: async () => o.sessions ?? [],
    log: o.log ?? (() => {}),
    ...(o.now && { now: o.now }),
    ...(o.yieldBetween && { yieldBetween: o.yieldBetween }),
    ...(o.onColdPassDone && { onColdPassDone: o.onColdPassDone }),
    ...(o.leaseRetryMs !== undefined && { leaseRetryMs: o.leaseRetryMs }),
  });
  distillers.push(distiller);
  distiller.start();
  return distiller;
}

/** Five sessions, newest first, each with a card fully indexed at its current
 *  update time, so a cold pass examines each without fetching or writing. */
function upToDateSessions(db: SqliteDb, store: Store): HistorySession[] {
  const sessions = [5, 4, 3, 2, 1].map((n) => session(`s${n}`, `S${n}`, PROJECT_DIR, n * 1000));
  db.tx(() => {
    for (const s of sessions) store.upsertCard(indexedCard(s.id, s.time.updated));
  });
  return sessions;
}

function indexedCard(id: string, timeUpdated: number): Card {
  return {
    sessionId: id,
    parentId: null,
    rootId: id,
    title: "",
    slug: id,
    directory: PROJECT_DIR,
    projectId: "project-main",
    agent: null,
    model: null,
    timeCreated: timeUpdated - 1000,
    timeUpdated,
    partCount: 1,
    retainedChars: 1,
    summaryHead: "",
    outcomeHead: "",
    inventory: "",
    files: [],
    tools: [],
    errors: [],
    familyRollup: [],
    distillState: "full",
    distilledThrough: "seed",
    embedding: null,
    embeddingGen: null,
    nlSummary: "",
    summaryHash: "",
  };
}

const IDLE: WalCheckpoint = { busy: false, frames: 0, checkpointed: 0 };

describe("the lease holder's connection", () => {
  it("checkpoints on its own schedule only while it holds the lease; a connection without it keeps SQLite's default", async () => {
    const holder = await openStoreFile();
    const otherDb = await openSqlite(holder.path);
    if (!otherDb) throw new Error("no sqlite");
    dbs.push(otherDb);
    const other = openV1Store(otherDb);
    if (!other) throw new Error("openStore returned null");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const holderCheckpoints = vi.spyOn(holder.store, "checkpoint");
    const otherCheckpoints = vi.spyOn(other, "checkpoint");
    expect(autoCheckpoint(holder.db)).toBe(1000);

    start(holder.store, { instanceId: "holder" });
    const follower = start(other, { instanceId: "follower" });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(follower.status().leaseHeld).toBe(false);
    expect(autoCheckpoint(holder.db)).toBe(0);
    expect(holderCheckpoints).toHaveBeenCalled();
    expect(autoCheckpoint(otherDb)).toBe(1000);
    expect(otherCheckpoints).not.toHaveBeenCalled();
  });

  it("checkpoints on a timer every 10 ms while checkpoints find new frames, and every second once they find none", async () => {
    const { store } = await openStoreFile();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const t0 = Date.now();
    const results: Array<WalCheckpoint | Error> = [
      { busy: false, frames: 4, checkpointed: 4 }, // frames the last one did not see
      { busy: false, frames: 4, checkpointed: 4 }, // nothing new
      { busy: false, frames: 9, checkpointed: 9 }, // new frames
      { busy: false, frames: 9, checkpointed: 6 }, // a reader held some back
      { busy: false, frames: 9, checkpointed: 9 }, // nothing new
      new Error("database is locked"), // a failure counts as nothing new
      { busy: false, frames: 2, checkpointed: 2 }, // the WAL started over
    ];
    const at: number[] = [];
    vi.spyOn(store, "checkpoint").mockImplementation(() => {
      at.push(Date.now() - t0);
      const next = results.shift() ?? { busy: false, frames: 2, checkpointed: 2 };
      if (next instanceof Error) throw next;
      return next;
    });
    const logs: string[] = [];
    start(store, { now: () => Date.now(), log: (line) => logs.push(line) });

    await vi.advanceTimersByTimeAsync(3_050);
    expect(at).toEqual([10, 20, 1020, 1030, 1040, 2040, 3040, 3050]);
    expect(logs.some((line) => line.includes("WAL checkpoint failed: database is locked"))).toBe(
      true,
    );
  });

  it.each([
    {
      how: "its heartbeat",
      // A heartbeat runs within the lease's TTL.
      detect: async (): Promise<void> => {
        await vi.advanceTimersByTimeAsync(30_000);
      },
    },
    {
      how: "a check of the lease",
      detect: async (distiller: Distiller): Promise<void> => {
        expect(distiller.ownsLease()).toBe(false);
      },
    },
  ])(
    "gives its connection back to SQLite's automatic checkpoints once $how finds a rival holding the lease, and takes it again with the lease",
    async ({ detect }) => {
      let leaseClock = 1_000_000;
      const { db, store } = await openStoreFile(() => leaseClock);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      /** The connection's setting at each checkpoint. */
      const settings: number[] = [];
      const checkpoint = store.checkpoint.bind(store);
      vi.spyOn(store, "checkpoint").mockImplementation(() => {
        settings.push(autoCheckpoint(db));
        return checkpoint();
      });
      const distiller = start(store, { leaseRetryMs: 100 });
      await vi.advanceTimersByTimeAsync(10);
      expect(settings).toEqual([0]);

      leaseClock += 31_000;
      expect(store.acquireLease("rival", 30_000, "rivalbuild", 4)).toBe(true);
      await detect(distiller);
      expect(autoCheckpoint(db)).toBe(1000);
      const taken = settings.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settings).toHaveLength(taken);
      expect(settings.every((setting) => setting === 0)).toBe(true);

      expect(store.releaseLease("rival")).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(distiller.status().leaseHeld).toBe(true);
      expect(autoCheckpoint(db)).toBe(0);
      await vi.advanceTimersByTimeAsync(10);
      expect(settings.length).toBeGreaterThan(taken);
    },
  );

  it.each(["quiesce", "stop"] as const)(
    "gives its connection back to SQLite's automatic checkpoints on %s and checkpoints no more",
    async (method) => {
      const { db, store } = await openStoreFile();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const checkpoints = vi.spyOn(store, "checkpoint");
      const distiller = start(store);
      await vi.advanceTimersByTimeAsync(10);
      expect(checkpoints).toHaveBeenCalledTimes(1);

      if (method === "quiesce") distiller.quiesce();
      else await distiller.stop();
      expect(autoCheckpoint(db)).toBe(1000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(checkpoints).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves checkpoints to the connection when it cannot turn them off, and says so", async () => {
    const { db, store } = await openStoreFile();
    const sessions = upToDateSessions(db, store);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(store, "setAutoCheckpoint").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    const checkpoints = vi.spyOn(store, "checkpoint");
    const logs: string[] = [];
    let clock = 1_000_000;
    const distiller = start(store, {
      sessions,
      now: () => clock,
      yieldBetween: async () => {
        clock += 10;
      },
      log: (line) => logs.push(line),
    });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(distiller.status()).toMatchObject({ leaseHeld: true, coldPass: "done" });
    expect(autoCheckpoint(db)).toBe(1000);
    expect(checkpoints).not.toHaveBeenCalled();
    expect(
      logs.some((line) => line.includes("could not change WAL checkpoints: disk I/O error")),
    ).toBe(true);
  });
});

describe("a background slice of the lease holder", () => {
  /**
   * A cold pass over {@link upToDateSessions}, with no timed checkpoint (the
   * timers never move) and `performance.now` frozen except for `cost`, the
   * milliseconds each checkpoint takes. Each yield moves the distiller's clock
   * on by `step`. Returns, per session, what happened between the previous
   * session's card read and its own: yields and checkpoints, in order.
   */
  async function slices(o: { step: number; cost?: number }): Promise<string[][]> {
    const { db, store } = await openStoreFile();
    const sessions = upToDateSessions(db, store);
    const ids = new Set(sessions.map((s) => s.id));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let perf = 5_000;
    vi.spyOn(performance, "now").mockImplementation(() => perf);
    const events: string[] = [];
    vi.spyOn(store, "checkpoint").mockImplementation(() => {
      events.push("checkpoint");
      perf += o.cost ?? 0;
      return IDLE;
    });
    const getCard = store.getCard.bind(store);
    vi.spyOn(store, "getCard").mockImplementation((id) => {
      if (ids.has(id)) events.push("read");
      return getCard(id);
    });
    let clock = 1_000_000;
    let done!: () => void;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    start(store, {
      sessions,
      now: () => clock,
      yieldBetween: async () => {
        events.push("yield");
        clock += o.step;
      },
      onColdPassDone: () => done(),
    });
    await finished;
    const perSession: string[][] = [[]];
    for (const event of events) {
      if (event === "read") perSession.push([]);
      else perSession.at(-1)!.push(event);
    }
    // What follows the last read is the end of the pass, not a session's.
    return perSession.slice(0, -1);
  }

  it("checkpoints at the start of every slice once the last checkpoint is 10 ms old", async () => {
    expect(await slices({ step: 10 })).toEqual(Array(5).fill(["yield", "checkpoint"]));
  });

  it("does not checkpoint at the start of a slice while the last checkpoint is younger than 10 ms", async () => {
    // Every other slice starts 10 ms after the last checkpoint.
    expect(await slices({ step: 5 })).toEqual([
      ["yield", "checkpoint"],
      ["yield"],
      ["yield", "checkpoint"],
      ["yield"],
      ["yield", "checkpoint"],
    ]);
  });

  it("yields again after a checkpoint that took 2 ms, before the slice's own work", async () => {
    expect(await slices({ step: 10, cost: 2 })).toEqual(
      Array(5).fill(["yield", "checkpoint", "yield"]),
    );
  });

  it("goes on with the slice's work after a checkpoint that took under 2 ms", async () => {
    expect(await slices({ step: 10, cost: 1.9 })).toEqual(Array(5).fill(["yield", "checkpoint"]));
  });
});
