import { afterEach, describe, expect, it, vi } from "vitest";
import { openSqlite } from "../src/sqlite.js";
import {
  CARDS_DELETED_KEY,
  CARDS_REV_KEY,
  CARDS_STAMPED_KEY,
  type Card,
  type Store,
} from "../src/store.js";
import {
  createCardsRuntime,
  storeCardSource,
  type CardSource,
  type RankStats,
} from "../src/cards.js";
import { cardVectorStamp, EMBED_REPRESENTATION } from "../src/embedding-text.js";
import { parseQuery } from "../src/query.js";
import { openV1Store } from "./helpers.js";

/**
 * How the card runtime keeps its card map and search index in step with the
 * store: when it reads the store, what it reloads in full and what it applies
 * card by card, which calls do index work, and how chunked builds serve while
 * they run. Ranking parity with a fresh runtime is pinned separately in
 * cards-incremental.test.ts.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

async function freshStore(): Promise<Store> {
  const db = await openSqlite(":memory:");
  if (!db) throw new Error("openSqlite returned null");
  const store = openV1Store(db);
  if (!store) throw new Error("openStore returned null");
  return store;
}

function makeCard(sessionId: string, over: Partial<Card> = {}): Card {
  return {
    sessionId,
    parentId: null,
    rootId: sessionId,
    title: "",
    slug: sessionId,
    directory: "",
    projectId: "",
    agent: null,
    model: null,
    timeCreated: 1000,
    timeUpdated: 2000,
    partCount: 1,
    retainedChars: 1,
    summaryHead: "",
    outcomeHead: "",
    inventory: "",
    files: [],
    tools: [],
    errors: [],
    familyRollup: [],
    distillState: "full",
    distilledThrough: "m1",
    embedding: null,
    embeddingGen: null,
    nlSummary: "",
    summaryHash: "",
    ...over,
  };
}

/** A stamped card write, as the distiller makes it. */
function put(store: Store, sessionId: string, over: Partial<Card> = {}): void {
  store.replaceSessionParts(sessionId, [], makeCard(sessionId, over));
}

/** Zero-padded, so session-id order is numeric order. */
const cardId = (i: number): string => `c${String(i).padStart(3, "0")}`;

const ids = (items: { sessionId: string }[]): string[] => items.map((item) => item.sessionId);

/** Enough distinct content words for a card to earn a vector (see embeddingTextOf). */
const SUBST =
  "reticulate splines calibrate manifold turbine gasket flange bearing sprocket lattice quiver zephyr";

const MODEL = "model-x";

/** Counts the store reads a store-backed source makes. `fullLoads` counts walks
 *  of every card (a keyset page read from the first card). */
function countedSource(store: Store): {
  source: CardSource;
  reads: { stats: number; fullLoads: number; ids: number; vectors: number };
} {
  const base = storeCardSource(store);
  const inner = base.store!;
  const reads = { stats: 0, fullLoads: 0, ids: 0, vectors: 0 };
  return {
    reads,
    source: {
      ...base,
      store: {
        ...inner,
        stats: () => {
          reads.stats++;
          return inner.stats();
        },
        cardIds: () => {
          reads.ids++;
          return inner.cardIds();
        },
        cardsPage: (after, limit, opts) => {
          if (after === undefined) reads.fullLoads++;
          return inner.cardsPage(after, limit, opts);
        },
        vectorsPage: (after, limit) => {
          reads.vectors++;
          return inner.vectorsPage(after, limit);
        },
      },
    },
  };
}

/** A `yieldBetween` held shut until the test lets a slice through (`step`) or
 *  opens it for good, counting the yields. */
function gate(): {
  yieldBetween: () => Promise<void>;
  yields: () => number;
  step: () => void;
  open: () => void;
} {
  let open = false;
  let yields = 0;
  const waiting: Array<() => void> = [];
  const release = (): void => {
    for (const resolve of waiting.splice(0)) resolve();
  };
  return {
    yieldBetween: () => {
      yields++;
      return open ? Promise.resolve() : new Promise<void>((resolve) => waiting.push(resolve));
    },
    yields: () => yields,
    step: release,
    open: () => {
      open = true;
      release();
    },
  };
}

