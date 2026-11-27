/** Split camelCase/PascalCase at lowercase→uppercase boundaries */
export function splitCamelCase(text: string): string {
  // e.g., rateLimit → rate Limit, getHTTPResponse → getHTTP Response
  // Note: pure-uppercase runs like XMLParser are NOT split (no lowercase→uppercase boundary)
  return text.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/**
 * Text with separators (`_-/.`) turned into spaces, camelCase split and
 * lowercased: the string {@link tokenizeAll} splits at whitespace and
 * {@link normalize} collapses. A token is a whitespace-delimited run of it.
 */
export function tokenText(text: string): string {
  const separated = text.replace(/[_\-/.]/g, " ");
  const camelSplit = splitCamelCase(separated);
  return camelSplit.toLowerCase();
}

/**
 * Split text into normalized tokens, preserving duplicates and order.
 * Splits on separators (`_-/.`), splits camelCase, lowercases.
 *
 * This is the canonical tokenizer used by the BM25 index/search so term
 * frequency is preserved (a document that repeats a term is more relevant).
 */
export function tokenizeAll(text: string): string[] {
  return tokenText(text)
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Deduplicated token set. Used for set-membership checks (matched-term
 * detection, query token uniqueness) where repetition is irrelevant.
 */
export function tokenize(text: string): string[] {
  return [...new Set(tokenizeAll(text))];
}

/** Produce a fully normalized whitespace-collapsed string for indexed fields:
 *  the {@link tokenizeAll} tokens joined by single spaces. */
export function normalize(text: string): string {
  return tokenText(text).replace(/\s+/g, " ").trim();
}
