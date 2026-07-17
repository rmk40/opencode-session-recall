import { describe, expect, it, vi } from "vitest";
import { search } from "../src/search.js";
import { CorpusCache } from "../src/corpus.js";
import type { SearchOutput, ErrorOutput } from "../src/types.js";
import {
  PROJECT_DIR,
  TEST_LIMITS,
  OTHER_DIR,
  assistantMessage,
  bundle,
  completedToolPart,
  globalSessionFrom,
  makeContext,
  makeFakeHarness,
  runTool,
  runToolRaw,
  session,
  textPart,
  userMessage,
} from "./helpers.js";

function recallTool(h = makeFakeHarness(), global = true, limits = TEST_LIMITS) {
  return search(h.client, h.unscoped, global, limits, new CorpusCache(h.client, limits));
}

function messageTime(
  h: ReturnType<typeof makeFakeHarness>,
  sessionID: string,
  messageID: string,
): number {
  const msg = h.messagesBySession[sessionID]?.find((m) => m.info.id === messageID);
  if (!msg) throw new Error(`missing fixture message ${sessionID}:${messageID}`);
  return msg.info.time.created;
}

describe("recall", () => {
  it("defaults to global literal search and returns valid JSON results", async () => {
    const h = makeFakeHarness();
    const out = await runTool<SearchOutput>(recallTool(h), {
      query: "walkthrough",
    });

    expect(h.calls.globalList).toEqual([{ search: undefined, limit: undefined }]);
    expect(h.calls.projectList).toEqual([]);
    expect(out.ok).toBe(true);
    expect(out.group).toBe("part");
    expect(out.results.map((r) => r.sessionID)).toEqual(["s-other", "s-other", "s-other"]);
    expect(out.results.some((r) => r.source === "title")).toBe(true);
    expect(out.truncated).toBe(false);
    expect(out.coverage).toMatchObject({
      sessionsDiscovered: 3,
      sessionsSearched: 2,
      sessionsSkipped: 1,
      totalSessionsKnown: false,
      skippedByReason: { excludedSession: 1 },
    });
    expect(out.coverage?.limitedBy).toContain("excludedSession");
  });

  it("routes project, current-session, and explicit-session searches correctly", async () => {
    const h = makeFakeHarness();
    const tool = recallTool(h);

    const project = await runTool<SearchOutput>(tool, {
      query: "walkthrough",
      scope: "project",
    });
    expect(project.results).toEqual([]);
    expect(h.calls.projectList).toHaveLength(1);

    const current = await runTool<SearchOutput>(tool, {
      query: "rate-limit",
      scope: "session",
    });
    expect(current.results.map((r) => r.sessionID)).toEqual(["s-current"]);

    const explicit = await runTool<SearchOutput>(tool, {
      query: "walkthrough",
      scope: "project",
      sessionID: "s-other",
    });
    expect(explicit.results.map((r) => r.sessionID)).toEqual(["s-other", "s-other", "s-other"]);
    expect(h.calls.get.some((c) => c.sessionID === "s-other")).toBe(true);
  });

  it("filters by part type, role, title, and timestamp windows", async () => {
    const h = makeFakeHarness();
    const tool = recallTool(h);
    const unauthorizedAt = messageTime(h, "s-current", "m-current-3");

    const toolOnly = await runTool<SearchOutput>(tool, {
      query: "unauthorized",
      scope: "project",
      type: "tool",
      role: "assistant",
      excludeCurrentSession: false,
    });
    expect(toolOnly.results).toHaveLength(1);
    expect(toolOnly.results[0]).toMatchObject({
      sessionID: "s-current",
      partType: "tool",
      toolName: "bash",
      pruned: true,
    });

    const before = await runTool<SearchOutput>(tool, {
      query: "unauthorized",
      scope: "project",
      before: unauthorizedAt,
      excludeCurrentSession: false,
    });
    expect(before.results).toEqual([]);

    const after = await runTool<SearchOutput>(tool, {
      query: "unauthorized",
      scope: "project",
      after: unauthorizedAt - 1,
      excludeCurrentSession: false,
    });
    expect(after.results).toHaveLength(1);

    const titled = await runTool<SearchOutput>(tool, {
      query: "walkthrough",
      title: "Actualyze",
    });
    expect(titled.coverage?.sessionsSearched).toBe(1);
    expect(h.calls.globalList.at(-1)).toEqual({
      search: "Actualyze",
      limit: undefined,
    });
  });

  it("filters by relative time windows", async () => {
    const h = makeFakeHarness();
    const tool = recallTool(h);

    const recent = await runTool<SearchOutput>(tool, {
      query: "walkthrough",
      since: "2h",
    });
    expect(recent.results.map((r) => r.sessionID)).toEqual(["s-other", "s-other", "s-other"]);

    const old = await runTool<SearchOutput>(tool, {
      query: "walkthrough",
      until: "2h",
    });
    expect(old.results).toEqual([]);

    const invalid = await runTool<SearchOutput>(tool, {
      query: "walkthrough",
      since: "30m",
    });
    expect(invalid.results.length).toBeGreaterThan(0);
    expect(invalid.warnings?.[0]).toContain('Ignored since:"30m"');

    const conflict = await runTool<SearchOutput>(tool, {
      query: "walkthrough",
      after: Date.now() - 5_000,
      since: "2h",
    });
    expect(conflict.warnings?.[0]).toContain("Used after as the lower time bound");

    const impossible = await runTool<ErrorOutput>(tool, {
      query: "walkthrough",
      since: "2h",
      until: "3h",
    });
    expect(impossible.error).toContain("Time filters produce an empty window");

    const zeroWidth = await runTool<ErrorOutput>(tool, {
      query: "walkthrough",
      since: "2h",
      until: "2h",
    });
    expect(zeroWidth.error).toContain("Time filters produce an empty window");
  });

  it("applies relative time filters to actual message ages", async () => {
    const now = Date.now();
    const h = makeFakeHarness();
    const old = session("s-old-relative", "Old Relative", PROJECT_DIR, now - 3 * 86_400_000);
    const recent = session("s-recent-relative", "Recent Relative", PROJECT_DIR, now - 3_600_000);

    h.sessions.push(old, recent);
    h.messagesBySession[old.id] = [
      bundle(userMessage("m-old-relative", old.id, now - 3 * 86_400_000), [
        textPart("p-old-relative", old.id, "m-old-relative", "relative-token old"),
      ]),
    ];
    h.messagesBySession[recent.id] = [
      bundle(userMessage("m-recent-relative", recent.id, now - 3_600_000), [
        textPart("p-recent-relative", recent.id, "m-recent-relative", "relative-token recent"),
      ]),
    ];

    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const since = await runTool<SearchOutput>(recallTool(h), {
        query: "relative-token",
        scope: "project",
        since: "1d",
      });
      expect(since.results.map((r) => r.sessionID)).toEqual(["s-recent-relative"]);

      const until = await runTool<SearchOutput>(recallTool(h), {
        query: "relative-token",
        scope: "project",
        until: "1d",
      });
      expect(until.results.map((r) => r.sessionID)).toEqual(["s-old-relative"]);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("supports clearer time filters and degenerate duration warnings", async () => {
    const now = Date.now();
    const h = makeFakeHarness();
    const old = session("s-old-window", "Old Window", PROJECT_DIR, now - 3 * 86_400_000);
    const recent = session("s-recent-window", "Recent Window", PROJECT_DIR, now - 3_600_000);

    h.sessions.push(old, recent);
    h.messagesBySession[old.id] = [
      bundle(userMessage("m-old-window", old.id, now - 3 * 86_400_000), [
        textPart("p-old-window", old.id, "m-old-window", "window-token old"),
      ]),
    ];
    h.messagesBySession[recent.id] = [
      bundle(userMessage("m-recent-window", recent.id, now - 3_600_000), [
        textPart("p-recent-window", recent.id, "m-recent-window", "window-token recent"),
      ]),
    ];

    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const last = await runTool<SearchOutput>(recallTool(h), {
        query: "window-token",
        scope: "project",
        last: "1d",
      });
      const since = await runTool<SearchOutput>(recallTool(h), {
        query: "window-token",
        scope: "project",
        since: "1d",
      });
      expect(last.results.map((r) => r.sessionID)).toEqual(["s-recent-window"]);
      expect(since.results.map((r) => r.sessionID)).toEqual(last.results.map((r) => r.sessionID));
      expect(since.coverage?.messagesSearched).toBe(last.coverage?.messagesSearched);

      const fromTo = await runTool<SearchOutput>(recallTool(h), {
        query: "window-token",
        scope: "project",
        from: "2d ago",
        to: "now",
      });
      expect(fromTo.results.map((r) => r.sessionID)).toEqual(["s-recent-window"]);

      const beforeDate = await runTool<SearchOutput>(recallTool(h), {
        query: "window-token",
        scope: "project",
        before: new Date(now - 86_400_000).toISOString(),
      });
      expect(beforeDate.results.map((r) => r.sessionID)).toEqual(["s-old-window"]);

      const untilNow = await runTool<SearchOutput>(recallTool(h), {
        query: "window-token",
        scope: "project",
        until: "0d",
      });
      expect(untilNow.results.map((r) => r.sessionID)).toEqual(["s-old-window", "s-recent-window"]);
      expect(untilNow.warnings?.[0]).toContain('Normalized until:"0d"');

      const ignoredLast = await runTool<SearchOutput>(recallTool(h), {
        query: "window-token",
        scope: "project",
        last: "0d",
      });
      expect(ignoredLast.results.map((r) => r.sessionID)).toEqual([
        "s-old-window",
        "s-recent-window",
      ]);
      expect(ignoredLast.warnings?.[0]).toContain('Ignored last:"0d"');

      const upperConflict = await runTool<SearchOutput>(recallTool(h), {
        query: "window-token",
        scope: "project",
        before: now - 86_400_000,
        until: "2d",
      });
      expect(upperConflict.results.map((r) => r.sessionID)).toEqual(["s-old-window"]);
      expect(upperConflict.warnings?.[0]).toContain("Used until as the upper time bound");

      // Multiple lower bounds: newest (most restrictive) wins, others warned about.
      const lowerConflict = await runTool<SearchOutput>(recallTool(h), {
        query: "window-token",
        scope: "project",
        last: "1d",
        from: "5d ago",
      });
      expect(lowerConflict.results.map((r) => r.sessionID)).toEqual(["s-recent-window"]);
      expect(lowerConflict.warnings?.some((w) => /Used last as the lower time bound/.test(w))).toBe(
        true,
      );

      // Impossible windows produce a hard error with bounds and an example.
      const impossible = await runTool<ErrorOutput>(recallTool(h), {
        query: "window-token",
        scope: "project",
        after: now - 86_400_000,
        before: now - 5 * 86_400_000,
      });
      expect(impossible.ok).toBe(false);
      expect(impossible.error).toContain("Time filters produce an empty window");
      expect(impossible.error).toContain('last:"7d"');

      // Malformed date strings on before/after are ignored with a warning, not a hard error.
      const malformedDate = await runToolRaw<SearchOutput>(recallTool(h), {
        query: "window-token",
        scope: "project",
        after: "not-a-date",
      });
      expect(malformedDate.ok).toBe(true);
      expect(malformedDate.warnings?.some((w) => w.includes('Ignored after:"not-a-date"'))).toBe(
        true,
      );

      // Relative durations on absolute-only fields (before/after) are rejected with a warning.
      const relativeOnAfter = await runToolRaw<SearchOutput>(recallTool(h), {
        query: "window-token",
        scope: "project",
        after: "7d",
      });
      expect(relativeOnAfter.ok).toBe(true);
      expect(relativeOnAfter.warnings?.some((w) => w.includes('Ignored after:"7d"'))).toBe(true);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("returns title-only hits from recall without recall_sessions", async () => {
    const h = makeFakeHarness();
    const titled = session("s-title-only", "Minecraft Server Notes", PROJECT_DIR, Date.now());
    h.sessions.push(titled);
    h.messagesBySession[titled.id] = [
      bundle(userMessage("m-title-only", titled.id, Date.now()), [
        textPart("p-title-only", titled.id, "m-title-only", "unrelated body"),
      ]),
    ];

    const out = await runTool<SearchOutput>(recallTool(h), {
      query: "minecraft",
      scope: "project",
    });

    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      sessionID: "s-title-only",
      source: "title",
      partType: "title",
      titleMatch: { title: "Minecraft Server Notes" },
      why: { matchedFields: ["title"], confidence: "medium" },
    });
    expect(out.suggestions?.[0]?.reason).toContain("Only session-title hits");
  });

  it("preserves title-hit directory relevance and expands the first expandable result", async () => {
    const h = makeFakeHarness();
    const titleOnly = session("s-title-expand", "Minecraft Server Notes", PROJECT_DIR, Date.now());
    const content = session("s-content-expand", "Content Session", PROJECT_DIR, Date.now());
    h.sessions.push(titleOnly, content);
    h.globalSessions.push(globalSessionFrom(titleOnly), globalSessionFrom(content));
    h.messagesBySession[titleOnly.id] = [
      bundle(userMessage("m-title-expand", titleOnly.id, Date.now()), [
        textPart("p-title-expand", titleOnly.id, "m-title-expand", "unrelated body"),
      ]),
    ];
    h.messagesBySession[content.id] = [
      bundle(userMessage("m-content-expand", content.id, Date.now()), [
        textPart("p-content-expand", content.id, "m-content-expand", "minecraft body"),
      ]),
    ];

    const literal = await runTool<SearchOutput>(recallTool(h), {
      query: "minecraft",
      scope: "project",
      expand: "message",
      expandResults: 1,
    });
    expect(literal.results.map((result) => result.source)).toEqual(["title", "message"]);
    expect(literal.expanded?.[0]).toMatchObject({
      resultIndex: 1,
      messageID: "m-content-expand",
    });

    const smart = await runTool<SearchOutput>(recallTool(h), {
      query: "minecraft",
      match: "smart",
      directory: PROJECT_DIR,
      fallback: true,
    });
    expect(smart.results.find((result) => result.source === "title")?.why?.directoryRelevance).toBe(
      "exact",
    );
  });

  it("filters sessions by exact or descendant directory", async () => {
    const h = makeFakeHarness();
    const archive = session(
      "s-projectish",
      "Project Archive",
      `${PROJECT_DIR}-archive`,
      Date.now(),
    );
    const nested = session("s-nested", "Nested Project", `${PROJECT_DIR}/nested`, Date.now());

    h.globalSessions.push(globalSessionFrom(archive), globalSessionFrom(nested));
    h.messagesBySession[archive.id] = [
      bundle(userMessage("m-archive-1", archive.id, Date.now()), [
        textPart("p-archive-1", archive.id, "m-archive-1", "rate archive false positive"),
      ]),
    ];
    h.messagesBySession[nested.id] = [
      bundle(userMessage("m-nested-1", nested.id, Date.now()), [
        textPart("p-nested-1", nested.id, "m-nested-1", "rate nested descendant"),
      ]),
    ];

    const out = await runTool<SearchOutput>(recallTool(h), {
      query: "rate",
      directory: PROJECT_DIR,
      results: 10,
      excludeCurrentSession: false,
    });

    expect(out.results.some((r) => r.sessionID === "s-current")).toBe(true);
    expect(out.results.some((r) => r.sessionID === "s-nested")).toBe(true);
    expect(out.results.some((r) => r.sessionID === "s-projectish")).toBe(false);

    const other = await runTool<SearchOutput>(recallTool(h), {
      query: "walkthrough",
      directory: OTHER_DIR,
    });
    expect(other.results.map((r) => r.sessionID)).toEqual(["s-other", "s-other", "s-other"]);
    expect(other.coverage?.directoryBucketsSearched).toEqual(["exact"]);

    const fallback = await runTool<SearchOutput>(recallTool(h), {
      query: "walkthrough",
      directory: PROJECT_DIR,
      fallback: true,
    });
    expect(fallback.results.some((r) => r.sessionID === "s-other")).toBe(true);
    expect(fallback.results.find((r) => r.sessionID === "s-other")?.why?.directoryRelevance).toBe(
      "global",
    );
    expect(fallback.warnings).toContain(
      "Directory fallback broadened the search beyond exact matches.",
    );
    expect(fallback.coverage?.directoryBucketsSearched).toEqual(
      expect.arrayContaining(["exact", "global"]),
    );
    expect(fallback.coverage?.directoryBucketCounts?.global).toBeGreaterThan(0);

    const capped = await runTool<SearchOutput>(recallTool(h), {
      query: "rate",
      directory: PROJECT_DIR,
      sessions: 1,
      excludeCurrentSession: false,
    });
    expect(capped.coverage).toMatchObject({
      sessionsEligible: 3,
      sessionsSearched: 1,
      sessionsSkipped: 4,
      skippedByReason: { directory: 2, sessionsLimit: 2 },
    });
    expect(capped.results[0]?.sessionID).toBe("s-current");
    expect(capped.results.every((result) => result.sessionID === "s-current")).toBe(true);
    expect(h.calls.globalList.at(-1)?.limit).toBeGreaterThan(1);

    const globalCallsBeforeSessionFallback = h.calls.globalList.length;
    const sessionFallback = await runTool<SearchOutput>(recallTool(h), {
      query: "walkthrough",
      scope: "session",
      directory: PROJECT_DIR,
      fallback: true,
    });
    expect(sessionFallback.results).toEqual([]);
    expect(h.calls.globalList).toHaveLength(globalCallsBeforeSessionFallback);
  });

  it("filters tool parts by exact tool name", async () => {
    const h = makeFakeHarness();
    const tool = recallTool(h);

    const bash = await runTool<SearchOutput>(tool, {
      query: "unauthorized",
      scope: "project",
      toolName: "bash",
      excludeCurrentSession: false,
    });
    expect(bash.results).toHaveLength(1);
    expect(bash.results[0]).toMatchObject({ partType: "tool", toolName: "bash" });

    const noMatch = await runTool<SearchOutput>(tool, {
      query: "unauthorized",
      scope: "project",
      toolName: "playwright",
    });
    expect(noMatch.results).toEqual([]);

    const invalid = await runTool<ErrorOutput>(tool, {
      query: "unauthorized",
      scope: "project",
      type: "text",
      toolName: "bash",
    });
    expect(invalid.error).toContain("toolName can only be used");
  });

  it("applies toolName filtering to smart-ranked searches", async () => {
    const h = makeFakeHarness();
    const out = await runTool<SearchOutput>(recallTool(h), {
      query: "checkout cache",
      scope: "project",
      match: "smart",
      toolName: "bash",
      results: 10,
    });

    expect(out.results.map((r) => `${r.partType}:${r.toolName ?? ""}`)).toEqual(["tool:bash"]);
  });

  it("reports matched tool fields for smart-ranked tool hits", async () => {
    const h = makeFakeHarness();
    const out = await runTool<SearchOutput>(recallTool(h), {
      query: "permission",
      scope: "project",
      match: "smart",
      toolName: "bash",
    });

    expect(out.results[0]).toMatchObject({
      partType: "tool",
      why: { matchedFields: ["stderr"] },
    });
  });

  it("treats zero, negative, and blank optional filters as omitted", async () => {
    const h = makeFakeHarness();
    const tool = recallTool(h);

    const baseline = await runTool<SearchOutput>(tool, {
      query: "rate",
      scope: "project",
    });
    const zero = await runTool<SearchOutput>(tool, {
      query: "rate",
      scope: "project",
      before: 0,
      after: 0,
      sessionID: "   ",
      title: "   ",
    });
    const negative = await runTool<SearchOutput>(tool, {
      query: "rate",
      scope: "project",
      before: -1,
      after: -1,
    });

    expect(zero.results.map((r) => r.messageID)).toEqual(baseline.results.map((r) => r.messageID));
    expect(negative.results.map((r) => r.messageID)).toEqual(
      baseline.results.map((r) => r.messageID),
    );
    expect(h.calls.projectList).toContainEqual({
      search: undefined,
      limit: undefined,
    });
  });

  it("supports case-insensitive and punctuation-containing literal queries", async () => {
    const h = makeFakeHarness();
    const tool = recallTool(h);

    const mixedCase = await runTool<SearchOutput>(tool, {
      query: "CHECKOUT",
      scope: "project",
      results: 10,
      excludeCurrentSession: false,
    });
    const punctuation = await runTool<SearchOutput>(tool, {
      query: "C++",
      scope: "project",
      excludeCurrentSession: false,
    });

    expect(mixedCase.results.length).toBeGreaterThan(1);
    expect(punctuation.results).toHaveLength(1);
    expect(punctuation.results[0]?.messageID).toBe("m-current-1");
  });

  it("groups by session with hit counts and reports truncation", async () => {
    const h = makeFakeHarness();
    const tool = recallTool(h);

    const ungrouped = await runTool<SearchOutput>(tool, {
      query: "rate",
      scope: "project",
      results: 1,
      excludeCurrentSession: false,
    });
    expect(ungrouped.results).toHaveLength(1);
    expect(ungrouped.truncated).toBe(true);

    const grouped = await runTool<SearchOutput>(tool, {
      query: "rate",
      scope: "project",
      group: "session",
      results: 1,
      excludeCurrentSession: false,
    });
    expect(grouped.results).toHaveLength(1);
    expect(grouped.total).toBe(2);
    expect(grouped.truncated).toBe(true);
    expect(grouped.results[0]).toMatchObject({
      sessionID: "s-current",
      hitCount: 3,
    });
  });

  it("omits expansions by default and expands full messages when requested", async () => {
    const h = makeFakeHarness();
    const tool = recallTool(h);

    const baseline = await runTool<SearchOutput>(tool, {
      query: "unauthorized",
      scope: "project",
      excludeCurrentSession: false,
    });
    expect(baseline.expanded).toBeUndefined();

    const expanded = await runTool<SearchOutput>(tool, {
      query: "unauthorized",
      scope: "project",
      expand: "message",
      excludeCurrentSession: false,
    });
    expect(expanded.expanded).toHaveLength(1);
    expect(expanded.expanded?.[0]).toMatchObject({
      resultIndex: 0,
      sessionID: "s-current",
      messageID: "m-current-3",
      mode: "message",
      message: {
        message: { id: "m-current-3" },
        parts: [{ type: "tool", toolName: "bash" }],
      },
    });
  });

  it("redacts self-recall tool output inside expansion context", async () => {
    const h = makeFakeHarness();
    const tool = recallTool(h);

    // s-current contains a `recall` tool part (m-current-4). Expand a wide
    // context window around a hit so that part is included, and confirm its
    // output is redacted rather than leaked back through recall.
    const out = await runTool<SearchOutput>(tool, {
      query: "rate-limit middleware",
      scope: "session",
      sessionID: "s-current",
      expand: "context",
      window: 10,
    });

    const expandedMessages = out.expanded?.flatMap((e) => e.messages ?? []) ?? [];
    const selfParts = expandedMessages
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "tool" && p.toolName === "recall");
    // The recall part is present (structure preserved) but its body is redacted.
    expect(selfParts.length).toBeGreaterThan(0);
    for (const p of selfParts) {
      expect(p.output).toBeUndefined();
      expect(p.content).toBe("[recall output omitted]");
    }
    // The known self-output string must not appear anywhere in the expansion.
    const serialized = JSON.stringify(out.expanded);
    expect(serialized).not.toContain("unique-self-recall-result");
  });

  it("truncates large expanded text fields with an explicit marker", async () => {
    const h = makeFakeHarness();
    const current = h.sessions.find((s) => s.id === "s-current");
    if (!current) throw new Error("missing current session fixture");

    h.messagesBySession[current.id]?.push(
      bundle(assistantMessage("m-large-expand", current.id, Date.now()), [
        completedToolPart(
          "p-large-expand",
          current.id,
          "m-large-expand",
          "bash",
          { command: "npm test" },
          `large-expand-token ${"x".repeat(50_000)}`,
        ),
      ]),
    );

    const out = await runTool<SearchOutput>(recallTool(h), {
      query: "large-expand-token",
      scope: "project",
      expand: "message",
      excludeCurrentSession: false,
    });

    const output = out.expanded?.[0]?.message?.parts[0]?.output;
    expect(output).toContain("[truncated by recall expansion]");
    expect(output?.length).toBeLessThan(5_000);
    expect(out.warnings?.some((warning) => warning.includes("Expanded text budget capped"))).toBe(
      true,
    );
  });

  it("enforces a shared expanded text budget across message parts", async () => {
    const h = makeFakeHarness();
    const current = h.sessions.find((s) => s.id === "s-current");
    if (!current) throw new Error("missing current session fixture");

    h.messagesBySession[current.id]?.push(
      bundle(
        assistantMessage("m-budget-expand", current.id, Date.now()),
        Array.from({ length: 10 }, (_, index) =>
          completedToolPart(
            `p-budget-expand-${index}`,
            current.id,
            "m-budget-expand",
            "bash",
            { command: `command ${index}` },
            `budget-expand-token ${index} ${"x".repeat(5_000)}`,
          ),
        ),
      ),
    );

    const out = await runTool<SearchOutput>(recallTool(h), {
      query: "budget-expand-token",
      scope: "project",
      expand: "message",
    });
    const outputs =
      out.expanded?.[0]?.message?.parts
        .map((part) => part.output)
        .filter((output): output is string => typeof output === "string") ?? [];

    expect(outputs.join("").length).toBeLessThanOrEqual(30_000);
    expect(outputs.length).toBeLessThan(10);
    expect(outputs.join("")).not.toContain("budget exhausted");
  });

  it("expands bounded context windows with boundary flags", async () => {
    const h = makeFakeHarness();
    const out = await runTool<SearchOutput>(recallTool(h), {
      query: "unauthorized",
      scope: "project",
      expand: "context",
      window: 1,
      excludeCurrentSession: false,
    });

    expect(out.expanded).toHaveLength(1);
    expect(out.expanded?.[0]).toMatchObject({
      resultIndex: 0,
      sessionID: "s-current",
      messageID: "m-current-3",
      mode: "context",
      hasMoreBefore: true,
      hasMoreAfter: true,
    });
    expect(out.expanded?.[0]?.messages?.map((m) => m.message.id)).toEqual([
      "m-current-2",
      "m-current-3",
      "m-current-4",
    ]);
    expect(out.expanded?.[0]?.messages?.find((m) => m.center)?.message.id).toBe("m-current-3");
  });

  it("supports zero-width context expansion around only the matching message", async () => {
    const h = makeFakeHarness();
    const out = await runTool<SearchOutput>(recallTool(h), {
      query: "unauthorized",
      scope: "project",
      expand: "context",
      window: 0,
      excludeCurrentSession: false,
    });

    expect(out.expanded?.[0]?.messages?.map((m) => [m.message.id, m.center])).toEqual([
      ["m-current-3", true],
    ]);
  });

  it("auto-fits context expansion under the message budget", async () => {
    const h = makeFakeHarness();
    const out = await runTool<SearchOutput>(recallTool(h), {
      query: "unauthorized",
      scope: "project",
      expand: "context",
      window: "auto",
      expandBudgetMessages: 1,
      excludeCurrentSession: false,
    });

    expect(out.expanded?.[0]?.messages?.map((m) => [m.message.id, m.center])).toEqual([
      ["m-current-3", true],
    ]);
  });

  it("clamps oversized expansion parameters with warnings instead of failing", async () => {
    const out = await runToolRaw<SearchOutput>(recallTool(makeFakeHarness()), {
      query: "unauthorized",
      scope: "project",
      expand: "context",
      window: 9999,
      expandResults: 99,
      expandBudgetMessages: 9_999_999,
      expandBudgetChars: 9_999_999,
    });

    expect(out.ok).toBe(true);
    const warnings = out.warnings ?? [];
    expect(warnings.some((w) => w.includes("Clamped expandResults"))).toBe(true);
    expect(warnings.some((w) => w.includes("Clamped window"))).toBe(true);
    expect(warnings.some((w) => w.includes("Clamped expandBudgetMessages"))).toBe(true);
    expect(warnings.some((w) => w.includes("Clamped expandBudgetChars"))).toBe(true);
  });

  it("ignores non-numeric raw budget inputs with a clear warning", async () => {
    const out = await runToolRaw<SearchOutput>(recallTool(makeFakeHarness()), {
      query: "rate",
      scope: "project",
      expandBudgetMessages: "lots",
      expandBudgetChars: Number.NaN,
      width: Number.POSITIVE_INFINITY,
    });

    expect(out.ok).toBe(true);
    const warnings = out.warnings ?? [];
    expect(warnings.some((w) => w.includes('Ignored expandBudgetMessages:"lots"'))).toBe(true);
    expect(warnings.some((w) => w.includes("Ignored expandBudgetChars:NaN"))).toBe(true);
    expect(warnings.some((w) => w.includes("Ignored width:Infinity"))).toBe(true);
  });

  it("clamps below-min and invalid out-of-range numeric inputs with warnings", async () => {
    const out = await runToolRaw<SearchOutput>(recallTool(makeFakeHarness()), {
      query: "rate",
      scope: "project",
      results: 0,
      width: 5,
      window: -3,
      expandResults: -1,
    });

    expect(out.ok).toBe(true);
    expect(out.results.length).toBeGreaterThan(0);
    const warnings = out.warnings ?? [];
    expect(warnings.some((w) => w.includes("Clamped results"))).toBe(true);
    expect(warnings.some((w) => w.includes("Clamped width"))).toBe(true);
    expect(warnings.some((w) => w.includes("Clamped window"))).toBe(true);
    expect(warnings.some((w) => w.includes("Clamped expandResults"))).toBe(true);
  });

  it("falls back to safe defaults for unknown enum values", async () => {
    // First batch of enums (capped at 5 warnings to keep response compact).
    const out = await runToolRaw<SearchOutput>(recallTool(makeFakeHarness()), {
      query: "walkthrough",
      scope: "garbage",
      match: "elsewhere",
      type: "fake",
      role: "system",
      group: "weird",
    });

    expect(out.ok).toBe(true);
    const warnings = out.warnings ?? [];
    expect(warnings.some((w) => w.includes('Ignored scope:"garbage"'))).toBe(true);
    expect(warnings.some((w) => w.includes('Ignored match:"elsewhere"'))).toBe(true);
    expect(warnings.some((w) => w.includes('Ignored type:"fake"'))).toBe(true);
    expect(warnings.some((w) => w.includes('Ignored role:"system"'))).toBe(true);
    expect(warnings.some((w) => w.includes('Ignored group:"weird"'))).toBe(true);
    // Safe global default ran and returned content matches.
    expect(out.results.length).toBeGreaterThan(0);

    // Independently verify expand: garbage falls back to "none".
    const expandOut = await runToolRaw<SearchOutput>(recallTool(makeFakeHarness()), {
      query: "walkthrough",
      expand: "huge",
    });
    expect(expandOut.warnings?.some((w) => w.includes('Ignored expand:"huge"'))).toBe(true);
    expect(expandOut.expanded).toBeUndefined();
  });

  it("caps expansion count and returns partial results for oversized context expansion", async () => {
    const h = makeFakeHarness();
    const expanded = await runTool<SearchOutput>(recallTool(h), {
      query: "rate",
      scope: "project",
      results: 10,
      expand: "message",
      expandResults: 2,
      excludeCurrentSession: false,
    });
    expect(expanded.results.length).toBeGreaterThan(2);
    expect(expanded.expanded).toHaveLength(2);
    expect(expanded.expanded?.map((entry) => entry.resultIndex)).toEqual([0, 1]);

    const tooLarge = await runTool<SearchOutput>(recallTool(h), {
      query: "rate",
      scope: "project",
      expand: "context",
      expandResults: 3,
      window: 5,
      expandBudgetMessages: 2,
      excludeCurrentSession: false,
    });
    expect(tooLarge.results.length).toBeGreaterThan(0);
    expect(tooLarge.expanded?.length).toBeGreaterThan(0);
    expect(tooLarge.warnings?.some((warning) => warning.includes("Context expansion capped"))).toBe(
      true,
    );
  });

  it("expands grouped representatives", async () => {
    const h = makeFakeHarness();
    const out = await runTool<SearchOutput>(recallTool(h), {
      query: "rate",
      scope: "project",
      group: "session",
      results: 2,
      expand: "message",
      expandResults: 2,
      excludeCurrentSession: false,
    });

    expect(out.results).toHaveLength(2);
    expect(out.expanded).toHaveLength(2);
    expect(out.expanded?.map((entry) => entry.messageID)).toEqual(
      out.results.map((result) => result.messageID),
    );
  });

  it("returns smart and fuzzy ranked metadata without pinning score constants", async () => {
    const h = makeFakeHarness();
    const tool = recallTool(h);

    const smart = await runTool<SearchOutput>(tool, {
      query: "rate limit cache",
      scope: "project",
      match: "smart",
      explain: true,
    });
    expect(smart.matchMode).toBe("smart");
    expect(smart.results[0]?.score).toBeGreaterThanOrEqual(0);
    expect(smart.results[0]?.score).toBeLessThanOrEqual(1);
    expect(smart.results[0]?.matchedTerms).toEqual(
      expect.arrayContaining(["rate", "limit", "cache"]),
    );
    expect(smart.results[0]?.matchReasons?.length).toBeGreaterThan(0);

    const fuzzy = await runTool<SearchOutput>(tool, {
      query: "walkthroug",
      match: "fuzzy",
    });
    expect(fuzzy.matchMode).toBe("fuzzy");
    expect(fuzzy.results.some((r) => r.sessionID === "s-other")).toBe(true);
  });

  it("ranks the whole eligible corpus with no scan-order candidate truncation", async () => {
    // Regression for the old maxCandidatesTotal=3000 cap: a rare term planted
    // in the LAST session of provider list order, beyond where the old cap
    // truncated, must still be found. Impossible under the old architecture.
    const h = makeFakeHarness();
    const now = Date.now();
    for (let sIndex = 0; sIndex < 4; sIndex++) {
      const filler = session(`s-fill-${sIndex}`, `Filler ${sIndex}`, PROJECT_DIR, now - sIndex);
      h.sessions.push(filler);
      h.globalSessions.push(globalSessionFrom(filler));
      h.messagesBySession[filler.id] = Array.from({ length: 40 }, (_, mIndex) => {
        const messageID = `m-fill-${sIndex}-${mIndex}`;
        return bundle(assistantMessage(messageID, filler.id, now - mIndex), [
          ...Array.from({ length: 20 }, (_, pIndex) =>
            textPart(`p-fill-${sIndex}-${mIndex}-${pIndex}`, filler.id, messageID, "filler noise"),
          ),
        ]);
      });
    }
    const rare = session("s-rare", "Rare Needle", PROJECT_DIR, now - 100);
    h.sessions.push(rare);
    h.globalSessions.push(globalSessionFrom(rare));
    h.messagesBySession[rare.id] = [
      bundle(userMessage("m-rare", rare.id, now - 100), [
        textPart("p-rare", rare.id, "m-rare", "xylozene reactor calibration decision"),
      ]),
    ];

    const out = await runTool<SearchOutput>(recallTool(h), {
      query: "xylozene calibration",
      scope: "project",
      match: "smart",
      excludeCurrentSession: false,
    });
    expect(out.results.some((r) => r.sessionID === "s-rare")).toBe(true);
  });

  it("reports time degradation deterministically", async () => {
    // smartScan calls performance.now() at start and once after BM25. Make the
    // elapsed time exceed the 2000ms total budget so it flags time degradation.
    let call = 0;
    const perf = vi.spyOn(performance, "now").mockImplementation(() => {
      call++;
      return call === 1 ? 0 : 2_001;
    });
    try {
      const timed = await runTool<SearchOutput>(recallTool(makeFakeHarness()), {
        query: "rate",
        scope: "session",
        match: "smart",
      });
      expect(timed.degradeKind).toBe("time");
      expect(timed.coverage?.limitedBy).toContain("timeBudget");
    } finally {
      perf.mockRestore();
    }
  });

  it("excludes recall's own tool output without hiding unrelated tool output", async () => {
    const h = makeFakeHarness();
    const tool = recallTool(h);

    const self = await runTool<SearchOutput>(tool, {
      query: "unique-self-recall-result",
      scope: "project",
      excludeCurrentSession: false,
    });
    const unrelated = await runTool<SearchOutput>(tool, {
      query: "unauthorized",
      scope: "project",
      type: "tool",
      excludeCurrentSession: false,
    });

    expect(self.results).toEqual([]);
    expect(unrelated.results).toHaveLength(1);
    expect(unrelated.results[0]?.toolName).toBe("bash");
  });

  it("returns suggestions and near misses for empty searches", async () => {
    const out = await runTool<SearchOutput>(recallTool(makeFakeHarness()), {
      query: "totally-absent-token",
      scope: "project",
    });

    expect(out.results).toEqual([]);
    expect(out.suggestions?.some((suggestion) => suggestion.action.includes('match:"smart"'))).toBe(
      true,
    );
    expect(out.nearMisses?.length).toBeGreaterThan(0);
    expect(out.nearMisses?.[0]).toHaveProperty("sessionID");
  });

  it("counts messagesSearched and partsSearched in coverage", async () => {
    const h = makeFakeHarness();
    const projectOut = await runTool<SearchOutput>(recallTool(h), {
      query: "walkthrough",
      scope: "project",
      excludeCurrentSession: false,
    });
    const globalOut = await runTool<SearchOutput>(recallTool(h), {
      query: "walkthrough",
      excludeCurrentSession: false,
    });

    // Candidate-derived coverage: messages/parts WITH searchable content.
    // s-current has 6 messages but m-current-4 holds only recall's own tool
    // output (self-excluded), so 5 messages / 5 parts count; s-project-2 adds
    // 3/3 and s-other (global only) adds 2/2.
    const projectExpected = 8;
    const totalExpected = 10;

    expect(projectOut.coverage?.messagesSearched).toBe(projectExpected);
    expect(projectOut.coverage?.partsSearched).toBeGreaterThan(0);
    expect(projectOut.coverage?.partsSearched).toBeGreaterThanOrEqual(
      projectOut.coverage?.messagesSearched ?? 0,
    );

    expect(globalOut.coverage?.messagesSearched).toBe(totalExpected);
    expect(globalOut.coverage?.messagesSearched).toBeGreaterThan(
      projectOut.coverage?.messagesSearched ?? 0,
    );
  });

  it("respects role and type filters when counting coverage", async () => {
    const h = makeFakeHarness();
    const all = await runTool<SearchOutput>(recallTool(h), {
      query: "walkthrough",
      scope: "project",
    });
    const userOnly = await runTool<SearchOutput>(recallTool(h), {
      query: "walkthrough",
      scope: "project",
      role: "user",
    });
    const toolOnly = await runTool<SearchOutput>(recallTool(h), {
      query: "walkthrough",
      scope: "project",
      type: "tool",
    });

    expect(userOnly.coverage?.messagesSearched).toBeLessThan(all.coverage?.messagesSearched ?? 0);
    expect(toolOnly.coverage?.partsSearched).toBeLessThan(all.coverage?.partsSearched ?? 0);
  });

  it("does not emit a type-filter suggestion when type is unset or 'all'", async () => {
    const fromAll = await runTool<SearchOutput>(recallTool(makeFakeHarness()), {
      query: "totally-absent-token",
      scope: "project",
      type: "all",
    });
    const fromUnset = await runToolRaw<SearchOutput>(recallTool(makeFakeHarness()), {
      query: "totally-absent-token",
      scope: "project",
    });

    for (const out of [fromAll, fromUnset]) {
      expect(out.results).toEqual([]);
      const reasons = out.suggestions?.map((s) => s.reason) ?? [];
      expect(reasons.every((reason) => !reason.includes("type:undefined"))).toBe(true);
      expect(reasons.every((reason) => !reason.includes('type:"all"'))).toBe(true);
    }
  });

  it("emits a typed type-filter suggestion only when a non-default type filter is used", async () => {
    const out = await runTool<SearchOutput>(recallTool(makeFakeHarness()), {
      query: "totally-absent-token",
      scope: "project",
      type: "tool",
    });

    const typeSuggestion = out.suggestions?.find((s) => s.reason.includes("type:"));
    expect(typeSuggestion?.reason).toContain('type:"tool"');
    expect(typeSuggestion?.example).toEqual({ type: "all" });
  });

  it("uses correct grammar for the 'sessions searched' suggestion", async () => {
    const single = await runTool<SearchOutput>(recallTool(makeFakeHarness()), {
      query: "totally-absent-token",
      scope: "session",
    });
    expect(single.coverage?.sessionsSearched).toBe(1);
    const singleReason = single.suggestions?.find((s) => s.reason.includes("searched"))?.reason;
    expect(singleReason).toBe("Only 1 session was searched.");

    const multi = await runTool<SearchOutput>(
      recallTool(makeFakeHarness(), true, { ...TEST_LIMITS, maxSessions: 3 }),
      {
        query: "totally-absent-token",
        scope: "project",
        excludeCurrentSession: false,
      },
    );
    expect(multi.coverage?.sessionsSearched).toBe(2);
    const multiReason = multi.suggestions?.find((s) => s.reason.includes("searched"))?.reason;
    expect(multiReason).toBe("Only 2 sessions were searched.");
  });

  it("applies defensive defaults when callers bypass Zod schema parsing", async () => {
    // Live MCP hosts may forward raw caller args without applying schema defaults.
    // The plugin must still treat scope/match/type/group/role/expand/window as defaulted.
    const out = await runToolRaw<SearchOutput>(recallTool(makeFakeHarness()), {
      query: "walkthrough",
    });

    expect(out.ok).toBe(true);
    expect(out.results.length).toBeGreaterThan(0);
    // No type-filter suggestion should fire when type was unset.
    expect(
      out.suggestions?.some(
        (suggestion) =>
          suggestion.reason.includes("type:undefined") || suggestion.reason.includes('type:"all"'),
      ) ?? false,
    ).toBe(false);
  });

  it("surfaces partial and total message-load failures", async () => {
    const partial = makeFakeHarness({
      messageErrors: { "s-project-2": "Unauthorized" },
      messageThrows: new Set(["s-current"]),
    });
    const partialOut = await runTool<SearchOutput>(recallTool(partial), {
      query: "walkthrough",
      excludeCurrentSession: false,
    });
    expect(partialOut.results).toHaveLength(3);
    expect(partialOut.coverage?.loadErrors?.count).toBe(2);
    expect(partialOut.coverage?.loadErrors?.samples).toEqual(
      expect.arrayContaining([
        expect.stringContaining("s-project-2: Unauthorized"),
        expect.stringContaining("s-current: thrown messages: s-current"),
      ]),
    );

    const total = makeFakeHarness({
      messageErrors: {
        "s-current": "Unauthorized",
        "s-project-2": "Unauthorized",
        "s-other": "Unauthorized",
      },
    });
    const totalOut = await runTool<SearchOutput>(recallTool(total), {
      query: "walkthrough",
      excludeCurrentSession: false,
    });
    expect(totalOut.results).toEqual([]);
    expect(totalOut.coverage?.loadErrors?.count).toBe(3);
    expect(totalOut.coverage?.loadErrors?.samples).toHaveLength(3);
  });

  it("continues explicit session searches when metadata lookup fails", async () => {
    const h = makeFakeHarness({ getThrows: new Set(["s-other"]) });
    const out = await runTool<SearchOutput>(recallTool(h), {
      query: "walkthrough",
      sessionID: "s-other",
    });

    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({
      sessionID: "s-other",
      sessionTitle: "",
      directory: "",
    });
  });

  it("reports bad explicit sessionIDs as load errors, not silent no-matches", async () => {
    const h = makeFakeHarness();
    const out = await runTool<SearchOutput>(recallTool(h), {
      query: "anything",
      sessionID: "s-missing",
    });

    expect(out.ok).toBe(true);
    expect(out.results).toEqual([]);
    expect(out.coverage?.sessionsSearched).toBe(1);
    expect(out.coverage?.loadErrors?.count).toBe(1);
    expect(out.coverage?.loadErrors?.samples[0]).toContain("s-missing: Unauthorized");
  });

  it("returns errors for disabled global search, missing current session, and aborts", async () => {
    const h = makeFakeHarness();
    const disabled = await runTool<ErrorOutput>(recallTool(h, false), {
      query: "walkthrough",
    });
    expect(disabled).toMatchObject({ ok: false });
    expect(disabled.error).toContain("Global scope disabled");

    const missingSession = await runTool<ErrorOutput>(
      recallTool(makeFakeHarness()),
      { query: "rate", scope: "session" },
      makeContext({ sessionID: "" }).ctx,
    );
    expect(missingSession.error).toContain("No sessionID provided");

    const aborted = await runTool<ErrorOutput>(
      recallTool(makeFakeHarness()),
      { query: "rate", scope: "project" },
      makeContext({ aborted: true }).ctx,
    );
    expect(aborted).toEqual({ ok: false, error: "aborted" });
  });

  it("honors aborts between concurrency batches", async () => {
    const ctx = makeContext();
    const h = makeFakeHarness({
      afterMessagesCall: () => ctx.controller.abort(),
    });
    const out = await runTool<ErrorOutput>(
      recallTool(h, true, { ...TEST_LIMITS, concurrency: 1 }),
      { query: "rate", scope: "project" },
      ctx.ctx,
    );

    expect(out).toEqual({ ok: false, error: "aborted" });
    expect(h.calls.messages).toHaveLength(1);
  });

  describe("composition-aware suggestions", () => {
    it("flags generated-material dominance and exact code tokens", async () => {
      const h = makeFakeHarness();
      const docsHeavy = session("s-docsheavy", "Docs Heavy", PROJECT_DIR, Date.now());
      h.sessions.push(docsHeavy);
      h.globalSessions.push(globalSessionFrom(docsHeavy));
      h.messagesBySession[docsHeavy.id] = [0, 1, 2].map((i) =>
        bundle(assistantMessage(`m-dh-${i}`, docsHeavy.id, Date.now() - i), [
          completedToolPart(
            `p-dh-${i}`,
            docsHeavy.id,
            `m-dh-${i}`,
            "read",
            { filePath: `/doc-${i}.md` },
            `ZANTHOR_TOKEN reference documentation copy ${i}`,
            { title: "Read doc" },
          ),
        ]),
      );

      const out = await runTool<SearchOutput>(recallTool(h), {
        query: "ZANTHOR_TOKEN",
        match: "smart",
        scope: "project",
        excludeCurrentSession: false,
      });
      // file-read caps still allow two; with only reads matching, the top-5
      // composition triggers the generated-material hint. codeTokens trigger
      // the literal hint.
      expect(out.suggestions?.some((s) => s.reason.includes("generated reference material"))).toBe(
        true,
      );
      expect(out.suggestions?.some((s) => s.example && "match" in s.example)).toBe(true);
    });
  });

  describe("query plan", () => {
    it("reports selected variants only under explain", async () => {
      const h = makeFakeHarness();
      const tool = recallTool(h);

      const explained = await runTool<SearchOutput>(tool, {
        query: "Actualyze walkthrough",
        match: "smart",
        explain: true,
        excludeCurrentSession: false,
      });
      expect(explained.queryPlan?.variants).toContain("title-shortlist");
      expect(explained.queryPlan?.selected).toContain("bm25-broad");
      // "Actualyze" overlaps the s-other session title, so the shortlist ran.
      expect(explained.queryPlan?.selected.some((s) => s.startsWith("title-shortlist"))).toBe(true);

      const plain = await runTool<SearchOutput>(tool, {
        query: "Actualyze walkthrough",
        match: "smart",
        excludeCurrentSession: false,
      });
      expect(plain.queryPlan).toBeUndefined();
    });
  });

  describe("expansion match preservation", () => {
    it("keeps the matched region of an oversized part during expansion", async () => {
      const h = makeFakeHarness();
      const big = session("s-bigpart", "Big Part", PROJECT_DIR, Date.now());
      h.sessions.push(big);
      h.globalSessions.push(globalSessionFrom(big));
      const output = `${"x".repeat(8_000)} zebrafinch-token ${"y".repeat(2_000)}`;
      h.messagesBySession[big.id] = [
        bundle(assistantMessage("m-bigpart", big.id, Date.now()), [
          completedToolPart("p-bigpart", big.id, "m-bigpart", "bash", { command: "run" }, output),
        ]),
      ];

      const out = await runTool<SearchOutput>(recallTool(h), {
        query: "zebrafinch-token",
        scope: "project",
        expand: "message",
        excludeCurrentSession: false,
      });
      expect(out.results[0]?.sessionID).toBe("s-bigpart");
      const expandedPart = out.expanded?.[0]?.message?.parts.find((p) => p.id === "p-bigpart");
      // Head-only truncation at 4,000 chars would have dropped the match at ~8,000.
      expect(expandedPart?.output).toContain("zebrafinch-token");
      expect(expandedPart?.output).toContain("chars omitted");
      expect(out.warnings?.some((w) => w.includes("truncated or omitted"))).toBe(true);
    });
  });

  describe("current-session exclusion", () => {
    it("excludes the current session by default", async () => {
      const out = await runTool<SearchOutput>(recallTool(makeFakeHarness()), {
        query: "rate-limit middleware",
      });

      expect(out.results).toEqual([]);
      expect(out.coverage?.skippedByReason?.excludedSession).toBe(1);
      expect(out.coverage?.limitedBy).toContain("excludedSession");
      const excluded = out.suggestions?.find((s) => s.reason.includes("current session"));
      expect(excluded?.example).toEqual({ excludeCurrentSession: false });
    });

    it("includes the current session when excludeCurrentSession is false", async () => {
      const out = await runTool<SearchOutput>(recallTool(makeFakeHarness()), {
        query: "rate-limit middleware",
        excludeCurrentSession: false,
      });

      expect(out.results.some((r) => r.sessionID === "s-current")).toBe(true);
    });

    it("applies the default when hosts bypass Zod parsing", async () => {
      const tool = recallTool(makeFakeHarness());

      const missing = await runToolRaw<SearchOutput>(tool, {
        query: "rate-limit middleware",
      });
      expect(missing.ok).toBe(true);
      expect(missing.results).toEqual([]);
      expect(missing.coverage?.skippedByReason?.excludedSession).toBe(1);

      const garbage = await runToolRaw<SearchOutput>(tool, {
        query: "rate-limit middleware",
        excludeCurrentSession: "yes",
      });
      expect(garbage.ok).toBe(true);
      expect(garbage.results).toEqual([]);
      expect(garbage.coverage?.skippedByReason?.excludedSession).toBe(1);

      // A non-string excludeSessionID must coerce to "unset", not throw.
      const numericID = await runToolRaw<SearchOutput>(tool, {
        query: "rate-limit middleware",
        excludeCurrentSession: false,
        excludeSessionID: 123,
      });
      expect(numericID.ok).toBe(true);
      expect(numericID.results.some((r) => r.sessionID === "s-current")).toBe(true);
    });

    it("excludes an arbitrary session via excludeSessionID", async () => {
      const out = await runTool<SearchOutput>(recallTool(makeFakeHarness()), {
        query: "walkthrough",
        excludeSessionID: "s-other",
        excludeCurrentSession: false,
      });

      expect(out.results.every((r) => r.sessionID !== "s-other")).toBe(true);
      expect(out.results).toEqual([]);
      expect(out.coverage?.skippedByReason?.excludedSession).toBe(1);
    });

    it("rejects contradictory exclusion arguments", async () => {
      const tool = recallTool(makeFakeHarness());

      const sessionScope = await runTool<ErrorOutput>(tool, {
        query: "x",
        scope: "session",
        excludeCurrentSession: true,
      });
      expect(sessionScope.ok).toBe(false);
      expect(sessionScope.error).toContain('scope:"session"');

      const sameSession = await runTool<ErrorOutput>(tool, {
        query: "x",
        sessionID: "s-other",
        excludeSessionID: "s-other",
      });
      expect(sameSession.ok).toBe(false);

      const currentTarget = await runTool<ErrorOutput>(tool, {
        query: "x",
        sessionID: "s-current",
        excludeCurrentSession: true,
      });
      expect(currentTarget.ok).toBe(false);
    });

    it("suggests dropping excludeCurrentSession:false when the current session dominates", async () => {
      const out = await runTool<SearchOutput>(recallTool(makeFakeHarness()), {
        query: "rate",
        scope: "project",
        excludeCurrentSession: false,
      });

      const top = out.results.slice(0, 5);
      const fromCurrent = top.filter((r) => r.sessionID === "s-current").length;
      expect(fromCurrent * 2).toBeGreaterThanOrEqual(top.length);
      const dominance = out.suggestions?.find((s) =>
        s.reason.startsWith("Most top hits are from this conversation"),
      );
      expect(dominance).toBeDefined();
    });
  });
});
