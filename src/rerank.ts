import { compareHits, MIN_RELATIVE_SCORE, type Bm25Hit } from "./bm25.js";

/**
 * Two-stage DRILLED rerank.
 *
 * NOT the deleted round-3 corpus-wide windowing. This runs entirely within the
 * tier-2 drilled candidate pool: a BROAD pass scores every drilled candidate,
 * and a DEEP pass re-scores only the card-supported neighborhood (the sessions
 * tier-1's cards.rank shortlisted) with a fresh, shortlist-local IDF. MiniSearch
 * computes IDF at index-build time, so the deep pass needs its own index over
 * just the neighborhood to let a term that is rare in the right neighborhood but
 * common across the drilled set rank where the card shortlist says it should.
 *
 * The degenerate case where the deep pool equals the broad pool (every drilled
 * session is card-supported) is fine and deterministic: the merge below lifts
 * every hit uniformly by {@link SHORTLIST_MULT}, which does not change ordering.
 */

export const SHORTLIST_MULT = 1.1;

/**
 * Merge the broad and deep drilled passes into one ranked list.
 *
 * Deep-pass scores are normalized relative to the deep pass's own top hit, so
 * they cannot be compared with broad scores directly: a neighborhood whose best
 * match is globally weak would still carry a deep score of 1.0 and rocket to the
 * top. Each deep hit is therefore anchored to ITS OWN session's broad-pass
 * ceiling (the best broad score among that session's deep hits): the deep pass
 * re-ranks within each neighborhood using shortlist-local IDF, while every
 * neighborhood's overall strength stays what the broad pool says it is, lifted
 * by the shortlist multiplier (applied exactly once, here). A session whose
 * broad counterparts were all dropped by the relative score floor re-enters at
 * the floor level (MIN_RELATIVE_SCORE × broad top): the card shortlist says it
 * is the right neighborhood, so it must not vanish, but its globally-weak
 * content cannot outrank real broad hits. Deduped by partID keeping the higher
 * score.
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
  // Deep scores are unclamped (base × structural multipliers), so anchoring on
  // them directly would compound the multiplier stack with SHORTLIST_MULT.
  // Normalize each deep hit to ITS OWN SESSION's deep top: the anchor is the
  // hit's relative rank within its neighborhood, and every neighborhood's best
  // lands at exactly its own ceiling × SHORTLIST_MULT.
  const deepTopBySession = new Map<string, number>();
  for (const hit of deep) {
    const sessionID = hit.candidate.sessionID;
    const known = deepTopBySession.get(sessionID) ?? 0;
    if (hit.score > known) deepTopBySession.set(sessionID, hit.score);
  }

  for (const hit of deep) {
    const ceiling = ceilingBySession.get(hit.candidate.sessionID) ?? fallbackCeiling;
    if (ceiling <= 0) continue;
    const deepTop = deepTopBySession.get(hit.candidate.sessionID) ?? 0;
    if (deepTop <= 0) continue;
    const scaled = (hit.score / deepTop) * ceiling * SHORTLIST_MULT;
    const existing = byPart.get(hit.candidate.partID);
    if (existing && existing.score >= scaled) continue;
    byPart.set(hit.candidate.partID, {
      ...hit,
      score: scaled,
      matchReasons: explain
        ? [...hit.matchReasons, `Drilled deep pass: ×${SHORTLIST_MULT}`]
        : hit.matchReasons,
    });
  }
  return [...byPart.values()].sort(compareHits);
}
