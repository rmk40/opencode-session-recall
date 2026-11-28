import MiniSearch from "minisearch";
import {
  CARDS_REV_KEY,
  SEMANTIC_MODEL_KEY,
  VECTORS_REV_KEY,
  type Card,
  type CardCounters,
  type CardVectorRow,
  type Store,
} from "./store.js";
import type { ParsedQuery } from "./query.js";
import { normalize, tokenizeAll } from "./normalize.js";
import { embeddingTextOf, cardVectorStamp, EMBED_REPRESENTATION } from "./embedding-text.js";
import { isSummarizerTitle } from "./extract.js";
import { parentageOf } from "./authorship.js";
import { clamp01, recencyMultiplier } from "./bm25.js";
import { cosineSimilarity } from "./semantic/similarity.js";
import type { CandidateEmbedder } from "./corpus.js";
import type { DirectoryRelevance } from "./types.js";
import { SLICE_MS, yieldOnBudget } from "./yield.js";
import { SqliteBusyError } from "./sqlite.js";

/**
 * Tier-1 card runtime.
 *
 * Ranks whole sessions from their derived cards (the distiller's ~5MB summary
 * layer) so the query path never scans parts to build a shortlist. A MiniSearch
 * BM25 index over card fields (title, heads, inventory, error signatures, file
 * basenames) is kept in step with the store; each hit is then lifted by exact
 * code-token presence in the inventory, a recency prior, and — when enabled — a
 * semantic blend over card text. Metadata predicates (since/until, directory
 * scope, agent, current-session or family exclusion) filter the ranked hits.
 *
 * The runtime keeps two layers. The metadata layer is a map of every card,
 * which `list`, `get`, `exclusionFamily`, `familyOf`, `coverage` and
 * `semanticStatus` read. The index layer (the MiniSearch index and the card
 * vectors) is brought up to date only by `rank` and `ready({ index: true })`.
 * With a store-backed source ({@link CardSource.store}) a refresh reads the
 * revision counters and applies only the cards stamped since the last refresh.
 * The index then swaps each changed card's document (`remove` then `add`, which
 * keeps term frequencies exact). The map is loaded in full on a cold start,
 * when a revision counter goes backwards and when an older build's unstamped
 * writes widen the gap between `cards_rev` and `cards_stamped`. The index is
 * built in full when there is none yet or when more cards changed than
 * swapping them one by one is worth (more than 64 and more than half the
 * index). A full load reads in keyset pages and a build indexes in time
 * slices, yielding to the event loop once a slice of work has run, so neither
 * holds it for long.
 *
 * Vectors a build, a vector reload or an in-place update computes are
 * persisted after the index and vectors are installed, by a write queue of
 * their own with at most one write in flight ({@link CardSource.writeEmbeddings}).
 * Nothing that serves a search awaits it.
 *
 * This layer only SHORTLISTS which sessions to drill; final result ranking is
 * tier-2's job over the drilled parts. So generous recall here is correct: a
 * session that belongs in the answer must reach the shortlist, precision is the
 * drill's concern.
 */

/** Bounded ancestor walk + descendant collection, matching `exclusionFamily`. */
const MAX_FAMILY_DEPTH = 16;
/** The store is checked for changes no more often than this. */
const REFRESH_INTERVAL_MS = 5_000;
/** After a synchronous refresh found the store locked, the synchronous
 *  accessors serve what they hold for this long before they read again. */
const BUSY_SERVE_MS = 250;
/** Cards per keyset page of a full load and per `cardsSince` page. A page is
 *  read in one synchronous step, so it stays small enough to read (vectors
 *  included) in a few milliseconds; the load yields between pages once a
 *  slice of work has run. */
const LOAD_PAGE = 250;
/** Card vectors persisted per vector write. */
const VECTOR_WRITE_CHUNK = 200;
/** Changed cards a synchronous `rank` applies to the index in place; more run
 *  as a chunked build while the current index serves. */
const MAX_SYNC_DOCS = 64;
/** Builds one `ready()` call waits for before it settles for the current state,
 *  so a store that keeps changing cannot hold a caller forever. */
const MAX_READY_ROUNDS = 8;
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

/**
 * `since` and `until` keep the sessions that overlap the window between them:
 * one last updated at or after `since` and created at or before `until`. A
 * session that kept running past `until` stays in, since its messages inside
 * the window are as findable as any other's; the drill reads toward the
 * window and the per-message filters apply it exactly.
 */
export type CardFilters = {
  /** Keep cards with `timeUpdated >= since` (ms epoch). */
  since?: number;
  /** Keep cards with `timeCreated <= until` (ms epoch). */
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
  /** Exclude this one session and nothing else, so its parent, siblings and
   *  subagents stay in. With {@link excludeFamilyOf} both apply. */
  excludeSessionId?: string;
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
  /** Cards that passed every filter but were left out unscored because the
   *  index had yet to take their current content (an index update was still
   *  running). Set by every `rank` call given this object. */
  pending?: number;
  /** Cards the exclusion filters ({@link CardFilters.excludeSessionId},
   *  {@link CardFilters.excludeFamilyOf}) alone removed that matched the query
   *  lexically, in session-id order: the ones the caller's exclusion arguments
   *  would let back in. Cards are returned, like {@link rootOnlySkipped}, so
   *  the caller can apply the selection guards `rank` does not see. A semantic
   *  score alone does not count, since nearly every card carries one. Set
   *  only when an exclusion filter is. */
  excludedMatched?: Card[];
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
  /** How many cards had a computed vector as of the last index update. */
  cardsWithVectors: number;
  /** Representation generation this process embeds at
   *  ({@link EMBED_REPRESENTATION}). Surfaces in `coverage.semantic` so a
   *  mixed-version store is visible in tool output. */
  representation: number;
  /** Plugin build tag of this process (from {@link CardsRuntimeDeps.pluginVersion}),
   *  the same tag the distill lease records. Undefined when not configured. */
  pluginVersion?: string;
};

/**
 * The store reads a store-backed {@link CardSource} offers so the runtime can
 * apply changes incrementally. Each maps onto one {@link Store} read (see
 * {@link storeCardSource}).
 */
export type CardStoreReads = {
  /** The revision counters, read in one statement that touches no card
   *  ({@link Store.cardCounters}). Read at every refresh check, so it must
   *  stay as cheap however many cards the store holds. Counts the runtime
   *  reports come from its own card map. */
  stats: () => CardCounters;
  /** Cards stamped after revision `rev`, oldest first ({@link Store.cardsSince}). */
  cardsSince: (rev: number, limit: number, opts?: { withEmbeddings?: boolean }) => Card[];
  /** Every card's session id. */
  cardIds: () => string[];
  /** Cards in session-id order after `after` ({@link Store.cardsPage}). */
  cardsPage: (
    after: string | undefined,
    limit: number,
    opts?: { withEmbeddings?: boolean },
  ) => Card[];
  /** Persisted card vectors in session-id order after `after`
   *  ({@link Store.cardVectorsPage}). */
  vectorsPage: (after: string | undefined, limit: number) => CardVectorRow[];
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
   *  vectors must reload. */
  vectorsRevision?: () => string | undefined;
  /**
   * Store reads for incremental refreshes. With them the runtime applies only
   * what changed since its last refresh (see the module comment) and reads its
   * counters from `stats` rather than `revision`. Without them (cards-lite and
   * static sources) any change to `revision()` or `vectorsRevision()`, or an
   * `invalidate()`, reloads every card before the next access.
   */
  store?: CardStoreReads;
  /** True when cards are metadata-only (degraded, no store). */
  degraded?: boolean;
  /** The store's persisted semantic-model stamp (`meta.semantic_model`), or
   *  undefined with no store / no stamp yet. Gates card-vector reuse. */
  semanticModel?: () => string | undefined;
  /** Persists newly computed card vectors (see {@link CardVectorWriter}).
   *  Absent in degraded mode, and for a store this process may not write. */
  writeEmbeddings?: CardVectorWriter;
};

