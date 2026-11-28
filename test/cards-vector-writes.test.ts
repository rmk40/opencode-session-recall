import { afterEach, describe, expect, it, vi } from "vitest";
import { openSqlite } from "../src/sqlite.js";
import type { Card, Store } from "../src/store.js";
import {
  createCardsRuntime,
  inlineVectorWriter,
  storeCardSource,
  type CardHit,
  type CardSource,
  type CardsRuntime,
  type CardVectorWriteResult,
} from "../src/cards.js";
import { cardVectorStamp, EMBED_REPRESENTATION, embeddingTextOf } from "../src/embedding-text.js";
import { createForegroundSignal } from "../src/foreground.js";
import { parseQuery } from "../src/query.js";
import { yieldBackgroundTo } from "../src/yield.js";
import {
  fakeVectorWriter,
  type FakeVectorWriter,
  type PendingVectorWrite,
} from "./fake-vector-writer.js";
import { openScratchReader, openV1Store } from "./helpers.js";

/**
 * How the card runtime persists the card vectors it computes: after it has
 * installed them, one write at a time through an asynchronous writer, with
 * no search, rank() or ready() waiting on a write, and with its view of
 * `vectors_rev` moved only by acknowledgements that prove a write its own.
 */

afterEach(() => {
  yieldBackgroundTo(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const MODEL = "model-x";
const REFRESH_MS = 5_000;
/** Enough distinct content words for a card to earn a vector (see embeddingTextOf). */
const SUBST =
  "reticulate splines calibrate manifold turbine gasket flange bearing sprocket lattice quiver zephyr";

/** Zero-padded, so session-id order is numeric order. */
const cardId = (i: number): string => `c${String(i).padStart(3, "0")}`;
const range = (from: number, to: number): string[] =>
  Array.from({ length: to - from }, (_, i) => cardId(from + i));

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
    inventory: `${sessionId} ${SUBST}`,
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

/** A repeatable vector of its own for each text (FNV-1a over its characters). */
function vectorOf(text: string): Float32Array {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return Float32Array.from([(h & 0xffff) / 0xffff, (h >>> 16) / 0xffff, 1]);
}

/** The vector the runtime embeds for the card the store holds now. */
function vectorFor(store: Store, sessionId: string): Float32Array {
  const card = store.getCard(sessionId);
  const text = card && embeddingTextOf(card);
  if (!text) throw new Error(`no embedding text for ${sessionId}`);
  return vectorOf(text);
}

const decode = (bytes: Uint8Array): number[] =>
  Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));

const blobOf = (vector: Float32Array): Uint8Array => new Uint8Array(vector.buffer.slice(0));

/** One turn of the event loop, after every pending microtask. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function turns(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await turn();
}

/** Whether `promise` has settled, readable at any later point. */
function track(promise: Promise<unknown>): { settled: () => boolean } {
  let settled = false;
  const done = (): void => {
    settled = true;
  };
  void promise.then(done, done);
  return { settled: () => settled };
}

/** A `yieldBetween` that passes straight through until `hold()`, then keeps
 *  every caller waiting until `release()`. */
function holdable(): {
  yieldBetween: () => Promise<void>;
  hold: () => void;
  release: () => void;
  held: () => number;
} {
  let holding = false;
  const waiting: Array<() => void> = [];
  return {
    yieldBetween: () =>
      holding ? new Promise<void>((resolve) => waiting.push(resolve)) : Promise.resolve(),
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const resolve of waiting.splice(0)) resolve();
    },
    held: () => waiting.length,
  };
}

/** `base` with its persisted-vector page reads counted. */
function countingVectorReads(base: CardSource): { source: CardSource; reads: { vectors: number } } {
  const inner = base.store!;
  const reads = { vectors: 0 };
  return {
    reads,
    source: {
      ...base,
      store: {
        ...inner,
        vectorsPage: (after, limit) => {
          reads.vectors++;
          return inner.vectorsPage(after, limit);
        },
      },
    },
  };
}

type Harness = {
  store: Store;
  writer: FakeVectorWriter;
  runtime: CardsRuntime;
  gate: ReturnType<typeof holdable>;
  /** Persisted-vector pages the runtime read: one or more per vector reload. */
  reads: { vectors: number };
  logs: string[];
  /** Move the runtime's clock past its refresh interval. */
  later: () => void;
  rank: () => CardHit[];
  /** The session ids of each write handed to the writer, in order. */
  written: () => string[][];
};

