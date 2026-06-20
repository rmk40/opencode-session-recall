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
};

export const DEFAULTS: Limits = {
  concurrency: 3,
  maxSessions: Infinity,
  maxResults: 50,
  maxSessionList: 100,
  maxMessages: 50,
  maxWindow: 10,
  defaultWidth: 200,
};

export type MatchMode = "literal" | "smart" | "fuzzy" | "regex";
export type DegradeKind = "none" | "time" | "budget" | "fallback";
export type GroupMode = "part" | "session";
export type ResultSource = "message" | "title" | "tool" | "reasoning";
export type DirectoryRelevance = "exact" | "project" | "global" | "unknown";

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
    | "loadError"
    | "rankingBudget"
    | "timeBudget"
    | "abortSignal"
  >;
};

export type ResultWhy = {
  matchedFields: Array<
    "title" | "text" | "command" | "stdout" | "stderr" | "cwd" | "toolName" | "reasoning"
  >;
  matchedTerms?: string[];
  directoryRelevance?: DirectoryRelevance;
  recency?: "recent" | "older" | "unknown";
  confidence?: "high" | "medium" | "low";
};

export type NearMiss = {
  sessionID: string;
  title?: string;
  directory?: string;
  reason: string;
  terms?: string[];
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
  source?: ResultSource;
  why?: ResultWhy;
  directoryRelevance?: DirectoryRelevance;
  titleMatch?: {
    title: string;
    matchedTerms?: string[];
  };
};

export type SearchOutput = {
  ok: true;
  results: SearchResult[];
  expanded?: ExpandedResult[];
  scanned: number;
  total: number;
  truncated: boolean;
  /** Number of sessions whose messages could not be loaded */
  loadErrorCount?: number;
  /** Sample message-load failures; omitted when all scanned sessions loaded */
  loadErrors?: string[];
  /** Which strategy produced the returned results */
  matchMode?: MatchMode;
  /** Ranking/coverage flag: "fallback" (smart→literal), "budget" (candidate cap
   *  hit), "time" (search exceeded the time budget — a latency flag, results are
   *  still BM25-ranked), or "none". */
  degradeKind?: DegradeKind;
  /** Which grouping was applied */
  group?: GroupMode;
  warnings?: string[];
  suggestions?: SearchSuggestion[];
  coverage?: SearchCoverage;
  nearMisses?: NearMiss[];
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
  pagination: {
    offset: number;
    returned: number;
    total: number;
    hasMore: boolean;
  };
};

export type SessionItem = {
  id: string;
  title: string;
  directory: string;
  project?: { name?: string; worktree: string };
  time: { created: number; updated: number };
  archived: boolean;
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

export function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
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
