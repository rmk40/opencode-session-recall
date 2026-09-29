/**
 * Digest tokenization primitives.
 *
 * Shared by {@link buildSessionDigest} (the corpus digest, feeding tier-2
 * ranking) and the distiller's card inventory (tier-1 anchors). Both credit the
 * same statement/command vocabulary — clean word-like tokens with at least one
 * letter, stopworded, minimum length — so the two indexes agree on what counts
 * as session identity rather than drifting apart.
 */

export const DIGEST_HEAD_CHARS = 200;

/**
 * Text a history source puts in place of a message it cannot load (a row over
 * the read cap, or one whose stored data does not decode). It is still indexed
 * and shown, so the gap is visible, but it is never a session's head: its
 * wording avoids domain words so it does not pull unrelated queries, and it
 * says nothing about what the session was for.
 */
const UNAVAILABLE_PREFIX = "[unavailable: ";

export function unavailableText(reason: string): string {
  return `${UNAVAILABLE_PREFIX}${reason}]`;
}

/** Whether `text` is a placeholder from {@link unavailableText}. */
export function isUnavailableText(text: string | undefined): boolean {
  return text !== undefined && text.startsWith(UNAVAILABLE_PREFIX) && text.endsWith("]");
}

/**
 * The line opencode v2 prepends to a subagent's first prompt
 * (`core/src/tool/plugin/subagent.ts:206-211`, `core/src/config/plugin/command.ts:110`).
 * Session parentage already classifies that prompt as delegated, so the line
 * carries no session identity; v1 never writes it.
 */
export const SUBAGENT_PROMPT_PREFIX = "You are a subagent spawned by another session.\n";

/** A statement's head text with the v2 subagent prefix removed (exact match
 *  only). Used where a session's first user statement becomes its summary
 *  head: the card's `summaryHead` and the tier-2 session digest. */
export function stripSubagentPrefix(text: string): string {
  return text.startsWith(SUBAGENT_PROMPT_PREFIX) ? text.slice(SUBAGENT_PROMPT_PREFIX.length) : text;
}
export const DIGEST_MIN_TOKEN_LENGTH = 4;

/** Clean word-like tokens with at least one letter; keeps JSON shards and
 *  bare numbers (timeouts, sizes) out of the digest. */
export const DIGEST_TOKEN_RE = /^(?=.*\p{L})[\p{L}\p{N}][\p{L}\p{N}-]*$/u;

/** Common prose/dev words that carry no session identity. */
export const DIGEST_STOPWORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "have",
  "will",
  "should",
  "would",
  "could",
  "when",
  "then",
  "than",
  "them",
  "they",
  "there",
  "here",
  "what",
  "which",
  "into",
  "onto",
  "over",
  "under",
  "about",
  "please",
  "using",
  "used",
  "make",
  "made",
  "need",
  "needs",
  "want",
  "like",
  "just",
  "also",
  "only",
  "some",
  "more",
  "most",
  "very",
  "each",
  "every",
  "and",
  "the",
  "for",
  "not",
  "are",
  "was",
  "were",
  "been",
  "being",
  "does",
  "doing",
  "done",
  "error",
  "failed",
  "session",
  "message",
  "config",
  "result",
  "tool",
  "output",
  "update",
  "function",
  "const",
  "return",
  "import",
  "export",
  "test",
  "build",
  "run",
  "check",
  "value",
  "data",
  "type",
  "file",
  "files",
  "code",
]);

/**
 * Whether a token earns digest credit: long enough, not a stopword, and clean
 * word-like (at least one letter, no JSON punctuation). This is the exact gate
 * {@link buildSessionDigest} applied inline before it moved here.
 */
export function isDigestToken(token: string): boolean {
  return (
    token.length >= DIGEST_MIN_TOKEN_LENGTH &&
    !DIGEST_STOPWORDS.has(token) &&
    DIGEST_TOKEN_RE.test(token)
  );
}
