import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Part, Session } from "@opencode-ai/sdk/v2";
import { search } from "../src/search.js";
import { bm25Search, bm25SearchPausing } from "../src/bm25.js";
import { buildCandidates, populateNormalized } from "../src/candidates.js";
import { parseQuery } from "../src/query.js";
import { rerankDrilled, rerankDrilledPausing } from "../src/rerank.js";
import { mulberry32 } from "./perf-helpers.js";
import {
  PROJECT_DIR,
  TEST_LIMITS,
  assistantMessage,
  bundle,
  completedToolPart,
  makeContext,
  makeFakeHarness,
  makeRecallDeps,
  reasoningPart,
  session,
  textPart,
  toolResultText,
  userMessage,
} from "./helpers.js";

// A search hands the event loop back while it looks the slim index up, ranks
// the drilled pool and builds results. Where it does so must not change what
// it returns, so the same searches run once without yielding and once
// yielding at every point that may, and their outputs must be the same text.

const NOW = 1_790_000_000_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const WORDS = [
  "deploy",
  "deployment",
  "wrangler",
  "worker",
  "cache",
  "caching",
  "config",
  "token",
  "launcher",
  "release",
  "rollback",
  "migration",
  "schema",
  "index",
  "query",
  "budget",
  "slice",
  "error",
  "retry",
  "timeout",
];

/** Six sessions of 60 messages each, every part drawn from one small
 *  vocabulary, so a query matches hundreds of parts across every page. */
function corpus(): {
  sessions: Session[];
  messagesBySession: Record<string, { info: Message; parts: Part[] }[]>;
} {
  const rand = mulberry32(5);
  const prose = (n: number): string =>
    Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" ");
  const sessions: Session[] = [];
  const messagesBySession: Record<string, { info: Message; parts: Part[] }[]> = {};
  for (let s = 0; s < 6; s++) {
    const id = `ses-yield-${s}`;
    sessions.push(session(id, `Yield session ${s} ${prose(3)}`, PROJECT_DIR, NOW - s * 60_000));
    const bundles: { info: Message; parts: Part[] }[] = [];
    for (let m = 0; m < 60; m++) {
      const mid = `${id}-m${String(m).padStart(2, "0")}`;
      // The last session sits just inside the seven days a result counts as
      // recent for, so a label read after a few yields would say older.
      const time =
        s === 5 ? NOW - SEVEN_DAYS_MS + 5_000 + m * 500 : NOW - s * 60_000 - (60 - m) * 500;
      if (m % 3 === 0) {
        bundles.push(
          bundle(userMessage(mid, id, time), [textPart(`${mid}-t`, id, mid, prose(20))]),
        );
        continue;
      }
      bundles.push(
        bundle(assistantMessage(mid, id, time), [
          reasoningPart(`${mid}-r`, id, mid, prose(30)),
          completedToolPart(
            `${mid}-k`,
            id,
            mid,
            m % 2 === 0 ? "bash" : "read",
            { command: prose(5), cwd: PROJECT_DIR },
            prose(60),
            { title: prose(3) },
          ),
        ]),
      );
    }
    messagesBySession[id] = bundles;
  }
  return { sessions, messagesBySession };
}

const SEARCHES: Array<Record<string, unknown>> = [
  { query: "deploy cache worker", match: "smart", results: 40 },
  { query: "deplyo cachng rollbak", match: "fuzzy", results: 40, explain: true },
  { query: "release migration schema", match: "smart", group: "session" },
  { query: '"wrangler deploy" config', match: "smart", results: 40 },
  {
    query: "retry timeout budget",
    match: "smart",
    deep: true,
    sessions: ["ses-yield-1", "ses-yield-2"],
  },
];

// The clock moves 1 ms at every reading, and a yield moves it a further
// second, as time passes while other work runs. Recency is read once per
// response before anything yields, so a yielding run must match one that
// never yields; reading the clock per candidate or per result would see the
// yields and change scores or labels.
let clock = NOW;

/** Starts the clock again, so each search sees the same readings. */
function resetClock(): void {
  clock = NOW;
}

const noYield = (): Promise<void> => Promise.resolve();

/** Yields to the event loop at every call, moving the clock a second. */
function yieldingPoint(): { pause: () => Promise<void>; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    pause: () =>
      new Promise<void>((resolve) => {
        calls++;
        clock += 1_000;
        setImmediate(resolve);
      }),
  };
}

/** Each search's output text, run with `yieldPoint` as the search's and
 *  the drill's yield point. `onContext` gets each search's abort controller
 *  before it runs. */
