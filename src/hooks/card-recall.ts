import type { CardsRuntime, CardFilters } from "../cards.js";
import type { Card, Store } from "../store.js";
import { parseQuery } from "../query.js";

/**
 * Card-tier query for the hooks — the whole answer, no drill, no message fetch.
 *
 * Auto-recall and compaction run on latency-sensitive paths (a user turn, a
 * compaction). Round 4 moves them entirely onto the card tier: rank cards with
 * the same {@link CardsRuntime.rank} the search tool uses, backfill needle
 * sessions from the slim FTS index, and derive matched anchors from each card's
 * inventory. Every input is already in memory or answered by SQLite's C engine,
 * so the hook makes zero `session.messages`/`session.message` calls.
 */

export type CardRecallHit = {
  card: Card;
  score: number;
  /** Query anchors (code tokens / phrases / terms) present in the card inventory. */
  anchors: string[];
};

export type CardRecallDeps = { cards: CardsRuntime; store: Store | null };

const MAX_ANCHORS = 4;
const MIN_ANCHOR_CHARS = 3;

export function cardRecall(
  deps: CardRecallDeps,
  query: string,
  opts: { limit: number; filters?: CardFilters },
): CardRecallHit[] {
  const parsed = parseQuery(query);
  const filters = opts.filters ?? {};

  const anchorsFor = (card: Card): string[] => {
    const inventory = card.inventory.toLowerCase();
    const out: string[] = [];
    for (const anchor of [...parsed.codeTokens, ...parsed.phrases, ...parsed.tokens]) {
      const lower = anchor.toLowerCase();
      if (lower.length < MIN_ANCHOR_CHARS) continue;
      if (inventory.includes(lower) && !out.includes(anchor)) out.push(anchor);
      if (out.length >= MAX_ANCHORS) break;
    }
    return out;
  };

  const byId = new Map<string, CardRecallHit>();
  // Keep only real lexical/semantic hits. `cards.rank` falls back to recency
  // near-misses (score 0) when nothing matches — useful for the interactive
  // search tool's "here's what's recent" affordance, but the hooks must not
  // inject unrelated recent sessions on every history cue. FTS needles below
  // (also score 0, but a genuine anchor match) are added separately.
  for (const hit of deps.cards.rank(parsed, filters)) {
    if (hit.score <= 0) continue;
    byId.set(hit.sessionId, { card: hit.card, score: hit.score, anchors: anchorsFor(hit.card) });
  }

  // Tier-1.5 needle backfill: sessions whose card missed the anchor but whose
  // slim FTS index carries it. Answered by SQLite — still zero message fetches.
  if (deps.store && (parsed.codeTokens.length > 0 || parsed.phrases.length > 0)) {
    const excluded = filters.excludeFamilyOf
      ? deps.cards.exclusionFamily(filters.excludeFamilyOf)
      : new Set<string>();
    const rows = deps.store.ftsSearch({
      strong: [...parsed.codeTokens, ...parsed.phrases],
      weak: parsed.tokens,
      limit: opts.limit * 4,
    });
    for (const row of rows) {
      if (byId.has(row.sessionId) || excluded.has(row.sessionId)) continue;
      const card = deps.store.getCard(row.sessionId);
      if (!card) continue;
      if (filters.since != null && card.timeUpdated < filters.since) continue;
      if (filters.until != null && card.timeUpdated > filters.until) continue;
      byId.set(row.sessionId, { card, score: 0, anchors: anchorsFor(card) });
    }
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score || b.card.timeUpdated - a.card.timeUpdated)
    .slice(0, opts.limit);
}
