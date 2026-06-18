import type { Hooks, ToolContext, ToolDefinition } from "@opencode-ai/plugin";
import type { OpencodeClient, Part } from "@opencode-ai/sdk/v2";
import type { Limits, SearchOutput, SearchResult } from "../types.js";
import { search } from "../search.js";
import { partId } from "./part-id.js";

/**
 * R1b — gated automatic recall on `chat.message`.
 *
 * On each user message, a cheap trigger check decides whether to run a bounded
 * recall. If it fires and finds high-confidence hits, a compact cited synthetic
 * text part is appended to the message parts so the model sees the lead inline
 * (verified injection shape from opencode core: session/prompt.ts uses
 * `{ type: "text", synthetic: true, text }`).
 *
 * Opt-in (default off) because it adds latency on the message critical path and
 * injects content into context. Everything here is defensive: it never throws,
 * and it does nothing when the gate does not fire or the search is empty.
 */

const MAX_AUTO_HITS = 3;
const MAX_AUTO_BLOCK_CHARS = 900;
const MAX_QUERY_CHARS = 120;
const MIN_MESSAGE_CHARS = 12;
/** Hard wall-clock cap on the inline auto-recall search (critical path). */
const SEARCH_TIMEOUT_MS = 1500;
/** Bound how many sessions auto-recall will scan (history default is unbounded). */
const AUTO_SESSION_CAP = 200;

/**
 * Deictic / history cues. Word-boundary, case-insensitive. Tight on purpose so
 * auto-recall fires only when the user plausibly references prior history.
 * Bare `before`/`earlier` are deliberately excluded — they fire on ordinary
 * task phrasing ("clean up before committing", "the earlier command") that does
 * not reference prior sessions. They are only included when scoped (e.g.
 * "as before", "same as before", "earlier session").
 */
const CUE_PATTERNS: RegExp[] = [
  /\blast time\b/i,
  /\bpreviously\b/i,
  /\bremember\b/i,
  /\b(?:as|from) before\b/i,
  /\bearlier session\b/i,
  /\bsame as (?:before|last time)\b/i,
  /\bwhat did we (?:decide|do|use|choose)\b/i,
  /\bthe (?:approach|fix|bug|error|decision|issue) (?:we|you)\b/i,
  /\bin another session\b/i,
  /\bprior (?:fix|session|work|attempt)\b/i,
  /\bwe already (?:did|tried|built|fixed|used|chose|decided|solved|implemented)\b/i,
  /\blike (?:before|last time)\b/i,
  /\bdid we (?:ever|already)\b/i,
];

/** A user message part that carries text. */
type TextLikePart = { type: string; text?: string; synthetic?: boolean };

function extractUserText(parts: readonly TextLikePart[]): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string" && !p.synthetic)
    .map((p) => p.text as string)
    .join("\n")
    .trim();
}

/** A residual query is only useful if it has a real word (≥3 alphanumerics). */
function hasUsefulTerm(text: string): boolean {
  return /[\p{L}\p{N}]{3,}/u.test(text);
}

/**
 * Strip cue words and quotes to derive a compact query from the user text.
 * Returns undefined when nothing useful remains (rather than falling back to the
 * raw cue words, which would search low-signal phrasing).
 */
