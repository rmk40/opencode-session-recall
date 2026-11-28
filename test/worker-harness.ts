import { MessageChannel, type MessagePort } from "node:worker_threads";
import { BUILD_ID } from "../src/build-id.js";
import { EMBED_REPRESENTATION } from "../src/embedding-text.js";
import { createForegroundSignal, type ForegroundSignal } from "../src/foreground.js";
import { V2_PROJECTOR_GEN } from "../src/history/v2-project.js";
import { V2_PLUGIN_BUILD } from "../src/host/v2-runtime.js";
import { openSqlite, type ReadOnlyDb, type SqliteDb } from "../src/sqlite.js";
import type { LeaseInfo } from "../src/store.js";
import type { Limits } from "../src/types.js";
import {
  createWorkerController,
  type WorkerController,
  type WorkerControllerOptions,
  type WorkerInit,
} from "../src/worker/controller.js";
import { runWorkerHandler, type WorkerHandler, type WorkerPort } from "../src/worker/handler.js";
import { PROTOCOL_VERSION, type MainMessage, type WorkerMessage } from "../src/worker/protocol.js";
import type { WorkerLike, WorkerStarter } from "../src/worker/start.js";
import { TEST_LIMITS } from "./helpers.js";

/**
 * Helpers for the distiller worker's tests. The handler runs on the test's
 * own thread over an in-process `MessageChannel`, which clones messages as a
 * thread boundary does, so these exercise the same protocol a thread would.
 * The compiled worker in a real thread has its own runner
 * (`test/compiled/worker-runner.ts`).
 */

/** Where a harnessed handler ends as a crashed thread would.
 *  - `before-commit`: inside a write transaction, before its COMMIT (the
 *    transaction rolls back);
 *  - `after-commit`: right after a write transaction committed, before
 *    anything else runs, so the reply for it never arrives;
 *  - `during-shutdown`: when the `stop` request arrives, before the handler
 *    sees it.
 *  `skip` lets that many write transactions pass first. */
export type WorkerFault =
  | { at: "before-commit" | "after-commit"; skip?: number }
  | { at: "during-shutdown" };

/** One generation's handler, as the harness ran it. */
export type HandlerSide = {
  generation: number;
  handler: WorkerHandler;
  /** Every message main sent to the handler, in order. */
  received: MainMessage[];
  /** Every message the handler posted, delivered or not, in order. */
  sent: WorkerMessage[];
  /** When each message of {@link sent} was posted (`Date.now()`). */
  sentAt: number[];
  /** End the handler now, as a crashed thread: nothing more is delivered
   *  either way, the store connection closes without releasing the lease,
   *  and main's exit listeners run on a later turn. */
  crash(): void;
  /** End the handler at a later point ({@link WorkerFault}). */
  arm(fault: WorkerFault): void;
  /** Hold every message of `types` (every type when undefined) for `ms`
   *  before it reaches main; `undefined` delivers at once again. */
  delay(ms: number | undefined, types?: Array<WorkerMessage["type"]>): void;
  /** Whether the handler ended (crashed or terminated). */
  readonly ended: boolean;
};

export type WorkerHarness = {
  /** A starter for `createWorkerController` or `V2RuntimeInputs.worker.start`. */
  start: WorkerStarter;
  /** Each generation's handler side, in start order. */
  readonly sides: HandlerSide[];
  side(generation: number): HandlerSide | undefined;
  /** Faults armed for every generation the harness starts from now on. */
  armAll(fault: WorkerFault | undefined): void;
  /** Make the next `n` starts reject, as a thread that cannot load. */
  failStarts(n: number): void;
};

/** A store handle whose write transactions end the handler at an armed
 *  fault. */
function faultyDb(db: SqliteDb, state: { fault?: WorkerFault; crash(): void }): SqliteDb {
  return {
    ...db,
    tx<T>(fn: () => T): T {
      const fault = state.fault;
      const inTx = fault && fault.at !== "during-shutdown" ? fault : undefined;
      const due = (): boolean => {
        if (!inTx) return false;
        if ((inTx.skip ?? 0) > 0) {
          inTx.skip = (inTx.skip ?? 0) - 1;
          return false;
        }
        return true;
      };
      if (inTx?.at === "before-commit") {
        return db.tx(() => {
          const result = fn();
          if (due()) {
            state.fault = undefined;
            state.crash();
            throw new Error("the worker crashed before its commit");
          }
          return result;
        });
      }
      const result = db.tx(fn);
      if (inTx?.at === "after-commit" && due()) {
        state.fault = undefined;
        state.crash();
      }
      return result;
    },
  };
}

/** The inline harness: each generation's handler runs here, over a
 *  `MessageChannel`, with crash points and delayed replies. */
