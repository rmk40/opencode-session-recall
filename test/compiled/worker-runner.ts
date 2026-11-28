import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EMBED_REPRESENTATION } from "../../src/embedding-text.js";
import { createForegroundSignal, type ForegroundSignal } from "../../src/foreground.js";
import { V2_PROJECTOR_GEN } from "../../src/history/v2-project.js";
import { pluginBuild } from "../../src/store.js";
import type { Limits } from "../../src/types.js";
import {
  PROTOCOL_VERSION,
  isWorkerMessage,
  type InitMessage,
  type MainMessage,
  type WorkerMessage,
} from "../../src/worker/protocol.js";
import { TEST_LIMITS } from "../helpers.js";

/**
 * Runs a compiled worker module in a real `node:worker_threads` thread:
 * `dist/distill-worker.js` after `npm run compile`, or the stall entry in
 * `test-dist/` (`npm run build:test-worker`). The checks under
 * `test/compiled/` run through `npm run test:compiled`, after the build, so
 * `npm test` stays on the sources.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The published worker module. */
export const DIST_WORKER = join(ROOT, "dist", "distill-worker.js");
/** The stall entry: the published handler with a store handle that stalls
 *  inside a write transaction (see `test/stall-worker.ts`). */
export const STALL_WORKER = join(ROOT, "test-dist", "stall-worker.js");

/** What the stall entry reads from `workerData.stall`: it holds the thread
 *  for `ms` inside the `afterTx`-th write transaction it opens (counting
 *  from 1, the fence's), before that transaction's COMMIT. */
export type StallRequest = { ms: number; afterTx?: number };

type Body<T> = T extends unknown ? Omit<T, "v" | "generation"> : never;

export type CompiledWorker = {
  worker: Worker;
  generation: number;
  /** Every message the worker posted, in order. */
  messages: WorkerMessage[];
  /** The next message of `type` from the first one not yet taken, waiting
   *  at most `timeoutMs`. */
  next<T extends WorkerMessage["type"]>(
    type: T,
    timeoutMs?: number,
  ): Promise<Extract<WorkerMessage, { type: T }>>;
  send(message: Body<MainMessage>, transfer?: ArrayBuffer[]): void;
  /** Send `init` for the scratch paths, with the build tags the worker
   *  reported in `ready` and this build's generations, and wait for the
   *  `store` result. */
  init(o: {
    storePath: string;
    sourcePath: string;
    limits?: Partial<Limits>;
    holderId?: string;
    takeOver?: string;
    foreground?: ForegroundSignal;
    sync?: InitMessage["sync"];
    timeoutMs?: number;
  }): Promise<Extract<WorkerMessage, { type: "store" }>>;
  /** Send `stop` and wait for `stopped`. */
  stop(timeoutMs?: number): Promise<Extract<WorkerMessage, { type: "stopped" }>>;
  /** Errors the thread reported. */
  errors: unknown[];
  /** Resolves with the exit code once the thread has ended. */
  exited: Promise<number>;
  terminate(): Promise<number>;
};

/** Start `entry` (default {@link DIST_WORKER}) as generation `generation`
 *  and wait for its `ready`. */
export async function startCompiledWorker(
  o: {
    entry?: string;
    generation?: number;
    stall?: StallRequest;
    readyTimeoutMs?: number;
  } = {},
): Promise<CompiledWorker> {
  const generation = o.generation ?? 1;
  const worker = new Worker(o.entry ?? DIST_WORKER, {
    workerData: { generation, ...(o.stall && { stall: o.stall }) },
  });
  const messages: WorkerMessage[] = [];
  const errors: unknown[] = [];
  const waiters = new Set<() => void>();
  let taken = 0;
  worker.on("message", (message: unknown) => {
    if (isWorkerMessage(message)) messages.push(message);
    for (const wake of [...waiters]) wake();
  });
  worker.on("error", (error) => errors.push(error));
  const exited = new Promise<number>((resolve) => worker.on("exit", resolve));
  let nextId = 1;

  const next = <T extends WorkerMessage["type"]>(
    type: T,
    timeoutMs = 10_000,
  ): Promise<Extract<WorkerMessage, { type: T }>> =>
    new Promise((resolve, reject) => {
      const look = (): boolean => {
        for (let i = taken; i < messages.length; i++) {
          if (messages[i]!.type === type) {
            taken = i + 1;
            resolve(messages[i] as Extract<WorkerMessage, { type: T }>);
            return true;
          }
        }
        return false;
      };
      if (look()) return;
      const timer = setTimeout(() => {
        waiters.delete(wake);
        reject(new Error(`no ${type} message within ${timeoutMs} ms`));
      }, timeoutMs);
      const wake = (): void => {
        if (look()) {
          clearTimeout(timer);
          waiters.delete(wake);
        }
      };
      waiters.add(wake);
    });

  const send = (message: Body<MainMessage>, transfer?: ArrayBuffer[]): void =>
    worker.postMessage({ v: PROTOCOL_VERSION, generation, ...message }, transfer);

  const ready = await next("ready", o.readyTimeoutMs ?? 10_000);

  return {
    worker,
    generation,
    messages,
    next,
    send,
    async init(i) {
      send({
        type: "init",
        id: nextId++,
        deadline: Date.now() + (i.timeoutMs ?? 10_000),
        buildId: ready.buildId,
        build: pluginBuild("opencode-v2", V2_PROJECTOR_GEN),
        representation: EMBED_REPRESENTATION,
        projectorGen: V2_PROJECTOR_GEN,
        storePath: i.storePath,
        sourcePath: i.sourcePath,
        holderId: i.holderId ?? `compiled/w${generation}`,
        ...(i.takeOver !== undefined && { takeOver: i.takeOver }),
        limits: { ...TEST_LIMITS, ...i.limits },
        ...(i.sync && { sync: i.sync }),
        foreground: (i.foreground ?? createForegroundSignal()).buffer,
      });
      return next("store", i.timeoutMs ?? 10_000);
    },
    async stop(timeoutMs = 10_000) {
      send({ type: "stop", id: nextId++, deadline: Date.now() + timeoutMs });
      return next("stopped", timeoutMs);
    },
    errors,
    exited,
    terminate: () => worker.terminate(),
  };
}
