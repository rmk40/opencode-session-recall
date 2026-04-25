import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BUDGETS } from "../src/candidates.js";
import { search } from "../src/search.js";
import type { SearchOutput, ErrorOutput } from "../src/types.js";
import {
  PROJECT_DIR,
  TEST_LIMITS,
  assistantMessage,
  bundle,
  globalSessionFrom,
  makeContext,
  makeFakeHarness,
  runTool,
  session,
  textPart,
} from "./helpers.js";

function recallTool(
  h = makeFakeHarness(),
  global = true,
  limits = TEST_LIMITS,
) {
  return search(h.client, h.unscoped, global, limits);
}

function messageTime(
  h: ReturnType<typeof makeFakeHarness>,
  sessionID: string,
  messageID: string,
): number {
  const msg = h.messagesBySession[sessionID]?.find(
    (m) => m.info.id === messageID,
  );
  if (!msg)
    throw new Error(`missing fixture message ${sessionID}:${messageID}`);
  return msg.info.time.created;
}

describe("recall", () => {
  it("defaults to global literal search and returns valid JSON results", async () => {
    const h = makeFakeHarness();
    const out = await runTool<SearchOutput>(recallTool(h), {
      query: "walkthrough",
    });

    expect(h.calls.globalList).toEqual([{ search: undefined, limit: 1000 }]);
    expect(h.calls.projectList).toEqual([]);
    expect(out.ok).toBe(true);
    expect(out.group).toBe("part");
    expect(out.results.map((r) => r.sessionID)).toEqual(["s-other", "s-other"]);
    expect(out.scanned).toBe(3);
    expect(out.truncated).toBe(false);
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
    expect(explicit.results.map((r) => r.sessionID)).toEqual([
      "s-other",
      "s-other",
    ]);
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
      limit: 1000,
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

    expect(zero.results.map((r) => r.messageID)).toEqual(
      baseline.results.map((r) => r.messageID),
    );
    expect(negative.results.map((r) => r.messageID)).toEqual(
      baseline.results.map((r) => r.messageID),
    );
    expect(h.calls.projectList).toContainEqual({
      search: undefined,
      limit: 1000,
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

  it("surfaces partial and total message-load failures", async () => {
    const partial = makeFakeHarness({
      messageErrors: { "s-project-2": "Unauthorized" },
      messageThrows: new Set(["s-current"]),
    });
    const partialOut = await runTool<SearchOutput>(recallTool(partial), {
      query: "walkthrough",
    });
    expect(partialOut.results).toHaveLength(2);
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
