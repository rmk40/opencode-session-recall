import { loadWorkerThreads } from "../node-import.js";
import { portOf, runWorkerHandler, type WorkerHandlerOptions } from "./handler.js";
import { WORKER_ENTRY, type MainMessage } from "./protocol.js";

/**
 * How main starts a worker generation: a thread over the compiled worker
 * module, or the same handler on main's own thread over an in-process
 * `MessageChannel`. The controller sees both through one shape.
 */

export type WorkerLike = {
  postMessage(message: MainMessage, transfer?: ArrayBuffer[]): void;
  onMessage(listener: (message: unknown) => void): void;
  onError(listener: (error: unknown) => void): void;
  /** Called once the worker has ended: a thread's `exit` event. */
  onExit(listener: () => void): void;
  /** Ask the worker to end. A thread inside a statement ends only once the
   *  statement does, so the end is known only from {@link onExit}. */
  terminate(): void;
};

/** Starts the worker of one generation. */
export type WorkerStarter = (generation: number) => Promise<WorkerLike>;

/**
 * Start each generation as a `node:worker_threads` thread over `url` (by
 * default `distill-worker.js` beside this module, which the build writes next
 * to the plugin's entry and its shared chunks). The thread's `workerData`
 * carries the generation and `workerData`'s own fields. The thread is
 * unreferenced: it never keeps the host process alive.
 */
export function threadStarter(
  opts: { url?: URL; workerData?: Record<string, unknown> } = {},
): WorkerStarter {
  return async (generation) => {
    const threads = await loadWorkerThreads();
    const url = opts.url ?? new URL(WORKER_ENTRY, import.meta.url);
    const worker = new threads.Worker(url, { workerData: { ...opts.workerData, generation } });
    worker.unref?.();
    return {
      postMessage: (message, transfer) => worker.postMessage(message, transfer),
      onMessage: (listener) => {
        worker.on("message", listener);
      },
      onError: (listener) => {
        worker.on("error", listener);
      },
      onExit: (listener) => {
        worker.on("exit", () => listener());
      },
      terminate: () => {
        worker.terminate().catch(() => {
          // The exit event reports the end either way.
        });
      },
    };
  };
}

/**
 * Run each generation's handler on this thread, over an in-process
 * `MessageChannel`: the protocol and its structured cloning are the same as
 * a thread's. `terminate` halts the handler ({@link WorkerHandler.halt}) and
 * reports the end on a later turn, as a thread's `exit` arrives.
 */
export function inlineStarter(opts: Omit<WorkerHandlerOptions, "generation"> = {}): WorkerStarter {
  return async (generation) => {
    const threads = await loadWorkerThreads();
    const { port1, port2 } = new threads.MessageChannel();
    port1.unref?.();
    port2.unref?.();
    const handler = runWorkerHandler(portOf(port2), { ...opts, generation });
    const exitListeners: Array<() => void> = [];
    let ended = false;
    return {
      postMessage: (message, transfer) => port1.postMessage(message, transfer),
      onMessage: (listener) => {
        port1.on("message", listener);
      },
      onError: () => {
        // A handler on this thread reports its failures as `fatal`.
      },
      onExit: (listener) => {
        exitListeners.push(listener);
      },
      terminate: () => {
        if (ended) return;
        ended = true;
        handler.halt();
        try {
          port1.close();
        } catch {
          // Already closed.
        }
        setTimeout(() => {
          for (const listener of exitListeners.splice(0)) listener();
        }, 0);
      },
    };
  };
}

/** Whether this module runs from its TypeScript source (the tests), where no
 *  compiled worker lies beside it. */
function unbundled(): boolean {
  return /\.[cm]?ts$/.test(new URL(import.meta.url).pathname);
}

/**
 * The starter a runtime uses unless told otherwise: a thread over the
 * compiled worker in a built plugin, and the inline handler when this module
 * runs from its TypeScript source, which has no compiled worker beside it.
 */
export function defaultWorkerStarter(): WorkerStarter {
  return unbundled() ? inlineStarter() : threadStarter();
}
