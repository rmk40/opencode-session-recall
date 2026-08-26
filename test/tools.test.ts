import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { context as contextTool } from "../src/context.js";
import { get as getTool } from "../src/get.js";
import { messages as messagesTool } from "../src/messages.js";
import { search } from "../src/search.js";
import { sessions as sessionsTool } from "../src/sessions.js";
import { createFetchGate, type FetchGate } from "../src/fetch-gate.js";
import { cardsLiteFromSessions } from "../src/cards.js";
import type {
  ContextOutput,
  ErrorOutput,
  MessageOutput,
  MessagesOutput,
  SearchOutput,
  SessionsOutput,
} from "../src/types.js";
import {
  OTHER_DIR,
  PROJECT_DIR,
  TEST_LIMITS,
  bundle,
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
} from "./helpers.js";

// Every browse/search tool must fetch bounded pages, never a whole session.
beforeAll(() => setStrictNoLimitMessages(true));
afterAll(() => setStrictNoLimitMessages(false));

// Shared gate for the browse tools (they must not fetch outside the concurrency
// budget). `gate` is a plain gate for behavior tests; `makeSpyGate` counts
// `runQuery` calls so a test can assert the fetch went through the gate.
const gate: FetchGate = createFetchGate({ concurrency: 4 });
function makeSpyGate(): { gate: FetchGate; queries: () => number } {
  const real = createFetchGate({ concurrency: 4 });
  let queryCount = 0;
  const spy: FetchGate = {
    runQuery: (fn) => {
      queryCount++;
      return real.runQuery(fn);
    },
    runBackground: (fn) => real.runBackground(fn),
    activeQueries: () => real.activeQueries(),
  };
  return { gate: spy, queries: () => queryCount };
}

describe("recall_sessions", () => {
  it("lists project sessions with schema defaults", async () => {
    const h = makeFakeHarness();
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, true, TEST_LIMITS),
      {},
    );

    expect(out).toMatchObject({ ok: true, returned: 2, scope: "project" });
    expect(out.sessions.map((s) => s.id)).toEqual(["s-current", "s-project-2"]);
    expect(h.calls.projectList).toEqual([{ search: undefined, limit: 20 }]);
  });

  it("lists global sessions, normalizes blank search, and exposes archived/project metadata", async () => {
    const h = makeFakeHarness();
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, true, TEST_LIMITS),
      { scope: "global", search: "   " },
    );

    expect(h.calls.globalList).toEqual([{ search: undefined, limit: 20 }]);
    expect(out.sessions.map((s) => s.id)).toEqual(["s-other", "s-current", "s-project-2"]);
    expect(out.sessions.find((s) => s.id === "s-project-2")?.archived).toBe(true);
    expect(out.sessions.find((s) => s.id === "s-other")?.project?.name).toBe("other");
  });

  it("filters titles and handles disabled global/list errors", async () => {
    const filtered = makeFakeHarness();
    const match = await runTool<SessionsOutput>(
      sessionsTool(filtered.client, filtered.unscoped, true, TEST_LIMITS),
      { search: "Checkout" },
    );
    expect(match.sessions.map((s) => s.id)).toEqual(["s-project-2"]);

    const disabled = await runTool<ErrorOutput>(
      sessionsTool(filtered.client, filtered.unscoped, false, TEST_LIMITS),
      { scope: "global" },
    );
    expect(disabled.error).toContain("Global scope disabled");

    const errored = makeFakeHarness({
      projectListError: "database unavailable",
    });
    const out = await runTool<ErrorOutput>(
      sessionsTool(errored.client, errored.unscoped, true, TEST_LIMITS),
      {},
    );
    expect(out.error).toContain("Failed to list sessions: database unavailable");
  });
});

describe("recall_messages", () => {
  it("returns one bounded newest-first page with a continuation cursor", async () => {
    const h = makeFakeHarness();
    const tool = messagesTool(h.client, gate, TEST_LIMITS);
    const out = await runTool<MessagesOutput>(tool, { limit: 2 });

    // Newest-first, always with an explicit limit (never a whole-session fetch).
    expect(out.messages.map((m) => m.message.id)).toEqual(["m-current-6", "m-current-5"]);
    expect(out.pagination.limit).toBe(2);
    expect(out.pagination.returned).toBe(2);
    expect(out.pagination.hasMore).toBe(true);
    expect(out.pagination.nextCursor).toBeDefined();
    expect(h.calls.messages.every((c) => c.limit != null)).toBe(true);
    expect(out.context.sessionTitle).toBe("Current Debugging Session");

    // The cursor continues to the next page.
    const next = await runTool<MessagesOutput>(tool, {
      limit: 2,
      cursor: out.pagination.nextCursor,
    });
    expect(next.messages.map((m) => m.message.id)).toEqual(["m-current-4", "m-current-3"]);
  });

  it("filters the returned page by role and query", async () => {
    const h = makeFakeHarness();
    // A page large enough to cover the small session, then filter within it.
    const filtered = await runTool<MessagesOutput>(messagesTool(h.client, gate, TEST_LIMITS), {
      role: "user",
      query: "checkout",
      limit: 50,
    });
    expect(filtered.messages.map((m) => m.message.id)).toEqual(["m-current-1"]);
    expect(filtered.pagination.returned).toBe(1);
    expect(filtered.pagination.hasMore).toBe(false);
    expect(filtered.pagination.nextCursor).toBeUndefined();
  });

  it("normalizes blank query and handles missing/error/empty sessions", async () => {
    const blank = makeFakeHarness();
    const blankOut = await runTool<MessagesOutput>(messagesTool(blank.client, gate, TEST_LIMITS), {
      query: "   ",
      limit: 50,
    });
    expect(blankOut.pagination.returned).toBe(6);

    const missing = await runTool<ErrorOutput>(
      messagesTool(blank.client, gate, TEST_LIMITS),
      {},
      makeContext({ sessionID: "" }).ctx,
    );
    expect(missing.error).toContain("No sessionID provided");

    const errored = makeFakeHarness({
      messageErrors: { "s-current": "Unauthorized" },
    });
    const errorOut = await runTool<ErrorOutput>(
      messagesTool(errored.client, gate, TEST_LIMITS),
      {},
    );
    expect(errorOut.error).toContain("Unauthorized");

    // A successful response without an array body is malformed, not an empty page.
    const noData = makeFakeHarness({ noMessageData: new Set(["s-current"]) });
    const noDataOut = await runTool<ErrorOutput>(
      messagesTool(noData.client, gate, TEST_LIMITS),
      {},
    );
    expect(noDataOut.error).toBe("successful message response was not an array");
  });

  it("survives raw MCP-bypass args (undefined role/limit must not filter everything)", async () => {
    // The live MCP host can forward args that skip Zod defaults. With role
    // undefined, the old code did `role !== "all"` → true → filtered everything
    // out. Coercion restores the defaults AND still passes a limit under strict.
    const h = makeFakeHarness();
    const out = await runToolRaw<MessagesOutput>(messagesTool(h.client, gate, TEST_LIMITS), {
      sessionID: "s-current",
    });
    expect(out.ok).toBe(true);
    expect(out.pagination.returned).toBeGreaterThan(0);
    expect(h.calls.messages.every((c) => c.limit != null)).toBe(true);
  });

  it("survives a raw non-string cursor (host path): treats it as the first page", async () => {
    // A Zod-bypassed non-string cursor must coerce to undefined (first page),
    // never reach the SDK as a bad `before`, and never throw.
    const h = makeFakeHarness();
    const out = await runToolRaw<MessagesOutput>(messagesTool(h.client, gate, TEST_LIMITS), {
      sessionID: "s-current",
      cursor: 123,
    });
    expect(out.ok).toBe(true);
    expect(out.pagination.returned).toBeGreaterThan(0);
    // No stray cursor was forwarded to the SDK as `before`.
    expect(h.calls.messages.every((c) => c.before === undefined)).toBe(true);
  });

  it("routes its fetches through the shared gate", async () => {
    const h = makeFakeHarness();
    const { gate: spy, queries } = makeSpyGate();
    await runTool<MessagesOutput>(messagesTool(h.client, spy, TEST_LIMITS), { limit: 2 });
    // The page fetch (and the session.get) must go through gate.runQuery.
    expect(queries()).toBeGreaterThan(0);
  });
});

