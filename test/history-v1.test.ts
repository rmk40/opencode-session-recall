import { describe, expect, it } from "vitest";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { createV1HistorySource } from "../src/history/v1.js";
import { MalformedSessionError } from "../src/history/source.js";
import { makeFakeHarness, session, PROJECT_DIR } from "./helpers.js";

/** A client whose `session.get` / `session.message` return a scripted body. */
function scripted(body: unknown): OpencodeClient {
  return {
    session: {
      get: async () => body,
      message: async () => body,
    },
  } as unknown as OpencodeClient;
}

describe("v1 history source", () => {
  it("routes listings by scope and passes search and limit through", async () => {
    const h = makeFakeHarness();
    const source = createV1HistorySource({ scoped: h.client, unscoped: h.unscoped });

    const project = await source.listSessions({ scope: "project", limit: 1 });
    expect(project.ok && project.items.map((s) => s.id)).toEqual(["s-current"]);
    const global = await source.listSessions({ scope: "global", limit: 5, search: "walkthrough" });
    expect(global.ok && global.items.map((s) => s.id)).toEqual(["s-other"]);
    expect(global.ok && global.items[0]?.project?.worktree).toBe("/workspace/other");

    expect(h.calls.projectList).toEqual([{ search: undefined, limit: 1 }]);
    expect(h.calls.globalList).toEqual([{ search: "walkthrough", limit: 5 }]);
  });

  it("returns a listing error with the host's message", async () => {
    const h = makeFakeHarness({ projectListError: "list exploded" });
    const source = createV1HistorySource({ scoped: h.client, unscoped: h.unscoped });
    expect(await source.listSessions({ scope: "project", limit: 5 })).toEqual({
      ok: false,
      error: "list exploded",
    });
  });

  it("rejects a non-array listing body only under strict, in both scopes", async () => {
    for (const scope of ["project", "global"] as const) {
      const h = makeFakeHarness({ listBody: { unexpected: true } });
      const source = createV1HistorySource({ scoped: h.client, unscoped: h.unscoped });
      // Discovery (not strict) keeps v1's `Array.isArray(data) ? data : []`.
      expect(await source.listSessions({ scope, limit: 5 })).toEqual({ ok: true, items: [] });
      await expect(source.listSessions({ scope, limit: 5, strict: true })).rejects.toThrow(
        "session listing response was not an array",
      );

      const empty = makeFakeHarness({ listBody: null });
      const emptySource = createV1HistorySource({ scoped: empty.client, unscoped: empty.unscoped });
      expect(await emptySource.listSessions({ scope, limit: 5, strict: true })).toEqual({
        ok: true,
        items: [],
      });
    }
  });

  it("looks sessions up through the client for the requested scope", async () => {
    const h = makeFakeHarness({ unscopedGetThrows: new Set(["s-current"]) });
    const source = createV1HistorySource({ scoped: h.client, unscoped: h.unscoped });
    expect(source.scopedLookup).toBe(true);

    const found = await source.getSession("s-current", { scope: "project" });
    expect(found.ok && found.value.title).toBe("Current Debugging Session");
    await expect(source.getSession("s-current", { scope: "global" })).rejects.toThrow(
      "unscoped get failed",
    );
  });

  it("reports one lookup scope when both clients are the same", () => {
    const h = makeFakeHarness();
    expect(createV1HistorySource({ scoped: h.client, unscoped: h.client }).scopedLookup).toBe(
      false,
    );
  });

  it("classifies session lookup failures", async () => {
    const h = makeFakeHarness();
    const source = createV1HistorySource({ scoped: h.client, unscoped: h.unscoped });
    expect(await source.getSession("missing", { scope: "project" })).toEqual({
      ok: false,
      reason: "error",
      error: "Session not found: missing",
    });

    const lookup = (body: unknown) =>
      createV1HistorySource({ scoped: scripted(body), unscoped: scripted(body) }).getSession("s", {
        scope: "project",
      });
    expect(await lookup({ error: { name: "NotFoundError", data: { message: "gone" } } })).toEqual({
      ok: false,
      reason: "not-found",
      error: "gone",
    });
    expect(await lookup({ error: { data: { message: "x" } }, response: { status: 404 } })).toEqual({
      ok: false,
      reason: "not-found",
      error: "x",
    });
    expect(await lookup({ data: null })).toEqual({ ok: false, reason: "not-found" });
    expect(await lookup({ data: "not-an-object" })).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  it("lists children through the scoped client, tolerating a non-array body", async () => {
    const child = session("c1", "Child", PROJECT_DIR, 1_000, undefined, "s-current");
    const h = makeFakeHarness({ children: { "s-current": [child] } });
    const source = createV1HistorySource({ scoped: h.client, unscoped: h.unscoped });
    const listing = await source.listChildren("s-current");
    expect(listing.ok && listing.items.map((s) => s.id)).toEqual(["c1"]);
    expect(h.calls.children).toEqual([{ sessionID: "s-current", client: "scoped" }]);

    const odd = makeFakeHarness({ childrenNonArray: true });
    const oddSource = createV1HistorySource({ scoped: odd.client, unscoped: odd.unscoped });
    expect(await oddSource.listChildren("s-current")).toEqual({ ok: true, items: [] });

    const failed = makeFakeHarness({ childrenError: "no children for you" });
    const failedSource = createV1HistorySource({
      scoped: failed.client,
      unscoped: failed.unscoped,
    });
    expect(await failedSource.listChildren("s-current")).toEqual({
      ok: false,
      error: "no children for you",
    });
  });

  it("pages messages newest-first with the limit and cursor it was given", async () => {
    const h = makeFakeHarness();
    const source = createV1HistorySource({ scoped: h.client, unscoped: h.unscoped });
    const first = await source.messagePage({ sessionID: "s-current", limit: 4 });
    expect(first.items.map((m) => m.info.id)).toEqual([
      "m-current-6",
      "m-current-5",
      "m-current-4",
      "m-current-3",
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await source.messagePage({
      sessionID: "s-current",
      limit: 4,
      before: first.nextCursor ?? undefined,
    });
    expect(second.items.map((m) => m.info.id)).toEqual(["m-current-2", "m-current-1"]);
    expect(second.nextCursor).toBeNull();
    expect(h.calls.messages.map((c) => c.limit)).toEqual([4, 4]);
  });

  it("rejects a page request without a positive integer limit, before any fetch", async () => {
    const h = makeFakeHarness();
    const source = createV1HistorySource({ scoped: h.client, unscoped: h.unscoped });
    for (const limit of [0, -1, 1.5, Number.NaN, undefined]) {
      await expect(
        source.messagePage({ sessionID: "s-current", limit: limit as number }),
      ).rejects.toThrow("message page limit must be a positive integer");
    }
    expect(h.calls.messages).toEqual([]);
  });

  it("raises MalformedSessionError for a non-array page only under strict", async () => {
    const client = {
      session: { messages: async () => ({ data: { messages: "not-an-array" } }) },
    } as unknown as OpencodeClient;
    const source = createV1HistorySource({ scoped: client, unscoped: client });
    expect(await source.messagePage({ sessionID: "s", limit: 5 })).toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(source.messagePage({ sessionID: "s", limit: 5, strict: true })).rejects.toThrow(
      MalformedSessionError,
    );
  });

  it("classifies message lookups", async () => {
    const h = makeFakeHarness({
      messageLookupErrors: { "s-current:m-bad": "lookup exploded" },
      noSingleMessageData: new Set(["s-current:m-empty"]),
    });
    const source = createV1HistorySource({ scoped: h.client, unscoped: h.unscoped });
    const found = await source.getMessage("s-current", "m-current-1");
    expect(found.ok && found.value.info.id).toBe("m-current-1");
    expect(await source.getMessage("s-current", "m-bad")).toEqual({
      ok: false,
      reason: "error",
      error: "lookup exploded",
    });
    expect(await source.getMessage("s-current", "m-empty")).toEqual({
      ok: false,
      reason: "not-found",
    });
  });
});