/** Lets every pending callback run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A clock on which every time-budget check finds the slice spent, as on a
 *  machine that indexes no more than one card per slice. */
function slowSlices(): void {
  let t = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (t += 1_000));
}

const vectorBlob = (values: number[]): Uint8Array =>
  new Uint8Array(Float32Array.from(values).buffer);

describe("card map refresh from a store", () => {
  it("reads the store's counters at most once per refresh interval", async () => {
    const store = await freshStore();
    put(store, "s1");
    const { source, reads } = countedSource(store);
    let clock = 1_000_000;
    const runtime = createCardsRuntime({ source, now: () => clock, refreshIntervalMs: 5_000 });

    expect(ids(runtime.list({}))).toEqual(["s1"]);
    const afterLoad = reads.stats;

    put(store, "s2");
    clock += 4_000;
    runtime.list({});
    runtime.get("s2");
    runtime.coverage();
    expect(reads.stats).toBe(afterLoad);
    expect(runtime.get("s2")).toBeUndefined();

    clock += 1_000;
    expect(runtime.get("s2")).toBeDefined();
    runtime.list({});
    expect(reads.stats).toBe(afterLoad + 1);
    // A stamped write arrives without walking every card again.
    expect(reads.fullLoads).toBe(1);
  });

  it.each([
    // A reset store: both counters move back by the same amount, so their
    // difference alone shows nothing.
    { moved: "cards_rev and cards_stamped", keys: [CARDS_REV_KEY, CARDS_STAMPED_KEY] },
    { moved: "cards_deleted", keys: [CARDS_DELETED_KEY] },
  ])("reloads every card when $moved goes backwards", async ({ keys }) => {
    const store = await freshStore();
    for (const id of ["s1", "s2", "gone"]) put(store, id);
    store.deleteSession("gone");
    const { source, reads } = countedSource(store);
    const runtime = createCardsRuntime({ source, refreshIntervalMs: 0 });
    await runtime.ready();

    // An unstamped write moves no counter, so no refresh can find it.
    store.upsertCard(makeCard("s-quiet"));
    await runtime.ready();
    expect(ids(runtime.list({}))).not.toContain("s-quiet");

    for (const key of keys) store.setMeta(key, String(Number(store.getMeta(key)) - 1));
    await runtime.ready();
    expect(ids(runtime.list({})).sort()).toEqual(["s-quiet", "s1", "s2"]);
    expect(reads.fullLoads).toBe(2);
  });

  it("reads the store's card ids only when a refresh finds a deletion", async () => {
    const store = await freshStore();
    for (const id of ["s1", "s2", "s3"]) put(store, id);
    const { source, reads } = countedSource(store);
    const runtime = createCardsRuntime({ source, refreshIntervalMs: 0 });
    await runtime.ready();

    put(store, "s1", { title: "Again" });
    await runtime.ready();
    expect(runtime.get("s1")?.title).toBe("Again");
    expect(reads.ids).toBe(0);

    store.deleteSession("s2");
    await runtime.ready();
    expect(ids(runtime.list({})).sort()).toEqual(["s1", "s3"]);
    expect(reads.ids).toBe(1);
    expect(reads.fullLoads).toBe(1);
  });

  it("applies a page of revisions in place and serves the map while a larger set applies in slices", async () => {
    const store = await freshStore();
    for (let i = 0; i < 5; i++) put(store, cardId(i));
    const slices = gate();
    const runtime = createCardsRuntime({
      source: storeCardSource(store),
      refreshIntervalMs: 0,
      yieldBetween: slices.yieldBetween,
    });
    await runtime.ready();

    for (let i = 5; i < 255; i++) put(store, cardId(i));
    expect(runtime.list({})).toHaveLength(255);
    expect(slices.yields()).toBe(0);

    for (let i = 255; i < 506; i++) put(store, cardId(i));
    expect(ids(runtime.list({}))).not.toContain(cardId(505));
    expect(slices.yields()).toBe(1);
    // Accesses meanwhile serve the current map and start nothing new.
    expect(runtime.get(cardId(505))).toBeUndefined();
    expect(slices.yields()).toBe(1);

    slices.open();
    await runtime.ready();
    expect(runtime.list({})).toHaveLength(506);
  });

  it("shares one chunked load between concurrent ready() calls", async () => {
    const store = await freshStore();
    for (let i = 0; i < 300; i++) put(store, cardId(i));
    const { source, reads } = countedSource(store);
    const slices = gate();
    const runtime = createCardsRuntime({
      source,
      now: () => 1_000,
      yieldBetween: slices.yieldBetween,
    });

    const first = runtime.ready();
    const second = runtime.ready();
    await settle();
    expect(reads.fullLoads).toBe(1);

    slices.open();
    await Promise.all([first, second]);
    expect(reads.fullLoads).toBe(1);
    expect(runtime.list({})).toHaveLength(300);
  });

  it("loads in place for an accessor during a cold chunked load, and the older load never replaces it", async () => {
    const store = await freshStore();
    for (let i = 0; i < 300; i++) put(store, cardId(i));
    const { source, reads } = countedSource(store);
    const slices = gate();
    const runtime = createCardsRuntime({
      source,
      now: () => 1_000,
      yieldBetween: slices.yieldBetween,
    });

    // The chunked load reads the first page, then waits.
    const loading = runtime.ready();
    await settle();
    store.patchCardMeta(cardId(0), { title: "Renamed" });

    // A synchronous accessor cannot wait for the chunked load.
    expect(runtime.get(cardId(0))?.title).toBe("Renamed");

    slices.open();
    await loading;
    expect(runtime.get(cardId(0))?.title).toBe("Renamed");
    expect(reads.fullLoads).toBe(2);
  });
});

