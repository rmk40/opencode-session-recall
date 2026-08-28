import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@opencode-ai/plugin";
import { buildSuggestions, search, type SearchDeps } from "../src/search.js";
import { cardsLiteFromSessions, createCardsRuntime } from "../src/cards.js";
import { createDrill } from "../src/drill.js";
import { createFetchGate } from "../src/fetch-gate.js";
import type { Limits, SearchCoverage, SearchOutput, ErrorOutput } from "../src/types.js";
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
  makeRecallDeps,
  runTool,
  runToolRaw,
  session,
  setStrictNoLimitMessages,
  textPart,
  userMessage,
  type FakeHarness,
} from "./helpers.js";

// No search path may make an unpaginated session.messages call.
beforeAll(() => setStrictNoLimitMessages(true));
afterAll(() => setStrictNoLimitMessages(false));

// Each recall tool is built over a temp card store seeded from the harness
// fixture (the way a completed distiller cold pass would leave it). Cleanups run
// after every test.
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function recallTool(
  h: FakeHarness = makeFakeHarness(),
  global = true,
  limits: Limits = TEST_LIMITS,
): Promise<ToolDefinition> {
  const { deps, cleanup } = await makeRecallDeps(h, limits);
  cleanups.push(cleanup);
  return search(h.client, h.unscoped, global, limits, deps);
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
    const out = await runTool<SearchOutput>(await recallTool(h), {
      query: "walkthrough",
    });

    // Discovery is now the distiller's job; the search tool ranks the seeded
    // card store and drills only the shortlisted session (s-other).
    expect(out.ok).toBe(true);
    expect(out.group).toBe("part");
    expect(out.results.map((r) => r.sessionID)).toEqual(["s-other", "s-other", "s-other"]);
    expect(out.results.some((r) => r.source === "title")).toBe(true);
    expect(out.truncated).toBe(false);
    expect(out.coverage).toMatchObject({
      sessionsDiscovered: 3,
      sessionsSearched: 1,
      totalSessionsKnown: false,
    });
    expect(out.coverage?.cards).toMatchObject({ total: 3 });
    expect(out.coverage?.limitedBy).toContain("excludedSession");
  });

  it("routes project, current-session, and explicit-session searches correctly", async () => {
    const h = makeFakeHarness();
    const tool = await recallTool(h);

    const project = await runTool<SearchOutput>(tool, {
      query: "walkthrough",
      scope: "project",
    });
    // s-other lives in OTHER_DIR, so a project-scoped search drops it.
    expect(project.results).toEqual([]);

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
    const tool = await recallTool(h);
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
    // The title filter now narrows the ranked cards, not a session.list call.
    expect(titled.coverage?.sessionsSearched).toBe(1);
  });

  it("filters by relative time windows", async () => {
    const h = makeFakeHarness();
    const tool = await recallTool(h);

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
      const since = await runTool<SearchOutput>(await recallTool(h), {
        query: "relative-token",
        scope: "project",
        since: "1d",
      });
      expect(since.results.map((r) => r.sessionID)).toEqual(["s-recent-relative"]);

      const until = await runTool<SearchOutput>(await recallTool(h), {
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
      const last = await runTool<SearchOutput>(await recallTool(h), {
        query: "window-token",
        scope: "project",
        last: "1d",
      });
      const since = await runTool<SearchOutput>(await recallTool(h), {
        query: "window-token",
        scope: "project",
        since: "1d",
      });
      expect(last.results.map((r) => r.sessionID)).toEqual(["s-recent-window"]);
      expect(since.results.map((r) => r.sessionID)).toEqual(last.results.map((r) => r.sessionID));
      expect(since.coverage?.messagesSearched).toBe(last.coverage?.messagesSearched);

      const fromTo = await runTool<SearchOutput>(await recallTool(h), {
        query: "window-token",
        scope: "project",
        from: "2d ago",
        to: "now",
      });
      expect(fromTo.results.map((r) => r.sessionID)).toEqual(["s-recent-window"]);

      const beforeDate = await runTool<SearchOutput>(await recallTool(h), {
        query: "window-token",
        scope: "project",
        before: new Date(now - 86_400_000).toISOString(),
      });
      expect(beforeDate.results.map((r) => r.sessionID)).toEqual(["s-old-window"]);

      const untilNow = await runTool<SearchOutput>(await recallTool(h), {
        query: "window-token",
        scope: "project",
        until: "0d",
      });
      // Recency orders the shortlist, so the recent session drills first.
      expect(untilNow.results.map((r) => r.sessionID)).toEqual(["s-recent-window", "s-old-window"]);
      expect(untilNow.warnings?.[0]).toContain('Normalized until:"0d"');

      const ignoredLast = await runTool<SearchOutput>(await recallTool(h), {
        query: "window-token",
        scope: "project",
        last: "0d",
      });
      expect(ignoredLast.results.map((r) => r.sessionID)).toEqual([
        "s-recent-window",
        "s-old-window",
      ]);
      expect(ignoredLast.warnings?.[0]).toContain('Ignored last:"0d"');

      const upperConflict = await runTool<SearchOutput>(await recallTool(h), {
        query: "window-token",
        scope: "project",
        before: now - 86_400_000,
        until: "2d",
      });
      expect(upperConflict.results.map((r) => r.sessionID)).toEqual(["s-old-window"]);
      expect(upperConflict.warnings?.[0]).toContain("Used until as the upper time bound");

      // Multiple lower bounds: newest (most restrictive) wins, others warned about.
      const lowerConflict = await runTool<SearchOutput>(await recallTool(h), {
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
      const impossible = await runTool<ErrorOutput>(await recallTool(h), {
        query: "window-token",
        scope: "project",
        after: now - 86_400_000,
        before: now - 5 * 86_400_000,
      });
      expect(impossible.ok).toBe(false);
      expect(impossible.error).toContain("Time filters produce an empty window");
      expect(impossible.error).toContain('last:"7d"');

      // Malformed date strings on before/after are ignored with a warning, not a hard error.
      const malformedDate = await runToolRaw<SearchOutput>(await recallTool(h), {
        query: "window-token",
        scope: "project",
        after: "not-a-date",
      });
      expect(malformedDate.ok).toBe(true);
      expect(malformedDate.warnings?.some((w) => w.includes('Ignored after:"not-a-date"'))).toBe(
        true,
      );

      // Relative durations on absolute-only fields (before/after) are rejected with a warning.
      const relativeOnAfter = await runToolRaw<SearchOutput>(await recallTool(h), {
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

    const out = await runTool<SearchOutput>(await recallTool(h), {
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

    const literal = await runTool<SearchOutput>(await recallTool(h), {
      query: "minecraft",
      scope: "project",
      expand: "message",
      expandResults: 1,
    });
    // The content session ranks ahead of the title-only session, so the message
    // hit precedes the title hit and is the first expandable result.
    expect(literal.results.map((result) => result.source)).toEqual(["message", "title"]);
    expect(literal.expanded?.[0]).toMatchObject({
      resultIndex: 0,
      messageID: "m-content-expand",
    });

    const smart = await runTool<SearchOutput>(await recallTool(h), {
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

    const out = await runTool<SearchOutput>(await recallTool(h), {
      query: "rate",
      directory: PROJECT_DIR,
      results: 10,
      excludeCurrentSession: false,
    });

    expect(out.results.some((r) => r.sessionID === "s-current")).toBe(true);
    expect(out.results.some((r) => r.sessionID === "s-nested")).toBe(true);
    expect(out.results.some((r) => r.sessionID === "s-projectish")).toBe(false);

    const other = await runTool<SearchOutput>(await recallTool(h), {
      query: "walkthrough",
      directory: OTHER_DIR,
    });
    expect(other.results.map((r) => r.sessionID)).toEqual(["s-other", "s-other", "s-other"]);
    expect(other.coverage?.directoryBucketsSearched).toEqual(["exact"]);

    const fallback = await runTool<SearchOutput>(await recallTool(h), {
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
    // Only s-other matched "walkthrough" (global bucket); no exact-bucket card
    // matched, so the honest buckets-searched is global-only.
    expect(fallback.coverage?.directoryBucketsSearched).toEqual(["global"]);
    expect(fallback.coverage?.directoryBucketCounts?.global).toBeGreaterThan(0);

    // `sessionLimit: 1` caps the drill fan-out to a single shortlisted session.
    const capped = await runTool<SearchOutput>(await recallTool(h), {
      query: "rate",
      directory: PROJECT_DIR,
      sessionLimit: 1,
      excludeCurrentSession: false,
    });
    expect(capped.coverage?.sessionsSearched).toBe(1);
    expect(capped.coverage?.limitedBy).toContain("sessionsLimit");
    expect(new Set(capped.results.map((r) => r.sessionID)).size).toBe(1);

    const sessionFallback = await runTool<SearchOutput>(await recallTool(h), {
      query: "walkthrough",
      scope: "session",
      directory: PROJECT_DIR,
      fallback: true,
    });
    expect(sessionFallback.results).toEqual([]);
  });

  it("filters tool parts by exact tool name", async () => {
    const h = makeFakeHarness();
    const tool = await recallTool(h);

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
    const out = await runTool<SearchOutput>(await recallTool(h), {
      query: "checkout cache",
      scope: "project",
      match: "smart",
      toolName: "bash",
      results: 10,
    });

    // Both bash tool parts qualify: one matches in its own text, the other
    // through the session digest field (session-level identity, like title/
    // directory matches). The toolName filter is what's under test: only
    // bash tool parts may appear.
    expect(out.results.every((r) => r.partType === "tool" && r.toolName === "bash")).toBe(true);
    expect(out.results.length).toBeGreaterThanOrEqual(1);
  });

  it("reports matched tool fields for smart-ranked tool hits", async () => {
    const h = makeFakeHarness();
    const out = await runTool<SearchOutput>(await recallTool(h), {
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
    const tool = await recallTool(h);

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
  });

  it("supports case-insensitive and punctuation-containing literal queries", async () => {
    const h = makeFakeHarness();
    const tool = await recallTool(h);

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
    const tool = await recallTool(h);

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
    expect(grouped.results[0]?.hitCount).toBeGreaterThanOrEqual(1);

    // With room for both sessions, s-current reports its 3 "rate" part hits.
    const groupedAll = await runTool<SearchOutput>(tool, {
      query: "rate",
      scope: "project",
      group: "session",
      results: 5,
      excludeCurrentSession: false,
    });
    expect(groupedAll.results.find((r) => r.sessionID === "s-current")?.hitCount).toBe(3);
  });

  it("omits expansions by default and expands full messages when requested", async () => {
    const h = makeFakeHarness();
    const tool = await recallTool(h);

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
    const tool = await recallTool(h);

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

    const out = await runTool<SearchOutput>(await recallTool(h), {
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

    const out = await runTool<SearchOutput>(await recallTool(h), {
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
    const out = await runTool<SearchOutput>(await recallTool(h), {
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
    const out = await runTool<SearchOutput>(await recallTool(h), {
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
    const out = await runTool<SearchOutput>(await recallTool(h), {
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
    const out = await runToolRaw<SearchOutput>(await recallTool(makeFakeHarness()), {
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
    const out = await runToolRaw<SearchOutput>(await recallTool(makeFakeHarness()), {
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
    const out = await runToolRaw<SearchOutput>(await recallTool(makeFakeHarness()), {
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
    const out = await runToolRaw<SearchOutput>(await recallTool(makeFakeHarness()), {
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
    const expandOut = await runToolRaw<SearchOutput>(await recallTool(makeFakeHarness()), {
      query: "walkthrough",
      expand: "huge",
    });
    expect(expandOut.warnings?.some((w) => w.includes('Ignored expand:"huge"'))).toBe(true);
    expect(expandOut.expanded).toBeUndefined();
  });

  it("caps expansion count and returns partial results for oversized context expansion", async () => {
    const h = makeFakeHarness();
    const expanded = await runTool<SearchOutput>(await recallTool(h), {
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

    const tooLarge = await runTool<SearchOutput>(await recallTool(h), {
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
    const out = await runTool<SearchOutput>(await recallTool(h), {
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
    const tool = await recallTool(h);

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

    const out = await runTool<SearchOutput>(await recallTool(h), {
      query: "xylozene calibration",
      scope: "project",
      match: "smart",
      excludeCurrentSession: false,
    });
    expect(out.results.some((r) => r.sessionID === "s-rare")).toBe(true);
  });

  // (Removed "reports time degradation deterministically": the corpus-scan
  //  ranking time budget no longer exists. Tier-2 drills a bounded shortlist, so
  //  there is no full-corpus ranking phase to flag as time-degraded.)

  it("excludes recall's own tool output without hiding unrelated tool output", async () => {
    const h = makeFakeHarness();
    const tool = await recallTool(h);

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
    const out = await runTool<SearchOutput>(await recallTool(makeFakeHarness()), {
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

  it("counts messagesSearched and partsSearched over the drilled sessions", async () => {
    const h = makeFakeHarness();
    // "rate" matches both project sessions, so both are drilled. Coverage counts
    // their searchable messages/parts: s-current has 6 messages but m-current-4
    // is recall's own tool output (self-excluded) → 5 messages / 5 parts; plus
    // s-project-2's 3/3 = 8 each.
    const projectOut = await runTool<SearchOutput>(await recallTool(h), {
      query: "rate",
      scope: "project",
      excludeCurrentSession: false,
    });

    expect(projectOut.coverage?.messagesSearched).toBe(8);
    expect(projectOut.coverage?.partsSearched).toBeGreaterThan(0);
    expect(projectOut.coverage?.partsSearched).toBeGreaterThanOrEqual(
      projectOut.coverage?.messagesSearched ?? 0,
    );
    // Coverage also reports the card store's tier-0 state.
    expect(projectOut.coverage?.cards?.total).toBe(3);
  });

  it("respects role and type filters when counting coverage", async () => {
    const h = makeFakeHarness();
    // "rate" drills s-project-2 (s-current is the excluded current session).
    const all = await runTool<SearchOutput>(await recallTool(h), {
      query: "rate",
      scope: "project",
    });
    const userOnly = await runTool<SearchOutput>(await recallTool(h), {
      query: "rate",
      scope: "project",
      role: "user",
    });
    const toolOnly = await runTool<SearchOutput>(await recallTool(h), {
      query: "rate",
      scope: "project",
      type: "tool",
    });

    expect(all.coverage?.messagesSearched).toBeGreaterThan(0);
    expect(userOnly.coverage?.messagesSearched).toBeLessThan(all.coverage?.messagesSearched ?? 0);
    expect(toolOnly.coverage?.partsSearched).toBeLessThan(all.coverage?.partsSearched ?? 0);
  });

  it("does not emit a type-filter suggestion when type is unset or 'all'", async () => {
    const fromAll = await runTool<SearchOutput>(await recallTool(makeFakeHarness()), {
      query: "totally-absent-token",
      scope: "project",
      type: "all",
    });
    const fromUnset = await runToolRaw<SearchOutput>(await recallTool(makeFakeHarness()), {
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
    const out = await runTool<SearchOutput>(await recallTool(makeFakeHarness()), {
      query: "totally-absent-token",
      scope: "project",
      type: "tool",
    });

    const typeSuggestion = out.suggestions?.find((s) => s.reason.includes("type:"));
    expect(typeSuggestion?.reason).toContain('type:"tool"');
    expect(typeSuggestion?.example).toEqual({ type: "all" });
  });

  it("uses correct grammar for the 'sessions searched' suggestion", async () => {
    const single = await runTool<SearchOutput>(await recallTool(makeFakeHarness()), {
      query: "totally-absent-token",
      scope: "session",
    });
    expect(single.coverage?.sessionsSearched).toBe(1);
    const singleReason = single.suggestions?.find((s) => s.reason.includes("searched"))?.reason;
    expect(singleReason).toBe("Only 1 session was searched.");

    const multi = await runTool<SearchOutput>(
      await recallTool(makeFakeHarness(), true, { ...TEST_LIMITS, maxSessions: 3 }),
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
    const out = await runToolRaw<SearchOutput>(await recallTool(makeFakeHarness()), {
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

  it("survives raw Zod-bypass since/until/project/sessionLimit (host path)", async () => {
    // The stage 3-4 filter args (since/until, project, sessionLimit) can arrive
    // from the live MCP host with the wrong runtime type (Zod is not applied).
    // None may throw; each coerces to a safe default rather than crashing on
    // .trim()/.slice() or making a bound NaN.
    const h = makeFakeHarness();
    const out = await runToolRaw<SearchOutput>(await recallTool(h), {
      query: "rate",
      scope: "project",
      excludeCurrentSession: false,
      since: 42, // number epoch: a valid absolute lower bound, not a crash
      until: {}, // non-string: ignored, never reaches .trim()
      project: 7, // non-boolean/string: no project filter, no throw
      sessionLimit: "12", // non-number: coerced to the fan-out default + a warning
    });
    expect(out.ok).toBe(true);
    expect(out.results.length).toBeGreaterThan(0);
    // Coercion ran: the malformed sessionLimit was reported, not silently obeyed.
    expect(out.warnings?.some((w) => /sessionLimit/i.test(w))).toBe(true);
  });

  it("surfaces partial and total drilled-session load failures", async () => {
    // "rate" drills s-current and s-project-2. Load errors now come only from
    // the drilled sessions (the store is already distilled); a failing drill
    // fetch is reported without hiding the sessions that loaded.
    const partial = makeFakeHarness({ messageErrors: { "s-project-2": "Unauthorized" } });
    const partialOut = await runTool<SearchOutput>(await recallTool(partial), {
      query: "rate",
      excludeCurrentSession: false,
    });
    expect(partialOut.results.length).toBeGreaterThan(0);
    expect(partialOut.coverage?.loadErrors?.count).toBe(1);
    expect(partialOut.coverage?.loadErrors?.samples[0]).toContain("s-project-2: Unauthorized");

    const total = makeFakeHarness({
      messageErrors: { "s-current": "Unauthorized", "s-project-2": "Unauthorized" },
    });
    const totalOut = await runTool<SearchOutput>(await recallTool(total), {
      query: "rate",
      excludeCurrentSession: false,
    });
    expect(totalOut.results).toEqual([]);
    expect(totalOut.coverage?.loadErrors?.count).toBe(2);
    expect(totalOut.coverage?.loadErrors?.samples).toHaveLength(2);
  });

  it("continues explicit session searches when metadata lookup fails", async () => {
    const h = makeFakeHarness({ getThrows: new Set(["s-other"]) });
    const out = await runTool<SearchOutput>(await recallTool(h), {
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
    const out = await runTool<SearchOutput>(await recallTool(h), {
      query: "anything",
      sessionID: "s-missing",
    });

    expect(out.ok).toBe(true);
    expect(out.results).toEqual([]);
    // The drill attempted the one target but its fetch failed, so it loaded
    // nothing (sessionsSearched 0) and reports the failure rather than a silent
    // no-match.
    expect(out.coverage?.sessionsSearched).toBe(0);
    expect(out.coverage?.loadErrors?.count).toBe(1);
    expect(out.coverage?.loadErrors?.samples[0]).toContain("s-missing: Unauthorized");
  });

  it("returns errors for disabled global search, missing current session, and aborts", async () => {
    const h = makeFakeHarness();
    const disabled = await runTool<ErrorOutput>(await recallTool(h, false), {
      query: "walkthrough",
    });
    expect(disabled).toMatchObject({ ok: false });
    expect(disabled.error).toContain("Global scope disabled");

    const missingSession = await runTool<ErrorOutput>(
      await recallTool(makeFakeHarness()),
      { query: "rate", scope: "session" },
      makeContext({ sessionID: "" }).ctx,
    );
    expect(missingSession.error).toContain("No sessionID provided");

    const aborted = await runTool<ErrorOutput>(
      await recallTool(makeFakeHarness()),
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
      await recallTool(h, true, { ...TEST_LIMITS, concurrency: 1 }),
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

      const out = await runTool<SearchOutput>(await recallTool(h), {
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

    it("keeps zero-result guidance ahead of the code-token hint under the suggestion cap", async () => {
      // Four priority-0 zero-result hints fire (directory, excluded session,
      // type filter, few sessions searched); the priority-1 code-token hint
      // must be the one displaced by the 3-suggestion cap.
      const out = await runTool<SearchOutput>(await recallTool(makeFakeHarness()), {
        query: "zanzibar_qux warp",
        match: "smart",
        type: "reasoning",
        directory: "/nonexistent/path",
      });

      expect(out.results).toEqual([]);
      expect(out.suggestions).toHaveLength(3);
      expect(out.suggestions!.some((s) => s.reason.includes("code-like tokens"))).toBe(false);
    });

    it("suggests a title filter when shortlisted sessions do not rank", async () => {
      const h = makeFakeHarness();
      const planned = session("s-planned", "Zanzibar migration planning", PROJECT_DIR, Date.now());
      const worker = session("s-worker", "Other work", PROJECT_DIR, Date.now());
      h.sessions.push(planned, worker);
      h.globalSessions.push(globalSessionFrom(planned), globalSessionFrom(worker));
      h.messagesBySession[planned.id] = [
        bundle(userMessage("m-planned", planned.id, Date.now()), [
          textPart("p-planned", planned.id, "m-planned", "notes about unrelated prose entirely"),
        ]),
      ];
      h.messagesBySession[worker.id] = [
        bundle(assistantMessage("m-worker", worker.id, Date.now()), [
          completedToolPart(
            "p-worker",
            worker.id,
            "m-worker",
            "bash",
            // The anchor rides the tool INPUT (a human-layer field the store
            // indexes) so the worker session actually ranks and drills.
            { command: "deploy zanzibar service" },
            "zanzibar deployment output log",
          ),
        ]),
      ];

      // type:"tool" leaves the shortlisted session with zero eligible
      // candidates, so its metadata overlap cannot rank — the hint must
      // point at the title filter instead.
      const out = await runTool<SearchOutput>(await recallTool(h), {
        query: "zanzibar",
        match: "smart",
        type: "tool",
      });

      expect(out.results.length).toBeGreaterThan(0);
      expect(out.results.every((r) => r.sessionID !== planned.id)).toBe(true);
      const hint = out.suggestions?.find((s) => s.reason.includes("title/directory match"));
      expect(hint?.example).toEqual({ title: "zanzibar" });
    });

    it("suggests inspecting a dense grouped session with group:part", async () => {
      const h = makeFakeHarness();
      const dense = session("s-dense", "Widget session", PROJECT_DIR, Date.now());
      h.sessions.push(dense);
      h.globalSessions.push(globalSessionFrom(dense));
      h.messagesBySession[dense.id] = Array.from({ length: 10 }, (_, i) =>
        bundle(assistantMessage(`m-dense-${i}`, dense.id, Date.now() - i), [
          textPart(`p-dense-${i}`, dense.id, `m-dense-${i}`, `flurbwidget occurrence ${i}`),
        ]),
      );

      const out = await runTool<SearchOutput>(await recallTool(h), {
        query: "flurbwidget",
        group: "session",
      });

      expect(out.results[0]?.hitCount).toBeGreaterThanOrEqual(10);
      const hint = out.suggestions?.find((s) => s.action.includes('group:"part"'));
      expect(hint?.example).toEqual({ group: "part", sessionID: dense.id });
    });
  });

  describe("staleness suggestion", () => {
    /** Age every fixture session so the seeded card store's recency is 3 days
     *  old — a since:"1h" window is then provably newer than the index. */
    function staleHarness(): FakeHarness {
      const h = makeFakeHarness();
      const old = Date.now() - 3 * 24 * 3600_000;
      for (const s of [...h.sessions, ...h.globalSessions]) s.time.updated = old;
      return h;
    }

    it("flags a stale window first and suppresses the misleading generic entries", async () => {
      const h = staleHarness();
      const out = await runTool<SearchOutput>(await recallTool(h), {
        query: "fix review findings batch",
        scope: "project",
        since: "1h",
      });

      expect(out.results).toEqual([]);
      expect(out.coverage?.sessionsEligible).toBe(0);
      // The staleness entry is present and FIRST.
      expect(out.suggestions?.[0]?.reason).toContain("has not caught up");
      expect(out.suggestions?.[0]?.action).toContain('parentID: "current"');
      // The two contradicted generic entries are suppressed (the pinned
      // sessions-searched entry reads "Only N session(s) ... searched.").
      expect(out.suggestions?.some((s) => s.reason.includes("Literal search found no hits"))).toBe(
        false,
      );
      expect(
        out.suggestions?.some((s) => /^Only \d+ sessions? (was|were) searched\.$/.test(s.reason)),
      ).toBe(false);
      // "Widen the window" is never offered.
      expect(out.suggestions?.some((s) => /widen/i.test(`${s.reason} ${s.action}`))).toBe(false);
    });

    it("survives the 3-cap against a regex-shaped query with directory and type filters", async () => {
      // Adversarial combination: the regex routing hint plus the directory and
      // type-filter zero-result hints are all priority-0 — the staleness entry
      // must be inserted ahead of them or the cap slices it off.
      const h = staleHarness();
      const out = await runTool<SearchOutput>(await recallTool(h), {
        query: "batch[a-z]+",
        match: "smart",
        type: "reasoning",
        directory: "/nonexistent/path",
        since: "1h",
      });

      expect(out.results).toEqual([]);
      expect(out.suggestions).toHaveLength(3);
      expect(out.suggestions?.[0]?.reason).toContain("has not caught up");
    });

    it("uses the no-index wording in degraded mode", async () => {
      // Virgin degraded mode: no store, cards-lite over aged sessions, so
      // storeRecency is 0 and coverage.cards.degraded is true. The wording
      // must say "no index", not misdiagnose the missing store as lag.
      const h = staleHarness();
      const gate = createFetchGate({ concurrency: TEST_LIMITS.concurrency });
      const liteCards = cardsLiteFromSessions(h.globalSessions);
      const cards = createCardsRuntime({
        source: { getCards: () => liteCards, revision: () => undefined, degraded: true },
      });
      const drill = createDrill({ client: h.client, gate, limits: TEST_LIMITS });
      const deps: SearchDeps = { gate, store: null, cards, drill };
      const tool = search(h.client, h.unscoped, true, TEST_LIMITS, deps);

      const out = await runTool<SearchOutput>(tool, {
        query: "fix review findings batch",
        scope: "project",
        since: "1h",
      });

      expect(out.coverage?.cards?.degraded).toBe(true);
      expect(out.suggestions?.[0]?.reason).toContain("No content index is available");
      expect(out.suggestions?.[0]?.action).toContain("recall_sessions");
    });

    it("keeps generic suggestions unchanged for a non-stale zero result", async () => {
      // Fresh fixture store, absent query: zero results but the window covers
      // the index, so the staleness entry must not appear and the generic
      // literal→smart hint stays.
      const out = await runTool<SearchOutput>(await recallTool(makeFakeHarness()), {
        query: "totally-absent-token",
        scope: "project",
        since: "1h",
      });

      expect(out.results).toEqual([]);
      expect(out.suggestions?.some((s) => s.reason.includes("has not caught up")) ?? false).toBe(
        false,
      );
      expect(out.suggestions?.some((s) => s.action.includes('match:"smart"'))).toBe(true);
    });

    it("requires zero eligible sessions: a stale-looking recency alone does not fire", () => {
      // Degraded mode reaches this state for real: storeRecency is 0 (it counts
      // full cards only) while sessions are still eligible and searchable.
      // Without the sessionsEligible conjunct the no-index entry would fire on
      // every time-bounded degraded query, results or not.
      const coverage: SearchCoverage = {
        totalSessionsKnown: false,
        sessionsDiscovered: 3,
        sessionsEligible: 3,
        sessionsSearched: 3,
        messagesSearched: 10,
        partsSearched: 20,
        sessionsSkipped: 0,
        cards: { total: 3, full: 0, storeRecency: 0, degraded: true },
      };
      const suggestions = buildSuggestions({
        results: [],
        coverage,
        fallback: false,
        matchMode: "smart",
        type: undefined,
        query: "anything",
        currentSessionExcluded: false,
        excludeExplicitOff: false,
        codeTokens: [],
        shortlistIDs: [],
        after: Date.now() - 3600_000,
      });
      const all = (suggestions ?? []).map((s) => `${s.reason} ${s.action}`).join(" | ");
      expect(all).not.toMatch(/has not caught up|No content index is available/);
    });

    it("emits no staleness entry and does not crash when coverage.cards is absent", () => {
      const coverage: SearchCoverage = {
        totalSessionsKnown: false,
        sessionsDiscovered: 0,
        sessionsEligible: 0,
        sessionsSearched: 0,
        messagesSearched: 0,
        partsSearched: 0,
        sessionsSkipped: 0,
      };
      const suggestions = buildSuggestions({
        results: [],
        coverage,
        fallback: false,
        matchMode: "smart",
        type: undefined,
        query: "anything",
        currentSessionExcluded: false,
        excludeExplicitOff: false,
        codeTokens: [],
        shortlistIDs: [],
        after: Date.now() - 3600_000,
      });
      expect(suggestions?.some((s) => s.reason.includes("has not caught up")) ?? false).toBe(false);
    });
  });

  describe("literal candidate scans", () => {
    it("counts one result per part for multi-field matches and classes literal hits", async () => {
      const h = makeFakeHarness();
      const fields = session("s-fields", "Field session", PROJECT_DIR, Date.now());
      h.sessions.push(fields);
      h.globalSessions.push(globalSessionFrom(fields));
      h.messagesBySession[fields.id] = [
        bundle(assistantMessage("m-fields", fields.id, Date.now()), [
          completedToolPart(
            "p-multi",
            fields.id,
            "m-fields",
            "bash",
            { command: "grishnak --verify" },
            "grishnak verified ok",
          ),
          completedToolPart(
            "p-input",
            fields.id,
            "m-fields",
            "bash",
            { command: "flumox run" },
            "done",
          ),
        ]),
      ];
      const tool = await recallTool(h);

      // The query matches output, command, AND the JSON input of one part:
      // total counts matched parts, not matched fields.
      const multi = await runTool<SearchOutput>(tool, { query: "grishnak", scope: "project" });
      expect(multi.results).toHaveLength(1);
      expect(multi.total).toBe(1);
      expect(multi.truncated).toBe(false);
      expect(multi.results[0]?.why?.evidenceClass).toBe("tool-output");

      // A hit found only in what was asked of the tool classes as tool-input.
      const inputOnly = await runTool<SearchOutput>(tool, { query: "flumox", scope: "project" });
      expect(inputOnly.total).toBe(1);
      expect(inputOnly.results[0]?.why?.evidenceClass).toBe("tool-input");
      expect(inputOnly.results[0]?.why?.matchedFields).toEqual(["command"]);
    });
  });

  describe("query plan", () => {
    it("reports selected variants only under explain", async () => {
      const h = makeFakeHarness();
      const tool = await recallTool(h);

      const explained = await runTool<SearchOutput>(tool, {
        query: "Actualyze walkthrough",
        match: "smart",
        explain: true,
        excludeCurrentSession: false,
      });
      // The plan now names the tiered pipeline: tier-1 cards, tier-2 drill, and
      // the FTS needle lookup (the "walkthrough" anchor hits s-other's rows).
      expect(explained.queryPlan?.variants).toContain("cards-tier1");
      expect(explained.queryPlan?.selected).toContain("cards-tier1");
      expect(explained.queryPlan?.selected).toContain("drill-tier2");

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

      const out = await runTool<SearchOutput>(await recallTool(h), {
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

    it("keeps inline context expansion bounded on a large session", async () => {
      // 60-message session with the needle near the top: recall + expand:context
      // must resolve context via bounded point/page fetches (strict mode would
      // throw on any unpaginated whole-session pull).
      const h = makeFakeHarness();
      const big = session("s-bigexpand", "Big Expand", PROJECT_DIR, Date.now());
      h.globalSessions.push(globalSessionFrom(big));
      h.messagesBySession[big.id] = Array.from({ length: 60 }, (_, i) =>
        bundle(assistantMessage(`mb-${i}`, big.id, Date.now() - (60 - i) * 1_000), [
          textPart(
            `pb-${i}`,
            big.id,
            `mb-${i}`,
            i === 58 ? "zephyrbounded distinctive marker" : `filler line ${i}`,
          ),
        ]),
      );

      const out = await runTool<SearchOutput>(await recallTool(h), {
        query: "zephyrbounded",
        match: "smart",
        scope: "project",
        excludeCurrentSession: false,
        expand: "context",
        window: 1,
      });
      expect(out.results.some((r) => r.sessionID === "s-bigexpand")).toBe(true);
      expect((out.expanded?.length ?? 0) > 0).toBe(true);
      // Every fetch carried an explicit, capped limit.
      expect(
        h.calls.messages.every((c) => c.limit != null && c.limit <= TEST_LIMITS.maxMessages),
      ).toBe(true);
    });
  });

  describe("discovery completeness", () => {
    it("finds matches beyond the server's 100-session default window", async () => {
      const h = makeFakeHarness();
      const now = Date.now();
      // 120 filler sessions newer than the needle so the needle sits past
      // where an omitted limit (server default 100) would truncate.
      for (let index = 0; index < 120; index++) {
        const filler = session(`s-page-${index}`, `Page Filler ${index}`, OTHER_DIR, now - index);
        h.globalSessions.push(globalSessionFrom(filler));
        h.messagesBySession[filler.id] = [
          bundle(userMessage(`m-page-${index}`, filler.id, now - index), [
            textPart(`p-page-${index}`, filler.id, `m-page-${index}`, "routine filler note"),
          ]),
        ];
      }
      const needle = session("s-deep", "Deep History", OTHER_DIR, now - 1_000_000);
      h.globalSessions.push(globalSessionFrom(needle));
      h.messagesBySession[needle.id] = [
        bundle(userMessage("m-deep", needle.id, now - 1_000_000), [
          textPart("p-deep", needle.id, "m-deep", "quixotic-artifact provenance decision"),
        ]),
      ];

      const out = await runTool<SearchOutput>(await recallTool(h), {
        query: "quixotic-artifact",
      });
      // The distiller distilled every session into the store, so a needle far
      // past the old 100-row list window is still ranked and drilled.
      expect(out.results.some((r) => r.sessionID === "s-deep")).toBe(true);
      // Well under the discovery limit: no provider-cap warning.
      expect(out.coverage?.limitedBy ?? []).not.toContain("providerLimit");
    });

    // (Removed "reports providerLimit when discovery fills the completeness
    //  window": discovery is now the distiller's cold pass, not a search-time
    //  session.list. providerLimit fires when the card store holds >=
    //  DISCOVERY_LIMIT cards — a store-size condition, not practically seeded in
    //  a unit fixture. The accounting path is exercised by the distiller.)
  });

  describe("exclusion family", () => {
    function familyHarness() {
      const h = makeFakeHarness();
      const now = Date.now();
      const root = session("s-root", "Family Root", PROJECT_DIR, now - 5_000);
      const child = session(
        "s-child",
        "Family Child",
        PROJECT_DIR,
        now - 4_000,
        undefined,
        "s-root",
      );
      const grandchild = session(
        "s-grandchild",
        "Family Grandchild",
        PROJECT_DIR,
        now - 3_000,
        undefined,
        "s-child",
      );
      const sibling = session(
        "s-sibling",
        "Family Sibling",
        PROJECT_DIR,
        now - 2_000,
        undefined,
        "s-root",
      );
      for (const sess of [root, child, grandchild, sibling]) {
        h.globalSessions.push(globalSessionFrom(sess));
        h.messagesBySession[sess.id] = [
          bundle(userMessage(`m-${sess.id}`, sess.id, sess.time.updated), [
            textPart(`p-${sess.id}`, sess.id, `m-${sess.id}`, "family lineage evidence marker"),
          ]),
        ];
      }
      return h;
    }

    it("excludes the whole delegation tree when searching from the root", async () => {
      const h = familyHarness();
      const out = await runTool<SearchOutput>(
        await recallTool(h),
        { query: "family lineage evidence" },
        makeContext({ sessionID: "s-root" }).ctx,
      );
      expect(out.results).toEqual([]);
      expect(out.coverage?.skippedByReason?.excludedSession).toBe(4);
    });

    it("excludes ancestors and siblings when searching from a subagent child", async () => {
      const h = familyHarness();
      const out = await runTool<SearchOutput>(
        await recallTool(h),
        { query: "family lineage evidence" },
        makeContext({ sessionID: "s-grandchild" }).ctx,
      );
      expect(out.results).toEqual([]);
      expect(out.coverage?.skippedByReason?.excludedSession).toBe(4);
    });

    it("keeps unrelated sessions and restores the family on explicit opt-in", async () => {
      const h = familyHarness();
      const outsider = session("s-outsider", "Unrelated", PROJECT_DIR, Date.now() - 1_000);
      h.globalSessions.push(globalSessionFrom(outsider));
      h.messagesBySession[outsider.id] = [
        bundle(userMessage("m-outsider", outsider.id, Date.now() - 1_000), [
          textPart("p-outsider", outsider.id, "m-outsider", "family lineage evidence marker too"),
        ]),
      ];

      const excluded = await runTool<SearchOutput>(
        await recallTool(h),
        { query: "family lineage evidence" },
        makeContext({ sessionID: "s-root" }).ctx,
      );
      expect(excluded.results.map((r) => r.sessionID)).toEqual(["s-outsider"]);

      const optIn = await runTool<SearchOutput>(
        await recallTool(h),
        { query: "family lineage evidence", excludeCurrentSession: false },
        makeContext({ sessionID: "s-root" }).ctx,
      );
      expect(new Set(optIn.results.map((r) => r.sessionID)).size).toBe(5);
    });

    it("survives a parentID cycle without hanging", async () => {
      const h = makeFakeHarness();
      const now = Date.now();
      const a = session("s-cyc-a", "Cycle A", PROJECT_DIR, now - 2_000, undefined, "s-cyc-b");
      const b = session("s-cyc-b", "Cycle B", PROJECT_DIR, now - 1_000, undefined, "s-cyc-a");
      for (const sess of [a, b]) {
        h.globalSessions.push(globalSessionFrom(sess));
        h.messagesBySession[sess.id] = [
          bundle(userMessage(`m-${sess.id}`, sess.id, now), [
            textPart(`p-${sess.id}`, sess.id, `m-${sess.id}`, "cycle marker text"),
          ]),
        ];
      }
      const out = await runTool<SearchOutput>(
        await recallTool(h),
        { query: "cycle marker" },
        makeContext({ sessionID: "s-cyc-a" }).ctx,
      );
      expect(out.ok).toBe(true);
      expect(out.results).toEqual([]);
    });
  });

  describe("current-session exclusion", () => {
    it("excludes the current session by default", async () => {
      const out = await runTool<SearchOutput>(await recallTool(makeFakeHarness()), {
        query: "rate-limit middleware",
      });

      expect(out.results).toEqual([]);
      expect(out.coverage?.skippedByReason?.excludedSession).toBe(1);
      expect(out.coverage?.limitedBy).toContain("excludedSession");
      const excluded = out.suggestions?.find((s) => s.reason.includes("current session"));
      expect(excluded?.example).toEqual({ excludeCurrentSession: false });
    });

    it("includes the current session when excludeCurrentSession is false", async () => {
      const out = await runTool<SearchOutput>(await recallTool(makeFakeHarness()), {
        query: "rate-limit middleware",
        excludeCurrentSession: false,
      });

      expect(out.results.some((r) => r.sessionID === "s-current")).toBe(true);
    });

    it("applies the default when hosts bypass Zod parsing", async () => {
      const tool = await recallTool(makeFakeHarness());

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
      const out = await runTool<SearchOutput>(await recallTool(makeFakeHarness()), {
        query: "walkthrough",
        excludeSessionID: "s-other",
        excludeCurrentSession: false,
      });

      expect(out.results.every((r) => r.sessionID !== "s-other")).toBe(true);
      expect(out.results).toEqual([]);
      expect(out.coverage?.skippedByReason?.excludedSession).toBe(1);
    });

    it("rejects contradictory exclusion arguments", async () => {
      const tool = await recallTool(makeFakeHarness());

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

    it("does not apply the implicit default to an explicit current-session target", async () => {
      const out = await runTool<SearchOutput>(await recallTool(makeFakeHarness()), {
        query: "rate-limit",
        sessionID: "s-current",
      });

      // Targeting the current session by ID with no exclusion args must
      // search it: the scope-aware default never contradicts an explicit target.
      expect(out.ok).toBe(true);
      expect(out.results.length).toBeGreaterThan(0);
      expect(out.results.every((r) => r.sessionID === "s-current")).toBe(true);
      expect(out.coverage?.skippedByReason?.excludedSession).toBeUndefined();
    });

    it("combines excludeSessionID with the default current-session exclusion", async () => {
      const out = await runTool<SearchOutput>(await recallTool(makeFakeHarness()), {
        query: "rate",
        excludeSessionID: "s-other",
      });

      expect(out.coverage?.skippedByReason?.excludedSession).toBe(2);
      expect(out.results.length).toBeGreaterThan(0);
      expect(out.results.every((r) => r.sessionID === "s-project-2")).toBe(true);
    });

    it("omits the exclusion suggestion when the current session was not discovered", async () => {
      const { ctx } = makeContext({ sessionID: "s-elsewhere" });
      const out = await runTool<SearchOutput>(
        await recallTool(makeFakeHarness()),
        { query: "no-such-term-anywhere" },
        ctx,
      );

      // The exclusion removed nothing, so the zero-result guidance must not
      // blame it and coverage must not count a skip.
      expect(out.results).toEqual([]);
      expect(out.coverage?.skippedByReason?.excludedSession).toBeUndefined();
      expect(
        out.suggestions?.some((s) => s.reason.includes("excluded the current session")),
      ).toBeFalsy();
    });

    it("suggests dropping excludeCurrentSession:false when the current session dominates", async () => {
      const out = await runTool<SearchOutput>(await recallTool(makeFakeHarness()), {
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

// ── Explicit shortlist with uncarded sessions ────────────────────────────────
// A session named in `sessions:` that has no card yet (young session the
// distiller has not carded) must still be drilled: the caller named it
// explicitly. Setup trick: seed the store (makeRecallDeps) FIRST, then add the
// session to the harness — the fake client serves its messages, but no card
// exists.
describe("explicit shortlist includes uncarded sessions", () => {
  const NOW = Date.now();

  function addUncarded(h: FakeHarness, id: string, title: string, text: string): void {
    const s = session(id, title, PROJECT_DIR, NOW - 1_000);
    h.sessions.push(s);
    h.globalSessions.push(globalSessionFrom(s));
    h.messagesBySession[id] = [
      bundle(userMessage(`m-${id}-1`, id, NOW - 2_000), [
        textPart(`p-${id}-1`, id, `m-${id}-1`, text),
      ]),
    ];
  }

  async function setup(h: FakeHarness = makeFakeHarness(), limits: Limits = TEST_LIMITS) {
    const { deps, cleanup } = await makeRecallDeps(h, limits);
    cleanups.push(cleanup);
    return search(h.client, h.unscoped, true, limits, deps);
  }

  it("drills an uncarded shortlist member: hit returned, eligible counted, warning present", async () => {
    const h = makeFakeHarness();
    const carded = session("s-carded", "Carded Session", PROJECT_DIR, NOW - 5_000);
    h.sessions.push(carded);
    h.globalSessions.push(globalSessionFrom(carded));
    h.messagesBySession[carded.id] = [
      bundle(userMessage("m-carded-1", carded.id, NOW - 6_000), [
        textPart("p-carded-1", carded.id, "m-carded-1", "nothing relevant in the carded session"),
      ]),
    ];
    const recall = await setup(h);
    // Added AFTER the store was seeded → messages exist, no card (the live bug).
    addUncarded(h, "s-young", "Young Uncarded", "the zorblatt needle lives only here");

    const out = await runTool<SearchOutput>(recall, {
      query: "zorblatt",
      sessions: ["s-carded", "s-young"],
    });
    expect(out.ok).toBe(true);
    expect(out.results.some((r) => r.sessionID === "s-young")).toBe(true);
    expect(out.coverage?.sessionsEligible).toBe(2);
    expect(out.coverage?.sessionsSearched).toBe(2);
    expect(out.warnings?.some((w) => /no card yet .*drilled directly/i.test(w))).toBe(true);
  });

  it("searches an uncarded-only shortlist instead of reporting zero eligible sessions", async () => {
    const h = makeFakeHarness();
    const recall = await setup(h);
    addUncarded(h, "s-only-young", "Only Young", "flumoxide appears in the young session");

    const out = await runTool<SearchOutput>(recall, {
      query: "flumoxide",
      sessions: ["s-only-young"],
    });
    expect(out.ok).toBe(true);
    expect(out.coverage?.sessionsEligible).toBe(1);
    expect(out.coverage?.sessionsSearched).toBe(1);
    expect(out.results.some((r) => r.sessionID === "s-only-young")).toBe(true);
    expect(out.warnings?.some((w) => /no card yet/i.test(w))).toBe(true);
  });

  it("tolerates a nonexistent id: ok:true, other sessions still searched", async () => {
    const h = makeFakeHarness();
    const recall = await setup(h);
    addUncarded(h, "s-real-young", "Real Young", "grimwold hides here");

    const out = await runTool<SearchOutput>(recall, {
      query: "grimwold",
      sessions: ["s-real-young", "s-no-such-session"],
    });
    expect(out.ok).toBe(true);
    expect(out.results.some((r) => r.sessionID === "s-real-young")).toBe(true);
    // The bad id's fetch failure is a per-target load error, not a crash.
    expect(out.coverage?.loadErrors?.count).toBe(1);
    expect(out.coverage?.loadErrors?.samples?.[0]).toContain("s-no-such-session");
  });

  it("carded members honor since/title filters; uncarded bypass them", async () => {
    const h = makeFakeHarness();
    const oldCarded = session("s-old-carded", "Old Carded", PROJECT_DIR, NOW - 86_400_000);
    h.sessions.push(oldCarded);
    h.globalSessions.push(globalSessionFrom(oldCarded));
    h.messagesBySession[oldCarded.id] = [
      bundle(userMessage("m-old-carded-1", oldCarded.id, NOW - 86_400_000), [
        textPart("p-old-carded-1", oldCarded.id, "m-old-carded-1", "sproket mention old"),
      ]),
    ];
    const recall = await setup(h);
    addUncarded(h, "s-fresh", "Fresh Uncarded", "sproket mention fresh");

    // `after` excludes the old carded card; the uncarded id has no card
    // metadata to filter on, so it is drilled regardless.
    const out = await runTool<SearchOutput>(recall, {
      query: "sproket",
      sessions: ["s-old-carded", "s-fresh"],
      after: NOW - 3_600_000,
    });
    expect(out.ok).toBe(true);
    expect(out.results.some((r) => r.sessionID === "s-fresh")).toBe(true);
    expect(out.results.some((r) => r.sessionID === "s-old-carded")).toBe(false);
    expect(out.coverage?.sessionsEligible).toBe(1);

    // Same for a title filter that matches no carded member.
    const titled = await runTool<SearchOutput>(recall, {
      query: "sproket",
      sessions: ["s-old-carded", "s-fresh"],
      title: "does-not-match-anything",
    });
    expect(titled.ok).toBe(true);
    expect(titled.results.some((r) => r.sessionID === "s-fresh")).toBe(true);
    expect(titled.results.some((r) => r.sessionID === "s-old-carded")).toBe(false);
  });

  it("applies the sessions cap across the combined list, carded first", async () => {
    const h = makeFakeHarness();
    const carded = session("s-cap-carded", "Cap Carded", PROJECT_DIR, NOW - 5_000);
    h.sessions.push(carded);
    h.globalSessions.push(globalSessionFrom(carded));
    h.messagesBySession[carded.id] = [
      bundle(userMessage("m-cap-carded-1", carded.id, NOW - 6_000), [
        textPart("p-cap-carded-1", carded.id, "m-cap-carded-1", "quibblet in the carded one"),
      ]),
    ];
    const recall = await setup(h);
    addUncarded(h, "s-cap-young", "Cap Young", "quibblet in the young one");

    // Cap 1: the carded member fills the only slot; the uncarded id is sliced
    // out (ranked last) and no "drilled directly" warning fires for it.
    const out = await runTool<SearchOutput>(recall, {
      query: "quibblet",
      sessions: ["s-cap-young", "s-cap-carded"],
      sessionLimit: 1,
    });
    expect(out.ok).toBe(true);
    expect(out.coverage?.sessionsSearched).toBe(1);
    expect(out.results.some((r) => r.sessionID === "s-cap-carded")).toBe(true);
    expect(out.results.some((r) => r.sessionID === "s-cap-young")).toBe(false);
    expect(out.coverage?.sessionsEligible).toBe(2);
    expect(out.coverage?.limitedBy).toContain("sessionsLimit");
    expect(out.warnings?.some((w) => /no card yet/i.test(w))).toBeFalsy();
  });
});
