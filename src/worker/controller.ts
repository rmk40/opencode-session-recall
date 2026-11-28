import { BUILD_ID } from "../build-id.js";
import type { CardVectorWriteResult, CardVectorWriter } from "../cards.js";
import { LEASE_TTL_MS, type DistillSignal } from "../distill.js";
import { takeOverHolders, type LeaseInfo } from "../store.js";
import { errmsg, settleWithin } from "../types.js";
import {
  createEventOutbox,
  EVENT_BATCH,
  isWorkerMessage,
  MAX_PENDING_REQUESTS,
  MAX_UNACKED_BATCHES,
  PROTOCOL_VERSION,
  transferableBuffers,
  VECTOR_WRITE_DEADLINE_MS,
  WORKER_READY_TIMEOUT_MS,
  WORKER_STORE_TIMEOUT_MS,
  type InitMessage,
  type MainMessage,
  type WorkerMessage,
  type WorkerStatus,
} from "./protocol.js";
import type { WorkerLike, WorkerStarter } from "./start.js";

/**
 * Main's side of the distiller worker: one per v2 runtime.
 *
 * It starts generation 1 at once, and each later generation only after its
 * predecessor's thread has ended (its exit event), since a thread that was
 * asked to end may still be inside a statement that can commit. The holder id
 * of generation `n` is `<instanceId>/w<n>`, and each replacement's `init`
 * names the holder ids of the earlier generations whose threads have ended
 * (the most recent four), so its first lease acquire may take a lease that
 * names one of them over without waiting out the TTL. A generation can take
 * the lease in its last moments without main hearing of it, and once its
 * thread has ended nothing of it can still hold the lease.
 *
 * A generation fails when it reports no `ready` within 10 s of starting or no
 * `store` within 10 s of `init`, when its thread reports an error or ends
 * unexpectedly, when it reports `fatal` of kind `crash` (a build mismatch
 * included), when main cannot open its reader after the worker reported its
 * store open, and when the watchdog trips. After a failure the next
 * generation starts 1 s later, then 5 s later; the third failure hands the
 * distiller to main ({@link WorkerControllerOptions.onInline}). A store the
 * worker refuses, or reports damaged (`fatal` of kind `store`), stops
 * indexing for good: no generation is retried and nothing runs on main.
 */

/** The fields of `init` the runtime supplies; the controller adds the
 *  envelope, the request id, the deadline and the holder ids. */
export type WorkerInit = Omit<
  InitMessage,
  "v" | "generation" | "type" | "id" | "deadline" | "holderId" | "takeOver"
>;

export type WorkerControllerOptions = {
  start: WorkerStarter;
  instanceId: string;
  init: WorkerInit;
  log: (line: string) => void;
  /**
   * The worker reported its store open: open main's reader, or keep the one
   * already open. A refusal there is a failure of this generation.
   */
  onStoreOpen(warning: string | undefined): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Indexing stopped for good: the store refused (`reason` is the refusal,
   *  such as `source-mismatch`) or is damaged. */
  onStopped(reason: string): void;
  /**
   * Every allowed generation failed and the last one's thread has ended:
   * main runs the distiller itself from here on, and may take over a lease
   * that names one of `takeOver`, the holder ids of the generations whose
   * threads have ended, the most recent last (at most four).
   */
  onInline(reason: string, takeOver: readonly string[]): void;
  /** A status message of the current generation arrived. */
  onStatus?(status: WorkerStatus): void;
  /** The current generation waits for a store whose write lock another
   *  connection holds (`reason`); it reports its store once it gets it. */
  onWaiting?(reason: string): void;
  /** The lease row as main's reader sees it, for the watchdog; undefined
   *  while there is no reader. */
  readLease(): LeaseInfo | undefined;
  now?: () => number;
  /** Waits before the second and the third generation (default 1 s, 5 s). */
  restartDelaysMs?: readonly number[];
  readyTimeoutMs?: number;
  storeTimeoutMs?: number;
  /** How often the watchdog reads the lease (default 5 s). */
  watchdogEveryMs?: number;
  /** Failed generations before the distiller runs on main (default 3). */
  maxFailures?: number;
  /** The first generation starts only once `ended` settles: the end of an
   *  earlier runtime's worker thread on the same store. A retire, a stop or
   *  a terminate cancels the wait, so nothing of this controller stays
   *  waiting on a thread that may never end. */
  startAfter?: { ended: Promise<unknown>; cancel(): void };
};

