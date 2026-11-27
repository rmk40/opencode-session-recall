import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpencodeClient, Part } from "@opencode-ai/sdk/v2";
import {
  createDrill,
  OUT_OF_WINDOW_FACTOR,
  OUT_OF_WINDOW_MESSAGES,
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
  completedToolPart,
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
  seeks: Array<{ sessionID: string; until: number }>;
  floors: Array<{ sessionID: string; after: number; before?: number }>;
  held: Array<() => void>;
  holdPage?: (req: PageRequest) => boolean;
  holdLookup?: (req: LookupRequest) => boolean;
  /** The page read rejects, as a transport failure does. */
  failPage?: (req: PageRequest) => boolean;
  /** The lookup answers with a host error, or rejects. */
  failLookup?: (req: LookupRequest) => "error" | "throw" | undefined;
};

/** A history source over `graph` whose reads a test can hold open or fail. A
 *  missing message is a `not-found` lookup. With `seek`, it also seeks the
 *  way the v2 source does: to the page whose first message is the last one,
 *  in graph order, created at or before the bound. With `floor`, its messages
 *  carry their graph position as `seq` and it answers the window's floor the
 *  way the v2 source does. */
function makeControlledSource(
  graph: Graph,
  opts: { seek?: boolean; floor?: boolean } = {},
): { source: HistorySource; ctl: SourceControls } {
  const ctl: SourceControls = { pages: [], lookups: [], seeks: [], floors: [], held: [] };
  const hold = (on: boolean): Promise<void> =>
    on ? new Promise<void>((resolve) => ctl.held.push(resolve)) : Promise.resolve();
  // With `floor`, messages carry the v2 row order: their position in the
  // graph, whatever their creation times say.
  const messagesOf = (sessionID: string): MessageBundle[] => {
    const all = graph.messagesBySession[sessionID] ?? [];
    return opts.floor ? all.map((m, i) => ({ ...m, info: { ...m.info, seq: i + 1 } })) : all;
  };
  const source: HistorySource = {
    kind: "v1-http",
    scopedLookup: false,
    listSessions: async () => ({ ok: true, items: [], truncated: false }),
    getSession: async () => ({ ok: false, reason: "not-found" }),
    listChildren: async () => ({ ok: true, items: [], truncated: false }),
    async messagePage(o) {
      const req = { sessionID: o.sessionID, before: o.before };
      ctl.pages.push(req);
      const failed = ctl.failPage?.(req) === true;
      const page = paginateBundles(messagesOf(o.sessionID), o.limit, o.before);
      await hold(ctl.holdPage?.(req) === true);
      if (failed) throw new Error("page read failed");
      return page;
    },
    async getMessage(sessionID, messageID) {
      const req = { sessionID, messageID };
      ctl.lookups.push(req);
      const failure = ctl.failLookup?.(req);
      const found = messagesOf(sessionID).find((m) => m.info.id === messageID);
      await hold(ctl.holdLookup?.(req) === true);
      if (failure === "throw") throw new Error("lookup read failed");
      if (failure === "error") return { ok: false, reason: "error", error: "host busy" };
      return found ? { ok: true, value: found } : { ok: false, reason: "not-found" };
    },
    ...(opts.seek && {
      async seekPage(o: { sessionID: string; until: number }) {
        ctl.seeks.push({ sessionID: o.sessionID, until: o.until });
        const all = graph.messagesBySession[o.sessionID] ?? [];
        const index = [...all].reverse().findIndex((m) => m.info.time.created <= o.until);
        if (index < 0) return { ok: true as const, value: null };
        if (index === 0) return { ok: true as const, value: undefined };
        // The cursor past the first `index` messages, newest first.
        return { ok: true as const, value: paginateBundles(all, index).nextCursor ?? undefined };
      },
    }),
    ...(opts.floor && {
      async seqFloor(o: { sessionID: string; after: number; before?: number }) {
        ctl.floors.push(o);
        const seqs = (graph.messagesBySession[o.sessionID] ?? []).flatMap((m, i) => {
          const created = m.info.time.created;
          const inside = created > o.after && (o.before === undefined || created < o.before);
          return inside ? [i + 1] : [];
        });
        return { ok: true as const, value: seqs.length > 0 ? Math.min(...seqs) : null };
      },
    }),
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

  it("does not cache a build over lookups another query evicted while it waited", async () => {
    // A asks for o1, o2 and o3 and is held on o3. Meanwhile B's lookup of o4
    // passes the 250-char cap and evicts o1 and o2, uncharging them. A build
    // cached by A would keep their candidates reachable uncharged; instead
    // B's build, whose lookups are all still cached, stays the cached one.
    const graph = pointGraph();
    graph.messagesBySession["s-p"]!.unshift(note("s-p", "o4", 500, sized("marker four", 100)));
    const { source, ctl } = makeControlledSource(graph);
    const drill = newDrill(source, POINT_LIMITS);
    const queryA = poolsInput([revised("s-p")], "marker", {
      "s-p": [ftsHit("s-p", "o1"), ftsHit("s-p", "o2"), ftsHit("s-p", "o3")],
    });
    const queryB = poolsInput([revised("s-p")], "marker", { "s-p": [ftsHit("s-p", "o4")] });

    ctl.holdLookup = (req) => req.messageID === "o3";
    const pendingA = drill.pools(queryA);
    await waitFor(() => ctl.held.length === 1);
    ctl.holdLookup = undefined;
    const firstB = await drill.pools(queryB);
    ctl.held[0]!();
    const firstA = await pendingA;

    expect(poolTexts(firstA, "s-p")).toHaveLength(5);
    expect(drill.cachedChars()).toBe(216); // both pages, o4 and o3

    const againB = await drill.pools(queryB);
    expect(ctl.lookups.map((l) => l.messageID)).toEqual(["o1", "o2", "o3", "o4"]);
    expect(againB.pools[0]!.candidates).toBe(firstB.pools[0]!.candidates);
  });

  it("bounds cached messages by count, whatever chars they charge", async () => {
    // Messages without searchable text and not-found lookups charge no chars,
    // so only the object bound evicts them. Each session's entry, page and six
    // messages count 8, so the bound of 8 holds one session.
    const empty = (sid: string): MessageBundle[] =>
      Array.from({ length: 6 }, (_, i) => note(sid, `${sid}-${i}`, 1000 + i, ""));
    const graph: Graph = {
      messagesBySession: {
        "s-e": empty("s-e"),
        "s-f": empty("s-f"),
        "s-n": [note("s-n", "n1", 1000, "needle")],
      },
    };
    const { source, ctl } = makeControlledSource(graph);
    const drill = createDrill({
      source,
      gate: createFetchGate({ concurrency: 4 }),
      limits: { ...TEST_LIMITS, drillPageMessages: 10 },
      maxCachedObjects: 8,
    });
    const run = (sid: string, fts?: Record<string, FtsHit[]>) =>
      drill.pools(poolsInput([revised(sid)], "needle", fts));

    await run("s-e");
    await run("s-f"); // 16 objects: s-e, the least recently used, goes
    await run("s-f");
    await run("s-e");
    expect(ctl.pages.map((p) => p.sessionID)).toEqual(["s-e", "s-f", "s-e"]);
    expect(drill.cachedChars()).toBe(0);

    // The entry, its page and message and eight not-found lookups pass the
    // bound alone, so the entry is dropped once its query has used it, and a
    // repeat reads all of it again with the same result.
    const gone = { "s-n": Array.from({ length: 8 }, (_, i) => ftsHit("s-n", `gone-${i}`)) };
    const first = await run("s-n", gone);
    const again = await run("s-n", gone);
    expect(ctl.lookups).toHaveLength(16);
    expect(ctl.pages.filter((p) => p.sessionID === "s-n")).toHaveLength(2);
    expect(poolTexts(again, "s-n")).toEqual(poolTexts(first, "s-n"));
    expect(poolTexts(first, "s-n")).toEqual(["needle"]);
  });

  /** A drill with an object bound of `maxCachedObjects` over `source`. */
  const objectBounded = (source: HistorySource, maxCachedObjects: number) =>
    createDrill({
      source,
      gate: createFetchGate({ concurrency: 4 }),
      limits: TEST_LIMITS,
      maxCachedObjects,
    });

  // `s-keep` caches three objects: its entry, its one page and its message.
  const keepGraph = (): Graph => ({
    messagesBySession: { "s-keep": [note("s-keep", "k1", 1000, "needle kept")] },
  });

  it("counts sessions with empty histories against the object bound", async () => {
    // Each empty session caches its entry and one empty page, two objects and
    // no chars, so a bound of 5 holds two of them and nothing else.
    const { source, ctl } = makeControlledSource(keepGraph());
    const drill = objectBounded(source, 5);
    const run = (sid: string) => drill.pools(poolsInput([revised(sid)], "needle"));
    const pagesOf = (sid: string) => ctl.pages.filter((p) => p.sessionID === sid).length;

    await run("s-keep");
    for (let i = 0; i < 10; i++) {
      const out = await run(`s-empty-${i}`);
      expect(out.drilledSessions).toEqual([`s-empty-${i}`]);
      expect(out.pools[0]!.candidates).toEqual([]);
    }
    expect(drill.cachedChars()).toBe(0); // s-keep was evicted

    await run("s-empty-9");
    await run("s-empty-8");
    expect(pagesOf("s-empty-9")).toBe(1);
    expect(pagesOf("s-empty-8")).toBe(1);
    await run("s-empty-7");
    expect(pagesOf("s-empty-7")).toBe(2);
    const kept = await run("s-keep");
    expect(pagesOf("s-keep")).toBe(2);
    expect(poolTexts(kept, "s-keep")).toEqual(["needle kept"]);
  });

  it("counts sessions whose first page read failed against the object bound", async () => {
    // A failed first read caches the entry alone, one object and no chars, so
    // a bound of 4 holds s-keep and one failed session, then evicts s-keep.
    const { source, ctl } = makeControlledSource(keepGraph());
    ctl.failPage = (req) => req.sessionID.startsWith("s-fail-");
    const drill = objectBounded(source, 4);
    const run = (sid: string) => drill.pools(poolsInput([revised(sid)], "needle"));

    await run("s-keep");
    const errors: string[] = [];
    for (let i = 0; i < 10; i++) {
      const out = await run(`s-fail-${i}`);
      expect(out.drilledSessions).toEqual([]);
      errors.push(...out.loadErrors);
    }
    expect(errors).toHaveLength(10);
    expect(drill.cachedChars()).toBe(0); // s-keep was evicted

    const kept = await run("s-keep");
    expect(ctl.pages.filter((p) => p.sessionID === "s-keep")).toHaveLength(2);
    expect(poolTexts(kept, "s-keep")).toEqual(["needle kept"]);
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

// ── Per-target accounting: what each target's read fetched and why it
// stopped, for every target in drill order, read or not. ──

/** Zero counts with `stop`: a target that was never read. */
const unread = (sessionId: string, stop: string) => ({
  sessionId,
  fetched: 0,
  candidate: 0,
  eligible: 0,
  stop,
});

describe("drill per-target accounting", () => {
  it("stops at the anchor when a later page matches nothing, and at the end when that page was the last", async () => {
    // Page size 1: each session's second page lacks "alpha". s-a has a third
    // page left; s-b's second page is its last.
    const graph: Graph = {
      messagesBySession: {
        "s-a": [
          note("s-a", "a1", 1000, "beta oldest"),
          note("s-a", "a2", 2000, "beta middle"),
          note("s-a", "a3", 3000, "alpha newest"),
        ],
        "s-b": [note("s-b", "b1", 1000, "beta oldest"), note("s-b", "b2", 2000, "alpha newest")],
      },
    };
    const { source } = makeControlledSource(graph);
    const drill = newDrill(source, { drillPageMessages: 1 });

    const out = await drill.pools(poolsInput([revised("s-a"), revised("s-b")], "alpha"));
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 2, candidate: 2, eligible: 2, stop: "anchor" },
      { sessionId: "s-b", fetched: 2, candidate: 2, eligible: 2, stop: "end" },
    ]);
    // Each drilled pool carries the same stats.
    expect(out.pools.map((p) => ({ sessionId: p.target.sessionId, ...p.stats }))).toEqual(
      out.targets,
    );
  });

  it("stops on the per-session budget while pages remain", async () => {
    const graph: Graph = {
      messagesBySession: {
        "s-a": [
          note("s-a", "a1", 1000, sized("alpha one", 200)),
          note("s-a", "a2", 2000, sized("alpha two", 200)),
        ],
      },
    };
    const { source } = makeControlledSource(graph);
    const drill = newDrill(source, { drillPageMessages: 1, drillCharsPerSession: 100 });

    const out = await drill.pools(poolsInput([revised("s-a")], "alpha"));
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 1, candidate: 1, eligible: 1, stop: "sessionBudget" },
    ]);
  });

  it("reports targetsCut when the budget runs out before every point lookup, unless paging spent it", async () => {
    // Page size 1. In s-a the walk reads a5 and a4 and stops at the anchor,
    // with budget left for the a1 lookup but not the a2 one. In s-b the first
    // page alone spends the budget, so its stop stays sessionBudget.
    const graph: Graph = {
      messagesBySession: {
        "s-a": [
          note("s-a", "a1", 1000, sized("alpha archived", 500)),
          note("s-a", "a2", 2000, "alpha archived too"),
          note("s-a", "a3", 3000, "chatter"),
          note("s-a", "a4", 4000, "chatter"),
          note("s-a", "a5", 5000, "alpha recent"),
        ],
        "s-b": [
          note("s-b", "b1", 1000, "alpha archived"),
          note("s-b", "b2", 2000, "chatter"),
          note("s-b", "b3", 3000, sized("alpha recent", 400)),
        ],
      },
    };
    const { source, ctl } = makeControlledSource(graph);
    const drill = newDrill(source, { drillPageMessages: 1, drillCharsPerSession: 300 });

    const out = await drill.pools(
      poolsInput([revised("s-a"), revised("s-b")], "alpha", {
        "s-a": [ftsHit("s-a", "a1"), ftsHit("s-a", "a2")],
        "s-b": [ftsHit("s-b", "b1")],
      }),
    );
    expect(ctl.lookups.map((l) => l.messageID)).toEqual(["a1"]);
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 3, candidate: 3, eligible: 3, stop: "targetsCut" },
      { sessionId: "s-b", fetched: 1, candidate: 1, eligible: 1, stop: "sessionBudget" },
    ]);
  });

  it("flags cached, with the same counts and stop, when the cache held every page and lookup", async () => {
    const graph: Graph = {
      messagesBySession: {
        "s-a": [
          note("s-a", "a1", 1000, "alpha archived"),
          note("s-a", "a2", 2000, "chatter"),
          note("s-a", "a3", 3000, "alpha recent"),
        ],
      },
    };
    const { source } = makeControlledSource(graph);
    const drill = newDrill(source, { drillPageMessages: 1 });
    const input = poolsInput([revised("s-a")], "alpha", { "s-a": [ftsHit("s-a", "a1")] });

    const cold = await drill.pools(input);
    const warm = await drill.pools(input);
    // The walk stops at a2, which lacks the anchor; a1 comes from its lookup.
    expect(cold.targets).toEqual([
      { sessionId: "s-a", fetched: 3, candidate: 3, eligible: 3, stop: "anchor" },
    ]);
    expect(cold.targets[0]).not.toHaveProperty("cached");
    expect(warm.targets).toEqual([{ ...cold.targets[0]!, cached: true }]);
    expect(warm.pools[0]!.stats).toEqual({ ...cold.pools[0]!.stats, cached: true });
  });

  it("counts messages read, those with a candidate, and those the filters keep, apart", async () => {
    // A recall call of our own builds no candidate; the role filter keeps
    // only the user message; the title candidate is not a message.
    const graph: Graph = {
      messagesBySession: {
        "s-a": [
          note("s-a", "a1", 1000, "alpha asked"),
          bundle(assistantMessage("a2", "s-a", 2000), [
            textPart("a2-p", "s-a", "a2", "alpha answered"),
          ]),
          bundle(assistantMessage("a3", "s-a", 3000), [
            completedToolPart("a3-p", "s-a", "a3", "recall", { query: "alpha" }, "alpha recalled"),
          ]),
        ],
      },
    };
    const { source } = makeControlledSource(graph);
    const drill = newDrill(source);

    const out = await drill.pools({
      ...poolsInput([revised("s-a")], "alpha"),
      filter: (candidate) => candidate.role === "user",
      searchTitles: true,
    });
    expect(out.pools[0]!.candidates.some((c) => c.partType === "title")).toBe(true);
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 3, candidate: 2, eligible: 1, stop: "end" },
    ]);
  });

  it("lists the targets the per-query budget left unread as queryBudget", async () => {
    const graph: Graph = {
      messagesBySession: {
        "s-a": [note("s-a", "a1", 1000, "alpha one")],
        "s-b": [note("s-b", "b1", 1000, "alpha two")],
        "s-c": [note("s-c", "c1", 1000, "alpha three")],
      },
    };
    const { source } = makeControlledSource(graph);
    const drill = newDrill(source, { drillCharsPerQuery: 1 });

    const out = await drill.pools(
      poolsInput(
        ["s-a", "s-b", "s-c"].map((id) => revised(id)),
        "alpha",
      ),
    );
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 1, candidate: 1, eligible: 1, stop: "end" },
      unread("s-b", "queryBudget"),
      unread("s-c", "queryBudget"),
    ]);
  });

  it("marks a session whose read failed as loadError and reads the next", async () => {
    const graph: Graph = {
      messagesBySession: {
        "s-a": [note("s-a", "a1", 1000, "alpha one")],
        "s-b": [note("s-b", "b1", 1000, "alpha two")],
      },
    };
    const { source, ctl } = makeControlledSource(graph);
    ctl.failPage = (req) => req.sessionID === "s-a";
    const drill = newDrill(source);

    const out = await drill.pools(poolsInput([revised("s-a"), revised("s-b")], "alpha"));
    expect(out.loadErrors).toHaveLength(1);
    expect(out.targets).toEqual([
      unread("s-a", "loadError"),
      { sessionId: "s-b", fetched: 1, candidate: 1, eligible: 1, stop: "end" },
    ]);
  });

  it("marks every target from an abort on as aborted", async () => {
    const graph: Graph = {
      messagesBySession: {
        "s-a": [note("s-a", "a1", 1000, "alpha one")],
        "s-b": [note("s-b", "b1", 1000, "alpha two")],
      },
    };
    const { source, ctl } = makeControlledSource(graph);
    const drill = newDrill(source);
    const targets = [revised("s-a"), revised("s-b")];

    const before = new AbortController();
    before.abort();
    const none = await drill.pools({ ...poolsInput(targets, "alpha"), abort: before.signal });
    expect(none.targets).toEqual([unread("s-a", "aborted"), unread("s-b", "aborted")]);

    // Aborted while s-a's page is in flight: s-a finishes, s-b is not read.
    const during = new AbortController();
    ctl.holdPage = (req) => req.sessionID === "s-a";
    const pending = drill.pools({ ...poolsInput(targets, "alpha"), abort: during.signal });
    await waitFor(() => ctl.held.length === 1);
    during.abort();
    ctl.held[0]!();
    const out = await pending;
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 1, candidate: 1, eligible: 1, stop: "end" },
      unread("s-b", "aborted"),
    ]);
  });

  describe("in a deep sweep", () => {
    /** `count` messages of `chars` chars each, all matching "alpha". */
    const long = (sid: string, count: number, chars = 50): MessageBundle[] =>
      Array.from({ length: count }, (_, i) =>
        note(sid, `${sid}-m${i}`, 1000 + i, sized(`alpha ${i}`, chars)),
      );
    const deepInput = (ids: string[], charsPerQuery: number, abort?: AbortSignal) => ({
      sessions: ids.map((id) => revised(id)),
      query: parseQuery("alpha"),
      charsPerQuery,
      ...(abort && { abort }),
    });

    it("sweeps whole sessions to their end, and marks those left with the budget that stopped it", async () => {
      // s-a alone spends the budget, on its only page.
      const { source } = makeControlledSource({
        messagesBySession: { "s-a": long("s-a", 3), "s-b": long("s-b", 3), "s-c": long("s-c", 3) },
      });
      const out = await newDrill(source).deep(deepInput(["s-a", "s-b", "s-c"], 100));
      expect(out.targets).toEqual([
        { sessionId: "s-a", fetched: 3, candidate: 3, eligible: 3, stop: "end" },
        unread("s-b", "budget"),
        unread("s-c", "budget"),
      ]);
      expect(out.pools.map((p) => p.stats.stop)).toEqual(["end"]);
    });

    it("marks the session a budget stopped inside with that budget", async () => {
      // Sixty messages: the sweep reads 50 per page, so s-a has a second page.
      const { source } = makeControlledSource({
        messagesBySession: { "s-a": long("s-a", 60), "s-b": long("s-b", 3) },
      });
      const out = await newDrill(source).deep(deepInput(["s-a", "s-b"], 100));
      expect(out.targets).toEqual([
        { sessionId: "s-a", fetched: 50, candidate: 50, eligible: 50, stop: "budget" },
        unread("s-b", "budget"),
      ]);
    });

    it("marks the sessions the wall clock stopped inside and before as wallClock", async () => {
      // The clock passes the deadline once s-a's first page is read.
      let reads = 0;
      const graph: Graph = { messagesBySession: { "s-a": long("s-a", 60), "s-b": long("s-b", 3) } };
      const { source } = makeControlledSource(graph);
      const counting: HistorySource = {
        ...source,
        messagePage: async (o) => {
          reads++;
          return source.messagePage(o);
        },
      };
      const drill = createDrill({
        source: counting,
        gate: createFetchGate({ concurrency: 4 }),
        limits: TEST_LIMITS,
        now: () => (reads === 0 ? 0 : 1_000_000),
        deepWallClockMs: 1_000,
      });
      const out = await drill.deep(deepInput(["s-a", "s-b"], 1_000_000));
      expect(out.targets).toEqual([
        { sessionId: "s-a", fetched: 50, candidate: 50, eligible: 50, stop: "wallClock" },
        unread("s-b", "wallClock"),
      ]);
    });

    it("marks every session as aborted when the sweep was cancelled before it began", async () => {
      const { source, ctl } = makeControlledSource({
        messagesBySession: { "s-a": long("s-a", 3), "s-b": long("s-b", 3) },
      });
      const controller = new AbortController();
      controller.abort();
      const out = await newDrill(source).deep(
        deepInput(["s-a", "s-b"], 1_000_000, controller.signal),
      );
      expect(ctl.pages).toEqual([]);
      expect(out.targets).toEqual([unread("s-a", "aborted"), unread("s-b", "aborted")]);
    });

    it("marks a session whose read failed as loadError and sweeps the next", async () => {
      const { source, ctl } = makeControlledSource({
        messagesBySession: { "s-a": long("s-a", 3), "s-b": long("s-b", 3) },
      });
      ctl.failPage = (req) => req.sessionID === "s-a";
      const out = await newDrill(source).deep(deepInput(["s-a", "s-b"], 1_000_000));
      expect(out.targets).toEqual([
        unread("s-a", "loadError"),
        { sessionId: "s-b", fetched: 3, candidate: 3, eligible: 3, stop: "end" },
      ]);
    });
  });
});