/**
 * A store of `cards` cards and a card runtime over it with semantic search
 * on, persisting vectors through a {@link fakeVectorWriter} whose writes
 * commit to the store only when the test says so. Between two writes the
 * runtime yields through a {@link holdable} gate, or through its default
 * yield point with `defaultYield`.
 */
async function harness(cards: number, o: { defaultYield?: boolean } = {}): Promise<Harness> {
  const db = await openSqlite(":memory:");
  const store = db && openV1Store(db);
  if (!store) throw new Error("store did not open");
  for (let i = 0; i < cards; i++) put(store, cardId(i));
  const writer = fakeVectorWriter(store);
  const { source, reads } = countingVectorReads(storeCardSource(store, writer.write));
  const gate = holdable();
  const logs: string[] = [];
  let clock = 1_000_000;
  const runtime = createCardsRuntime({
    source,
    embedder: { ready: true, embed: vectorOf },
    semanticWeight: 0.5,
    semanticModel: MODEL,
    now: () => clock,
    refreshIntervalMs: REFRESH_MS,
    ...(!o.defaultYield && { yieldBetween: gate.yieldBetween }),
    log: (line) => logs.push(line),
  });
  return {
    store,
    writer,
    runtime,
    gate,
    reads,
    logs,
    later: () => {
      clock += REFRESH_MS + 1;
    },
    rank: () => runtime.rank(parseQuery("reticulate splines"), {}),
    written: () => writer.calls.map((call) => call.rows.map((row) => row.sessionId)),
  };
}

/** Count one foreground operation on `signal` until the returned function is
 *  called, as a search running on another thread does. */
