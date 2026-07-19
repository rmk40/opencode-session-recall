import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@opencode-ai/plugin";
import type { SearchOutput } from "../../src/types.js";
import { TEST_LIMITS } from "../helpers.js";
import {
  PROJECT_DIR,
  assistantMessage,
  bundle,
  completedToolPart,
  globalSessionFrom,
  session,
  textPart,
  userMessage,
} from "../helpers.js";
import type { EvalCorpus, MessageBundle } from "./corpus.js";
import { evalContext, makeEvalSearch } from "./harness.js";
import { makeConceptEmbedder } from "./fake-embedder.js";

/**
 * Semantic plumbing eval (DEFAULT gate; fake concept embedder, no model
 * download). Pins Path A end-to-end without model variance: an identifier-soup
 * target that is lexically INVISIBLE to four paraphrase queries (its fields and
 * parts use nonsense synonyms) must still be (a) reserved a drill slot by the
 * semantic quota, (b) rescued into results as labeled semantic evidence despite
 * zero lexical hits, and (c) reported in coverage.semantic diagnostics. The
 * real-model counterpart lives in semantic.test.ts (RECALL_EVAL_SEMANTIC=1).
 *
 * The four paraphrase queries are the plan's failing real-corpus cases.
 */
const PARAPHRASES = [
  "pseudo-terminal testing real host",
  "PTY harness inside interactive host",
  "test plugin interactively",
  "terminal add-on end to end",
] as const;

const TARGET = "t-soup";

/** UI/keyboard/extension "adjacent vocabulary" fillers — none contain a concept
 *  trigger substring, so distractors get no semantic signal. */
const FILLERS = [
  "keyboard",
  "shortcut",
  "layout",
  "theme",
  "css",
  "widget",
  "button",
  "menu",
  "scroll",
  "panel",
  "toolbar",
  "sidebar",
  "modal",
  "tooltip",
  "dropdown",
  "checkbox",
  "slider",
  "tabbar",
  "gutter",
  "badge",
  "palette",
  "cursor",
  "viewport",
  "canvas",
  "ribbon",
  "banner",
  "carousel",
  "stepper",
  "chip",
  "gauge",
];

/**
 * Corpus: one identifier-soup target (the OLDEST session, so recency never
 * surfaces it) among 30 distractors flavored with adjacent UI/keyboard
 * vocabulary. The target's card embeds (through embeddingTextOf) to all four
 * concept axes via nonsense synonyms (quaxel/floremel/plaxin/morbex), while its
 * lexical fields and parts share NO token with the paraphrase queries.
 * Distractors lexically match the queries' generic words (terminal/testing/host)
 * so the blend buries the target, but carry no concept — only the reserved
 * semantic slot can surface it.
 */
function makeSoupCorpus(now = Date.now()): EvalCorpus {
  const target = session(TARGET, "Profile audit CLI usage tracking", PROJECT_DIR, now - 500_000);
  const messagesBySession: Record<string, MessageBundle[]> = {
    [TARGET]: [
      bundle(userMessage("ts-1", TARGET, now - 500_100), [
        textPart(
          "ts-1p",
          TARGET,
          "ts-1",
          "Implement the quaxel floremel plaxin morbex module for the internal build subsystem.",
        ),
      ]),
      bundle(assistantMessage("ts-2", TARGET, now - 500_050), [
        completedToolPart(
          "ts-2p",
          TARGET,
          "ts-2",
          "bash",
          { command: "run quaxelFloremel plaxinMorbex --build internal" },
          "built ok",
          { title: "Build module" },
        ),
      ]),
    ],
  };

  const sessions = [target];
  for (let i = 0; i < FILLERS.length; i++) {
    const id = `d-${i}`;
    // Newer than the target so the recency near-miss never picks it.
    const s = session(id, `UI work ${FILLERS[i]}`, PROJECT_DIR, now - 1_000 * (i + 1));
    sessions.push(s);
    messagesBySession[id] = [
      bundle(userMessage(`${id}-1`, id, now - 1_000 * (i + 1) - 10), [
        textPart(
          `${id}-1p`,
          id,
          `${id}-1`,
          `Adjust the terminal testing host workflow for the real ${FILLERS[i]} dashboard.`,
        ),
      ]),
    ];
  }

  return { sessions, globalSessions: sessions.map(globalSessionFrom), messagesBySession };
}

