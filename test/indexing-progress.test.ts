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
      let progress: IndexingProgress | undefined = { indexed: 12, examined: 3, known: 40 };
      const recall = search(h.source, true, TEST_LIMITS, { ...deps, indexing: () => progress });
      const running = await runTool<SearchOutput>(recall, { query: "rateLimit", scope: "global" });
      expect(running.coverage?.cards?.indexing).toEqual({ indexed: 12, examined: 3, known: 40 });
      expect(running.warnings).toContain(
        "Indexing in progress: 12 of 40 sessions indexed; 3 checked in this pass; older history may be missing.",
      );

      progress = undefined; // the pass finished
      const done = await runTool<SearchOutput>(recall, { query: "rateLimit", scope: "global" });
      expect(done.coverage?.cards?.indexing).toBeUndefined();
      expect(done.warnings?.some((w) => w.startsWith("Indexing in progress"))).toBeFalsy();
    } finally {
      cleanup();
    }
  });

  it("recall says the index is incomplete, not in progress, when no pass is running", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await makeRecallDeps(h, TEST_LIMITS);
    try {
      const stalled: IndexingProgress = { indexed: 4, examined: 9, known: 40, stalled: true };
      const recall = search(h.source, true, TEST_LIMITS, { ...deps, indexing: () => stalled });
      const out = await runTool<SearchOutput>(recall, { query: "rateLimit", scope: "global" });
      expect(out.coverage?.cards?.indexing).toEqual(stalled);
      expect(out.warnings).toContain(
        "Index incomplete: 4 of 40 sessions indexed, and indexing is not running right now; older history may be missing.",
      );
      expect(out.warnings?.some((w) => w.startsWith("Indexing in progress"))).toBeFalsy();
    } finally {
      cleanup();
    }
  });

  it("recall_sessions notes indexing progress on card-selected listings only", async () => {
    const h = makeFakeHarness();
    const { store, cleanup } = await makeRecallDeps(h, TEST_LIMITS);
    try {
      const tool = sessions(h.source, true, TEST_LIMITS, {
        cards: () => store.allCards(),
        indexing: () => ({ indexed: 0, examined: 0, known: 0 }),
      });
      // A time filter selects from the cards.
      const carded = await runTool<SessionsOutput>(tool, { scope: "project", since: "30d" });
      expect(carded.ok).toBe(true);
      expect(carded.sessions.length).toBeGreaterThan(0);
      expect(carded.indexing).toEqual({ indexed: 0, examined: 0, known: 0 });
      expect(carded.note).toContain("Indexing in progress: sessions are still being discovered");

      // A plain listing is live: it does not depend on the index.
      const live = await runTool<SessionsOutput>(tool, { scope: "project" });
      expect(live.ok).toBe(true);
      expect(live.indexing).toBeUndefined();
      expect(live.note).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
