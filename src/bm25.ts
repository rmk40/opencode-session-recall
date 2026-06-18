import MiniSearch from "minisearch";
import { distance } from "fastest-levenshtein";
import type { Candidate } from "./candidates.js";
import type { ParsedQuery } from "./query.js";
import { tokenize, tokenizeAll } from "./normalize.js";
import type { ResultWhy } from "./types.js";

/**
 * BM25 relevance ranking via an in-memory MiniSearch index built per query.
 *
 * This replaces Fuse.js as the relevance engine for smart/fuzzy modes. MiniSearch
 * provides BM25+ scoring (term-rarity / IDF weighting and document-length
 * normalization) which Fuse — a fuzzy string matcher — does not. Structural
 * signals from the old rank.ts (recency, role, part type, error text, exact
 * phrase, coverage) are layered on as multiplicative document boosts so they
 * ride on a calibrated relevance score rather than an uncalibrated fuzzy distance.
 *
 * The index is rebuilt every call. This is intentional and cheap: histories load
 * fast and there is no persistent cache (by design).
 */

export type Bm25Mode = "smart" | "fuzzy";

export type Bm25Hit = {
  candidate: Candidate;
  /** Final score in 0..1 (BM25 relative score × structural multiplier). */
  score: number;
  matchedTerms: string[];
  matchedFields: ResultWhy["matchedFields"];
  matchReasons: string[];
};

// ── Structural multipliers (ported from rank.ts additive boosts) ─────────
// Additive +x became multiplicative ×(1+x); penalties −x became ×(1−x). The
// mapping is documented so the eval fixtures can re-tune if needed.
const EXACT_PHRASE_MULT = 1.15; // was +0.15
const ALL_TOKENS_MULT = 1.1; // was +0.10
const REASONING_MULT = 1.05; // was +0.05
const ERROR_TEXT_MULT = 1.05; // was +0.05
const USER_ROLE_MULT = 1.03; // was +0.03
const RECENCY_MULT_MAX = 1.05; // was +0.05 at max
const WEAK_FUZZY_MULT = 0.9; // was −0.10
const POOR_COVERAGE_MULT = 0.92; // was −0.08

const RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const WEAK_FUZZY_THRESHOLD = 0.7;

/**
 * Minimum final score (after structural multipliers) for a hit to be returned.
 * MiniSearch combines terms with OR, so a single weakly-matched term can surface
 * an otherwise-irrelevant document. This floor drops that noise. It is a relative
 * floor: scores are normalized to the top hit, so the best match always survives.
 */
const MIN_RELATIVE_SCORE = 0.1;

const ERROR_PATTERNS = ["error", "failed", "exception"];

/** Fuzzy edit-distance fraction per mode (smart conservative, fuzzy looser). */
function fuzzyFor(mode: Bm25Mode): number {
  return mode === "smart" ? 0.2 : 0.3;
}

/** MiniSearch caps fractional fuzzy distance at this many edits. */
const MAX_FUZZY = 6;

/**
 * Max edit distance MiniSearch would allow for a term in this mode, matching its
 * `fuzzy: fraction` + `maxFuzzy` behavior. Used so matched-term metadata agrees
 * with what the index actually matched (reviewer-flagged consistency).
 */
function maxEditDistance(term: string, mode: Bm25Mode): number {
  if (term.length < 4) return 0;
  return Math.min(MAX_FUZZY, Math.round(term.length * fuzzyFor(mode)));
}

function containsErrorPattern(text: string): boolean {
  const lower = text.toLowerCase();
  return ERROR_PATTERNS.some((p) => lower.includes(p));
}