/** Where the distiller runs, as `coverage.history.distiller` reports it. */
export type DistillerMode =
  /** `detail` says what the worker is doing when it is not simply running,
   *  such as waiting for the store's write lock. */
  | { kind: "worker"; detail?: string }
  | { kind: "inline"; reason: string }
  | { kind: "stopped"; reason: string };

export type WorkerController = {
  /** Resolves once the first generation's store result settled: its reader
   *  opened, the store was refused, or the distiller went inline. */
  settled(): Promise<void>;
  mode(): DistillerMode;
  /** The current generation's last status, if it sent one. */
  status(): WorkerStatus | undefined;
  /** The current generation, 0 before the first. */
  generation(): number;
  /** The current generation's holder id. */
  holderId(): string | undefined;
  /** Queue a distiller signal for the worker (coalesced per session). False
   *  when the controller takes none: the distiller runs inline, indexing
   *  stopped, or the controller is stopping. */
  post(signal: DistillSignal): boolean;
  /** Every signal still queued, emptied (for a distiller taking over). */
  drainEvents(): DistillSignal[];
  /** A vector writer that sends each write to the worker. */
  readonly writeVectors: CardVectorWriter;
  /** Take no more signals, and drop the queued ones. */
  quiesce(): void;
  /**
   * Start no generation from now on and clear a pending restart, for a
   * runtime going away. The current generation keeps taking vector writes
   * and a later {@link stop}; a reader refusal from here on is no failure.
   */
  retire(): void;
  /**
   * Stop: no generation starts after this. The running worker is asked to
   * stop its distiller, release its lease and close its connections; resolves
   * true once it reported `stopped`, false at the deadline or when no worker
   * was running. Later calls return the first call's promise.
   */
  stop(deadlineMs: number): Promise<boolean>;
  /** End the worker's thread and wait at most `waitMs` for its exit. */
  terminate(waitMs: number): Promise<void>;
  /** Settles once the current generation's thread has ended, with no time
   *  bound; at once when none runs. After {@link retire} no generation
   *  follows, so it is the end of the last thread. */
  exited(): Promise<void>;
};

const DEFAULT_RESTART_DELAYS_MS = [1_000, 5_000];
const DEFAULT_WATCHDOG_EVERY_MS = 5_000;
const DEFAULT_MAX_FAILURES = 3;

