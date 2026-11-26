import type { Authorship } from "./authorship.js";
import type { HistoryReadCounts } from "./history/source.js";

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

/**
 * Why a drill stopped reading one target session.
 *
 * - `anchor`: a page after the first matched none of the query's anchors.
 * - `sessionBudget`: the per-session retained-chars budget ran out while
 *   paging.
 * - `targetsCut`: paging stopped for another reason, then the per-session
 *   budget ran out before every point lookup the slim index asked for (a hit
 *   message and its neighbors) was read.
 * - `end`: the whole session was read.
 * - `queryBudget`: the per-query budget ran out before this session was read.
 * - `loadError`: reading the session failed.
 * - `aborted`: the query was cancelled before (or, in a deep sweep, while)
 *   this session was read.
 * - `budget` / `wallClock`: a deep sweep's retained-chars or wall-clock
 *   budget ran out before (or while) this session was swept.
 *
 * A session the card drill (history unavailable) searched reports `end`.
 */
export type DrillStop =
  | "anchor"
  | "sessionBudget"
  | "end"
  | "queryBudget"
  | "loadError"
  | "aborted"
  | "targetsCut"
  | "budget"
  | "wallClock";

/**
 * What a drill read for one target session. `fetched` counts the messages
 * read (from the history source or the drill cache; the card drill reads
 * none), `candidate` those that built at least one candidate before the
 * query's filters, and `eligible` those with a candidate left after the
 * filters and the authorship stage (the session's title candidate is not a
 * message and counts in neither). `cached` is set when every page and point
 * lookup came from the drill cache, so nothing was fetched; `stop` is still
 * what stopped the walk.
 */
export type DrillSessionStats = {
  fetched: number;
  candidate: number;
  eligible: number;
  stop: DrillStop;
  cached?: true;
};

/** One drilled (or not drilled) target in `coverage.sessionStops`. */
export type SessionStop = DrillSessionStats & { sessionID: string };

/**
 * `coverage.toolNames`: the tool parts a search with a `toolName` filter
 * read, by tool name, reported when it returned no results. Counted in the
 * searched sessions' drilled parts under every filter but `toolName` (time,
 * role, type), before the authorship stage and the query match.
 */
export type ToolNamesCoverage = {
  /** The `toolName` filter as given. */
  filter: string;
  /** The names it accepts: its alias group in any case, or itself exactly. */
  accepted: string[];
  /** Tool parts the filter accepted. */
  matched: number;
  /** Tool parts counted. */
  parts: number;
  /** Distinct tool names among them. */
  distinct: number;
  /** The most frequent names, most frequent first, the first 10. */
  top: Array<{ name: string; count: number }>;
  /** The counted name closest to `filter` that it does not accept, when one
   *  is close. */
  closest?: string;
};

/** The repair sweep's progress as `coverage.history.repair` reports it. */
export type HistoryRepairCoverage = {
  /** Cards built under an older history reader not yet rebuilt. */
  pending: number;
  /** Cards that could not be rebuilt (each has a repair reason). */
  repairPending: number;
  /** Cards the running (or last) sweep rebuilt. */
  done: number;
  running: boolean;
  /** Set when the sweep's progress has not been refreshed for a while:
   *  the process running it went away. */
  stalled?: true;
  /** When the progress was last shared (ms epoch). */
  at: number;
};

/** The range check's progress as `coverage.history.reconcile` reports it. */
export type HistoryReconcileCoverage = {
  /** Completed sweeps over every checkable card. */
  sweeps: number;
  /** The running sweep's position: the card it is walking (null at the
   *  start of a sweep) and the `seq` after which that card's next range
   *  starts (null at the start of the card). Everything from here on is
   *  unchecked in this sweep. */
  oldestUnchecked: { session: string | null; after: number | null };
  /** When the last sweep completed (ms epoch); null before one has. */
  lastSweepCompletedAt: number | null;
  /** Every range not yet checked in the running sweep was checked or
   *  recorded no earlier than this (ms epoch), which bounds how long a
   *  change only the range check can find waits; null before a sweep has
   *  completed. */
  checkedSince: number | null;
  /** When the last range was checked (ms epoch; 0 before the first). */
  lastCheckAt: number;
};

/**
 * How the host's history database differs from what this build reads, and
 * how far card repair has got (opencode v2 only). See `HistoryDrift` in
 * `history/source.ts` for the fields shared with it.
 */
