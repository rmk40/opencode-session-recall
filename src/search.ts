import { tool } from "./tool-def.js";
import type { ToolDefinition, ToolContext } from "./host/opencode-v1-types.js";
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
  type IndexingStatus,
  type HistoryCoverage,
  type HistoryRepairCoverage,
  type ToolNamesCoverage,
  indexingWarning,
  DISCOVERY_LIMIT,
} from "./types.js";
import {
  snippet,
  matches,
  isSelfToolPart,
  isSummarizerTitle,
  evidenceClassFor,
} from "./extract.js";
import {
  authorshipOf,
  parentageOf,
  AUTHORSHIP_VALUES,
  type Authorship,
  type AuthorshipCounts,
} from "./authorship.js";
import { parseQuery } from "./query.js";
import {
  candidateFilter,
  closestToolName,
  compileToolFilter,
  toolFilterMatches,
  toolFilterNames,
  type Candidate,
  type CandidateFilters,
  type ToolFilter,
} from "./candidates.js";
import type { CandidateEmbedder } from "./corpus.js";
import { cosineSimilarity } from "./semantic/similarity.js";
import { clamp01, bm25Search, type Bm25Hit } from "./bm25.js";
import { smartSnippet, truncatePreservingMatch } from "./snippet.js";
import { compileRegex, regexFirstIndex, regexSnippet } from "./regex.js";
import { classifyQuery } from "./route.js";
import type { CardsRuntime, CardHit, CardFilters, CardRankFilters, RankStats } from "./cards.js";
import { createCardDrill } from "./card-drill.js";
import {
  encodeDeepCursor,
  decodeDeepCursor,
  type Drill,
  type DrillTarget,
  type DrillTargetStats,
  type DrilledPool,
  type TimeWindow,
} from "./drill.js";
import { buildMatch, type Store, type FtsHit, type Card } from "./store.js";
import type { FetchGate } from "./fetch-gate.js";
import { fetchMessageWindow, type FetchRunner } from "./fetch-window.js";
import type { HistoryMessage } from "./history/model.js";
import {
  unavailableHistoryError,
  type HistoryDrift,
  type HistorySource,
  type SessionScope,
} from "./history/source.js";
import { inspectCheckpoint } from "./history/v2-sync.js";
import type { RepairStatus } from "./distill.js";
import { cyrb53 } from "./hash.js";
import {
  decodeRecallCursor,
  encodeRecallCursor,
  fitMessage,
  fitMessageList,
  messageItem,
  resumeMessage,
  resumeMessageList,
  section,
  utf8Length,
  writeError,
  writeOutput,
  type Fitted,
  type MessagePosition,
  type OutputSection,
  type OutputStop,
  type RecallCursor,
} from "./output.js";

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
  /** Opt-in semantic layer. When present and ready, the tier-1 card runtime
   *  already blends its signal; the search tool additionally uses the embedder
   *  here for the bounded zero-lexical-hit part-level rescue (semantic-
   *  shortlisted sessions only). Absent = lexical-only. */
  semantic?: SemanticSearchConfig;
  /** Set only when the plugin is CONFIGURED in ephemeral mode (no persistent
   *  store by choice). Never derived from `store === null`: the accidental
   *  driver-missing degraded path keeps its existing wording and defaults. */
  mode?: "ephemeral";
  /** Ephemeral cards-lite refresh trigger: called fire-and-forget once at
   *  query entry (search tool and card-tier hook path) so the metadata
   *  snapshot lazily self-heals. See lite-refresh.ts. */
  maybeRefresh?: () => void;
  /** The cold pass's progress while it builds an incomplete store (both
   *  hosts wire `Distiller.indexing` here); absent means none to report. */
  indexing?: IndexingStatus;
  /** How the host's history database differs from what this build reads
   *  (v2 wires its runtime's shared drift state; undefined while
   *  `opencode.db` cannot be read). Absent on v1, which has none. Reported
   *  as `coverage.history`. */
  history?: () => HistoryDrift | undefined;
  /** The repair sweep's and the range check's progress (v2 wires
   *  `Distiller.repair`). Absent on v1, which runs neither. */
  repair?: () => RepairStatus | undefined;
  /** Whether the last session discovery stopped at its limit, so older
   *  sessions may be missing from the store (v1, whose discovery requests
   *  one bounded listing; v2 discovery pages without a cap and leaves it
   *  unset). */
  discoveryTruncated?: () => boolean;
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
/** Hard cap on the explicit `sessions` shortlist (schema max + defensive clamp
 *  for the Zod-bypass host path). Matches the default session-list page size;
 *  it also bounds the uncarded metadata-probe fan-out on the deep path. */
const MAX_SHORTLIST_SESSIONS = 100;
/** Uncarded metadata probes run in parallel chunks of this size, so a long
 *  shortlist neither serializes every probe nor floods the fetch gate. */
const PROBE_CHUNK = 4;
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
 * then collect that root's transitive descendants. The search itself reads
 * the same set from the cards (`exclusionFamilyFromCards`); this discovery
 * form is the reference the equivalence test compares it with. Exported for
 * tests.
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

  // Collect the root's subtree (bounded, cycle-guarded). Seeded with the root
  // alone, so a current session below it is reached as a child and its own
  // subagents are collected too; it is added afterwards for the cycle and
  // depth-cap cases the walk does not reach it in.
  const family = new Set([root]);
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
  family.add(currentSessionID);
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

/**
 * Exported for direct unit tests of the per-part budget mechanics. `selfTool`
 * is {@link isSelfToolPart} of the source part, decided by the caller because
 * the formatted part no longer carries the tool metadata the predicate reads.
 */
export function truncateExpandedPart(
  part: PartOutput,
  budget: ExpansionBudget,
  findMatch: MatchFinder | undefined,
  /** Whether the source part is one of our own recall tools (required, so a
   *  new caller cannot forget the self-recall redaction). */
  selfTool: boolean,
): PartOutput {
  // Never surface our own recall tool output inside expansion. Search matching
  // already excludes self-tool parts (searchableFields), but expansion formats
  // every surrounding part, so a hit adjacent to a prior recall call would leak
  // that recall's output. Redact the body but keep the part marker so message
  // structure/positioning is preserved. Explicit recall_get/recall_context are
  // unaffected — this only applies to recall's inline expansion.
  if (selfTool) {
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

/** A history message as an expanded item: {@link messageItem} (so a message
 *  a read cut short carries the `recall_get` cursor for its rest), each part
 *  cut to the expansion budgets. */
function formatExpandedMsg(
  msg: HistoryMessage,
  budget: ExpansionBudget,
  matchedPartID?: string,
  findMatch?: MatchFinder,
): MessageItem {
  const item = messageItem(msg);
  // Pair each formatted part with its source part by id, not position, so the
  // self-recall redaction cannot mis-pair if formatMsg ever drops a part.
  // (Today it maps one to one, so the pairing is the same either way.)
  const sources = new Map(msg.parts.map((part) => [part.id, part]));
  return {
    ...item,
    parts: item.parts.map((part) => {
      const source = sources.get(part.id);
      return truncateExpandedPart(
        part,
        budget,
        part.id === matchedPartID && findMatch ? findMatch : undefined,
        source !== undefined && isSelfToolPart(source),
      );
    }),
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

/** Build a SearchResult from a cached candidate hit (literal/regex paths).
 *  `emitAuthorship` is the gate that keeps default responses byte-identical:
 *  the field is added only when the caller narrowed `authorship` or asked for
 *  `explain`. This route does NOT spread `candidate.why`, so the addition has
 *  to be made here explicitly. */
function candidateResult(
  candidate: Candidate,
  relevance: DirectoryRelevance,
  matchedField: ResultWhy["matchedFields"][number],
  snip: string,
  emitAuthorship = false,
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
      ...(emitAuthorship && { authorship: authorshipOf(candidate) }),
    },
  });
}

function scan(
  candidates: Candidate[],
  relevance: DirectoryRelevance,
  query: string,
  limit: number,
  width?: number,
  emitAuthorship = false,
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
          candidateResult(
            candidate,
            relevance,
            field.field,
            snippet(field.text, query, width),
            emitAuthorship,
          ),
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
  emitAuthorship = false,
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
            emitAuthorship,
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
  emitAuthorship = false,
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
        ...(emitAuthorship && { authorship: authorshipOf(c) }),
      },
      titleMatch: c.titleMatch,
    });

    if (explain && r.matchReasons.length > 0) {
      result.matchReasons = r.matchReasons;
    }

    return result;
  });
}

// ── Zero-lexical-hit semantic rescue ─────────────────────────────────
// Bounded part-level rescue for sessions the reserved-slot band surfaced that
// then drilled to zero lexical hits. This is the ONLY place the search path
// embeds parts, and only for those sessions — the drill itself stays embedding-
// free (drill.test.ts guards that). Capped candidates per session keep the extra
// embed work within the drill budgets already spent to fetch them.

/** Per-session cap on parts embedded during rescue. Drilled pools are already
 *  budget-bounded; this bounds the extra embed work regardless. */
const MAX_RESCUE_CANDIDATES = 60;

/** Build a rescue result from the top-cosine drilled part: labeled semantic in
 *  `why` (no lexical match), scored from the blended card+part similarity. */
function semanticRescueResult(
  candidate: Candidate,
  relevance: DirectoryRelevance,
  query: ReturnType<typeof parseQuery>,
  partSimilarity: number,
  blendedScore: number,
  width: number | undefined,
  mode: MatchMode,
  explain: boolean,
  emitAuthorship = false,
): SearchResult {
  const result = annotateResult({
    sessionID: candidate.sessionID,
    sessionTitle: candidate.sessionTitle,
    directory: candidate.directory,
    messageID: candidate.messageID,
    role: candidate.role,
    time: candidate.time,
    partID: candidate.partID,
    partType: candidate.partType,
    pruned: candidate.isPruned,
    snippet: smartSnippet(candidate.rawText, query, width),
    toolName: candidate.toolName,
    score: clamp01(blendedScore),
    matchMode: mode,
    source: candidate.source ?? sourceForPartType(candidate.partType),
    titleMatch: candidate.titleMatch,
    why: {
      matchedFields: [],
      directoryRelevance: relevance,
      recency: recencyLabel(candidate.time),
      confidence: "low",
      evidenceClass: evidenceClassFor(candidate.partType, candidate.toolName, []),
      ...(emitAuthorship && { authorship: authorshipOf(candidate) }),
      semanticSimilarity: partSimilarity,
    },
  });
  if (explain) {
    result.matchReasons = [
      `Semantic evidence (no lexical hit): cosine similarity ${partSimilarity.toFixed(3)}`,
    ];
  }
  return result;
}

/** For each semantic-shortlisted session with zero lexical drill hits, embed its
 *  drilled parts (bounded), pick the top-cosine part, and build one rescue result
 *  scored from the blended card+part similarity. Returns [] when semantic is off,
 *  the embedder is not ready, the query does not embed, or nothing qualifies. */
function rescueZeroHitSessions(input: {
  reserved: string[];
  hitSessions: Set<string>;
  pools: DrilledPool[];
  semantic: SemanticSearchConfig | undefined;
  semanticBySession: Map<string, number>;
  relevanceBySession: Map<string, DirectoryRelevance>;
  query: ReturnType<typeof parseQuery>;
  width: number | undefined;
  mode: MatchMode;
  explain: boolean;
  emitAuthorship: boolean;
}): SearchResult[] {
  const embedder = input.semantic?.embedder;
  if (input.reserved.length === 0 || !embedder?.ready) return [];
  const queryVec = embedder.embed(input.query.raw);
  if (!queryVec) return [];

  const weight = input.semantic!.weight;
  const reserved = new Set(input.reserved);
  const results: SearchResult[] = [];
  for (const pool of input.pools) {
    const sessionId = pool.target.sessionId;
    if (!reserved.has(sessionId) || input.hitSessions.has(sessionId)) continue;

    let best: { candidate: Candidate; sim: number } | undefined;
    let embedded = 0;
    for (const candidate of pool.candidates) {
      if (candidate.partType === "title" || !candidate.rawText) continue;
      if (embedded >= MAX_RESCUE_CANDIDATES) break;
      const vec = embedder.embed(candidate.rawText);
      embedded++;
      if (!vec) continue;
      const sim = clamp01((cosineSimilarity(queryVec, vec) + 1) / 2);
      if (!best || sim > best.sim) best = { candidate, sim };
    }
    if (!best) continue;

    const cardSim = input.semanticBySession.get(sessionId) ?? best.sim;
    const blended = clamp01(weight * best.sim + (1 - weight) * cardSim);
    const relevance = input.relevanceBySession.get(sessionId) ?? "unknown";
    results.push(
      semanticRescueResult(
        best.candidate,
        relevance,
        input.query,
        best.sim,
        blended,
        input.width,
        input.mode,
        input.explain,
        input.emitAuthorship,
      ),
    );
  }
  return results;
}

// ── Group results by session ─────────────────────────────────────────

/** How many of a session's strongest hits to track for representative
 *  selection and secondary evidence. Results arrive pre-ranked (smart) or in
 *  newest-first scan order (literal/regex), so the first N content hits are
 *  the session's best. */
const MAX_GROUP_TRACKED = 4;
/** A tracked hit qualifies as representative when its score is within this
 *  fraction of the session's best score. At a tighter tolerance (0.85) the
 *  utility ordering rarely gets to act, and the right material shows only in
 *  topEvidence. */
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
        // Inherits the emit gate for free: `why.authorship` is populated
        // exactly when the caller narrowed authorship or asked for explain, so
        // default grouped responses are unchanged.
        ...(hit.why?.authorship && { authorship: hit.why.authorship }),
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

const NO_FAMILY: ReadonlySet<string> = new Set();

/**
 * Final part-mode pass: apply per-class caps within the slice, backfill from
 * held-back hits when the caps starve the fill, and for command-like queries
 * guarantee one tool-input hit when any exists. Runs AFTER
 * orderForDirectoryFallback — that re-sort is class-blind, so a cap applied
 * inside diversify() would be silently defeated whenever directory fallback
 * reorders the list.
 *
 * With `family` (the relatives {@link familyDiversity} orders by), it also
 * keeps that pass's allowance: a cap skipping a hit moves later ones up, and
 * a promotion replaces one, so either could otherwise put a third relative
 * among the first {@link FAMILY_TOP_WINDOW} results. A relative the allowance
 * holds back comes right after those results, and fills in among them only
 * when no other hit is left. A `preferred` relative's hit (see
 * {@link familyDiversity}) the allowance, the limit or a class cap would
 * leave out takes the place of the last hit among those results from a
 * relative that is not preferred, in rank order.
 *
 * A promoted hit takes the last slot it may: not one among the first results
 * that would put a third relative there, never a preferred relative's hit
 * when it comes from a relative that is not preferred, and never a preferred
 * relative's only hit when it comes from outside the family. When no slot
 * qualifies the next held-back tool input is tried, and failing that none is
 * promoted.
 */
