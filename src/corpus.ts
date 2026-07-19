import type { Candidate } from "./candidates.js";
import { tokenize } from "./normalize.js";
import { toolNameMatches } from "./extract.js";
import { DIGEST_HEAD_CHARS, isDigestToken } from "./digest.js";

/**
 * Session-digest derivation and the embedder surface — the two survivors of the
 * deleted in-memory CorpusCache.
 *
 * Round 4 replaced the full-corpus cache with the persistent card store plus the
 * tier-2 drill LRU (src/drill.ts); the old CorpusCache/assembleSession machinery
 * (and its unpaginated whole-session fetch) is gone. `buildSessionDigest` still
 * builds the content-derived session identity that the drill stamps onto every
 * candidate for ranking, and `CandidateEmbedder` is the narrow embedder surface
 * the card runtime consumes.
 */

/**
 * The narrow slice of the semantic embedder the query path needs. `ready` is
 * read per use (never awaited): an unready embedder simply leaves text
 * unembedded, so searches stay lexical-only until the model warms up.
 */
export type CandidateEmbedder = {
  ready: boolean;
  embed(text: string): Float32Array | undefined;
};

// ── Session digest ────────────────────────────────────────────────────
// The first session-level text derived from CONTENT rather than naming luck
// (fixes the misleading-title finding): the first user message's head plus
// the session's characteristic action vocabulary. Built only from statement
// and action evidence (text/subtask parts, tool command/cwd inputs) so a
// session that merely READ about a topic gets no digest credit for it.

const DIGEST_TOP_TOKENS = 8;

/**
 * Deterministic content digest for a session. Rarity is approximated by
 * in-session frequency over stopworded statement/action tokens — stable per
 * session version, and it credits sessions for what they SAID and DID, never
 * for what they read.
 */
export function buildSessionDigest(candidates: Candidate[]): string {
  const counts = new Map<string, number>();
  let firstUserText: Candidate | undefined;

  for (const candidate of candidates) {
    const isStatement = candidate.partType === "text" || candidate.partType === "subtask";
    if (isStatement && candidate.role === "user") {
      // Candidates are newest-first; the last matching one is the earliest.
      firstUserText = candidate;
    }
    if (isStatement) {
      for (const token of candidate.tokens) {
        if (!isDigestToken(token)) continue;
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
      continue;
    }
    if (candidate.partType === "tool") {
      // Generated-reference tools (file reads, skill loads) earn no digest
      // credit: a session that merely read about a topic must not carry its
      // vocabulary as session identity.
      if (
        candidate.toolName &&
        (toolNameMatches(candidate.toolName, "read") ||
          toolNameMatches(candidate.toolName, "skill"))
      ) {
        continue;
      }
      for (const field of candidate.fieldTexts) {
        if (field.field !== "command" && field.field !== "cwd") continue;
        // toolInputTexts also files the whole JSON input under "command";
        // only true command/cwd strings describe an action.
        if (field.text.startsWith("{")) continue;
        for (const token of tokenize(field.text)) {
          if (!isDigestToken(token)) continue;
          counts.set(token, (counts.get(token) ?? 0) + 1);
        }
      }
    }
  }

  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, DIGEST_TOP_TOKENS)
    .map(([token]) => token);

  const head = firstUserText ? firstUserText.rawText.slice(0, DIGEST_HEAD_CHARS) : "";
  return [head, top.join(" ")].filter(Boolean).join(" ").trim();
}
