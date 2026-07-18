import { describe, expect, it } from "vitest";
import { createFetchGate } from "../src/fetch-gate.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("fetch gate", () => {
  it("never runs more than `concurrency` tasks at once", async () => {
    const gate = createFetchGate({ concurrency: 2 });
    let inFlight = 0;
    let maxInFlight = 0;
    const task = async (): Promise<void> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(10);
      inFlight--;
    };
    await Promise.all(Array.from({ length: 8 }, () => gate.runQuery(task)));
    expect(maxInFlight).toBe(2);
  });

  it("holds background until no query is active or queued, and lets a late query go first", async () => {
    const gate = createFetchGate({ concurrency: 1 });
    const order: string[] = [];
    const aGate = deferred<void>();
    const cGate = deferred<void>();

    const a = gate.runQuery(async () => {
      order.push("A-start");
      await aGate.promise;
      order.push("A-end");
    });
    await delay(5); // let A acquire the only permit

    const b = gate.runBackground(async () => {
      order.push("B");
    });
    const c = gate.runQuery(async () => {
      order.push("C-start");
      await cGate.promise;
      order.push("C-end");
    });
    await delay(5);

    // Background is blocked: A is active and C is queued.
    expect(order).toEqual(["A-start"]);
    expect(gate.activeQueries()).toBe(2);

    aGate.resolve(); // A finishes; the freed permit must go to the queued query C, not B
    await delay(5);
    expect(order).toContain("C-start");
    expect(order).not.toContain("B");

    cGate.resolve(); // C finishes; only now may background run
    await Promise.all([a, b, c]);
    expect(order).toEqual(["A-start", "A-end", "C-start", "C-end", "B"]);
    expect(gate.activeQueries()).toBe(0);
  });

  it("runs background work immediately when no query contends", async () => {
    const gate = createFetchGate({ concurrency: 2 });
    const value = await gate.runBackground(async () => 42);
    expect(value).toBe(42);
  });

  it("logs a background pause once per episode after the threshold", async () => {
    const pauses: number[] = [];
    const gate = createFetchGate({
      concurrency: 1,
      pauseThresholdMs: 20,
      onBackgroundPause: (ms) => pauses.push(ms),
    });
    const aGate = deferred<void>();
    const a = gate.runQuery(async () => {
      await aGate.promise;
    });
    await delay(5); // A holds the permit

    const b = gate.runBackground(async () => {});
    await delay(70); // stay blocked well past the 20ms threshold
    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toBeGreaterThanOrEqual(20);

    aGate.resolve();
    await Promise.all([a, b]);
    await delay(40); // no further pause fires once background has run
    expect(pauses).toHaveLength(1);
  });

  it("propagates task rejection and still releases the permit", async () => {
    const gate = createFetchGate({ concurrency: 1 });
    await expect(
      gate.runQuery(async () => {
        throw new Error("query failed");
      }),
    ).rejects.toThrow("query failed");
    // The permit was released, so the next task runs.
    expect(await gate.runQuery(async () => "ok")).toBe("ok");
    expect(gate.activeQueries()).toBe(0);
  });
});
