import { errmsg, type DrillSessionStats, type DrillStop, type Limits } from "./types.js";
import type { FetchGate } from "./fetch-gate.js";
import type { ParsedQuery } from "./query.js";
import { compareMessages, type HistoryMessage } from "./history/model.js";
import type { HistorySource } from "./history/source.js";
import {
  buildCandidates,
  buildTitleCandidate,
  populateNormalized,
  MAX_CHARS_PER_CANDIDATE,
  type Candidate,
} from "./candidates.js";
import { buildSessionDigest } from "./corpus.js";
import { normalize } from "./normalize.js";
import { searchable } from "./extract.js";
import { authorshipOf, type Authorship, type AuthorshipCounts } from "./authorship.js";
import { bm25Search, type Bm25Hit, type Bm25Mode } from "./bm25.js";
import { mergeShortlistHits } from "./rerank.js";
import type { FtsHit } from "./store.js";

/**
 * Tier-2 bounded drill.
 *
 * Fetches only the shortlisted sessions (tier-1 cards + FTS-injected needles),
 * in bounded slices, and reranks the drilled parts with the SAME candidate build
 * + BM25 scoring stack the corpus scan used — now scoped to the drilled pool via
 * the two-stage drilled rerank (see rerank.ts): a broad pass over every drilled
 * candidate and a deep pass over the card-supported neighborhood. Drilled slices
 * deliberately INCLUDE tool outputs — outputs are searchable within the sessions
 * a query drills into (they are not in the tier-1 card/FTS layers).
 *
 * Untargeted drill pages newest-first and truncates each part to the existing
 * per-candidate cap immediately; it stops at the per-session retained budget or
 * once pages stop matching any query anchor. Targeted drill (a session with FTS
 * hits) point-fetches the hit message plus its stored prev/next neighbors. A
 * per-query retained budget caps the whole drill.
 *
 * A small per-session LRU keeps repeat and refined queries warm. It holds the
 * pages and point lookups earlier queries fetched, not their slices: each query
 * replays the paging loop over the cached pages with its own stop rules,
 * fetches only what the cache lacks and builds from exactly the slice an
 * uncached fetch would return for it, so results never depend on query order.
 * An entry is valid for one (time.updated, card write revision) pair, so a
 * re-index that keeps the session's timestamp still invalidates it.
 */

export type DrillTarget = {
  sessionId: string;
  title: string;
  directory: string;
  timeUpdated: number;
  /** Tri-state session parentage, carried into every candidate this target
   *  produces so the authorship classifier can tell a human prompt from a
   *  delegated one. `string` = has a parent, `null` = metadata said root,
   *  `undefined`/omitted = metadata unavailable → `unknown`. Safe by omission:
   *  a construction site that forgets the key fails CLOSED (withholds from
   *  `authorship: "human"`) rather than claiming agent text is human-typed. */
  parentID?: string | null;
  /** The session card's `writeRev`, the store revision of its last stamped
   *  write. With `timeUpdated` it keys the drill cache, so a re-index that
   *  leaves `timeUpdated` unchanged still drops the cached pages. Absent when
   *  the session has no card or no stamped write has touched it; the cache then
   *  serves the session's pages only for {@link UNREVISED_ENTRY_TTL_MS}. */
  writeRev?: number;
};

export type DrillInput = {
  /** Ordered sessions to drill (already capped at limits.drillSessions). */
  sessions: DrillTarget[];
  /** Card-supported neighborhood — the deep pass's pool. */
  deepSet: Set<string>;
  /** Targeted point-fetch hints per session, from the FTS rows. */
  ftsBySession?: Map<string, FtsHit[]>;
  query: ParsedQuery;
  mode: Bm25Mode;
  explain: boolean;
  /** Per-query candidate eligibility (type/role/time/toolName). Applied to each
   *  drilled session's candidates before scoring/scanning, mirroring the old
   *  `assembleSession` filter. Absent = keep every candidate. Never cached: the
   *  drill cache holds unfiltered candidates, so the filter runs per query. */
  filter?: (candidate: Candidate) => boolean;
  /** Append each session's bound title candidate to its pool (mirrors the old
   *  `assembleSession` title binding) — the newest eligible candidate carries
   *  the session title so title hits participate in ranking/scanning. */
  searchTitles?: boolean;
  /** Authorship buckets to keep. Applied as the LAST stage of {@link poolFor},
   *  after the title candidate is built, so the title is filtered by the same
   *  rule as everything else. Absent = no authorship narrowing. */
  authorship?: ReadonlySet<Authorship>;
  /** Cooperative cancellation: a fired signal stops the drill before the next
   *  session's fetch (a hook timeout, for example), so no further SDK calls are
   *  made once the caller has given up. */
  abort?: AbortSignal;
};

/** One drilled session's candidate pool (already filtered to the query's
 *  eligibility and carrying its bound title candidate when requested). Consumed
 *  by BM25 scoring (smart/fuzzy) and by direct substring/pattern scans
 *  (literal/regex). */
