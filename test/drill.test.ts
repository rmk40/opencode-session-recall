import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpencodeClient, Part } from "@opencode-ai/sdk/v2";
import { createDrill, type DrillOutput, type DrillTarget } from "../src/drill.js";
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
