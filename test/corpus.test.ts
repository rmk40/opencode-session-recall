import { describe, expect, it } from "vitest";
import { buildSessionDigest } from "../src/corpus.js";
import { buildCandidates } from "../src/candidates.js";
import {
  PROJECT_DIR,
  TEST_LIMITS,
  completedToolPart,
  makeFakeHarness,
  makeRecallDeps,
  reasoningPart,
  runTool,
  textPart,
} from "./helpers.js";
import { search } from "../src/search.js";
import type { SearchOutput } from "../src/types.js";

// (CorpusCache and assembleSession describes removed: both were deleted from
//  src/corpus.ts with the round-4 cutover — the persistent card store + tier-2
//  drill LRU replaced the in-memory cache, and its unpaginated whole-session
//  fetch is gone. buildSessionDigest is the surviving unit surface here; drilled
//  ranking/coverage is covered by drill.test.ts and recall.test.ts.)

describe("buildSessionDigest", () => {
  function digestOf(messages: Parameters<typeof buildCandidates>[0]): string {
    const { candidates } = buildCandidates(messages, {
      id: "s",
      title: "T",
      directory: PROJECT_DIR,
    });
    return buildSessionDigest(candidates);
  }

  it("combines the first user message head with statement/command vocabulary", () => {
    const digest = digestOf([
      {
        info: { id: "m1", role: "user", time: { created: 100 } },
        parts: [textPart("p1", "s", "m1", "Investigate the flaky websocket reconnect logic")],
      },
      {
        info: { id: "m2", role: "assistant", time: { created: 200 } },
        parts: [
          completedToolPart(
            "p2",
            "s",
            "m2",
            "bash",
            { command: "wscat --connect ws://host" },
            "ok",
          ),
        ],
      },
    ] as never);
    expect(digest).toContain("Investigate the flaky websocket reconnect logic");
    expect(digest).toContain("wscat");
  });

  it("gives no digest credit to read/skill tools or JSON pseudo-commands", () => {
    const digest = digestOf([
      {
        info: { id: "m1", role: "assistant", time: { created: 100 } },
        parts: [
          completedToolPart(
            "p1",
            "s",
            "m1",
            "read",
            { filePath: "/docs/zeppelin-handbook.md" },
            "zeppelin zeppelin zeppelin airship manual",
          ),
          completedToolPart(
            "p2",
            "s",
            "m1",
            "mcp__host__skill",
            { skill: "zeppelin" },
            "zeppelin skill payload",
          ),
        ],
      },
    ] as never);
    expect(digest).not.toContain("zeppelin");
    expect(digest).toBe("");
  });

  it("uses the earliest user message as the head and ignores reasoning vocabulary", () => {
    const digest = digestOf([
      {
        info: { id: "m1", role: "user", time: { created: 100 } },
        parts: [textPart("p1", "s", "m1", "Fix the broken telemetry exporter")],
      },
      {
        info: { id: "m2", role: "user", time: { created: 200 } },
        parts: [textPart("p2", "s", "m2", "Also polish dashboard rendering")],
      },
      {
        info: { id: "m3", role: "assistant", time: { created: 300 } },
        parts: [reasoningPart("p3", "s", "m3", "quixotic quixotic quixotic pondering")],
      },
    ] as never);
    // Candidates arrive newest-first; the head must still be the EARLIEST
    // user message, not the most recent one.
    expect(digest.startsWith("Fix the broken telemetry exporter")).toBe(true);
    // Reasoning is neither a statement nor an action: no digest credit.
    expect(digest).not.toContain("quixotic");
  });

  it("filters stopwords, short and letterless tokens, and caps the vocabulary at eight", () => {
    const words = [
      "ambera",
      "brindle",
      "cascade",
      "dorval",
      "estuary",
      "fjordic",
      "gantry",
      "harbinger",
      "icicle",
      "jamboree",
      "kestrel",
      "lantern",
    ];
    const digest = digestOf([
      {
        info: { id: "m1", role: "user", time: { created: 100 } },
        parts: [textPart("p1", "s", "m1", "go do")],
      },
      {
        info: { id: "m2", role: "assistant", time: { created: 200 } },
        parts: [textPart("p2", "s", "m2", `should with this 1234 ab ${words.join(" ")}`)],
      },
    ] as never);
    // Equal counts tie-break alphabetically; only the first eight survive.
    expect(digest).toBe("go do ambera brindle cascade dorval estuary fjordic gantry harbinger");
  });

  it("keeps sessions with no statements or commands digest-free", () => {
    const digest = digestOf([
      { info: { id: "m1", role: "assistant", time: { created: 100 } }, parts: [] },
    ] as never);
    expect(digest).toBe("");
  });
});

describe("expansion over the cache", () => {
  it("fetches expanded sessions on demand and degrades to a warning on failure", async () => {
    const h = makeFakeHarness();
    let failMessages = false;
    const original = h.client.session.messages.bind(h.client.session);
    // First (sync) loads succeed; the expansion re-fetch fails.
    (h.client.session as unknown as Record<string, unknown>).messages = async (params: {
      sessionID: string;
    }) => {
      if (failMessages) return { error: { data: { message: "expansion fetch down" } } };
      return original(params);
    };
    const { deps, cleanup } = await makeRecallDeps(h);
    const tool = search(h.client, h.unscoped, true, TEST_LIMITS, deps);
    try {
      // Warm the drill LRU, then break the message endpoint: the second query is
      // served warm (no fetch) while only the expansion re-fetch fails.
      const warm = await runTool<SearchOutput>(tool, { query: "walkthrough" });
      expect(warm.results.length).toBeGreaterThan(0);

      failMessages = true;
      const out = await runTool<SearchOutput>(tool, {
        query: "walkthrough",
        expand: "context",
      });
      expect(out.ok).toBe(true);
      expect(out.results.length).toBeGreaterThan(0);
      expect(out.expanded).toBeUndefined();
      expect(out.warnings?.some((w) => w.includes("Expansion could not load session"))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