function deriveQuery(text: string): string | undefined {
  let q = text;
  for (const re of CUE_PATTERNS) q = q.replace(re, " ");
  q = q
    .replace(/["'`]/g, " ")
    .replace(/[^\p{L}\p{N}\s_.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!hasUsefulTerm(q)) return undefined;
  return q.slice(0, MAX_QUERY_CHARS).trim();
}

export type AutoRecallDecision = { run: false } | { run: true; query: string };

/**
 * Pure trigger gate (exported for testing). Decides whether to auto-recall and,
 * if so, the query to use.
 */
export function shouldAutoRecall(parts: readonly TextLikePart[]): AutoRecallDecision {
  const text = extractUserText(parts);
  if (text.length < MIN_MESSAGE_CHARS) return { run: false };
  // Skip slash commands and messages already asking for recall explicitly.
  if (text.startsWith("/")) return { run: false };
  if (/\brecall(?:_\w+)?\s*\(/i.test(text)) return { run: false };
  if (!CUE_PATTERNS.some((re) => re.test(text))) return { run: false };

  const query = deriveQuery(text);
  if (!query) return { run: false };
  return { run: true, query };
}

function relativeDate(time: number): string {
  if (!Number.isFinite(time) || time <= 0) return "unknown";
  const days = Math.floor((Date.now() - time) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

/** Format the cited synthetic block. Bounded by hit count and total chars. */
export function formatAutoRecallBlock(results: SearchResult[]): string | undefined {
  const hits = results.slice(0, MAX_AUTO_HITS);
  if (hits.length === 0) return undefined;

  const lines = [
    "<recall-auto>",
    "Possibly relevant prior history (auto-recall; verify before relying on it):",
  ];
  for (const r of hits) {
    const title = r.sessionTitle?.trim() || "(untitled session)";
    const id8 = r.sessionID.slice(0, 8);
    const snippet = (r.snippet ?? "").replace(/\s+/g, " ").trim();
    lines.push(`- [${title} · ${relativeDate(r.time)} · session ${id8}] ${snippet}`);
  }
  lines.push("Use recall_get / recall_context for full detail.");
  lines.push("</recall-auto>");

  let block = lines.join("\n");
  if (block.length > MAX_AUTO_BLOCK_CHARS) {
    block =
      block.slice(0, MAX_AUTO_BLOCK_CHARS - "\n…\n</recall-auto>".length) + "\n…\n</recall-auto>";
  }
  return block;
}

/**
 * Run the recall search tool with conservative auto-recall parameters and a
 * wall-clock bound. `chat.message` is awaited inline before the model runs, so
 * an unbounded search would stall every user turn.
 *
 * `Promise.race` against the timeout means the hook resolves promptly once
 * control returns to the event loop after ~SEARCH_TIMEOUT_MS — it cannot
 * preempt synchronous work that is currently blocking the loop. The aborted
 * controller stops the search's own work at the next checkpoint: between async
 * session-load batches, and between sessions during synchronous candidate
 * building (smartScan also checks the wall-clock deadline there). A single
 * in-flight synchronous BM25 exec can't be interrupted, but the candidate/char
 * budgets bound it. We also cap the session scan (history default is unbounded).
 */
async function runAutoSearch(
  searchTool: ToolDefinition,
  query: string,
  input: { sessionID: string },
): Promise<SearchResult[]> {
  const controller = new AbortController();
  const ctx = {
    sessionID: input.sessionID,
    messageID: "auto-recall",
    agent: "auto-recall",
    abort: controller.signal,
    metadata: () => {},
    ask: async () => undefined,
  } as unknown as ToolContext;

  // One timer both aborts the scan and resolves the race, cleared in finally.
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
        query,
        match: "smart",
        group: "session",
        scope: "global",
        results: MAX_AUTO_HITS,
        sessions: AUTO_SESSION_CAP,
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

export function autoRecall(
  client: OpencodeClient,
  unscoped: OpencodeClient,
  global: boolean,
  limits: Limits,
): NonNullable<Hooks["chat.message"]> {
  const searchTool = search(client, unscoped, global, limits);

  return async (input, output) => {
    try {
      const parts = (output.parts ?? []) as TextLikePart[];
      const decision = shouldAutoRecall(parts);
      if (!decision.run) return;

      const results = await runAutoSearch(searchTool, decision.query, {
        sessionID: input.sessionID,
      });
      const block = formatAutoRecallBlock(results);
      if (!block) return;

      // The hook fires after core's assign() has filled ids on the original
      // parts, so an appended part must carry its own valid id or it fails
      // Part-schema decode and corrupts id-ordered persistence.
      const synthetic: Part = {
        id: partId(),
        messageID: output.message.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: block,
      };
      output.parts.push(synthetic);
    } catch {
      // Auto-recall is best-effort; never disrupt the turn.
    }
  };
}
