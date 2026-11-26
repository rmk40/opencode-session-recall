import { describe, expect, it } from "vitest";
import { openSqlite, type SqliteDb } from "../src/sqlite.js";
import { CARDS_REV_KEY, type Card, type Store } from "../src/store.js";
import {
  createCardsRuntime,
  storeCardSource,
  type CardHit,
  type CardRankFilters,
  type CardSource,
  type CardsRuntime,
} from "../src/cards.js";
import { cardVectorStamp, EMBED_REPRESENTATION } from "../src/embedding-text.js";
import { parseQuery } from "../src/query.js";
import { openV1Store } from "./helpers.js";

/**
 * Parity of the incremental card runtime with a freshly built one. Each seed
 * replays a random sequence of store writes; after every step a long-lived
 * runtime (refreshing incrementally) and a runtime built from scratch over the
 * same store must rank alike: the same ids, in the same order up to score
 * ties, with scores within a small tolerance.
 */

/** Each seed replays about a thousand store writes, so allow for a loaded machine. */
const SEED_TIMEOUT_MS = 60_000;

async function freshStore(): Promise<{ db: SqliteDb; store: Store }> {
  const db = await openSqlite(":memory:");
  if (!db) throw new Error("openSqlite returned null");
  const store = openV1Store(db);
  if (!store) throw new Error("openStore returned null");
  return { db, store };
}

/** Deterministic PRNG, so a seed always replays the same writes. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "anchor",
  "bridge",
  "cobalt",
  "delta",
  "ember",
  "falcon",
  "garnet",
  "harbor",
  "indigo",
  "jasper",
  "kernel",
  "lantern",
  "meadow",
  "nickel",
  "orchid",
  "pepper",
  "quartz",
  "raven",
  "saddle",
  "timber",
  "umber",
  "velvet",
  "walnut",
  "yonder",
  "zenith",
  "parser",
  "router",
  "socket",
  "buffer",
  "cursor",
  "ledger",
  "mirror",
];

const QUERIES = [
  "anchor bridge",
  "cobalt",
  "falcon garnet harbor",
  "kernel lantern",
  "parser router socket",
  "zenith",
  "ledger mirror cursor",
  "velvet walnut",
];

const DIM = 16;
const MODEL = "model-parity";
const WEIGHT = 0.4;
/** Relative score tolerance: incremental updates keep MiniSearch's running
 *  field-length averages in a different float order than a fresh build. */
const TOLERANCE = 1e-9;
/** Old enough that the recency prior is exactly 1, so wall time between the two
 *  rankings cannot move a score. */
const BASE_TIME = 1_000_000;

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Bag-of-words embedder: deterministic, so a reused vector equals a recomputed
 *  one bit for bit. */
const embedder = {
  ready: true,
  embed(text: string): Float32Array | undefined {
    const vec = new Float32Array(DIM);
    for (const token of text.toLowerCase().split(/[^a-z]+/)) {
      if (token.length >= 4) vec[hashToken(token) % DIM]! += 1;
    }
    let norm = 0;
    for (const x of vec) norm += x * x;
    if (norm === 0) return undefined;
    norm = Math.sqrt(norm);
    for (let i = 0; i < DIM; i++) vec[i]! /= norm;
    return vec;
  },
};

type World = {
  rand: () => number;
  pick: (n: number) => string[];
  nextId: () => string;
  /** A card for `id` with fresh random content. */
  card: (id: string, parentId?: string | null) => Card;
};

function makeWorld(seed: number): World {
  const rand = mulberry32(seed);
  const pick = (n: number): string[] =>
    Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]!);
  let next = 0;
  return {
    rand,
    pick,
    nextId: () => `s${String(next++).padStart(3, "0")}`,
    card: (id, parentId = null) => ({
      sessionId: id,
      parentId,
      rootId: parentId ?? id,
      title: pick(2).join(" "),
      slug: id,
      directory: "/proj",
      projectId: "p1",
      agent: null,
      model: null,
      timeCreated: BASE_TIME,
      // Few distinct values, so recency ties exercise the id tiebreak.
      timeUpdated: BASE_TIME + Math.floor(rand() * 8) * 1000,
      partCount: 1 + Math.floor(rand() * 5),
      retainedChars: 100,
      summaryHead: pick(4).join(" "),
      outcomeHead: pick(2).join(" "),
      // Some cards stay under the embedding floor and get no vector.
      inventory: pick(rand() < 0.2 ? 3 : 18).join(" "),
      files: [`src/${pick(1)[0]}.ts`],
      tools: ["bash"],
      errors: rand() < 0.3 ? [pick(2).join(" ")] : [],
      familyRollup: [],
      distillState: rand() < 0.1 ? "metadata" : "full",
      distilledThrough: "m1",
      embedding: null,
      embeddingGen: null,
      nlSummary: "",
      summaryHash: "",
    }),
  };
}

