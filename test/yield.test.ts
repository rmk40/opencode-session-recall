import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createV2HistorySource, openOpencodeDb } from "../src/history/v2.js";
import {
  BACKGROUND_EVERY,
  macrotask,
  prioritySlicer,
  SLICE_MS,
  timeSlicer,
  yieldInBackground,
  yieldOnBudget,
} from "../src/yield.js";
import { insertProject, insertSession, makeV2PartsDb } from "./v2-db.js";

/** A clock the test advances by hand, and a yield that records each call. */
function harness(budgetMs = SLICE_MS) {
  let now = 0;
  const yields: number[] = [];
  const slicer = timeSlicer({
    budgetMs,
    now: () => now,
    yieldNow: async () => {
      yields.push(now);
    },
  });
  return {
    slicer,
    yields,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("timeSlicer", () => {
  it("resolves without yielding while the slice is within its budget", async () => {
    const h = harness(8);
    for (let i = 0; i < 7; i++) {
      h.advance(1);
      await h.slicer();
    }
    expect(h.yields).toEqual([]);
  });

  it("yields once the budget has run and starts the next slice after the yield", async () => {
    const h = harness(8);
    h.advance(8);
    await h.slicer();
    expect(h.yields).toEqual([8]);
    // The new slice began at the yield: 7 ms later is still within it.
    h.advance(7);
    await h.slicer();
    expect(h.yields).toEqual([8]);
    h.advance(1);
    await h.slicer();
    expect(h.yields).toEqual([8, 16]);
  });

  it("yields at the first yield point past the budget, so a slice overruns it by less than one unit of work", async () => {
    // Units of work of varying cost, with a yield point after each.
    const h = harness(8);
    const costs = [3, 1, 5, 2, 2, 7, 1, 1, 1, 4, 6, 2, 3, 3, 9, 1, 12, 2];
    const slices: Array<{ length: number; last: number }> = [];
    let length = 0;
    for (const cost of costs) {
      h.advance(cost);
      length += cost;
      const before = h.yields.length;
      await h.slicer();
      if (h.yields.length > before) {
        slices.push({ length, last: cost });
        length = 0;
      }
    }
    expect(slices.length).toBeGreaterThan(3);
    for (const slice of slices) {
      // It ran the budget, and had not before its last unit.
      expect(slice.length).toBeGreaterThanOrEqual(8);
      expect(slice.length - slice.last).toBeLessThan(8);
    }
    // What is left after the last yield is within the budget.
    expect(length).toBeLessThan(8);
  });

  it("defaults to a SLICE_MS budget", async () => {
    let now = 0;
    let yields = 0;
    const slicer = timeSlicer({
      now: () => now,
      yieldNow: async () => {
        yields++;
      },
    });
    now = SLICE_MS - 0.5;
    await slicer();
    expect(yields).toBe(0);
    now = SLICE_MS;
    await slicer();
    expect(yields).toBe(1);
  });

  it("starts the next slice when the yield returns, so the time spent yielding is not charged to it", async () => {
    // Other work runs for 5 ms while this one is yielded.
    let now = 0;
    let yields = 0;
    const slicer = timeSlicer({
      budgetMs: 8,
      now: () => now,
      yieldNow: async () => {
        yields++;
        now += 5;
      },
    });
    now = 8;
    await slicer();
    expect(yields).toBe(1);
    now += 7;
    await slicer();
    expect(yields).toBe(1);
    now += 1;
    await slicer();
    expect(yields).toBe(2);
  });

  it("shares one slice among the callers of one slicer", async () => {
    // Two workers take turns, each running 5 ms between its yield points:
    // neither alone passes the budget, together they do.
    let now = 0;
    const yields: string[] = [];
    let caller = "";
    const slicer = timeSlicer({
      budgetMs: 8,
      now: () => now,
      yieldNow: async () => {
        yields.push(caller);
      },
    });
    const step = async (name: string): Promise<void> => {
      now += 5;
      caller = name;
      await slicer();
    };
    await step("a");
    await step("b");
    await step("a");
    await step("b");
    expect(yields).toEqual(["b", "b"]);
  });

  it("lets one of several callers past the budget run per yield, the rest waiting in line", async () => {
    // Each worker, once resumed, does a whole slice of work. A yield resolves
    // only when the test releases it, as a turn of the event loop would.
    let now = 0;
    const turns: Array<() => void> = [];
    const slicer = timeSlicer({
      budgetMs: 8,
      now: () => now,
      yieldNow: () => new Promise<void>((resolve) => turns.push(resolve)),
    });
    const ran: string[] = [];
    const worker = async (name: string): Promise<void> => {
      await slicer();
      ran.push(name);
      now += 8;
    };
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    now = 8;
    const workers = [worker("a"), worker("b"), worker("c")];
    await settle();
    expect(turns).toHaveLength(1);
    for (const expected of [["a"], ["a", "b"], ["a", "b", "c"]]) {
      turns.shift()!();
      await settle();
      expect(ran).toEqual(expected);
    }
    expect(turns).toEqual([]);
    await Promise.all(workers);
  });

  it("lets a later caller start a new yield when the pending one never resolves", async () => {
    let now = 0;
    let calls = 0;
    const slicer = timeSlicer({
      budgetMs: 8,
      now: () => now,
      yieldNow: () => {
        calls++;
        // The first yield's callback is lost; later ones resolve.
        return calls === 1 ? new Promise<void>(() => {}) : Promise.resolve();
      },
    });
    now = 8;
    void slicer();
    await Promise.resolve();
    now = 200;
    await slicer();
    expect(calls).toBe(2);
  });
});

describe("prioritySlicer", () => {
  it("gives a slice to a waiting foreground caller before background callers that came first, and one turn in every backgroundEvery to the background", async () => {
    let now = 0;
    const turns: Array<() => void> = [];
    const slicer = prioritySlicer({
      budgetMs: 8,
      backgroundEvery: 3,
      now: () => now,
      yieldNow: () => new Promise<void>((resolve) => turns.push(resolve)),
    });
    const ran: string[] = [];
    // Each time a worker resumes it does a whole slice of work.
    const worker = async (name: string, at: () => Promise<void>, slices: number): Promise<void> => {
      for (let i = 0; i < slices; i++) {
        await at();
        ran.push(name);
        now += 8;
      }
    };
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    now = 8;
    const workers = [
      worker("b1", slicer.background, 2),
      worker("b2", slicer.background, 2),
      worker("f", slicer.foreground, 5),
    ];
    await settle();
    for (let turn = 0; turn < 9; turn++) {
      turns.shift()!();
      await settle();
    }
    expect(ran).toEqual(["f", "f", "b1", "f", "f", "b2", "f", "b1", "b2"]);
    expect(turns).toEqual([]);
    await Promise.all(workers);
  });

  /** A slicer whose yields resolve only when the test releases them, as a
   *  turn of the event loop would, and workers that each do a whole slice of
   *  work every time they resume. */
  function contested(opts: { backgroundEvery?: number } = {}) {
    let now = 0;
    const turns: Array<() => void> = [];
    const slicer = prioritySlicer({
      budgetMs: 8,
      ...opts,
      now: () => now,
      yieldNow: () => new Promise<void>((resolve) => turns.push(resolve)),
    });
    const ran: string[] = [];
    const workers: Array<Promise<void>> = [];
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    now = 8;
    return {
      slicer,
      ran,
      turns,
      start(name: string, at: () => Promise<void>, slices: number): void {
        workers.push(
          (async () => {
            for (let i = 0; i < slices; i++) {
              await at();
              ran.push(name);
              now += 8;
            }
          })(),
        );
      },
      /** Release the pending yields one at a time, `count` of them. */
      async release(count: number): Promise<void> {
        await settle();
        for (let turn = 0; turn < count; turn++) {
          turns.shift()!();
          await settle();
        }
      },
      /** Release yields until every worker has finished. */
      async drain(): Promise<void> {
        await settle();
        while (turns.length > 0) {
          turns.shift()!();
          await settle();
        }
        await Promise.all(workers);
      },
    };
  }

  it("gives background callers one turn in BACKGROUND_EVERY by default, and foreground callers theirs in the order they waited", async () => {
    // The background caller waits first; both foreground callers keep
    // waiting past the 2 * BACKGROUND_EVERY turns observed.
    const c = contested();
    c.start("b", c.slicer.background, 2);
    c.start("f1", c.slicer.foreground, 2 * BACKGROUND_EVERY);
    c.start("f2", c.slicer.foreground, 2 * BACKGROUND_EVERY);
    await c.release(2 * BACKGROUND_EVERY);
    // Every BACKGROUND_EVERY-th turn is the background's; the foreground
    // callers alternate through the rest, the one that waited longer first.
    const expected: string[] = [];
    let next = "f1";
    for (let turn = 1; turn <= 2 * BACKGROUND_EVERY; turn++) {
      if (turn % BACKGROUND_EVERY === 0) {
        expected.push("b");
        continue;
      }
      expected.push(next);
      next = next === "f1" ? "f2" : "f1";
    }
    expect(c.ran).toEqual(expected);
    await c.drain();
  });

  it("hands each yield to the next background caller in line when no foreground caller waits", async () => {
    const c = contested({ backgroundEvery: 3 });
    for (const name of ["b1", "b2", "b3"]) c.start(name, c.slicer.background, 2);
    await c.release(6);
    expect(c.ran).toEqual(["b1", "b2", "b3", "b1", "b2", "b3"]);
    expect(c.turns).toEqual([]);
    await c.drain();
  });

  it("shares one slice between its foreground and background yield points", async () => {
    let now = 0;
    const yields: string[] = [];
    let caller = "";
    const slicer = prioritySlicer({
      budgetMs: 8,
      now: () => now,
      yieldNow: async () => {
        yields.push(caller);
      },
    });
    const step = async (name: "foreground" | "background"): Promise<void> => {
      now += 5;
      caller = name;
      await slicer[name]();
    };
    // 5 ms a step: within the budget for one step, past it for two
    // together, whichever points they go through.
    await step("foreground");
    await step("background");
    await step("foreground");
    await step("background");
    expect(yields).toEqual(["background", "background"]);
  });

  it("lets the first waiter on a yield replaced as stale take a slice when it resolves, whatever its class", async () => {
    let now = 0;
    const turns: Array<() => void> = [];
    const slicer = prioritySlicer({
      budgetMs: 8,
      now: () => now,
      yieldNow: () => new Promise<void>((resolve) => turns.push(resolve)),
    });
    const ran: string[] = [];
    const call = (name: string, at: () => Promise<void>): Promise<void> =>
      at().then(() => {
        ran.push(name);
      });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    now = 8;
    // A background and a foreground caller wait on the first yield, which
    // stays pending past 100 ms, so a later caller starts another.
    const waiting = [call("b", slicer.background), call("f1", slicer.foreground)];
    await settle();
    now += 101;
    waiting.push(call("f2", slicer.foreground));
    await settle();
    expect(turns).toHaveLength(2);

    // The replaced yield resolves late: its first waiter takes the slice,
    // though a foreground caller waited on it too, and the newer yield still
    // holds its own waiter.
    turns.shift()!();
    await settle();
    expect(ran).toEqual(["b"]);
    turns.shift()!();
    await settle();
    expect(ran).toEqual(["b", "f2"]);
    turns.shift()!();
    await settle();
    expect(ran).toEqual(["b", "f2", "f1"]);
    expect(turns).toEqual([]);
    await Promise.all(waiting);
  });

  it("yields at every call of either point with a budget of zero", async () => {
    let yields = 0;
    const slicer = prioritySlicer({
      budgetMs: 0,
      now: () => 0,
      yieldNow: async () => {
        yields++;
      },
    });
    await slicer.foreground();
    await slicer.background();
    await slicer.background();
    expect(yields).toBe(3);
  });
});

describe("yieldOnBudget", () => {
  // `performance.now`, which the shared slicer reads, moved by hand from a
  // second past the real clock, so the first yield point is past any slice
  // started earlier.
  let clock = 0;
  beforeEach(() => {
    clock = performance.now() + 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Whether awaiting `run` let a macrotask queued just before it run. */
  async function yielded(run: () => Promise<unknown>): Promise<boolean> {
    let ran = false;
    setImmediate(() => {
      ran = true;
    });
    await run();
    return ran;
  }

  it("yields to the event loop only once a slice of work has run since its last yield", async () => {
    expect(await yielded(yieldOnBudget)).toBe(true);
    clock += SLICE_MS - 1;
    expect(await yielded(yieldOnBudget)).toBe(false);
    clock += 1;
    expect(await yielded(yieldOnBudget)).toBe(true);
  });

  it("is the one slice the v2 history source yields through by default", async () => {
    const t = await makeV2PartsDb();
    try {
      insertProject(t.db, { id: "prj", worktree: "/w/app" });
      insertSession(t.db, {
        id: "ses_a",
        project_id: "prj",
        directory: "/w/app",
        time_created: 0,
        time_updated: 0,
      });
      const opened = await openOpencodeDb(t.path);
      if (!opened.ok) throw new Error(opened.reason);
      try {
        // Built before the clock moves, so a slicer of its own would count
        // its slice from here.
        const source = createV2HistorySource(opened.db);
        const seek = () => source.seekPage!({ sessionID: "ses_a", until: 1 });
        clock += 1_000;
        // A yield anywhere starts a slice the source's reads then share.
        expect(await yielded(yieldOnBudget)).toBe(true);
        expect(await yielded(seek)).toBe(false);
        // And a read past the budget starts the slice everyone else shares.
        clock += SLICE_MS;
        expect(await yielded(seek)).toBe(true);
        expect(await yielded(yieldOnBudget)).toBe(false);
      } finally {
        opened.db.close();
      }
    } finally {
      t.cleanup();
    }
  });

  it("shares its slice with yieldInBackground, and goes ahead of it on a yield both wait on", async () => {
    // Well past the slice the tests before this one left, which moved the
    // clock ahead of their own start.
    clock += 10_000;
    expect(await yielded(yieldOnBudget)).toBe(true);
    clock += SLICE_MS - 1;
    expect(await yielded(yieldInBackground)).toBe(false);
    clock += 1;
    expect(await yielded(yieldInBackground)).toBe(true);
    expect(await yielded(yieldOnBudget)).toBe(false);

    // Past the budget, a background caller waits first and a foreground one
    // after it.
    clock += SLICE_MS;
    const order: string[] = [];
    await Promise.all([
      yieldInBackground().then(() => order.push("background")),
      yieldOnBudget().then(() => order.push("foreground")),
    ]);
    expect(order).toEqual(["foreground", "background"]);
  });
});

describe("macrotask", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves through setImmediate where the runtime has it", async () => {
    const held: Array<() => void> = [];
    vi.stubGlobal("setImmediate", (callback: () => void) => {
      held.push(callback);
    });
    let done = false;
    const pending = macrotask().then(() => {
      done = true;
    });
    vi.unstubAllGlobals();
    expect(held).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(done).toBe(false);
    held[0]!();
    await pending;
    expect(done).toBe(true);
  });

  it("falls back to setTimeout(0) where the runtime has no setImmediate", async () => {
    vi.stubGlobal("setImmediate", undefined);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const pending = macrotask();
    const calls = [...timeout.mock.calls];
    vi.unstubAllGlobals();
    timeout.mockRestore();
    expect(calls).toEqual([[expect.any(Function), 0]]);
    await pending;
  });

  it("lets a due timer run within a turn or two of the event loop", async () => {
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 0);
    const busy = (ms: number): void => {
      const end = performance.now() + ms;
      while (performance.now() < end);
    };
    let turns = 0;
    while (!fired && turns < 5) {
      busy(3);
      await macrotask();
      turns++;
    }
    expect(fired).toBe(true);
    expect(turns).toBeLessThanOrEqual(2);
  });
});
