import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpencodeClient, Part } from "@opencode-ai/sdk/v2";
import {
  createDrill,
  UNREVISED_ENTRY_TTL_MS,
  type DrillInput,
  type DrillOutput,
  type DrillPoolsOutput,
  type DrillTarget,
} from "../src/drill.js";
import type { HistorySource } from "../src/history/source.js";
import { createV1HistorySource } from "../src/history/v1.js";
import { createFetchGate, type FetchGate } from "../src/fetch-gate.js";
import { parseQuery } from "../src/query.js";
import type { FtsHit } from "../src/store.js";
import {
  apiFailure,
  assistantMessage,
  bundle,
  messagesResponse,
  paginateBundles,
  PROJECT_DIR,
  setStrictNoLimitMessages,
  strictNoLimit,
  TEST_LIMITS,
  textPart,
  UNBOUNDED_MESSAGES_ERROR,
  userMessage,
} from "./helpers.js";

// The drill must always page with an explicit limit.
beforeAll(() => setStrictNoLimitMessages(true));
afterAll(() => setStrictNoLimitMessages(false));

type MessageBundle = { info: import("@opencode-ai/sdk/v2").Message; parts: Part[] };
type Graph = { messagesBySession: Record<string, MessageBundle[]> };

type Calls = {
  messages: Array<{ sessionID: string; limit?: number; before?: string }>;
  message: Array<{ sessionID: string; messageID: string }>;
};

function makeDrillFake(graph: Graph): { source: HistorySource; calls: Calls } {
  const calls: Calls = { messages: [], message: [] };
  const client = {
    session: {
      messages: async (p: { sessionID: string; limit?: number; before?: string }) => {
        calls.messages.push({ sessionID: p.sessionID, limit: p.limit, before: p.before });
        if (p.limit == null && strictNoLimit()) throw new Error(UNBOUNDED_MESSAGES_ERROR);
        const data = graph.messagesBySession[p.sessionID] ?? [];
        const { items, nextCursor } = paginateBundles(data, p.limit ?? data.length, p.before);
        return messagesResponse(items, nextCursor);
      },
      message: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
        calls.message.push({ sessionID, messageID });
        const found = graph.messagesBySession[sessionID]?.find((m) => m.info.id === messageID);
        return found ? { data: found } : { error: apiFailure("not found") };
      },
    },
  } as unknown as OpencodeClient;
  return { source: createV1HistorySource({ scoped: client, unscoped: client }), calls };
}

function makeSpyGate(): { gate: FetchGate; queries: () => number } {
  const real = createFetchGate({ concurrency: 4 });
  let queryCount = 0;
  const gate: FetchGate = {
    runQuery: (fn) => {
      queryCount++;
      return real.runQuery(fn);
    },
    runBackground: (fn) => real.runBackground(fn),
    activeQueries: () => real.activeQueries(),
  };
  return { gate, queries: () => queryCount };
}

const target = (id: string): DrillTarget => ({
  sessionId: id,
  title: id,
  directory: PROJECT_DIR,
  timeUpdated: 2000,
});

