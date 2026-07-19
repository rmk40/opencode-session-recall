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
  type GroupMode,
  type SearchCoverage,
  type SearchSuggestion,
  type NearMiss,
  type DirectoryRelevance,
  type EvidenceClass,
  type ResultSource,
  type ResultWhy,
  DISCOVERY_LIMIT,
} from "./types.js";
import { snippet, matches, formatMsg, isSelfTool, evidenceClassFor } from "./extract.js";
import { parseQuery } from "./query.js";
import { candidateEligible, type Candidate, type CandidateFilters } from "./candidates.js";
import type { CandidateEmbedder } from "./corpus.js";
import { clamp01, bm25Search, type Bm25Hit } from "./bm25.js";
import { smartSnippet, truncatePreservingMatch } from "./snippet.js";
import { compileRegex, regexFirstIndex, regexSnippet } from "./regex.js";
import { classifyQuery } from "./route.js";
import type { CardsRuntime, CardHit, CardFilters } from "./cards.js";
import {
  encodeDeepCursor,
  decodeDeepCursor,
  type Drill,
  type DrillTarget,
  type DrilledPool,
} from "./drill.js";
import type { Store, FtsHit, Card } from "./store.js";
import type { FetchGate } from "./fetch-gate.js";
import { fetchMessageWindow, type FetchRunner } from "./fetch-window.js";

/** The embedder as the search path consumes it: the cache-facing surface plus
 *  the init error, so the one-time "unavailable" warning can explain why. */
export type SearchEmbedder = CandidateEmbedder & { initError?: string };
/** Opt-in semantic config threaded from the plugin into the tier-1 card runtime,
 *  which embeds card text once per load. The drill does not embed candidates. */
export type SemanticSearchConfig = { embedder: SearchEmbedder; weight: number };

/** Tier-2 dependency bundle: the shared fetch gate, the derived card store (null
 *  in degraded mode), the tier-1 card runtime, and the tier-2 drill. Built once
 *  in the plugin entry and shared by the recall tool and both search-running
 *  hooks. */
export type SearchDeps = {
  gate: FetchGate;
  store: Store | null;
  cards: CardsRuntime;
  drill: Drill;
};

/** Wall-clock budget for the synchronous literal/regex scan loops (ms). Bounds
 *  the worst case where a fired abort can't preempt synchronous scanning (e.g.
 *  a hook timeout that lands mid-scan), keeping the event loop responsive. */
const SCAN_TIME_BUDGET_MS = 2000;

/** Part-mode literal/regex over-collection bound (grouped mode scans the
 *  whole eligible corpus — the completeness contract — with the wall-clock
 *  scan budget as the safety valve, reported via truncated). */
const MAX_PART_SCAN_RESULTS = 1000;

const MAX_EXPANDED_RESULTS = 3;
const MAX_EXPANDED_CONTEXT_MESSAGES = 30;
const MAX_EXPANDED_TOTAL_TEXT_CHARS = 30_000;
const MAX_EXPANDED_FIELD_CHARS = 4_000;
/** Cap on one part's total expanded text (all fields combined) so a single
 *  oversized tool dump cannot consume the whole expansion budget. */
const MAX_EXPANDED_PART_CHARS = 6_000;
/** Cap on one part's serialized tool INPUT inside expansion: a Write-style
 *  input embedding a whole file must not bypass the budgets. recall_get
 *  remains the full-fidelity path. */
const MAX_EXPANDED_INPUT_CHARS = 2_000;
// DISCOVERY_LIMIT now lives in types.ts (so the distiller can share it without a
// search-module cycle); re-exported here for existing importers.
export { DISCOVERY_LIMIT };
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
/** Hard cap on how many targets a resumed deep cursor may reconstitute, so an
 *  untrusted cursor cannot inflate the swept set beyond a sane bound. */
const MAX_RESUME_TARGETS = 500;
const EXPANSION_TRUNCATED = "\n[truncated by recall expansion]";

type ExpandMode = "none" | "context" | "message";
export type ExpansionBudget = {
  remaining: number;
  truncated: boolean;
  /** A field was cut because the BUDGET bound it (not the per-field cap). */
  limitedByBudget?: boolean;
  /** The per-part cap was the binding constraint for some part. */
  partCapped?: boolean;
};
/** Locate the query's match position in a text, per match mode (-1 if none). */
type MatchFinder = (text: string) => number;
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
  parentID?: string;
  projectID?: string;
  projectWorktree?: string;
  directoryRelevance?: DirectoryRelevance;
};

/** Bounded ancestor walk + descendant BFS depth for the exclusion family. */
const MAX_FAMILY_DEPTH = 16;

/**
 * The current session's delegation tree within the discovered set: walk
 * parentID up to the highest discovered ancestor (bounded, cycle-guarded),
 * then collect that root's transitive descendants. Searching for prior
 * history from a parent must not answer with its own subagents' restated
 * findings — and vice versa from inside a subagent. Exported for tests.
 */
