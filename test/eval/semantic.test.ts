import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@opencode-ai/plugin";
import { SemanticEmbedder } from "../../src/semantic/embedder.js";
import { cosineSimilarity } from "../../src/semantic/similarity.js";
import type { SearchOutput } from "../../src/types.js";
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

/**
 * Real-model semantic eval, gated behind RECALL_EVAL_SEMANTIC=1 because it
 * downloads potion-base-8M (~30MB) on first run — unfit for the default
 * `npm run check`. It proves the loader works end-to-end against the real
 * artifacts: a workflow session that shares NO content words with the query
 * ("drive", "console", "app", "keyboard" appear nowhere in it) must still be
 * retrieved above a lexically-and-semantically unrelated distractor.
 */

const QUERY = "how did we drive the console app by keyboard before";
// Describes driving a console app by keyboard using entirely different words.
const WORKFLOW_TEXT =
  "We operated the terminal interface through key presses, steering the CLI utility with arrow buttons rather than a mouse pointer.";
const DISTRACTOR_TEXT =
  "Postgres migration rollback failed with a foreign-key constraint violation on the orders table during deploy.";

function makeCorpus(): EvalCorpus {
  const work = session("sem-work", "Terminal spike notes", PROJECT_DIR, 2_000);
  const distractor = session("sem-distractor", "DB migration incident", PROJECT_DIR, 1_000);
  return {
    sessions: [work, distractor],
    globalSessions: [work, distractor].map(globalSessionFrom),
    messagesBySession: {
      "sem-work": [
        bundle(userMessage("mw", "sem-work", 1_500), [
          textPart("pw", "sem-work", "mw", WORKFLOW_TEXT),
        ]),
      ],
      "sem-distractor": [
        bundle(userMessage("md", "sem-distractor", 1_400), [
          textPart("pd", "sem-distractor", "md", DISTRACTOR_TEXT),
        ]),
      ],
    },
  };
}

describe.skipIf(!process.env.RECALL_EVAL_SEMANTIC)(
  "semantic eval (real potion-base-8M; set RECALL_EVAL_SEMANTIC=1)",
  () => {
    it("ranks the vocabulary-gap workflow session in the top 3", async () => {
      const embedder = new SemanticEmbedder("minishlab/potion-base-8M");
      await embedder.init();
      expect(embedder.ready, `embedder init failed: ${embedder.initError}`).toBe(true);

      const queryVec = embedder.embed(QUERY)!;
      const workVec = embedder.embed(WORKFLOW_TEXT)!;
      const distractorVec = embedder.embed(DISTRACTOR_TEXT)!;
      const cosWork = cosineSimilarity(queryVec, workVec);
      const cosDistractor = cosineSimilarity(queryVec, distractorVec);
      console.log(
        `cosine(query, workflow)=${cosWork.toFixed(4)} cosine(query, distractor)=${cosDistractor.toFixed(4)}`,
      );
      expect(cosWork).toBeGreaterThan(cosDistractor);

      const { searchTool, cleanup } = await makeEvalSearch(makeCorpus(), {
        embedder,
        weight: 0.35,
      });
      try {
        const raw = await searchTool.execute(
          { query: QUERY, match: "smart", group: "session", scope: "global" } as Parameters<
            typeof searchTool.execute
          >[0],
          evalContext("sem-external"),
        );
        const out = JSON.parse(raw) as SearchOutput;
        const top3 = out.results.slice(0, 3).map((r) => r.sessionID);
        expect(top3, `results: ${JSON.stringify(out.results.map((r) => r.sessionID))}`).toContain(
          "sem-work",
        );
      } finally {
        cleanup();
      }
    }, 120_000);
  },
);

// ── Vocabulary-gap target + four paraphrase queries (the plan's real failure) ──
// The default-gate counterpart (fake embedder) is semantic-plumbing.test.ts. This
// measures the REAL model against a GENUINE vocabulary gap: the target's card is
// identifier soup that uses SYNONYMS of the query concepts (console/tty/headless/
// extension/verify — NOT terminal/pty/harness/plugin/test), so it is lexically
// (near-)invisible to the paraphrases, while ~15 distractors DO mention the query
// words in unrelated contexts and compete both lexically and semantically. The
// `lexical` vs `semantic` ranks logged below are the honest measurement of how
// far Path A's representation fix carries — and how much Path B must add.

const PARAPHRASES = [
  "pseudo-terminal testing real host",
  "PTY harness inside interactive host",
  "test plugin interactively",
  "terminal add-on end to end",
] as const;