describe("drill tool-name counts", () => {
  // A user note, then two bash calls and one read call on assistant messages.
  // The predicate under test admits the parts older than 3000 only.
  const toolGraph = (): Graph => ({
    messagesBySession: {
      "s-a": [
        note("s-a", "a1", 1000, "alpha asked"),
        bundle(assistantMessage("a2", "s-a", 2000), [
          completedToolPart("a2-p", "s-a", "a2", "bash", { command: "alpha" }, "alpha out"),
          completedToolPart("a2-q", "s-a", "a2", "read", { filePath: "alpha.ts" }, "alpha src"),
        ]),
        bundle(assistantMessage("a3", "s-a", 3000), [
          completedToolPart("a3-p", "s-a", "a3", "bash", { command: "alpha" }, "alpha again"),
        ]),
      ],
    },
  });
  const olderThan3000 = (candidate: { time: number }): boolean => candidate.time < 3000;
  const expected = new Map([
    ["bash", 1],
    ["read", 1],
  ]);

  it("counts the tool parts countTools admits, whatever the filter keeps", async () => {
    const { source } = makeControlledSource(toolGraph());
    const out = await newDrill(source).pools({
      ...poolsInput([revised("s-a")], "alpha"),
      filter: (candidate) => candidate.partType !== "tool",
      countTools: olderThan3000,
    });
    expect(out.pools[0]!.candidates.map((c) => c.partType)).toEqual(["text"]);
    expect(out.pools[0]!.toolNames).toEqual(expected);
  });

  it("counts the tool parts the authorship stage removes apart from those it keeps", async () => {
    const { source } = makeControlledSource(toolGraph());
    const drill = newDrill(source);
    const removing = await drill.pools({
      ...poolsInput([revised("s-a")], "alpha"),
      authorship: new Set(["human"] as const),
      countTools: olderThan3000,
    });
    expect(removing.pools[0]!.candidates.some((c) => c.partType === "tool")).toBe(false);
    expect(removing.pools[0]!.toolNames).toEqual(new Map());
    expect(removing.pools[0]!.authorshipToolNames).toEqual(expected);

    // Tool parts on assistant messages classify as model-authored.
    const keeping = await drill.pools({
      ...poolsInput([revised("s-a")], "alpha"),
      authorship: new Set(["model"] as const),
      countTools: olderThan3000,
    });
    expect(keeping.pools[0]!.toolNames).toEqual(expected);
    expect(keeping.pools[0]!.authorshipToolNames).toEqual(new Map());
  });

  it("counts nothing without countTools", async () => {
    const { source } = makeControlledSource(toolGraph());
    const out = await newDrill(source).pools(poolsInput([revised("s-a")], "alpha"));
    expect(out.pools[0]).not.toHaveProperty("toolNames");
  });

  it("counts the same way in a deep sweep", async () => {
    const { source } = makeControlledSource(toolGraph());
    const drill = newDrill(source);
    const sweep = {
      sessions: [revised("s-a")],
      query: parseQuery("alpha"),
      charsPerQuery: 1_000_000,
      filter: () => false,
      authorship: new Set(["human"] as const),
    };
    const counted = await drill.deep({ ...sweep, countTools: olderThan3000 });
    expect(counted.pools[0]!.candidates).toEqual([]);
    expect(counted.pools[0]!.toolNames).toEqual(new Map());
    expect(counted.pools[0]!.authorshipToolNames).toEqual(expected);

    const uncounted = await drill.deep(sweep);
    expect(uncounted.pools[0]).not.toHaveProperty("toolNames");
  });
});

