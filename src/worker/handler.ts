import { BUILD_ID } from "../build-id.js";
import { createDistiller, type Distiller, type DistillSignal } from "../distill.js";
import { EMBED_REPRESENTATION } from "../embedding-text.js";
import { createFetchGate } from "../fetch-gate.js";
import { foregroundSignalFrom } from "../foreground.js";
import { createHistoryDriftState, type HistoryDriftState } from "../history/source.js";
import { createV2HistorySource, openOpencodeDb, v2DriftBase } from "../history/v2.js";
import { discoverSessions } from "../history/v2-discovery.js";
import { V2_PROJECTOR_GEN } from "../history/v2-project.js";
import { createV2Sync, type V2SyncOptions } from "../history/v2-sync.js";
import type { ThreadPortLike } from "../node-import.js";
import { isCorruptError, openSqlite, type ReadOnlyDb, type SqliteDb } from "../sqlite.js";
import { openStore, pluginBuild, type Store } from "../store.js";
import { errmsg, settleWithin } from "../types.js";
import { yieldBackgroundTo, yieldInBackground } from "../yield.js";
import {
  isMainMessage,
  LOG_LINE_CHARS,
  LOG_LINES_PER_SECOND,
  PROTOCOL_VERSION,
  STATUS_CHECK_MS,
  STATUS_EVERY_MS,
  STORE_LOCK_RETRY_FIRST_MS,
  STORE_LOCK_RETRY_MAX_MS,
  type EventsMessage,
  type InitMessage,
  type StopMessage,
  type VectorsMessage,
  type WorkerMessage,
  type WorkerStatus,
} from "./protocol.js";

/**
 * The distiller's side of the worker protocol, independent of how messages
 * travel: `src/distill-worker.ts` runs it on a worker thread's parent port,
 * and the inline starter and the tests run it on an in-process
 * `MessageChannel`, with the same structured cloning.
 *
 * Once `init` arrives it opens its own read-only `opencode.db` handle and the
 * only writable connection to the store (`openStore`, the fence and any
 * migration), runs one read on it so the store's WAL files exist for main's
 * reader, and reports the fence result as `store`. It then runs the whole v2
 * distiller: the lease, the cold pass, the polls, the repair sweep, the range
 * check, the rollups and the WAL checkpoints. Its background work gives way
 * to main's foreground signal. Vector writes main asks for run at once,
 * through `writeCardEmbeddings`, whatever the signal reads.
 */

/** The message surface the handler needs: Node's and Bun's `MessagePort`
 *  through {@link portOf}, or a test's own. */
export type WorkerPort = {
  postMessage(message: WorkerMessage, transfer?: ArrayBuffer[]): void;
  onMessage(listener: (message: unknown) => void): void;
  close(): void;
};

/** A `node:worker_threads` port as a {@link WorkerPort}. */
export function portOf(port: ThreadPortLike): WorkerPort {
  return {
    postMessage: (message, transfer) => port.postMessage(message, transfer),
    onMessage: (listener) => {
      port.on("message", listener);
    },
    close: () => port.close(),
  };
}

export type WorkerHandlerOptions = {
  /** The generation every message carries, which main assigned. */
  generation: number;
  /** Opens the store's writable connection (default {@link openSqlite}). A
   *  test wraps the handle it returns, to stall or fail inside a
   *  transaction. */
  openStoreDb?: (path: string) => Promise<SqliteDb | null>;
  now?: () => number;
  /** The waits before a store open whose write lock was held runs again
   *  (default {@link STORE_LOCK_RETRY_FIRST_MS}, doubling up to
   *  {@link STORE_LOCK_RETRY_MAX_MS}). */
  lockRetryMs?: { first: number; max: number };
};

export type WorkerHandler = {
  /**
   * End at once, as a thread's end would: no further message is posted, every
   * store call from here on throws, and both connections close. The lease is
   * not released, so it stays with this holder until it expires or is taken
   * over. Idempotent.
   */
  halt(): void;
  /** Settles once the handler has stopped or halted. */
  readonly done: Promise<void>;
};

/** What the handler knows of its store's calls. */
type StoreProbe = {
  /** The longest synchronous call since the last status. */
  longest: number;
  /** Every call from now on throws. */
  severed: boolean;
};

/**
 * `store` with every method timed, a damaged file reported through
 * `onCorrupt`, and every call refused once `probe.severed` is set.
 */
