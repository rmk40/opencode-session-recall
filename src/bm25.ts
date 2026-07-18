import MiniSearch from "minisearch";
import { distance } from "fastest-levenshtein";
import type { Candidate } from "./candidates.js";
import type { ParsedQuery } from "./query.js";
import { tokenize, tokenizeAll, normalize } from "./normalize.js";
import { evidenceClassFor, containsErrorPattern } from "./extract.js";
import type { EvidenceClass, ResultWhy } from "./types.js";

/**
 * BM25 relevance ranking via MiniSearch.
 *
 * MiniSearch provides BM25+ scoring (term-rarity / IDF weighting and
 * document-length normalization). Structural signals (recency, role, part type,
 * error text, exact phrase, coverage, evidence class) are layered on as
 * multiplicative document boosts so they ride on a calibrated relevance score.
 *
 * Two structural changes from the per-query-rebuild era:
 *
 * - The index is owned by CorpusCache and lives across queries (src/corpus.ts):
 *   docs are keyed by the STABLE STRING partID, added once per session version.
 *   A per-query side index (createIndex) is still built for narrow scopes and
 *   for unknown-version sessions that are not in the persistent index.
 * - Scoring is split into two phases (Fix 2): a cheap O(1) phase-1 over every
 *   raw hit (used only to pick a bounded refinement window), then the full
 *   per-hit stack (phase 2) over the window. phase2Hit reproduces the old
 *   single-pass scoring exactly, so when the window covers every hit (small
 *   corpora, e.g. the eval) the result is byte-for-byte the pre-split ranking.
 */

export type Bm25Mode = "smart" | "fuzzy";

/** A raw index hit: the resolved candidate plus its BM25 score normalized to
 *  the top matched (and filter-eligible) hit. Downstream phases turn `base`
 *  into a boosted score. */
export type RawHit = { candidate: Candidate; base: number };

