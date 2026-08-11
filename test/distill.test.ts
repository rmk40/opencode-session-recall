import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, OpencodeClient, Part, Session } from "@opencode-ai/sdk/v2";
import { openSqlite, type Row, type SqliteDb } from "../src/sqlite.js";
import { openStore, type Card, type Store } from "../src/store.js";
import { createFetchGate, type FetchGate } from "../src/fetch-gate.js";
import {
  createDistiller,
  deriveCard,
  distillFields,
  fetchMessagePage,
  resolveRootId,
  type DeriveCardInput,
  type DistillSessionMeta,
} from "../src/distill.js";
import {
  apiFailure,
  assistantMessage,
  bundle,
  completedToolPart,
  errorToolPart,
  messagesResponse,
  paginateBundles,
  PROJECT_DIR,
  reasoningPart,
  session,
  subtaskPart,
  TEST_LIMITS,
  textPart,
  userMessage,
} from "./helpers.js";

type MessageBundle = { info: import("@opencode-ai/sdk/v2").Message; parts: Part[] };

// ── Temp store plumbing (real node:sqlite, per store.test.ts) ────────────────

const tmpDirs: string[] = [];
function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "recall-distill-"));
  tmpDirs.push(dir);
  return join(dir, "store.db");
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

async function freshStore(now?: () => number): Promise<{ db: SqliteDb; store: Store }> {
  const db = await openSqlite(freshDbPath());
  if (!db) throw new Error("openSqlite returned null");
  const store = openStore(db, now ? { now } : undefined);
  if (!store) throw new Error("openStore returned null");
  return { db, store };
}

// ── Fakes ────────────────────────────────────────────────────────────────────

type Graph = { sessions: Session[]; messagesBySession: Record<string, MessageBundle[]> };

type SdkCalls = {
  list: number;
  get: number;
  messages: Array<{ sessionID: string; limit?: number; before?: string }>;
};

function makeDistillFake(
  graph: Graph,
  opts: {
    throwOnce?: Set<string>;
    nonArray?: Set<string>;
    metadataErrorOnce?: Set<string>;
  } = {},
): { client: OpencodeClient; sdk: SdkCalls } {
  const sdk: SdkCalls = { list: 0, get: 0, messages: [] };
  const threw = new Set<string>();
  const client = {
    session: {
      list: async () => {
        sdk.list++;
        return { data: [...graph.sessions] };
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        sdk.get++;
        if (opts.metadataErrorOnce?.has(sessionID) && !threw.has(`meta:${sessionID}`)) {
          threw.add(`meta:${sessionID}`);
          return { error: apiFailure(`metadata transport failed: ${sessionID}`) };
        }
        const found = graph.sessions.find((s) => s.id === sessionID);
        return found ? { data: found } : { error: apiFailure(`not found: ${sessionID}`) };
      },
      messages: async (params: { sessionID: string; limit?: number; before?: string }) => {
        sdk.messages.push({
          sessionID: params.sessionID,
          limit: params.limit,
          before: params.before,
        });
        if (opts.throwOnce?.has(params.sessionID) && !threw.has(params.sessionID)) {
          threw.add(params.sessionID);
          throw new Error(`throw once: ${params.sessionID}`);
        }
        if (opts.nonArray?.has(params.sessionID)) {
          return { data: { messages: "not-an-array" } };
        }
        const data = graph.messagesBySession[params.sessionID] ?? [];
        const { items, nextCursor } = paginateBundles(
          data,
          params.limit ?? data.length,
          params.before,
        );
        return messagesResponse(items, nextCursor);
      },
    },
  } as unknown as OpencodeClient;
  return { client, sdk };
}

