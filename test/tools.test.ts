import { describe, expect, it } from "vitest";
import { context as contextTool } from "../src/context.js";
import { get as getTool } from "../src/get.js";
import { messages as messagesTool } from "../src/messages.js";
import { search } from "../src/search.js";
import { sessions as sessionsTool } from "../src/sessions.js";
import type {
  ContextOutput,
  ErrorOutput,
  MessageOutput,
  MessagesOutput,
  SearchOutput,
  SessionsOutput,
} from "../src/types.js";
import { TEST_LIMITS, makeContext, makeFakeHarness, runTool, runToolRaw } from "./helpers.js";

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
  it("browses current-session messages chronologically with pagination", async () => {
    const h = makeFakeHarness();
    const out = await runTool<MessagesOutput>(messagesTool(h.client, TEST_LIMITS), {
      limit: 2,
    });

    expect(out.messages.map((m) => m.message.id)).toEqual(["m-current-1", "m-current-2"]);
    expect(out.pagination).toEqual({
      offset: 0,
      returned: 2,
      total: 6,
      hasMore: true,
    });
    expect(out.context.sessionTitle).toBe("Current Debugging Session");
  });

  it("supports reverse offset semantics and role/query filters", async () => {
    const h = makeFakeHarness();
    const tool = messagesTool(h.client, TEST_LIMITS);

    const reverse = await runTool<MessagesOutput>(tool, {
      reverse: true,
      offset: 1,
      limit: 1,
    });
    expect(reverse.messages.map((m) => m.message.id)).toEqual(["m-current-5"]);

    const filtered = await runTool<MessagesOutput>(tool, {
      role: "user",
      query: "checkout",
      limit: 10,
    });
    expect(filtered.messages.map((m) => m.message.id)).toEqual(["m-current-1"]);
    expect(filtered.pagination.total).toBe(1);
  });

  it("normalizes blank query and handles missing/error/no-data sessions", async () => {
    const blank = makeFakeHarness();
    const blankOut = await runTool<MessagesOutput>(messagesTool(blank.client, TEST_LIMITS), {
      query: "   ",
      limit: 50,
    });
    expect(blankOut.pagination.total).toBe(6);

    const missing = await runTool<ErrorOutput>(
      messagesTool(blank.client, TEST_LIMITS),
      {},
      makeContext({ sessionID: "" }).ctx,
    );
    expect(missing.error).toContain("No sessionID provided");

    const errored = makeFakeHarness({
      messageErrors: { "s-current": "Unauthorized" },
    });
    const errorOut = await runTool<ErrorOutput>(messagesTool(errored.client, TEST_LIMITS), {});
    expect(errorOut.error).toContain("Unauthorized");

    const noData = makeFakeHarness({ noMessageData: new Set(["s-current"]) });
    const noDataOut = await runTool<ErrorOutput>(messagesTool(noData.client, TEST_LIMITS), {});
    expect(noDataOut.error).toBe("No messages returned");
  });

  it("survives raw MCP-bypass args (undefined role/limit/offset/reverse must not filter everything)", async () => {
    // The live MCP host can forward args that skip Zod defaults. With role
    // undefined, the old code did `role !== "all"` → true → filtered everything
    // out, returning total:0 on a non-empty session. Coercion must restore the
    // defaults. runToolRaw bypasses Zod exactly like the MCP host.
    const h = makeFakeHarness();
    const out = await runToolRaw<MessagesOutput>(messagesTool(h.client, TEST_LIMITS), {
      sessionID: "s-current",
    });
    expect(out.ok).toBe(true);
    expect(out.pagination.total).toBe(6);
    expect(out.pagination.returned).toBeGreaterThan(0);
    expect(out.pagination.offset).toBe(0);
  });
});

describe("recall_get", () => {
  it("returns formatted full messages with model, pruned, and tool-state details", async () => {
    const h = makeFakeHarness();
    const tool = getTool(h.client);

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
    const notFound = await runTool<ErrorOutput>(getTool(h.client), {
      sessionID: "s-current",
      messageID: "missing",
    });
    expect(notFound.error).toBe("Message not found: missing");

    const noData = makeFakeHarness({
      noSingleMessageData: new Set(["s-current:m-current-1"]),
    });
    const noDataOut = await runTool<ErrorOutput>(getTool(noData.client), {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    expect(noDataOut.error).toBe("Message not found: m-current-1");

    const errored = makeFakeHarness({
      messageLookupErrors: { "s-current:m-current-1": "message API failed" },
    });
    const errorOut = await runTool<ErrorOutput>(getTool(errored.client), {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    expect(errorOut.error).toContain("message API failed");

    const noContext = makeFakeHarness({ getThrows: new Set(["s-current"]) });
    const ok = await runTool<MessageOutput>(getTool(noContext.client), {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    expect(ok.ok).toBe(true);
    expect(ok.context.sessionTitle).toBeUndefined();
    expect(ok.context.directory).toBeUndefined();
  });
});

describe("recall_context", () => {
  it("returns centered windows, window:0, and asymmetric before/after slices", async () => {
    const h = makeFakeHarness();
    const tool = contextTool(h.client, TEST_LIMITS);

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
    const tool = contextTool(h.client, TEST_LIMITS);

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
    const notFound = await runTool<ErrorOutput>(contextTool(h.client, TEST_LIMITS), {
      sessionID: "s-current",
      messageID: "missing",
    });
    expect(notFound.error).toBe("Message not found: missing");

    const errored = makeFakeHarness({
      messageErrors: { "s-current": "Unauthorized" },
    });
    const errorOut = await runTool<ErrorOutput>(contextTool(errored.client, TEST_LIMITS), {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    expect(errorOut.error).toContain("Unauthorized");

    const noData = makeFakeHarness({ noMessageData: new Set(["s-current"]) });
    const noDataOut = await runTool<ErrorOutput>(contextTool(noData.client, TEST_LIMITS), {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    expect(noDataOut.error).toBe("No messages returned");
  });

  it("survives raw MCP-bypass args (undefined window must not break slice bounds)", async () => {
    const h = makeFakeHarness();
    const out = await runToolRaw<ContextOutput>(contextTool(h.client, TEST_LIMITS), {
      sessionID: "s-current",
      messageID: "m-current-3",
    });
    expect(out.ok).toBe(true);
    expect(out.messages.length).toBeGreaterThan(0);
    expect(out.messages.some((m) => m.center)).toBe(true);
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
});

describe("LLM-facing schemas", () => {
  it("reject invalid enum and capped numeric args before execute", async () => {
    const h = makeFakeHarness();
    const recall = search(h.client, h.unscoped, true, {
      ...TEST_LIMITS,
      maxResults: 2,
    });

    await expect(
      runTool<SearchOutput>(recall, { query: "rate", scope: "everywhere" }),
    ).rejects.toThrow();
    await expect(runTool<SearchOutput>(recall, { query: "rate", results: 3 })).rejects.toThrow();
  });
});
