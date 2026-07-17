import type { Part } from "@opencode-ai/sdk/v2";
import { tokenize, normalize } from "./normalize.js";
import { searchableFields, pruned, type SearchableField } from "./extract.js";
import type { DirectoryRelevance, ResultSource, ResultWhy } from "./types.js";

export type SessionMeta = {
  id: string;
  title: string;
  directory: string;
  directoryRelevance?: DirectoryRelevance;
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

  // Deduplicated tokens for matched-term metadata checks
  tokens: string[];

  // Optional semantic embedding (L2-normalized), computed once per session
  // version at cache-fill time when the opt-in semantic layer is enabled.
  embedding?: Float32Array;

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
 * Query-time filters applied to cached candidates. Semantics match the old
 * per-query message/part filters exactly: `before` excludes messages at or
 * after the timestamp, `after` excludes messages at or before it, `toolName`
 * implies tool parts only, and `type` applies only without `toolName`.
 */
export type CandidateFilters = {
  type: string;
  role: string;
  before?: number;
  after?: number;
  toolName?: string;
};

export function candidateEligible(candidate: Candidate, filters: CandidateFilters): boolean {
  if (filters.role !== "all" && candidate.role !== filters.role) return false;
  if (filters.before != null && candidate.time >= filters.before) return false;
  if (filters.after != null && candidate.time <= filters.after) return false;
  if (filters.toolName) {
    return candidate.partType === "tool" && candidate.toolName === filters.toolName;
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