describe("recall_get", () => {
  it("returns formatted full messages with model, pruned, and tool-state details", async () => {
    const h = makeFakeHarness();
    const tool = getTool(h.client, gate);

    const user = await runTool<MessageOutput>(tool, {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    expect(user.message).toMatchObject({
      id: "m-current-1",
      role: "user",
      model: "test-user-model",
    });

    const completed = await runTool<MessageOutput>(tool, {
      sessionID: "s-current",
      messageID: "m-current-3",
    });
    expect(completed.message.model).toBe("test-assistant-model");
    expect(completed.parts[0]).toMatchObject({
      type: "tool",
      toolName: "bash",
      pruned: true,
      title: "Run test suite",
      output: "Error: Unauthorized while loading session messages",
      input: { command: "npm test" },
    });

    const errored = await runTool<MessageOutput>(tool, {
      sessionID: "s-project-2",
      messageID: "m-project-2",
    });
    expect(errored.parts[0]).toMatchObject({
      error: "permission denied when reading checkout cache",
    });

    const running = await runTool<MessageOutput>(tool, {
      sessionID: "s-current",
      messageID: "m-current-6",
    });
    expect(running.parts[0]).toMatchObject({
      input: { command: "pnpm migrate status" },
    });
  });

  it("handles not-found, returned errors, and context lookup failures", async () => {
    const h = makeFakeHarness();
    const notFound = await runTool<ErrorOutput>(getTool(h.client, gate), {
      sessionID: "s-current",
      messageID: "missing",
    });
    expect(notFound.error).toBe("Message not found: missing");

    const noData = makeFakeHarness({
      noSingleMessageData: new Set(["s-current:m-current-1"]),
    });
    const noDataOut = await runTool<ErrorOutput>(getTool(noData.client, gate), {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    expect(noDataOut.error).toBe("Message not found: m-current-1");

    const errored = makeFakeHarness({
      messageLookupErrors: { "s-current:m-current-1": "message API failed" },
    });
    const errorOut = await runTool<ErrorOutput>(getTool(errored.client, gate), {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    expect(errorOut.error).toContain("message API failed");

    const noContext = makeFakeHarness({ getThrows: new Set(["s-current"]) });
    const ok = await runTool<MessageOutput>(getTool(noContext.client, gate), {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    expect(ok.ok).toBe(true);
    expect(ok.context.sessionTitle).toBeUndefined();
    expect(ok.context.directory).toBeUndefined();
  });

  it("routes its fetches through the shared gate", async () => {
    const h = makeFakeHarness();
    const { gate: spy, queries } = makeSpyGate();
    await runTool<MessageOutput>(getTool(h.client, spy), {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    // The message fetch (and the session.get) must go through gate.runQuery.
    expect(queries()).toBeGreaterThan(0);
  });
});

describe("recall_context", () => {
  it("returns centered windows, window:0, and asymmetric before/after slices", async () => {
    const h = makeFakeHarness();
    const tool = contextTool(h.client, gate, TEST_LIMITS);

    const around = await runTool<ContextOutput>(tool, {
      sessionID: "s-current",
      messageID: "m-current-3",
      window: 1,
    });
    expect(around.messages.map((m) => m.message.id)).toEqual([
      "m-current-2",
      "m-current-3",
      "m-current-4",
    ]);
    expect(around.messages.find((m) => m.center)?.message.id).toBe("m-current-3");
    expect(around.hasMoreBefore).toBe(true);
    expect(around.hasMoreAfter).toBe(true);

    const onlyTarget = await runTool<ContextOutput>(tool, {
      sessionID: "s-current",
      messageID: "m-current-3",
      window: 0,
    });
    expect(onlyTarget.messages.map((m) => m.message.id)).toEqual(["m-current-3"]);

    const afterOnly = await runTool<ContextOutput>(tool, {
      sessionID: "s-current",
      messageID: "m-current-3",
      before: 0,
      after: 1,
    });
    expect(afterOnly.messages.map((m) => m.message.id)).toEqual(["m-current-3", "m-current-4"]);
  });

  it("sets boundary hasMore flags at the first and last message", async () => {
    const h = makeFakeHarness();
    const tool = contextTool(h.client, gate, TEST_LIMITS);

    const first = await runTool<ContextOutput>(tool, {
      sessionID: "s-current",
      messageID: "m-current-1",
      before: 3,
      after: 1,
    });
    expect(first.hasMoreBefore).toBe(false);
    expect(first.hasMoreAfter).toBe(true);

    const last = await runTool<ContextOutput>(tool, {
      sessionID: "s-current",
      messageID: "m-current-6",
      before: 1,
      after: 3,
    });
    expect(last.hasMoreBefore).toBe(true);
    expect(last.hasMoreAfter).toBe(false);
  });

  it("handles message-not-found, returned errors, and no-data errors", async () => {
    const h = makeFakeHarness();
    const notFound = await runTool<ErrorOutput>(contextTool(h.client, gate, TEST_LIMITS), {
      sessionID: "s-current",
      messageID: "missing",
    });
    expect(notFound.error).toBe("Message not found: missing");

    const errored = makeFakeHarness({
      messageErrors: { "s-current": "Unauthorized" },
    });
    const errorOut = await runTool<ErrorOutput>(contextTool(errored.client, gate, TEST_LIMITS), {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    expect(errorOut.error).toContain("Unauthorized");

    const noData = makeFakeHarness({ noMessageData: new Set(["s-current"]) });
    const noDataOut = await runTool<ErrorOutput>(contextTool(noData.client, gate, TEST_LIMITS), {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    expect(noDataOut.error).toBe("successful message response was not an array");
  });

  it("survives raw MCP-bypass args (undefined window must not break slice bounds)", async () => {
    const h = makeFakeHarness();
    const out = await runToolRaw<ContextOutput>(contextTool(h.client, gate, TEST_LIMITS), {
      sessionID: "s-current",
      messageID: "m-current-3",
    });
    expect(out.ok).toBe(true);
    expect(out.messages.length).toBeGreaterThan(0);
    expect(out.messages.some((m) => m.center)).toBe(true);
  });

  it("fetches only bounded pages, never the whole session", async () => {
    // A 60-message session: a small window around a recent message must be
    // served by bounded newest-first pages, never an unpaginated whole-session
    // pull (the incident path).
    const h = makeFakeHarness();
    h.messagesBySession["s-big"] = Array.from({ length: 60 }, (_, i) =>
      bundle(userMessage(`mb-${i}`, "s-big", 1_000 + i), [
        textPart(`pb-${i}`, "s-big", `mb-${i}`, `context line ${i}`),
      ]),
    );

    const out = await runTool<ContextOutput>(contextTool(h.client, gate, TEST_LIMITS), {
      sessionID: "s-big",
      messageID: "mb-59",
      window: 1,
    });
    expect(out.ok).toBe(true);
    expect(out.messages.some((m) => m.center && m.message.id === "mb-59")).toBe(true);
    // Every fetch carried an explicit, capped limit …
    expect(
      h.calls.messages.every((c) => c.limit != null && c.limit <= TEST_LIMITS.maxMessages),
    ).toBe(true);
    // … and the total fetched stayed well under the whole 60-message session.
    const totalFetched = h.calls.messages.reduce((sum, c) => sum + (c.limit ?? 0), 0);
    expect(totalFetched).toBeLessThan(60);
  });

  it("routes its fetches through the shared gate", async () => {
    const h = makeFakeHarness();
    const { gate: spy, queries } = makeSpyGate();
    await runTool<ContextOutput>(contextTool(h.client, spy, TEST_LIMITS), {
      sessionID: "s-current",
      messageID: "m-current-3",
      window: 1,
    });
    // The window page fetch (and the session.get) must go through gate.runQuery.
    expect(queries()).toBeGreaterThan(0);
  });
});

describe("recall_sessions defensive args", () => {
  it("survives raw MCP-bypass args (undefined scope/limit default to project)", async () => {
    const h = makeFakeHarness();
    const out = await runToolRaw<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, true, TEST_LIMITS),
      {},
    );
    expect(out.ok).toBe(true);
    expect(out.scope).toBe("project");
    expect(Array.isArray(out.sessions)).toBe(true);
  });

  it("survives raw non-string since/until (host path): ignores the filters", async () => {
    // The since/until time bounds can arrive with the wrong type from the live
    // MCP host. optionalString() must drop them (no .trim() on a non-string) so
    // the listing succeeds unfiltered rather than throwing.
    const h = makeFakeHarness();
    const out = await runToolRaw<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, true, TEST_LIMITS),
      { scope: "global", since: 42, until: {} },
    );
    expect(out.ok).toBe(true);
    // Non-string bounds were ignored, so every listed session came through.
    expect(out.sessions.length).toBeGreaterThan(0);
  });
});

describe("recall_sessions enrichment", () => {
  it("attaches card-store digest, files, tools, and family from the card store", async () => {
    const h = makeFakeHarness();

    // No enrichment source (no store wired) → bare listings, ever.
    const cold = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, true, TEST_LIMITS),
      { scope: "global" },
    );
    expect(cold.sessions.every((s) => s.digest === undefined)).toBe(true);
    expect(cold.sessions.every((s) => s.files === undefined && s.tools === undefined)).toBe(true);

    // With a seeded card store, sessions carry their card's summary head, top
    // files/tools, and a family rollup for roots — served from the card store,
    // no message fetch.
    const { store, cleanup } = await makeRecallDeps(h);
    try {
      const enrichment = { cards: () => store.allCards() };
      const warm = await runTool<SessionsOutput>(
        sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, enrichment),
        { scope: "global" },
      );
      const current = warm.sessions.find((s) => s.id === "s-current");
      expect(current?.digest).toBeDefined();
      expect(current!.digest!.length).toBeLessThanOrEqual(160);
      // s-project-2 touched the checkout cache via a bash tool → tools present.
      const projectTwo = warm.sessions.find((s) => s.id === "s-project-2");
      expect(projectTwo?.tools).toContain("bash");
      // No message fetch happened for enrichment.
      expect(h.calls.messages).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("filters by since/until on time.updated", async () => {
    const h = makeFakeHarness();
    const { store, cleanup } = await makeRecallDeps(h);
    try {
      const enrichment = { cards: () => store.allCards() };
      // s-other is the newest global session (updated now-500); a tight `since`
      // keeps only the freshest, an `until` in the future keeps all.
      const recent = await runTool<SessionsOutput>(
        sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, enrichment),
        { scope: "global", since: "1h" },
      );
      // All fixture sessions are within the last hour, so since:1h keeps them.
      expect(recent.sessions.length).toBeGreaterThan(0);

      // A future-only lower bound (very small window) drops everything.
      const none = await runTool<SessionsOutput>(
        sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, enrichment),
        { scope: "global", until: "10w" },
      );
      // until:10w = updated <= now-10w → all fixture sessions are newer → none.
      expect(none.sessions).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("returns older matches beyond the newest page when a card store is present", async () => {
    // The defect: session.list returns only the newest `limit` rows, so
    // post-filtering an until bound there drops older matches. With the card
    // store, the time-filtered set is resolved authoritatively in memory.
    const now = Date.now();
    const h = makeFakeHarness();
    const old = session("s-old", "Old cache investigation", PROJECT_DIR, now - 40 * 24 * 3600_000);
    h.sessions.push(old);
    h.globalSessions.push(globalSessionFrom(old));
    h.messagesBySession[old.id] = [
      bundle(userMessage("m-old-1", old.id, now - 40 * 24 * 3600_000 - 500), [
        textPart("p-old-1", old.id, "m-old-1", "old cache investigation notes"),
      ]),
    ];
    const { store, cleanup } = await makeRecallDeps(h);
    try {
      const enrichment = { cards: () => store.allCards() };
      // until:30d excludes every newest fixture session; only s-old (40d) matches.
      // A tiny limit means the list path would return only the (excluded) newest
      // page — the card path still surfaces the older match.
      const out = await runTool<SessionsOutput>(
        sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, enrichment),
        { scope: "global", until: "30d", limit: 2 },
      );
      expect(out.sessions.map((s) => s.id)).toContain("s-old");
      expect(h.calls.messages).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("notes the newest-window caveat when filtering without a card store (degraded)", async () => {
    const h = makeFakeHarness();
    // No enrichment → the time filter can only apply within the list's page.
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, true, TEST_LIMITS),
      { scope: "global", since: "7d" },
    );
    expect(out.ok).toBe(true);
    expect(out.note).toBeDefined();
    expect(out.note).toMatch(/newest/i);
  });
});

describe("recall_sessions children branch", () => {
  const PARENT = "ses-parent";

  it("lists direct children via the scoped client, index-free and fetch-free", async () => {
    const now = Date.now();
    const h = makeFakeHarness({
      children: {
        [PARENT]: [
          session(
            "ses-child-1",
            "Fix batch A findings (@code-writer subagent)",
            PROJECT_DIR,
            now - 2_000,
            undefined,
            PARENT,
          ),
          session(
            "ses-child-2",
            "Fix batch B findings (@code-writer subagent)",
            PROJECT_DIR,
            now - 1_000,
            undefined,
            PARENT,
          ),
        ],
      },
    });
    const { ctx, metadata } = makeContext();
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, true, TEST_LIMITS),
      { parentID: PARENT },
      ctx,
    );

    expect(out).toMatchObject({ ok: true, scope: "children", parentID: PARENT, childCount: 2 });
    // Newest first (updated desc).
    expect(out.sessions.map((s) => s.id)).toEqual(["ses-child-2", "ses-child-1"]);
    // Decision 1 enforced: the scoped client carried the call.
    expect(h.calls.children).toEqual([{ sessionID: PARENT, client: "scoped" }]);
    // Index-freedom is the premise: no session.list on either client.
    expect(h.calls.projectList).toEqual([]);
    expect(h.calls.globalList).toEqual([]);
    // No message fetch of any kind (strict mode alone only catches unlimited).
    expect(h.calls.messages).toEqual([]);
    // The branch metadata call overwrites the preamble one (last-write-wins).
    expect(metadata.at(-1)?.title).toBe(`Found 2 children of ${PARENT}`);
  });

  it("ignores the global-disabled error when parentID is set (the !parentID conjunct)", async () => {
    const h = makeFakeHarness({ children: {} });
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, false, TEST_LIMITS),
      { scope: "global", parentID: PARENT },
    );
    expect(out.ok).toBe(true);
    expect(out.scope).toBe("children");
  });

  it('resolves "current" via ctx.sessionID (case-insensitively) and errors without one', async () => {
    const now = Date.now();
    const h = makeFakeHarness({
      children: {
        "s-current": [
          session("ses-kid", "Child of current", PROJECT_DIR, now, undefined, "s-current"),
        ],
      },
    });
    const tool = sessionsTool(h.client, h.unscoped, true, TEST_LIMITS);
    const out = await runTool<SessionsOutput>(tool, { parentID: "current" });
    expect(out).toMatchObject({ ok: true, scope: "children", parentID: "s-current" });
    expect(out.sessions.map((s) => s.id)).toEqual(["ses-kid"]);

    // The sugar is case-insensitive ("Current", "CURRENT"); no collision risk
    // with real session IDs (ses_*-prefixed).
    const cased = await runTool<SessionsOutput>(tool, { parentID: "Current" });
    expect(cased).toMatchObject({ ok: true, scope: "children", parentID: "s-current" });
    expect(cased.sessions.map((s) => s.id)).toEqual(["ses-kid"]);

    const noSession = await runTool<ErrorOutput>(
      tool,
      { parentID: "current" },
      makeContext({ sessionID: "" }).ctx,
    );
    expect(noSession.ok).toBe(false);
    expect(noSession.error).toContain('parentID:"current" requires a current session');
  });

  it("treats a divergent non-array children payload as an empty list", async () => {
    const h = makeFakeHarness({ childrenNonArray: true });
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, true, TEST_LIMITS),
      { parentID: PARENT },
    );
    expect(out).toMatchObject({ ok: true, scope: "children", childCount: 0, returned: 0 });
    expect(out.sessions).toEqual([]);
  });

  it("returns ok with an empty list and childCount 0 for a parent with no children", async () => {
    const h = makeFakeHarness({ children: {} });
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, true, TEST_LIMITS),
      { parentID: PARENT },
    );
    expect(out).toMatchObject({ ok: true, scope: "children", childCount: 0, returned: 0 });
    expect(out.sessions).toEqual([]);
  });

  it("maps an SDK error return and a throw to distinct error shapes", async () => {
    const errored = makeFakeHarness({ childrenError: "endpoint unavailable" });
    const errOut = await runTool<ErrorOutput>(
      sessionsTool(errored.client, errored.unscoped, true, TEST_LIMITS),
      { parentID: PARENT },
    );
    expect(errOut.error).toBe("Failed to list children: endpoint unavailable");

    const thrown = makeFakeHarness({ childrenThrows: true });
    const thrownOut = await runTool<ErrorOutput>(
      sessionsTool(thrown.client, thrown.unscoped, true, TEST_LIMITS),
      { parentID: PARENT },
    );
    // The existing catch yields the bare message, without the prefix —
    // intentionally consistent with how the tool treats other throws.
    expect(thrownOut.error).toBe(`children failed: ${PARENT}`);
  });

  it("sorts before slicing: newest kept, childCount is the pre-slice total", async () => {
    const now = Date.now();
    const h = makeFakeHarness({
      children: {
        [PARENT]: [
          session("ses-old", "Oldest", PROJECT_DIR, now - 3_000, undefined, PARENT),
          session("ses-new", "Newest", PROJECT_DIR, now - 1_000, undefined, PARENT),
          session("ses-mid", "Middle", PROJECT_DIR, now - 2_000, undefined, PARENT),
        ],
      },
    });
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, true, TEST_LIMITS),
      { parentID: PARENT, limit: 2 },
    );
    expect(out.sessions.map((s) => s.id)).toEqual(["ses-new", "ses-mid"]);
    expect(out.childCount).toBe(3);
    expect(out.returned).toBe(2);
  });

  it("excludes grandchildren (direct-child contract) and summarizer workers", async () => {
    const now = Date.now();
    const h = makeFakeHarness({
      children: {
        [PARENT]: [
          session("ses-direct", "Direct child", PROJECT_DIR, now - 1_000, undefined, PARENT),
          // The endpoint may return full descendants; a grandchild's parentID
          // is its own parent, not the resolved one.
          session("ses-grandchild", "Grandchild", PROJECT_DIR, now - 500, undefined, "ses-direct"),
          session(
            "ses-worker",
            "[recall-summarizer] worker",
            PROJECT_DIR,
            now - 200,
            undefined,
            PARENT,
          ),
        ],
      },
    });
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, true, TEST_LIMITS),
      { parentID: PARENT },
    );
    expect(out.sessions.map((s) => s.id)).toEqual(["ses-direct"]);
    expect(out.childCount).toBe(1);
  });

  it("applies search (case-insensitive) and since/until post-filters", async () => {
    const now = Date.now();
    const h = makeFakeHarness({
      children: {
        [PARENT]: [
          session(
            "ses-batch-a",
            "Fix Batch A findings",
            PROJECT_DIR,
            now - 3 * 3600_000,
            undefined,
            PARENT,
          ),
          session(
            "ses-batch-b",
            "Fix Batch B findings",
            PROJECT_DIR,
            now - 1_000,
            undefined,
            PARENT,
          ),
          session("ses-misc", "Unrelated child", PROJECT_DIR, now - 2_000, undefined, PARENT),
        ],
      },
    });
    const tool = sessionsTool(h.client, h.unscoped, true, TEST_LIMITS);

    const bySearch = await runTool<SessionsOutput>(tool, { parentID: PARENT, search: "batch" });
    expect(bySearch.sessions.map((s) => s.id)).toEqual(["ses-batch-b", "ses-batch-a"]);

    const bySince = await runTool<SessionsOutput>(tool, { parentID: PARENT, since: "1h" });
    expect(bySince.sessions.map((s) => s.id)).toEqual(["ses-batch-b", "ses-misc"]);

    const byUntil = await runTool<SessionsOutput>(tool, { parentID: PARENT, until: "1h" });
    expect(byUntil.sessions.map((s) => s.id)).toEqual(["ses-batch-a"]);
    expect(byUntil.childCount).toBe(1);
  });

  it("marks undistilled and metadata-only children with distilled:false, full cards omit it", async () => {
    const now = Date.now();
    const fullChild = session(
      "ses-full",
      "Fully distilled child",
      PROJECT_DIR,
      now - 1_000,
      undefined,
      PARENT,
    );
    const emptyChild = session(
      "ses-empty",
      "Distilled empty child",
      PROJECT_DIR,
      now - 2_000,
      undefined,
      PARENT,
    );
    const freshChild = session(
      "ses-fresh",
      "Uncarded fresh child",
      PROJECT_DIR,
      now - 500,
      undefined,
      PARENT,
    );
    const h = makeFakeHarness({
      children: { [PARENT]: [fullChild, emptyChild, freshChild] },
    });
    // Seed cards for the full and empty children (not the fresh one). The
    // empty child has zero messages: distillState "full", distilledThrough
    // null — decision 5 keys on distillState, so it must NOT be marked.
    h.globalSessions.push(globalSessionFrom(fullChild), globalSessionFrom(emptyChild));
    h.messagesBySession[fullChild.id] = [
      bundle(userMessage("m-full-1", fullChild.id, now - 1_500), [
        textPart("p-full-1", fullChild.id, "m-full-1", "child work notes on batching"),
      ]),
    ];
    const { store, cleanup } = await makeRecallDeps(h);
    try {
      const enrichment = { cards: () => store.allCards() };
      const out = await runTool<SessionsOutput>(
        sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, enrichment),
        { parentID: PARENT },
      );
      const byId = new Map(out.sessions.map((s) => [s.id, s]));
      expect(byId.get("ses-fresh")?.distilled).toBe(false);
      expect("distilled" in byId.get("ses-full")!).toBe(false);
      expect("distilled" in byId.get("ses-empty")!).toBe(false);
      // The full child is enriched from its card.
      expect(byId.get("ses-full")?.digest).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("marks metadata-only cards (cards-lite) distilled:false", async () => {
    const now = Date.now();
    const child = session(
      "ses-lite",
      "Cards-lite child",
      PROJECT_DIR,
      now - 1_000,
      undefined,
      PARENT,
    );
    const h = makeFakeHarness({ children: { [PARENT]: [child] } });
    const enrichment = { cards: () => cardsLiteFromSessions([child]) };
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, enrichment),
      { parentID: PARENT },
    );
    expect(out.sessions[0]?.distilled).toBe(false);
  });

  it("marks every child distilled:false in degraded mode (no enrichment)", async () => {
    const now = Date.now();
    const h = makeFakeHarness({
      children: {
        [PARENT]: [
          session("ses-a", "Child A", PROJECT_DIR, now - 1_000, undefined, PARENT),
          session("ses-b", "Child B", PROJECT_DIR, now - 2_000, undefined, PARENT),
        ],
      },
    });
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, true, TEST_LIMITS),
      { parentID: PARENT },
    );
    expect(out.sessions).toHaveLength(2);
    expect(out.sessions.every((s) => s.distilled === false)).toBe(true);
  });

  it("never emits a distilled key on ordinary listings (warm and cards-lite)", async () => {
    const h = makeFakeHarness();
    const { store, cleanup } = await makeRecallDeps(h);
    try {
      const warm = await runTool<SessionsOutput>(
        sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, { cards: () => store.allCards() }),
        { scope: "global" },
      );
      expect(warm.sessions.length).toBeGreaterThan(0);
      expect(warm.sessions.every((s) => !("distilled" in s))).toBe(true);
      expect(warm.parentID).toBeUndefined();
      expect(warm.childCount).toBeUndefined();

      const lite = await runTool<SessionsOutput>(
        sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, {
          cards: () => cardsLiteFromSessions(h.globalSessions),
        }),
        { scope: "global" },
      );
      expect(lite.sessions.length).toBeGreaterThan(0);
      expect(lite.sessions.every((s) => !("distilled" in s))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("withholds foreign-project children of explicit foreign parents under global:false", async () => {
    const now = Date.now();
    const h = makeFakeHarness({
      children: {
        [PARENT]: [
          session("ses-here", "In-project child", PROJECT_DIR, now - 1_000, undefined, PARENT),
          session("ses-elsewhere", "Foreign child", OTHER_DIR, now - 500, undefined, PARENT),
        ],
      },
    });
    // PARENT is not the caller's session, so decision 2's withholding applies.
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, false, TEST_LIMITS),
      { parentID: PARENT },
    );
    expect(out.sessions.map((s) => s.id)).toEqual(["ses-here"]);
    expect(out.childCount).toBe(1);
    expect(out.note).toMatch(/1 child session .*withheld/);
  });

  it("sorts equal-timestamp children by id ascending (deterministic tie-break)", async () => {
    const now = Date.now();
    const tied = now - 1_000;
    const h = makeFakeHarness({
      children: {
        // Input order deliberately inverted: a stable sort with no tie-break
        // would keep it, so the assertion distinguishes the id comparator.
        [PARENT]: [
          session("ses-tie-b", "Tie B", PROJECT_DIR, tied, undefined, PARENT),
          session("ses-tie-a", "Tie A", PROJECT_DIR, tied, undefined, PARENT),
        ],
      },
    });
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, true, TEST_LIMITS),
      { parentID: PARENT },
    );
    expect(out.sessions.map((s) => s.id)).toEqual(["ses-tie-a", "ses-tie-b"]);
  });

  it('exempts the caller\'s own children ("current") from global:false withholding', async () => {
    const now = Date.now();
    const h = makeFakeHarness({
      children: {
        "s-current": [
          session(
            "ses-worktree",
            "Child in another worktree",
            OTHER_DIR,
            now - 500,
            undefined,
            "s-current",
          ),
        ],
      },
    });
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, false, TEST_LIMITS),
      { parentID: "current" },
    );
    expect(out.sessions.map((s) => s.id)).toEqual(["ses-worktree"]);
    expect(out.note).toBeUndefined();
  });

  it("exempts an explicit parentID equal to ctx.sessionID (resolved-ID exemption)", async () => {
    // Decision 2: the exemption keys on the RESOLVED parent, not the "current"
    // literal — an explicit ID that equals ctx.sessionID is equally the
    // caller's own session, and its children are exempt from withholding.
    const now = Date.now();
    const h = makeFakeHarness({
      children: {
        "s-current": [
          session(
            "ses-worktree",
            "Child in another worktree",
            OTHER_DIR,
            now - 500,
            undefined,
            "s-current",
          ),
        ],
      },
    });
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, false, TEST_LIMITS),
      { parentID: "s-current" },
    );
    expect(out.sessions.map((s) => s.id)).toEqual(["ses-worktree"]);
    expect(out.note).toBeUndefined();
  });

  it("withholds nothing for a foreign parent when global:true (the global disjunct)", async () => {
    const now = Date.now();
    const h = makeFakeHarness({
      children: {
        [PARENT]: [
          session("ses-elsewhere", "Foreign child", OTHER_DIR, now - 500, undefined, PARENT),
        ],
      },
    });
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, true, TEST_LIMITS),
      { parentID: PARENT },
    );
    expect(out.sessions.map((s) => s.id)).toEqual(["ses-elsewhere"]);
    expect(out.childCount).toBe(1);
    expect(out.note).toBeUndefined();
  });

  it("counts only otherwise-passing rows as withheld (filter order)", async () => {
    // A foreign row that already fails an earlier filter (summarizer, search,
    // time) is excluded, not withheld — the note must not inflate the count.
    const now = Date.now();
    const h = makeFakeHarness({
      children: {
        [PARENT]: [
          session("ses-foreign", "Foreign child", OTHER_DIR, now - 500, undefined, PARENT),
          session(
            "ses-foreign-worker",
            "[recall-summarizer] worker",
            OTHER_DIR,
            now - 400,
            undefined,
            PARENT,
          ),
          session(
            "ses-foreign-old",
            "Foreign old child",
            OTHER_DIR,
            now - 3 * 3600_000,
            undefined,
            PARENT,
          ),
        ],
      },
    });
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, false, TEST_LIMITS),
      { parentID: PARENT, since: "1h" },
    );
    expect(out.sessions).toEqual([]);
    expect(out.childCount).toBe(0);
    // Only ses-foreign passed the summarizer and time filters to reach the
    // scope check; singular wording pins the exact count.
    expect(out.note).toMatch(/^1 child session in other projects was withheld/);
  });

  it("withholds nothing under global:false when the caller has no directory", async () => {
    const now = Date.now();
    const h = makeFakeHarness({
      children: {
        [PARENT]: [
          session("ses-foreign", "Foreign child", OTHER_DIR, now - 500, undefined, PARENT),
        ],
      },
    });
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, false, TEST_LIMITS),
      { parentID: PARENT },
      makeContext({ directory: undefined }).ctx,
    );
    // Documented edge: with no caller directory there is no scope basis.
    expect(out.sessions.map((s) => s.id)).toEqual(["ses-foreign"]);
    expect(out.note).toBeUndefined();
  });

  it("survives the raw host path: parentID:'current' alone, and a non-string degrade", async () => {
    const now = Date.now();
    const h = makeFakeHarness({
      children: {
        "s-current": [
          session("ses-raw", "Raw child", PROJECT_DIR, now - 500, undefined, "s-current"),
        ],
      },
    });
    const tool = sessionsTool(h.client, h.unscoped, true, TEST_LIMITS);

    // All other args omitted — every default must be applied defensively.
    const out = await runToolRaw<SessionsOutput>(tool, { parentID: "current" });
    expect(out).toMatchObject({ ok: true, scope: "children", parentID: "s-current" });
    expect(out.sessions.map((s) => s.id)).toEqual(["ses-raw"]);

    // A raw non-string parentID degrades to an ordinary listing, detectable
    // because scope is not "children" (decision 3).
    const degraded = await runToolRaw<SessionsOutput>(tool, { parentID: 42 });
    expect(degraded.ok).toBe(true);
    expect(degraded.scope).toBe("project");
    expect(degraded.parentID).toBeUndefined();

    // Blank and whitespace-only strings trim to unset (optionalString) and
    // degrade the same way.
    for (const blank of ["", "   "]) {
      const out2 = await runToolRaw<SessionsOutput>(tool, { parentID: blank });
      expect(out2.ok).toBe(true);
      expect(out2.scope).toBe("project");
      expect(out2.parentID).toBeUndefined();
    }
  });
});

