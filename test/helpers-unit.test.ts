import { describe, expect, it } from "vitest";
import { buildCandidates, type Candidate } from "../src/candidates.js";
import {
  format,
  formatMsg,
  pruned,
  searchable,
  snippet,
} from "../src/extract.js";
import { prefilter } from "../src/prefilter.js";
import { parseQuery } from "../src/query.js";
import { rank, rankDegraded } from "../src/rank.js";
import { smartSnippet } from "../src/snippet.js";
import { errmsg, optionalString } from "../src/types.js";
import { normalize, splitCamelCase, tokenize } from "../src/normalize.js";
import type { Part } from "@opencode-ai/sdk/v2";
import {
  PROJECT_DIR,
  assistantMessage,
  completedToolPart,
  errorToolPart,
  pendingToolPart,
  reasoningPart,
  runningToolPart,
  subtaskPart,
  textPart,
  userMessage,
} from "./helpers.js";

function candidate(
  overrides: Partial<Candidate> & { rawText: string },
): Candidate {
  const { rawText, ...rest } = overrides;
  return {
    sessionID: "s",
    sessionTitle: "Session",
    directory: PROJECT_DIR,
    messageID: "m",
    role: "assistant",
    time: Date.now() - 10 * 24 * 60 * 60 * 1000,
    partID: "p",
    partType: "text",
    isPruned: false,
    rawText,
    tokens: tokenize(rawText),
    ...rest,
  };
}

describe("string and error helpers", () => {
  it("normalizes optional strings and error messages", () => {
    expect(optionalString(undefined)).toBeUndefined();
    expect(optionalString("   ")).toBeUndefined();
    expect(optionalString(" value ")).toBe("value");

    expect(errmsg(new Error("boom"))).toBe("boom");
    expect(errmsg("plain")).toBe("plain");
    expect(errmsg({ data: { message: "from api" } })).toBe("from api");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(errmsg(circular)).not.toHaveLength(0);
  });

  it("tokenizes, normalizes, and parses queries for search", () => {
    expect(splitCamelCase("rateLimit getHTTPResponse XMLParser")).toBe(
      "rate Limit get HTTPResponse XMLParser",
    );
    expect(tokenize("rate-limit/rate_limit.foo rateLimit")).toEqual([
      "rate",
      "limit",
      "foo",
    ]);
    expect(normalize(" rate-limit\nrateLimit.foo ")).toBe(
      "rate limit rate limit foo",
    );

    expect(parseQuery('find "exact phrase" exact "" phrase')).toEqual({
      raw: 'find "exact phrase" exact "" phrase',
      lower: 'find "exact phrase" exact "" phrase',
      tokens: ["exact", "phrase", "find"],
      phrases: ["exact phrase"],
    });
  });
});