export type DrilledPool = {
  target: DrillTarget;
  candidates: Candidate[];
  /** What was read for this session and why reading stopped. */
  stats: DrillSessionStats;
  /** Per-bucket counts of candidates the authorship stage removed. Present only
   *  when an authorship filter ran. The title candidate is deliberately NOT
   *  attributed: a title is dropped by definition under any set that excludes
   *  `"title"`, so counting it would add a constant per-session term that says
   *  nothing about what content was withheld. */
  authorshipDropped?: AuthorshipCounts;
  /** Total candidates the authorship stage removed, INCLUDING the unattributed
   *  title candidate. Present only when an authorship filter ran. This is what
   *  tells "the pass emptied this pool" apart from "eligibility left it empty",
   *  including for a pool whose only survivor would have been its title. */
  authorshipRemoved?: number;
};

/** A target's {@link DrillSessionStats}, with the session it describes. */
export type DrillTargetStats = DrillSessionStats & { sessionId: string };

export type DrillOutput = {
  hits: Bm25Hit[];
  /** The drilled candidate pools the hits were scored over (coverage counts). */
  pools: DrilledPool[];
  /** See {@link DrillPoolsOutput.drilledSessions}. */
  drilledSessions: string[];
  /** See {@link DrillPoolsOutput.targets}. */
  targets: DrillTargetStats[];
  budgetExhausted: boolean;
  loadErrors: string[];
};

export type DrillPoolsOutput = {
  pools: DrilledPool[];
  /** Every target in drill order, read or not: a drilled one with its
   *  pool's stats, one never read with zero counts and the reason
   *  (`queryBudget`, `aborted`, `loadError`). */
  targets: DrillTargetStats[];
  /**
   * The targets that were searched, in drill order. The two drills differ:
   * the history drill lists every target whose history loaded, even if its
   * filters then left no candidate; the card drill (`card-drill.ts`, used
   * when the history is unavailable) lists only targets whose card offered
   * at least one candidate, since a card-less target was not searched at
   * all. Callers report `sessionsSearched` from it either way.
   */
  drilledSessions: string[];
  budgetExhausted: boolean;
  loadErrors: string[];
};

/** One session to sweep in deep mode, ordered newest-first by the caller. */
export type DeepTarget = DrillTarget;

export type DeepInput = {
  /** The scoped session set to sweep, newest-first. On a resumed sweep the
   *  first entry is the session that was mid-sweep and {@link DeepInput.resume}
   *  carries its page cursor. */
  sessions: DeepTarget[];
  query: ParsedQuery;
  /** Per-query candidate eligibility (type/role/time/toolName), applied to each
   *  swept session's candidates (mirrors the drill's `filter`). */
  filter?: (candidate: Candidate) => boolean;
  /** Append each session's bound title candidate (mirrors the drill). */
  searchTitles?: boolean;
  /** Authorship buckets to keep (mirrors {@link DrillInput.authorship}). */
  authorship?: ReadonlySet<Authorship>;
  /** Retained-chars budget for the whole sweep (`limits.deepCharsPerQuery`). */
  charsPerQuery: number;
  /** Resume state: the page cursor to continue the FIRST session from. */
  resume?: { before: string | null };
  abort?: AbortSignal;
};

/** How far a deep sweep got through its scoped set. */
export type DeepCoverage = {
  sessionsCovered: number;
  sessionsPartial: number;
  sessionsRemaining: number;
  exhaustedBudget: boolean;
};

/** Continuation state emitted when a sweep stops on a budget (opaque to callers
 *  once encoded). `current` is the session left mid-sweep (null when the sweep
 *  stopped cleanly between sessions), `before` its resume page cursor, and
 *  `remaining` the session ids never reached. */
export type DeepContinuation = {
  current: string | null;
  before: string | null;
  remaining: string[];
};

export type DeepOutput = {
  pools: DrilledPool[];
  drilledSessions: string[];
  /** Every scoped session in sweep order: swept ones with their pool's
   *  stats (`end`, or the budget that stopped the sweep inside one), and
   *  those never reached with zero counts and the reason the sweep stopped
   *  (`budget`, `wallClock`, `aborted`). */
  targets: DrillTargetStats[];
  loadErrors: string[];
  coverage: DeepCoverage;
  continuation?: DeepContinuation;
};

export type Drill = {
  drill(input: DrillInput): Promise<DrillOutput>;
  /** Collect the drilled candidate pools without BM25 scoring, for literal/regex
   *  modes that scan the pool directly. Same bounded fetch + budgets + LRU as
   *  {@link Drill.drill}. */
  pools(input: DrillInput): Promise<DrillPoolsOutput>;
  /**
   * Deep sweep: fetch EVERY part of each scoped session (tool outputs included),
   * exhaustively (no anchor early-stop), under a retained-chars + wall-clock
   * budget, returning the candidate pools plus a continuation cursor when a
   * budget stopped the sweep. Never touches the drill LRU (sweeps are large and
   * would thrash it).
   */
  deep(input: DeepInput): Promise<DeepOutput>;
  /** Candidate chars currently held by the drill cache (diagnostics/tests). */
  cachedChars(): number;
};

