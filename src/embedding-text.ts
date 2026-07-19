import type { Card } from "./store.js";
import { tokenizeAll } from "./normalize.js";

/**
 * Natural-language projection of a card, for embedding ONLY.
 *
 * Round-4 dogfooding proved the failure was representational: cards embed
 * identifier soup (camelCase tokens, file paths, a dispatch-instruction summary
 * head, a garbage title), so a paraphrase query never lands near them in vector
 * space. This builds the text that gets embedded — identifiers split into words
 * (`launchTerminal` → "launch terminal", `GHOSTAUTH_LIVE_TUI` → "ghostauth live
 * tui", `test/tui/pty.spec.ts` → "test tui pty spec ts"), file paths split into
 * basenames + directory + segment words, fields rendered as short labeled prose,
 * global-deduped, and capped. The LEXICAL card index is unchanged — it still
 * indexes the raw fields (exact code tokens must survive for anchor hits); only
 * the embedding INPUT changes here.
 *
 * Splitting reuses {@link tokenizeAll} (the BM25 tokenizer: splits on `_-/.`,
 * splits camelCase, lowercases) rather than a fresh regex, so the projection
 * stays consistent with how the rest of the plugin tokenizes.
 */

/** The embedder truncates its input at ~2k chars anyway; cap here too so the
 *  global dedup below stays meaningful over the whole projection. */
const REP_MAX_CHARS = 2_000;

/**
 * Representation version. The embedding INPUT (this projection) is part of what
 * a persisted card vector means, so persisted vectors must recompute when it
 * changes. {@link cardVectorStamp} folds this into the stored model stamp so a
 * bump here makes every existing vector recompute exactly once (stamp mismatch),
 * without touching the schema version or forcing a store rebuild.
 */
export const EMBED_REPRESENTATION = "rep2";

/** Stamp persisted alongside card vectors: the embedding model plus the
 *  representation version, so a change to EITHER recomputes the vectors. */
export function cardVectorStamp(model: string): string {
  return `${model}:${EMBED_REPRESENTATION}`;
}

/**
 * Build the natural-language text embedded for one card. Sections are rendered
 * as labeled prose, most-meaningful first (summary/outcome, then title, files,
 * tools, errors, inventory, project dir). Words are globally deduped across
 * sections — the first section to use a word claims it — so the projection stays
 * word-rich without repetition, then capped at {@link REP_MAX_CHARS}.
 */
export function embeddingTextOf(card: Card): string {
  const seen = new Set<string>();
  /** Split `text` into fresh (not-yet-seen) words, preserving first-seen order. */
  const fresh = (text: string): string => {
    const words: string[] = [];
    for (const token of tokenizeAll(text)) {
      if (seen.has(token)) continue;
      seen.add(token);
      words.push(token);
    }
    return words.join(" ");
  };

  const segments: string[] = [];
  const addSection = (label: string, source: string): void => {
    const words = fresh(source);
    if (words) segments.push(`${label}: ${words}`);
  };

  addSection("about", `${card.summaryHead} ${card.outcomeHead}`);
  addSection("title", card.title);
  // File paths split into basename + directory + segment words (tokenizeAll
  // splits on "/" and "."), unlike the lexical `files` field which indexes
  // basenames only — directory context is exactly the paraphrase-bridging signal.
  addSection("files", card.files.join(" "));
  addSection("tools", card.tools.join(" "));
  addSection("errors", card.errors.join(" "));
  addSection("ran", card.inventory);
  addSection("project", card.directory);

  const text = segments.join("; ");
  return text.length > REP_MAX_CHARS ? text.slice(0, REP_MAX_CHARS) : text;
}
