import { describe, expect, it } from "vitest";
import v8 from "node:v8";
import vm from "node:vm";
import { stallProbe } from "./perf-helpers.js";

/** V8's `gc` function. `--expose-gc` is not set at launch, so the flag is
 *  turned on only while a new context picks the function up. */
function gcHandle(): () => void {
  v8.setFlagsFromString("--expose-gc");
  try {
    return vm.runInNewContext("gc") as () => void;
  } finally {
    v8.setFlagsFromString("--no-expose-gc");
  }
}

describe("stallProbe", () => {
  it.each([
    ["a timer", (run: () => void) => setTimeout(run, 0)],
    ["an immediate", (run: () => void) => setImmediate(run)],
  ])(
    "puts a collection that ends an operation run from %s down to GC",
    async (_phase, schedule) => {
      const gc = gcHandle();
      // Enough live objects that a full collection takes milliseconds.
      const retained = Array.from({ length: 1_000_000 }, (_, i) => ({ i, text: `item ${i}` }));
      const probe = stallProbe();
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        probe.reset();
        const span = { from: 0, to: 0 };
        await new Promise<void>((resolve) => {
          schedule(() => {
            span.from = performance.now();
            gc();
            span.to = performance.now();
            resolve();
          });
        });
        // Read at once: the collection's entry may not have been delivered.
        const stalls = await probe.stalls(span);
        expect(stalls.gcCount).toBeGreaterThan(0);
        expect(stalls.maxMs).toBeGreaterThan(0);
        // The gap holding the collection is put down to it, not to code.
        expect(stalls.gcMs).toBeGreaterThan(stalls.maxOutsideGcMs);
        expect(stalls.maxOutsideGcMs).toBeLessThan(stalls.maxMs);
      } finally {
        probe.stop();
      }
      expect(retained).toHaveLength(1_000_000);
    },
  );
});
