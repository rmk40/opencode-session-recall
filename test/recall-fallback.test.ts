import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchOutput } from "../src/types.js";
import { CorpusCache } from "../src/corpus.js";
import { TEST_LIMITS, makeFakeHarness, runTool } from "./helpers.js";

// The smart broad pass gets its BM25 hits from either the persistent index
// (searchRawHits, via CorpusCache.searchPersistent) or a per-query side index
// (sideSearch). Stub BOTH to return nothing so the smart pass finds no results
// and the tool falls back to literal.
const searchRawHits = vi.hoisted(() => vi.fn(() => []));
const sideSearch = vi.hoisted(() => vi.fn(() => []));

vi.mock("../src/bm25.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  searchRawHits,
  sideSearch,
}));

const { search } = await import("../src/search.js");

describe("recall smart fallback", () => {
  beforeEach(() => {
    searchRawHits.mockClear();
    sideSearch.mockClear();
  });

  it("falls back to literal search when smart matching finds no results", async () => {
    const h = makeFakeHarness();
    const out = await runTool<SearchOutput>(
      search(h.client, h.unscoped, true, TEST_LIMITS, new CorpusCache(h.client, TEST_LIMITS)),
      {
        query: "walkthrough",
        match: "smart",
      },
    );

    // The broad BM25 pass ran (returned nothing via the stub), so the tool fell
    // back to literal, which finds the "walkthrough" hits including the title.
    expect(searchRawHits.mock.calls.length + sideSearch.mock.calls.length).toBeGreaterThan(0);
    expect(out.results).toHaveLength(3);
    expect(out.results.some((result) => result.source === "title")).toBe(true);
    expect(out.matchMode).toBe("literal");
    expect(out.degradeKind).toBe("fallback");
  });
});