// ── LRU parentage: the cache key omits parentage, so the entry must be
// restamped from the CURRENT target on every hit. Two targets for one session
// can legitimately share a key while disagreeing about parentage (a card with
// `timeUpdated: 0`, or an id with no card, collides with the metadata-less
// fallback target), and inheriting a cached stamp fails OPEN: unknown-parentage
// candidates would classify `human`.
describe("drill LRU parentage restamping", () => {
  const parentageGraph = (): Graph => ({
    messagesBySession: {
      "s-p": [
        bundle(userMessage("m1", "s-p", 1000), [
          textPart("p1", "s-p", "m1", "needle typed into the session"),
        ]),
      ],
    },
  });

  /** Same session id and the same `timeUpdated`, so both targets hit one cache key. */
  const rootTarget: DrillTarget = {
    sessionId: "s-p",
    title: "s-p",
    directory: PROJECT_DIR,
    timeUpdated: 0,
    parentID: null,
  };
  const unknownTarget: DrillTarget = {
    sessionId: "s-p",
    title: "s-p",
    directory: PROJECT_DIR,
    timeUpdated: 0,
    // parentID omitted: no metadata → unknown.
  };
  const childTarget: DrillTarget = { ...rootTarget, parentID: "s-parent" };

  async function humanPool(
    drill: ReturnType<typeof createDrill>,
    t: DrillTarget,
  ): Promise<{ human: number; parentage: Array<string | null | undefined> }> {
    const out = await drill.pools({
      sessions: [t],
      deepSet: new Set([t.sessionId]),
      query: parseQuery("needle"),
      mode: "smart",
      explain: false,
      authorship: new Set(["human"] as const),
    });
    const all = await drill.pools({
      sessions: [t],
      deepSet: new Set([t.sessionId]),
      query: parseQuery("needle"),
      mode: "smart",
      explain: false,
    });
    return {
      human: out.pools[0]?.candidates.length ?? 0,
      parentage: (all.pools[0]?.candidates ?? []).map((c) => c.sessionParentID),
    };
  }

  it("does not serve a cached root stamp to an unknown-parentage target", async () => {
    const { source, calls } = makeDrillFake(parentageGraph());
    const { gate } = makeSpyGate();
    const drill = createDrill({ source, gate, limits: TEST_LIMITS });

    const first = await humanPool(drill, rootTarget);
    expect(first.human).toBe(1); // root session → human
    expect(first.parentage).toEqual([null]);

    const fetchesAfterFirst = calls.messages.length;
    const second = await humanPool(drill, unknownTarget);
    // Served from the cache (no refetch) but reclassified for THIS target.
    expect(calls.messages.length).toBe(fetchesAfterFirst);
    expect(second.parentage).toEqual([undefined]);
    expect(second.human).toBe(0); // unknown parentage is withheld from "human"
  });

  it("does not serve a cached unknown stamp to a root target (the reverse order)", async () => {
    const { source, calls } = makeDrillFake(parentageGraph());
    const { gate } = makeSpyGate();
    const drill = createDrill({ source, gate, limits: TEST_LIMITS });

    const first = await humanPool(drill, unknownTarget);
    expect(first.human).toBe(0);

    const fetchesAfterFirst = calls.messages.length;
    const second = await humanPool(drill, rootTarget);
    expect(calls.messages.length).toBe(fetchesAfterFirst);
    expect(second.parentage).toEqual([null]);
    expect(second.human).toBe(1);
  });

  it("does not serve a cached root stamp to a child target", async () => {
    const { source } = makeDrillFake(parentageGraph());
    const { gate } = makeSpyGate();
    const drill = createDrill({ source, gate, limits: TEST_LIMITS });

    await humanPool(drill, rootTarget);
    const second = await humanPool(drill, childTarget);
    expect(second.parentage).toEqual(["s-parent"]);
    expect(second.human).toBe(0); // a child session's user text is delegated
  });

  it("leaves the cached array untouched when restamping (no retroactive reclassification)", async () => {
    const { source } = makeDrillFake(parentageGraph());
    const { gate } = makeSpyGate();
    const drill = createDrill({ source, gate, limits: TEST_LIMITS });

    const rootPools = await drill.pools({
      sessions: [rootTarget],
      deepSet: new Set(["s-p"]),
      query: parseQuery("needle"),
      mode: "smart",
      explain: false,
    });
    const held = rootPools.pools[0]!.candidates;
    await humanPool(drill, unknownTarget);
    // The earlier caller's candidates still say what they said.
    expect(held.map((c) => c.sessionParentID)).toEqual([null]);
  });

  it("stamps the current target's parentage on a wider slice built over another target's pages", async () => {
    // Page size 1: "alpha" walks the two newest pages and stops, "beta" walks
    // all three, so the unknown-parentage query builds a new slice from pages
    // whose candidates were first built for the root target.
    const graph: Graph = {
      messagesBySession: {
        "s-p": [
          bundle(userMessage("m1", "s-p", 1000), [textPart("p1", "s-p", "m1", "beta oldest")]),
          bundle(userMessage("m2", "s-p", 2000), [textPart("p2", "s-p", "m2", "beta older")]),
          bundle(userMessage("m3", "s-p", 3000), [
            textPart("p3", "s-p", "m3", "alpha beta newest"),
          ]),
        ],
      },
    };
    const { source, calls } = makeDrillFake(graph);
    const { gate } = makeSpyGate();
    const drill = createDrill({ source, gate, limits: { ...TEST_LIMITS, drillPageMessages: 1 } });
    const run = (t: DrillTarget, text: string) =>
      drill.pools({
        sessions: [t],
        deepSet: new Set(["s-p"]),
        query: parseQuery(text),
        mode: "smart",
        explain: false,
      });

    await run(rootTarget, "alpha");
    const wider = await run(unknownTarget, "beta");

    expect(calls.messages).toHaveLength(3); // the root query's two pages were reused
    const candidates = wider.pools[0]?.candidates ?? [];
    expect(candidates.map((c) => c.rawText)).toEqual([
      "alpha beta newest",
      "beta older",
      "beta oldest",
    ]);
    expect(candidates.map((c) => c.sessionParentID)).toEqual([undefined, undefined, undefined]);
  });
});