type Pending = {
  generation: number;
  resolve: (result: CardVectorWriteResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Generation = {
  number: number;
  holderId: string;
  worker?: WorkerLike;
  readyTimer?: ReturnType<typeof setTimeout>;
  storeTimer?: ReturnType<typeof setTimeout>;
  /** The worker reported its store open and main's reader is open. */
  running: boolean;
  failed: boolean;
  stopRequested: boolean;
  exited: boolean;
  exit: Promise<void>;
  markExited: () => void;
  stopped?: () => void;
  status?: WorkerStatus;
  /** The `events` batches posted to this generation that it has not
   *  acknowledged yet, by batch id in the order they were posted, with their
   *  signals (at most {@link MAX_UNACKED_BATCHES} of {@link EVENT_BATCH}). */
  unacked: Map<number, DistillSignal[]>;
};

function unref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  (timer as { unref?: () => void }).unref?.();
}

type Body<T> = T extends unknown ? Omit<T, "v" | "generation"> : never;

export function createWorkerController(options: WorkerControllerOptions): WorkerController {
  const now = options.now ?? Date.now;
  const delays = options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
  const readyTimeout = options.readyTimeoutMs ?? WORKER_READY_TIMEOUT_MS;
  const storeTimeout = options.storeTimeoutMs ?? WORKER_STORE_TIMEOUT_MS;
  const watchdogEvery = options.watchdogEveryMs ?? DEFAULT_WATCHDOG_EVERY_MS;
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  const log = options.log;

  let mode: DistillerMode = { kind: "worker" };
  let current: Generation | undefined;
  let count = 0;
  let failures = 0;
  /** The holder ids of the generations whose threads have ended, the most
   *  recent last, as many as a takeover names ({@link takeOverHolders}). */
  let ended: string[] = [];
  let stopping = false;
  let quiesced = false;
  let nextId = 1;
  let nextBatch = 1;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let flushScheduled = false;
  let stopPromise: Promise<boolean> | undefined;
  const outbox = createEventOutbox();
  const pending = new Map<number, Pending>();
  let markSettled!: () => void;
  const firstSettled = new Promise<void>((resolve) => (markSettled = resolve));

  const send = (gen: Generation, message: Body<MainMessage>, transfer?: ArrayBuffer[]): boolean => {
    if (!gen.worker || gen.exited) return false;
    try {
      gen.worker.postMessage(
        { v: PROTOCOL_VERSION, generation: gen.number, ...message } as MainMessage,
        transfer,
      );
      return true;
    } catch (error) {
      log(`worker message failed: ${errmsg(error)}`);
      return false;
    }
  };

  const failPending = (gen: Generation, reason: string): void => {
    for (const [id, request] of pending) {
      if (request.generation !== gen.number) continue;
      pending.delete(id);
      clearTimeout(request.timer);
      request.resolve({ status: "failed", error: reason });
    }
  };

  const clearGenerationTimers = (gen: Generation): void => {
    if (gen.readyTimer !== undefined) clearTimeout(gen.readyTimer);
    if (gen.storeTimer !== undefined) clearTimeout(gen.storeTimer);
    gen.readyTimer = undefined;
    gen.storeTimer = undefined;
  };

  const stopWatchdog = (): void => {
    if (watchdog !== undefined) clearInterval(watchdog);
    watchdog = undefined;
  };

  function flushSoon(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    setTimeout(() => {
      flushScheduled = false;
      flush();
    }, 0);
  }

  /** Post the outbox's signals while fewer than {@link MAX_UNACKED_BATCHES}
   *  batches wait on their ack. A worker that SQLite holds up reads none, so
   *  the rest keep coalescing in the bounded outbox meanwhile. */
  function flush(): void {
    const gen = current;
    if (!gen?.running || gen.failed || gen.stopRequested) return;
    while (gen.unacked.size < MAX_UNACKED_BATCHES && outbox.size() > 0) {
      const signals = outbox.drain(EVENT_BATCH);
      const batch = nextBatch++;
      if (!send(gen, { type: "events", batch, signals })) {
        // The batch's sessions left the outbox whole in this same turn, so
        // no newer signal of theirs waits there: adding them back restores
        // what the outbox held, for the next send or a distiller taking over.
        for (const signal of signals) outbox.add(signal);
        return;
      }
      gen.unacked.set(batch, signals);
    }
  }

  function stopIndexing(gen: Generation | undefined, reason: string): void {
    if (mode.kind !== "worker") return;
    mode = { kind: "stopped", reason };
    stopWatchdog();
    if (gen) {
      clearGenerationTimers(gen);
      failPending(gen, "indexing stopped");
      gen.worker?.terminate();
    }
    outbox.drain();
    options.onStopped(reason);
    markSettled();
  }

  async function fail(gen: Generation, reason: string): Promise<void> {
    if (gen.failed || gen !== current || mode.kind !== "worker") return;
    gen.failed = true;
    gen.running = false;
    failures++;
    clearGenerationTimers(gen);
    stopWatchdog();
    failPending(gen, `the worker failed: ${reason}`);
    log(`worker generation ${gen.number} failed (${failures} of ${maxFailures}): ${reason}`);
    // Its last status is frozen, often still holding the lease: until a new
    // generation reports, the distiller reports as restarting and idle.
    gen.status = undefined;
    mode = { kind: "worker", detail: `restarting (${reason})` };
    gen.worker?.terminate();
    // Its thread may still be inside a statement that can commit: nothing
    // replaces it before the thread has ended.
    await gen.exit;
    // Its thread has ended, so a lease naming it is dead, whether or not main
    // heard that it took it (an acquire can commit while the thread is
    // ended). Its holder id joins the ones a takeover may name.
    ended = takeOverHolders([...ended, gen.holderId]);
    if (stopping || mode.kind !== "worker") return;
    // The batches it never acknowledged may not have reached its distiller,
    // or only in part: they go back ahead of the signals posted since, for
    // the next generation or the distiller on this thread. One it had partly
    // dispatched is safe to dispatch again: a deletion of a deleted session
    // removes nothing, a patch writes the values it wrote, and a re-check, a
    // removal or a patchless meta reads the session from opencode.db again.
    const unacked = [...gen.unacked.values()].flat();
    gen.unacked.clear();
    if (unacked.length > 0) outbox.requeue(unacked);
    if (failures >= maxFailures) {
      mode = { kind: "inline", reason };
      log(`the distiller runs on the main thread from now on: ${reason}`);
      options.onInline(reason, [...ended]);
      markSettled();
      return;
    }
    const delay = delays[Math.min(failures - 1, delays.length - 1)] ?? 0;
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void launch();
    }, delay);
    unref(restartTimer);
  }

  function startWatchdog(gen: Generation): void {
    stopWatchdog();
    watchdog = setInterval(() => {
      if (gen !== current || !gen.running || gen.stopRequested || stopping) return;
      // The row, not the generation's last status, says who holds the lease:
      // a worker can take it and stall before it reports a status.
      let lease: LeaseInfo | undefined;
      try {
        lease = options.readLease();
      } catch {
        return;
      }
      if (lease?.holder !== gen.holderId) return;
      const ttl = lease.ttl > 0 ? lease.ttl : LEASE_TTL_MS;
      if (now() - lease.heartbeat > ttl) {
        void fail(gen, `its lease heartbeat is older than ${ttl} ms`);
      }
    }, watchdogEvery);
    unref(watchdog);
  }

  async function onStore(gen: Generation, message: Extract<WorkerMessage, { type: "store" }>) {
    if (gen.storeTimer !== undefined) clearTimeout(gen.storeTimer);
    gen.storeTimer = undefined;
    if (mode.kind === "worker" && gen === current) mode = { kind: "worker" };
    if (!message.ok) {
      stopIndexing(gen, message.reason);
      return;
    }
    if (message.warning !== undefined) log(`store: ${message.warning}`);
    let opened: { ok: true } | { ok: false; reason: string };
    try {
      opened = await options.onStoreOpen(message.warning);
    } catch (error) {
      opened = { ok: false, reason: errmsg(error) };
    }
    if (gen !== current || gen.failed || mode.kind !== "worker") return;
    if (!opened.ok) {
      // A runtime going away refuses to open its reader: that is the stop
      // under way, which ends this generation, not a failure of it.
      if (stopping) return;
      void fail(gen, `main could not open its store reader (${opened.reason})`);
      return;
    }
    gen.running = true;
    startWatchdog(gen);
    markSettled();
    flush();
  }

  function onMessage(gen: Generation, raw: unknown): void {
    if (gen !== current || gen.failed) return;
    if (!isWorkerMessage(raw) || raw.generation !== gen.number) return;
    switch (raw.type) {
      case "ready": {
        if (gen.readyTimer !== undefined) clearTimeout(gen.readyTimer);
        gen.readyTimer = undefined;
        if (raw.buildId !== BUILD_ID) {
          void fail(gen, `build mismatch: main has ${BUILD_ID}, the worker ${raw.buildId}`);
          return;
        }
        if (gen.stopRequested) return;
        send(gen, {
          type: "init",
          id: nextId++,
          deadline: now() + storeTimeout,
          holderId: gen.holderId,
          ...(ended.length > 0 && { takeOver: [...ended] }),
          ...options.init,
        });
        gen.storeTimer = setTimeout(
          () => void fail(gen, `no store result within ${storeTimeout} ms of init`),
          storeTimeout,
        );
        unref(gen.storeTimer);
        return;
      }
      case "store":
        void onStore(gen, raw);
        return;
      case "waiting": {
        // The worker is alive and keeps trying: its store deadline moves to
        // past the wait it announced, and the wait is no failure.
        if (gen.storeTimer === undefined || gen.stopRequested) return;
        clearTimeout(gen.storeTimer);
        const wait = Math.max(0, raw.retryInMs) + storeTimeout;
        gen.storeTimer = setTimeout(
          () => void fail(gen, `no store result within ${wait} ms of a wait for the store lock`),
          wait,
        );
        unref(gen.storeTimer);
        if (mode.kind === "worker") mode = { kind: "worker", detail: `waiting (${raw.reason})` };
        options.onWaiting?.(raw.reason);
        return;
      }
      case "status":
        gen.status = raw.status;
        options.onStatus?.(raw.status);
        return;
      case "ack":
        if (gen.unacked.delete(raw.batch) && outbox.size() > 0) flush();
        return;
      case "log":
        if (raw.dropped) log(`worker: ${raw.dropped} log line(s) dropped`);
        log(raw.line);
        return;
      case "fatal":
        if (raw.kind === "store") stopIndexing(gen, raw.reason);
        else void fail(gen, raw.reason);
        return;
      case "reply": {
        const request = pending.get(raw.id);
        if (!request || request.generation !== gen.number) return;
        pending.delete(raw.id);
        clearTimeout(request.timer);
        if (raw.outcome === "committed" && typeof raw.revision === "number") {
          request.resolve({ status: "committed", revision: raw.revision });
        } else if (raw.outcome === "refused") {
          request.resolve({ status: "refused", reason: raw.reason ?? "refused" });
        } else {
          request.resolve({ status: "failed", error: raw.reason ?? "the write failed" });
        }
        return;
      }
      case "stopped":
        gen.stopped?.();
        return;
    }
  }

  async function launch(): Promise<void> {
    if (stopping || mode.kind !== "worker") return;
    if (count === 0 && options.startAfter) {
      // A writer started now would contend on the store's write lock behind
      // a thread that may still hold it.
      mode = { kind: "worker", detail: "waiting (an earlier worker on this store has not ended)" };
      log("waiting for an earlier worker thread on this store to end before starting one");
      await options.startAfter.ended;
      if (stopping || mode.kind !== "worker") return;
      mode = { kind: "worker" };
    }
    const number = ++count;
    let markExited!: () => void;
    const gen: Generation = {
      number,
      holderId: `${options.instanceId}/w${number}`,
      running: false,
      failed: false,
      stopRequested: false,
      exited: false,
      unacked: new Map(),
      exit: new Promise<void>((resolve) => (markExited = resolve)),
      markExited: () => {
        gen.exited = true;
        markExited();
      },
    };
    current = gen;
    let worker: WorkerLike;
    try {
      worker = await options.start(number);
    } catch (error) {
      gen.markExited();
      void fail(gen, `the worker did not start: ${errmsg(error)}`);
      return;
    }
    gen.worker = worker;
    worker.onMessage((message) => onMessage(gen, message));
    worker.onError((error) => void fail(gen, `worker error: ${errmsg(error)}`));
    worker.onExit(() => {
      gen.markExited();
      gen.stopped?.();
      if (gen === current && !gen.failed && !gen.stopRequested && mode.kind === "worker") {
        void fail(gen, "the worker exited unexpectedly");
      }
    });
    if (stopping) {
      // Asked to end while it started: its exit is no failure, and
      // terminate() waits for it.
      gen.stopRequested = true;
      worker.terminate();
      return;
    }
    gen.readyTimer = setTimeout(
      () => void fail(gen, `no ready within ${readyTimeout} ms of starting`),
      readyTimeout,
    );
    unref(gen.readyTimer);
  }

  const writeVectors: CardVectorWriter = (model, representation, rows) => {
    const gen = current;
    if (mode.kind !== "worker" || !gen?.running || gen.failed || gen.stopRequested) {
      return Promise.resolve({ status: "failed", error: "the store writer is not running" });
    }
    if (pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.resolve({ status: "failed", error: "too many vector writes are waiting" });
    }
    const id = nextId++;
    return new Promise<CardVectorWriteResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ status: "failed", error: "no acknowledgement before the deadline" });
      }, VECTOR_WRITE_DEADLINE_MS);
      unref(timer);
      pending.set(id, { generation: gen.number, resolve, timer });
      const sent = send(
        gen,
        {
          type: "vectors",
          id,
          deadline: now() + VECTOR_WRITE_DEADLINE_MS,
          model,
          representation,
          rows,
        },
        transferableBuffers(rows),
      );
      if (!sent) {
        pending.delete(id);
        clearTimeout(timer);
        resolve({ status: "failed", error: "the store writer is not running" });
      }
    });
  };

  void launch();

  return {
    settled: () => firstSettled,
    mode: () => mode,
    status: () => current?.status,
    generation: () => count,
    holderId: () => current?.holderId,
    post(signal) {
      if (mode.kind !== "worker" || stopping || quiesced) return false;
      outbox.add(signal);
      if (current?.running) flushSoon();
      return true;
    },
    drainEvents: () => outbox.drain(),
    writeVectors,
    quiesce() {
      quiesced = true;
      outbox.drain();
    },
    retire() {
      stopping = true;
      options.startAfter?.cancel();
      if (restartTimer !== undefined) clearTimeout(restartTimer);
      restartTimer = undefined;
      markSettled();
    },
    stop(deadlineMs) {
      stopPromise ??= (async () => {
        stopping = true;
        options.startAfter?.cancel();
        quiesced = true;
        outbox.drain();
        stopWatchdog();
        if (restartTimer !== undefined) clearTimeout(restartTimer);
        restartTimer = undefined;
        markSettled();
        const gen = current;
        if (!gen?.worker || gen.exited || gen.failed) return false;
        clearGenerationTimers(gen);
        gen.stopRequested = true;
        const stopped = new Promise<void>((resolve) => (gen.stopped = resolve));
        const sent = send(gen, { type: "stop", id: nextId++, deadline: now() + deadlineMs });
        if (!sent) return false;
        const result = await settleWithin(stopped, deadlineMs);
        failPending(gen, "the worker stopped");
        return !result.timedOut && !gen.exited;
      })();
      return stopPromise;
    },
    async terminate(waitMs) {
      stopping = true;
      options.startAfter?.cancel();
      stopWatchdog();
      if (restartTimer !== undefined) clearTimeout(restartTimer);
      restartTimer = undefined;
      const gen = current;
      if (!gen) return;
      failPending(gen, "the worker ended");
      if (gen.exited) return;
      gen.stopRequested = true;
      // A worker whose start is still pending is ended by launch once it
      // exists (it sees `stopping`); its exit settles `gen.exit` either way.
      gen.worker?.terminate();
      await settleWithin(gen.exit, waitMs);
    },
    exited: () => current?.exit ?? Promise.resolve(),
  };
}