function runtimeOver(source: CardSource, refreshIntervalMs?: number): CardsRuntime {
  return createCardsRuntime({
    source,
    embedder,
    semanticWeight: WEIGHT,
    semanticModel: MODEL,
    refreshIntervalMs,
  });
}

/** Same ids, the same order up to ties, and scores within {@link TOLERANCE}. */
function expectSameRanking(actual: CardHit[], expected: CardHit[], label: string): void {
  expect(actual.map((h) => h.sessionId).sort(), `${label}: ids`).toEqual(
    expected.map((h) => h.sessionId).sort(),
  );
  const close = (a: number, b: number): boolean =>
    Math.abs(a - b) <= TOLERANCE * Math.max(1, Math.abs(b));
  const expectedScore = new Map(expected.map((h) => [h.sessionId, h.score]));
  const expectedSemantic = new Map(expected.map((h) => [h.sessionId, h.semanticScore]));
  actual.forEach((hit, i) => {
    // The id at this position must score what the fresh ranking's id here
    // scores: equal ids, or ids whose scores tie.
    expect(
      close(expectedScore.get(hit.sessionId)!, expected[i]!.score),
      `${label}: order @${i}`,
    ).toBe(true);
    expect(
      close(hit.score, expectedScore.get(hit.sessionId)!),
      `${label}: score ${hit.sessionId}`,
    ).toBe(true);
    const sem = expectedSemantic.get(hit.sessionId);
    expect(hit.semanticScore === undefined, `${label}: semantic ${hit.sessionId}`).toBe(
      sem === undefined,
    );
    if (sem !== undefined) expect(close(hit.semanticScore!, sem)).toBe(true);
  });
}

type StepKind =
  | "insert"
  | "update"
  | "updateSameText"
  | "delete"
  | "summary"
  | "rollup"
  | "rename"
  | "foreignVector"
  | "foreignModel"
  | "deleteThenInsert"
  | "olderWrite"
  | "olderDelete"
  | "burst";

const STEP_KINDS: StepKind[] = [
  "insert",
  "insert",
  "update",
  "update",
  "updateSameText",
  "delete",
  "summary",
  "summary",
  "rollup",
  "rename",
  "foreignVector",
  "foreignVector",
  "foreignModel",
  "deleteThenInsert",
  "olderWrite",
  "olderDelete",
  "burst",
];

/** Steps whose writes only a full load can apply. */
const FULL_LOAD_STEPS = new Set<StepKind>(["olderWrite", "olderDelete"]);

function applyStep(kind: StepKind, world: World, db: SqliteDb, store: Store): void {
  const ids = store.cardSessionIds().sort();
  const any = (): string | undefined =>
    ids.length > 0 ? ids[Math.floor(world.rand() * ids.length)] : undefined;
  const insert = (): void => {
    const id = world.nextId();
    const parent = world.rand() < 0.3 ? (any() ?? null) : null;
    store.replaceSessionParts(id, [], world.card(id, parent));
  };
  /** A newer build's stamped rewrite of one card's content. */
  const update = (id: string): void => {
    const stored = store.getCard(id)!;
    store.replaceSessionParts(id, [], {
      ...world.card(id, stored.parentId),
      rootId: stored.rootId,
    });
  };
  /** An older build bumps `cards_rev` without stamping anything. */
  const olderBump = (): void => {
    store.setMeta(CARDS_REV_KEY, String(Number(store.getMeta(CARDS_REV_KEY) ?? 0) + 1));
  };

  const id = any();
  switch (kind) {
    case "insert":
      insert();
      return;
    case "update":
      if (id) update(id);
      return;
    case "updateSameText": {
      // Stamped, but nothing the index or the embedding reads changes.
      if (!id) return;
      const stored = store.getCard(id)!;
      store.replaceSessionParts(id, [], { ...stored, partCount: stored.partCount + 1 });
      return;
    }
    case "delete":
      if (id) store.deleteSession(id);
      return;
    case "summary":
      if (id) store.writeSummary(id, world.pick(6).join(" "), `h${world.rand()}`);
      return;
    case "rollup":
      if (id) store.setFamilyRollup(id, [{ sessionId: id, messageId: `m${world.rand()}` }]);
      return;
    case "rename":
      if (id) store.patchCardMeta(id, { title: world.pick(3).join(" ") });
      return;
    case "foreignVector": {
      // Another process persists a vector the embedder would not produce.
      if (!id) return;
      const stored = store.getCard(id)!;
      const vec = new Float32Array(DIM).map(() => world.rand() - 0.5);
      store.writeCardEmbeddings(cardVectorStamp(MODEL), EMBED_REPRESENTATION, [
        {
          sessionId: id,
          embedding: new Uint8Array(vec.buffer),
          expectedSummaryHash: stored.summaryHash,
        },
      ]);
      return;
    }
    case "foreignModel":
      // Another process on another model restamps the store, clearing every vector.
      store.writeCardEmbeddings(cardVectorStamp("model-other"), EMBED_REPRESENTATION, []);
      return;
    case "deleteThenInsert":
      if (id) store.deleteSession(id);
      insert();
      return;
    case "olderWrite": {
      // An older build's unstamped rewrite, then a newer build's stamped one.
      if (!id) return;
      const stored = store.getCard(id)!;
      store.upsertCard({ ...world.card(id, stored.parentId), rootId: stored.rootId });
      olderBump();
      const other = any();
      if (other) update(other);
      return;
    }
    case "olderDelete": {
      // An older build's delete leaves no deletion count, then a newer write.
      if (!id) return;
      db.run("DELETE FROM card WHERE session_id=?", [id]);
      olderBump();
      const rest = store.cardSessionIds();
      const other = rest[Math.floor(world.rand() * rest.length)];
      if (other) update(other);
      return;
    }
    case "burst":
      // Many stamped revisions between two refreshes, several per card.
      for (let i = 0; i < 300; i++) {
        const target = any();
        if (target && store.getCard(target)) update(target);
      }
      return;
  }
}