const semanticConfig = () => ({ embedder: makeConceptEmbedder(), weight: 0.35 });

async function run(
  tool: ToolDefinition,
  query: string,
  extra: Record<string, unknown> = {},
): Promise<SearchOutput> {
  const raw = await tool.execute(
    {
      query,
      match: "smart",
      group: "session",
      scope: "global",
      results: 20,
      ...extra,
    } as Parameters<typeof tool.execute>[0],
    evalContext("plumbing-external"),
  );
  const parsed = JSON.parse(raw) as SearchOutput | { ok: false; error: string };
  if (!("ok" in parsed) || !parsed.ok) throw new Error(`query failed: ${JSON.stringify(parsed)}`);
  return parsed;
}

describe("semantic plumbing eval (fake concept embedder, default gate)", () => {
  let tool: ToolDefinition;
  let cleanup: () => void = () => {};

  beforeAll(async () => {
    ({ searchTool: tool, cleanup } = await makeEvalSearch(makeSoupCorpus(), semanticConfig()));
  });
  afterAll(() => cleanup());

  it("reports coverage.semantic diagnostics with vectors and a contribution", async () => {
    const out = await run(tool, PARAPHRASES[1]); // strongest concept overlap
    const semantic = out.coverage?.semantic;
    expect(semantic, "coverage.semantic should be present when semantic is on").toBeDefined();
    expect(semantic!.ready).toBe(true);
    expect(semantic!.model).toBe("eval/fake-embedder");
    expect(semantic!.weight).toBe(0.35);
    // Only the target embeds to a concept vector (distractors have none).
    expect(semantic!.cardsWithVectors).toBeGreaterThanOrEqual(1);
    // The target is lexically buried; the reserved slot is what surfaced it.
    expect(semantic!.contributed).toBeGreaterThanOrEqual(1);
  });

  it("rescues the lexically-invisible target as labeled semantic evidence on every paraphrase", async () => {
    for (const query of PARAPHRASES) {
      const out = await run(tool, query, { explain: true });
      const hit = out.results.find((r) => r.sessionID === TARGET);
      expect(hit, `[${query}] target must appear via the semantic path`).toBeDefined();
      // Rescue evidence is labeled semantic: a cosine similarity in `why`, and a
      // matchReason naming it under explain.
      expect(
        hit!.why?.semanticSimilarity,
        `[${query}] target result carries a similarity`,
      ).toBeGreaterThan(0);
      expect(
        (hit!.matchReasons ?? []).some((r) => /semantic/i.test(r)),
        `[${query}] target result is labeled semantic (matchReasons: ${JSON.stringify(hit!.matchReasons)})`,
      ).toBe(true);
    }
  });

  it("the reserved semantic slot is load-bearing: no slot, no target", async () => {
    // Same corpus, but the semantic reservation disabled: the buried target must
    // vanish, proving the reserved slot (not the blend) is what surfaces it.
    const { searchTool: noSlots, cleanup: c } = await makeEvalSearch(
      makeSoupCorpus(),
      semanticConfig(),
      { ...TEST_LIMITS, semanticSlots: 0 },
    );
    try {
      const out = await run(noSlots, PARAPHRASES[0]);
      expect(out.results.some((r) => r.sessionID === TARGET)).toBe(false);
    } finally {
      c();
    }

    // With the reservation on, the same query surfaces it.
    const withSlots = await run(tool, PARAPHRASES[0]);
    expect(withSlots.results.some((r) => r.sessionID === TARGET)).toBe(true);
  });
});
