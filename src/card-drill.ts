import {
  buildTitleCandidate,
  populateNormalized,
  type Candidate,
  type CandidateFilters,
} from "./candidates.js";
import type { CardsRuntime } from "./cards.js";
import { bm25Search } from "./bm25.js";
import { authorshipOf, type Authorship, type AuthorshipCounts } from "./authorship.js";
import { tokenize } from "./normalize.js";
import type {
  DeepOutput,
  Drill,
  DrillInput,
  DrillOutput,
  DrillPoolsOutput,
  DrillTarget,
  DrilledPool,
} from "./drill.js";

/**
 * A {@link Drill} that reads nothing: each target's pool is built from its
 * session card instead of fetched messages. `recall` uses it when the history
 * source is unavailable (v2 with `opencode.db` unreadable), so a query still
 * returns card-quality matches, labeled as such, instead of an empty result.
 *
 * A card records less provenance than a message does, so a card field only
 * becomes a candidate when what the query asks for can be answered truthfully
 * from what the card knows (see `distill.ts`, `walkMessages`):
 *
 * - `summaryHead` is the first statement of the first user-role message: its
 *   role is known (user), but not its part type (a text or a subtask) nor its
 *   authorship (typed, delegated or injected). It is offered with no filter,
 *   or with `role: "user"` alone.
 * - `outcomeHead` is the text of the last message with any text, of either
 *   role; `nlSummary` is written by the summarizer, not by anyone in the
 *   session. Both are offered only when no role, type, tool or authorship
 *   filter is set, labeled `assistant` as a best guess (the last text is
 *   usually the answer). An outcome equal to the summary head (the session
 *   has no answer yet) is not offered at all.
 * - The session title is always its own candidate (source `title`, as the
 *   normal pipeline emits title hits), so a metadata-only card can still match
 *   by title. It is dated by the card's last update and is subject to the
 *   same time, type and authorship filters; it claims no message role, so any
 *   role filter excludes it.
 *
 * A card-derived result points at the card's last distilled message where it
 * has one; `recall_get` and `recall_context` cannot open it while the source
 * is unavailable, and say so.
 */

/** What the query narrows by, as far as provenance is concerned. */
export type CardDrillFilters = {
  filters: CandidateFilters;
  /** An authorship filter other than "any" is set. */
  authorshipNarrowed: boolean;
};

type CardField = { key: string; text: string; role: "user" | "assistant"; time: number };

function candidateOf(
  target: DrillTarget,
  messageID: string,
  field: CardField,
): Candidate | undefined {
  const text = field.text.trim();
  if (!text) return undefined;
  const candidate: Candidate = {
    sessionID: target.sessionId,
    sessionTitle: target.title,
    directory: target.directory,
    messageID,
    role: field.role,
    time: field.time,
    partID: `${target.sessionId}:card:${field.key}`,
    partType: "text",
    isPruned: false,
    sessionParentID: target.parentID,
    rawText: text,
    fieldTexts: [{ field: "text", text }],
    tokens: tokenize(text),
    source: "message",
    why: { matchedFields: [], confidence: "low" },
  };
  populateNormalized(candidate);
  return candidate;
}

function cardCandidates(
  target: DrillTarget,
  cards: CardsRuntime,
  narrow: CardDrillFilters,
): Candidate[] {
  const card = cards.get(target.sessionId);
  if (!card) return [];
  const { filters } = narrow;
  const messageID = card.distilledThrough ?? `${card.sessionId}:card`;
  const unnarrowed =
    filters.role === "all" &&
    filters.type === "all" &&
    !filters.toolName &&
    !narrow.authorshipNarrowed;
  const summaryAllowed =
    (filters.role === "all" || filters.role === "user") &&
    filters.type === "all" &&
    !filters.toolName &&
    !narrow.authorshipNarrowed;
  const fields: CardField[] = [];
  // Newest first, as a fetched pool is.
  if (unnarrowed) {
    fields.push({ key: "nl", text: card.nlSummary, role: "assistant", time: card.timeUpdated });
    // In a session whose last text is its first request (no answer yet), the
    // outcome repeats the summary; skip it rather than label it an answer.
    if (card.outcomeHead !== card.summaryHead) {
      fields.push({
        key: "outcome",
        text: card.outcomeHead,
        role: "assistant",
        time: card.timeUpdated,
      });
    }
  }
  if (summaryAllowed) {
    fields.push({ key: "summary", text: card.summaryHead, role: "user", time: card.timeCreated });
  }
  const out: Candidate[] = [];
  for (const field of fields) {
    const candidate = candidateOf(target, messageID, field);
    if (candidate) out.push(candidate);
  }
  return out;
}

