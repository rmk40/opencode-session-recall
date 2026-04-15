import { distance } from "fastest-levenshtein";
import type { Candidate } from "./candidates.js";
import type { ParsedQuery } from "./query.js";

export type PrefilterResult = {
  candidate: Candidate;
  prefilterScore: number;
};

/** Check if a query token matches any candidate token (exact substring or typo) */
function tokenMatches(
  qt: string,
  candidateTokens: readonly string[],
): "exact" | "typo" | "none" {
  for (const ct of candidateTokens) {
    if (ct.includes(qt)) return "exact";
  }
  if (qt.length >= 4) {
    for (const ct of candidateTokens) {
      if (Math.abs(ct.length - qt.length) > 1) continue;
      if (distance(qt, ct) <= 1) return "typo";
    }
  }
  return "none";
}

/**
 * Score a candidate for degraded-mode ranking.
 * Deliberately crude — just good enough for degraded output.
 */
export function prefilterScore(
  candidate: Candidate,
  query: ParsedQuery,
): number {
  const rawLower = candidate.rawText.toLowerCase();
  let score = 0;

  // 1. Exact full-query substring in rawText
  if (rawLower.includes(query.lower)) {
    score += 100;
  }

  // 2. Quoted phrase matches
  for (const phrase of query.phrases) {
    if (rawLower.includes(phrase)) {
      score += 30;
    }
  }

  // 3-4. Token overlap and typo matches (single pass)
  let allMatched = true;
  for (const qt of query.tokens) {
    const result = tokenMatches(qt, candidate.tokens);
    if (result === "exact") {
      score += 10;
    } else if (result === "typo") {
      score += 3;
    } else {
      allMatched = false;
    }
  }

  // 5. Query coverage bonus — all tokens matched (exact or typo)
  if (query.tokens.length > 0 && allMatched) {
    score += 20;
  }

  return score;
}

/**
 * Filter candidates that have at least some lexical relevance to the query.
 * Returns candidates that pass, with prefilter scores attached.
 *
 * A candidate survives if ANY of these are true:
 * 1. Exact raw substring match of the full query in rawText
 * 2. Any quoted phrase found as substring in rawText (lowercased)
 * 3. At least one query token found as exact substring in candidate tokens
 * 4. At least one query token of length >= 4 has edit-distance <= 1 to any candidate token
 */
export function prefilter(
  candidates: Candidate[],
  query: ParsedQuery,
): PrefilterResult[] {
  const results: PrefilterResult[] = [];

  for (const candidate of candidates) {
    const score = prefilterScore(candidate, query);
    if (score > 0) {
      results.push({ candidate, prefilterScore: score });
    }
  }

  return results;
}
