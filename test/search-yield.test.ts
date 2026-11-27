import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Part, Session } from "@opencode-ai/sdk/v2";
import { search } from "../src/search.js";
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
      const time = NOW - s * 60_000 - (60 - m) * 500;
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

/** Each search's output text, run with `yieldPoint` as the search's and
 *  the drill's yield point. */
async function outputs(yieldPoint: () => Promise<void>): Promise<string[]> {
  const h = makeFakeHarness({ corpus: corpus() });
  const { deps, cleanup } = await makeRecallDeps(h, TEST_LIMITS, { yieldPoint });
  try {
    const tool = search(h.source, true, TEST_LIMITS, deps);
    const texts: string[] = [];
    for (const args of SEARCHES) {
      texts.push(toolResultText(await tool.execute(args as never, makeContext().ctx)));
    }
    return texts;
  } finally {
    cleanup();
  }
}

describe("search output with and without yields", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is the same text whether or not the search yields at each point it may", async () => {
    const straight = await outputs(() => Promise.resolve());
    let yields = 0;
    const yielding = await outputs(
      () =>
        new Promise<void>((resolve) => {
          yields++;
          setImmediate(resolve);
        }),
    );
    expect(yielding).toEqual(straight);
    // Every search returned results, and the second run yielded inside the
    // lookup, the ranking loops and the result building.
    for (const text of straight) expect(JSON.parse(text).results.length).toBeGreaterThan(0);
    expect(yields).toBeGreaterThan(50);
  });
});
