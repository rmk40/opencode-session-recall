import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2";
import { errmsg, type Limits } from "./types.js";
import type { FetchGate } from "./fetch-gate.js";
import type { ParsedQuery } from "./query.js";
import { fetchMessagePage } from "./distill.js";
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
 * per-query retained budget caps the whole drill; a small LRU keyed
 * (session, time.updated) keeps repeat/refined queries warm.
 */

type MsgWithParts = { info: Message; parts: Part[] };

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
   *  drill LRU holds the unfiltered pool, so the filter runs per query. */
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

export type DrillOutput = {
  hits: Bm25Hit[];
  /** The drilled candidate pools the hits were scored over (coverage counts). */
  pools: DrilledPool[];
  drilledSessions: string[];
  budgetExhausted: boolean;
  loadErrors: string[];
};

export type DrillPoolsOutput = {
  pools: DrilledPool[];
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
  /** Retained-chars currently held by the drilled-session LRU (diagnostics/tests). */
  cachedChars(): number;
};

export type DrillDeps = {
  client: OpencodeClient;
  gate: FetchGate;
  limits: Limits;
  /** Injectable clock for the deep sweep's wall-clock budget (tests). */
  now?: () => number;
  /** Soft wall-clock budget for a deep sweep in ms (default 20s). Injectable so
   *  tests can force a time stop without a real 20s wait. */
  deepWallClockMs?: number;
};

/** Messages per page during a deep sweep (the spec's exhaustive page size). */
const DEEP_PAGE_MESSAGES = 50;
/** Default soft wall-clock budget for a deep sweep. */
const DEFAULT_DEEP_WALL_CLOCK_MS = 20_000;

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

/** One cached session build. `parentID` records the session parentage the
 *  cached candidates are currently STAMPED with, so a hit served to a target
 *  that disagrees can be restamped instead of silently inheriting it. */
type CacheEntry = { candidates: Candidate[]; chars: number; parentID: string | null | undefined };

const MAX_LOAD_ERROR_SAMPLES = 5;

function anchorNeedles(query: ParsedQuery): string[] {
  return [...query.tokens, ...query.phrases, ...query.codeTokens.map((t) => t.toLowerCase())];
}

function partsMatchAnchor(page: MsgWithParts[], needles: string[]): boolean {
  if (needles.length === 0) return true;
  for (const msg of page) {
    for (const part of msg.parts) {
      for (const text of searchable(part)) {
        const lower = text.toLowerCase();
        if (needles.some((n) => lower.includes(n))) return true;
      }
    }
  }
  return false;
}

/** Rough retained-bytes estimate for a fetched message, matching the per-part
 *  cap the candidate build applies, so paging can stop before over-fetching. */
function estimateRetained(msg: MsgWithParts): number {
  let total = 0;
  for (const part of msg.parts) {
    for (const text of searchable(part)) total += Math.min(text.length, MAX_CHARS_PER_CANDIDATE);
  }
  return total;
}

