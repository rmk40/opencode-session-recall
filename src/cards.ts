import MiniSearch from "minisearch";
import type { Card, CardEmbeddingWrite } from "./store.js";
import type { ParsedQuery } from "./query.js";
import { normalize, tokenizeAll } from "./normalize.js";
import { embeddingTextOf, cardVectorStamp, EMBED_REPRESENTATION } from "./embedding-text.js";
import { isSummarizerTitle } from "./extract.js";
import { parentageOf } from "./authorship.js";
import { clamp01, recencyMultiplier } from "./bm25.js";
import { cosineSimilarity } from "./semantic/similarity.js";
import type { CandidateEmbedder } from "./corpus.js";
import type { DirectoryRelevance } from "./types.js";

/**
 * Tier-1 card runtime.
 *
 * Ranks whole sessions from their derived cards (the distiller's ~5MB summary
 * layer) so the query path never scans parts to build a shortlist. A MiniSearch
 * BM25 index over card fields (title, heads, inventory, error signatures, file
 * basenames) is rebuilt lazily from the store; each hit is then lifted by exact
 * code-token presence in the inventory, a recency prior, and — when enabled — a
 * semantic blend over card text. Metadata predicates (since/until, directory
 * scope, agent, current-session family exclusion) filter the ranked hits.
 *
 * This layer only SHORTLISTS which sessions to drill; final result ranking is
 * tier-2's job over the drilled parts. So generous recall here is correct: a
 * session that belongs in the answer must reach the shortlist, precision is the
 * drill's concern.
 */

/** Bounded ancestor walk + descendant collection, matching `exclusionFamily`. */
const MAX_FAMILY_DEPTH = 16;
/** Cards reload no more often than this, even as `cards_rev` advances. */
const REFRESH_INTERVAL_MS = 5_000;
/** Exact inventory code-token hit: the anchor agents actually query by. */
const CODE_TOKEN_MULT = 1.25;
/** Recency-only near-miss fallback size when nothing matches lexically. */
const NEAR_MISS_LIMIT = 12;

const CARD_FIELDS = [
  "title",
  "summary",
  "nlSummary",
  "outcome",
  "inventory",
  "errors",
  "files",
] as const;

const FIELD_BOOST: Record<(typeof CARD_FIELDS)[number], number> = {
  title: 1.0,
  summary: 1.6,
  // The LLM summary (Path B) is coherent prose about what the session did, so it
  // is the strongest lexical field when present.
  nlSummary: 1.8,
  outcome: 0.8,
  inventory: 2.0,
  errors: 1.2,
  files: 0.6,
};

type CardDoc = {
  id: string;
  title: string;
  summary: string;
  nlSummary: string;
  outcome: string;
  inventory: string;
  errors: string;
  files: string;
};

export type CardHit = {
  sessionId: string;
  score: number;
  card: Card;
  directoryRelevance: DirectoryRelevance;
  /** Pure semantic score (cosine-derived, 0..1) for this card, present only when
   *  the semantic layer is active for the query. Distinct from `score` (the
   *  lexical+semantic blend): the reserved-slot shortlist uses it to rank cards
   *  by semantic similarity alone, so a session the blend buries can still be
   *  guaranteed a drill slot. Undefined when semantic is off/unready. */
  semanticScore?: number;
};

export type CardFilters = {
  /** Keep cards with `timeUpdated >= since` (ms epoch). */
  since?: number;
  /** Keep cards with `timeUpdated <= until` (ms epoch). */
  until?: number;
  /** Exact agent match when set. */
  agent?: string;
  /** Directory scope. `exact` keeps only `directory`; `project` keeps the same
   *  project; `global` (default) keeps everything. */
  scope?: "exact" | "project" | "global";
  /** The caller's directory, for scope filtering and relevance labeling. */
  directory?: string;
  /** The caller's project id, for scope filtering and relevance labeling. */
  projectId?: string;
  /** Keep only cards in this directory (explicit `directory` arg). */
  directoryFilter?: string;
  /** Exclude the current session and its whole family (see {@link exclusionFamilyFromCards}). */
  excludeFamilyOf?: string;
  /** Declared as `never` so the ranking-only restriction cannot be smuggled in
   *  here; see {@link CardRankFilters}. */
  rootOnly?: never;
};

