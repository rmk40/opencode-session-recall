import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin";
import type { OpencodeClient, Session, GlobalSession, Part, Message } from "@opencode-ai/sdk/v2";
import {
  errmsg,
  optionalString,
  type ExpandedResult,
  type MessageItem,
  type PartOutput,
  type SearchResult,
  type SearchOutput,
  type ErrorOutput,
  type Limits,
  type MatchMode,
  type DegradeKind,
  type GroupMode,
  type SearchCoverage,
  type SearchSuggestion,
  type NearMiss,
  type DirectoryRelevance,
  type ResultSource,
  type ResultWhy,
} from "./types.js";
import { searchableFields, snippet, pruned, matches, formatMsg } from "./extract.js";
import { parseQuery } from "./query.js";
import {
  buildCandidates,
  buildTitleCandidate,
  populateNormalized,
  DEFAULT_BUDGETS,
} from "./candidates.js";
import { bm25Search, type Bm25Hit } from "./bm25.js";
import { smartSnippet } from "./snippet.js";
import { compileRegex, regexFirstIndex, regexSnippet } from "./regex.js";
import { classifyQuery } from "./route.js";

/** Post-fetch time budget for the entire ranking pipeline (ms) */
const TIME_BUDGET_MS = 2000;

/** Wall-clock budget for the synchronous literal/regex scan loops (ms). Bounds
 *  the worst case where a fired abort can't preempt synchronous scanning (e.g.
 *  a hook timeout that lands mid-scan), keeping the event loop responsive. */
const SCAN_TIME_BUDGET_MS = 2000;

/** Max literal results to collect when grouping by session.
 *  Must be high enough to get representative hits from many sessions,
 *  but bounded to prevent unbounded memory growth on broad queries. */
const MAX_GROUPED_LITERAL_RESULTS = 1000;

const MAX_EXPANDED_RESULTS = 3;
const MAX_EXPANDED_CONTEXT_MESSAGES = 30;
const MAX_EXPANDED_TOTAL_TEXT_CHARS = 30_000;
const MAX_EXPANDED_FIELD_CHARS = 4_000;
const DIRECTORY_FILTER_LIST_LIMIT = 5000;
/** In part-grouped results, cap hits per session in the initial fill so one
 *  noisy session can't flood the result list; backfill if room remains. */
const MAX_HITS_PER_SESSION_INITIAL = 2;
/** Literal/regex part-mode scans collect this multiple of the requested result
 *  count (bounded) before the diversity pass, so a single early session can't
 *  fill every slot and starve cross-session diversity. Smart/fuzzy already
 *  ranks the full candidate set, so it doesn't need this. */
const DIVERSITY_SCAN_MULTIPLIER = 5;
const MAX_WARNINGS = 5;
const MAX_SUGGESTIONS = 3;
const MAX_NEAR_MISSES = 3;
const EXPANSION_TRUNCATED = "\n[truncated by recall expansion]";

type ExpandMode = "none" | "context" | "message";
type ExpansionBudget = { remaining: number; truncated: boolean };
type TimeValue = number | string | undefined;

// ── Types ────────────────────────────────────────────────────────────

type MsgWithParts = {
  info: Message;
  parts: Array<Part>;
};

type SessionMetaInternal = {
  id: string;
  title: string;
  directory: string;
  updated: number;
  projectID?: string;
  projectWorktree?: string;
  directoryRelevance?: DirectoryRelevance;
};

function meta(s: Session | GlobalSession): SessionMetaInternal {
  const project = "project" in s ? s.project : undefined;
  return {
    id: s.id,
    title: s.title,
    directory: s.directory,
    updated: s.time.updated,
    projectID: s.projectID,
    projectWorktree: project?.worktree,
  };
}

function positiveTimestampOrUndefined(value: TimeValue): number | undefined {
  if (typeof value === "number") return value > 0 ? value : undefined;
  return undefined;
}

function parseDurationMs(value: string): number | undefined {
  const match = /^(\d+)([hdw])(?:\s+ago)?$/i.exec(value.trim());
  if (!match) return undefined;

  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount < 0) return undefined;

  const unit = match[2]?.toLowerCase();
  const hours = unit === "h" ? amount : unit === "d" ? amount * 24 : amount * 24 * 7;
  return hours * 60 * 60 * 1000;
}

function parseDateString(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeDirectoryPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function directoryMatches(directory: string, target: string): boolean {
  const dir = normalizeDirectoryPath(directory);
  const filter = normalizeDirectoryPath(target);
  if (filter === "/") return dir === "/" || dir.startsWith("/");
  return dir === filter || dir.startsWith(`${filter}/`);
}

function sourceForPartType(partType: string): ResultSource {
  if (partType === "title") return "title";
  if (partType === "tool") return "tool";
  if (partType === "reasoning") return "reasoning";
  return "message";
}

function defaultMatchedFields(partType: string): ResultWhy["matchedFields"] {
  if (partType === "title") return ["title"];
  if (partType === "tool") return [];
  if (partType === "reasoning") return ["reasoning"];
  return ["text"];
}

function recencyLabel(time: number): ResultWhy["recency"] {
  if (!Number.isFinite(time) || time <= 0) return "unknown";
  return Date.now() - time <= 7 * 24 * 60 * 60 * 1000 ? "recent" : "older";
}

function annotateResult(result: SearchResult): SearchResult {
  const source = result.source ?? sourceForPartType(result.partType);
  const confidence = source === "title" ? "medium" : "high";
  return {
    ...result,
    source,
    directoryRelevance: result.directoryRelevance ?? "unknown",
    why: {
      matchedFields: defaultMatchedFields(result.partType),
      matchedTerms: result.matchedTerms,
      directoryRelevance: result.directoryRelevance ?? "unknown",
      recency: recencyLabel(result.time),
      confidence,
      ...result.why,
    },
  };
}

function pushUnique<T>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value);
}

type TimeCandidate = { label: string; timestamp: number };

type NormalizedSearchOptions = {
  before?: number;
  after?: number;
  expandResults: number;
  window: number;
  expandBudgetMessages: number;
  expandBudgetChars: number;
  warnings: string[];
  limitedBy: NonNullable<SearchCoverage["limitedBy"]>;
};

function parseLowerTime(
  label: string,
  value: TimeValue,
  now: number,
  warnings: string[],
): number | undefined {
  if (typeof value === "number") return positiveTimestampOrUndefined(value);

  const raw = optionalString(value);
  if (!raw) return undefined;

  const acceptsDuration = label === "from" || label === "last" || label === "since";
  const duration = parseDurationMs(raw);
  if (duration != null) {
    if (!acceptsDuration) {
      warnings.push(`Ignored ${label}:"${raw}"; use ${label}:"2025-01-01" or last:"7d".`);
      return undefined;
    }
    if (duration === 0) {
      warnings.push(`Ignored ${label}:"${raw}"; zero-width lower bounds are omitted.`);
      return undefined;
    }
    return now - duration;
  }

  if (raw.toLowerCase() === "now") return now;

  const date = parseDateString(raw);
  if (date != null) return date;

  warnings.push(
    `Ignored ${label}:"${raw}"; use last:"7d", from:"365d ago", or after:"2025-01-01".`,
  );
  return undefined;
}

function parseUpperTime(
  label: string,
  value: TimeValue,
  now: number,
  warnings: string[],
): number | undefined {
  if (typeof value === "number") return positiveTimestampOrUndefined(value);

  const raw = optionalString(value);
  if (!raw) return undefined;

  if (raw.toLowerCase() === "now") return now;

  const acceptsDuration = label === "until";
  const duration = parseDurationMs(raw);
  if (duration != null) {
    if (!acceptsDuration) {
      warnings.push(`Ignored ${label}:"${raw}"; use ${label}:"2026-01-01" or until:"3w".`);
      return undefined;
    }
    if (duration === 0) {
      warnings.push(`Normalized ${label}:"${raw}" to to:"now".`);
      return now;
    }
    return now - duration;
  }

  const date = parseDateString(raw);
  if (date != null) return date;

  warnings.push(`Ignored ${label}:"${raw}"; use to:"now", before:"2026-01-01", or until:"3w".`);
  return undefined;
}