const SOUP_TARGET = "soup-real";

/** Distractors that mention the QUERY words in unrelated contexts — they should
 *  compete lexically (and semantically) with the target, reproducing the "many
 *  adjacent sessions" burial from the real failure. */
const QUERY_WORD_DISTRACTORS = [
  "Reviewed the terminal color scheme and prompt theme in the editor settings.",
  "Wrote unit tests for the currency parser and fixed a rounding bug.",
  "Updated the host config file and DNS records for the staging server.",
  "Installed an editor plugin for markdown preview and tweaked its options.",
  "Wrote an interactive tutorial page with step-by-step onboarding.",
  "Measured test coverage and added assertions to the checkout suite.",
  "Browsed the plugin marketplace and compared two linting extensions.",
  "Debugged a flaky integration test in the payments host service.",
  "Configured the terminal font and ligatures for the code editor.",
  "Added a plugin hook for the build pipeline and documented it.",
  "Ran the test runner in watch mode and triaged the failures.",
  "Set up an interactive REPL for the data host and logged sessions.",
  "Refactored the terminal output formatter for the log viewer.",
  "Wrote end-to-end tests for the signup plugin and its callbacks.",
  "Tuned the host connection pool and retried the flaky test cases.",
];

/** UI/keyboard filler — adjacent vocabulary far from the paraphrases. */
const UI_FILLERS = [
  "keyboard shortcuts",
  "css layout",
  "button styling",
  "scroll panel",
  "sidebar menu",
  "modal dialog",
  "tooltip hover",
  "dropdown select",
  "checkbox group",
  "slider control",
  "status badge",
  "color palette",
  "viewport resize",
  "canvas render",
  "toast notification",
];

function makeSoupCorpus(now = Date.now()): EvalCorpus {
  // Garbage title + dispatch-instruction first message; the real signal is the
  // synonym identifier soup in the tool inputs and file paths — NONE of which
  // tokenize-match the paraphrase queries.
  const target = session(
    SOUP_TARGET,
    "Profile audit CLI usage tracking",
    PROJECT_DIR,
    now - 900_000,
  );
  const messagesBySession: Record<string, MessageBundle[]> = {
    [SOUP_TARGET]: [
      bundle(userMessage("sr-1", SOUP_TARGET, now - 900_100), [
        textPart(
          "sr-1p",
          SOUP_TARGET,
          "sr-1",
          "Delegated to a subagent to complete the assigned task per the parent dispatch plan.",
        ),
      ]),
      bundle(assistantMessage("sr-2", SOUP_TARGET, now - 900_050), [
        completedToolPart(
          "sr-2p",
          SOUP_TARGET,
          "sr-2",
          "bash",
          {
            command:
              "node scripts/spawnConsoleShell.js --tty-bridge --headless-driver --live-server",
          },
          "spawned",
          { title: "spawn" },
        ),
      ]),
      bundle(assistantMessage("sr-3", SOUP_TARGET, now - 900_040), [
        completedToolPart(
          "sr-3p",
          SOUP_TARGET,
          "sr-3",
          "bash",
          {
            command: "node scaffold/e2eSuite.js --extension-smoke --verify-flow driveHeadless",
          },
          "ok",
          { title: "run suite" },
        ),
      ]),
      bundle(assistantMessage("sr-4", SOUP_TARGET, now - 900_030), [
        completedToolPart(
          "sr-4p",
          SOUP_TARGET,
          "sr-4",
          "read",
          { filePath: "e2e/headless-console/bridge-bootstrap.spec.ts" },
          "spec contents",
          { title: "read spec" },
        ),
      ]),
      bundle(assistantMessage("sr-5", SOUP_TARGET, now - 900_020), [
        completedToolPart(
          "sr-5p",
          SOUP_TARGET,
          "sr-5",
          "read",
          { filePath: "src/console/extension-adapter.ts" },
          "adapter contents",
          { title: "read adapter" },
        ),
      ]),
    ],
  };

  const sessions = [target];
  // Query-word distractors first (the lexical competitors), then UI filler.
  for (let i = 0; i < QUERY_WORD_DISTRACTORS.length; i++) {
    const id = `qd-${i}`;
    const s = session(id, `Task ${i}`, PROJECT_DIR, now - 1_000 * (i + 1));
    sessions.push(s);
    messagesBySession[id] = [
      bundle(userMessage(`${id}-1`, id, now - 1_000 * (i + 1) - 10), [
        textPart(`${id}-1p`, id, `${id}-1`, QUERY_WORD_DISTRACTORS[i]!),
      ]),
    ];
  }
  for (let i = 0; i < UI_FILLERS.length; i++) {
    const id = `sd-${i}`;
    const s = session(id, `UI ${UI_FILLERS[i]}`, PROJECT_DIR, now - 500_000 - 1_000 * (i + 1));
    sessions.push(s);
    messagesBySession[id] = [
      bundle(userMessage(`${id}-1`, id, now - 500_000 - 1_000 * (i + 1) - 10), [
        textPart(
          `${id}-1p`,
          id,
          `${id}-1`,
          `Polish the frontend ${UI_FILLERS[i]} for the settings dashboard and fix the spacing.`,
        ),
      ]),
    ];
  }
  return { sessions, globalSessions: sessions.map(globalSessionFrom), messagesBySession };
}