describe("recall_sessions staleness fallback", () => {
  it("falls through to the live list when since is newer than every in-scope card", async () => {
    const now = Date.now();
    const h = makeFakeHarness();
    // Age the whole fixture: all carded sessions are 3 days old.
    for (const s of [...h.sessions, ...h.globalSessions]) {
      s.time.updated = now - 3 * 24 * 3600_000;
    }
    const { store, cleanup } = await makeRecallDeps(h);
    try {
      // A fresh session appears AFTER the store was seeded — live-visible,
      // uncarded. Exactly the incident shape.
      const fresh = session("ses-fresh", "Fresh subagent session", PROJECT_DIR, now - 60_000);
      h.sessions.push(fresh);
      const enrichment = { cards: () => store.allCards() };
      const out = await runTool<SessionsOutput>(
        sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, enrichment),
        { since: "1h" },
      );
      // The live list was consulted (the card answer would have been empty).
      expect(h.calls.projectList).toHaveLength(1);
      expect(out.sessions.map((s) => s.id)).toContain("ses-fresh");
      // The note discloses both the lag and the newest-limit bound.
      expect(out.note).toMatch(/index had not caught up/i);
      expect(out.note).toMatch(/newest \d+ live sessions/);
      // The uncarded row is marked; carded rows would omit the field.
      expect(out.sessions.find((s) => s.id === "ses-fresh")?.distilled).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("does not claim index lag when the live check also finds the window empty", async () => {
    const now = Date.now();
    const h = makeFakeHarness();
    // Everything — cards AND live rows — is 3 days old: the fallback fires
    // (watermark < since) but the live list confirms a genuinely quiet window.
    for (const s of [...h.sessions, ...h.globalSessions]) {
      s.time.updated = now - 3 * 24 * 3600_000;
    }
    const { store, cleanup } = await makeRecallDeps(h);
    try {
      const enrichment = { cards: () => store.allCards() };
      const out = await runTool<SessionsOutput>(
        sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, enrichment),
        { since: "1h" },
      );
      expect(h.calls.projectList).toHaveLength(1);
      expect(out.sessions).toEqual([]);
      // Honest empty-window note: the live check confirmed a quiet window, so
      // the note must state the fact (nothing indexed is newer) without the
      // causal lag diagnosis or any "recent sessions may be missing" steer.
      expect(out.note).toMatch(/none fell in the window/);
      expect(out.note).toMatch(/newest \d+ live sessions/);
      expect(out.note).not.toMatch(/had not caught up|may be missing/);
    } finally {
      cleanup();
    }
  });

  it("says 'matching' in the fallback note bound when a search narrowed the list call", async () => {
    const now = Date.now();
    const h = makeFakeHarness();
    for (const s of [...h.sessions, ...h.globalSessions]) {
      s.time.updated = now - 3 * 24 * 3600_000;
    }
    const { store, cleanup } = await makeRecallDeps(h);
    try {
      const fresh = session("ses-fresh", "Fresh debugging session", PROJECT_DIR, now - 60_000);
      h.sessions.push(fresh);
      const enrichment = { cards: () => store.allCards() };
      const out = await runTool<SessionsOutput>(
        sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, enrichment),
        { since: "1h", search: "debugging" },
      );
      expect(out.sessions.map((s) => s.id)).toContain("ses-fresh");
      // The list call consulted the newest `limit` MATCHING sessions only.
      expect(out.note).toMatch(/newest \d+ matching live sessions/);
    } finally {
      cleanup();
    }
  });

  it("ignores summarizer cards in the watermark (a fresh worker card cannot mask lag)", async () => {
    const now = Date.now();
    const h = makeFakeHarness();
    // Real cards are stale; one fresh summarizer worker card would raise the
    // watermark past `since` if it were counted — it must not be.
    for (const s of [...h.sessions, ...h.globalSessions]) {
      s.time.updated = now - 3 * 24 * 3600_000;
    }
    const worker = session("ses-worker", "[recall-summarizer] worker", PROJECT_DIR, now - 30_000);
    h.sessions.push(worker);
    h.globalSessions.push(globalSessionFrom(worker));
    const { store, cleanup } = await makeRecallDeps(h);
    try {
      const fresh = session("ses-fresh", "Fresh subagent session", PROJECT_DIR, now - 60_000);
      h.sessions.push(fresh);
      const enrichment = { cards: () => store.allCards() };
      const out = await runTool<SessionsOutput>(
        sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, enrichment),
        { since: "1h" },
      );
      // The fallback fired despite the fresh worker card.
      expect(h.calls.projectList).toHaveLength(1);
      expect(out.sessions.map((s) => s.id)).toContain("ses-fresh");
      expect(out.note).toMatch(/index had not caught up/i);
    } finally {
      cleanup();
    }
  });

  it("keeps cards authoritative when since is older than the newest in-scope card", async () => {
    const h = makeFakeHarness();
    const { store, cleanup } = await makeRecallDeps(h);
    try {
      const enrichment = { cards: () => store.allCards() };
      // Window bounded so nothing matches, but since (2h ago) is older than the
      // fresh fixture cards — the emptiness is the caller's bounds, not lag.
      const out = await runTool<SessionsOutput>(
        sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, enrichment),
        { scope: "global", since: "2h", until: "1h" },
      );
      expect(out.sessions).toEqual([]);
      expect(h.calls.projectList).toEqual([]);
      expect(h.calls.globalList).toEqual([]);
      expect(out.note).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("does not fall back when since equals the watermark (equal is not newer)", async () => {
    const h = makeFakeHarness();
    const { store, cleanup } = await makeRecallDeps(h);
    try {
      const enrichment = { cards: () => store.allCards() };
      const watermark = Math.max(...store.allCards().map((c) => c.timeUpdated));
      // Force zero matches via a search that matches nothing; since === watermark.
      const out = await runTool<SessionsOutput>(
        sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, enrichment),
        { scope: "global", since: new Date(watermark).toISOString(), search: "no-such-title" },
      );
      expect(out.sessions).toEqual([]);
      expect(h.calls.globalList).toEqual([]);
      expect(out.note).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("uses a scope-relative watermark: a fresher foreign card does not mask project lag", async () => {
    const now = Date.now();
    const h = makeFakeHarness();
    // Project sessions are old; the OTHER_DIR session stays fresh.
    for (const s of [...h.sessions, ...h.globalSessions]) {
      if (s.directory === PROJECT_DIR) s.time.updated = now - 3 * 24 * 3600_000;
    }
    const { store, cleanup } = await makeRecallDeps(h);
    try {
      const enrichment = { cards: () => store.allCards() };
      const out = await runTool<SessionsOutput>(
        sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, enrichment),
        { scope: "project", since: "1h" },
      );
      // In-scope (project) watermark is 3 days stale even though a foreign
      // card is fresh — the fallback fires for project scope. The live check
      // finds nothing in-window, so the note carries the quiet-window wording.
      expect(h.calls.projectList).toHaveLength(1);
      expect(out.note).toMatch(/none fell in the window/);
    } finally {
      cleanup();
    }
  });

  it("treats an empty-but-present card store as watermark 0 (fallback always fires)", async () => {
    const h = makeFakeHarness();
    const enrichment = { cards: () => [] };
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, enrichment),
      { since: "1h" },
    );
    expect(h.calls.projectList).toHaveLength(1);
    expect(out.note).toMatch(/index had not caught up/i);
  });

  it("counts metadata-only cards toward the watermark (no fallback in cards-lite)", async () => {
    const h = makeFakeHarness();
    // Cards-lite: metadata-only cards with fresh fixture timestamps. A
    // full-only watermark would collapse to 0 here and fire the live list on
    // every since call — decision 8 counts ALL states, so no fallback.
    const enrichment = { cards: () => cardsLiteFromSessions(h.globalSessions) };
    const out = await runTool<SessionsOutput>(
      sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, enrichment),
      { scope: "global", since: "1h", search: "no-such-title" },
    );
    expect(out.sessions).toEqual([]);
    expect(h.calls.globalList).toEqual([]);
    expect(h.calls.projectList).toEqual([]);
    expect(out.note).toBeUndefined();
  });

  it("skips the fallback for an inverted window (since > until)", async () => {
    const now = Date.now();
    const h = makeFakeHarness();
    for (const s of [...h.sessions, ...h.globalSessions]) {
      s.time.updated = now - 3 * 24 * 3600_000;
    }
    const { store, cleanup } = await makeRecallDeps(h);
    try {
      const enrichment = { cards: () => store.allCards() };
      // since:1h is newer than until:2h — an inverted, self-empty window. The
      // emptiness is the caller's bounds even though the store is stale.
      const out = await runTool<SessionsOutput>(
        sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, enrichment),
        { since: "1h", until: "2h" },
      );
      expect(out.sessions).toEqual([]);
      expect(h.calls.projectList).toEqual([]);
      expect(out.note).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("never falls back on an until-only zero result", async () => {
    const h = makeFakeHarness();
    const { store, cleanup } = await makeRecallDeps(h);
    try {
      const enrichment = { cards: () => store.allCards() };
      // until:10w → all fixture sessions are newer → zero, and only a lower
      // bound can signal index lag.
      const out = await runTool<SessionsOutput>(
        sessionsTool(h.client, h.unscoped, true, TEST_LIMITS, enrichment),
        { scope: "global", until: "10w" },
      );
      expect(out.sessions).toEqual([]);
      expect(h.calls.globalList).toEqual([]);
      expect(out.note).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe("LLM-facing schemas", () => {
  it("reject invalid enum and capped numeric args before execute", async () => {
    const h = makeFakeHarness();
    const limits = { ...TEST_LIMITS, maxResults: 2 };
    const { deps, cleanup } = await makeRecallDeps(h, limits);
    try {
      const recall = search(h.client, h.unscoped, true, limits, deps);
      await expect(
        runTool<SearchOutput>(recall, { query: "rate", scope: "everywhere" }),
      ).rejects.toThrow();
      await expect(runTool<SearchOutput>(recall, { query: "rate", results: 3 })).rejects.toThrow();
    } finally {
      cleanup();
    }
  });
});