describe("drill tier-2", () => {
  it("reranks drilled candidates, surfacing the matching session, all fetches through the gate", async () => {
    const graph: Graph = {
      messagesBySession: {
        "s-rate": [
          bundle(userMessage("m1", "s-rate", 1000), [
            textPart("p1", "s-rate", "m1", "rate limit token bucket middleware for checkout"),
          ]),
        ],
        "s-db": [
          bundle(userMessage("m2", "s-db", 1000), [
            textPart("p2", "s-db", "m2", "postgres migration decision over dynamodb"),
          ]),
        ],
      },
    };
    const { source, calls } = makeDrillFake(graph);
    const { gate, queries } = makeSpyGate();
    const drill = createDrill({ source, gate, limits: TEST_LIMITS });

    const out = await drill.drill({
      sessions: [target("s-rate"), target("s-db")],
      deepSet: new Set(["s-rate", "s-db"]),
      query: parseQuery("token bucket rate limit"),
      mode: "smart",
      explain: false,
    });

    expect(out.hits[0]?.candidate.sessionID).toBe("s-rate");
    expect([...out.drilledSessions].sort()).toEqual(["s-db", "s-rate"]);
    expect(out.budgetExhausted).toBe(false);
    expect(queries()).toBe(calls.messages.length); // every fetch routed through runQuery
    expect(calls.messages.every((c) => c.limit != null)).toBe(true); // always bounded
  });

  it("point-fetches an FTS hit's message and neighbors that untargeted paging missed", async () => {
    // Newest-first, page size 1: m3 matches, m2 does not → paging stops after m2,
    // leaving the old needle message m1 for the targeted point fetch.
    const graph: Graph = {
      messagesBySession: {
        "s-x": [
          bundle(userMessage("m1", "s-x", 1000), [
            textPart("p1", "s-x", "m1", "needle old context"),
          ]),
          bundle(assistantMessage("m2", "s-x", 2000), [
            textPart("p2", "s-x", "m2", "unrelated middle"),
          ]),
          bundle(assistantMessage("m3", "s-x", 3000), [
            textPart("p3", "s-x", "m3", "needle recent hit"),
          ]),
        ],
      },
    };
    const { source, calls } = makeDrillFake(graph);
    const { gate } = makeSpyGate();
    const drill = createDrill({ source, gate, limits: { ...TEST_LIMITS, drillPageMessages: 1 } });
    const ftsBySession = new Map<string, FtsHit[]>([
      [
        "s-x",
        [
          {
            sessionId: "s-x",
            partId: "p1",
            messageId: "m1",
            prevMessageId: null,
            nextMessageId: "m2",
            class: "human-text",
            score: 1,
          },
        ],
      ],
    ]);

    const out = await drill.drill({
      sessions: [target("s-x")],
      deepSet: new Set(["s-x"]),
      ftsBySession,
      query: parseQuery("needle"),
      mode: "smart",
      explain: false,
    });

    expect(calls.message.map((c) => c.messageID)).toContain("m1"); // targeted fetched the missed message
    expect(out.hits.some((h) => h.candidate.messageID === "m1")).toBe(true);
  });

  it("stops drilling further sessions once the per-query budget is exhausted", async () => {
    const graph: Graph = {
      messagesBySession: {
        "s-a": [
          bundle(userMessage("ma", "s-a", 1000), [
            textPart("pa", "s-a", "ma", "widget parser alpha"),
          ]),
        ],
        "s-b": [
          bundle(userMessage("mb", "s-b", 1000), [
            textPart("pb", "s-b", "mb", "widget parser beta"),
          ]),
        ],
      },
    };
    const { source, calls } = makeDrillFake(graph);
    const { gate } = makeSpyGate();
    const drill = createDrill({ source, gate, limits: { ...TEST_LIMITS, drillCharsPerQuery: 1 } });

    const out = await drill.drill({
      sessions: [target("s-a"), target("s-b")],
      deepSet: new Set(["s-a", "s-b"]),
      query: parseQuery("widget parser"),
      mode: "smart",
      explain: false,
    });

    expect(out.drilledSessions).toEqual(["s-a"]); // second session skipped
    expect(out.budgetExhausted).toBe(true);
    expect(calls.messages.map((c) => c.sessionID)).toEqual(["s-a"]);
  });

  it("serves a repeated drill of the same session version from the LRU (no refetch)", async () => {
    const graph: Graph = {
      messagesBySession: {
        "s-c": [
          bundle(userMessage("mc", "s-c", 1000), [
            textPart("pc", "s-c", "mc", "cached content marker"),
          ]),
        ],
      },
    };
    const { source, calls } = makeDrillFake(graph);
    const { gate } = makeSpyGate();
    const drill = createDrill({ source, gate, limits: TEST_LIMITS });
    const input = {
      sessions: [target("s-c")],
      deepSet: new Set(["s-c"]),
      query: parseQuery("cached content"),
      mode: "smart" as const,
      explain: false,
    };

    await drill.drill(input);
    const afterFirst = calls.messages.length;
    expect(drill.cachedChars()).toBeGreaterThan(0);

    await drill.drill(input); // same (session, timeUpdated) → cache hit
    expect(calls.messages.length).toBe(afterFirst); // no refetch
  });

  it("does not embed drilled or swept candidates (semantic lives in the card tier)", async () => {
    // Path C removed the drill's per-candidate embed pass: the semantic blend is
    // a card-tier concern (cards.ts). The drill takes no embedder, and neither a
    // drilled nor a deep-swept candidate may carry an embedding. Guards against
    // regressing that dead per-candidate work back in.
    const graph: Graph = {
      messagesBySession: {
        "s-a": [
          bundle(userMessage("ma", "s-a", 1000), [
            textPart("pa", "s-a", "ma", "widget parser alpha content"),
          ]),
        ],
      },
    };
    const { source } = makeDrillFake(graph);
    const { gate } = makeSpyGate();
    const drill = createDrill({ source, gate, limits: TEST_LIMITS });

    const drilled = await drill.drill({
      sessions: [target("s-a")],
      deepSet: new Set(["s-a"]),
      query: parseQuery("widget parser"),
      mode: "smart",
      explain: false,
    });
    const swept = await drill.deep({
      sessions: [target("s-a")],
      query: parseQuery("widget parser"),
      charsPerQuery: 1_000_000,
    });

    const candidates = [...drilled.pools, ...swept.pools].flatMap((p) => p.candidates);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect((candidate as { embedding?: unknown }).embedding).toBeUndefined();
    }
  });
});

