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
/** While foreground callers wait, background callers take one turn in this
 *  many, so upkeep slows down during a search but never stops. */
export const BACKGROUND_EVERY = 8;
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
  /** While foreground callers wait, background callers take one turn in
   *  this many (default {@link BACKGROUND_EVERY}). */
  backgroundEvery?: number;
};

/** The two yield points of one slicer, which share its slice. */
export type PrioritySlicer = {
  /** For work a caller is waiting on, such as a search's reads and builds. */
  foreground: () => Promise<void>;
  /** For upkeep no caller waits on, such as the distiller's passes. */
  background: () => Promise<void>;
};

/**
 * Yield points that yield only once the budget has run since anything last
 * yielded through either. Work awaits one wherever it may stop: within the budget it
 * resolves at once (one microtask), past it it awaits `yieldNow` and starts
 * the next slice. A slice runs over the budget by at most the work between
 * two calls.
 *
 * Every caller of one slicer shares its slice. Callers past the budget wait
 * in line on one pending yield, which starts the next slice once it
 * resolves. Only one of them takes that slice; the others wait for the yield
 * that starts the one after, and so on, so however many callers wait, a turn
 * of the event loop holds about one slice of their work. The slice goes to
 * the first waiter to resume of the class the yield chose when it resolved:
 * foreground while any foreground caller waits on it, except that background
 * callers waiting through `backgroundEvery - 1` foreground turns in a row
 * take the next one. (Resumed waiters run before any of them does its work,
 * so a waiter cannot tell from the clock alone whether another has the
 * slice.) A budget of zero or less yields at every call.
 */
export function prioritySlicer(opts: TimeSlicerOptions = {}): PrioritySlicer {
  const budget = opts.budgetMs ?? SLICE_MS;
  const now = opts.now ?? (() => performance.now());
  const yieldNow = opts.yieldNow ?? macrotask;
  const every = Math.max(1, Math.floor(opts.backgroundEvery ?? BACKGROUND_EVERY));
  if (!(budget > 0)) return { foreground: () => yieldNow(), background: () => yieldNow() };
  type Class = "foreground" | "background";
  type Turn = {
    done: Promise<void>;
    since: number;
    taken: boolean;
    /** Callers of each class waiting on this yield. */
    waiting: Record<Class, number>;
    /** The class whose first resumed waiter takes the slice; unset for a
     *  yield that was replaced, which any waiter may take. */
    winner?: Class;
  };
  let sliceStart = now();
  let turn: Turn | undefined;
  /** Foreground turns in a row that background callers waited through. */
  let passedOver = 0;
  const startTurn = (): Turn => {
    const next: Turn = {
      done: Promise.resolve(),
      since: now(),
      taken: false,
      waiting: { foreground: 0, background: 0 },
    };
    // A yield that fails still ends the wait; it only let other work run.
    const end = (): void => {
      if (turn !== next) return;
      turn = undefined;
      sliceStart = now();
      const { foreground, background } = next.waiting;
      if (foreground > 0 && (background === 0 || passedOver < every - 1)) {
        next.winner = "foreground";
        passedOver = background > 0 ? passedOver + 1 : 0;
      } else {
        next.winner = "background";
        passedOver = 0;
      }
    };
    next.done = yieldNow().then(end, end);
    return next;
  };
  const yieldPoint = (kind: Class) => async (): Promise<void> => {
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
      mine.waiting[kind]++;
      await mine.done;
      if (!mine.taken && (mine.winner === undefined || mine.winner === kind)) {
        mine.taken = true;
        return;
      }
    }
  };
  return { foreground: yieldPoint("foreground"), background: yieldPoint("background") };
}

/** A slicer's foreground yield point alone (see {@link prioritySlicer}). */
export function timeSlicer(opts: TimeSlicerOptions = {}): () => Promise<void> {
  return prioritySlicer(opts).foreground;
}

const shared = prioritySlicer();

/**
 * The process's default yield point: the history reader, the v2 sync, the
 * card runtime and discovery all yield through it unless given their own,
 * so together with {@link yieldInBackground} they hold the event loop for
 * about one {@link SLICE_MS} slice at a time.
 */
export const yieldOnBudget: () => Promise<void> = shared.foreground;

/**
 * The process's background yield point, sharing {@link yieldOnBudget}'s
 * slice: the distiller and the history reads, sync and discovery it drives
 * yield through it, so a search that waits at the same time takes all but
 * one in {@link BACKGROUND_EVERY} turns.
 */
export const yieldInBackground: () => Promise<void> = shared.background;