describe("card vectors", () => {
  it("reloads only the vectors after another process writes one, and nothing after its own write", async () => {
    const store = await freshStore();
    put(store, "s1", { inventory: `first ${SUBST}` });
    put(store, "s2", { inventory: `second ${SUBST}` });
    const embed = vi.fn((text: string) => Float32Array.from(text === "alpha" ? [1, 0] : [0, 1]));
    const { source, reads } = countedSource(store);
    let clock = 1_000_000;
    const runtime = createCardsRuntime({
      source,
      embedder: { ready: true, embed },
      semanticWeight: 0.5,
      semanticModel: MODEL,
      now: () => clock,
      refreshIntervalMs: 5_000,
    });
    const semanticOf = (id: string): number | undefined =>
      runtime.rank(parseQuery("alpha"), {}).find((hit) => hit.sessionId === id)?.semanticScore;

    await runtime.ready({ index: true });
    expect(embed).toHaveBeenCalledTimes(2);
    expect(store.cardStats().vectorsRev).toBe(1);

    clock += 6_000;
    await runtime.ready({ index: true });
    expect(reads.vectors).toBe(0);
    expect(semanticOf("s1")).toBeCloseTo(0.5);

    store.writeCardEmbeddings(cardVectorStamp(MODEL), EMBED_REPRESENTATION, [
      { sessionId: "s1", embedding: vectorBlob([1, 0]), expectedSummaryHash: "" },
    ]);
    clock += 6_000;
    embed.mockClear();
    await runtime.ready({ index: true });
    expect(reads.vectors).toBeGreaterThan(0);
    expect(reads.fullLoads).toBe(1);
    // Both stored vectors are reused under the matching stamp.
    expect(embed).not.toHaveBeenCalled();
    expect(semanticOf("s1")).toBeCloseTo(1);
  });

  it("computes the vectors without reloading cards once the embedder is ready", async () => {
    const store = await freshStore();
    put(store, "s1", { inventory: `first ${SUBST}` });
    put(store, "s2", { inventory: `second ${SUBST}` });
    let ready = false;
    const embedder = {
      get ready() {
        return ready;
      },
      embed: vi.fn(() => Float32Array.from([1, 0])),
    };
    const { source, reads } = countedSource(store);
    const runtime = createCardsRuntime({
      source,
      embedder,
      semanticWeight: 0.5,
      semanticModel: MODEL,
      now: () => 1_000,
    });

    await runtime.ready({ index: true });
    expect(runtime.semanticStatus()?.cardsWithVectors).toBe(0);

    ready = true;
    await runtime.ready({ index: true });
    expect(runtime.semanticStatus()?.cardsWithVectors).toBe(2);
    expect(reads.fullLoads).toBe(1);
  });
});