function chooseLower(candidates: TimeCandidate[], warnings: string[]): number | undefined {
  if (candidates.length === 0) return undefined;
  const sorted = [...candidates].sort((a, b) => b.timestamp - a.timestamp);
  const chosen = sorted[0]!;
  const ignored = sorted.filter((candidate) => candidate.timestamp !== chosen.timestamp);
  if (ignored.length > 0) {
    warnings.push(
      `Used ${chosen.label} as the lower time bound; ignored less restrictive ${ignored.map((candidate) => candidate.label).join(", ")}.`,
    );
  }
  return chosen.timestamp;
}

function chooseUpper(candidates: TimeCandidate[], warnings: string[]): number | undefined {
  if (candidates.length === 0) return undefined;
  const sorted = [...candidates].sort((a, b) => a.timestamp - b.timestamp);
  const chosen = sorted[0]!;
  const ignored = sorted.filter((candidate) => candidate.timestamp !== chosen.timestamp);
  if (ignored.length > 0) {
    warnings.push(
      `Used ${chosen.label} as the upper time bound; ignored less restrictive ${ignored.map((candidate) => candidate.label).join(", ")}.`,
    );
  }
  return chosen.timestamp;
}

function clampNumber(
  label: string,
  value: number,
  min: number,
  max: number,
  warnings: string[],
): number {
  if (value < min) {
    warnings.push(`Clamped ${label} from ${value} to ${min}.`);
    return min;
  }
  if (value > max) {
    warnings.push(`Clamped ${label} from ${value} to ${max}.`);
    return max;
  }
  return value;
}

function normalizeSearchOptions(
  args: {
    after?: TimeValue;
    before?: TimeValue;
    since?: string;
    until?: string;
    last?: string;
    from?: string;
    to?: string;
    expandResults: number;
    window: number | "auto";
    expandBudgetMessages?: number;
    expandBudgetChars?: number;
  },
  limits: Limits,
): NormalizedSearchOptions | ErrorOutput {
  const warnings: string[] = [];
  const limitedBy: NonNullable<SearchCoverage["limitedBy"]> = [];
  const now = Date.now();

  const lowerCandidates: TimeCandidate[] = [];
  const upperCandidates: TimeCandidate[] = [];
  const addLower = (label: string, value: TimeValue): void => {
    const timestamp = parseLowerTime(label, value, now, warnings);
    if (timestamp != null) lowerCandidates.push({ label, timestamp });
  };
  const addUpper = (label: string, value: TimeValue): void => {
    const timestamp = parseUpperTime(label, value, now, warnings);
    if (timestamp != null) upperCandidates.push({ label, timestamp });
  };

  addLower("after", args.after);
  addLower("from", args.from);
  addLower("last", args.last);
  addLower("since", args.since);
  addUpper("before", args.before);
  addUpper("to", args.to);
  addUpper("until", args.until);

  const after = chooseLower(lowerCandidates, warnings);
  const before = chooseUpper(upperCandidates, warnings);
  if (after != null || before != null) pushUnique(limitedBy, "time");

  if (after != null && before != null && after >= before) {
    return {
      ok: false,
      error: `Time filters produce an empty window: after ${after} must be older than before ${before}. Try last:"7d" or from:"365d ago", to:"now".`,
    };
  }

  const expandResults = clampNumber(
    "expandResults",
    Math.trunc(args.expandResults),
    1,
    MAX_EXPANDED_RESULTS,
    warnings,
  );

  const expandBudgetMessages = clampNumber(
    "expandBudgetMessages",
    Math.trunc(args.expandBudgetMessages ?? MAX_EXPANDED_CONTEXT_MESSAGES),
    1,
    MAX_EXPANDED_CONTEXT_MESSAGES,
    warnings,
  );

  const expandBudgetChars = clampNumber(
    "expandBudgetChars",
    Math.trunc(args.expandBudgetChars ?? MAX_EXPANDED_TOTAL_TEXT_CHARS),
    1,
    MAX_EXPANDED_TOTAL_TEXT_CHARS,
    warnings,
  );

  let window: number;
  if (args.window === "auto") {
    const messagesPerResult = Math.max(1, Math.floor(expandBudgetMessages / expandResults));
    window = Math.min(limits.maxWindow, Math.max(0, Math.floor((messagesPerResult - 1) / 2)));
  } else {
    window = clampNumber("window", Math.trunc(args.window), 0, limits.maxWindow, warnings);
  }

  return {
    before,
    after,
    expandResults,
    window,
    expandBudgetMessages,
    expandBudgetChars,
    warnings,
    limitedBy,
  };
}

function partEligible(part: Part, type: string, toolName: string | undefined): boolean {
  if (toolName) return part.type === "tool" && part.tool === toolName;
  return type === "all" || part.type === type;
}

function findRepresentativeMessage(
  messages: MsgWithParts[],
  role: string,
  before?: number,
  after?: number,
): MsgWithParts | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const msg = messages[index]!;
    const ts = msg.info.time.created;
    if (before != null && ts >= before) continue;
    if (after != null && ts <= after) continue;
    if (role !== "all" && msg.info.role !== role) continue;
    return msg;
  }
  return undefined;
}

/** Build a title-sourced result. `titleSnippet` is precomputed by the caller so
 *  literal and regex paths can share this single constructor. */
function titleSearchResult(
  session: SessionMetaInternal,
  representative: MsgWithParts,
  titleSnippet: string,
): SearchResult {
  return annotateResult({
    sessionID: session.id,
    sessionTitle: session.title,
    directory: session.directory,
    messageID: representative.info.id,
    role: representative.info.role,
    time: representative.info.time.created,
    partID: `${session.id}:title`,
    partType: "title",
    pruned: false,
    snippet: titleSnippet,
    source: "title",
    directoryRelevance: session.directoryRelevance ?? "unknown",
    titleMatch: { title: session.title },
    why: {
      matchedFields: ["title"],
      directoryRelevance: session.directoryRelevance ?? "unknown",
      recency: recencyLabel(representative.info.time.created),
      confidence: "medium",
    },
  });
}

function canSearchTitles(type: string, toolName: string | undefined): boolean {
  return type === "all" && !toolName;
}

function countSearchCoverage(
  loaded: Array<{ messages: MsgWithParts[] }>,
  type: string,
  role: string,
  toolName: string | undefined,
  before?: number,
  after?: number,
): { messagesSearched: number; partsSearched: number } {
  let messagesSearched = 0;
  let partsSearched = 0;

  for (const { messages } of loaded) {
    for (const msg of messages) {
      const ts = msg.info.time.created;
      if (before != null && ts >= before) continue;
      if (after != null && ts <= after) continue;
      if (role !== "all" && msg.info.role !== role) continue;
      messagesSearched++;

      for (const part of msg.parts) {
        if (!partEligible(part, type, toolName)) continue;
        partsSearched++;
      }
    }
  }

  return { messagesSearched, partsSearched };
}

function sameProjectOrWorktree(
  session: SessionMetaInternal,
  worktree: string | undefined,
): boolean {
  const rawWorktree = optionalString(worktree);
  if (!rawWorktree) return false;
  const normalizedWorktree = normalizeDirectoryPath(rawWorktree);
  if (
    session.projectWorktree &&
    normalizeDirectoryPath(session.projectWorktree) === normalizedWorktree
  ) {
    return true;
  }
  const sessionDir = normalizeDirectoryPath(session.directory);
  return sessionDir === normalizedWorktree || sessionDir.startsWith(`${normalizedWorktree}/`);
}

function classifyDirectoryRelevance(
  session: SessionMetaInternal,
  directory: string | undefined,
  worktree: string | undefined,
): DirectoryRelevance {
  if (!directory) return "unknown";
  if (directoryMatches(session.directory, directory)) return "exact";
  if (sameProjectOrWorktree(session, worktree)) return "project";
  return "global";
}

function withDirectoryRelevance(
  session: SessionMetaInternal,
  relevance: DirectoryRelevance,
): SessionMetaInternal {
  return { ...session, directoryRelevance: relevance };
}

function dedupeSessions(sessions: SessionMetaInternal[]): SessionMetaInternal[] {
  const seen = new Set<string>();
  const result: SessionMetaInternal[] = [];
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    result.push(session);
  }
  return result;
}

function listLimitForDirectoryFilter(
  argsLimit: number | undefined,
  configuredLimit: number,
): number | undefined {
  // A finite maxSessions is a hard plugin safety cap; broaden only within it.
  if (Number.isFinite(configuredLimit)) return configuredLimit;
  if (argsLimit == null) return undefined;
  return Math.max(argsLimit, DIRECTORY_FILTER_LIST_LIMIT);
}

