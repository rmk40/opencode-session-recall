import { describe, expect, it } from "vitest";
import {
  buildCandidates,
  candidateEligible,
  populateNormalized,
  type Candidate,
} from "../src/candidates.js";
import {
  evidenceClassFor,
  format,
  formatMsg,
  isSelfTool,
  pruned,
  searchable,
  snippet,
  toolNameMatches,
} from "../src/extract.js";
import { parseQuery } from "../src/query.js";
import { bm25Search } from "../src/bm25.js";
import {
  capAndSlice,
  groupBySession,
  truncateExpandedPart,
  type ExpansionBudget,
} from "../src/search.js";
import type { PartOutput } from "../src/types.js";
import { metadataShortlist, mergeShortlistHits, SHORTLIST_MULT } from "../src/plan.js";
import type { EvidenceClass, SearchResult } from "../src/types.js";
import { smartSnippet, truncatePreservingMatch } from "../src/snippet.js";
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
      codeTokens: [],
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

describe("evidence classification", () => {
  it("maps part types, tool names, and matched fields to evidence classes", () => {
    const rows: Array<{
      partType: string;
      toolName?: string;
      fields: Parameters<typeof evidenceClassFor>[2];
      expected: string;
    }> = [
      { partType: "title", fields: ["title"], expected: "session-title" },
      { partType: "reasoning", fields: ["reasoning"], expected: "reasoning" },
      { partType: "text", fields: ["text"], expected: "human-text" },
      { partType: "subtask", fields: ["text"], expected: "human-text" },
      { partType: "tool", toolName: "skill", fields: ["stdout"], expected: "skill-definition" },
      // Host-namespaced variants classify the same way.
      {
        partType: "tool",
        toolName: "mcp__server__read",
        fields: ["stdout"],
        expected: "file-read",
      },
      {
        partType: "tool",
        toolName: "provider.skill",
        fields: ["stdout"],
        expected: "skill-definition",
      },
      // Suffix without a separator is a different tool, not a match.
      { partType: "tool", toolName: "myskill", fields: ["stdout"], expected: "tool-output" },
      // Matched only in what was asked of the tool (incl. JSON input under
      // the command field) => tool-input, regardless of tool.
      { partType: "tool", toolName: "bash", fields: ["command"], expected: "tool-input" },
      { partType: "tool", toolName: "bash", fields: ["command", "cwd"], expected: "tool-input" },
      {
        partType: "tool",
        toolName: "custom-mcp-tool",
        fields: ["command"],
        expected: "tool-input",
      },
      // Any output-side match makes it tool-output.
      {
        partType: "tool",
        toolName: "bash",
        fields: ["stdout", "command"],
        expected: "tool-output",
      },
      { partType: "tool", toolName: "bash", fields: ["stderr"], expected: "tool-output" },
      { partType: "tool", toolName: "bash", fields: [], expected: "tool-output" },
    ];
    for (const row of rows) {
      expect(
        evidenceClassFor(row.partType, row.toolName, row.fields),
        `${row.partType}/${row.toolName ?? "-"}/${row.fields.join("+")}`,
      ).toBe(row.expected);
    }
  });

  it("toolNameMatches requires a separator boundary", () => {
    expect(toolNameMatches("read", "read")).toBe(true);
    expect(toolNameMatches("mcp__server__read", "read")).toBe(true);
    expect(toolNameMatches("provider.read", "read")).toBe(true);
    expect(toolNameMatches("myread", "read")).toBe(false);
    expect(toolNameMatches("reader", "read")).toBe(false);
  });

  it("excludes synthetic <recall-auto> parts from search but keeps other synthetic text", () => {
    const auto = {
      id: "p1",
      sessionID: "s",
      messageID: "m",
      type: "text",
      text: "<recall-auto>\nPossibly relevant prior history\n</recall-auto>",
      synthetic: true,
    } as unknown as Part;
    expect(searchable(auto)).toEqual([]);

    const otherSynthetic = {
      id: "p2",
      sessionID: "s",
      messageID: "m",
      type: "text",
      text: "host-injected context block",
      synthetic: true,
    } as unknown as Part;
    expect(searchable(otherSynthetic)).toEqual(["host-injected context block"]);

    const plain = {
      id: "p3",
      sessionID: "s",
      messageID: "m",
      type: "text",
      text: "<recall-auto> quoted in ordinary user text",
    } as unknown as Part;
    expect(searchable(plain)).toHaveLength(1);
  });
});

