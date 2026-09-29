import { buildTitleCandidate, populateNormalized, type Candidate } from "./candidates.js";
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
 * session card (title, first statement, last answer, summary) instead of
 * fetched messages. `recall` uses it when the history source is unavailable
 * (v2 with `opencode.db` unreadable), so a query still returns card-quality
 * matches, labeled as such, instead of an empty result. The same per-query
 * eligibility (type, role, time, tool) and authorship filters apply as on a
 * real drill, through the same stages.
 *
 * A card-derived result points at the card's last distilled message where it
 * has one; `recall_get` and `recall_context` cannot open it while the source
 * is unavailable, and say so.
 */

type CardField = { key: string; text: string; role: "user" | "assistant"; time: number };

function cardCandidates(target: DrillTarget, cards: CardsRuntime): Candidate[] {
  const card = cards.get(target.sessionId);
  if (!card) return [];
  const messageID = card.distilledThrough ?? `${card.sessionId}:card`;
  const fields: CardField[] = [
    { key: "summary", text: card.summaryHead, role: "user", time: card.timeCreated },
    { key: "outcome", text: card.outcomeHead, role: "assistant", time: card.timeUpdated },
    { key: "nl", text: card.nlSummary, role: "assistant", time: card.timeUpdated },
  ];
  const out: Candidate[] = [];
  // Newest first, as a fetched pool is.
  for (const field of fields.reverse()) {
    const text = field.text.trim();
    if (!text) continue;
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
    out.push(candidate);
  }
  return out;
}

/** The drill's pool stages over card candidates: eligibility, the title
 *  candidate, then authorship (see drill.ts `poolFor`). */
function poolOf(
  target: DrillTarget,
  cards: CardsRuntime,
  input: Pick<DrillInput, "filter" | "searchTitles" | "authorship">,
): DrilledPool {
  const all = cardCandidates(target, cards);
  let pool = input.filter ? all.filter(input.filter) : all;
  const representative = pool[0];
  if (input.searchTitles && representative) {
    const title = buildTitleCandidate(
      { id: target.sessionId, title: target.title, directory: target.directory },
      {
        id: representative.messageID,
        role: representative.role,
        time: { created: representative.time },
      },
    );
    if (title) {
      title.sessionParentID = target.parentID;
      populateNormalized(title);
      pool = [...pool, title];
    }
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

export function createCardDrill(cards: CardsRuntime): Drill {
  const collect = (input: DrillInput): DrillPoolsOutput => {
    const pools: DrilledPool[] = [];
    for (const target of input.sessions) {
      if (input.abort?.aborted) break;
      pools.push(poolOf(target, cards, input));
    }
    return {
      pools,
      drilledSessions: pools.map((pool) => pool.target.sessionId),
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
