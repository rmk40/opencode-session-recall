import { distance } from "fastest-levenshtein";
import type { Candidate } from "./candidates.js";
import type { ParsedQuery } from "./query.js";
import { tokenize, tokenizeAll, tokenText } from "./normalize.js";
import { evidenceClassFor } from "./extract.js";
import type { EvidenceClass, ResultWhy } from "./types.js";

/**
 * BM25 relevance ranking over a per-query candidate pool.
 *
 * Each candidate is scored with BM25+ (term rarity over the pool and
 * field-length normalization) across five weighted fields, with prefix and
 * fuzzy expansion of the query terms. Structural signals (recency, role, part
 * type, error text, exact phrase, coverage) are layered on as multiplicative
 * boosts so they ride on a calibrated relevance score.
 *
 * The BM25+ scores are exactly the ones a MiniSearch index over the pool would
 * give with the fields, boosts, tokenizer and prefix and fuzzy options below
 * (MiniSearch 7's scoring defaults), but no index is built. A pass over the
 * pool counts what those scores depend on: the pool size, each field's average
 * length, and the document frequency of every pool term a query term reaches.
 * Only the candidates holding such a term are scored, so the work per
 * candidate is a lookup per distinct term rather than an index insert per
 * token.
 */

export type Bm25Mode = "smart" | "fuzzy";

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
/** Fetched web content is reference material, same tier as skill payloads,
 *  and a class that otherwise dominates workflow queries. */
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
 * BM25 combines terms with OR, so a single weakly-matched term can surface
 * an otherwise-irrelevant document. This floor drops that noise. It is a relative
 * floor: scores are normalized to the top hit, so the best match always survives.
 * (Applied to the unclamped boosted score; multipliers shift hits across the
 * floor slightly, which is intended — penalized classes may drop below it.)
 * Exported for the shortlist merge, which uses it as the re-entry ceiling for
 * deep hits whose broad counterparts this floor removed.
 */
export const MIN_RELATIVE_SCORE = 0.1;

const ERROR_PATTERNS = ["error", "failed", "exception"];

/** Fuzzy edit-distance fraction per mode (smart conservative, fuzzy looser). */
function fuzzyFor(mode: Bm25Mode): number {
  return mode === "smart" ? 0.2 : 0.3;
}

/** Fractional fuzzy distance is capped at this many edits. */
const MAX_FUZZY = 6;

/**
 * Max edit distance a fuzzy match of `term` may have in this mode: none under
 * four characters, else the mode's fraction of its length, rounded, at most
 * {@link MAX_FUZZY}. Scoring and matched-term metadata share it, so reported
 * matched terms agree with what was scored.
 */
function maxEditDistance(term: string, mode: Bm25Mode): number {
  if (term.length < 4) return 0;
  return Math.min(MAX_FUZZY, Math.round(term.length * fuzzyFor(mode)));
}

/** Whether text carries an error signature (`error`/`failed`/`exception`).
 *  Exported so the distiller mines the same error vocabulary from tool outputs
 *  when building a card's error-signature list. */
export function containsErrorPattern(text: string): boolean {
  return lowerHasErrorPattern(text.toLowerCase());
}

function lowerHasErrorPattern(lower: string): boolean {
  return ERROR_PATTERNS.some((p) => lower.includes(p));
}

/** Recency prior: linearly decays from {@link RECENCY_MULT_MAX} at now to 1.0 at
 *  {@link RECENCY_WINDOW_MS} old, then flat. Exported so tier-1 card ranking
 *  applies the same recency shape as part-level scoring. */
