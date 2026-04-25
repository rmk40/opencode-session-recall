import { distance } from "fastest-levenshtein";
import type { FuseHit } from "./fuse.js";
import type { Candidate } from "./candidates.js";
import type { ParsedQuery } from "./query.js";
import { tokenize } from "./normalize.js";
import type { ResultWhy } from "./types.js";

// ── Tuning constants ────────────────────────────────────────────────

/** Boost when a quoted phrase appears verbatim in rawText */
const EXACT_PHRASE_BOOST = 0.15;

/** Boost when every query token appears in candidate tokens */
const ALL_TOKENS_BOOST = 0.1;

/** Boost when candidate is a reasoning part */
const REASONING_BOOST = 0.05;

/** Boost when candidate is a tool part containing error-like text */
const ERROR_TEXT_BOOST = 0.05;

/** Boost for user-authored messages */
const USER_ROLE_BOOST = 0.03;

/** Maximum recency boost for very recent messages */
const RECENCY_BOOST_MAX = 0.05;

/** Window over which recency decays (1 week in ms) */
const RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Penalty for a single fuzzy-matched token with weak score */
const WEAK_FUZZY_PENALTY = -0.1;

/** Threshold below which a single-token match is considered weak fuzzy */
const WEAK_FUZZY_THRESHOLD = 0.7;

/** Penalty when fewer than half the query tokens appear in candidate */
const POOR_COVERAGE_PENALTY = -0.08;

/** Approximate max prefilter score used to normalize degraded mode */
const MAX_PREFILTER_SCORE = 150;

// ── Error pattern matching ──────────────────────────────────────────

const ERROR_PATTERNS = ["error", "failed", "exception"];

function containsErrorPattern(text: string): boolean {
  const lower = text.toLowerCase();
  return ERROR_PATTERNS.some((p) => lower.includes(p));
}

// ── Shared helpers ──────────────────────────────────────────────────

export type RankedResult = {
  candidate: Candidate;
  score: number;
  matchedTerms: string[];
  matchedFields: ResultWhy["matchedFields"];
  matchReasons: string[];
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function recencyBoost(time: number): number {
  const ageMs = Date.now() - time;
  const factor = Math.max(0, 1 - ageMs / RECENCY_WINDOW_MS);
  return factor * RECENCY_BOOST_MAX;
}

function findMatchedTerms(
  queryTokens: readonly string[],
  candidateTokens: readonly string[],
): string[] {
  const matched: string[] = [];
  for (const qt of queryTokens) {
    // Substring match (consistent with prefilter exact gate)
    const exactFound = candidateTokens.some((ct) => ct.includes(qt));
    if (exactFound) {
      matched.push(qt);
      continue;
    }
    // Typo match (consistent with prefilter typo gate: edit-distance ≤ 1 for tokens ≥ 4 chars)
    if (qt.length >= 4) {
      const typoFound = candidateTokens.some(
        (ct) => Math.abs(ct.length - qt.length) <= 1 && distance(qt, ct) <= 1,
      );
      if (typoFound) {
        matched.push(qt);
      }
    }
  }
  return matched;
}

function findMatchedFields(query: ParsedQuery, candidate: Candidate): ResultWhy["matchedFields"] {
  const fields = new Set<ResultWhy["matchedFields"][number]>();
  for (const field of candidate.fieldTexts) {
    const lower = field.text.toLowerCase();
    const phraseMatched = query.phrases.some((phrase) => lower.includes(phrase));
    const termsMatched = findMatchedTerms(query.tokens, tokenize(field.text)).length > 0;
    if (phraseMatched || termsMatched) fields.add(field.field);
  }
  return [...fields];
}

function sortResults(results: RankedResult[]): RankedResult[] {
  return results.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    return b.candidate.time - a.candidate.time;
  });
}

// ── rank ─────────────────────────────────────────────────────────────

/**
 * Apply structural boosts/penalties and produce final ranked results.
 * Results are sorted by score descending, then by time descending for ties.
 */
