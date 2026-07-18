import MiniSearch from "minisearch";
import type { Card } from "./store.js";
import type { ParsedQuery } from "./query.js";
import { normalize, tokenizeAll } from "./normalize.js";
import { clamp01, recencyMultiplier } from "./bm25.js";
import { cosineSimilarity } from "./semantic/similarity.js";
import type { CandidateEmbedder } from "./corpus.js";
import type { DirectoryRelevance } from "./types.js";

/**
 * Tier-1 card runtime.
 *
 * Ranks whole sessions from their derived cards (the distiller's ~5MB summary
 * layer) so the query path never scans parts to build a shortlist. A MiniSearch
 * BM25 index over card fields (title, heads, inventory, error signatures, file
 * basenames) is rebuilt lazily from the store; each hit is then lifted by exact
 * code-token presence in the inventory, a recency prior, and — when enabled — a
 * semantic blend over card text. Metadata predicates (since/until, directory
 * scope, agent, current-session family exclusion) filter the ranked hits.
 *
 * This layer only SHORTLISTS which sessions to drill; final result ranking is
 * tier-2's job over the drilled parts. So generous recall here is correct: a
 * session that belongs in the answer must reach the shortlist, precision is the
 * drill's concern.
 */

/** Bounded ancestor walk + descendant collection, matching `exclusionFamily`. */
const MAX_FAMILY_DEPTH = 16;
/** Cards reload no more often than this, even as `cards_rev` advances. */
const REFRESH_INTERVAL_MS = 5_000;
/** Exact inventory code-token hit: the anchor agents actually query by. */
const CODE_TOKEN_MULT = 1.25;
/** Recency-only near-miss fallback size when nothing matches lexically. */
const NEAR_MISS_LIMIT = 12;

const CARD_FIELDS = ["title", "summary", "outcome", "inventory", "errors", "files"] as const;

const FIELD_BOOST: Record<(typeof CARD_FIELDS)[number], number> = {
  title: 1.0,
  summary: 1.6,
  outcome: 0.8,
  inventory: 2.0,
  errors: 1.2,
  files: 0.6,
};

type CardDoc = {
  id: string;
  title: string;
  summary: string;
  outcome: string;
  inventory: string;
  errors: string;
  files: string;
};

export type CardHit = {
  sessionId: string;
  score: number;
  card: Card;
  directoryRelevance: DirectoryRelevance;
};

export type CardFilters = {
  /** Keep cards with `timeUpdated >= since` (ms epoch). */
  since?: number;
  /** Keep cards with `timeUpdated <= until` (ms epoch). */
  until?: number;
  /** Exact agent match when set. */
  agent?: string;
  /** Directory scope. `exact` keeps only `directory`; `project` keeps the same
   *  project; `global` (default) keeps everything. */
  scope?: "exact" | "project" | "global";
  /** The caller's directory, for scope filtering and relevance labeling. */
  directory?: string;
  /** The caller's project id, for scope filtering and relevance labeling. */
  projectId?: string;
  /** Keep only cards in this directory (explicit `directory` arg). */
  directoryFilter?: string;
  /** Exclude the current session and its whole family (see {@link exclusionFamilyFromCards}). */
  excludeFamilyOf?: string;
};

export type CardsCoverage = {
  totalCards: number;
  fullCards: number;
  /** Newest `timeUpdated` among distilled cards (0 when none). */
  storeRecency: number;
  degraded: boolean;
};

export type CardSource = {
  /** Snapshot of all cards (e.g. `store.allCards()` or static cards-lite). */
  getCards: () => Card[];
  /** Monotonic write revision (`cards_rev`); undefined for static/degraded. */
  revision: () => string | undefined;
  /** True when cards are metadata-only (degraded, no store). */
  degraded?: boolean;
};

export type CardsRuntimeDeps = {
  source: CardSource;
  embedder?: CandidateEmbedder;
  /** Blend weight for the semantic signal, 0..1. */
  semanticWeight?: number;
  now?: () => number;
  refreshIntervalMs?: number;
};

export type CardsRuntime = {
  rank(query: ParsedQuery, filters: CardFilters): CardHit[];
  exclusionFamily(currentSessionId: string): Set<string>;
  /** All cards whose `rootId` equals the given root (the root's family). */
  familyOf(rootId: string): Card[];
  coverage(): CardsCoverage;
  /** Force the next rank() to rebuild from the source (tests). */
  invalidate(): void;
};

function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function toDoc(card: Card): CardDoc {
  return {
    id: card.sessionId,
    title: normalize(card.title),
    summary: normalize(card.summaryHead),
    outcome: normalize(card.outcomeHead),
    // inventory is already a normalized-ish token stream; index it verbatim so
    // both split and whole code tokens survive.
    inventory: card.inventory,
    errors: normalize(card.errors.join(" ")),
    files: normalize(card.files.map(basename).join(" ")),
  };
}