function makeSpyGate(): { gate: FetchGate; background: () => number } {
  const real = createFetchGate({ concurrency: 4 });
  let backgroundCount = 0;
  const gate: FetchGate = {
    runQuery: (fn) => real.runQuery(fn),
    runBackground: (fn) => {
      backgroundCount++;
      return real.runBackground(fn);
    },
    activeQueries: () => real.activeQueries(),
  };
  return { gate, background: () => backgroundCount };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function metaFromSession(s: Session): DistillSessionMeta {
  return {
    id: s.id,
    parentId: s.parentID ?? null,
    title: s.title,
    slug: s.slug,
    directory: s.directory,
    projectId: s.projectID,
    agent: null,
    model: null,
    timeCreated: s.time.created,
    timeUpdated: s.time.updated,
  };
}

function deriveInput(
  id: string,
  messages: MessageBundle[],
  opts: {
    parentById?: Map<string, string | null>;
    parentId?: string | null;
    caps?: { ftsRowsPerSession?: number; inventoryTokens?: number };
  } = {},
): DeriveCardInput {
  const parentId = opts.parentId ?? null;
  const parentById = opts.parentById ?? new Map<string, string | null>([[id, parentId]]);
  const session: DistillSessionMeta = {
    id,
    parentId,
    title: "",
    slug: id,
    directory: "",
    projectId: "",
    agent: null,
    model: null,
    timeCreated: 1000,
    timeUpdated: 2000,
  };
  return { session, messages, parentById, caps: opts.caps };
}

function fullCard(id: string, timeUpdated: number): Card {
  return {
    sessionId: id,
    parentId: null,
    rootId: id,
    title: "",
    slug: id,
    directory: "",
    projectId: "",
    agent: null,
    model: null,
    timeCreated: timeUpdated - 1000,
    timeUpdated,
    partCount: 1,
    retainedChars: 1,
    summaryHead: "",
    outcomeHead: "",
    inventory: "",
    files: [],
    tools: [],
    errors: [],
    familyRollup: [],
    distillState: "full",
    distilledThrough: "seed",
    embedding: null,
    embeddingGen: null,
    nlSummary: "",
    summaryHash: "",
  };
}

const idleEvent = (sessionID: string): Event =>
  ({ type: "session.idle", properties: { sessionID } }) as Event;
const removedEvent = (sessionID: string): Event =>
  ({
    type: "message.part.removed",
    properties: { sessionID, messageID: "m", partID: "p" },
  }) as Event;
const deletedEvent = (s: Session): Event =>
  ({ type: "session.deleted", properties: { sessionID: s.id, info: s } }) as Event;

const ftsSessions = (hits: { sessionId: string }[]): string[] => hits.map((h) => h.sessionId);

/** Test-only reader: the full stored slim-index row metadata for a session, in
 *  insertion order. FTS partId sets hide prev/next pointers, so the append path's
 *  boundary metadata is compared against a fresh full re-distill through this. */
const storedRowMeta = (db: SqliteDb, sessionId: string): Row[] =>
  db.all(
    "SELECT part_id, message_id, prev_message_id, next_message_id, class FROM part_text WHERE session_id=? ORDER BY id",
    [sessionId],
  );

// ── distillFields ────────────────────────────────────────────────────────────

describe("distillFields", () => {
  it("maps text, reasoning, subtask, and tool-input classes", () => {
    expect(distillFields(textPart("p", "s", "m", "hello world"))).toEqual([
      { class: "human-text", field: "text", text: "hello world" },
    ]);
    expect(distillFields(reasoningPart("p", "s", "m", "thinking it over"))).toEqual([
      { class: "reasoning", field: "reasoning", text: "thinking it over" },
    ]);
    expect(distillFields(subtaskPart("p", "s", "m", "desc here", "prompt here"))).toEqual([
      { class: "human-text", field: "text", text: "desc here\n\nprompt here" },
    ]);

    const tool = completedToolPart("p", "s", "m", "bash", { command: "npm test" }, "the output");
    const fields = distillFields(tool);
    expect(fields.some((f) => f.class === "tool-input" && f.text === "npm test")).toBe(true);
    expect(fields.some((f) => f.text.startsWith("{"))).toBe(true); // capped JSON input row
    expect(fields.some((f) => f.text.includes("the output"))).toBe(false); // never the output
  });

  it("excludes self-tool parts entirely, bare and namespaced", () => {
    expect(
      distillFields(completedToolPart("p", "s", "m", "recall", { query: "x" }, "prior")),
    ).toEqual([]);
    expect(
      distillFields(
        completedToolPart(
          "p",
          "s",
          "m",
          "mcp__opencode-session-recall__recall",
          { query: "x" },
          "prior",
        ),
      ),
    ).toEqual([]);
  });

  it("excludes only the synthetic recall-auto sentinel", () => {
    const auto = {
      ...textPart("p", "s", "m", "<recall-auto> restated terms"),
      synthetic: true,
    } as Part;
    expect(distillFields(auto)).toEqual([]);
    const otherSynthetic = {
      ...textPart("p", "s", "m", "host injected context"),
      synthetic: true,
    } as Part;
    expect(distillFields(otherSynthetic)).toHaveLength(1);
  });

  it("indexes command/cwd always but the JSON blob only for non-read/skill tools", () => {
    const read = distillFields(
      completedToolPart(
        "p",
        "s",
        "m",
        "read",
        { filePath: "src/x.ts", command: "probe" },
        "contents",
      ),
    );
    expect(read.some((f) => f.text === "probe")).toBe(true); // command still indexed
    expect(read.some((f) => f.text.startsWith("{"))).toBe(false); // read JSON blob excluded

    const bash = distillFields(
      completedToolPart("p", "s", "m", "bash", { command: "ls", cwd: "/tmp" }, "out"),
    );
    expect(bash.some((f) => f.field === "command" && f.text === "ls")).toBe(true);
    expect(bash.some((f) => f.field === "cwd" && f.text === "/tmp")).toBe(true);
    expect(bash.some((f) => f.text.startsWith("{"))).toBe(true);
  });

  it("caps text/reasoning at 2000 and tool inputs at 1000, slicing cleanly", () => {
    expect(distillFields(textPart("p", "s", "m", "a".repeat(5000)))[0]!.text.length).toBe(2000);
    const bigCommand = distillFields(
      completedToolPart("p", "s", "m", "bash", { command: "x".repeat(3000) }, "out"),
    ).find((f) => f.text.startsWith("x"))!;
    expect(bigCommand.text.length).toBe(1000);
  });
});

// ── deriveCard ───────────────────────────────────────────────────────────────

describe("deriveCard", () => {
  it("builds norm rows with both tokenized and verbatim code tokens", () => {
    const messages = [
      bundle(userMessage("m1", "s1", 1000), [
        textPart("p1", "s1", "m1", "set GHOSTAUTH_LIVE_TUI now"),
      ]),
    ];
    const norm = deriveCard(deriveInput("s1", messages)).rows[0]!.norm;
    expect(norm).toContain("GHOSTAUTH_LIVE_TUI"); // verbatim compound
    for (const token of ["ghostauth", "live", "tui"]) expect(norm).toContain(token); // tokenized
  });

  it("keeps read/skill/JSON pollution out of the inventory but keeps code anchors + commands", () => {
    const messages = [
      bundle(userMessage("m1", "s1", 1000), [
        textPart("p1", "s1", "m1", "investigate launchTerminal timeout behavior"),
      ]),
      bundle(assistantMessage("m2", "s1", 2000), [
        completedToolPart(
          "p2",
          "s1",
          "m2",
          "read",
          { filePath: "vault/passwordfile" },
          "TOPSECRETBODY",
        ),
      ]),
      bundle(assistantMessage("m3", "s1", 3000), [
        completedToolPart("p3", "s1", "m3", "bash", { command: "wrangler deploy" }, "done"),
      ]),
    ];
    const inventory = deriveCard(deriveInput("s1", messages)).card.inventory;
    const tokens = inventory.split(" ");
    expect(tokens).toContain("launchTerminal"); // code anchor from user text
    expect(tokens).toContain("wrangler"); // command token
    expect(tokens).toContain("deploy");
    expect(inventory.toLowerCase()).not.toContain("password"); // read input never indexed
    expect(inventory.toLowerCase()).not.toContain("topsecret"); // output never indexed
  });

  it("collects error signatures from error states and error-pattern outputs, deduped", () => {
    const messages = [
      bundle(assistantMessage("m1", "s1", 1000), [
        errorToolPart(
          "e1",
          "s1",
          "m1",
          "bash",
          { command: "a" },
          "ECONNRESET during deploy\nstack",
        ),
        errorToolPart(
          "e2",
          "s1",
          "m1",
          "bash",
          { command: "b" },
          "ECONNRESET during deploy\nother",
        ),
        completedToolPart(
          "c1",
          "s1",
          "m1",
          "bash",
          { command: "c" },
          "Error: build failed at step 3",
        ),
        completedToolPart(
          "c2",
          "s1",
          "m1",
          "bash",
          { command: "d" },
          "all clear, nothing to report",
        ),
      ]),
    ];
    const errors = deriveCard(deriveInput("s1", messages)).card.errors;
    expect(errors).toContain("ECONNRESET during deploy");
    expect(errors).toContain("Error: build failed at step 3");
    expect(errors.filter((e) => e === "ECONNRESET during deploy")).toHaveLength(1); // first line, deduped
    expect(errors.some((e) => e.includes("all clear"))).toBe(false); // not an error pattern
  });

  it("caps error signatures at 8, keeping the earliest distinct", () => {
    const tools = Array.from({ length: 10 }, (_, i) =>
      completedToolPart(
        `e${i}`,
        "s1",
        "m1",
        "bash",
        { command: `c${i}` },
        `Error number ${i} occurred`,
      ),
    );
    const errors = deriveCard(
      deriveInput("s1", [bundle(assistantMessage("m1", "s1", 1000), tools)]),
    ).card.errors;
    expect(errors).toHaveLength(8);
    expect(errors[0]).toBe("Error number 0 occurred");
    expect(errors).not.toContain("Error number 8 occurred");
  });

  it("collects files from read/edit/write inputs, capped at 30 keeping the newest", () => {
    const messages = Array.from({ length: 35 }, (_, i) =>
      bundle(assistantMessage(`m${i}`, "s1", 1000 + i), [
        completedToolPart(`f${i}`, "s1", `m${i}`, "edit", { filePath: `src/file${i}.ts` }, "ok"),
      ]),
    );
    const files = deriveCard(deriveInput("s1", messages)).card.files;
    expect(files).toHaveLength(30);
    expect(files).toContain("src/file34.ts"); // newest kept
    expect(files).not.toContain("src/file0.ts"); // oldest dropped
  });

  it("resolves root by walking parentID within the known set", () => {
    const parentById = new Map<string, string | null>([
      ["a", null],
      ["b", "a"],
      ["c", "b"],
    ]);
    expect(resolveRootId("c", parentById)).toBe("a");
    // Missing parent → the highest known session is the root.
    expect(resolveRootId("x", new Map([["x", "ghost"]]))).toBe("x");
    // A parentID cycle terminates (no hang) at the last unseen ancestor.
    expect(
      resolveRootId(
        "a",
        new Map([
          ["a", "b"],
          ["b", "a"],
        ]),
      ),
    ).toBe("b");

    const card = deriveCard(deriveInput("c", [], { parentById, parentId: "b" })).card;
    expect(card.rootId).toBe("a");
  });

  it("leaves family_rollup empty (the distiller fills roots)", () => {
    const card = deriveCard(
      deriveInput("s1", [bundle(userMessage("m1", "s1", 1000), [textPart("p", "s1", "m1", "hi")])]),
    ).card;
    expect(card.familyRollup).toEqual([]);
  });

  it("sets distilled_through to the newest message id and derives the heads", () => {
    const messages = [
      bundle(userMessage("m1", "s1", 1000), [
        textPart("p1", "s1", "m1", "first request about the parser"),
      ]),
      bundle(assistantMessage("m2", "s1", 2000), [
        textPart("p2", "s1", "m2", "final answer, parser fixed"),
      ]),
    ];
    const card = deriveCard(deriveInput("s1", messages)).card;
    expect(card.distilledThrough).toBe("m2");
    expect(card.summaryHead).toBe("first request about the parser");
    expect(card.outcomeHead).toBe("final answer, parser fixed");
    expect(card.partCount).toBe(2);
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

  it("throws on an SDK error", async () => {
    const { client } = clientReturning(() => ({ error: apiFailure("boom") }));
    await expect(fetchMessagePage(client, { sessionID: "s", limit: 5 })).rejects.toThrow("boom");
  });
});

// ── Cold pass ────────────────────────────────────────────────────────────────

describe("cold pass", () => {
  function malformedBundle(sessionId: string): MessageBundle {
    return {
      info: userMessage(`m-${sessionId}`, sessionId, 100),
      parts: undefined,
    } as unknown as MessageBundle;
  }

  it("quarantines a malformed session and continues processing the pass", async () => {
    const bad = session("bad", "Bad", PROJECT_DIR, 3000);
    const good = session("good", "Good", PROJECT_DIR, 2000);
    const graph: Graph = {
      sessions: [bad, good],
      messagesBySession: {
        bad: [malformedBundle("bad")],
        good: [
          bundle(userMessage("m-good", "good", 100), [
            textPart("p-good", "good", "m-good", "valid session content"),
          ]),
        ],
      },
    };
    const { client } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const logs: string[] = [];
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "malformed-continue",
      log: (message) => logs.push(message),
    });

    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");

    expect(store.getCard("bad")).toBeUndefined();
    expect(store.getCard("good")?.distillState).toBe("full");
    expect(logs.some((line) => line.includes("session bad quarantined at timeUpdated 3000:"))).toBe(
      true,
    );
    await distiller.stop();
    db.close();
  });

  it("skips an unchanged quarantined session on a later cold-pass retry", async () => {
    const graph: Graph = {
      sessions: [
        session("bad", "Bad", PROJECT_DIR, 3000),
        session("flaky", "Flaky", PROJECT_DIR, 2000),
        session("good", "Good", PROJECT_DIR, 1000),
      ],
      messagesBySession: {
        bad: [malformedBundle("bad")],
        flaky: [
          bundle(userMessage("m-flaky", "flaky", 100), [
            textPart("p-flaky", "flaky", "m-flaky", "flaky content"),
          ]),
        ],
        good: [
          bundle(userMessage("m-good", "good", 100), [
            textPart("p-good", "good", "m-good", "good content"),
          ]),
        ],
      },
    };
    const { client, sdk } = makeDistillFake(graph, { throwOnce: new Set(["flaky"]) });
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "malformed-skip",
      coldPassRetryMs: 15,
    });

    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");

    expect(sdk.list).toBe(2);
    expect(sdk.messages.filter((call) => call.sessionID === "bad")).toHaveLength(1);
    expect(store.getCard("good")?.distillState).toBe("full");
    await distiller.stop();
    db.close();
  });

  it("preserves an existing card and FTS rows for a non-array message payload", async () => {
    const current = session("bad", "Bad", PROJECT_DIR, 2000);
    const old = session("bad", "Bad", PROJECT_DIR, 1000);
    const oldMessages = [
      bundle(userMessage("m-old", "bad", 100), [
        textPart("p-old", "bad", "m-old", "preserved_fts_marker"),
      ]),
    ];
    const graph: Graph = { sessions: [current], messagesBySession: { bad: oldMessages } };
    const { client } = makeDistillFake(graph, { nonArray: new Set(["bad"]) });
    const { db, store } = await freshStore();
    const seeded = deriveCard({
      session: metaFromSession(old),
      messages: oldMessages,
      parentById: new Map([["bad", null]]),
    });
    store.replaceSessionParts("bad", seeded.rows, seeded.card);
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "non-array-preserve",
    });

    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");

    expect(store.getCard("bad")).toEqual(seeded.card);
    expect(ftsSessions(store.ftsSearch({ strong: ["preserved_fts_marker"], weak: [] }))).toEqual([
      "bad",
    ]);
    await distiller.stop();
    db.close();
  });

  it("does not arm a cold-pass retry when discovery fails after stop", async () => {
    vi.useFakeTimers();
    const { db, store } = await freshStore();
    try {
      let rejectDiscovery!: (error: Error) => void;
      const discovery = new Promise<Session[]>((_, reject) => {
        rejectDiscovery = reject;
      });
      const discover = vi.fn(() => discovery);
      const { client } = makeDistillFake({ sessions: [], messagesBySession: {} });
      const { gate } = makeSpyGate();
      const distiller = createDistiller({
        client,
        store,
        gate,
        limits: TEST_LIMITS,
        instanceId: "late-discovery-failure",
        coldPassRetryMs: 100,
        discover,
      });

      distiller.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(discover).toHaveBeenCalledOnce();
      const stopping = distiller.stop();
      rejectDiscovery(new Error("late discovery failure"));
      await stopping;

      expect(vi.getTimerCount()).toBe(0);
      expect(discover).toHaveBeenCalledOnce();
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });

  it("does not fetch another message page or write progress after stop during a delay", async () => {
    vi.useFakeTimers();
    const { db, store } = await freshStore();
    try {
      const meta = session("s1", "Paged", PROJECT_DIR, 2000);
      let messageCalls = 0;
      const first = bundle(userMessage("m1", "s1", 100), [
        textPart("p1", "s1", "m1", "first page"),
      ]);
      const client = {
        session: {
          messages: async () => {
            messageCalls++;
            return messagesResponse(
              messageCalls === 1 ? [first] : [],
              messageCalls === 1 ? "next" : null,
            );
          },
        },
      } as unknown as OpencodeClient;
      const { gate } = makeSpyGate();
      const distiller = createDistiller({
        client,
        store,
        gate,
        limits: { ...TEST_LIMITS, distillDelayMs: 100 },
        instanceId: "stop-pagination",
        discover: async () => [meta],
      });

      distiller.start();
      for (let i = 0; i < 8 && messageCalls === 0; i++) await Promise.resolve();
      expect(messageCalls).toBe(1);
      const stopping = distiller.stop();
      await vi.advanceTimersByTimeAsync(100);
      await stopping;

      expect(messageCalls).toBe(1);
      expect(store.getCard("s1")).toBeUndefined();
      expect(store.getMeta("coldpass_cursor")).toBeUndefined();
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });

  it("does not start a message request that was queued in the gate when stopped", async () => {
    const { db, store } = await freshStore();
    try {
      const meta = session("s1", "Queued", PROJECT_DIR, 2000);
      let messageCalls = 0;
      let releaseQuery!: () => void;
      const queryBlocked = new Promise<void>((resolve) => {
        releaseQuery = resolve;
      });
      let queryStarted!: () => void;
      const queryIsRunning = new Promise<void>((resolve) => {
        queryStarted = resolve;
      });
      let messageQueued!: () => void;
      const messageIsQueued = new Promise<void>((resolve) => {
        messageQueued = resolve;
      });
      const realGate = createFetchGate({ concurrency: 1 });
      let backgroundCalls = 0;
      const gate: FetchGate = {
        runQuery: (fn) => realGate.runQuery(fn),
        runBackground: (fn) => {
          backgroundCalls++;
          if (backgroundCalls === 2) messageQueued();
          return realGate.runBackground(fn);
        },
        activeQueries: () => realGate.activeQueries(),
      };
      const client = {
        session: {
          messages: async () => {
            messageCalls++;
            return messagesResponse([], null);
          },
        },
      } as unknown as OpencodeClient;
      const distiller = createDistiller({
        client,
        store,
        gate,
        limits: TEST_LIMITS,
        instanceId: "stop-gate-queue",
        discover: async () => {
          void gate.runQuery(async () => {
            queryStarted();
            await queryBlocked;
          });
          return [meta];
        },
      });

      distiller.start();
      await queryIsRunning;
      await messageIsQueued;
      const stopping = distiller.stop();
      releaseQuery();
      await stopping;

      expect(messageCalls).toBe(0);
      expect(store.getCard("s1")).toBeUndefined();
      expect(store.getMeta("coldpass_cursor")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("retries a quarantined session after its update timestamp changes", async () => {
    const bad = session("bad", "Bad", PROJECT_DIR, 3000);
    const graph: Graph = {
      sessions: [bad, session("flaky", "Flaky", PROJECT_DIR, 2000)],
      messagesBySession: {
        bad: [malformedBundle("bad")],
        flaky: [
          bundle(userMessage("m-flaky", "flaky", 100), [
            textPart("p-flaky", "flaky", "m-flaky", "flaky content"),
          ]),
        ],
      },
    };
    const { client, sdk } = makeDistillFake(graph, { throwOnce: new Set(["flaky"]) });
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "malformed-update",
      coldPassRetryMs: 100,
    });

    distiller.start();
    await waitFor(() => distiller.status().lastError != null);
    bad.time.updated = 4000;
    graph.messagesBySession.bad = [
      bundle(userMessage("m-bad-fixed", "bad", 100), [
        textPart("p-bad-fixed", "bad", "m-bad-fixed", "repaired content"),
      ]),
    ];
    await waitFor(() => distiller.status().coldPass === "done");

    expect(sdk.messages.filter((call) => call.sessionID === "bad")).toHaveLength(2);
    expect(store.getCard("bad")?.timeUpdated).toBe(4000);
    await distiller.stop();
    db.close();
  });

  it("distills newest-updated-first, skips up-to-date cards, routes every fetch through the gate", async () => {
    const s1 = session("s1", "Alpha", PROJECT_DIR, 3000);
    const s2 = session("s2", "Bravo", PROJECT_DIR, 2000);
    const s3 = session("s3", "Charlie", PROJECT_DIR, 1000);
    const graph: Graph = {
      sessions: [s2, s3, s1], // deliberately unsorted
      messagesBySession: {
        s1: [
          bundle(userMessage("m1", "s1", 100), [textPart("p1", "s1", "m1", "alpha content zulu")]),
        ],
        s2: [
          bundle(userMessage("m2", "s2", 100), [
            textPart("p2", "s2", "m2", "bravo content yankee"),
          ]),
        ],
        s3: [
          bundle(userMessage("m3", "s3", 100), [
            textPart("p3", "s3", "m3", "charlie content xray"),
          ]),
        ],
      },
    };
    const { client, sdk } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    store.upsertCard(fullCard("s2", 2000)); // already current → must be skipped
    const { gate, background } = makeSpyGate();
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "cold-1",
    });

    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");

    expect(sdk.messages.map((c) => c.sessionID)).toEqual(["s1", "s3"]); // newest-first, s2 skipped
    expect(store.getCard("s1")?.distillState).toBe("full");
    expect(ftsSessions(store.ftsSearch({ strong: ["zulu"], weak: [] }))).toEqual(["s1"]);
    expect(background()).toBe(sdk.list + sdk.messages.length); // list + pages, all gated
    expect(sdk.messages.every((c) => c.limit != null)).toBe(true); // never an unbounded fetch

    distiller.stop();
    db.close();
  });

  it("resumes from the checkpoint after a mid-pass fetch failure", async () => {
    const s1 = session("s1", "Alpha", PROJECT_DIR, 3000);
    const s2 = session("s2", "Bravo", PROJECT_DIR, 2000);
    const s3 = session("s3", "Charlie", PROJECT_DIR, 1000);
    const graph: Graph = {
      sessions: [s1, s2, s3],
      messagesBySession: {
        s1: [bundle(userMessage("m1", "s1", 100), [textPart("p1", "s1", "m1", "alpha zulu")])],
        s2: [bundle(userMessage("m2", "s2", 100), [textPart("p2", "s2", "m2", "bravo yankee")])],
        s3: [bundle(userMessage("m3", "s3", 100), [textPart("p3", "s3", "m3", "charlie xray")])],
      },
    };
    const { client } = makeDistillFake(graph, { throwOnce: new Set(["s2"]) });
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const limits = { ...TEST_LIMITS, distillConcurrency: 1 };

    const first = createDistiller({ client, store, gate, limits, instanceId: "cold-a" });
    first.start();
    await waitFor(() => first.status().coldPass !== "running");
    expect(first.status().lastError).toBeDefined();
    expect(store.getCard("s1")?.distillState).toBe("full"); // processed before the failure
    expect(store.getCard("s2")).toBeUndefined(); // failed
    expect(store.getCard("s3")).toBeUndefined(); // never reached (pass aborted)
    first.stop(); // releases the lease

    const second = createDistiller({ client, store, gate, limits, instanceId: "cold-b" });
    second.start();
    await waitFor(() => second.status().coldPass === "done");
    expect(store.getCard("s2")?.distillState).toBe("full"); // completed on resume
    expect(store.getCard("s3")?.distillState).toBe("full");
    second.stop();
    db.close();
  });

  it("honors the per-session FTS row cap, keeping the newest rows", async () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      bundle(userMessage(`m${i}`, "g", 1000 + i), [
        textPart(`p${i}`, "g", `m${i}`, `rowmarker unique${i}end`),
      ]),
    );
    const graph: Graph = {
      sessions: [session("g", "Giant", PROJECT_DIR, 5000)],
      messagesBySession: { g: messages },
    };
    const { client } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: { ...TEST_LIMITS, ftsRowsPerSession: 5 },
      instanceId: "giant",
      pageMessages: 4,
    });

    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");

    expect(ftsSessions(store.ftsSearch({ strong: ["unique19end"], weak: [] }))).toEqual(["g"]); // newest kept
    expect(ftsSessions(store.ftsSearch({ strong: ["unique15end"], weak: [] }))).toEqual(["g"]);
    expect(store.ftsSearch({ strong: ["unique14end"], weak: [] })).toEqual([]); // capped out
    expect(store.ftsSearch({ strong: ["unique0end"], weak: [] })).toEqual([]); // never fetched
    distiller.stop();
    db.close();
  });

  it("builds capped family rollups on roots with child provenance", async () => {
    const root = session("R", "Root Session", PROJECT_DIR, 9000);
    const children = Array.from({ length: 15 }, (_, i) =>
      session(`C${i}`, `Child ${i}`, PROJECT_DIR, 1000 + i, undefined, "R"),
    );
    const messagesBySession: Record<string, MessageBundle[]> = {
      R: [bundle(userMessage("mR", "R", 100), [textPart("pR", "R", "mR", "root coordination")])],
    };
    for (const child of children) {
      messagesBySession[child.id] = [
        bundle(userMessage(`m-${child.id}`, child.id, 100), [
          textPart(`p-${child.id}`, child.id, `m-${child.id}`, `child ${child.id} work`),
        ]),
      ];
    }
    const { client } = makeDistillFake({ sessions: [root, ...children], messagesBySession });
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "fam",
    });

    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");

    const rollup = store.getCard("R")!.familyRollup;
    expect(rollup).toHaveLength(12); // capped
    expect(rollup[0]!.sessionId).toBe("C14"); // newest child first
    expect(rollup[0]!.messageId).toBe("m-C14"); // provenance to the child transcript
    expect(rollup[0]!.snippet).toBe("Child 14"); // hint = child title
    distiller.stop();
    db.close();
  });

  it("a cold pass over an already-distilled store keeps persisted root vectors intact", async () => {
    const root = session("R", "Root Session", PROJECT_DIR, 9000);
    const child = session("C0", "Child 0", PROJECT_DIR, 1000, undefined, "R");
    const messagesBySession: Record<string, MessageBundle[]> = {
      R: [bundle(userMessage("mR", "R", 100), [textPart("pR", "R", "mR", "root coordination")])],
      C0: [bundle(userMessage("mC0", "C0", 100), [textPart("pC0", "C0", "mC0", "child work")])],
    };
    const { client } = makeDistillFake({ sessions: [root, child], messagesBySession });
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();

    // First pass distills the family and builds the root's rollup.
    const first = createDistiller({
      client,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "first",
    });
    first.start();
    await waitFor(() => first.status().coldPass === "done");
    expect(store.getCard("R")!.familyRollup.length).toBeGreaterThan(0);
    first.stop(); // releases the lease

    // A prior semantic run persisted the root's card vector.
    const vec = new Uint8Array([7, 7, 7, 7]);
    store.writeCardEmbeddings("model-x", 4, [
      { sessionId: "R", embedding: vec, expectedSummaryHash: "" },
    ]);
    expect(store.getCard("R")!.embedding).toEqual(vec);

    // Warm restart: the cold pass skips the up-to-date cards but still recomputes
    // every root's rollup. That rollup upsert must NOT wipe the persisted vector.
    const second = createDistiller({
      client,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "second",
    });
    second.start();
    await waitFor(() => second.status().coldPass === "done");
    expect(store.getCard("R")!.embedding).toEqual(vec); // survived the rollup recompute
    expect(store.getCard("R")!.familyRollup.length).toBeGreaterThan(0); // rollup still intact
    second.stop();
    db.close();
  });

  it("recovers a concurrency-2 cold pass from a mid-pass failure via backoff retry", async () => {
    const graph: Graph = {
      sessions: [
        session("s1", "One", PROJECT_DIR, 4000),
        session("s2", "Two", PROJECT_DIR, 3000),
        session("s3", "Three", PROJECT_DIR, 2000),
        session("s4", "Four", PROJECT_DIR, 1000),
      ],
      messagesBySession: {
        s1: [bundle(userMessage("m1", "s1", 100), [textPart("p1", "s1", "m1", "one content")])],
        s2: [bundle(userMessage("m2", "s2", 100), [textPart("p2", "s2", "m2", "two content")])],
        s3: [bundle(userMessage("m3", "s3", 100), [textPart("p3", "s3", "m3", "three content")])],
        s4: [bundle(userMessage("m4", "s4", 100), [textPart("p4", "s4", "m4", "four content")])],
      },
    };
    // s2 throws on its first fetch (mid-pass "crash"); succeeds on the retry.
    const { client, sdk } = makeDistillFake(graph, { throwOnce: new Set(["s2"]) });
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 2 },
      instanceId: "cc2",
      coldPassRetryMs: 15,
    });

    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");

    for (const id of ["s1", "s2", "s3", "s4"]) {
      expect(store.getCard(id)?.distillState).toBe("full");
    }
    expect(sdk.messages.filter((c) => c.sessionID === "s2").length).toBe(2); // threw once, retried
    expect(sdk.list).toBe(2); // discovery re-ran on the backoff retry
    distiller.stop();
    db.close();
  });

  it("uses an injected discover function instead of client.session.list", async () => {
    const s1 = session("s1", "One", PROJECT_DIR, 3000);
    const s2 = session("s2", "Two", PROJECT_DIR, 2000);
    const graph: Graph = {
      sessions: [s1, s2],
      messagesBySession: {
        s1: [bundle(userMessage("m1", "s1", 100), [textPart("p1", "s1", "m1", "one content")])],
        s2: [bundle(userMessage("m2", "s2", 100), [textPart("p2", "s2", "m2", "two content")])],
      },
    };
    const { client, sdk } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate, background } = makeSpyGate();
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "disc",
      discover: async () => [s1], // only s1 is discovered
    });

    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");

    expect(store.getCard("s1")?.distillState).toBe("full");
    expect(store.getCard("s2")).toBeUndefined(); // never discovered
    expect(sdk.list).toBe(0); // client.session.list bypassed
    expect(background()).toBeGreaterThan(0); // discover still routed through the gate
    distiller.stop();
    db.close();
  });

  it("bumps cards_rev on every store write so tier-1 can detect changes", async () => {
    const graph: Graph = {
      sessions: [session("s1", "One", PROJECT_DIR, 3000)],
      messagesBySession: {
        s1: [bundle(userMessage("m1", "s1", 100), [textPart("p1", "s1", "m1", "one content")])],
      },
    };
    const { client } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "rev",
      idleDebounceMs: 5,
    });

    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");
    const afterCold = Number(store.getMeta("cards_rev"));
    expect(afterCold).toBeGreaterThan(0);

    distiller.onEvent(idleEvent("s1")); // an incremental re-distill bumps it again
    await waitFor(() => Number(store.getMeta("cards_rev")) > afterCold);
    distiller.stop();
    db.close();
  });
});