// ── Time windows: a time-bounded search reads toward its window, and the
// messages outside it charge no budget. Page size 1 throughout, so every
// page is one message and the reads can be named. ──

describe("drill time window", () => {
  const windowed = (
    sessions: DrillTarget[],
    text: string,
    window: DrillInput["window"],
    fts?: Record<string, FtsHit[]>,
  ): DrillInput => ({ ...poolsInput(sessions, text, fts), window });

  /** s-a: three messages inside a window that ends at 3500, then two newer
   *  ones that alone pass a 200-char session budget. */
  const ranPastWindow = (): Graph => ({
    messagesBySession: {
      "s-a": [
        note("s-a", "a1", 1000, "beta oldest"),
        note("s-a", "a2", 2000, "alpha needle"),
        note("s-a", "a3", 3000, "alpha inside"),
        note("s-a", "a4", 4000, sized("alpha newer", 300)),
        note("s-a", "a5", 5000, sized("alpha newest", 300)),
      ],
    },
  });

  it("reads past messages newer than the window without charging them, where the source cannot seek", async () => {
    const { source, ctl } = makeControlledSource(ranPastWindow());
    const drill = newDrill(source, { drillPageMessages: 1, drillCharsPerSession: 200 });
    const out = await drill.pools(windowed([revised("s-a")], "alpha", { before: 3500 }));
    expect(ctl.pages).toHaveLength(5);
    expect(poolTexts(out, "s-a")).toEqual(["alpha inside", "alpha needle", "beta oldest"]);
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 5, candidate: 3, eligible: 3, stop: "end" },
    ]);
  });

  it("starts at the newest message at or before the upper bound where the source seeks", async () => {
    const { source, ctl } = makeControlledSource(ranPastWindow(), { seek: true });
    const drill = newDrill(source, { drillPageMessages: 1, drillCharsPerSession: 200 });
    const out = await drill.pools(windowed([revised("s-a")], "alpha", { before: 3500 }));
    expect(ctl.seeks).toEqual([{ sessionID: "s-a", until: 3500 }]);
    // a3, a2, a1: neither newer message is read.
    expect(ctl.pages).toHaveLength(3);
    expect(ctl.pages[0]!.before).toBeDefined();
    expect(poolTexts(out, "s-a")).toEqual(["alpha inside", "alpha needle", "beta oldest"]);
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 3, candidate: 3, eligible: 3, stop: "end" },
    ]);
  });

  it("reads nothing from a session with no message at or before the upper bound", async () => {
    const { source, ctl } = makeControlledSource(ranPastWindow(), { seek: true });
    const drill = newDrill(source, { drillPageMessages: 1 });
    const out = await drill.pools(
      windowed([revised("s-a")], "alpha", { before: 500 }, { "s-a": [ftsHit("s-a", "a2")] }),
    );
    expect(ctl.pages).toEqual([]);
    expect(ctl.lookups).toEqual([]);
    expect(out.pools[0]!.candidates).toEqual([]);
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 0, candidate: 0, eligible: 0, stop: "end" },
    ]);
  });

  it("ends a walk that reads too far past messages outside the window as sessionBudget", async () => {
    // Each newer message is half the out-of-window bound, so the walk ends
    // after two of them, before it reaches a1.
    const budget = 100;
    const half = (budget * OUT_OF_WINDOW_FACTOR) / 2;
    const { source, ctl } = makeControlledSource({
      messagesBySession: {
        "s-a": [
          note("s-a", "a1", 1000, "alpha inside"),
          note("s-a", "a2", 5000, sized("alpha newer", half)),
          note("s-a", "a3", 6000, sized("alpha newer", half)),
          note("s-a", "a4", 7000, sized("alpha newer", half)),
        ],
      },
    });
    const drill = newDrill(source, { drillPageMessages: 1, drillCharsPerSession: budget });
    const out = await drill.pools(windowed([revised("s-a")], "alpha", { before: 3000 }));
    expect(ctl.pages).toHaveLength(2);
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 2, candidate: 0, eligible: 0, stop: "sessionBudget" },
    ]);
  });

  it("stops at the first page that reaches the lower bound, without charging its older messages", async () => {
    // a2 is older than the window and alone passes the 300-char budget. The
    // source's floor shows that nothing below a2 is inside the window.
    const { source, ctl } = makeControlledSource(
      {
        messagesBySession: {
          "s-a": [
            note("s-a", "a1", 1000, "alpha ancient"),
            note("s-a", "a2", 2000, sized("alpha older", 500)),
            note("s-a", "a3", 3000, "alpha inside"),
            note("s-a", "a4", 4000, "alpha inside too"),
          ],
        },
      },
      { floor: true },
    );
    const drill = newDrill(source, { drillPageMessages: 1, drillCharsPerSession: 300 });
    const out = await drill.pools(windowed([revised("s-a")], "alpha", { after: 2500 }));
    expect(ctl.pages).toHaveLength(3);
    expect(poolTexts(out, "s-a")).toEqual(["alpha inside too", "alpha inside"]);
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 3, candidate: 2, eligible: 2, stop: "end" },
    ]);
  });

  it("looks up an FTS hit outside the window without adding or charging it", async () => {
    // The walk stops at the anchor on a4. a1 is older than the window and
    // would alone spend the budget a2's lookup needs.
    const { source, ctl } = makeControlledSource({
      messagesBySession: {
        "s-a": [
          note("s-a", "a1", 1000, sized("alpha ancient", 500)),
          note("s-a", "a2", 2000, "alpha kept"),
          note("s-a", "a3", 3000, "chatter"),
          note("s-a", "a4", 4000, "chatter"),
          note("s-a", "a5", 5000, "alpha recent"),
        ],
      },
    });
    const drill = newDrill(source, { drillPageMessages: 1, drillCharsPerSession: 300 });
    const out = await drill.pools(
      windowed(
        [revised("s-a")],
        "alpha",
        { after: 1500 },
        { "s-a": [ftsHit("s-a", "a1"), ftsHit("s-a", "a2")] },
      ),
    );
    expect(ctl.lookups.map((l) => l.messageID)).toEqual(["a1", "a2"]);
    expect(poolTexts(out, "s-a")).toEqual(["alpha recent", "chatter", "alpha kept"]);
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 4, candidate: 3, eligible: 3, stop: "anchor" },
    ]);
  });

  it("keeps messages outside the window off the per-query budget", async () => {
    const graph: Graph = {
      messagesBySession: {
        ...ranPastWindow().messagesBySession,
        "s-b": [note("s-b", "b1", 2000, "alpha other")],
      },
    };
    const { source } = makeControlledSource(graph);
    // s-a's newer messages alone pass the query budget, though not the
    // query's bound on messages outside the window; what s-a holds inside the
    // window does not pass it.
    const drill = newDrill(source, { drillPageMessages: 1, drillCharsPerQuery: 200 });
    const out = await drill.pools(
      windowed([revised("s-a"), revised("s-b")], "alpha", { before: 3500 }),
    );
    expect(out.budgetExhausted).toBe(false);
    expect(out.targets.map((t) => [t.sessionId, t.stop])).toEqual([
      ["s-a", "end"],
      ["s-b", "end"],
    ]);
    expect(poolTexts(out, "s-b")).toEqual(["alpha other"]);
  });

  it("walks cached pages under another window, with a slice of its own", async () => {
    const { source, ctl } = makeControlledSource({
      messagesBySession: {
        "s-a": [
          note("s-a", "a1", 1000, "alpha one"),
          note("s-a", "a2", 2000, "alpha two"),
          note("s-a", "a3", 3000, "alpha three"),
          note("s-a", "a4", 4000, "alpha four"),
        ],
      },
    });
    const drill = newDrill(source, { drillPageMessages: 1 });
    const early = windowed([revised("s-a")], "alpha", { before: 2500 });
    const late = windowed([revised("s-a")], "alpha", { after: 2500 });

    const first = await drill.pools(early);
    expect(poolTexts(first, "s-a")).toEqual(["alpha two", "alpha one"]);
    const reads = ctl.pages.length;

    const second = await drill.pools(late);
    expect(ctl.pages).toHaveLength(reads);
    expect(poolTexts(second, "s-a")).toEqual(["alpha four", "alpha three"]);
    expect(second.targets[0]).toMatchObject({ fetched: 3, candidate: 2, cached: true });

    const again = await drill.pools(early);
    expect(poolTexts(again, "s-a")).toEqual(poolTexts(first, "s-a"));
    expect(again.targets).toEqual([{ ...first.targets[0]!, cached: true }]);
  });

  it("sweeps from the upper bound and completes a session at the lower bound in a deep sweep", async () => {
    // Inside the window (2500, 4500): m3 and m4. The budget holds those two
    // of each session, not every message the sweep reads.
    const session = (sid: string): MessageBundle[] =>
      [1000, 2000, 3000, 4000, 5000, 6000].map((created, i) =>
        note(sid, `${sid}-m${i + 1}`, created, sized(`alpha ${i + 1}`, 50)),
      );
    const { source, ctl } = makeControlledSource(
      { messagesBySession: { "s-a": session("s-a"), "s-b": session("s-b") } },
      { seek: true },
    );
    const out = await newDrill(source).deep({
      sessions: [revised("s-a"), revised("s-b")],
      query: parseQuery("alpha"),
      charsPerQuery: 220,
      window: { after: 2500, before: 4500 },
    });
    expect(ctl.seeks.map((s) => s.sessionID)).toEqual(["s-a", "s-b"]);
    expect(ctl.pages).toHaveLength(2);
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 4, candidate: 2, eligible: 2, stop: "end" },
      { sessionId: "s-b", fetched: 4, candidate: 2, eligible: 2, stop: "end" },
    ]);
    expect(out.coverage).toMatchObject({ sessionsCovered: 2, sessionsPartial: 0 });
    expect(out.continuation).toBeUndefined();
  });
});

