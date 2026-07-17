import { describe, it, expect } from "vitest";
import { search } from "../../src/search.js";
import { CorpusCache } from "../../src/corpus.js";
import { TEST_LIMITS } from "../helpers.js";
import { EVAL_CASES } from "./cases.js";
import { makeEvalClients, evalContext, runEval } from "./harness.js";
import BASELINE from "./baseline.json" with { type: "json" };

/**
 * Relevance gate. Runs the live `recall` search over the labeled eval corpus and
 * asserts MRR / recall@5 meet the recorded baseline.
 *
 * baseline.json holds the numbers produced by the production ranker. When the
 * ranking engine changes, the new engine must MEET OR BEAT these numbers — the
 * test fails if relevance regresses. To intentionally move the baseline, update
 * baseline.json in the same change-set and explain why.
 */
describe("recall relevance eval", () => {
  const { client, unscoped } = makeEvalClients();
  const searchTool = search(
    client,
    unscoped,
    true,
    TEST_LIMITS,
    new CorpusCache(client, TEST_LIMITS),
  );
  const ctx = evalContext();

  it("meets or beats the recorded baseline (MRR, recall@5)", async () => {
    const summary = await runEval(searchTool, EVAL_CASES, ctx);

    // Surface per-case detail on failure for easy diagnosis.
    const detail = summary.cases
      .map(
        (c) => `  ${c.name}: rank=${c.firstRelevantRank} rr=${c.rr.toFixed(3)} hit@5=${c.hitAt5}`,
      )
      .join("\n");

    expect(
      summary.mrr,
      `MRR ${summary.mrr.toFixed(3)} < baseline ${BASELINE.mrr}\n${detail}`,
    ).toBeGreaterThanOrEqual(BASELINE.mrr - 1e-9);

    expect(
      summary.recallAt5,
      `recall@5 ${summary.recallAt5.toFixed(3)} < baseline ${BASELINE.recallAt5}\n${detail}`,
    ).toBeGreaterThanOrEqual(BASELINE.recallAt5 - 1e-9);
  });

  it("reports per-case ranks (diagnostic; not a gate)", async () => {
    const summary = await runEval(searchTool, EVAL_CASES, ctx);
    // Every case must be well-formed: at least one returned-or-not run completes
    // without throwing, and the summary covers all cases.
    expect(summary.cases).toHaveLength(EVAL_CASES.length);
    // Coverage check: each relevant session in the corpus is reachable by id.
    for (const c of EVAL_CASES) {
      expect(c.relevantSessionIDs.length).toBeGreaterThan(0);
    }
  });

  it("meets per-case expectations (exclusions, evidence classes)", async () => {
    const summary = await runEval(searchTool, EVAL_CASES, ctx);
    for (const [index, c] of EVAL_CASES.entries()) {
      const result = summary.cases[index]!;
      if (!c.expect) continue;

      for (const banned of c.expect.notInResults ?? []) {
        expect(
          result.returnedSessionIDs,
          `${c.name}: session ${banned} must not appear in results`,
        ).not.toContain(banned);
      }

      if (c.expect.classInTop3) {
        const top3 = result.topClasses.slice(0, 3);
        expect(
          c.expect.classInTop3.some((cls) => top3.includes(cls)),
          `${c.name}: expected one of [${c.expect.classInTop3.join(", ")}] in top-3 classes, got [${top3.join(", ")}]`,
        ).toBe(true);
      }

      for (const [cls, max] of Object.entries(c.expect.maxClassInTop5 ?? {})) {
        const count = result.topClasses.slice(0, 5).filter((got) => got === cls).length;
        expect(
          count,
          `${c.name}: class ${cls} appears ${count} times in top 5 (max ${max})`,
        ).toBeLessThanOrEqual(max as number);
      }
    }
  });
});