/**
 * {@link CardFilters} plus the ranking-only root restriction.
 *
 * The fence is a real type error, not an excess-property warning: `CardFilters`
 * declares `rootOnly?: never`, so a `CardRankFilters` VARIABLE (not just a
 * literal) is unassignable to the `CardFilters` parameter of
 * {@link CardsRuntime.list}, while a plain `CardFilters` still flows into
 * {@link CardsRuntime.rank}. `cards.list` backs the explicit-shortlist and deep
 * branches, which must never drop a session the caller named by id.
 */
export type CardRankFilters = Omit<CardFilters, "rootOnly"> & {
  /**
   * Drop cards whose parentage is positively a CHILD ({@link parentageOf}).
   * Root and unknown-parentage cards are kept: the restriction is fail-open at
   * selection and fail-closed at part-level filtering, and it reads parentage
   * through the same helper the classifier uses so the two cannot disagree.
   *
   * Distinct from {@link CardFilters.excludeFamilyOf}, which excludes one named
   * family and cannot express "roots only".
   *
   * Set by exactly one caller: the tier-1 ranking branch when `authorship`
   * normalizes to `{human}`. No candidate in a child session can classify
   * `human` (the classifier's parent rule fires before the root rule), so such
   * a session contributes zero results either way — dropping it at selection
   * frees a shortlist slot for a session that can.
   */
  rootOnly?: boolean;
};

/** Optional out-parameter for {@link CardsRuntime.rank}: what the ranking pass
 *  discarded, for coverage reporting. Filled only when the corresponding filter
 *  is set, and measured against the query's own contention set. */
export type RankStats = {
  /** Cards {@link CardRankFilters.rootOnly} removed that would OTHERWISE have
   *  ranked: they passed every other filter and carried a lexical or semantic
   *  signal. Cards are returned rather than a count so the caller can apply its
   *  own directory/scope bucketing, which `rank` does not see.
   *
   *  Each carries the score it WOULD have ranked with, computed identically to
   *  a real hit. The caller needs it because "had a signal" is far too loose to
   *  report on its own: with semantic ranking on, cosine similarity is mapped
   *  to [0,1] so essentially every card carries a nonzero score, and the raw
   *  count collapses to "every child session in the store" (measured: 4,488 of
   *  4,978 on a real corpus). The score is the input to the caller's estimate
   *  of which cards would have taken a shortlist slot; that estimate is
   *  explicitly approximate (see the counterfactual merge in `search.ts`). */
  rootOnlySkipped: Array<{ card: Card; score: number }>;
};

export type CardsCoverage = {
  totalCards: number;
  fullCards: number;
  /** Newest `timeUpdated` among distilled cards (0 when none). */
  storeRecency: number;
  degraded: boolean;
};

/** Semantic-layer diagnostics for the search coverage block. Present only when
 *  the semantic layer is configured on (an embedder plus a positive weight). */
export type SemanticStatus = {
  /** The embedder has finished loading; searches embed until then they stay lexical. */
  ready: boolean;
  /** Configured embedding model id (the clean id, without the representation
   *  stamp suffix). Undefined when no model id was configured (some tests). */
  model?: string;
  /** Blend weight for the semantic signal, 0..1. */
  weight: number;
  /** How many loaded cards currently have a computed vector. */
  cardsWithVectors: number;
  /** Representation generation this process embeds at
   *  ({@link EMBED_REPRESENTATION}). Surfaces in `coverage.semantic` so a
   *  mixed-version store is visible in tool output. */
  representation: number;
  /** Plugin build tag of this process (from {@link CardsRuntimeDeps.pluginVersion}),
   *  the same tag the distill lease records. Undefined when not configured. */
  pluginVersion?: string;
};