export type HistoryCoverage = {
  capabilities: { parts: boolean };
  migration: { newest: string | null; tested: boolean };
  unknownTables: string[];
  /** Columns an optional capability needs that the database lacks; present
   *  only when some are missing. */
  missingColumns?: string[];
  /** Part types read that this build does not know; present only when some
   *  were read. */
  unknownPartTypeNames?: string[];
  /** Message reads recorded since the process started. */
  reads: number;
  /** What those reads could not project faithfully, summed. */
  counts: HistoryReadCounts;
  repair?: HistoryRepairCoverage;
  reconcile?: HistoryReconcileCoverage;
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
  /** Messages the drill read across the searched sessions (see
   *  {@link DrillSessionStats}). */
  messagesFetched: number;
  /** Of those, messages that built at least one candidate before the
   *  query's filters. */
  messagesCandidate: number;
  /** Of those, messages with a candidate left after the filters and the
   *  authorship stage: what the match path searched. */
  messagesEligible: number;
  partsSearched: number;
  /** Why the drill stopped reading each target session, in drill order:
   *  `count` targets in all (drilled or not), the first 10 of them
   *  listed. */
  sessionStops?: { count: number; sessions: SessionStop[] };
  /** Present when a `toolName` filter left no results while the searched
   *  sessions held tool parts. */
  toolNames?: ToolNamesCoverage;
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
  /** Present on opencode v2 while `opencode.db` can be read: how it differs
   *  from what this build reads and how far card repair has got. */
  history?: HistoryCoverage;
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

/** `recall`'s output. When it does not fit the output budget it is
 *  `trimmed`: the results come first and the expansions after them, and the
 *  `continuation` (passed back as `cursor` with the same arguments) resumes
 *  at the first record not shown, inside an expansion when one was cut. */
export type SearchOutput = TrimmedFields & {
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
   *  cursor alone only readmits ids the card store knows. Independent of
   *  `continuation`, which returns the rest of this output: following a
   *  trimmed deep output's continuation re-runs the same sweep (same
   *  `deepCursor`), and each output carries that run's `nextCursor`. */
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

/** The order `recall_messages` browses in. */
export type MessagesOrder = "newest" | "oldest";

/**
 * Why a `recall_messages` scan stopped: `limit` messages matched, the
 * matches fill the output budget (`outputBudget`), it read as many messages
 * or pages as one call may (`scanBudget`), or the session has no more
 * messages in its order (`end`).
 */
export type MessagesStop = "limit" | "outputBudget" | "scanBudget" | "end";

export type MessagesOutput = TrimmedFields & {
  ok: true;
  messages: MessageItem[];
  context: {
    sessionTitle?: string;
    directory?: string;
  };
  /** Cursor-based pagination over bounded pages in `order`. The call scans
   *  pages until `matched` reaches `limit` or `stop` says why it did not.
   *  `scanned` counts the messages it read and tested against the role and
   *  query filters, `matched` those that passed and `returned` those shown,
   *  whole or in part, so `returned` is less than `matched` only on a
   *  trimmed output. `nextCursor` (opaque) continues from where this output
   *  stopped: on a trimmed output its `continuation`, otherwise right after
   *  the last message scanned. Absent means the session has no more. */
  pagination: {
    limit: number;
    order: MessagesOrder;
    returned: number;
    matched: number;
    scanned: number;
    stop: MessagesStop;
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
  /** Sessions shown: at most `limit`, and fewer on a trimmed output. */
  returned: number;
  scope: string;
  /** Children branch only: echoes the resolved parent session ID. Its presence
   *  is NOT the discrimination rule — check `scope === "children"`. */
  parentID?: string;
  /** Children branch only: the total number of children the listing holds
   *  across all its pages, after the filters (withheld foreign rows
   *  excluded). Every page carries the same count, the last one included,
   *  so `nextCursor` is what says another page follows. */
  childCount?: number;
  /** More sessions match than this page holds. `nextCursor` reads them,
   *  except where the listing could not reach them, which `note` explains:
   *  the children branch reads at most a fixed number of children (the
   *  first ones in id order), and `childCount` then covers only those. */
  truncated?: true;
  /** Taken back as `cursor` (with the same arguments) to read on: the
   *  `continuation` of a trimmed output, otherwise the next page when
   *  `truncated`. Absent at the end of the listing. */
  nextCursor?: string;
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