export function rank(hits: FuseHit[], query: ParsedQuery, explain: boolean): RankedResult[] {
  const results: RankedResult[] = [];

  for (const hit of hits) {
    const { candidate, normalizedScore } = hit;
    let score = normalizedScore;
    const reasons: string[] = [];

    if (explain) {
      reasons.push(`Fuse.js base score: ${normalizedScore.toFixed(2)}`);
    }

    // ── Exact phrase match ──────────────────────────────────────────
    const rawLower = candidate.rawText.toLowerCase();
    let hasExactPhrase = false;
    for (const phrase of query.phrases) {
      if (rawLower.includes(phrase)) {
        hasExactPhrase = true;
        break;
      }
    }
    if (hasExactPhrase) {
      score += EXACT_PHRASE_BOOST;
      if (explain) {
        reasons.push(`Exact phrase match: +${EXACT_PHRASE_BOOST.toFixed(2)}`);
      }
    }

    // ── All tokens matched ──────────────────────────────────────────
    const matchedTerms = findMatchedTerms(query.tokens, candidate.tokens);
    const matchedFields = findMatchedFields(query, candidate);
    const allTokensMatched = query.tokens.length > 0 && matchedTerms.length === query.tokens.length;

    if (allTokensMatched) {
      score += ALL_TOKENS_BOOST;
      if (explain) {
        reasons.push(`All query tokens matched: +${ALL_TOKENS_BOOST.toFixed(2)}`);
      }
    }

    // ── Reasoning / error text boost ────────────────────────────────
    if (candidate.partType === "reasoning") {
      score += REASONING_BOOST;
      if (explain) {
        reasons.push(`Reasoning part boost: +${REASONING_BOOST.toFixed(2)}`);
      }
    }

    if (candidate.partType === "tool" && containsErrorPattern(candidate.rawText)) {
      score += ERROR_TEXT_BOOST;
      if (explain) {
        reasons.push(`Error text boost: +${ERROR_TEXT_BOOST.toFixed(2)}`);
      }
    }

    // ── User role boost ─────────────────────────────────────────────
    if (candidate.role === "user") {
      score += USER_ROLE_BOOST;
      if (explain) {
        reasons.push(`User text boost: +${USER_ROLE_BOOST.toFixed(2)}`);
      }
    }

    // ── Recency boost ───────────────────────────────────────────────
    const recency = recencyBoost(candidate.time);
    if (recency > 0) {
      score += recency;
      if (explain) {
        reasons.push(`Recency boost: +${recency.toFixed(2)}`);
      }
    }

    // ── Weak single-token fuzzy penalty ─────────────────────────────
    if (
      matchedTerms.length === 1 &&
      query.tokens.length === 1 &&
      normalizedScore < WEAK_FUZZY_THRESHOLD
    ) {
      score += WEAK_FUZZY_PENALTY;
      if (explain) {
        reasons.push(`Weak single-token fuzzy: ${WEAK_FUZZY_PENALTY.toFixed(2)}`);
      }
    }

    // ── Poor query coverage penalty ─────────────────────────────────
    if (query.tokens.length > 1 && matchedTerms.length < query.tokens.length / 2) {
      score += POOR_COVERAGE_PENALTY;
      if (explain) {
        reasons.push(`Poor query coverage: ${POOR_COVERAGE_PENALTY.toFixed(2)}`);
      }
    }

    // ── Clamp and collect ───────────────────────────────────────────
    score = clamp01(score);

    results.push({
      candidate,
      score,
      matchedTerms,
      matchedFields,
      matchReasons: explain ? reasons : [],
    });
  }

  return sortResults(results);
}

// ── rankDegraded ─────────────────────────────────────────────────────

/**
 * Rank prefilter-scored candidates for degraded mode (no Fuse.js).
 * Used when time budget is exceeded.
 */
export function rankDegraded(
  candidates: Array<{ candidate: Candidate; prefilterScore: number }>,
  query: ParsedQuery,
  explain: boolean,
): RankedResult[] {
  const results: RankedResult[] = [];

  for (const entry of candidates) {
    const { candidate, prefilterScore } = entry;
    const reasons: string[] = [];

    // Normalize prefilter score to 0-1
    let score = Math.min(1, prefilterScore / MAX_PREFILTER_SCORE);

    if (explain) {
      reasons.push(`Degraded mode: prefilter score ${prefilterScore} → ${score.toFixed(2)}`);
    }

    // Recency boost
    const recency = recencyBoost(candidate.time);
    if (recency > 0) {
      score += recency;
      if (explain) {
        reasons.push(`Recency boost: +${recency.toFixed(2)}`);
      }
    }

    score = clamp01(score);

    const matchedTerms = findMatchedTerms(query.tokens, candidate.tokens);
    const matchedFields = findMatchedFields(query, candidate);

    results.push({
      candidate,
      score,
      matchedTerms,
      matchedFields,
      matchReasons: explain ? reasons : [],
    });
  }

  return sortResults(results);
}