export type CardSource = {
  /** Snapshot of all cards. Pass `withEmbeddings` to include the persisted
   *  `embedding` BLOB — the semantic layer needs it to reuse card vectors; the
   *  lexical-only default omits it so no blobs load when semantic is off. */
  getCards: (opts?: { withEmbeddings?: boolean }) => Card[];
  /** Monotonic write revision (`cards_rev`); undefined for static/degraded. */
  revision: () => string | undefined;
  /** Monotonic vector-write revision (`meta.vectors_rev`); undefined for
   *  static/degraded or a store with no vector writes yet. Watched separately from
   *  `revision` because vector writes deliberately do not bump `cards_rev`; a
   *  change here means another process wrote/cleared vectors, so the in-memory
   *  snapshot must reload. */
  vectorsRevision?: () => string | undefined;
  /** True when cards are metadata-only (degraded, no store). */
  degraded?: boolean;
  /** The store's persisted semantic-model stamp (`meta.semantic_model`), or
   *  undefined with no store / no stamp yet. Gates card-vector reuse. */
  semanticModel?: () => string | undefined;
  /** Persist newly computed card vectors at representation generation `gen`, plus
   *  the model stamp. Absent in degraded mode (no store to write to). Each row
   *  carries the summary hash the vector was embedded from so the store can skip a
   *  row a concurrent summary write has since changed. Returns `{ revision,
   *  committed }` — the `vectors_rev` value after the call and whether it actually
   *  wrote — so the runtime can distinguish its own committed write from a foreign
   *  interleave (see {@link import("./store.js").Store.writeCardEmbeddings}). */
  writeEmbeddings?: (
    model: string,
    gen: number,
    rows: Array<{ sessionId: string; embedding: Uint8Array; expectedSummaryHash: string }>,
  ) => CardEmbeddingWrite;
};

export type CardsRuntimeDeps = {
  source: CardSource;
  embedder?: CandidateEmbedder;
  /** Blend weight for the semantic signal, 0..1. */
  semanticWeight?: number;
  /** Model id stamped on persisted card vectors. When it matches the store's
   *  stamp, vectors are reused across process starts instead of recomputed. */
  semanticModel?: string;
  /** Plugin build tag of this process, surfaced in `coverage.semantic.pluginVersion`
   *  (the same tag the distill lease records). Purely diagnostic. */
  pluginVersion?: string;
  /** Resolves when the embedder finishes loading (the embedder's init promise).
   *  Lets the runtime run one embed pass the moment the model is ready, so
   *  semantic activates on a warm store without waiting for a distill
   *  (`cards_rev`) bump. */
  semanticReady?: Promise<void>;
  now?: () => number;
  refreshIntervalMs?: number;
};

export type CardsRuntime = {
  rank(query: ParsedQuery, filters: CardRankFilters, stats?: RankStats): CardHit[];
  /** Every card passing the metadata filters (no query ranking), newest-first.
   *  The deep sweep uses this to enumerate its scoped session set — deep is
   *  exhaustive within scope, so it must not rank/prune by query. */
  list(filters: CardFilters): Card[];
  /** Single card by id from the loaded snapshot (undefined when unknown). Used
   *  to build deep targets from an explicit `sessions` list or a resume cursor. */
  get(sessionId: string): Card | undefined;
  exclusionFamily(currentSessionId: string): Set<string>;
  /** All cards whose `rootId` equals the given root (the root's family). */
  familyOf(rootId: string): Card[];
  coverage(): CardsCoverage;
  /** Semantic-layer diagnostics, or undefined when semantic is not configured on.
   *  Reflects live readiness and the current vector count. */
  semanticStatus(): SemanticStatus | undefined;
  /** Force the next card access to rebuild from the source, bypassing the
   *  refresh-interval gate. Production caller: the ephemeral cards-lite
   *  refresh controller after a successful list (lite-refresh.ts) — the sole
   *  rebuild signal for the lite source, whose `revision()` stays a pure
   *  `() => undefined`. Also used by tests. */
  invalidate(): void;
  /** Prevent deferred semantic warm-up from touching its source after shutdown. */
  dispose(): void;
};

