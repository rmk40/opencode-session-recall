/**
 * Handing the event loop back during long work.
 *
 * On the v2 host this plugin runs inside opencode's shared service, so reads,
 * builds and passes yield regularly to let other work run. They yield on a
 * time budget, not before every step: a `setTimeout(0)` turn costs about
 * 1.25 ms (timers are clamped to 1 ms), several times what one read statement
 * costs, so a yield per statement would leave a read waiting most of its
 * time. A yield itself goes through `setImmediate` where the runtime has it,
 * which lets due timers and ready I/O run for a few microseconds.
 * `MessageChannel` is no substitute: Node and Bun deliver a port's messages
 * back to back without returning to the event loop, so a chain of them keeps
 * timers from ever firing.
 */

/** How long work runs before it yields, in milliseconds. */
export const SLICE_MS = 8;
/** How long a slicer's callers wait on one pending yield before a new
 *  caller starts another, in milliseconds. A yield resolves within a turn of
 *  the event loop, so only a yield whose callback was lost waits this long. */
const STALE_YIELD_MS = 100;

type ImmediateHost = { setImmediate?: (callback: () => void) => unknown };

/** Resolves on a later turn of the event loop, after due timers and ready
 *  I/O have run: through `setImmediate` (Node, Bun), else `setTimeout(0)`. */
export function macrotask(): Promise<void> {
  return new Promise((resolve) => {
    const host = globalThis as ImmediateHost;
    if (typeof host.setImmediate === "function") host.setImmediate(() => resolve());
    else setTimeout(resolve, 0);
  });
}

export type TimeSlicerOptions = {
  /** Work allowed between two yields, in milliseconds (default
   *  {@link SLICE_MS}). */
  budgetMs?: number;
  /** Clock in milliseconds (default `performance.now`). */
  now?: () => number;
  /** How to yield once the budget has run (default {@link macrotask}). */
  yieldNow?: () => Promise<void>;
};

/**
 * A yield point that yields only once the budget has run since it last
 * yielded. Work awaits it wherever it may stop: within the budget it resolves
 * at once (one microtask), past it it awaits `yieldNow` and starts the next
 * slice. A slice runs over the budget by at most the work between two calls.
 *
 * Every caller of one slicer shares its slice. Callers past the budget wait
 * in line on one pending yield, which starts the next slice once it
 * resolves. Only the first of them to resume takes that slice; the others
 * wait for the yield that starts the one after, and so on, so however many
 * callers wait, a turn of the event loop holds about one slice of their
 * work. (Resumed waiters run before any of them does its work, so a waiter
 * cannot tell from the clock alone whether another has the slice.) A budget
 * of zero or less yields at every call.
 */
export function timeSlicer(opts: TimeSlicerOptions = {}): () => Promise<void> {
  const budget = opts.budgetMs ?? SLICE_MS;
  const now = opts.now ?? (() => performance.now());
  const yieldNow = opts.yieldNow ?? macrotask;
  if (!(budget > 0)) return () => yieldNow();
  type Turn = { done: Promise<void>; since: number; taken: boolean };
  let sliceStart = now();
  let turn: Turn | undefined;
  const startTurn = (): Turn => {
    const next: Turn = { done: Promise.resolve(), since: now(), taken: false };
    // A yield that fails still ends the wait; it only let other work run.
    const end = (): void => {
      if (turn !== next) return;
      turn = undefined;
      sliceStart = now();
    };
    next.done = yieldNow().then(end, end);
    return next;
  };
  return async () => {
    // A clock that went backwards (a test's fake clock swapped back for the
    // real one) restarts the slice rather than holding off every yield.
    if (now() < sliceStart) sliceStart = now();
    if (now() - sliceStart < budget) return;
    for (;;) {
      // A yield whose callback was dropped (a test that swapped the timer
      // functions out from under it) must not hold every later caller, so a
      // pending yield older than STALE_YIELD_MS, or from a clock that has
      // since gone backwards, is replaced.
      const age = turn ? now() - turn.since : 0;
      if (!turn || age > STALE_YIELD_MS || age < 0) turn = startTurn();
      const mine = turn;
      await mine.done;
      if (!mine.taken) {
        mine.taken = true;
        return;
      }
    }
  };
}

/**
 * The process's default yield point: the history reader, the v2 sync, the
 * card runtime, the distiller and discovery all yield through it unless
 * given their own, so together they hold the event loop for about one
 * {@link SLICE_MS} slice at a time.
 */
export const yieldOnBudget: () => Promise<void> = timeSlicer();