export type Bm25Hit = {
  candidate: Candidate;
  /** BM25 relative score × structural multipliers. UNCLAMPED: boosts can push
   *  it above 1 so they can break ties at the relative top; the output layer
   *  (rankedToSearchResults) clamps to 0..1 for the public shape. */
  score: number;
  matchedTerms: string[];
  matchedFields: ResultWhy["matchedFields"];
  evidenceClass: EvidenceClass;
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

// ── Evidence-class multipliers ────────────────────────────────────────
// Concrete actions (tool inputs) beat generated reference material (skill
// payloads, file reads) for "what did we do before" queries. Plain tool
// output is deliberately NOT penalized: error/stdout evidence is often the
// only record of what happened. Tuned against test/eval/.
const TOOL_INPUT_MULT = 1.1;
const SKILL_DEFINITION_MULT = 0.85;
const FILE_READ_MULT = 0.9;
/** Fetched web content is reference material, same tier as skill payloads —
 *  exactly the class round-2 dogfooding saw dominating workflow queries. */
const WEB_FETCH_MULT = 0.85;

/** Verbatim presence of a code-like compound query token (tokenization splits
 *  them, so BM25 alone cannot tell `GHOSTAUTH_LIVE_TUI` from the loose words). */
const EXACT_TOKEN_MULT = 1.12;

/** Session-identity boost: at least half the query tokens appear in the
 *  candidate's session digest (built from the session's own statements and
 *  commands, never from reads). A session that SAID or DID the query's terms
 *  outranks one that merely read about them at equal lexical strength. */
const DIGEST_MATCH_MULT = 1.15;

const RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const WEAK_FUZZY_THRESHOLD = 0.7;

/**
 * Minimum final score (after structural multipliers) for a hit to be returned.
 * MiniSearch combines terms with OR, so a single weakly-matched term can surface
 * an otherwise-irrelevant document. This floor drops that noise. It is a relative
 * floor: scores are normalized to the top hit, so the best match always survives.
 * (Applied to the unclamped boosted score; multipliers shift hits across the
 * floor slightly, which is intended — penalized classes may drop below it.)
 * Exported for the shortlist merge, which uses it as the re-entry ceiling for
 * deep hits whose broad counterparts this floor removed.
 */
export const MIN_RELATIVE_SCORE = 0.1;

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

function recencyMultiplier(time: number): number {
  const ageMs = Date.now() - time;
  const factor = Math.max(0, 1 - ageMs / RECENCY_WINDOW_MS);
  return 1 + factor * (RECENCY_MULT_MAX - 1);
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Deterministic hit ordering: score, then recency, then partID. */
export function compareHits(a: Bm25Hit, b: Bm25Hit): number {
  const diff = b.score - a.score;
  if (diff !== 0) return diff;
  const timeDiff = b.candidate.time - a.candidate.time;
  if (timeDiff !== 0) return timeDiff;
  return a.candidate.partID.localeCompare(b.candidate.partID);
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
 *
 * Reproduces the old indexedTokenPool exactly, now that candidates no longer
 * retain their token list: tokenize(rawText) is recomputed on demand here, and
 * this runs only over the phase-2 window so it stays bounded.
 */
function indexedTokenPool(candidate: Candidate): string[] {
  const pool = new Set<string>(tokenize(candidate.rawText));
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

// ── Persistent / side index primitives ────────────────────────────────

type IndexedDoc = {
  /** STABLE STRING partID (opencode part IDs are globally unique; title
   *  candidates namespace as `<sessionID>:title`). */
  id: string;
  primaryText: string;
  secondaryText: string;
  titleText: string;
  hintText: string;
  digestText: string;
};

const FIELDS = ["primaryText", "secondaryText", "titleText", "hintText", "digestText"] as const;

/** Field boosts mirror the old Fuse key weights (primary dominates). The
 *  digest sits between directory (0.6) and title (0.3): content-derived
 *  session identity outranks naming metadata but never body text. The main
 *  digest ranking signal is DIGEST_MATCH_MULT below, not this field boost. */
const FIELD_BOOST: Record<(typeof FIELDS)[number], number> = {
  primaryText: 2,
  secondaryText: 0.6,
  titleText: 0.3,
  hintText: 0.15,
  digestText: 0.4,
};

/** Fresh MiniSearch configured exactly like the query engine expects. Used for
 *  the persistent (CorpusCache-owned) index and for per-query side/deep
 *  indexes. Default autoVacuum handles tombstone cleanup after discards. */
export function createIndex(): MiniSearch<IndexedDoc> {
  return new MiniSearch<IndexedDoc>({
    idField: "id",
    fields: [...FIELDS],
    // tokenizeAll preserves duplicate terms so BM25 term frequency stays
    // meaningful — a document that repeats a term ranks higher.
    tokenize: (text: string) => tokenizeAll(text),
  });
}

/**
 * The indexed document for a candidate. primaryText is released after the
 * persistent add (memory cut), so side/deep index builds HARD-rehydrate it from
 * rawText — never fall back to indexing "". A title candidate's body IS its
 * title (indexed via titleText); its primaryText stays empty so the title text
 * is not double-weighted.
 */
export function candidateToDoc(c: Candidate): IndexedDoc {
  return {
    id: c.partID,
    primaryText: c.partType === "title" ? "" : (c.primaryText ?? normalize(c.rawText)),
    secondaryText: c.secondaryText ?? "",
    titleText: c.titleText ?? "",
    hintText: c.hintText ?? "",
    digestText: c.digestText ?? "",
  };
}

/**
 * Search an index and return raw hits (candidate + relative base score),
 * resolving ids to candidates and applying an optional post-scoring filter
 * (MiniSearch's `filter` runs after scoring, exactly how it is designed). The
 * base score is normalized to the top FILTER-ELIGIBLE hit, so a scope filter
 * cannot leave the whole list scaled by an excluded document.
 */
export function searchRawHits(
  mini: MiniSearch<IndexedDoc>,
  query: ParsedQuery,
  mode: Bm25Mode,
  resolve: (id: string) => Candidate | undefined,
  filter?: (candidate: Candidate) => boolean,
): RawHit[] {
  const queryText = query.tokens.join(" ");
  if (queryText.trim().length === 0) return [];

  const rawHits = mini.search(queryText, {
    fields: [...FIELDS],
    boost: FIELD_BOOST,
    combineWith: "OR",
    prefix: (term) => term.length > 3,
    fuzzy: (term) => (term.length >= 4 ? fuzzyFor(mode) : false),
    maxFuzzy: MAX_FUZZY,
    ...(filter && {
      filter: (result) => {
        const candidate = resolve(result.id as string);
        return candidate != null && filter(candidate);
      },
    }),
  });
  if (rawHits.length === 0) return [];

  const maxScore = rawHits[0]!.score || 1;
  const hits: RawHit[] = [];
  for (const hit of rawHits) {
    const candidate = resolve(hit.id as string);
    if (!candidate) continue;
    hits.push({ candidate, base: clamp01(hit.score / maxScore) });
  }
  return hits;
}

/** Build a fresh index over a candidate pool and return raw hits. Used by the
 *  side path (narrow scopes, unknown-version sessions) and the deep pass. The
 *  index id is the pool POSITION, not the partID: a per-query pool is
 *  positional and may legitimately hold the same partID twice (e.g. a title
 *  candidate that also appears as content), and positional ids also can't
 *  collide the way stable ids could. */
export function sideSearch(pool: Candidate[], query: ParsedQuery, mode: Bm25Mode): RawHit[] {
  if (pool.length === 0) return [];
  const mini = createIndex();
  const docs: IndexedDoc[] = pool.map((candidate, index) => ({
    ...candidateToDoc(candidate),
    id: String(index),
  }));
  mini.addAll(docs);
  return searchRawHits(mini, query, mode, (id) => pool[Number(id)]);
}

// ── Two-phase scoring ─────────────────────────────────────────────────

/**
 * Phase 1: cheap, O(1)-per-hit multipliers over the base score, used only to
 * choose the refinement window. Recency, reasoning, user-role, precomputed
 * error text, and the precomputed skill/file-read penalties — no re-tokenizing,
 * no field re-scan, no evidence resolution. Fetch-shaped tools get NO penalty
 * here: whether a fetch part is an action (tool-input, a boost) or reference
 * material (web-fetch, a penalty) is query-dependent, so pre-penalizing could
 * push an input-only fetch out of the window before phase 2 can raise it.
 */
export function phase1Score(candidate: Candidate, base: number): number {
  let mult = 1;
  if (candidate.partType === "reasoning") mult *= REASONING_MULT;
  if (candidate.partType === "tool" && candidate.hasErrorText) mult *= ERROR_TEXT_MULT;
  if (candidate.role === "user") mult *= USER_ROLE_MULT;
  const recency = recencyMultiplier(candidate.time);
  if (recency > 1) mult *= recency;
  if (candidate.nameClass === "skill-definition") mult *= SKILL_DEFINITION_MULT;
  else if (candidate.nameClass === "file-read") mult *= FILE_READ_MULT;
  return base * mult;
}

/** A phase-1 hit (window candidate not yet refined, or a tail hit). Carries the
 *  cheap score and a provisional evidence class from the name alone; phase 2
 *  resolves the full class. matchedTerms/fields stay empty until refinement. */
export function phase1Hit(raw: RawHit): Bm25Hit {
  const c = raw.candidate;
  const provisional: EvidenceClass =
    c.nameClass ?? evidenceClassFor(c.partType, c.toolName, defaultFieldsFor(c));
  return {
    candidate: c,
    score: phase1Score(c, raw.base),
    matchedTerms: [],
    matchedFields: [],
    evidenceClass: provisional,
    matchReasons: [],
  };
}

/** A default matched-field guess for a phase-1 hit's provisional class (only
 *  used before refinement, e.g. tail hits that are never materialized). */
function defaultFieldsFor(candidate: Candidate): ResultWhy["matchedFields"] {
  if (candidate.partType === "title") return ["title"];
  if (candidate.partType === "reasoning") return ["reasoning"];
  if (candidate.partType === "tool") return [];
  return ["text"];
}

/**
 * Phase 2: the full per-hit stack, recomputed from the base score. This is the
 * exact scoring of the pre-split single-pass ranker (exact phrase, digest,
 * code token, full evidence class, matched terms/coverage, weak-fuzzy, poor
 * coverage). Run only over the bounded refinement window. `digestCache` is a
 * per-query memo shared across hits so a session's digest tokens are built once.
 */
export function phase2Hit(
  raw: RawHit,
  query: ParsedQuery,
  mode: Bm25Mode,
  explain: boolean,
  digestCache: Map<string, Set<string>>,
): Bm25Hit {
  const candidate = raw.candidate;
  const base = raw.base;
  const reasons: string[] = [];
  if (explain) reasons.push(`BM25 relative score: ${base.toFixed(2)}`);

  let mult = 1;

  // Exact phrase present in raw text.
  const rawLower = candidate.rawText.toLowerCase();
  if (query.phrases.some((p) => rawLower.includes(p))) {
    mult *= EXACT_PHRASE_MULT;
    if (explain) reasons.push(`Exact phrase: ×${EXACT_PHRASE_MULT}`);
  }

  // Session-identity: the session's own statements/actions cover the query.
  if (candidate.digestText && query.tokens.length > 0) {
    let digestTokens = digestCache.get(candidate.digestText);
    if (!digestTokens) {
      digestTokens = new Set(tokenize(candidate.digestText));
      digestCache.set(candidate.digestText, digestTokens);
    }
    const covered = query.tokens.filter((token) => digestTokens!.has(token)).length;
    if (covered * 2 >= query.tokens.length) {
      mult *= DIGEST_MATCH_MULT;
      if (explain) reasons.push(`Session digest match: ×${DIGEST_MATCH_MULT}`);
    }
  }

  // Verbatim code-like compound token (case-insensitive).
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

  return {
    candidate,
    // Deliberately unclamped: clamping here would erase positive boosts at the
    // relative top (1.0 × 1.12 → 1.0), reducing them to tie-breaks.
    score: base * mult,
    matchedTerms,
    matchedFields,
    evidenceClass,
    matchReasons: explain ? reasons : [],
  };
}

/**
 * Rank a candidate pool end to end via a per-query index (the side path). This
 * is the pre-split single-pass ranker preserved for narrow scopes and unit
 * tests: build an index, score every hit through phase 2, sort, apply the
 * relative floor. Identical output to the old bm25Search.
 */
export function bm25Search(
  candidates: Candidate[],
  query: ParsedQuery,
  mode: Bm25Mode,
  explain: boolean,
): Bm25Hit[] {
  const raw = sideSearch(candidates, query, mode);
  return refineHits(raw, query, mode, explain);
}

/**
 * Turn raw hits into fully-refined, floored, sorted Bm25Hits by running phase 2
 * over ALL of them. Used by the side path (small pools) where windowing buys
 * nothing. digestCache is per-call.
 */
export function refineHits(
  raw: RawHit[],
  query: ParsedQuery,
  mode: Bm25Mode,
  explain: boolean,
): Bm25Hit[] {
  if (raw.length === 0) return [];
  const digestCache = new Map<string, Set<string>>();
  const hits = raw.map((r) => phase2Hit(r, query, mode, explain, digestCache));
  hits.sort(compareHits);
  return applyRelativeFloor(hits);
}

/** Drop trailing OR-combined noise below the relative floor, never the best
 *  hit. Assumes `hits` is already sorted best-first. */
export function applyRelativeFloor(hits: Bm25Hit[]): Bm25Hit[] {
  if (hits.length <= 1) return hits;
  const floor = hits[0]!.score * MIN_RELATIVE_SCORE;
  return hits.filter((h) => h.score >= floor);
}
