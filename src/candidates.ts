import type { Part } from "@opencode-ai/sdk/v2";
import { tokenize, normalize } from "./normalize.js";
import { searchable, pruned } from "./extract.js";

export type SessionMeta = {
  id: string;
  title: string;
  directory: string;
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

  // Stage 1: lightweight tokens for prefiltering
  tokens: string[];

  // Stage 2: normalized weighted fields for Fuse.js (populated lazily)
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

      const texts = searchable(part);
      if (texts.length === 0) continue;

      // Join all searchable texts so smart mode searches the same content as literal
      let rawText = texts.join("\n\n");

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
        tokens: tokenize(rawText),
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

/** Populate stage-2 normalized fields on a candidate (mutates in place). */
export function populateNormalized(candidate: Candidate): void {
  candidate.primaryText = normalize(candidate.rawText);
  // secondaryText: directory path provides cross-project search context
  candidate.secondaryText = candidate.directory ? normalize(candidate.directory) : "";
  candidate.titleText = candidate.sessionTitle ? normalize(candidate.sessionTitle) : "";
  candidate.hintText = candidate.toolName ? normalize(candidate.toolName) : "";
}
