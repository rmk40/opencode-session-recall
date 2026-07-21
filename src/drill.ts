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

type CacheEntry = { candidates: Candidate[]; chars: number };

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

  async function candidatesFor(
    target: DrillTarget,
    needles: string[],
    ftsHits: FtsHit[] | undefined,
  ): Promise<CacheEntry> {
    const key = `${target.sessionId}:${target.timeUpdated}`;
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key); // move to MRU
      cache.set(key, cached);
      return cached;
    }

    const messages = await fetchDrilledMessages(target, needles, ftsHits);
    const { candidates, charsUsed } = buildCandidates(messages, {
      id: target.sessionId,
      title: target.title,
      directory: target.directory,
    });
    for (const candidate of candidates) populateNormalized(candidate);

    // Content-derived session digest, stamped as a normalized field so
    // content-identity participates in ranking exactly as the corpus scan did
    // (the digest-bridge case depends on this).
    const digestText = buildSessionDigest(candidates);
    const normalizedDigest = digestText ? normalize(digestText) : "";
    for (const candidate of candidates) candidate.digestText = normalizedDigest;

    const entry: CacheEntry = { candidates, chars: charsUsed };
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
      pools.push({ target, candidates: poolFor(target, entry.candidates, input) });
    }
    return { pools, drilledSessions, loadErrors, budgetExhausted };
  }

  /** The per-query scan/score pool for one drilled session: the cached
   *  (unfiltered) candidates narrowed by the query filter, with the bound title
   *  candidate appended when title search applies. Mirrors `assembleSession`.
   *  Shared by the bounded drill and the deep sweep. */
  function poolFor(
    target: DrillTarget,
    cached: Candidate[],
    input: { filter?: (candidate: Candidate) => boolean; searchTitles?: boolean },
  ): Candidate[] {
    const eligible = input.filter ? cached.filter(input.filter) : cached;
    if (!input.searchTitles) return eligible;
    const representative = eligible[0]; // newest eligible, matching assembleSession
    if (!representative) return eligible;
    const title = buildTitleCandidate(
      { id: target.sessionId, title: target.title, directory: target.directory },
      {
        id: representative.messageID,
        role: representative.role,
        time: { created: representative.time },
      },
    );
    if (!title) return eligible;
    populateNormalized(title);
    // All of a session's candidates carry the same stamped digest; reuse it so
    // the title candidate participates in ranking exactly as before.
    title.digestText = cached[0]?.digestText ?? "";
    return [...eligible, title];
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
        pools.push({ target, candidates: poolFor(target, swept.candidates, input) });
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