function truncateExpandedText(
  value: string | undefined,
  budget: ExpansionBudget,
): string | undefined {
  if (value == null) return undefined;
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return undefined;
  }

  const allowed = Math.min(MAX_EXPANDED_FIELD_CHARS, budget.remaining);
  if (value.length <= allowed) {
    budget.remaining -= value.length;
    return value;
  }

  if (allowed <= EXPANSION_TRUNCATED.length) {
    budget.truncated = true;
    return undefined;
  }

  const sliceLength = allowed - EXPANSION_TRUNCATED.length;
  budget.remaining -= allowed;
  budget.truncated = true;
  return `${value.slice(0, sliceLength)}${EXPANSION_TRUNCATED}`;
}

function truncateExpandedPart(part: PartOutput, budget: ExpansionBudget): PartOutput {
  return {
    ...part,
    content: truncateExpandedText(part.content, budget),
    output: truncateExpandedText(part.output, budget),
    error: truncateExpandedText(part.error, budget),
  };
}

function formatExpandedMsg(msg: MsgWithParts, budget: ExpansionBudget): MessageItem {
  const item = formatMsg(msg);
  return {
    ...item,
    parts: item.parts.map((part) => truncateExpandedPart(part, budget)),
  };
}

/** Cap sample size only; loadErrorCount still reports all failures. */
const MAX_LOAD_ERROR_SAMPLES = 5;

// ── Literal scan (preserved from original) ──────────────────────────

function scan(
  messages: MsgWithParts[],
  session: SessionMetaInternal,
  query: string,
  type: string,
  role: string,
  limit: number,
  before?: number,
  after?: number,
  width?: number,
  toolName?: string,
): { results: SearchResult[]; total: number } {
  const results: SearchResult[] = [];
  let total = 0;

  for (const msg of messages) {
    if (results.length >= limit) break;
    const ts = msg.info.time.created;
    if (before != null && ts >= before) continue;
    if (after != null && ts <= after) continue;
    if (role !== "all" && msg.info.role !== role) continue;

    for (const part of msg.parts) {
      if (results.length >= limit) break;
      if (!partEligible(part, type, toolName)) continue;

      const fields = searchableFields(part);
      let matched = false;

      for (const field of fields) {
        if (!matches(field.text, query)) continue;
        total++;
        if (matched) continue;
        matched = true;

        if (results.length < limit) {
          results.push(
            annotateResult({
              sessionID: session.id,
              sessionTitle: session.title,
              directory: session.directory,
              messageID: msg.info.id,
              role: msg.info.role,
              time: msg.info.time.created,
              partID: part.id,
              partType: part.type,
              pruned: pruned(part),
              snippet: snippet(field.text, query, width),
              toolName: part.type === "tool" ? part.tool : undefined,
              source: sourceForPartType(part.type),
              directoryRelevance: session.directoryRelevance ?? "unknown",
              why: {
                matchedFields: [field.field],
                directoryRelevance: session.directoryRelevance ?? "unknown",
                recency: recencyLabel(msg.info.time.created),
                confidence: "high",
              },
            }),
          );
        }
      }
    }
  }
  return { results, total };
}

// ── Regex scan ───────────────────────────────────────────────────────

/** Bounded regex scan over candidate fields. Mirrors scan() but uses a RegExp. */
function regexScan(
  messages: MsgWithParts[],
  session: SessionMetaInternal,
  re: RegExp,
  type: string,
  role: string,
  limit: number,
  before?: number,
  after?: number,
  width?: number,
  toolName?: string,
): { results: SearchResult[]; total: number } {
  const results: SearchResult[] = [];
  let total = 0;

  for (const msg of messages) {
    if (results.length >= limit) break;
    const ts = msg.info.time.created;
    if (before != null && ts >= before) continue;
    if (after != null && ts <= after) continue;
    if (role !== "all" && msg.info.role !== role) continue;

    for (const part of msg.parts) {
      if (results.length >= limit) break;
      if (!partEligible(part, type, toolName)) continue;

      const fields = searchableFields(part);
      let matched = false;

      for (const field of fields) {
        const matchIndex = regexFirstIndex(re, field.text);
        if (matchIndex === -1) continue;
        total++;
        if (matched) continue;
        matched = true;

        if (results.length < limit) {
          results.push(
            annotateResult({
              sessionID: session.id,
              sessionTitle: session.title,
              directory: session.directory,
              messageID: msg.info.id,
              role: msg.info.role,
              time: msg.info.time.created,
              partID: part.id,
              partType: part.type,
              pruned: pruned(part),
              snippet: regexSnippet(re, field.text, width, matchIndex),
              toolName: part.type === "tool" ? part.tool : undefined,
              source: sourceForPartType(part.type),
              directoryRelevance: session.directoryRelevance ?? "unknown",
              why: {
                matchedFields: [field.field],
                directoryRelevance: session.directoryRelevance ?? "unknown",
                recency: recencyLabel(msg.info.time.created),
                confidence: "high",
              },
            }),
          );
        }
      }
    }
  }
  return { results, total };
}

// ── Smart/fuzzy scan ─────────────────────────────────────────────────

/** smartScan returns ALL ranked results (caller handles slicing/grouping). */
function smartScan(
  allMessages: Array<{
    session: SessionMetaInternal;
    messages: MsgWithParts[];
  }>,
  query: string,
  type: string,
  role: string,
  explain: boolean,
  mode: "smart" | "fuzzy",
  before?: number,
  after?: number,
  width?: number,
  toolName?: string,
  abort?: AbortSignal,
): {
  results: SearchResult[];
  total: number;
  degradeKind: DegradeKind;
  matchMode: MatchMode;
} {
  const pq = parseQuery(query);
  const startTime = performance.now();

  // ── 1. Build candidates across all sessions ───────────────────────
  const allCandidates: Array<ReturnType<typeof buildCandidates>["candidates"][number]> = [];
  let totalCharsUsed = 0;
  let anyBudgetHit = false;
  let timedOut = false;

  for (const { session, messages } of allMessages) {
    // Stop accumulating candidates if the caller aborted OR the wall-clock
    // budget is already spent. The abort flag covers async cancellation, but it
    // cannot flip during a synchronous run, so we also check the deadline
    // directly here between sessions — this is the only thing that bounds the
    // synchronous candidate-build/index phase for a hook whose timer fired while
    // the event loop was blocked. A single in-flight BM25 exec still can't be
    // preempted; the candidate/char budgets below bound that worst case.
    if (abort?.aborted || performance.now() - startTime > TIME_BUDGET_MS) {
      timedOut = true;
      break;
    }
    if (canSearchTitles(type, toolName)) {
      const representative = findRepresentativeMessage(messages, role, before, after);
      if (representative) {
        const titleCandidate = buildTitleCandidate(session, representative.info);
        if (titleCandidate) {
          allCandidates.push(titleCandidate);
        }
      }
    }

    const { candidates, charsUsed, budgetHit } = buildCandidates(
      messages,
      session,
      {
        ...DEFAULT_BUDGETS,
        maxCharsTotal: DEFAULT_BUDGETS.maxCharsTotal - totalCharsUsed,
      },
      type,
      role,
      before,
      after,
      toolName,
    );

    allCandidates.push(...candidates);
    totalCharsUsed += charsUsed;
    if (budgetHit) anyBudgetHit = true;

    // Enforce global candidate cap
    if (allCandidates.length >= DEFAULT_BUDGETS.maxCandidatesTotal) {
      allCandidates.length = DEFAULT_BUDGETS.maxCandidatesTotal;
      anyBudgetHit = true;
      break;
    }
  }

  // ── 2. Populate stage-2 normalization for all candidates ──────────
  // BM25 indexes the normalized fields directly; there is no separate
  // prefilter survival gate (the index itself selects matching docs).
  for (const candidate of allCandidates) {
    populateNormalized(candidate);
  }

  // ── 3. Run BM25 (MiniSearch) over all candidates ──────────────────
  const hits = bm25Search(allCandidates, pq, mode, explain);
  const allResults = rankedToSearchResults(hits, mode, explain, pq, width);

  const totalTime = performance.now() - startTime;

  // ── 4. Time-budget safety valve ───────────────────────────────────
  // BM25 does not swap algorithms under load; the budget only flags that
  // elapsed time was high so coverage can report it. Results are unchanged.
  // A wall-clock cutoff during candidate building (timedOut) is also a time
  // degradation; candidate-count/char caps are reported as "budget".
  if (timedOut || totalTime > TIME_BUDGET_MS) {
    return {
      results: allResults,
      total: allResults.length,
      degradeKind: "time",
      matchMode: mode,
    };
  }

  return {
    results: allResults,
    total: allResults.length,
    degradeKind: anyBudgetHit ? "budget" : "none",
    matchMode: mode,
  };
}

