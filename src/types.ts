export const TOOLS = [
  "recall",
  "recall_get",
  "recall_sessions",
  "recall_context",
  "recall_messages",
] as const;

export type Limits = {
  concurrency: number;
  maxSessions: number;
  maxResults: number;
  maxSessionList: number;
  maxMessages: number;
  maxWindow: number;
  defaultWidth: number;
  /** Raw-text budget for the tier-2 drilled-session LRU (repurposed from the
   *  deleted full-corpus cache). */
  cacheMaxChars: number;
  /** Sessions the distiller keeps in flight during the cold pass. */
  distillConcurrency: number;
  /** Politeness delay (ms) between a session's page fetches in the cold pass. */
  distillDelayMs: number;
  /** Per-session slim-index row cap; giants keep their newest rows. */
  ftsRowsPerSession: number;
  /** Card inventory token cap (code anchors + digest tokens, combined). */
  inventoryTokens: number;
  /** Whether the distiller runs its background cold pass at all. */
  coldPass: boolean;
  /** Tier-2 drill fan-out: how many shortlisted sessions to drill per query. */
  drillSessions: number;
  /** Messages per untargeted drill page fetch (newest-first). */
  drillPageMessages: number;
  /** Per-session retained-chars budget for an untargeted drill. */
  drillCharsPerSession: number;
  /** Per-query retained-chars budget shared across all drilled sessions. */
  drillCharsPerQuery: number;
  /** Per-query retained-chars budget for a deep (exhaustive, output-inclusive)
   *  sweep. Much larger than the normal drill budget because deep exists to
   *  cover the 2.4GB tool-output tier within an explicit scope. */
  deepCharsPerQuery: number;
};

export const DEFAULTS: Limits = {
  concurrency: 3,
  maxSessions: Infinity,
  maxResults: 50,
  maxSessionList: 100,
  maxMessages: 50,
  maxWindow: 10,
  defaultWidth: 200,
  // Repurposed as the drilled-session LRU budget (no longer the full-corpus cache).
  cacheMaxChars: 24_000_000,
  distillConcurrency: 2,
  distillDelayMs: 25,
  ftsRowsPerSession: 5000,
  inventoryTokens: 200,
  coldPass: true,
  drillSessions: 12,
  drillPageMessages: 25,
  drillCharsPerSession: 1_500_000,
  drillCharsPerQuery: 20_000_000,
  deepCharsPerQuery: 30_000_000,
};

/** Explicit discovery limit for "all history" requests: the opencode server
 *  defaults to 100 rows when no limit is sent (silently hiding older sessions),
 *  and it applies caller limits unclamped. Lives here (not in `search.ts`) so
 *  the distiller can share it without importing the search module, which would
 *  cycle once search wires the distiller in. `search.ts` re-exports it for
 *  existing importers. */
export const DISCOVERY_LIMIT = 10_000;

export type MatchMode = "literal" | "smart" | "fuzzy" | "regex";
export type DegradeKind = "none" | "time" | "fallback";
export type GroupMode = "part" | "session";
export type ResultSource = "message" | "title" | "tool" | "reasoning";
export type DirectoryRelevance = "exact" | "project" | "global" | "unknown";

/**
 * What kind of evidence a hit is, derived deterministically from part type,
 * tool name, and which fields matched. Generated reference material
 * (skill-definition, file-read) is distinguished from concrete actions
 * (tool-input) and conversational statements (human-text) so ranking and
 * grouping can prefer the latter for "what did we do before" queries.
 */
export type EvidenceClass =
  | "human-text" // text part, user or assistant
  | "reasoning"
  | "tool-input" // hit matched in command/cwd/toolName fields (incl. JSON input)
  | "tool-output"
  | "file-read" // tool name suffix-matches "read"
  | "web-fetch" // output-side match on a fetch-shaped tool (webfetch/scrape/…)
  | "skill-definition" // tool name suffix-matches "skill"
  | "session-title";

