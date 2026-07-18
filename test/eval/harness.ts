/**
 * Eval harness: runs the real `recall` search tool against the eval corpus and
 * computes relevance metrics (MRR, recall@k) over labeled cases.
 *
 * This is a measurement tool, not a feature. It exists so ranking changes (e.g.
 * swapping the smart/fuzzy engine) can be proven to meet or beat a recorded
 * baseline rather than guessed at.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2";
import type { ToolContext, ToolDefinition } from "@opencode-ai/plugin";
import type { EvidenceClass, SearchOutput } from "../../src/types.js";
import { DISCOVERY_LIMIT } from "../../src/types.js";
import {
  PROJECT_DIR,
  TEST_LIMITS,
  paginateBundles,
  messagesResponse,
  strictNoLimit,
  setStrictNoLimitMessages,
  UNBOUNDED_MESSAGES_ERROR,
} from "../helpers.js";
import { openSqlite } from "../../src/sqlite.js";
import { openStore } from "../../src/store.js";
import { createFetchGate } from "../../src/fetch-gate.js";
import { createDistiller, type Distiller } from "../../src/distill.js";
import { createCardsRuntime, cardsLiteFromSessions } from "../../src/cards.js";
import { createDrill } from "../../src/drill.js";
import { search, type SearchDeps, type SemanticSearchConfig } from "../../src/search.js";
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
        // Mimic the opencode server: an omitted limit defaults to 100 rows.
        data: matchTitle(corpus.sessions, params?.search).slice(0, params?.limit ?? 100),
      }),
      get: async ({ sessionID }: { sessionID: string }) => {
        const found = corpus.globalSessions.find((s) => s.id === sessionID);
        return found ? { data: found } : { error: { data: { message: "not found" } } };
      },
      messages: async (params: { sessionID: string; limit?: number; before?: string }) => {
        const data = corpus.messagesBySession[params.sessionID];
        if (!data) return { error: { data: { message: "Unauthorized" } } };
        // Faithful keyset pagination (distiller/drill contract) when a limit is
        // sent; a no-limit caller is the incident path and fails under strict.
        if (params.limit != null) {
          const { items, nextCursor } = paginateBundles(data, params.limit, params.before);
          return messagesResponse(items, nextCursor);
        }
        if (strictNoLimit()) throw new Error(UNBOUNDED_MESSAGES_ERROR);
        return { data };
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
          data: matchTitle(corpus.globalSessions, params?.search).slice(0, params?.limit ?? 100),
        }),
      },
    },
  };

  return {
    client: client as unknown as OpencodeClient,
    unscoped: unscoped as unknown as OpencodeClient,
  };
}

/** Poll a distiller until its cold pass finishes (the eval fakes resolve
 *  synchronously, so this settles within a few event-loop turns). */
