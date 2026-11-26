import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { context as contextTool } from "../src/context.js";
import { get as getTool } from "../src/get.js";
import { messages as messagesTool } from "../src/messages.js";
import { search } from "../src/search.js";
import { sessions as sessionsTool } from "../src/sessions.js";
import { createFetchGate, type FetchGate } from "../src/fetch-gate.js";
import { cardsLiteFromSessions } from "../src/cards.js";
import { decodeMessagesCursor, encodeContinuation } from "../src/output.js";
import { createUnavailableSource, type HistorySource } from "../src/history/source.js";
import { createV2HistorySource, openOpencodeDb, type V2SourceOptions } from "../src/history/v2.js";
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
  assistantMessage,
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
  type FakeHarness,
} from "./helpers.js";
import { insertMessage, insertProject, insertSession, limitSpy, makeV2Db } from "./v2-db.js";

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
    const out = await runTool<SessionsOutput>(sessionsTool(h.source, true, TEST_LIMITS), {});

    expect(out).toMatchObject({ ok: true, returned: 2, scope: "project" });
    expect(out.sessions.map((s) => s.id)).toEqual(["s-current", "s-project-2"]);
    // The tool reads one session past its page, to start the next page's
    // cursor there, and the source one row past that to decide `truncated`.
    expect(h.calls.projectList).toEqual([{ search: undefined, limit: 22 }]);
  });

  it("pins the fake's deliberate divergence: its global listing includes an archived session", async () => {
    // The real v1 server's listGlobal hides archived sessions; this fixture
    // does not, and the tests above rely on that. If the fake changes, they
    // need revisiting.
    const h = makeFakeHarness();
    const listing = await h.source.listSessions({ scope: "global", limit: 20 });
    const archived = listing.ok ? listing.items.find((s) => s.id === "s-project-2") : undefined;
    expect(archived?.time.archived).toEqual(expect.any(Number));
  });

  it("lists global sessions, normalizes blank search, and exposes archived/project metadata", async () => {
    // The fake's global list includes an archived session, which the real v1
    // server's `listGlobal` would hide; this checks the tool's mapping only.
    const h = makeFakeHarness();
    const out = await runTool<SessionsOutput>(sessionsTool(h.source, true, TEST_LIMITS), {
      scope: "global",
      search: "   ",
    });

    expect(h.calls.globalList).toEqual([{ search: undefined, limit: 22 }]);
    expect(out.sessions.map((s) => s.id)).toEqual(["s-other", "s-current", "s-project-2"]);
    expect(out.sessions.find((s) => s.id === "s-project-2")?.archived).toBe(true);
    expect(out.sessions.find((s) => s.id === "s-other")?.project?.name).toBe("other");
  });

  it("filters titles and handles disabled global/list errors", async () => {
    const filtered = makeFakeHarness();
    const match = await runTool<SessionsOutput>(sessionsTool(filtered.source, true, TEST_LIMITS), {
      search: "Checkout",
    });
    expect(match.sessions.map((s) => s.id)).toEqual(["s-project-2"]);

    const disabled = await runTool<ErrorOutput>(sessionsTool(filtered.source, false, TEST_LIMITS), {
      scope: "global",
    });
    expect(disabled.error).toContain("Global scope disabled");

    const errored = makeFakeHarness({
      projectListError: "database unavailable",
    });
    const out = await runTool<ErrorOutput>(sessionsTool(errored.source, true, TEST_LIMITS), {});
    expect(out.error).toContain("Failed to list sessions: database unavailable");
  });

  it("reports a non-array listing body as an error in both scopes (v1 behavior)", async () => {
    // v1 iterated the body with for-of, so a truthy non-array threw and the
    // tool's outer catch returned it bare (no "Failed to list sessions" prefix).
    for (const scope of ["project", "global"] as const) {
      const h = makeFakeHarness({ listBody: { unexpected: true } });
      const out = await runTool<ErrorOutput>(sessionsTool(h.source, true, TEST_LIMITS), { scope });
      expect(out).toEqual({ ok: false, error: "session listing response was not an array" });
    }
  });

  it("treats an absent listing body as an empty listing in both scopes", async () => {
    for (const scope of ["project", "global"] as const) {
      const h = makeFakeHarness({ listBody: undefined });
      const out = await runTool<SessionsOutput>(sessionsTool(h.source, true, TEST_LIMITS), {
        scope,
      });
      expect(out).toMatchObject({ ok: true, returned: 0, sessions: [] });
    }
  });
});

