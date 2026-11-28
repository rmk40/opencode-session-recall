import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchGate } from "../src/fetch-gate.js";
import {
  createForegroundSignal,
  FOREGROUND_WAIT_MS,
  foregroundSignalFrom,
  waitForQuiet,
  type ForegroundSignal,
} from "../src/foreground.js";
import {
  prioritySlicer,
  yieldBackgroundTo,
  yieldInBackground,
  yieldOnBudget,
} from "../src/yield.js";

/**
 * The foreground signal: a count of foreground work that threads share, and
 * the bounded waits the fetch gate's background lane and the slicer's
 * background yields make while it is up.
 */

afterEach(() => {
  yieldBackgroundTo(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Fake the timers and the clock the signal's waits use. `setImmediate` stays
 *  real, so a turn of the event loop still runs. */
function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}

/** One turn of the real event loop, after every pending microtask. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Whether `promise` has settled, readable at any later point. */
function track(promise: Promise<unknown>): { settled: () => boolean } {
  let settled = false;
  const done = (): void => {
    settled = true;
  };
  void promise.then(done, done);
  return { settled: () => settled };
}

/** Whether `promise` settles within a few turns of the event loop, with no
 *  fake timer advanced. */
async function settlesNow(promise: Promise<unknown>): Promise<boolean> {
  const tracked = track(promise);
  for (let i = 0; i < 3 && !tracked.settled(); i++) await turn();
  return tracked.settled();
}

/** Advance the fake timers by `ms`, then let what they woke run. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await turn();
}

/** Count one foreground operation on `signal` until the returned function is
 *  called, as a search running on another thread does. */
function holdForeground(signal: ForegroundSignal): () => Promise<void> {
  let finish!: () => void;
  const running = signal.run(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  return async () => {
    finish();
    await running;
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("foreground signal", () => {
  it("counts an operation from before it starts until it settles, and passes its value through", async () => {
    const signal = createForegroundSignal();
    expect(signal.count()).toBe(0);
    expect(signal.active()).toBe(false);

    let inside = -1;
    let finish!: (value: string) => void;
    const running = signal.run(() => {
      inside = signal.count();
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    expect(inside).toBe(1);
    expect(signal.active()).toBe(true);
    finish("done");
    expect(await running).toBe("done");
    expect(signal.count()).toBe(0);

    expect(await signal.run(() => 42)).toBe(42);
    expect(signal.count()).toBe(0);
  });

  it("lowers the count again when the operation throws or rejects", async () => {
    const signal = createForegroundSignal();
    await expect(
      signal.run(() => {
        throw new Error("thrown");
      }),
    ).rejects.toThrow("thrown");
    expect(signal.count()).toBe(0);
    await expect(signal.run(() => Promise.reject(new Error("rejected")))).rejects.toThrow(
      "rejected",
    );
    expect(signal.count()).toBe(0);
    expect(signal.active()).toBe(false);
  });

  it("shares one count among the signals built over its buffer", async () => {
    const main = createForegroundSignal();
    const other = foregroundSignalFrom(main.buffer);
    const first = holdForeground(other);
    expect(main.count()).toBe(1);
    expect(main.active()).toBe(true);
    const second = holdForeground(main);
    expect(other.count()).toBe(2);
    await first();
    expect(main.count()).toBe(1);
    await second();
    expect(other.count()).toBe(0);
    expect(other.active()).toBe(false);
  });

  it("refuses a buffer that is not a shared buffer of at least four bytes", () => {
    expect(() => foregroundSignalFrom(new ArrayBuffer(4) as unknown as SharedArrayBuffer)).toThrow(
      TypeError,
    );
    expect(() => foregroundSignalFrom(new SharedArrayBuffer(2))).toThrow(TypeError);
    expect(foregroundSignalFrom(new SharedArrayBuffer(8)).count()).toBe(0);
  });
});

describe("waitForQuiet", () => {
  it("resolves without starting a timer while nothing is counted", async () => {
    fakeTimers();
    const signal = createForegroundSignal();
    expect(await settlesNow(waitForQuiet(signal))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends within one poll of the count falling to zero", async () => {
    fakeTimers();
    const signal = createForegroundSignal();
    const release = holdForeground(signal);
    const wait = track(waitForQuiet(signal));
    await advance(100);
    expect(wait.settled()).toBe(false);
    await release();
    await advance(4);
    expect(wait.settled()).toBe(true);
  });

  it("gives up once FOREGROUND_WAIT_MS pass with the count still up, or maxMs when given", async () => {
    fakeTimers();
    const signal = createForegroundSignal();
    const release = holdForeground(signal);
    const wait = track(waitForQuiet(signal));
    await advance(FOREGROUND_WAIT_MS - 1);
    expect(wait.settled()).toBe(false);
    await advance(1);
    expect(wait.settled()).toBe(true);

    const short = track(waitForQuiet(signal, { maxMs: 10 }));
    await advance(9);
    expect(short.settled()).toBe(false);
    await advance(1);
    expect(short.settled()).toBe(true);
    expect(signal.count()).toBe(1);
    await release();
  });

  it("ends on whichever of its clock and its timers covers the bound first", async () => {
    fakeTimers();
    const signal = createForegroundSignal();
    const release = holdForeground(signal);

    // A clock already past the bound ends the wait without a timer.
    let t = 0;
    expect(await settlesNow(waitForQuiet(signal, { now: () => (t += 1_000) }))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    // Under a clock that never moves, the timers it waited on cover the bound.
    const stopped = track(waitForQuiet(signal, { now: () => 0 }));
    await advance(FOREGROUND_WAIT_MS - 1);
    expect(stopped.settled()).toBe(false);
    await advance(1);
    expect(stopped.settled()).toBe(true);
    await release();
  });
});

describe("fetch gate with a foreground signal", () => {
  it("counts each query in the signal from the moment it arrives until it settles", async () => {
    const signal = createForegroundSignal();
    const gate = createFetchGate({ concurrency: 1, foreground: signal });
    const first = deferred();
    const a = gate.runQuery(() => first.promise);
    const b = gate.runQuery(async () => {
      throw new Error("b failed");
    });
    // B still waits for the permit A holds, and counts already.
    expect(signal.count()).toBe(2);
    first.resolve();
    await a;
    await expect(b).rejects.toThrow("b failed");
    expect(signal.count()).toBe(0);
    expect(gate.activeQueries()).toBe(0);
  });

  it("reports the larger of its own queries and the signal's count", async () => {
    const signal = createForegroundSignal();
    const elsewhere = foregroundSignalFrom(signal.buffer);
    const gate = createFetchGate({ concurrency: 1, foreground: signal });
    const releaseOne = holdForeground(elsewhere);
    const releaseTwo = holdForeground(elsewhere);
    expect(gate.activeQueries()).toBe(2);

    const own = deferred();
    const query = gate.runQuery(() => own.promise);
    // The gate's own query counts in the signal too: three in all, not four.
    expect(gate.activeQueries()).toBe(3);
    await releaseOne();
    await releaseTwo();
    expect(gate.activeQueries()).toBe(1);
    own.resolve();
    await query;
    expect(gate.activeQueries()).toBe(0);
  });

  it("starts a background call at once while the signal reads zero", async () => {
    fakeTimers();
    const gate = createFetchGate({ concurrency: 1, foreground: createForegroundSignal() });
    expect(await settlesNow(gate.runBackground(async () => 1))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds a background call while another thread counts foreground work, until the count falls", async () => {
    fakeTimers();
    const signal = createForegroundSignal();
    const gate = createFetchGate({ concurrency: 1, foreground: signal });
    const release = holdForeground(foregroundSignalFrom(signal.buffer));
    let ran = false;
    const background = gate.runBackground(async () => {
      ran = true;
    });
    await advance(100);
    expect(ran).toBe(false);
    await release();
    await advance(4);
    expect(ran).toBe(true);
    await background;
  });

  it("starts a background call after FOREGROUND_WAIT_MS when the count never falls", async () => {
    fakeTimers();
    const signal = createForegroundSignal();
    const gate = createFetchGate({ concurrency: 1, foreground: signal });
    const release = holdForeground(foregroundSignalFrom(signal.buffer));
    let ran = false;
    const background = gate.runBackground(async () => {
      ran = true;
    });
    await advance(FOREGROUND_WAIT_MS - 1);
    expect(ran).toBe(false);
    await advance(1);
    expect(ran).toBe(true);
    expect(signal.count()).toBe(1);
    await background;
    await release();
  });

  it("keeps a background call behind its own queries after the bounded wait is over", async () => {
    fakeTimers();
    const signal = createForegroundSignal();
    // A second permit is free, so only the query's priority holds the call.
    const gate = createFetchGate({ concurrency: 2, foreground: signal });
    const own = deferred();
    const query = gate.runQuery(() => own.promise);
    let ran = false;
    const background = gate.runBackground(async () => {
      ran = true;
    });
    await advance(4 * FOREGROUND_WAIT_MS);
    expect(ran).toBe(false);
    own.resolve();
    await query;
    await turn();
    expect(ran).toBe(true);
    await background;
  });
});

describe("slicer with a foreground signal", () => {
  /** A slicer on a hand-moved clock whose yields resolve at once, counted.
   *  The clock does not move with the fake timers, so a wait on the signal
   *  ends on its timers. */
  function slicerWith(signal: ForegroundSignal | undefined, budgetMs = 8) {
    let now = 0;
    let yields = 0;
    const slicer = prioritySlicer({
      budgetMs,
      now: () => now,
      yieldNow: async () => {
        yields++;
      },
      ...(signal && { foreground: signal }),
    });
    return {
      slicer,
      yields: () => yields,
      spend: (ms: number) => {
        now += ms;
      },
    };
  }

  it("makes a background yield that has to yield wait while the signal is up", async () => {
    fakeTimers();
    const signal = createForegroundSignal();
    const release = holdForeground(signal);
    const s = slicerWith(signal);
    s.spend(8);
    const background = track(s.slicer.background());
    await advance(100);
    expect(background.settled()).toBe(false);
    expect(s.yields()).toBe(0);
    await release();
    await advance(4);
    expect(background.settled()).toBe(true);
    expect(s.yields()).toBe(1);
  });

  it("never holds a background call within its slice, nor any foreground yield", async () => {
    fakeTimers();
    const signal = createForegroundSignal();
    const release = holdForeground(signal);
    const s = slicerWith(signal);
    s.spend(4);
    expect(await settlesNow(s.slicer.background())).toBe(true);
    expect(s.yields()).toBe(0);
    s.spend(4);
    expect(await settlesNow(s.slicer.foreground())).toBe(true);
    expect(s.yields()).toBe(1);
    await release();
  });

  it("waits at most FOREGROUND_WAIT_MS at each background yield, then yields", async () => {
    fakeTimers();
    const signal = createForegroundSignal();
    const release = holdForeground(signal);
    const s = slicerWith(signal);
    for (const expected of [1, 2]) {
      s.spend(8);
      const background = track(s.slicer.background());
      await advance(FOREGROUND_WAIT_MS - 1);
      expect(background.settled()).toBe(false);
      await advance(1);
      expect(background.settled()).toBe(true);
      expect(s.yields()).toBe(expected);
    }
    await release();
  });

  it("waits on the signal once per background yield, not again when a foreground caller takes the turn it waited for", async () => {
    fakeTimers();
    const signal = createForegroundSignal();
    const release = holdForeground(signal);
    const turns: Array<() => void> = [];
    let now = 0;
    const slicer = prioritySlicer({
      budgetMs: 8,
      now: () => now,
      yieldNow: () => new Promise<void>((resolve) => turns.push(resolve)),
      foreground: signal,
    });
    now = 8;
    const background = track(slicer.background());
    await advance(FOREGROUND_WAIT_MS);
    expect(turns).toHaveLength(1);
    // A foreground caller waits on the same yield and takes its slice.
    const foreground = track(slicer.foreground());
    await turn();
    turns.shift()!();
    await turn();
    expect(foreground.settled()).toBe(true);
    // The background caller waits on the next yield at once, with no second
    // wait on the signal.
    expect(background.settled()).toBe(false);
    expect(turns).toHaveLength(1);
    turns.shift()!();
    await turn();
    expect(background.settled()).toBe(true);
    await release();
  });

  it("gives way to the signal set with yieldTo, and to none once it is set to undefined", async () => {
    fakeTimers();
    const signal = createForegroundSignal();
    const release = holdForeground(signal);
    const s = slicerWith(undefined);
    s.spend(8);
    expect(await settlesNow(s.slicer.background())).toBe(true);

    s.slicer.yieldTo(signal);
    s.spend(8);
    const held = track(s.slicer.background());
    await advance(100);
    expect(held.settled()).toBe(false);
    await advance(FOREGROUND_WAIT_MS);
    expect(held.settled()).toBe(true);

    s.slicer.yieldTo(undefined);
    s.spend(8);
    expect(await settlesNow(s.slicer.background())).toBe(true);
    expect(s.yields()).toBe(3);
    await release();
  });

  it("with a budget of zero, waits before every background yield and before no foreground one", async () => {
    fakeTimers();
    const signal = createForegroundSignal();
    const release = holdForeground(signal);
    const s = slicerWith(signal, 0);
    const background = track(s.slicer.background());
    await turn();
    expect(background.settled()).toBe(false);
    expect(await settlesNow(s.slicer.foreground())).toBe(true);
    expect(s.yields()).toBe(1);
    await release();
    await advance(4);
    expect(background.settled()).toBe(true);
    expect(s.yields()).toBe(2);
  });

  it("gives this thread's yieldInBackground the signal set with yieldBackgroundTo, and takes it away with undefined", async () => {
    fakeTimers();
    // The shared slicer's clock, moved by hand from past any slice the
    // real clock started.
    let clock = performance.now() + 1_000_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const signal = createForegroundSignal();
    const release = holdForeground(signal);
    yieldBackgroundTo(signal);

    const held = track(yieldInBackground());
    await advance(100);
    expect(held.settled()).toBe(false);
    // The foreground yield point shares the slicer and never waits.
    expect(await settlesNow(yieldOnBudget())).toBe(true);
    await release();
    await advance(4);
    await turn();
    expect(held.settled()).toBe(true);

    yieldBackgroundTo(undefined);
    const again = holdForeground(signal);
    clock += 1_000;
    expect(await settlesNow(yieldInBackground())).toBe(true);
    await again();
  });
});