export type SearchSuggestion = {
  reason: string;
  action: string;
  example?: Record<string, unknown>;
};

export type SearchCoverage = {
  totalSessionsAvailable?: number;
  totalSessionsKnown: boolean;
  sessionsDiscovered: number;
  sessionsEligible: number;
  sessionsSearched: number;
  messagesSearched: number;
  partsSearched: number;
  sessionsSkipped: number;
  skippedByReason?: Record<string, number>;
  directoryBucketsSearched?: Array<"exact" | "project" | "global">;
  directoryBucketCounts?: {
    exact?: number;
    project?: number;
    global?: number;
  };
  limitedBy?: Array<
    | "scope"
    | "sessionID"
    | "title"
    | "directory"
    | "time"
    | "type"
    | "role"
    | "sessionsLimit"
    | "maxSessions"
    | "providerLimit"
    | "excludedSession"
    | "loadError"
    | "rankingBudget"
    | "timeBudget"
    | "abortSignal"
  >;
  /** Present when some sessions failed to load; samples are capped. */
  loadErrors?: { count: number; samples: string[] };
  /** Tier-0 card-store state: how many sessions are distilled and how fresh the
   *  store is. `total` counts every known card, `full` those distilled to
   *  content (the rest are metadata-only), `storeRecency` is the newest card's
   *  `timeUpdated` (ms, 0 when none), `degraded` is true in cards-lite mode. */
  cards?: {
    total: number;
    full: number;
    storeRecency: number;
    degraded: boolean;
  };
  /** Present only for a deep sweep: how much of the scoped session set the sweep
   *  actually covered. `sessionsCovered` were fully swept, `sessionsPartial`
   *  stopped mid-session on a budget, `sessionsRemaining` were never reached,
   *  and `exhaustedBudget` is true when a char/time budget stopped the sweep
   *  (in which case `nextCursor` on the output continues it). */
  deep?: {
    sessionsCovered: number;
    sessionsPartial: number;
    sessionsRemaining: number;
    exhaustedBudget: boolean;
  };
};

export type ResultWhy = {
  matchedFields: Array<
    "title" | "text" | "command" | "stdout" | "stderr" | "cwd" | "toolName" | "reasoning"
  >;
  matchedTerms?: string[];
  directoryRelevance?: DirectoryRelevance;
  recency?: "recent" | "older" | "unknown";
  confidence?: "high" | "medium" | "low";
  evidenceClass?: EvidenceClass;
};

export type NearMiss = {
  sessionID: string;
  title?: string;
  directory?: string;
  reason: string;
  terms?: string[];
};

/** Compact secondary evidence attached to grouped session results. */
export type TopEvidence = {
  messageID: string;
  partID: string;
  evidenceClass: EvidenceClass;
  snippet: string;
};

export type SearchResult = {
  sessionID: string;
  sessionTitle: string;
  directory: string;
  messageID: string;
  role: "user" | "assistant";
  time: number;
  partID: string;
  partType: string;
  pruned: boolean;
  snippet: string;
  toolName?: string;
  /** Present for smart/fuzzy results */
  score?: number;
  /** Present for smart/fuzzy results */
  matchMode?: MatchMode;
  /** Present for smart/fuzzy results */
  matchedTerms?: string[];
  /** Present when explain=true */
  matchReasons?: string[];
  /** Present when group:"session" — number of part-level hits in this session */
  hitCount?: number;
  /** Present when group:"session" — unique evidence classes among the session's hits */
  evidenceKinds?: EvidenceClass[];
  /** Present when group:"session" — up to two hits of other evidence classes */
  topEvidence?: TopEvidence[];
  source?: ResultSource;
  why?: ResultWhy;
  titleMatch?: {
    title: string;
    matchedTerms?: string[];
  };
};

