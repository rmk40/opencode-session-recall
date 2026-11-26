import type { Authorship } from "./authorship.js";

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
  /** Of `drillSessions`, how many slots to reserve for the top pure-semantic
   *  cards not already shortlisted (semantic on + ready only). Clamped; 0
   *  disables the reservation. */
  semanticSlots: number;
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
  semanticSlots: 2,
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
  /** Present only when the plugin is configured in ephemeral mode: cards are
   *  metadata-quality by configuration (no persistent index), not by failure.
   *  Never set on the accidental driver-missing degraded path. */
  mode?: "ephemeral";
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
    | "authorship"
    | "sessionsLimit"
    | "maxSessions"
    | "providerLimit"
    | "excludedSession"
    | "loadError"
    | "rankingBudget"
    | "timeBudget"
    | "abortSignal"
    /** A deep sweep was requested but could not run (the history source is
     *  unavailable); the scoped sessions were searched by card instead. */
    | "deep"
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
    /** Present while the store is not complete yet (no cold pass has
     *  indexed every session, and it has fewer cards than sessions): how many
     *  of the `known` sessions have a card (`indexed`) and how many the
     *  current pass has checked (`examined`; `known` is 0 until discovery
     *  finishes). Every process sharing the store reports the lease holder's
     *  pass. With `stalled`, no pass is making progress right now. A
     *  re-verify pass over a complete store reports nothing. */
    indexing?: IndexingProgress;
  };
  /** Present only when the semantic layer is configured on. `ready` is the
   *  embedder load state, `model` the configured model id, `weight` the blend
   *  weight, `cardsWithVectors` how many cards carry a vector, and `contributed`
   *  how many of THIS query's returned results the semantic tier surfaced
   *  (reserved-slot inclusions plus zero-lexical-hit rescues). `representation`
   *  (the embedding generation) and `pluginVersion` (this process's build tag,
   *  the same one the distill lease records) make mixed-version confusion visible
   *  in tool output. */
  semantic?: {
    ready: boolean;
    model?: string;
    weight: number;
    cardsWithVectors: number;
    contributed: number;
    representation: number;
    pluginVersion?: string;
  };
  /** Present only when the history source cannot read history (v2:
   *  `opencode.db` unavailable): results came from the session cards alone
   *  (no drill, no deep sweep) for `reason`. */
  source?: { kind: "v1-http" | "v2-sqlite"; available: false; reason: string };
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
  /** Who composed this part (see src/authorship.ts). Emitted ONLY when the
   *  caller narrowed `authorship` or asked for `explain` — default responses
   *  stay byte-identical to pre-authorship builds. */
  authorship?: Authorship;
  /** Semantic (cosine-derived, 0..1) similarity behind this result. Present for
   *  a zero-lexical-hit semantic rescue (its whole basis), and for any result
   *  under explain:true when the semantic layer scored its session. */
  semanticSimilarity?: number;
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
  /** Who composed this evidence. Optional and emitted under the SAME predicate
   *  as {@link ResultWhy.authorship} (active filter or `explain`), so grouped
   *  output can answer the authorship question without changing default
   *  grouped responses. */
  authorship?: Authorship;
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
   *  coverage stopped. If the original request named uncarded sessions via
   *  `sessions:[...]`, repeat that arg alongside the cursor — the untrusted
   *  cursor alone only readmits ids the card store knows. */
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

/**
 * Set on a tool output that does not hold everything it was asked for (see
 * `output.ts`): `continuation` is what the tool takes as its `cursor` to
 * return the rest. Both are written before the output's record arrays, so a
 * reader that sees only the start of the output still finds them. Distinct
 * from `recall`'s `truncated`, which means more results exist.
 */
export type TrimmedFields = {
  trimmed?: true;
  continuation?: string;
};

/** A message a history read cut short (opencode v2 only): `omittedParts`
 *  content items were left out, `omittedBytes` bytes of part rows among
 *  them. On a message listed by `recall_messages` or `recall_context`,
 *  `cursor` is what `recall_get` takes to read them. */
export type PartialOutput = {
  omittedParts: number;
  omittedBytes: number;
  cursor?: string;
};

export type MessageOutput = TrimmedFields & {
  ok: true;
  message: {
    id: string;
    role: "user" | "assistant";
    time: number;
    agent?: string;
    model?: string;
  };
  /** Present when the history read stopped before the message's end; the
   *  output is then `trimmed` and its `continuation` leads to the rest. */
  partial?: PartialOutput;
  parts: PartOutput[];
  context: {
    sessionTitle?: string;
    directory?: string;
  };
};

/** The part fields that hold text an output can cut. Offsets into them count
 *  UTF-16 code units of the string, or of the JSON text for an `input` that
 *  is not a string. */
export type PartTextField = "content" | "title" | "input" | "output" | "error";

