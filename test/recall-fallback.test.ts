import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchOutput } from "../src/types.js";
import { TEST_LIMITS, makeFakeHarness, runTool } from "./helpers.js";

const fuseSearch = vi.hoisted(() => vi.fn(() => []));

vi.mock("../src/fuse.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  fuseSearch,
}));

const { search } = await import("../src/search.js");

describe("recall smart fallback", () => {
  beforeEach(() => {
    fuseSearch.mockClear();
  });

  it("falls back to literal search when smart matching finds no results", async () => {
    const h = makeFakeHarness();
    const out = await runTool<SearchOutput>(search(h.client, h.unscoped, true, TEST_LIMITS), {
      query: "walkthrough",
      match: "smart",
    });

    expect(fuseSearch).toHaveBeenCalled();
    const firstCall = fuseSearch.mock.calls[0] as unknown[] | undefined;
    if (!firstCall) throw new Error("missing fuseSearch call");
    const candidates = firstCall[0] as unknown[];
    expect(candidates.length).toBeGreaterThan(0);
    expect(firstCall[2]).toBe("smart");
    expect(out.results).toHaveLength(3);
    expect(out.results.some((result) => result.source === "title")).toBe(true);
    expect(out.matchMode).toBe("literal");
    expect(out.degradeKind).toBe("fallback");
  });
});