/** One card vector to persist: the card's session id, the vector's bytes and
 *  the summary hash the vector was embedded from, so the store can skip a row
 *  a concurrent summary write has changed since. */
export type CardVectorWriteRow = {
  sessionId: string;
  embedding: Uint8Array;
  expectedSummaryHash: string;
};

/**
 * What one vector write reported.
 *
 * - `committed`: the write committed, and `revision` is `vectors_rev` right
 *   after it.
 * - `refused`: the store declined it and wrote nothing, as it does a write at
 *   a lower representation generation than a stored vector's.
 * - `failed`: it did not run or its outcome is unknown, such as a thrown
 *   error, a writer that stopped or an acknowledgement that never came.
 *
 * Only `committed` may move the runtime's view of `vectors_rev`, and only by
 * the one revision the write itself made ({@link CardsRuntime}).
 */
export type CardVectorWriteResult =
  | { status: "committed"; revision: number }
  | { status: "refused"; reason: string }
  | { status: "failed"; error: string };

/**
 * Persists card vectors at representation generation `gen` under the model
 * stamp `model`, the way {@link Store.writeCardEmbeddings} does: one write,
 * which also stamps the model (clearing every stored vector first when the
 * stamp changes). The promise must settle for every call, with `failed` when
 * the outcome cannot be known. Each row's `embedding` is a buffer of its own,
 * which the writer may transfer to another thread. The runtime issues the
 * next write only once the last one has settled.
 */
export type CardVectorWriter = (
  model: string,
  gen: number,
  rows: CardVectorWriteRow[],
) => Promise<CardVectorWriteResult>;

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
  /** Awaited between the steps of a chunked build (a page read, a slice of
   *  indexing) and between two vector writes. Default: {@link yieldOnBudget},
   *  which yields to the event loop once a slice of work has run, so other
   *  work runs in between. */
  yieldBetween?: () => Promise<void>;
  /** Receives a line when vector writes of one pass failed or were refused. */
  log?: (line: string) => void;
};

