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
 * ties, with scores within a small tolerance. Steps that leave every card's
 * content alone must not make the long-lived runtime embed anything.
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
/** The model another process embeds with. */
const OTHER_MODEL = "model-other";
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

/** Bag-of-words embedder that counts its calls: deterministic, so a reused
 *  vector equals a recomputed one bit for bit. */
function makeEmbedder(): {
  ready: boolean;
  embed: (text: string) => Float32Array | undefined;
  calls: () => number;
} {
  let calls = 0;
  return {
    ready: true,
    calls: () => calls,
    embed(text: string): Float32Array | undefined {
      calls++;
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
}

type World = {
  rand: () => number;
  pick: (n: number) => string[];
  nextId: () => string;
  /** A card for `id` with fresh random content. */
  card: (id: string, parentId?: string | null) => Card;
  /** A random unit-free vector no embedder here would produce. */
  vector: () => Uint8Array;
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
    vector: () => new Uint8Array(new Float32Array(DIM).map(() => rand() - 0.5).buffer),
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

function runtimeOver(
  source: CardSource,
  embedder: ReturnType<typeof makeEmbedder>,
  opts: { refreshIntervalMs?: number; yieldBetween?: () => Promise<void> } = {},
): CardsRuntime {
  return createCardsRuntime({
    source,
    embedder,
    semanticWeight: WEIGHT,
    semanticModel: MODEL,
    ...opts,
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
  | "foreignModelRow"
  | "modelSwitch"
  | "deleteThenInsert"
  | "olderWrite"
  | "olderDelete"
  | "olderNoop"
  | "burst"
  | "smallBurst"
  | "rollupBurst";

/** Every kind, for a runtime that awaits ready() after each step. */
const ALL_STEPS: StepKind[] = [
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
  "foreignModelRow",
  "modelSwitch",
  "deleteThenInsert",
  "olderWrite",
  "olderDelete",
  "olderNoop",
  "burst",
  "rollupBurst",
];

/** Kinds a synchronous rank() applies in place: stamped writes only, no more
 *  revisions than one `cardsSince` page and no more changed cards than the
 *  in-place index update takes. */
const IN_PLACE_STEPS: StepKind[] = [
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
  "deleteThenInsert",
  "smallBurst",
];

/** Steps whose writes only a full load can apply. */
const FULL_LOAD_STEPS = new Set<StepKind>(["olderWrite", "olderDelete", "olderNoop"]);

/** Steps that change no card's content, so every vector this runtime has
 *  stays current and it must embed nothing. */
const NO_EMBED_STEPS = new Set<StepKind>([
  "updateSameText",
  "delete",
  "rollup",
  "foreignVector",
  "foreignModel",
  "foreignModelRow",
  "olderNoop",
  "rollupBurst",
]);

type StepContext = {
  world: World;
  db: SqliteDb;
  store: Store;
  /** Bring the runtime under test up to date mid-step. */
  between: () => Promise<void>;
  /** From here on in this step the runtime under test must embed nothing. */
  quietFromHere: () => void;
};

async function applyStep(kind: StepKind, ctx: StepContext): Promise<void> {
  const { world, db, store } = ctx;
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
  /** A stamped write that changes no content and keeps the card's vector. */
  const rollup = (id: string): void => {
    store.setFamilyRollup(id, [{ sessionId: id, messageId: `m${world.rand()}` }]);
  };
  /** An older build bumps `cards_rev` without stamping anything. */
  const olderBump = (): void => {
    store.setMeta(CARDS_REV_KEY, String(Number(store.getMeta(CARDS_REV_KEY) ?? 0) + 1));
  };
  /** Another process on another model restamps the store, clearing every
   *  stored vector, and stores its own vectors for `targets`, which then reach
   *  this runtime through a stamped write that keeps them. */
  const foreignModel = (targets: string[]): void => {
    store.writeCardEmbeddings(
      cardVectorStamp(OTHER_MODEL),
      EMBED_REPRESENTATION,
      targets.map((id) => ({
        sessionId: id,
        embedding: world.vector(),
        expectedSummaryHash: store.getCard(id)!.summaryHash,
      })),
    );
    for (const id of targets) rollup(id);
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
      if (id) rollup(id);
      return;
    case "rename":
      if (id) store.patchCardMeta(id, { title: world.pick(3).join(" ") });
      return;
    case "foreignVector": {
      // Another process on this model stores a vector the embedder would not
      // produce; every runtime must then use it.
      if (!id) return;
      store.writeCardEmbeddings(cardVectorStamp(MODEL), EMBED_REPRESENTATION, [
        {
          sessionId: id,
          embedding: world.vector(),
          expectedSummaryHash: store.getCard(id)!.summaryHash,
        },
      ]);
      return;
    }
    case "foreignModel":
      foreignModel([]);
      return;
    case "foreignModelRow":
      if (id) foreignModel([id]);
      return;
    case "modelSwitch": {
      // The map takes a few cards carrying another model's vectors, and this
      // runtime restamps the store with its own...
      const switched = ids.filter(() => world.rand() < 0.1).slice(0, 5);
      foreignModel(switched);
      await ctx.between();
      // ...then more than half the cards change without changing content,
      // which takes a full index build. The cards whose map copies still
      // carry the other model's vectors stay out of it.
      ctx.quietFromHere();
      const rest = ids.filter((other) => !switched.includes(other));
      for (const other of rest.slice(0, Math.max(65, Math.ceil(ids.length * 0.7)))) {
        rollup(other);
      }
      return;
    }
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
    case "olderNoop":
      // An older build rewrites a card as it was: a full load that changes nothing.
      if (!id) return;
      store.upsertCard(store.getCard(id)!);
      olderBump();
      return;
    case "burst":
    case "smallBurst":
      // Many stamped revisions between two refreshes, several per card.
      for (let i = 0; i < (kind === "burst" ? 300 : 200); i++) {
        const target = any();
        if (target && store.getCard(target)) update(target);
      }
      return;
    case "rollupBurst":
      // More than half the cards change without changing content.
      for (const other of ids.slice(0, Math.max(65, Math.ceil(ids.length * 0.7)))) {
        rollup(other);
      }
      return;
  }
}

type Variant = {
  name: string;
  cards: number;
  kinds: StepKind[];
  /** Await ready({ index: true }) before ranking, or call rank() straight
   *  away so its synchronous in-place refresh does all the work. */
  awaitReady: boolean;
};

const VARIANTS: Variant[] = [
  // Enough cards that a burst of changes passes the full-build threshold.
  { name: "awaiting ready()", cards: 100, kinds: ALL_STEPS, awaitReady: true },
  { name: "ranking in place", cards: 40, kinds: IN_PLACE_STEPS, awaitReady: false },
];

describe("incremental card runtime parity", () => {
  for (const variant of VARIANTS) {
    for (const seed of [1, 2, 3, 4]) {
      it(
        `ranks like a fresh build after every write, ${variant.name} (seed ${seed})`,
        async () => {
          const world = makeWorld(seed);
          const { db, store } = await freshStore();
          for (let i = 0; i < variant.cards; i++) {
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
          const embedder = makeEmbedder();
          let yields = 0;
          // Interval 0: every access checks the store, as a search past the
          // interval does.
          const incremental = runtimeOver(counted, embedder, {
            refreshIntervalMs: 0,
            yieldBetween: () => {
              yields++;
              return new Promise((resolve) => setTimeout(resolve, 0));
            },
          });
          const refresh = async (): Promise<void> => {
            if (variant.awaitReady) await incremental.ready({ index: true });
            else incremental.rank(parseQuery(QUERIES[0]!), {});
          };
          await refresh();
          let expectedFullLoads = 1;

          for (let step = 0; step < 40; step++) {
            const kind = variant.kinds[Math.floor(world.rand() * variant.kinds.length)]!;
            const label = `seed ${seed} step ${step} (${kind})`;
            let quietFrom = NO_EMBED_STEPS.has(kind) ? embedder.calls() : undefined;
            await applyStep(kind, {
              world,
              db,
              store,
              between: refresh,
              quietFromHere: () => {
                quietFrom = embedder.calls();
              },
            });
            if (FULL_LOAD_STEPS.has(kind)) expectedFullLoads++;

            if (variant.awaitReady) await incremental.ready({ index: true });
            const ids = store.cardSessionIds().sort();
            const familyOf = ids[Math.floor(world.rand() * ids.length)];
            const filters: CardRankFilters[] = [{}, { rootOnly: true }];
            if (familyOf) filters.push({ excludeFamilyOf: familyOf });
            const incrementalRanks = QUERIES.flatMap((q) =>
              filters.map((f) => incremental.rank(parseQuery(q), f)),
            );
            const incrementalList = incremental.list({}).map((c) => c.sessionId);
            const incrementalCoverage = incremental.coverage();
            if (quietFrom !== undefined) {
              // Query embeds aside, the runtime embedded no card.
              const queryEmbeds = QUERIES.length * filters.length;
              expect(embedder.calls() - quietFrom, `${label}: card embeds`).toBe(queryEmbeds);
            }

            // Ranking in place, the reference must not write vectors either, or
            // the runtime under test would see another process's write and
            // reload in the background.
            const freshSource = variant.awaitReady
              ? storeCardSource(store)
              : { ...storeCardSource(store), writeEmbeddings: undefined };
            const fresh = runtimeOver(freshSource, makeEmbedder());
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
            expect(incrementalList, `${label}: list`).toEqual(
              fresh.list({}).map((c) => c.sessionId),
            );
            expect(incrementalCoverage, `${label}: coverage`).toEqual(fresh.coverage());
            expect(incremental.semanticStatus()?.cardsWithVectors, `${label}: vectors`).toBe(
              fresh.semanticStatus()?.cardsWithVectors,
            );
            fresh.dispose();
          }
          expect(fullLoads).toBe(expectedFullLoads);
          // Ranking in place, nothing was left to a chunked build.
          if (!variant.awaitReady) expect(yields).toBe(0);
          incremental.dispose();
          db.close();
        },
        SEED_TIMEOUT_MS,
      );
    }
  }
});