function holdForeground(signal: ReturnType<typeof createForegroundSignal>): () => Promise<void> {
  let finish!: () => void;
  const running = signal.run(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  return async () => {
    finish();
    await running;
  };
}

describe("card vector writes", () => {
  it("installs the index and the vectors first and issues the first write on the caller's turn, which no rank() or ready() awaits", async () => {
    const h = await harness(3);
    const hits = h.rank();
    // Synchronously, within that rank(): the index and vectors serve, and the
    // write is issued but not answered.
    expect(hits.map((hit) => hit.sessionId).sort()).toEqual(range(0, 3));
    expect(hits.every((hit) => hit.semanticScore !== undefined)).toBe(true);
    expect(h.runtime.semanticStatus()?.cardsWithVectors).toBe(3);
    expect(h.written()).toEqual([range(0, 3)]);
    expect(h.writer.calls[0]).toMatchObject({
      model: cardVectorStamp(MODEL),
      gen: EMBED_REPRESENTATION,
    });
    expect(h.store.getCard(cardId(0))?.embedding).toBeNull();

    const ready = track(h.runtime.ready({ index: true }));
    await turns();
    expect(ready.settled()).toBe(true);
    expect(h.rank().every((hit) => hit.semanticScore !== undefined)).toBe(true);
    expect(h.writer.pending).toHaveLength(1);

    h.writer.next().commit();
    expect(await h.runtime.flushVectorWrites()).toBe(true);
    expect(decode(h.store.getCard(cardId(1))!.embedding!)).toEqual(
      Array.from(vectorFor(h.store, cardId(1))),
    );
  });

  it("issues one write at a time in queue order, in chunks of 200, each after a yield", async () => {
    const h = await harness(450);
    h.rank();
    expect(h.written()).toEqual([range(0, 200)]);

    h.gate.hold();
    h.writer.next().commit();
    await turns();
    // Acknowledged; the next write waits on the yield.
    expect(h.writer.calls).toHaveLength(1);
    expect(h.gate.held()).toBe(1);

    h.gate.release();
    await turns();
    expect(h.written()).toEqual([range(0, 200), range(200, 400)]);
    await turns();
    // One in flight: nothing more is issued until it is answered.
    expect(h.writer.calls).toHaveLength(2);

    h.writer.next().commit();
    await turns();
    expect(h.written()).toEqual([range(0, 200), range(200, 400), range(400, 450)]);
    h.writer.next().commit();
    expect(await h.runtime.flushVectorWrites()).toBe(true);
    expect(h.writer.calls).toHaveLength(3);
    const stored = h.store.cardVectorsPage(undefined, 500).filter((row) => row.embedding);
    expect(stored).toHaveLength(450);
  });

  it("skips a queued row a later pass superseded, and writes the later pass's row after it", async () => {
    const h = await harness(210);
    h.rank();
    h.gate.hold();
    h.writer.next().commit();
    await turns();

    // c205 waits in the queue's second chunk when its content changes and an
    // in-place update queues a new vector for it.
    put(h.store, cardId(205), { inventory: `${cardId(205)} rewritten ${SUBST} omega` });
    h.later();
    h.rank();
    const rewritten = vectorFor(h.store, cardId(205));

    h.gate.release();
    await turns();
    expect(h.written()[1]).toEqual(range(200, 210).filter((id) => id !== cardId(205)));
    h.writer.next().commit();
    await turns();
    expect(h.written()[2]).toEqual([cardId(205)]);
    expect(decode(h.writer.calls[2]!.rows[0]!.embedding)).toEqual(Array.from(rewritten));
    h.writer.next().commit();
    expect(await h.runtime.flushVectorWrites()).toBe(true);
    expect(h.writer.calls).toHaveLength(3);
    expect(decode(h.store.getCard(cardId(205))!.embedding!)).toEqual(Array.from(rewritten));
  });

  it("skips a queued row whose card left the map or no longer indexes as it did, and writes one whose card changed elsewhere", async () => {
    const h = await harness(210);
    h.rank();
    h.gate.hold();
    h.writer.next().commit();
    await turns();

    put(h.store, cardId(205), { inventory: `${cardId(205)} rewritten ${SUBST} omega` });
    put(h.store, cardId(206), { timeUpdated: 9_000 });
    h.store.deleteSession(cardId(207));
    // A map-only accessor applies the changes; no index pass queues anything.
    h.later();
    expect(h.runtime.get(cardId(207))).toBeUndefined();
    expect(h.runtime.get(cardId(206))?.timeUpdated).toBe(9_000);

    h.gate.release();
    await turns();
    expect(h.written()[1]).toEqual(
      range(200, 210).filter((id) => id !== cardId(205) && id !== cardId(207)),
    );
    h.writer.next().commit();
    expect(await h.runtime.flushVectorWrites()).toBe(true);
    expect(h.writer.calls).toHaveLength(2);
  });

  it("hands the writer each embedding in a buffer of its own, which it may transfer", async () => {
    const h = await harness(3);
    const before = h.rank().map((hit) => [hit.sessionId, hit.semanticScore]);
    const rows = h.writer.calls[0]!.rows;
    const buffers = new Set(rows.map((row) => row.embedding.buffer));
    expect(buffers.size).toBe(rows.length);
    for (const row of rows) {
      expect(row.embedding.byteOffset).toBe(0);
      expect(row.embedding.buffer.byteLength).toBe(row.embedding.byteLength);
      expect(decode(row.embedding)).toEqual(Array.from(vectorFor(h.store, row.sessionId)));
    }

    // Transferring them away leaves the vectors that serve searches intact.
    for (const row of rows) {
      structuredClone(row.embedding, { transfer: [row.embedding.buffer as ArrayBuffer] });
      expect(row.embedding.byteLength).toBe(0);
    }
    expect(h.rank().map((hit) => [hit.sessionId, hit.semanticScore])).toEqual(before);
    h.writer.next().fail("transferred");
    expect(await h.runtime.flushVectorWrites()).toBe(true);
  });
});

describe("acknowledgements of card vector writes", () => {
  it.each<{
    name: string;
    answer: (write: PendingVectorWrite) => void;
    advances: boolean;
  }>([
    {
      name: "committed at the next revision",
      answer: (write) => write.ack({ status: "committed", revision: 1 }),
      advances: true,
    },
    {
      name: "committed at a later revision",
      answer: (write) => write.ack({ status: "committed", revision: 2 }),
      advances: false,
    },
    { name: "refused", answer: (write) => write.refuse(), advances: false },
    { name: "failed", answer: (write) => write.fail(), advances: false },
    {
      name: "rejected",
      answer: (write) => write.reject(new Error("writer stopped")),
      advances: false,
    },
    {
      name: "committed with a revision that is not a number",
      answer: (write) =>
        write.ack({ status: "committed", revision: "1" } as unknown as CardVectorWriteResult),
      advances: false,
    },
    {
      name: "answered with no result",
      answer: (write) => write.ack(undefined as unknown as CardVectorWriteResult),
      advances: false,
    },
  ])(
    "a write $name that did commit moves the cached vectors revision only when proven its own",
    async ({ answer, advances }) => {
      const h = await harness(3);
      h.rank();
      const write = h.writer.next();
      // The write commits as the writer would make it; only its answer differs.
      expect(h.store.writeCardEmbeddings(write.model, write.gen, write.rows)).toEqual({
        revision: 1,
        committed: true,
      });
      answer(write);
      expect(await h.runtime.flushVectorWrites()).toBe(true);
      // The vectors keep serving whatever the answer.
      expect(h.runtime.semanticStatus()?.cardsWithVectors).toBe(3);
      // A write that is not proven its own counts as another process's, so
      // the next refresh reloads the vectors.
      h.later();
      await h.runtime.ready({ index: true });
      expect(h.reads.vectors > 0).toBe(!advances);
    },
  );

  it("logs one line for a pass whose writes failed or were refused, and none for one that committed", async () => {
    const committed = await harness(3);
    committed.rank();
    committed.writer.next().commit();
    expect(await committed.runtime.flushVectorWrites()).toBe(true);
    expect(committed.logs).toEqual([]);

    const h = await harness(201);
    h.rank();
    h.writer.next().fail("disk full");
    await turns();
    h.writer.next().refuse("lower generation");
    expect(await h.runtime.flushVectorWrites()).toBe(true);
    expect(h.writer.calls).toHaveLength(2);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("1 of 2");
    expect(h.logs[0]).toContain("1 were refused");
    expect(h.logs[0]).toContain("disk full");
  });

  it("takes its own commit, seen by a refresh before its acknowledgement, as its own", async () => {
    const h = await harness(3);
    h.rank();
    const write = h.writer.next();
    h.store.writeCardEmbeddings(write.model, write.gen, write.rows);
    h.later();
    h.rank();
    expect(h.reads.vectors).toBe(0);

    write.ack({ status: "committed", revision: 1 });
    expect(await h.runtime.flushVectorWrites()).toBe(true);
    h.later();
    await h.runtime.ready({ index: true });
    expect(h.reads.vectors).toBe(0);
  });

  it("reloads the vectors once the acknowledgement arrives when a refresh during the write saw another process's write", async () => {
    const h = await harness(3);
    h.rank();
    const write = h.writer.next();
    h.store.writeCardEmbeddings(write.model, write.gen, write.rows);
    h.store.writeCardEmbeddings(cardVectorStamp(MODEL), EMBED_REPRESENTATION, [
      { sessionId: cardId(0), embedding: blobOf(vectorOf("elsewhere")), expectedSummaryHash: "" },
    ]);
    h.later();
    h.rank();
    // Nothing reloads while the write is in flight.
    expect(h.reads.vectors).toBe(0);

    write.ack({ status: "committed", revision: 1 });
    expect(await h.runtime.flushVectorWrites()).toBe(true);
    await h.runtime.ready({ index: true });
    expect(h.reads.vectors).toBeGreaterThan(0);
  });
});

describe("shutting card vector writes down", () => {
  it("drops the queued writes on dispose and lets the write in flight settle and apply", async () => {
    const h = await harness(450);
    h.rank();
    const flushed = track(h.runtime.flushVectorWrites());
    h.runtime.dispose();
    await turns();
    expect(flushed.settled()).toBe(false);

    h.writer.next().commit();
    await turns();
    expect(flushed.settled()).toBe(true);
    expect(await h.runtime.flushVectorWrites()).toBe(true);
    await turns();
    expect(h.writer.calls).toHaveLength(1);
    // The acknowledged commit moved the cached revision: the store's
    // vectors_rev reads as this runtime's own, so nothing reloads.
    h.later();
    h.rank();
    expect(h.reads.vectors).toBe(0);
  });

  it("resolves flushVectorWrites true once nothing is queued or in flight, and false when its deadline passes first", async () => {
    const h = await harness(3);
    expect(await h.runtime.flushVectorWrites()).toBe(true);

    h.rank();
    expect(await h.runtime.flushVectorWrites(20)).toBe(false);
    expect(await h.runtime.flushVectorWrites(-1)).toBe(false);
    expect(await h.runtime.flushVectorWrites(Number.NaN)).toBe(false);
    const unbounded = track(h.runtime.flushVectorWrites());
    await turns();
    expect(unbounded.settled()).toBe(false);

    h.writer.next().commit();
    await turns();
    expect(unbounded.settled()).toBe(true);
    expect(await h.runtime.flushVectorWrites(20)).toBe(true);
  });

  it("issues its writes while this thread's background yields give way to a foreground signal", async () => {
    // The fake timers would hold any wait on the signal forever, and the
    // fixed clock leaves the slice spent at the yield between the writes.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const clock = performance.now() + 1_000_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const signal = createForegroundSignal();
    const release = holdForeground(signal);
    yieldBackgroundTo(signal);
    try {
      const h = await harness(201, { defaultYield: true });
      h.rank();
      h.writer.next().commit();
      for (let i = 0; i < 20 && h.writer.calls.length < 2; i++) await turn();
      expect(h.written()).toEqual([range(0, 200), [cardId(200)]]);
      h.writer.next().commit();
      expect(await h.runtime.flushVectorWrites()).toBe(true);
    } finally {
      await release();
    }
  });
});

describe("card vector writers and the sources that hold them", () => {
  const embedder = { ready: true, embed: vectorOf };

  it("inlineVectorWriter writes through the store at the call and reports it as committed, refused or failed, never rejecting", async () => {
    const db = await openSqlite(":memory:");
    const store = db && openV1Store(db);
    if (!store) throw new Error("store did not open");
    put(store, "s1");
    const row = {
      sessionId: "s1",
      embedding: new Uint8Array([1, 2, 3, 4]),
      expectedSummaryHash: "",
    };
    const write = inlineVectorWriter(store);

    const committed = write("model-y:5", 5, [row]);
    expect(store.getMeta("vectors_rev")).toBe("1");
    expect(await committed).toEqual({ status: "committed", revision: 1 });
    // A stored vector of a higher generation refuses the write wholesale.
    expect(await write("model-x:4", 4, [row])).toMatchObject({ status: "refused" });
    expect(store.getMeta("vectors_rev")).toBe("1");

    const broken = inlineVectorWriter({
      writeCardEmbeddings: () => {
        throw new Error("disk full");
      },
    });
    await expect(broken("model-x:4", 4, [row])).resolves.toEqual({
      status: "failed",
      error: "disk full",
    });
  });

  it("keeps the vectors it computes in memory and writes none over a source without a writer", async () => {
    const db = await openSqlite(":memory:");
    const store = db && openV1Store(db);
    if (!store) throw new Error("store did not open");
    for (let i = 0; i < 3; i++) put(store, cardId(i));
    const runtime = createCardsRuntime({
      source: storeCardSource(store, undefined),
      embedder,
      semanticWeight: 0.5,
      semanticModel: MODEL,
    });
    const hits = runtime.rank(parseQuery("reticulate"), {});
    expect(hits).toHaveLength(3);
    expect(hits.every((hit) => hit.semanticScore !== undefined)).toBe(true);
    expect(runtime.semanticStatus()?.cardsWithVectors).toBe(3);
    expect(await runtime.flushVectorWrites()).toBe(true);
    expect(store.cardCounters().vectorsRev).toBe(0);
    expect(store.getMeta("semantic_model")).toBeUndefined();
  });

  it("serves a runtime over a read-only store connection and takes the commit its writer made as its own", async () => {
    const scratch = await openScratchReader({
      seed: (store) => {
        for (let i = 0; i < 3; i++) put(store, cardId(i));
      },
    });
    try {
      if (!scratch.opened.ok) throw new Error(scratch.opened.reason);
      const reader = scratch.opened.store;
      const writer = fakeVectorWriter(scratch.writer);
      const { source, reads } = countingVectorReads(storeCardSource(reader, writer.write));
      let clock = 1_000_000;
      const runtime = createCardsRuntime({
        source,
        embedder,
        semanticWeight: 0.5,
        semanticModel: MODEL,
        now: () => clock,
        refreshIntervalMs: REFRESH_MS,
      });
      const hits = runtime.rank(parseQuery("reticulate"), {});
      expect(hits.map((hit) => hit.sessionId).sort()).toEqual(range(0, 3));
      expect(writer.calls).toHaveLength(1);

      writer.next().commit();
      expect(await runtime.flushVectorWrites()).toBe(true);
      expect(reader.cardCounters().vectorsRev).toBe(1);
      clock += REFRESH_MS + 1;
      await runtime.ready({ index: true });
      expect(reads.vectors).toBe(0);
      expect(reader.cardVectorsPage(undefined, 10).filter((row) => row.embedding)).toHaveLength(3);
    } finally {
      scratch.cleanup();
    }
  });
});