export type CardsRuntime = {
  /**
   * Resolves once the card map is loaded and current, and with `index` also
   * the search index and card vectors. A cold or full load runs in chunks
   * that yield to the event loop; an async caller awaits this so its later
   * synchronous calls find everything built. Without `index` it never waits
   * on index or vector work, which may still be running when it resolves.
   * It never waits on a vector write: persisting vectors runs after they are
   * installed ({@link flushVectorWrites}). Rejects when a load fails.
   */
  ready(opts?: { index?: boolean }): Promise<void>;
  /**
   * Resolves `true` once no vector write is queued or in flight, or `false`
   * when `deadlineMs` milliseconds pass first (no bound when undefined).
   * Writes queued before the call keep being issued until then, unless the
   * runtime is disposed: from then on only the write in flight is waited for,
   * and the queue is dropped. For a shutdown that must not outlast a bound,
   * and for tests.
   */
  flushVectorWrites(deadlineMs?: number): Promise<boolean>;
  /** Rank cards against a query over the current index, updating the index
   *  first. Synchronous: while a chunked build runs it ranks over the index it
   *  had and leaves out every card the index has yet to take, so no hit is
   *  scored on a document its card no longer has; with no index at all it
   *  builds one in place. */
  rank(query: ParsedQuery, filters: CardRankFilters, stats?: RankStats): CardHit[];
  /** Every card passing the metadata filters (no query ranking), newest-first.
   *  The deep sweep uses this to enumerate its scoped session set — deep is
   *  exhaustive within scope, so it must not rank/prune by query. */
  list(filters: CardFilters): Card[];
  /** Single card by id from the card map (undefined when unknown). Used
   *  to build deep targets from an explicit `sessions` list or a resume cursor. */
  get(sessionId: string): Card | undefined;
  exclusionFamily(currentSessionId: string): Set<string>;
  /** All cards whose `rootId` equals the given root (the root's family). */
  familyOf(rootId: string): Card[];
  coverage(): CardsCoverage;
  /** Semantic-layer diagnostics, or undefined when semantic is not configured on.
   *  Reflects live readiness and the vector count as of the last index update. */
  semanticStatus(): SemanticStatus | undefined;
  /** Force the next card access to reload from the source, bypassing the
   *  refresh-interval gate; until it has, no access serves the old cards.
   *  Production caller: the ephemeral cards-lite refresh controller after a
   *  successful list (lite-refresh.ts) — the sole rebuild signal for the lite
   *  source, whose `revision()` stays a pure `() => undefined`. Also used by
   *  tests. */
  invalidate(): void;
  /** Prevent deferred semantic warm-up and every vector write not yet issued
   *  from touching the source after shutdown. A write already in flight
   *  settles on its own ({@link flushVectorWrites}). */
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
 * whole subtree through `parentId` links. Produces the SAME set `search.ts`'s
 * `exclusionFamily()` derives from a discovery walk — so family exclusion
 * (recall's `excludeFamily`, the v1 hooks) and recall's family diversity work
 * without any part fetch. Exported for the equivalence test.
 */
export function exclusionFamilyFromCards(
  cards: Iterable<Card>,
  currentSessionId: string,
): Set<string> {
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

  // Collect the root's subtree (bounded, cycle-guarded). Seeded with the root
  // alone, so a current session below it is reached as a child and its own
  // subagents are collected too; it is added afterwards for the cycle and
  // depth-cap cases the walk does not reach it in.
  const family = new Set([root]);
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
  family.add(currentSessionId);
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
 * The `vectors_rev` value to cache once one of this runtime's own vector
 * writes is acknowledged, given the cached value at that moment (`seen`) and
 * the write's result. Trust the reported revision only when the write
 * COMMITTED and it is exactly `seen + 1`: proof that this write, and no
 * foreign one, moved the counter past what the in-memory vectors reflect. A
 * refused or failed write moves nothing; its unchanged revision could
 * coincide with a foreign write that already moved the counter, and keeping
 * `seen` makes the next refresh reload the vectors instead of absorbing that
 * write. Applied once per acknowledgement, in order (one write is in flight
 * at a time), so a pass written in several chunks stays exact.
 */
function ownWriteRevision(seen: number, write: CardVectorWriteResult): number {
  return write.status === "committed" && write.revision === seen + 1 ? write.revision : seen;
}

/** A writer's result as one of the three {@link CardVectorWriteResult}s; any
 *  other value is a failed write. */
function asWriteResult(value: unknown): CardVectorWriteResult {
  const result = value as Partial<Record<string, unknown>> | null | undefined;
  if (result?.status === "committed" && typeof result.revision === "number") {
    return { status: "committed", revision: result.revision };
  }
  if (result?.status === "refused") {
    return { status: "refused", reason: String(result.reason ?? "refused") };
  }
  if (result?.status === "failed") return { status: "failed", error: String(result.error ?? "") };
  return { status: "failed", error: "the writer returned no result" };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A vectors-revision counter value as a number; 0 when unset. */
function revisionNumber(value: string | undefined): number {
  return Number(value ?? 0) || 0;
}

/** Runs a build to completion in one synchronous slice. */
function runSync(steps: Generator<void, void>): void {
  while (!steps.next().done);
}

/** Session ids in a fixed order, the last tiebreak of every card sort. */
function compareIds(a: string, b: string): number {
  return a.localeCompare(b);
}

/** Newest first, then by session id. */
function byRecency(a: Card, b: Card): number {
  return b.timeUpdated - a.timeUpdated || compareIds(a.sessionId, b.sessionId);
}

function sameDoc(a: CardDoc | undefined, b: CardDoc | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.title === b.title &&
    a.summary === b.summary &&
    a.nlSummary === b.nlSummary &&
    a.outcome === b.outcome &&
    a.inventory === b.inventory &&
    a.errors === b.errors &&
    a.files === b.files
  );
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Whether two versions of a card index and embed alike: every field the
 *  search document ({@link toDoc}) and the embedded text
 *  ({@link embeddingTextOf}) are made of. */
function sameIndexedContent(a: Card, b: Card): boolean {
  return (
    a.title === b.title &&
    a.summaryHead === b.summaryHead &&
    a.outcomeHead === b.outcomeHead &&
    a.nlSummary === b.nlSummary &&
    a.inventory === b.inventory &&
    a.directory === b.directory &&
    sameStrings(a.files, b.files) &&
    sameStrings(a.tools, b.tools) &&
    sameStrings(a.errors, b.errors)
  );
}

/** A vector a pass queued to persist, with the card version it belongs to. */
type QueuedVector = {
  sessionId: string;
  vector: Float32Array;
  expectedSummaryHash: string;
  card: Card;
};

/** One semantic pass: the vectors it sets, the card version each vector was
 *  computed or loaded for, the rows it queued to persist, and whether the
 *  store's model stamp is this model's (when it is not, a write restamps the
 *  store and clears every stored vector, so the pass persists all it keeps). */
type VectorPass = {
  vectors: Map<string, Float32Array>;
  sources: Map<string, Card>;
  rows: QueuedVector[];
  stampMatches: boolean;
};

/** One pass's vectors waiting to be written, `next` being the first row not
 *  yet taken; `restamp` when the pass found another model's stamp, so its
 *  first write restamps the store even with no row left to write. */
type WriteBatch = { rows: QueuedVector[]; next: number; restamp: boolean };

/** A stored vector as read with its card or its row, and the model stamp it
 *  was stored under (undefined when that could not be established). */
type StoredVector = {
  embedding: Uint8Array | null;
  embeddingGen: number | null;
  stamp: string | undefined;
};

/** The store reads a store-backed {@link CardSource} makes, and no write. */
export type CardSourceStore = Pick<
  Store,
  | "allCards"
  | "getMeta"
  | "cardCounters"
  | "cardsSince"
  | "cardSessionIds"
  | "cardsPage"
  | "cardVectorsPage"
>;

/**
 * A {@link CardVectorWriter} that writes through `store` on the calling
 * thread, at the call ({@link Store.writeCardEmbeddings}), and returns its
 * outcome as a settled promise.
 */
export function inlineVectorWriter(store: Pick<Store, "writeCardEmbeddings">): CardVectorWriter {
  return (model, gen, rows) => {
    try {
      const write = store.writeCardEmbeddings(model, gen, rows);
      return Promise.resolve(
        write.committed
          ? { status: "committed", revision: write.revision }
          : { status: "refused", reason: "a stored vector has a higher representation generation" },
      );
    } catch (error) {
      return Promise.resolve({ status: "failed", error: errorText(error) });
    }
  };
}

/**
 * Store-backed {@link CardSource}: the plugin's card source whenever a card
 * store is open, with the reads incremental refreshes need. It reads through
 * `store` and persists vectors only through `writeVectors`; without one the
 * runtime keeps the vectors it computes in memory and writes none.
 */
export function storeCardSource(
  store: CardSourceStore,
  writeVectors: CardVectorWriter | undefined,
): CardSource {
  return {
    getCards: (opts) => store.allCards(opts),
    revision: () => store.getMeta(CARDS_REV_KEY),
    vectorsRevision: () => store.getMeta(VECTORS_REV_KEY),
    semanticModel: () => store.getMeta(SEMANTIC_MODEL_KEY),
    ...(writeVectors && { writeEmbeddings: writeVectors }),
    store: {
      stats: () => store.cardCounters(),
      cardsSince: (rev, limit, opts) => store.cardsSince(rev, limit, opts),
      cardIds: () => store.cardSessionIds(),
      cardsPage: (after, limit, opts) => store.cardsPage(after, limit, opts),
      vectorsPage: (after, limit) => store.cardVectorsPage(after, limit),
    },
  };
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
  const yieldBetween = deps.yieldBetween ?? yieldOnBudget;
  const source = deps.source;
  const reads = source.store;
  /** Semantic is configured on: vectors are kept, though the embedder may
   *  still be loading. */
  const semanticOn = embedder != null && semanticWeight > 0;
  const cardOpts = semanticOn ? { withEmbeddings: true } : undefined;

  // Builds and the requests they answer are ordered by one counter: a build
  // started at tick t satisfies every request made before t, and installs only
  // over a state built from an older start.
  let clock = 0;
  const tick = (): number => ++clock;

  // ── Metadata layer ──
  let cardById = new Map<string, Card>();
  /** Start tick of the load the map came from; 0 before the first load. */
  let metaInstalledAt = 0;
  /** Latest request for a full load (soft: the current map may still serve). */
  let metaWantFull = 0;
  /** Latest request no access may be served before (cold, invalidated, or a
   *  revision change on a source without store reads). */
  let metaWantHard = 0;
  let lastCheck = -Infinity;
  /** Store counters as of the last applied refresh (store-backed sources). */
  let counters: CardCounters | undefined;
  /** Highest `writeRev` applied; `cardsSince` resumes after it. */
  let appliedRev = 0;
  /** `revision()` as of the last load (sources without store reads). */
  let installedRevision: string | undefined;
  let coverageCache: CardsCoverage | undefined;

  /** The model stamp each map card's `embedding` was stored under, recorded
   *  only when the read that returned the card saw no vector write land (see
   *  {@link stampedRead}). A blob without one is never reused. */
  const blobStamp = new WeakMap<Card, string>();

  // ── Index layer ──
  let mini: MiniSearch<CardDoc> | undefined;
  /** Exactly the documents in `mini`, so a changed card can be removed. */
  let docById = new Map<string, CardDoc>();
  let cardVectors: Map<string, Float32Array> | undefined;
  /** The card version each in-memory vector was computed or loaded for. */
  let vectorSource = new Map<string, Card>();
  /** Start tick of the build `mini` came from; 0 before the first build. */
  let indexInstalledAt = 0;
  /** A hard load changed the map: a synchronous `rank` may not serve the
   *  index until it caught up. */
  let hardIndexPending = false;
  /** Tick at which the last hard load installed its map. */
  let hardLoadInstalledAt = 0;
  /** Ids whose card changed (or left) in the map since the index took them:
   *  exactly the cards whose indexed document or vector may be out of date. */
  const dirty = new Set<string>();
  /** The vectors were computed by a full pass with the embedder ready, so a
   *  per-card update keeps them complete. */
  let vectorsComplete = false;
  /** Another process wrote vectors since they were read: reload them. */
  let vectorsStale = false;
  /** `vectors_rev` reflected in memory: sampled before the vectors were read,
   *  then advanced only by this runtime's own acknowledged writes
   *  ({@link ownWriteRevision}). */
  let vectorsRevSeen = 0;

  // ── Vector persistence ──
  /** Passes whose vectors wait to be written, oldest first. */
  const writeQueue: WriteBatch[] = [];
  /** The row each session was last queued with; an older one still queued
   *  for the same session is skipped. */
  const latestQueued = new Map<string, QueuedVector>();
  /** The loop issuing {@link writeQueue}'s writes, one at a time. */
  let writeRunner: Promise<void> | undefined;
  /** A write was issued and has not been acknowledged. */
  let writeInFlight = false;
  /** The highest `vectors_rev` a refresh read while a write was in flight,
   *  which only that write's acknowledgement can attribute (0 when none). */
  let observedDuringWrite = 0;
  /** Acknowledged writes that moved {@link vectorsRevSeen}, counted so a read
   *  sampled before one can tell that its sample is behind it. */
  let ownCommits = 0;
  /** Callers of {@link CardsRuntime.flushVectorWrites} waiting for the queue
   *  to empty. */
  const flushWaiters = new Set<() => void>();
  const log = deps.log;

  /** The running chunked builds: at most one that changes the card map and
   *  one that changes the index or vectors. They may run side by side. */
  let metaJob: Promise<void> | undefined;
  let indexJob: Promise<void> | undefined;
  let disposed = false;

  const readVectorsRev = (): number =>
    source.vectorsRevision
      ? revisionNumber(source.vectorsRevision())
      : (reads?.stats().vectorsRev ?? 0);
  const vectorsActive = (): boolean => semanticOn && embedder?.ready === true;

  function newIndex(): MiniSearch<CardDoc> {
    return new MiniSearch<CardDoc>({
      idField: "id",
      fields: [...CARD_FIELDS],
      tokenize: (text: string) => tokenizeAll(text),
    });
  }

  /** Run a build in slices with {@link yieldBetween} between them. The first
   *  slice runs synchronously; a disposed runtime stops at the next slice. */
  async function drive(steps: Generator<void, void>): Promise<void> {
    while (!steps.next().done) {
      await yieldBetween();
      if (disposed) return;
    }
  }

  /** Start a chunked build of its kind unless one of that kind is running;
   *  returns the running one. */
  function startJob(kind: "meta" | "index", steps: Generator<void, void>): Promise<void> {
    const running = kind === "meta" ? metaJob : indexJob;
    if (running) return running;
    const run = drive(steps);
    if (kind === "meta") metaJob = run;
    else indexJob = run;
    // Also marks the promise handled: a build started by a synchronous access
    // has no awaiting caller, and ready() rethrows its failure on its own.
    const settle = (): void => {
      if (metaJob === run) metaJob = undefined;
      if (indexJob === run) indexJob = undefined;
    };
    run.then(settle, settle);
    return run;
  }

  /**
   * Run a read that returns stored vectors, and say which model stamp those
   * vectors were stored under. Every vector write bumps `vectors_rev` in its own
   * transaction, and a stamp change clears every stored vector first, so when
   * `vectors_rev` did not move across the read, every vector it returned was
   * stored under the stamp read before it. `quiet` is false when a vector
   * write landed meanwhile; `stamp` is then undefined.
   */
  function stampedRead<T>(read: () => T): { value: T; stamp?: string; quiet: boolean } {
    if (!semanticOn) return { value: read(), quiet: true };
    const before = readVectorsRev();
    const stamp = source.semanticModel?.();
    const value = read();
    const quiet = readVectorsRev() === before;
    return quiet && stamp !== undefined ? { value, stamp, quiet } : { value, quiet };
  }

  /** Record the stamp a read's card blobs were stored under. */
  function markBlobs(cards: Iterable<Card>, stamp: string | undefined): void {
    if (stamp === undefined) return;
    for (const card of cards) blobStamp.set(card, stamp);
  }

  /**
   * Whether `observed`, a `vectors_rev` the store reported, shows a vector
   * write the in-memory vectors do not reflect. While one of this runtime's
   * own writes is in flight its commit may already be visible, so a
   * different value is held until that write's acknowledgement says whose it
   * was ({@link settleVectorWrite}) and reads as no change for now.
   */
  function vectorsMoved(observed: number): boolean {
    if (observed === vectorsRevSeen) return false;
    if (!writeInFlight) return true;
    observedDuringWrite = Math.max(observedDuringWrite, observed);
    return false;
  }

  /** Another process wrote vectors: reload them, or on a source without store
   *  reads, the cards their vectors come with. */
  function foreignVectorWrite(): void {
    vectorsStale = true;
    if (!reads) {
      metaWantHard = tick();
      metaWantFull = metaWantHard;
    }
  }

  // ── Metadata loads and refreshes ──

  /**
   * Load every card into a new map and install it. Paged by session id on a
   * store-backed source, with a yield between pages. Each page is compared
   * with the map it replaces, so the index learns exactly which cards changed
   * (no other map change can land during a load: see {@link metaPlan}).
   */
  function* metaLoadSteps(hard: boolean): Generator<void, void> {
    const startedAt = tick();
    // Sample every counter BEFORE reading cards: a write that lands during the
    // load leaves the sample behind it, so the next refresh applies the write
    // instead of the load absorbing it unseen.
    const stats = reads?.stats();
    const revision = reads ? undefined : source.revision();
    const vectorsRev = stats ? stats.vectorsRev : readVectorsRev();
    const commitsBefore = ownCommits;
    const next = new Map<string, Card>();
    const changed: string[] = [];
    /** Cards whose content is unchanged, with the copy they replace. */
    const same: Array<[old: Card, card: Card]> = [];
    let quiet = true;
    const take = (page: Card[], read: { stamp?: string; quiet: boolean }): void => {
      markBlobs(page, read.stamp);
      quiet &&= read.quiet;
      for (const card of page) {
        next.set(card.sessionId, card);
        const old = cardById.get(card.sessionId);
        if (old && sameIndexedContent(old, card)) same.push([old, card]);
        else changed.push(card.sessionId);
      }
    };
    if (reads) {
      let after: string | undefined;
      for (;;) {
        const read = stampedRead(() => reads.cardsPage(after, LOAD_PAGE, cardOpts));
        take(read.value, read);
        if (read.value.length < LOAD_PAGE) break;
        after = read.value[read.value.length - 1]!.sessionId;
        yield;
      }
    } else {
      const read = stampedRead(() => source.getCards(cardOpts));
      take(read.value, read);
    }
    if (disposed || startedAt <= metaInstalledAt) return;
    // Recorded whether or not an index exists yet: a first build that took
    // its snapshot before this load installs after it, and keeps exactly
    // these entries (see indexBuildSteps). Without an index or a build, the
    // first build covers them.
    for (const id of changed) dirty.add(id);
    for (const id of cardById.keys()) if (!next.has(id)) dirty.add(id);
    // A vector belongs to content, not to a copy of the card: move it to the
    // new copy so semanticScore() keeps finding it by identity.
    for (const [old, card] of same) {
      if (vectorSource.get(card.sessionId) === old) vectorSource.set(card.sessionId, card);
    }
    if (hard) {
      hardLoadInstalledAt = tick();
      if (indexInstalledAt > 0) hardIndexPending = true;
    }
    cardById = next;
    metaInstalledAt = startedAt;
    counters = stats;
    appliedRev = stats?.cardsRev ?? 0;
    installedRevision = revision;
    lastCheck = now();
    coverageCache = undefined;
    if (!reads && quiet && vectorsRev !== vectorsRevSeen) {
      // Without store reads the new map's blobs are the vectors a reload
      // uses, so they are current as of the sample, if no write interleaved.
      // An own write acknowledged during the load is past the sample and
      // in memory already, so it is kept.
      vectorsStale = true;
      vectorsRevSeen =
        ownCommits !== commitsBefore ? Math.max(vectorsRevSeen, vectorsRev) : vectorsRev;
    } else if (vectorsMoved(vectorsRev)) {
      // Another process wrote vectors the in-memory ones do not reflect.
      vectorsStale = true;
    }
  }

  /**
   * Apply the cards stamped since the last refresh, a `cardsSince` page per
   * slice, then drop deleted cards when the store counted a deletion, and
   * record `stats` (sampled before the reads) as the applied counters.
   */
  function* applySteps(store: CardStoreReads, stats: CardCounters): Generator<void, void> {
    const loadedAt = metaInstalledAt;
    for (;;) {
      const read = stampedRead(() => store.cardsSince(appliedRev, LOAD_PAGE, cardOpts));
      const page = read.value;
      markBlobs(page, read.stamp);
      for (const card of page) {
        cardById.set(card.sessionId, card);
        dirty.add(card.sessionId);
        if (card.writeRev !== undefined && card.writeRev > appliedRev) appliedRev = card.writeRev;
      }
      coverageCache = undefined;
      if (page.length < LOAD_PAGE) break;
      yield;
      // A full load replaced the map and its counters meanwhile.
      if (metaInstalledAt !== loadedAt) return;
    }
    if (stats.cardsDeleted !== counters?.cardsDeleted) {
      const present = new Set(store.cardIds());
      for (const id of cardById.keys()) {
        if (present.has(id)) continue;
        cardById.delete(id);
        dirty.add(id);
      }
    }
    counters = stats;
  }

  type MetaPlan =
    | { kind: "fresh" }
    | { kind: "load"; hard: boolean }
    | { kind: "apply"; store: CardStoreReads; stats: CardCounters; revisions: number };

  /**
   * What the map needs before it serves. A full load when it was never
   * loaded, was invalidated, or (from the store's counters) the store was
   * reset (a counter went backwards) or an older build wrote without stamping
   * (`cards_rev` advanced further than `cards_stamped`, a gap later stamped
   * writes never close). Otherwise the stamped changes to apply, if any.
   * Checks the store at most once per refresh interval.
   */
  function metaPlan(): MetaPlan {
    if (metaInstalledAt === 0 || metaWantHard > metaInstalledAt)
      return { kind: "load", hard: true };
    if (metaWantFull > metaInstalledAt) return { kind: "load", hard: false };
    // A running load or apply owns the map; whoever waits on it refreshes
    // after it. An index build never holds the map back.
    if (metaJob) return { kind: "fresh" };
    if (now() - lastCheck < refreshIntervalMs) return { kind: "fresh" };
    lastCheck = now();
    if (!reads) {
      // Without store reads only a full reload can apply a change.
      if (source.revision() === installedRevision && !vectorsMoved(readVectorsRev())) {
        return { kind: "fresh" };
      }
      metaWantHard = tick();
      metaWantFull = metaWantHard;
      return { kind: "load", hard: true };
    }
    const stats = reads.stats();
    if (vectorsMoved(stats.vectorsRev)) vectorsStale = true;
    const last = counters;
    const revisions = last ? stats.cardsRev - last.cardsRev : 0;
    const stamped = last ? stats.cardsStamped - last.cardsStamped : 0;
    if (
      !last ||
      revisions < 0 ||
      stamped < 0 ||
      stats.cardsDeleted < last.cardsDeleted ||
      revisions !== stamped
    ) {
      metaWantFull = tick();
      return { kind: "load", hard: false };
    }
    if (revisions === 0 && stats.cardsDeleted === last.cardsDeleted) {
      counters = stats;
      return { kind: "fresh" };
    }
    return { kind: "apply", store: reads, stats, revisions };
  }

  /** The synchronous accessors' refresh. A hard load runs in place, as does
   *  an apply that fits one page; a soft load or a larger apply runs as a
   *  chunked build while the current map serves. */
  function syncMeta(): void {
    const plan = metaPlan();
    if (plan.kind === "load") {
      if (plan.hard) runSync(metaLoadSteps(true));
      else void startJob("meta", metaLoadSteps(false));
    } else if (plan.kind === "apply") {
      const steps = applySteps(plan.store, plan.stats);
      if (plan.revisions <= LOAD_PAGE) runSync(steps);
      else void startJob("meta", steps);
    }
  }

  /** Until when the synchronous accessors read nothing, after a refresh of
   *  theirs found the store locked. */
  let busyUntil = -Infinity;

  /**
   * Run a synchronous accessor's `refresh`. A reader that never waits on a
   * lock throws {@link SqliteBusyError} where another connection holds one.
   * Once what the accessor serves has loaded (`loaded`), it keeps serving
   * that as it is, and the next synchronous refresh comes after
   * {@link BUSY_SERVE_MS}; before, the error reaches the caller. An async
   * caller retries through `ready()`. A load installs only once it read
   * everything and an apply moves its counters only at its end, so a refresh
   * cut short loses nothing, and `lastCheck` is cleared so it is due again
   * once the pause ends.
   */
  function serving(refresh: () => void, loaded: () => boolean): void {
    if (loaded() && now() < busyUntil) return;
    try {
      refresh();
    } catch (error) {
      if (!(error instanceof SqliteBusyError) || !loaded()) throw error;
      busyUntil = now() + BUSY_SERVE_MS;
      lastCheck = -Infinity;
    }
  }
  const mapLoaded = (): boolean => metaInstalledAt > 0;
  const indexLoaded = (): boolean => metaInstalledAt > 0 && indexInstalledAt > 0;

  /** {@link syncMeta}'s plan as a build to await, or undefined when fresh. */
  function metaSteps(): Generator<void, void> | undefined {
    const plan = metaPlan();
    if (plan.kind === "load") return metaLoadSteps(plan.hard);
    if (plan.kind === "apply") return applySteps(plan.store, plan.stats);
    return undefined;
  }

  // ── Index builds and updates ──

  function vectorPass(
    vectors: Map<string, Float32Array>,
    sources: Map<string, Card>,
  ): VectorPass | undefined {
    if (!vectorsActive()) return undefined;
    return {
      vectors,
      sources,
      rows: [],
      stampMatches: configuredModel != null && source.semanticModel?.() === configuredModel,
    };
  }

  /** A map card's own blob, with the stamp it was read under. */
  const storedWith = (card: Card): StoredVector => ({
    embedding: card.embedding,
    embeddingGen: card.embeddingGen,
    stamp: blobStamp.get(card),
  });

  /**
   * Set one card's vector, never from a vector whose provenance is not this
   * model at this generation for this card version, and embed only when no
   * such vector is at hand. In order: a freshly read row (`fresh`) when it
   * holds one, since it is the store's current vector; the in-memory vector
   * when it was computed or loaded for the same content, since it is at least
   * as current as a blob read with the card; the blob `stored` holds when it
   * was stored under this model's stamp at this generation (a null- or
   * lower-generation row, legacy or an older build's, never qualifies, and
   * the store refuses to downgrade a higher one, so a lagging process
   * recomputes in memory without clobbering it); else the card text is
   * embedded. Queues a write for every vector the store is not known to hold
   * under this stamp.
   */
  function setVector(
    pass: VectorPass,
    card: Card,
    stored: StoredVector | undefined,
    fresh: boolean,
  ): void {
    const id = card.sessionId;
    const keep = (vec: Float32Array, write: boolean): void => {
      pass.vectors.set(id, vec);
      pass.sources.set(id, card);
      // Carry the summary hash the vector belongs to, so the store skips the
      // write if a summary landed (and cleared the vector) since.
      if (write) {
        pass.rows.push({
          sessionId: id,
          vector: vec,
          expectedSummaryHash: card.summaryHash,
          card,
        });
      }
    };
    // Never embed a stray summarizer worker card (a crash can leave one in the
    // store); it is excluded from every result anyway.
    if (isSummarizerTitle(card.title)) {
      pass.vectors.delete(id);
      pass.sources.delete(id);
      return;
    }
    const blob =
      stored &&
      stored.stamp === configuredModel &&
      stored.embedding &&
      stored.embeddingGen === EMBED_REPRESENTATION
        ? stored.embedding
        : undefined;
    // A write under another stamp restamps the store and clears every stored
    // vector, so then even a vector it holds must be written again.
    if (fresh && blob) return keep(blobToVector(blob), !pass.stampMatches);
    const from = vectorSource.get(id);
    const memory = from && sameIndexedContent(from, card) ? cardVectors?.get(id) : undefined;
    // A fresh row without a usable vector means the store lacks this one.
    if (memory) return keep(memory, fresh || !pass.stampMatches);
    if (blob) return keep(blobToVector(blob), !pass.stampMatches);
    const text = embeddingTextOf(card);
    const vec = text ? embedder?.embed(text) : undefined;
    if (!vec) {
      pass.vectors.delete(id);
      pass.sources.delete(id);
      return;
    }
    keep(vec, true);
  }

  /**
   * Queue a pass's computed vectors to persist, plus the model stamp when it
   * must advance so a later start reuses them, and start the writes unless
   * they are running. Called once the pass's vectors are installed, so
   * nothing that serves a search waits for them. The first write of an idle
   * queue is issued at once, on the caller's turn; with a writer that writes
   * on the calling thread that is where it commits.
   */
  function queueVectorWrites(pass: VectorPass): void {
    if (configuredModel == null || !source.writeEmbeddings || disposed) return;
    if (pass.rows.length === 0 && pass.stampMatches) return;
    for (const row of pass.rows) latestQueued.set(row.sessionId, row);
    writeQueue.push({ rows: pass.rows, next: 0, restamp: !pass.stampMatches });
    pumpVectorWrites();
  }

  function pumpVectorWrites(): void {
    if (writeRunner) return;
    const run = runVectorWrites();
    writeRunner = run;
    // Cleared on a later turn even when the run finished on this one, and a
    // batch queued meanwhile starts a new run.
    const done = (): void => {
      if (writeRunner !== run) return;
      writeRunner = undefined;
      if (!disposed && writeQueue.length > 0) pumpVectorWrites();
      else notifyFlushed();
    };
    void run.then(done, done);
  }

  function notifyFlushed(): void {
    if (writeRunner || (!disposed && writeQueue.length > 0)) return;
    const waiters = [...flushWaiters];
    flushWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  /**
   * A queued vector is written only while it is the last one queued for its
   * session and the card the map holds still indexes and embeds as the
   * version it was computed for. A card that changed since is dirty, and the
   * pass that takes it queues its own vector. This keeps a write that waited
   * in the queue from storing a vector for a card version it no longer
   * describes. Accepted race: a re-distill that commits between this check
   * and the write can still have its card's vector set from the older
   * content when the summary hash is unchanged; the next re-distill of that
   * card clears it again, so it self-heals.
   */
  function writable(row: QueuedVector): boolean {
    if (latestQueued.get(row.sessionId) !== row) return false;
    latestQueued.delete(row.sessionId);
    const card = cardById.get(row.sessionId);
    return card !== undefined && (card === row.card || sameIndexedContent(card, row.card));
  }

  /** The next chunk of `batch`, each row with a copy of its vector's bytes
   *  the writer may keep or transfer. */
  function takeChunk(batch: WriteBatch): CardVectorWriteRow[] {
    const chunk: CardVectorWriteRow[] = [];
    while (chunk.length < VECTOR_WRITE_CHUNK && batch.next < batch.rows.length) {
      const row = batch.rows[batch.next++]!;
      if (!writable(row)) continue;
      chunk.push({
        sessionId: row.sessionId,
        embedding: vectorToBlob(row.vector).slice(),
        expectedSummaryHash: row.expectedSummaryHash,
      });
    }
    return chunk;
  }

  /**
   * Issue the queued writes in order, one at a time, in chunks of
   * {@link VECTOR_WRITE_CHUNK}, yielding before every write but the first.
   * A batch that must restamp issues one write even when no row of it is
   * left, unless the store's stamp is this model's by then. Never rejects: a
   * write that throws counts as failed, and so does a restamp check whose
   * read of the stamp throws (a busy read on a connection that never waits
   * on a lock), which ends its batch. Anything else that throws ends the
   * batch it was in. A batch is taken off the queue however it ended, so a
   * failure never makes the next run start over with it. A refused or failed
   * write moves nothing and leaves the vectors in memory as they are, and a
   * later pass may write them again. Stops issuing once the runtime is
   * disposed.
   */
  async function runVectorWrites(): Promise<void> {
    const write = source.writeEmbeddings;
    const model = configuredModel;
    if (!write || model == null) return;
    let first = true;
    while (!disposed) {
      const batch = writeQueue[0];
      if (!batch) return;
      let issued = 0;
      let failed = 0;
      let refused = 0;
      let firstProblem: string | undefined;
      try {
        for (;;) {
          const restampDue = issued === 0 && batch.restamp;
          if (batch.next >= batch.rows.length && !restampDue) break;
          if (!first) {
            await yieldBetween();
            if (disposed) return;
          }
          first = false;
          const chunk = takeChunk(batch);
          // Every row left was superseded or outdated: the write is still due
          // only to restamp a store that still carries another stamp.
          if (chunk.length === 0) {
            if (!restampDue) break;
            let stale: boolean;
            try {
              stale = source.semanticModel?.() !== model;
            } catch (error) {
              issued++;
              failed++;
              firstProblem ??= errorText(error);
              break;
            }
            if (!stale) break;
          }
          issued++;
          const result = await issueVectorWrite(write, model, chunk);
          if (result.status === "failed") {
            failed++;
            firstProblem ??= result.error;
          } else if (result.status === "refused") {
            refused++;
            firstProblem ??= result.reason;
          }
          if (disposed) return;
        }
      } catch (error) {
        issued++;
        failed++;
        firstProblem ??= errorText(error);
      }
      if (writeQueue[0] === batch) writeQueue.shift();
      if ((failed > 0 || refused > 0) && log) {
        log(
          `card vectors not persisted: ${failed} of ${issued} write(s) failed and ${refused} were refused (${firstProblem ?? "no detail"}); the vectors stay in memory`,
        );
      }
    }
  }

  /** One write, and what its acknowledgement means for the vectors in memory. */
  async function issueVectorWrite(
    write: CardVectorWriter,
    model: string,
    rows: CardVectorWriteRow[],
  ): Promise<CardVectorWriteResult> {
    writeInFlight = true;
    let result: CardVectorWriteResult;
    try {
      result = asWriteResult(await write(model, EMBED_REPRESENTATION, rows));
    } catch (error) {
      result = { status: "failed", error: errorText(error) };
    }
    settleVectorWrite(result);
    return result;
  }

  /**
   * Apply one acknowledgement. The cached `vectors_rev` moves only by the one
   * revision a committed write made ({@link ownWriteRevision}), whatever ran
   * since it was issued: a refresh or reload that ran meanwhile only ever set
   * it from a store read, never past what memory holds. A revision a refresh
   * read meanwhile and this write does not account for is another process's
   * write, which the vectors are then reloaded for.
   */
  function settleVectorWrite(result: CardVectorWriteResult): void {
    writeInFlight = false;
    const seen = ownWriteRevision(vectorsRevSeen, result);
    if (seen !== vectorsRevSeen) ownCommits++;
    vectorsRevSeen = seen;
    const observed = observedDuringWrite;
    observedDuringWrite = 0;
    if (!disposed && observed > vectorsRevSeen) foreignVectorWrite();
  }

  /** Build a new index (and vectors) from the current map and install it. */
  function* indexBuildSteps(): Generator<void, void> {
    const startedAt = tick();
    const snapshot = new Map(cardById);
    const index = newIndex();
    const docs = new Map<string, CardDoc>();
    const vectors = new Map<string, Float32Array>();
    const sources = new Map<string, Card>();
    const pass = vectorPass(vectors, sources);
    let slice = performance.now();
    for (const card of snapshot.values()) {
      if (performance.now() - slice >= SLICE_MS) {
        yield;
        slice = performance.now();
      }
      const doc = toDoc(card);
      index.add(doc);
      docs.set(card.sessionId, doc);
      if (pass) setVector(pass, card, storedWith(card), false);
    }
    if (disposed || startedAt <= indexInstalledAt) return;
    mini = index;
    docById = docs;
    cardVectors = semanticOn ? vectors : undefined;
    vectorSource = sources;
    vectorsComplete = pass !== undefined;
    indexInstalledAt = startedAt;
    // A hard load that installed after the snapshot left changes this index
    // lacks, which a synchronous rank() must still apply before it serves.
    hardIndexPending = hardLoadInstalledAt > startedAt;
    // The new index holds every card as of the snapshot. Every change to the
    // map since is in `dirty` (an apply records it, and so does a full load,
    // with or without an index), so a card that changed or left since stays
    // dirty and the rest are covered.
    for (const id of dirty) if (cardById.get(id) === snapshot.get(id)) dirty.delete(id);
    if (pass) queueVectorWrites(pass);
  }

  /**
   * Re-read every persisted vector and recompute the missing ones, without
   * touching the index. Runs when another process wrote vectors, and when the
   * embedder becomes ready after the index was built.
   */
  function* vectorReloadSteps(): Generator<void, void> {
    const startedAt = tick();
    // Sampled before the reads, like a full load (see metaLoadSteps).
    const sample = readVectorsRev();
    const commitsBefore = ownCommits;
    /** Each row with the stamp its page was read under; undefined for a page
     *  a vector write landed during, whose rows are never reused. */
    const rows = new Map<string, { row: CardVectorRow; stamp: string | undefined }>();
    let quiet = true;
    if (reads) {
      let after: string | undefined;
      for (;;) {
        const read = stampedRead(() => reads.vectorsPage(after, LOAD_PAGE));
        quiet &&= read.quiet;
        for (const row of read.value) rows.set(row.sessionId, { row, stamp: read.stamp });
        if (read.value.length < LOAD_PAGE) break;
        after = read.value[read.value.length - 1]!.sessionId;
        yield;
      }
    }
    const vectors = new Map<string, Float32Array>();
    const sources = new Map<string, Card>();
    const pass = vectorPass(vectors, sources);
    if (!pass) return;
    let slice = performance.now();
    for (const card of [...cardById.values()]) {
      if (performance.now() - slice >= SLICE_MS) {
        yield;
        slice = performance.now();
      }
      // Without store reads the map was just reloaded, so its own blobs are
      // the freshest stored vectors.
      if (!reads) {
        setVector(pass, card, storedWith(card), true);
        continue;
      }
      const id = card.sessionId;
      const found = rows.get(id);
      // Gone from the store: the next refresh drops the card.
      if (!found) continue;
      const { row, stamp } = found;
      if (row.writeRev !== card.writeRev) {
        // Rewritten since the map read it: the next refresh brings the new
        // card, so keep what this version had rather than embed stale text.
        const kept = cardVectors?.get(id);
        const from = vectorSource.get(id);
        if (kept && from) {
          vectors.set(id, kept);
          sources.set(id, from);
        }
        continue;
      }
      // A row from a page a write landed during says nothing for sure about
      // the store, so it is neither reused nor taken as missing: the vector
      // this card has in memory serves, and only a card without one embeds.
      const stored = { embedding: row.embedding, embeddingGen: row.embeddingGen, stamp };
      setVector(pass, card, stored, stamp !== undefined);
    }
    // A newer index build computed its own vectors.
    if (disposed || indexInstalledAt > startedAt) return;
    cardVectors = vectors;
    vectorSource = sources;
    vectorsComplete = true;
    // Installed even when a write landed during a page, so a busy writer
    // cannot keep vectors from ever installing; those pages read again on
    // the next pass.
    vectorsStale = !quiet;
    // Without store reads the vectors came from the map, read before `sample`,
    // so the sample would absorb a write that landed in between. An own write
    // acknowledged during the reload moved the cached revision past the
    // sample by exactly its own commit, whose vectors memory holds, so it is
    // kept; otherwise the sample replaces it, a lower one included (a store
    // that was reset).
    if (reads) {
      vectorsRevSeen = ownCommits !== commitsBefore ? Math.max(vectorsRevSeen, sample) : sample;
    }
    queueVectorWrites(pass);
  }

  /**
   * Apply the dirty cards to the index and vectors in place, in time slices.
   * Each changed card's old document is removed and its new one added, which
   * keeps every term's document frequency exact; a card whose document is
   * unchanged costs no index work.
   */
  function* applyDirtySteps(): Generator<void, void> {
    const index = mini;
    if (!index) return;
    const builtAt = indexInstalledAt;
    let pass = vectorsComplete && cardVectors ? vectorPass(cardVectors, vectorSource) : undefined;
    if (pass && !pass.stampMatches) {
      // The store holds another model's vectors: only a full pass may restamp
      // it, since a stamp change clears every stored vector.
      vectorsStale = true;
      pass = undefined;
    }
    let slice = performance.now();
    for (const id of [...dirty]) {
      if (performance.now() - slice >= SLICE_MS) {
        yield;
        slice = performance.now();
        // An index built meanwhile covers every card.
        if (indexInstalledAt !== builtAt) return;
      }
      // Read the card now, not when the slice began: it may have changed.
      if (!dirty.delete(id)) continue;
      const card = cardById.get(id);
      const next = card ? toDoc(card) : undefined;
      const prev = docById.get(id);
      if (!sameDoc(prev, next)) {
        if (prev) index.remove(prev);
        if (next) {
          index.add(next);
          docById.set(id, next);
        } else docById.delete(id);
      }
      if (!pass) continue;
      if (card) setVector(pass, card, storedWith(card), false);
      else {
        pass.vectors.delete(id);
        pass.sources.delete(id);
      }
    }
    if (dirty.size === 0) hardIndexPending = false;
    if (pass) queueVectorWrites(pass);
  }

  /** A full build is due: no index yet, or so many cards changed that
   *  rebuilding costs less than removing and re-adding each one. */
  function indexNeedsBuild(): boolean {
    return indexInstalledAt === 0 || dirty.size > Math.max(MAX_SYNC_DOCS, docById.size / 2);
  }

  function vectorsNeedReload(): boolean {
    return vectorsActive() && (vectorsStale || !vectorsComplete);
  }

  /** The index work {@link ready} awaits next, or undefined when current. */
  function indexSteps(): Generator<void, void> | undefined {
    if (indexNeedsBuild()) return indexBuildSteps();
    if (dirty.size > 0) return applyDirtySteps();
    if (vectorsNeedReload()) return vectorReloadSteps();
    return undefined;
  }

  /**
   * `rank`'s refresh: the map first, then the index. With no index it builds
   * in place, as it does after a hard load changed more cards than it applies
   * in place or while another index build runs (a full build supersedes that
   * one; an in-place update beside it could be lost when it installs). A few
   * changed cards apply in place; anything larger runs as a chunked build
   * while the current index serves.
   */
  function syncIndex(): void {
    syncMeta();
    if (
      indexInstalledAt === 0 ||
      (hardIndexPending && (indexJob !== undefined || dirty.size > MAX_SYNC_DOCS))
    ) {
      runSync(indexBuildSteps());
    }
    if (indexJob) return;
    if (!indexNeedsBuild() && dirty.size > 0 && dirty.size <= MAX_SYNC_DOCS) {
      runSync(applyDirtySteps());
    }
    const steps = indexSteps();
    if (steps) void startJob("index", steps);
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

  /** The session ids the exclusion filters remove, read from the card map
   *  alone, so a call that does not rank never touches the index. */
  function exclusionOf(
    filters: Pick<CardFilters, "excludeFamilyOf" | "excludeSessionId">,
  ): Set<string> {
    const excluded = filters.excludeFamilyOf
      ? exclusionFamilyFromCards(cardById.values(), filters.excludeFamilyOf)
      : new Set<string>();
    if (filters.excludeSessionId) excluded.add(filters.excludeSessionId);
    return excluded;
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
    // The session overlaps the window (see CardFilters).
    if (filters.since != null && card.timeUpdated < filters.since) return false;
    if (filters.until != null && card.timeCreated > filters.until) return false;
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
    // A card waiting in `dirty` was scored on a document it no longer has, so
    // it neither scores nor sets the scale the others are measured against.
    const current = raw.filter((hit) => !dirty.has(String(hit.id)));
    const top = current[0]?.score || 1;
    const scores = new Map<string, number>();
    for (const hit of current) scores.set(String(hit.id), clamp01(hit.score / top));
    return scores;
  }

  function semanticScore(query: ParsedQuery): Map<string, number> {
    const scores = new Map<string, number>();
    if (!embedder || !cardVectors || semanticWeight <= 0 || !embedder.ready) return scores;
    const queryVec = embedder.embed(query.raw);
    if (!queryVec) return scores;
    for (const [sessionId, vec] of cardVectors) {
      // Like lexicalHits: a card waiting in `dirty` has a vector for a version
      // it no longer is.
      if (dirty.has(sessionId)) continue;
      // A card the index has taken may still wait for its vector (a pass that
      // could not write under another model's stamp left it to a reload), so
      // a vector scores only for the content it was computed from.
      const card = cardById.get(sessionId);
      const from = vectorSource.get(sessionId);
      if (!card || !from) continue;
      if (from !== card) {
        if (!sameIndexedContent(from, card)) continue;
        vectorSource.set(sessionId, card);
      }
      scores.set(sessionId, clamp01((cosineSimilarity(queryVec, vec) + 1) / 2));
    }
    return scores;
  }

  // Warm-store activation: when the embedder is still loading, hook its init
  // completion to run one vector pass the moment it is ready, so semantic turns
  // on without waiting for a card change. The init promise resolves once; the
  // pass is skipped when no index is built yet (its build computes the vectors)
  // or a full pass already ran. When another build is running, the next index
  // update starts the pass instead.
  if (semanticOn && deps.semanticReady) {
    void deps.semanticReady.then(() => {
      if (disposed || !embedder?.ready || indexInstalledAt === 0 || vectorsComplete) return;
      void startJob("index", vectorReloadSteps());
    });
  }

  return {
    dispose(): void {
      disposed = true;
      // Nothing queued is issued from here on; a write in flight settles.
      writeQueue.length = 0;
      latestQueued.clear();
      notifyFlushed();
    },

    flushVectorWrites(deadlineMs?: number): Promise<boolean> {
      if (!writeRunner && (disposed || writeQueue.length === 0)) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const flushed = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          resolve(true);
        };
        flushWaiters.add(flushed);
        // No bound when undefined or infinite; any other value that is not a
        // finite duration (NaN, a negative) ends the wait at once.
        if (deadlineMs !== undefined && deadlineMs !== Infinity) {
          timer = setTimeout(
            () => {
              flushWaiters.delete(flushed);
              resolve(false);
            },
            Number.isFinite(deadlineMs) ? Math.max(0, deadlineMs) : 0,
          );
        }
      });
    },

    async ready(opts): Promise<void> {
      const withIndex = opts?.index === true;
      let reloaded = false;
      for (let round = 0; round < MAX_READY_ROUNDS && !disposed; round++) {
        // The map first. A caller that reads only the map never waits on the
        // index or the vectors.
        if (metaJob) {
          await metaJob;
          continue;
        }
        const meta = metaSteps();
        if (meta) {
          await startJob("meta", meta);
          continue;
        }
        if (!withIndex) return;
        if (indexJob) {
          await indexJob;
          continue;
        }
        if (!indexNeedsBuild() && dirty.size === 0 && vectorsNeedReload()) {
          // A reload this call already ran installed its vectors and is stale
          // only because another process wrote during it. The next refresh
          // picks that write up, as it does any other foreign write.
          if (reloaded) return;
          reloaded = true;
        }
        const index = indexSteps();
        if (!index) return;
        await startJob("index", index);
      }
    },

    rank(query, filters, stats): CardHit[] {
      serving(syncIndex, indexLoaded);
      const cards = cardById.values();
      const excluded = exclusionOf(filters);
      // The excluded cards that matched are counted against the same filters
      // with the exclusion lifted, so a card some other filter also removes is
      // not reported as one the exclusion arguments would let back in.
      const excludedMatched: Card[] | undefined = stats && excluded.size > 0 ? [] : undefined;
      const noExclusion = new Set<string>();

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
      const skipped: Array<{ card: Card; score: number }> = [];
      let pending = 0;
      for (const card of cards) {
        if (dirty.has(card.sessionId)) {
          // Unscored (see lexicalHits); counted only when a filter would
          // have let it compete.
          if (passesFilters(card, filters, excluded)) pending++;
          continue;
        }
        if (!passesFilters(card, filters, excluded)) {
          if (
            excludedMatched &&
            excluded.has(card.sessionId) &&
            (lexical.get(card.sessionId) ?? 0) > 0 &&
            passesFilters(card, filters, noExclusion)
          ) {
            excludedMatched.push(card);
          }
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
              skipped.push({ card, score: scoreOf(card, skippedLex, skippedSem) });
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

      // Map order follows load and update history, so every order here ends
      // in the session id and an updated runtime ranks like a fresh one.
      if (stats && skipped.length > 0) {
        skipped.sort((a, b) => byRecency(a.card, b.card));
        stats.rootOnlySkipped.push(...skipped);
      }
      if (stats) stats.pending = pending;
      if (stats && excludedMatched) {
        stats.excludedMatched = excludedMatched.sort((a, b) =>
          compareIds(a.sessionId, b.sessionId),
        );
      }
      hits.sort(
        (a, b) =>
          b.score - a.score ||
          b.card.timeUpdated - a.card.timeUpdated ||
          compareIds(a.sessionId, b.sessionId),
      );
      if (hits.length > 0) return hits;

      // No lexical/semantic signal: fall back to recency-ranked near-misses so a
      // broad paraphrase still returns something honest (labeled by the caller).
      return [...cardById.values()]
        .filter((card) => passesFilters(card, filters, excluded))
        .sort(byRecency)
        .slice(0, NEAR_MISS_LIMIT)
        .map((card) => ({
          sessionId: card.sessionId,
          score: 0,
          card,
          directoryRelevance: directoryRelevance(card, filters),
        }));
    },

    list(filters): Card[] {
      serving(syncMeta, mapLoaded);
      const excluded = exclusionOf(filters);
      return [...cardById.values()]
        .filter((card) => passesFilters(card, filters, excluded))
        .sort(byRecency);
    },

    get(sessionId): Card | undefined {
      serving(syncMeta, mapLoaded);
      const card = cardById.get(sessionId);
      // A worker card is never a valid drill/deep target (see passesFilters).
      return card && !isSummarizerTitle(card.title) ? card : undefined;
    },

    exclusionFamily(currentSessionId): Set<string> {
      serving(syncMeta, mapLoaded);
      return exclusionFamilyFromCards(cardById.values(), currentSessionId);
    },

    familyOf(rootId): Card[] {
      serving(syncMeta, mapLoaded);
      return [...cardById.values()].filter((card) => card.rootId === rootId).sort(byRecency);
    },

    coverage(): CardsCoverage {
      serving(syncMeta, mapLoaded);
      if (coverageCache) return { ...coverageCache };
      let full = 0;
      let recency = 0;
      for (const card of cardById.values()) {
        if (card.distillState === "full") {
          full++;
          if (card.timeUpdated > recency) recency = card.timeUpdated;
        }
      }
      coverageCache = {
        totalCards: cardById.size,
        fullCards: full,
        storeRecency: recency,
        degraded: source.degraded === true,
      };
      return { ...coverageCache };
    },

    semanticStatus(): SemanticStatus | undefined {
      if (!embedder || semanticWeight <= 0) return undefined;
      serving(syncMeta, mapLoaded);
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
      const at = tick();
      metaWantFull = at;
      metaWantHard = at;
    },
  };
}