export type SearchOutput = {
  ok: true;
  results: SearchResult[];
  expanded?: ExpandedResult[];
  total: number;
  truncated: boolean;
  /** Which strategy produced the returned results */
  matchMode?: MatchMode;
  /** Ranking/coverage flag: "fallback" (smart→literal), "time" (search
   *  exceeded the time budget — a latency flag, results are still
   *  BM25-ranked), or "none". */
  degradeKind?: DegradeKind;
  /** Which grouping was applied */
  group?: GroupMode;
  warnings?: string[];
  suggestions?: SearchSuggestion[];
  coverage?: SearchCoverage;
  nearMisses?: NearMiss[];
  /** Present when explain:true — which query-plan variants exist and ran. */
  queryPlan?: { variants: string[]; selected: string[] };
  /** Present only for a deep sweep that stopped on a budget: an opaque
   *  continuation token; pass it back as `deepCursor` to resume exactly where
   *  coverage stopped. */
  nextCursor?: string;
};

export type ExpandedResult = {
  resultIndex: number;
  sessionID: string;
  messageID: string;
  mode: "context" | "message";
  messages?: MessageItem[];
  message?: MessageItem;
  hasMoreBefore?: boolean;
  hasMoreAfter?: boolean;
};

export type MessageOutput = {
  ok: true;
  message: {
    id: string;
    role: "user" | "assistant";
    time: number;
    agent?: string;
    model?: string;
  };
  parts: PartOutput[];
  context: {
    sessionTitle?: string;
    directory?: string;
  };
};

export type PartOutput = {
  id: string;
  type: string;
  pruned: boolean;
  content?: string;
  toolName?: string;
  title?: string;
  input?: unknown;
  output?: string;
  error?: string;
};

export type MessageItem = {
  message: {
    id: string;
    role: "user" | "assistant";
    time: number;
    agent?: string;
    model?: string;
  };
  parts: PartOutput[];
  center?: boolean;
};

export type ContextOutput = {
  ok: true;
  messages: MessageItem[];
  context: {
    sessionTitle?: string;
    directory?: string;
  };
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
};

export type MessagesOutput = {
  ok: true;
  messages: MessageItem[];
  context: {
    sessionTitle?: string;
    directory?: string;
  };
  /** Cursor-based pagination over one bounded newest-first page. `nextCursor`
   *  (opaque) continues from where this page stopped; absent means the last
   *  page. `returned` counts messages after role/query filtering within the
   *  page, so it can be less than `limit`. */
  pagination: {
    limit: number;
    returned: number;
    hasMore: boolean;
    nextCursor?: string;
  };
};

export type SessionItem = {
  id: string;
  title: string;
  directory: string;
  project?: { name?: string; worktree: string };
  time: { created: number; updated: number };
  archived: boolean;
  /** Content-derived digest (the card's summary head), present only when a
   *  distilled card exists for the session (best-effort; recall_sessions never
   *  fetches). */
  digest?: string;
  /** Up to the top files the session touched (from the card, when one exists). */
  files?: string[];
  /** Up to the top tools the session used (from the card, when one exists). */
  tools?: string[];
  /** Family rollup for a root session: its id and how many descendant sessions
   *  the card store knows about. Present only for a root that has children. */
  family?: { rootId: string; childCount: number };
};

export type SessionsOutput = {
  ok: true;
  sessions: SessionItem[];
  returned: number;
  scope: string;
};

export type ErrorOutput = {
  ok: false;
  error: string;
};

export function errmsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "data" in e) {
    const data = (e as { data?: { message?: string } }).data;
    if (data?.message) return data.message;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export function optionalString(value: unknown): string | undefined {
  // Defensive against the host-bypass path: a raw non-string (number, object)
  // must coerce to "unset", not throw on .trim().
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Defensive arg coercers for tools other than `recall`.
 *
 * The live MCP host can forward raw caller args that bypass the Zod schema, so
 * enum/number/boolean defaults are NOT guaranteed to be applied. Without this,
 * e.g. an undefined `role` makes `role !== "all"` true and silently filters out
 * every message. These mirror the defensive coercion `recall` already does.
 */
export function coerceEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function coerceBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function coerceInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