// ── Warm equals cold: a drill that reuses cached pages must return what a
// fresh drill returns for the same query, whatever ran before it. ──
describe("drill cache replay", () => {
  /** Deterministic PRNG (mulberry32), so a failing sequence replays by seed. */
  function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Pad to 150 chars so each `s-b` message charges a known retained size. */
  const long = (text: string): string => `${text} `.padEnd(150, "lorem ");

  const msg = (sid: string, id: string, created: number, text: string): MessageBundle => {
    const info =
      created % 2000 === 0 ? assistantMessage(id, sid, created) : userMessage(id, sid, created);
    return bundle(info, [textPart(`${id}-p`, sid, id, text)]);
  };

  // Page size 2 newest-first. In `s-a`, "alpha" stops after page 2, "beta"
  // walks all four pages and "gamma" stops after page 2 but point-fetches the
  // old messages. In `s-b`, long messages make the per-session budget stop
  // paging for "delta" and cut the point lookups for "epsilon". `s-c` has no
  // card revision.
  const replayGraph = (): Graph => ({
    messagesBySession: {
      "s-a": [
        msg("s-a", "a1", 1000, "alpha ancient origin story"),
        msg("s-a", "a2", 2000, "gamma ancient reply"),
        msg("s-a", "a3", 3000, "noise three"),
        msg("s-a", "a4", 4000, "beta older answer"),
        msg("s-a", "a5", 5000, "noise five"),
        msg("s-a", "a6", 6000, "beta mid answer"),
        msg("s-a", "a7", 7000, "noise seven"),
        msg("s-a", "a8", 8000, "alpha beta recent answer"),
      ],
      "s-b": [
        msg("s-b", "b1", 1000, long("epsilon origin delta")),
        msg("s-b", "b2", 2000, long("delta second")),
        msg("s-b", "b3", 3000, long("delta third")),
        msg("s-b", "b4", 4000, long("delta fourth")),
        msg("s-b", "b5", 5000, long("delta fifth")),
        msg("s-b", "b6", 6000, long("delta sixth recent")),
      ],
      "s-c": [
        msg("s-c", "c1", 1000, "zeta alpha notes"),
        msg("s-c", "c2", 2000, "zeta reply"),
        msg("s-c", "c3", 3000, "zeta final words"),
      ],
    },
  });

  /** Rewrite two `s-a` messages in place, as a re-index after a repair sees
   *  them. a5 now matches "gamma", so that query's page walk changes too. */
  function repair(graph: Graph): void {
    const rows = graph.messagesBySession["s-a"]!;
    rows[4] = msg("s-a", "a5", 5000, "gamma repaired five");
    rows[7] = msg("s-a", "a8", 8000, "alpha beta recent answer repaired");
  }

  const hit = (sid: string, id: string, prev: string | null, next: string | null): FtsHit => ({
    sessionId: sid,
    partId: `${id}-p`,
    messageId: id,
    prevMessageId: prev,
    nextMessageId: next,
    class: "human-text",
    score: 1,
  });

  const QUERIES: Array<{ text: string; fts: Record<string, FtsHit[]> }> = [
    { text: "alpha", fts: { "s-a": [hit("s-a", "a1", null, "a2")] } },
    { text: "beta", fts: {} },
    { text: "gamma", fts: { "s-a": [hit("s-a", "a2", "a1", "a3")] } },
    { text: "delta", fts: {} },
    { text: "epsilon", fts: { "s-b": [hit("s-b", "b1", null, "b2")] } },
    { text: "beta delta", fts: {} },
    {
      text: "zeta",
      fts: { "s-a": [hit("s-a", "a-gone", null, null)], "s-c": [hit("s-c", "c1", null, "c2")] },
    },
    { text: "alpha zeta", fts: { "s-a": [hit("s-a", "a4", "a3", "a5")] } },
  ];

  const LIMITS = {
    ...TEST_LIMITS,
    drillPageMessages: 2,
    drillCharsPerSession: 700,
    drillCharsPerQuery: 1000,
  };

  const targets = (revA: number): DrillTarget[] => [
    {
      sessionId: "s-a",
      title: "s-a",
      directory: PROJECT_DIR,
      timeUpdated: 9000,
      parentID: null,
      writeRev: revA,
    },
    {
      sessionId: "s-b",
      title: "s-b",
      directory: PROJECT_DIR,
      timeUpdated: 9000,
      parentID: null,
      writeRev: 3,
    },
    { sessionId: "s-c", title: "s-c", directory: PROJECT_DIR, timeUpdated: 5000, parentID: null },
  ];

  const inputFor = (q: (typeof QUERIES)[number], revA: number) => ({
    sessions: targets(revA),
    deepSet: new Set(["s-a", "s-b", "s-c"]),
    ftsBySession: new Map(Object.entries(q.fts)),
    query: parseQuery(q.text),
    mode: "smart" as const,
    explain: false,
    searchTitles: true,
  });

  /** Everything a caller reads from a drill, in order. */
  const observed = (out: DrillOutput) => ({
    hits: out.hits.map((h) => [h.candidate.partID, h.score, h.matchedTerms]),
    pools: out.pools.map((p) => [
      p.target.sessionId,
      p.candidates.map((c) => [c.partID, c.rawText, c.digestText, c.sessionParentID]),
    ]),
    drilledSessions: out.drilledSessions,
    budgetExhausted: out.budgetExhausted,
    loadErrors: out.loadErrors,
  });

  const textsOf = (out: DrillOutput, sid: string): string[] =>
    out.pools.find((p) => p.target.sessionId === sid)?.candidates.map((c) => c.rawText) ?? [];

  const fetches = (calls: Calls): number => calls.messages.length + calls.message.length;

  it("returns the uncached result for any query order, and new content after a repair", async () => {
    // The fixture must make queries disagree about the slice, or the property
    // holds trivially.
    const slices = new Set<string>();
    for (const q of QUERIES) {
      const { source } = makeDrillFake(replayGraph());
      const out = await createDrill({ source, gate: makeSpyGate().gate, limits: LIMITS }).drill(
        inputFor(q, 1),
      );
      slices.add(JSON.stringify(textsOf(out, "s-a")));
    }
    expect(slices.size).toBeGreaterThan(2);

    const STEPS = 8;
    for (const cacheMaxChars of [TEST_LIMITS.cacheMaxChars, 600]) {
      const roomy = cacheMaxChars === TEST_LIMITS.cacheMaxChars;
      let warmFetches = 0;
      let coldFetches = 0;
      for (let seed = 1; seed <= 25; seed++) {
        const random = prng(seed * 7919 + cacheMaxChars);
        const graph = replayGraph();
        const warm = makeDrillFake(graph);
        const cold = makeDrillFake(graph);
        const limits = { ...LIMITS, cacheMaxChars };
        const warmDrill = createDrill({ source: warm.source, gate: makeSpyGate().gate, limits });
        const repairAt = 1 + Math.floor(random() * (STEPS - 1));
        let revA = 1;

        for (let step = 0; step < STEPS; step++) {
          if (step === repairAt) {
            repair(graph);
            if (roomy) {
              // Same timeUpdated and revision: the cached pages still serve.
              const stale = await warmDrill.drill(inputFor(QUERIES[1]!, revA));
              expect(textsOf(stale, "s-a").join(" ")).not.toContain("repaired");
            }
            revA++;
          }
          const q = QUERIES[Math.floor(random() * QUERIES.length)]!;
          const label = `cache ${cacheMaxChars}, seed ${seed}, step ${step}, "${q.text}"`;
          const coldDrill = createDrill({ source: cold.source, gate: makeSpyGate().gate, limits });
          const warmOut = await warmDrill.drill(inputFor(q, revA));
          const coldOut = await coldDrill.drill(inputFor(q, revA));
          expect(observed(warmOut), label).toEqual(observed(coldOut));
          if (step >= repairAt) {
            expect(textsOf(warmOut, "s-a").join(" "), label).toContain("repaired");
          }
        }
        warmFetches += fetches(warm.calls);
        coldFetches += fetches(cold.calls);
      }
      if (roomy) expect(warmFetches).toBeLessThan(coldFetches);
    }
  });
});