async function awaitColdPass(distiller: Distiller, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (distiller.status().coldPass !== "done") {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`cold pass did not finish: ${JSON.stringify(distiller.status())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Build the live `recall` tool over the eval corpus the way the plugin does:
 * open a temp-file card store, run the distiller cold pass over the fake corpus
 * (populating cards + the FTS slim index), then wire the tier-1 card runtime and
 * tier-2 drill behind the new deps. Returns the tool plus a cleanup that closes
 * and deletes the store.
 */
export async function makeEvalSearch(
  corpus: EvalCorpus = makeEvalCorpus(),
  semantic?: SemanticSearchConfig,
): Promise<{ searchTool: ToolDefinition; cleanup: () => void }> {
  // The whole eval path (cold pass, drill, expansion) must be bounded.
  setStrictNoLimitMessages(true);
  const { client, unscoped } = makeEvalClients(corpus);
  const dir = mkdtempSync(join(tmpdir(), "recall-eval-"));
  const db = await openSqlite(join(dir, "store.db"));
  if (!db) throw new Error("openSqlite returned null in eval harness");
  const store = openStore(db);
  if (!store) throw new Error("openStore returned null in eval harness");

  const gate = createFetchGate({ concurrency: TEST_LIMITS.concurrency });
  const distiller = createDistiller({
    client,
    store,
    gate,
    limits: TEST_LIMITS,
    instanceId: "eval-distiller",
    discover: async () => {
      const resp = await unscoped.experimental.session.list({ limit: DISCOVERY_LIMIT });
      return (resp.data ?? []) as Session[];
    },
  });
  distiller.start();
  await awaitColdPass(distiller);
  distiller.stop();

  const cards = createCardsRuntime({
    source: { getCards: () => store.allCards(), revision: () => store.getMeta("cards_rev") },
    embedder: semantic?.embedder,
    semanticWeight: semantic?.weight,
  });
  const drill = createDrill({ client, gate, limits: TEST_LIMITS, embedder: semantic?.embedder });
  const searchTool = search(client, unscoped, true, TEST_LIMITS, { gate, store, cards, drill });

  return {
    searchTool,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Build the `recall` tool over the eval corpus in VIRGIN degraded mode: no card
 * store (SQLite unavailable), only ephemeral cards-lite built from the session
 * list — exactly the plugin's `store === null` ladder rung. Discovery metadata
 * still ranks and drills, but content search is degraded and coverage says so.
 * No cleanup is needed (nothing is written to disk).
 */
export function makeDegradedEvalSearch(corpus: EvalCorpus = makeEvalCorpus()): {
  searchTool: ToolDefinition;
} {
  setStrictNoLimitMessages(true);
  const { client, unscoped } = makeEvalClients(corpus);
  const gate = createFetchGate({ concurrency: TEST_LIMITS.concurrency });
  const liteCards = cardsLiteFromSessions(corpus.globalSessions);
  const cards = createCardsRuntime({
    source: { getCards: () => liteCards, revision: () => undefined, degraded: true },
  });
  const drill = createDrill({ client, gate, limits: TEST_LIMITS });
  const deps: SearchDeps = { gate, store: null, cards, drill };
  const searchTool = search(client, unscoped, true, TEST_LIMITS, deps);
  return { searchTool };
}

/**
 * Build an eval ToolContext. The default sessionID is deliberately NOT a
 * corpus session: `recall` excludes the caller's current session by default,
 * so a corpus default would silently remove that session from every case and
 * weaken ranking cases that depend on it (e.g. old-strong vs recent-weak
 * needs e-noise as a live competitor). Cases that test the exclusion set
 * `ctxSessionID` explicitly.
 */
export function evalContext(sessionID = "e-external"): ToolContext {
  return {
    sessionID,
    messageID: "eval-msg",
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
  /** Current-session id for this case's ToolContext (default: non-corpus id). */
  ctxSessionID?: string;
  /** Extra per-case assertions beyond rank metrics. */
  expect?: {
    /** Session IDs that must NOT appear anywhere in the results. */
    notInResults?: string[];
    /** At least one of these evidence classes must appear in the top 3. */
    classInTop3?: EvidenceClass[];
    /** Per-class maximum count within the top 5 results. */
    maxClassInTop5?: Partial<Record<EvidenceClass, number>>;
  };
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
  /** Evidence class per result, in rank order (undefined until populated). */
  topClasses: (string | undefined)[];
};

export type EvalSummary = {
  mrr: number;
  recallAt5: number;
  cases: CaseResult[];
};

/** Run one case through the search tool and score it by session rank. A case
 *  with `ctxSessionID` gets its own context; otherwise the shared default. */
export async function runCase(
  searchTool: ToolDefinition,
  c: EvalCase,
  ctx?: ToolContext,
): Promise<CaseResult> {
  const caseCtx = c.ctxSessionID ? evalContext(c.ctxSessionID) : (ctx ?? evalContext());
  const raw = await searchTool.execute(c.args as Parameters<typeof searchTool.execute>[0], caseCtx);
  const parsed = JSON.parse(raw) as SearchOutput | { ok: false; error: string };

  const returnedSessionIDs: string[] = [];
  const topClasses: (string | undefined)[] = [];
  if ("ok" in parsed && parsed.ok) {
    for (const r of parsed.results) {
      returnedSessionIDs.push(r.sessionID);
      topClasses.push(r.why?.evidenceClass);
    }
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
    topClasses,
  };
}

export async function runEval(
  searchTool: ToolDefinition,
  cases: EvalCase[],
  ctx?: ToolContext,
): Promise<EvalSummary> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    results.push(await runCase(searchTool, c, ctx));
  }
  const mrr = results.reduce((sum, r) => sum + r.rr, 0) / results.length;
  const recallAt5 = results.filter((r) => r.hitAt5).length / results.length;
  return { mrr, recallAt5, cases: results };
}