export function recencyMultiplier(time: number): number {
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

// ── Term expansion ────────────────────────────────────────────────────

/** How a pool term reaches one query term, and the weight of that match. */
type Expansion = {
  /** Index of the query term in the term list the expander was built for. */
  term: number;
  kind: "exact" | "prefix" | "fuzzy";
  weight: number;
};

/** The expansions a pool term takes part in, or undefined when it reaches no
 *  query term. Remembered per distinct term for one search. */
type Expander = (token: string) => readonly Expansion[] | undefined;

/** Weights of a prefix and of a fuzzy expansion relative to an exact match
 *  (MiniSearch's defaults). */
const PREFIX_WEIGHT = 0.375;
const FUZZY_WEIGHT = 0.45;

/**
 * The expander for `terms`. A pool term reaches a query term when it equals
 * it, when the query term is longer than three characters and a prefix of it,
 * or within {@link maxEditDistance} edits of it; an exact match takes weight
 * 1 and a prefix match takes precedence over a fuzzy one. Each weight falls
 * as the pool term moves away from the query term, as MiniSearch weighs its
 * prefix and fuzzy matches.
 */
function createExpander(terms: readonly string[], mode: Bm25Mode): Expander {
  const specs = terms.map((text) => ({
    text,
    prefix: text.length > 3,
    maxDistance: maxEditDistance(text, mode),
  }));
  // A prototype-less object rather than a Map: it is read once per distinct
  // token of every candidate, and a property read interns its key, so the
  // tokens of the drill cache's candidates are hashed on their first search
  // only. Under Bun that makes a repeated read several times cheaper.
  const memo = Object.create(null) as Record<string, readonly Expansion[] | null | undefined>;
  return (token) => {
    let found = memo[token];
    if (found === undefined) {
      let list: Expansion[] | null = null;
      for (let i = 0; i < specs.length; i++) {
        const { text, prefix, maxDistance } = specs[i]!;
        let expansion: Expansion | undefined;
        if (token === text) {
          expansion = { term: i, kind: "exact", weight: 1 };
        } else if (prefix && token.startsWith(text)) {
          const gap = token.length - text.length;
          const weight = (PREFIX_WEIGHT * token.length) / (token.length + 0.3 * gap);
          expansion = { term: i, kind: "prefix", weight };
        } else if (maxDistance > 0 && Math.abs(token.length - text.length) <= maxDistance) {
          const edits = distance(text, token);
          if (edits <= maxDistance) {
            const weight = (FUZZY_WEIGHT * token.length) / (token.length + edits);
            expansion = { term: i, kind: "fuzzy", weight };
          }
        }
        if (expansion) (list ??= []).push(expansion);
      }
      found = list;
      memo[token] = found;
    }
    return found ?? undefined;
  };
}

/** Whether two term lists are the same terms in the same order. */
function sameTerms(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((term, i) => term === b[i]);
}

// ── BM25+ scoring ─────────────────────────────────────────────────────

const FIELDS = ["primaryText", "secondaryText", "titleText", "hintText", "digestText"] as const;
const PRIMARY_FIELD = 0;

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
const BOOSTS = FIELDS.map((field) => FIELD_BOOST[field]);

/** BM25+ term-frequency saturation, length normalization and lower bound
 *  (MiniSearch's defaults). */
const BM25_K = 1.2;
const BM25_B = 0.7;
const BM25_D = 0.5;

/** BM25+ for one term in one field of one document, written as MiniSearch
 *  computes it so the floating-point result is the same. */
function bm25Plus(
  termFreq: number,
  docFreq: number,
  docCount: number,
  fieldLength: number,
  avgFieldLength: number,
): number {
  const idf = Math.log(1 + (docCount - docFreq + 0.5) / (docFreq + 0.5));
  return (
    idf *
    (BM25_D +
      (termFreq * (BM25_K + 1)) /
        (termFreq + BM25_K * (1 - BM25_B + (BM25_B * fieldLength) / avgFieldLength)))
  );
}

/** A distinct token of a field text that reaches a query term, with the
 *  number of times the text holds it. */
type ReachingTerm = { token: string; expansions: readonly Expansion[]; count: number };

/** A field text's length (its number of distinct tokens) and its reaching
 *  tokens in first occurrence order. */
type FieldTerms = { length: number; reaching: readonly ReachingTerm[] };

function fieldTerms(text: string, expand: Expander): FieldTerms {
  const counts = new Map<string, number>();
  for (const token of tokenizeAll(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  const reaching: ReachingTerm[] = [];
  for (const [token, count] of counts) {
    const expansions = expand(token);
    if (expansions) reaching.push({ token, expansions, count });
  }
  return { length: counts.size, reaching };
}

/** {@link fieldTerms} for a `normalize` result whose distinct tokens are
 *  known: only the reaching ones are counted, in the text itself. */
function knownFieldTerms(
  normalized: string,
  distinct: readonly string[],
  expand: Expander,
): FieldTerms {
  const reaching: ReachingTerm[] = [];
  for (const token of distinct) {
    const expansions = expand(token);
    if (expansions) reaching.push({ token, expansions, count: countToken(normalized, token) });
  }
  return { length: distinct.length, reaching };
}

/** Occurrences of `token` as a whole token of `normalized`, a `normalize`
 *  result: tokens joined by single spaces. */
function countToken(normalized: string, token: string): number {
  let count = 0;
  let at = normalized.indexOf(token);
  while (at !== -1) {
    const end = at + token.length;
    const starts = at === 0 || normalized.charCodeAt(at - 1) === 32;
    const ends = end === normalized.length || normalized.charCodeAt(end) === 32;
    if (starts && ends) {
      count++;
      at = normalized.indexOf(token, end + 1);
    } else {
      at = normalized.indexOf(token, at + 1);
    }
  }
  return count;
}

/** One pool term a candidate holds that reaches a query term: the fields
 *  holding it, in field order, and its frequency in each. */
type HeldTerm = { expansions: readonly Expansion[]; fields: number[]; freqs: number[] };

/** A candidate holding at least one reaching term, with its field lengths. */
type Holder = {
  doc: number;
  lengths: number[];
  held: Map<string, HeldTerm>;
  primaryReaching: readonly string[] | undefined;
};

/** A scored candidate. `primaryReaching` lists the tokens of its
 *  `primaryTerms` that reach a query term, in their order, when the score
 *  read them from there. */
type RawHit = { doc: number; score: number; primaryReaching: readonly string[] | undefined };

const LATER_KINDS = ["prefix", "fuzzy"] as const;

/**
 * BM25+ scores for every candidate holding a term that reaches a query term,
 * highest first (ties in pool order).
 *
 * The statistics are the ones a MiniSearch index over all of `candidates`
 * holds: the document count is the pool size, a field's length is its number
 * of distinct tokens, its average length is the running mean over the pool in
 * order, and a term's document frequency in a field is the number of
 * candidates holding it there. A candidate that holds a reaching term in some
 * field counts toward those frequencies, so counting only candidates that
 * hold one loses nothing.
 *
 * The primary field's distinct tokens come from `primaryTerms` and its term
 * frequencies from `primaryText` when both are set; the other fields repeat
 * across a session's candidates and are tokenized once per distinct text.
 *
 * A candidate's score sums, for each query term in order, its exact term and
 * then its prefix and fuzzy expansions across fields, each weighted by its
 * expansion weight and field boost; the sum is multiplied by how many distinct
 * query terms it reached.
 */
function scorePool(
  candidates: readonly Candidate[],
  terms: readonly string[],
  expand: Expander,
): RawHit[] {
  const fieldCount = FIELDS.length;
  const docFreqs = FIELDS.map(() => new Map<string, number>());
  const avgLengths = FIELDS.map(() => 0);
  const labels = new Map<string, FieldTerms>();
  const holders: Holder[] = [];
  const lengths = FIELDS.map(() => 0);

  for (let doc = 0; doc < candidates.length; doc++) {
    const candidate = candidates[doc]!;
    let held: Map<string, HeldTerm> | undefined;
    let primaryReaching: string[] | undefined;
    for (let field = 0; field < fieldCount; field++) {
      const text = candidate[FIELDS[field]!] ?? "";
      let terms: FieldTerms;
      if (field !== PRIMARY_FIELD) {
        let known = labels.get(text);
        if (!known) {
          known = fieldTerms(text, expand);
          labels.set(text, known);
        }
        terms = known;
      } else if (candidate.primaryText !== undefined && candidate.primaryTerms !== undefined) {
        terms = knownFieldTerms(text, candidate.primaryTerms, expand);
        primaryReaching = terms.reaching.map(({ token }) => token);
      } else {
        terms = fieldTerms(text, expand);
      }
      lengths[field] = terms.length;
      avgLengths[field] = (avgLengths[field]! * doc + terms.length) / (doc + 1);
      for (const { token, expansions, count } of terms.reaching) {
        held ??= new Map();
        let entry = held.get(token);
        if (!entry) {
          entry = { expansions, fields: [], freqs: [] };
          held.set(token, entry);
        }
        entry.fields.push(field);
        entry.freqs.push(count);
        const freqs = docFreqs[field]!;
        freqs.set(token, (freqs.get(token) ?? 0) + 1);
      }
    }
    if (held) holders.push({ doc, lengths: [...lengths], held, primaryReaching });
  }

  const docCount = candidates.length;
  const firstIndex = terms.map((term) => terms.indexOf(term));
  const add = (score: number, token: string, entry: HeldTerm, holder: Holder, weight: number) => {
    let sum = score;
    for (let k = 0; k < entry.fields.length; k++) {
      const field = entry.fields[k]!;
      const raw = bm25Plus(
        entry.freqs[k]!,
        docFreqs[field]!.get(token)!,
        docCount,
        holder.lengths[field]!,
        avgLengths[field]!,
      );
      sum += weight * BOOSTS[field]! * raw;
    }
    return sum;
  };

  const hits: RawHit[] = [];
  for (const holder of holders) {
    let total = 0;
    let quality = 0;
    for (let i = 0; i < terms.length; i++) {
      const term = terms[i]!;
      let sum = 0;
      let reached = false;
      const exact = holder.held.get(term);
      if (exact) {
        sum = add(sum, term, exact, holder, 1);
        reached = true;
      }
      for (const kind of LATER_KINDS) {
        for (const [token, entry] of holder.held) {
          if (token === term) continue;
          const expansion = entry.expansions.find((e) => e.term === i && e.kind === kind);
          if (!expansion) continue;
          sum = add(sum, token, entry, holder, expansion.weight);
          reached = true;
        }
      }
      if (!reached) continue;
      total += sum;
      if (firstIndex[i] === i) quality++;
    }
    hits.push({
      doc: holder.doc,
      score: total * quality,
      primaryReaching: holder.primaryReaching,
    });
  }
  hits.sort((a, b) => b.score - a.score || a.doc - b.doc);
  return hits;
}

// ── Matched-term and matched-field metadata ───────────────────────────

/** Whitespace as `tokenizeAll` splits on it. */
const WHITESPACE = /\s/;

/** Whether `token` (no whitespace) is a whitespace-delimited run of `text`. */
function holdsToken(text: string, token: string): boolean {
  let at = text.indexOf(token);
  while (at !== -1) {
    const end = at + token.length;
    const starts = at === 0 || WHITESPACE.test(text[at - 1]!);
    const ends = end === text.length || WHITESPACE.test(text[end]!);
    if (starts && ends) return true;
    at = text.indexOf(token, at + 1);
  }
  return false;
}

/**
 * Matched-term and matched-field metadata for hits, sharing one expander
 * over the query tokens. A query token matches a candidate token by the same
 * rule as scoring (exact, prefix when longer than three characters, or within
 * the mode's edit distance), so reported matched terms agree with what was
 * scored. `scoredWith` says the scores used this same expander, so a hit's
 * `primaryReaching` are its reaching tokens whenever its `tokens` are its
 * `primaryTerms`.
 */
function createHitMetadata(query: ParsedQuery, expand: Expander, scoredWith: boolean) {
  const labelTerms = new Map<string, readonly number[]>();
  const reachedBy = (label: string): readonly number[] => {
    let reached = labelTerms.get(label);
    if (!reached) {
      const indices = new Set<number>();
      for (const token of tokenize(label)) {
        for (const expansion of expand(token) ?? []) indices.add(expansion.term);
      }
      reached = [...indices];
      labelTerms.set(label, reached);
    }
    return reached;
  };

  /** Whether the field's tokens hold a term reaching a query token. `held`
   *  is the candidate's tokens that do; when `complete`, they include every
   *  such token of every field. */
  const fieldReached = (
    candidate: Candidate,
    text: string,
    held: readonly string[],
    complete: boolean,
  ): boolean => {
    if (text === candidate.rawText) return held.length > 0;
    if (complete && held.length === 0) return false;
    const lowered = tokenText(text);
    if (held.some((token) => holdsToken(lowered, token))) return true;
    if (complete) return false;
    return lowered.split(/\s+/).some((token) => token.length > 0 && expand(token) !== undefined);
  };

  return (candidate: Candidate, primaryReaching: readonly string[] | undefined) => {
    const reached = new Uint8Array(query.tokens.length);
    let held: readonly string[];
    if (scoredWith && primaryReaching && candidate.tokens === candidate.primaryTerms) {
      held = primaryReaching;
      for (const token of held) {
        for (const expansion of expand(token)!) reached[expansion.term] = 1;
      }
    } else {
      const found: string[] = [];
      for (const token of candidate.tokens) {
        const expansions = expand(token);
        if (!expansions) continue;
        found.push(token);
        for (const expansion of expansions) reached[expansion.term] = 1;
      }
      held = found;
    }
    // The searched fields beyond the text: directory, session title and tool name.
    for (const label of [candidate.directory, candidate.sessionTitle, candidate.toolName]) {
      if (label) for (const i of reachedBy(label)) reached[i] = 1;
    }
    const matchedTerms = query.tokens.filter((_, i) => reached[i] === 1);

    const complete = candidate.rawComplete === true;
    const fields = new Set<ResultWhy["matchedFields"][number]>();
    for (const field of candidate.fieldTexts) {
      if (fields.has(field.field)) continue;
      const lower = query.phrases.length > 0 ? field.text.toLowerCase() : "";
      const phraseMatched = query.phrases.some((phrase) => lower.includes(phrase));
      if (phraseMatched || fieldReached(candidate, field.text, held, complete)) {
        fields.add(field.field);
      }
    }
    return { matchedTerms, matchedFields: [...fields] };
  };
}

/**
 * Score candidates with BM25+ over the pool and return ranked hits.
 * Candidates MUST have stage-2 normalized fields populated (primaryText etc.).
 */
export function bm25Search(
  candidates: Candidate[],
  query: ParsedQuery,
  mode: Bm25Mode,
  explain: boolean,
): Bm25Hit[] {
  if (candidates.length === 0) return [];

  // Search terms come from the parsed query tokens (already normalized),
  // through the same tokenizer as the fields.
  const terms = tokenizeAll(query.tokens.join(" "));
  if (terms.length === 0) return [];
  const expand = createExpander(terms, mode);

  const rawHits = scorePool(candidates, terms, expand);
  if (rawHits.length === 0) return [];

  // Normalize BM25 scores to a 0..1 relative scale using the top score.
  const maxScore = rawHits[0]!.score || 1;

  const shared = sameTerms(terms, query.tokens);
  const metadataOf = createHitMetadata(
    query,
    shared ? expand : createExpander(query.tokens, mode),
    shared,
  );

  // Digest strings repeat across a session's candidates; check each once.
  const digestCovered = new Map<string, boolean>();

  const hits: Bm25Hit[] = [];
  for (const hit of rawHits) {
    const candidate = candidates[hit.doc]!;
    const base = clamp01(hit.score / maxScore);
    const reasons: string[] = [];
    if (explain) reasons.push(`BM25 relative score: ${base.toFixed(2)}`);

    let mult = 1;

    // Raw text lowercased once, only for the checks that read it.
    let rawLowerMemo: string | undefined;
    const rawLower = (): string => (rawLowerMemo ??= candidate.rawText.toLowerCase());

    // Exact phrase present in raw text.
    if (query.phrases.length > 0 && query.phrases.some((p) => rawLower().includes(p))) {
      mult *= EXACT_PHRASE_MULT;
      if (explain) reasons.push(`Exact phrase: ×${EXACT_PHRASE_MULT}`);
    }

    // Session-identity: the session's own statements/actions cover the query.
    if (candidate.digestText && query.tokens.length > 0) {
      let covered = digestCovered.get(candidate.digestText);
      if (covered === undefined) {
        const digestTokens = new Set(tokenize(candidate.digestText));
        const count = query.tokens.filter((token) => digestTokens.has(token)).length;
        covered = count * 2 >= query.tokens.length;
        digestCovered.set(candidate.digestText, covered);
      }
      if (covered) {
        mult *= DIGEST_MATCH_MULT;
        if (explain) reasons.push(`Session digest match: ×${DIGEST_MATCH_MULT}`);
      }
    }

    // Verbatim code-like compound token (case-insensitive).
    if (
      query.codeTokens.length > 0 &&
      query.codeTokens.some((token) => rawLower().includes(token.toLowerCase()))
    ) {
      mult *= EXACT_TOKEN_MULT;
      if (explain) reasons.push(`Exact code token: ×${EXACT_TOKEN_MULT}`);
    }

    const { matchedTerms, matchedFields } = metadataOf(candidate, hit.primaryReaching);
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
    if (candidate.partType === "tool" && lowerHasErrorPattern(rawLower())) {
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
      // Deliberately unclamped: clamping here would erase positive boosts at
      // the relative top (1.0 × 1.12 → 1.0), reducing them to tie-breaks.
      score: base * mult,
      matchedTerms,
      matchedFields,
      evidenceClass,
      matchReasons: explain ? reasons : [],
    });
  }

  hits.sort(compareHits);

  // Drop trailing noise from OR-combined weak single-term matches, but never
  // drop the only/best hit. The floor is relative to the BOOSTED top score:
  // internal scores are unclamped, so a fixed threshold would stop being
  // relative whenever multipliers push the top above 1.
  if (hits.length <= 1) return hits;
  const floor = hits[0]!.score * MIN_RELATIVE_SCORE;
  return hits.filter((h) => h.score >= floor);
}