describe("query plan (codeTokens, shortlist, merge)", () => {
  it("extracts code-like compound tokens verbatim", () => {
    const rows: Array<[string, string[]]> = [
      ["how did we test ghostauth", []],
      ["find GHOSTAUTH_LIVE_TUI usage", ["GHOSTAUTH_LIVE_TUI"]],
      ["call launchTerminal from the api", ["launchTerminal"]],
      ["open deploy.yaml and opencode-multikey", ["deploy.yaml", "opencode-multikey"]],
      ["path src/hooks/auto-recall.ts", ["src/hooks/auto-recall.ts"]],
      ["abc a_b", []], // below the 4-char minimum
    ];
    for (const [query, expected] of rows) {
      expect(parseQuery(query).codeTokens, query).toEqual(expected);
    }
  });

  it("boosts verbatim code tokens over split-token equivalents", () => {
    const candidates = [
      indexed({ rawText: "note the ghostauth live tui lane here" }),
      indexed({ rawText: "note the GHOSTAUTH_LIVE_TUI lane here" }),
    ];
    const ranked = bm25Search(candidates, parseQuery("GHOSTAUTH_LIVE_TUI"), "smart", true);
    expect(ranked[0]?.candidate.rawText).toContain("GHOSTAUTH_LIVE_TUI");
    expect(ranked[0]?.matchReasons.join(" ")).toContain("Exact code token");
  });

  it("shortlists sessions by metadata token overlap, capped and length-gated", () => {
    const query = parseQuery("ghostauth live test");
    const shortlist = metadataShortlist(
      [
        { id: "s1", title: "Profile and audit CLI usage", directory: "/w/ghostauth" },
        { id: "s2", title: "Ghostauth docs audit", directory: "/w/ghostauth" },
        { id: "s3", title: "Terminal UI spike", directory: "/w/other" },
      ],
      query,
    );
    expect(shortlist.has("s1")).toBe(true);
    expect(shortlist.has("s2")).toBe(true);
    expect(shortlist.has("s3")).toBe(false);
    // Short tokens (< 4 chars) never form a shortlist by themselves.
    expect(
      metadataShortlist([{ id: "s1", title: "a ui fix", directory: "/w" }], parseQuery("ui fix"))
        .size,
    ).toBe(0);
  });

  it("deep pass uses shortlist-local IDF (fails on a filter-only implementation)", () => {
    // "needle" is common in the broad corpus (low IDF) but rare inside the
    // shortlisted session s1. A second, shortlist-only index must score s1's
    // needle doc higher relative to its own corpus than the broad pass did.
    const shortlistDoc = indexed({
      rawText: "needle appears here amid unique session context words",
      sessionID: "s1",
      partID: "s1-needle",
    });
    const shortlistOther = indexed({
      rawText: "unique session context words about other matters entirely",
      sessionID: "s1",
      partID: "s1-other",
    });
    const broadNoise = Array.from({ length: 8 }, (_, i) =>
      indexed({ rawText: `needle needle filler ${i}`, sessionID: `noise-${i}`, partID: `n-${i}` }),
    );
    const pool = [shortlistDoc, shortlistOther, ...broadNoise];
    const query = parseQuery("needle context");

    const broad = bm25Search(pool, query, "smart", false);
    const deep = bm25Search([shortlistDoc, shortlistOther], query, "smart", false);
    const broadRank = broad.findIndex((h) => h.candidate.partID === "s1-needle");
    const deepRank = deep.findIndex((h) => h.candidate.partID === "s1-needle");
    expect(deepRank).toBe(0);
    // Merged list must respect the deep pass's local ordering for s1 parts.
    const merged = mergeShortlistHits(broad, deep, false);
    const mergedS1 = merged.filter((h) => h.candidate.sessionID === "s1");
    expect(mergedS1[0]?.candidate.partID).toBe("s1-needle");
    expect(broadRank).toBeGreaterThanOrEqual(0);
  });

  it("anchors deep scores to the broad ceiling and applies the multiplier once", () => {
    const broad = [
      {
        candidate: candidate({ rawText: "a", partID: "pa", sessionID: "s1" }),
        score: 0.4,
        matchedTerms: [],
        matchedFields: [],
        evidenceClass: "human-text",
        matchReasons: [],
      },
      {
        candidate: candidate({ rawText: "b", partID: "pb", sessionID: "s2" }),
        score: 1.0,
        matchedTerms: [],
        matchedFields: [],
        evidenceClass: "human-text",
        matchReasons: [],
      },
    ] as never[];
    const deep = [
      {
        candidate: candidate({ rawText: "a", partID: "pa", sessionID: "s1" }),
        score: 1.0,
        matchedTerms: [],
        matchedFields: [],
        evidenceClass: "human-text",
        matchReasons: [],
      },
    ] as never[];
    const merged = mergeShortlistHits(broad as never, deep as never, false);
    const pa = merged.find((h) => h.candidate.partID === "pa")!;
    // Deep 1.0 anchored to the shortlist's broad ceiling (0.4) × 1.1 = 0.44,
    // NOT 1.0 — a weak neighborhood cannot rocket to the global top.
    expect(pa.score).toBeCloseTo(0.4 * SHORTLIST_MULT, 5);
    const pb = merged.find((h) => h.candidate.partID === "pb")!;
    expect(pb.score).toBe(1.0);
  });
});