// ── Lease ────────────────────────────────────────────────────────────────────

describe("lease", () => {
  it("a non-holder writes nothing on start or events", async () => {
    const graph: Graph = {
      sessions: [session("s1", "Alpha", PROJECT_DIR, 3000)],
      messagesBySession: {
        s1: [bundle(userMessage("m1", "s1", 100), [textPart("p1", "s1", "m1", "alpha")])],
      },
    };
    const { client, sdk } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    expect(store.acquireLease("other", 30_000, "otherbuild", 4)).toBe(true); // someone else holds it
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "B",
      idleDebounceMs: 5,
    });

    distiller.start();
    await new Promise((r) => setTimeout(r, 15));
    expect(distiller.status().leaseHeld).toBe(false);

    distiller.onEvent(idleEvent("s1"));
    await new Promise((r) => setTimeout(r, 25)); // well past the debounce

    expect(store.allCards()).toEqual([]); // no cards written
    expect(sdk.messages).toEqual([]); // never fetched
    distiller.stop();
    db.close();
  });

  it("takes over an expired lease after its TTL", async () => {
    let clock = 1_000_000;
    const graph: Graph = {
      sessions: [session("s1", "Alpha", PROJECT_DIR, 3000)],
      messagesBySession: {
        s1: [bundle(userMessage("m1", "s1", 100), [textPart("p1", "s1", "m1", "alpha")])],
      },
    };
    const { client } = makeDistillFake(graph);
    const { db, store } = await freshStore(() => clock);
    expect(store.acquireLease("A", 30_000, "buildA", 4)).toBe(true); // A holds it, then "dies" (no heartbeat)
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "B",
      now: () => clock,
      leaseRetryMs: 5,
    });

    distiller.start();
    await new Promise((r) => setTimeout(r, 15));
    expect(distiller.status().leaseHeld).toBe(false); // A's lease still fresh

    clock += 31_000; // past A's TTL
    await waitFor(() => distiller.status().leaseHeld === true); // B's retry takes over
    await waitFor(() => distiller.status().coldPass === "done");
    expect(store.getCard("s1")?.distillState).toBe("full");
    distiller.stop();
    db.close();
  });
});

