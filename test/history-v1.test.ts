import { describe, expect, it } from "vitest";
import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2";
import { createV1HistorySource, fetchMessagePage } from "../src/history/v1.js";
import { MalformedSessionError } from "../src/history/source.js";
import {
  apiFailure,
  bundle,
  makeFakeHarness,
  session,
  userMessage,
  PROJECT_DIR,
} from "./helpers.js";

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

    // One row past the limit decides `truncated`.
    expect(h.calls.projectList).toEqual([{ search: undefined, limit: 2 }]);
    expect(h.calls.globalList).toEqual([{ search: "walkthrough", limit: 6 }]);
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
      expect(await source.listSessions({ scope, limit: 5 })).toEqual({
        ok: true,
        items: [],
        truncated: false,
      });
      await expect(source.listSessions({ scope, limit: 5, strict: true })).rejects.toThrow(
        "session listing response was not an array",
      );

      const empty = makeFakeHarness({ listBody: null });
      const emptySource = createV1HistorySource({ scoped: empty.client, unscoped: empty.unscoped });
      expect(await emptySource.listSessions({ scope, limit: 5, strict: true })).toEqual({
        ok: true,
        items: [],
        truncated: false,
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
    expect(await oddSource.listChildren("s-current")).toEqual({
      ok: true,
      items: [],
      truncated: false,
    });

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

describe("v1 history source: truncation, archived sessions and continuations", () => {
  /** Clients whose listings return `rows` and record the params they got. */
  function listingClients(rows: Session[]) {
    const calls = { project: [] as unknown[], global: [] as unknown[] };
    const scoped = {
      session: {
        list: async (params: unknown) => {
          calls.project.push(params);
          return { data: rows };
        },
      },
    } as unknown as OpencodeClient;
    const unscoped = {
      experimental: {
        session: {
          list: async (params: unknown) => {
            calls.global.push(params);
            return { data: rows };
          },
        },
      },
    } as unknown as OpencodeClient;
    return { source: createV1HistorySource({ scoped, unscoped }), calls };
  }

  it("asks for one row past the limit and cuts it off as truncated", async () => {
    const h = makeFakeHarness();
    const source = createV1HistorySource({ scoped: h.client, unscoped: h.unscoped });
    // The fixture's project listing holds two sessions, its global one three.
    const one = await source.listSessions({ scope: "project", limit: 1 });
    expect(one).toMatchObject({ ok: true, truncated: true });
    expect(one.ok && one.items.map((s) => s.id)).toEqual(["s-current"]);
    const both = await source.listSessions({ scope: "project", limit: 2 });
    expect(both).toMatchObject({ ok: true, truncated: false });
    expect(both.ok && both.items).toHaveLength(2);
    const global = await source.listSessions({ scope: "global", limit: 2 });
    expect(global).toMatchObject({ ok: true, truncated: true });
    expect(global.ok && global.items).toHaveLength(2);
    expect(h.calls.projectList.map((c) => c.limit)).toEqual([2, 3]);
    expect(h.calls.globalList.map((c) => c.limit)).toEqual([3]);
  });

  it("fails an id-order listing or a cursor without calling the host", async () => {
    const h = makeFakeHarness();
    const source = createV1HistorySource({ scoped: h.client, unscoped: h.unscoped });
    for (const scope of ["project", "global"] as const) {
      expect(await source.listSessions({ scope, limit: 5, order: "id" })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/id order/),
      });
      expect(await source.listSessions({ scope, limit: 5, after: "s-current" })).toMatchObject({
        ok: false,
      });
    }
    // A recency listing is still served.
    expect(
      await source.listSessions({ scope: "project", limit: 5, order: "recent" }),
    ).toMatchObject({
      ok: true,
    });
    expect(h.calls.projectList).toHaveLength(1);
    expect(h.calls.globalList).toEqual([]);
  });

  it("asks the global endpoint for archived sessions only when they are included", async () => {
    const { source, calls } = listingClients([]);
    await source.listSessions({ scope: "global", limit: 5 });
    await source.listSessions({ scope: "global", limit: 5, archived: "exclude" });
    await source.listSessions({ scope: "global", limit: 5, archived: "include", search: "x" });
    expect(calls.global).toEqual([
      { limit: 6 },
      { limit: 6 },
      { search: "x", limit: 6, archived: true },
    ]);
    // The project endpoint takes no archived parameter.
    await source.listSessions({ scope: "project", limit: 5, archived: "include" });
    expect(calls.project).toEqual([{ limit: 6 }]);
  });

  it("drops archived sessions from a project listing only on exclude", async () => {
    const live = session("s-live", "Live", PROJECT_DIR, 2_000);
    const archived = session("s-arch", "Archived", PROJECT_DIR, 1_500, 1_800);
    const { source } = listingClients([live, archived]);
    const list = async (o: { archived?: "include" | "exclude" }) => {
      const listing = await source.listSessions({ scope: "project", limit: 5, ...o });
      return listing.ok && listing.items.map((s) => s.id);
    };
    expect(await list({})).toEqual(["s-live", "s-arch"]);
    expect(await list({ archived: "include" })).toEqual(["s-live", "s-arch"]);
    expect(await list({ archived: "exclude" })).toEqual(["s-live"]);
  });

  it("drops archived sessions before cutting to the limit, truncated while the host had more", async () => {
    const archived = session("s-arch", "Archived", PROJECT_DIR, 2_000, 2_100);
    const live = session("s-live", "Live", PROJECT_DIR, 1_500);
    const { source, calls } = listingClients([archived, live]);
    // The host returned the extra row, so more live sessions may follow.
    expect(await source.listSessions({ scope: "project", limit: 1, archived: "exclude" })).toEqual({
      ok: true,
      items: [live],
      truncated: true,
    });
    expect(calls.project).toEqual([{ limit: 2 }]);
    // Within the limit, the listing is complete.
    expect(await source.listSessions({ scope: "project", limit: 2, archived: "exclude" })).toEqual({
      ok: true,
      items: [live],
      truncated: false,
    });
  });

  it("keeps rows of the wrong shape instead of throwing while excluding archived ones", async () => {
    const live = session("s-live", "Live", PROJECT_DIR, 1_500);
    const odd = [{ id: "no-time" }, null, { id: "bad-time", time: 5 }] as unknown as Session[];
    const { source } = listingClients([...odd, live]);
    const listing = await source.listSessions({ scope: "project", limit: 10, archived: "exclude" });
    expect(listing).toEqual({ ok: true, items: [...odd, live], truncated: false });
  });

  it("returns every child at once, never truncated, whatever the paging options", async () => {
    const kids = [
      session("c1", "One", PROJECT_DIR, 1_000, undefined, "s-current"),
      session("c2", "Two", PROJECT_DIR, 2_000, 2_500, "s-current"),
      session("c3", "Three", PROJECT_DIR, 3_000, undefined, "s-current"),
    ];
    const h = makeFakeHarness({ children: { "s-current": kids } });
    const source = createV1HistorySource({ scoped: h.client, unscoped: h.unscoped });
    const listed = await source.listChildren("s-current", { limit: 1, order: "id", after: "c1" });
    expect(listed).toEqual({ ok: true, items: kids, truncated: false });
    const live = await source.listChildren("s-current", { archived: "exclude" });
    expect(live).toEqual({ ok: true, items: [kids[0], kids[2]], truncated: false });
  });

  it("answers a part continuation as unsupported without calling the host", async () => {
    const h = makeFakeHarness();
    const source = createV1HistorySource({ scoped: h.client, unscoped: h.unscoped });
    for (const partOrdinal of [0, 3]) {
      expect(await source.getMessage("s-current", "m-current-2", { partOrdinal })).toEqual({
        ok: false,
        reason: "unsupported",
        error: expect.any(String),
      });
    }
    expect(h.calls.message).toEqual([]);
    const whole = await source.getMessage("s-current", "m-current-2", {});
    expect(whole.ok && whole.value.partial).toBeUndefined();
  });
});