export function workerHarness(
  opts: {
    openStoreDb?: (path: string) => Promise<SqliteDb | null>;
    /** The handlers' clock (`WorkerHandlerOptions.now`). */
    now?: () => number;
  } = {},
): WorkerHarness {
  const sides: HandlerSide[] = [];
  let allFault: WorkerFault | undefined;
  let failingStarts = 0;
  const openBase = opts.openStoreDb ?? openSqlite;

  const start: WorkerStarter = async (generation) => {
    if (failingStarts > 0) {
      failingStarts--;
      throw new Error("the worker module did not load");
    }
    const { port1, port2 } = new MessageChannel();
    port1.unref();
    port2.unref();
    const exitListeners: Array<() => void> = [];
    const messageListeners: Array<(message: unknown) => void> = [];
    let ended = false;
    let delayMs: number | undefined;
    let delayTypes: Set<string> | undefined;
    const received: MainMessage[] = [];
    const sent: WorkerMessage[] = [];
    const sentAt: number[] = [];
    const state: { fault?: WorkerFault; crash(): void } = {
      fault: allFault && { ...allFault },
      crash: () => end(),
    };

    const handlerPort: WorkerPort = {
      postMessage(message, transfer) {
        sent.push(message);
        sentAt.push(Date.now());
        if (ended) return;
        const deliver = (): void => {
          if (!ended) port2.postMessage(message, transfer ?? []);
        };
        if (delayMs !== undefined && (!delayTypes || delayTypes.has(message.type))) {
          setTimeout(deliver, delayMs);
        } else deliver();
      },
      onMessage(listener) {
        messageListeners.push(listener);
      },
      close() {
        port2.close();
      },
    };
    port2.on("message", (message: MainMessage) => {
      if (ended) return;
      received.push(message);
      if (message.type === "stop" && state.fault?.at === "during-shutdown") {
        state.fault = undefined;
        end();
        return;
      }
      for (const listener of messageListeners) listener(message);
    });

    const handler = runWorkerHandler(handlerPort, {
      generation,
      ...(opts.now && { now: opts.now }),
      openStoreDb: async (path) => {
        const db = await openBase(path);
        return db ? faultyDb(db, state) : db;
      },
    });

    function end(): void {
      if (ended) return;
      ended = true;
      handler.halt();
      closePort(port1);
      setTimeout(() => {
        for (const listener of exitListeners.splice(0)) listener();
      }, 0);
    }

    const side: HandlerSide = {
      generation,
      handler,
      received,
      sent,
      sentAt,
      crash: end,
      arm(fault) {
        state.fault = { ...fault };
      },
      delay(ms, types) {
        delayMs = ms;
        delayTypes = types && new Set(types);
      },
      get ended() {
        return ended;
      },
    };
    sides.push(side);

    const worker: WorkerLike = {
      postMessage: (message, transfer) => {
        if (!ended) port1.postMessage(message, transfer ?? []);
      },
      onMessage: (listener) => {
        port1.on("message", listener);
      },
      onError: () => {
        // The handler reports its own failures as `fatal`.
      },
      onExit: (listener) => {
        exitListeners.push(listener);
      },
      terminate: end,
    };
    return worker;
  };

  return {
    start,
    sides,
    side: (generation) => sides.find((side) => side.generation === generation),
    armAll(fault) {
      allFault = fault;
    },
    failStarts(n) {
      failingStarts = n;
    },
  };
}

function closePort(port: MessagePort): void {
  try {
    port.close();
  } catch {
    // Already closed.
  }
}

/** A worker `init` for a scratch store and `opencode.db`, with this build's
 *  tags. */
export function workerInit(o: {
  storePath: string;
  sourcePath: string;
  limits?: Partial<Limits>;
  foreground?: ForegroundSignal;
  sync?: WorkerInit["sync"];
  idleDebounceMs?: number;
}): WorkerInit {
  return {
    buildId: BUILD_ID,
    build: V2_PLUGIN_BUILD,
    representation: EMBED_REPRESENTATION,
    projectorGen: V2_PROJECTOR_GEN,
    storePath: o.storePath,
    sourcePath: o.sourcePath,
    limits: { ...TEST_LIMITS, ...o.limits },
    ...(o.sync && { sync: o.sync }),
    ...(o.idleDebounceMs !== undefined && { idleDebounceMs: o.idleDebounceMs }),
    foreground: (o.foreground ?? createForegroundSignal()).buffer,
  };
}

/** What a harnessed controller's callbacks reported. */
export type ControllerRecord = {
  storeOpens: Array<string | undefined>;
  stopped: string[];
  inline: Array<{ reason: string; lastHolder: string | undefined }>;
  logs: string[];
};

/**
 * A controller over `harness`, with callbacks that record what they were
 * told. `onStoreOpen` accepts by default; `readLease` reads nothing unless
 * given. Fast restart delays (0 ms) unless `overrides` names others.
 */