export function capAndSlice(
  ordered: SearchResult[],
  limit: number,
  commandLike: boolean,
  family: ReadonlySet<string> = NO_FAMILY,
  preferred: (hit: SearchResult) => boolean = () => false,
): SearchResult[] {
  const classCounts = new Map<string, number>();
  const final: SearchResult[] = [];
  const taken = new Set<SearchResult>();
  const heldBack: SearchResult[] = [];
  /** Relatives the family allowance kept out of the first results. */
  const deferred: SearchResult[] = [];
  const isFamily = (hit: SearchResult): boolean => family.has(hit.sessionID);
  const windowFull = (hit: SearchResult): boolean =>
    isFamily(hit) &&
    final.length < FAMILY_TOP_WINDOW &&
    final.filter(isFamily).length >= FAMILY_TOP_MAX;
  const classFull = (hit: SearchResult): boolean => {
    const cls = hit.why?.evidenceClass;
    const cap = cls != null ? CLASS_CAPS[cls] : undefined;
    return cls != null && cap != null && (classCounts.get(cls) ?? 0) >= cap;
  };
  const take = (hit: SearchResult): void => {
    const cls = hit.why?.evidenceClass;
    if (cls != null && CLASS_CAPS[cls] != null) {
      classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);
    }
    final.push(hit);
    taken.add(hit);
  };
  const position = new Map(ordered.map((hit, index) => [hit, index] as const));
  const byPosition = (a: SearchResult, b: SearchResult): number =>
    (position.get(a) ?? 0) - (position.get(b) ?? 0);
  /** Removes the last hit among the first results from a relative that is
   *  not preferred, for a preferred one to take its place. */
  const displaceUnpreferred = (): SearchResult | undefined => {
    const index = lastIndexWhere(final.slice(0, FAMILY_TOP_WINDOW), (held) => {
      return isFamily(held) && !preferred(held);
    });
    return index === -1 ? undefined : removeAt(index);
  };
  /** Takes the hit at `index` out of the results and its class count. */
  function removeAt(index: number): SearchResult {
    const displaced = final.splice(index, 1)[0]!;
    taken.delete(displaced);
    const cls = displaced.why?.evidenceClass;
    if (cls != null && CLASS_CAPS[cls] != null) {
      classCounts.set(cls, (classCounts.get(cls) ?? 1) - 1);
    }
    return displaced;
  }
  /** Makes room in the full allowance for a preferred relative's hit. */
  const displaceFor = (hit: SearchResult): boolean => {
    if (!preferred(hit)) return false;
    const displaced = displaceUnpreferred();
    if (!displaced) return false;
    deferred.push(displaced);
    return true;
  };
  const offer = (hit: SearchResult): void => {
    if (final.length >= limit || classFull(hit)) heldBack.push(hit);
    else if (!windowFull(hit) || displaceFor(hit)) take(hit);
    else deferred.push(hit);
  };

  for (const hit of ordered) {
    offer(hit);
    // Once the first results are full, the relatives they held back are next.
    if (final.length >= FAMILY_TOP_WINDOW && deferred.length > 0) {
      for (const held of deferred.splice(0).sort(byPosition)) offer(held);
    }
  }

  // Backfill in original order when the caps starved the fill (mirrors the
  // per-session diversity semantics: caps yield rather than return less).
  // A relative the family allowance still refuses waits for a second pass,
  // so it fills in only after every other held-back hit.
  const rest = [...heldBack, ...deferred].sort(byPosition);
  for (const keepAllowance of [true, false]) {
    for (const hit of rest) {
      if (final.length >= limit) break;
      if (taken.has(hit) || (keepAllowance && windowFull(hit))) continue;
      final.push(hit);
      taken.add(hit);
    }
  }

  // A preferred relative's hit still left out (by the limit or a class cap)
  // takes the place of the last one among the first results from a relative
  // that is not preferred, at its own rank, when its class cap still holds
  // once that hit is out: replacing a hit of its own class frees the room it
  // needs. Counted over the results themselves, since the backfill above
  // fills without counting.
  const classInFinal = (cls: EvidenceClass): number =>
    final.filter((held) => held.why?.evidenceClass === cls).length;
  for (const found of rest) {
    if (taken.has(found) || !isFamily(found) || !preferred(found)) continue;
    const firstResults = final.slice(0, FAMILY_TOP_WINDOW);
    if (!firstResults.some((held) => isFamily(held) && !preferred(held))) break;
    const cls = found.why?.evidenceClass;
    const cap = cls != null ? CLASS_CAPS[cls] : undefined;
    const index = lastIndexWhere(firstResults, (held) => {
      if (!isFamily(held) || preferred(held)) return false;
      if (cls == null || cap == null) return true;
      return classInFinal(cls) - (held.why?.evidenceClass === cls ? 1 : 0) < cap;
    });
    if (index === -1) continue;
    removeAt(index);
    const at = final.findIndex((held) => byPosition(held, found) > 0);
    if (at === -1) final.push(found);
    else final.splice(at, 0, found);
    taken.add(found);
    if (cls != null && cap != null) classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);
  }

  if (
    commandLike &&
    final.length > 0 &&
    !final.some((hit) => hit.why?.evidenceClass === "tool-input")
  ) {
    const familyInWindow = (): number => final.slice(0, FAMILY_TOP_WINDOW).filter(isFamily).length;
    /** Whether `by` may take slot `slot` (see the rules above). */
    const canTake = (slot: number, by: SearchResult): boolean => {
      const target = final[slot]!;
      if (
        slot < FAMILY_TOP_WINDOW &&
        isFamily(by) &&
        !isFamily(target) &&
        familyInWindow() >= FAMILY_TOP_MAX
      ) {
        return false;
      }
      if (!isFamily(target) || !preferred(target)) return true;
      if (isFamily(by)) return preferred(by);
      return final.some((other, index) => index !== slot && other.sessionID === target.sessionID);
    };
    for (const promoted of rest) {
      if (promoted.why?.evidenceClass !== "tool-input" || taken.has(promoted)) continue;
      let slot = final.length - 1;
      while (slot >= 0 && !canTake(slot, promoted)) slot--;
      if (slot === -1) continue;
      final[slot] = promoted;
      break;
    }
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

// ── Family diversity ─────────────────────────────────────────────────
// recall leaves the current session's relatives (its parent, siblings and
// subagents) in by default, so an orchestrator can find what its subagents
// found. A relative can still echo the query without holding an answer: a
// subagent's prompt is the orchestrator's own wording of it. These passes keep
// such echoes from crowding out prior work.

/** Family sessions may hold at most this many of the first
 *  {@link FAMILY_TOP_WINDOW} results while other results remain. */
const FAMILY_TOP_MAX = 2;
const FAMILY_TOP_WINDOW = 5;
/** Family sessions may take at most this share of the drill shortlist
 *  (never fewer than {@link FAMILY_TOP_MAX} slots). */
const FAMILY_DRILL_SHARE = 1 / 3;

/** The drill slots family sessions may take in a shortlist of `cap`. */
export function familyDrillSlots(cap: number): number {
  return Math.max(FAMILY_TOP_MAX, Math.floor(cap * FAMILY_DRILL_SHARE));
}

/**
 * Family diversity over ordered results. `family` holds the current session's
 * relatives, never the current session itself. A family session whose best
 * evidence (its first result that is not a title hit) is a delegated prompt
 * (`delegated` says which) moves below the best result from outside the
 * family, keeping its order. A relative whose best evidence is its own
 * reply is not moved, even when the reply only restates the query: the pass
 * cannot tell a model-written echo from an answer, so only `excludeFamily`
 * removes one. Then the family holds at most
 * {@link FAMILY_TOP_MAX} of the first {@link FAMILY_TOP_WINDOW} results; the
 * results it would have held there move down behind them, and fill in only
 * when no other result is left. A `preferred` result (one from a relative
 * the slim-index lookup found, as {@link capFamilySlots} prefers) the
 * allowance held back, or ranked anywhere below those first results, takes
 * the place there of the lowest-ranked family result that is not preferred,
 * keeping rank order among them; the one it displaces moves down behind
 * them. Without a result from outside the family nothing moves. Exported for
 * direct unit tests.
 */
export function familyDiversity(
  results: SearchResult[],
  family: ReadonlySet<string>,
  delegated: (result: SearchResult) => boolean,
  preferred: (result: SearchResult) => boolean = () => false,
): SearchResult[] {
  if (family.size === 0) return results;
  const isFamily = (result: SearchResult): boolean => family.has(result.sessionID);
  const bestOther = results.findIndex((result) => !isFamily(result));
  if (bestOther === -1) return results;

  let ordered = results;
  if (bestOther > 0) {
    const leads = new Map<string, SearchResult>();
    for (const result of results.slice(0, bestOther)) {
      if (result.source !== "title" && !leads.has(result.sessionID)) {
        leads.set(result.sessionID, result);
      }
    }
    const demoted = new Set(
      [...leads.values()].filter((lead) => delegated(lead)).map((lead) => lead.sessionID),
    );
    if (demoted.size > 0) {
      const above = results.slice(0, bestOther);
      ordered = [
        ...above.filter((result) => !demoted.has(result.sessionID)),
        results[bestOther]!,
        ...above.filter((result) => demoted.has(result.sessionID)),
        ...results.slice(bestOther + 1),
      ];
    }
  }

  const top: SearchResult[] = [];
  const held: SearchResult[] = [];
  let familyInTop = 0;
  let next = 0;
  for (; next < ordered.length && top.length < FAMILY_TOP_WINDOW; next++) {
    const result = ordered[next]!;
    if (isFamily(result)) {
      if (familyInTop >= FAMILY_TOP_MAX) {
        held.push(result);
        continue;
      }
      familyInTop++;
    }
    top.push(result);
  }

  // Preferred results the allowance held back or the window never reached
  // take the places of the lowest-ranked family results there that are not
  // preferred, which move down to lead the held ones.
  const swappedIn = new Set<SearchResult>();
  const swappedOut: SearchResult[] = [];
  for (const found of [...held, ...ordered.slice(next)]) {
    if (!isFamily(found) || !preferred(found)) continue;
    const index = lastIndexWhere(top, (r) => isFamily(r) && !preferred(r));
    if (index === -1) break;
    swappedOut.unshift(top.splice(index, 1)[0]!);
    top.push(found);
    swappedIn.add(found);
  }
  if (swappedIn.size > 0) {
    const position = new Map(ordered.map((r, index) => [r, index] as const));
    top.sort((a, b) => position.get(a)! - position.get(b)!);
    return [
      ...top,
      ...swappedOut,
      ...held.filter((r) => !swappedIn.has(r)),
      ...ordered.slice(next).filter((r) => !swappedIn.has(r)),
    ];
  }
  if (held.length === 0) return ordered;
  return [...top, ...held, ...ordered.slice(next)];
}

/** The index of the last item of `items` matching `test`, or -1. */
function lastIndexWhere<T>(items: readonly T[], test: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i]!)) return i;
  return -1;
}

/**
 * Caps the family sessions in a drill shortlist at `max`. The relatives it
 * keeps are those in `preferred` first, in its order, then the shortlist's
 * other relatives in shortlist order. `preferred` holds the relatives the
 * slim-index lookup matched on the query's code tokens or phrases outside a
 * delegated prompt, in its order: such a row is evidence about the session
 * itself, while a card can rank a relative on words its prompt shares with
 * the query. When the cap drops relatives, a preferred relative outside the
 * shortlist takes the slot of the first one it outranks. The freed slots go
 * to the next ids of `ranked` (the ranked card ids, then the slim-index
 * sessions) from outside the family; when none is left, the capped family ids
 * take them back, so the shortlist never shrinks. Within the cap nothing
 * moves, and no preferred relative is brought in. Exported for direct unit
 * tests.
 */
