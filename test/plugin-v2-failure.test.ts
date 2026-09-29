import { afterEach, describe, expect, it, vi } from "vitest";
import { REGISTRY_KEY } from "../src/host/registry.js";
import { resetRuntimeRegistryForTests } from "../src/host/runtime.js";
import { fakeV2Host } from "./v2-host.js";

/**
 * A v2 runtime whose creation throws: the failure is logged, and the tools
 * answer that the runtime failed to start rather than that it is starting.
 */

vi.mock("../src/host/v2-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/host/v2-runtime.js")>();
  return {
    ...actual,
    v2RuntimeFactory: (inputs: Parameters<typeof actual.v2RuntimeFactory>[0]) => ({
      ...actual.v2RuntimeFactory(inputs),
      resolve: async () => ({ store: null, source: null }),
      create: async () => {
        throw new Error("runtime exploded");
      },
    }),
  };
});

const { default: entry } = await import("../src/opencode-session-recall.js");
const { setV2LogSinkForTests } = await import("../src/host/v2.js");
const { FAILED_REASON, STARTING_REASON } = await import("../src/host/v2-tools.js");

afterEach(() => {
  setV2LogSinkForTests(undefined);
  resetRuntimeRegistryForTests();
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
});

describe("v2 runtime creation failure", () => {
  it("logs once and answers tools with the failed-to-start reason", async () => {
    const lines: string[] = [];
    setV2LogSinkForTests(
      Object.assign((line: string) => void lines.push(line), { flush: async () => {} }),
    );
    const h = fakeV2Host({ options: { coldPass: false } });
    const cleanup = await entry.setup(h.ctx);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = await h.runTool("recall_sessions", { scope: "project" });
      const out = JSON.parse(result.content as string) as { ok: boolean; error?: string };
      expect(out.ok).toBe(false);
      expect(out.error).toContain(FAILED_REASON);
      expect(out.error).not.toContain(STARTING_REASON);
      expect(
        lines.filter((l) => l.includes("runtime creation failed: runtime exploded")),
      ).toHaveLength(1);
    } finally {
      await cleanup?.();
    }
  });
});
