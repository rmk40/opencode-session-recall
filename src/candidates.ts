import type { Part } from "@opencode-ai/sdk/v2";
import { distance } from "fastest-levenshtein";
import { tokenize, normalize } from "./normalize.js";
import { searchableFields, pruned, toolNameMatches, type SearchableField } from "./extract.js";
import type { DirectoryRelevance, ResultSource, ResultWhy } from "./types.js";

export type SessionMeta = {
  id: string;
  title: string;
  directory: string;
  directoryRelevance?: DirectoryRelevance;
  /** Tri-state session parentage for authorship classification: a string is a
   *  real parent id, `null` means metadata said root, and `undefined`/omitted
   *  means metadata was unavailable (see src/authorship.ts). Safe by omission:
   *  forgetting it yields `unknown`, never a false `human`. */
  parentID?: string | null;
};

export type MsgInfo = {
  id: string;
  role: "user" | "assistant";
  time: { created: number };
};

export type Candidate = {
  // Raw values for output
  sessionID: string;
  sessionTitle: string;
  directory: string;
  messageID: string;
  role: "user" | "assistant";
  time: number;
  partID: string;
  partType: string;
  isPruned: boolean;
  toolName?: string;
  rawText: string;
  fieldTexts: SearchableField[];
  source?: ResultSource;
  why?: ResultWhy;
  directoryRelevance?: DirectoryRelevance;
  titleMatch?: { title: string; matchedTerms?: string[] };

  // ── Authorship inputs (structural; see src/authorship.ts) ──
  /** Host/tool-injected part (SDK `TextPart.synthetic`). */
  synthetic?: boolean;
  /** Host rendering hint, e.g. a TUI status block (SDK `TextPart.ignored`). */
  ignored?: boolean;
  /** Tri-state parentage of this candidate's session (see {@link SessionMeta}). */
  sessionParentID?: string | null;

  // Deduplicated tokens for matched-term metadata checks
  tokens: string[];

  // Normalized weighted fields indexed by the BM25 ranker (populated lazily)
  primaryText?: string;
  secondaryText?: string;
  titleText?: string;
  hintText?: string;
  /** Normalized session digest (stamped per session at cache-fill time). */
  digestText?: string;
};

/** Truncate very long tool outputs per candidate. */
export const MAX_CHARS_PER_CANDIDATE = 20_000;

/**
 * Tool names that name the same tool. OpenCode v2 renamed `bash` to `shell`,
 * `task` to `subagent` and `apply_patch` to `patch` (`RENAMED_TOOLS` in
 * opencode's `core/src/database/v1-migration.bun.ts`), so one history holds
 * both names, and some recorded calls name them in another case (`Bash`,
 * `Shell`). Members are lower case.
 */
export const TOOL_NAME_ALIASES: ReadonlyArray<readonly string[]> = [
  ["bash", "shell"],
  ["task", "subagent"],
  ["apply_patch", "patch"],
];

/**
 * The tool names a `toolName` filter accepts, worked out once per filter. A
 * name in an alias group accepts every member of the group in any case
 * (`group`, lower case); any other name accepts only itself, exactly.
 */
export type ToolFilter = { name: string; group?: ReadonlySet<string> };

export function compileToolFilter(name: string): ToolFilter {
  const folded = name.toLowerCase();
  const group = TOOL_NAME_ALIASES.find((members) => members.includes(folded));
  return group ? { name, group: new Set(group) } : { name };
}

/** Whether a tool part named `toolName` passes the filter. */
export function toolFilterMatches(filter: ToolFilter, toolName: string | undefined): boolean {
  if (toolName === undefined) return false;
  return filter.group ? filter.group.has(toolName.toLowerCase()) : toolName === filter.name;
}

/** The names a filter accepts, for reporting: its alias group, or the name. */
export function toolFilterNames(filter: ToolFilter): string[] {
  return filter.group ? [...filter.group] : [filter.name];
}

/**
 * How close a tool name is to a requested one, lower being closer, or
 * undefined when it is not close at all. Compared in lower case: the same
 * name in another case scores 0, a host-namespaced form of either
 * (`mcp__server__read` for `read`, see {@link toolNameMatches}) 1, a name
 * containing the other 2, and otherwise 2 plus the edit distance when that is
 * at most a third of the longer name (at least 1).
 */
function toolNameCloseness(requested: string, name: string): number | undefined {
  if (name === requested) return 0;
  if (toolNameMatches(name, requested) || toolNameMatches(requested, name)) return 1;
  if (Math.min(name.length, requested.length) >= 3) {
    if (name.includes(requested) || requested.includes(name)) return 2;
  }
  const edits = distance(name, requested);
  const allowed = Math.max(1, Math.floor(Math.max(name.length, requested.length) / 3));
  return edits <= allowed ? 2 + edits : undefined;
}

/**
 * The name in `counts` closest to `requested` (see `toolNameCloseness`),
 * leaving out any name `filter` accepts; ties go to the more frequent name,
 * then the alphabetically first. An alias filter scores each name by its
 * closest group member, so the answer is the same whichever alias was given.
 * Undefined when no name is close.
 */
export function closestToolName(
  requested: string,
  counts: ReadonlyMap<string, number>,
  filter: ToolFilter,
): string | undefined {
  const targets = filter.group ? [...filter.group] : [requested.toLowerCase()];
  let best: { name: string; score: number; count: number } | undefined;
  for (const [name, count] of counts) {
    if (toolFilterMatches(filter, name)) continue;
    const folded = name.toLowerCase();
    let score: number | undefined;
    for (const target of targets) {
      const closeness = toolNameCloseness(target, folded);
      if (closeness !== undefined && (score === undefined || closeness < score)) score = closeness;
    }
    if (score === undefined) continue;
    if (
      !best ||
      score < best.score ||
      (score === best.score &&
        (count > best.count || (count === best.count && name.localeCompare(best.name) < 0)))
    ) {
      best = { name, score, count };
    }
  }
  return best?.name;
}