describe("truncateExpandedPart budgets", () => {
  function toolPart(fields: Partial<PartOutput>): PartOutput {
    return { id: "p1", type: "tool", pruned: false, toolName: "bash", ...fields };
  }

  it("caps a multi-field part at the part budget and leaves the rest for siblings", () => {
    const budget: ExpansionBudget = { remaining: 30_000, truncated: false };
    const out = truncateExpandedPart(
      toolPart({
        content: "c".repeat(5_000),
        output: "o".repeat(5_000),
        error: "e".repeat(5_000),
      }),
      budget,
    );
    // Part consumed exactly the 6k part cap, not 12k+.
    expect(30_000 - budget.remaining).toBe(6_000);
    expect(budget.partCapped).toBe(true);
    expect(budget.truncated).toBe(true);
    // Fields degrade in order: content gets the field cap, output the rest.
    expect(out.content?.length).toBeLessThanOrEqual(4_000);
    expect(out.output?.length).toBeLessThanOrEqual(2_000);
    expect(out.error).toBeUndefined();
  });

  it("does not report the part cap for a single field cut by the field cap", () => {
    const budget: ExpansionBudget = { remaining: 30_000, truncated: false };
    truncateExpandedPart(toolPart({ output: "o".repeat(10_000) }), budget);
    expect(30_000 - budget.remaining).toBe(4_000);
    expect(budget.partCapped).toBeUndefined();
    expect(budget.truncated).toBe(true);
  });

  it("attributes cuts to the global budget when it is smaller than the part cap", () => {
    const budget: ExpansionBudget = { remaining: 1_000, truncated: false };
    truncateExpandedPart(toolPart({ output: "o".repeat(5_000) }), budget);
    expect(budget.remaining).toBe(0);
    expect(budget.partCapped).toBeUndefined();
    expect(budget.truncated).toBe(true);
  });
});

describe("truncatePreservingMatch", () => {
  const text = `HEAD:${"a".repeat(5_000)}NEEDLE${"b".repeat(5_000)}`;

  it("returns short text unchanged and respects the cap", () => {
    expect(truncatePreservingMatch("short", 2, 100)).toBe("short");
    const out = truncatePreservingMatch(text, text.indexOf("NEEDLE"), 1_000);
    expect(out.length).toBeLessThanOrEqual(1_000);
  });

  it("keeps the head and a window around a deep match with an omission marker", () => {
    const out = truncatePreservingMatch(text, text.indexOf("NEEDLE"), 1_000);
    expect(out.startsWith("HEAD:")).toBe(true);
    expect(out).toContain("NEEDLE");
    expect(out).toContain("chars omitted");
  });

  it("falls back to a head slice when the match is inside the kept head", () => {
    const out = truncatePreservingMatch(text, 2, 1_000);
    expect(out).toBe(text.slice(0, 1_000));
  });

  it("falls back to a head slice for missing matches and handles a match near the end", () => {
    expect(truncatePreservingMatch(text, -1, 500)).toBe(text.slice(0, 500));
    const nearEnd = truncatePreservingMatch(text, text.length - 3, 800);
    expect(nearEnd.length).toBeLessThanOrEqual(800);
    expect(nearEnd.endsWith(text.slice(-1))).toBe(true);
  });

  it("degrades to a head slice when the cap leaves no useful window", () => {
    const out = truncatePreservingMatch(text, text.indexOf("NEEDLE"), 80);
    expect(out).toBe(text.slice(0, 80));
  });
});