export function harnessController(
  harness: WorkerHarness,
  init: WorkerInit,
  overrides: Partial<WorkerControllerOptions> = {},
): { controller: WorkerController; record: ControllerRecord } {
  const record: ControllerRecord = { storeOpens: [], stopped: [], inline: [], logs: [] };
  const controller = createWorkerController({
    start: harness.start,
    instanceId: "harness",
    init,
    log: (line) => record.logs.push(line),
    onStoreOpen: async (warning) => {
      record.storeOpens.push(warning);
      return { ok: true };
    },
    onStopped: (reason) => record.stopped.push(reason),
    onInline: (reason, lastHolder) => record.inline.push({ reason, lastHolder }),
    readLease: (): LeaseInfo | undefined => undefined,
    restartDelaysMs: [0, 0],
    ...overrides,
  });
  return { controller, record };
}

/** A read handle wrapper that records every statement main's store reader
 *  runs (`V2RuntimeInputs.wrapReader`, `ReadStoreOptions.wrapReader`). */
export function readerStatements(): {
  wrap: (db: ReadOnlyDb) => ReadOnlyDb;
  statements: string[];
  /** The recorded statements that are not reads: anything but a `SELECT`,
   *  a `WITH` query or a `PRAGMA` that sets nothing. */
  nonReads(): string[];
  /** How many times a wrapped handle was closed. */
  readonly closes: number;
  /** Called each time a wrapped handle is closed, before it closes. */
  onClose?: () => void;
} {
  const statements: string[] = [];
  let closes = 0;
  const isRead = (sql: string): boolean => {
    const text = sql.trim();
    if (/^(SELECT|WITH)\b/i.test(text)) return !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(text);
    return /^PRAGMA\s+[\w.]+(\([^)]*\))?\s*;?$/i.test(text) && !text.includes("=");
  };
  const recorder: ReturnType<typeof readerStatements> = {
    statements,
    wrap: (db) => ({
      get: (sql, params) => {
        statements.push(sql);
        return db.get(sql, params);
      },
      all: (sql, params) => {
        statements.push(sql);
        return db.all(sql, params);
      },
      close: () => {
        closes++;
        recorder.onClose?.();
        db.close();
      },
    }),
    nonReads: () => statements.filter((sql) => !isRead(sql)),
    get closes() {
      return closes;
    },
  };
  return recorder;
}

/** One worker a {@link scriptedWorkers} starter started: the test plays the
 *  worker's side by hand. */
export type ScriptedWorker = {
  generation: number;
  /** Every message main sent, in order, with the transfer list it gave. */
  received: Array<{ message: MainMessage; transfer: ArrayBuffer[] | undefined }>;
  /** Deliver `message` to main as this worker's, with this generation and
   *  protocol version unless `message` sets its own. */
  emit(message: Record<string, unknown>): void;
  /** Deliver a raw value to main, as is. */
  emitRaw(value: unknown): void;
  /** Report an `error` event. */
  error(error: unknown): void;
  /** Report the thread's exit. */
  exit(): void;
  /** How many times main asked the worker to end. */
  readonly terminations: number;
  /** The last message main sent of `type`, if any. */
  last<T extends MainMessage["type"]>(type: T): Extract<MainMessage, { type: T }> | undefined;
};

/**
 * A starter whose workers do nothing on their own: no `ready`, no exit after
 * `terminate()`. Each starts as the test scripts it, so the controller's
 * timeouts, restarts and exits can be driven one at a time (with fake timers).
 */
export function scriptedWorkers(): {
  start: WorkerStarter;
  readonly workers: ScriptedWorker[];
  worker(generation: number): ScriptedWorker;
  /** Make the next `n` starts reject. */
  failStarts(n: number): void;
} {
  const workers: ScriptedWorker[] = [];
  let failing = 0;
  const start: WorkerStarter = async (generation) => {
    if (failing > 0) {
      failing--;
      throw new Error("the worker module did not load");
    }
    const messageListeners: Array<(message: unknown) => void> = [];
    const errorListeners: Array<(error: unknown) => void> = [];
    const exitListeners: Array<() => void> = [];
    let terminations = 0;
    const scripted: ScriptedWorker = {
      generation,
      received: [],
      emit: (message) => {
        const full = { v: PROTOCOL_VERSION, generation, ...message };
        for (const listener of messageListeners) listener(full);
      },
      emitRaw: (value) => {
        for (const listener of messageListeners) listener(value);
      },
      error: (error) => {
        for (const listener of errorListeners) listener(error);
      },
      exit: () => {
        for (const listener of exitListeners) listener();
      },
      get terminations() {
        return terminations;
      },
      last: (type) =>
        [...scripted.received].reverse().find((entry) => entry.message.type === type)
          ?.message as never,
    };
    workers.push(scripted);
    return {
      postMessage: (message, transfer) => {
        scripted.received.push({ message, transfer });
      },
      onMessage: (listener) => {
        messageListeners.push(listener);
      },
      onError: (listener) => {
        errorListeners.push(listener);
      },
      onExit: (listener) => {
        exitListeners.push(listener);
      },
      terminate: () => {
        terminations++;
      },
    };
  };
  return {
    start,
    workers,
    worker: (generation) => {
      const found = workers.find((w) => w.generation === generation);
      if (!found) throw new Error(`no worker of generation ${generation} started`);
      return found;
    },
    failStarts: (n) => {
      failing = n;
    },
  };
}