/**
 * Query-time filters applied to cached candidates. Semantics match the old
 * per-query message/part filters exactly: `before` excludes messages at or
 * after the timestamp, `after` excludes messages at or before it, `toolName`
 * implies tool parts only and matches through {@link toolFilterMatches}, and
 * `type` applies only without `toolName`.
 */
export type CandidateFilters = {
  type: string;
  role: string;
  before?: number;
  after?: number;
  toolName?: string;
};

/** The eligibility predicate for `filters`, with the tool filter compiled
 *  once, for testing many candidates. */
export function candidateFilter(filters: CandidateFilters): (candidate: Candidate) => boolean {
  const tool = filters.toolName ? compileToolFilter(filters.toolName) : undefined;
  return (candidate) => eligibleUnder(candidate, filters, tool);
}

/** Whether one candidate passes `filters`. Compiles the tool filter on every
 *  call; use {@link candidateFilter} to test many candidates. */
export function candidateEligible(candidate: Candidate, filters: CandidateFilters): boolean {
  return candidateFilter(filters)(candidate);
}

function eligibleUnder(
  candidate: Candidate,
  filters: CandidateFilters,
  tool: ToolFilter | undefined,
): boolean {
  if (filters.role !== "all" && candidate.role !== filters.role) return false;
  if (filters.before != null && candidate.time >= filters.before) return false;
  if (filters.after != null && candidate.time <= filters.after) return false;
  if (tool) {
    return candidate.partType === "tool" && toolFilterMatches(tool, candidate.toolName);
  }
  if (filters.type !== "all" && candidate.partType !== filters.type) return false;
  return true;
}

/**
 * Build the complete, unfiltered candidate list for one session version.
 * Runs once per session change at cache-fill time (see corpus.ts), so there
 * are no per-query filters and no scan budgets here; the only size control is
 * the per-candidate character cap. Iterates newest message first so eligible
 * candidates come out newest-first for representative selection.
 */
export function buildCandidates(
  messages: Array<{ info: MsgInfo; parts: Part[] }>,
  session: SessionMeta,
): {
  candidates: Candidate[];
  charsUsed: number;
} {
  const candidates: Candidate[] = [];
  let charsUsed = 0;

  // Iterate newest-first (messages arrive chronological, so reverse)
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi]!;
    const info = msg.info;

    for (const part of msg.parts) {
      const fields = searchableFields(part);
      if (fields.length === 0) continue;

      // Join all searchable texts so smart mode searches the same content as literal
      let rawText = fields.map((field) => field.text).join("\n\n");
      if (rawText.length > MAX_CHARS_PER_CANDIDATE) {
        rawText = rawText.slice(0, MAX_CHARS_PER_CANDIDATE);
      }
      charsUsed += rawText.length;

      // Authorship part flags. The SDK declares both on TextPart only, so the
      // type narrowing carries them — no cast. A non-text part leaves them
      // undefined, which the classifier reads as "not flagged".
      const synthetic = part.type === "text" && part.synthetic === true ? true : undefined;
      const ignored = part.type === "text" && part.ignored === true ? true : undefined;

      const candidate: Candidate = {
        sessionID: session.id,
        sessionTitle: session.title,
        directory: session.directory,
        messageID: info.id,
        role: info.role,
        time: info.time.created,
        partID: part.id,
        partType: part.type,
        isPruned: pruned(part),
        synthetic,
        ignored,
        sessionParentID: session.parentID,
        rawText,
        fieldTexts: fields,
        tokens: tokenize(rawText),
        source: part.type === "tool" ? "tool" : part.type === "reasoning" ? "reasoning" : "message",
        why: {
          matchedFields: [],
        },
      };

      if (part.type === "tool") {
        candidate.toolName = part.tool;
      }

      candidates.push(candidate);
    }
  }

  return { candidates, charsUsed };
}

export function buildTitleCandidate(
  session: SessionMeta,
  representative: MsgInfo,
): Candidate | undefined {
  const title = session.title.trim();
  if (!title) return undefined;

  return {
    sessionID: session.id,
    sessionTitle: session.title,
    directory: session.directory,
    messageID: representative.id,
    role: representative.role,
    time: representative.time.created,
    partID: `${session.id}:title`,
    partType: "title",
    isPruned: false,
    rawText: title,
    fieldTexts: [{ field: "title", text: title }],
    tokens: tokenize(title),
    source: "title",
    directoryRelevance: session.directoryRelevance,
    why: {
      matchedFields: ["title"],
      directoryRelevance: session.directoryRelevance,
      confidence: "medium",
    },
    titleMatch: { title: session.title },
  };
}

/** Populate stage-2 normalized fields on a candidate (mutates in place). */
export function populateNormalized(candidate: Candidate): void {
  // For title candidates, rawText IS the session title, which is already indexed
  // via titleText below. Indexing it in primaryText too would double-weight the
  // same text (primary boost + title boost). Leave primaryText empty so a title
  // candidate is scored only through its title field.
  candidate.primaryText = candidate.partType === "title" ? "" : normalize(candidate.rawText);
  // secondaryText: directory path provides cross-project search context
  candidate.secondaryText = candidate.directory ? normalize(candidate.directory) : "";
  candidate.titleText = candidate.sessionTitle ? normalize(candidate.sessionTitle) : "";
  candidate.hintText = candidate.toolName ? normalize(candidate.toolName) : "";
}
