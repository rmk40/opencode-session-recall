import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/host/opencode-v1-types.js";
import type { SearchOutput } from "../../src/types.js";
import { DISCOVERY_LIMIT } from "../../src/types.js";
import { createV2HistorySource, openOpencodeDb } from "../../src/history/v2.js";
import { EVAL_CASES } from "./cases.js";
import { makeEvalCorpus } from "./corpus.js";
import { evalContext, makeEvalSearchOver, runEval } from "./harness.js";
import { setStrictNoLimitMessages, toolResultText } from "../helpers.js";
import { limitSpy, makeV2Db, writeV1Corpus, type V2TestDb } from "../v2-db.js";
import BASELINE from "./baseline.json" with { type: "json" };

/**
 * Parity eval: the labeled eval corpus written as v2 rows
 * into a temp `opencode.db`, then the unchanged relevance harness (cold pass,
 * cards, drill, `recall`) run through the v2 history source. It must meet the
 * same baseline as the v1 path.
 *
 * The writer is the inverse of the projector, so this proves the v2 read path
 * keeps ranking quality on the same content (self-consistency), not that the
 * projection is faithful to real v2 data; the faithfulness fixture
 * (`test/v2-faithfulness.test.ts`) covers that.
 */
describe("recall relevance eval through the v2 history source", () => {
  let searchTool: ToolDefinition;
  let t: V2TestDb;
  let cleanup: () => void = () => {};

  beforeAll(async () => {
    setStrictNoLimitMessages(true);
    const corpus = makeEvalCorpus();
    t = await makeV2Db();
    writeV1Corpus(t.db, corpus.globalSessions, corpus.messagesBySession);
    const opened = await openOpencodeDb(t.path);
    if (!opened.ok) throw new Error(opened.reason);
    // Every v2 read of the whole eval path goes through the LIMIT spy.
    const source = createV2HistorySource(limitSpy(opened.db), { projectID: "project-main" });
    const built = await makeEvalSearchOver(source, async () => {
      const listing = await source.listSessions({ scope: "global", limit: DISCOVERY_LIMIT });
      if (!listing.ok) throw new Error(listing.error);
      return listing.items;
    });
    // The cold pass distilled every corpus session through the v2 source.
    expect(built.cardCount).toBe(corpus.globalSessions.length);
    searchTool = built.searchTool;
    cleanup = () => {
      built.cleanup();
      opened.db.close();
      t.cleanup();
    };
  });
  afterAll(() => cleanup());

  it("meets or beats the recorded baseline (MRR, recall@5)", async () => {
    const summary = await runEval(searchTool, EVAL_CASES, evalContext());
    const detail = summary.cases
      .map(
        (c) => `  ${c.name}: rank=${c.firstRelevantRank} top=${c.returnedSessionIDs.slice(0, 3)}`,
      )
      .join("\n");
    expect(summary.mrr, `MRR ${summary.mrr}\n${detail}`).toBeGreaterThanOrEqual(
      BASELINE.mrr - 1e-9,
    );
    expect(summary.recallAt5, `recall@5 ${summary.recallAt5}\n${detail}`).toBeGreaterThanOrEqual(
      BASELINE.recallAt5 - 1e-9,
    );
  });

  it("meets per-case expectations (exclusions, evidence classes)", async () => {
    const summary = await runEval(searchTool, EVAL_CASES, evalContext());
    for (const [index, c] of EVAL_CASES.entries()) {
      const result = summary.cases[index]!;
      if (!c.expect) continue;
      for (const banned of c.expect.notInResults ?? []) {
        expect(result.returnedSessionIDs, `${c.name}: ${banned}`).not.toContain(banned);
      }
      for (const { session, below } of c.expect.rankedBelow ?? []) {
        const upper = result.returnedSessionIDs.indexOf(below);
        expect(upper, `${c.name}: ${below}`).toBeGreaterThanOrEqual(0);
        expect(
          result.returnedSessionIDs.indexOf(session),
          `${c.name}: ${session} below ${below}`,
        ).toBeGreaterThan(upper);
      }
      if (c.expect.classInTop3) {
        const top3 = result.topClasses.slice(0, 3);
        expect(
          c.expect.classInTop3.some((cls) => top3.includes(cls)),
          `${c.name}: top-3 classes [${top3.join(", ")}]`,
        ).toBe(true);
      }
      for (const [cls, max] of Object.entries(c.expect.maxClassInTop5 ?? {})) {
        const count = result.topClasses.slice(0, 5).filter((got) => got === cls).length;
        expect(count, `${c.name}: ${cls} in top 5`).toBeLessThanOrEqual(max as number);
      }
    }
  });

  it("output-only needle: honest miss without deep, hit with a scoped deep sweep", async () => {
    const run = async (args: Record<string, unknown>): Promise<SearchOutput> => {
      const raw = await searchTool.execute(
        args as Parameters<typeof searchTool.execute>[0],
        evalContext(),
      );
      const parsed = JSON.parse(toolResultText(raw)) as SearchOutput;
      if (!parsed.ok) throw new Error(JSON.stringify(parsed));
      return parsed;
    };
    const base = { query: "quaxolith", match: "smart", group: "session", scope: "global" };
    const shallow = await run(base);
    expect(shallow.results.some((r) => r.sessionID === "e-out")).toBe(false);
    const deep = await run({ ...base, deep: true, sessions: ["e-out"] });
    expect(deep.results.some((r) => r.sessionID === "e-out")).toBe(true);
    expect(deep.coverage?.deep?.sessionsCovered).toBe(1);
  });
});
