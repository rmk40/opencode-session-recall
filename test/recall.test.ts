import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BUDGETS } from "../src/candidates.js";
import { search } from "../src/search.js";
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
  return search(h.client, h.unscoped, global, limits);
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
    expect(out.scanned).toBe(3);
    expect(out.truncated).toBe(false);
    expect(out.coverage).toMatchObject({
      sessionsDiscovered: 3,
      sessionsSearched: 3,
      sessionsSkipped: 0,
      totalSessionsKnown: false,
    });
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
    });
    expect(before.results).toEqual([]);

    const after = await runTool<SearchOutput>(tool, {
      query: "unauthorized",
      scope: "project",
      after: unauthorizedAt - 1,
    });
    expect(after.results).toHaveLength(1);

    const titled = await runTool<SearchOutput>(tool, {
      query: "walkthrough",
      title: "Actualyze",
    });
    expect(titled.scanned).toBe(1);
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
    expect(smart.results.find((result) => result.source === "title")?.directoryRelevance).toBe(
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
    expect(fallback.results.find((r) => r.sessionID === "s-other")?.directoryRelevance).toBe(
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
    });
    expect(capped.scanned).toBe(1);
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
    });
    const punctuation = await runTool<SearchOutput>(tool, {
      query: "C++",
      scope: "project",
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
    });
    expect(ungrouped.results).toHaveLength(1);
    expect(ungrouped.truncated).toBe(true);

    const grouped = await runTool<SearchOutput>(tool, {
      query: "rate",
      scope: "project",
      group: "session",
      results: 1,
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
    });
    expect(baseline.expanded).toBeUndefined();

    const expanded = await runTool<SearchOutput>(tool, {
      query: "unauthorized",
      scope: "project",
      expand: "message",
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

  it("reports budget degradation deterministically", async () => {
    const h = makeFakeHarness();
    const big = session("s-budget", "Budget Stress", PROJECT_DIR, Date.now());
    h.sessions.push(big);
    h.globalSessions.push(globalSessionFrom(big));
    h.messagesBySession[big.id] = Array.from(
      { length: DEFAULT_BUDGETS.maxCandidatesPerSession + 1 },
      (_, index) => {
        const messageID = `m-budget-${index}`;
        return bundle(assistantMessage(messageID, big.id, Date.now() - index), [
          textPart(`p-budget-${index}`, big.id, messageID, "budget token"),
        ]);
      },
    );

    const budget = await runTool<SearchOutput>(recallTool(h), {
      query: "budget",
      scope: "project",
      match: "smart",
    });
    expect(budget.degradeKind).toBe("budget");
  });

  it("reports time degradation deterministically", async () => {
    let call = 0;
    const perf = vi.spyOn(performance, "now").mockImplementation(() => {
      call++;
      return call === 1 ? 0 : 1_601;
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
    });
    const unrelated = await runTool<SearchOutput>(tool, {
      query: "unauthorized",
      scope: "project",
      type: "tool",
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
    });
    const globalOut = await runTool<SearchOutput>(recallTool(h), {
      query: "walkthrough",
    });

    const projectSessionIDs = new Set(h.sessions.map((s) => s.id));
    const projectExpected = Object.entries(h.messagesBySession)
      .filter(([sessionID]) => projectSessionIDs.has(sessionID))
      .reduce((sum, [, msgs]) => sum + (msgs?.length ?? 0), 0);
    const totalExpected = Object.values(h.messagesBySession).reduce(
      (sum, msgs) => sum + (msgs?.length ?? 0),
      0,
    );

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
    });
    expect(partialOut.results).toHaveLength(3);
    expect(partialOut.loadErrorCount).toBe(2);
    expect(partialOut.loadErrors).toEqual(
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
    });
    expect(totalOut.results).toEqual([]);
    expect(totalOut.loadErrorCount).toBe(3);
    expect(totalOut.loadErrors).toHaveLength(3);
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
    expect(out.scanned).toBe(1);
    expect(out.loadErrorCount).toBe(1);
    expect(out.loadErrors?.[0]).toContain("s-missing: Unauthorized");
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
});