describe("calls that read only the card map", () => {
  it("never build or update the index or compute vectors", async () => {
    const store = await freshStore();
    put(store, "s1", { inventory: `root ${SUBST}` });
    put(store, "s2", { inventory: `child ${SUBST}`, parentId: "s1", rootId: "s1" });
    put(store, "s3", { inventory: `other ${SUBST}` });
    const embedded: string[] = [];
    const embed = vi.fn((text: string) => {
      embedded.push(text);
      return Float32Array.from([1, 0]);
    });
    let clock = 1_000_000;
    const runtime = createCardsRuntime({
      source: storeCardSource(store),
      embedder: { ready: true, embed },
      semanticWeight: 0.5,
      semanticModel: MODEL,
      now: () => clock,
      refreshIntervalMs: 5_000,
    });
    const readMap = (): void => {
      runtime.list({});
      runtime.get("s1");
      runtime.exclusionFamily("s2");
      runtime.familyOf("s1");
      runtime.coverage();
      runtime.semanticStatus();
    };

    readMap();
    expect(embed).not.toHaveBeenCalled();
    expect(runtime.semanticStatus()?.cardsWithVectors).toBe(0);
    expect(store.cardStats().vectorsRev).toBe(0);

    await runtime.ready({ index: true });
    expect(embed).toHaveBeenCalledTimes(3);

    put(store, "s3", { inventory: `changed ${SUBST}` });
    clock += 6_000;
    readMap();
    expect(runtime.get("s3")?.inventory).toContain("changed");
    expect(embedded.some((text) => text.includes("changed"))).toBe(false);

    runtime.rank(parseQuery("changed"), {});
    expect(embedded.some((text) => text.includes("changed"))).toBe(true);
  });
});

describe("search index updates", () => {
  /** A store of `count` cards reading "alpha shared" plus an "anchor" card
   *  that always matches "omega", and a runtime whose index is built. */
  async function indexedStore(count: number) {
    const store = await freshStore();
    put(store, "anchor", { inventory: "omega anchor" });
    for (let i = 0; i < count; i++) put(store, cardId(i), { inventory: "alpha shared" });
    const slices = gate();
    const runtime = createCardsRuntime({
      source: storeCardSource(store),
      refreshIntervalMs: 0,
      yieldBetween: slices.yieldBetween,
    });
    const omega = (): string[] => ids(runtime.rank(parseQuery("omega"), {})).sort();
    expect(omega()).toEqual(["anchor"]);
    /** Rewrite the first `changed` cards to read "omega shared"; returns the
     *  ids "omega" matches once the index has them. */
    const change = (changed: number): string[] => {
      for (let i = 0; i < changed; i++) put(store, cardId(i), { inventory: "omega shared" });
      return ["anchor", ...Array.from({ length: changed }, (_, i) => cardId(i))].sort();
    };
    return { runtime, slices, omega, change };
  }

  it.each([
    { changed: 64, inPlace: true },
    { changed: 65, inPlace: false },
  ])(
    "with $changed of 140 cards changed, rank() serves them at once: $inPlace",
    async ({ changed, inPlace }) => {
      const { runtime, slices, omega, change } = await indexedStore(140);
      const updated = change(changed);

      slowSlices();
      // A larger update runs in slices while rank() keeps the index it had.
      expect(omega()).toEqual(inPlace ? updated : ["anchor"]);

      slices.open();
      await runtime.ready({ index: true });
      expect(omega()).toEqual(updated);
    },
  );

  it("swaps a full rebuild in whole: rank() serves the previous index until it finishes", async () => {
    // More than half the cards changed, so the index is rebuilt rather than
    // updated card by card.
    const { runtime, slices, omega, change } = await indexedStore(100);
    const updated = change(70);
    slowSlices();

    let finished = false;
    const done = runtime.ready({ index: true }).then(() => {
      finished = true;
    });
    let slicesSeen = 0;
    while (!finished) {
      expect(omega(), `after ${slicesSeen} slices`).toEqual(["anchor"]);
      slices.step();
      await settle();
      slicesSeen++;
    }
    await done;
    expect(slicesSeen).toBeGreaterThan(1);
    expect(omega()).toEqual(updated);
  });

  it("shares one chunked index build between concurrent ready() calls", async () => {
    const store = await freshStore();
    for (const id of ["s1", "s2", "s3"]) put(store, id, { inventory: `${id} ${SUBST}` });
    const embed = vi.fn(() => Float32Array.from([1, 0]));
    const slices = gate();
    const runtime = createCardsRuntime({
      source: storeCardSource(store),
      embedder: { ready: true, embed },
      semanticWeight: 0.5,
      semanticModel: MODEL,
      now: () => 1_000,
      yieldBetween: slices.yieldBetween,
    });
    slowSlices();

    const first = runtime.ready({ index: true });
    await settle();
    expect(slices.yields()).toBe(1);
    const second = runtime.ready({ index: true });
    slices.open();
    await Promise.all([first, second]);

    // One build embeds each card once.
    expect(embed).toHaveBeenCalledTimes(3);
    expect(runtime.semanticStatus()?.cardsWithVectors).toBe(3);
  });
});