export function exclusionFamily(
  discovered: SessionMetaInternal[],
  currentSessionID: string,
): Set<string> {
  const byID = new Map<string, SessionMetaInternal>();
  const childrenByParent = new Map<string, string[]>();
  for (const session of discovered) {
    byID.set(session.id, session);
    if (session.parentID) {
      const siblings = childrenByParent.get(session.parentID);
      if (siblings) siblings.push(session.id);
      else childrenByParent.set(session.parentID, [session.id]);
    }
  }

  // Ascend to the top-most discovered ancestor.
  let root = currentSessionID;
  const seen = new Set([currentSessionID]);
  for (let depth = 0; depth < MAX_FAMILY_DEPTH; depth++) {
    const parentID = byID.get(root)?.parentID;
    if (!parentID || seen.has(parentID)) break;
    seen.add(parentID);
    root = parentID;
  }

  // Collect the root's subtree (bounded, cycle-guarded).
  const family = new Set([currentSessionID, root]);
  let frontier = [root];
  for (let depth = 0; depth < MAX_FAMILY_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const childID of childrenByParent.get(id) ?? []) {
        if (family.has(childID)) continue;
        family.add(childID);
        next.push(childID);
      }
    }
    frontier = next;
  }
  return family;
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
    why: {
      matchedFields: defaultMatchedFields(result.partType),
      matchedTerms: result.matchedTerms,
      directoryRelevance: "unknown",
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

function canSearchTitles(type: string, toolName: string | undefined): boolean {
  return type === "all" && !toolName;
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

function truncateExpandedText(
  value: string | undefined,
  budget: ExpansionBudget,
  findMatch?: MatchFinder,
): string | undefined {
  if (value == null) return undefined;
  if (budget.remaining <= 0) {
    budget.truncated = true;
    budget.limitedByBudget = true;
    return undefined;
  }

  const allowed = Math.min(MAX_EXPANDED_FIELD_CHARS, budget.remaining);
  if (value.length <= allowed) {
    budget.remaining -= value.length;
    return value;
  }
  // Truncating: record whether the budget (rather than the per-field cap)
  // was the binding constraint, so the caller can attribute the cut.
  if (budget.remaining < MAX_EXPANDED_FIELD_CHARS) budget.limitedByBudget = true;

  if (allowed <= EXPANSION_TRUNCATED.length) {
    budget.truncated = true;
    return undefined;
  }

  const sliceLength = allowed - EXPANSION_TRUNCATED.length;
  budget.remaining -= allowed;
  budget.truncated = true;
  // For the matched part, keep the head plus a window around the match
  // instead of head-only slicing that can drop the matched region entirely.
  if (findMatch) {
    const matchIndex = findMatch(value);
    if (matchIndex > 0) {
      return `${truncatePreservingMatch(value, matchIndex, sliceLength)}${EXPANSION_TRUNCATED}`;
    }
  }
  return `${value.slice(0, sliceLength)}${EXPANSION_TRUNCATED}`;
}

const SELF_TOOL_REDACTED = "[recall output omitted]";

/** Budget a tool input for expansion. Small inputs keep their original shape
 *  (and charge their serialized length); oversized ones are replaced with a
 *  truncated serialized string plus the marker. Unserializable inputs
 *  (circular, bare undefined) are omitted rather than thrown on. */
function truncateExpandedInput(value: unknown, budget: ExpansionBudget): unknown {
  if (value == null) return value;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (serialized === undefined) return undefined;

  const allowed = Math.min(MAX_EXPANDED_INPUT_CHARS, budget.remaining);
  if (serialized.length <= allowed) {
    budget.remaining -= serialized.length;
    return value;
  }
  budget.truncated = true;
  if (allowed <= EXPANSION_TRUNCATED.length) {
    budget.limitedByBudget = true;
    return undefined;
  }
  if (budget.remaining < MAX_EXPANDED_INPUT_CHARS) budget.limitedByBudget = true;
  const sliceLength = allowed - EXPANSION_TRUNCATED.length;
  budget.remaining -= allowed;
  return `${serialized.slice(0, sliceLength)}${EXPANSION_TRUNCATED}`;
}

/** Exported for direct unit tests of the per-part budget mechanics. */
export function truncateExpandedPart(
  part: PartOutput,
  budget: ExpansionBudget,
  findMatch?: MatchFinder,
): PartOutput {
  // Never surface our own recall tool output inside expansion. Search matching
  // already excludes self-tool parts (searchableFields), but expansion formats
  // every surrounding part, so a hit adjacent to a prior recall call would leak
  // that recall's output. Redact the body but keep the part marker so message
  // structure/positioning is preserved. Explicit recall_get/recall_context are
  // unaffected — this only applies to recall's inline expansion.
  if (part.type === "tool" && part.toolName && isSelfTool(part.toolName)) {
    return {
      ...part,
      content: SELF_TOOL_REDACTED,
      output: undefined,
      error: undefined,
      input: undefined,
    };
  }
  // Per-part sub-budget: one part may consume at most MAX_EXPANDED_PART_CHARS
  // of the global budget across all of its fields.
  const initialAllowance = Math.min(MAX_EXPANDED_PART_CHARS, budget.remaining);
  const partBudget: ExpansionBudget = { remaining: initialAllowance, truncated: false };
  const out: PartOutput = {
    ...part,
    input: truncateExpandedInput(part.input, partBudget),
    content: truncateExpandedText(part.content, partBudget, findMatch),
    output: truncateExpandedText(part.output, partBudget, findMatch),
    error: truncateExpandedText(part.error, partBudget, findMatch),
  };
  budget.remaining -= initialAllowance - partBudget.remaining;
  if (partBudget.truncated) {
    budget.truncated = true;
    // The part cap was binding only when a field was cut by the sub-budget
    // itself (limitedByBudget) AND the sub-budget was the 6k part cap rather
    // than the global remainder. A lone field cut by the 4k field cap is not
    // a part-cap event.
    if (partBudget.limitedByBudget && initialAllowance === MAX_EXPANDED_PART_CHARS) {
      budget.partCapped = true;
    }
  }
  return out;
}

function formatExpandedMsg(
  msg: MsgWithParts,
  budget: ExpansionBudget,
  matchedPartID?: string,
  findMatch?: MatchFinder,
): MessageItem {
  const item = formatMsg(msg);
  return {
    ...item,
    parts: item.parts.map((part) =>
      truncateExpandedPart(
        part,
        budget,
        part.id === matchedPartID && findMatch ? findMatch : undefined,
      ),
    ),
  };
}

// ── Candidate scans (cached corpus) ──────────────────────────────────
// Literal and regex matching run over cached candidates' fieldTexts, which
// searchableFields() built at cache-fill time, so matching semantics are
// identical to the old per-message scans. Query filters were applied during
// assembly; the session's bound title candidate rides at the end of the pool
// so content hits precede the title hit, as before. One deliberate ordering
// change: candidates are cached newest-message-first, so within a session,
// literal/regex hits (and the hits kept under a scan limit) are now the most
// recent ones — the old scans iterated chronologically and kept the oldest.

/** Build a SearchResult from a cached candidate hit (literal/regex paths). */
function candidateResult(
  candidate: Candidate,
  relevance: DirectoryRelevance,
  matchedField: ResultWhy["matchedFields"][number],
  snip: string,
): SearchResult {
  return annotateResult({
    sessionID: candidate.sessionID,
    sessionTitle: candidate.sessionTitle,
    directory: candidate.directory,
    messageID: candidate.messageID,
    role: candidate.role,
    time: candidate.time,
    partID: candidate.partID,
    partType: candidate.partType,
    pruned: candidate.isPruned,
    snippet: snip,
    toolName: candidate.toolName,
    source: candidate.source ?? sourceForPartType(candidate.partType),
    titleMatch: candidate.titleMatch,
    why: {
      matchedFields: [matchedField],
      directoryRelevance: relevance,
      recency: recencyLabel(candidate.time),
      confidence: candidate.partType === "title" ? "medium" : "high",
      evidenceClass: evidenceClassFor(candidate.partType, candidate.toolName, [matchedField]),
    },
  });
}

function scan(
  candidates: Candidate[],
  relevance: DirectoryRelevance,
  query: string,
  limit: number,
  width?: number,
): { results: SearchResult[]; total: number } {
  const results: SearchResult[] = [];
  let total = 0;

  for (const candidate of candidates) {
    if (results.length >= limit) break;
    let matched = false;
    for (const field of candidate.fieldTexts) {
      if (!matches(field.text, query)) continue;
      if (matched) continue;
      matched = true;
      // Count per matched PART (one result unit), not per matched field:
      // total must be comparable with results.length and with smart mode's
      // part-granular total, or truncated can misreport.
      total++;
      if (results.length < limit) {
        results.push(
          candidateResult(candidate, relevance, field.field, snippet(field.text, query, width)),
        );
      }
    }
  }
  return { results, total };
}

/** Regex scan over cached candidate fields. Mirrors scan() but uses a RegExp. */
function regexScanCandidates(
  candidates: Candidate[],
  relevance: DirectoryRelevance,
  re: RegExp,
  limit: number,
  width?: number,
): { results: SearchResult[]; total: number } {
  const results: SearchResult[] = [];
  let total = 0;

  for (const candidate of candidates) {
    if (results.length >= limit) break;
    let matched = false;
    for (const field of candidate.fieldTexts) {
      const matchIndex = regexFirstIndex(re, field.text);
      if (matchIndex === -1) continue;
      if (matched) continue;
      matched = true;
      // Per matched part, matching scan(); see the note there.
      total++;
      if (results.length < limit) {
        results.push(
          candidateResult(
            candidate,
            relevance,
            field.field,
            regexSnippet(re, field.text, width, matchIndex),
          ),
        );
      }
    }
  }
  return { results, total };
}

// ── Convert ranked results to SearchResult[] ─────────────────────────

function rankedToSearchResults(
  ranked: Bm25Hit[],
  mode: MatchMode,
  explain: boolean,
  query: ReturnType<typeof parseQuery>,
  width: number | undefined,
  relevanceBySession: Map<string, DirectoryRelevance>,
): SearchResult[] {
  return ranked.map((r) => {
    const c = r.candidate;
    // Directory relevance is per-query (it depends on the caller's directory
    // filter), so it comes from the query's session map, never from the
    // cached candidate.
    const relevance = relevanceBySession.get(c.sessionID) ?? "unknown";

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
      // Ranking scores are unclamped so boosts can beat the relative top;
      // the public shape stays 0..1.
      score: clamp01(r.score),
      matchMode: mode,
      matchedTerms: r.matchedTerms,
      source: c.source,
      why: {
        ...c.why,
        directoryRelevance: relevance,
        evidenceClass: r.evidenceClass,
        matchedFields:
          r.matchedFields.length > 0
            ? r.matchedFields
            : (c.why?.matchedFields ?? defaultMatchedFields(c.partType)),
      },
      titleMatch: c.titleMatch,
    });

    if (explain && r.matchReasons.length > 0) {
      result.matchReasons = r.matchReasons;
    }

    return result;
  });
}

// ── Group results by session ─────────────────────────────────────────

/** How many of a session's strongest hits to track for representative
 *  selection and secondary evidence. Results arrive pre-ranked (smart) or in
 *  newest-first scan order (literal/regex), so the first N content hits are
 *  the session's best. */
const MAX_GROUP_TRACKED = 4;
/** A tracked hit qualifies as representative when its score is within this
 *  fraction of the session's best score. Loosened from 0.85 after round-2
 *  dogfooding: the utility ordering rarely got to act while topEvidence
 *  held the right material. */
const REPRESENTATIVE_TOLERANCE = 0.7;
const TOP_EVIDENCE_SNIPPET_CHARS = 120;
const MAX_TOP_EVIDENCE = 2;

/** Utility order for similarly-scored hits: conversational statements and
 *  concrete actions make better session representatives than generated
 *  reference material. */
const CLASS_PRIORITY: EvidenceClass[] = [
  "human-text",
  "tool-input",
  "tool-output",
  "reasoning",
  "file-read",
  "web-fetch",
  "skill-definition",
  "session-title",
];

function classPriority(cls: EvidenceClass | undefined): number {
  if (!cls) return CLASS_PRIORITY.length;
  const index = CLASS_PRIORITY.indexOf(cls);
  return index === -1 ? CLASS_PRIORITY.length : index;
}

/** Among the tracked content hits, pick the representative: hits within score
 *  tolerance of the best (all of them when scores are absent, i.e. literal or
 *  regex mode) compete by evidence-class priority; ties fall back to the old
 *  rules (score, then recency). */
function pickRepresentative(tracked: SearchResult[]): SearchResult | undefined {
  if (tracked.length === 0) return undefined;
  const scores = tracked.map((hit) => hit.score);
  const best = scores.every((score) => score != null)
    ? Math.max(...(scores as number[]))
    : undefined;
  const qualifying =
    best == null
      ? tracked
      : tracked.filter((hit) => (hit.score ?? 0) >= best * REPRESENTATIVE_TOLERANCE);

  let winner = qualifying[0]!;
  for (const hit of qualifying.slice(1)) {
    const winnerPriority = classPriority(winner.why?.evidenceClass);
    const hitPriority = classPriority(hit.why?.evidenceClass);
    if (hitPriority < winnerPriority) {
      winner = hit;
      continue;
    }
    if (hitPriority > winnerPriority) continue;
    if (hit.score != null && winner.score != null) {
      if (hit.score > winner.score) winner = hit;
    } else if (hit.time > winner.time) {
      winner = hit;
    }
  }
  return winner;
}