// ── fetchMessagePage ─────────────────────────────────────────────────────────

describe("fetchMessagePage", () => {
  function clientReturning(
    impl: (p: { sessionID: string; limit?: number; before?: string }) => unknown,
  ): {
    client: OpencodeClient;
    calls: Array<{ sessionID: string; limit?: number; before?: string }>;
  } {
    const calls: Array<{ sessionID: string; limit?: number; before?: string }> = [];
    const client = {
      session: {
        messages: async (p: { sessionID: string; limit?: number; before?: string }) => {
          calls.push(p);
          return impl(p);
        },
      },
    } as unknown as OpencodeClient;
    return { client, calls };
  }

  it("always sends limit and returns items plus the X-Next-Cursor value", async () => {
    const { client, calls } = clientReturning(() => ({
      data: [bundle(userMessage("m1", "s1", 1), [])],
      response: { headers: new Headers({ "X-Next-Cursor": "CUR1" }) },
    }));
    const page = await fetchMessagePage(client, { sessionID: "s1", limit: 50 });
    expect(calls[0]!.limit).toBe(50);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe("CUR1");
  });

  it("reads the cursor header case-insensitively", async () => {
    const { client } = clientReturning(() => ({
      data: [],
      response: { headers: new Headers({ "x-next-cursor": "lower" }) },
    }));
    expect((await fetchMessagePage(client, { sessionID: "s", limit: 10 })).nextCursor).toBe(
      "lower",
    );
  });

  it("is null-safe on missing response, headers, or header", async () => {
    const noResponse = clientReturning(() => ({ data: [] })).client;
    expect(
      (await fetchMessagePage(noResponse, { sessionID: "s", limit: 5 })).nextCursor,
    ).toBeNull();
    const noHeaders = clientReturning(() => ({ data: [], response: {} })).client;
    expect((await fetchMessagePage(noHeaders, { sessionID: "s", limit: 5 })).nextCursor).toBeNull();
    const noCursor = clientReturning(() => ({
      data: [],
      response: { headers: new Headers() },
    })).client;
    expect((await fetchMessagePage(noCursor, { sessionID: "s", limit: 5 })).nextCursor).toBeNull();
  });

  it("sends before only when provided", async () => {
    const { client, calls } = clientReturning(() => ({
      data: [],
      response: { headers: new Headers() },
    }));
    await fetchMessagePage(client, { sessionID: "s", limit: 25 });
    expect("before" in calls[0]!).toBe(false);
    await fetchMessagePage(client, { sessionID: "s", limit: 25, before: "cur" });
    expect(calls[1]!.before).toBe("cur");
  });

  it("rejects a limit that is not a positive integer, before any request", async () => {
    const { client, calls } = clientReturning(() => ({ data: [] }));
    for (const limit of [0, -1, 1.5, Number.NaN, undefined]) {
      await expect(
        fetchMessagePage(client, { sessionID: "s", limit: limit as number }),
      ).rejects.toThrow("message page limit must be a positive integer");
    }
    expect(calls).toEqual([]);
  });

  it("throws on an SDK error", async () => {
    const { client } = clientReturning(() => ({ error: apiFailure("boom") }));
    await expect(fetchMessagePage(client, { sessionID: "s", limit: 5 })).rejects.toThrow("boom");
  });

  it("treats a successful non-array body as an empty page by default (query path)", async () => {
    // Documented decision: a `{}` response (no data field) means "empty page,
    // ok:true" for recall_messages/recall_context/recall_get/drill. Only the
    // distiller opts into strict (below) so its quarantine can distinguish
    // malformed from empty.
    const { client } = clientReturning(() => ({}));
    const page = await fetchMessagePage(client, { sessionID: "s", limit: 5 });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("throws MalformedSessionError on a successful non-array body under strict", async () => {
    const { client } = clientReturning(() => ({ data: { messages: "not-an-array" } }));
    await expect(
      fetchMessagePage(client, { sessionID: "s", limit: 5, strict: true }),
    ).rejects.toThrow("successful message response was not an array");
  });
});