/**
 * The current session's family within the card graph: ascend `parentId` to the
 * highest known ancestor (bounded, cycle-guarded), then collect that ancestor's
 * whole subtree via `rootId`. Produces the SAME set `search.ts`'s
 * `exclusionFamily()` derives from a discovery walk — so the default
 * self-exclusion keeps working without any part fetch. Exported for the
 * equivalence test.
 */
export function exclusionFamilyFromCards(cards: Card[], currentSessionId: string): Set<string> {
  const byId = new Map<string, Card>();
  const childrenByParent = new Map<string, string[]>();
  for (const card of cards) {
    byId.set(card.sessionId, card);
    if (card.parentId) {
      const siblings = childrenByParent.get(card.parentId);
      if (siblings) siblings.push(card.sessionId);
      else childrenByParent.set(card.parentId, [card.sessionId]);
    }
  }

  // Ascend to the top-most known ancestor.
  let root = currentSessionId;
  const seen = new Set([currentSessionId]);
  for (let depth = 0; depth < MAX_FAMILY_DEPTH; depth++) {
    const parentId = byId.get(root)?.parentId;
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    root = parentId;
  }

  // Collect the root's subtree (bounded, cycle-guarded).
  const family = new Set([currentSessionId, root]);
  let frontier = [root];
  for (let depth = 0; depth < MAX_FAMILY_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const childId of childrenByParent.get(id) ?? []) {
        if (family.has(childId)) continue;
        family.add(childId);
        next.push(childId);
      }
    }
    frontier = next;
  }
  return family;
}

/** Build metadata-only cards-lite for degraded mode (store unavailable). */
export function cardsLiteFromSessions(
  sessions: Array<{
    id: string;
    slug?: string;
    title?: string;
    directory?: string;
    projectID?: string;
    parentID?: string;
    time?: { created?: number; updated?: number };
  }>,
): Card[] {
  return sessions.map((s) => ({
    sessionId: s.id,
    parentId: typeof s.parentID === "string" ? s.parentID : null,
    rootId: s.id,
    title: s.title ?? "",
    slug: s.slug ?? "",
    directory: s.directory ?? "",
    projectId: s.projectID ?? "",
    agent: null,
    model: null,
    timeCreated: s.time?.created ?? 0,
    timeUpdated: s.time?.updated ?? 0,
    partCount: 0,
    retainedChars: 0,
    summaryHead: "",
    outcomeHead: "",
    inventory: "",
    files: [],
    tools: [],
    errors: [],
    familyRollup: [],
    distillState: "metadata",
    distilledThrough: null,
    embedding: null,
  }));
}

