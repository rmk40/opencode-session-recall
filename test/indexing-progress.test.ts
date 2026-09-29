import { describe, expect, it } from "vitest";
import { search } from "../src/search.js";
import { sessions } from "../src/sessions.js";
import type { IndexingProgress, SearchOutput, SessionsOutput } from "../src/types.js";
import { makeFakeHarness, makeRecallDeps, runTool, TEST_LIMITS } from "./helpers.js";

/**
 * While the distiller's cold pass runs, the card store is incomplete, so a
 * card-backed answer must say so: coverage.cards.indexing, a warning on
 * recall, and a note on recall_sessions. Both hosts wire the distiller's
 * status into these through the `indexing` hooks.
 */

describe("cold-pass progress in responses", () => {
  it("recall reports indexing progress and warns while the pass runs", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await makeRecallDeps(h, TEST_LIMITS);
    try {
      let progress: IndexingProgress | undefined = { examined: 3, known: 40 };
      const recall = search(h.source, true, TEST_LIMITS, { ...deps, indexing: () => progress });
      const running = await runTool<SearchOutput>(recall, { query: "rateLimit", scope: "global" });
      expect(running.coverage?.cards?.indexing).toEqual({ examined: 3, known: 40 });
      expect(running.warnings).toContain(
        "Indexing in progress: 3 of 40 sessions indexed so far; older history may be missing.",
      );

      progress = undefined; // the pass finished
      const done = await runTool<SearchOutput>(recall, { query: "rateLimit", scope: "global" });
      expect(done.coverage?.cards?.indexing).toBeUndefined();
      expect(done.warnings?.some((w) => w.startsWith("Indexing in progress"))).toBeFalsy();
    } finally {
      cleanup();
    }
  });

  it("recall_sessions notes indexing progress on card-backed listings", async () => {
    const h = makeFakeHarness();
    const { store, cleanup } = await makeRecallDeps(h, TEST_LIMITS);
    try {
      const tool = sessions(h.source, true, TEST_LIMITS, {
        cards: () => store.allCards(),
        indexing: () => ({ examined: 0, known: 0 }),
      });
      const out = await runTool<SessionsOutput>(tool, { scope: "project" });
      expect(out.ok).toBe(true);
      expect(out.indexing).toEqual({ examined: 0, known: 0 });
      expect(out.note).toContain("Indexing in progress: sessions are still being discovered");
    } finally {
      cleanup();
    }
  });
});