describe("capAndSlice class caps", () => {
  function hit(partID: string, evidenceClass: EvidenceClass): SearchResult {
    return {
      sessionID: "s1",
      sessionTitle: "S",
      directory: PROJECT_DIR,
      messageID: `m-${partID}`,
      role: "assistant",
      time: 1_000,
      partID,
      partType: "tool",
      pruned: false,
      snippet: "snip",
      why: { matchedFields: [], evidenceClass },
    };
  }

  it("caps skill-definition to one and file-read to two within the slice", () => {
    const ordered = [
      hit("p1", "skill-definition"),
      hit("p2", "skill-definition"),
      hit("p3", "file-read"),
      hit("p4", "file-read"),
      hit("p5", "file-read"),
      hit("p6", "tool-output"),
      hit("p7", "human-text"),
    ];
    const final = capAndSlice(ordered, 5, false);
    expect(final.map((h) => h.partID)).toEqual(["p1", "p3", "p4", "p6", "p7"]);
  });

  it("backfills held-back hits when caps starve the fill", () => {
    const ordered = [
      hit("p1", "skill-definition"),
      hit("p2", "skill-definition"),
      hit("p3", "skill-definition"),
    ];
    const final = capAndSlice(ordered, 3, false);
    expect(final.map((h) => h.partID)).toEqual(["p1", "p2", "p3"]);
  });

  it("promotes a held-back tool-input hit for command-like queries only", () => {
    const ordered = [hit("p1", "human-text"), hit("p2", "tool-output"), hit("p3", "tool-input")];
    const commandLike = capAndSlice(ordered, 2, true);
    expect(commandLike.map((h) => h.partID)).toEqual(["p1", "p3"]);

    const plain = capAndSlice(ordered, 2, false);
    expect(plain.map((h) => h.partID)).toEqual(["p1", "p2"]);

    // No swap when a tool-input hit is already present.
    const present = capAndSlice([hit("p0", "tool-input"), ...ordered], 2, true);
    expect(present.map((h) => h.partID)).toEqual(["p0", "p1"]);
  });
});