function instrumentStore(
  store: Store,
  probe: StoreProbe,
  onCorrupt: (error: unknown) => void,
): Store {
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const cached = wrapped.get(property);
      if (cached) return cached;
      const method = value as (...args: unknown[]) => unknown;
      const call = (...args: unknown[]): unknown => {
        if (probe.severed) throw new Error("the store connection is closed");
        const started = performance.now();
        try {
          return method.apply(target, args);
        } catch (error) {
          if (isCorruptError(error)) onCorrupt(error);
          throw error;
        } finally {
          const took = performance.now() - started;
          if (took > probe.longest) probe.longest = took;
        }
      };
      wrapped.set(property, call);
      return call;
    },
  });
}

/** The numeric sync timings of an `init`, as `V2SyncOptions`. */
function syncOptionsOf(sync: InitMessage["sync"]): V2SyncOptions {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(sync ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out as V2SyncOptions;
}

/** Why an `init` from another build must not run here, or undefined. */
function buildMismatch(init: InitMessage): string | undefined {
  const mine = {
    buildId: BUILD_ID,
    build: pluginBuild("opencode-v2", V2_PROJECTOR_GEN),
    representation: EMBED_REPRESENTATION,
    projectorGen: V2_PROJECTOR_GEN,
  };
  for (const key of Object.keys(mine) as Array<keyof typeof mine>) {
    if (init[key] !== mine[key]) {
      return `build mismatch: main has ${key} ${String(init[key])}, the worker ${String(mine[key])}`;
    }
  }
  return undefined;
}

function closeQuietly(db: Pick<SqliteDb, "close"> | null): void {
  try {
    db?.close();
  } catch {
    // Best-effort.
  }
}

/** A Node or Bun timer must not keep the thread alive on its own. */
function unref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  (timer as { unref?: () => void }).unref?.();
}

type Body<T> = T extends unknown ? Omit<T, "v" | "generation"> : never;