export type DrillDeps = {
  source: HistorySource;
  gate: FetchGate;
  limits: Limits;
  /** Injectable clock for the deep sweep's wall-clock budget and the drill
   *  cache's time bound (tests). */
  now?: () => number;
  /** Soft wall-clock budget for a deep sweep in ms (default 20s). Injectable so
   *  tests can force a time stop without a real 20s wait. */
  deepWallClockMs?: number;
  /** Objects the drill cache may hold across all sessions (default
   *  {@link MAX_CACHED_OBJECTS}). Injectable so tests can reach the bound
   *  without fetching tens of thousands of messages. */
  maxCachedObjects?: number;
};

/** Messages per page during a deep sweep (the spec's exhaustive page size). */
const DEEP_PAGE_MESSAGES = 50;
/** Default soft wall-clock budget for a deep sweep. */
const DEFAULT_DEEP_WALL_CLOCK_MS = 20_000;
/** How long the drill cache serves a session whose target carries no card
 *  `writeRev`. Without a revision only `timeUpdated` can reveal a change, and
 *  an uncarded or unverified target may carry 0 there, so a short bound caps
 *  how stale those pages can get. */
export const UNREVISED_ENTRY_TTL_MS = 30_000;
/** Default bound on the objects the drill cache holds, counting each session
 *  entry, cached page, page message, point lookup and not-found lookup as one.
 *  `cacheMaxChars` bounds candidate chars only, and an entry or page with no
 *  messages, a message with no searchable text or a not-found lookup charges
 *  none, though each stays in memory. So the cache evicts while either bound
 *  is passed. */
export const MAX_CACHED_OBJECTS = 50_000;

// ── Deep continuation cursor (opaque base64url JSON) ─────────────────────────
// btoa/atob are DOM globals (available under Bun and Node), so no Node Buffer is
// needed. The payload is ASCII (session ids, base64url page cursors, integers),
// so no unicode escaping is required; every path is still guarded so a malformed
// cursor degrades to a clean rejection rather than a throw.

function base64urlEncode(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(text: string): string {
  return atob(text.replace(/-/g, "+").replace(/_/g, "/"));
}

export type DeepCursorPayload = {
  v: 1;
  remaining: string[];
  current: string | null;
  before: string | null;
};

export function encodeDeepCursor(payload: DeepCursorPayload): string {
  return base64urlEncode(JSON.stringify(payload));
}

/** Decode a `deepCursor`; returns null (never throws) for any malformed input so
 *  the caller can answer with guidance instead of crashing. */
export function decodeDeepCursor(raw: string): DeepCursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(base64urlDecode(raw));
    if (!parsed || typeof parsed !== "object") return null;
    const rec = parsed as Record<string, unknown>;
    if (rec.v !== 1) return null;
    if (!Array.isArray(rec.remaining)) return null;
    const remaining = rec.remaining.filter((x): x is string => typeof x === "string");
    if (remaining.length !== rec.remaining.length) return null;
    const current = typeof rec.current === "string" ? rec.current : null;
    const before = typeof rec.before === "string" ? rec.before : null;
    return { v: 1, remaining, current, before };
  } catch {
    return null;
  }
}

/**
 * A fetched message as the drill cache keeps it: its candidates built and
 * normalized once, without the slice-dependent digest. The parts are dropped;
 * `message` keeps only `info`, for ordering through `compareMessages`.
 * `retained` is the message's charge against the per-session budget and
 * `chars` the candidate chars it holds.
 */
type DrilledMessage = {
  message: HistoryMessage;
  candidates: Candidate[];
  retained: number;
  chars: number;
};

/** One cached newest-first page and the cursor it returned. */
type CachedPage = { items: DrilledMessage[]; nextCursor: string | null };

/** Why a slice's walk stopped (see {@link DrillStop}). */
type SliceStop = Extract<DrillStop, "anchor" | "sessionBudget" | "end" | "targetsCut">;

/** The messages one query's slice of a session holds (see `sliceFor`).
 *  `fetches` counts the history reads building it took (0 when the cache
 *  held everything). */
type Slice = {
  messages: DrilledMessage[];
  signature: string;
  points: Array<[string, DrilledMessage]>;
  stop: SliceStop;
  fetches: number;
};

/** History reads a slice made, counted as `pageAt` and `pointAt` fetch. */
type SliceReads = { fetches: number };

/**
 * The candidates one query's slice of a session builds to. `signature` names
 * the slice (pages walked, point lookups added), so a later query that lands
 * on the same slice reuses the build. `parentID` records the parentage the
 * candidates are currently STAMPED with, so a hit served to a target that
 * disagrees can be restamped instead of silently inheriting it.
 */
type SliceBuild = {
  signature: string;
  candidates: Candidate[];
  chars: number;
  parentID: string | null | undefined;
};

/**
 * Everything the drill fetched for one session version. `stamp` is the
 * (time.updated, writeRev) pair it was filled under; `expiresAt` bounds an
 * entry filled without a revision. `pages` is keyed by the cursor that
 * produced each page ("" for the first page: a source never hands back an
 * empty cursor, since the paging loop reads one as the end of the session).
 * `points` holds point lookups by requested message id, with null for a
 * not-found. `chars` and `objects` are the entry's charge against
 * `cacheMaxChars` and the cached-object bound; `objects` counts the entry
 * itself from the moment it is cached. The `build`'s candidates are
 * shallow copies of candidates the entry holds, sharing their strings, so
 * they add no charge; a build is cached only while every message under it is
 * still held. `live` turns false once the entry leaves the cache, after which
 * a query still holding it stops charging the cache totals.
 */