export function createDrill(deps: DrillDeps): Drill {
  const { client, gate, limits } = deps;
  // Drilled-session LRU keyed by (session, time.updated); Map order is LRU order.
  const cache = new Map<string, CacheEntry>();
  let cachedTotal = 0;

  function evict(): void {
    for (const key of cache.keys()) {
      if (cachedTotal <= limits.cacheMaxChars) break;
      const entry = cache.get(key)!;
      cache.delete(key);
      cachedTotal -= entry.chars;
    }
  }

  async function fetchDrilledMessages(
    target: DrillTarget,
    needles: string[],
    ftsHits: FtsHit[] | undefined,
  ): Promise<MsgWithParts[]> {
    const byId = new Map<string, MsgWithParts>();
    let retained = 0;

    // Untargeted: bounded newest-first paging.
    let cursor: string | undefined;
    let firstPage = true;
    do {
      const before = cursor;
      const page = await gate.runQuery(() =>
        fetchMessagePage(client, {
          sessionID: target.sessionId,
          limit: limits.drillPageMessages,
          before,
        }),
      );
      const matched = partsMatchAnchor(page.items, needles);
      for (const msg of page.items) {
        if (!byId.has(msg.info.id)) {
          byId.set(msg.info.id, msg);
          retained += estimateRetained(msg);
        }
      }
      cursor = page.nextCursor ?? undefined;
      // Stop once a non-first page stops matching any anchor (nothing more to gain).
      if (!firstPage && !matched) break;
      firstPage = false;
    } while (cursor && retained < limits.drillCharsPerSession);

    // Targeted: point-fetch each FTS hit's message plus its stored neighbors,
    // charging their retained chars against the SAME per-session budget as the
    // untargeted paging — once the session's budget is exhausted, stop fetching
    // further point targets (matching the documented per-session bound).
    if (ftsHits && ftsHits.length > 0) {
      const wanted = new Set<string>();
      for (const hit of ftsHits) {
        wanted.add(hit.messageId);
        if (hit.prevMessageId) wanted.add(hit.prevMessageId);
        if (hit.nextMessageId) wanted.add(hit.nextMessageId);
      }
      for (const messageID of wanted) {
        if (retained >= limits.drillCharsPerSession) break;
        if (byId.has(messageID)) continue;
        const resp = await gate.runQuery(() =>
          client.session.message({ sessionID: target.sessionId, messageID }),
        );
        if (resp.error || !resp.data) continue;
        const bundle = resp.data as MsgWithParts;
        byId.set(bundle.info.id, bundle);
        retained += estimateRetained(bundle);
      }
    }

    // Chronological (oldest-first) for buildCandidates, which walks newest-first.
    return [...byId.values()].sort(
      (a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id),
    );
  }

  /** Return the entry's candidates carrying `parentID` as their session
   *  parentage. The common case (the stamp already matches) returns the cached
   *  array untouched. On a mismatch the candidates are SHALLOW-COPIED before
   *  restamping: the cached array may be held by a concurrent reader, and
   *  mutating it in place would retroactively change that reader's
   *  classification. The cache entry itself is never rewritten, so it stays the
   *  canonical build for whichever target filled it. */
  function restamped(entry: CacheEntry, parentID: string | null | undefined): CacheEntry {
    if (entry.parentID === parentID) return entry;
    const candidates = entry.candidates.map((candidate) => ({
      ...candidate,
      sessionParentID: parentID,
    }));
    return { candidates, chars: entry.chars, parentID };
  }

  async function candidatesFor(
    target: DrillTarget,
    needles: string[],
    ftsHits: FtsHit[] | undefined,
  ): Promise<CacheEntry> {
    // The key deliberately omits `target.parentID`. Two targets for the same
    // session CAN disagree about parentage at the same `timeUpdated` — a card
    // whose `timeUpdated` is 0, or an id with no card at all, produces the same
    // `${sessionId}:0` key as the metadata-less fallback — so the key alone
    // cannot be trusted to imply matching parentage. Extending the key would
    // instead refetch the same session, which is exactly what this cache
    // exists to avoid. So parentage is treated as TARGET metadata rather than
    // message-derived data: a hit whose stamp disagrees with the current target
    // is restamped onto a copy (below). Getting this wrong fails OPEN — cached
    // root parentage served to an unknown-parentage target would let its
    // candidates satisfy `authorship: "human"`.
    const key = `${target.sessionId}:${target.timeUpdated}`;
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key); // move to MRU
      cache.set(key, cached);
      return restamped(cached, target.parentID);
    }

    const messages = await fetchDrilledMessages(target, needles, ftsHits);
    const { candidates, charsUsed } = buildCandidates(messages, {
      id: target.sessionId,
      title: target.title,
      directory: target.directory,
      parentID: target.parentID,
    });
    for (const candidate of candidates) populateNormalized(candidate);

    // Content-derived session digest, stamped as a normalized field so
    // content-identity participates in ranking exactly as the corpus scan did
    // (the digest-bridge case depends on this).
    const digestText = buildSessionDigest(candidates);
    const normalizedDigest = digestText ? normalize(digestText) : "";
    for (const candidate of candidates) candidate.digestText = normalizedDigest;

    const entry: CacheEntry = { candidates, chars: charsUsed, parentID: target.parentID };
    cache.set(key, entry);
    cachedTotal += charsUsed;
    evict();
    return entry;
  }

  /** Shared bounded fetch loop for both the BM25 and scan paths: drills each
   *  shortlisted session under the per-query budget and returns its candidate
   *  pool plus which sessions were reached in the card-supported deep set. */
  async function collectPools(input: DrillInput): Promise<{
    pools: DrilledPool[];
    drilledSessions: string[];
    loadErrors: string[];
    budgetExhausted: boolean;
  }> {
    const needles = anchorNeedles(input.query);
    const pools: DrilledPool[] = [];
    const drilledSessions: string[] = [];
    const loadErrors: string[] = [];
    let queryRetained = 0;
    let budgetExhausted = false;

    for (const target of input.sessions) {
      if (input.abort?.aborted) break;
      if (queryRetained >= limits.drillCharsPerQuery) {
        budgetExhausted = true;
        break;
      }
      let entry: CacheEntry;
      try {
        entry = await candidatesFor(target, needles, input.ftsBySession?.get(target.sessionId));
      } catch (error) {
        if (loadErrors.length < MAX_LOAD_ERROR_SAMPLES) {
          loadErrors.push(`${target.sessionId}: ${errmsg(error)}`);
        }
        continue;
      }
      queryRetained += entry.chars;
      drilledSessions.push(target.sessionId);
      pools.push({ target, ...poolFor(target, entry.candidates, input) });
    }
    return { pools, drilledSessions, loadErrors, budgetExhausted };
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
      const { pools, drilledSessions, loadErrors, budgetExhausted } = await collectPools(input);
      const broadPool: Candidate[] = [];
      const deepPool: Candidate[] = [];
      for (const pool of pools) {
        broadPool.push(...pool.candidates);
        if (input.deepSet.has(pool.target.sessionId)) deepPool.push(...pool.candidates);
      }

      const broad = bm25Search(broadPool, input.query, input.mode, input.explain);
      const deep = bm25Search(deepPool, input.query, input.mode, input.explain);
      const hits = mergeShortlistHits(broad, deep, input.explain);
      return { hits, pools, drilledSessions, budgetExhausted, loadErrors };
    },

    async pools(input): Promise<DrillPoolsOutput> {
      const { pools, drilledSessions, loadErrors, budgetExhausted } = await collectPools(input);
      return { pools, drilledSessions, budgetExhausted, loadErrors };
    },

    async deep(input): Promise<DeepOutput> {
      const now = deps.now ?? Date.now;
      const wallClockMs = deps.deepWallClockMs ?? DEFAULT_DEEP_WALL_CLOCK_MS;
      const deadline = now() + wallClockMs;
      const charsPerQuery = input.charsPerQuery;

      const budget = { retained: 0 };
      const pools: DrilledPool[] = [];
      const drilledSessions: string[] = [];
      const loadErrors: string[] = [];
      let sessionsCovered = 0;
      let sessionsPartial = 0;
      let continuation: DeepContinuation | undefined;

      const overBudget = (): boolean =>
        budget.retained >= charsPerQuery || now() >= deadline || input.abort?.aborted === true;

      /** Sweep one session exhaustively from `startBefore`, stopping cleanly on a
       *  budget. Always fetches at least one page so the sweep makes progress. */
      const sweepSession = async (
        target: DeepTarget,
        startBefore: string | null,
      ): Promise<{ candidates: Candidate[]; nextBefore: string | null; stopped: boolean }> => {
        const messages: MsgWithParts[] = [];
        let cursor: string | undefined = startBefore ?? undefined;
        let stopped = false;
        let fetchedAny = false;
        for (;;) {
          if (fetchedAny && overBudget()) {
            stopped = true;
            break;
          }
          if (!fetchedAny && input.abort?.aborted) {
            stopped = true;
            break;
          }
          const before = cursor;
          const page = await gate.runQuery(() =>
            fetchMessagePage(client, {
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

        const chrono = [...messages].sort(
          (a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id),
        );
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
        return { candidates, nextBefore: stopped ? (cursor ?? null) : null, stopped };
      };

      const targets = input.sessions;
      const remainingFrom = (index: number): string[] =>
        targets.slice(index).map((t) => t.sessionId);

      for (let i = 0; i < targets.length; i++) {
        const target = targets[i]!;
        // Budget spent between sessions: this session and the rest are untouched.
        if (overBudget()) {
          continuation = { current: null, before: null, remaining: remainingFrom(i) };
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
          continue;
        }
        pools.push({ target, ...poolFor(target, swept.candidates, input) });
        drilledSessions.push(target.sessionId);
        if (swept.stopped) {
          sessionsPartial++;
          continuation = {
            current: target.sessionId,
            before: swept.nextBefore,
            remaining: remainingFrom(i + 1),
          };
          break;
        }
        sessionsCovered++;
      }

      const exhaustedBudget = continuation != null;
      return {
        pools,
        drilledSessions,
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
