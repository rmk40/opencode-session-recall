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
import type { DrillSessionStats } from "./types.js";
import {
  countMessages,
  unreadTargets,
  type DeepOutput,
  type Drill,
  type DrillInput,
  type DrillOutput,
  type DrillPoolsOutput,
  type DrillTarget,
  type DrillTargetStats,
  type DrilledPool,
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
 * - `outcomeHead` (the text of the last message with any text, of either
 *   role) and `nlSummary` (written by the summarizer, not by anyone in the
 *   session) are never offered: a message candidate must carry a role, and
 *   the card does not record one for either.
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

/** The one card field offered as a message: the summary head, a user
 *  statement (the only field whose role the card records). */
function summaryCandidate(
  target: DrillTarget,
  messageID: string,
  text: string,
  time: number,
): Candidate | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const candidate: Candidate = {
    sessionID: target.sessionId,
    sessionTitle: target.title,
    directory: target.directory,
    messageID,
    role: "user",
    time,
    partID: `${target.sessionId}:card:summary`,
    partType: "text",
    isPruned: false,
    sessionParentID: target.parentID,
    rawText: trimmed,
    fieldTexts: [{ field: "text", text: trimmed }],
    tokens: tokenize(trimmed),
    source: "message",
    why: { matchedFields: [], confidence: "low" },
  };
  populateNormalized(candidate);
  return candidate;
}

/** The card's summary head as a candidate, whatever the query asks for;
 *  undefined when there is no card or it has no summary head. */
function cardSummary(target: DrillTarget, cards: CardsRuntime): Candidate | undefined {
  const card = cards.get(target.sessionId);
  if (!card) return undefined;
  const messageID = card.distilledThrough ?? `${card.sessionId}:card`;
  return summaryCandidate(target, messageID, card.summaryHead, card.timeCreated);
}

/** Whether what the query narrows by lets the summary head be offered. */
function summaryAllowed(narrow: CardDrillFilters): boolean {
  const { filters } = narrow;
  return (
    (filters.role === "all" || filters.role === "user") &&
    filters.type === "all" &&
    !filters.toolName &&
    !narrow.authorshipNarrowed
  );
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
 *  candidate, then authorship (see drill.ts `poolFor`). The stats count the
 *  card's summary head as the one message it can offer, and nothing as
 *  fetched: the card drill reads no history. */
function poolOf(
  target: DrillTarget,
  cards: CardsRuntime,
  narrow: CardDrillFilters,
  input: Pick<DrillInput, "filter" | "searchTitles" | "authorship">,
): DrilledPool {
  const summary = cardSummary(target, cards);
  const all = summary && summaryAllowed(narrow) ? [summary] : [];
  const stats = (candidates: Candidate[]): DrillSessionStats => ({
    fetched: 0,
    candidate: summary ? 1 : 0,
    eligible: countMessages(candidates),
    stop: "end",
  });
  let pool = input.filter ? all.filter(input.filter) : all;
  if (input.searchTitles) {
    const title = standaloneTitle(target, cards, narrow);
    if (title && (!input.filter || input.filter(title))) pool = [...pool, title];
  }
  if (!input.authorship) return { target, candidates: pool, stats: stats(pool) };
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
  return { target, candidates: kept, stats: stats(kept), authorshipDropped, authorshipRemoved };
}

export function createCardDrill(cards: CardsRuntime, narrow: CardDrillFilters): Drill {
  const collect = (input: DrillInput): DrillPoolsOutput => {
    const pools: DrilledPool[] = [];
    const targets: DrillTargetStats[] = [];
    for (let i = 0; i < input.sessions.length; i++) {
      if (input.abort?.aborted) {
        targets.push(...unreadTargets(input.sessions, i, "aborted"));
        break;
      }
      const pool = poolOf(input.sessions[i]!, cards, narrow, input);
      pools.push(pool);
      targets.push({ sessionId: pool.target.sessionId, ...pool.stats });
    }
    return {
      pools,
      targets,
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