function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function toDoc(card: Card): CardDoc {
  return {
    id: card.sessionId,
    title: normalize(card.title),
    summary: normalize(card.summaryHead),
    nlSummary: normalize(card.nlSummary),
    outcome: normalize(card.outcomeHead),
    // inventory is already a normalized-ish token stream; index it verbatim so
    // both split and whole code tokens survive.
    inventory: card.inventory,
    errors: normalize(card.errors.join(" ")),
    files: normalize(card.files.map(basename).join(" ")),
  };
}

/**
 * The current session's family within the card graph: ascend `parentId` to the
 * highest known ancestor (bounded, cycle-guarded), then collect that ancestor's
 * whole subtree via `rootId`. Produces the SAME set `search.ts`'s
 * `exclusionFamily()` derives from a discovery walk — so the default
 * self-exclusion keeps working without any part fetch. Exported for the
 * equivalence test.
 */
export function exclusionFamilyFromCards(cards: Card[], currentSessionId: string): Set<string> {
  const byId = new Map<string, Card>();
  const childrenByParent = new Map<string, string[]>();
  for (const card of cards) {
    byId.set(card.sessionId, card);
    if (card.parentId) {
      const siblings = childrenByParent.get(card.parentId);
      if (siblings) siblings.push(card.sessionId);
      else childrenByParent.set(card.parentId, [card.sessionId]);
    }
  }

  // Ascend to the top-most known ancestor.
  let root = currentSessionId;
  const seen = new Set([currentSessionId]);
  for (let depth = 0; depth < MAX_FAMILY_DEPTH; depth++) {
    const parentId = byId.get(root)?.parentId;
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    root = parentId;
  }

  // Collect the root's subtree (bounded, cycle-guarded).
  const family = new Set([currentSessionId, root]);
  let frontier = [root];
  for (let depth = 0; depth < MAX_FAMILY_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const childId of childrenByParent.get(id) ?? []) {
        if (family.has(childId)) continue;
        family.add(childId);
        next.push(childId);
      }
    }
    frontier = next;
  }
  return family;
}

/** Build metadata-only cards-lite for degraded mode (store unavailable). */
export function cardsLiteFromSessions(
  sessions: Array<{
    id: string;
    slug?: string;
    title?: string;
    directory?: string;
    projectID?: string;
    parentID?: string;
    time?: { created?: number; updated?: number };
  }>,
): Card[] {
  return sessions.map((s) => ({
    sessionId: s.id,
    parentId: typeof s.parentID === "string" ? s.parentID : null,
    rootId: s.id,
    title: s.title ?? "",
    slug: s.slug ?? "",
    directory: s.directory ?? "",
    projectId: s.projectID ?? "",
    agent: null,
    model: null,
    timeCreated: s.time?.created ?? 0,
    timeUpdated: s.time?.updated ?? 0,
    partCount: 0,
    retainedChars: 0,
    summaryHead: "",
    outcomeHead: "",
    inventory: "",
    files: [],
    tools: [],
    errors: [],
    familyRollup: [],
    distillState: "metadata",
    distilledThrough: null,
    embedding: null,
    embeddingGen: null,
    nlSummary: "",
    summaryHash: "",
  }));
}

const F32_BYTES = 4;

/** Serialize an L2-normalized vector to a store BLOB (native-endian float32
 *  bytes). The card store is a machine-local, rebuildable cache, so native byte
 *  order needs no portability handling. */
function vectorToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Reconstruct a vector from a store BLOB. Copies into a fresh, aligned buffer
 *  (SQLite blobs are not guaranteed 4-byte aligned) and drops any trailing
 *  bytes that don't complete a float. */
function blobToVector(blob: Uint8Array): Float32Array {
  const copy = blob.slice();
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / F32_BYTES));
}