export function runWorkerHandler(port: WorkerPort, options: WorkerHandlerOptions): WorkerHandler {
  const generation = options.generation;
  const now = options.now ?? Date.now;
  const openStoreDb = options.openStoreDb ?? openSqlite;
  const lockRetry = options.lockRetryMs ?? {
    first: STORE_LOCK_RETRY_FIRST_MS,
    max: STORE_LOCK_RETRY_MAX_MS,
  };
  /** The wait before the store's open runs again, which a stop or a halt
   *  ends at once. */
  let lockWait: (() => void) | undefined;
  let lockTimer: ReturnType<typeof setTimeout> | undefined;

  let halted = false;
  let stopping = false;
  let initStarted = false;
  let sourceDb: ReadOnlyDb | null = null;
  let storeDb: SqliteDb | null = null;
  let store: Store | null = null;
  let distiller: Distiller | undefined;
  let drift: HistoryDriftState | undefined;
  let holderId = "";
  const probe: StoreProbe = { longest: 0, severed: false };
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let lastStatusKey: string | undefined;
  let lastStatusAt = -Infinity;
  let corruptReported = false;
  let settleDone!: () => void;
  const done = new Promise<void>((resolve) => (settleDone = resolve));

  const send = (message: Body<WorkerMessage>, transfer?: ArrayBuffer[]): void => {
    if (halted) return;
    try {
      port.postMessage({ v: PROTOCOL_VERSION, generation, ...message } as WorkerMessage, transfer);
    } catch {
      // A closed port: main is gone or has dropped this generation.
    }
  };

  // ── Logging, rate-limited ──
  let logWindow = 0;
  let logCount = 0;
  let logDropped = 0;
  const log = (message: string): void => {
    const second = Math.floor(now() / 1_000);
    if (second !== logWindow) {
      logWindow = second;
      logCount = 0;
    }
    if (logCount >= LOG_LINES_PER_SECOND) {
      logDropped++;
      return;
    }
    logCount++;
    const line = message.length > LOG_LINE_CHARS ? message.slice(0, LOG_LINE_CHARS) : message;
    send({ type: "log", line, ...(logDropped > 0 && { dropped: logDropped }) });
    logDropped = 0;
  };

  const fatal = (kind: "store" | "crash", reason: string): void => {
    send({ type: "fatal", kind, reason });
  };

  // ── Status ──
  const statusNow = (): WorkerStatus | undefined => {
    if (!distiller || !store) return undefined;
    return {
      holderId,
      distill: distiller.status(),
      indexing: distiller.indexing(),
      repair: distiller.repair(),
      discoveryTruncated: distiller.discoveryTruncated(),
      ...(drift && { drift: drift.snapshot() }),
      longestStoreCallMs: probe.longest,
    };
  };

  const postStatus = (force: boolean): void => {
    if (halted || probe.severed) return;
    let status: WorkerStatus | undefined;
    try {
      status = statusNow();
    } catch (error) {
      log(`status read failed: ${errmsg(error)}`);
      return;
    }
    if (!status) return;
    const key = JSON.stringify({ ...status, longestStoreCallMs: 0 });
    if (!force && (key === lastStatusKey || now() - lastStatusAt < STATUS_EVERY_MS)) return;
    lastStatusKey = key;
    lastStatusAt = now();
    probe.longest = 0;
    send({ type: "status", status });
  };

  const onCorrupt = (error: unknown): void => {
    if (corruptReported) return;
    corruptReported = true;
    fatal("store", `the store file is damaged: ${errmsg(error)}`);
    // Nothing more is written to a damaged file.
    distiller?.quiesce();
    probe.severed = true;
  };

  const clearTimers = (): void => {
    if (statusTimer !== undefined) clearInterval(statusTimer);
    statusTimer = undefined;
    if (lockTimer !== undefined) clearTimeout(lockTimer);
    lockTimer = undefined;
    lockWait?.();
  };

  const closeAll = (): void => {
    closeQuietly(storeDb);
    storeDb = null;
    closeQuietly(sourceDb);
    sourceDb = null;
  };

  // ── Requests ──
  async function init(message: InitMessage): Promise<void> {
    if (initStarted) return;
    initStarted = true;
    const mismatch = buildMismatch(message);
    if (mismatch) {
      fatal("crash", mismatch);
      return;
    }
    holderId = message.holderId;
    const opened = await openOpencodeDb(message.sourcePath);
    if (halted || stopping) {
      if (opened.ok) closeQuietly(opened.db);
      return;
    }
    if (!opened.ok) {
      fatal("crash", `opencode history unavailable: ${opened.reason}`);
      return;
    }
    sourceDb = opened.db;
    const schema = opened.schema;
    drift = createHistoryDriftState(v2DriftBase(schema));

    const db = await openStoreDb(message.storePath);
    if (halted || stopping) {
      closeQuietly(db);
      return;
    }
    if (!db) {
      fatal("crash", "SQLite could not open the store");
      return;
    }
    // Closed by a stop or a halt that arrives while the open waits.
    storeDb = db;
    let result = openStore(db, { host: "opencode-v2", source: message.sourcePath });
    // Another connection held the write lock past the open's busy timeout:
    // no refusal, so the open runs again after a wait that doubles up to a
    // bound, on this thread, for as long as the lock stays held. Main hears
    // of each wait and counts none of them as a failure.
    for (let attempt = 1; !result.ok && result.busy; attempt++) {
      const retryInMs = Math.min(lockRetry.first * 2 ** (attempt - 1), lockRetry.max);
      send({
        type: "waiting",
        reason: "another process holds the store's write lock",
        attempt,
        retryInMs,
      });
      await new Promise<void>((resolve) => {
        lockWait = resolve;
        lockTimer = setTimeout(resolve, retryInMs);
        unref(lockTimer);
      });
      lockWait = undefined;
      lockTimer = undefined;
      if (halted || stopping) return;
      result = openStore(db, { host: "opencode-v2", source: message.sourcePath });
    }
    if (!result.ok) {
      storeDb = null;
      closeQuietly(db);
      send({ type: "store", id: message.id, ok: false, reason: result.reason });
      return;
    }
    store = instrumentStore(result.store, probe, onCorrupt);
    // SQLite creates the WAL and its index file at a connection's first
    // statement in WAL mode, and openStore switches a new store to WAL as
    // its last step: main's reader refuses a store without them.
    store.cardCounters();

    const foreground = foregroundSignalFrom(message.foreground);
    const gate = createFetchGate({ concurrency: message.limits.concurrency, foreground });
    const distillSource = createV2HistorySource(sourceDb, {
      schema,
      drift,
      yieldBetween: yieldInBackground,
    });
    distiller = createDistiller({
      source: distillSource,
      store,
      gate,
      limits: message.limits,
      instanceId: holderId,
      build: message.build,
      gen: EMBED_REPRESENTATION,
      projectorGen: V2_PROJECTOR_GEN,
      ...(message.takeOver !== undefined && { takeOverLease: message.takeOver }),
      discover: () => discoverSessions(distillSource, yieldInBackground),
      log,
      sync: createV2Sync(sourceDb, {
        yieldBetween: yieldInBackground,
        ...syncOptionsOf(message.sync),
        schema,
      }),
      yieldBetween: yieldInBackground,
      ...(message.idleDebounceMs !== undefined && { idleDebounceMs: message.idleDebounceMs }),
    });
    // This thread's background yields give way to the tools main runs.
    yieldBackgroundTo(foreground);
    send({
      type: "store",
      id: message.id,
      ok: true,
      ...(result.warning !== undefined && { warning: result.warning }),
    });
    statusTimer = setInterval(() => postStatus(false), STATUS_CHECK_MS);
    unref(statusTimer);
    if (message.limits.coldPass) distiller.start();
    postStatus(true);
  }

  function events(message: EventsMessage): void {
    if (!distiller || stopping || !Array.isArray(message.signals)) return;
    for (const signal of message.signals as unknown[]) {
      if (typeof signal !== "object" || signal === null) continue;
      const { type, sessionID } = signal as { type?: unknown; sessionID?: unknown };
      if (typeof sessionID !== "string") continue;
      if (type === "turn-ended" || type === "removal" || type === "deleted" || type === "meta") {
        distiller.onEvent(signal as DistillSignal);
      }
    }
  }

  function vectors(message: VectorsMessage): void {
    const reply = (
      outcome: "committed" | "refused" | "failed",
      extra: { reason?: string; revision?: number } = {},
    ): void => send({ type: "reply", id: message.id, outcome, ...extra });
    if (!store || stopping || probe.severed) {
      reply("failed", { reason: "the store is not open" });
      return;
    }
    if (now() > message.deadline) {
      reply("refused", { reason: "the deadline passed before the write ran" });
      return;
    }
    try {
      const write = store.writeCardEmbeddings(message.model, message.representation, message.rows);
      if (write.committed) reply("committed", { revision: write.revision });
      else reply("refused", { reason: "a stored vector has a higher representation generation" });
    } catch (error) {
      reply("failed", { reason: errmsg(error) });
    }
  }

  async function stop(message: StopMessage): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearTimers();
    if (distiller) {
      distiller.quiesce();
      // Leave a little of the deadline for the checkpoint and the reply.
      await settleWithin(distiller.stop(), Math.max(0, message.deadline - now() - 100));
    }
    if (store && !probe.severed) {
      try {
        store.checkpoint();
      } catch {
        // The next writer checkpoints what this one left.
      }
    }
    probe.severed = true;
    closeAll();
    yieldBackgroundTo(undefined);
    send({ type: "stopped", id: message.id });
    settleDone();
  }

  const crashed = (error: unknown): void => {
    fatal("crash", `the worker failed: ${errmsg(error)}`);
  };

  port.onMessage((raw) => {
    if (halted) return;
    if (!isMainMessage(raw)) {
      const type = (raw as { type?: unknown } | null)?.type;
      if (type === "init") fatal("crash", "protocol version mismatch");
      return;
    }
    if (raw.generation !== generation) return;
    try {
      switch (raw.type) {
        case "init":
          void init(raw).catch(crashed);
          break;
        case "events":
          events(raw);
          break;
        case "vectors":
          vectors(raw);
          break;
        case "stop":
          void stop(raw).catch(crashed);
          break;
      }
    } catch (error) {
      crashed(error);
    }
  });

  send({ type: "ready", buildId: BUILD_ID });

  return {
    halt() {
      if (halted) return;
      halted = true;
      clearTimers();
      probe.severed = true;
      if (distiller) {
        distiller.quiesce();
        // Its lease release fails on the severed store, as it would after a
        // thread's end, so the lease stays with this holder.
        void distiller.stop();
      }
      closeAll();
      if (!stopping) yieldBackgroundTo(undefined);
      try {
        port.close();
      } catch {
        // Already closed.
      }
      settleDone();
    },
    done,
  };
}
