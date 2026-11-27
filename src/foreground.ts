/**
 * A count of foreground work (searches and other tool reads, queued or
 * running) that one thread raises and any thread sharing its buffer reads
 * without a message.
 *
 * The count lives in one `Int32` of a `SharedArrayBuffer`, changed with
 * `Atomics.add` and `Atomics.sub` and read with `Atomics.load`. The only way
 * to raise it is {@link ForegroundSignal.run}, which lowers it again in a
 * `finally` however the operation ends (returned, thrown or rejected), so no
 * increment is left behind by an operation that settles. Background work that
 * reads the signal never waits on it for more than {@link FOREGROUND_WAIT_MS}
 * at a time ({@link waitForQuiet}), so upkeep slows while a search runs but
 * never stops, even if an operation never settled.
 *
 * Writes another thread serves for the one that raises the signal (the card
 * runtime's vector writes) never wait on it: the thread that raised it may be
 * awaiting that very write.
 */

/** The longest one wait for the foreground to go quiet lasts, in
 *  milliseconds. */
export const FOREGROUND_WAIT_MS = 250;
/** How often a wait reads the count again, in milliseconds. A timer rather
 *  than a turn of the event loop, so a wait does not keep its thread busy. */
const FOREGROUND_POLL_MS = 4;
/** Bytes of the shared counter: one `Int32`. */
const COUNTER_BYTES = Int32Array.BYTES_PER_ELEMENT;

export type ForegroundSignal = {
  /** The shared counter, for handing to another thread, which wraps it with
   *  {@link foregroundSignalFrom}. */
  readonly buffer: SharedArrayBuffer;
  /** Foreground operations counted now, by every thread sharing the buffer. */
  count(): number;
  /** Whether the count is non-zero. */
  active(): boolean;
  /**
   * Run `operation` counted: the count rises before it starts and falls once
   * it has settled, whether it returned, threw or rejected.
   */
  run<T>(operation: () => T | Promise<T>): Promise<T>;
};

function signalOver(buffer: SharedArrayBuffer): ForegroundSignal {
  const counts = new Int32Array(buffer, 0, 1);
  const count = (): number => Atomics.load(counts, 0);
  return {
    buffer,
    count,
    active: () => count() !== 0,
    async run<T>(operation: () => T | Promise<T>): Promise<T> {
      Atomics.add(counts, 0, 1);
      try {
        return await operation();
      } finally {
        Atomics.sub(counts, 0, 1);
      }
    },
  };
}

/** A new signal with a count of zero. */
export function createForegroundSignal(): ForegroundSignal {
  return signalOver(new SharedArrayBuffer(COUNTER_BYTES));
}

/** The signal whose counter is `buffer` (another thread's
 *  {@link ForegroundSignal.buffer}). Throws when `buffer` is not a
 *  `SharedArrayBuffer` large enough to hold the counter. */
export function foregroundSignalFrom(buffer: SharedArrayBuffer): ForegroundSignal {
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength < COUNTER_BYTES) {
    throw new TypeError("a foreground signal needs a SharedArrayBuffer of at least 4 bytes");
  }
  return signalOver(buffer);
}

export type QuietWaitOptions = {
  /** The longest the wait lasts (default {@link FOREGROUND_WAIT_MS}). */
  maxMs?: number;
  /** Clock in milliseconds (default `Date.now`). */
  now?: () => number;
};

/**
 * Wait until `signal` reads zero or `maxMs` have passed, whichever comes
 * first, reading it every few milliseconds on a timer. Resolves at once,
 * without awaiting anything, when it already reads zero. The wait ends once
 * either the clock or the timers it waited on have covered `maxMs`, so it is
 * bounded under fake timers and under a stalled clock alike.
 */
export async function waitForQuiet(
  signal: ForegroundSignal,
  opts: QuietWaitOptions = {},
): Promise<void> {
  if (!signal.active()) return;
  const maxMs = opts.maxMs ?? FOREGROUND_WAIT_MS;
  const now = opts.now ?? Date.now;
  const start = now();
  let waited = 0;
  while (signal.active()) {
    const left = maxMs - Math.max(waited, now() - start);
    if (!(left > 0)) return;
    const step = Math.min(FOREGROUND_POLL_MS, left);
    await new Promise<void>((resolve) => setTimeout(resolve, step));
    waited += step;
  }
}