// ── Incremental ──────────────────────────────────────────────────────────────

describe("incremental", () => {
  it("logs metadata transport errors without changing a valid card and retries on a later event", async () => {
    const original = session("s1", "Alpha", PROJECT_DIR, 3000);
    const graph: Graph = {
      sessions: [original],
      messagesBySession: {
        s1: [
          bundle(userMessage("m1", "s1", 100), [
            textPart("p1", "s1", "m1", "preserved metadata transport marker"),
          ]),
        ],
      },
    };
    const { client, sdk } = makeDistillFake(graph, {
      metadataErrorOnce: new Set(["s1"]),
    });
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const logs: string[] = [];
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "metadata-transport",
      idleDebounceMs: 5,
      log: (message) => logs.push(message),
    });
    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");
    const preserved = store.getCard("s1");

    graph.sessions[0] = session("s1", "Alpha updated", PROJECT_DIR, 4000);
    graph.messagesBySession.s1 = [
      bundle(userMessage("m2", "s1", 200), [
        textPart("p2", "s1", "m2", "fresh metadata transport marker"),
      ]),
    ];
    distiller.onEvent(idleEvent("s1"));
    await waitFor(() => sdk.get === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(store.getCard("s1")).toEqual(preserved);
    expect(logs.some((line) => line.includes("session s1 re-distill failed:"))).toBe(true);
    expect(logs.some((line) => line.includes("metadata transport failed: s1"))).toBe(true);

    // A later idle event retries normally; the transport failure was neither
    // interpreted as deletion nor quarantined as malformed session data.
    distiller.onEvent(idleEvent("s1"));
    await waitFor(() => store.getCard("s1")?.timeUpdated === 4000);
    expect(sdk.get).toBe(2);
    expect(store.getCard("s1")?.summaryHead).toContain("fresh metadata transport marker");
    await distiller.stop();
    db.close();
  });

  it("coalesces an idle burst into a single re-distill", async () => {
    const graph: Graph = {
      sessions: [session("s1", "Alpha", PROJECT_DIR, 3000)],
      messagesBySession: {
        s1: [bundle(userMessage("m1", "s1", 100), [textPart("p1", "s1", "m1", "alpha")])],
      },
    };
    const { client, sdk } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "holder",
      idleDebounceMs: 10,
    });
    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");

    const before = sdk.messages.length;
    for (let i = 0; i < 5; i++) distiller.onEvent(idleEvent("s1"));
    await waitFor(() => sdk.messages.length > before);
    await new Promise((r) => setTimeout(r, 40)); // let any stragglers land

    expect(sdk.messages.length - before).toBe(1); // five idles → one re-distill fetch
    distiller.stop();
    db.close();
  });

  it("forces a full re-distill on a removal event, dropping stale FTS text", async () => {
    const graph: Graph = {
      sessions: [session("s1", "Alpha", PROJECT_DIR, 3000)],
      messagesBySession: {
        s1: [
          bundle(userMessage("m1", "s1", 100), [textPart("p1", "s1", "m1", "stalemarker content")]),
        ],
      },
    };
    const { client } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    // appendThresholdParts 0 makes the session append-eligible, so only the
    // removal semantics (not size) force the full path that drops stale rows.
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "holder",
      idleDebounceMs: 5,
      appendThresholdParts: 0,
    });
    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");
    expect(ftsSessions(store.ftsSearch({ strong: ["stalemarker"], weak: [] }))).toEqual(["s1"]);

    graph.messagesBySession.s1 = [
      bundle(userMessage("m9", "s1", 5000), [textPart("p9", "s1", "m9", "freshmarker content")]),
    ];
    distiller.onEvent(removedEvent("s1"));
    await waitFor(
      () => ftsSessions(store.ftsSearch({ strong: ["freshmarker"], weak: [] })).length > 0,
    );

    expect(store.ftsSearch({ strong: ["stalemarker"], weak: [] })).toEqual([]); // full replace, not append
    distiller.stop();
    db.close();
  });

  it("deletes the card and its rows and refreshes the root rollup", async () => {
    const root = session("R", "Root Session", PROJECT_DIR, 9000);
    const child = session("C", "Child Session", PROJECT_DIR, 4000, undefined, "R");
    const graph: Graph = {
      sessions: [root, child],
      messagesBySession: {
        R: [bundle(userMessage("mR", "R", 100), [textPart("pR", "R", "mR", "root uniquerootzz")])],
        C: [
          bundle(userMessage("mC", "C", 100), [textPart("pC", "C", "mC", "child uniquechildyy")]),
        ],
      },
    };
    const { client } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "holder",
    });
    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");
    expect(store.getCard("R")!.familyRollup.map((e) => e.sessionId)).toContain("C");

    distiller.onEvent(deletedEvent(child));

    expect(store.getCard("C")).toBeUndefined();
    expect(store.ftsSearch({ strong: ["uniquechildyy"], weak: [] })).toEqual([]);
    expect(store.getCard("R")!.familyRollup.map((e) => e.sessionId)).not.toContain("C");
    distiller.stop();
    db.close();
  });

  it("append mode fetches only new pages and its card equals a full re-distill", async () => {
    const s1 = session("s1", "Growing", PROJECT_DIR, 3000);
    const initial: MessageBundle[] = [
      bundle(userMessage("m0", "s1", 1000), [
        textPart("p0", "s1", "m0", "start on the widget parser"),
      ]),
      bundle(assistantMessage("m1", "s1", 1001), [
        reasoningPart("p1", "s1", "m1", "consider launchTerminal internals"),
      ]),
      bundle(assistantMessage("m2", "s1", 1002), [
        completedToolPart("p2", "s1", "m2", "bash", { command: "npm run build" }, "built"),
      ]),
      bundle(assistantMessage("m3", "s1", 1003), [
        completedToolPart("p3", "s1", "m3", "edit", { filePath: "src/widget.ts" }, "edited"),
      ]),
      bundle(assistantMessage("m4", "s1", 1004), [
        errorToolPart(
          "p4",
          "s1",
          "m4",
          "bash",
          { command: "deploy prod" },
          "ECONNRESET boom during deploy",
        ),
      ]),
      bundle(assistantMessage("m5", "s1", 1005), [
        textPart("p5", "s1", "m5", "midpoint status update"),
      ]),
    ];
    const graph: Graph = { sessions: [s1], messagesBySession: { s1: [...initial] } };
    const { client, sdk } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "holder",
      pageMessages: 2,
      appendThresholdParts: 1,
      idleDebounceMs: 5,
    });
    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");
    expect(store.getCard("s1")!.partCount).toBeGreaterThan(1); // append-eligible

    // Persist a card vector before the append so the append path must decide
    // whether to carry it forward (stale) or clear it. It must clear it — the
    // append changed the inventory/heads the vector is derived from — matching a
    // full re-distill, which stores a null embedding.
    store.writeCardEmbeddings("model-x", 4, [
      { sessionId: "s1", embedding: new Uint8Array([9, 9, 9, 9]), expectedSummaryHash: "" },
    ]);
    expect(store.getCard("s1")!.embedding).not.toBeNull();

    const appended: MessageBundle[] = [
      bundle(assistantMessage("m6", "s1", 1006), [
        completedToolPart("p6", "s1", "m6", "edit", { filePath: "src/new.ts" }, "edited new"),
      ]),
      bundle(assistantMessage("m7", "s1", 1007), [
        textPart("p7", "s1", "m7", "final outcome text summary"),
      ]),
    ];
    graph.messagesBySession.s1 = [...initial, ...appended];

    const before = sdk.messages.length;
    distiller.onEvent(idleEvent("s1"));
    await waitFor(() => store.getCard("s1")!.distilledThrough === "m7");
    const appendFetches = sdk.messages.length - before;

    // Full over 8 messages at page size 2 is 4 fetches; append halts at the
    // checkpoint after 2.
    expect(appendFetches).toBeLessThan(4);

    const full = deriveCard({
      session: metaFromSession(s1),
      messages: [...initial, ...appended],
      parentById: new Map<string, string | null>([["s1", null]]),
    }).card;
    expect(store.getCard("s1")).toEqual(full); // equivalence: append == full re-distill
    expect(store.getCard("s1")!.embedding).toBeNull(); // append cleared the stale vector
    distiller.stop();
    db.close();
  });

  it("append that crosses the row cap still equals a full re-distill (card + FTS rows)", async () => {
    const s1 = session("s1", "Capped", PROJECT_DIR, 3000);
    const message = (i: number): MessageBundle =>
      bundle(userMessage(`m${i}`, "s1", 1000 + i), [
        textPart(`p${i}`, "s1", `m${i}`, `marker${i} content`),
      ]);
    const initial = [message(0), message(1), message(2), message(3)];
    const appended = [message(4), message(5), message(6), message(7)];
    const graph: Graph = { sessions: [s1], messagesBySession: { s1: [...initial] } };
    const { client } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    // Cap of 5 rows: 4 initial + 4 appended = 8 → the 3 oldest rows are evicted.
    const distiller = createDistiller({
      client,
      store,
      gate,
      limits: { ...TEST_LIMITS, ftsRowsPerSession: 5 },
      instanceId: "capped",
      pageMessages: 4,
      appendThresholdParts: 1,
      idleDebounceMs: 5,
    });
    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");

    graph.messagesBySession.s1 = [...initial, ...appended];
    distiller.onEvent(idleEvent("s1"));
    await waitFor(() => store.getCard("s1")!.distilledThrough === "m7");

    // A fresh full re-distill of the same 8-message state, same cap.
    const { db: db2, store: store2 } = await freshStore();
    const full = deriveCard({
      session: metaFromSession(s1),
      messages: [...initial, ...appended],
      parentById: new Map<string, string | null>([["s1", null]]),
      caps: { ftsRowsPerSession: 5 },
    });
    store2.replaceSessionParts("s1", full.rows, full.card);

    // Card equivalence over the capped set.
    expect(store.getCard("s1")).toEqual(store2.getCard("s1"));
    // FTS-visible rows match exactly: the oldest 3 markers are gone from both,
    // the newest 5 survive in both, under the same part ids.
    for (let i = 0; i < 8; i++) {
      const marker = `marker${i}`;
      expect(
        store
          .ftsSearch({ strong: [marker], weak: [] })
          .map((h) => h.partId)
          .sort(),
      ).toEqual(
        store2
          .ftsSearch({ strong: [marker], weak: [] })
          .map((h) => h.partId)
          .sort(),
      );
    }
    expect(store.ftsSearch({ strong: ["marker0"], weak: [] })).toEqual([]); // evicted
    expect(ftsSessions(store.ftsSearch({ strong: ["marker7"], weak: [] }))).toEqual(["s1"]); // kept
    // Full stored row metadata (part_id, message_id, prev/next, class) must match
    // a fresh full re-distill — this is precisely where the append seam's stale
    // next_message_id would surface if it were not repointed.
    expect(storedRowMeta(db, "s1")).toEqual(storedRowMeta(db2, "s1"));
    distiller.stop();
    db.close();
    db2.close();
  });
});

// ── Degraded mode ────────────────────────────────────────────────────────────

describe("null store", () => {
  it("is a clean no-op with no lease and idle status", () => {
    const { client } = makeDistillFake({ sessions: [], messagesBySession: {} });
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      client,
      store: null,
      gate,
      limits: TEST_LIMITS,
      instanceId: "none",
    });
    expect(() => {
      distiller.start();
      distiller.onEvent(idleEvent("s1"));
      distiller.stop();
    }).not.toThrow();
    expect(distiller.status()).toEqual({
      leaseHeld: false,
      coldPass: "idle",
      distilledCount: 0,
      knownCount: 0,
    });
  });
});
