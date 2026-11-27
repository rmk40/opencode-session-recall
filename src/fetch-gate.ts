/**
 * Shared fetch primitive.
 *
 * Every SDK call — foreground drill, the context/messages tools, and the
 * background distiller — passes through one counting semaphore so the plugin
 * never opens more than `concurrency` connections to the opencode server at
 * once. Foreground queries have strict priority: a background call does not
 * START while any query is active or queued, and it re-checks that condition at
 * acquisition time so a query arriving mid-wait always goes first. The guarantee
 * gates the START of background work only — a background call already in flight
 * runs to completion and is never interrupted.
 * A background waiter that stays blocked past a threshold reports once via
 * `onBackgroundPause`, making a steady query stream visible rather than silent.
 *
 * With a {@link ForegroundSignal} (`foreground`) the gate also takes part in
 * the foreground count threads share. Each query counts in it from entry
 * until it settles, and a background call that finds it non-zero (another
 * thread's search, or a tool read that does not pass through this gate)
 * waits until it reads zero or {@link FOREGROUND_WAIT_MS} pass before it
 * queues for a permit. That wait is bounded, unlike the wait for this gate's
 * own queries, so a count raised elsewhere slows background work but never
 * stops it.
 */

import { FOREGROUND_WAIT_MS, waitForQuiet, type ForegroundSignal } from "./foreground.js";

export type FetchGate = {
  runQuery<T>(fn: () => Promise<T>): Promise<T>;
  runBackground<T>(fn: () => Promise<T>): Promise<T>;
  /** Queries currently running or queued (the count background waits to reach
   *  0), together with the foreground work the shared signal counts elsewhere. */
  activeQueries(): number;
};

export type FetchGateOptions = {
  concurrency: number;
  onBackgroundPause?: (waitedMs: number) => void;
  /** Wait before a blocked background waiter logs a pause. Configurable for tests. */
  pauseThresholdMs?: number;
  /** The foreground count shared between threads, which this gate's queries
   *  count in and its background calls give way to. */
  foreground?: ForegroundSignal;
};

const DEFAULT_PAUSE_THRESHOLD_MS = 5_000;

type BackgroundWaiter = {
  resolve: () => void;
  settled: boolean;
  pausedFired: boolean;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
};

export function createFetchGate(opts: FetchGateOptions): FetchGate {
  const permitsMax =
    Number.isFinite(opts.concurrency) && opts.concurrency >= 1 ? Math.floor(opts.concurrency) : 1;
  const onBackgroundPause = opts.onBackgroundPause;
  const pauseThresholdMs =
    opts.pauseThresholdMs != null && opts.pauseThresholdMs >= 0
      ? opts.pauseThresholdMs
      : DEFAULT_PAUSE_THRESHOLD_MS;

  let permits = permitsMax;
  // Queries in the system: incremented at runQuery entry (so a just-arrived
  // query counts before it even acquires a permit) and decremented when its
  // work settles. Background may proceed only while this is zero.
  let queriesInSystem = 0;
  const queryWaiters: Array<() => void> = [];
  const backgroundWaiters: BackgroundWaiter[] = [];

  function clearPauseTimer(waiter: BackgroundWaiter): void {
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
  }

  function armPauseTimer(waiter: BackgroundWaiter): void {
    // Once per pause episode: skip if a timer is pending or the pause already
    // fired for this waiter, so repeated schedule() calls never re-arm it.
    if (!onBackgroundPause || waiter.timer !== undefined || waiter.pausedFired) return;
    waiter.timer = setTimeout(() => {
      waiter.timer = undefined;
      if (waiter.settled) return;
      waiter.pausedFired = true;
      onBackgroundPause(Date.now() - waiter.startedAt);
    }, pauseThresholdMs);
  }

  function schedule(): void {
    // Queries have priority and each needs a permit.
    while (permits > 0 && queryWaiters.length > 0) {
      permits--;
      const resolve = queryWaiters.shift();
      resolve?.();
    }
    // Background runs only when a permit is free and no query is active or
    // queued. Because a queued query keeps `queriesInSystem` above zero, a query
    // that arrives while a background waiter sits here always wins the permit.
    while (permits > 0 && queriesInSystem === 0 && backgroundWaiters.length > 0) {
      permits--;
      const waiter = backgroundWaiters.shift();
      if (!waiter) break;
      waiter.settled = true;
      clearPauseTimer(waiter);
      waiter.resolve();
    }
    // Any background waiter still blocked should be counting toward its pause log.
    for (const waiter of backgroundWaiters) armPauseTimer(waiter);
  }

  function acquireQuery(): Promise<void> {
    return new Promise<void>((resolve) => {
      queryWaiters.push(resolve);
      schedule();
    });
  }

  function acquireBackground(): Promise<void> {
    return new Promise<void>((resolve) => {
      backgroundWaiters.push({
        resolve,
        settled: false,
        pausedFired: false,
        startedAt: Date.now(),
        timer: undefined,
      });
      schedule();
    });
  }

  async function runCounted<T>(fn: () => Promise<T>): Promise<T> {
    queriesInSystem++;
    await acquireQuery();
    try {
      return await fn();
    } finally {
      permits++;
      queriesInSystem--;
      schedule();
    }
  }

  const foreground = opts.foreground;

  return {
    runQuery<T>(fn: () => Promise<T>): Promise<T> {
      return foreground ? foreground.run(() => runCounted(fn)) : runCounted(fn);
    },

    async runBackground<T>(fn: () => Promise<T>): Promise<T> {
      if (foreground?.active()) {
        await waitForQuiet(foreground, { maxMs: FOREGROUND_WAIT_MS, now: Date.now });
      }
      await acquireBackground();
      try {
        return await fn();
      } finally {
        permits++;
        schedule();
      }
    },

    activeQueries(): number {
      // This gate's own queries count in the signal too, so the larger of the
      // two is every query this gate and the signal know of.
      return foreground ? Math.max(queriesInSystem, foreground.count()) : queriesInSystem;
    },
  };
}