export function capFamilySlots(
  shortlist: string[],
  ranked: readonly string[],
  family: ReadonlySet<string>,
  max: number,
  preferred: readonly string[] = [],
): string[] {
  const relatives = shortlist.filter((id) => family.has(id));
  if (relatives.length <= max) return shortlist;
  const order = [...new Set([...preferred.filter((id) => family.has(id)), ...relatives])];
  const keep = new Set(order.slice(0, max));
  const pulled = order.slice(0, max).filter((id) => !shortlist.includes(id));
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const id of shortlist) {
    if (!family.has(id) || keep.has(id)) {
      kept.push(id);
      continue;
    }
    const next = pulled.shift();
    if (next !== undefined) kept.push(next);
    else dropped.push(id);
  }
  const seen = new Set(shortlist);
  for (const id of ranked) {
    if (kept.length >= shortlist.length) break;
    if (seen.has(id) || family.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  for (const id of dropped) {
    if (kept.length >= shortlist.length) break;
    kept.push(id);
  }
  return kept;
}

/** Safety cap on messages fetched while locating one hit's context window. */
const MAX_EXPAND_CONTEXT_FETCH = 200;

async function expandSearchResults(
  results: SearchResult[],
  source: HistorySource,
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
        const lookup = await gate.runQuery(() =>
          source.getMessage(result.sessionID, result.messageID),
        );
        if (!lookup.ok) {
          warnings.push(
            `Expansion could not load session ${result.sessionID}: ${
              lookup.error ?? "no message returned"
            }.`,
          );
          continue;
        }
        const bundle = lookup.value;
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
      source,
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

/** Below this many results (or the `results` asked for, when fewer), a search
 *  that excluded matching sessions says which argument includes them. */
const FEW_RESULTS = 3;

/** What a search's exclusion arguments removed that matched the query, as the
 *  card ranking and the slim-index lookup measured it: whether the current
 *  session matched, and how many of its relatives (its parent, siblings and
 *  subagents, removed only by `excludeFamily`) did. */
export type ExcludedMatches = { current: boolean; relatives: number };

type ExcludedHintInput = {
  results: SearchResult[];
  currentSessionExcluded: boolean;
  excludeFamily?: boolean;
  excludedMatches?: ExcludedMatches;
  requested?: number;
};

/** The suggestion naming the argument that includes the excluded sessions
 *  measured to match the query, on zero or few results; otherwise, on an
 *  empty result after the current session was excluded, the one naming that
 *  exclusion. */
function excludedHint(input: ExcludedHintInput): SearchSuggestion | undefined {
  const matched = input.excludedMatches;
  const few = input.results.length < Math.min(FEW_RESULTS, input.requested ?? FEW_RESULTS);
  if (matched && few && matched.relatives > 0) {
    const n = matched.relatives;
    return {
      reason: `${plural(n, "session")} in the current session's family (its parent, siblings or subagents) ${n === 1 ? "matches" : "match"} the query, but excludeFamily:true left ${n === 1 ? "it" : "them"} out.`,
      action: "Drop excludeFamily to search them.",
      example: { excludeFamily: false },
    };
  }
  if (matched && few && matched.current) {
    return input.excludeFamily
      ? {
          reason: "The current session matches the query, but excludeFamily:true left it out.",
          action:
            "Drop excludeFamily and pass excludeCurrentSession:false if you meant to search this conversation.",
          example: { excludeFamily: false, excludeCurrentSession: false },
        }
      : {
          reason: "The current session matches the query, but recall excludes it by default.",
          action: "Pass excludeCurrentSession:false if you meant to search this conversation.",
          example: { excludeCurrentSession: false },
        };
  }
  // An empty result after the current session was excluded names the
  // exclusion even when no match was measured, because the measurement can
  // miss one: the current session's card is the one most likely to be
  // waiting for the index, which ranking leaves unscored, and the cards and
  // the slim index leave out much of what assistant replies and tool output
  // say.
  if (input.results.length > 0 || !input.currentSessionExcluded) return undefined;
  return input.excludeFamily
    ? {
        reason: "This search excluded the current session and its family.",
        action: "Drop excludeFamily to search its parent, siblings and subagents.",
        example: { excludeFamily: false },
      }
    : {
        reason: "This search excluded the current session.",
        action: "Pass excludeCurrentSession:false if you meant to search this conversation.",
        example: { excludeCurrentSession: false },
      };
}

// Exported for direct unit tests (the absent-`coverage.cards` guard cannot be
// reached through the tool, which always attaches a cards block).
export function buildSuggestions(input: {
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
  /** Caller passed excludeFamily:true. */
  excludeFamily?: boolean;
  /** Excluded sessions that matched the query, when the search ranked cards. */
  excludedMatches?: ExcludedMatches;
  /** The `results` count the caller asked for. */
  requested?: number;
  codeTokens: string[];
  /** Session IDs the metadata shortlist selected (smart/fuzzy only). */
  shortlistIDs: string[];
  /** Normalized lower time bound (ms epoch), when the caller set one. */
  after?: number;
  /** The normalized authorship buckets, when the caller narrowed them. Absent
   *  for the default `"any"`, so the hint below cannot fire on a plain query. */
  authorship?: Authorship[];
}): SearchSuggestion[] | undefined {
  // Suggestions are ranked before the MAX_SUGGESTIONS slice so the required
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

  // Staleness: the requested window is newer than the newest indexed session,
  // so zero eligible sessions means the index has not caught up — not that the
  // history is empty. Inserted FIRST among priority-0 entries so the cap
  // (MAX_SUGGESTIONS) cannot displace it, and the two generic zero-result
  // entries it would contradict (literal→smart, "only N sessions searched")
  // are suppressed below. Widening the window is deliberately not offered: it
  // only admits older indexed sessions, never unindexed ones.
  const staleWindow =
    input.coverage.sessionsEligible === 0 &&
    input.after != null &&
    input.coverage.cards != null &&
    input.after > input.coverage.cards.storeRecency;
  if (staleWindow) {
    if (input.coverage.cards?.degraded) {
      // Mode-gated wording: in configured ephemeral mode this branch fires on
      // snapshot lag (lite cards carry real timeUpdated values, so an
      // in-window `since` usually matches eligible cards), not routinely —
      // reword it for that meaning. The driver-missing degraded wording stays
      // byte-identical.
      if (input.coverage.mode === "ephemeral") {
        add(0, {
          reason:
            "No persistent index by configuration (ephemeral mode) — content matches come from live drill; the metadata snapshot has not caught up to this time window.",
          action:
            "For very recent sessions, list them with recall_sessions and name them via sessions: [...].",
        });
      } else {
        add(0, {
          reason:
            "No content index is available (degraded mode); recent sessions are not searchable.",
          action:
            "Use recall_sessions for live session metadata; recall_messages reads a known session directly.",
        });
      }
    } else {
      add(0, {
        reason:
          "The search index has not caught up to this time window; recent sessions may be missing.",
        action:
          'For cancelled-subagent recovery use recall_sessions({ parentID: "current" }); otherwise list live session metadata with recall_sessions using the same since.',
      });
    }
  }

  // On an empty result the exclusion hint comes right after the stale-window
  // hint and ahead of every other priority-0 entry, so the cap keeps both it
  // and the tool-name hint inserted next: what the exclusion removed is the
  // likeliest explanation, ahead of routing, directory and literal-mode
  // advice. On a few results it ranks with the priority-1 hints.
  const excluded = excludedHint(input);
  if (excluded) add(input.results.length === 0 ? 0 : 1, excluded);

  // A toolName that matched no tool part the other filters keep. When the
  // authorship filter removed the parts it did match, that filter emptied the
  // result; otherwise the name did, so name what is there. A deep sweep that
  // stopped early has not seen every scoped session, so it asks for the rest
  // of the sweep before another name.
  const tools = input.coverage.toolNames;
  let toolAuthorshipHint = false;
  if (input.results.length === 0 && tools && tools.matched === 0) {
    const sweptSoFar = input.coverage.deep?.exhaustedBudget === true;
    const where = sweptSoFar ? "the sessions swept so far" : "the searched sessions";
    const named = `toolName:${JSON.stringify(tools.filter)}`;
    if (tools.excludedByAuthorship) {
      toolAuthorshipHint = true;
      const count = tools.excludedByAuthorship;
      add(0, {
        reason: `${named} matched ${count} tool part${count === 1 ? "" : "s"} in ${where}, but the authorship:${JSON.stringify(input.authorship ?? [])} filter removed ${count === 1 ? "it" : "them all"}.`,
        action:
          'Tool parts classify as "model" on assistant messages and "injected" on user messages: add those to authorship, or pass authorship:"any".',
        example: { authorship: "any" },
      });
    } else {
      const listed = tools.top
        .slice(0, 3)
        .map((entry) => `${entry.name} (${entry.count})`)
        .join(", ");
      add(0, {
        reason: `${named} matched none of the ${tools.parts} tool part${tools.parts === 1 ? "" : "s"} in ${where}; the most frequent ${tools.top.length === 1 ? "is" : "are"} ${listed}.`,
        action: sweptSoFar
          ? "The sweep has not reached every scoped session: pass nextCursor as deepCursor to search the rest before changing toolName."
          : tools.closest
            ? `Retry with toolName:${JSON.stringify(tools.closest)}, the closest name found.`
            : "Retry with a name from coverage.toolNames.top, or drop toolName.",
        ...(!sweptSoFar && tools.closest && { example: { toolName: tools.closest } }),
      });
    }
  }

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

  // Suppressed under a stale window: broadening the match cannot recover
  // sessions the index has not seen.
  if (input.results.length === 0 && input.matchMode === "literal" && !staleWindow) {
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

  // The tool-name hint above already names the authorship filter and how to
  // widen it, for the parts it removed.
  if (
    input.results.length === 0 &&
    input.authorship &&
    input.authorship.length > 0 &&
    !toolAuthorshipHint
  ) {
    // Only name the delegated bucket when it is actually being withheld —
    // otherwise the reason contradicts an authorship:"delegated" request.
    const hidesDelegated = !input.authorship.includes("delegated");
    add(0, {
      reason: `The authorship:${JSON.stringify(input.authorship)} filter withholds every other kind of text${
        hidesDelegated ? ", including agent-authored prompts in subagent sessions" : ""
      }.`,
      action: 'Retry with authorship:"any" to see who else wrote about this.',
      example: { authorship: "any" },
    });
  }

  // Suppressed under a stale window: "remove narrowing filters" misdiagnoses
  // an indexing gap as over-filtering.
  if (input.results.length === 0 && input.coverage.sessionsSearched <= 4 && !staleWindow) {
    const count = input.coverage.sessionsSearched;
    const noun = count === 1 ? "session" : "sessions";
    const verb = count === 1 ? "was" : "were";
    add(0, {
      reason: `Only ${count} ${noun} ${verb} searched.`,
      action: "Remove narrowing filters or increase the sessions limit.",
    });
  }

  // Required hints (priority 1): must survive the cap when triggered.
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
    excludeFamily: boolean;
    excludedMatches?: ExcludedMatches;
    requested: number;
    codeTokens: string[];
    shortlistIDs: string[];
    after?: number;
    authorship?: Authorship[];
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
    excludeFamily: input.excludeFamily,
    ...(input.excludedMatches && { excludedMatches: input.excludedMatches }),
    requested: input.requested,
    codeTokens: input.codeTokens,
    shortlistIDs: input.shortlistIDs,
    ...(input.after != null && { after: input.after }),
    ...(input.authorship && { authorship: input.authorship }),
  });
  if (suggestions) out.suggestions = suggestions;
  const nearMisses = buildNearMisses(input.final, input.searchedSessions);
  if (nearMisses) out.nearMisses = nearMisses;
  return out;
}

/**
 * Merge the tier-1 card shortlist with the tier-1.5 FTS-only needle sessions and
 * the tier-1 top pure-semantic sessions, capped at `cap`.
 *
 * Two reserved bands sit ahead of the weakest strong cards so a signal the blend
 * buries still gets a drill slot: FTS-only sessions (a session whose card missed
 * the query's anchor but whose slim-index rows carry it) get a dynamic band, and
 * the top pure-semantic sessions (card ids the lexical+semantic blend ranks too
 * low to shortlist, but which the semantic signal ranks highest) get a fixed
 * `semanticSlots` band. Both reservations honor the same cap==1 guard: when the
 * cap leaves no room beyond one strong card, that single slot always goes to the
 * top-ranked card, never a reserved band. `semanticIds` is a subset of `cardIds`
 * (reordered by semantic score); dedup keeps a reserved id that is also strong
 * from taking two slots. Order-preserving and deduped. Exported for direct unit
 * tests of the reservation and cap guards.
 */
export function mergeShortlist(
  cardIds: string[],
  ftsOnly: string[],
  semanticIds: string[],
  cap: number,
  semanticSlots: number,
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }
  };

  // Only reserve when the cap leaves room for at least one strong card.
  const roomForReserved = cardIds.length > 0 ? cap - 1 : cap;
  const ftsReserve =
    ftsOnly.length === 0
      ? 0
      : Math.min(ftsOnly.length, Math.max(1, Math.floor(cap / 3)), Math.max(0, roomForReserved));
  const semReserve =
    semanticIds.length === 0 || semanticSlots <= 0
      ? 0
      : Math.min(semanticIds.length, semanticSlots, Math.max(0, roomForReserved - ftsReserve));

  // The reserved-semantic ids are card ids the blend ranked too low to make the
  // strong prefix; pulling them out first is what rescues them. Exclude them from
  // the strong prefix so the reservation is additive, not a reorder of the top.
  const reservedSemantic = semanticIds.slice(0, semReserve);
  const reservedSemanticSet = new Set(reservedSemantic);
  const strongCount = Math.max(0, cap - ftsReserve - semReserve);
  const strong = cardIds.filter((id) => !reservedSemanticSet.has(id)).slice(0, strongCount);

  for (const id of strong) push(id);
  for (const id of ftsOnly.slice(0, ftsReserve)) push(id);
  for (const id of reservedSemantic) push(id);
  for (const id of cardIds) {
    if (merged.length >= cap) break;
    push(id);
  }
  for (const id of ftsOnly.slice(ftsReserve)) {
    if (merged.length >= cap) break;
    push(id);
  }
  return merged.slice(0, cap);
}

// ── Drill accounting ─────────────────────────────────────────────────

/** Target sessions `coverage.sessionStops` lists, in drill order. */
const SESSION_STOPS_SHOWN = 10;

/** The coverage message counts and stop list for a drill's targets. */
function drillAccounting(
  targets: readonly DrillTargetStats[],
): Pick<
  SearchCoverage,
  "messagesFetched" | "messagesCandidate" | "messagesEligible" | "sessionStops"
> {
  let messagesFetched = 0;
  let messagesCandidate = 0;
  let messagesEligible = 0;
  for (const target of targets) {
    messagesFetched += target.fetched;
    messagesCandidate += target.candidate;
    messagesEligible += target.eligible;
  }
  return {
    messagesFetched,
    messagesCandidate,
    messagesEligible,
    ...(targets.length > 0 && {
      sessionStops: {
        count: targets.length,
        sessions: targets.slice(0, SESSION_STOPS_SHOWN).map((target) => ({
          sessionID: target.sessionId,
          fetched: target.fetched,
          candidate: target.candidate,
          eligible: target.eligible,
          stop: target.stop,
          ...(target.cached && { cached: true as const }),
        })),
      },
    }),
  };
}

/** Tool names `coverage.toolNames.top` lists. */
const TOOL_NAMES_SHOWN = 10;

/** Tool parts per tool name across the pools: `kept` from each pool's
 *  `toolNames`, `removed` from its `authorshipToolNames` (see
 *  {@link DrilledPool}). */
function poolToolNames(pools: readonly DrilledPool[]): {
  kept: Map<string, number>;
  removed: Map<string, number>;
} {
  const kept = new Map<string, number>();
  const removed = new Map<string, number>();
  const add = (into: Map<string, number>, from: ReadonlyMap<string, number> | undefined) => {
    for (const [name, count] of from ?? []) into.set(name, (into.get(name) ?? 0) + count);
  };
  for (const pool of pools) {
    add(kept, pool.toolNames);
    add(removed, pool.authorshipToolNames);
  }
  return { kept, removed };
}

/** `coverage.toolNames` for a `toolName` filter over the counted tool parts
 *  the authorship filter kept (`counts`) and those it removed
 *  (`authorshipRemoved`, of which only the names the filter accepts count);
 *  undefined when neither holds a part. Exported for direct unit tests. */
export function toolNamesCoverage(
  requested: string,
  filter: ToolFilter,
  counts: ReadonlyMap<string, number>,
  authorshipRemoved: ReadonlyMap<string, number> = new Map(),
): ToolNamesCoverage | undefined {
  let parts = 0;
  let matched = 0;
  for (const [name, count] of counts) {
    parts += count;
    if (toolFilterMatches(filter, name)) matched += count;
  }
  let excludedByAuthorship = 0;
  for (const [name, count] of authorshipRemoved) {
    if (toolFilterMatches(filter, name)) excludedByAuthorship += count;
  }
  if (parts === 0 && excludedByAuthorship === 0) return undefined;
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOOL_NAMES_SHOWN)
    .map(([name, count]) => ({ name, count }));
  const closest = closestToolName(requested, counts, filter);
  return {
    filter: requested,
    accepted: toolFilterNames(filter),
    matched,
    ...(excludedByAuthorship > 0 && { excludedByAuthorship }),
    parts,
    distinct: counts.size,
    top,
    ...(closest !== undefined && { closest }),
  };
}

// ── History drift and card repair ────────────────────────────────────

/** `coverage.history` from the drift state and the repair progress;
 *  undefined when the host reports no drift state (v1, or `opencode.db`
 *  unreadable). */