export function createCardsRuntime(deps: CardsRuntimeDeps): CardsRuntime {
  const now = deps.now ?? Date.now;
  const refreshIntervalMs = deps.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
  const semanticWeight = deps.semanticWeight ?? 0;
  const embedder = deps.embedder;

  let cards: Card[] = [];
  let mini: MiniSearch<CardDoc> | undefined;
  let cardVectors: Map<string, Float32Array> | undefined;
  let lastLoad = -Infinity;
  let lastRevision: string | undefined;
  let loaded = false;

  function embedCards(): void {
    if (!embedder || semanticWeight <= 0) {
      cardVectors = undefined;
      return;
    }
    const vectors = new Map<string, Float32Array>();
    for (const card of cards) {
      const text = `${card.title} ${card.summaryHead} ${card.inventory}`.trim();
      if (!text) continue;
      const vec = embedder.embed(text);
      if (vec) vectors.set(card.sessionId, vec);
    }
    cardVectors = vectors;
  }

  function rebuild(): void {
    cards = deps.source.getCards();
    const index = new MiniSearch<CardDoc>({
      idField: "id",
      fields: [...CARD_FIELDS],
      tokenize: (text: string) => tokenizeAll(text),
    });
    index.addAll(cards.map(toDoc));
    mini = index;
    embedCards();
    lastLoad = now();
    lastRevision = deps.source.revision();
    loaded = true;
  }

  function refreshIfStale(): void {
    if (!loaded) {
      rebuild();
      return;
    }
    if (now() - lastLoad < refreshIntervalMs) return;
    const revision = deps.source.revision();
    if (revision !== lastRevision) rebuild();
    else lastLoad = now(); // nothing changed; defer the next revision check
  }

  function directoryRelevance(card: Card, filters: CardFilters): DirectoryRelevance {
    if (filters.directory && card.directory === filters.directory) return "exact";
    if (filters.projectId && card.projectId === filters.projectId) return "project";
    if (!card.directory && !card.projectId) return "unknown";
    return "global";
  }

  function passesFilters(card: Card, filters: CardFilters, excluded: Set<string>): boolean {
    if (excluded.has(card.sessionId)) return false;
    if (filters.since != null && card.timeUpdated < filters.since) return false;
    if (filters.until != null && card.timeUpdated > filters.until) return false;
    if (filters.agent && card.agent !== filters.agent) return false;
    if (filters.directoryFilter && card.directory !== filters.directoryFilter) return false;
    const scope = filters.scope ?? "global";
    if (scope === "exact" && filters.directory && card.directory !== filters.directory)
      return false;
    if (scope === "project" && filters.projectId && card.projectId !== filters.projectId) {
      return false;
    }
    return true;
  }

  function lexicalHits(query: ParsedQuery): Map<string, number> {
    if (!mini) return new Map();
    const queryText = query.tokens.join(" ");
    if (queryText.trim().length === 0) return new Map();
    const raw = mini.search(queryText, {
      fields: [...CARD_FIELDS],
      boost: FIELD_BOOST,
      combineWith: "OR",
      prefix: (term) => term.length > 3,
      fuzzy: (term) => (term.length >= 4 ? 0.2 : false),
    });
    const top = raw[0]?.score || 1;
    const scores = new Map<string, number>();
    for (const hit of raw) scores.set(String(hit.id), clamp01(hit.score / top));
    return scores;
  }

  function semanticScore(query: ParsedQuery): Map<string, number> {
    const scores = new Map<string, number>();
    if (!embedder || !cardVectors || semanticWeight <= 0 || !embedder.ready) return scores;
    const queryVec = embedder.embed(query.raw);
    if (!queryVec) return scores;
    for (const [sessionId, vec] of cardVectors) {
      scores.set(sessionId, clamp01((cosineSimilarity(queryVec, vec) + 1) / 2));
    }
    return scores;
  }

  return {
    rank(query, filters): CardHit[] {
      refreshIfStale();
      const excluded = filters.excludeFamilyOf
        ? exclusionFamilyFromCards(cards, filters.excludeFamilyOf)
        : new Set<string>();

      const lexical = lexicalHits(query);
      const semantic = semanticScore(query);
      const codeTokens = query.codeTokens.map((t) => t.toLowerCase());

      const hits: CardHit[] = [];
      for (const card of cards) {
        if (!passesFilters(card, filters, excluded)) continue;
        const lex = lexical.get(card.sessionId) ?? 0;
        const sem = semantic.get(card.sessionId) ?? 0;
        if (lex <= 0 && sem <= 0) continue;

        let score = semantic.size > 0 ? (1 - semanticWeight) * lex + semanticWeight * sem : lex;
        if (codeTokens.length > 0) {
          const inventoryLower = card.inventory.toLowerCase();
          if (codeTokens.some((token) => inventoryLower.includes(token))) score *= CODE_TOKEN_MULT;
        }
        score *= recencyMultiplier(card.timeUpdated);
        hits.push({
          sessionId: card.sessionId,
          score,
          card,
          directoryRelevance: directoryRelevance(card, filters),
        });
      }

      hits.sort((a, b) => b.score - a.score || b.card.timeUpdated - a.card.timeUpdated);
      if (hits.length > 0) return hits;

      // No lexical/semantic signal: fall back to recency-ranked near-misses so a
      // broad paraphrase still returns something honest (labeled by the caller).
      return cards
        .filter((card) => passesFilters(card, filters, excluded))
        .sort((a, b) => b.timeUpdated - a.timeUpdated)
        .slice(0, NEAR_MISS_LIMIT)
        .map((card) => ({
          sessionId: card.sessionId,
          score: 0,
          card,
          directoryRelevance: directoryRelevance(card, filters),
        }));
    },

    exclusionFamily(currentSessionId): Set<string> {
      refreshIfStale();
      return exclusionFamilyFromCards(cards, currentSessionId);
    },

    familyOf(rootId): Card[] {
      refreshIfStale();
      return cards.filter((card) => card.rootId === rootId);
    },

    coverage(): CardsCoverage {
      refreshIfStale();
      let full = 0;
      let recency = 0;
      for (const card of cards) {
        if (card.distillState === "full") {
          full++;
          if (card.timeUpdated > recency) recency = card.timeUpdated;
        }
      }
      return {
        totalCards: cards.length,
        fullCards: full,
        storeRecency: recency,
        degraded: deps.source.degraded === true,
      };
    },

    invalidate(): void {
      loaded = false;
    },
  };
}
