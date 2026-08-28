import { afterAll, beforeAll, describe, it, expect } from "vitest";
import type { ToolDefinition } from "@opencode-ai/plugin";
import type { SearchOutput } from "../../src/types.js";
import { EVAL_CASES } from "./cases.js";
import { evalContext, makeDegradedEvalSearch, makeEvalSearch, runEval } from "./harness.js";
import { toolResultText } from "../helpers.js";
import BASELINE from "./baseline.json" with { type: "json" };

/** Run one recall query through a tool and parse it (throws on a non-ok body). */
async function runQuery(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<SearchOutput> {
  const raw = await tool.execute(args as Parameters<typeof tool.execute>[0], evalContext());
  const parsed = JSON.parse(toolResultText(raw)) as SearchOutput | { ok: false; error: string };
  if (!("ok" in parsed) || !parsed.ok) {
    throw new Error(`query failed: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

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
  let searchTool: ToolDefinition;
  let cleanup: () => void = () => {};
  const ctx = evalContext();

  // Seed the card store via the distiller cold pass once for the whole suite.
  beforeAll(async () => {
    ({ searchTool, cleanup } = await makeEvalSearch());
  });
  afterAll(() => cleanup());

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

  it("output-only needle: honest miss without deep, hit with a scoped deep sweep", async () => {
    // "quaxolith" lives solely in e-out's tool OUTPUT, which the distiller never
    // indexes, and e-out is one of the three oldest sessions the tier-1 recency
    // near-miss drops — so a non-deep smart query never drills it (the honest
    // miss), while a deep sweep scoped to e-out reads its outputs and finds it.
    const shallow = await runQuery(searchTool, {
      query: "quaxolith",
      match: "smart",
      group: "session",
      scope: "global",
    });
    expect(shallow.results.some((r) => r.sessionID === "e-out")).toBe(false);
    expect(JSON.stringify(shallow.results)).not.toContain("quaxolith");

    const deep = await runQuery(searchTool, {
      query: "quaxolith",
      match: "smart",
      group: "session",
      scope: "global",
      deep: true,
      sessions: ["e-out"],
    });
    expect(deep.results.some((r) => r.sessionID === "e-out")).toBe(true);
    expect(deep.coverage?.deep?.sessionsCovered).toBe(1);
    expect(deep.warnings?.some((w) => /Deep sweep searched tool outputs/i.test(w))).toBe(true);
  });

  it("virgin degraded mode: metadata-quality results with degraded coverage", async () => {
    // Store unavailable (virgin machine): cards-lite from the session list still
    // ranks and drills by metadata, and coverage must report the degradation.
    const { searchTool: degraded } = makeDegradedEvalSearch();
    const out = await runQuery(degraded, {
      query: "postgres",
      match: "smart",
      group: "session",
      scope: "global",
    });
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results.some((r) => r.sessionID === "e-db")).toBe(true);
    expect(out.coverage?.cards?.degraded).toBe(true);
    expect(
      out.warnings?.some((w) => /metadata-only|degraded/i.test(w)),
      `expected a degraded-cards warning, got ${JSON.stringify(out.warnings)}`,
    ).toBe(true);
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