describe.skipIf(!process.env.RECALL_EVAL_SEMANTIC)(
  "semantic eval: vocabulary-gap target, four paraphrase queries (real model)",
  () => {
    it("measures how far Path A's representation carries (lexical vs semantic ranks)", async () => {
      const embedder = new SemanticEmbedder("minishlab/potion-base-8M");
      await embedder.init();
      expect(embedder.ready, `embedder init failed: ${embedder.initError}`).toBe(true);

      const rankOf = async (tool: ToolDefinition, query: string): Promise<SearchOutput> => {
        const raw = await tool.execute(
          {
            query,
            match: "smart",
            group: "session",
            scope: "global",
            results: 20,
            explain: true,
          } as Parameters<typeof tool.execute>[0],
          evalContext("soup-external"),
        );
        return JSON.parse(raw) as SearchOutput;
      };

      // Lexical-only baseline (no embedder) vs. the production default weight
      // (0.35) — measuring the honest opt-in behavior, and how much of the rank
      // is semantic vs. the identifiers' incidental lexical overlap. Same corpus.
      const lexical = await makeEvalSearch(makeSoupCorpus());
      const semantic = await makeEvalSearch(makeSoupCorpus(), { embedder, weight: 0.35 });

      try {
        const lines: string[] = [];
        let improvedOverLexical = 0;
        let regressed = 0;
        let semanticFound = 0;
        for (const query of PARAPHRASES) {
          const lexOut = await rankOf(lexical.searchTool, query);
          const semOut = await rankOf(semantic.searchTool, query);
          const lexRank = lexOut.results.findIndex((r) => r.sessionID === SOUP_TARGET) + 1;
          const semRank = semOut.results.findIndex((r) => r.sessionID === SOUP_TARGET) + 1;
          const sim = semOut.results.find((r) => r.sessionID === SOUP_TARGET)?.why
            ?.semanticSimilarity;
          lines.push(
            `  "${query}": lexical=${lexRank || "MISS"} semantic=${semRank || "MISS"} sim=${sim?.toFixed(3) ?? "-"} cardsWithVectors=${semOut.coverage?.semantic?.cardsWithVectors ?? "-"}`,
          );
          if (semRank > 0) semanticFound++;
          const lexFound = lexRank > 0;
          const semBetter = semRank > 0 && (!lexFound || semRank < lexRank);
          if (semBetter) improvedOverLexical++;
          if (lexFound && semRank === 0) regressed++;
        }
        // This is a MEASUREMENT, not a claim that potion-base-8M bridges every
        // paraphrase — it does not (see the logged ranks; ~half the genuine-gap
        // paraphrases miss with this small static model, which is the evidence
        // that Path B's LLM summaries are needed for the rest). The honest,
        // reproducible floor Path A must hold: the semantic path is load-bearing
        // (it surfaces the lexically-invisible target on at least one paraphrase
        // lexical alone misses) and never regresses one lexical already found.
        console.log(
          `\n[semantic soup eval] real-model ranks (lexical vs semantic, potion-base-8M @ weight 0.35):\n${lines.join("\n")}\n  → semantic found ${semanticFound}/4, improved ${improvedOverLexical}/4, regressed ${regressed}/4\n`,
        );
        expect(regressed, `semantic regressed a lexical hit:\n${lines.join("\n")}`).toBe(0);
        expect(
          improvedOverLexical,
          `semantic never improved over lexical (Path A not load-bearing here):\n${lines.join("\n")}`,
        ).toBeGreaterThanOrEqual(1);
      } finally {
        lexical.cleanup();
        semantic.cleanup();
      }
    }, 120_000);
  },
);
