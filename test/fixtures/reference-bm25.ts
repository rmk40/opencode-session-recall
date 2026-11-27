import MiniSearch from "minisearch";
import { distance } from "fastest-levenshtein";
import type { Candidate } from "../../src/candidates.js";
import type { ParsedQuery } from "../../src/query.js";
import { tokenize, tokenizeAll } from "../../src/normalize.js";
import { evidenceClassFor } from "../../src/extract.js";
import {
  clamp01,
  compareHits,
  containsErrorPattern,
  MIN_RELATIVE_SCORE,
  recencyMultiplier,
  type Bm25Hit,
  type Bm25Mode,
} from "../../src/bm25.js";
import type { ResultWhy } from "../../src/types.js";

/**
 * A reference for `bm25Search` (src/bm25.ts) that computes the same ranking
 * the direct way: it builds a MiniSearch index over the whole pool and finds
 * each hit's matched terms and fields by tokenizing every field it searches.
 * The parity test holds the production ranker to it, so a change to the
 * ranking's boosts, multipliers or matching rules is made in both.
 */

const EXACT_PHRASE_MULT = 1.15;
const ALL_TOKENS_MULT = 1.1;
const REASONING_MULT = 1.05;
const ERROR_TEXT_MULT = 1.05;
const USER_ROLE_MULT = 1.03;
const WEAK_FUZZY_MULT = 0.9;
const POOR_COVERAGE_MULT = 0.92;
const TOOL_INPUT_MULT = 1.1;
const SKILL_DEFINITION_MULT = 0.85;
const FILE_READ_MULT = 0.9;
const WEB_FETCH_MULT = 0.85;
const EXACT_TOKEN_MULT = 1.12;
const DIGEST_MATCH_MULT = 1.15;
const WEAK_FUZZY_THRESHOLD = 0.7;
const MAX_FUZZY = 6;

function fuzzyFor(mode: Bm25Mode): number {
  return mode === "smart" ? 0.2 : 0.3;
}

function maxEditDistance(term: string, mode: Bm25Mode): number {
  if (term.length < 4) return 0;
  return Math.min(MAX_FUZZY, Math.round(term.length * fuzzyFor(mode)));
}

function findMatchedTerms(
  queryTokens: readonly string[],
  candidateTokens: readonly string[],
  mode: Bm25Mode,
): string[] {
  const matched: string[] = [];
  for (const qt of queryTokens) {
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
  digestText: string;
};

const FIELDS = ["primaryText", "secondaryText", "titleText", "hintText", "digestText"] as const;

const FIELD_BOOST: Record<(typeof FIELDS)[number], number> = {
  primaryText: 2,
  secondaryText: 0.6,
  titleText: 0.3,
  hintText: 0.15,
  digestText: 0.4,
};

export function referenceBm25Search(
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
    digestText: c.digestText ?? "",
  }));

  const mini = new MiniSearch<IndexedDoc>({
    idField: "id",
    fields: [...FIELDS],
    tokenize: (text: string) => tokenizeAll(text),
  });
  mini.addAll(docs);

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

  const maxScore = rawHits[0]!.score || 1;
  const digestTokenCache = new Map<string, Set<string>>();

  const hits: Bm25Hit[] = [];
  for (const hit of rawHits) {
    const candidate = candidates[hit.id as number]!;
    const base = clamp01(hit.score / maxScore);
    const reasons: string[] = [];
    if (explain) reasons.push(`BM25 relative score: ${base.toFixed(2)}`);

    let mult = 1;

    const rawLower = candidate.rawText.toLowerCase();
    if (query.phrases.some((p) => rawLower.includes(p))) {
      mult *= EXACT_PHRASE_MULT;
      if (explain) reasons.push(`Exact phrase: ×${EXACT_PHRASE_MULT}`);
    }

    if (candidate.digestText && query.tokens.length > 0) {
      let digestTokens = digestTokenCache.get(candidate.digestText);
      if (!digestTokens) {
        digestTokens = new Set(tokenize(candidate.digestText));
        digestTokenCache.set(candidate.digestText, digestTokens);
      }
      const covered = query.tokens.filter((token) => digestTokens!.has(token)).length;
      if (covered * 2 >= query.tokens.length) {
        mult *= DIGEST_MATCH_MULT;
        if (explain) reasons.push(`Session digest match: ×${DIGEST_MATCH_MULT}`);
      }
    }

    if (
      query.codeTokens.length > 0 &&
      query.codeTokens.some((token) => rawLower.includes(token.toLowerCase()))
    ) {
      mult *= EXACT_TOKEN_MULT;
      if (explain) reasons.push(`Exact code token: ×${EXACT_TOKEN_MULT}`);
    }

    const matchedTerms = findMatchedTerms(query.tokens, indexedTokenPool(candidate), mode);
    const matchedFields = findMatchedFields(query, candidate, mode);
    const evidenceClass = evidenceClassFor(candidate.partType, candidate.toolName, matchedFields);
    if (evidenceClass === "tool-input") {
      mult *= TOOL_INPUT_MULT;
      if (explain) reasons.push(`Tool input: ×${TOOL_INPUT_MULT}`);
    } else if (evidenceClass === "skill-definition") {
      mult *= SKILL_DEFINITION_MULT;
      if (explain) reasons.push(`Skill definition: ×${SKILL_DEFINITION_MULT}`);
    } else if (evidenceClass === "file-read") {
      mult *= FILE_READ_MULT;
      if (explain) reasons.push(`File read: ×${FILE_READ_MULT}`);
    } else if (evidenceClass === "web-fetch") {
      mult *= WEB_FETCH_MULT;
      if (explain) reasons.push(`Web fetch: ×${WEB_FETCH_MULT}`);
    }
    if (explain) reasons.push(`Evidence class: ${evidenceClass}`);
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

    if (matchedTerms.length === 1 && query.tokens.length === 1 && base < WEAK_FUZZY_THRESHOLD) {
      mult *= WEAK_FUZZY_MULT;
      if (explain) reasons.push(`Weak single-token fuzzy: ×${WEAK_FUZZY_MULT}`);
    }

    if (query.tokens.length > 1 && matchedTerms.length < query.tokens.length / 2) {
      mult *= POOR_COVERAGE_MULT;
      if (explain) reasons.push(`Poor coverage: ×${POOR_COVERAGE_MULT}`);
    }

    hits.push({
      candidate,
      score: base * mult,
      matchedTerms,
      matchedFields,
      evidenceClass,
      matchReasons: explain ? reasons : [],
    });
  }

  hits.sort(compareHits);

  if (hits.length <= 1) return hits;
  const floor = hits[0]!.score * MIN_RELATIVE_SCORE;
  return hits.filter((h) => h.score >= floor);
}