// ── Convert ranked results to SearchResult[] ─────────────────────────

function rankedToSearchResults(
  ranked: Bm25Hit[],
  mode: MatchMode,
  explain: boolean,
  query: ReturnType<typeof parseQuery>,
  width: number | undefined,
): SearchResult[] {
  return ranked.map((r) => {
    const c = r.candidate;

    // Always use smartSnippet which operates on raw text positions.
    // BM25 match ranges reference normalized fields and can't be
    // used directly against rawText without position mapping.
    const snip = smartSnippet(c.rawText, query, width);

    const result: SearchResult = annotateResult({
      sessionID: c.sessionID,
      sessionTitle: c.sessionTitle,
      directory: c.directory,
      messageID: c.messageID,
      role: c.role,
      time: c.time,
      partID: c.partID,
      partType: c.partType,
      pruned: c.isPruned,
      snippet: snip,
      toolName: c.toolName,
      score: r.score,
      matchMode: mode,
      matchedTerms: r.matchedTerms,
      source: c.source,
      why: {
        ...c.why,
        matchedFields:
          r.matchedFields.length > 0
            ? r.matchedFields
            : (c.why?.matchedFields ?? defaultMatchedFields(c.partType)),
      },
      directoryRelevance: c.directoryRelevance ?? "unknown",
      titleMatch: c.titleMatch,
    });

    if (explain && r.matchReasons.length > 0) {
      result.matchReasons = r.matchReasons;
    }

    return result;
  });
}

// ── Group results by session ─────────────────────────────────────────

function groupBySession(results: SearchResult[]): SearchResult[] {
  const groups = new Map<
    string,
    { best: SearchResult; count: number; titleMatch?: SearchResult["titleMatch"] }
  >();

  for (const r of results) {
    const existing = groups.get(r.sessionID);
    if (!existing) {
      groups.set(r.sessionID, { best: r, count: 1, titleMatch: r.titleMatch });
    } else {
      existing.count++;
      existing.titleMatch ??= r.titleMatch;
      // Pick best representative:
      // - Prefer content/tool/reasoning over title-only metadata when both exist
      // - Smart/fuzzy: highest score wins
      // - Literal (no score): most recent time wins
      if (existing.best.source === "title" && r.source !== "title") {
        existing.best = r;
      } else if (r.source === "title" && existing.best.source !== "title") {
        continue;
      } else if (r.score != null && existing.best.score != null) {
        if (r.score > existing.best.score) {
          existing.best = r;
        }
      } else if (r.time > existing.best.time) {
        existing.best = r;
      }
    }
  }

  return [...groups.values()].map(({ best, count, titleMatch }) => ({
    ...best,
    hitCount: count,
    titleMatch: best.titleMatch ?? titleMatch,
  }));
}

/**
 * Diversity pass for part-grouped results. Preserves the incoming ranking but
 * caps how many hits each session contributes to the initial fill, so a single
 * noisy session cannot dominate. If slots remain after the capped first pass
 * (because there weren't enough distinct sessions), the held-back hits backfill
 * in their original order. A non-positive cap or `perSession >= limit` is a
 * no-op.
 */
function diversify(results: SearchResult[], limit: number, perSession: number): SearchResult[] {
  if (perSession <= 0 || perSession >= limit || results.length <= limit) return results;

  const counts = new Map<string, number>();
  const firstPass: SearchResult[] = [];
  const heldBack: SearchResult[] = [];

  for (const r of results) {
    const used = counts.get(r.sessionID) ?? 0;
    if (used < perSession) {
      counts.set(r.sessionID, used + 1);
      firstPass.push(r);
    } else {
      heldBack.push(r);
    }
  }

  if (firstPass.length >= limit) return firstPass;
  return [...firstPass, ...heldBack];
}

function expandSearchResults(
  results: SearchResult[],
  loaded: Array<{ session: SessionMetaInternal; messages: MsgWithParts[] }>,
  mode: ExpandMode,
  expandResults: number,
  window: number,
  expandBudgetMessages: number,
  expandBudgetChars: number,
): { expanded?: ExpandedResult[]; warnings: string[] } {
  if (mode === "none") return { warnings: [] };

  const bySession = new Map(loaded.map((entry) => [entry.session.id, entry.messages]));
  const expanded: ExpandedResult[] = [];
  const budget: ExpansionBudget = { remaining: expandBudgetChars, truncated: false };
  const expandable = results
    .map((result, resultIndex) => ({ result, resultIndex }))
    .filter((entry) => entry.result.source !== "title")
    .slice(0, expandResults);
  const count = expandable.length;
  const warnings: string[] = [];
  let remainingContextMessages = expandBudgetMessages;
  let contextCapped = false;

  if (count === 0 && results.some((result) => result.source === "title")) {
    warnings.push("Expansion skipped title-only hits; title results do not have matched parts.");
  }

  for (const { result, resultIndex } of expandable) {
    const messages = bySession.get(result.sessionID);
    if (!messages) continue;

    const messageIndex = messages.findIndex((msg) => msg.info.id === result.messageID);
    if (messageIndex === -1) continue;

    if (mode === "message") {
      expanded.push({
        resultIndex,
        sessionID: result.sessionID,
        messageID: result.messageID,
        mode,
        message: formatExpandedMsg(messages[messageIndex]!, budget),
      });
      continue;
    }

    if (remainingContextMessages <= 0) {
      contextCapped = true;
      break;
    }

    const desiredStart = Math.max(0, messageIndex - window);
    const desiredEnd = Math.min(messages.length, messageIndex + window + 1);
    const desiredCount = desiredEnd - desiredStart;
    const allowedCount = Math.min(desiredCount, remainingContextMessages);
    if (allowedCount < desiredCount) contextCapped = true;

    const half = Math.floor((allowedCount - 1) / 2);
    let start = Math.max(desiredStart, messageIndex - half);
    const end = Math.min(desiredEnd, start + allowedCount);
    start = Math.max(desiredStart, end - allowedCount);
    const slice = messages.slice(start, end);
    remainingContextMessages -= slice.length;
    const items: MessageItem[] = slice.map((msg) => {
      const item = formatExpandedMsg(msg, budget);
      return { ...item, center: msg.info.id === result.messageID };
    });

    expanded.push({
      resultIndex,
      sessionID: result.sessionID,
      messageID: result.messageID,
      mode,
      messages: items,
      hasMoreBefore: start > 0,
      hasMoreAfter: end < messages.length,
    });
  }

  if (contextCapped) {
    warnings.push(
      `Context expansion capped at ${expandBudgetMessages} messages; expanded ${expanded.length} of ${count} requested results. Reduce window or expandResults to include more hits.`,
    );
  }
  if (budget.truncated) {
    warnings.push(
      `Expanded text budget capped at ${expandBudgetChars} characters; some expanded fields were truncated or omitted.`,
    );
  }

  return { expanded: expanded.length > 0 ? expanded : undefined, warnings };
}

function directoryRank(relevance: DirectoryRelevance | undefined): number {
  if (relevance === "exact") return 0;
  if (relevance === "project") return 1;
  if (relevance === "global") return 2;
  return 3;
}

function orderForDirectoryFallback(results: SearchResult[], enabled: boolean): SearchResult[] {
  if (!enabled) return results;
  return [...results].sort((a, b) => {
    const rankDiff = directoryRank(a.directoryRelevance) - directoryRank(b.directoryRelevance);
    if (rankDiff !== 0) return rankDiff;
    const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return b.time - a.time;
  });
}