export type PartOutput = {
  id: string;
  type: string;
  pruned: boolean;
  content?: string;
  toolName?: string;
  title?: string;
  /** The tool input. A part cut or resumed inside it carries its JSON text
   *  (or a slice of it) as a string. */
  input?: unknown;
  output?: string;
  error?: string;
  /** Set on a part an output resumed from a continuation: the text fields
   *  before `field` are left out, and `field` starts at `offset`. */
  resumedAt?: { field: PartTextField; offset: number };
  /** Set on a part the output cut short: `field` stops at `offset` of its
   *  `length`, the text fields after it are left out, and the output's
   *  `continuation` resumes there. */
  cutAt?: { field: PartTextField; offset: number; length: number };
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
  /** Present when the history read cut this message short. */
  partial?: PartialOutput;
  center?: boolean;
};

export type ContextOutput = TrimmedFields & {
  ok: true;
  messages: MessageItem[];
  context: {
    sessionTitle?: string;
    directory?: string;
  };
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
};

export type MessagesOutput = TrimmedFields & {
  ok: true;
  messages: MessageItem[];
  context: {
    sessionTitle?: string;
    directory?: string;
  };
  /** Cursor-based pagination over one bounded newest-first page. `nextCursor`
   *  (opaque) continues from where this output stopped: the next page, or,
   *  on a trimmed output, its `continuation`. Absent means the last page.
   *  `returned` counts the messages shown, whole or in part, after
   *  role/query filtering within the page, so it can be less than `limit`. */
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
  /** Emitted as `false` only, on live listings (the `parentID` children branch
   *  and the staleness fallback), for a row with no card or one not distilled
   *  to content (`distillState !== "full"`): its content is not searchable via
   *  `recall` yet. Rows backed by a full card omit the field, and ordinary
   *  card-backed listings never emit it. */
  distilled?: boolean;
};

/** A cold pass's progress (see {@link IndexingStatus}). `indexed` is how
 *  many of the `known` sessions have a card; `examined` how many the current
 *  (or last) pass has checked, which restarts at 0 with every pass. With
 *  `stalled`, no pass is making progress right now. Quarantined (malformed)
 *  sessions are counted as examined but never get a card, and `indexed`
 *  counts every card in the store, including cards of sessions no longer
 *  known: `indexed` reaching `known` does not mean every known session,
 *  malformed ones included, was indexed. */
export type IndexingProgress = {
  indexed: number;
  examined: number;
  known: number;
  stalled?: true;
};

/** Reads the cold pass's progress: undefined unless a pass is building an
 *  incomplete store (see `Distiller.indexing`). */
export type IndexingStatus = () => IndexingProgress | undefined;

/** The warning for a query answered while the store is still incomplete. */
export function indexingWarning(progress: IndexingProgress): string {
  const indexed = `${progress.indexed} of ${progress.known} sessions indexed`;
  if (progress.stalled) {
    return `Index incomplete: ${indexed}, and indexing is not running right now; older history may be missing.`;
  }
  return progress.known > 0
    ? `Indexing in progress: ${indexed}; ${progress.examined} checked in this pass; older history may be missing.`
    : "Indexing in progress: sessions are still being discovered; older history may be missing.";
}

export type SessionsOutput = TrimmedFields & {
  ok: true;
  sessions: SessionItem[];
  /** Sessions shown. On a trimmed output, fewer than the listing selected. */
  returned: number;
  scope: string;
  /** Children branch only: echoes the resolved parent session ID. Its presence
   *  is NOT the discrimination rule — check `scope === "children"`. */
  parentID?: string;
  /** Children branch only: the post-filter, pre-slice child count (withheld
   *  foreign rows excluded). `childCount > returned` means the listing was
   *  truncated by `limit` (or the output trimmed). */
  childCount?: number;
  /** Children branch only: the parent has more children than one call reads,
   *  so `childCount` and the listing cover only the children read (the
   *  first ones in id order). */
  truncated?: true;
  /** Explains a caveat in how the listing was produced — e.g. a since/until
   *  filter that could only be applied within the newest-limit window because no
   *  card store was available to resolve older sessions authoritatively. */
  note?: string;
  /** Present while the distiller's cold pass is building an incomplete store
   *  (see `SearchCoverage.cards.indexing`); the note then says so too. */
  indexing?: IndexingProgress;
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

/** Result of {@link settleWithin}: the settled value, or a timeout marker. */
export type TimedResult<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * Await a promise for at most `timeoutMs`, then detach it. The promise itself
 * is never cancelled (SDK requests cannot be); a late settlement is simply no
 * longer awaited. Callers must ensure detached work is guarded (lease checks,
 * finalized flags) so its late completion cannot write anywhere. Used to bound
 * summarizer SDK calls and the plugin's dispose() so a never-settling request
 * cannot hang the host's shutdown.
 */
export async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<TimedResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimedResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then((value): TimedResult<T> => ({ timedOut: false, value })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