// ── Time windows, continued: where a walk starts and ends, what a seek
// costs and which answers and builds a later query may reuse. Page size 1. ──

describe("drill time window bounds and reuse", () => {
  const windowed = (
    sessions: DrillTarget[],
    text: string,
    window: DrillInput["window"],
    fts?: Record<string, FtsHit[]>,
  ): DrillInput => ({ ...poolsInput(sessions, text, fts), window });

  /** s-a: "alpha 1" to "alpha 5", created at 1000 to 5000. */
  const fiveNotes = (): Graph => ({
    messagesBySession: {
      "s-a": [1000, 2000, 3000, 4000, 5000].map((created, i) =>
        note("s-a", `a${i + 1}`, created, `alpha ${i + 1}`),
      ),
    },
  });

  it("counts the anchor stop's pages from the first page holding the window", async () => {
    // No seek: the walk starts at a4. Neither newer page holds the anchor,
    // and neither does a2, the window's first page, which the stop exempts.
    const { source, ctl } = makeControlledSource({
      messagesBySession: {
        "s-a": [
          note("s-a", "a1", 1000, "alpha needle"),
          note("s-a", "a2", 2000, "chatter inside"),
          note("s-a", "a3", 4000, "chatter"),
          note("s-a", "a4", 5000, "chatter"),
        ],
      },
    });
    const drill = newDrill(source, { drillPageMessages: 1 });
    const out = await drill.pools(windowed([revised("s-a")], "alpha", { before: 3000 }));
    expect(ctl.pages).toHaveLength(4);
    expect(poolTexts(out, "s-a")).toEqual(["chatter inside", "alpha needle"]);
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 4, candidate: 2, eligible: 2, stop: "end" },
    ]);
  });

  it("never looks up an FTS hit its walk already read outside the window", async () => {
    const { source, ctl } = makeControlledSource({
      messagesBySession: {
        "s-a": [
          note("s-a", "a1", 1000, "alpha one"),
          note("s-a", "a2", 2000, "alpha two"),
          note("s-a", "a3", 5000, "alpha newer"),
        ],
      },
    });
    const drill = newDrill(source, { drillPageMessages: 1 });
    const out = await drill.pools(
      windowed([revised("s-a")], "alpha", { before: 3000 }, { "s-a": [ftsHit("s-a", "a3")] }),
    );
    expect(ctl.lookups).toEqual([]);
    expect(poolTexts(out, "s-a")).toEqual(["alpha two", "alpha one"]);
    expect(out.targets[0]).toMatchObject({ fetched: 3, candidate: 2, stop: "end" });
  });

  it("leaves out the message created at the upper bound its seek starts at", async () => {
    const { source, ctl } = makeControlledSource(fiveNotes(), { seek: true });
    const drill = newDrill(source, { drillPageMessages: 1 });
    const out = await drill.pools(windowed([revised("s-a")], "alpha", { before: 3000 }));
    // a3, created at 3000, is where the walk starts and is outside the window.
    expect(ctl.pages).toHaveLength(3);
    expect(poolTexts(out, "s-a")).toEqual(["alpha 2", "alpha 1"]);
    expect(out.targets[0]).toMatchObject({ fetched: 3, candidate: 2, stop: "end" });
  });

  it("ends the walk at a message created at the lower bound, leaving it out", async () => {
    const { source, ctl } = makeControlledSource(fiveNotes(), { floor: true });
    const drill = newDrill(source, { drillPageMessages: 1 });
    const out = await drill.pools(windowed([revised("s-a")], "alpha", { after: 3000 }));
    expect(ctl.pages).toHaveLength(3);
    expect(poolTexts(out, "s-a")).toEqual(["alpha 5", "alpha 4"]);
    expect(out.targets[0]).toMatchObject({ fetched: 3, candidate: 2, stop: "end" });
  });

  it("seeks once per upper bound and reuses each answer, a session with nothing below it included", async () => {
    const { source, ctl } = makeControlledSource(fiveNotes(), { seek: true });
    const drill = newDrill(source, { drillPageMessages: 1 });
    const run = (window: DrillInput["window"]) =>
      drill.pools(windowed([revised("s-a")], "alpha", window));
    const first = await run({ before: 3500 });
    const again = await run({ before: 3500 });
    expect(again.targets).toEqual([{ ...first.targets[0]!, cached: true }]);
    await run({ before: 500 });
    await run({ before: 500 });
    await run({ before: 4500 });
    // A lower bound alone needs no seek.
    await run({ after: 1500 });
    expect(ctl.seeks.map((s) => s.until)).toEqual([3500, 500, 4500]);
  });

  it("walks the pages an unbounded walk cached when the seek starts at the newest message", async () => {
    const { source, ctl } = makeControlledSource(fiveNotes(), { seek: true });
    const drill = newDrill(source, { drillPageMessages: 1 });
    await drill.pools(poolsInput([revised("s-a")], "alpha"));
    const pages = ctl.pages.length;
    const out = await drill.pools(windowed([revised("s-a")], "alpha", { before: 9000 }));
    expect(ctl.seeks).toHaveLength(1);
    expect(ctl.pages).toHaveLength(pages);
    expect(out.targets[0]).toMatchObject({ fetched: 5, candidate: 5, stop: "end" });
  });

  it("walks from the newest page after a failed seek, counts the seek as a read and asks again next time", async () => {
    const { source: inner, ctl } = makeControlledSource(fiveNotes(), { seek: true });
    let failing = true;
    let attempts = 0;
    const source: HistorySource = {
      ...inner,
      async seekPage(o) {
        attempts++;
        if (failing) return { ok: false, reason: "error", error: "host busy" };
        return inner.seekPage!(o);
      },
    };
    const drill = newDrill(source, { drillPageMessages: 1 });
    const input = windowed([revised("s-a")], "alpha", { before: 3500 });
    // An unbounded walk caches every page first, so only a seek can read.
    await drill.pools(poolsInput([revised("s-a")], "alpha"));
    const pages = ctl.pages.length;

    const failed = await drill.pools(input);
    expect(poolTexts(failed, "s-a")).toEqual(["alpha 3", "alpha 2", "alpha 1"]);
    // The walk read from a5 down and left out the two newer messages.
    expect(failed.targets).toEqual([
      { sessionId: "s-a", fetched: 5, candidate: 3, eligible: 3, stop: "end" },
    ]);

    failing = false;
    const sought = await drill.pools(input);
    expect(attempts).toBe(2);
    expect(sought.targets).toEqual([
      { sessionId: "s-a", fetched: 3, candidate: 3, eligible: 3, stop: "end" },
    ]);

    const repeat = await drill.pools(input);
    expect(attempts).toBe(2);
    expect(repeat.targets).toEqual([
      { sessionId: "s-a", fetched: 3, candidate: 3, eligible: 3, stop: "end", cached: true },
    ]);
    expect(ctl.pages).toHaveLength(pages);
  });

  it("counts no read for a seek the v1 source cannot make, so a repeated query is all cache", async () => {
    const { source, calls } = makeDrillFake(fiveNotes());
    const drill = newDrill(source, { drillPageMessages: 1 });
    const input = windowed([revised("s-a")], "alpha", { before: 3500 });
    const first = await drill.pools(input);
    expect(first.targets[0]).toMatchObject({ fetched: 5, candidate: 3, stop: "end" });
    const reads = calls.messages.length;
    const second = await drill.pools(input);
    expect(calls.messages).toHaveLength(reads);
    expect(second.targets).toEqual([{ ...first.targets[0]!, cached: true }]);
  });

  it("builds a slice of its own for another window over the same pages", async () => {
    // No seek: every window here walks all five pages to the session's start.
    const { source, ctl } = makeControlledSource(fiveNotes());
    const drill = newDrill(source, { drillPageMessages: 1 });
    const wide = await drill.pools(windowed([revised("s-a")], "alpha", { before: 3500 }));
    expect(poolTexts(wide, "s-a")).toEqual(["alpha 3", "alpha 2", "alpha 1"]);
    const pages = ctl.pages.length;

    const narrow = await drill.pools(windowed([revised("s-a")], "alpha", { before: 2500 }));
    expect(ctl.pages).toHaveLength(pages);
    expect(poolTexts(narrow, "s-a")).toEqual(["alpha 2", "alpha 1"]);
    expect(narrow.targets[0]).toMatchObject({ fetched: 5, candidate: 2, cached: true });

    const unbounded = await drill.pools(poolsInput([revised("s-a")], "alpha"));
    expect(poolTexts(unbounded, "s-a")).toEqual([
      "alpha 5",
      "alpha 4",
      "alpha 3",
      "alpha 2",
      "alpha 1",
    ]);
  });
});

