import { describe, expect, it } from "vitest";
import { buildCandidates, populateNormalized, type Candidate } from "../src/candidates.js";
import { format, formatMsg, isSelfTool, pruned, searchable, snippet } from "../src/extract.js";
import { parseQuery } from "../src/query.js";
import { bm25Search } from "../src/bm25.js";
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

function candidate(overrides: Partial<Candidate> & { rawText: string }): Candidate {
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
    fieldTexts: [{ field: "text", text: rawText }],
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
    expect(tokenize("rate-limit/rate_limit.foo rateLimit")).toEqual(["rate", "limit", "foo"]);
    expect(normalize(" rate-limit\nrateLimit.foo ")).toBe("rate limit rate limit foo");

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
      "npm test",
      '{"command":"npm test"}',
    ]);

    const self = completedToolPart("p2", "s", "m", "recall", {}, "self output");
    expect(searchable(self)).toEqual([]);

    // Host-namespaced variants of our own tools are also excluded so recall
    // can never find prior recall output regardless of how the tool was named.
    for (const name of [
      "recall_messages",
      "mcp__opencode-session-recall__recall",
      "opencode-session-recall_recall",
      "mcp__srv__recall_context",
    ]) {
      const namespaced = completedToolPart("p2x", "s", "m", name, {}, "self output");
      expect(searchable(namespaced), name).toEqual([]);
    }

    // An unrelated tool that merely ends in "recall" is NOT excluded.
    const notSelf = completedToolPart("p2y", "s", "m", "myrecall", {}, "real output");
    expect(searchable(notSelf)).toContain("real output");

    const errored = errorToolPart("p3", "s", "m", "bash", { path: "src" }, "failed");
    expect(searchable(errored)).toEqual(["failed", '{"path":"src"}']);

    expect(searchable(runningToolPart("p4", "s", "m", { command: "run" }))).toEqual([
      "run",
      '{"command":"run"}',
    ]);
    expect(searchable(pendingToolPart("p5", "s", "m", { command: "wait" }))).toEqual([
      "wait",
      '{"command":"wait"}',
    ]);
    expect(searchable(subtaskPart("p6", "s", "m", "desc", "prompt"))).toEqual(["desc", "prompt"]);

    const long = "x".repeat(10_100);
    const truncated = completedToolPart("p7", "s", "m", "bash", { long }, "out");
    expect(searchable(truncated)[2]?.length).toBe(10_000);
  });

  it("identifies our own recall tools, including host-namespaced names", () => {
    // Bare registered names.
    for (const name of [
      "recall",
      "recall_get",
      "recall_sessions",
      "recall_context",
      "recall_messages",
    ]) {
      expect(isSelfTool(name), name).toBe(true);
    }
    // Namespaced by an MCP host or provider prefix.
    expect(isSelfTool("mcp__opencode-session-recall__recall")).toBe(true);
    expect(isSelfTool("opencode-session-recall_recall")).toBe(true);
    expect(isSelfTool("provider.recall_get")).toBe(true);
    expect(isSelfTool("mcp__srv__recall_context")).toBe(true);
    // Unrelated tools that merely contain or end in a recall-like substring.
    for (const name of ["myrecall", "recallx", "precall", "recall_other", "bash", "read"]) {
      expect(isSelfTool(name), name).toBe(false);
    }
  });

  it("builds snippets and pruned flags at important boundaries", () => {
    expect(snippet("needle at start and more", "needle", 12)).toBe("needle at st...");
    expect(snippet("more text with needle", "needle", 12)).toBe("... with needle");
    expect(snippet("abcdef", "missing", 3)).toBe("abc...");

    const compacted = completedToolPart("p", "s", "m", "bash", {}, "out", {
      compacted: 1,
    });
    const notCompacted = completedToolPart("p2", "s", "m", "bash", {}, "out");
    expect(pruned(compacted)).toBe(true);
    expect(pruned(notCompacted)).toBe(false);
    expect(pruned(errorToolPart("p3", "s", "m", "bash", {}, "err"))).toBe(false);
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

function indexed(overrides: Partial<Candidate> & { rawText: string }): Candidate {
  const c = candidate(overrides);
  populateNormalized(c);
  return c;
}

describe("search ranking helpers", () => {
  it("ranks BM25 matches with explainable structural boosts", () => {
    const query = parseQuery('"rate limit" cache missing');
    const candidates = [
      indexed({
        rawText: "rate limit cache error",
        role: "user",
        partType: "tool",
        toolName: "bash",
        time: 1_000,
      }),
      indexed({ rawText: "rate", time: 2_000 }),
      indexed({ rawText: "rate limit cache", partType: "reasoning", time: 4_000 }),
    ];

    const ranked = bm25Search(candidates, query, "smart", true);
    const errorResult = ranked.find((r) => r.candidate.rawText === "rate limit cache error");
    expect(errorResult?.matchReasons.join(" ")).toContain("Exact phrase");
    expect(errorResult?.matchReasons.join(" ")).toContain("Error text");
    expect(errorResult?.matchReasons.join(" ")).toContain("User text");
    expect(
      ranked.find((r) => r.candidate.partType === "reasoning")?.matchReasons.join(" "),
    ).toContain("Reasoning part");
    // Every returned score stays within 0..1.
    for (const r of ranked) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("rewards term rarity (IDF) over boilerplate", () => {
    const boilerplate = "error failed config session result tool output update value data";
    const candidates = [
      indexed({ rawText: `discriminative ${boilerplate}` }),
      indexed({ rawText: `${boilerplate} ${boilerplate}` }),
    ];
    const ranked = bm25Search(candidates, parseQuery("discriminative config"), "smart", false);
    expect(ranked[0]?.candidate.rawText).toContain("discriminative");
  });

  it("matches typos within edit distance via BM25 fuzzy", () => {
    const candidates = [
      indexed({ rawText: "prefilter pipeline" }),
      indexed({ rawText: "unrelated content" }),
    ];
    const ranked = bm25Search(candidates, parseQuery("prefiltr"), "fuzzy", false);
    expect(ranked[0]?.candidate.rawText).toContain("prefilter");
  });

  it("breaks score ties by recency (newest first)", () => {
    const candidates = [
      indexed({ rawText: "same token", time: 10 }),
      indexed({ rawText: "same token", time: 20 }),
    ];
    const ranked = bm25Search(candidates, parseQuery("same"), "smart", false);
    expect(ranked.map((r) => r.candidate.time)).toEqual([20, 10]);
  });

  it("returns nothing for a non-matching query", () => {
    const candidates = [indexed({ rawText: "rate limit cache" })];
    expect(bm25Search(candidates, parseQuery("zzzznomatch"), "smart", false)).toEqual([]);
  });

  it("does not over-report matchedTerms for a non-prefix substring", () => {
    // "cate" is a substring of "domicate" but not a prefix; BM25 prefix search
    // would not match it, so matchedTerms must not claim it did.
    const candidates = [indexed({ rawText: "domicate widget" })];
    const ranked = bm25Search(candidates, parseQuery("cate"), "smart", false);
    for (const r of ranked) {
      expect(r.matchedTerms).not.toContain("cate");
    }
  });

  it("does not index a title candidate's text into primaryText (no double-weight)", () => {
    const titleCand = indexed({ rawText: "rate limit", partType: "title" });
    expect(titleCand.primaryText).toBe("");
    expect(titleCand.titleText).toBeTruthy();
  });

  it("builds smart snippets at boundaries", () => {
    expect(smartSnippet("", parseQuery("rate"), 10)).toBe("");
    expect(smartSnippet("abcdef", parseQuery("zzz"), 3)).toBe("abc...");
    expect(smartSnippet("aaa rate bbb limit ccc", parseQuery("rate limit"), 12)).toContain("rate");
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