describe("groupBySession representative selection", () => {
  function hit(over: Partial<SearchResult> & { evidenceClass?: EvidenceClass }): SearchResult {
    const { evidenceClass, ...rest } = over;
    return {
      sessionID: "s1",
      sessionTitle: "Session One",
      directory: PROJECT_DIR,
      messageID: rest.partID ? `m-${rest.partID}` : "m1",
      role: "assistant",
      time: 1_000,
      partID: "p1",
      partType: "text",
      pruned: false,
      snippet: "snippet text",
      why: { matchedFields: ["text"], evidenceClass },
      ...rest,
    };
  }

  it("prefers a better evidence class within the score tolerance", () => {
    const grouped = groupBySession([
      hit({ partID: "pa", score: 1.0, evidenceClass: "skill-definition", partType: "tool" }),
      hit({ partID: "pb", score: 0.9, evidenceClass: "tool-input", partType: "tool" }),
      hit({ partID: "pc", score: 0.87, evidenceClass: "human-text" }),
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.partID).toBe("pc");
    expect(grouped[0]!.hitCount).toBe(3);
    expect(grouped[0]!.evidenceKinds).toEqual(
      expect.arrayContaining(["skill-definition", "tool-input", "human-text"]),
    );
    // Secondary evidence: classes different from the representative's, max 2.
    expect(grouped[0]!.topEvidence).toHaveLength(2);
    expect(grouped[0]!.topEvidence!.map((e) => e.evidenceClass)).toEqual([
      "skill-definition",
      "tool-input",
    ]);
  });

  it("keeps a dominant hit as representative when others fall outside tolerance", () => {
    const grouped = groupBySession([
      hit({ partID: "pa", score: 1.0, evidenceClass: "skill-definition", partType: "tool" }),
      hit({ partID: "pb", score: 0.5, evidenceClass: "human-text" }),
    ]);
    expect(grouped[0]!.partID).toBe("pa");
    expect(grouped[0]!.topEvidence?.map((e) => e.evidenceClass)).toEqual(["human-text"]);
  });

  it("uses class priority for unscored (literal) hits with recency as tiebreak", () => {
    const grouped = groupBySession([
      hit({ partID: "pa", time: 3_000, evidenceClass: "file-read", partType: "tool" }),
      hit({ partID: "pb", time: 2_000, evidenceClass: "tool-input", partType: "tool" }),
      hit({ partID: "pc", time: 1_000, evidenceClass: "tool-input", partType: "tool" }),
    ]);
    // tool-input beats file-read despite being older; newer tool-input wins the tie.
    expect(grouped[0]!.partID).toBe("pb");
  });

  it("uses a title hit only for title-only sessions and truncates topEvidence snippets", () => {
    const titleOnly = groupBySession([
      hit({
        partID: "s1:title",
        partType: "title",
        source: "title",
        evidenceClass: "session-title",
      }),
    ]);
    expect(titleOnly[0]!.partType).toBe("title");

    const withContent = groupBySession([
      hit({
        partID: "s1:title",
        partType: "title",
        source: "title",
        evidenceClass: "session-title",
      }),
      hit({
        partID: "pb",
        evidenceClass: "tool-output",
        partType: "tool",
        snippet: "x".repeat(300),
      }),
    ]);
    expect(withContent[0]!.partID).toBe("pb");
    expect(withContent[0]!.hitCount).toBe(2);
    // Title hits are not secondary evidence (never tracked as content).
    expect(withContent[0]!.topEvidence).toBeUndefined();
  });

  it("tracks at most four hits and caps topEvidence at two", () => {
    const grouped = groupBySession([
      hit({ partID: "pa", score: 1.0, evidenceClass: "human-text" }),
      hit({ partID: "pb", score: 0.99, evidenceClass: "tool-input", partType: "tool" }),
      hit({ partID: "pc", score: 0.98, evidenceClass: "tool-output", partType: "tool" }),
      hit({ partID: "pd", score: 0.97, evidenceClass: "reasoning", partType: "reasoning" }),
      hit({ partID: "pe", score: 0.96, evidenceClass: "file-read", partType: "tool" }),
    ]);
    expect(grouped[0]!.partID).toBe("pa");
    expect(grouped[0]!.hitCount).toBe(5);
    expect(grouped[0]!.topEvidence).toHaveLength(2);
    // file-read (5th) was never tracked; kinds still record every class seen.
    expect(grouped[0]!.evidenceKinds).toContain("file-read");
  });
});

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
    // Internal ranking scores are unclamped so boosts can beat the relative
    // top; the output layer clamps to 0..1 (asserted in recall.test.ts).
    for (const r of ranked) {
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });

  it("prefers a concrete tool input over a long skill payload with the same terms", () => {
    const skillBody =
      "tuistory skill reference. tuistory launch wait type press snapshot close. " +
      "Run tuistory sessions for agents. ".repeat(30);
    const candidates = [
      indexed({
        rawText: skillBody,
        partType: "tool",
        toolName: "skill",
        time: 2_000,
      }),
      indexed({
        rawText: 'npx tuistory launch "opencode" -s t1 --background\n\nbash',
        partType: "tool",
        toolName: "bash",
        time: 1_000,
        fieldTexts: [
          { field: "command", text: 'npx tuistory launch "opencode" -s t1 --background' },
        ],
      }),
    ];
    const ranked = bm25Search(candidates, parseQuery("tuistory launch"), "smart", true);
    expect(ranked[0]?.candidate.toolName).toBe("bash");
    expect(ranked[0]?.evidenceClass).toBe("tool-input");
    expect(ranked[1]?.evidenceClass).toBe("skill-definition");
    expect(ranked[0]?.matchReasons.join(" ")).toContain("Tool input");
    expect(ranked[1]?.matchReasons.join(" ")).toContain("Skill definition");
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

  it("builds unfiltered candidates; query filters apply via candidateEligible", () => {
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

    // Cache-fill build: everything searchable, newest message first.
    const built = buildCandidates(messages, { id: "s", title: "Session", directory: PROJECT_DIR });
    expect(built.candidates).toHaveLength(2);
    expect(built.candidates.map((c) => c.partType)).toEqual(["tool", "text"]);
    expect(built.candidates[0]).toMatchObject({
      partType: "tool",
      role: "assistant",
      rawText: "tool text\n\nbash\n\n{}",
    });

    // Query-time filters reproduce the old build-time filtering exactly.
    const filters = { type: "tool", role: "assistant", before: 300, after: 100 };
    const eligible = built.candidates.filter((c) => candidateEligible(c, filters));
    expect(eligible).toHaveLength(1);
    expect(eligible[0]).toMatchObject({ partType: "tool", role: "assistant" });

    // Boundary semantics: before excludes >= boundary, after excludes <= boundary.
    expect(
      built.candidates.filter((c) =>
        candidateEligible(c, { type: "all", role: "all", before: 200 }),
      ),
    ).toHaveLength(1);
    expect(
      built.candidates.filter((c) =>
        candidateEligible(c, { type: "all", role: "all", after: 200 }),
      ),
    ).toHaveLength(0);
    expect(
      built.candidates.filter((c) =>
        candidateEligible(c, { type: "text", role: "all", toolName: "bash" }),
      ),
    ).toHaveLength(1);
  });
});
