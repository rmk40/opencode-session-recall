import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createV2HistorySource, openOpencodeDb } from "../src/history/v2.js";
import { macrotask, SLICE_MS, timeSlicer, yieldOnBudget } from "../src/yield.js";
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