// ── Drill cache lifecycle: what the cache keeps, when it lets an entry go and
// what it charges against its bound. ──

type PageRequest = { sessionID: string; before?: string };
type LookupRequest = { sessionID: string; messageID: string };

/**
 * Controls for {@link makeControlledSource}. A held read has already taken its
 * answer from the graph when it was called, so a graph change made while it is
 * held does not reach it. `held` collects one release function per held read,
 * in call order.
 */
type SourceControls = {
  pages: PageRequest[];
  lookups: LookupRequest[];
  held: Array<() => void>;
  holdPage?: (req: PageRequest) => boolean;
  holdLookup?: (req: LookupRequest) => boolean;
  /** The page read rejects, as a transport failure does. */
  failPage?: (req: PageRequest) => boolean;
  /** The lookup answers with a host error, or rejects. */
  failLookup?: (req: LookupRequest) => "error" | "throw" | undefined;
};

/** A history source over `graph` whose reads a test can hold open or fail. A
 *  missing message is a `not-found` lookup. */
function makeControlledSource(graph: Graph): { source: HistorySource; ctl: SourceControls } {
  const ctl: SourceControls = { pages: [], lookups: [], held: [] };
  const hold = (on: boolean): Promise<void> =>
    on ? new Promise<void>((resolve) => ctl.held.push(resolve)) : Promise.resolve();
  const source: HistorySource = {
    kind: "v1-http",
    scopedLookup: false,
    listSessions: async () => ({ ok: true, items: [] }),
    getSession: async () => ({ ok: false, reason: "not-found" }),
    listChildren: async () => ({ ok: true, items: [] }),
    async messagePage(o) {
      const req = { sessionID: o.sessionID, before: o.before };
      ctl.pages.push(req);
      const failed = ctl.failPage?.(req) === true;
      const page = paginateBundles(graph.messagesBySession[o.sessionID] ?? [], o.limit, o.before);
      await hold(ctl.holdPage?.(req) === true);
      if (failed) throw new Error("page read failed");
      return page;
    },
    async getMessage(sessionID, messageID) {
      const req = { sessionID, messageID };
      ctl.lookups.push(req);
      const failure = ctl.failLookup?.(req);
      const found = graph.messagesBySession[sessionID]?.find((m) => m.info.id === messageID);
      await hold(ctl.holdLookup?.(req) === true);
      if (failure === "throw") throw new Error("lookup read failed");
      if (failure === "error") return { ok: false, reason: "error", error: "host busy" };
      return found ? { ok: true, value: found } : { ok: false, reason: "not-found" };
    },
  };
  return { source, ctl };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const note = (sid: string, id: string, created: number, text: string): MessageBundle =>
  bundle(userMessage(id, sid, created), [textPart(`${id}-p`, sid, id, text)]);

/** Pad `text` to exactly `length` chars, so its message charges a known size. */
const sized = (text: string, length: number): string => `${text} `.padEnd(length, "x");

const revised = (sessionId: string, writeRev = 1): DrillTarget => ({
  sessionId,
  title: sessionId,
  directory: PROJECT_DIR,
  timeUpdated: 2000,
  parentID: null,
  writeRev,
});

const ftsHit = (sid: string, id: string): FtsHit => ({
  sessionId: sid,
  partId: `${id}-p`,
  messageId: id,
  prevMessageId: null,
  nextMessageId: null,
  class: "human-text",
  score: 1,
});

const poolsInput = (
  sessions: DrillTarget[],
  text: string,
  fts?: Record<string, FtsHit[]>,
): DrillInput => ({
  sessions,
  deepSet: new Set(sessions.map((s) => s.sessionId)),
  ftsBySession: fts ? new Map(Object.entries(fts)) : undefined,
  query: parseQuery(text),
  mode: "smart",
  explain: false,
});

const poolTexts = (out: DrillPoolsOutput, sid: string): string[] =>
  out.pools.find((p) => p.target.sessionId === sid)?.candidates.map((c) => c.rawText) ?? [];

/** The candidate chars a result holds (no title candidates are requested). */
const resultChars = (out: DrillPoolsOutput): number =>
  out.pools.flatMap((p) => p.candidates).reduce((sum, c) => sum + c.rawText.length, 0);

const newDrill = (
  source: HistorySource,
  limits: Partial<typeof TEST_LIMITS> = {},
  now?: () => number,
) =>
  createDrill({
    source,
    gate: createFetchGate({ concurrency: 4 }),
    limits: { ...TEST_LIMITS, ...limits },
    now,
  });

describe("drill cache reuse", () => {
  it("fetches only the pages a longer walk lacks, and replays a shorter walk without them", async () => {
    // Page size 1. "alpha" stops on the second page, which lacks its anchor;
    // "beta" matches every page and walks to the end of the session.
    const graph: Graph = {
      messagesBySession: {
        "s-r": [
          note("s-r", "m1", 1000, "beta one"),
          note("s-r", "m2", 2000, "beta two"),
          note("s-r", "m3", 3000, "beta three"),
          note("s-r", "m4", 4000, "alpha beta newest"),
        ],
      },
    };
    const { source, ctl } = makeControlledSource(graph);
    const drill = newDrill(source, { drillPageMessages: 1 });
    const t = revised("s-r");

    const alpha = await drill.pools(poolsInput([t], "alpha"));
    expect(ctl.pages).toHaveLength(2);
    const beta = await drill.pools(poolsInput([t], "beta"));
    expect(ctl.pages).toHaveLength(4);
    expect(new Set(ctl.pages.map((p) => p.before)).size).toBe(4); // no page read twice

    const alphaAgain = await drill.pools(poolsInput([t], "alpha"));
    const betaAgain = await drill.pools(poolsInput([t], "beta"));
    expect(ctl.pages).toHaveLength(4);
    expect(poolTexts(alpha, "s-r")).toEqual(["alpha beta newest", "beta three"]);
    expect(poolTexts(alphaAgain, "s-r")).toEqual(poolTexts(alpha, "s-r"));
    expect(poolTexts(beta, "s-r")).toEqual([
      "alpha beta newest",
      "beta three",
      "beta two",
      "beta one",
    ]);
    expect(poolTexts(betaAgain, "s-r")).toEqual(poolTexts(beta, "s-r"));
  });

  it("keeps one copy when two queries fill the same page at once", async () => {
    const graph: Graph = {
      messagesBySession: { "s-x": [note("s-x", "m1", 1000, "needle first copy")] },
    };
    const { source, ctl } = makeControlledSource(graph);
    const drill = newDrill(source);
    const input = poolsInput([revised("s-x")], "needle");
    ctl.holdPage = () => true;

    const first = drill.pools(input);
    await waitFor(() => ctl.held.length === 1);
    // The second read answers differently, as if the session changed between
    // the two reads, so a second copy in the cache would show.
    graph.messagesBySession["s-x"] = [note("s-x", "m1", 1000, "needle second copy, longer")];
    const second = drill.pools(input);
    await waitFor(() => ctl.held.length === 2);
    ctl.held[0]!();
    const firstOut = await first;
    ctl.held[1]!();
    const secondOut = await second;

    expect(poolTexts(firstOut, "s-x")).toEqual(["needle first copy"]);
    expect(poolTexts(secondOut, "s-x")).toEqual(poolTexts(firstOut, "s-x"));
    expect(drill.cachedChars()).toBe(resultChars(firstOut));

    ctl.holdPage = undefined;
    const third = await drill.pools(input);
    expect(ctl.pages).toHaveLength(2);
    expect(poolTexts(third, "s-x")).toEqual(poolTexts(firstOut, "s-x"));
  });

  it("keeps one copy when two queries point-fetch the same message at once", async () => {
    // Page size 1: the walk reads m3 and m2 and stops, since m2 lacks the
    // anchor, so m1 comes only from its point lookup.
    const graph: Graph = {
      messagesBySession: {
        "s-x": [
          note("s-x", "m1", 1000, "needle archived detail"),
          note("s-x", "m2", 2000, "middle chatter"),
          note("s-x", "m3", 3000, "recent chatter"),
        ],
      },
    };
    const { source, ctl } = makeControlledSource(graph);
    const drill = newDrill(source, { drillPageMessages: 1 });
    const t = revised("s-x");
    await drill.pools(poolsInput([t], "needle")); // cache the pages, so only lookups race
    const input = poolsInput([t], "needle", { "s-x": [ftsHit("s-x", "m1")] });
    ctl.holdLookup = () => true;

    const first = drill.pools(input);
    const second = drill.pools(input);
    await waitFor(() => ctl.held.length === 2);
    for (const release of ctl.held) release();
    const [firstOut, secondOut] = await Promise.all([first, second]);

    expect(poolTexts(firstOut, "s-x")).toContain("needle archived detail");
    expect(poolTexts(secondOut, "s-x")).toEqual(poolTexts(firstOut, "s-x"));
    expect(drill.cachedChars()).toBe(resultChars(firstOut));

    ctl.holdLookup = undefined;
    await drill.pools(input);
    expect(ctl.lookups).toHaveLength(2);
  });

  it.each([
    { failure: "error" as const, loadErrors: 0 },
    { failure: "throw" as const, loadErrors: 1 },
  ])(
    "caches a not-found lookup but asks again after a transient $failure",
    async ({ failure, loadErrors }) => {
      const graph: Graph = {
        messagesBySession: {
          "s-x": [
            note("s-x", "m1", 1000, "needle flaky detail"),
            note("s-x", "m2", 2000, "middle chatter"),
            note("s-x", "m3", 3000, "recent chatter"),
          ],
        },
      };
      const { source, ctl } = makeControlledSource(graph);
      const drill = newDrill(source, { drillPageMessages: 1 });
      // m-gone does not exist; m1 fails once and then reads normally.
      let failures = 1;
      ctl.failLookup = (req) => (req.messageID === "m1" && failures-- > 0 ? failure : undefined);
      const input = poolsInput([revised("s-x")], "needle", {
        "s-x": [ftsHit("s-x", "m-gone"), ftsHit("s-x", "m1")],
      });

      const first = await drill.pools(input);
      expect(ctl.lookups.map((l) => l.messageID)).toEqual(["m-gone", "m1"]);
      expect(poolTexts(first, "s-x")).not.toContain("needle flaky detail");
      expect(first.loadErrors).toHaveLength(loadErrors);

      const second = await drill.pools(input);
      expect(ctl.lookups.map((l) => l.messageID)).toEqual(["m-gone", "m1", "m1"]);
      expect(poolTexts(second, "s-x")).toContain("needle flaky detail");
      expect(second.loadErrors).toEqual([]);

      // A repeat on the unchanged session has nothing left to read.
      const pages = ctl.pages.length;
      await drill.pools(input);
      expect(ctl.lookups).toHaveLength(3);
      expect(ctl.pages).toHaveLength(pages);
    },
  );

  it("keeps the pages before a failed page read and reads only the rest again", async () => {
    // Page size 1 and every page matches, so the walk runs to the end.
    const graph: Graph = {
      messagesBySession: {
        "s-x": [
          note("s-x", "m1", 1000, "needle one"),
          note("s-x", "m2", 2000, "needle two"),
          note("s-x", "m3", 3000, "needle three"),
        ],
      },
    };
    const { source, ctl } = makeControlledSource(graph);
    const drill = newDrill(source, { drillPageMessages: 1 });
    let failures = 1;
    ctl.failPage = (req) => req.before !== undefined && failures-- > 0;
    const input = poolsInput([revised("s-x")], "needle");

    const first = await drill.pools(input);
    expect(first.loadErrors).toHaveLength(1);
    expect(first.pools).toEqual([]);
    expect(ctl.pages).toHaveLength(2);

    const second = await drill.pools(input);
    expect(ctl.pages).toHaveLength(4); // the second and third pages, not the first
    expect(ctl.pages.slice(2).every((p) => p.before !== undefined)).toBe(true);
    expect(poolTexts(second, "s-x")).toEqual(["needle three", "needle two", "needle one"]);
  });
});

describe("drill cache invalidation", () => {
  const stamped = (stamp: Pick<DrillTarget, "timeUpdated" | "writeRev">): DrillTarget => ({
    sessionId: "s-x",
    title: "s-x",
    directory: PROJECT_DIR,
    parentID: null,
    ...stamp,
  });

  it.each([
    {
      change: "timeUpdated",
      from: { timeUpdated: 2000, writeRev: 1 },
      to: { timeUpdated: 3000, writeRev: 1 },
    },
    {
      change: "writeRev",
      from: { timeUpdated: 2000, writeRev: 1 },
      to: { timeUpdated: 2000, writeRev: 2 },
    },
    {
      change: "writeRev removed",
      from: { timeUpdated: 2000, writeRev: 1 },
      to: { timeUpdated: 2000 },
    },
    {
      change: "writeRev added",
      from: { timeUpdated: 2000 },
      to: { timeUpdated: 2000, writeRev: 1 },
    },
  ])("drops the cached entry when the stamp changes ($change)", async ({ from, to }) => {
    const graph: Graph = {
      messagesBySession: { "s-x": [note("s-x", "m1", 1000, "needle before the change")] },
    };
    const { source, ctl } = makeControlledSource(graph);
    // A fixed clock keeps the time bound out of it.
    const drill = newDrill(source, {}, () => 1_000_000);

    await drill.pools(poolsInput([stamped(from)], "needle"));
    const after = "needle after the change, longer";
    graph.messagesBySession["s-x"] = [note("s-x", "m1", 1000, after)];
    const changed = await drill.pools(poolsInput([stamped(to)], "needle"));

    expect(ctl.pages).toHaveLength(2);
    expect(poolTexts(changed, "s-x")).toEqual([after]);
    expect(drill.cachedChars()).toBe(after.length); // the old entry's chars are released

    await drill.pools(poolsInput([stamped(to)], "needle"));
    expect(ctl.pages).toHaveLength(2);
  });

  it("serves a target without writeRev until the time bound from its fill, then refills it", async () => {
    const graph: Graph = {
      messagesBySession: { "s-u": [note("s-u", "m1", 1000, "needle version one")] },
    };
    const { source, ctl } = makeControlledSource(graph);
    let now = 1_000_000;
    const drill = newDrill(source, {}, () => now);
    const unrevised: DrillTarget = {
      sessionId: "s-u",
      title: "s-u",
      directory: PROJECT_DIR,
      timeUpdated: 2000,
      parentID: null,
    };
    const input = poolsInput([unrevised], "needle");

    await drill.pools(input);
    const rewritten = "needle version two, rewritten";
    graph.messagesBySession["s-u"] = [note("s-u", "m1", 1000, rewritten)];

    now += UNREVISED_ENTRY_TTL_MS - 1;
    const served = await drill.pools(input);
    expect(ctl.pages).toHaveLength(1);
    expect(poolTexts(served, "s-u")).toEqual(["needle version one"]);

    // The bound runs from the fill: the hit just above does not extend it.
    now += 1;
    const refilled = await drill.pools(input);
    expect(ctl.pages).toHaveLength(2);
    expect(poolTexts(refilled, "s-u")).toEqual([rewritten]);
    expect(drill.cachedChars()).toBe(rewritten.length);
  });

  it("keeps serving a target with writeRev past the time bound", async () => {
    const graph: Graph = {
      messagesBySession: { "s-x": [note("s-x", "m1", 1000, "needle version one")] },
    };
    const { source, ctl } = makeControlledSource(graph);
    let now = 1_000_000;
    const drill = newDrill(source, {}, () => now);
    const input = poolsInput([revised("s-x", 7)], "needle");

    await drill.pools(input);
    graph.messagesBySession["s-x"] = [note("s-x", "m1", 1000, "needle version two")];
    now += 10 * UNREVISED_ENTRY_TTL_MS;
    const served = await drill.pools(input);

    expect(ctl.pages).toHaveLength(1);
    expect(poolTexts(served, "s-x")).toEqual(["needle version one"]);
  });
});

describe("drill cache bounds", () => {
  const threeSessions = (): Graph => ({
    messagesBySession: {
      s1: [note("s1", "m1", 1000, sized("needle one", 400))],
      s2: [note("s2", "m2", 1000, sized("needle two", 400))],
      s3: [note("s3", "m3", 1000, sized("needle three", 400))],
    },
  });

  it("evicts the least recently used session to stay under cacheMaxChars", async () => {
    const { source, ctl } = makeControlledSource(threeSessions());
    const drill = newDrill(source, { cacheMaxChars: 1000 });
    const run = (sid: string) => drill.pools(poolsInput([revised(sid)], "needle"));
    const fetched = () => ctl.pages.map((p) => p.sessionID);

    await run("s1");
    await run("s2");
    expect(drill.cachedChars()).toBe(800);
    await run("s1"); // a hit makes s1 the most recently used
    await run("s3"); // 1200 chars: s2, now the least recently used, goes
    expect(drill.cachedChars()).toBe(800);

    await run("s1");
    expect(fetched()).toEqual(["s1", "s2", "s3"]);
    await run("s2");
    expect(fetched()).toEqual(["s1", "s2", "s3", "s2"]);
    expect(drill.cachedChars()).toBe(800);
  });

  it("drops an entry larger than the bound once its query has used it", async () => {
    const { source, ctl } = makeControlledSource(threeSessions());
    const drill = newDrill(source, { cacheMaxChars: 300 });
    const input = poolsInput([revised("s1")], "needle");

    const out = await drill.pools(input);
    expect(poolTexts(out, "s1")).toEqual([sized("needle one", 400)]);
    expect(drill.cachedChars()).toBe(0);

    await drill.pools(input);
    expect(ctl.pages).toHaveLength(2);
  });

  // Page size 1: the walk reads the two newest messages (16 chars) and stops on
  // "head one", which lacks the anchor. The older 100-char messages come only
  // from point lookups.
  const pointGraph = (): Graph => ({
    messagesBySession: {
      "s-p": [
        note("s-p", "o1", 1000, sized("marker one", 100)),
        note("s-p", "o2", 2000, sized("marker two", 100)),
        note("s-p", "o3", 3000, sized("marker three", 100)),
        note("s-p", "h1", 4000, "head one"),
        note("s-p", "h2", 5000, "head two"),
      ],
    },
  });
  const POINT_LIMITS = { drillPageMessages: 1, drillCharsPerSession: 250 };

  it("clears the cached point lookups when they reach the per-session cap", async () => {
    const { source, ctl } = makeControlledSource(pointGraph());
    const drill = newDrill(source, POINT_LIMITS);
    const lookup = (id: string) =>
      drill.pools(poolsInput([revised("s-p")], "marker", { "s-p": [ftsHit("s-p", id)] }));

    await lookup("o1");
    await lookup("o2");
    expect(drill.cachedChars()).toBe(216);
    await lookup("o3"); // 300 chars of lookups would pass the 250 cap
    expect(drill.cachedChars()).toBe(116);

    const again = await lookup("o1");
    await lookup("o3");
    expect(ctl.lookups.map((l) => l.messageID)).toEqual(["o1", "o2", "o3", "o1"]);
    expect(poolTexts(again, "s-p")).toContain(sized("marker one", 100));
  });

  it("does not refetch a repeated query whose own point lookups pass the cap", async () => {
    // Each lookup starts under the 250-char session budget (16, 116, 216), so
    // one query reads all three, 300 chars of lookups in all.
    const { source, ctl } = makeControlledSource(pointGraph());
    const drill = newDrill(source, POINT_LIMITS);
    const input = poolsInput([revised("s-p")], "marker", {
      "s-p": [ftsHit("s-p", "o1"), ftsHit("s-p", "o2"), ftsHit("s-p", "o3")],
    });

    const first = await drill.pools(input);
    expect(poolTexts(first, "s-p")).toHaveLength(5);
    expect(ctl.lookups).toHaveLength(3);

    await drill.pools(input);
    expect(ctl.lookups).toHaveLength(3);
  });
});

describe("drill cache entries dropped mid-query", () => {
  it("keeps a query correct, and off the cache's total, when LRU eviction takes its entry", async () => {
    // Page size 1: s1 has two 400-char pages, s2 one 700-char page; two
    // sessions' worth of pages do not fit the 1000-char bound.
    const graph: Graph = {
      messagesBySession: {
        s1: [
          note("s1", "m1", 1000, sized("needle s1 older", 400)),
          note("s1", "m2", 2000, sized("needle s1 newer", 400)),
        ],
        s2: [note("s2", "m3", 1000, sized("needle s2", 700))],
      },
    };
    const { source, ctl } = makeControlledSource(graph);
    const drill = newDrill(source, { cacheMaxChars: 1000, drillPageMessages: 1 });
    ctl.holdPage = (req) => req.sessionID === "s1" && req.before !== undefined;

    const pending = drill.pools(poolsInput([revised("s1")], "needle"));
    await waitFor(() => ctl.held.length === 1); // s1's first page is cached, its second in flight
    await drill.pools(poolsInput([revised("s2")], "needle")); // 1100 chars: s1 goes
    expect(drill.cachedChars()).toBe(700);

    ctl.held[0]!();
    const out = await pending;
    expect(poolTexts(out, "s1")).toEqual([
      sized("needle s1 newer", 400),
      sized("needle s1 older", 400),
    ]);
    expect(drill.cachedChars()).toBe(700);

    ctl.holdPage = undefined;
    await drill.pools(poolsInput([revised("s1")], "needle"));
    expect(ctl.pages.filter((p) => p.sessionID === "s1")).toHaveLength(4); // both pages again
    expect(drill.cachedChars()).toBe(800); // s1 now; s2 was the least recently used
  });

  it("keeps a query whose entry a new stamp replaced from charging the new entry", async () => {
    const graph: Graph = {
      messagesBySession: { "s-x": [note("s-x", "m1", 1000, "needle old text")] },
    };
    const { source, ctl } = makeControlledSource(graph);
    const drill = newDrill(source);
    ctl.holdPage = () => true;

    const stale = drill.pools(poolsInput([revised("s-x", 1)], "needle"));
    await waitFor(() => ctl.held.length === 1); // its read has answered with the old text
    ctl.holdPage = undefined;
    const repaired = "needle new text, repaired";
    graph.messagesBySession["s-x"] = [note("s-x", "m1", 1000, repaired)];
    const fresh = await drill.pools(poolsInput([revised("s-x", 2)], "needle"));
    expect(poolTexts(fresh, "s-x")).toEqual([repaired]);

    ctl.held[0]!();
    const staleOut = await stale;
    expect(poolTexts(staleOut, "s-x")).toEqual(["needle old text"]);
    expect(drill.cachedChars()).toBe(repaired.length);

    const again = await drill.pools(poolsInput([revised("s-x", 2)], "needle"));
    expect(ctl.pages).toHaveLength(2);
    expect(poolTexts(again, "s-x")).toEqual([repaired]);
  });
});