function historyCoverage(
  drift: HistoryDrift | undefined,
  repair: RepairStatus | undefined,
): HistoryCoverage | undefined {
  if (!drift) return undefined;
  const sweep = repair?.sweep;
  const reconcile = repair?.reconcile;
  return {
    capabilities: drift.capabilities,
    migration: drift.migration,
    unknownTables: drift.unknownTables,
    ...(drift.missingColumns.length > 0 && { missingColumns: drift.missingColumns }),
    ...(drift.unknownPartTypeNames.length > 0 && {
      unknownPartTypeNames: drift.unknownPartTypeNames,
    }),
    reads: drift.reads,
    counts: drift.counts,
    ...(sweep && {
      repair: {
        pending: sweep.pending,
        repairPending: sweep.repairPending,
        done: sweep.done,
        running: sweep.running,
        ...(sweep.stalled && { stalled: true as const }),
        at: sweep.at,
      },
    }),
    ...(reconcile && {
      reconcile: {
        sweeps: reconcile.sweep,
        oldestUnchecked: { session: reconcile.session, after: reconcile.after },
        // A sweep starts the moment the previous one completes.
        lastSweepCompletedAt: reconcile.previousStartedAt !== null ? reconcile.startedAt : null,
        checkedSince: reconcile.previousStartedAt,
        lastCheckAt: reconcile.at,
      },
    }),
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The warning for a history database whose schema or reads show content
 *  this build may miss; undefined while reads are clean (a normal install).
 *  An untested newest migration alone is not one: every opencode release
 *  adds migrations, and `coverage.history.migration` still reports it. */
function driftWarning(history: HistoryCoverage): string | undefined {
  const found: string[] = [];
  if (history.unknownTables.length > 0) {
    found.push(`unknown tables ${history.unknownTables.join(", ")}`);
  }
  if (history.missingColumns) {
    found.push(`missing columns ${history.missingColumns.join(", ")}`);
  }
  const { unknownPartTypes, emptyWithParts, malformedParts } = history.counts;
  if (unknownPartTypes > 0) {
    const names = history.unknownPartTypeNames?.join(", ");
    found.push(`${plural(unknownPartTypes, "part")} of unknown types${names ? ` (${names})` : ""}`);
  }
  if (emptyWithParts > 0) {
    found.push(`${plural(emptyWithParts, "assistant message")} read empty despite part rows`);
  }
  if (malformedParts > 0) found.push(`${plural(malformedParts, "part")} that do not decode`);
  if (found.length === 0) return undefined;
  return `opencode's history database differs from what this plugin version reads (${found.join("; ")}); some content may be missing from results. Updating opencode-session-recall may fix it.`;
}

/** The warning while card repair is unfinished or has given up on some
 *  cards; undefined once every card is rebuilt. */
function repairWarning(repair: HistoryRepairCoverage): string | undefined {
  const failed =
    repair.repairPending > 0
      ? ` (${plural(repair.repairPending, "more card")} could not be rebuilt)`
      : "";
  if (repair.pending > 0 && repair.stalled) {
    return `Card repair has stalled with ${plural(repair.pending, "session card")} not yet rebuilt${failed}; matches in those sessions may be missing. Restarting opencode resumes it.`;
  }
  if (repair.pending > 0) {
    return `Card repair in progress: ${plural(repair.pending, "session card")} not yet rebuilt${failed}; matches in those sessions may be missing until it finishes.`;
  }
  if (repair.repairPending > 0) {
    return `${plural(repair.repairPending, "session card")} could not be rebuilt by this plugin version; matches in those sessions may be missing.`;
  }
  return undefined;
}

/** The warning when result sessions were indexed with messages cut short
 *  (their cards miss part of those messages); undefined when none were. */
function cutWarning(results: readonly SearchResult[], cards: CardsRuntime): string | undefined {
  let sessions = 0;
  let messages = 0;
  for (const id of new Set(results.map((result) => result.sessionID))) {
    const cut = inspectCheckpoint(cards.get(id)?.distillCursor)?.cut ?? 0;
    if (cut === 0) continue;
    sessions++;
    messages += cut;
  }
  if (sessions === 0) return undefined;
  return `${plural(sessions, "result session")} ${sessions === 1 ? "was" : "were"} indexed with ${plural(messages, "message")} cut short, so the index misses part of ${messages === 1 ? "it" : "them"}; recall_get reads a message in full.`;
}

// ── Output continuation ──────────────────────────────────────────────

// The continuation itself is a `RecallCursor` (see `output.ts`).

/** The identity a continuation checks a result by. */
function resultIdentity(result: SearchResult): [string, string, string] {
  return [result.sessionID, result.messageID, result.partID];
}

/** The `shown` fingerprint of a {@link RecallCursor}: for a results stop at
 *  `index`, the results up to and including it; for a stop inside expansion
 *  `index`, every result and the expansions up to and including it. */
function shownFingerprint(
  results: readonly SearchResult[],
  expanded: readonly ExpandedResult[],
  stop: { section: "results" | "expanded"; index: number },
): string {
  const parts =
    stop.section === "results"
      ? results.slice(0, stop.index + 1).map(resultIdentity)
      : [
          results.map(resultIdentity),
          expanded.slice(0, stop.index + 1).map((e) => [e.resultIndex, e.messageID]),
        ];
  return cyrb53(JSON.stringify(parts));
}

/** The largest leading piece of an expansion that serializes within
 *  `bytes`: its messages as {@link fitMessageList} (context) or
 *  {@link fitMessage} (message) fits them, with where its rest starts. */
function fitExpansion(
  record: ExpandedResult,
  bytes: number,
): Fitted<ExpandedResult, MessagePosition> | undefined {
  if (record.messages) {
    const shell = utf8Length(JSON.stringify({ ...record, messages: [] }));
    if (shell > bytes) return undefined;
    // The shell's empty array already paid for the list's brackets.
    const fitted = fitMessageList(record.messages, bytes - shell + 2);
    if (!fitted?.rest) return undefined;
    return { record: { ...record, messages: fitted.items }, rest: fitted.rest };
  }
  if (record.message) {
    // The shell with the message's value as `null`, less those 4 bytes.
    const shell = utf8Length(JSON.stringify({ ...record, message: null })) - 4;
    if (shell > bytes) return undefined;
    const fitted = fitMessage(record.message, bytes - shell);
    if (!fitted) return undefined;
    return {
      record: { ...record, message: fitted.record },
      rest: { message: record.message.message.id, at: fitted.rest },
    };
  }
  return undefined;
}

/** `record` resumed at `at`; undefined when the message or part it names is
 *  no longer in it. */
function resumeExpansion(record: ExpandedResult, at: MessagePosition): ExpandedResult | undefined {
  if (record.messages) {
    const messages = resumeMessageList(record.messages, at);
    return messages ? { ...record, messages } : undefined;
  }
  if (record.message) {
    if (record.message.message.id !== at.message) return undefined;
    if (!at.at) return record;
    const message = resumeMessage(record.message, at.at);
    return message ? { ...record, message } : undefined;
  }
  return undefined;
}

const RESULTS_CHANGED =
  "The search results changed since this cursor was made (new history, or a sweep that reached a different point); search again without cursor";

// ── Main export ──────────────────────────────────────────────────────

export function search(
  source: HistorySource,
  global: boolean,
  limits: Limits,
  deps: SearchDeps,
): ToolDefinition {
  const { cards, drill, store, gate, mode, maybeRefresh } = deps;
  return tool({
    description: `Search prior opencode conversations by message/tool-output content. Primary history-discovery tool; prefer over recall_sessions for topical discovery (titles only).

Call when history could change the approach: debugging errors, investigating behavior, non-trivial feature work in areas with likely prior history, changing architecture/config, answering "last time/before", recovering commands/root causes/decisions, or checking if an approach worked or failed. Also call before substantive work in an unfamiliar area of this project.

Skip trivial commands, simple local code/file lookup, simple edits with full context, ordinary code tasks where prior history would not change the approach, or anything not helped by past conversations.

For "how did we do X before": match:"smart", group:"session" (current session is already excluded by default); if results are weak, search the project directory literally for the tool/command name and inspect tool-input hits with expand:"context" or recall_context.

First call: for broad discovery use match:"smart", group:"session", ${mode ? 'scope:"project" (default in this mode; cross-project needs an explicit scope:"global")' : 'scope:"global" (default)'}, 5-10 results, and short terms from error text/feature/config/file/decision. Only the current session is excluded by default, so its subagents' findings stay searchable; pass excludeCurrentSession:false to include it (or use scope:"session"), or excludeFamily:true to also drop its parent, siblings and subagents. Use role:"user" for requirements/decisions, and authorship:"human" when you specifically want what a person typed — role:"user" also carries subagent prompts written by an orchestrating agent and host-injected text. Use expand:"context" or "message" when top-hit evidence will avoid a follow-up.

If memory exists, store only durable findings: preferences, project decisions, reusable root causes, environment facts, behavior corrections, or repeatable success/failure. Do not store ephemeral details, one-off commands, transient errors, or implementation minutiae.

Modes: literal exact substring; smart ranked BM25; fuzzy looser; regex pattern (invalid pattern errors). Smart/fuzzy include score/matchedTerms and fall back to literal. Results are snippets; use recall_get/context for full content. coverage reports what was searched; coverage.loadErrors reports partial session-load failures. A trimmed result continues with cursor: continuation (same arguments); for a deep sweep that re-runs the sweep, which may differ and need a fresh search.${mode ? '\n\nEphemeral mode is configured: no persistent content index (coverage.cards full:0/storeRecency:0 is the configured state, not an empty history). Ranking is metadata-quality; for content recall rely on drilled results, deep sweeps, or name sessions via sessions:[...]. The default scope in this mode is "project" (not global): limitedBy:["scope"] on defaulted queries is configured behavior, and an explicit scope:"global" always works.' : ""}`,
    args: {
      query: tool.schema.string().min(1).describe("Search text"),
      // Ephemeral mode deliberately uses `.optional()` with NO schema default:
      // a schema `.default("project")` would materialize on parsed callers and
      // destroy explicitness detection (an omitted scope must stay
      // distinguishable from an explicit one for the deep gate), while a bare
      // default-less enum is REQUIRED in Zod — the host validates even though
      // it discards the parse — so omitted calls would fail and the
      // model-facing JSON schema would demand `scope`. The runtime pickEnum
      // fallback resolves undefined → "project" instead.
      scope: mode
        ? tool.schema
            .enum(["session", "project", "global"])
            .optional()
            .describe(
              "global=all projects, project=current project (default in this mode), session=current only",
            )
        : tool.schema
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
      excludeFamily: tool.schema
        .boolean()
        .optional()
        .describe("true also excludes this session's parent, siblings and subagents"),
      excludeSessionID: tool.schema.string().optional().describe("Exclude one session by ID"),
      type: tool.schema
        .enum(["text", "tool", "reasoning", "all"])
        .default("all")
        .describe("Part type filter"),
      role: tool.schema.enum(["user", "assistant", "all"]).default("all").describe("Role filter"),
      authorship: tool.schema
        .union([
          tool.schema.enum([...AUTHORSHIP_VALUES, "any"]),
          tool.schema.array(tool.schema.enum([...AUTHORSHIP_VALUES])),
        ])
        .optional()
        .describe(
          'Who wrote it (default "any"): human=typed by a person in a root session, delegated=written by an orchestrating agent (subagent prompts and subtask parts), injected=host/tool-injected or host-ignored user-role content, model=assistant output, title=session title, unknown=parentage could not be resolved. Accepts an array to union buckets. Different question from role, which is transport-level.',
        ),
      sessionLimit: tool.schema
        .number()
        .min(1)
        .max(limits.maxSessions)
        .optional()
        .describe("Max sessions to drill (caps drill fan-out)"),
      sessions: tool.schema
        .array(tool.schema.string())
        .max(MAX_SHORTLIST_SESSIONS)
        .optional()
        .describe(
          `Explicit session-id shortlist (max ${MAX_SHORTLIST_SESSIONS}). Without deep: drill exactly these (skips card ranking for selection; results are still ranked). With deep: the sweep scope.`,
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
          "Opaque continuation from a prior deep response's nextCursor; resumes the sweep. If the original request named uncarded sessions via `sessions`, repeat that `sessions` arg on resume — the untrusted cursor alone only readmits ids the card store knows.",
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
      since: tool.schema
        .string()
        .optional()
        .describe(
          "Alias for last (2h, 7d, 3w). Keeps sessions active since then and reads only their messages after it",
        ),
      until: tool.schema
        .string()
        .optional()
        .describe(
          "Upper bound as an age (2h, 7d, 3w). Keeps sessions started before it, still-running ones too, and reads their messages from the bound down",
        ),
      last: tool.schema
        .string()
        .optional()
        .describe(
          "Lower bound (2h, 7d, 3w). Keeps sessions active since then and reads only their messages after it",
        ),
      from: tool.schema.string().optional().describe("Lower bound like '365d ago' or date"),
      to: tool.schema.string().optional().describe("Upper bound like 'now' or date"),
      directory: tool.schema.string().optional().describe("Exact or descendant session dir"),
      project: tool.schema
        .union([tool.schema.boolean(), tool.schema.string()])
        .optional()
        .describe("true=current project only; a path filters to that project dir"),
      fallback: tool.schema.boolean().default(false).describe("Broaden directory search if needed"),
      toolName: tool.schema
        .string()
        .optional()
        .describe(
          "Tool name, exact; tool parts only. Aliases match in any case: bash/shell, task/subagent, apply_patch/patch",
        ),
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
      cursor: tool.schema
        .string()
        .optional()
        .describe("continuation from a trimmed result; omit for the start"),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      // Ephemeral cards-lite refresh trigger: fire-and-forget at query entry;
      // this query proceeds on the current snapshot (see lite-refresh.ts).
      maybeRefresh?.();
      // Defensive defaults and validation: some callers (e.g. live MCP) may
      // bypass Zod and forward raw caller args. Coerce missing values to safe
      // defaults and clamp/whitelist invalid values rather than trusting Zod.
      const defenseWarnings: string[] = [];
      // Ordinary advisory warnings raised during argument inspection. Kept
      // apart from `defenseWarnings`, which is unshifted to the FRONT of the
      // list as "we ignored what you sent"; these report a well-formed request
      // that cannot match, so they belong in the normal warning order.
      const argWarnings: string[] = [];
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
      /**
       * Enum-SET coercion for `authorship`. `pickEnum` is string-only and
       * returns the whole fallback on a bad value, which for a filter would
       * silently WIDEN the result set — the wrong failure direction for an
       * argument whose purpose is exclusion. So an array drops invalid members
       * INDIVIDUALLY (naming each), deduplicates, collapses to `"any"` if
       * `"any"` appears anywhere, and only falls back to `"any"` when nothing
       * usable is left. Returns `"any"` (no narrowing) or the wanted set.
       */
      const pickEnumSet = <T extends string>(
        label: string,
        value: unknown,
        allowed: readonly T[],
      ): "any" | Set<T> => {
        // ONLY `undefined` is omission. An explicit `null` is a non-string,
        // non-array value and takes the warned fallback like any other junk.
        if (value === undefined) return "any";
        const isAllowed = (v: unknown): v is T =>
          typeof v === "string" && (allowed as readonly string[]).includes(v);
        const fallback = (): "any" => {
          defenseWarnings.push(`Ignored ${label}:${JSON.stringify(value)}; using ${label}:"any".`);
          return "any";
        };
        if (typeof value === "string") {
          if (value === "any") return "any";
          return isAllowed(value) ? new Set<T>([value]) : fallback();
        }
        if (!Array.isArray(value)) return fallback();

        const kept = new Set<T>();
        const dropped: unknown[] = [];
        let sawAny = false;
        for (const member of value) {
          if (member === "any") {
            sawAny = true;
            continue;
          }
          if (isAllowed(member)) kept.add(member);
          else dropped.push(member);
        }
        if (dropped.length > 0) {
          defenseWarnings.push(
            `Ignored invalid ${label} value${dropped.length === 1 ? "" : "s"} ${dropped
              .map((d) => JSON.stringify(d))
              .join(", ")}.`,
          );
        }
        if (sawAny) return "any";
        if (kept.size === 0) {
          defenseWarnings.push(`Ignored empty ${label}; using ${label}:"any".`);
          return "any";
        }
        return kept;
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

      // Runtime default: ephemeral mode resolves an omitted/invalid scope to
      // "project" (metadata-only ranking over the global corpus is noise);
      // persistent mode keeps "global". Under both parsed and raw execution
      // `args.scope === undefined` reliably means "not supplied" (the
      // ephemeral schema has no Zod default to materialize).
      const scope = pickEnum(
        "scope",
        args.scope,
        ["session", "project", "global"] as const,
        mode ? "project" : "global",
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
      // `role` is transport-level and unchanged; `authorship` answers the
      // separate "who composed this" question (see src/authorship.ts).
      const authorshipSet = pickEnumSet("authorship", args.authorship, AUTHORSHIP_VALUES);
      const authorshipActive = authorshipSet !== "any";
      const authorshipFilter = authorshipSet === "any" ? undefined : authorshipSet;
      /** The normalized set is exactly `{human}` — the trigger for the
       *  selection-tier root-only restriction (step 5). `["human"]` triggers it;
       *  `["human","delegated"]` does not. */
      const humanOnly =
        authorshipSet !== "any" && authorshipSet.size === 1 && authorshipSet.has("human");
      /** Emit `why.authorship` / `topEvidence.authorship`. Gated so responses
       *  stay byte-identical when authorship is absent/"any" AND explain:false. */
      const emitAuthorship = authorshipActive || explain;
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
      // Family exclusion is opt-in: the default leaves the current session's
      // parent, siblings and subagents searchable. Anything but `true` reads
      // as unset.
      const excludeFamily = args.excludeFamily === true;
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
      // The schema caps `sessions` at MAX_SHORTLIST_SESSIONS, but the host may
      // bypass Zod (AGENTS.md), so clamp defensively here too.
      const explicitSessionsRaw = Array.isArray(args.sessions)
        ? [
            ...new Set(
              args.sessions
                .map((id) => optionalString(id))
                .filter((id): id is string => id !== undefined),
            ),
          ]
        : [];
      const explicitSessions = explicitSessionsRaw.slice(0, MAX_SHORTLIST_SESSIONS);
      if (explicitSessionsRaw.length > MAX_SHORTLIST_SESSIONS) {
        defenseWarnings.push(
          `sessions was truncated to the first ${MAX_SHORTLIST_SESSIONS} ids (${explicitSessionsRaw.length} given).`,
        );
      }
      const deepCursorRaw = optionalString(args.deepCursor);

      const fail = (error: string): string => writeError(error);

      // Required, but the host may bypass Zod. Not trimmed: a literal or
      // regex query searches exactly what was sent.
      if (typeof args.query !== "string" || args.query === "") {
        return fail("query is required");
      }

      // The normalized arguments, fingerprinted: a continuation resumes only
      // the search that issued it. Time arguments are kept as given (a
      // relative bound like "7d"), since the bounds they resolved to travel
      // in the continuation itself.
      const timeArg = (value: unknown): number | string | null =>
        typeof value === "number" ? value : (optionalString(value) ?? null);
      const argsFingerprint = cyrb53(
        JSON.stringify({
          query: args.query,
          scope,
          match: matchMode,
          explain,
          group: groupArg,
          type: partType,
          role,
          authorship: authorshipSet === "any" ? "any" : [...authorshipSet].sort(),
          fallback,
          expand: expandMode,
          expandResults: expandResultsArg,
          window: windowArg,
          width: widthArg,
          results: resultsArg,
          expandBudgetMessages: expandBudgetMessagesArg ?? null,
          expandBudgetChars: expandBudgetCharsArg ?? null,
          sessionID: sessionID ?? null,
          title: title ?? null,
          directory: directory ?? null,
          project:
            args.project === true
              ? true
              : typeof args.project === "string"
                ? (optionalString(args.project) ?? null)
                : null,
          toolName: toolName ?? null,
          excludeSessionID: excludeSessionID ?? null,
          excludeCurrentSession: excludeExplicit ?? null,
          excludeFamily,
          sessionLimit: requestedSessions ?? null,
          deep: deepRequested,
          sessions: explicitSessions,
          deepCursor: deepCursorRaw ?? null,
          time: [
            args.after,
            args.before,
            args.since,
            args.until,
            args.last,
            args.from,
            args.to,
          ].map(timeArg),
          currentSession: currentSessionID ?? null,
        }),
      );
      // A non-string cursor reads as none.
      const cursorRaw = optionalString(args.cursor);
      let resume: RecallCursor | undefined;
      if (cursorRaw) {
        const decoded = decodeRecallCursor(cursorRaw);
        if (!decoded.ok) return fail(decoded.error);
        if (decoded.value.query !== argsFingerprint) {
          return fail(
            "This cursor continues a different search; pass it with that search's arguments, or search again without cursor",
          );
        }
        resume = decoded.value;
      }

      if (toolName && partType !== "all" && partType !== "tool") {
        return fail('toolName can only be used with type:"all" or type:"tool"');
      }

      // Empty-by-construction authorship combinations. Warnings, not errors:
      // the request is well-formed, it just cannot match anything.
      if (authorshipSet !== "any") {
        // With `type:"tool"` or a `toolName`, every candidate is a tool part —
        // which classifies `injected` on a user envelope and `model` on an
        // assistant one. Any set disjoint from those two matches nothing.
        const toolPartsOnly = partType === "tool" || toolName != null;
        if (toolPartsOnly && !authorshipSet.has("injected") && !authorshipSet.has("model")) {
          argWarnings.push(
            `authorship:${JSON.stringify([...authorshipSet])} with ${
              toolName ? "toolName" : 'type:"tool"'
            } matches nothing: tool parts classify only as "injected" or "model".`,
          );
        }
        // Mirror case: title candidates are only built when titles are
        // searchable at all, which happens before authorship ever runs.
        if (
          authorshipSet.size === 1 &&
          authorshipSet.has("title") &&
          !canSearchTitles(partType, toolName)
        ) {
          argWarnings.push(
            'authorship:"title" matches nothing with a type or toolName filter: session titles are only searched when type:"all" and no toolName is set.',
          );
        }
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
      // The family includes the current session, so excludeFamily carries
      // every contradiction excludeCurrentSession:true does, plus one with an
      // explicit excludeCurrentSession:false. A sessionID in the family is
      // checked once the cards are read, below.
      if (excludeFamily && scope === "session") {
        return fail(
          'excludeFamily cannot be combined with scope:"session"; the search would exclude its only target',
        );
      }
      if (excludeFamily && excludeExplicit === false) {
        return fail(
          "excludeFamily:true also excludes the current session, which excludeCurrentSession:false includes; drop one of them",
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
      normalized.warnings.push(...argWarnings);
      // A continuation re-runs with the bounds its search resolved, so a
      // relative bound does not move between the calls.
      const after = resume ? resume.after : normalized.after;
      const before = resume ? resume.before : normalized.before;

      ctx.metadata({
        title: `Searching ${scope} for "${args.query}"${matchMode !== "literal" ? ` (${matchMode})` : ""}`,
      });

      if (scope === "global" && !sessionID && !global) {
        return fail("Global scope disabled via plugin option: global: false");
      }

      try {
        const queryMeta = parseQuery(args.query);
        const commandLikeQuery =
          queryMeta.codeTokens.length > 0 || COMMAND_VERB_RE.test(args.query);
        const smartMode: "smart" | "fuzzy" = matchMode === "fuzzy" ? "fuzzy" : "smart";
        const searchTitles = canSearchTitles(partType, toolName);
        const filters: CandidateFilters = { type: partType, role, before, after, toolName };
        const eligibleFilter = candidateFilter(filters);
        const toolFilter = toolName ? compileToolFilter(toolName) : undefined;
        // Every filter but toolName: the drill counts the tool parts it admits
        // by name, so a toolName that matches none can say what is there.
        const countTools = toolFilter
          ? candidateFilter({ type: partType, role, before, after })
          : undefined;
        if (authorshipActive) pushUnique(normalized.limitedBy, "authorship");
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
          // Explicitness fork — NOT a redefinition of `projectScope`: the gate
          // counts only explicitly supplied, project-valued constraints (raw
          // scope "project", project:true), so a mode-defaulted resolved scope
          // never satisfies it. (Explicit scope "session" never sets
          // `bucketDirectory`; session-scoped deep passes via `hasSingleTarget`
          // below.) Unconditional in both modes — byte-identical in persistent,
          // and no mode branch in security-adjacent logic. `projectScope` and
          // all consumers of the RESOLVED scope keep the resolved value; that
          // is what makes the ephemeral default do anything. Used ONLY here.
          const explicitProjectScope = args.scope === "project" || args.project === true;
          const projectConstraint =
            directoryFilter != null || (explicitProjectScope && bucketDirectory != null);
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

        // Every branch reads the card map; only tier-1 ranking below waits for
        // the search index, so a search scoped to one session or a named list
        // never builds or updates it.
        await cards.ready();

        /** The current session's family (itself, its parent, siblings and
         *  subagents) from the card map, read once and only when needed. */
        let familyMemo: Set<string> | undefined;
        const currentFamily = (): Set<string> =>
          (familyMemo ??= currentSessionID
            ? cards.exclusionFamily(currentSessionID)
            : new Set<string>());
        if (excludeFamily && sessionID && currentFamily().has(sessionID)) {
          return fail(
            "sessionID targets a session excludeFamily:true excludes (the current session or its parent, a sibling or a subagent); drop one of them",
          );
        }
        /** The card filter for what the exclusion arguments remove: the whole
         *  family with excludeFamily, else the current session alone. */
        const exclusionFilter = (): Pick<CardFilters, "excludeFamilyOf" | "excludeSessionId"> => {
          if (!currentSessionID) return {};
          if (excludeFamily) return { excludeFamilyOf: currentSessionID };
          return excludeCurrent ? { excludeSessionId: currentSessionID } : {};
        };
        /** The session ids {@link exclusionFilter} removes. */
        const excludedIds = (): Set<string> => {
          if (!currentSessionID) return new Set<string>();
          if (excludeFamily) return currentFamily();
          return excludeCurrent ? new Set([currentSessionID]) : new Set<string>();
        };
        /** The relatives family diversity reorders: the family less the
         *  current session, empty when excludeFamily removed them anyway. */
        const relatives = (): Set<string> => {
          if (excludeFamily || !currentSessionID) return new Set<string>();
          const ids = new Set(currentFamily());
          ids.delete(currentSessionID);
          return ids;
        };

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
        // Semantic bookkeeping for the smart/fuzzy route (empty unless the tier-1
        // rank branch ran with the semantic layer active): per-session semantic
        // score, and the sessions the reserved-slot band pulled into the drill.
        const semanticBySession = new Map<string, number>();
        let semanticReserved: string[] = [];
        /** Cards tier-1 ranking left out because the index had yet to take
         *  their latest content (reported as `coverage.cards.pending`). */
        let cardsPending = 0;
        /** The relatives family diversity applies to (see `familyDiversity`):
         *  set only by tier-1 ranking, so a search of one session or of a
         *  named list keeps its order, and only without a time bound, since a
         *  time-bounded search asks for what happened in that window wherever
         *  it happened, the current session's subagents included. */
        let diversityFamily = new Set<string>();
        /** The relatives in {@link diversityFamily} the slim-index lookup
         *  found, which keep the family's drill slots and first results ahead
         *  of the others. */
        let familyIndexed = new Set<string>();
        /** Excluded sessions that matched, measured by tier-1 ranking. */
        let excludedMatches: ExcludedMatches | undefined;
        /** Sessions the authorship root-only restriction removed from selection,
         *  across BOTH selection paths (card ranking and the FTS admission
         *  chain). Kept as ids so the two paths cannot double-count the same
         *  session; reported as `skippedByReason.authorship`. */
        const authorshipSkippedIds = new Set<string>();
        // Child sessions the FTS admission chain dropped under `authorship:"human"`,
        // held until the shortlist cap is known so they can be counted the same
        // cap-aware way the ranked lane is. `ftsLaneAll` is the same lane with
        // those ids left IN, in iteration order — the counterfactual lane.
        const authorshipFtsDropped: string[] = [];
        const ftsLaneAll: string[] = [];

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
            // `Card.parentId` is two-state (`string | null`) — the distiller
            // collapses missing/non-string to `null`, so a card-backed target
            // reads `null` as root and can never express `unknown`. Accepted:
            // a card exists only for a session the distiller discovered.
            parentID: card.parentId,
            writeRev: card.writeRev,
          };
        };

        /** Build a target for an id — from its facade card when known, else a
         *  minimal blank target. Callers: the deep-resume path (facade-carded
         *  ids reconstituted from a cursor) and the deep singleTarget sweep.
         *  Uncarded shortlist ids do NOT come through here — they go through
         *  `resolveUncarded`, which probes live metadata (worker exclusion,
         *  time bounds, real title/directory). */
        const targetFor = (id: string): DrillTarget => {
          const card = cards.get(id);
          if (card) return registerTarget(card, relevanceOf(card));
          relevanceBySession.set(id, "unknown");
          searchedMeta.set(id, { id, title: "", directory: "" });
          // No metadata at all: `parentID` is deliberately OMITTED, which the
          // authorship classifier reads as `unknown` (never root). Fail-closed.
          return { sessionId: id, title: "", directory: "", timeUpdated: 0 };
        };

        /** Whether a card for the id ANYWHERE (live store first, facade
         *  fallback) names a summarizer worker. `cards.get()` hides worker
         *  cards by design (cards.ts), so the store read is what catches a
         *  persisted worker card here; in degraded mode (no store) a persisted
         *  worker card cannot exist, so the facade fallback suffices. */
        const workerCard = (id: string): boolean => {
          const c = (store ? store.getCard(id) : undefined) ?? cards.get(id);
          return c != null && isSummarizerTitle(c.title);
        };

        /** The `writeRev` of the session's card in the live store, for the
         *  targets built from live metadata rather than a snapshot card. The
         *  drill cache keys on it, so a re-index that leaves the session's
         *  `time.updated` alone still drops cached pages at once, even before
         *  the snapshot reloads. Undefined without a store, a card or a
         *  stamped write. */
        const liveWriteRev = (id: string): number | undefined => store?.cardWriteRev(id);

        /** The explicitly named ids to treat as UNCARDED. Uncarded-ness is
         *  decided from the SAME facade snapshot the carded filter reads
         *  (`cards.get`), NOT the live store: a just-carded session visible in
         *  the store but not yet in the ≤5s-stale snapshot must still be
         *  drilled (honestly, with a warning), never silently dropped — that
         *  would reopen the original bug in its exact target scenario. This
         *  also keeps the carded and uncarded lists structurally disjoint. */
        const uncardedShortlist = (ids: string[]): string[] =>
          ids.filter((id) => id !== excludeSessionID && cards.get(id) == null && !workerCard(id));

        /** The named sessions (`sessions:` and a deep cursor's targets) the
         *  exclusion arguments remove, carded or not. Naming a session asks
         *  for it, so the implicit default exclusion does not apply: dropping
         *  a young, uncarded own session there would leave a search with
         *  nothing to drill. An explicit excludeCurrentSession:true removes
         *  the current session, and excludeFamily:true its whole family. */
        let namedExcludedMemo: Set<string> | undefined;
        const namedExcluded = (): Set<string> =>
          (namedExcludedMemo ??= !currentSessionID
            ? new Set<string>()
            : excludeFamily
              ? currentFamily()
              : excludeExplicit === true
                ? new Set([currentSessionID])
                : new Set<string>());
        /** `ids` less the ones {@link namedExcluded} removes, each counted as
         *  an `excludedSession` skip. Runs before any target slot is taken. */
        const dropNamedExcluded = (ids: string[]): string[] => {
          const excluded = namedExcluded();
          if (excluded.size === 0) return ids;
          const kept = ids.filter((id) => !excluded.has(id));
          const dropped = ids.length - kept.length;
          if (dropped > 0) {
            skippedByReason.excludedSession = (skippedByReason.excludedSession ?? 0) + dropped;
            pushUnique(normalized.limitedBy, "excludedSession");
          }
          return kept;
        };

        /** One uncarded id's metadata probe: the project scope first, then one
         *  retry at GLOBAL scope — workers and cross-project sessions
         *  live outside the caller's directory scope, so the retry closes most
         *  "probe failed → admitted unverified" gaps (including a worker whose
         *  scoped fetch 404s). Only when BOTH fail is the id admitted
         *  unverified (fail-open: reachability of a caller-named session
         *  outweighs the residual risk, which the warning reports). */
        const probeMeta = async (
          id: string,
        ): Promise<
          | {
              title: string;
              directory: string;
              created: number;
              updated: number;
              parentID: string | null;
            }
          | undefined
        > => {
          const probeScopes: SessionScope[] = source.scopedLookup
            ? ["project", "global"]
            : ["project"];
          for (const scope of probeScopes) {
            try {
              const sess = await gate.runQuery(() => source.getSession(id, { scope }));
              if (sess.ok) {
                const data = sess.value;
                return {
                  title: data.title,
                  directory: data.directory,
                  created: data.time.created,
                  updated: data.time.updated,
                  // A SUCCESSFUL fetch whose `parentID` is absent means root,
                  // so it maps to `null` — never `undefined` (which is reserved
                  // for "no metadata"). Read defensively: host rows are not
                  // validated against the type.
                  parentID: typeof data.parentID === "string" ? data.parentID : null,
                };
              }
            } catch {
              // Try the next scope / fall through to unverified.
            }
          }
          return undefined;
        };

        /** Resolve uncarded shortlist ids into drill targets via live metadata
         *  probes ({@link probeMeta}). On success: a summarizer worker title
         *  excludes the id entirely (a truly-uncarded worker cannot be caught
         *  by the card-title checks, and its content — plain user/assistant
         *  text — would otherwise sail through the extract-level part
         *  filters), and before/after bounds keep the sessions that overlap the
         *  window (`time.created` and `time.updated`). On
         *  double failure: a minimal unverified target with selection bounds
         *  bypassed — the warning says so.
         *
         *  Lazy + bounded: probes run in parallel chunks of {@link PROBE_CHUNK}
         *  and stop once `wanted` targets are admitted (excluded ids — worker
         *  or out-of-bounds — do not count toward `wanted`, so probing
         *  continues past them). Ids never probed are returned as `unprobed`
         *  for the cap-truncation warning. */
        const resolveUncarded = async (
          ids: string[],
          wanted: number,
        ): Promise<{
          resolved: Array<{ target: DrillTarget; verified: boolean }>;
          unprobed: number;
        }> => {
          const resolved: Array<{ target: DrillTarget; verified: boolean }> = [];
          let index = 0;
          while (index < ids.length && resolved.length < wanted && !ctx.abort.aborted) {
            const chunk = ids.slice(index, index + PROBE_CHUNK);
            index += chunk.length;
            const metas = await Promise.all(chunk.map(probeMeta));
            for (let i = 0; i < chunk.length; i++) {
              if (resolved.length >= wanted) {
                // Probed but over the cap: count as unprobed for the warning —
                // it genuinely was not searched. (The rewind can never go
                // negative: index === chunkStart + chunk.length here and we
                // subtract at most chunk.length.)
                index -= chunk.length - i;
                break;
              }
              const id = chunk[i]!;
              const meta = metas[i];
              if (meta) {
                if (isSummarizerTitle(meta.title)) continue; // worker: never a target
                // The session overlaps the window, as `CardFilters` keeps it.
                if (after != null && meta.updated < after) continue;
                if (before != null && meta.created > before) continue;
                relevanceBySession.set(id, "unknown");
                searchedMeta.set(id, { id, title: meta.title, directory: meta.directory });
                resolved.push({
                  target: {
                    sessionId: id,
                    title: meta.title,
                    directory: meta.directory,
                    timeUpdated: meta.updated,
                    parentID: meta.parentID,
                    writeRev: liveWriteRev(id),
                  },
                  verified: true,
                });
              } else {
                relevanceBySession.set(id, "unknown");
                searchedMeta.set(id, { id, title: "", directory: "" });
                // Both probes failed: `parentID` is OMITTED → `unknown`, never
                // root. An unverified target must not be able to claim `human`.
                resolved.push({
                  target: {
                    sessionId: id,
                    title: "",
                    directory: "",
                    timeUpdated: 0,
                    writeRev: liveWriteRev(id),
                  },
                  verified: false,
                });
              }
            }
          }
          return { resolved, unprobed: ids.length - index };
        };

        /** Honest-coverage warning for shortlist ids selected without a card.
         *  "No card visible" covers both real states: not yet indexed, or
         *  carded so recently that this reader's snapshot has not seen it. */
        const warnUncarded = (count: number, unverified: number): void => {
          let msg = `${count} session id${count === 1 ? "" : "s"} in the shortlist ${count === 1 ? "has" : "have"} no card visible to this search yet (not yet indexed, or the index snapshot lags); ${count === 1 ? "it was" : "they were"} selected for direct drilling.`;
          if (unverified > 0) {
            msg += ` ${unverified} could not be verified (metadata fetch failed), so selection time bounds were not applied.`;
          }
          normalized.warnings.push(msg);
        };

        /** Distinct honest warning for named ids never reached under the cap. */
        const warnCapDropped = (count: number): void => {
          normalized.warnings.push(
            `${count} named session id${count === 1 ? "" : "s"} ${count === 1 ? "was" : "were"} not searched: the session cap was reached.`,
          );
        };

        const singleTarget = sessionID ?? (scope === "session" ? currentSessionID : undefined);
        if (scope === "session" && !singleTarget) {
          return fail("No sessionID provided and no current session available");
        }

        if (!deepMode && singleTarget) {
          let sTitle = "";
          let sDir = "";
          let sUpdated = 0;
          // Stays `undefined` unless the fetch succeeds: no metadata →
          // `unknown` parentage, never root.
          let sParent: string | null | undefined;
          try {
            const sess = await gate.runQuery(() =>
              source.getSession(singleTarget, { scope: "project" }),
            );
            if (sess.ok) {
              const data = sess.value;
              sTitle = data.title;
              sDir = data.directory;
              sUpdated = data.time.updated;
              sParent = typeof data.parentID === "string" ? data.parentID : null;
            }
          } catch {
            // Proceed without metadata; drill still fetches the session's parts.
          }
          drillTargets = [
            {
              sessionId: singleTarget,
              title: sTitle,
              directory: sDir,
              timeUpdated: sUpdated,
              parentID: sParent,
              writeRev: liveWriteRev(singleTarget),
            },
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

          if (deepCursor) {
            // Resume from an UNTRUSTED cursor: keep only ids the card store knows
            // (or that an accompanying `sessions` arg explicitly allows), cap the
            // total, and report anything dropped. Resume stays stateless — the
            // cursor is the only carry-over, so a proportionate validation here is
            // the whole defense. The exclusion arguments drop their sessions
            // before the cap counts any.
            const order = dropNamedExcluded(
              deepCursor.current
                ? [deepCursor.current, ...deepCursor.remaining]
                : [...deepCursor.remaining],
            );
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
            // Kept ids split by how they were admitted: facade-carded ids
            // reconstitute directly from their card, while explicit-only ids
            // (readmitted purely via the repeated `sessions` arg) get the SAME
            // guards as a fresh uncarded shortlist — worker exclusion, live
            // metadata probe, time bounds, warning.
            // Without this split a resume would bypass every uncarded guard.
            // Snapshot carded-ness ONCE before the await: cards.get refreshes
            // the card map, so two reads straddling the probe could disagree
            // (present→absent would drop an id with no warning).
            const cardedIds = new Set(kept.filter((id) => cards.get(id) != null));
            const explicitOnly = uncardedShortlist(kept.filter((id) => !cardedIds.has(id)));
            const { resolved } = await resolveUncarded(explicitOnly, explicitOnly.length);
            const resolvedById = new Map(resolved.map((r) => [r.target.sessionId, r] as const));
            drillTargets = [];
            for (const id of kept) {
              if (cardedIds.has(id)) drillTargets.push(targetFor(id));
              else {
                const r = resolvedById.get(id);
                if (r) drillTargets.push(r.target);
                // else: excluded by the uncarded guards (worker/bounds).
              }
            }
            if (resolved.length > 0) {
              warnUncarded(resolved.length, resolved.filter((r) => !r.verified).length);
            }
            if (dropped.length > 0) {
              const sample = dropped.slice(0, 3).join(", ");
              normalized.warnings.push(
                `Deep resume dropped ${dropped.length} session id${dropped.length === 1 ? "" : "s"} not in the card store${dropped.length > MAX_RESUME_TARGETS ? " (over the resume cap)" : ""}: ${sample}${dropped.length > 3 ? ", …" : ""}. If a dropped id was named in the original sessions arg, repeat sessions:[...] alongside the cursor.`,
              );
            }
          } else if (explicitSessions.length > 0) {
            const named = dropNamedExcluded(explicitSessions);
            const namedSet = new Set(named);
            const scoped = cards.list(timeFilters).filter((card) => namedSet.has(card.sessionId));
            drillTargets = scoped
              .filter((card) => card.sessionId !== excludeSessionID)
              .map((card) => registerTarget(card, relevanceOf(card)));
            // Explicitly named ids the facade snapshot has no card for (young
            // session the distiller has not carded, or carded-so-recently the
            // snapshot is stale) are swept anyway — the caller named them.
            // A live metadata probe excludes summarizer workers and applies
            // time bounds; a failed probe falls back to a bounds-bypassed
            // sweep. Carded-but-filtered ids are NOT resurrected here (they
            // have metadata and were filtered).
            const uncarded = uncardedShortlist(named);
            if (uncarded.length > 0) {
              // Deep has no session-count cap; the shortlist schema max is the
              // bound on this probe fan-out.
              const { resolved } = await resolveUncarded(uncarded, uncarded.length);
              if (resolved.length > 0) {
                drillTargets = [...drillTargets, ...resolved.map((r) => r.target)];
                warnUncarded(resolved.length, resolved.filter((r) => !r.verified).length);
              }
            }
          } else if (singleTarget) {
            // Explicit sessionID / scope:"session" → sweep exactly that session.
            if (singleTarget !== excludeSessionID) drillTargets = [targetFor(singleTarget)];
          } else {
            // since + project/directory constraint (validated by the scope gate).
            const scoped = cards.list({ ...timeFilters, ...exclusionFilter() }).filter((card) => {
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
          const named = dropNamedExcluded(explicitSessions);
          const wanted = new Set(named);
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
          // Explicitly named ids the facade snapshot has no card for (young
          // session the distiller has not carded, or carded-so-recently the
          // snapshot is stale) are drilled anyway — the caller named them.
          // A live metadata probe excludes summarizer workers and applies
          // before/after bounds; a failed probe falls back to a bounds-
          // bypassed drill. The title filter never applies to uncarded ids —
          // the caller named them explicitly. Carded-but-filtered ids are
          // NOT resurrected (they have metadata and were filtered).
          // Uncarded ids rank last: carded members fill the cap first.
          const cardedTargets = scopedCards
            .filter((card) => card.sessionId !== excludeSessionID)
            .slice(0, cap)
            .map((card) => registerTarget(card, relevanceOf(card)));
          // Probe lazily: only as many uncarded ids as the cap leaves room for
          // are resolved; the unprobed remainder is reported, not fetched.
          const uncarded = uncardedShortlist(named);
          const remaining = Math.max(0, cap - cardedTargets.length);
          const { resolved: uncardedTaken, unprobed } =
            uncarded.length > 0
              ? await resolveUncarded(uncarded, remaining)
              : { resolved: [], unprobed: 0 };
          if (uncardedTaken.length > 0) {
            warnUncarded(uncardedTaken.length, uncardedTaken.filter((r) => !r.verified).length);
          }
          if (unprobed > 0) warnCapDropped(unprobed);
          drillTargets = [...cardedTargets, ...uncardedTaken.map((r) => r.target)];
          deepSet = new Set(drillTargets.map((t) => t.sessionId));
          sessionsEligible = scopedCards.length + uncardedTaken.length + unprobed;
          shortlistIDs = drillTargets.map((t) => t.sessionId);
          // Counted only when the list names it and the exclusion arguments
          // have not dropped (and counted) it already.
          if (excludeSessionID && named.includes(excludeSessionID)) {
            skippedByReason.excludedSession = (skippedByReason.excludedSession ?? 0) + 1;
            pushUnique(normalized.limitedBy, "excludedSession");
          }
          if (sessionsEligible > drillTargets.length) {
            pushUnique(normalized.limitedBy, "sessionsLimit");
          }
          if (scope !== "global") pushUnique(normalized.limitedBy, "scope");
        } else {
          // ── Tier 1: rank cards ──
          const cardFilters: CardRankFilters = { ...exclusionFilter() };
          if (after != null) cardFilters.since = after;
          if (before != null) cardFilters.until = before;
          // Selection-tier win for the dominant contaminant: under
          // authorship:{human} a child session can contribute no result at all,
          // so drop it from ranking and let a root session take the slot. The
          // type fence (CardRankFilters) keeps this off every `cards.list`
          // caller, which must never drop a session named by id.
          if (humanOnly) cardFilters.rootOnly = true;
          // Coverage for that restriction comes back from the ranking pass
          // itself, which already knows which cards it discarded and whether
          // they had any signal. The directory/scope bucketing below is applied
          // to them here, since `rank` never sees it. The same pass counts the
          // cards it left out because the index had yet to take them.
          const rankStats: RankStats = { rootOnlySkipped: [] };
          await cards.ready({ index: true });
          let cardHits: CardHit[] = cards.rank(queryMeta, cardFilters, rankStats);
          cardsPending = rankStats.pending ?? 0;

          // Hoisted so the authorship skip accounting below applies the exact
          // same title predicate `eligible` did, instead of over-counting a
          // child card that the title filter would have removed anyway.
          const titleLower = title ? title.toLowerCase() : undefined;
          const passesTitle = (card: Card): boolean =>
            titleLower === undefined || card.title.toLowerCase().includes(titleLower);

          if (title) {
            cardHits = cardHits.filter((hit) => passesTitle(hit.card));
            pushUnique(normalized.limitedBy, "title");
          }

          // ── Directory / project bucketing (reuses the old relevance machinery) ──
          let eligible = cardHits.map((hit) => ({ hit, relevance: relevanceOf(hit.card) }));
          // Which relevance buckets this query actually kept. Recorded so the
          // authorship skip accounting below is measured against exactly the
          // same population `eligible` is, instead of the whole store.
          const keptRelevances = new Set<DirectoryRelevance>([
            "exact",
            "project",
            "global",
            "unknown",
          ]);
          if (bucketDirectory) {
            pushUnique(normalized.limitedBy, directoryFilter ? "directory" : "scope");
            const exact = eligible.filter((e) => e.relevance === "exact");
            const proj = eligible.filter((e) => e.relevance === "project");
            const glob = eligible.filter((e) => e.relevance === "global");
            if (directoryFilter && fallback) {
              // `eligible` is rebuilt from the three named buckets, so an
              // "unknown"-relevance card is dropped here too.
              keptRelevances.delete("unknown");
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
              keptRelevances.delete("global");
              keptRelevances.delete("unknown");
              eligible = [...exact, ...proj];
              directoryBucketsSearched = [
                ...(exact.length > 0 ? (["exact"] as const) : []),
                ...(proj.length > 0 ? (["project"] as const) : []),
              ];
              if (glob.length > 0) skippedByReason.directory = glob.length;
            } else {
              keptRelevances.delete("project");
              keptRelevances.delete("global");
              keptRelevances.delete("unknown");
              eligible = exact;
              directoryBucketsSearched = exact.length > 0 ? ["exact"] : [];
              const skipped = proj.length + glob.length;
              if (skipped > 0) skippedByReason.directory = skipped;
            }
          }

          // The restriction's coverage entry: cards that would have ranked, and
          // that this query's OTHER selection guards (title, directory
          // bucketing) would also have kept. Counting a card that another
          // guard would have removed anyway would misattribute the skip.
          //
          // The FTS injection below applies the directory guard but NOT `title`
          // — that path has never gated admission on `title` — so a child it
          // drops genuinely was in contention there and is counted. The two
          // paths therefore attribute against their own admission rules, which
          // is the honest reading; they dedupe into one id set.
          //
          // Held for later: the count is only meaningful once the shortlist cap
          // is known (see the counterfactual merge below, which fills
          // `authorshipSkippedIds`), because "carried a signal" admits nearly
          // every card when semantic ranking is on.
          const skippedContenders = rankStats.rootOnlySkipped.filter(
            (s) => passesTitle(s.card) && keptRelevances.has(relevanceOf(s.card)),
          );
          // Excluded sessions that matched the query, kept to the same
          // selection guards; the slim-index lookup below adds the ones only
          // its rows match.
          const excludedMatched = new Set(
            (rankStats.excludedMatched ?? [])
              .filter((card) => passesTitle(card) && keptRelevances.has(relevanceOf(card)))
              .map((card) => card.sessionId),
          );

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

          // Pure-semantic ordering for the reserved shortlist band: the eligible
          // cards the semantic layer scored, highest cosine first. Empty unless
          // the card runtime ran with semantic active (each hit then carries a
          // `semanticScore`); the lexical-only path leaves it empty, so the
          // reservation and everything downstream of it is a no-op.
          for (const e of eligible) {
            if (e.hit.semanticScore != null)
              semanticBySession.set(e.hit.sessionId, e.hit.semanticScore);
          }
          const semanticIds =
            semanticBySession.size > 0
              ? [...semanticBySession.entries()]
                  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                  .map(([id]) => id)
              : [];

          // ── Tier 1.5: FTS needle lookup — inject sessions whose card missed the anchor ──
          const ftsOnly: string[] = [];
          const strongAnchors = [...queryMeta.codeTokens, ...queryMeta.phrases];
          /** The lookup's rows in its order, kept for the family's preference. */
          let ftsRows: FtsHit[] = [];
          if (store) {
            const rows = store.ftsSearch({ strong: strongAnchors, weak: queryMeta.tokens });
            ftsRows = rows;
            ftsBySession = new Map<string, FtsHit[]>();
            for (const row of rows) {
              const list = ftsBySession.get(row.sessionId);
              if (list) list.push(row);
              else ftsBySession.set(row.sessionId, [row]);
            }
            const ftsExcluded = excludedIds();
            for (const id of ftsBySession.keys()) {
              if (eligibleIdSet.has(id)) continue;
              if (id === excludeSessionID) continue;
              const card = store.getCard(id);
              if (!card) continue;
              // A direct store read bypasses the card runtime's filter, so a stray
              // worker card (crash leftover) must be rejected here too.
              if (isSummarizerTitle(card.title)) continue;
              // The session overlaps the window, as `CardFilters` keeps it.
              if (after != null && card.timeUpdated < after) continue;
              if (before != null && card.timeCreated > before) continue;
              const relevance = relevanceOf(card);
              if (bucketDirectory) {
                if (relevance === "global" && !(directoryFilter && fallback)) continue;
                if (relevance === "project" && !(projectScope || (directoryFilter && fallback))) {
                  continue;
                }
              }
              // After the guards above, so only a session they would have
              // admitted counts as an excluded match (one the roots-only
              // restriction below would drop anyway does not).
              if (ftsExcluded.has(id)) {
                if (!(humanOnly && parentageOf(card.parentId) === "child")) excludedMatched.add(id);
                continue;
              }
              // This path never goes through `cards.rank`/`CardFilters`, so the
              // roots-only restriction needs its own check here. Not marginal:
              // FTS rows are the human-text class, exactly where delegated
              // prompts live, so child sessions arrive disproportionately via
              // `ftsOnly` for prompt-shaped queries. Placed LAST so the count
              // only claims sessions the other guards would have admitted —
              // consistent with the card-rank count above. Held rather than
              // counted: like the ranked lane, this only becomes a meaningful
              // number once the shortlist cap is known.
              if (humanOnly && parentageOf(card.parentId) === "child") {
                authorshipFtsDropped.push(id);
                // Recorded in ITERATION order, interleaved with the admitted
                // ids, because `mergeShortlist` reserves a prefix of this lane.
                // Appending the dropped ids afterwards instead would demote them
                // behind every admitted id and systematically under-count the
                // lane this check exists for.
                ftsLaneAll.push(id);
                continue;
              }
              ftsLaneAll.push(id);
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
          const semanticSlots = semanticIds.length > 0 ? limits.semanticSlots : 0;
          if (after == null && before == null) diversityFamily = relatives();
          // The current session's relatives take at most a share of the drill
          // slots, so subagents that echo the query cannot crowd out other
          // history. The ones the slim-index lookup found keep those slots
          // first, in its order: a card ranks a relative on the words it
          // shares with the query, which a subagent's prompt often does, while
          // a slim-index row is a match in the session's own text. Only rows
          // matched on the query's code tokens or phrases count, since the
          // lookup ANDs those but ORs plain words, where any word matches and
          // its order favors short rows such as a prompt restating the query.
          // A row in a subagent's first message, the prompt its orchestrator
          // wrote, does not count either. A row with no previous message is in
          // the oldest message its card's write read, which is the session's
          // first unless that read stopped at the per-session row cap. An
          // opencode v2 write records such a stop as the checkpoint's floor,
          // so a card with one has no prompt row; a v1 write records none, so
          // a capped v1 subagent's oldest message read counts as its prompt.
          // A subtask part or a later prompt cannot be told apart from the
          // session's own text by its row.
          const familyRanked = [...eligibleIds, ...ftsOnly];
          const candidates = new Set(familyRanked);
          const promptRow = (row: FtsHit): boolean => {
            if (row.prevMessageId !== null) return false;
            const card = cardById.get(row.sessionId);
            return (
              parentageOf(card?.parentId) === "child" &&
              inspectCheckpoint(card?.distillCursor)?.floor === undefined
            );
          };
          const familyFound =
            buildMatch(strongAnchors, []) === null
              ? []
              : [
                  ...new Set(
                    ftsRows
                      .filter(
                        (row) =>
                          diversityFamily.has(row.sessionId) &&
                          candidates.has(row.sessionId) &&
                          !promptRow(row),
                      )
                      .map((row) => row.sessionId),
                  ),
                ];
          familyIndexed = new Set(familyFound);
          const capFamily = (ids: string[]): string[] =>
            diversityFamily.size > 0
              ? capFamilySlots(
                  ids,
                  familyRanked,
                  diversityFamily,
                  familyDrillSlots(cap),
                  familyFound,
                )
              : ids;
          const mergedIds = capFamily(
            mergeShortlist(eligibleIds, ftsOnly, semanticIds, cap, semanticSlots),
          );

          // How many child sessions the roots-only restriction cost the
          // shortlist: re-run the real `mergeShortlist` with the dropped
          // children restored and count the restored ids that land in it.
          //
          // Why not just count every child that carried a signal: that is
          // technically true and practically useless. Semantic scoring maps
          // cosine to [0,1], so nearly every card scores above zero and the
          // number collapses to "every child session in the store" (4,488 of
          // 4,978 on a real corpus), swamping `sessionsSkipped`, whose other
          // keys are all post-ranking and small.
          //
          // This is a close APPROXIMATION, not a proof, and it is a diagnostic
          // counter rather than behavior. Three known imprecisions, all small
          // and all in the under-reporting direction except the first:
          //   - the ranked lane is rebuilt in pure score order, while the real
          //     lane is bucket-major (exact, then project, then global) when
          //     directory bucketing is on, so a restored card can place higher
          //     or lower than it truly would;
          //   - `semanticIds` is derived from the post-restriction ranking, so
          //     a restored child can never claim a reserved semantic slot;
          //   - `rank`'s recency near-miss fallback records no skips, so a
          //     zero-signal query attributes nothing.
          // Only the top `cap` of the ranked restore list can reach a shortlist
          // of size `cap`, so it is sliced before the merge. That bounds the
          // MERGE by the cap; collecting and sorting the contenders is still
          // O(children). Measured on a 4,580-child store with a code-token
          // query: +0.46ms over an unrestricted rank, against a 50ms budget.
          if (skippedContenders.length > 0 || authorshipFtsDropped.length > 0) {
            const restoredCards = [...skippedContenders]
              .sort((a, b) => b.score - a.score)
              .slice(0, cap);
            const rankedRestored = new Set(restoredCards.map((s) => s.card.sessionId));
            const restoredIds = new Set([...rankedRestored, ...authorshipFtsDropped]);
            const counterfactualCardIds = [
              ...eligible.map((e) => ({ id: e.hit.sessionId, score: e.hit.score })),
              ...restoredCards.map((s) => ({ id: s.card.sessionId, score: s.score })),
            ]
              .sort((a, b) => b.score - a.score)
              .map((e) => e.id);
            // A child that is both a rank contender and an FTS hit would have
            // been skipped by the FTS loop (`eligibleIdSet`), so it must not
            // inflate the FTS lane and earn a bigger reserved band. Keyed on
            // EVERY contender, not the cap-sliced restore list: a beyond-cap
            // contender cannot win a card-lane slot either, so excluding it
            // from both lanes is faithful, not merely cheaper.
            const rankedContenders = new Set(skippedContenders.map((s) => s.card.sessionId));
            const counterfactualFts = ftsLaneAll.filter((id) => !rankedContenders.has(id));
            const counterfactual = mergeShortlist(
              counterfactualCardIds,
              counterfactualFts,
              semanticIds,
              cap,
              semanticSlots,
            );
            for (const id of counterfactual) {
              if (restoredIds.has(id)) authorshipSkippedIds.add(id);
            }
          }
          // Which sessions the semantic reservation actually surfaced: the ids in
          // the shortlist that the lexical-only merge would NOT have selected.
          // These are the rescue-eligible / semantically-contributed sessions —
          // a lexically-strong card that also scores well semantically is NOT
          // counted, since it would be here regardless.
          if (semanticSlots > 0) {
            const lexicalOnly = new Set(
              capFamily(mergeShortlist(eligibleIds, ftsOnly, [], cap, 0)),
            );
            semanticReserved = mergedIds.filter((id) => !lexicalOnly.has(id));
          }
          drillTargets = mergedIds
            .filter((id) => id !== excludeSessionID)
            .map((id) => {
              const card = cardById.get(id);
              // This is the DEFAULT recall path: it builds target literals
              // inline rather than through `registerTarget`, so parentage has
              // to be read here too. `cardById` is populated from both the
              // eligible cards and the FTS injection; a missing card leaves
              // `parentID` undefined → `unknown` (fail-closed).
              return {
                sessionId: id,
                title: card?.title ?? "",
                directory: card?.directory ?? "",
                timeUpdated: card?.timeUpdated ?? 0,
                parentID: card?.parentId,
                writeRev: card?.writeRev,
              };
            });

          if (excludeSessionID) {
            skippedByReason.excludedSession = (skippedByReason.excludedSession ?? 0) + 1;
            pushUnique(normalized.limitedBy, "excludedSession");
          }
          if (authorshipSkippedIds.size > 0) {
            skippedByReason.authorship =
              (skippedByReason.authorship ?? 0) + authorshipSkippedIds.size;
          }
          const shortlistSkipped = Math.max(0, eligibleIds.length - drillTargets.length);
          if (requestedSessions != null && sessionsEligible > requestedSessions) {
            pushUnique(normalized.limitedBy, "sessionsLimit");
          }
          if (shortlistSkipped > 0) {
            skippedByReason.sessionsLimit = (skippedByReason.sessionsLimit ?? 0) + shortlistSkipped;
          }
          const excluded = excludedIds();
          if (currentSessionID && excluded.size > 0) {
            // Count the sessions the exclusion removed from ranking (the
            // current session, or its whole family with excludeFamily) so
            // coverage reports the skip.
            let excludedKnown = 0;
            for (const id of excluded) {
              if (!store || store.getCard(id)) excludedKnown++;
            }
            if (excludedKnown > 0) {
              pushUnique(normalized.limitedBy, "excludedSession");
              skippedByReason.excludedSession =
                (skippedByReason.excludedSession ?? 0) + excludedKnown;
            }
            // excludeSessionID removes its session whatever the exclusion
            // arguments say, so it is not one they would let back in.
            if (excludeSessionID) excludedMatched.delete(excludeSessionID);
            const current = excludedMatched.has(currentSessionID);
            excludedMatches = { current, relatives: excludedMatched.size - (current ? 1 : 0) };
          }
          if (scope !== "global") pushUnique(normalized.limitedBy, "scope");
        }

        if (ctx.abort.aborted) return fail("aborted");

        const currentSessionExcluded = Boolean(
          excludeCurrent && currentSessionID && (store ? store.getCard(currentSessionID) : true),
        );
        drillTargets = drillTargets.filter((t) => t.sessionId !== excludeSessionID);
        // An unreadable history source (v2: opencode.db unavailable) cannot be
        // drilled or swept. The selected sessions are still searched, through
        // their cards: the card drill builds each session's pool from its
        // title and first request, and the ordinary routes rank, filter and
        // group those exactly as drilled parts. Results are card-quality;
        // coverage.source and a warning say why.
        const sourceUnavailable = source.unavailable;
        const activeDrill =
          sourceUnavailable === undefined
            ? drill
            : createCardDrill(cards, {
                filters,
                authorshipNarrowed: authorshipFilter !== undefined,
              });
        if (sourceUnavailable !== undefined) {
          if (deepMode) pushUnique(normalized.limitedBy, "deep");
          normalized.warnings.push(
            `${unavailableHistoryError(sourceUnavailable)}. Results come from the session cards only (title and first request)${deepMode ? "; the deep sweep was skipped" : ""}; message content cannot be read until it is available.`,
          );
        }

        // The drill and the sweep read toward the time window; the filter
        // still applies it to every candidate.
        const timeWindow: TimeWindow | undefined =
          after != null || before != null
            ? { ...(after != null && { after }), ...(before != null && { before }) }
            : undefined;
        const drillInput = {
          sessions: drillTargets,
          deepSet,
          ftsBySession,
          ...(timeWindow && { window: timeWindow }),
          query: queryMeta,
          explain,
          filter: eligibleFilter,
          ...(countTools && { countTools }),
          searchTitles,
          authorship: authorshipFilter,
          abort: ctx.abort,
        };
        const abortedOutput = (): string => fail("aborted");

        const cardsCoverage = cards.coverage();
        const indexing = deps.indexing?.();
        // Semantic diagnostics: static status from the card runtime (ready,
        // model, weight, vector count), always present when semantic is
        // configured on; `contributed` is filled per route in finish() from the
        // returned results. The set of sessions the semantic reservation
        // surfaced is `semanticReserved` (populated only in the tier-1 branch).
        const semanticStatus = cards.semanticStatus();
        const semanticReservedSet = new Set(semanticReserved);
        if (deps.discoveryTruncated?.()) {
          pushUnique(normalized.limitedBy, "providerLimit");
          normalized.warnings.push(
            "Session discovery stopped at its limit, so older sessions may not be indexed and their history is not searched.",
          );
        }
        if (cardsCoverage.degraded) {
          // Mode-gated wording: configured ephemeral operation is not damage.
          // The driver-missing degraded path keeps its wording byte-identical
          // (the eval pins /metadata-only|degraded/i; the ephemeral wording
          // intentionally matches neither).
          normalized.warnings.push(
            mode
              ? "Ephemeral mode (configured): session cards are metadata-quality; content matches come from live drill, not a persistent index."
              : "Cards are metadata-only (card store unavailable); content search is degraded.",
          );
        } else if (indexing) {
          // A running cold pass: the card counts alone read as complete while
          // older sessions are not even carded yet.
          normalized.warnings.push(indexingWarning(indexing));
        } else if (cardsCoverage.fullCards < cardsCoverage.totalCards) {
          normalized.warnings.push(
            "The card store is still distilling; some sessions are metadata-only until it completes.",
          );
        }
        // The drift and repair warnings go here, after the store's own, but
        // are read only once the query's reads are done (see finish()).
        const historyWarningsAt = normalized.warnings.length;

        // ── Build coverage + the finish() machinery from a drill result ──
        const buildOutputContext = (
          drilledSessions: string[],
          pools: DrilledPool[],
          targets: DrillTargetStats[],
          loadErrors: string[],
          budgetExhausted: boolean,
        ): {
          coverage: SearchCoverage;
          searchedSessions: Array<{ id: string; title: string; directory: string }>;
          loadErrorCount: number;
          incomplete: boolean;
          /** Statement half of the empty-pool warning, when the authorship pass
           *  emptied at least one drilled session. finish() adds the advice. */
          authorshipEmptied?: string;
          /** Tool parts per name across the pools, under a `toolName` filter. */
          toolCounts?: ReturnType<typeof poolToolNames>;
        } => {
          let partsSearched = 0;
          let authorshipEmptied: string | undefined;
          for (const pool of pools) {
            for (const candidate of pool.candidates) {
              if (candidate.partType !== "title") partsSearched++;
            }
          }
          // Authorship narrowed everything away: say so, naming the buckets and
          // counts, so an empty answer is not read as "no such history". Lives
          // here rather than per-route so it reaches every route — including
          // the single-target branch a subagent's scope:"session" +
          // authorship:"human" always takes, which bypasses the selection tier.
          if (authorshipFilter) {
            // Detected PER POOL, not globally: one surviving candidate in one
            // session must not hide the fact that the pass emptied ten others.
            // The predicate is `authorshipRemoved` (which counts the title
            // candidate) rather than the bucket sum, so it says exactly "the
            // authorship stage emptied this pool" and not "eligibility left it
            // empty" — independent of the fact that a title candidate can never
            // be a pool's ONLY member (it is derived from a non-empty eligible
            // pool, so an all-title drop is unreachable and the breakdown below
            // is always populated in practice). Counts come only from the
            // emptied pools, so the breakdown explains the emptiness rather
            // than restating the whole query.
            let emptied = 0;
            const dropped: AuthorshipCounts = {};
            for (const pool of pools) {
              if (pool.candidates.length > 0 || (pool.authorshipRemoved ?? 0) === 0) continue;
              emptied++;
              for (const [bucket, count] of Object.entries(pool.authorshipDropped ?? {})) {
                dropped[bucket as Authorship] = (dropped[bucket as Authorship] ?? 0) + count;
              }
            }
            if (emptied > 0) {
              const entries = Object.entries(dropped).sort(
                (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
              );
              const breakdown =
                entries.length > 0
                  ? ` (${entries.map(([bucket, count]) => `${bucket} ${count}`).join(", ")})`
                  : "";
              // Composed here, emitted in finish() — the advice half depends on
              // whether the query ended up with anything, which is not known
              // until the results are sliced. A successful narrowed query
              // should report what it withheld without being told to widen.
              authorshipEmptied = `authorship:${JSON.stringify([...authorshipFilter])} removed every candidate from ${emptied} of ${pools.length} drilled session${pools.length === 1 ? "" : "s"}${breakdown}.`;
            }
          }
          const loadErrorCount = loadErrors.length;
          if (loadErrorCount > 0) pushUnique(normalized.limitedBy, "loadError");
          if (budgetExhausted) pushUnique(normalized.limitedBy, "rankingBudget");
          const drillSkipped = Math.max(0, drillTargets.length - drilledSessions.length);
          if (drillSkipped > 0) {
            // Under the card drill (history unavailable) a target goes unsearched
            // because it has no card, or no card field its filters allow; no
            // budget was involved.
            const reason = sourceUnavailable !== undefined ? "noCardCandidate" : "rankingBudget";
            skippedByReason[reason] = (skippedByReason[reason] ?? 0) + drillSkipped;
          }
          const sessionsSkipped = Object.values(skippedByReason).reduce((a, b) => a + b, 0);
          const coverage: SearchCoverage = {
            ...(mode != null && { mode }),
            totalSessionsKnown: false,
            sessionsDiscovered: cardsCoverage.totalCards,
            sessionsEligible,
            sessionsSearched: drilledSessions.length,
            ...drillAccounting(targets),
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
              ...(cardsPending > 0 && { pending: cardsPending }),
              ...(indexing && { indexing }),
            },
            ...(semanticStatus && { semantic: { ...semanticStatus, contributed: 0 } }),
            ...(sourceUnavailable !== undefined && {
              source: { kind: source.kind, available: false as const, reason: sourceUnavailable },
            }),
          };
          const searchedSessions = drilledSessions.map(
            (id) => searchedMeta.get(id) ?? { id, title: "", directory: "" },
          );
          return {
            coverage,
            searchedSessions,
            loadErrorCount,
            incomplete: loadErrorCount > 0,
            ...(authorshipEmptied != null && { authorshipEmptied }),
            ...(toolFilter && { toolCounts: poolToolNames(pools) }),
          };
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
            source,
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

        /**
         * The output as text within the output budget: the header fields,
         * then the results, then the expansions (when there are any), so
         * expansions are trimmed before results. On a continuation, the
         * re-run output resumes at the cursor's record (results from its
         * anchor on, or the expansions from inside the one it stopped in)
         * only when the anchor is unchanged; otherwise the call is refused.
         */
        const respond = (out: SearchOutput): string => {
          const { results, expanded } = out;
          const fields: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(out)) {
            if (key !== "ok" && key !== "results" && key !== "expanded") fields[key] = value;
          }
          const expansions = expanded ?? [];
          let resultsFrom = 0;
          let expandedFrom = 0;
          let resumedExpansion: ExpandedResult | undefined;
          if (resume) {
            const index = resume.result.index;
            const anchor = results[index];
            if (
              anchor?.sessionID !== resume.result.sessionID ||
              anchor.partID !== resume.result.partID
            ) {
              return fail(RESULTS_CHANGED);
            }
            const stopped = resume.expansion;
            if (stopped) {
              const record = expansions[stopped.index];
              if (
                record?.resultIndex !== index ||
                shownFingerprint(results, expansions, {
                  section: "expanded",
                  index: stopped.index,
                }) !== resume.shown
              ) {
                return fail(RESULTS_CHANGED);
              }
              if (stopped.at) {
                resumedExpansion = resumeExpansion(record, stopped.at);
                if (!resumedExpansion) return fail(RESULTS_CHANGED);
              }
              resultsFrom = results.length;
              expandedFrom = stopped.index;
            } else {
              if (
                shownFingerprint(results, expansions, { section: "results", index }) !==
                resume.shown
              ) {
                return fail(RESULTS_CHANGED);
              }
              resultsFrom = index;
            }
          }
          const shownResults = results.slice(resultsFrom);
          const shownExpansions = expansions.slice(expandedFrom);
          if (resumedExpansion) shownExpansions[0] = resumedExpansion;
          const sections: Array<OutputSection<MessagePosition>> = [
            section<SearchResult, MessagePosition>("results", shownResults),
          ];
          if (expanded) sections.push(section("expanded", shownExpansions, fitExpansion));

          const continuationAt = (stop: OutputStop<MessagePosition>): string => {
            const bounds = {
              query: argsFingerprint,
              ...(after !== undefined && { after }),
              ...(before !== undefined && { before }),
            };
            if (stop.section === "results") {
              const index = resultsFrom + stop.index;
              const result = results[index]!;
              return encodeRecallCursor({
                ...bounds,
                result: { index, sessionID: result.sessionID, partID: result.partID },
                shown: shownFingerprint(results, expansions, { section: "results", index }),
              });
            }
            const index = expandedFrom + stop.index;
            const record = expansions[index]!;
            const result = results[record.resultIndex]!;
            // A resumed expansion not shown at all resumes where it did.
            const at =
              stop.rest ??
              (stop.index === 0 && resumedExpansion ? resume?.expansion?.at : undefined);
            return encodeRecallCursor({
              ...bounds,
              result: {
                index: record.resultIndex,
                sessionID: result.sessionID,
                partID: result.partID,
              },
              shown: shownFingerprint(results, expansions, { section: "expanded", index }),
              expansion: { index, ...(at && { at }) },
            });
          };

          return writeOutput<MessagePosition>({
            sections,
            head: (stop) => ({
              ...(stop && { continuation: continuationAt(stop) }),
              fields,
            }),
          }).text;
        };

        const finish = async (
          out: SearchOutput,
          final: SearchResult[],
          effectiveMatchMode: MatchMode,
          outCtx: ReturnType<typeof buildOutputContext>,
        ): Promise<string> => {
          const warnings = [...normalized.warnings];
          if (outCtx.authorshipEmptied) {
            warnings.push(
              final.length === 0
                ? `${outCtx.authorshipEmptied} Widen it or pass authorship:"any" to see them.`
                : outCtx.authorshipEmptied,
            );
          }
          // Count the returned results the semantic tier surfaced (reserved-slot
          // inclusions plus zero-lexical-hit rescues, both keyed by the session
          // set the reservation added).
          if (outCtx.coverage.semantic) {
            outCtx.coverage.semantic.contributed = final.filter((r) =>
              semanticReservedSet.has(r.sessionID),
            ).length;
          }
          if (outCtx.incomplete) {
            warnings.push(
              `${outCtx.loadErrorCount} session${outCtx.loadErrorCount === 1 ? "" : "s"} failed to load; results may be partial.`,
            );
          }
          const cut = cutWarning(final, cards);
          if (cut) warnings.push(cut);
          const expanded = await includeExpansion(out, final, warnings, effectiveMatchMode);
          // Read after every history read this query makes (the drill and the
          // expansions), so what they could not project is reported now.
          const history = historyCoverage(deps.history?.(), deps.repair?.());
          if (history) {
            outCtx.coverage.history = history;
            const historyWarnings = [
              driftWarning(history),
              history.repair && repairWarning(history.repair),
            ].filter((warning): warning is string => Boolean(warning));
            warnings.splice(historyWarningsAt, 0, ...historyWarnings);
          }
          if (final.length === 0 && toolName && toolFilter && outCtx.toolCounts) {
            const { kept, removed } = outCtx.toolCounts;
            const toolNames = toolNamesCoverage(toolName, toolFilter, kept, removed);
            if (toolNames) outCtx.coverage.toolNames = toolNames;
          }
          return respond(
            attachCommonOutput(expanded, {
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
              excludeFamily,
              ...(excludedMatches && { excludedMatches }),
              requested: resultsArg,
              codeTokens: queryMeta.codeTokens,
              shortlistIDs,
              ...(after != null && { after }),
              ...(authorshipFilter && { authorship: [...authorshipFilter] }),
            }),
          );
        };

        // ── Part-mode over-collection bound (grouped scans broadly) ──
        const partScanLimit = Math.min(
          MAX_PART_SCAN_RESULTS,
          resultsArg * DIVERSITY_SCAN_MULTIPLIER,
        );

        /** A result from a relative the slim-index lookup found. */
        const indexedRelative = (result: SearchResult): boolean =>
          familyIndexed.has(result.sessionID);

        /** Family diversity over ordered results, judged on the candidates
         *  of the drilled `pools` the results came from. Runs after the
         *  directory-fallback re-sort, which is family-blind and would undo
         *  it. */
        const orderForFamily = (ordered: SearchResult[], pools: DrilledPool[]): SearchResult[] => {
          if (diversityFamily.size === 0) return ordered;
          let byPart: Map<string, Candidate> | undefined;
          const delegated = (result: SearchResult): boolean => {
            if (!byPart) {
              byPart = new Map();
              for (const pool of pools) {
                if (!diversityFamily.has(pool.target.sessionId)) continue;
                for (const candidate of pool.candidates) {
                  byPart.set(`${candidate.sessionID}\u0000${candidate.partID}`, candidate);
                }
              }
            }
            const candidate = byPart.get(`${result.sessionID}\u0000${result.partID}`);
            return candidate !== undefined && authorshipOf(candidate) === "delegated";
          };
          return familyDiversity(ordered, diversityFamily, delegated, indexedRelative);
        };

        const applyGroupAndSlice = (
          results: SearchResult[],
          partTotal: number,
          earlyExit: boolean,
          pools: DrilledPool[],
        ): { final: SearchResult[]; total: number; truncated: boolean } => {
          if (isGrouped) {
            const grouped = orderForFamily(
              orderForDirectoryFallback(
                groupBySession(results),
                Boolean(bucketDirectory && fallback),
              ),
              pools,
            );
            const final = grouped.slice(0, resultsArg);
            return {
              final,
              total: grouped.length,
              truncated: earlyExit || grouped.length > final.length,
            };
          }
          const diversified = diversify(results, resultsArg, MAX_HITS_PER_SESSION_INITIAL);
          const ordered = orderForFamily(
            orderForDirectoryFallback(diversified, Boolean(bucketDirectory && fallback)),
            pools,
          );
          const final = capAndSlice(
            ordered,
            resultsArg,
            commandLikeQuery,
            diversityFamily,
            indexedRelative,
          );
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
        ) => scan(candidates, relevance, args.query, remaining, widthArg, emitAuthorship);
        const regexMatcher =
          (re: RegExp) =>
          (candidates: Candidate[], relevance: DirectoryRelevance, remaining: number) =>
            regexScanCandidates(candidates, relevance, re, remaining, widthArg, emitAuthorship);

        const loadErrorSuffixOf = (count: number): string =>
          count > 0 ? `, ${count} load error${count !== 1 ? "s" : ""}` : "";

        // ── Deep sweep route (exhaustive, tool-output-inclusive, budgeted) ──
        if (deepMode && sourceUnavailable === undefined) {
          // The page offset belongs to ONE session (deepCursor.current). The
          // resume rebuild can drop that session (worker/bounds/current-session
          // guards, excludeSessionID), shifting a different session into slot 0
          // — applying the offset there would silently skip its earlier pages
          // and report full coverage. Only resume mid-session when slot 0 is
          // still the session the cursor was cut in; otherwise sweep it fresh.
          const deepResume =
            deepCursor?.current && drillTargets[0]?.sessionId === deepCursor.current
              ? { before: deepCursor.before }
              : undefined;
          const deepResult = await activeDrill.deep({
            sessions: drillTargets,
            query: queryMeta,
            filter: eligibleFilter,
            ...(countTools && { countTools }),
            searchTitles,
            authorship: authorshipFilter,
            charsPerQuery: limits.deepCharsPerQuery,
            resume: deepResume,
            ...(timeWindow && { window: timeWindow }),
            abort: ctx.abort,
          });
          if (ctx.abort.aborted) return abortedOutput();
          const outCtx = buildOutputContext(
            deepResult.drilledSessions,
            deepResult.pools,
            deepResult.targets,
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
            const sliced = applyGroupAndSlice(
              scanned.collected,
              scanned.total,
              scanned.early,
              deepResult.pools,
            );
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
              emitAuthorship,
            );
            const sliced = applyGroupAndSlice(
              allResults,
              allResults.length,
              false,
              deepResult.pools,
            );
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
          return await finish(out, final, effMode, outCtx);
        }

        // ── Route: literal ──
        if (matchMode === "literal") {
          const drilled = await activeDrill.pools({ ...drillInput, mode: smartMode });
          if (ctx.abort.aborted) return abortedOutput();
          const outCtx = buildOutputContext(
            drilled.drilledSessions,
            drilled.pools,
            drilled.targets,
            drilled.loadErrors,
            drilled.budgetExhausted,
          );
          const limit = isGrouped ? Number.MAX_SAFE_INTEGER : partScanLimit;
          const { collected, total, early } = scanPools(drilled.pools, limit, literalMatcher);
          const {
            final,
            total: outTotal,
            truncated,
          } = applyGroupAndSlice(collected, total, early, drilled.pools);

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
          return await finish(out, final, "literal", outCtx);
        }

        // ── Route: regex ──
        if (matchMode === "regex" && regex) {
          const drilled = await activeDrill.pools({ ...drillInput, mode: smartMode });
          if (ctx.abort.aborted) return abortedOutput();
          const outCtx = buildOutputContext(
            drilled.drilledSessions,
            drilled.pools,
            drilled.targets,
            drilled.loadErrors,
            drilled.budgetExhausted,
          );
          const limit = isGrouped ? Number.MAX_SAFE_INTEGER : partScanLimit;
          const { collected, total, early } = scanPools(drilled.pools, limit, regexMatcher(regex));
          const {
            final,
            total: outTotal,
            truncated,
          } = applyGroupAndSlice(collected, total, early, drilled.pools);

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
          return await finish(out, final, "regex", outCtx);
        }

        // ── Route: smart / fuzzy (tier-2 drilled BM25 rerank) ──
        const drilled = await activeDrill.drill({ ...drillInput, mode: smartMode });
        if (ctx.abort.aborted) return abortedOutput();
        const outCtx = buildOutputContext(
          drilled.drilledSessions,
          drilled.pools,
          drilled.targets,
          drilled.loadErrors,
          drilled.budgetExhausted,
        );
        let allResults = rankedToSearchResults(
          drilled.hits,
          smartMode,
          explain,
          queryMeta,
          widthArg,
          relevanceBySession,
          emitAuthorship,
        );

        // ── Zero-lexical-hit semantic rescue (Path A) ──
        // A session the reserved-slot band surfaced by embedding similarity but
        // whose drilled parts yield NO lexical BM25 hit no longer vanishes: embed
        // its drilled candidates (bounded), take the top-cosine part as evidence,
        // scored from the blended card+part similarity and labeled semantic in
        // `why`. Scoped to semantic-shortlisted, zero-lexical-hit sessions only —
        // the drill itself never embeds (see the drill.test.ts guard).
        const rescued = rescueZeroHitSessions({
          reserved: semanticReserved,
          hitSessions: new Set(drilled.hits.map((h) => h.candidate.sessionID)),
          pools: drilled.pools,
          semantic: deps.semantic,
          semanticBySession,
          relevanceBySession,
          query: queryMeta,
          width: widthArg,
          mode: smartMode,
          explain,
          emitAuthorship,
        });
        if (rescued.length > 0) {
          allResults = [...allResults, ...rescued].sort(
            (a, b) => (b.score ?? 0) - (a.score ?? 0) || b.time - a.time,
          );
        }
        // Explain: surface each result's card-level semantic similarity in why +
        // matchReasons (the rescue results already carry their own part-level one).
        if (explain && semanticBySession.size > 0) {
          for (const result of allResults) {
            if (!result.why || result.why.semanticSimilarity != null) continue;
            const sim = semanticBySession.get(result.sessionID);
            if (sim == null) continue;
            result.why = { ...result.why, semanticSimilarity: sim };
            result.matchReasons = [
              ...(result.matchReasons ?? []),
              `Card semantic similarity: ${sim.toFixed(3)}`,
            ];
          }
        }

        const planSelected: string[] = ["cards-tier1", "drill-tier2"];
        if (rescued.length > 0) planSelected.push("semantic-rescue");
        if (queryMeta.codeTokens.length > 0) planSelected.push("exact-token-boost");
        if (ftsBySession && ftsBySession.size > 0) planSelected.push("fts-needle");
        const QUERY_PLAN_VARIANTS = [
          "cards-tier1",
          "fts-needle",
          "exact-token-boost",
          "drill-tier2",
          "semantic-rescue",
          "literal-fallback",
        ];
        const attachQueryPlan = (out: SearchOutput, selected: string[]): void => {
          if (explain) out.queryPlan = { variants: QUERY_PLAN_VARIANTS, selected };
        };

        // ── Fallback to a literal scan over the SAME drilled pools if smart is empty ──
        if (allResults.length === 0 && !ctx.abort.aborted) {
          const limit = isGrouped ? Number.MAX_SAFE_INTEGER : partScanLimit;
          const { collected, total, early } = scanPools(drilled.pools, limit, literalMatcher);
          const {
            final,
            total: outTotal,
            truncated,
          } = applyGroupAndSlice(collected, total, early, drilled.pools);
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
            return await finish(out, final, "literal", outCtx);
          }
        }

        const {
          final,
          total: outTotal,
          truncated,
        } = applyGroupAndSlice(allResults, allResults.length, false, drilled.pools);
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
        return await finish(out, final, smartMode, outCtx);
      } catch (e) {
        return fail(errmsg(e));
      }
    },
  });
}