async function outputs(
  yieldPoint: () => Promise<void>,
  searches: Array<Record<string, unknown>> = SEARCHES,
  onContext?: (controller: AbortController) => void,
): Promise<string[]> {
  const h = makeFakeHarness({ corpus: corpus() });
  const { deps, cleanup } = await makeRecallDeps(h, TEST_LIMITS, { yieldPoint });
  try {
    const tool = search(h.source, true, TEST_LIMITS, deps);
    const texts: string[] = [];
    for (const args of searches) {
      resetClock();
      const { ctx, controller } = makeContext();
      onContext?.(controller);
      texts.push(toolResultText(await tool.execute(args as never, ctx)));
    }
    return texts;
  } finally {
    cleanup();
  }
}

// Each run seeds a store from the corpus before it searches.
describe("search output with and without yields", { timeout: 30_000 }, () => {
  beforeEach(() => {
    resetClock();
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 1));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is the same text whether or not the search yields at each point it may", async () => {
    const straight = await outputs(noYield);
    const yielding = yieldingPoint();
    expect(await outputs(yielding.pause)).toEqual(straight);
    // Every search returned results, and the second run yielded inside the
    // lookup, the ranking loops and the result building.
    for (const text of straight) expect(JSON.parse(text).results.length).toBeGreaterThan(0);
    expect(yielding.calls()).toBeGreaterThan(50);
    // Results near the seven-day line are among them.
    expect(straight.some((text) => text.includes('"sessionID":"ses-yield-5"'))).toBe(true);
  });

  it("ranks and looks up as the synchronous forms do while yielding", async () => {
    const h = makeFakeHarness({ corpus: corpus() });
    const { deps, store, cleanup } = await makeRecallDeps(h, TEST_LIMITS);
    try {
      const targets = h.sessions.map((s) => ({
        sessionId: s.id,
        title: s.title,
        directory: s.directory,
        timeUpdated: s.time.updated,
        parentID: null,
      }));
      const deepSet = new Set(targets.slice(0, 3).map((t) => t.sessionId));
      const cases = [
        { text: "deploy cache worker", mode: "smart" as const },
        { text: "deplyo cachng rollbak", mode: "fuzzy" as const },
      ];
      for (const { text, mode } of cases) {
        const query = parseQuery(text);
        const input = { sessions: targets, deepSet, query, mode, explain: true };
        const { pools } = await deps.drill.pools(input);
        resetClock();
        const expected = rerankDrilled(pools, deepSet, query, mode, true);
        resetClock();
        const yielding = yieldingPoint();
        const hits = await rerankDrilledPausing(pools, deepSet, query, mode, true, yielding.pause);
        expect(hits).toEqual(expected);
        expect(yielding.calls()).toBeGreaterThan(5);
        const lookup = { strong: [], weak: query.tokens };
        expect(await store.ftsSearchPausing(lookup, yieldingPoint().pause)).toEqual(
          store.ftsSearch(lookup),
        );
      }
    } finally {
      cleanup();
    }
  });

  it("returns the aborted response when the search is cancelled during its last yield", async () => {
    // The last yield of a ranked search is in its result building, after the
    // route's other cancellation checks.
    const searches = [SEARCHES[0]!, SEARCHES[4]!];
    for (const args of searches) {
      const counting = yieldingPoint();
      await outputs(counting.pause, [args]);
      const last = counting.calls();
      let calls = 0;
      let controller: AbortController | undefined;
      const [text] = await outputs(
        () => {
          if (++calls === last) controller?.abort();
          return Promise.resolve();
        },
        [args],
        (c) => {
          controller = c;
        },
      );
      expect(JSON.parse(text!)).toMatchObject({ ok: false, error: "aborted" });
    }
  });
});

describe("ranking hits with large tool outputs", () => {
  it("stops by text read as well as by hits while it builds their metadata", async () => {
    // Ten tool parts with 300,000-character outputs: well under the 64 hits
    // a step may hold, but 3 million characters of field text to tokenize.
    const id = "ses-large";
    const messages = Array.from({ length: 10 }, (_, m) => {
      const mid = `${id}-m${m}`;
      return bundle(assistantMessage(mid, id, NOW - m), [
        completedToolPart(
          `${mid}-k`,
          id,
          mid,
          "bash",
          { command: `deploy step ${m}` },
          `deploy ${"output line ".repeat(27_272)}${m}`,
        ),
      ]);
    });
    const { candidates } = buildCandidates(messages, {
      id,
      title: "Large outputs",
      directory: PROJECT_DIR,
      parentID: null,
    });
    for (const candidate of candidates) populateNormalized(candidate);
    const query = parseQuery("deploy output");
    const expected = bm25Search(candidates, query, "smart", true, NOW);
    let stops = 0;
    const hits = await bm25SearchPausing(
      candidates,
      query,
      "smart",
      true,
      async () => {
        stops++;
      },
      NOW,
    );
    expect(hits).toEqual(expected);
    expect(hits).toHaveLength(10);
    // A stop before each of the two sorts, and two more by text read.
    expect(stops).toBe(4);
  });
});
