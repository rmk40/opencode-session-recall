import type { Hooks } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk/v2";
import type { SearchDeps } from "../search.js";
import { cardRecall, type CardRecallHit } from "./card-recall.js";
import { partId } from "./part-id.js";

/**
 * R1b — gated automatic recall on `chat.message`.
 *
 * On each user message, a cheap trigger check decides whether to run a bounded
 * recall. Round 4 makes this a pure CARD-TIER query (see {@link cardRecall}):
 * no drill, no `session.messages` fetch. If the gate fires and cards match, a
 * compact cited synthetic text part is appended so the model sees the lead
 * inline (verified injection shape from opencode core: session/prompt.ts uses
 * `{ type: "text", synthetic: true, text }`).
 *
 * Opt-in (default off) because it injects content into context. Everything here
 * is defensive: it never throws, and it does nothing when the gate does not fire
 * or the cards yield nothing.
 */

const MAX_AUTO_HITS = 3;
const MAX_AUTO_BLOCK_CHARS = 900;
const MAX_QUERY_CHARS = 120;
const MIN_MESSAGE_CHARS = 12;
const SUMMARY_SLICE_CHARS = 140;

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

function dirTail(directory: string): string {
  const trimmed = directory.replace(/[/\\]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * Format the cited synthetic block from card hits. Each line carries the card's
 * title, age, session id, a summary-head slice, and any matched anchors —
 * everything the card already holds, no fetch. Bounded by hit count and chars.
 */
export function formatAutoRecallBlock(hits: CardRecallHit[]): string | undefined {
  const top = hits.slice(0, MAX_AUTO_HITS);
  if (top.length === 0) return undefined;

  const lines = [
    "<recall-auto>",
    "Possibly relevant prior sessions (auto-recall; verify before relying on it):",
  ];
  for (const { card, anchors } of top) {
    const title = card.title.trim() || "(untitled session)";
    const id8 = card.sessionId.slice(0, 8);
    const dir = dirTail(card.directory);
    const summary = card.summaryHead.replace(/\s+/g, " ").trim().slice(0, SUMMARY_SLICE_CHARS);
    const anchorNote = anchors.length > 0 ? ` (anchors: ${anchors.join(", ")})` : "";
    const dirNote = dir ? ` [${dir}]` : "";
    lines.push(
      `- [${title} · ${relativeDate(card.timeUpdated)} · session ${id8}]${dirNote} ${summary}${anchorNote}`,
    );
  }
  lines.push("Use recall / recall_get for full detail.");
  lines.push("</recall-auto>");

  let block = lines.join("\n");
  if (block.length > MAX_AUTO_BLOCK_CHARS) {
    block =
      block.slice(0, MAX_AUTO_BLOCK_CHARS - "\n…\n</recall-auto>".length) + "\n…\n</recall-auto>";
  }
  return block;
}

export function autoRecall(deps: SearchDeps): NonNullable<Hooks["chat.message"]> {
  return async (input, output) => {
    try {
      const parts = (output.parts ?? []) as TextLikePart[];
      const decision = shouldAutoRecall(parts);
      if (!decision.run) return;

      // Pure card-tier query — no drill, no message fetch. The current session
      // and its family are excluded so auto-recall never cites the live turn.
      const hits = cardRecall(deps, decision.query, {
        limit: MAX_AUTO_HITS,
        filters: { excludeFamilyOf: input.sessionID },
      });
      const block = formatAutoRecallBlock(hits);
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