describe("deep sweep time window bounds", () => {
  /** `count` messages created at 1000, 2000, …: 100 chars from `largeFrom`
   *  on, 20 before it. */
  const series = (sid: string, count: number, largeFrom = Infinity): MessageBundle[] =>
    Array.from({ length: count }, (_, i) => {
      const created = (i + 1) * 1000;
      return note(
        sid,
        `${sid}-m${i + 1}`,
        created,
        sized(`alpha ${i + 1}`, created >= largeFrom ? 100 : 20),
      );
    });

  it("reads past messages newer than the window without pooling or charging them where the source cannot seek", async () => {
    // Fifty newer messages fill the newest page and alone pass the budget,
    // though not the sweep's bound on messages outside the window.
    const { source, calls } = makeDrillFake({
      messagesBySession: { "s-a": series("s-a", 60, 10_500) },
    });
    const out = await newDrill(source).deep({
      sessions: [revised("s-a")],
      query: parseQuery("alpha"),
      charsPerQuery: 1_500,
      window: { before: 10_500 },
    });
    expect(calls.messages).toHaveLength(2);
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 60, candidate: 10, eligible: 10, stop: "end" },
    ]);
    expect(out.coverage).toMatchObject({ sessionsCovered: 1, sessionsPartial: 0 });
    expect(out.continuation).toBeUndefined();
  });

  it("completes a session at the first page that reaches the lower bound, leaving older pages unread", async () => {
    // The source's floor shows that nothing below that page is inside.
    const { source, ctl } = makeControlledSource(
      { messagesBySession: { "s-a": series("s-a", 120) } },
      { floor: true },
    );
    const out = await newDrill(source).deep({
      sessions: [revised("s-a")],
      query: parseQuery("alpha"),
      charsPerQuery: 1_000_000,
      window: { after: 100_500 },
    });
    // The newest page holds m120 down to m71, of which m101 to m120 are inside.
    expect(ctl.pages).toHaveLength(1);
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 50, candidate: 20, eligible: 20, stop: "end" },
    ]);
    expect(out.coverage).toMatchObject({ sessionsCovered: 1, sessionsPartial: 0 });
    expect(out.continuation).toBeUndefined();
  });

  it("reads nothing from a session with nothing at or before the upper bound and counts it covered", async () => {
    const { source, ctl } = makeControlledSource(
      {
        messagesBySession: {
          "s-a": [note("s-a", "a1", 5000, "alpha late"), note("s-a", "a2", 6000, "alpha later")],
          "s-b": [note("s-b", "b1", 1000, "alpha early"), note("s-b", "b2", 2000, "alpha inside")],
        },
      },
      { seek: true },
    );
    const out = await newDrill(source).deep({
      sessions: [revised("s-a"), revised("s-b")],
      query: parseQuery("alpha"),
      charsPerQuery: 10_000,
      window: { before: 3000 },
    });
    expect(ctl.pages.map((p) => p.sessionID)).toEqual(["s-b"]);
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 0, candidate: 0, eligible: 0, stop: "end" },
      { sessionId: "s-b", fetched: 2, candidate: 2, eligible: 2, stop: "end" },
    ]);
    expect(out.coverage).toMatchObject({ sessionsCovered: 2, sessionsPartial: 0 });
  });

  it("continues a resumed session from its cursor without seeking", async () => {
    const sessionA = series("s-a", 3);
    const { source, ctl } = makeControlledSource(
      { messagesBySession: { "s-a": sessionA, "s-b": series("s-b", 3) } },
      { seek: true },
    );
    const cursor = paginateBundles(sessionA, 1).nextCursor!;
    const out = await newDrill(source).deep({
      sessions: [revised("s-a"), revised("s-b")],
      query: parseQuery("alpha"),
      charsPerQuery: 10_000,
      window: { before: 9000 },
      resume: { before: cursor },
    });
    expect(ctl.seeks.map((s) => s.sessionID)).toEqual(["s-b"]);
    expect(ctl.pages[0]).toEqual({ sessionID: "s-a", before: cursor });
    expect(out.targets[0]).toMatchObject({
      sessionId: "s-a",
      fetched: 2,
      candidate: 2,
      stop: "end",
    });
  });
});

