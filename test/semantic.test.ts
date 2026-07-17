import { describe, expect, it } from "vitest";
import { search, type SemanticSearchConfig } from "../src/search.js";
import { CorpusCache } from "../src/corpus.js";
import type { SearchOutput } from "../src/types.js";
import { TEST_LIMITS, makeFakeHarness, runTool } from "./helpers.js";

/**
 * A deterministic fake embedder: any text containing "limiting" (the query
 * anchor) or "walkthrough" (the semantically-close target) maps to one axis,
 * everything else to the orthogonal axis. This lets a lexically-disjoint
 * candidate reach cosine 1 with the query without sharing any content words.
 */
function fakeEmbedder(ready = true, initError?: string): SemanticSearchConfig["embedder"] {
  return {
    ready,
    initError,
    embed(text: string): Float32Array | undefined {
      if (!ready) return undefined;
      const lower = text.toLowerCase();
      const aligned = lower.includes("limiting") || lower.includes("walkthrough");
      return Float32Array.from(aligned ? [1, 0] : [0, 1]);
    },
  };
}

const QUERY = "checkout rate limiting";

describe("hybrid semantic merge", () => {
  it("surfaces a lexically-disjoint but semantically-close candidate when semantic is on", async () => {
    const h = makeFakeHarness();
    const embedder = fakeEmbedder();
    const cache = new CorpusCache(h.client, TEST_LIMITS, embedder);
    const tool = search(h.client, h.unscoped, true, TEST_LIMITS, cache, {
      embedder,
      weight: 0.35,
    });

    const out = await runTool<SearchOutput>(tool, {
      query: QUERY,
      match: "smart",
      group: "part",
      scope: "global",
    });

    // s-other ("...Actualyze walkthrough") shares no content words with the
    // query; only the semantic signal can pull it in.
    expect(out.results.some((r) => r.sessionID === "s-other")).toBe(true);
  });

  it("omits that candidate when semantic is off (lexical-only)", async () => {
    const h = makeFakeHarness();
    const cache = new CorpusCache(h.client, TEST_LIMITS); // no embedder
    const tool = search(h.client, h.unscoped, true, TEST_LIMITS, cache); // no semantic

    const out = await runTool<SearchOutput>(tool, {
      query: QUERY,
      match: "smart",
      group: "part",
      scope: "global",
    });

    expect(out.results.some((r) => r.sessionID === "s-other")).toBe(false);
  });

  it("records the semantic variant in the query plan under explain", async () => {
    const h = makeFakeHarness();
    const embedder = fakeEmbedder();
    const cache = new CorpusCache(h.client, TEST_LIMITS, embedder);
    const tool = search(h.client, h.unscoped, true, TEST_LIMITS, cache, {
      embedder,
      weight: 0.35,
    });

    const out = await runTool<SearchOutput>(tool, {
      query: QUERY,
      match: "smart",
      group: "part",
      scope: "global",
      explain: true,
    });

    expect(out.queryPlan?.variants).toContain("semantic");
    expect(out.queryPlan?.selected).toContain("semantic");
  });

  it("warns once and stays lexical-only when the embedder is not ready", async () => {
    const h = makeFakeHarness();
    const embedder = fakeEmbedder(false, "model download failed");
    const cache = new CorpusCache(h.client, TEST_LIMITS, embedder);
    const tool = search(h.client, h.unscoped, true, TEST_LIMITS, cache, {
      embedder,
      weight: 0.35,
    });

    const out = await runTool<SearchOutput>(tool, {
      query: QUERY,
      match: "smart",
      group: "part",
      scope: "global",
      explain: true,
    });

    expect(
      out.warnings?.some((w) => w.includes("Semantic search unavailable (model download failed)")),
    ).toBe(true);
    expect(out.results.some((r) => r.sessionID === "s-other")).toBe(false);
    expect(out.queryPlan?.selected).not.toContain("semantic");
  });
});