function countDirectoryBuckets(
  results: SearchResult[],
): SearchCoverage["directoryBucketCounts"] | undefined {
  const counts: NonNullable<SearchCoverage["directoryBucketCounts"]> = {};
  for (const result of results) {
    if (
      result.directoryRelevance === "exact" ||
      result.directoryRelevance === "project" ||
      result.directoryRelevance === "global"
    ) {
      counts[result.directoryRelevance] = (counts[result.directoryRelevance] ?? 0) + 1;
    }
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function capWarnings(warnings: string[]): string[] | undefined {
  const unique = [...new Set(warnings.map((warning) => warning.trim()).filter(Boolean))];
  return unique.length > 0 ? unique.slice(0, MAX_WARNINGS) : undefined;
}

function buildSuggestions(input: {
  results: SearchResult[];
  coverage: SearchCoverage;
  directory?: string;
  fallback: boolean;
  matchMode: MatchMode;
  type: string | undefined;
  query: string;
}): SearchSuggestion[] | undefined {
  const suggestions: SearchSuggestion[] = [];
  const onlyTitleHits =
    input.results.length > 0 && input.results.every((result) => result.source === "title");
  const typeFilter = input.type && input.type !== "all" ? input.type : undefined;

  // Routing hint: never override the caller, only suggest a better-fitting mode.
  const routed = classifyQuery(input.query, input.matchMode);
  if (routed.suggested === "regex") {
    suggestions.push({
      reason: `${routed.reason} It may be intended as a pattern.`,
      action: 'Use match:"regex" to match it as a regular expression.',
      example: { match: "regex" },
    });
  }

  if (onlyTitleHits) {
    suggestions.push({
      reason: "Only session-title hits matched; no message content matched the query.",
      action:
        'Inspect the returned sessions, try group:"session", or use match:"smart" with broader terms.',
      example: { group: "session" },
    });
  }

  if (input.results.length === 0 && input.directory && !input.fallback) {
    suggestions.push({
      reason: "The directory filter may be excluding useful history.",
      action: "Retry with fallback:true to broaden from this directory to project/global history.",
      example: { directory: input.directory, fallback: true },
    });
  }

  if (input.results.length === 0 && input.matchMode === "literal") {
    suggestions.push({
      reason: "Literal search found no hits.",
      action: 'Try match:"smart" or match:"fuzzy" for typos and naming variants.',
      example: { match: "smart" },
    });
  }

  if (input.results.length === 0 && typeFilter) {
    suggestions.push({
      reason: `The type:${JSON.stringify(typeFilter)} filter may be hiding other evidence.`,
      action: 'Retry with type:"all" to include text, reasoning, and tool output.',
      example: { type: "all" },
    });
  }

  if (input.results.length === 0 && input.coverage.sessionsSearched <= 4) {
    const count = input.coverage.sessionsSearched;
    const noun = count === 1 ? "session" : "sessions";
    const verb = count === 1 ? "was" : "were";
    suggestions.push({
      reason: `Only ${count} ${noun} ${verb} searched.`,
      action: "Remove narrowing filters or increase the sessions limit.",
    });
  }

  return suggestions.length > 0 ? suggestions.slice(0, MAX_SUGGESTIONS) : undefined;
}

function buildNearMisses(
  results: SearchResult[],
  loaded: Array<{ session: SessionMetaInternal; messages: MsgWithParts[] }>,
): NearMiss[] | undefined {
  if (results.length > 0) return undefined;
  const misses = loaded
    .filter((entry) => entry.session.title || entry.session.directory)
    .slice(0, MAX_NEAR_MISSES)
    .map((entry) => ({
      sessionID: entry.session.id,
      title: entry.session.title || undefined,
      directory: entry.session.directory || undefined,
      reason: "Session was searched but no searchable part matched the query.",
    }));
  return misses.length > 0 ? misses : undefined;
}

function attachCommonOutput<T extends SearchOutput>(
  out: T,
  input: {
    final: SearchResult[];
    allLoaded: Array<{ session: SessionMetaInternal; messages: MsgWithParts[] }>;
    coverage: SearchCoverage;
    warnings: string[];
    directory?: string;
    fallback: boolean;
    matchMode: MatchMode;
    type: string | undefined;
    query: string;
  },
): T {
  input.coverage.directoryBucketCounts = countDirectoryBuckets(input.final);
  out.coverage = input.coverage;
  const warnings = capWarnings(input.warnings);
  if (warnings) out.warnings = warnings;
  const suggestions = buildSuggestions({
    results: input.final,
    coverage: input.coverage,
    directory: input.directory,
    fallback: input.fallback,
    matchMode: input.matchMode,
    type: input.type,
    query: input.query,
  });
  if (suggestions) out.suggestions = suggestions;
  const nearMisses = buildNearMisses(input.final, input.allLoaded);
  if (nearMisses) out.nearMisses = nearMisses;
  return out;
}

// ── Main export ──────────────────────────────────────────────────────

export function search(
  client: OpencodeClient,
  unscoped: OpencodeClient,
  global: boolean,
  limits: Limits,
): ToolDefinition {
  return tool({
    description: `Search prior opencode conversations by message/tool-output content. Primary history-discovery tool; prefer over recall_sessions for topical discovery (titles only).

Call when history could change the approach: debugging errors, investigating behavior, non-trivial feature work in areas with likely prior history, changing architecture/config, answering "last time/before", recovering commands/root causes/decisions, or checking if an approach worked or failed. Also call before substantive work in an unfamiliar area of this project.

Skip trivial commands, simple local code/file lookup, simple edits with full context, ordinary code tasks where prior history would not change the approach, or anything not helped by past conversations.

First call: for broad discovery use match:"smart", group:"session", scope:"global" (default), 5-10 results, and short terms from error text/feature/config/file/decision. Use role:"user" for requirements/decisions. Use expand:"context" or "message" when top-hit evidence will avoid a follow-up.

If memory exists, store only durable findings: preferences, project decisions, reusable root causes, environment facts, behavior corrections, or repeatable success/failure. Do not store ephemeral details, one-off commands, transient errors, or implementation minutiae.

Modes: literal exact substring; smart ranked BM25; fuzzy looser; regex pattern (invalid pattern errors). Smart/fuzzy include score/matchedTerms and fall back to literal. Results are snippets; use recall_get/context for full content. loadErrorCount/loadErrors indicate partial session-load failures.`,
    args: {
      query: tool.schema.string().min(1).describe("Search text"),
      scope: tool.schema
        .enum(["session", "project", "global"])
        .default("global")
        .describe("global=all projects, project=current project, session=current only"),
      match: tool.schema
        .enum(["literal", "smart", "fuzzy", "regex"])
        .default("literal")
        .describe("literal=exact, smart=ranked fuzzy, fuzzy=looser, regex=pattern"),
      explain: tool.schema.boolean().default(false).describe("Include matchReasons"),
      group: tool.schema
        .enum(["part", "session"])
        .default("part")
        .describe("part=per hit, session=one per session with hitCount"),
      sessionID: tool.schema.string().optional().describe("Specific session; overrides scope"),
      type: tool.schema
        .enum(["text", "tool", "reasoning", "all"])
        .default("all")
        .describe("Part type filter"),
      role: tool.schema.enum(["user", "assistant", "all"]).default("all").describe("Role filter"),
      sessions: tool.schema
        .number()
        .min(1)
        .max(limits.maxSessions)
        .optional()
        .describe("Max sessions to scan"),
      results: tool.schema
        .number()
        .min(1)
        .max(limits.maxResults)
        .default(Math.min(10, limits.maxResults))
        .describe("Max returned results"),
      title: tool.schema.string().optional().describe("Pre-filter by session title"),
      before: tool.schema
        .union([tool.schema.number(), tool.schema.string()])
        .optional()
        .describe("Only messages before ms epoch or date"),
      after: tool.schema
        .union([tool.schema.number(), tool.schema.string()])
        .optional()
        .describe("Only messages after ms epoch or date"),
      since: tool.schema.string().optional().describe("Compatibility alias for last: 2h, 7d, 3w"),
      until: tool.schema.string().optional().describe("Older-than relative filter: 2h, 7d, 3w"),
      last: tool.schema.string().optional().describe("Recent-history lower bound: 2h, 7d, 3w"),
      from: tool.schema.string().optional().describe("Lower bound like '365d ago' or date"),
      to: tool.schema.string().optional().describe("Upper bound like 'now' or date"),
      directory: tool.schema.string().optional().describe("Exact or descendant session dir"),
      fallback: tool.schema.boolean().default(false).describe("Broaden directory search if needed"),
      toolName: tool.schema.string().optional().describe("Exact tool name; tool parts only"),
      expand: tool.schema
        .enum(["none", "context", "message"])
        .default("none")
        .describe("Inline none/context/message"),
      expandResults: tool.schema.number().int().min(1).default(1).describe("Expanded result count"),
      window: tool.schema
        .union([tool.schema.number().int().min(0), tool.schema.literal("auto")])
        .default(Math.min(3, limits.maxWindow))
        .describe("Context messages each side"),
      expandBudgetMessages: tool.schema
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Total context messages to expand"),
      expandBudgetChars: tool.schema
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Total expanded text budget"),
      width: tool.schema
        .number()
        .min(50)
        .max(Math.max(limits.defaultWidth, 1000))
        .default(limits.defaultWidth)
        .describe("Snippet context chars"),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      // Defensive defaults and validation: some callers (e.g. live MCP) may
      // bypass Zod and forward raw caller args. Coerce missing values to safe
      // defaults and clamp/whitelist invalid values rather than trusting Zod.
      const defenseWarnings: string[] = [];
      const pickEnum = <T extends string>(
        label: string,
        value: unknown,
        allowed: readonly T[],
        fallbackValue: T,
      ): T => {
        if (typeof value !== "string") return fallbackValue;
        if ((allowed as readonly string[]).includes(value)) return value as T;
        defenseWarnings.push(
          `Ignored ${label}:${JSON.stringify(value)}; using ${label}:${JSON.stringify(fallbackValue)}.`,
        );
        return fallbackValue;
      };
      const pickNumber = (
        label: string,
        value: unknown,
        min: number,
        max: number,
        fallbackValue: number,
      ): number => {
        if (value == null) return fallbackValue;
        if (typeof value !== "number" || !Number.isFinite(value)) {
          // JSON.stringify(NaN) is the string "null", which is misleading in a
          // warning. Render numbers via String() so NaN/Infinity stay literal.
          defenseWarnings.push(
            `Ignored ${label}:${typeof value === "number" ? String(value) : JSON.stringify(value)}; using ${label}:${fallbackValue}.`,
          );
          return fallbackValue;
        }
        return clampNumber(label, Math.trunc(value), min, max, defenseWarnings);
      };

      const scope = pickEnum(
        "scope",
        args.scope,
        ["session", "project", "global"] as const,
        "global",
      );
      const matchMode = pickEnum(
        "match",
        args.match,
        ["literal", "smart", "fuzzy", "regex"] as const,
        "literal",
      ) as MatchMode;
      const explain = typeof args.explain === "boolean" ? args.explain : false;
      const groupArg = pickEnum("group", args.group, ["part", "session"] as const, "part");
      const partType = pickEnum(
        "type",
        args.type,
        ["text", "tool", "reasoning", "all"] as const,
        "all",
      );
      const role = pickEnum("role", args.role, ["user", "assistant", "all"] as const, "all");
      const fallback = typeof args.fallback === "boolean" ? args.fallback : false;
      const expandMode = pickEnum(
        "expand",
        args.expand,
        ["none", "context", "message"] as const,
        "none",
      ) as ExpandMode;
      const expandResultsArg = pickNumber(
        "expandResults",
        args.expandResults,
        1,
        Number.MAX_SAFE_INTEGER,
        1,
      );
      const windowArg =
        args.window === "auto"
          ? "auto"
          : pickNumber(
              "window",
              args.window,
              0,
              Number.MAX_SAFE_INTEGER,
              Math.min(3, limits.maxWindow),
            );
      const widthArg = pickNumber(
        "width",
        args.width,
        50,
        Math.max(limits.defaultWidth, 1000),
        limits.defaultWidth,
      );
      const resultsArg = pickNumber(
        "results",
        args.results,
        1,
        limits.maxResults,
        Math.min(10, limits.maxResults),
      );
      // For the budget fields we keep `undefined` distinct from a clamped value
      // so `normalizeSearchOptions` can apply its own default. `pickNumber` only
      // runs when a non-null value is supplied, and its upper bound is
      // intentionally loose — the real per-budget cap lives in normalization
      // (one clamp warning per oversized request, not two).
      const expandBudgetMessagesArg =
        args.expandBudgetMessages == null
          ? undefined
          : pickNumber(
              "expandBudgetMessages",
              args.expandBudgetMessages,
              1,
              Number.MAX_SAFE_INTEGER,
              MAX_EXPANDED_CONTEXT_MESSAGES,
            );
      const expandBudgetCharsArg =
        args.expandBudgetChars == null
          ? undefined
          : pickNumber(
              "expandBudgetChars",
              args.expandBudgetChars,
              1,
              Number.MAX_SAFE_INTEGER,
              MAX_EXPANDED_TOTAL_TEXT_CHARS,
            );

      const sessionID = optionalString(args.sessionID);
      const title = optionalString(args.title);
      const directory = optionalString(args.directory);
      const toolName = optionalString(args.toolName);
      const requestedSessions =
        args.sessions == null
          ? undefined
          : pickNumber("sessions", args.sessions, 1, limits.maxSessions, limits.maxSessions);
      const sessionListLimit = directory
        ? listLimitForDirectoryFilter(requestedSessions, limits.maxSessions)
        : (requestedSessions ??
          (Number.isFinite(limits.maxSessions) ? limits.maxSessions : undefined));

      const fail = (error: string): string =>
        JSON.stringify({ ok: false, error } satisfies ErrorOutput);

      if (toolName && partType !== "all" && partType !== "tool") {
        return fail('toolName can only be used with type:"all" or type:"tool"');
      }

      // Compile the regex up front so an invalid pattern is a clean caller error.
      let regex: RegExp | undefined;
      if (matchMode === "regex") {
        const compiled = compileRegex(args.query);
        if (!compiled.ok) return fail(compiled.error);
        regex = compiled.re;
      }

      const normalized = normalizeSearchOptions(
        {
          after: args.after,
          before: args.before,
          since: args.since,
          until: args.until,
          last: args.last,
          from: args.from,
          to: args.to,
          expandResults: expandResultsArg,
          window: windowArg,
          expandBudgetMessages: expandBudgetMessagesArg,
          expandBudgetChars: expandBudgetCharsArg,
        },
        limits,
      );
      if ("ok" in normalized) return fail(normalized.error);
      // Surface defensive-default warnings alongside time/expansion warnings.
      normalized.warnings.unshift(...defenseWarnings);
      const { before, after } = normalized;

      ctx.metadata({
        title: `Searching ${scope} for "${args.query}"${matchMode !== "literal" ? ` (${matchMode})` : ""}`,
      });

      if (scope === "global" && !sessionID && !global) {
        const err: ErrorOutput = {
          ok: false,
          error: "Global scope disabled via plugin option: global: false",
        };
        return JSON.stringify(err);
      }

      try {
        let targets: SessionMetaInternal[] = [];

        if (sessionID) {
          let title = "";
          let directory = "";
          let updated = 0;
          let projectID: string | undefined;
          let projectWorktree: string | undefined;
          try {
            const sess = await client.session.get({
              sessionID,
            });
            if (sess.data) {
              const data = sess.data as Session | GlobalSession;
              title = data.title;
              directory = data.directory;
              updated = data.time.updated;
              projectID = data.projectID;
              projectWorktree = "project" in data ? data.project?.worktree : undefined;
            }
          } catch {
            // Can't get metadata, proceed anyway
          }
          targets = [{ id: sessionID, title, directory, updated, projectID, projectWorktree }];
        } else if (scope === "session") {
          if (!ctx.sessionID) {
            const err: ErrorOutput = {
              ok: false,
              error: "No sessionID provided and no current session available",
            };
            return JSON.stringify(err);
          }

          let title = "";
          let directory = "";
          let updated = 0;
          let projectID: string | undefined;
          let projectWorktree: string | undefined;
          try {
            const sess = await client.session.get({ sessionID: ctx.sessionID });
            if (sess.data) {
              const data = sess.data as Session | GlobalSession;
              title = data.title;
              directory = data.directory;
              updated = data.time.updated;
              projectID = data.projectID;
              projectWorktree = "project" in data ? data.project?.worktree : undefined;
            }
          } catch {
            // proceed without metadata
          }
          targets = [{ id: ctx.sessionID, title, directory, updated, projectID, projectWorktree }];
        } else if (scope === "project") {
          const resp = await client.session.list({
            search: title,
            limit: sessionListLimit,
          });
          if (resp.error) {
            const err: ErrorOutput = {
              ok: false,
              error: `Failed to list sessions: ${errmsg(resp.error)}`,
            };
            return JSON.stringify(err);
          }
          if (resp.data) targets = resp.data.map(meta);
        } else {
          const resp = await unscoped.experimental.session.list({
            search: title,
            limit: sessionListLimit,
          });
          if (resp.error) {
            const err: ErrorOutput = {
              ok: false,
              error: `Failed to list sessions: ${errmsg(resp.error)}`,
            };
            return JSON.stringify(err);
          }
          if (resp.data) targets = resp.data.map(meta);
        }

        if (directory && fallback && !sessionID && scope === "project" && global) {
          const resp = await unscoped.experimental.session.list({
            search: title,
            limit: sessionListLimit,
          });
          if (resp.data) targets = dedupeSessions([...targets, ...resp.data.map(meta)]);
          if (resp.error) {
            normalized.warnings.push(
              `Directory fallback could not list global sessions: ${errmsg(resp.error)}.`,
            );
          }
        }

        const discoveredTargets = dedupeSessions(targets);
        const skippedByReason: Record<string, number> = {};
        let directoryBucketsSearched: SearchCoverage["directoryBucketsSearched"];
        let sessionsEligible = discoveredTargets.length;
        if (directory) {
          pushUnique(normalized.limitedBy, "directory");
          const fallbackWorktree = optionalString(ctx.worktree) ?? optionalString(ctx.directory);
          if (fallback && !fallbackWorktree) {
            normalized.warnings.push(
              "Directory fallback could not identify a project/worktree bucket; using exact and global buckets only.",
            );
          }
          const bucketed = discoveredTargets.map((target) =>
            withDirectoryRelevance(
              target,
              classifyDirectoryRelevance(target, directory, fallbackWorktree),
            ),
          );
          const exact = bucketed.filter((target) => target.directoryRelevance === "exact");
          const project = bucketed.filter((target) => target.directoryRelevance === "project");
          const fallbackGlobal = bucketed.filter(
            (target) => target.directoryRelevance === "global",
          );

          if (fallback) {
            targets = [...exact, ...project, ...fallbackGlobal];
            sessionsEligible = targets.length;
            directoryBucketsSearched = [
              ...(exact.length > 0 ? (["exact"] as const) : []),
              ...(project.length > 0 ? (["project"] as const) : []),
              ...(fallbackGlobal.length > 0 ? (["global"] as const) : []),
            ];
            if (project.length > 0 || fallbackGlobal.length > 0) {
              normalized.warnings.push(
                "Directory fallback broadened the search beyond exact matches.",
              );
            }
          } else {
            targets = exact;
            sessionsEligible = targets.length;
            const skipped = discoveredTargets.length - targets.length;
            if (skipped > 0) skippedByReason.directory = skipped;
            directoryBucketsSearched = exact.length > 0 ? ["exact"] : [];
          }

          if (requestedSessions != null && targets.length > requestedSessions) {
            skippedByReason.sessionsLimit =
              (skippedByReason.sessionsLimit ?? 0) + (targets.length - requestedSessions);
            targets = targets.slice(0, requestedSessions);
          }
        } else {
          targets = discoveredTargets.map((target) => withDirectoryRelevance(target, "unknown"));
          sessionsEligible = targets.length;
        }

        if (requestedSessions != null && sessionsEligible > requestedSessions) {
          pushUnique(normalized.limitedBy, "sessionsLimit");
        }
        if (Number.isFinite(limits.maxSessions) && discoveredTargets.length >= limits.maxSessions) {
          pushUnique(normalized.limitedBy, "maxSessions");
        }
        if (title) pushUnique(normalized.limitedBy, "title");
        if (sessionID) pushUnique(normalized.limitedBy, "sessionID");
        else if (scope !== "global") pushUnique(normalized.limitedBy, "scope");

        // ── Load messages ─────────────────────────────────────────────
        const allLoaded: Array<{
          session: SessionMetaInternal;
          messages: MsgWithParts[];
        }> = [];
        const loadErrors: string[] = [];
        let loadErrorCount = 0;
        let scanned = 0;

        for (let i = 0; i < targets.length; i += limits.concurrency) {
          if (ctx.abort.aborted) break;

          const batch = targets.slice(i, i + limits.concurrency);

          const loaded = await Promise.all(
            batch.map(async (t) => {
              try {
                const resp = await client.session.messages({
                  sessionID: t.id,
                });
                if (resp.error) {
                  loadErrorCount++;
                  if (loadErrors.length < MAX_LOAD_ERROR_SAMPLES) {
                    loadErrors.push(`${t.id}: ${errmsg(resp.error)}`);
                  }
                  return { session: t, messages: [] as MsgWithParts[] };
                }
                if (!resp.data) {
                  loadErrorCount++;
                  if (loadErrors.length < MAX_LOAD_ERROR_SAMPLES) {
                    loadErrors.push(`${t.id}: no messages returned`);
                  }
                  return { session: t, messages: [] as MsgWithParts[] };
                }
                return {
                  session: t,
                  messages: resp.data as MsgWithParts[],
                };
              } catch (e) {
                loadErrorCount++;
                if (loadErrors.length < MAX_LOAD_ERROR_SAMPLES) {
                  loadErrors.push(`${t.id}: ${errmsg(e)}`);
                }
                return { session: t, messages: [] as MsgWithParts[] };
              }
            }),
          );

          allLoaded.push(...loaded);
          scanned += batch.length;
        }

        if (ctx.abort.aborted) {
          const err: ErrorOutput = { ok: false, error: "aborted" };
          return JSON.stringify(err);
        }

        if (loadErrorCount > 0) pushUnique(normalized.limitedBy, "loadError");
        const { messagesSearched, partsSearched } = countSearchCoverage(
          allLoaded,
          partType,
          role,
          toolName,
          before,
          after,
        );
        const sessionsDiscovered = discoveredTargets.length;
        const sessionsSkipped = sessionsDiscovered - scanned;
        if (sessionsSkipped > 0) {
          const accounted = Object.values(skippedByReason).reduce((sum, value) => sum + value, 0);
          if (accounted < sessionsSkipped) {
            skippedByReason.filtered = sessionsSkipped - accounted;
          }
        }
        const coverage: SearchCoverage = {
          totalSessionsKnown: false,
          sessionsDiscovered,
          sessionsEligible,
          sessionsSearched: scanned,
          messagesSearched,
          partsSearched,
          sessionsSkipped,
          skippedByReason: Object.keys(skippedByReason).length > 0 ? skippedByReason : undefined,
          directoryBucketsSearched,
          limitedBy: normalized.limitedBy.length > 0 ? normalized.limitedBy : undefined,
        };

        const groupMode: GroupMode = groupArg;
        const isGrouped = groupMode === "session";
        const incomplete = loadErrorCount > 0;
        const loadErrorSuffix = incomplete
          ? `, ${loadErrorCount} load error${loadErrorCount !== 1 ? "s" : ""}`
          : "";
        const includeLoadErrors = <T extends SearchOutput>(out: T): T => {
          if (!incomplete) return out;
          out.loadErrorCount = loadErrorCount;
          out.loadErrors = [...loadErrors];
          return out;
        };
        const includeExpansion = <T extends SearchOutput>(
          out: T,
          final: SearchResult[],
          warnings: string[],
        ): T => {
          const expansion = expandSearchResults(
            final,
            allLoaded,
            expandMode,
            normalized.expandResults,
            normalized.window,
            normalized.expandBudgetMessages,
            normalized.expandBudgetChars,
          );
          if (expansion.expanded) out.expanded = expansion.expanded;
          warnings.push(...expansion.warnings);
          return out;
        };
        const finish = <T extends SearchOutput>(
          out: T,
          final: SearchResult[],
          effectiveMatchMode: MatchMode,
        ): T => {
          const warnings = [...normalized.warnings];
          if (incomplete) {
            warnings.push(
              `${loadErrorCount} session${loadErrorCount === 1 ? "" : "s"} failed to load; results may be partial.`,
            );
          }
          return includeLoadErrors(
            attachCommonOutput(includeExpansion(out, final, warnings), {
              final,
              allLoaded,
              coverage,
              warnings,
              directory,
              fallback,
              matchMode: effectiveMatchMode,
              type: partType,
              query: args.query,
            }),
          );
        };

        // ── Helper: run literal scan (full or limited) ───────────────
        const literalScan = (
          scanLimit: number,
        ): { collected: SearchResult[]; total: number; early: boolean } => {
          const collected: SearchResult[] = [];
          let total = 0;
          let early = false;
          const scanStart = performance.now();

          for (const { session: sess, messages: msgs } of allLoaded) {
            if (collected.length >= scanLimit) {
              early = true;
              break;
            }
            // Bound synchronous scanning by wall-clock and honor a fired abort
            // (a hook timeout may have landed mid-scan, where the abort flag
            // couldn't be observed until now).
            if (ctx.abort.aborted || performance.now() - scanStart > SCAN_TIME_BUDGET_MS) {
              early = true;
              break;
            }
            const remaining = scanLimit - collected.length;
            const result = scan(
              msgs,
              sess,
              args.query,
              partType,
              role,
              remaining,
              before,
              after,
              widthArg,
              toolName,
            );
            collected.push(...result.results);
            total += result.total;

            if (
              canSearchTitles(partType, toolName) &&
              matches(sess.title, args.query) &&
              collected.length < scanLimit
            ) {
              const representative = findRepresentativeMessage(msgs, role, before, after);
              if (representative) {
                collected.push(
                  titleSearchResult(
                    sess,
                    representative,
                    snippet(sess.title, args.query, widthArg),
                  ),
                );
                total++;
              }
            }
          }
          return { collected, total, early };
        };

        // ── Helper: run regex scan (full or limited) ─────────────────
        const regexScanAll = (
          re: RegExp,
          scanLimit: number,
        ): { collected: SearchResult[]; total: number; early: boolean } => {
          const collected: SearchResult[] = [];
          let total = 0;
          let early = false;
          const scanStart = performance.now();

          for (const { session: sess, messages: msgs } of allLoaded) {
            if (collected.length >= scanLimit) {
              early = true;
              break;
            }
            // Bound synchronous scanning by wall-clock and honor a fired abort.
            if (ctx.abort.aborted || performance.now() - scanStart > SCAN_TIME_BUDGET_MS) {
              early = true;
              break;
            }
            const remaining = scanLimit - collected.length;
            const result = regexScan(
              msgs,
              sess,
              re,
              partType,
              role,
              remaining,
              before,
              after,
              widthArg,
              toolName,
            );
            collected.push(...result.results);
            total += result.total;

            const titleIndex = canSearchTitles(partType, toolName)
              ? regexFirstIndex(re, sess.title)
              : -1;
            if (titleIndex !== -1 && collected.length < scanLimit) {
              const representative = findRepresentativeMessage(msgs, role, before, after);
              if (representative) {
                collected.push(
                  titleSearchResult(
                    sess,
                    representative,
                    regexSnippet(re, sess.title, widthArg, titleIndex),
                  ),
                );
                total++;
              }
            }
          }
          return { collected, total, early };
        };

        // ── Helper: apply grouping and slicing ───────────────────────
        const applyGroupAndSlice = (
          results: SearchResult[],
          partTotal: number,
          earlyExit: boolean,
        ): { final: SearchResult[]; total: number; truncated: boolean } => {
          if (isGrouped) {
            const grouped = orderForDirectoryFallback(
              groupBySession(results),
              Boolean(directory && fallback),
            );
            const final = grouped.slice(0, resultsArg);
            return {
              final,
              total: grouped.length,
              truncated: earlyExit || grouped.length > final.length,
            };
          }
          // Diversify first (caps per-session hits), then restore directory
          // relevance ordering — otherwise a held-back exact-directory hit can
          // land behind a global-directory hit, inverting the fallback ordering
          // the caller asked for.
          const diversified = diversify(results, resultsArg, MAX_HITS_PER_SESSION_INITIAL);
          const ordered = orderForDirectoryFallback(diversified, Boolean(directory && fallback));
          const final = ordered.slice(0, resultsArg);
          return {
            final,
            total: partTotal,
            truncated: earlyExit || partTotal > final.length,
          };
        };

        // Part-mode literal/regex over-collect so the diversity pass has
        // cross-session material; grouped mode already scans broadly.
        const partScanLimit = Math.min(
          MAX_GROUPED_LITERAL_RESULTS,
          resultsArg * DIVERSITY_SCAN_MULTIPLIER,
        );

        // ── Route: literal or smart/fuzzy ─────────────────────────────
        if (matchMode === "literal") {
          // When grouping by session, scan all sessions (no early exit)
          // so we get representative hits from every matching session
          const limit = isGrouped ? MAX_GROUPED_LITERAL_RESULTS : partScanLimit;
          const { collected, total, early } = literalScan(limit);
          const { final, total: outTotal, truncated } = applyGroupAndSlice(collected, total, early);

          const unit = isGrouped ? "session" : "result";
          ctx.metadata({
            title: `Found ${final.length} ${unit}${final.length !== 1 ? "s" : ""} for "${args.query}" (${scanned} session${scanned !== 1 ? "s" : ""} searched${loadErrorSuffix})`,
          });

          const out: SearchOutput = {
            ok: true,
            results: final,
            scanned,
            total: outTotal,
            truncated,
            group: groupMode,
          };
          return JSON.stringify(finish(out, final, "literal"));
        }

        // ── Route: regex ──────────────────────────────────────────────
        if (matchMode === "regex" && regex) {
          const limit = isGrouped ? MAX_GROUPED_LITERAL_RESULTS : partScanLimit;
          const { collected, total, early } = regexScanAll(regex, limit);
          const { final, total: outTotal, truncated } = applyGroupAndSlice(collected, total, early);

          const unit = isGrouped ? "session" : "result";
          ctx.metadata({
            title: `Found ${final.length} ${unit}${final.length !== 1 ? "s" : ""} for /${args.query}/ (regex, ${scanned} session${scanned !== 1 ? "s" : ""}${loadErrorSuffix})`,
          });

          const out: SearchOutput = {
            ok: true,
            results: final,
            scanned,
            total: outTotal,
            truncated,
            matchMode: "regex",
            group: groupMode,
          };
          return JSON.stringify(finish(out, final, "regex"));
        }

        // ── Smart/fuzzy path ────────────────────────────────────────
        // literal and regex modes returned above; only smart/fuzzy remain.
        const smartMode: "smart" | "fuzzy" = matchMode === "fuzzy" ? "fuzzy" : "smart";
        const smartResult = smartScan(
          allLoaded,
          args.query,
          partType,
          role,
          explain,
          smartMode,
          before,
          after,
          widthArg,
          toolName,
          ctx.abort,
        );
        if (smartResult.degradeKind === "budget") pushUnique(normalized.limitedBy, "rankingBudget");
        if (smartResult.degradeKind === "time") pushUnique(normalized.limitedBy, "timeBudget");

        // ── Fallback to literal if smart returns nothing ────────────
        // Skip the fallback when the smart pass was cut short rather than
        // genuinely empty: if the caller aborted (a hook timeout fired
        // mid-smartScan) or the wall-clock budget was hit, a synchronous literal
        // re-scan would run past the budget the timeout just enforced, and would
        // also mask the time-degradation signal.
        if (
          smartResult.results.length === 0 &&
          smartResult.degradeKind !== "time" &&
          !ctx.abort.aborted
        ) {
          const limit = isGrouped ? MAX_GROUPED_LITERAL_RESULTS : partScanLimit;
          const { collected, total, early } = literalScan(limit);
          const { final, total: outTotal, truncated } = applyGroupAndSlice(collected, total, early);

          if (final.length > 0) {
            const unit = isGrouped ? "session" : "result";
            ctx.metadata({
              title: `Found ${final.length} ${unit}${final.length !== 1 ? "s" : ""} for "${args.query}" (literal fallback, ${scanned} session${scanned !== 1 ? "s" : ""}${loadErrorSuffix})`,
            });

            const out: SearchOutput = {
              ok: true,
              results: final,
              scanned,
              total: outTotal,
              truncated,
              matchMode: "literal",
              degradeKind: "fallback",
              group: groupMode,
            };
            return JSON.stringify(finish(out, final, "literal"));
          }
        }

        // ── Return smart/fuzzy results ──────────────────────────────
        const {
          final,
          total: outTotal,
          truncated,
        } = applyGroupAndSlice(smartResult.results, smartResult.total, false);

        const unit = isGrouped ? "session" : "result";
        ctx.metadata({
          title: `Found ${final.length} ${unit}${final.length !== 1 ? "s" : ""} for "${args.query}" (${matchMode}, ${scanned} session${scanned !== 1 ? "s" : ""}${loadErrorSuffix})`,
        });

        const out: SearchOutput = {
          ok: true,
          results: final,
          scanned,
          total: outTotal,
          truncated,
          matchMode: smartResult.matchMode,
          degradeKind: smartResult.degradeKind,
          group: groupMode,
        };
        return JSON.stringify(finish(out, final, smartResult.matchMode));
      } catch (e) {
        const err: ErrorOutput = { ok: false, error: errmsg(e) };
        return JSON.stringify(err);
      }
    },
  });
}
