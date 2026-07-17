import { tokenize } from "./normalize.js";
import { compareHits, MIN_RELATIVE_SCORE, type Bm25Hit } from "./bm25.js";
import type { ParsedQuery } from "./query.js";

/**
 * Two-stage session-first query plan for smart/fuzzy searches.
 *
 * Stage A shortlists sessions whose metadata (title, directory, and — once
 * available — digest text) overlaps the query. Stage B runs BM25 twice: the
 * unchanged broad pass over the whole eligible corpus, and a deep pass over a
 * SECOND index built from only the shortlisted sessions' candidates. The
 * second build is required, not an optimization choice: MiniSearch computes
 * IDF at index-build time over the supplied documents, so filtering the broad
 * index's results cannot remove the broad corpus's term statistics — only a
 * shortlist-only index gives the deep pass its own IDF. This is what lets a
 * term that is rare inside the right neighborhood but common globally rank
 * where the caller's metadata hint says it should.
 */

export const SHORTLIST_MAX = 25;
export const SHORTLIST_MULT = 1.1;
/** Query tokens shorter than this are too common to signal a session. */
const MIN_OVERLAP_TOKEN_LENGTH = 4;

export type SessionMetaText = {
  id: string;
  title: string;
  directory: string;
  digestText?: string;
};

/** Stage A: sessions whose metadata overlaps the query, best-first, capped. */
export function metadataShortlist(sessions: SessionMetaText[], query: ParsedQuery): Set<string> {
  const queryTokens = new Set(
    query.tokens.filter((token) => token.length >= MIN_OVERLAP_TOKEN_LENGTH),
  );
  if (queryTokens.size === 0) return new Set();

  const scored: Array<{ id: string; overlap: number }> = [];
  for (const session of sessions) {
    const metaTokens = tokenize(
      `${session.title} ${session.directory} ${session.digestText ?? ""}`,
    );
    let overlap = 0;
    for (const token of metaTokens) {
      if (queryTokens.has(token)) overlap++;
    }
    if (overlap >= 1) scored.push({ id: session.id, overlap });
  }

  scored.sort((a, b) => b.overlap - a.overlap || a.id.localeCompare(b.id));
  return new Set(scored.slice(0, SHORTLIST_MAX).map((entry) => entry.id));
}

/**
 * Stage B merge: one ranked list from the broad and deep passes.
 *
 * Deep-pass scores are normalized relative to the deep pass's own top hit, so
 * they cannot be compared with broad scores directly: a shortlisted session
 * whose best match is globally weak would still carry a deep score of 1.0 and
 * rocket to the top. Each deep hit is therefore anchored to ITS OWN session's
 * broad-pass ceiling (the best broad score among that session's deep hits):
 * the deep pass re-ranks within each neighborhood using shortlist-local IDF,
 * while every neighborhood's overall strength stays what the broad corpus
 * says it is, lifted by the shortlist multiplier (applied exactly once,
 * here). A session whose broad counterparts were all dropped by the relative
 * score floor re-enters at the floor level (MIN_RELATIVE_SCORE × broad top):
 * metadata says it is the right neighborhood, so it must not vanish, but its
 * globally-weak content cannot outrank real broad hits. Deduped by partID
 * keeping the higher score.
 */
export function mergeShortlistHits(broad: Bm25Hit[], deep: Bm25Hit[], explain: boolean): Bm25Hit[] {
  if (broad.length === 0) return [...deep].sort(compareHits);

  const byPart = new Map<string, Bm25Hit>();
  for (const hit of broad) byPart.set(hit.candidate.partID, hit);

  // Per-session broad ceilings. A deep hit is not guaranteed a broad
  // counterpart: bm25Search's relative floor can drop a shortlisted session's
  // weak content from the broad list entirely.
  const ceilingBySession = new Map<string, number>();
  for (const hit of deep) {
    const counterpart = byPart.get(hit.candidate.partID);
    if (!counterpart) continue;
    const sessionID = hit.candidate.sessionID;
    const known = ceilingBySession.get(sessionID) ?? 0;
    if (counterpart.score > known) ceilingBySession.set(sessionID, counterpart.score);
  }
  const broadTop = broad[0]?.score ?? 0;
  const fallbackCeiling = broadTop * MIN_RELATIVE_SCORE;

  for (const hit of deep) {
    const ceiling = ceilingBySession.get(hit.candidate.sessionID) ?? fallbackCeiling;
    if (ceiling <= 0) continue;
    const scaled = hit.score * ceiling * SHORTLIST_MULT;
    const existing = byPart.get(hit.candidate.partID);
    if (existing && existing.score >= scaled) continue;
    byPart.set(hit.candidate.partID, {
      ...hit,
      score: scaled,
      matchReasons: explain
        ? [...hit.matchReasons, `Title-shortlist deep pass: ×${SHORTLIST_MULT}`]
        : hit.matchReasons,
    });
  }
  return [...byPart.values()].sort(compareHits);
}