// ── Time windows where creation times are out of row order (opencode moves a
// retried assistant's creation time later), and the bounds on reading past
// messages outside the window. ──

describe("drill time window order and outside bounds", () => {
  const windowed = (
    sessions: DrillTarget[],
    text: string,
    window: DrillInput["window"],
  ): DrillInput => ({ ...poolsInput(sessions, text), window });

  /** s-a in row order, two messages a page: a5 is older than a lower bound
   *  of 4500 and ends the second page, while a4, below it, is inside. a0 is
   *  alone on a fifth page. */
  const inverted = (): Graph => ({
    messagesBySession: {
      "s-a": [
        note("s-a", "a0", 500, "alpha zero"),
        note("s-a", "a1", 1000, "alpha one"),
        note("s-a", "a2", 2000, "alpha two"),
        note("s-a", "a3", 3000, "alpha three"),
        note("s-a", "a4", 4800, "alpha needle"),
        note("s-a", "a5", 4200, "alpha retried"),
        note("s-a", "a6", 5000, "alpha six"),
        note("s-a", "a7", 6000, "alpha seven"),
        note("s-a", "a8", 7000, "alpha eight"),
      ],
    },
  });

  it("reads past an older message to the window's floor when creation times cross a page boundary", async () => {
    const { source, ctl } = makeControlledSource(inverted(), { floor: true });
    const drill = newDrill(source, { drillPageMessages: 2 });
    const out = await drill.pools(windowed([revised("s-a")], "alpha", { after: 4500 }));
    expect(ctl.floors).toEqual([{ sessionID: "s-a", after: 4500 }]);
    expect(ctl.pages).toHaveLength(3);
    expect(poolTexts(out, "s-a")).toContain("alpha needle");
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 6, candidate: 4, eligible: 4, stop: "end" },
    ]);
  });

  it("reads on past the lower bound where the source has no floor, until a page holds nothing inside", async () => {
    const { source, ctl } = makeControlledSource(inverted());
    const drill = newDrill(source, { drillPageMessages: 2 });
    const out = await drill.pools(windowed([revised("s-a")], "alpha", { after: 4500 }));
    expect(ctl.pages).toHaveLength(4);
    expect(poolTexts(out, "s-a")).toContain("alpha needle");
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 8, candidate: 4, eligible: 4, stop: "anchor" },
    ]);
  });

  it("sweeps past an older message to the window's floor in a deep sweep, and only then counts the session covered", async () => {
    // Sixty messages, fifty a page: m11 is older than the window and ends the
    // first page, while m6 to m10, on the second, are inside.
    const messages = Array.from({ length: 60 }, (_, i) => {
      const seq = i + 1;
      return note("s-a", `m${seq}`, seq === 11 ? 500 : seq * 1000, `alpha ${seq}`);
    });
    const { source, ctl } = makeControlledSource(
      { messagesBySession: { "s-a": messages } },
      { floor: true },
    );
    const out = await newDrill(source).deep({
      sessions: [revised("s-a")],
      query: parseQuery("alpha"),
      charsPerQuery: 1_000_000,
      window: { after: 5500 },
    });
    expect(ctl.pages).toHaveLength(2);
    expect(out.pools[0]!.candidates.map((c) => c.rawText)).toContain("alpha 6");
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 60, candidate: 54, eligible: 54, stop: "end" },
    ]);
    expect(out.coverage).toMatchObject({ sessionsCovered: 1, sessionsPartial: 0 });
    expect(out.continuation).toBeUndefined();
  });

  /** A v1 session that ran past a window ending at 3000: one message inside
   *  it, then three newer ones of 100 chars. */
  const ranPast = (sid: string): MessageBundle[] => [
    note(sid, `${sid}-in`, 1000, "alpha inside"),
    ...[4000, 5000, 6000].map((created, i) =>
      note(sid, `${sid}-n${i}`, created, sized(`alpha newer ${i}`, 100)),
    ),
  ];

  it("ends the drill as queryBudget once its sessions together read past too much outside the window", async () => {
    // The query's bound outside the window is four times its 200-char
    // budget: s1 and s2 read 300 each and s3 reaches 800 on its second page.
    const ids = ["s1", "s2", "s3", "s4", "s5"];
    const { source } = makeDrillFake({
      messagesBySession: Object.fromEntries(ids.map((id) => [id, ranPast(id)])),
    });
    const drill = newDrill(source, {
      drillPageMessages: 1,
      drillCharsPerSession: 10_000,
      drillCharsPerQuery: 200,
    });
    const out = await drill.pools(
      windowed(
        ids.map((id) => revised(id)),
        "alpha",
        { before: 3000 },
      ),
    );
    expect(out.budgetExhausted).toBe(true);
    expect(out.targets).toEqual([
      { sessionId: "s1", fetched: 4, candidate: 1, eligible: 1, stop: "end" },
      { sessionId: "s2", fetched: 4, candidate: 1, eligible: 1, stop: "end" },
      { sessionId: "s3", fetched: 2, candidate: 0, eligible: 0, stop: "queryBudget" },
      unread("s4", "queryBudget"),
      unread("s5", "queryBudget"),
    ]);
  });

  it("ends a deep sweep with a continuation once it reads past too much outside the window", async () => {
    // Fifty newer messages of 100 chars fill the first page: four times the
    // sweep's 1,000-char budget is less than they hold.
    const series = (sid: string): MessageBundle[] =>
      Array.from({ length: 60 }, (_, i) => {
        const created = (i + 1) * 1000;
        return note(sid, `${sid}-m${i + 1}`, created, sized(`alpha ${i + 1}`, 100));
      });
    const { source } = makeDrillFake({
      messagesBySession: { "s-a": series("s-a"), "s-b": series("s-b") },
    });
    const out = await newDrill(source).deep({
      sessions: [revised("s-a"), revised("s-b")],
      query: parseQuery("alpha"),
      charsPerQuery: 1_000,
      window: { before: 10_500 },
    });
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 50, candidate: 0, eligible: 0, stop: "budget" },
      unread("s-b", "budget"),
    ]);
    expect(out.coverage).toMatchObject({ sessionsCovered: 0, sessionsPartial: 1 });
    expect(out.continuation).toMatchObject({ current: "s-a", remaining: ["s-b"] });
    expect(out.continuation?.before).toEqual(expect.any(String));
  });

  it("ends a walk past messages that charge no chars on their count, as sessionBudget", async () => {
    // Our own recall calls have no searchable text, so passing them costs
    // nothing in chars.
    const newer = Array.from({ length: OUT_OF_WINDOW_MESSAGES + 100 }, (_, i) =>
      bundle(assistantMessage(`n${i}`, "s-a", 10_000 + i), [
        completedToolPart(`n${i}-p`, "s-a", `n${i}`, "recall", { query: "alpha" }, "alpha"),
      ]),
    );
    const { source, ctl } = makeControlledSource({
      messagesBySession: { "s-a": [note("s-a", "in", 1000, "alpha inside"), ...newer] },
    });
    const out = await newDrill(source).pools(windowed([revised("s-a")], "alpha", { before: 5000 }));
    expect(ctl.pages).toHaveLength(OUT_OF_WINDOW_MESSAGES / TEST_LIMITS.drillPageMessages);
    expect(out.targets).toEqual([
      {
        sessionId: "s-a",
        fetched: OUT_OF_WINDOW_MESSAGES,
        candidate: 0,
        eligible: 0,
        stop: "sessionBudget",
      },
    ]);
  });

  it("stops a walk before its next page once the drill is aborted", async () => {
    const { source, ctl } = makeControlledSource({
      messagesBySession: { "s-a": ranPast("s-a"), "s-b": ranPast("s-b") },
    });
    let held = false;
    ctl.holdPage = (req) => {
      if (held || req.sessionID !== "s-a" || req.before === undefined) return false;
      held = true;
      return true;
    };
    const controller = new AbortController();
    const drill = newDrill(source, { drillPageMessages: 1 });
    const pending = drill.pools({
      ...windowed([revised("s-a"), revised("s-b")], "alpha", { before: 3000 }),
      abort: controller.signal,
    });
    await waitFor(() => ctl.held.length === 1);
    controller.abort();
    ctl.held[0]!();
    const out = await pending;
    expect(ctl.pages).toHaveLength(2);
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 2, candidate: 0, eligible: 0, stop: "aborted" },
      unread("s-b", "aborted"),
    ]);
  });

  it("asks a source that cannot seek or find a floor once per drill, whatever the sessions", async () => {
    const { source: inner } = makeDrillFake({
      messagesBySession: { "s-a": ranPast("s-a"), "s-b": ranPast("s-b"), "s-c": ranPast("s-c") },
    });
    const asked = { seek: 0, floor: 0 };
    const source: HistorySource = {
      ...inner,
      seekPage: (o) => {
        asked.seek++;
        return inner.seekPage!(o);
      },
      seqFloor: (o) => {
        asked.floor++;
        return inner.seqFloor!(o);
      },
    };
    const drill = newDrill(source, { drillPageMessages: 1 });
    const sessions = [revised("s-a"), revised("s-b"), revised("s-c")];
    await drill.pools(windowed(sessions, "alpha", { after: 500, before: 4500 }));
    await drill.pools(windowed(sessions, "alpha", { after: 500, before: 5500 }));
    expect(asked).toEqual({ seek: 1, floor: 0 });
    await drill.pools(windowed(sessions, "alpha", { after: 4500 }));
    expect(asked).toEqual({ seek: 1, floor: 1 });
  });

  it("fetches no FTS hit once a newer tail has spent the walk's outside bound, though its budget is untouched", async () => {
    // A 100-char budget gives the walk 400 chars outside the window: two
    // newer messages of 200 spend them before anything inside is read.
    const { source, ctl } = makeControlledSource({
      messagesBySession: {
        "s-a": [
          note("s-a", "a1", 1000, "alpha needle"),
          note("s-a", "a2", 2000, "alpha inside"),
          ...[4000, 5000, 6000].map((created, i) =>
            note("s-a", `n${i}`, created, sized(`alpha newer ${i}`, 200)),
          ),
        ],
      },
    });
    const drill = newDrill(source, { drillPageMessages: 1, drillCharsPerSession: 100 });
    const out = await drill.pools({
      ...windowed([revised("s-a")], "alpha", { before: 3000 }),
      ftsBySession: new Map([["s-a", [ftsHit("s-a", "a1"), ftsHit("s-a", "a2")]]]),
    });
    expect(ctl.lookups).toEqual([]);
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 2, candidate: 0, eligible: 0, stop: "sessionBudget" },
    ]);
  });

  it("charges an FTS hit found outside the window to the drill's outside bound and stops its lookups there as queryBudget", async () => {
    // A 100-char query budget gives the drill 400 chars outside the window.
    // The walk reads a3 (300 chars) on its way to the floor, and looking up
    // a1 adds 300 more, so a2 is never fetched.
    const { source, ctl } = makeControlledSource(
      {
        messagesBySession: {
          "s-a": [
            note("s-a", "a1", 1000, sized("alpha one", 300)),
            note("s-a", "a2", 2000, sized("alpha two", 300)),
            note("s-a", "a3", 3000, sized("alpha three", 300)),
            note("s-a", "a5", 5000, "alpha five"),
            note("s-a", "a6", 6000, "alpha six"),
          ],
        },
      },
      { floor: true },
    );
    const drill = newDrill(source, { drillPageMessages: 1, drillCharsPerQuery: 100 });
    const out = await drill.pools({
      ...windowed([revised("s-a")], "alpha", { after: 4500 }),
      ftsBySession: new Map([["s-a", [ftsHit("s-a", "a1"), ftsHit("s-a", "a2")]]]),
    });
    expect(ctl.lookups.map((l) => l.messageID)).toEqual(["a1"]);
    expect(poolTexts(out, "s-a")).toEqual(["alpha six", "alpha five"]);
    expect(out.budgetExhausted).toBe(true);
    expect(out.targets).toEqual([
      { sessionId: "s-a", fetched: 4, candidate: 2, eligible: 2, stop: "queryBudget" },
    ]);
  });
});
