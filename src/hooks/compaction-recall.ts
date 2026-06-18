import type { Hooks, ToolContext, ToolDefinition } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { Limits, SearchOutput, SearchResult } from "../types.js";
import { search } from "../search.js";

/**
 * R1c — compaction preservation.
 *
 * Compaction is the moment durable context is destroyed. This hook runs a
 * bounded session-scoped recall for durable-signal terms right before the
 * summary is generated and pushes a compact, cited block onto the compaction
 * `context` array (verified against opencode core: session/compaction.ts spreads
 * `output.context` into the summary prompt). It never sets `output.prompt` —
 * appending preserves the default summarization behavior.
 *
 * Opt-in (default off). Best-effort: never throws.
 */

const MAX_PRESERVE_HITS = 5;
const MAX_PRESERVE_BLOCK_CHARS = 700;
/** Hard wall-clock cap on the preservation search. */
const SEARCH_TIMEOUT_MS = 1500;

/** Durable-signal query: decisions, requirements, root causes, errors. */
const DURABLE_QUERY = "decision chose because requirement error root cause fix";

/**
 * Minimum score for a hit to be preserved. BM25 scores are normalized relative
 * to the top hit in the result set, so this is a RELATIVE floor: it keeps the
 * strongest matches for the durable-signal query and drops the weaker tail. It
 * does not certify absolute durability (a session with only incidental matches
 * still yields a top hit near 1.0). Combined with the broad query this is a
 * best-effort "surface the most relevant lines for the summarizer," not a
 * guarantee that every preserved line is a real decision.
 */
const MIN_PRESERVE_SCORE = 0.4;

/** Build the compact preservation block from recall hits. */
export function formatPreservationBlock(results: SearchResult[]): string | undefined {
  const hits = results
    .filter((r) => r.score == null || r.score >= MIN_PRESERVE_SCORE)
    .slice(0, MAX_PRESERVE_HITS);
  if (hits.length === 0) return undefined;

  const lines = [
    "Durable findings from this session's history (preserve in the summary if still true):",
  ];
  for (const r of hits) {
    const snippet = (r.snippet ?? "").replace(/\s+/g, " ").trim();
    const id8 = r.messageID.slice(0, 8);
    lines.push(`- (msg ${id8}) ${snippet}`);
  }

  let block = lines.join("\n");
  if (block.length > MAX_PRESERVE_BLOCK_CHARS) {
    block = block.slice(0, MAX_PRESERVE_BLOCK_CHARS - 1) + "…";
  }
  return block;
}

async function runPreservationSearch(
  searchTool: ToolDefinition,
  sessionID: string,
): Promise<SearchResult[]> {
  const controller = new AbortController();
  const ctx = {
    sessionID,
    messageID: "compaction-recall",
    agent: "compaction-recall",
    abort: controller.signal,
    metadata: () => {},
    ask: async () => undefined,
  } as unknown as ToolContext;

  // One timer both aborts the scan and resolves the race, cleared in finally.
  // The race bounds when this function resolves; the abort stops the search's
  // work at its next checkpoint (it cannot interrupt a synchronous exec).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, SEARCH_TIMEOUT_MS);
  });
  try {
    const exec = searchTool.execute(
      {
        query: DURABLE_QUERY,
        match: "smart",
        scope: "session",
        sessionID,
        group: "part",
        results: MAX_PRESERVE_HITS,
      } as Parameters<typeof searchTool.execute>[0],
      ctx,
    );
    const raw = await Promise.race([exec, timeout]);
    if (raw === undefined) return [];
    const parsed = JSON.parse(raw) as SearchOutput | { ok: false };
    if (!("ok" in parsed) || !parsed.ok) return [];
    return parsed.results ?? [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function compactionRecall(
  client: OpencodeClient,
  unscoped: OpencodeClient,
  global: boolean,
  limits: Limits,
): NonNullable<Hooks["experimental.session.compacting"]> {
  const searchTool = search(client, unscoped, global, limits);

  return async (input, output) => {
    try {
      const results = await runPreservationSearch(searchTool, input.sessionID);
      const block = formatPreservationBlock(results);
      if (!block) return;
      if (!Array.isArray(output.context)) return;
      output.context.push(block);
    } catch {
      // Best-effort; never disrupt compaction.
    }
  };
}
