import { describe, expect, it } from "vitest";
import { macrotask, SLICE_MS, timeSlicer } from "../src/yield.js";

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
});

describe("macrotask", () => {
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
