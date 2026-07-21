import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchOutput } from "../src/types.js";
import { TEST_LIMITS, makeFakeHarness, makeRecallDeps, runTool } from "./helpers.js";

const bm25Search = vi.hoisted(() => vi.fn(() => []));

vi.mock("../src/bm25.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  bm25Search,
}));

const { search } = await import("../src/search.js");

describe("recall smart fallback", () => {
  beforeEach(() => {
    bm25Search.mockClear();
  });

  it("falls back to literal search when smart matching finds no results", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await makeRecallDeps(h);
    let out: SearchOutput;
    try {
      out = await runTool<SearchOutput>(search(h.client, h.unscoped, true, TEST_LIMITS, deps), {
        query: "walkthrough",
        match: "smart",
      });
    } finally {
      cleanup();
    }

    // BM25 ran (returned nothing via the mock), so the tool fell back to literal.
    expect(bm25Search).toHaveBeenCalled();
    const firstCall = bm25Search.mock.calls[0] as unknown[] | undefined;
    if (!firstCall) throw new Error("missing bm25Search call");
    const candidates = firstCall[0] as unknown[];
    expect(candidates.length).toBeGreaterThan(0);
    expect(firstCall[2]).toBe("smart");
    expect(out.results).toHaveLength(3);
    expect(out.results.some((result) => result.source === "title")).toBe(true);
    expect(out.matchMode).toBe("literal");
    expect(out.degradeKind).toBe("fallback");
  });
});