describe("cards-lite source", () => {
  it("keeps its cards past the refresh interval until invalidate(), then reloads before any access", () => {
    let liteCards = [makeCard("a", { title: "first widget" })];
    let clock = 1_000;
    // Any build left to run in slices would stay unfinished.
    const slices = gate();
    slowSlices();
    const runtime = createCardsRuntime({
      source: { getCards: () => liteCards, revision: () => undefined, degraded: true },
      now: () => clock,
      refreshIntervalMs: 5_000,
      yieldBetween: slices.yieldBetween,
    });
    expect(ids(runtime.rank(parseQuery("widget"), {}))).toEqual(["a"]);

    liteCards = [...liteCards, makeCard("b", { title: "second widget", timeUpdated: 3000 })];
    clock += 60_000;
    expect(runtime.get("b")).toBeUndefined();
    expect(ids(runtime.list({}))).toEqual(["a"]);

    runtime.invalidate();
    expect(runtime.get("b")?.title).toBe("second widget");
    // The map reloaded through get(); rank() rebuilds the index from it.
    expect(ids(runtime.rank(parseQuery("widget"), {})).sort()).toEqual(["a", "b"]);
  });
});

describe("card ordering", () => {
  it("breaks every tie on the session id, whatever order the cards arrive in", () => {
    // Identical content and times: every score and recency ties.
    const shared = { inventory: "widget parser", rootId: "s-a" };
    const cards = [
      makeCard("s-c", shared),
      makeCard("s-b", shared),
      makeCard("s-a", shared),
      makeCard("k-c", { ...shared, parentId: "s-a" }),
      makeCard("k-b", { ...shared, parentId: "s-a" }),
      makeCard("k-a", { ...shared, parentId: "s-a" }),
    ];
    const runtime = createCardsRuntime({
      source: { getCards: () => cards, revision: () => undefined },
    });
    const all = ["k-a", "k-b", "k-c", "s-a", "s-b", "s-c"];

    expect(ids(runtime.list({}))).toEqual(all);
    expect(ids(runtime.familyOf("s-a"))).toEqual(all);
    expect(ids(runtime.rank(parseQuery("widget"), {}))).toEqual(all);
    // No lexical hit: the recency fallback.
    expect(ids(runtime.rank(parseQuery("nothingmatches"), {}))).toEqual(all);

    const stats: RankStats = { rootOnlySkipped: [] };
    expect(ids(runtime.rank(parseQuery("widget"), { rootOnly: true }, stats))).toEqual([
      "s-a",
      "s-b",
      "s-c",
    ]);
    expect(stats.rootOnlySkipped.map((skip) => skip.card.sessionId)).toEqual(["k-a", "k-b", "k-c"]);
  });
});
