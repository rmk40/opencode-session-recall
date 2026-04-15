import Fuse, { type FuseOptionKeyObject } from "fuse.js";
import type { Candidate } from "./candidates.js";
import type { ParsedQuery } from "./query.js";
import { normalize } from "./normalize.js";

/** Match modes supported by Fuse.js (excludes "literal" which bypasses Fuse) */
type FuseMode = "smart" | "fuzzy";

export type FuseHit = {
  candidate: Candidate;
  /** 0 = perfect match, 1 = worst (raw from Fuse.js) */
  fuseScore: number;
  /** Inverted: 1 = perfect match, 0 = worst (for our ranking) */
  normalizedScore: number;
};

/** Fuse.js threshold for smart mode (conservative) */
export const SMART_THRESHOLD = 0.3;

/** Fuse.js threshold for fuzzy mode (looser) */
export const FUZZY_THRESHOLD = 0.5;

const KEYS: FuseOptionKeyObject<Candidate>[] = [
  { name: "primaryText", weight: 0.65 },
  { name: "secondaryText", weight: 0.2 },
  { name: "titleText", weight: 0.1 },
  { name: "hintText", weight: 0.05 },
];

function thresholdFor(mode: FuseMode): number {
  return mode === "smart" ? SMART_THRESHOLD : FUZZY_THRESHOLD;
}

/**
 * Run Fuse.js search over pre-normalized candidates.
 * Candidates MUST have stage-2 fields populated (primaryText etc.) before calling.
 * Returns ALL matches above threshold so callers can compute accurate totals.
 */
export function fuseSearch(
  candidates: Candidate[],
  query: ParsedQuery,
  mode: FuseMode,
): FuseHit[] {
  const fuse = new Fuse(candidates, {
    includeScore: true,
    ignoreLocation: true,
    ignoreFieldNorm: true,
    shouldSort: true,
    includeMatches: false,
    threshold: thresholdFor(mode),
    keys: KEYS,
  });

  // Normalize query the same way candidate fields are normalized
  // so separators/camelCase/whitespace match consistently
  const normalizedQuery = normalize(query.raw);
  const results = fuse.search(normalizedQuery);

  return results.map((result) => {
    const fuseScore = result.score ?? 1;
    return {
      candidate: result.item,
      fuseScore,
      normalizedScore: 1 - fuseScore,
    };
  });
}