describe("extract helpers", () => {
  it("searches meaningful part content and excludes recall's own tool output", () => {
    const completed = completedToolPart(
      "p1",
      "s",
      "m",
      "bash",
      { command: "npm test" },
      "completed output",
      { title: "completed title" },
    );
    expect(searchable(completed)).toEqual([
      "completed output",
      "completed title",
      '{"command":"npm test"}',
    ]);

    const self = completedToolPart("p2", "s", "m", "recall", {}, "self output");
    expect(searchable(self)).toEqual([]);

    const errored = errorToolPart(
      "p3",
      "s",
      "m",
      "bash",
      { path: "src" },
      "failed",
    );
    expect(searchable(errored)).toEqual(["failed", '{"path":"src"}']);

    expect(
      searchable(runningToolPart("p4", "s", "m", { command: "run" })),
    ).toEqual(['{"command":"run"}']);
    expect(
      searchable(pendingToolPart("p5", "s", "m", { command: "wait" })),
    ).toEqual(['{"command":"wait"}']);
    expect(searchable(subtaskPart("p6", "s", "m", "desc", "prompt"))).toEqual([
      "desc",
      "prompt",
    ]);

    const long = "x".repeat(10_100);
    const truncated = completedToolPart(
      "p7",
      "s",
      "m",
      "bash",
      { long },
      "out",
    );
    expect(searchable(truncated)[2]?.length).toBe(10_000);
  });

  it("builds snippets and pruned flags at important boundaries", () => {
    expect(snippet("needle at start and more", "needle", 12)).toBe(
      "needle at st...",
    );
    expect(snippet("more text with needle", "needle", 12)).toBe(
      "... with needle",
    );
    expect(snippet("abcdef", "missing", 3)).toBe("abc...");

    const compacted = completedToolPart("p", "s", "m", "bash", {}, "out", {
      compacted: 1,
    });
    const notCompacted = completedToolPart("p2", "s", "m", "bash", {}, "out");
    expect(pruned(compacted)).toBe(true);
    expect(pruned(notCompacted)).toBe(false);
    expect(pruned(errorToolPart("p3", "s", "m", "bash", {}, "err"))).toBe(
      false,
    );
  });

  it("formats messages and non-search part types for retrieval", () => {
    const parts: Part[] = [
      {
        id: "c",
        sessionID: "s",
        messageID: "m",
        type: "compaction",
        auto: true,
      },
      {
        id: "f",
        sessionID: "s",
        messageID: "m",
        type: "file",
        mime: "text/plain",
        filename: "a.txt",
        url: "file://a",
      },
      {
        id: "s1",
        sessionID: "s",
        messageID: "m",
        type: "snapshot",
        snapshot: "snap",
      },
      {
        id: "p",
        sessionID: "s",
        messageID: "m",
        type: "patch",
        hash: "h",
        files: ["a.ts"],
      },
      {
        id: "a",
        sessionID: "s",
        messageID: "m",
        type: "agent",
        name: "worker",
      },
      {
        id: "r",
        sessionID: "s",
        messageID: "m",
        type: "retry",
        attempt: 2,
        error: { data: { message: "retry failed" } },
        time: { created: 1 },
      } as unknown as Part,
      { id: "ss", sessionID: "s", messageID: "m", type: "step-start" },
      {
        id: "sf",
        sessionID: "s",
        messageID: "m",
        type: "step-finish",
        reason: "done",
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
      {
        id: "u",
        sessionID: "s",
        messageID: "m",
        type: "unknown",
      } as unknown as Part,
    ];

    expect(parts.map(format).map((p) => p.content ?? p.error)).toEqual([
      "[compaction boundary (auto)]",
      "[file] a.txt",
      "[snapshot] snap",
      "[patch] a.ts",
      "[agent] worker",
      "[retry] attempt 2",
      "[step-start]",
      "[step-finish] done",
      "[unknown]",
    ]);

    const user = formatMsg({
      info: userMessage("u", "s", 123),
      parts: [textPart("t", "s", "u", "hello")],
    });
    const assistant = formatMsg({
      info: assistantMessage("a", "s", 456),
      parts: [reasoningPart("r", "s", "a", "thinking")],
    });
    expect(user.message).toMatchObject({
      role: "user",
      time: 123,
      model: "test-user-model",
    });
    expect(assistant.message).toMatchObject({
      role: "assistant",
      time: 456,
      model: "test-assistant-model",
    });
  });
});

describe("search ranking helpers", () => {
  it("prefilters exact, phrase, and typo matches", () => {
    const candidates = [
      candidate({ rawText: "rate limit cache" }),
      candidate({ rawText: "walkthrough guide" }),
      candidate({ rawText: "unrelated" }),
    ];

    expect(
      prefilter(candidates, parseQuery('"rate limit"')).map(
        (r) => r.candidate.rawText,
      ),
    ).toEqual(["rate limit cache"]);
    expect(
      prefilter(candidates, parseQuery("walthrough")).map(
        (r) => r.candidate.rawText,
      ),
    ).toEqual(["walkthrough guide"]);
  });

  it("ranks with explainable boosts, penalties, and time tie-breaks", () => {
    const query = parseQuery('"rate limit" cache missing');
    const hits = [
      {
        candidate: candidate({
          rawText: "rate limit cache error",
          role: "user",
          partType: "tool",
          toolName: "bash",
          time: 1_000,
        }),
        fuseScore: 0.1,
        normalizedScore: 0.9,
      },
      {
        candidate: candidate({ rawText: "rate", time: 2_000 }),
        fuseScore: 0.1,
        normalizedScore: 0.9,
      },
      {
        candidate: candidate({ rawText: "rat", time: 3_000 }),
        fuseScore: 0.4,
        normalizedScore: 0.6,
      },
      {
        candidate: candidate({
          rawText: "rate limit cache",
          partType: "reasoning",
          time: 4_000,
        }),
        fuseScore: 0.2,
        normalizedScore: 0.8,
      },
    ];

    const ranked = rank(hits, query, true);
    const errorResult = ranked.find(
      (r) => r.candidate.rawText === "rate limit cache error",
    );
    expect(errorResult?.matchReasons.join(" ")).toContain("Exact phrase match");
    expect(errorResult?.matchReasons.join(" ")).toContain("Error text boost");
    expect(errorResult?.matchReasons.join(" ")).toContain("User text boost");
    expect(
      ranked
        .find((r) => r.candidate.partType === "reasoning")
        ?.matchReasons.join(" "),
    ).toContain("Reasoning part boost");
    expect(
      ranked
        .find((r) => r.candidate.rawText === "rate")
        ?.matchReasons.join(" "),
    ).toContain("Poor query coverage");

    const weak = rank(
      [
        {
          candidate: candidate({ rawText: "rat" }),
          fuseScore: 0.4,
          normalizedScore: 0.6,
        },
      ],
      parseQuery("rate"),
      true,
    );
    expect(weak[0]?.matchReasons.join(" ")).toContain(
      "Weak single-token fuzzy",
    );

    const tied = rank(
      [
        {
          candidate: candidate({ rawText: "same", time: 10 }),
          fuseScore: 0.1,
          normalizedScore: 0.9,
        },
        {
          candidate: candidate({ rawText: "same", time: 20 }),
          fuseScore: 0.1,
          normalizedScore: 0.9,
        },
      ],
      parseQuery("same"),
      false,
    );
    expect(tied.map((r) => r.candidate.time)).toEqual([20, 10]);
  });

  it("ranks degraded results and builds smart snippets at boundaries", () => {
    const degraded = rankDegraded(
      [{ candidate: candidate({ rawText: "rate limit" }), prefilterScore: 30 }],
      parseQuery("rate"),
      true,
    );
    expect(degraded[0]?.matchReasons[0]).toContain("Degraded mode");

    expect(smartSnippet("", parseQuery("rate"), 10)).toBe("");
    expect(smartSnippet("abcdef", parseQuery("zzz"), 3)).toBe("abc...");
    expect(
      smartSnippet("aaa rate bbb limit ccc", parseQuery("rate limit"), 12),
    ).toContain("rate");
  });

  it("builds candidates with role/type/time filters", () => {
    const messages = [
      {
        info: userMessage("u", "s", 100),
        parts: [textPart("t1", "s", "u", "user text")],
      },
      {
        info: assistantMessage("a", "s", 200),
        parts: [completedToolPart("t2", "s", "a", "bash", {}, "tool text")],
      },
    ];

    const built = buildCandidates(
      messages,
      { id: "s", title: "Session", directory: PROJECT_DIR },
      {
        maxMessagesPerSession: 10,
        maxPartsPerSession: 10,
        maxCharsPerCandidate: 100,
        maxCharsTotal: 1000,
        maxCandidatesPerSession: 10,
        maxCandidatesTotal: 10,
      },
      "tool",
      "assistant",
      300,
      100,
    );

    expect(built.candidates).toHaveLength(1);
    expect(built.candidates[0]).toMatchObject({
      partType: "tool",
      role: "assistant",
      rawText: "tool text\n\nbash\n\n{}",
    });
  });
});
