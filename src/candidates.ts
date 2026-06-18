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

  // Normalized weighted fields indexed by the BM25 ranker (populated lazily)
  primaryText?: string;
  secondaryText?: string;
  titleText?: string;
  hintText?: string;
};

export type CandidateBudgets = {
  maxMessagesPerSession: number;
  maxPartsPerSession: number;
  maxCharsPerCandidate: number;
  maxCharsTotal: number;
  maxCandidatesPerSession: number;
  maxCandidatesTotal: number;
};

export const DEFAULT_BUDGETS: CandidateBudgets = {
  maxMessagesPerSession: 1000,
  maxPartsPerSession: 5000,
  maxCharsPerCandidate: 20000,
  maxCharsTotal: 2000000,
  maxCandidatesPerSession: 500,
  maxCandidatesTotal: 3000,
};

/** Build candidates from a single session's messages. Returns candidates and budget tracking info. */
export function buildCandidates(
  messages: Array<{ info: MsgInfo; parts: Part[] }>,
  session: SessionMeta,
  budgets: CandidateBudgets,
  type: string,
  role: string,
  before?: number,
  after?: number,
  toolName?: string,
): {
  candidates: Candidate[];
  messagesProcessed: number;
  partsProcessed: number;
  charsUsed: number;
  budgetHit: boolean;
} {
  const candidates: Candidate[] = [];
  let messagesProcessed = 0;
  let partsProcessed = 0;
  let charsUsed = 0;
  let budgetHit = false;

  // Iterate newest-first (messages arrive chronological, so reverse)
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    if (messagesProcessed >= budgets.maxMessagesPerSession) {
      budgetHit = true;
      break;
    }

    const msg = messages[mi]!;
    const info = msg.info;

    // Message-level filters
    if (role !== "all" && info.role !== role) continue;
    if (before != null && info.time.created >= before) continue;
    if (after != null && info.time.created <= after) continue;

    messagesProcessed++;

    for (const part of msg.parts) {
      if (partsProcessed >= budgets.maxPartsPerSession) {
        budgetHit = true;
        break;
      }

      // Part type/tool filters
      if (toolName && (part.type !== "tool" || part.tool !== toolName)) {
        continue;
      }
      if (!toolName && type !== "all" && part.type !== type) {
        continue;
      }

      partsProcessed++;

      const fields = searchableFields(part);
      if (fields.length === 0) continue;

      // Join all searchable texts so smart mode searches the same content as literal
      let rawText = fields.map((field) => field.text).join("\n\n");

      // Truncate at per-candidate char budget
      if (rawText.length > budgets.maxCharsPerCandidate) {
        rawText = rawText.slice(0, budgets.maxCharsPerCandidate);
      }

      // Check total char budget
      if (charsUsed + rawText.length > budgets.maxCharsTotal) {
        budgetHit = true;
        break;
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
        directoryRelevance: session.directoryRelevance,
        why: {
          matchedFields: [],
        },
      };

      if (part.type === "tool") {
        candidate.toolName = part.tool;
      }

      candidates.push(candidate);

      if (candidates.length >= budgets.maxCandidatesPerSession) {
        budgetHit = true;
        break;
      }
    }

    // If inner loop hit a budget, stop outer loop too
    if (
      partsProcessed >= budgets.maxPartsPerSession ||
      charsUsed >= budgets.maxCharsTotal ||
      candidates.length >= budgets.maxCandidatesPerSession
    ) {
      break;
    }
  }

  return {
    candidates,
    messagesProcessed,
    partsProcessed,
    charsUsed,
    budgetHit,
  };
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
