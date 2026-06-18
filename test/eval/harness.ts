/**
 * Eval harness: runs the real `recall` search tool against the eval corpus and
 * computes relevance metrics (MRR, recall@k) over labeled cases.
 *
 * This is a measurement tool, not a feature. It exists so ranking changes (e.g.
 * swapping the smart/fuzzy engine) can be proven to meet or beat a recorded
 * baseline rather than guessed at.
 */
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { ToolContext, ToolDefinition } from "@opencode-ai/plugin";
import type { SearchOutput } from "../../src/types.js";
import { PROJECT_DIR } from "../helpers.js";
import { makeEvalCorpus, type EvalCorpus } from "./corpus.js";

type ListParams = { search?: string; limit?: number };

/** Build fake scoped + unscoped clients backed by the eval corpus. */
export function makeEvalClients(corpus: EvalCorpus = makeEvalCorpus()): {
  client: OpencodeClient;
  unscoped: OpencodeClient;
} {
  const matchTitle = <T extends { title: string }>(items: T[], search?: string): T[] =>
    search ? items.filter((s) => s.title.toLowerCase().includes(search.toLowerCase())) : items;

  const client = {
    session: {
      list: async (params?: ListParams) => ({
        data: matchTitle(corpus.sessions, params?.search).slice(0, params?.limit),
      }),
      get: async ({ sessionID }: { sessionID: string }) => {
        const found = corpus.globalSessions.find((s) => s.id === sessionID);
        return found ? { data: found } : { error: { data: { message: "not found" } } };
      },
      messages: async ({ sessionID }: { sessionID: string }) => {
        const data = corpus.messagesBySession[sessionID];
        return data ? { data } : { error: { data: { message: "Unauthorized" } } };
      },
      message: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
        const found = corpus.messagesBySession[sessionID]?.find((m) => m.info.id === messageID);
        return found ? { data: found } : { error: { data: { message: "not found" } } };
      },
    },
  };

  const unscoped = {
    experimental: {
      session: {
        list: async (params?: ListParams) => ({
          data: matchTitle(corpus.globalSessions, params?.search).slice(0, params?.limit),
        }),
      },
    },
  };

  return {
    client: client as unknown as OpencodeClient,
    unscoped: unscoped as unknown as OpencodeClient,
  };
}

export function evalContext(): ToolContext {
  return {
    sessionID: "e-noise",
    messageID: "en-2",
    agent: "build",
    directory: PROJECT_DIR,
    worktree: PROJECT_DIR,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => undefined,
  } as unknown as ToolContext;
}

export type EvalCase = {
  name: string;
  /** recall tool args */
  args: Record<string, unknown>;
  /** Session ID(s) considered relevant, in no particular order. */
  relevantSessionIDs: string[];
};

export type CaseResult = {
  name: string;
  /** 1-based rank of the first relevant session hit, or 0 if none in results. */
  firstRelevantRank: number;
  /** reciprocal rank (1/rank or 0). */
  rr: number;
  /** whether any relevant session appeared in the top 5. */
  hitAt5: boolean;
  returnedSessionIDs: string[];
};

export type EvalSummary = {
  mrr: number;
  recallAt5: number;
  cases: CaseResult[];
};

/** Run one case through the search tool and score it by session rank. */
export async function runCase(
  searchTool: ToolDefinition,
  c: EvalCase,
  ctx: ToolContext,
): Promise<CaseResult> {
  const raw = await searchTool.execute(c.args as Parameters<typeof searchTool.execute>[0], ctx);
  const parsed = JSON.parse(raw) as SearchOutput | { ok: false; error: string };

  const returnedSessionIDs: string[] = [];
  if ("ok" in parsed && parsed.ok) {
    for (const r of parsed.results) returnedSessionIDs.push(r.sessionID);
  }

  const relevant = new Set(c.relevantSessionIDs);
  let firstRelevantRank = 0;
  for (let i = 0; i < returnedSessionIDs.length; i++) {
    if (relevant.has(returnedSessionIDs[i]!)) {
      firstRelevantRank = i + 1;
      break;
    }
  }

  const hitAt5 = returnedSessionIDs.slice(0, 5).some((id) => relevant.has(id));

  return {
    name: c.name,
    firstRelevantRank,
    rr: firstRelevantRank > 0 ? 1 / firstRelevantRank : 0,
    hitAt5,
    returnedSessionIDs,
  };
}

export async function runEval(
  searchTool: ToolDefinition,
  cases: EvalCase[],
  ctx: ToolContext,
): Promise<EvalSummary> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    results.push(await runCase(searchTool, c, ctx));
  }
  const mrr = results.reduce((sum, r) => sum + r.rr, 0) / results.length;
  const recallAt5 = results.filter((r) => r.hitAt5).length / results.length;
  return { mrr, recallAt5, cases: results };
}