type SessionEntry = {
  sessionId: string;
  stamp: string;
  expiresAt: number | undefined;
  pages: Map<string, CachedPage>;
  points: Map<string, DrilledMessage | null>;
  pointChars: number;
  chars: number;
  objects: number;
  build: SliceBuild | undefined;
  live: boolean;
};

const MAX_LOAD_ERROR_SAMPLES = 5;

/** Distinct messages among `candidates`; a title candidate is not a message
 *  and is left out. */
export function countMessages(candidates: readonly Candidate[]): number {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.partType !== "title") ids.add(candidate.messageID);
  }
  return ids.size;
}

/** Zero-count stats for `targets` from `from` on, none of which was read. */
export function unreadTargets(
  targets: readonly DrillTarget[],
  from: number,
  stop: DrillStop,
): DrillTargetStats[] {
  return targets.slice(from).map((target) => ({
    sessionId: target.sessionId,
    fetched: 0,
    candidate: 0,
    eligible: 0,
    stop,
  }));
}

function anchorNeedles(query: ParsedQuery): string[] {
  return [...query.tokens, ...query.phrases, ...query.codeTokens.map((t) => t.toLowerCase())];
}

/** Whether any searchable text on the page contains a needle. A message's
 *  candidates carry every searchable field of its parts (a part without one
 *  builds no candidate), so this reads the same texts the raw parts hold. */
function partsMatchAnchor(page: DrilledMessage[], needles: string[]): boolean {
  if (needles.length === 0) return true;
  for (const msg of page) {
    for (const candidate of msg.candidates) {
      for (const field of candidate.fieldTexts) {
        const lower = field.text.toLowerCase();
        if (needles.some((n) => lower.includes(n))) return true;
      }
    }
  }
  return false;
}

/** Rough retained-bytes estimate for a fetched message, matching the per-part
 *  cap the candidate build applies, so paging can stop before over-fetching. */
function estimateRetained(msg: HistoryMessage): number {
  let total = 0;
  for (const part of msg.parts) {
    for (const text of searchable(part)) total += Math.min(text.length, MAX_CHARS_PER_CANDIDATE);
  }
  return total;
}