/** Exported for direct unit tests of representative selection. */
export function groupBySession(results: SearchResult[]): SearchResult[] {
  type Group = {
    tracked: SearchResult[];
    titleHit?: SearchResult;
    count: number;
    kinds: Set<EvidenceClass>;
    titleMatch?: SearchResult["titleMatch"];
  };
  const groups = new Map<string, Group>();

  for (const r of results) {
    let group = groups.get(r.sessionID);
    if (!group) {
      group = { tracked: [], count: 0, kinds: new Set() };
      groups.set(r.sessionID, group);
    }
    group.count++;
    group.titleMatch ??= r.titleMatch;
    const cls = r.why?.evidenceClass;
    if (cls) group.kinds.add(cls);
    // Title hits never beat content as representative (preserved rule); they
    // stand in only for title-only sessions.
    if (r.source === "title") {
      group.titleHit ??= r;
    } else if (group.tracked.length < MAX_GROUP_TRACKED) {
      group.tracked.push(r);
    }
  }

  return [...groups.values()].map((group) => {
    const representative = pickRepresentative(group.tracked) ?? group.titleHit!;
    const representativeClass = representative.why?.evidenceClass;
    const topEvidence = group.tracked
      .filter(
        (hit) =>
          hit !== representative &&
          hit.why?.evidenceClass != null &&
          hit.why.evidenceClass !== representativeClass,
      )
      .slice(0, MAX_TOP_EVIDENCE)
      .map((hit) => ({
        messageID: hit.messageID,
        partID: hit.partID,
        evidenceClass: hit.why!.evidenceClass!,
        snippet:
          hit.snippet.length > TOP_EVIDENCE_SNIPPET_CHARS
            ? `${hit.snippet.slice(0, TOP_EVIDENCE_SNIPPET_CHARS)}…`
            : hit.snippet,
      }));

    return {
      ...representative,
      hitCount: group.count,
      titleMatch: representative.titleMatch ?? group.titleMatch,
      ...(group.kinds.size > 0 && { evidenceKinds: [...group.kinds] }),
      ...(topEvidence.length > 0 && { topEvidence }),
    };
  });
}

/** Per-class caps for the final part-mode slice: generated reference material
 *  must not crowd out other evidence. Plain tool output is uncapped. */
const CLASS_CAPS: Partial<Record<EvidenceClass, number>> = {
  "skill-definition": 1,
  "file-read": 2,
  "web-fetch": 2,
};

/** Queries that describe actions: exact code anchors or command verbs. */
const COMMAND_VERB_RE = /\b(run|launch|type|press|test|reproduce|install|start)\b/i;

/**
 * Final part-mode pass: apply per-class caps within the slice, backfill from
 * held-back hits when the caps starve the fill, and for command-like queries
 * guarantee one tool-input hit when any exists. Runs AFTER
 * orderForDirectoryFallback — that re-sort is class-blind, so a cap applied
 * inside diversify() would be silently defeated whenever directory fallback
 * reorders the list.
 */