/** The session title as a standalone candidate: no message behind it, so it
 *  is offered only without a role filter, and it is dated by the card. */
function standaloneTitle(
  target: DrillTarget,
  cards: CardsRuntime,
  narrow: CardDrillFilters,
): Candidate | undefined {
  if (narrow.filters.role !== "all") return undefined;
  const card = cards.get(target.sessionId);
  const title = buildTitleCandidate(
    { id: target.sessionId, title: target.title, directory: target.directory },
    {
      id: card?.distilledThrough ?? `${target.sessionId}:card`,
      role: "user",
      time: { created: card?.timeUpdated ?? target.timeUpdated },
    },
  );
  if (!title) return undefined;
  title.sessionParentID = target.parentID;
  populateNormalized(title);
  return title;
}

/** The drill's pool stages over card candidates: eligibility, the title
 *  candidate, then authorship (see drill.ts `poolFor`). */
function poolOf(
  target: DrillTarget,
  cards: CardsRuntime,
  narrow: CardDrillFilters,
  input: Pick<DrillInput, "filter" | "searchTitles" | "authorship">,
): DrilledPool {
  const all = cardCandidates(target, cards, narrow);
  let pool = input.filter ? all.filter(input.filter) : all;
  if (input.searchTitles) {
    const title = standaloneTitle(target, cards, narrow);
    if (title && (!input.filter || input.filter(title))) pool = [...pool, title];
  }
  if (!input.authorship) return { target, candidates: pool };
  const kept: Candidate[] = [];
  const authorshipDropped: AuthorshipCounts = {};
  let authorshipRemoved = 0;
  for (const candidate of pool) {
    const bucket: Authorship = authorshipOf(candidate);
    if (input.authorship.has(bucket)) {
      kept.push(candidate);
      continue;
    }
    authorshipRemoved++;
    if (candidate.partType === "title") continue;
    authorshipDropped[bucket] = (authorshipDropped[bucket] ?? 0) + 1;
  }
  return { target, candidates: kept, authorshipDropped, authorshipRemoved };
}

export function createCardDrill(cards: CardsRuntime, narrow: CardDrillFilters): Drill {
  const collect = (input: DrillInput): DrillPoolsOutput => {
    const pools: DrilledPool[] = [];
    for (const target of input.sessions) {
      if (input.abort?.aborted) break;
      pools.push(poolOf(target, cards, narrow, input));
    }
    return {
      pools,
      // Only a session whose card offered at least one candidate was really
      // searched; a card-less target (or one its filters emptied) was not.
      drilledSessions: pools
        .filter((pool) => pool.candidates.length > 0)
        .map((pool) => pool.target.sessionId),
      budgetExhausted: false,
      loadErrors: [],
    };
  };

  return {
    async drill(input): Promise<DrillOutput> {
      const collected = collect(input);
      const all = collected.pools.flatMap((pool) => pool.candidates);
      const hits = bm25Search(all, input.query, input.mode, input.explain);
      return { hits, ...collected };
    },
    async pools(input): Promise<DrillPoolsOutput> {
      return collect(input);
    },
    async deep(): Promise<DeepOutput> {
      // recall never routes a deep sweep here: without the history there is
      // nothing to sweep exhaustively.
      throw new Error("a deep sweep needs the history source");
    },
    cachedChars: () => 0,
  };
}
