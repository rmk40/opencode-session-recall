import { describe, expect, it } from "vitest";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { search } from "../../src/search.js";
import { CorpusCache } from "../../src/corpus.js";
import { SemanticEmbedder } from "../../src/semantic/embedder.js";
import { cosineSimilarity } from "../../src/semantic/similarity.js";
import type { SearchOutput } from "../../src/types.js";
import {
  PROJECT_DIR,
  TEST_LIMITS,
  bundle,
  globalSessionFrom,
  session,
  textPart,
  userMessage,
} from "../helpers.js";
import { evalContext } from "./harness.js";

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

function makeClients(): { client: OpencodeClient; unscoped: OpencodeClient } {
  const work = session("sem-work", "Terminal spike notes", PROJECT_DIR, 2_000);
  const distractor = session("sem-distractor", "DB migration incident", PROJECT_DIR, 1_000);
  const messagesBySession: Record<string, ReturnType<typeof bundle>[]> = {
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
  };
  const globals = [work, distractor].map(globalSessionFrom);

  const client = {
    session: {
      list: async () => ({ data: [work, distractor] }),
      get: async ({ sessionID }: { sessionID: string }) => {
        const found = globals.find((s) => s.id === sessionID);
        return found ? { data: found } : { error: { data: { message: "not found" } } };
      },
      messages: async ({ sessionID }: { sessionID: string }) => {
        const data = messagesBySession[sessionID];
        return data ? { data } : { error: { data: { message: "not found" } } };
      },
      message: async () => ({ error: { data: { message: "not found" } } }),
    },
  };
  const unscoped = {
    experimental: { session: { list: async () => ({ data: globals }) } },
  };
  return {
    client: client as unknown as OpencodeClient,
    unscoped: unscoped as unknown as OpencodeClient,
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

      const { client, unscoped } = makeClients();
      const cache = new CorpusCache(client, TEST_LIMITS, embedder);
      const tool = search(client, unscoped, true, TEST_LIMITS, cache, {
        embedder,
        weight: 0.35,
      });

      const raw = await tool.execute(
        { query: QUERY, match: "smart", group: "session", scope: "global" } as Parameters<
          typeof tool.execute
        >[0],
        evalContext("sem-external"),
      );
      const out = JSON.parse(raw) as SearchOutput;
      const top3 = out.results.slice(0, 3).map((r) => r.sessionID);
      expect(top3, `results: ${JSON.stringify(out.results.map((r) => r.sessionID))}`).toContain(
        "sem-work",
      );
    }, 120_000);
  },
);