function recencyMultiplier(time: number): number {
  const ageMs = Date.now() - time;
  const factor = Math.max(0, 1 - ageMs / RECENCY_WINDOW_MS);
  return 1 + factor * (RECENCY_MULT_MAX - 1);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Token-match detection for metadata (matchedTerms / matchedFields).
 * A query token matches a candidate token by substring, or by edit distance
 * within the SAME fuzzy budget MiniSearch used for the index (so reported
 * matched terms agree with what actually matched).
 */
function findMatchedTerms(
  queryTokens: readonly string[],
  candidateTokens: readonly string[],
  mode: Bm25Mode,
): string[] {
  const matched: string[] = [];
  for (const qt of queryTokens) {
    // Mirror MiniSearch's own matching: exact token, or prefix when the term is
    // long enough for prefix search (length > 3). Using substring containment
    // here would over-report terms BM25 never matched, which would distort the
    // coverage boost/penalty and the matchedTerms metadata.
    const prefixEligible = qt.length > 3;
    if (candidateTokens.some((ct) => (prefixEligible ? ct.startsWith(qt) : ct === qt))) {
      matched.push(qt);
      continue;
    }
    const maxDist = maxEditDistance(qt, mode);
    if (maxDist > 0) {
      const typo = candidateTokens.some(
        (ct) => Math.abs(ct.length - qt.length) <= maxDist && distance(qt, ct) <= maxDist,
      );
      if (typo) matched.push(qt);
    }
  }
  return matched;
}

/**
 * Token pool covering every field the BM25 index searches (raw message/tool
 * text plus directory, session title, and tool name). matchedTerms/coverage are
 * computed against this pool so a hit caused by a title/directory/tool-name
 * match still reports its matched terms instead of being penalized for coverage.
 */
function indexedTokenPool(candidate: Candidate): string[] {
  const pool = new Set<string>(candidate.tokens);
  for (const extra of [candidate.directory, candidate.sessionTitle, candidate.toolName]) {
    if (extra) for (const t of tokenize(extra)) pool.add(t);
  }
  return [...pool];
}

function findMatchedFields(
  query: ParsedQuery,
  candidate: Candidate,
  mode: Bm25Mode,
): ResultWhy["matchedFields"] {
  const fields = new Set<ResultWhy["matchedFields"][number]>();
  for (const field of candidate.fieldTexts) {
    const lower = field.text.toLowerCase();
    const phraseMatched = query.phrases.some((phrase) => lower.includes(phrase));
    const termsMatched = findMatchedTerms(query.tokens, tokenize(field.text), mode).length > 0;
    if (phraseMatched || termsMatched) fields.add(field.field);
  }
  return [...fields];
}

type IndexedDoc = {
  id: number;
  primaryText: string;
  secondaryText: string;
  titleText: string;
  hintText: string;
};

const FIELDS = ["primaryText", "secondaryText", "titleText", "hintText"] as const;

/** Field boosts mirror the old Fuse key weights (primary dominates). */
const FIELD_BOOST: Record<(typeof FIELDS)[number], number> = {
  primaryText: 2,
  secondaryText: 0.6,
  titleText: 0.3,
  hintText: 0.15,
};

/**
 * Build a per-query BM25 index over candidates and return ranked hits.
 * Candidates MUST have stage-2 normalized fields populated (primaryText etc.).
 */
export function bm25Search(
  candidates: Candidate[],
  query: ParsedQuery,
  mode: Bm25Mode,
  explain: boolean,
): Bm25Hit[] {
  if (candidates.length === 0) return [];

  const docs: IndexedDoc[] = candidates.map((c, id) => ({
    id,
    primaryText: c.primaryText ?? "",
    secondaryText: c.secondaryText ?? "",
    titleText: c.titleText ?? "",
    hintText: c.hintText ?? "",
  }));

  const mini = new MiniSearch<IndexedDoc>({
    idField: "id",
    fields: [...FIELDS],
    // Use the plugin's shared tokenizer (camelCase/separator aware) for both
    // indexing and search. tokenizeAll preserves duplicate terms so BM25 term
    // frequency stays meaningful — a document that repeats a term ranks higher.
    tokenize: (text: string) => tokenizeAll(text),
  });
  mini.addAll(docs);

  // Search terms come from the parsed query tokens (already normalized).
  const queryText = query.tokens.join(" ");
  if (queryText.trim().length === 0) return [];

  const rawHits = mini.search(queryText, {
    fields: [...FIELDS],
    boost: FIELD_BOOST,
    combineWith: "OR",
    prefix: (term) => term.length > 3,
    fuzzy: (term) => (term.length >= 4 ? fuzzyFor(mode) : false),
    maxFuzzy: MAX_FUZZY,
  });

  if (rawHits.length === 0) return [];

  // Normalize BM25 scores to a 0..1 relative scale using the top score.
  const maxScore = rawHits[0]!.score || 1;

  const hits: Bm25Hit[] = [];
  for (const hit of rawHits) {
    const candidate = candidates[hit.id as number]!;
    const base = clamp01(hit.score / maxScore);
    const reasons: string[] = [];
    if (explain) reasons.push(`BM25 relative score: ${base.toFixed(2)}`);

    let mult = 1;

    // Exact phrase present in raw text.
    const rawLower = candidate.rawText.toLowerCase();
    if (query.phrases.some((p) => rawLower.includes(p))) {
      mult *= EXACT_PHRASE_MULT;
      if (explain) reasons.push(`Exact phrase: ×${EXACT_PHRASE_MULT}`);
    }

    const matchedTerms = findMatchedTerms(query.tokens, indexedTokenPool(candidate), mode);
    const matchedFields = findMatchedFields(query, candidate, mode);
    const allTokens = query.tokens.length > 0 && matchedTerms.length === query.tokens.length;
    if (allTokens) {
      mult *= ALL_TOKENS_MULT;
      if (explain) reasons.push(`All tokens matched: ×${ALL_TOKENS_MULT}`);
    }

    if (candidate.partType === "reasoning") {
      mult *= REASONING_MULT;
      if (explain) reasons.push(`Reasoning part: ×${REASONING_MULT}`);
    }
    if (candidate.partType === "tool" && containsErrorPattern(candidate.rawText)) {
      mult *= ERROR_TEXT_MULT;
      if (explain) reasons.push(`Error text: ×${ERROR_TEXT_MULT}`);
    }
    if (candidate.role === "user") {
      mult *= USER_ROLE_MULT;
      if (explain) reasons.push(`User text: ×${USER_ROLE_MULT}`);
    }

    const recency = recencyMultiplier(candidate.time);
    if (recency > 1) {
      mult *= recency;
      if (explain) reasons.push(`Recency: ×${recency.toFixed(3)}`);
    }

    // Weak single-token fuzzy: a lone weakly-scored token match.
    if (matchedTerms.length === 1 && query.tokens.length === 1 && base < WEAK_FUZZY_THRESHOLD) {
      mult *= WEAK_FUZZY_MULT;
      if (explain) reasons.push(`Weak single-token fuzzy: ×${WEAK_FUZZY_MULT}`);
    }

    // Poor coverage: fewer than half the query tokens matched.
    if (query.tokens.length > 1 && matchedTerms.length < query.tokens.length / 2) {
      mult *= POOR_COVERAGE_MULT;
      if (explain) reasons.push(`Poor coverage: ×${POOR_COVERAGE_MULT}`);
    }

    hits.push({
      candidate,
      score: clamp01(base * mult),
      matchedTerms,
      matchedFields,
      matchReasons: explain ? reasons : [],
    });
  }

  hits.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    const timeDiff = b.candidate.time - a.candidate.time;
    if (timeDiff !== 0) return timeDiff;
    // Final deterministic tie-breaker so ordering is stable across runs.
    return a.candidate.partID.localeCompare(b.candidate.partID);
  });

  // Drop trailing noise from OR-combined weak single-term matches, but never
  // drop the only/best hit (the floor is relative to the top score).
  if (hits.length <= 1) return hits;
  return hits.filter((h) => h.score >= MIN_RELATIVE_SCORE);
}
