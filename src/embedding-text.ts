import type { Card } from "./store.js";
import { tokenizeAll } from "./normalize.js";
import { isDigestToken } from "./digest.js";

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
 *
 * Round-6 precision fix: IDENTITY terms (words derived from the card's title and
 * directory) are de-weighted — excluded from the substantive-content count,
 * placed last, and deduped so they appear once — and a card whose substantive
 * content is below a floor gets NO vector. Otherwise a content-free "Getting
 * Started" card (whose only text is project identity) embeds to the
 * project-identity vector and becomes an attractor that rescues onto any
 * project-adjacent query.
 */

/** The embedder truncates its input at ~2k chars anyway; cap here too so the
 *  global dedup below stays meaningful over the whole projection. */
const REP_MAX_CHARS = 2_000;

/**
 * Substantive-content floor. A card earns a vector only when it has at least this
 * many DISTINCT MEANINGFUL tokens — {@link isDigestToken} (length ≥ 4, not a
 * stopword) AND not an identity term (not derived from the card's title or
 * directory) — across its substantive fields (nlSummary, summary/outcome heads,
 * files, tools, errors, and the inventory's non-identity code tokens). Below it,
 * {@link embeddingTextOf} returns null and the card gets no vector, so it can
 * never semantically rank or rescue; it stays fully lexically findable. Twelve
 * cleanly separates a content-free card (0-2 such tokens) from a session that
 * actually did work (files, tools, and inventory alone usually clear it).
 */
const SUBSTANTIVE_FLOOR = 12;

/**
 * Representation version. The embedding INPUT (this projection) is part of what
 * a persisted card vector means, so persisted vectors must recompute when it
 * changes. {@link cardVectorStamp} folds this into the stored model stamp so a
 * bump here makes every existing vector recompute exactly once (stamp mismatch),
 * without touching the schema version or forcing a store rebuild.
 *
 * rep4 (round-6): identity de-weighting + the substantive-content floor changed
 * the input (and drop vectors for content-free cards). Bumped unconditionally so
 * the one-time recompute is simple and correct.
 */
export const EMBED_REPRESENTATION = "rep4";

/** Stamp persisted alongside card vectors: the embedding model plus the
 *  representation version, so a change to EITHER recomputes the vectors. */
export function cardVectorStamp(model: string): string {
  return `${model}:${EMBED_REPRESENTATION}`;
}

/**
 * Build the natural-language text embedded for one card, or null when the card
 * lacks substantive content (see {@link SUBSTANTIVE_FLOOR}). Substantive
 * sections lead — the LLM summary, then heads, files, tools, errors, and the
 * inventory — and identity (title, project dir) trails, deduped and never
 * dominating. Words are globally deduped across sections (first section to use a
 * word claims it) and the result is capped at {@link REP_MAX_CHARS}.
 */
export function embeddingTextOf(card: Card): string | null {
  // Identity terms: words derived from the card's title and directory. They say
  // WHICH project/session, not WHAT it did, so they never count toward the floor
  // and appear once, last.
  const identity = new Set<string>();
  for (const token of tokenizeAll(`${card.title} ${card.directory}`)) identity.add(token);

  const seen = new Set<string>();
  let substantive = 0;
  /** Split `text` into fresh (not-yet-seen) words, counting the distinct
   *  meaningful non-identity ones toward the substantive floor. */
  const fresh = (text: string): string => {
    const words: string[] = [];
    for (const token of tokenizeAll(text)) {
      if (seen.has(token)) continue;
      seen.add(token);
      words.push(token);
      if (!identity.has(token) && isDigestToken(token)) substantive++;
    }
    return words.join(" ");
  };

  const segments: string[] = [];
  const addSection = (label: string, source: string): void => {
    const words = fresh(source);
    if (words) segments.push(`${label}: ${words}`);
  };

  // Substantive content LEADS. The LLM summary (Path B) is the strongest signal,
  // so it goes first. File paths split into basename + directory + segment words
  // (unlike the lexical `files` field, which indexes basenames only).
  addSection("summary", card.nlSummary);
  addSection("about", `${card.summaryHead} ${card.outcomeHead}`);
  addSection("files", card.files.join(" "));
  addSection("tools", card.tools.join(" "));
  addSection("errors", card.errors.join(" "));
  addSection("ran", card.inventory);

  // A content-free card gets no vector at all, so it cannot become a
  // project-identity attractor that rescues onto project-adjacent queries.
  if (substantive < SUBSTANTIVE_FLOOR) return null;

  // Identity trails, deduped: a substantive card still carries mild project/title
  // context, but it never leads or dominates the vector.
  addSection("title", card.title);
  addSection("project", card.directory);

  const text = segments.join("; ");
  return text.length > REP_MAX_CHARS ? text.slice(0, REP_MAX_CHARS) : text;
}