export function createDrill(deps: DrillDeps): Drill {
  const { source, gate, limits } = deps;
  const clock = deps.now ?? Date.now;
  const maxCachedObjects = deps.maxCachedObjects ?? MAX_CACHED_OBJECTS;
  // Per-session LRU of fetched pages and point lookups; Map order is LRU order.
  const cache = new Map<string, SessionEntry>();
  let cachedTotal = 0;
  let cachedObjects = 0;

  function charge(entry: SessionEntry, chars: number, objects: number): void {
    entry.chars += chars;
    entry.objects += objects;
    if (!entry.live) return;
    cachedTotal += chars;
    cachedObjects += objects;
  }

  function drop(entry: SessionEntry): void {
    if (!entry.live) return;
    entry.live = false;
    cache.delete(entry.sessionId);
    cachedTotal -= entry.chars;
    cachedObjects -= entry.objects;
  }

  function evict(): void {
    for (const entry of cache.values()) {
      if (cachedTotal <= limits.cacheMaxChars && cachedObjects <= maxCachedObjects) break;
      drop(entry);
    }
  }

  /**
   * The cache entry for the target's session version, moved to MRU, or a new
   * empty one when the cached entry was filled under another (time.updated,
   * writeRev) pair or has outlived its time bound. The cache holds one entry
   * per session id, so targets that stamp one session differently replace
   * each other's entry rather than sharing the cache. A session-scoped
   * query's target carries the session's live `time.updated` and the live
   * card's `writeRev`, a ranked target its snapshot card's, so the two
   * refetch on every switch while the card or the snapshot lags the session.
   *
   * The key deliberately omits `target.parentID`. Two targets for the same
   * session CAN disagree about parentage under the same stamp — a card without
   * a `writeRev` whose `timeUpdated` is 0, or an id with no card at all, stamps
   * the same as the metadata-less fallback — so the stamp alone cannot be
   * trusted to imply matching parentage. Extending the key would instead
   * refetch the same session, which is exactly what this cache exists to
   * avoid. So parentage is treated as TARGET metadata rather than
   * message-derived data: a build whose stamp disagrees with the current
   * target is restamped onto a copy ({@link restamped}). Getting this wrong
   * fails OPEN — cached root parentage served to an unknown-parentage target
   * would let its candidates satisfy `authorship: "human"`. Title and
   * directory are not restamped (see {@link prepare}).
   */
  function entryFor(target: DrillTarget): SessionEntry {
    const stamp = `${target.timeUpdated}:${target.writeRev ?? ""}`;
    const now = clock();
    const cached = cache.get(target.sessionId);
    if (cached) {
      const expired = cached.expiresAt !== undefined && now >= cached.expiresAt;
      if (cached.stamp === stamp && !expired) {
        cache.delete(target.sessionId); // move to MRU
        cache.set(target.sessionId, cached);
        return cached;
      }
      drop(cached);
    }
    const entry: SessionEntry = {
      sessionId: target.sessionId,
      stamp,
      expiresAt: target.writeRev === undefined ? now + UNREVISED_ENTRY_TTL_MS : undefined,
      pages: new Map(),
      points: new Map(),
      pointChars: 0,
      chars: 0,
      objects: 0,
      build: undefined,
      live: true,
    };
    cache.set(target.sessionId, entry);
    // The entry counts as one object for as long as it is cached, so entries
    // that never cache a message (an empty history, a failed first read) still
    // fill the bound and are evicted.
    charge(entry, 0, 1);
    return entry;
  }

  /** Build one fetched message's candidates once, for every slice that holds it.
   *  Their `sessionTitle` and `directory` come from the target that filled the
   *  entry and, unlike parentage, are not restamped: two targets with the same
   *  stamp but different titles both see the first one's. A title change
   *  rewrites the card and moves its `writeRev`, so this reaches only targets
   *  without one. */
  function prepare(msg: HistoryMessage, target: DrillTarget): DrilledMessage {
    const { candidates, charsUsed } = buildCandidates([msg], {
      id: target.sessionId,
      title: target.title,
      directory: target.directory,
      parentID: target.parentID,
    });
    for (const candidate of candidates) populateNormalized(candidate);
    return {
      message: { info: msg.info, parts: [] },
      candidates,
      retained: estimateRetained(msg),
      chars: charsUsed,
    };
  }

  /** The page `before` names, from the cache or fetched and cached. A page a
   *  concurrent query cached while this fetch was in flight wins, so every
   *  query walks one consistent chain. */
  async function pageAt(
    entry: SessionEntry,
    target: DrillTarget,
    before: string | undefined,
    reads: SliceReads,
  ): Promise<CachedPage> {
    const key = before ?? "";
    const hit = entry.pages.get(key);
    if (hit) return hit;
    reads.fetches++;
    const page = await gate.runQuery(() =>
      source.messagePage({
        sessionID: target.sessionId,
        limit: limits.drillPageMessages,
        before,
      }),
    );
    const raced = entry.pages.get(key);
    if (raced) return raced;
    const cached: CachedPage = {
      items: page.items.map((msg) => prepare(msg, target)),
      nextCursor: page.nextCursor,
    };
    entry.pages.set(key, cached);
    let chars = 0;
    for (const msg of cached.items) chars += msg.chars;
    // The page itself counts as one object, so an empty page is not free.
    charge(entry, chars, cached.items.length + 1);
    return cached;
  }

  /**
   * A point lookup, from the cache or fetched and cached; null when the source
   * has no such message. Only a not-found is cached as null: any other failure
   * may be transient, so the next query asks again.
   *
   * Point lookups differ from query to query, so their cached chars are capped
   * at the per-session budget. A lookup that would pass the cap first drops
   * every cached lookup outside `own`, the ids the current query has asked for,
   * and drops the cached build, which may hold them. The query's own lookups
   * stay, so repeating it refetches nothing, and they may pass the cap by about
   * one message: the lookup loop checks the per-session budget before each
   * fetch, so a query's lookups stop within one message of it.
   */
  async function pointAt(
    entry: SessionEntry,
    target: DrillTarget,
    messageID: string,
    own: ReadonlySet<string>,
    reads: SliceReads,
  ): Promise<DrilledMessage | null> {
    const hit = entry.points.get(messageID);
    if (hit !== undefined) return hit;
    reads.fetches++;
    const lookup = await gate.runQuery(() => source.getMessage(target.sessionId, messageID));
    const raced = entry.points.get(messageID);
    if (raced !== undefined) return raced;
    if (!lookup.ok) {
      if (lookup.reason === "not-found") {
        entry.points.set(messageID, null);
        charge(entry, 0, 1);
      }
      return null;
    }
    const msg = prepare(lookup.value, target);
    if (entry.pointChars + msg.chars > limits.drillCharsPerSession) {
      for (const [id, cached] of entry.points) {
        if (own.has(id)) continue;
        entry.points.delete(id);
        const chars = cached?.chars ?? 0;
        entry.pointChars -= chars;
        charge(entry, -chars, -1);
      }
      entry.build = undefined;
    }
    entry.points.set(messageID, msg);
    entry.pointChars += msg.chars;
    charge(entry, msg.chars, 1);
    return msg;
  }

  /**
   * The messages an uncached fetch would return for this query: the paging
   * loop and the point lookups run over the cache with the query's own stop
   * rules, fetching only what the cache lacks. `signature` names the slice by
   * the pages walked and the point lookups added; with the entry's pages fixed
   * for its lifetime, equal signatures mean equal slices. `points` lists the
   * lookups added, by requested id, so the caller can tell whether the entry
   * still holds them all. `stop` says why the walk ended: the session's end
   * when its last page was read (even if that page also missed every
   * anchor), else the anchor stop or the per-session budget, and
   * `targetsCut` when paging ended otherwise but the budget then left point
   * lookups unread.
   */
  async function sliceFor(
    entry: SessionEntry,
    target: DrillTarget,
    needles: string[],
    ftsHits: FtsHit[] | undefined,
  ): Promise<Slice> {
    const byId = new Map<string, DrilledMessage>();
    const reads: SliceReads = { fetches: 0 };
    let retained = 0;

    // Untargeted: bounded newest-first paging.
    let cursor: string | undefined;
    let pagesWalked = 0;
    let anchorStop = false;
    do {
      const page = await pageAt(entry, target, cursor, reads);
      pagesWalked++;
      for (const msg of page.items) {
        const id = msg.message.info.id;
        if (!byId.has(id)) {
          byId.set(id, msg);
          retained += msg.retained;
        }
      }
      cursor = page.nextCursor ?? undefined;
      // Stop once a non-first page stops matching any anchor (nothing more to gain).
      if (pagesWalked > 1 && !partsMatchAnchor(page.items, needles)) {
        anchorStop = true;
        break;
      }
    } while (cursor && retained < limits.drillCharsPerSession);
    let stop: SliceStop = !cursor ? "end" : anchorStop ? "anchor" : "sessionBudget";

    // Targeted: point-fetch each FTS hit's message plus its stored neighbors,
    // charging their retained chars against the SAME per-session budget as the
    // untargeted paging — once the session's budget is exhausted, stop fetching
    // further point targets (matching the documented per-session bound).
    const points: Array<[string, DrilledMessage]> = [];
    if (ftsHits && ftsHits.length > 0) {
      const wanted = new Set<string>();
      for (const hit of ftsHits) {
        wanted.add(hit.messageId);
        if (hit.prevMessageId) wanted.add(hit.prevMessageId);
        if (hit.nextMessageId) wanted.add(hit.nextMessageId);
      }
      const asked = new Set<string>();
      for (const messageID of wanted) {
        if (byId.has(messageID)) continue;
        if (retained >= limits.drillCharsPerSession) {
          if (stop !== "sessionBudget") stop = "targetsCut";
          break;
        }
        asked.add(messageID);
        const msg = await pointAt(entry, target, messageID, asked, reads);
        if (!msg) continue;
        byId.set(msg.message.info.id, msg);
        retained += msg.retained;
        points.push([messageID, msg]);
      }
    }

    return {
      messages: [...byId.values()],
      signature: [String(pagesWalked), ...points.map(([id]) => id)].join("\n"),
      points,
      stop,
      fetches: reads.fetches,
    };
  }

  /** Return the build's candidates carrying `parentID` as their session
   *  parentage. The common case (the stamp already matches) returns the cached
   *  array untouched. On a mismatch the candidates are SHALLOW-COPIED before
   *  restamping: the cached array may be held by a concurrent reader, and
   *  mutating it in place would retroactively change that reader's
   *  classification. The cached build itself is never rewritten, so it stays
   *  the canonical build for whichever target made it. */
  function restamped(build: SliceBuild, parentID: string | null | undefined): SliceBuild {
    if (build.parentID === parentID) return build;
    const candidates = build.candidates.map((candidate) => ({
      ...candidate,
      sessionParentID: parentID,
    }));
    return { signature: build.signature, candidates, chars: build.chars, parentID };
  }

  /** The slice's candidates newest message first, as `buildCandidates` emits
   *  them over the chronological slice, stamped with the slice's digest and the
   *  target's parentage. The cached per-message candidates are copied, never
   *  stamped, since other slices share them. */
  function assemble(target: DrillTarget, slice: Slice): SliceBuild {
    const chrono = [...slice.messages].sort((a, b) => compareMessages(a.message, b.message));
    const built: Candidate[] = [];
    let chars = 0;
    for (let i = chrono.length - 1; i >= 0; i--) {
      const msg = chrono[i]!;
      for (const candidate of msg.candidates) built.push(candidate);
      chars += msg.chars;
    }

    // Content-derived session digest, stamped as a normalized field so
    // content-identity participates in ranking exactly as the corpus scan did
    // (the digest-bridge case depends on this).
    const digestText = buildSessionDigest(built);
    const normalizedDigest = digestText ? normalize(digestText) : "";
    const candidates = built.map((candidate) => ({
      ...candidate,
      sessionParentID: target.parentID,
      digestText: normalizedDigest,
    }));
    return { signature: slice.signature, candidates, chars, parentID: target.parentID };
  }

  /** One target's slice built to candidates, with the messages it holds,
   *  why its walk stopped, and whether the cache held all of it. */
  async function candidatesFor(
    target: DrillTarget,
    needles: string[],
    ftsHits: FtsHit[] | undefined,
  ): Promise<{ build: SliceBuild; fetched: number; stop: SliceStop; cached: boolean }> {
    const entry = entryFor(target);
    try {
      const slice = await sliceFor(entry, target, needles, ftsHits);
      const read = {
        fetched: slice.messages.length,
        stop: slice.stop,
        cached: slice.fetches === 0,
      };
      if (entry.build?.signature === slice.signature) {
        return { build: restamped(entry.build, target.parentID), ...read };
      }
      const build = assemble(target, slice);
      // A concurrent query may have evicted some of this slice's lookups
      // while it waited on a later one. Caching the build then would keep
      // their candidates reachable with their chars no longer charged.
      // Page messages need no check: a live entry never drops a page.
      if (slice.points.every(([id, msg]) => entry.points.get(id) === msg)) entry.build = build;
      return { build, ...read };
    } finally {
      evict();
    }
  }

  /** Shared bounded fetch loop for both the BM25 and scan paths: drills each
   *  shortlisted session under the per-query budget and returns its candidate
   *  pool plus which sessions were reached in the card-supported deep set. */
  async function collectPools(input: DrillInput): Promise<DrillPoolsOutput> {
    const needles = anchorNeedles(input.query);
    const pools: DrilledPool[] = [];
    const drilledSessions: string[] = [];
    const targets: DrillTargetStats[] = [];
    const loadErrors: string[] = [];
    let queryRetained = 0;
    let budgetExhausted = false;

    for (let i = 0; i < input.sessions.length; i++) {
      const target = input.sessions[i]!;
      if (input.abort?.aborted) {
        targets.push(...unreadTargets(input.sessions, i, "aborted"));
        break;
      }
      if (queryRetained >= limits.drillCharsPerQuery) {
        budgetExhausted = true;
        targets.push(...unreadTargets(input.sessions, i, "queryBudget"));
        break;
      }
      let read: Awaited<ReturnType<typeof candidatesFor>>;
      try {
        read = await candidatesFor(target, needles, input.ftsBySession?.get(target.sessionId));
      } catch (error) {
        if (loadErrors.length < MAX_LOAD_ERROR_SAMPLES) {
          loadErrors.push(`${target.sessionId}: ${errmsg(error)}`);
        }
        targets.push(...unreadTargets([target], 0, "loadError"));
        continue;
      }
      queryRetained += read.build.chars;
      drilledSessions.push(target.sessionId);
      const pool = poolFor(target, read.build.candidates, input);
      const stats: DrillSessionStats = {
        fetched: read.fetched,
        candidate: countMessages(read.build.candidates),
        eligible: countMessages(pool.candidates),
        stop: read.stop,
        ...(read.cached && { cached: true as const }),
      };
      pools.push({ target, ...pool, stats });
      targets.push({ sessionId: target.sessionId, ...stats });
    }
    return { pools, drilledSessions, targets, loadErrors, budgetExhausted };
  }

  /**
   * The per-query scan/score pool for one drilled session, in THREE ORDERED
   * STAGES. The order is load-bearing:
   *
   * 1. **Eligibility** — the query's type/role/time/toolName predicate
   *    (`candidateEligible`), mirroring `assembleSession`.
   * 2. **Title construction** — from the ELIGIBLE pool, exactly as before: the
   *    representative is `eligible[0]` (newest eligible) and the bound title
   *    candidate is appended when title search applies.
   * 3. **Authorship** — over the COMBINED pool, title included.
   *
   * Stage 3 must not move ahead of stage 2. The title candidate is *derived
   * from* the pool (it borrows the representative's messageID/role/time), not
   * merely appended to it, so filtering first can leave nothing to build from
   * and would make `authorship: "title"` return nothing on every session. With
   * this order the title needs no special-casing at all: it classifies `title`
   * and the ordinary filter decides.
   *
   * Shared by the bounded drill and the deep sweep.
   */
  function poolFor(
    target: DrillTarget,
    cached: Candidate[],
    input: {
      filter?: (candidate: Candidate) => boolean;
      searchTitles?: boolean;
      authorship?: ReadonlySet<Authorship>;
    },
  ): { candidates: Candidate[]; authorshipDropped?: AuthorshipCounts; authorshipRemoved?: number } {
    // ── Stage 1: eligibility ──
    const eligible = input.filter ? cached.filter(input.filter) : cached;

    // ── Stage 2: title construction from the eligible pool ──
    let pool = eligible;
    if (input.searchTitles) {
      const representative = eligible[0]; // newest eligible, matching assembleSession
      if (representative) {
        const title = buildTitleCandidate(
          { id: target.sessionId, title: target.title, directory: target.directory },
          {
            id: representative.messageID,
            role: representative.role,
            time: { created: representative.time },
          },
        );
        if (title) {
          populateNormalized(title);
          // All of a session's candidates carry the same stamped digest; reuse
          // it so the title candidate participates in ranking exactly as before.
          title.digestText = cached[0]?.digestText ?? "";
          pool = [...eligible, title];
        }
      }
    }

    // ── Stage 3: authorship over the combined pool (title included) ──
    if (!input.authorship) return { candidates: pool };
    const wanted = input.authorship;
    const kept: Candidate[] = [];
    const authorshipDropped: AuthorshipCounts = {};
    let authorshipRemoved = 0;
    for (const candidate of pool) {
      const bucket = authorshipOf(candidate);
      if (wanted.has(bucket)) {
        kept.push(candidate);
        continue;
      }
      authorshipRemoved++;
      // Title drops are counted but not attributed — see DrilledPool.
      if (candidate.partType === "title") continue;
      authorshipDropped[bucket] = (authorshipDropped[bucket] ?? 0) + 1;
    }
    return { candidates: kept, authorshipDropped, authorshipRemoved };
  }

  return {
    async drill(input): Promise<DrillOutput> {
      const collected = await collectPools(input);
      const broadPool: Candidate[] = [];
      const deepPool: Candidate[] = [];
      for (const pool of collected.pools) {
        broadPool.push(...pool.candidates);
        if (input.deepSet.has(pool.target.sessionId)) deepPool.push(...pool.candidates);
      }

      const broad = bm25Search(broadPool, input.query, input.mode, input.explain);
      const deep = bm25Search(deepPool, input.query, input.mode, input.explain);
      const hits = mergeShortlistHits(broad, deep, input.explain);
      return { hits, ...collected };
    },

    async pools(input): Promise<DrillPoolsOutput> {
      return collectPools(input);
    },

    async deep(input): Promise<DeepOutput> {
      const now = deps.now ?? Date.now;
      const wallClockMs = deps.deepWallClockMs ?? DEFAULT_DEEP_WALL_CLOCK_MS;
      const deadline = now() + wallClockMs;
      const charsPerQuery = input.charsPerQuery;

      const budget = { retained: 0 };
      const pools: DrilledPool[] = [];
      const drilledSessions: string[] = [];
      const targetStats: DrillTargetStats[] = [];
      const loadErrors: string[] = [];
      let sessionsCovered = 0;
      let sessionsPartial = 0;
      let continuation: DeepContinuation | undefined;

      type SweepStop = Extract<DrillStop, "aborted" | "budget" | "wallClock">;
      /** What stops the sweep now, if anything. */
      const overBudget = (): SweepStop | undefined => {
        if (input.abort?.aborted === true) return "aborted";
        if (budget.retained >= charsPerQuery) return "budget";
        if (now() >= deadline) return "wallClock";
        return undefined;
      };

      /** Sweep one session exhaustively from `startBefore`, stopping cleanly on a
       *  budget. Always fetches at least one page so the sweep makes progress. */
      const sweepSession = async (
        target: DeepTarget,
        startBefore: string | null,
      ): Promise<{
        candidates: Candidate[];
        fetched: number;
        nextBefore: string | null;
        stopped: SweepStop | undefined;
      }> => {
        const messages: HistoryMessage[] = [];
        let cursor: string | undefined = startBefore ?? undefined;
        let stopped: SweepStop | undefined;
        let fetchedAny = false;
        for (;;) {
          stopped = fetchedAny ? overBudget() : input.abort?.aborted ? "aborted" : undefined;
          if (stopped) break;
          const before = cursor;
          const page = await gate.runQuery(() =>
            source.messagePage({
              sessionID: target.sessionId,
              limit: DEEP_PAGE_MESSAGES,
              before,
            }),
          );
          fetchedAny = true;
          for (const msg of page.items) {
            messages.push(msg);
            budget.retained += estimateRetained(msg);
          }
          cursor = page.nextCursor ?? undefined;
          if (!cursor) break; // session fully swept
        }

        const chrono = [...messages].sort(compareMessages);
        const { candidates } = buildCandidates(chrono, {
          id: target.sessionId,
          title: target.title,
          directory: target.directory,
          parentID: target.parentID,
        });
        for (const candidate of candidates) populateNormalized(candidate);
        const digestText = buildSessionDigest(candidates);
        const normalizedDigest = digestText ? normalize(digestText) : "";
        for (const candidate of candidates) candidate.digestText = normalizedDigest;
        return {
          candidates,
          fetched: messages.length,
          nextBefore: stopped ? (cursor ?? null) : null,
          stopped,
        };
      };

      const targets = input.sessions;
      const remainingFrom = (index: number): string[] =>
        targets.slice(index).map((t) => t.sessionId);

      for (let i = 0; i < targets.length; i++) {
        const target = targets[i]!;
        // Budget spent between sessions: this session and the rest are untouched.
        const between = overBudget();
        if (between) {
          continuation = { current: null, before: null, remaining: remainingFrom(i) };
          targetStats.push(...unreadTargets(targets, i, between));
          break;
        }
        const startBefore = i === 0 ? (input.resume?.before ?? null) : null;
        let swept: Awaited<ReturnType<typeof sweepSession>>;
        try {
          swept = await sweepSession(target, startBefore);
        } catch (error) {
          if (loadErrors.length < MAX_LOAD_ERROR_SAMPLES) {
            loadErrors.push(`${target.sessionId}: ${errmsg(error)}`);
          }
          targetStats.push(...unreadTargets([target], 0, "loadError"));
          continue;
        }
        const pool = poolFor(target, swept.candidates, input);
        const stats: DrillSessionStats = {
          fetched: swept.fetched,
          candidate: countMessages(swept.candidates),
          eligible: countMessages(pool.candidates),
          stop: swept.stopped ?? "end",
        };
        pools.push({ target, ...pool, stats });
        targetStats.push({ sessionId: target.sessionId, ...stats });
        drilledSessions.push(target.sessionId);
        if (swept.stopped) {
          sessionsPartial++;
          continuation = {
            current: target.sessionId,
            before: swept.nextBefore,
            remaining: remainingFrom(i + 1),
          };
          targetStats.push(...unreadTargets(targets, i + 1, swept.stopped));
          break;
        }
        sessionsCovered++;
      }

      const exhaustedBudget = continuation != null;
      return {
        pools,
        drilledSessions,
        targets: targetStats,
        loadErrors,
        coverage: {
          sessionsCovered,
          sessionsPartial,
          sessionsRemaining: continuation ? continuation.remaining.length : 0,
          exhaustedBudget,
        },
        continuation,
      };
    },

    cachedChars(): number {
      return cachedTotal;
    },
  };
}
