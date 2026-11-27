/**
 * Handing the event loop back during long work.
 *
 * On the v2 host this plugin runs inside opencode's shared service, so reads,
 * builds and passes yield regularly to let other work run. They yield on a
 * time budget, not before every step: a `setTimeout(0)` turn costs about
 * 1.25 ms (timers are clamped to 1 ms), which is several times what one read
 * statement costs, so yielding before each statement spent most of a read
 * waiting. A yield itself goes through `setImmediate` where the runtime has
 * it, which lets due timers and ready I/O run for a few microseconds.
 * `MessageChannel` is no substitute: Node and Bun deliver a port's messages
 * back to back without returning to the event loop, so a chain of them keeps
 * timers from ever firing.
 */

/** How long work runs before it yields, in milliseconds. */
export const SLICE_MS = 8;

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
 * Every caller of one slicer shares its slice, so concurrent work through it
 * yields together.
 */
export function timeSlicer(opts: TimeSlicerOptions = {}): () => Promise<void> {
  const budget = opts.budgetMs ?? SLICE_MS;
  const now = opts.now ?? (() => performance.now());
  const yieldNow = opts.yieldNow ?? macrotask;
  let sliceStart = now();
  return async () => {
    if (now() - sliceStart < budget) return;
    await yieldNow();
    sliceStart = now();
  };
}

/**
 * The process's default yield point: the history reader, the v2 sync, the
 * card runtime, the distiller and discovery all yield through it unless
 * given their own, so together they hold the event loop for about one
 * {@link SLICE_MS} slice at a time.
 */
export const yieldOnBudget: () => Promise<void> = timeSlicer();