export function capAndSlice(
  ordered: SearchResult[],
  limit: number,
  commandLike: boolean,
): SearchResult[] {
  const classCounts = new Map<string, number>();
  const final: SearchResult[] = [];
  const heldBack: SearchResult[] = [];

  for (const hit of ordered) {
    if (final.length >= limit) {
      heldBack.push(hit);
      continue;
    }
    const cls = hit.why?.evidenceClass;
    const cap = cls != null ? CLASS_CAPS[cls] : undefined;
    if (cls != null && cap != null) {
      const used = classCounts.get(cls) ?? 0;
      if (used >= cap) {
        heldBack.push(hit);
        continue;
      }
      classCounts.set(cls, used + 1);
    }
    final.push(hit);
  }

  // Backfill in original order when the caps starved the fill (mirrors the
  // per-session diversity semantics: caps yield rather than return less).
  for (const hit of heldBack) {
    if (final.length >= limit) break;
    final.push(hit);
  }

  if (
    commandLike &&
    final.length > 0 &&
    !final.some((hit) => hit.why?.evidenceClass === "tool-input")
  ) {
    const promoted = heldBack.find(
      (hit) => hit.why?.evidenceClass === "tool-input" && !final.includes(hit),
    );
    if (promoted) final[final.length - 1] = promoted;
  }

  return final;
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

/** Safety cap on messages fetched while locating one hit's context window. */
const MAX_EXPAND_CONTEXT_FETCH = 200;

async function expandSearchResults(
  results: SearchResult[],
  client: OpencodeClient,
  gate: FetchGate,
  limits: Limits,
  mode: ExpandMode,
  expandResults: number,
  window: number,
  expandBudgetMessages: number,
  expandBudgetChars: number,
  findMatch?: MatchFinder,
): Promise<{ expanded?: ExpandedResult[]; warnings: string[] }> {
  if (mode === "none") return { warnings: [] };

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

  // Bounded, per-hit fetches only — never an unpaginated whole-session load.
  // `message` mode is a single `session.message` point fetch; `context` mode is
  // a bounded newest-first window around the hit. Everything routes through the
  // shared gate so it counts against the same concurrency budget as the drill.
  const runner: FetchRunner = (fn) => gate.runQuery(fn);
  const pageMessages = Math.min(
    limits.maxMessages,
    Math.max(2 * window + 1, Math.min(25, limits.maxMessages)),
  );

  for (const { result, resultIndex } of expandable) {
    if (mode === "message") {
      try {
        const resp = await gate.runQuery(() =>
          client.session.message({
            sessionID: result.sessionID,
            messageID: result.messageID,
          }),
        );
        if (resp.error || !resp.data) {
          warnings.push(
            `Expansion could not load session ${result.sessionID}: ${
              resp.error ? errmsg(resp.error) : "no message returned"
            }.`,
          );
          continue;
        }
        const bundle = resp.data as MsgWithParts;
        expanded.push({
          resultIndex,
          sessionID: result.sessionID,
          messageID: result.messageID,
          mode,
          message: formatExpandedMsg(bundle, budget, result.partID, findMatch),
        });
      } catch (error) {
        warnings.push(`Expansion could not load session ${result.sessionID}: ${errmsg(error)}.`);
      }
      continue;
    }

    if (remainingContextMessages <= 0) {
      contextCapped = true;
      break;
    }

    const win = await fetchMessageWindow(
      client,
      {
        sessionID: result.sessionID,
        messageID: result.messageID,
        before: window,
        after: window,
        pageMessages,
        maxMessages: MAX_EXPAND_CONTEXT_FETCH,
      },
      runner,
    );
    if (win.loadError) {
      warnings.push(`Expansion could not load session ${result.sessionID}: ${win.loadError}.`);
      continue;
    }
    if (win.centerIndex === -1) continue;

    // Apply the per-call context-message budget, trimming symmetrically around
    // the center (mirrors the previous allowedCount logic).
    let msgs = win.messages;
    let hasMoreBefore = win.hasMoreBefore;
    let hasMoreAfter = win.hasMoreAfter;
    if (msgs.length > remainingContextMessages) {
      contextCapped = true;
      const allowed = remainingContextMessages;
      const half = Math.floor((allowed - 1) / 2);
      let start = Math.max(0, win.centerIndex - half);
      const end = Math.min(msgs.length, start + allowed);
      start = Math.max(0, end - allowed);
      if (start > 0) hasMoreBefore = true;
      if (end < msgs.length) hasMoreAfter = true;
      msgs = msgs.slice(start, end);
    }
    remainingContextMessages -= msgs.length;
    const items: MessageItem[] = msgs.map((msg) => {
      const item = formatExpandedMsg(
        msg,
        budget,
        msg.info.id === result.messageID ? result.partID : undefined,
        findMatch,
      );
      return { ...item, center: msg.info.id === result.messageID };
    });

    expanded.push({
      resultIndex,
      sessionID: result.sessionID,
      messageID: result.messageID,
      mode,
      messages: items,
      hasMoreBefore,
      hasMoreAfter,
    });
  }

  if (contextCapped) {
    warnings.push(
      `Context expansion capped at ${expandBudgetMessages} messages; expanded ${expanded.length} of ${count} requested results. Reduce window or expandResults to include more hits.`,
    );
  }
  if (budget.partCapped) {
    warnings.push(
      `One or more parts exceeded the per-part expansion cap (${MAX_EXPANDED_PART_CHARS} chars); bodies were sampled around the match.`,
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
    const rankDiff =
      directoryRank(a.why?.directoryRelevance) - directoryRank(b.why?.directoryRelevance);
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
    const relevance = result.why?.directoryRelevance;
    if (relevance === "exact" || relevance === "project" || relevance === "global") {
      counts[relevance] = (counts[relevance] ?? 0) + 1;
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
  currentSessionID?: string;
  /** The current session was actually removed from this search's targets. */
  currentSessionExcluded: boolean;
  /** Caller explicitly passed excludeCurrentSession:false. */
  excludeExplicitOff: boolean;
  codeTokens: string[];
  /** Session IDs the metadata shortlist selected (smart/fuzzy only). */
  shortlistIDs: string[];
}): SearchSuggestion[] | undefined {
  // Suggestions are ranked before the MAX_SUGGESTIONS slice so plan-mandated
  // guidance (exact code tokens, shortlisted-but-unranked sessions) cannot be
  // displaced by softer composition hints. Lower priority sorts first; equal
  // priorities keep insertion order (stable sort).
  const entries: Array<{ priority: number; suggestion: SearchSuggestion }> = [];
  const add = (priority: number, suggestion: SearchSuggestion): void => {
    entries.push({ priority, suggestion });
  };
  const onlyTitleHits =
    input.results.length > 0 && input.results.every((result) => result.source === "title");
  const typeFilter = input.type && input.type !== "all" ? input.type : undefined;

  // Routing hint: never override the caller, only suggest a better-fitting mode.
  const routed = classifyQuery(input.query, input.matchMode);
  if (routed.suggested === "regex") {
    add(0, {
      reason: `${routed.reason} It may be intended as a pattern.`,
      action: 'Use match:"regex" to match it as a regular expression.',
      example: { match: "regex" },
    });
  }

  if (onlyTitleHits) {
    add(0, {
      reason: "Only session-title hits matched; no message content matched the query.",
      action:
        'Inspect the returned sessions, try group:"session", or use match:"smart" with broader terms.',
      example: { group: "session" },
    });
  }

  if (input.results.length === 0 && input.directory && !input.fallback) {
    add(0, {
      reason: "The directory filter may be excluding useful history.",
      action: "Retry with fallback:true to broaden from this directory to project/global history.",
      example: { directory: input.directory, fallback: true },
    });
  }

  // Ahead of the generic zero-result hints so the cap cannot drop it: when
  // the exclusion removed the caller's session, that is the likeliest
  // explanation for an empty result.
  if (input.results.length === 0 && input.currentSessionExcluded) {
    add(0, {
      reason: "This search excluded the current session.",
      action: "Pass excludeCurrentSession:false if you meant to search this conversation.",
      example: { excludeCurrentSession: false },
    });
  }

  if (input.results.length === 0 && input.matchMode === "literal") {
    add(0, {
      reason: "Literal search found no hits.",
      action: 'Try match:"smart" or match:"fuzzy" for typos and naming variants.',
      example: { match: "smart" },
    });
  }

  if (input.results.length === 0 && typeFilter) {
    add(0, {
      reason: `The type:${JSON.stringify(typeFilter)} filter may be hiding other evidence.`,
      action: 'Retry with type:"all" to include text, reasoning, and tool output.',
      example: { type: "all" },
    });
  }

  if (input.results.length === 0 && input.coverage.sessionsSearched <= 4) {
    const count = input.coverage.sessionsSearched;
    const noun = count === 1 ? "session" : "sessions";
    const verb = count === 1 ? "was" : "were";
    add(0, {
      reason: `Only ${count} ${noun} ${verb} searched.`,
      action: "Remove narrowing filters or increase the sessions limit.",
    });
  }

  // Plan-mandated hints (priority 1): must survive the cap when triggered.
  if (input.codeTokens.length > 0 && (input.matchMode === "smart" || input.matchMode === "fuzzy")) {
    add(1, {
      reason: "The query contains exact code-like tokens.",
      action: 'match:"literal" pins them exactly.',
      example: { match: "literal", query: input.codeTokens[0] },
    });
  }

  if (input.shortlistIDs.length > 0 && input.results.length > 0) {
    const returned = new Set(input.results.map((result) => result.sessionID));
    if (!input.shortlistIDs.some((id) => returned.has(id))) {
      const titleTerm =
        input.codeTokens[0] ??
        input.query
          .toLowerCase()
          .split(/\s+/)
          .find((token) => token.length >= 4);
      add(1, {
        reason: "Sessions whose title/directory match the query exist but none ranked.",
        action: "Narrow to them with a title filter or browse via recall_sessions.",
        ...(titleTerm && { example: { title: titleTerm } }),
      });
    }
  }

  // Composition-aware guidance over non-empty results (priority 2).
  if (input.excludeExplicitOff && input.currentSessionID && input.results.length > 0) {
    const top = input.results.slice(0, Math.min(5, input.results.length));
    const fromCurrent = top.filter((result) => result.sessionID === input.currentSessionID).length;
    if (fromCurrent * 2 >= top.length) {
      add(2, {
        reason: "Most top hits are from this conversation, not prior history.",
        action: "Drop excludeCurrentSession:false so prior sessions rank instead.",
      });
    }
  }

  const topFive = input.results.slice(0, 5);
  const generatedCount = topFive.filter(
    (result) =>
      result.why?.evidenceClass === "skill-definition" || result.why?.evidenceClass === "file-read",
  ).length;
  if (generatedCount >= 3) {
    add(2, {
      reason: "Most top hits are generated reference material (skill payloads, file reads).",
      action: 'Re-run oriented to actions: type:"tool" surfaces commands and their output.',
      example: { type: "tool" },
    });
  }

  const topResult = input.results[0];
  if (topResult?.hitCount != null && topResult.hitCount >= 10) {
    add(3, {
      reason: `Session ${topResult.sessionID} holds ${topResult.hitCount} matching parts.`,
      action: 'Inspect it directly with group:"part" and sessionID.',
      example: { group: "part", sessionID: topResult.sessionID },
    });
  }

  if (entries.length === 0) return undefined;
  entries.sort((a, b) => a.priority - b.priority);
  return entries.slice(0, MAX_SUGGESTIONS).map((entry) => entry.suggestion);
}

function buildNearMisses(
  results: SearchResult[],
  searched: Array<{ id: string; title: string; directory: string }>,
): NearMiss[] | undefined {
  if (results.length > 0) return undefined;
  const misses = searched
    .filter((session) => session.title || session.directory)
    .slice(0, MAX_NEAR_MISSES)
    .map((session) => ({
      sessionID: session.id,
      title: session.title || undefined,
      directory: session.directory || undefined,
      reason: "Session was searched but no searchable part matched the query.",
    }));
  return misses.length > 0 ? misses : undefined;
}

function attachCommonOutput<T extends SearchOutput>(
  out: T,
  input: {
    final: SearchResult[];
    searchedSessions: Array<{ id: string; title: string; directory: string }>;
    coverage: SearchCoverage;
    warnings: string[];
    directory?: string;
    fallback: boolean;
    matchMode: MatchMode;
    type: string | undefined;
    query: string;
    currentSessionID?: string;
    currentSessionExcluded: boolean;
    excludeExplicitOff: boolean;
    codeTokens: string[];
    shortlistIDs: string[];
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
    currentSessionID: input.currentSessionID,
    currentSessionExcluded: input.currentSessionExcluded,
    excludeExplicitOff: input.excludeExplicitOff,
    codeTokens: input.codeTokens,
    shortlistIDs: input.shortlistIDs,
  });
  if (suggestions) out.suggestions = suggestions;
  const nearMisses = buildNearMisses(input.final, input.searchedSessions);
  if (nearMisses) out.nearMisses = nearMisses;
  return out;
}

/**
 * Merge the tier-1 card shortlist with the tier-1.5 FTS-only needle sessions,
 * capped at `cap`. FTS-only sessions (a session whose card missed the query's
 * anchor but whose slim-index rows carry it) are guaranteed a reserved band of
 * slots ahead of the weakest cards, so a rare needle is never crowded out by
 * lexically-strong-but-wrong cards. Order-preserving and deduped.
 */
function mergeShortlist(cardIds: string[], ftsOnly: string[], cap: number): string[] {
  if (ftsOnly.length === 0) return cardIds.slice(0, cap);
  // Reserve needle slots only when the cap still leaves room for at least one
  // strong card, so cap==1 always goes to the top-ranked card, not a needle.
  const reserve = Math.min(
    ftsOnly.length,
    Math.max(1, Math.floor(cap / 3)),
    cardIds.length > 0 ? cap - 1 : cap,
  );
  const strong = cardIds.slice(0, Math.max(0, cap - reserve));
  const merged: string[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }
  };
  for (const id of strong) push(id);
  for (const id of ftsOnly.slice(0, reserve)) push(id);
  for (const id of cardIds.slice(strong.length)) {
    if (merged.length >= cap) break;
    push(id);
  }
  for (const id of ftsOnly.slice(reserve)) {
    if (merged.length >= cap) break;
    push(id);
  }
  return merged.slice(0, cap);
}

// ── Main export ──────────────────────────────────────────────────────

export function search(
  client: OpencodeClient,
  unscoped: OpencodeClient,
  global: boolean,
  limits: Limits,
  deps: SearchDeps,
): ToolDefinition {
  const { cards, drill, store, gate } = deps;
  return tool({
    description: `Search prior opencode conversations by message/tool-output content. Primary history-discovery tool; prefer over recall_sessions for topical discovery (titles only).

Call when history could change the approach: debugging errors, investigating behavior, non-trivial feature work in areas with likely prior history, changing architecture/config, answering "last time/before", recovering commands/root causes/decisions, or checking if an approach worked or failed. Also call before substantive work in an unfamiliar area of this project.

Skip trivial commands, simple local code/file lookup, simple edits with full context, ordinary code tasks where prior history would not change the approach, or anything not helped by past conversations.

For "how did we do X before": match:"smart", group:"session" (current session is already excluded by default); if results are weak, search the project directory literally for the tool/command name and inspect tool-input hits with expand:"context" or recall_context.

First call: for broad discovery use match:"smart", group:"session", scope:"global" (default), 5-10 results, and short terms from error text/feature/config/file/decision. The current session and its subagent sessions are excluded by default; pass excludeCurrentSession:false to search them (or use scope:"session"). Use role:"user" for requirements/decisions. Use expand:"context" or "message" when top-hit evidence will avoid a follow-up.

If memory exists, store only durable findings: preferences, project decisions, reusable root causes, environment facts, behavior corrections, or repeatable success/failure. Do not store ephemeral details, one-off commands, transient errors, or implementation minutiae.

Modes: literal exact substring; smart ranked BM25; fuzzy looser; regex pattern (invalid pattern errors). Smart/fuzzy include score/matchedTerms and fall back to literal. Results are snippets; use recall_get/context for full content. coverage reports what was searched; coverage.loadErrors reports partial session-load failures.`,
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
      excludeCurrentSession: tool.schema
        .boolean()
        .optional()
        .describe("Default true for project/global scopes; false includes this session"),
      excludeSessionID: tool.schema.string().optional().describe("Exclude one session by ID"),
      type: tool.schema
        .enum(["text", "tool", "reasoning", "all"])
        .default("all")
        .describe("Part type filter"),
      role: tool.schema.enum(["user", "assistant", "all"]).default("all").describe("Role filter"),
      sessionLimit: tool.schema
        .number()
        .min(1)
        .max(limits.maxSessions)
        .optional()
        .describe("Max sessions to drill (caps drill fan-out)"),
      sessions: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe(
          "Explicit session-id shortlist. Without deep: drill exactly these (skips card ranking for selection; results are still ranked). With deep: the sweep scope.",
        ),
      deep: tool.schema
        .boolean()
        .default(false)
        .describe(
          "Exhaustively sweep tool OUTPUTS across the scoped session set — the only path that searches the tool-output tier. Requires scope: pass sessions, or set a lower time bound (since/last/from) together with project/directory. A global unscoped deep is rejected.",
        ),
      deepCursor: tool.schema
        .string()
        .optional()
        .describe(
          "Opaque continuation from a prior deep response's nextCursor; resumes the sweep.",
        ),
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
      project: tool.schema
        .union([tool.schema.boolean(), tool.schema.string()])
        .optional()
        .describe("true=current project only; a path filters to that project dir"),
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
      const excludeSessionID = optionalString(args.excludeSessionID);
      // Scope-aware default: exclude the caller's own session for broad
      // history discovery, but never when the caller targeted a specific
      // session. The schema deliberately has no Zod default so an explicit
      // `true` stays distinguishable from the implicit default (a Zod-
      // materialized `true` would hard-error every scope:"session" call).
      const excludeExplicit =
        typeof args.excludeCurrentSession === "boolean" ? args.excludeCurrentSession : undefined;
      const currentSessionID = optionalString(ctx.sessionID);
      const excludeCurrent = excludeExplicit ?? (scope !== "session" && !sessionID);
      const requestedSessions =
        args.sessionLimit == null
          ? undefined
          : pickNumber(
              "sessionLimit",
              args.sessionLimit,
              1,
              limits.maxSessions,
              limits.maxSessions,
            );
      // Deep-mode args (defensively coerced against the Zod-bypass host path).
      const deepRequested = typeof args.deep === "boolean" ? args.deep : false;
      const explicitSessions = Array.isArray(args.sessions)
        ? [
            ...new Set(
              args.sessions
                .map((id) => optionalString(id))
                .filter((id): id is string => id !== undefined),
            ),
          ]
        : [];
      const deepCursorRaw = optionalString(args.deepCursor);

      const fail = (error: string): string =>
        JSON.stringify({ ok: false, error } satisfies ErrorOutput);

      if (toolName && partType !== "all" && partType !== "tool") {
        return fail('toolName can only be used with type:"all" or type:"tool"');
      }

      // Contradictory exclusion filters are caller errors, but only when the
      // exclusion was explicit — the implicit default never conflicts because
      // it does not apply to session scope or explicit sessionID targets.
      if (excludeExplicit === true && scope === "session") {
        return fail(
          'excludeCurrentSession cannot be combined with scope:"session"; the search would exclude its only target',
        );
      }
      if (sessionID && excludeSessionID && sessionID === excludeSessionID) {
        return fail("sessionID and excludeSessionID refer to the same session");
      }
      if (excludeExplicit === true && sessionID && currentSessionID === sessionID) {
        return fail(
          "sessionID targets the current session but excludeCurrentSession is true; drop one of them",
        );
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
        const queryMeta = parseQuery(args.query);
        const commandLikeQuery =
          queryMeta.codeTokens.length > 0 || COMMAND_VERB_RE.test(args.query);
        const smartMode: "smart" | "fuzzy" = matchMode === "fuzzy" ? "fuzzy" : "smart";
        const searchTitles = canSearchTitles(partType, toolName);
        const filters: CandidateFilters = { type: partType, role, before, after, toolName };
        const groupMode: GroupMode = groupArg;
        const isGrouped = groupMode === "session";

        const callerDirectory = optionalString(ctx.directory);
        const callerWorktree = optionalString(ctx.worktree) ?? callerDirectory;
        const projectString =
          typeof args.project === "string" ? optionalString(args.project) : undefined;
        const projectScope = scope === "project" || args.project === true;
        const directoryFilter = directory ?? projectString;
        const bucketDirectory = directoryFilter ?? (projectScope ? callerDirectory : undefined);

        // ── Deep-mode scope gate + cursor decode ──
        // Deep is the only path that sweeps tool OUTPUTS across sessions, so it
        // demands explicit scope by construction: a `sessions` shortlist, a valid
        // continuation cursor (already scoped when it was minted), or a lower time
        // bound plus a project/directory constraint. A global unscoped deep is
        // rejected with guidance rather than attempted.
        const deepCursor = deepCursorRaw ? decodeDeepCursor(deepCursorRaw) : null;
        const deepMode = deepRequested || deepCursorRaw != null;
        if (deepMode) {
          if (deepCursorRaw != null && !deepCursor) {
            return fail(
              "deepCursor is malformed; drop it to start a new deep sweep. Pass only a nextCursor returned by a prior deep response.",
            );
          }
          const projectConstraint =
            directoryFilter != null || (projectScope && bucketDirectory != null);
          // An explicit sessionID (or scope:"session" with a current session) is
          // itself a concrete scope — deep treats it as sessions:[that id].
          const hasSingleTarget =
            sessionID != null || (scope === "session" && currentSessionID != null);
          const deepScoped =
            deepCursor != null ||
            explicitSessions.length > 0 ||
            hasSingleTarget ||
            (after != null && projectConstraint);
          if (!deepScoped) {
            return fail(
              "deep requires scope: pass sessions:[...], or set a lower time bound (since/last/from) together with project:true or a directory. A global unscoped deep sweep is not allowed.",
            );
          }
        }

        const skippedByReason: Record<string, number> = {};

        const cardMeta = (card: Card): SessionMetaInternal => ({
          id: card.sessionId,
          title: card.title,
          directory: card.directory,
          updated: card.timeUpdated,
          parentID: card.parentId ?? undefined,
          projectID: card.projectId || undefined,
        });
        const relevanceOf = (card: Card): DirectoryRelevance =>
          bucketDirectory
            ? classifyDirectoryRelevance(cardMeta(card), bucketDirectory, callerWorktree)
            : "unknown";

        const relevanceBySession = new Map<string, DirectoryRelevance>();
        const searchedMeta = new Map<string, { id: string; title: string; directory: string }>();
        let drillTargets: DrillTarget[] = [];
        let deepSet = new Set<string>();
        let ftsBySession: Map<string, FtsHit[]> | undefined;
        let sessionsEligible = 0;
        let shortlistIDs: string[] = [];
        let directoryBucketsSearched: SearchCoverage["directoryBucketsSearched"];

        /** Register a card as a drill target (relevance + coverage metadata). */
        const registerTarget = (card: Card, relevance: DirectoryRelevance): DrillTarget => {
          relevanceBySession.set(card.sessionId, relevance);
          searchedMeta.set(card.sessionId, {
            id: card.sessionId,
            title: card.title,
            directory: card.directory,
          });
          return {
            sessionId: card.sessionId,
            title: card.title,
            directory: card.directory,
            timeUpdated: card.timeUpdated,
          };
        };

        const singleTarget = sessionID ?? (scope === "session" ? currentSessionID : undefined);
        if (scope === "session" && !singleTarget) {
          const err: ErrorOutput = {
            ok: false,
            error: "No sessionID provided and no current session available",
          };
          return JSON.stringify(err);
        }

        if (!deepMode && singleTarget) {
          let sTitle = "";
          let sDir = "";
          let sUpdated = 0;
          try {
            const sess = await gate.runQuery(() => client.session.get({ sessionID: singleTarget }));
            if (sess.data) {
              const data = sess.data as Session | GlobalSession;
              sTitle = data.title;
              sDir = data.directory;
              sUpdated = data.time.updated;
            }
          } catch {
            // Proceed without metadata; drill still fetches the session's parts.
          }
          drillTargets = [
            { sessionId: singleTarget, title: sTitle, directory: sDir, timeUpdated: sUpdated },
          ];
          deepSet = new Set([singleTarget]);
          relevanceBySession.set(singleTarget, "unknown");
          searchedMeta.set(singleTarget, { id: singleTarget, title: sTitle, directory: sDir });
          sessionsEligible = 1;
          if (sessionID) pushUnique(normalized.limitedBy, "sessionID");
          else pushUnique(normalized.limitedBy, "scope");
        } else if (deepMode) {
          // ── Deep sweep: resolve the scoped session set (filters applied),
          //    newest-first. Deep never ranks by query — it sweeps the whole
          //    scope exhaustively. ──
          const timeFilters: CardFilters = {};
          if (after != null) timeFilters.since = after;
          if (before != null) timeFilters.until = before;
          const explicitSet = new Set(explicitSessions);

          /** Build a target for an id — from its card when known, else a minimal
           *  target so a session with no card is still swept. */
          const targetFor = (id: string): DrillTarget => {
            const card = cards.get(id);
            if (card) return registerTarget(card, relevanceOf(card));
            relevanceBySession.set(id, "unknown");
            searchedMeta.set(id, { id, title: "", directory: "" });
            return { sessionId: id, title: "", directory: "", timeUpdated: 0 };
          };

          if (deepCursor) {
            // Resume from an UNTRUSTED cursor: keep only ids the card store knows
            // (or that an accompanying `sessions` arg explicitly allows), cap the
            // total, and report anything dropped. Resume stays stateless — the
            // cursor is the only carry-over, so a proportionate validation here is
            // the whole defense.
            const order = deepCursor.current
              ? [deepCursor.current, ...deepCursor.remaining]
              : [...deepCursor.remaining];
            const kept: string[] = [];
            const dropped: string[] = [];
            for (const id of order) {
              if (id === excludeSessionID) continue;
              if (kept.length >= MAX_RESUME_TARGETS) {
                dropped.push(id);
                continue;
              }
              if (cards.get(id) || explicitSet.has(id)) kept.push(id);
              else dropped.push(id);
            }
            drillTargets = kept.map(targetFor);
            if (dropped.length > 0) {
              const sample = dropped.slice(0, 3).join(", ");
              normalized.warnings.push(
                `Deep resume dropped ${dropped.length} session id${dropped.length === 1 ? "" : "s"} not in the card store${dropped.length > MAX_RESUME_TARGETS ? " (over the resume cap)" : ""}: ${sample}${dropped.length > 3 ? ", …" : ""}.`,
              );
            }
          } else if (explicitSessions.length > 0) {
            const scoped = cards
              .list(timeFilters)
              .filter((card) => explicitSet.has(card.sessionId));
            drillTargets = scoped
              .filter((card) => card.sessionId !== excludeSessionID)
              .map((card) => registerTarget(card, relevanceOf(card)));
          } else if (singleTarget) {
            // Explicit sessionID / scope:"session" → sweep exactly that session.
            if (singleTarget !== excludeSessionID) drillTargets = [targetFor(singleTarget)];
          } else {
            // since + project/directory constraint (validated by the scope gate).
            if (excludeCurrent && currentSessionID) timeFilters.excludeFamilyOf = currentSessionID;
            const scoped = cards.list(timeFilters).filter((card) => {
              const rel = relevanceOf(card);
              return directoryFilter ? rel === "exact" : rel === "exact" || rel === "project";
            });
            drillTargets = scoped
              .filter((card) => card.sessionId !== excludeSessionID)
              .map((card) => registerTarget(card, relevanceOf(card)));
          }
          deepSet = new Set(drillTargets.map((t) => t.sessionId));
          sessionsEligible = drillTargets.length;
          pushUnique(normalized.limitedBy, sessionID ? "sessionID" : "scope");
        } else if (explicitSessions.length > 0) {
          // ── Explicit shortlist (non-deep): drill exactly these sessions,
          //    skipping card ranking for SELECTION; results are still ranked by
          //    the normal drill/scoring path. ──
          const timeFilters: CardFilters = {};
          if (after != null) timeFilters.since = after;
          if (before != null) timeFilters.until = before;
          const wanted = new Set(explicitSessions);
          let scopedCards = cards.list(timeFilters).filter((card) => wanted.has(card.sessionId));
          if (title) {
            const titleLower = title.toLowerCase();
            scopedCards = scopedCards.filter((card) =>
              card.title.toLowerCase().includes(titleLower),
            );
            pushUnique(normalized.limitedBy, "title");
          }
          const cap =
            requestedSessions != null
              ? Math.min(requestedSessions, Math.max(1, limits.drillSessions))
              : Math.max(1, limits.drillSessions);
          drillTargets = scopedCards
            .filter((card) => card.sessionId !== excludeSessionID)
            .slice(0, cap)
            .map((card) => registerTarget(card, relevanceOf(card)));
          deepSet = new Set(drillTargets.map((t) => t.sessionId));
          sessionsEligible = scopedCards.length;
          shortlistIDs = drillTargets.map((t) => t.sessionId);
          if (excludeSessionID) {
            skippedByReason.excludedSession = (skippedByReason.excludedSession ?? 0) + 1;
            pushUnique(normalized.limitedBy, "excludedSession");
          }
          if (sessionsEligible > drillTargets.length) {
            pushUnique(normalized.limitedBy, "sessionsLimit");
          }
          if (scope !== "global") pushUnique(normalized.limitedBy, "scope");
        } else {
          // ── Tier 1: rank cards ──
          const cardFilters: CardFilters = {};
          if (after != null) cardFilters.since = after;
          if (before != null) cardFilters.until = before;
          if (excludeCurrent && currentSessionID) cardFilters.excludeFamilyOf = currentSessionID;
          let cardHits: CardHit[] = cards.rank(queryMeta, cardFilters);

          if (title) {
            const titleLower = title.toLowerCase();
            cardHits = cardHits.filter((hit) => hit.card.title.toLowerCase().includes(titleLower));
            pushUnique(normalized.limitedBy, "title");
          }

          // ── Directory / project bucketing (reuses the old relevance machinery) ──
          let eligible = cardHits.map((hit) => ({ hit, relevance: relevanceOf(hit.card) }));
          if (bucketDirectory) {
            pushUnique(normalized.limitedBy, directoryFilter ? "directory" : "scope");
            const exact = eligible.filter((e) => e.relevance === "exact");
            const proj = eligible.filter((e) => e.relevance === "project");
            const glob = eligible.filter((e) => e.relevance === "global");
            if (directoryFilter && fallback) {
              eligible = [...exact, ...proj, ...glob];
              directoryBucketsSearched = [
                ...(exact.length > 0 ? (["exact"] as const) : []),
                ...(proj.length > 0 ? (["project"] as const) : []),
                ...(glob.length > 0 ? (["global"] as const) : []),
              ];
              if (proj.length > 0 || glob.length > 0) {
                normalized.warnings.push(
                  "Directory fallback broadened the search beyond exact matches.",
                );
              }
            } else if (projectScope && !directoryFilter) {
              eligible = [...exact, ...proj];
              directoryBucketsSearched = [
                ...(exact.length > 0 ? (["exact"] as const) : []),
                ...(proj.length > 0 ? (["project"] as const) : []),
              ];
              if (glob.length > 0) skippedByReason.directory = glob.length;
            } else {
              eligible = exact;
              directoryBucketsSearched = exact.length > 0 ? ["exact"] : [];
              const skipped = proj.length + glob.length;
              if (skipped > 0) skippedByReason.directory = skipped;
            }
          }

          for (const e of eligible) {
            relevanceBySession.set(e.hit.sessionId, e.relevance);
            searchedMeta.set(e.hit.sessionId, {
              id: e.hit.sessionId,
              title: e.hit.card.title,
              directory: e.hit.card.directory,
            });
          }
          sessionsEligible = eligible.length;
          // Title/directory-overlap shortlist (metadata signal), distinct from
          // the content rank: it powers the "these sessions match by name but no
          // content hit surfaced" suggestion, where every RESULT already comes
          // from a drilled (ranked) session.
          const metaTokens = queryMeta.tokens.filter((token) => token.length >= 4);
          shortlistIDs =
            metaTokens.length > 0
              ? eligible
                  .filter((e) => {
                    const meta = `${e.hit.card.title} ${e.hit.card.directory}`.toLowerCase();
                    return metaTokens.some((token) => meta.includes(token));
                  })
                  .map((e) => e.hit.sessionId)
              : [];

          const cardById = new Map(eligible.map((e) => [e.hit.sessionId, e.hit.card] as const));
          const eligibleIds = eligible.map((e) => e.hit.sessionId);
          const eligibleIdSet = new Set(eligibleIds);
          deepSet = eligibleIdSet;

          // ── Tier 1.5: FTS needle lookup — inject sessions whose card missed the anchor ──
          const ftsOnly: string[] = [];
          if (store) {
            const rows = store.ftsSearch({
              strong: [...queryMeta.codeTokens, ...queryMeta.phrases],
              weak: queryMeta.tokens,
            });
            ftsBySession = new Map<string, FtsHit[]>();
            for (const row of rows) {
              const list = ftsBySession.get(row.sessionId);
              if (list) list.push(row);
              else ftsBySession.set(row.sessionId, [row]);
            }
            const excludedFamily =
              excludeCurrent && currentSessionID
                ? cards.exclusionFamily(currentSessionID)
                : new Set<string>();
            for (const id of ftsBySession.keys()) {
              if (eligibleIdSet.has(id)) continue;
              if (id === excludeSessionID || excludedFamily.has(id)) continue;
              const card = store.getCard(id);
              if (!card) continue;
              if (after != null && card.timeUpdated < after) continue;
              if (before != null && card.timeUpdated > before) continue;
              const relevance = relevanceOf(card);
              if (bucketDirectory) {
                if (relevance === "global" && !(directoryFilter && fallback)) continue;
                if (relevance === "project" && !(projectScope || (directoryFilter && fallback))) {
                  continue;
                }
              }
              relevanceBySession.set(id, relevance);
              searchedMeta.set(id, { id, title: card.title, directory: card.directory });
              cardById.set(id, card);
              ftsOnly.push(id);
            }
          }

          // Cap the shortlist: caller sessions cap, then the drill fan-out.
          const cap =
            requestedSessions != null
              ? Math.min(requestedSessions, Math.max(1, limits.drillSessions))
              : Math.max(1, limits.drillSessions);
          const mergedIds = mergeShortlist(eligibleIds, ftsOnly, cap);
          drillTargets = mergedIds
            .filter((id) => id !== excludeSessionID)
            .map((id) => {
              const card = cardById.get(id);
              return {
                sessionId: id,
                title: card?.title ?? "",
                directory: card?.directory ?? "",
                timeUpdated: card?.timeUpdated ?? 0,
              };
            });

          if (excludeSessionID) {
            skippedByReason.excludedSession = (skippedByReason.excludedSession ?? 0) + 1;
            pushUnique(normalized.limitedBy, "excludedSession");
          }
          const shortlistSkipped = Math.max(0, eligibleIds.length - drillTargets.length);
          if (requestedSessions != null && sessionsEligible > requestedSessions) {
            pushUnique(normalized.limitedBy, "sessionsLimit");
          }
          if (shortlistSkipped > 0) {
            skippedByReason.sessionsLimit = (skippedByReason.sessionsLimit ?? 0) + shortlistSkipped;
          }
          if (excludeCurrent && currentSessionID) {
            // Count the current session's whole delegation tree (the cards the
            // family filter removed from ranking) so coverage reports the skip.
            const family = cards.exclusionFamily(currentSessionID);
            let excludedKnown = 0;
            for (const id of family) {
              if (!store || store.getCard(id)) excludedKnown++;
            }
            if (excludedKnown > 0) {
              pushUnique(normalized.limitedBy, "excludedSession");
              skippedByReason.excludedSession =
                (skippedByReason.excludedSession ?? 0) + excludedKnown;
            }
          }
          if (scope !== "global") pushUnique(normalized.limitedBy, "scope");
        }

        if (ctx.abort.aborted) {
          const err: ErrorOutput = { ok: false, error: "aborted" };
          return JSON.stringify(err);
        }

        const currentSessionExcluded = Boolean(
          excludeCurrent && currentSessionID && (store ? store.getCard(currentSessionID) : true),
        );
        drillTargets = drillTargets.filter((t) => t.sessionId !== excludeSessionID);

        const drillInput = {
          sessions: drillTargets,
          deepSet,
          ftsBySession,
          query: queryMeta,
          explain,
          filter: (candidate: Candidate) => candidateEligible(candidate, filters),
          searchTitles,
          abort: ctx.abort,
        };
        const abortedOutput = (): string =>
          JSON.stringify({ ok: false, error: "aborted" } satisfies ErrorOutput);

        const cardsCoverage = cards.coverage();
        if (cardsCoverage.totalCards >= DISCOVERY_LIMIT) {
          pushUnique(normalized.limitedBy, "providerLimit");
          normalized.warnings.push(
            "The card store holds the maximum discoverable sessions; older history may exist beyond it.",
          );
        }
        if (cardsCoverage.degraded) {
          normalized.warnings.push(
            "Cards are metadata-only (card store unavailable); content search is degraded.",
          );
        } else if (cardsCoverage.fullCards < cardsCoverage.totalCards) {
          normalized.warnings.push(
            "The card store is still distilling; some sessions are metadata-only until it completes.",
          );
        }

        // ── Build coverage + the finish() machinery from a drill result ──
        const buildOutputContext = (
          drilledSessions: string[],
          pools: DrilledPool[],
          loadErrors: string[],
          budgetExhausted: boolean,
        ): {
          coverage: SearchCoverage;
          searchedSessions: Array<{ id: string; title: string; directory: string }>;
          loadErrorCount: number;
          incomplete: boolean;
        } => {
          let partsSearched = 0;
          const msgIds = new Set<string>();
          for (const pool of pools) {
            for (const candidate of pool.candidates) {
              if (candidate.partType === "title") continue;
              partsSearched++;
              msgIds.add(candidate.messageID);
            }
          }
          const loadErrorCount = loadErrors.length;
          if (loadErrorCount > 0) pushUnique(normalized.limitedBy, "loadError");
          if (budgetExhausted) pushUnique(normalized.limitedBy, "rankingBudget");
          const drillSkipped = Math.max(0, drillTargets.length - drilledSessions.length);
          if (drillSkipped > 0) {
            skippedByReason.rankingBudget = (skippedByReason.rankingBudget ?? 0) + drillSkipped;
          }
          const sessionsSkipped = Object.values(skippedByReason).reduce((a, b) => a + b, 0);
          const coverage: SearchCoverage = {
            totalSessionsKnown: false,
            sessionsDiscovered: cardsCoverage.totalCards,
            sessionsEligible,
            sessionsSearched: drilledSessions.length,
            messagesSearched: msgIds.size,
            partsSearched,
            sessionsSkipped,
            skippedByReason: Object.keys(skippedByReason).length > 0 ? skippedByReason : undefined,
            directoryBucketsSearched,
            limitedBy: normalized.limitedBy.length > 0 ? normalized.limitedBy : undefined,
            loadErrors:
              loadErrorCount > 0 ? { count: loadErrorCount, samples: [...loadErrors] } : undefined,
            cards: {
              total: cardsCoverage.totalCards,
              full: cardsCoverage.fullCards,
              storeRecency: cardsCoverage.storeRecency,
              degraded: cardsCoverage.degraded,
            },
          };
          const searchedSessions = drilledSessions.map(
            (id) => searchedMeta.get(id) ?? { id, title: "", directory: "" },
          );
          return { coverage, searchedSessions, loadErrorCount, incomplete: loadErrorCount > 0 };
        };

        const queryLower = args.query.toLowerCase();
        let smartTokensMemo: string[] | undefined;
        const makeFindMatch = (effectiveMode: MatchMode): MatchFinder => {
          return (text) => {
            if (effectiveMode === "regex" && regex) return regexFirstIndex(regex, text);
            const lower = text.toLowerCase();
            if (effectiveMode === "literal") return lower.indexOf(queryLower);
            smartTokensMemo ??= parseQuery(args.query).tokens;
            for (const token of smartTokensMemo) {
              const index = lower.indexOf(token);
              if (index !== -1) return index;
            }
            return -1;
          };
        };

        const includeExpansion = async <T extends SearchOutput>(
          out: T,
          final: SearchResult[],
          warnings: string[],
          effectiveMatchMode: MatchMode,
        ): Promise<T> => {
          const expansion = await expandSearchResults(
            final,
            client,
            gate,
            limits,
            expandMode,
            normalized.expandResults,
            normalized.window,
            normalized.expandBudgetMessages,
            normalized.expandBudgetChars,
            makeFindMatch(effectiveMatchMode),
          );
          if (expansion.expanded) out.expanded = expansion.expanded;
          warnings.push(...expansion.warnings);
          return out;
        };

        const finish = async <T extends SearchOutput>(
          out: T,
          final: SearchResult[],
          effectiveMatchMode: MatchMode,
          outCtx: ReturnType<typeof buildOutputContext>,
        ): Promise<T> => {
          const warnings = [...normalized.warnings];
          if (outCtx.incomplete) {
            warnings.push(
              `${outCtx.loadErrorCount} session${outCtx.loadErrorCount === 1 ? "" : "s"} failed to load; results may be partial.`,
            );
          }
          return attachCommonOutput(
            await includeExpansion(out, final, warnings, effectiveMatchMode),
            {
              final,
              searchedSessions: outCtx.searchedSessions,
              coverage: outCtx.coverage,
              warnings,
              directory: directoryFilter,
              fallback,
              matchMode: effectiveMatchMode,
              type: partType,
              query: args.query,
              currentSessionID,
              currentSessionExcluded,
              excludeExplicitOff: excludeExplicit === false,
              codeTokens: queryMeta.codeTokens,
              shortlistIDs,
            },
          );
        };

        // ── Part-mode over-collection bound (grouped scans broadly) ──
        const partScanLimit = Math.min(
          MAX_PART_SCAN_RESULTS,
          resultsArg * DIVERSITY_SCAN_MULTIPLIER,
        );

        const applyGroupAndSlice = (
          results: SearchResult[],
          partTotal: number,
          earlyExit: boolean,
        ): { final: SearchResult[]; total: number; truncated: boolean } => {
          if (isGrouped) {
            const grouped = orderForDirectoryFallback(
              groupBySession(results),
              Boolean(bucketDirectory && fallback),
            );
            const final = grouped.slice(0, resultsArg);
            return {
              final,
              total: grouped.length,
              truncated: earlyExit || grouped.length > final.length,
            };
          }
          const diversified = diversify(results, resultsArg, MAX_HITS_PER_SESSION_INITIAL);
          const ordered = orderForDirectoryFallback(
            diversified,
            Boolean(bucketDirectory && fallback),
          );
          const final = capAndSlice(ordered, resultsArg, commandLikeQuery);
          return { final, total: partTotal, truncated: earlyExit || partTotal > final.length };
        };

        // ── Literal / regex scan over drilled pools ──
        const scanPools = (
          pools: DrilledPool[],
          scanLimit: number,
          matcher: (
            candidates: Candidate[],
            relevance: DirectoryRelevance,
            remaining: number,
          ) => {
            results: SearchResult[];
            total: number;
          },
        ): { collected: SearchResult[]; total: number; early: boolean } => {
          const collected: SearchResult[] = [];
          let total = 0;
          let early = false;
          const scanStart = performance.now();
          for (const pool of pools) {
            if (collected.length >= scanLimit) {
              early = true;
              break;
            }
            if (ctx.abort.aborted || performance.now() - scanStart > SCAN_TIME_BUDGET_MS) {
              early = true;
              break;
            }
            const relevance = relevanceBySession.get(pool.target.sessionId) ?? "unknown";
            const remaining = scanLimit - collected.length;
            const result = matcher(pool.candidates, relevance, remaining);
            collected.push(...result.results);
            total += result.total;
          }
          return { collected, total, early };
        };
        const literalMatcher = (
          candidates: Candidate[],
          relevance: DirectoryRelevance,
          remaining: number,
        ) => scan(candidates, relevance, args.query, remaining, widthArg);
        const regexMatcher =
          (re: RegExp) =>
          (candidates: Candidate[], relevance: DirectoryRelevance, remaining: number) =>
            regexScanCandidates(candidates, relevance, re, remaining, widthArg);

        const loadErrorSuffixOf = (count: number): string =>
          count > 0 ? `, ${count} load error${count !== 1 ? "s" : ""}` : "";

        // ── Deep sweep route (exhaustive, tool-output-inclusive, budgeted) ──
        if (deepMode) {
          const deepResume = deepCursor?.current ? { before: deepCursor.before } : undefined;
          const deepResult = await drill.deep({
            sessions: drillTargets,
            query: queryMeta,
            filter: (candidate: Candidate) => candidateEligible(candidate, filters),
            searchTitles,
            charsPerQuery: limits.deepCharsPerQuery,
            resume: deepResume,
            abort: ctx.abort,
          });
          if (ctx.abort.aborted) return abortedOutput();
          const outCtx = buildOutputContext(
            deepResult.drilledSessions,
            deepResult.pools,
            deepResult.loadErrors,
            deepResult.coverage.exhaustedBudget,
          );
          outCtx.coverage.deep = deepResult.coverage;

          const cov = deepResult.coverage;
          // Honest coverage line: deep searched tool outputs, and exactly how far.
          // On a resumed sweep the denominator is the REMAINING scope, so phrase it
          // that way — a continuation must never read like completion of the
          // original scope.
          const scopeWord = deepCursor ? "remaining scoped" : "scoped";
          normalized.warnings.push(
            `Deep sweep searched tool outputs across ${cov.sessionsCovered} full + ${cov.sessionsPartial} partial of ${drillTargets.length} ${scopeWord} session${drillTargets.length === 1 ? "" : "s"}${cov.sessionsRemaining > 0 ? `; ${cov.sessionsRemaining} not yet reached — pass deepCursor to continue` : ""}.`,
          );

          let final: SearchResult[];
          let outTotal: number;
          let truncated: boolean;
          let effMode: MatchMode;
          if (matchMode === "literal" || matchMode === "regex") {
            effMode = matchMode;
            const matcher = matchMode === "regex" && regex ? regexMatcher(regex) : literalMatcher;
            const limit = isGrouped ? Number.MAX_SAFE_INTEGER : partScanLimit;
            const scanned = scanPools(deepResult.pools, limit, matcher);
            const sliced = applyGroupAndSlice(scanned.collected, scanned.total, scanned.early);
            ({ final, total: outTotal, truncated } = sliced);
          } else {
            effMode = smartMode;
            const allCandidates = deepResult.pools.flatMap((pool) => pool.candidates);
            const hits = bm25Search(allCandidates, queryMeta, smartMode, explain);
            const allResults = rankedToSearchResults(
              hits,
              smartMode,
              explain,
              queryMeta,
              widthArg,
              relevanceBySession,
            );
            const sliced = applyGroupAndSlice(allResults, allResults.length, false);
            ({ final, total: outTotal, truncated } = sliced);
          }

          const unit = isGrouped ? "session" : "result";
          ctx.metadata({
            title: `Deep: ${final.length} ${unit}${final.length !== 1 ? "s" : ""} for "${args.query}" (${cov.sessionsCovered}/${drillTargets.length} swept${loadErrorSuffixOf(outCtx.loadErrorCount)})`,
          });

          const out: SearchOutput = {
            ok: true,
            results: final,
            total: outTotal,
            truncated,
            group: groupMode,
            ...(effMode !== "literal" ? { matchMode: effMode } : {}),
          };
          if (deepResult.continuation) {
            out.nextCursor = encodeDeepCursor({
              v: 1,
              remaining: deepResult.continuation.remaining,
              current: deepResult.continuation.current,
              before: deepResult.continuation.before,
            });
          }
          return JSON.stringify(await finish(out, final, effMode, outCtx));
        }

        // ── Route: literal ──
        if (matchMode === "literal") {
          const drilled = await drill.pools({ ...drillInput, mode: smartMode });
          if (ctx.abort.aborted) return abortedOutput();
          const outCtx = buildOutputContext(
            drilled.drilledSessions,
            drilled.pools,
            drilled.loadErrors,
            drilled.budgetExhausted,
          );
          const limit = isGrouped ? Number.MAX_SAFE_INTEGER : partScanLimit;
          const { collected, total, early } = scanPools(drilled.pools, limit, literalMatcher);
          const { final, total: outTotal, truncated } = applyGroupAndSlice(collected, total, early);

          const unit = isGrouped ? "session" : "result";
          ctx.metadata({
            title: `Found ${final.length} ${unit}${final.length !== 1 ? "s" : ""} for "${args.query}" (${drilled.drilledSessions.length} session${drilled.drilledSessions.length !== 1 ? "s" : ""} drilled${loadErrorSuffixOf(outCtx.loadErrorCount)})`,
          });

          const out: SearchOutput = {
            ok: true,
            results: final,
            total: outTotal,
            truncated,
            group: groupMode,
          };
          return JSON.stringify(await finish(out, final, "literal", outCtx));
        }

        // ── Route: regex ──
        if (matchMode === "regex" && regex) {
          const drilled = await drill.pools({ ...drillInput, mode: smartMode });
          if (ctx.abort.aborted) return abortedOutput();
          const outCtx = buildOutputContext(
            drilled.drilledSessions,
            drilled.pools,
            drilled.loadErrors,
            drilled.budgetExhausted,
          );
          const limit = isGrouped ? Number.MAX_SAFE_INTEGER : partScanLimit;
          const { collected, total, early } = scanPools(drilled.pools, limit, regexMatcher(regex));
          const { final, total: outTotal, truncated } = applyGroupAndSlice(collected, total, early);

          const unit = isGrouped ? "session" : "result";
          ctx.metadata({
            title: `Found ${final.length} ${unit}${final.length !== 1 ? "s" : ""} for /${args.query}/ (regex, ${drilled.drilledSessions.length} session${drilled.drilledSessions.length !== 1 ? "s" : ""}${loadErrorSuffixOf(outCtx.loadErrorCount)})`,
          });

          const out: SearchOutput = {
            ok: true,
            results: final,
            total: outTotal,
            truncated,
            matchMode: "regex",
            group: groupMode,
          };
          return JSON.stringify(await finish(out, final, "regex", outCtx));
        }

        // ── Route: smart / fuzzy (tier-2 drilled BM25 rerank) ──
        const drilled = await drill.drill({ ...drillInput, mode: smartMode });
        if (ctx.abort.aborted) return abortedOutput();
        const outCtx = buildOutputContext(
          drilled.drilledSessions,
          drilled.pools,
          drilled.loadErrors,
          drilled.budgetExhausted,
        );
        // Documented v1 decision (plan Revisions): semantic ranking is card-tier
        // only. A session the card runtime surfaced by embedding similarity but
        // whose drilled parts yield NO lexical BM25 hit produces no `drilled.hits`
        // entry, so it simply does not appear here. We deliberately do NOT
        // back-fill card-derived results or add part-level drill semantics — the
        // agent can issue a narrower query. Revisit only with measured demand.
        const allResults = rankedToSearchResults(
          drilled.hits,
          smartMode,
          explain,
          queryMeta,
          widthArg,
          relevanceBySession,
        );

        const planSelected: string[] = ["cards-tier1", "drill-tier2"];
        if (queryMeta.codeTokens.length > 0) planSelected.push("exact-token-boost");
        if (ftsBySession && ftsBySession.size > 0) planSelected.push("fts-needle");
        const QUERY_PLAN_VARIANTS = [
          "cards-tier1",
          "fts-needle",
          "exact-token-boost",
          "drill-tier2",
          "literal-fallback",
        ];
        const attachQueryPlan = (out: SearchOutput, selected: string[]): void => {
          if (explain) out.queryPlan = { variants: QUERY_PLAN_VARIANTS, selected };
        };

        // ── Fallback to a literal scan over the SAME drilled pools if smart is empty ──
        if (allResults.length === 0 && !ctx.abort.aborted) {
          const limit = isGrouped ? Number.MAX_SAFE_INTEGER : partScanLimit;
          const { collected, total, early } = scanPools(drilled.pools, limit, literalMatcher);
          const { final, total: outTotal, truncated } = applyGroupAndSlice(collected, total, early);
          if (final.length > 0) {
            const unit = isGrouped ? "session" : "result";
            ctx.metadata({
              title: `Found ${final.length} ${unit}${final.length !== 1 ? "s" : ""} for "${args.query}" (literal fallback, ${drilled.drilledSessions.length} session${drilled.drilledSessions.length !== 1 ? "s" : ""}${loadErrorSuffixOf(outCtx.loadErrorCount)})`,
            });
            const out: SearchOutput = {
              ok: true,
              results: final,
              total: outTotal,
              truncated,
              matchMode: "literal",
              degradeKind: "fallback",
              group: groupMode,
            };
            attachQueryPlan(out, [...planSelected, "literal-fallback"]);
            return JSON.stringify(await finish(out, final, "literal", outCtx));
          }
        }

        const {
          final,
          total: outTotal,
          truncated,
        } = applyGroupAndSlice(allResults, allResults.length, false);
        const unit = isGrouped ? "session" : "result";
        ctx.metadata({
          title: `Found ${final.length} ${unit}${final.length !== 1 ? "s" : ""} for "${args.query}" (${smartMode}, ${drilled.drilledSessions.length} session${drilled.drilledSessions.length !== 1 ? "s" : ""}${loadErrorSuffixOf(outCtx.loadErrorCount)})`,
        });
        const out: SearchOutput = {
          ok: true,
          results: final,
          total: outTotal,
          truncated,
          matchMode: smartMode,
          degradeKind: "none",
          group: groupMode,
        };
        attachQueryPlan(out, planSelected);
        return JSON.stringify(await finish(out, final, smartMode, outCtx));
      } catch (e) {
        const err: ErrorOutput = { ok: false, error: errmsg(e) };
        return JSON.stringify(err);
      }
    },
  });
}