/**
 * The `vectors_rev` value to cache after an embed pass, given the value sampled
 * BEFORE the snapshot load (`rev0`) and the store's write result (`write`, or
 * `undefined` when we did not call the write API). Trust the returned revision only
 * when the call actually COMMITTED and it is exactly `rev0 + 1` — proof that our
 * own write, and no foreign one, advanced the counter. A rejected write reports
 * `committed:false`, and its unchanged revision may coincide with a foreign
 * higher-gen write that already advanced `rev0` to `rev0 + 1`; keeping `rev0` in
 * that case forces the next refresh to reload and drop the stale snapshot.
 */
function ownWriteRevision(
  rev0: string | undefined,
  write: CardEmbeddingWrite | undefined,
): string | undefined {
  return write?.committed && write.revision === Number(rev0 ?? "0") + 1
    ? String(write.revision)
    : rev0;
}

export function createCardsRuntime(deps: CardsRuntimeDeps): CardsRuntime {
  const now = deps.now ?? Date.now;
  const refreshIntervalMs = deps.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
  const semanticWeight = deps.semanticWeight ?? 0;
  const embedder = deps.embedder;
  // The clean model id is what diagnostics report; the persisted-vector stamp
  // folds in the representation version so an embedding-input change recomputes
  // vectors once (see embedding-text.ts).
  const semanticModelId = deps.semanticModel;
  const configuredModel = semanticModelId != null ? cardVectorStamp(semanticModelId) : undefined;

  let cards: Card[] = [];
  let mini: MiniSearch<CardDoc> | undefined;
  let cardVectors: Map<string, Float32Array> | undefined;
  let lastLoad = -Infinity;
  let lastRevision: string | undefined;
  let lastVectorsRevision: string | undefined;
  let loaded = false;
  let disposed = false;

  /** Recompute/reuse card vectors and persist newly computed ones. Returns the
   *  store's `{ revision, committed }` result for the caller's own-write accounting,
   *  or `undefined` when it did not call the write API at all. */
  function embedCards(): CardEmbeddingWrite | undefined {
    if (!embedder || semanticWeight <= 0 || !embedder.ready) {
      // Semantic off, or the model is still warming (the query path also stays
      // lexical until the embedder is ready). Nothing to compute or persist.
      cardVectors = embedder && semanticWeight > 0 ? new Map() : undefined;
      return undefined;
    }

    // Reuse persisted vectors when the store's stamp matches this model. A card
    // whose vector was cleared by a re-distill (embedding null), or a model
    // change (stamp mismatch), falls through to recompute. Newly computed
    // vectors are written back under the model stamp so the next start reuses.
    const stampMatches =
      configuredModel != null && deps.source.semanticModel?.() === configuredModel;
    const vectors = new Map<string, Float32Array>();
    const toWrite: Array<{
      sessionId: string;
      embedding: Uint8Array;
      expectedSummaryHash: string;
    }> = [];

    for (const card of cards) {
      // Never embed a stray summarizer worker card (a crash can leave one in the
      // store); it is excluded from every result anyway.
      if (isSummarizerTitle(card.title)) continue;
      // Reuse a persisted vector only when the model stamp matches AND the row was
      // embedded at THIS process's generation. A null- or lower-generation row
      // (legacy, or written by an older build) is treated as absent and falls
      // through to recompute; the write guard then refuses to downgrade a higher-
      // generation row on disk, so a lagging process recomputes in memory without
      // clobbering the newer vector.
      if (stampMatches && card.embedding && card.embeddingGen === EMBED_REPRESENTATION) {
        vectors.set(card.sessionId, blobToVector(card.embedding));
        continue;
      }
      const text = embeddingTextOf(card);
      if (!text) continue;
      const vec = embedder.embed(text);
      if (!vec) continue;
      vectors.set(card.sessionId, vec);
      // Carry the summary hash the vector was embedded from, so the store skips
      // the write if a summary landed (and cleared the vector) since this snapshot.
      toWrite.push({
        sessionId: card.sessionId,
        embedding: vectorToBlob(vec),
        expectedSummaryHash: card.summaryHash,
      });
    }

    cardVectors = vectors;

    // Persist when anything was (re)computed, or when the stamp must advance to
    // this model so a later start reuses instead of recomputing. Accepted
    // cross-process race: this write can lose to a concurrent re-distill that
    // cleared the same card's embedding, leaving a one-generation-stale vector;
    // the next re-distill of that card clears it again, so it self-heals.
    if (
      configuredModel != null &&
      deps.source.writeEmbeddings &&
      (toWrite.length > 0 || !stampMatches)
    ) {
      return deps.source.writeEmbeddings(configuredModel, EMBED_REPRESENTATION, toWrite);
    }
    return undefined;
  }

  function rebuild(): void {
    // Sample the revision BEFORE snapshotting: a summary write (which bumps
    // cards_rev) that lands during this rebuild must leave the sampled revision
    // stale, so the next refresh reloads and picks the summary up. Sampling it
    // after embedding could swallow that bump and serve a summary-less snapshot.
    const revision = deps.source.revision();
    // Sample vectors_rev BEFORE the snapshot load too. embedCards returns the
    // store's { revision, committed } result; ownWriteRevision trusts it only when
    // the write COMMITTED and is exactly rev0+1 — i.e. our own write, with no
    // foreign vector write interleaved between this load and it. Otherwise it keeps
    // rev0, so the next refresh reloads and picks up the foreign write instead of
    // silently absorbing it (a rejected lower-gen write is committed:false, so its
    // unchanged revision can never masquerade as our own bump).
    const vectorsRev0 = deps.source.vectorsRevision?.();
    const wantEmbeddings = embedder != null && semanticWeight > 0;
    cards = wantEmbeddings
      ? deps.source.getCards({ withEmbeddings: true })
      : deps.source.getCards();
    const index = new MiniSearch<CardDoc>({
      idField: "id",
      fields: [...CARD_FIELDS],
      tokenize: (text: string) => tokenizeAll(text),
    });
    index.addAll(cards.map(toDoc));
    mini = index;
    const write = embedCards();
    lastLoad = now();
    lastRevision = revision;
    lastVectorsRevision = ownWriteRevision(vectorsRev0, write);
    loaded = true;
  }

  function refreshIfStale(): void {
    if (!loaded) {
      rebuild();
      return;
    }
    if (now() - lastLoad < refreshIntervalMs) return;
    const revision = deps.source.revision();
    // Either a lexical write (cards_rev, from distill/summary) or a cross-process
    // vector write (vectors_rev) invalidates the snapshot. The latter is the fix
    // for silently-stale vector snapshots across processes sharing one store.
    const vectorsRevision = deps.source.vectorsRevision?.();
    if (revision !== lastRevision || vectorsRevision !== lastVectorsRevision) rebuild();
    else lastLoad = now(); // nothing changed; defer the next revision check
  }

  function directoryRelevance(
    card: Card,
    // Only the two labeling fields — accepting the narrow shape keeps this
    // usable from both the rank and list paths despite the `rootOnly` fence.
    filters: Pick<CardFilters, "directory" | "projectId">,
  ): DirectoryRelevance {
    if (filters.directory && card.directory === filters.directory) return "exact";
    if (filters.projectId && card.projectId === filters.projectId) return "project";
    if (!card.directory && !card.projectId) return "unknown";
    return "global";
  }

  function passesFilters(card: Card, filters: CardRankFilters, excluded: Set<string>): boolean {
    // A summarizer worker card (a crash can leave one persisted) is never a
    // result; centralize the exclusion here so rank() and list() both honor it.
    if (isSummarizerTitle(card.title)) return false;
    if (excluded.has(card.sessionId)) return false;
    // Roots-only selection (authorship:{human}); never set by list() callers
    // (the type fence on CardRankFilters enforces that). Parentage is read
    // through the SAME helper the authorship classifier uses, so a degenerate
    // value cannot be a child here and a human there.
    if (filters.rootOnly && parentageOf(card.parentId) === "child") return false;
    if (filters.since != null && card.timeUpdated < filters.since) return false;
    if (filters.until != null && card.timeUpdated > filters.until) return false;
    if (filters.agent && card.agent !== filters.agent) return false;
    if (filters.directoryFilter && card.directory !== filters.directoryFilter) return false;
    const scope = filters.scope ?? "global";
    if (scope === "exact" && filters.directory && card.directory !== filters.directory)
      return false;
    if (scope === "project" && filters.projectId && card.projectId !== filters.projectId) {
      return false;
    }
    return true;
  }

  function lexicalHits(query: ParsedQuery): Map<string, number> {
    if (!mini) return new Map();
    const queryText = query.tokens.join(" ");
    if (queryText.trim().length === 0) return new Map();
    const raw = mini.search(queryText, {
      fields: [...CARD_FIELDS],
      boost: FIELD_BOOST,
      combineWith: "OR",
      prefix: (term) => term.length > 3,
      fuzzy: (term) => (term.length >= 4 ? 0.2 : false),
    });
    const top = raw[0]?.score || 1;
    const scores = new Map<string, number>();
    for (const hit of raw) scores.set(String(hit.id), clamp01(hit.score / top));
    return scores;
  }

  function semanticScore(query: ParsedQuery): Map<string, number> {
    const scores = new Map<string, number>();
    if (!embedder || !cardVectors || semanticWeight <= 0 || !embedder.ready) return scores;
    const queryVec = embedder.embed(query.raw);
    if (!queryVec) return scores;
    for (const [sessionId, vec] of cardVectors) {
      scores.set(sessionId, clamp01((cosineSimilarity(queryVec, vec) + 1) / 2));
    }
    return scores;
  }

  // Warm-store activation: when the embedder is still loading, hook its init
  // completion to run one embed pass the moment it is ready, so semantic turns
  // on without waiting for a distill (`cards_rev`) bump. Single-flight: the init
  // promise resolves once, and the pass is skipped when vectors already exist or
  // no snapshot is loaded yet (the next query then rebuilds and embeds).
  if (embedder && semanticWeight > 0 && deps.semanticReady) {
    void deps.semanticReady.then(() => {
      if (disposed || !embedder.ready || !loaded) return;
      if (cardVectors && cardVectors.size > 0) return;
      // Deliberately leave lastVectorsRevision untouched: this pass writes vectors
      // (bumping vectors_rev past the cached value), so the next refresh reloads
      // once and reconciles through rebuild()'s accounting. Caching a value here
      // could absorb a foreign write that landed since the last snapshot.
      embedCards();
    });
  }

  return {
    dispose(): void {
      disposed = true;
    },

    rank(query, filters, stats): CardHit[] {
      refreshIfStale();
      const excluded = filters.excludeFamilyOf
        ? exclusionFamilyFromCards(cards, filters.excludeFamilyOf)
        : new Set<string>();

      const lexical = lexicalHits(query);
      const semantic = semanticScore(query);
      const codeTokens = query.codeTokens.map((t) => t.toLowerCase());

      // Attribution for the rootOnly skip count: the same filters with the
      // restriction lifted, so a card that also fails a time bound or a scope
      // is never blamed on authorship. Hoisted — one allocation, not one per card.
      const withoutRootOnly: CardRankFilters | undefined =
        stats && filters.rootOnly ? { ...filters, rootOnly: false } : undefined;

      // One scoring definition, shared by real hits and by the rootOnly skip
      // accounting, so a skipped card's score is comparable to a hit's.
      const scoreOf = (card: Card, lex: number, sem: number): number => {
        let score = semantic.size > 0 ? (1 - semanticWeight) * lex + semanticWeight * sem : lex;
        if (codeTokens.length > 0) {
          const inventoryLower = card.inventory.toLowerCase();
          if (codeTokens.some((token) => inventoryLower.includes(token))) score *= CODE_TOKEN_MULT;
        }
        return score * recencyMultiplier(card.timeUpdated);
      };

      const hits: CardHit[] = [];
      for (const card of cards) {
        if (!passesFilters(card, filters, excluded)) {
          // Count only cards the restriction ALONE removed and that would have
          // become hits: the contention set every other skippedByReason key is
          // measured against. The near-miss fallback below is deliberately not
          // counted (those cards have no signal, so they were never contending).
          if (withoutRootOnly && passesFilters(card, withoutRootOnly, excluded)) {
            const skippedLex = lexical.get(card.sessionId) ?? 0;
            const skippedSem = semantic.get(card.sessionId) ?? 0;
            if (skippedLex > 0 || skippedSem > 0) {
              // Same score a real hit would get, so the caller can rank these
              // against the hits and keep only the ones that would have taken a
              // shortlist slot. See RankStats for why the bare count is useless.
              stats!.rootOnlySkipped.push({ card, score: scoreOf(card, skippedLex, skippedSem) });
            }
          }
          continue;
        }
        const lex = lexical.get(card.sessionId) ?? 0;
        const sem = semantic.get(card.sessionId) ?? 0;
        if (lex <= 0 && sem <= 0) continue;

        const score = scoreOf(card, lex, sem);
        hits.push({
          sessionId: card.sessionId,
          score,
          card,
          directoryRelevance: directoryRelevance(card, filters),
          ...(semantic.size > 0 && { semanticScore: sem }),
        });
      }

      hits.sort((a, b) => b.score - a.score || b.card.timeUpdated - a.card.timeUpdated);
      if (hits.length > 0) return hits;

      // No lexical/semantic signal: fall back to recency-ranked near-misses so a
      // broad paraphrase still returns something honest (labeled by the caller).
      return cards
        .filter((card) => passesFilters(card, filters, excluded))
        .sort((a, b) => b.timeUpdated - a.timeUpdated)
        .slice(0, NEAR_MISS_LIMIT)
        .map((card) => ({
          sessionId: card.sessionId,
          score: 0,
          card,
          directoryRelevance: directoryRelevance(card, filters),
        }));
    },

    list(filters): Card[] {
      refreshIfStale();
      const excluded = filters.excludeFamilyOf
        ? exclusionFamilyFromCards(cards, filters.excludeFamilyOf)
        : new Set<string>();
      return cards
        .filter((card) => passesFilters(card, filters, excluded))
        .sort((a, b) => b.timeUpdated - a.timeUpdated || a.sessionId.localeCompare(b.sessionId));
    },

    get(sessionId): Card | undefined {
      refreshIfStale();
      const card = cards.find((c) => c.sessionId === sessionId);
      // A worker card is never a valid drill/deep target (see passesFilters).
      return card && !isSummarizerTitle(card.title) ? card : undefined;
    },

    exclusionFamily(currentSessionId): Set<string> {
      refreshIfStale();
      return exclusionFamilyFromCards(cards, currentSessionId);
    },

    familyOf(rootId): Card[] {
      refreshIfStale();
      return cards.filter((card) => card.rootId === rootId);
    },

    coverage(): CardsCoverage {
      refreshIfStale();
      let full = 0;
      let recency = 0;
      for (const card of cards) {
        if (card.distillState === "full") {
          full++;
          if (card.timeUpdated > recency) recency = card.timeUpdated;
        }
      }
      return {
        totalCards: cards.length,
        fullCards: full,
        storeRecency: recency,
        degraded: deps.source.degraded === true,
      };
    },

    semanticStatus(): SemanticStatus | undefined {
      if (!embedder || semanticWeight <= 0) return undefined;
      refreshIfStale();
      return {
        ready: embedder.ready,
        ...(semanticModelId != null && { model: semanticModelId }),
        weight: semanticWeight,
        cardsWithVectors: cardVectors?.size ?? 0,
        representation: EMBED_REPRESENTATION,
        ...(deps.pluginVersion != null && { pluginVersion: deps.pluginVersion }),
      };
    },

    invalidate(): void {
      loaded = false;
    },
  };
}