describe("recall_messages", () => {
  it("returns one bounded newest-first page with a continuation cursor", async () => {
    const h = makeFakeHarness();
    const tool = messagesTool(h.source, gate, TEST_LIMITS);
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
    const filtered = await runTool<MessagesOutput>(messagesTool(h.source, gate, TEST_LIMITS), {
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
    const blankOut = await runTool<MessagesOutput>(messagesTool(blank.source, gate, TEST_LIMITS), {
      query: "   ",
      limit: 50,
    });
    expect(blankOut.pagination.returned).toBe(6);

    const missing = await runTool<ErrorOutput>(
      messagesTool(blank.source, gate, TEST_LIMITS),
      {},
      makeContext({ sessionID: "" }).ctx,
    );
    expect(missing.error).toContain("No sessionID provided");

    const errored = makeFakeHarness({
      messageErrors: { "s-current": "Unauthorized" },
    });
    const errorOut = await runTool<ErrorOutput>(
      messagesTool(errored.source, gate, TEST_LIMITS),
      {},
    );
    expect(errorOut.error).toContain("Unauthorized");

    // A session with no data returns an empty page rather than an error: the
    // query path is deliberately lenient (only the distiller opts into strict).
    const noData = makeFakeHarness({ noMessageData: new Set(["s-current"]) });
    const noDataOut = await runTool<MessagesOutput>(
      messagesTool(noData.source, gate, TEST_LIMITS),
      {},
    );
    expect(noDataOut.ok).toBe(true);
    expect(noDataOut.pagination.returned).toBe(0);
  });

  it("survives raw MCP-bypass args (undefined role/limit must not filter everything)", async () => {
    // The live MCP host can forward args that skip Zod defaults. With role
    // undefined, the old code did `role !== "all"` → true → filtered everything
    // out. Coercion restores the defaults AND still passes a limit under strict.
    const h = makeFakeHarness();
    const out = await runToolRaw<MessagesOutput>(messagesTool(h.source, gate, TEST_LIMITS), {
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
    const out = await runToolRaw<MessagesOutput>(messagesTool(h.source, gate, TEST_LIMITS), {
      sessionID: "s-current",
      cursor: 123,
    });
    expect(out.ok).toBe(true);
    expect(out.pagination.returned).toBeGreaterThan(0);
    // No stray cursor was forwarded to the SDK as `before`.
    expect(h.calls.messages.every((c) => c.before === undefined)).toBe(true);
  });

  it("survives a raw order that is not one it knows (host path): browses newest first", async () => {
    const h = makeFakeHarness();
    for (const order of [7, "sideways", null]) {
      const out = await runToolRaw<MessagesOutput>(messagesTool(h.source, gate, TEST_LIMITS), {
        sessionID: "s-current",
        limit: 2,
        order,
      });
      expect(out.ok, String(order)).toBe(true);
      expect(out.pagination.order).toBe("newest");
      expect(out.messages.map((m) => m.message.id)).toEqual(["m-current-6", "m-current-5"]);
    }
  });

  it("reports a raw order oldest as unsupported on a source that pages newest first only", async () => {
    const h = makeFakeHarness();
    const out = await runToolRaw<ErrorOutput>(messagesTool(h.source, gate, TEST_LIMITS), {
      sessionID: "s-current",
      order: "oldest",
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('order "oldest" is not supported');
    expect(h.calls.messages).toEqual([]);

    // A cursor made oldest first asks for the same order.
    const cursor = encodeContinuation("recall_messages", {
      s: "s-current",
      o: "oldest",
      page: null,
    });
    const fromCursor = await runTool<ErrorOutput>(messagesTool(h.source, gate, TEST_LIMITS), {
      sessionID: "s-current",
      cursor,
    });
    expect(fromCursor.error).toContain('order "oldest" is not supported');
    expect(h.calls.messages).toEqual([]);
  });

  it("survives a raw scan budget that is missing, not a number or out of range (host path)", async () => {
    const h = makeFakeHarness();
    const tool = messagesTool(h.source, gate, TEST_LIMITS);
    // Not a number reads as the default, which covers the whole small session.
    for (const scan of ["lots", undefined, Number.NaN]) {
      const out = await runToolRaw<MessagesOutput>(tool, {
        sessionID: "s-current",
        role: "user",
        scan,
      });
      expect(out.ok, String(scan)).toBe(true);
      expect(out.pagination).toMatchObject({ scanned: 6, stop: "end", hasMore: false });
    }
    // Below the minimum it clamps to one message read.
    const low = await runToolRaw<MessagesOutput>(tool, {
      sessionID: "s-current",
      role: "user",
      scan: -3,
    });
    expect(low.pagination).toMatchObject({ scanned: 1, stop: "scanBudget", hasMore: true });
    // Above the maximum it clamps rather than failing.
    const high = await runToolRaw<MessagesOutput>(tool, {
      sessionID: "s-current",
      role: "user",
      scan: 1e9,
    });
    expect(high.pagination).toMatchObject({ scanned: 6, stop: "end" });
  });

  it("routes its fetches through the shared gate", async () => {
    const h = makeFakeHarness();
    const { gate: spy, queries } = makeSpyGate();
    await runTool<MessagesOutput>(messagesTool(h.source, spy, TEST_LIMITS), { limit: 2 });
    // The page fetch (and the session.get) must go through gate.runQuery.
    expect(queries()).toBeGreaterThan(0);
  });
});

// ── recall_messages scans ────────────────────────────────────────────────────

/** Messages in the scan sessions, oldest first: message `i` is a user
 *  message every fifth, otherwise a reply, and mentions a needle every
 *  seventh from the fourth. */
const SCAN_COUNT = 120;
const scanId = (i: number): string => `msg_scan_${String(i).padStart(3, "0")}`;
const scanRole = (i: number): "user" | "assistant" => (i % 5 === 0 ? "user" : "assistant");
const scanText = (i: number): string => `message ${i}${i % 7 === 3 ? " with a needle" : ""}`;
const scanIds = (count: number): string[] => Array.from({ length: count }, (_, i) => scanId(i));
const isNeedle = (id: string): boolean => Number(id.slice("msg_scan_".length)) % 7 === 3;
const isUser = (id: string): boolean => scanRole(Number(id.slice("msg_scan_".length))) === "user";

/** Session `s-scan` in the fake v1 harness. Returns its ids, oldest first. */
function addScanSession(h: FakeHarness, count = SCAN_COUNT): string[] {
  const sid = "s-scan";
  h.messagesBySession[sid] = scanIds(count).map((id, i) => {
    const created = 1_000_000 + i * 1_000;
    const info =
      scanRole(i) === "user" ? userMessage(id, sid, created) : assistantMessage(id, sid, created);
    return bundle(info, [textPart(`${id}-p0`, sid, id, scanText(i))]);
  });
  return scanIds(count);
}

const v2Cleanups: Array<() => void> = [];
afterEach(() => {
  while (v2Cleanups.length > 0) v2Cleanups.pop()!();
});

/**
 * Session `ses_scan` in an opencode v2 database, shaped as the v1 scan
 * session with each text padded by `pad` characters, and a source over it
 * that counts the pages it reads. Returns its ids, oldest first.
 */
async function v2ScanSession(count = SCAN_COUNT, opts: V2SourceOptions = {}, pad = 0) {
  const t = await makeV2Db();
  v2Cleanups.push(t.cleanup);
  insertProject(t.db, { id: "prj", worktree: "/w/app" });
  insertSession(t.db, {
    id: "ses_scan",
    project_id: "prj",
    directory: "/w/app",
    time_created: 1_000,
    time_updated: 1_000,
  });
  t.db.exec("BEGIN");
  for (let i = 0; i < count; i++) {
    const text = `${scanText(i)} ${"-".repeat(pad)}`;
    insertMessage(t.db, {
      id: scanId(i),
      session_id: "ses_scan",
      type: scanRole(i),
      seq: i + 1,
      time_created: 2_000 + i,
      data:
        scanRole(i) === "user"
          ? { text, time: { created: 0 } }
          : {
              agent: "build",
              model: { id: "m-1", providerID: "p-1" },
              content: [{ type: "text", text }],
              time: { created: 0, completed: 1 },
            },
    });
  }
  t.db.exec("COMMIT");
  const opened = await openOpencodeDb(t.path);
  if (!opened.ok) throw new Error(opened.reason);
  v2Cleanups.push(() => opened.db.close());
  const inner = createV2HistorySource(limitSpy(opened.db), {
    yieldBetween: async () => {},
    projectID: "prj",
    ...opts,
  });
  const reads = { pages: 0 };
  const source: HistorySource = {
    ...inner,
    messagePage: (o) => {
      reads.pages++;
      return inner.messagePage(o);
    },
    messagePageAscending: (o) => {
      reads.pages++;
      return inner.messagePageAscending!(o);
    },
  };
  return { source, reads, ids: scanIds(count) };
}

const idsOf = (out: MessagesOutput): string[] => out.messages.map((m) => m.message.id);

/** Every output of a browse, following `pagination.nextCursor` to the end. */
async function browseAll(
  source: HistorySource,
  args: Record<string, unknown>,
): Promise<MessagesOutput[]> {
  const tool = messagesTool(source, gate, TEST_LIMITS);
  const outs: MessagesOutput[] = [];
  let cursor: string | undefined;
  for (let step = 0; step < 500; step++) {
    const out = await runTool<MessagesOutput>(tool, { ...args, ...(cursor && { cursor }) });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    outs.push(out);
    cursor = out.pagination.nextCursor;
    if (!cursor) return outs;
  }
  throw new Error("browse did not end");
}

describe("recall_messages scanning for matches", () => {
  it("reads on past the first page until limit messages match, asking 50 messages a page", async () => {
    const h = makeFakeHarness();
    const ids = addScanSession(h);
    const tool = messagesTool(h.source, gate, TEST_LIMITS);
    const out = await runTool<MessagesOutput>(tool, {
      sessionID: "s-scan",
      query: "needle",
      limit: 10,
    });
    const needles = [...ids].reverse().filter(isNeedle);
    expect(idsOf(out)).toEqual(needles.slice(0, 10));
    // The tenth needle from the newest is message 52, on the second page.
    expect(out.pagination).toMatchObject({
      limit: 10,
      order: "newest",
      returned: 10,
      matched: 10,
      scanned: SCAN_COUNT - 52,
      stop: "limit",
      hasMore: true,
    });
    expect(h.calls.messages.map((c) => c.limit)).toEqual([50, 50]);

    // Unfiltered, a page asks for limit messages and every one matches.
    const plain = makeFakeHarness();
    addScanSession(plain);
    const unfiltered = await runTool<MessagesOutput>(
      messagesTool(plain.source, gate, TEST_LIMITS),
      {
        sessionID: "s-scan",
        limit: 7,
      },
    );
    expect(idsOf(unfiltered)).toEqual([...ids].reverse().slice(0, 7));
    expect(unfiltered.pagination).toMatchObject({ matched: 7, scanned: 7, stop: "limit" });
    expect(plain.calls.messages.map((c) => c.limit)).toEqual([7]);
  });

  it.each([7, 50])(
    "stops at a scan budget of %i and resumes at the first message it did not read",
    async (scan) => {
      const h = makeFakeHarness();
      const ids = addScanSession(h);
      const tool = messagesTool(h.source, gate, TEST_LIMITS);
      const out = await runTool<MessagesOutput>(tool, {
        sessionID: "s-scan",
        query: "no message says this",
        scan,
      });
      expect(out.messages).toEqual([]);
      expect(out.pagination).toMatchObject({
        returned: 0,
        matched: 0,
        scanned: scan,
        stop: "scanBudget",
        hasMore: true,
        nextCursor: expect.any(String),
      });
      const next = await runTool<MessagesOutput>(tool, {
        sessionID: "s-scan",
        limit: 50,
        cursor: out.pagination.nextCursor,
      });
      expect(idsOf(next)[0]).toBe(ids[SCAN_COUNT - 1 - scan]);
    },
  );

  // Eleven messages hold two or three user messages and one or two needles,
  // so either budget can end a call.
  it.each([
    { name: "newest first on v1", v2: false, order: undefined, filter: { role: "user" }, limit: 3 },
    { name: "newest first on v2", v2: true, order: undefined, filter: { role: "user" }, limit: 3 },
    { name: "oldest first on v2", v2: true, order: "oldest", filter: { role: "user" }, limit: 3 },
    {
      name: "oldest first on v2 by query",
      v2: true,
      order: "oldest",
      filter: { query: "needle" },
      limit: 2,
    },
  ] as const)(
    "walks a filtered browse to its end, $name: each match once, each message scanned once",
    async ({ v2, order, filter, limit }) => {
      let source: HistorySource;
      let ids: string[];
      let sessionID: string;
      if (v2) {
        ({ source, ids } = await v2ScanSession());
        sessionID = "ses_scan";
      } else {
        const h = makeFakeHarness();
        ids = addScanSession(h);
        source = h.source;
        sessionID = "s-scan";
      }
      const outs = await browseAll(source, {
        sessionID,
        ...filter,
        limit,
        scan: 11,
        ...(order && { order }),
      });
      const inOrder = order === "oldest" ? ids : [...ids].reverse();
      const keep = "role" in filter ? isUser : isNeedle;
      expect(outs.flatMap(idsOf)).toEqual(inOrder.filter(keep));
      expect(outs.reduce((sum, out) => sum + out.pagination.scanned, 0)).toBe(SCAN_COUNT);
      for (const [i, out] of outs.entries()) {
        const p = out.pagination;
        expect(p.order).toBe(order ?? "newest");
        expect(p.returned).toBe(p.matched);
        expect(p.matched).toBeLessThanOrEqual(limit);
        expect(p.scanned).toBeLessThanOrEqual(11);
        if (i < outs.length - 1) {
          expect(["limit", "scanBudget"]).toContain(p.stop);
          expect(p.hasMore).toBe(true);
        }
      }
      expect(outs.at(-1)!.pagination).toMatchObject({ stop: "end", hasMore: false });
      expect(outs.at(-1)!.pagination).not.toHaveProperty("nextCursor");
      // Both budgets stopped the walk somewhere along the way.
      const stops = new Set(outs.map((out) => out.pagination.stop));
      expect(stops).toEqual(new Set(["limit", "scanBudget", "end"]));
    },
  );

  it("stops after 40 page reads, whatever its scan budget", async () => {
    // Each ~640-byte message fills a 1,000-byte page on its own.
    const { source, reads, ids } = await v2ScanSession(45, { pageByteCeiling: 1_000 }, 600);
    const tool = messagesTool(source, gate, TEST_LIMITS);
    const out = await runTool<MessagesOutput>(tool, {
      sessionID: "ses_scan",
      query: "no message says this",
      scan: 2_000,
    });
    expect(reads.pages).toBe(40);
    expect(out.pagination).toMatchObject({
      matched: 0,
      scanned: 40,
      stop: "scanBudget",
      hasMore: true,
    });
    const next = await runTool<MessagesOutput>(tool, {
      sessionID: "ses_scan",
      cursor: out.pagination.nextCursor,
      limit: 50,
    });
    expect(idsOf(next)).toEqual(ids.slice(0, 5).reverse());
    expect(next.pagination).toMatchObject({ stop: "end", hasMore: false });
  });

  it.each(["newest", "oldest"] as const)(
    "fills limit %s first across pages a byte ceiling cut short",
    async (order) => {
      const { source, reads, ids } = await v2ScanSession(45, { pageByteCeiling: 1_000 }, 600);
      const tool = messagesTool(source, gate, TEST_LIMITS);
      const inOrder = order === "oldest" ? ids : [...ids].reverse();
      const out = await runTool<MessagesOutput>(tool, { sessionID: "ses_scan", limit: 5, order });
      expect(idsOf(out)).toEqual(inOrder.slice(0, 5));
      expect(out.pagination).toMatchObject({
        returned: 5,
        matched: 5,
        scanned: 5,
        stop: "limit",
        hasMore: true,
      });
      expect(reads.pages).toBe(5);
      const next = await runTool<MessagesOutput>(tool, {
        sessionID: "ses_scan",
        limit: 5,
        cursor: out.pagination.nextCursor,
      });
      expect(idsOf(next)).toEqual(inOrder.slice(5, 10));
    },
  );
});

describe("recall_messages order", () => {
  it("browses oldest first on v2 and keeps that order through its cursor", async () => {
    const { source, ids } = await v2ScanSession(10);
    const tool = messagesTool(source, gate, TEST_LIMITS);
    const first = await runTool<MessagesOutput>(tool, {
      sessionID: "ses_scan",
      limit: 3,
      order: "oldest",
    });
    expect(idsOf(first)).toEqual(ids.slice(0, 3));
    expect(first.pagination.order).toBe("oldest");
    for (const order of [undefined, "oldest"]) {
      const next = await runTool<MessagesOutput>(tool, {
        sessionID: "ses_scan",
        limit: 3,
        cursor: first.pagination.nextCursor,
        ...(order && { order }),
      });
      expect(idsOf(next), String(order)).toEqual(ids.slice(3, 6));
      expect(next.pagination.order, String(order)).toBe("oldest");
    }
  });

  it("rejects an order that conflicts with the order its cursor was made in", async () => {
    const { source } = await v2ScanSession(10);
    const tool = messagesTool(source, gate, TEST_LIMITS);
    const cursors = {
      newest: (await runTool<MessagesOutput>(tool, { sessionID: "ses_scan", limit: 3 })).pagination
        .nextCursor,
      oldest: (
        await runTool<MessagesOutput>(tool, { sessionID: "ses_scan", limit: 3, order: "oldest" })
      ).pagination.nextCursor,
    };
    for (const [made, other] of [
      ["newest", "oldest"],
      ["oldest", "newest"],
    ] as const) {
      const out = await runTool<ErrorOutput>(tool, {
        sessionID: "ses_scan",
        cursor: cursors[made],
        order: other,
      });
      expect(out).toEqual({ ok: false, error: expect.stringContaining(`browses ${made} first`) });
    }
  });

  it("reads a cursor that names no order as newest first", async () => {
    const { source, ids } = await v2ScanSession(10);
    const tool = messagesTool(source, gate, TEST_LIMITS);
    const cursor = encodeContinuation("recall_messages", {
      s: "ses_scan",
      page: null,
      anchorId: ids[7]!,
    });
    const out = await runTool<MessagesOutput>(tool, { sessionID: "ses_scan", limit: 2, cursor });
    expect(idsOf(out)).toEqual([ids[7], ids[6]]);
    expect(out.pagination.order).toBe("newest");
    const conflict = await runTool<ErrorOutput>(tool, {
      sessionID: "ses_scan",
      limit: 2,
      cursor,
      order: "oldest",
    });
    expect(conflict.error).toContain("browses newest first");
  });
});

describe("recall_messages cursors resumed with other arguments", () => {
  type Args = { role?: "user"; query?: "needle"; limit: number; scan?: number };
  /** The scan session's ids a call with `args` keeps. */
  const keeps =
    (args: Args) =>
    (id: string): boolean =>
      (args.role === undefined || isUser(id)) && (args.query === undefined || isNeedle(id));

  // Each first call stops partway through a page it read, so its cursor
  // names the first message it did not read. The second call reads pages of
  // a different size: 2 or 4 messages unfiltered, 50 filtered.
  const cases: Array<{ name: string; first: Args; second: Args }> = [
    {
      name: "a filtered call, then an unfiltered one with a smaller limit",
      first: { role: "user", limit: 3 },
      second: { limit: 2 },
    },
    {
      name: "an unfiltered call, then a filtered one",
      first: { limit: 5, scan: 3 },
      second: { role: "user", limit: 3 },
    },
    {
      name: "a call, then the same call with its filter removed",
      first: { query: "needle", limit: 4 },
      second: { limit: 4 },
    },
  ];

  it.each(cases.flatMap((c) => (["newest", "oldest"] as const).map((order) => ({ ...c, order }))))(
    "resumes right after the last message read: $name, $order first",
    async (c) => {
      const { source, ids } = await v2ScanSession();
      const tool = messagesTool(source, gate, TEST_LIMITS);
      const inOrder = c.order === "oldest" ? ids : [...ids].reverse();

      const one = await runTool<MessagesOutput>(tool, {
        sessionID: "ses_scan",
        order: c.order,
        ...c.first,
      });
      const read = one.pagination.scanned;
      expect(idsOf(one)).toEqual(inOrder.slice(0, read).filter(keeps(c.first)));
      const cursor = one.pagination.nextCursor!;
      expect(decodeMessagesCursor(cursor)).toMatchObject({
        ok: true,
        value: { at: { message: inOrder[read] } },
      });

      const two = await runTool<MessagesOutput>(tool, {
        sessionID: "ses_scan",
        ...c.second,
        cursor,
      });
      expect(two.pagination.order).toBe(c.order);
      expect(idsOf(two)).toEqual(
        inOrder.slice(read).filter(keeps(c.second)).slice(0, c.second.limit),
      );
    },
  );

  it.each(["newest", "oldest"] as const)(
    "resumes a trimmed output's continuation with other arguments where the output stopped (%s first)",
    async (order) => {
      // ~7 KB messages: six needles fill the output budget, so the output
      // stops in a needle well into its 50-message page.
      const { source, ids } = await v2ScanSession(SCAN_COUNT, {}, 7_000);
      const tool = messagesTool(source, gate, TEST_LIMITS);
      const inOrder = order === "oldest" ? ids : [...ids].reverse();
      const needles = inOrder.filter(isNeedle);

      const one = await runTool<MessagesOutput>(tool, {
        sessionID: "ses_scan",
        query: "needle",
        limit: 20,
        order,
      });
      expect(one.trimmed).toBe(true);
      const shown = idsOf(one);
      expect(shown).toEqual(needles.slice(0, shown.length));
      const last = one.messages.at(-1)!;
      const cut = last.parts.find((p) => p.cutAt);
      const anchor = cut ? last.message.id : needles[shown.length]!;
      expect(inOrder.indexOf(anchor)).toBeGreaterThan(6);

      const two = await runTool<MessagesOutput>(tool, {
        sessionID: "ses_scan",
        limit: 2,
        cursor: one.continuation,
      });
      const from = inOrder.indexOf(anchor);
      expect(idsOf(two)).toEqual(inOrder.slice(from, from + 2));
      if (cut) {
        expect(two.messages[0]!.parts[0]).toMatchObject({
          id: cut.id,
          resumedAt: { field: cut.cutAt!.field, offset: cut.cutAt!.offset },
        });
      }
    },
  );
});

describe("recall_get", () => {
  it("returns formatted full messages with model, pruned, and tool-state details", async () => {
    const h = makeFakeHarness();
    const tool = getTool(h.source, gate);

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
    const notFound = await runTool<ErrorOutput>(getTool(h.source, gate), {
      sessionID: "s-current",
      messageID: "missing",
    });
    expect(notFound.error).toBe("Message not found: missing");

    const noData = makeFakeHarness({
      noSingleMessageData: new Set(["s-current:m-current-1"]),
    });
    const noDataOut = await runTool<ErrorOutput>(getTool(noData.source, gate), {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    expect(noDataOut.error).toBe("Message not found: m-current-1");

    const errored = makeFakeHarness({
      messageLookupErrors: { "s-current:m-current-1": "message API failed" },
    });
    const errorOut = await runTool<ErrorOutput>(getTool(errored.source, gate), {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    expect(errorOut.error).toContain("message API failed");

    const noContext = makeFakeHarness({ getThrows: new Set(["s-current"]) });
    const ok = await runTool<MessageOutput>(getTool(noContext.source, gate), {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    expect(ok.ok).toBe(true);
    expect(ok.context.sessionTitle).toBeUndefined();
    expect(ok.context.directory).toBeUndefined();
  });

  it("names an oversized header, not the records, when the header leaves no room", async () => {
    // The session title rides in the header's `context`; one over the whole
    // output budget leaves no room for any part.
    const h = makeFakeHarness();
    const source: HistorySource = {
      ...h.source,
      getSession: async () => ({
        ok: true,
        value: session("s-current", "T".repeat(45_000), PROJECT_DIR, 1_000),
      }),
    };
    const out = await runTool<ErrorOutput & { trimmed?: true }>(getTool(source, gate), {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    expect(out).toMatchObject({ ok: false, trimmed: true });
    expect(out.error).toContain("header alone is");
    expect(out.error).toContain('"context" field');
    expect(out.error).not.toContain("first record");
  });

  it("survives a raw non-string or blank cursor (host path): reads the whole message", async () => {
    const h = makeFakeHarness();
    for (const cursor of [123, {}, "   "]) {
      const out = await runToolRaw<MessageOutput>(getTool(h.source, gate), {
        sessionID: "s-current",
        messageID: "m-current-3",
        cursor,
      });
      expect(out.ok).toBe(true);
      expect(out.trimmed).toBeUndefined();
      expect(out.parts[0]).toMatchObject({ type: "tool", toolName: "bash" });
    }
  });

  it("routes its fetches through the shared gate", async () => {
    const h = makeFakeHarness();
    const { gate: spy, queries } = makeSpyGate();
    await runTool<MessageOutput>(getTool(h.source, spy), {
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
    const tool = contextTool(h.source, gate, TEST_LIMITS);

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
    const tool = contextTool(h.source, gate, TEST_LIMITS);

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
    const notFound = await runTool<ErrorOutput>(contextTool(h.source, gate, TEST_LIMITS), {
      sessionID: "s-current",
      messageID: "missing",
    });
    expect(notFound.error).toBe("Message not found: missing");

    const errored = makeFakeHarness({
      messageErrors: { "s-current": "Unauthorized" },
    });
    const errorOut = await runTool<ErrorOutput>(contextTool(errored.source, gate, TEST_LIMITS), {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    expect(errorOut.error).toContain("Unauthorized");

    const noData = makeFakeHarness({ noMessageData: new Set(["s-current"]) });
    const noDataOut = await runTool<ErrorOutput>(contextTool(noData.source, gate, TEST_LIMITS), {
      sessionID: "s-current",
      messageID: "m-current-1",
    });
    expect(noDataOut.error).toBe("No messages returned");
  });

  it("survives raw MCP-bypass args (undefined window must not break slice bounds)", async () => {
    const h = makeFakeHarness();
    const out = await runToolRaw<ContextOutput>(contextTool(h.source, gate, TEST_LIMITS), {
      sessionID: "s-current",
      messageID: "m-current-3",
    });
    expect(out.ok).toBe(true);
    expect(out.messages.length).toBeGreaterThan(0);
    expect(out.messages.some((m) => m.center)).toBe(true);
  });

  it("survives a raw non-string or blank cursor (host path): returns the window from its start", async () => {
    const h = makeFakeHarness();
    for (const cursor of [42, { anchorId: "m-current-4" }, ""]) {
      const out = await runToolRaw<ContextOutput>(contextTool(h.source, gate, TEST_LIMITS), {
        sessionID: "s-current",
        messageID: "m-current-3",
        window: 1,
        cursor,
      });
      expect(out.ok).toBe(true);
      expect(out.trimmed).toBeUndefined();
      expect(out.messages.map((m) => m.message.id)).toEqual([
        "m-current-2",
        "m-current-3",
        "m-current-4",
      ]);
    }
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

    const out = await runTool<ContextOutput>(contextTool(h.source, gate, TEST_LIMITS), {
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
    await runTool<ContextOutput>(contextTool(h.source, spy, TEST_LIMITS), {
      sessionID: "s-current",
      messageID: "m-current-3",
      window: 1,
    });
    // The window page fetch (and the session.get) must go through gate.runQuery.
    expect(queries()).toBeGreaterThan(0);
  });
});

describe("recall_sessions continuations across listing changes", () => {
  type Listed = SessionsOutput & { continuation?: string; error?: string };

  /** A harness listing 100 project sessions with ~1 KB titles, over the
   *  output budget, newest first in array order (as the fake lists them). */
  function harness(): ReturnType<typeof makeFakeHarness> {
    const h = makeFakeHarness();
    const now = Date.now();
    for (let i = 0; i < 120; i++) {
      const id = `s-walk-${String(i).padStart(3, "0")}`;
      h.sessions.push(session(id, `Walk ${i} ${"€".repeat(300)}`, PROJECT_DIR, now - 10_000 - i));
    }
    return h;
  }

  /** Session `id` updated now: newer `time.updated`, first in the listing. */
  function touch(h: ReturnType<typeof makeFakeHarness>, id: string): void {
    const index = h.sessions.findIndex((s) => s.id === id);
    const [moved] = h.sessions.splice(index, 1);
    h.sessions.unshift({ ...moved!, time: { ...moved!.time, updated: Date.now() + 60_000 } });
  }

  const run = (h: ReturnType<typeof makeFakeHarness>, cursor?: string): Promise<Listed> =>
    runTool<Listed>(sessionsTool(h.source, true, TEST_LIMITS), {
      limit: 100,
      ...(cursor && { cursor }),
    });

  it("walks an unchanged listing to its end, each session once and in order", async () => {
    const h = harness();
    const expected = h.sessions.filter((s) => s.directory === PROJECT_DIR).slice(0, 100);
    const ids: string[] = [];
    let out = await run(h);
    for (let calls = 1; ; calls++) {
      expect(out.ok).toBe(true);
      ids.push(...out.sessions.map((s) => s.id));
      if (!out.continuation) break;
      expect(calls).toBeLessThan(20);
      out = await run(h, out.continuation);
    }
    expect(ids).toEqual(expected.map((s) => s.id));
  });

  it("rejects the continuation when a session not yet shown was updated in between", async () => {
    const h = harness();
    const first = await run(h);
    expect(first.continuation).toBeDefined();
    touch(h, "s-walk-090");
    const out = await run(h, first.continuation);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("list again") });
  });

  it("rejects the continuation when its anchor session was updated in between", async () => {
    const h = harness();
    const first = await run(h);
    const anchor = h.sessions.filter((s) => s.directory === PROJECT_DIR)[first.sessions.length]!;
    touch(h, anchor.id);
    const out = await run(h, first.continuation);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("list again") });
  });

  it("rejects the continuation when a new session arrived in between", async () => {
    const h = harness();
    const first = await run(h);
    h.sessions.unshift(session("s-walk-new", "New", PROJECT_DIR, Date.now() + 60_000));
    const out = await run(h, first.continuation);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("list again") });
  });

  it("resumes when a session filtered out of the listing arrived in between, skipping nothing", async () => {
    // A summarizer worker is dropped after the source listing. The listing
    // reads past it, so the sessions the page still owes keep their places.
    const h = harness();
    const expected = h.sessions.filter((s) => s.directory === PROJECT_DIR).slice(0, 100);
    const first = await run(h);
    h.sessions.unshift(
      session("s-walk-worker", "[recall-summarizer] worker", PROJECT_DIR, Date.now() + 60_000),
    );
    const ids = first.sessions.map((s) => s.id);
    let out = await run(h, first.continuation);
    for (let calls = 1; ; calls++) {
      expect(out.ok).toBe(true);
      ids.push(...out.sessions.map((s) => s.id));
      if (!out.continuation) break;
      expect(calls).toBeLessThan(20);
      out = await run(h, out.continuation);
    }
    expect(ids).toEqual(expected.map((s) => s.id));
  });

  it("rejects the continuation when a session was inserted below the anchor in between", async () => {
    // The card index's initial pass can add a card with an old update time,
    // which sorts below the anchor on the card path (`since`/`until`).
    const h = harness();
    const cards = h.sessions.filter((s) => s.directory === PROJECT_DIR).slice(0, 100);
    const tool = sessionsTool(h.source, true, TEST_LIMITS, {
      cards: () => cardsLiteFromSessions(cards),
    });
    const call = (cursor?: string): Promise<Listed> =>
      runTool<Listed>(tool, { limit: 100, since: "7d", ...(cursor && { cursor }) });
    const first = await call();
    expect(first.continuation).toBeDefined();
    const anchorUpdated = cards[first.sessions.length]!.time.updated;
    cards.push(session("s-walk-late", "Late card", PROJECT_DIR, anchorUpdated - 1));
    const out = await call(first.continuation);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("list again") });
  });

  it("says summarizer workers kept three reads from the rest of a trimmed page, rather than that the listing changed", async () => {
    const h = harness();
    const first = await run(h);
    expect(first.continuation).toBeDefined();
    // Workers never listed arrive right after the continuation's session,
    // more than three reads reach past, so the anchor is found but the rest
    // of the page it resumes is not.
    const anchor = h.sessions.filter((s) => s.directory === PROJECT_DIR)[first.sessions.length]!;
    const workers = Array.from({ length: 400 }, (_, i) =>
      session(`s-walk-worker-${i}`, "[recall-summarizer] worker", PROJECT_DIR, anchor.time.updated),
    );
    h.sessions.splice(h.sessions.indexOf(anchor) + 1, 0, ...workers);
    const out = await run(h, first.continuation);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("summarizer worker") });
  });

  it("resumes when a session already shown was updated in between, without repeating it", async () => {
    const h = harness();
    const first = await run(h);
    const shown = first.sessions.map((s) => s.id);
    touch(h, shown[1]!);
    const out = await run(h, first.continuation);
    expect(out.ok).toBe(true);
    expect(out.sessions.some((s) => shown.includes(s.id))).toBe(false);
    expect(out.sessions[0]!.id).toBe(
      h.sessions.filter((s) => s.directory === PROJECT_DIR)[shown.length]!.id,
    );
  });
});

describe("recall_sessions pages past limit", () => {
  type Page = SessionsOutput & { error?: string };
  type Harness = ReturnType<typeof makeFakeHarness>;

  /** The fake harness with `count` project sessions with short titles after
   *  the fixture's two, newest first in array order (as the fake lists
   *  them), so no page is trimmed. */
  function listing(count: number): Harness {
    const h = makeFakeHarness();
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      const id = `s-page-${String(i).padStart(3, "0")}`;
      h.sessions.push(session(id, `Page ${i}`, PROJECT_DIR, now - 10_000 - i));
    }
    return h;
  }

  /** `count` sessions as the card index knows them, newest first. */
  function carded(count: number): ReturnType<typeof session>[] {
    const now = Date.now();
    return Array.from({ length: count }, (_, i) =>
      session(`s-card-${String(i).padStart(3, "0")}`, `Card ${i}`, PROJECT_DIR, now - 10_000 - i),
    );
  }

  /** A summarizer worker session, updated after every other session. */
  const worker = (id: string): ReturnType<typeof session> =>
    session(id, "[recall-summarizer] worker", PROJECT_DIR, Date.now() + 60_000);

  /** Session `id` updated now: newer `time.updated`, first in the listing. */
  function touch(h: Harness, id: string): void {
    const index = h.sessions.findIndex((s) => s.id === id);
    const [moved] = h.sessions.splice(index, 1);
    h.sessions.unshift({ ...moved!, time: { ...moved!.time, updated: Date.now() + 60_000 } });
  }

  /** Every page of a listing, following `nextCursor` to the end. `between`
   *  runs before each page after the first. */
  async function walk(
    tool: ReturnType<typeof sessionsTool>,
    args: Record<string, unknown>,
    between?: (step: number) => void,
  ): Promise<Page[]> {
    const pages: Page[] = [];
    let cursor: string | undefined;
    for (let step = 0; step < 50; step++) {
      const out = await runTool<Page>(tool, { ...args, ...(cursor && { cursor }) });
      expect(out.ok, out.error).toBe(true);
      pages.push(out);
      cursor = out.nextCursor;
      if (!cursor) return pages;
      between?.(step);
    }
    throw new Error("pages did not end");
  }

  const idsOf = (pages: Page[]): string[] => pages.flatMap((p) => p.sessions.map((s) => s.id));
  /** `truncated` as every page but the last of `count` shows it. */
  const truncatedUntilLast = (count: number): Array<true | undefined> =>
    Array.from({ length: count }, (_, i) => (i < count - 1 ? true : undefined));

  it("pages a live listing by recency, limit sessions at a time, each once and in order", async () => {
    // 27 sessions: pages of 9 end on a full page, pages of 10 on a short one.
    for (const [limit, sizes] of [
      [9, [9, 9, 9]],
      [10, [10, 10, 7]],
    ] as const) {
      const h = listing(25);
      const pages = await walk(sessionsTool(h.source, true, TEST_LIMITS), { limit });
      expect(pages.map((p) => p.returned)).toEqual(sizes);
      expect(pages.map((p) => p.truncated)).toEqual(truncatedUntilLast(sizes.length));
      expect(pages.every((p) => p.continuation === undefined && p.trimmed === undefined)).toBe(
        true,
      );
      expect(idsOf(pages)).toEqual(h.sessions.map((s) => s.id));
      // Each call reads from the top through the session after its page (the
      // source asks for one row more, to decide its own `truncated`).
      expect(h.calls.projectList.map((c) => c.limit)).toEqual(
        sizes.map((_, k) => (k + 1) * limit + 2),
      );
    }
  });

  it("ends a live listing that fits in one page without truncated or nextCursor", async () => {
    const h = listing(3);
    const out = await runTool<Page>(sessionsTool(h.source, true, TEST_LIMITS), { limit: 5 });
    expect(out.returned).toBe(5);
    expect(out.truncated).toBeUndefined();
    expect(out.nextCursor).toBeUndefined();
  });

  it("refuses the next live page when a session not yet shown moved ahead of it", async () => {
    const h = listing(25);
    const tool = sessionsTool(h.source, true, TEST_LIMITS);
    const first = await runTool<Page>(tool, { limit: 10 });
    expect(first.nextCursor).toEqual(expect.any(String));
    // A session from the third page is updated, so it moves to the top,
    // ahead of the sessions already shown.
    touch(h, h.sessions[22]!.id);
    expect(await runTool<Page>(tool, { limit: 10, cursor: first.nextCursor })).toMatchObject({
      ok: false,
      error: expect.stringContaining("This listing changed"),
    });
  });

  it("keeps paging a live listing without a gap when a summarizer worker arrives between pages", async () => {
    const h = listing(25);
    const expected = h.sessions.map((s) => s.id);
    const pages = await walk(sessionsTool(h.source, true, TEST_LIMITS), { limit: 9 }, (step) => {
      h.sessions.unshift(worker(`s-worker-${step}`));
    });
    expect(pages.map((p) => p.returned)).toEqual([9, 9, 9]);
    expect(idsOf(pages)).toEqual(expected);
    expect(pages.every((p) => p.note === undefined)).toBe(true);
  });

  it("reads past summarizer workers that leave a read short, to fill the page and reach the next", async () => {
    const h = listing(10);
    const expected = h.sessions.map((s) => s.id);
    for (let i = 0; i < 5; i++) h.sessions.unshift(worker(`s-worker-${i}`));
    const tool = sessionsTool(h.source, true, TEST_LIMITS);

    const first = await runTool<Page>(tool, { limit: 3 });
    expect(first.sessions.map((s) => s.id)).toEqual(expected.slice(0, 3));
    expect(first).toMatchObject({ truncated: true, nextCursor: expect.any(String) });
    expect(first.note).toBeUndefined();
    // More than one read, at most three, each longer than the one before.
    const reads = h.calls.projectList.map((c) => c.limit!);
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.length).toBeLessThanOrEqual(3);
    reads.slice(1).forEach((rows, i) => expect(rows).toBeGreaterThan(reads[i]!));

    const second = await runTool<Page>(tool, { limit: 3, cursor: first.nextCursor });
    expect(second.sessions.map((s) => s.id)).toEqual(expected.slice(3, 6));
  });

  it("makes at most three reads when summarizer workers fill them, and says why the page is short", async () => {
    const h = listing(10);
    for (let i = 0; i < 40; i++) h.sessions.unshift(worker(`s-worker-${i}`));
    const out = await runTool<Page>(sessionsTool(h.source, true, TEST_LIMITS), { limit: 3 });
    expect(h.calls.projectList).toHaveLength(3);
    // More sessions exist, but this call reached none to continue from.
    expect(out).toMatchObject({
      ok: true,
      returned: 0,
      truncated: true,
      note: expect.stringContaining("summarizer worker"),
    });
    expect(out.nextCursor).toBeUndefined();
  });

  it("says summarizer workers kept three reads from the cursor's session, rather than that the listing changed", async () => {
    const h = listing(10);
    const tool = sessionsTool(h.source, true, TEST_LIMITS);
    const first = await runTool<Page>(tool, { limit: 3 });
    expect(first.nextCursor).toEqual(expect.any(String));
    // Workers never listed arrive ahead of everything, more than three reads
    // of the next page reach past.
    for (let i = 0; i < 40; i++) h.sessions.unshift(worker(`s-worker-${i}`));
    h.calls.projectList.length = 0;
    const out = await runTool<Page>(tool, { limit: 3, cursor: first.nextCursor });
    expect(h.calls.projectList).toHaveLength(3);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("summarizer worker") });
  });

  it("keeps a time-bounded live listing to one page of the newest limit sessions", async () => {
    // Without a card store, and on the staleness fallback (a card store with
    // nothing newer than `since`).
    for (const enrichment of [undefined, { cards: () => [] }]) {
      const h = listing(25);
      const out = await runTool<Page>(sessionsTool(h.source, true, TEST_LIMITS, enrichment), {
        since: "1h",
        limit: 5,
      });
      expect(out.sessions.map((s) => s.id)).toEqual(h.sessions.slice(0, 5).map((s) => s.id));
      expect(out.truncated).toBeUndefined();
      expect(out.nextCursor).toBeUndefined();
      expect(out.note).toMatch(/newest 5\b/);
    }
  });

  it("pages a listing selected from the cards, with no live read", async () => {
    // With `since` over a card store, and from the cards alone while the
    // history source is unavailable.
    for (const mode of ["since", "unavailable"] as const) {
      const h = makeFakeHarness();
      const known = carded(25);
      const source =
        mode === "since" ? h.source : createUnavailableSource("v2-sqlite", "cannot open db");
      const tool = sessionsTool(source, true, TEST_LIMITS, {
        cards: () => cardsLiteFromSessions(known),
      });
      const pages = await walk(tool, { limit: 10, ...(mode === "since" && { since: "7d" }) });
      expect(
        pages.map((p) => p.returned),
        mode,
      ).toEqual([10, 10, 5]);
      expect(
        pages.map((p) => p.truncated),
        mode,
      ).toEqual(truncatedUntilLast(3));
      expect(idsOf(pages), mode).toEqual(known.map((s) => s.id));
      expect(h.calls.projectList, mode).toEqual([]);
    }
  });

  it("refuses the next page of a card listing when a session after the page left it", async () => {
    const h = makeFakeHarness();
    const known = carded(25);
    const tool = sessionsTool(h.source, true, TEST_LIMITS, {
      cards: () => cardsLiteFromSessions(known),
    });
    const first = await runTool<Page>(tool, { since: "7d", limit: 10 });
    expect(first.nextCursor).toEqual(expect.any(String));
    // The oldest session, on the last page, is gone from the cards.
    known.pop();
    expect(
      await runTool<Page>(tool, { since: "7d", limit: 10, cursor: first.nextCursor }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("This listing changed") });
  });

  it("reports archived from the card on listings served from the cards", async () => {
    const h = makeFakeHarness();
    const now = Date.now();
    const [archived, cleared, never] = cardsLiteFromSessions([
      session("s-archived", "Archived", PROJECT_DIR, now - 1_000),
      session("s-cleared", "Unarchived", PROJECT_DIR, now - 2_000),
      session("s-never", "Never archived", PROJECT_DIR, now - 3_000),
    ]);
    const cards = [
      { ...archived!, timeArchived: now - 500 },
      { ...cleared!, timeArchived: null },
      never!,
    ];
    for (const [source, args] of [
      [h.source, { since: "7d" }],
      [createUnavailableSource("v2-sqlite", "cannot open db"), {}],
    ] as const) {
      const out = await runTool<Page>(
        sessionsTool(source, true, TEST_LIMITS, { cards: () => cards }),
        args,
      );
      expect(out.sessions.map((s) => [s.id, s.archived])).toEqual([
        ["s-archived", true],
        ["s-cleared", false],
        ["s-never", false],
      ]);
    }
  });
});

describe("recall_sessions defensive args", () => {
  it("survives raw MCP-bypass args (undefined scope/limit default to project)", async () => {
    const h = makeFakeHarness();
    const out = await runToolRaw<SessionsOutput>(sessionsTool(h.source, true, TEST_LIMITS), {});
    expect(out.ok).toBe(true);
    expect(out.scope).toBe("project");
    expect(Array.isArray(out.sessions)).toBe(true);
  });

  it("survives raw non-string since/until (host path): ignores the filters", async () => {
    // The since/until time bounds can arrive with the wrong type from the live
    // MCP host. optionalString() must drop them (no .trim() on a non-string) so
    // the listing succeeds unfiltered rather than throwing.
    const h = makeFakeHarness();
    const out = await runToolRaw<SessionsOutput>(sessionsTool(h.source, true, TEST_LIMITS), {
      scope: "global",
      since: 42,
      until: {},
    });
    expect(out.ok).toBe(true);
    // Non-string bounds were ignored, so every listed session came through.
    expect(out.sessions.length).toBeGreaterThan(0);
  });

  it("survives a raw non-string or blank cursor (host path): lists from the start", async () => {
    const h = makeFakeHarness();
    for (const cursor of [7, ["s-project-2"], "  "]) {
      const out = await runToolRaw<SessionsOutput>(sessionsTool(h.source, true, TEST_LIMITS), {
        cursor,
      });
      expect(out.ok).toBe(true);
      expect(out.trimmed).toBeUndefined();
      expect(out.sessions.map((s) => s.id)).toEqual(["s-current", "s-project-2"]);
    }
  });
});

describe("recall_sessions enrichment", () => {
  it("attaches card-store digest, files, tools, and family from the card store", async () => {
    const h = makeFakeHarness();

    // No enrichment source (no store wired) → bare listings, ever.
    const cold = await runTool<SessionsOutput>(sessionsTool(h.source, true, TEST_LIMITS), {
      scope: "global",
    });
    expect(cold.sessions.every((s) => s.digest === undefined)).toBe(true);
    expect(cold.sessions.every((s) => s.files === undefined && s.tools === undefined)).toBe(true);

    // With a seeded card store, sessions carry their card's summary head, top
    // files/tools, and a family rollup for roots — served from the card store,
    // no message fetch.
    const { store, cleanup } = await makeRecallDeps(h);
    try {
      const enrichment = { cards: () => store.allCards() };
      const warm = await runTool<SessionsOutput>(
        sessionsTool(h.source, true, TEST_LIMITS, enrichment),
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
        sessionsTool(h.source, true, TEST_LIMITS, enrichment),
        { scope: "global", since: "1h" },
      );
      // All fixture sessions are within the last hour, so since:1h keeps them.
      expect(recent.sessions.length).toBeGreaterThan(0);

      // A future-only lower bound (very small window) drops everything.
      const none = await runTool<SessionsOutput>(
        sessionsTool(h.source, true, TEST_LIMITS, enrichment),
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
        sessionsTool(h.source, true, TEST_LIMITS, enrichment),
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
    const out = await runTool<SessionsOutput>(sessionsTool(h.source, true, TEST_LIMITS), {
      scope: "global",
      since: "7d",
    });
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
      sessionsTool(h.source, true, TEST_LIMITS),
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
    const out = await runTool<SessionsOutput>(sessionsTool(h.source, false, TEST_LIMITS), {
      scope: "global",
      parentID: PARENT,
    });
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
    const tool = sessionsTool(h.source, true, TEST_LIMITS);
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
    const out = await runTool<SessionsOutput>(sessionsTool(h.source, true, TEST_LIMITS), {
      parentID: PARENT,
    });
    expect(out).toMatchObject({ ok: true, scope: "children", childCount: 0, returned: 0 });
    expect(out.sessions).toEqual([]);
  });

  it("returns ok with an empty list and childCount 0 for a parent with no children", async () => {
    const h = makeFakeHarness({ children: {} });
    const out = await runTool<SessionsOutput>(sessionsTool(h.source, true, TEST_LIMITS), {
      parentID: PARENT,
    });
    expect(out).toMatchObject({ ok: true, scope: "children", childCount: 0, returned: 0 });
    expect(out.sessions).toEqual([]);
  });

  it("maps an SDK error return and a throw to distinct error shapes", async () => {
    const errored = makeFakeHarness({ childrenError: "endpoint unavailable" });
    const errOut = await runTool<ErrorOutput>(sessionsTool(errored.source, true, TEST_LIMITS), {
      parentID: PARENT,
    });
    expect(errOut.error).toBe("Failed to list children: endpoint unavailable");

    const thrown = makeFakeHarness({ childrenThrows: true });
    const thrownOut = await runTool<ErrorOutput>(sessionsTool(thrown.source, true, TEST_LIMITS), {
      parentID: PARENT,
    });
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
    const out = await runTool<SessionsOutput>(sessionsTool(h.source, true, TEST_LIMITS), {
      parentID: PARENT,
      limit: 2,
    });
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
    const out = await runTool<SessionsOutput>(sessionsTool(h.source, true, TEST_LIMITS), {
      parentID: PARENT,
    });
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
    const tool = sessionsTool(h.source, true, TEST_LIMITS);

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
        sessionsTool(h.source, true, TEST_LIMITS, enrichment),
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
      sessionsTool(h.source, true, TEST_LIMITS, enrichment),
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
    const out = await runTool<SessionsOutput>(sessionsTool(h.source, true, TEST_LIMITS), {
      parentID: PARENT,
    });
    expect(out.sessions).toHaveLength(2);
    expect(out.sessions.every((s) => s.distilled === false)).toBe(true);
  });

  it("never emits a distilled key on ordinary listings (warm and cards-lite)", async () => {
    const h = makeFakeHarness();
    const { store, cleanup } = await makeRecallDeps(h);
    try {
      const warm = await runTool<SessionsOutput>(
        sessionsTool(h.source, true, TEST_LIMITS, { cards: () => store.allCards() }),
        { scope: "global" },
      );
      expect(warm.sessions.length).toBeGreaterThan(0);
      expect(warm.sessions.every((s) => !("distilled" in s))).toBe(true);
      expect(warm.parentID).toBeUndefined();
      expect(warm.childCount).toBeUndefined();

      const lite = await runTool<SessionsOutput>(
        sessionsTool(h.source, true, TEST_LIMITS, {
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
    const out = await runTool<SessionsOutput>(sessionsTool(h.source, false, TEST_LIMITS), {
      parentID: PARENT,
    });
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
    const out = await runTool<SessionsOutput>(sessionsTool(h.source, true, TEST_LIMITS), {
      parentID: PARENT,
    });
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
    const out = await runTool<SessionsOutput>(sessionsTool(h.source, false, TEST_LIMITS), {
      parentID: "current",
    });
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
    const out = await runTool<SessionsOutput>(sessionsTool(h.source, false, TEST_LIMITS), {
      parentID: "s-current",
    });
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
    const out = await runTool<SessionsOutput>(sessionsTool(h.source, true, TEST_LIMITS), {
      parentID: PARENT,
    });
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
    const out = await runTool<SessionsOutput>(sessionsTool(h.source, false, TEST_LIMITS), {
      parentID: PARENT,
      since: "1h",
    });
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
      sessionsTool(h.source, false, TEST_LIMITS),
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
    const tool = sessionsTool(h.source, true, TEST_LIMITS);

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
        sessionsTool(h.source, true, TEST_LIMITS, enrichment),
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
        sessionsTool(h.source, true, TEST_LIMITS, enrichment),
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
        sessionsTool(h.source, true, TEST_LIMITS, enrichment),
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
        sessionsTool(h.source, true, TEST_LIMITS, enrichment),
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
        sessionsTool(h.source, true, TEST_LIMITS, enrichment),
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
        sessionsTool(h.source, true, TEST_LIMITS, enrichment),
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
        sessionsTool(h.source, true, TEST_LIMITS, enrichment),
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
      sessionsTool(h.source, true, TEST_LIMITS, enrichment),
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
      sessionsTool(h.source, true, TEST_LIMITS, enrichment),
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
        sessionsTool(h.source, true, TEST_LIMITS, enrichment),
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
        sessionsTool(h.source, true, TEST_LIMITS, enrichment),
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
      const recall = search(h.source, true, limits, deps);
      await expect(
        runTool<SearchOutput>(recall, { query: "rate", scope: "everywhere" }),
      ).rejects.toThrow();
      await expect(runTool<SearchOutput>(recall, { query: "rate", results: 3 })).rejects.toThrow();
    } finally {
      cleanup();
    }
  });
});