describe("incremental card runtime parity", () => {
  for (const seed of [1, 2, 3, 4]) {
    it(
      `ranks like a fresh build after every write (seed ${seed})`,
      async () => {
        const world = makeWorld(seed);
        const { db, store } = await freshStore();
        for (let i = 0; i < 40; i++) {
          const id = world.nextId();
          store.replaceSessionParts(id, [], world.card(id));
        }

        // Count full loads: everything else must reach the runtime incrementally.
        const source = storeCardSource(store);
        const reads = source.store!;
        let fullLoads = 0;
        const counted: CardSource = {
          ...source,
          store: {
            ...reads,
            cardsPage: (after, limit, opts) => {
              if (after === undefined) fullLoads++;
              return reads.cardsPage(after, limit, opts);
            },
          },
        };
        // Interval 0: every access checks the store, as a search past the
        // interval does.
        const incremental = runtimeOver(counted, 0);
        await incremental.ready({ index: true });
        let expectedFullLoads = 1;

        for (let step = 0; step < 40; step++) {
          const kind = STEP_KINDS[Math.floor(world.rand() * STEP_KINDS.length)]!;
          applyStep(kind, world, db, store);
          if (FULL_LOAD_STEPS.has(kind)) expectedFullLoads++;
          const label = `seed ${seed} step ${step} (${kind})`;

          await incremental.ready({ index: true });
          const ids = store.cardSessionIds().sort();
          const familyOf = ids[Math.floor(world.rand() * ids.length)];
          const filters: CardRankFilters[] = [{}, { rootOnly: true }];
          if (familyOf) filters.push({ excludeFamilyOf: familyOf });
          const incrementalRanks = QUERIES.flatMap((q) =>
            filters.map((f) => incremental.rank(parseQuery(q), f)),
          );
          const incrementalList = incremental.list({}).map((c) => c.sessionId);
          const incrementalCoverage = incremental.coverage();

          const fresh = runtimeOver(storeCardSource(store));
          await fresh.ready({ index: true });
          let n = 0;
          for (const q of QUERIES) {
            for (const f of filters) {
              expectSameRanking(
                incrementalRanks[n++]!,
                fresh.rank(parseQuery(q), f),
                `${label} "${q}" ${JSON.stringify(f)}`,
              );
            }
          }
          expect(incrementalList, `${label}: list`).toEqual(fresh.list({}).map((c) => c.sessionId));
          expect(incrementalCoverage, `${label}: coverage`).toEqual(fresh.coverage());
          expect(incremental.semanticStatus()?.cardsWithVectors, `${label}: vectors`).toBe(
            fresh.semanticStatus()?.cardsWithVectors,
          );
          fresh.dispose();
        }
        expect(fullLoads).toBe(expectedFullLoads);
        incremental.dispose();
        db.close();
      },
      SEED_TIMEOUT_MS,
    );
  }
});
