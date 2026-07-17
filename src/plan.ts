import { tokenize } from "./normalize.js";
import { compareHits, type Bm25Hit } from "./bm25.js";
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
 * rocket to the top. Instead, deep scores are anchored to the shortlist's
 * broad-pass ceiling (the best broad score among the deep hits): the deep
 * pass re-ranks WITHIN the neighborhood using shortlist-local IDF, while the
 * neighborhood's overall strength stays what the broad corpus says it is,
 * lifted by the shortlist multiplier (applied exactly once, here). Deduped by
 * partID keeping the higher score.
 */
export function mergeShortlistHits(broad: Bm25Hit[], deep: Bm25Hit[], explain: boolean): Bm25Hit[] {
  const byPart = new Map<string, Bm25Hit>();
  for (const hit of broad) byPart.set(hit.candidate.partID, hit);

  // Every deep hit has a broad counterpart (same query over a subset of the
  // same documents), so the ceiling is 0 only when the deep pass was empty.
  let ceiling = 0;
  for (const hit of deep) {
    const counterpart = byPart.get(hit.candidate.partID);
    if (counterpart && counterpart.score > ceiling) ceiling = counterpart.score;
  }
  if (ceiling > 0) {
    for (const hit of deep) {
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
  }
  return [...byPart.values()].sort(compareHits);
}
