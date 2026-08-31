import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpencodeClient, Part } from "@opencode-ai/sdk/v2";
import { createDrill, type DrillTarget } from "../src/drill.js";
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

function makeDrillFake(graph: Graph): { client: OpencodeClient; calls: Calls } {
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
  return { client, calls };
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
    const { client, calls } = makeDrillFake(parentageGraph());
    const { gate } = makeSpyGate();
    const drill = createDrill({ client, gate, limits: TEST_LIMITS });

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
    const { client, calls } = makeDrillFake(parentageGraph());
    const { gate } = makeSpyGate();
    const drill = createDrill({ client, gate, limits: TEST_LIMITS });

    const first = await humanPool(drill, unknownTarget);
    expect(first.human).toBe(0);

    const fetchesAfterFirst = calls.messages.length;
    const second = await humanPool(drill, rootTarget);
    expect(calls.messages.length).toBe(fetchesAfterFirst);
    expect(second.parentage).toEqual([null]);
    expect(second.human).toBe(1);
  });

  it("does not serve a cached root stamp to a child target", async () => {
    const { client } = makeDrillFake(parentageGraph());
    const { gate } = makeSpyGate();
    const drill = createDrill({ client, gate, limits: TEST_LIMITS });

    await humanPool(drill, rootTarget);
    const second = await humanPool(drill, childTarget);
    expect(second.parentage).toEqual(["s-parent"]);
    expect(second.human).toBe(0); // a child session's user text is delegated
  });

  it("leaves the cached array untouched when restamping (no retroactive reclassification)", async () => {
    const { client } = makeDrillFake(parentageGraph());
    const { gate } = makeSpyGate();
    const drill = createDrill({ client, gate, limits: TEST_LIMITS });

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
    const { client, calls } = makeDrillFake(graph);
    const { gate, queries } = makeSpyGate();
    const drill = createDrill({ client, gate, limits: TEST_LIMITS });

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
    const { client, calls } = makeDrillFake(graph);
    const { gate } = makeSpyGate();
    const drill = createDrill({ client, gate, limits: { ...TEST_LIMITS, drillPageMessages: 1 } });
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
    const { client, calls } = makeDrillFake(graph);
    const { gate } = makeSpyGate();
    const drill = createDrill({ client, gate, limits: { ...TEST_LIMITS, drillCharsPerQuery: 1 } });

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
    const { client, calls } = makeDrillFake(graph);
    const { gate } = makeSpyGate();
    const drill = createDrill({ client, gate, limits: TEST_LIMITS });
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
    const { client } = makeDrillFake(graph);
    const { gate } = makeSpyGate();
    const drill = createDrill({ client, gate, limits: TEST_LIMITS });

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
