import type { Hooks } from "@opencode-ai/plugin";
import type { SearchDeps } from "../search.js";
import type { Card } from "../store.js";

/**
 * R1c — compaction preservation.
 *
 * Compaction is the moment durable context is destroyed. Round 4 makes this a
 * pure CARD-TIER read: right before the summary is generated, the current
 * session's own card (the distiller's mechanical summary of what it was about,
 * the errors it hit, and its key identifiers/files) is pushed onto the
 * compaction `context` array so the summarizer keeps the durable signal. No
 * drill, no `session.messages` fetch — just a point lookup of one card.
 *
 * It appends to `output.context` (verified against opencode core:
 * session/compaction.ts spreads `output.context` into the summary prompt) and
 * never sets `output.prompt`, preserving the default summarization behavior.
 *
 * Opt-in (default off). Best-effort: never throws. Yields nothing when the
 * current session has no distilled card yet (degraded mode, or not-yet-distilled).
 */

const MAX_PRESERVE_BLOCK_CHARS = 700;
const FIELD_CHARS = 240;
const MAX_ERRORS = 3;
const MAX_IDENTIFIERS = 12;
const MAX_FILES = 5;

/** Build the compact preservation block from the current session's card. */
export function formatPreservationBlock(card: Card | undefined): string | undefined {
  if (!card) return undefined;

  // Prefer the LLM summary (Path B) over the mechanical summary head.
  const summary = (card.nlSummary || card.summaryHead).replace(/\s+/g, " ").trim();
  const outcome = card.outcomeHead.replace(/\s+/g, " ").trim();
  const lines: string[] = [];
  if (summary) lines.push(`- Focus: ${summary.slice(0, FIELD_CHARS)}`);
  if (outcome && outcome !== summary) lines.push(`- Latest: ${outcome.slice(0, FIELD_CHARS)}`);
  if (card.errors.length > 0) {
    lines.push(`- Errors: ${card.errors.slice(0, MAX_ERRORS).join(" | ").slice(0, FIELD_CHARS)}`);
  }
  const identifiers = card.inventory.split(/\s+/).filter(Boolean).slice(0, MAX_IDENTIFIERS);
  if (identifiers.length > 0) lines.push(`- Key identifiers: ${identifiers.join(" ")}`);
  const files = card.files.slice(0, MAX_FILES);
  if (files.length > 0) lines.push(`- Files: ${files.join(", ")}`);
  if (lines.length === 0) return undefined;

  let block = [
    "Durable context from this session (preserve in the summary if still true):",
    ...lines,
  ].join("\n");
  if (block.length > MAX_PRESERVE_BLOCK_CHARS) {
    block = block.slice(0, MAX_PRESERVE_BLOCK_CHARS - 1) + "…";
  }
  return block;
}

export function compactionRecall(
  deps: SearchDeps,
): NonNullable<Hooks["experimental.session.compacting"]> {
  return async (input, output) => {
    try {
      // Card-tier only: one point lookup, zero message fetches.
      const card = deps.store?.getCard(input.sessionID);
      const block = formatPreservationBlock(card);
      if (!block) return;
      if (!Array.isArray(output.context)) return;
      output.context.push(block);
    } catch {
      // Best-effort; never disrupt compaction.
    }
  };
}
