import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, OpencodeClient, Part, Session } from "@opencode-ai/sdk/v2";
import { openSqlite, type Row, type SqliteDb } from "../src/sqlite.js";
import { openStore, type Card, type FamilyRollup, type Store } from "../src/store.js";
import { createFetchGate, type FetchGate } from "../src/fetch-gate.js";
import {
  COLD_PASS_COMPLETE_KEY,
  COLD_PASS_PROGRESS_KEY,
  PROGRESS_STALE_MS,
  createDistiller,
  type Distiller,
  deriveCard,
  deriveCardCooperative,
  DERIVE_YIELD_EVERY,
  distillFields,
  resolveRootId,
  topByFrequency,
  type DeriveCardInput,
  type DistillSessionMeta,
  type DistillSignal,
  type DistillSync,
} from "../src/distill.js";
import { isDigestToken } from "../src/digest.js";
import { tokenize } from "../src/normalize.js";
import { extractCodeTokens } from "../src/query.js";
import { mulberry32, perfMessageText } from "./perf-helpers.js";
import type { HistorySource } from "../src/history/source.js";
import type { HistorySession } from "../src/history/model.js";
import { createV1HistorySource } from "../src/history/v1.js";
import { v1EventToSignal } from "../src/history/v1-events.js";
import { createV2HistorySource, openOpencodeDb } from "../src/history/v2.js";
import { V2_PROJECTOR_GEN } from "../src/history/v2-project.js";
import { createV2Sync } from "../src/history/v2-sync.js";
import {
  insertMessage,
  insertPart,
  insertProject,
  insertSession,
  limitSpy,
  makeV2PartsDb,
} from "./v2-db.js";

/** A v1 history source over one fake client (tests that hand-roll a client). */
const v1 = (client: OpencodeClient): HistorySource =>
  createV1HistorySource({ scoped: client, unscoped: client });
import {
  apiFailure,
  assistantMessage,
  bundle,
  completedToolPart,
  errorToolPart,
  executeToolPart,
  messagesResponse,
  paginateBundles,
  PROJECT_DIR,
  reasoningPart,
  session,
  subtaskPart,
  TEST_LIMITS,
  textPart,
  userMessage,
  openV1Store,
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
  const store = openV1Store(db, now ? { now } : undefined);
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
    /** Session id → how many message fetches of it throw before one succeeds. */
    failTimes?: Record<string, number>;
    nonArray?: Set<string>;
    metadataErrorOnce?: Set<string>;
    /** session.get returns the v2 404 body (`name: "NotFoundError"`). */
    metadataNotFound?: Set<string>;
    /** session.list succeeds with this raw `data` body instead of the graph. */
    listBody?: unknown;
  } = {},
): { client: OpencodeClient; source: HistorySource; sdk: SdkCalls } {
  const sdk: SdkCalls = { list: 0, get: 0, messages: [] };
  const threw = new Set<string>();
  const client = {
    session: {
      list: async () => {
        sdk.list++;
        if ("listBody" in opts) return { data: opts.listBody };
        return { data: [...graph.sessions] };
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        sdk.get++;
        if (opts.metadataErrorOnce?.has(sessionID) && !threw.has(`meta:${sessionID}`)) {
          threw.add(`meta:${sessionID}`);
          return { error: apiFailure(`metadata transport failed: ${sessionID}`) };
        }
        if (opts.metadataNotFound?.has(sessionID)) {
          // The real SessionGetErrors[404] shape from the v2 typings.
          return {
            error: { name: "NotFoundError", data: { message: `session not found: ${sessionID}` } },
          };
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
        const left = opts.failTimes?.[params.sessionID] ?? 0;
        if (left > 0) {
          opts.failTimes![params.sessionID] = left - 1;
          throw new Error(`failing: ${params.sessionID}`);
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
  return { client, source: createV1HistorySource({ scoped: client, unscoped: client }), sdk };
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

/** Deliver a v1 bus event the way the plugin entry does: through the v1
 *  mapper, dropping events the distiller ignores. */
const feed = (distiller: Distiller, event: Event): void => {
  const signal = v1EventToSignal(event);
  if (signal) distiller.onEvent(signal);
};

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

  it("treats v2 tool names exactly like their v1 counterparts", () => {
    // No extraction rule keys on bash/task/apply_patch or skill's `name`:
    // commands come from any tool's `command` input, and only read/skill
    // are special-cased. So v2's shell/subagent/patch and skill `id` need
    // no new bases.
    const pairs: Array<[string, string, Record<string, unknown>]> = [
      ["bash", "shell", { command: "npm test", workdir: "/w" }],
      ["task", "subagent", { description: "d", prompt: "p", subagent_type: "explore" }],
      ["apply_patch", "patch", { patchText: "*** Begin Patch" }],
    ];
    for (const [v1Name, v2Name, input] of pairs) {
      const strip = (fields: ReturnType<typeof distillFields>) =>
        fields.map((f) => [f.field, f.text]);
      expect(
        strip(distillFields(completedToolPart("p", "s", "m", v2Name, input, "out"))),
        v2Name,
      ).toEqual(strip(distillFields(completedToolPart("p", "s", "m", v1Name, input, "out"))));
    }
    // skill: v1 input { name }, v2 input { id }; both stay reference material.
    for (const input of [{ name: "tuistory" }, { id: "tuistory" }]) {
      expect(distillFields(completedToolPart("p", "s", "m", "skill", input, "body"))).toEqual([]);
    }
  });

  it("excludes a Code Mode execute part that called a recall tool", () => {
    const viaRecall = executeToolPart("p1", "s1", "m1", ["plugin.recall"], "prior");
    const other = executeToolPart("p2", "s1", "m1", ["context7.query-docs"], "docs");
    expect(distillFields(viaRecall)).toEqual([]);
    expect(distillFields(other).length).toBeGreaterThan(0);

    const messages = [bundle(assistantMessage("m1", "s1", 1_000), [viaRecall, other])];
    const { card, rows } = deriveCard(deriveInput("s1", messages));
    expect(card.tools).toEqual(["execute"]);
    expect(rows.every((row) => !row.partId.startsWith("p1#"))).toBe(true);
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

describe("deriveCardCooperative", () => {
  it("yields while deriving and matches deriveCard exactly on a large session", async () => {
    // A mixed session well past several yield intervals: user and assistant
    // text, reasoning, tool calls (reads, edits, commands, failures), a
    // subtask, and a synthetic recall-auto part, with shared timestamps so
    // ordering ties are exercised too.
    const sid = "s-large";
    const messages = [];
    for (let i = 0; i < 2_400; i++) {
      const id = `m${String(i).padStart(5, "0")}`;
      const at = 1_000 + Math.floor(i / 3);
      if (i % 2 === 0) {
        messages.push(
          bundle(userMessage(id, sid, at), [
            textPart(`${id}-t`, sid, id, `request ${i}: fix rateLimit in checkout_${i % 17}.ts`),
            ...(i % 50 === 0
              ? [subtaskPart(`${id}-s`, sid, id, "review", `review batch ${i}`)]
              : []),
          ]),
        );
      } else {
        messages.push(
          bundle(assistantMessage(id, sid, at), [
            reasoningPart(`${id}-r`, sid, id, `thinking about GHOST_${i % 11} and parser`),
            completedToolPart(
              `${id}-read`,
              sid,
              id,
              "read",
              { filePath: `/w/src/f${i % 23}.ts` },
              "...",
            ),
            completedToolPart(`${id}-bash`, sid, id, "bash", { command: `npm test -- ${i}` }, "ok"),
            ...(i % 7 === 0
              ? [errorToolPart(`${id}-err`, sid, id, "bash", { command: "make" }, `Error: E${i}`)]
              : []),
            textPart(`${id}-a`, sid, id, `answer ${i} with deploy.yaml notes`),
          ]),
        );
      }
    }
    const input = {
      session: {
        id: sid,
        parentId: null,
        title: "Large session",
        slug: "large",
        directory: PROJECT_DIR,
        projectId: "p",
        agent: null,
        model: null,
        timeCreated: 1_000,
        timeUpdated: 9_000,
      },
      // Shuffled: both must sort the same way.
      messages: [...messages].reverse(),
      parentById: new Map<string, string | null>([[sid, null]]),
      caps: { ftsRowsPerSession: 3_000, inventoryTokens: 200 },
    };
    let yields = 0;
    const cooperative = await deriveCardCooperative(input, async () => {
      yields++;
    });
    const synchronous = deriveCard(input);
    expect(cooperative).toEqual(synchronous);
    expect(JSON.stringify(cooperative)).toBe(JSON.stringify(synchronous));
    // Yields after the sort, through the walk, and through the inventory.
    expect(yields).toBeGreaterThanOrEqual(Math.floor(2_400 / DERIVE_YIELD_EVERY));
  });
});

describe("inventory ranking", () => {
  /** Tokens in the order a stable sort by count (highest first) and then
   *  `localeCompare` lists them. */
  const ranked = (counts: Map<string, number>): string[] =>
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);

  it("topByFrequency lists the first tokens a full stable sort lists", () => {
    // Case variants, and spellings localeCompare finds equal, among them.
    const variants = ["ab", "a\u200bb", "Ab", "e\u0301", "\u00e9", "x", "x\u00ad"];
    for (let s = 0; s < 60; s++) {
      const rand = mulberry32(300 + s);
      const counts = new Map<string, number>();
      const size = Math.floor(rand() * 400);
      for (let i = 0; i < size; i++) {
        const token =
          rand() < 0.2
            ? variants[Math.floor(rand() * variants.length)]!
            : `t${Math.floor(rand() * 1_000)}`;
        counts.set(token, (counts.get(token) ?? 0) + 1 + Math.floor(rand() * 3));
      }
      for (const n of [0, 1, 7, Math.floor(size / 2), size, size + 5]) {
        expect(topByFrequency(counts, n), `case ${s}, n ${n}`).toEqual(ranked(counts).slice(0, n));
      }
    }
  });

  it("topByFrequency keeps tokens that tie on count and compare equal in map order, wherever n cuts them", () => {
    // Each pair compares equal under localeCompare, so only map order
    // separates its tokens.
    const counts = new Map([
      ["x", 1],
      ["e\u0301", 2],
      ["a\u200bb", 3],
      ["\u00e9", 2],
      ["ab", 3],
      ["x\u00ad", 1],
    ]);
    const order = ["a\u200bb", "ab", "e\u0301", "\u00e9", "x", "x\u00ad"];
    for (let n = 0; n <= order.length + 1; n++) {
      expect(topByFrequency(counts, n), `n ${n}`).toEqual(order.slice(0, n));
    }
    const reversed = new Map([...counts].reverse());
    expect(topByFrequency(reversed, 1)).toEqual(["ab"]);
    expect(topByFrequency(reversed, 3)).toEqual(["ab", "a\u200bb", "\u00e9"]);
    expect(topByFrequency(counts, -1)).toEqual([]);
  });

  it("keeps the inventory a full sort of every counted token gives", () => {
    /** The inventory as ranking every token with a full sort builds it. */
    const sortedInventory = (rows: Array<{ class: string; raw: string }>, limit: number) => {
      const digest = new Map<string, number>();
      const code = new Map<string, number>();
      for (const row of rows) {
        if (
          row.class === "human-text" ||
          (row.class === "tool-input" && !row.raw.startsWith("{"))
        ) {
          for (const token of tokenize(row.raw)) {
            if (isDigestToken(token)) digest.set(token, (digest.get(token) ?? 0) + 1);
          }
        }
        for (const token of extractCodeTokens(row.raw)) {
          code.set(token, (code.get(token) ?? 0) + 1);
        }
      }
      const out: string[] = [];
      const seen = new Set<string>();
      for (const token of [...ranked(code), ...ranked(digest)]) {
        if (out.length >= limit) break;
        if (seen.has(token)) continue;
        seen.add(token);
        out.push(token);
      }
      return out.join(" ");
    };
    for (let s = 0; s < 24; s++) {
      const rand = mulberry32(500 + s);
      const sid = `s${s}`;
      const limit = [0, 1, 5, 40, 200, 5_000][s % 6]!;
      // Few distinct words, so counts tie, or a real session's spread.
      const text = (i: number) =>
        s % 4 === 0
          ? ["alpha beta", "Alpha launchTerminal", "beta gamma_delta", "src/a/b.ts"][i % 4]!
          : perfMessageText(s * 1_000 + i, 20 + Math.floor(rand() * 2_400));
      const messages = Array.from({ length: 5 + Math.floor(rand() * 40) }, (_, i) =>
        i % 3 === 2
          ? bundle(assistantMessage(`m${i}`, sid, 1000 + i), [
              completedToolPart(`p${i}`, sid, `m${i}`, "bash", { command: text(i) }, "ok"),
            ])
          : bundle(userMessage(`m${i}`, sid, 1000 + i), [textPart(`p${i}`, sid, `m${i}`, text(i))]),
      );
      const derived = deriveCard(deriveInput(sid, messages, { caps: { inventoryTokens: limit } }));
      expect(derived.card.inventory, `case ${s}, limit ${limit}`).toBe(
        sortedInventory(derived.rows, limit),
      );
    }
  });
});

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

  it("strips the v2 subagent prompt prefix from the summary head only", () => {
    const prompt = "You are a subagent spawned by another session.\nAudit the parser module";
    const messages = [bundle(userMessage("m1", "s1", 1000), [textPart("p1", "s1", "m1", prompt)])];
    const { card, rows } = deriveCard(deriveInput("s1", messages, { parentId: "root" }));
    expect(card.summaryHead).toBe("Audit the parser module");
    // The indexed statement keeps the verbatim text.
    expect(rows[0]!.raw).toBe(prompt);

    // A bare prefix leaves no head; the next statement supplies it.
    const bare = [
      bundle(userMessage("m1", "s1", 1000), [
        textPart("p1", "s1", "m1", "You are a subagent spawned by another session.\n"),
        textPart("p2", "s1", "m1", "second statement"),
      ]),
    ];
    expect(deriveCard(deriveInput("s1", bare)).card.summaryHead).toBe("second statement");
    // Only the exact prefix, at the start, is removed.
    const inner = [
      bundle(userMessage("m1", "s1", 1000), [
        textPart("p1", "s1", "m1", "Note: You are a subagent spawned by another session.\nX"),
      ]),
    ];
    expect(deriveCard(deriveInput("s1", inner)).card.summaryHead).toContain("Note: You are");
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
    const { source } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const logs: string[] = [];
    const distiller = createDistiller({
      source,
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
    expect(distiller.status().quarantinedCount).toBe(1);
    await distiller.stop();
    db.close();
  });

  it("does not quarantine on a non-shape deriveCard error; the pass aborts and surfaces it", async () => {
    // A deriveCard REGRESSION (anything that is not a data-shape failure) must
    // not sideline healthy sessions while reporting "done". The message below
    // passes the fetch stage untouched (fetchSessionMessages only walks parts)
    // and then throws a plain Error inside deriveCard's walk.
    const boobyTrapped = {
      info: {
        id: "m-boom",
        role: "user",
        get time(): { created: number } {
          throw new Error("synthetic deriveCard regression");
        },
      },
      parts: [textPart("p-boom", "boom", "m-boom", "content")],
    } as unknown as MessageBundle;
    const graph: Graph = {
      sessions: [session("boom", "Boom", PROJECT_DIR, 3000)],
      messagesBySession: { boom: [boobyTrapped] },
    };
    const { source } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
      store,
      gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "regression-surface",
      coldPassRetryMs: 60_000,
    });

    distiller.start();
    await waitFor(() => distiller.status().lastError != null);

    expect(distiller.status().lastError).toContain("synthetic deriveCard regression");
    expect(distiller.status().quarantinedCount).toBe(0); // NOT quarantined
    expect(distiller.status().coldPass).toBe("idle"); // aborted, not "done"
    await distiller.stop();
    db.close();
  });

  it("skips the write when the lease is taken over between fetch and write (stale writer)", async () => {
    // A process suspended past the TTL can lose the lease before its heartbeat
    // callback ever runs. The resumed fetch must not replace the new holder's
    // rows: the write gate re-verifies ownership against the live lease row.
    let clock = 1_000_000;
    let resolveMessages!: (value: unknown) => void;
    const gatePromise = new Promise<unknown>((resolve) => {
      resolveMessages = resolve;
    });
    const s1 = session("s1", "Alpha", PROJECT_DIR, 3000);
    const client = {
      session: {
        list: async () => ({ data: [s1] }),
        messages: async (params: { sessionID: string; limit?: number }) => {
          if (params.limit == null) throw new Error("unbounded fetch");
          await gatePromise;
          return messagesResponse(
            [bundle(userMessage("m1", "s1", 100), [textPart("p1", "s1", "m1", "alpha")])],
            null,
          );
        },
      },
    } as unknown as OpencodeClient;
    const { db, store } = await freshStore(() => clock);
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source: v1(client),
      store,
      gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "suspended",
      now: () => clock,
      leaseRetryMs: 600_000,
    });

    distiller.start();
    await new Promise((r) => setTimeout(r, 10)); // fetch now blocked in flight

    // Simulated suspension past the TTL: a rival takes the lease over.
    clock += 31_000;
    expect(store.acquireLease("rival", 30_000, "rivalbuild", 4)).toBe(true);

    // status() is authoritative WITHOUT side effects: it derives leaseHeld from
    // the lease row it already reads for the `lease` field, so it reports the
    // takeover even though the heartbeat callback has not run and the internal
    // cached flag still says held.
    expect(distiller.status().leaseHeld).toBe(false);
    expect(distiller.status().lease?.holder).toBe("rival");

    resolveMessages({});
    await waitFor(() => distiller.status().coldPass !== "running");

    expect(store.getCard("s1")).toBeUndefined(); // the stale write was skipped
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
    // flaky fails its first fetch and the end-of-pass retry, so a follow-up
    // pass runs; it must not refetch the quarantined session.
    const { source, sdk } = makeDistillFake(graph, { failTimes: { flaky: 2 } });
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
      store,
      gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "malformed-skip",
      coldPassRetryMs: 15,
    });

    distiller.start();
    await waitFor(() => store.getCard("flaky")?.distillState === "full");

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
    const { source } = makeDistillFake(graph, { nonArray: new Set(["bad"]) });
    const { db, store } = await freshStore();
    const seeded = deriveCard({
      session: metaFromSession(old),
      messages: oldMessages,
      parentById: new Map([["bad", null]]),
    });
    store.replaceSessionParts("bad", seeded.rows, seeded.card);
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
      store,
      gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "non-array-preserve",
    });

    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");

    // Unchanged since the seeding write, which stamped revision 1.
    expect(store.getCard("bad")).toEqual({ ...seeded.card, writeRev: 1 });
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
      const { source } = makeDistillFake({ sessions: [], messagesBySession: {} });
      const { gate } = makeSpyGate();
      const distiller = createDistiller({
        source,
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
        source: v1(client),
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
        source: v1(client),
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
    // flaky fails its fetch and the end-of-pass retry, so a follow-up pass
    // runs after coldPassRetryMs; by then bad has been repaired.
    const { source, sdk } = makeDistillFake(graph, { failTimes: { flaky: 2 } });
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
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
    await waitFor(() => store.getCard("bad")?.timeUpdated === 4000);

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
    const { source, sdk } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    store.upsertCard(fullCard("s2", 2000)); // already current → must be skipped
    const { gate, background } = makeSpyGate();
    const distiller = createDistiller({
      source,
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

  it("carries on past a mid-pass fetch failure and retries it at the end of the pass", async () => {
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
    const { source, sdk } = makeDistillFake(graph, { throwOnce: new Set(["s2"]) });
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const limits = { ...TEST_LIMITS, distillConcurrency: 1 };

    const first = createDistiller({ source, store, gate, limits, instanceId: "cold-a" });
    first.start();
    await waitFor(() => first.status().coldPass === "done");
    // One pass: s3 was reached after s2 failed, and s2 succeeded on the retry.
    for (const id of ["s1", "s2", "s3"]) expect(store.getCard(id)?.distillState).toBe("full");
    expect(sdk.list).toBe(1);
    expect(sdk.messages.map((call) => call.sessionID)).toEqual(["s1", "s2", "s3", "s2"]);
    expect(first.status().lastError).toBeUndefined();
    first.stop();
    db.close();
  });

  it("aborts the pass when five sessions in a row fail (an outage)", async () => {
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const graph: Graph = { sessions: [], messagesBySession: {} };
    ids.forEach((id, i) => {
      graph.sessions.push(session(id, id, PROJECT_DIR, 9000 - i * 1000));
      graph.messagesBySession[id] = [
        bundle(userMessage(`m-${id}`, id, 100), [textPart(`p-${id}`, id, `m-${id}`, id)]),
      ];
    });
    const { source } = makeDistillFake(graph, {
      failTimes: { s1: 1, s2: 1, s3: 1, s4: 1, s5: 1 },
    });
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
      store,
      gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "outage",
      coldPassRetryMs: 60_000,
      log: () => {},
    });
    distiller.start();
    await waitFor(() => distiller.status().lastError !== undefined);
    expect(distiller.status().coldPass).toBe("idle");
    expect(store.getCard("s6")).toBeUndefined(); // never reached: the pass aborted
    // The abort charged a strike to each of the five, so a repeating outage
    // still reaches the skip limit.
    expect(distiller.status().failingCount).toBe(5);
    await distiller.stop();
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
    const { source } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
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
    const { source } = makeDistillFake({ sessions: [root, ...children], messagesBySession });
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
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
    const { source } = makeDistillFake({ sessions: [root, child], messagesBySession });
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();

    // First pass distills the family and builds the root's rollup.
    const first = createDistiller({
      source,
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
      source,
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

  it("skips a session whose fetch keeps failing, so the pass reaches older sessions", async () => {
    // The host fails every read of one session (on v1, when its project
    // directory cannot boot). Retrying it on every pass would keep the pass
    // from ever reaching older sessions.
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
    const { source: inner } = makeDistillFake(graph);
    let s2Reads = 0;
    const source: HistorySource = {
      ...inner,
      messagePage: async (o) => {
        if (o.sessionID === "s2") {
          s2Reads++;
          throw new Error("SQLiteError: no such column: project_id");
        }
        return inner.messagePage(o);
      },
    };
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const logs: string[] = [];
    const distiller = createDistiller({
      source,
      store,
      gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "stuck-session",
      coldPassRetryMs: 5,
      log: (line) => logs.push(line),
    });

    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");
    // The first pass finishes: every other session is indexed right away.
    for (const id of ["s1", "s3", "s4"]) expect(store.getCard(id)?.distillState).toBe("full");
    expect(store.getCard("s2")).toBeUndefined();
    expect(distiller.status().failingCount).toBe(1);

    // Follow-up passes retry it; after three passes (a fetch and an
    // end-of-pass retry each) it is skipped.
    await waitFor(() => distiller.status().skippedCount === 1);
    expect(s2Reads).toBe(6);
    expect(distiller.status().failingCount).toBe(0);
    expect(store.getMeta("coldpass_cursor")).toBe("1000");
    expect(logs.some((line) => line.includes("session s2 skipped: 3 cold passes failed"))).toBe(
      true,
    );
    distiller.stop();
    db.close();
  });

  /** A graph of healthy sessions plus `bad` ones whose fetch always fails,
   *  newest first in the order given. */
  function failingGraph(order: Array<{ id: string; bad?: boolean }>): {
    graph: Graph;
    failTimes: Record<string, number>;
  } {
    const graph: Graph = { sessions: [], messagesBySession: {} };
    const failTimes: Record<string, number> = {};
    order.forEach(({ id, bad }, i) => {
      graph.sessions.push(session(id, id, PROJECT_DIR, 100_000 - i * 1000));
      graph.messagesBySession[id] = [
        bundle(userMessage(`m-${id}`, id, 100), [textPart(`p-${id}`, id, `m-${id}`, id)]),
      ];
      if (bad) failTimes[id] = Number.MAX_SAFE_INTEGER;
    });
    return { graph, failTimes };
  }

  it("skips sessions that always fail among healthy ones, then indexes them once the host heals", async () => {
    // Pass 1 sets the five aside (healthy fetches in between reset the outage
    // streak). On follow-up passes every healthy session is up to date, so the
    // five are fetched back to back: as known-bad sessions they must not read
    // as an outage, or the pass aborts forever and never reaches three strikes.
    const order = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, bad: i % 2 === 1 }));
    const { graph, failTimes } = failingGraph(order);
    const { source, sdk } = makeDistillFake(graph, { failTimes });
    const { db, store } = await freshStore();
    const distiller = createDistiller({
      source,
      store,
      gate: makeSpyGate().gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "always-failing",
      coldPassRetryMs: 5,
      log: () => {},
    });
    distiller.start();
    await waitFor(
      () => distiller.status().skippedCount === 5 && distiller.status().coldPass === "done",
    );
    expect(sdk.list).toBe(3);
    expect(distiller.status().failingCount).toBe(0);
    for (const { id, bad } of order) {
      if (!bad) expect(store.getCard(id)?.distillState).toBe("full");
    }
    // Skipped sessions without a card: the store is not complete, and says so.
    expect(store.getMeta(COLD_PASS_COMPLETE_KEY)).toBeUndefined();
    expect(distiller.indexing()).toMatchObject({ known: 10, stalled: true });

    // The host heals; the long-backoff pass indexes them and stamps the store.
    for (const { id, bad } of order) if (bad) failTimes[id] = 0;
    await waitFor(() => store.getMeta(COLD_PASS_COMPLETE_KEY) === "1");
    for (const { id } of order) expect(store.getCard(id)?.distillState).toBe("full");
    expect(distiller.status().skippedCount).toBe(0);
    expect(distiller.indexing()).toBeUndefined();
    // Nothing left to retry: no further pass is scheduled.
    const passes = sdk.list;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sdk.list).toBe(passes);
    await distiller.stop();
    db.close();
  });

  it("grows the skipped-pass backoff while nothing heals, and resets it on progress", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const R = 1_000; // coldPassRetryMs: the backoff runs 10R, 20R, 40R, 60R, 60R
      const { graph, failTimes } = failingGraph([
        { id: "ok" },
        { id: "a", bad: true },
        { id: "b", bad: true },
      ]);
      const { source } = makeDistillFake(graph, { failTimes });
      const discoveries: number[] = [];
      const { db, store } = await freshStore();
      const distiller = createDistiller({
        source,
        store,
        gate: makeSpyGate().gate,
        limits: { ...TEST_LIMITS, distillConcurrency: 1 },
        instanceId: "backoff",
        coldPassRetryMs: R,
        discover: async () => {
          discoveries.push(Date.now());
          const listing = await source.listSessions({ scope: "project", limit: 100 });
          if (!listing.ok) throw new Error(listing.error);
          return listing.items;
        },
        log: () => {},
      });
      distiller.start();
      let healed = false;
      for (let steps = 0; discoveries.length < 10 && steps < 500; steps++) {
        await vi.advanceTimersToNextTimerAsync();
        // After pass 7, a heals: pass 8 indexes it (progress) while b stays.
        if (!healed && discoveries.length === 7 && distiller.status().coldPass === "done") {
          failTimes.a = 0;
          healed = true;
        }
      }
      expect(discoveries).toHaveLength(10);
      const gaps = discoveries.slice(1).map((t, i) => (t - discoveries[i]!) / R);
      // Passes 1-3 strike (follow-ups at R); then skipped-only passes back
      // off 10, 20, 40, 60, 60; a's recovery in pass 8 resets it: 10, 20.
      expect(gaps).toEqual([1, 1, 10, 20, 40, 60, 60, 10, 20]);
      expect(store.getCard("a")?.distillState).toBe("full");
      await distiller.stop();
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a session's fetch strikes when it is quarantined", async () => {
    const { graph } = failingGraph([{ id: "ok" }, { id: "x" }]);
    const nonArray = new Set<string>();
    const { source } = makeDistillFake(graph, { failTimes: { x: 2 }, nonArray });
    const { db, store } = await freshStore();
    const distiller = createDistiller({
      source,
      store,
      gate: makeSpyGate().gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "strikes-quarantine",
      coldPassRetryMs: 30,
      log: () => {},
    });
    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");
    expect(distiller.status().failingCount).toBe(1);
    // x now fails as malformed data: quarantined, no longer failing.
    nonArray.add("x");
    await waitFor(() => distiller.status().quarantinedCount === 1);
    expect(distiller.status().failingCount).toBe(0);
    await distiller.stop();
    db.close();
  });

  it("ends a first build under a host-wide fetch outage unstamped, with a long-backoff pass", async () => {
    const order = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, bad: true }));
    const { graph, failTimes } = failingGraph(order);
    const { source, sdk } = makeDistillFake(graph, { failTimes });
    const { db, store } = await freshStore();
    const distiller = createDistiller({
      source,
      store,
      gate: makeSpyGate().gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "host-outage",
      coldPassRetryMs: 5,
      log: () => {},
    });
    distiller.start();
    await waitFor(
      () => distiller.status().skippedCount === 6 && distiller.status().coldPass === "done",
    );
    expect(store.getMeta(COLD_PASS_COMPLETE_KEY)).toBeUndefined();
    expect(distiller.indexing()).toMatchObject({ known: 6, stalled: true });
    // One more pass comes on the long backoff (10 x coldPassRetryMs).
    const passes = sdk.list;
    await waitFor(() => sdk.list > passes);
    await distiller.stop();
    db.close();
  });

  it("indexes older sessions within a few passes when the newest five always fail", async () => {
    // Cold start: the five newest fail first, which reads as an outage and
    // aborts pass 1. The abort charges each a strike, so pass 2 no longer
    // counts them toward an outage and reaches the healthy older sessions.
    const order = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `bad${i}`, bad: true })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `ok${i}` })),
    ];
    const { graph, failTimes } = failingGraph(order);
    const { source, sdk } = makeDistillFake(graph, { failTimes });
    const { db, store } = await freshStore();
    const distiller = createDistiller({
      source,
      store,
      gate: makeSpyGate().gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "newest-failing",
      coldPassRetryMs: 5,
      log: () => {},
    });
    distiller.start();
    await waitFor(() => store.getCard("ok3")?.distillState === "full");
    expect(sdk.list).toBe(2);
    await waitFor(
      () => distiller.status().skippedCount === 5 && distiller.status().coldPass === "done",
    );
    expect(sdk.list).toBeLessThanOrEqual(4);
    await distiller.stop();
    db.close();
  });

  it("stops end-of-pass retries after five fail in a row; the rest take a strike unfetched", async () => {
    const order = Array.from({ length: 14 }, (_, i) => ({ id: `s${i}`, bad: i % 2 === 1 }));
    const { graph, failTimes } = failingGraph(order);
    const { source, sdk } = makeDistillFake(graph, { failTimes });
    const { db, store } = await freshStore();
    const distiller = createDistiller({
      source,
      store,
      gate: makeSpyGate().gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "retry-stop",
      coldPassRetryMs: 60_000,
      log: () => {},
    });
    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");
    const fetches = (id: string) => sdk.messages.filter((c) => c.sessionID === id).length;
    const bad = order.filter((o) => o.bad).map((o) => o.id);
    // Seven failing sessions: the first five are retried, the last two not.
    expect(bad.map(fetches)).toEqual([2, 2, 2, 2, 2, 1, 1]);
    expect(distiller.status().failingCount).toBe(7);
    // Sessions wait for a retry: the store is not complete.
    expect(store.getMeta(COLD_PASS_COMPLETE_KEY)).toBeUndefined();
    // lastError names the first and counts the rest.
    expect(distiller.status().lastError).toBe("session s1 fetch failed: failing: s1 (and 6 more)");
    await distiller.stop();
    db.close();
  });

  it("does not finish the pass when stopped or demoted during the end-of-pass retry", async () => {
    for (const how of ["stop", "lease"] as const) {
      const { graph } = failingGraph([{ id: "ok" }, { id: "bad" }]);
      const { source: inner } = makeDistillFake(graph);
      let badReads = 0;
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => (release = resolve));
      const source: HistorySource = {
        ...inner,
        messagePage: async (o) => {
          if (o.sessionID === "bad") {
            badReads++;
            if (badReads === 2) await blocked; // the end-of-pass retry
            throw new Error("bad session");
          }
          return inner.messagePage(o);
        },
      };
      const { db, store } = await freshStore();
      let done = 0;
      const distiller = createDistiller({
        source,
        store,
        gate: makeSpyGate().gate,
        limits: { ...TEST_LIMITS, distillConcurrency: 1 },
        instanceId: `retry-${how}`,
        coldPassRetryMs: 60_000,
        onColdPassDone: () => done++,
        log: () => {},
      });
      distiller.start();
      await waitFor(() => badReads === 2);
      let stopping: Promise<void> | undefined;
      if (how === "stop") stopping = distiller.stop();
      else {
        store.setMeta(
          "distill_lease",
          JSON.stringify({
            holder: "rival",
            heartbeat: Date.now(),
            ttl: 30_000,
            build: "x",
            gen: 1,
          }),
        );
      }
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(distiller.status().coldPass, how).toBe("idle");
      expect(done, how).toBe(0);
      await (stopping ?? distiller.stop());
      db.close();
    }
  });

  it("clears a session's failing state when it distills, is deleted, or is no longer discovered", async () => {
    const { graph, failTimes } = failingGraph([
      { id: "a", bad: true },
      { id: "ok1" },
      { id: "b", bad: true },
      { id: "ok2" },
      { id: "c", bad: true },
    ]);
    const { source, sdk } = makeDistillFake(graph, { failTimes });
    const { db, store } = await freshStore();
    const distiller = createDistiller({
      source,
      store,
      gate: makeSpyGate().gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "failing-cleared",
      // The follow-up pass comes after the events below.
      coldPassRetryMs: 300,
      idleDebounceMs: 1,
      log: () => {},
    });
    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");
    expect(distiller.status().failingCount).toBe(3);

    // a recovers and an event re-distills it.
    failTimes.a = 0;
    distiller.onEvent({ type: "turn-ended", sessionID: "a" });
    await waitFor(() => distiller.status().failingCount === 2);
    expect(store.getCard("a")?.distillState).toBe("full");

    // b is deleted.
    graph.sessions = graph.sessions.filter((s) => s.id !== "b");
    distiller.onEvent({ type: "deleted", sessionID: "b" });
    expect(distiller.status().failingCount).toBe(1);

    // c is gone from the host by the follow-up pass, which prunes it.
    graph.sessions = graph.sessions.filter((s) => s.id !== "c");
    // At least the follow-up pass (sdk.list counts discoveries); later ones
    // change nothing.
    await waitFor(() => sdk.list >= 2 && distiller.status().coldPass === "done", 3_000);
    expect(distiller.status().failingCount).toBe(0);
    expect(distiller.status().skippedCount).toBe(0);
    await distiller.stop();
    db.close();
  });

  it("recovers a concurrency-2 cold pass from a mid-pass failure via the end-of-pass retry", async () => {
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
    const { source, sdk } = makeDistillFake(graph, { throwOnce: new Set(["s2"]) });
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
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
    expect(sdk.list).toBe(1); // retried at the end of the same pass, no second discovery
    distiller.stop();
    db.close();
  });

  it("tolerates a non-array discovery listing as zero sessions", async () => {
    const graph: Graph = {
      sessions: [session("s1", "One", PROJECT_DIR, 3000)],
      messagesBySession: {},
    };
    const { source, sdk } = makeDistillFake(graph, { listBody: { unexpected: true } });
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "disc-non-array",
      coldPassRetryMs: 15,
    });

    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");
    expect(sdk.list).toBe(1); // no failure, so no backoff retry
    expect(store.getCard("s1")).toBeUndefined();
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
    const { source, sdk } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate, background } = makeSpyGate();
    const distiller = createDistiller({
      source,
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
    const { source } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
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

    // An incremental re-distill that changes the card bumps it again (one that
    // finds nothing new writes no revision).
    graph.messagesBySession.s1!.push(
      bundle(userMessage("m2", "s1", 200), [textPart("p2", "s1", "m2", "two content")]),
    );
    feed(distiller, idleEvent("s1"));
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
    const { source, sdk } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    expect(store.acquireLease("other", 30_000, "otherbuild", 4)).toBe(true); // someone else holds it
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "B",
      idleDebounceMs: 5,
    });

    distiller.start();
    await new Promise((r) => setTimeout(r, 15));
    expect(distiller.status().leaseHeld).toBe(false);

    feed(distiller, idleEvent("s1"));
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
    const { source } = makeDistillFake(graph);
    const { db, store } = await freshStore(() => clock);
    expect(store.acquireLease("A", 30_000, "buildA", 4)).toBe(true); // A holds it, then "dies" (no heartbeat)
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
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

  it("ownsLease does not self-demote on its own stale heartbeat", async () => {
    // If the row still names THIS instance, nobody has taken over — an expired
    // heartbeat only means someone COULD. Heartbeat freshness is the
    // ACQUIRE-side concern of rivals; self-demoting would cost a full
    // lease-retry stall after any >TTL event-loop hiccup.
    let clock = 1_000_000;
    const { source } = makeDistillFake({ sessions: [], messagesBySession: {} });
    const { db, store } = await freshStore(() => clock);
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
      store,
      gate,
      limits: { ...TEST_LIMITS, coldPass: false },
      instanceId: "hiccup",
      now: () => clock,
    });

    distiller.start();
    expect(distiller.ownsLease()).toBe(true);

    clock += 31_000; // heartbeat now looks expired, but the row still names us
    expect(distiller.ownsLease()).toBe(true);
    expect(distiller.status().leaseHeld).toBe(true);

    // An actual takeover (someone else's name on the row) IS a loss.
    expect(store.acquireLease("rival", 30_000, "rivalbuild", 4)).toBe(true);
    expect(distiller.ownsLease()).toBe(false);
    expect(distiller.status().leaseHeld).toBe(false);

    await distiller.stop();
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
    const { source, sdk } = makeDistillFake(graph, {
      metadataErrorOnce: new Set(["s1"]),
    });
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const logs: string[] = [];
    const distiller = createDistiller({
      source,
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
    feed(distiller, idleEvent("s1"));
    await waitFor(() => sdk.get === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(store.getCard("s1")).toEqual(preserved);
    expect(logs.some((line) => line.includes("session s1 re-distill failed:"))).toBe(true);
    expect(logs.some((line) => line.includes("metadata transport failed: s1"))).toBe(true);
    // The apiFailure shape carries neither not-found signal (no name/_tag/404
    // status), so it takes the transport path and surfaces in lastError.
    expect(distiller.status().lastError).toContain("metadata transport failed: s1");

    // A later idle event retries normally; the transport failure was neither
    // interpreted as deletion nor quarantined as malformed session data.
    feed(distiller, idleEvent("s1"));
    await waitFor(() => store.getCard("s1")?.timeUpdated === 4000);
    expect(sdk.get).toBe(2);
    expect(store.getCard("s1")?.summaryHead).toContain("fresh metadata transport marker");
    await distiller.stop();
    db.close();
  });

  it("treats a NotFoundError metadata response as absence: silent, card preserved", async () => {
    // session.get's real 404 body (`name: "NotFoundError"`, per the v2
    // SessionGetErrors typing) means the session is GONE — absence, not a
    // transport failure: no lastError, no quarantine, existing card untouched,
    // no retry noise in the logs.
    const graph: Graph = {
      sessions: [session("s1", "Alpha", PROJECT_DIR, 3000)],
      messagesBySession: {
        s1: [
          bundle(userMessage("m1", "s1", 100), [
            textPart("p1", "s1", "m1", "preserved not-found marker"),
          ]),
        ],
      },
    };
    const { source, sdk } = makeDistillFake(graph, {
      metadataNotFound: new Set(["s1"]),
    });
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const logs: string[] = [];
    const distiller = createDistiller({
      source,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "metadata-not-found",
      idleDebounceMs: 5,
      log: (message) => logs.push(message),
    });
    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");
    const preserved = store.getCard("s1");
    expect(preserved).toBeDefined();

    feed(distiller, idleEvent("s1"));
    await waitFor(() => sdk.get === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(store.getCard("s1")).toEqual(preserved); // untouched
    expect(distiller.status().lastError).toBeUndefined(); // no error surfaced
    expect(distiller.status().quarantinedCount).toBe(0); // not quarantined
    expect(logs.some((line) => line.includes("re-distill failed"))).toBe(false); // no retry noise
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
    const { source, sdk } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "holder",
      idleDebounceMs: 10,
    });
    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");

    const before = sdk.messages.length;
    for (let i = 0; i < 5; i++) feed(distiller, idleEvent("s1"));
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
    const { source } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    // appendThresholdParts 0 makes the session append-eligible, so only the
    // removal semantics (not size) force the full path that drops stale rows.
    const distiller = createDistiller({
      source,
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
    feed(distiller, removedEvent("s1"));
    await waitFor(
      () => ftsSessions(store.ftsSearch({ strong: ["freshmarker"], weak: [] })).length > 0,
    );

    expect(store.ftsSearch({ strong: ["stalemarker"], weak: [] })).toEqual([]); // full replace, not append
    distiller.stop();
    db.close();
  });

  it("re-distills on a meta signal without forcing the full path", async () => {
    const graph: Graph = {
      sessions: [session("s1", "Alpha", PROJECT_DIR, 3000)],
      messagesBySession: {
        s1: [
          bundle(userMessage("m1", "s1", 100), [textPart("p1", "s1", "m1", "stalemarker content")]),
        ],
      },
    };
    const { source } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    // Append-eligible, as in the removal test above; only a removal flag
    // would force the full path.
    const distiller = createDistiller({
      source,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "holder",
      idleDebounceMs: 5,
      appendThresholdParts: 0,
    });
    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");

    // Rewrite m1 in place (a full re-distill would drop "stalemarker"), add a
    // newer message, and rename the session.
    graph.sessions = [session("s1", "Alpha renamed", PROJECT_DIR, 6000)];
    graph.messagesBySession.s1 = [
      bundle(userMessage("m1", "s1", 100), [textPart("p1", "s1", "m1", "rewritten content")]),
      bundle(userMessage("m9", "s1", 5000), [textPart("p9", "s1", "m9", "freshmarker content")]),
    ];
    distiller.onEvent({ type: "meta", sessionID: "s1" });
    await waitFor(
      () => ftsSessions(store.ftsSearch({ strong: ["freshmarker"], weak: [] })).length > 0,
    );

    expect(store.getCard("s1")?.title).toBe("Alpha renamed"); // metadata picked up
    // Appended, not replaced: the meta signal did not set the removal flag.
    expect(ftsSessions(store.ftsSearch({ strong: ["stalemarker"], weak: [] }))).toEqual(["s1"]);
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
    const { source } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "holder",
    });
    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");
    expect(store.getCard("R")!.familyRollup.map((e) => e.sessionId)).toContain("C");

    feed(distiller, deletedEvent(child));

    expect(store.getCard("C")).toBeUndefined();
    expect(store.ftsSearch({ strong: ["uniquechildyy"], weak: [] })).toEqual([]);
    expect(store.getCard("R")!.familyRollup.map((e) => e.sessionId)).not.toContain("C");
    distiller.stop();
    db.close();
  });

  it("keeps a root's family rollup through a full re-index of the root", async () => {
    const root = session("R", "Root Session", PROJECT_DIR, 9000);
    const child = session("C", "Child Session", PROJECT_DIR, 4000, undefined, "R");
    const graph: Graph = {
      sessions: [root, child],
      messagesBySession: {
        R: [bundle(userMessage("mR", "R", 100), [textPart("pR", "R", "mR", "root content")])],
        C: [bundle(userMessage("mC", "C", 100), [textPart("pC", "C", "mC", "child content")])],
      },
    };
    const { source } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
      store,
      gate,
      limits: TEST_LIMITS,
      instanceId: "holder",
      idleDebounceMs: 5,
    });
    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");
    const rollup = store.getCard("R")!.familyRollup;
    expect(rollup.map((e) => e.sessionId)).toEqual(["C"]);

    // One part is far below the append threshold, so the root re-indexes in
    // full, from a derived card whose rollup is empty.
    graph.messagesBySession.R!.push(
      bundle(userMessage("mR2", "R", 200), [textPart("pR2", "R", "mR2", "rootfollowup_marker")]),
    );
    feed(distiller, idleEvent("R"));
    await waitFor(
      () => ftsSessions(store.ftsSearch({ strong: ["rootfollowup_marker"], weak: [] })).length > 0,
    );

    expect(store.getCard("R")!.familyRollup).toEqual(rollup);
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
    const { source, sdk } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
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
    feed(distiller, idleEvent("s1"));
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
    // Equivalence: append == full re-distill. The append stamped the second
    // revision, after the cold pass's.
    expect(store.getCard("s1")).toEqual({ ...full, writeRev: 2 });
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
    const { source } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const { gate } = makeSpyGate();
    // Cap of 5 rows: 4 initial + 4 appended = 8 → the 3 oldest rows are evicted.
    const distiller = createDistiller({
      source,
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
    feed(distiller, idleEvent("s1"));
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

    // Card equivalence over the capped set. The append stamped the second
    // revision, after the cold pass's; the single full write stamped the first.
    expect(store.getCard("s1")).toEqual({ ...store2.getCard("s1"), writeRev: 2 });
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

describe("sync-host re-distill fan-out", () => {
  it("runs at most distillConcurrency re-distills at once for a 500-session poll", async () => {
    const graph: Graph = { sessions: [], messagesBySession: {} };
    for (let i = 0; i < 500; i++) {
      const id = `s${i}`;
      graph.sessions.push(session(id, `Session ${i}`, PROJECT_DIR, 1_000 + i));
      graph.messagesBySession[id] = [
        bundle(userMessage(`m${i}`, id, 100), [textPart(`p${i}`, id, `m${i}`, `text ${i}`)]),
      ];
    }
    const { source: inner } = makeDistillFake(graph);
    // Count re-distills from their first read (the session lookup) to their
    // last (the message page), which is held briefly so they overlap.
    let active = 0;
    let peak = 0;
    let finished = 0;
    const source: HistorySource = {
      ...inner,
      getSession: async (id, o) => {
        active++;
        peak = Math.max(peak, active);
        return inner.getSession(id, o);
      },
      messagePage: async (o) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        const page = await inner.messagePage(o);
        active--;
        finished++;
        return page;
      },
    };
    let polled = false;
    const sync: DistillSync = {
      checkpoint: async () => null,
      compare: async () => "rewritten",
      missing: async () => [],
      poll: async () => {
        const signals: DistillSignal[] = polled
          ? []
          : graph.sessions.map((s) => ({ type: "turn-ended", sessionID: s.id }));
        polled = true;
        return { signals, commit: () => {}, failures: [] };
      },
      pollIntervalMs: 5,
      reconcileEveryMs: 1e12,
    };
    const { db, store } = await freshStore();
    const distiller = createDistiller({
      source,
      store,
      // A wide gate, so only the distiller's own bound can hold concurrency down.
      gate: createFetchGate({ concurrency: 1_000 }),
      limits: { ...TEST_LIMITS, coldPass: false, distillConcurrency: 3 },
      instanceId: "fanout",
      sync,
      idleDebounceMs: 1,
    });
    distiller.start();
    await waitFor(() => finished === 500, 10_000);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    await distiller.stop();
    db.close();
  });
});

describe("sync-host re-distill queue across a lease handoff", () => {
  it("drains queued re-distills when the lease is reacquired", async () => {
    const graph: Graph = { sessions: [], messagesBySession: {} };
    for (const id of ["s1", "s2", "s3"]) {
      graph.sessions.push(session(id, id, PROJECT_DIR, 1_000));
      graph.messagesBySession[id] = [
        bundle(userMessage(`m-${id}`, id, 100), [textPart(`p-${id}`, id, `m-${id}`, `${id} text`)]),
      ];
    }
    const { source: inner } = makeDistillFake(graph);
    let releaseS1!: () => void;
    const s1Blocked = new Promise<void>((resolve) => (releaseS1 = resolve));
    const source: HistorySource = {
      ...inner,
      getSession: async (id, o) => {
        if (id === "s1") await s1Blocked;
        return inner.getSession(id, o);
      },
    };
    let polled = false;
    const sync: DistillSync = {
      checkpoint: async () => null,
      compare: async () => "rewritten",
      missing: async () => [],
      poll: async () => {
        const signals: DistillSignal[] = polled
          ? []
          : graph.sessions.map((s) => ({ type: "turn-ended", sessionID: s.id }));
        polled = true;
        return { signals, commit: () => {}, failures: [] };
      },
      pollIntervalMs: 5,
      reconcileEveryMs: 1e12,
    };
    const { db, store } = await freshStore();
    const distiller = createDistiller({
      source,
      store,
      gate: createFetchGate({ concurrency: 4 }),
      limits: { ...TEST_LIMITS, coldPass: false, distillConcurrency: 1 },
      instanceId: "handoff",
      sync,
      idleDebounceMs: 1,
      leaseRetryMs: 10,
      log: () => {},
    });
    distiller.start();
    // s1 runs (blocked), s2 and s3 wait in the queue.
    await new Promise((resolve) => setTimeout(resolve, 40));
    // A rival takes the lease; s1's write sees it and the distiller demotes.
    store.setMeta(
      "distill_lease",
      JSON.stringify({ holder: "rival", heartbeat: Date.now(), ttl: 30_000, build: "x", gen: 1 }),
    );
    releaseS1();
    await waitFor(() => !distiller.status().leaseHeld);
    expect(store.getCard("s2")).toBeUndefined();
    // The rival lets go; the retry reacquires and must drain the queue.
    store.releaseLease("rival");
    await waitFor(() => store.getCard("s2") !== undefined && store.getCard("s3") !== undefined);
    await distiller.stop();
    db.close();
  });
});

describe("sync-host poll dispatch", () => {
  it("yields every 50 dispatched signals and commits after the last one", async () => {
    const { source } = makeDistillFake({ sessions: [], messagesBySession: {} });
    let polled = false;
    let committed = false;
    const sync: DistillSync = {
      checkpoint: async () => null,
      compare: async () => "fresh",
      missing: async () => [],
      poll: async () => {
        const signals: DistillSignal[] = polled
          ? []
          : Array.from({ length: 120 }, (_, i) => ({
              type: "meta" as const,
              sessionID: `s${i}`,
              patch: { title: `t${i}` },
            }));
        polled = true;
        return { signals, commit: () => void (committed = true), failures: [] };
      },
      pollIntervalMs: 5,
      reconcileEveryMs: 1e12,
    };
    let yields = 0;
    const { db, store } = await freshStore();
    const distiller = createDistiller({
      source,
      store,
      gate: createFetchGate({ concurrency: 2 }),
      limits: { ...TEST_LIMITS, coldPass: false },
      instanceId: "dispatch-yields",
      sync,
      yieldBetween: async () => {
        yields++;
      },
      log: () => {},
    });
    distiller.start();
    await waitFor(() => committed);
    // 120 signals: a pause after the 50th and the 100th.
    expect(yields).toBe(2);
    await distiller.stop();
    db.close();
  });

  it("stop waits for a poll in flight, so no read happens after it resolves", async () => {
    const { source } = makeDistillFake({ sessions: [], messagesBySession: {} });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    const order: string[] = [];
    const sync: DistillSync = {
      checkpoint: async () => null,
      compare: async () => "fresh",
      missing: async () => [],
      poll: async () => {
        entered = true;
        await blocked;
        order.push("poll read");
        return { signals: [], commit: () => {}, failures: [] };
      },
      pollIntervalMs: 5,
      reconcileEveryMs: 1e12,
    };
    const { db, store } = await freshStore();
    const distiller = createDistiller({
      source,
      store,
      gate: createFetchGate({ concurrency: 2 }),
      limits: { ...TEST_LIMITS, coldPass: false },
      instanceId: "stop-waits-poll",
      sync,
      log: () => {},
    });
    distiller.start();
    await waitFor(() => entered);
    let stopResolved = false;
    const stopping = distiller.stop().then(() => {
      stopResolved = true;
      order.push("stop resolved");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopResolved).toBe(false);
    release();
    await stopping;
    expect(order).toEqual(["poll read", "stop resolved"]);
    db.close();
  });
});

describe("sync-host unsettled retries", () => {
  it("stops re-reading an unsettled session on every poll after repeated failures", async () => {
    const graph: Graph = {
      sessions: [session("s1", "One", PROJECT_DIR, 1_000)],
      messagesBySession: {
        s1: [bundle(userMessage("m1", "s1", 100), [textPart("p1", "s1", "m1", "one")])],
      },
    };
    const { source: inner } = makeDistillFake(graph);
    let failing = false;
    let failedReads = 0;
    const source: HistorySource = {
      ...inner,
      messagePage: async (o) => {
        if (failing) {
          failedReads++;
          throw new Error("history read failed");
        }
        return inner.messagePage(o);
      },
    };
    const sync: DistillSync = {
      // Always unsettled: every poll re-reads the session.
      checkpoint: async () => ({ cursor: "tail", settled: false }),
      compare: async () => "rewritten",
      missing: async () => [],
      poll: async () => ({ signals: [], commit: () => {}, failures: [] }),
      pollIntervalMs: 3,
      reconcileEveryMs: 1e12,
    };
    const { db, store } = await freshStore();
    const distiller = createDistiller({
      source,
      store,
      gate: createFetchGate({ concurrency: 4 }),
      limits: { ...TEST_LIMITS, coldPass: true },
      instanceId: "unsettled-failures",
      sync,
      idleDebounceMs: 1,
      log: () => {},
    });
    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");
    failing = true;
    await waitFor(() => failedReads >= 3);
    await new Promise((resolve) => setTimeout(resolve, 60)); // many more polls
    expect(failedReads).toBe(3);
    await distiller.stop();
    db.close();
  });
});

describe("null store", () => {
  it("is a clean no-op with no lease and idle status", () => {
    const { source } = makeDistillFake({ sessions: [], messagesBySession: {} });
    const { gate } = makeSpyGate();
    const distiller = createDistiller({
      source,
      store: null,
      gate,
      limits: TEST_LIMITS,
      instanceId: "none",
    });
    expect(() => {
      distiller.start();
      feed(distiller, idleEvent("s1"));
      distiller.stop();
    }).not.toThrow();
    expect(distiller.status()).toEqual({
      leaseHeld: false,
      coldPass: "idle",
      distilledCount: 0,
      knownCount: 0,
      examinedCount: 0,
      quarantinedCount: 0,
      skippedCount: 0,
      failingCount: 0,
    });
  });
});

describe("cold-pass progress reporting", () => {
  /** A yieldBetween that holds the pass while `held` is true. */
  function holdable(): { pause: () => Promise<void>; hold: (on: boolean) => void } {
    let held = false;
    let waiters: Array<() => void> = [];
    return {
      pause: () =>
        held ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve(),
      hold: (on) => {
        held = on;
        if (!on) {
          for (const wake of waiters) wake();
          waiters = [];
        }
      },
    };
  }

  function twoSessions(): Graph {
    return {
      sessions: [session("s1", "One", PROJECT_DIR, 2000), session("s2", "Two", PROJECT_DIR, 1000)],
      messagesBySession: {
        s1: [bundle(userMessage("m1", "s1", 100), [textPart("p1", "s1", "m1", "one")])],
        s2: [bundle(userMessage("m2", "s2", 100), [textPart("p2", "s2", "m2", "two")])],
      },
    };
  }

  it("reports progress on a first build, stamps completion, and stays quiet on a warm restart", async () => {
    const graph = twoSessions();
    const { source } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const gate = holdable();
    const make = (instanceId: string) =>
      createDistiller({
        source,
        store,
        gate: makeSpyGate().gate,
        limits: { ...TEST_LIMITS, distillConcurrency: 1 },
        instanceId,
        yieldBetween: gate.pause,
        log: () => {},
      });

    gate.hold(true);
    const first = make("first-build");
    first.start();
    await waitFor(() => first.status().knownCount === 2);
    expect(first.indexing()).toEqual({ indexed: 0, examined: 0, known: 2 });
    gate.hold(false);
    await waitFor(() => first.status().coldPass === "done");
    expect(first.indexing()).toBeUndefined();
    expect(store.getMeta(COLD_PASS_COMPLETE_KEY)).toBe("1");
    await first.stop();

    // A restart re-verifies the complete store: running, but nothing to report.
    gate.hold(true);
    const warm = make("warm-restart");
    warm.start();
    await waitFor(() => warm.status().knownCount === 2);
    expect(warm.status().coldPass).toBe("running");
    expect(warm.indexing()).toBeUndefined();
    gate.hold(false);
    await warm.stop();
    db.close();
  });

  it("reports nothing over an unstamped store that already has every card", async () => {
    // A store from before the completion stamp: the card count shows it is
    // complete, even while discovery is still running.
    const graph = twoSessions();
    const { source } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const built = createDistiller({
      source,
      store,
      gate: makeSpyGate().gate,
      limits: TEST_LIMITS,
      instanceId: "prebuilt",
      log: () => {},
    });
    built.start();
    await waitFor(() => built.status().coldPass === "done");
    await built.stop();
    db.run("DELETE FROM meta WHERE key = ?", [COLD_PASS_COMPLETE_KEY]);

    let releaseDiscovery!: () => void;
    const discovering = new Promise<void>((resolve) => (releaseDiscovery = resolve));
    const gate = holdable();
    gate.hold(true);
    const restarted = createDistiller({
      source,
      store,
      gate: makeSpyGate().gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "unstamped",
      discover: async () => {
        await discovering;
        const listing = await source.listSessions({ scope: "project", limit: 100 });
        if (!listing.ok) throw new Error(listing.error);
        return listing.items;
      },
      yieldBetween: gate.pause,
      log: () => {},
    });
    restarted.start();
    await waitFor(() => restarted.status().coldPass === "running");
    expect(restarted.indexing()).toBeUndefined(); // discovering, cards present
    releaseDiscovery();
    await waitFor(() => restarted.status().knownCount === 2);
    expect(restarted.indexing()).toBeUndefined(); // 2 known, 2 cards
    gate.hold(false);
    await restarted.stop();
    db.close();
  });

  it("a process without the lease reports the holder's shared progress, then nothing", async () => {
    const graph = twoSessions();
    const { source } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const gate = holdable();
    const make = (instanceId: string) =>
      createDistiller({
        source,
        store,
        gate: makeSpyGate().gate,
        limits: { ...TEST_LIMITS, distillConcurrency: 1 },
        instanceId,
        yieldBetween: gate.pause,
        leaseRetryMs: 60_000,
        log: () => {},
      });
    gate.hold(true);
    const holder = make("holder");
    holder.start();
    await waitFor(() => holder.status().knownCount === 2);
    const other = make("other");
    other.start(); // the lease is taken: this one only answers queries
    expect(other.status().leaseHeld).toBe(false);
    expect(other.indexing()).toEqual({ indexed: 0, examined: 0, known: 2 });

    gate.hold(false);
    await waitFor(() => holder.status().coldPass === "done");
    expect(other.indexing()).toBeUndefined();
    await other.stop();
    await holder.stop();
    db.close();
  });

  it("a process without the lease reports that the holder's discovery stopped at its limit", async () => {
    const graph = twoSessions();
    const { source } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const other = createDistiller({
      source,
      store,
      gate: makeSpyGate().gate,
      limits: { ...TEST_LIMITS, coldPass: false },
      instanceId: "other",
      log: () => {},
    });
    expect(other.discoveryTruncated()).toBe(false);
    let truncated = true;
    const discover = async (): Promise<HistorySession[]> => {
      const listing = await source.listSessions({ scope: "project", limit: 100 });
      if (!listing.ok) throw new Error(listing.error);
      return listing.items;
    };
    const holder = createDistiller({
      source,
      store,
      gate: makeSpyGate().gate,
      limits: TEST_LIMITS,
      instanceId: "holder",
      discover,
      discoveryTruncated: () => truncated,
      log: () => {},
    });
    holder.start();
    await waitFor(() => holder.status().coldPass === "done");
    expect(holder.status().leaseHeld).toBe(true);
    expect(other.status().leaseHeld).toBe(false);
    expect(other.discoveryTruncated()).toBe(true);
    await holder.stop();

    // The next holder's complete discovery clears it for everyone.
    truncated = false;
    const next = createDistiller({
      source,
      store,
      gate: makeSpyGate().gate,
      limits: TEST_LIMITS,
      instanceId: "next",
      discover,
      discoveryTruncated: () => truncated,
      log: () => {},
    });
    next.start();
    await waitFor(() => next.status().coldPass === "done");
    expect(other.discoveryTruncated()).toBe(false);
    await next.stop();
    await other.stop();
    db.close();
  });

  it("reports stale shared progress as a stalled gap, not as a pass in progress", async () => {
    const graph = twoSessions();
    const { source } = makeDistillFake(graph);
    const { db, store } = await freshStore();
    const built = createDistiller({
      source,
      store,
      gate: makeSpyGate().gate,
      limits: TEST_LIMITS,
      instanceId: "built",
      log: () => {},
    });
    built.start();
    await waitFor(() => built.status().coldPass === "done");
    await built.stop();
    // Two cards of five known sessions, and no completed pass.
    db.run("DELETE FROM meta WHERE key = ?", [COLD_PASS_COMPLETE_KEY]);
    const t = Date.now();
    const reader = createDistiller({
      source,
      store,
      gate: makeSpyGate().gate,
      limits: { ...TEST_LIMITS, coldPass: false },
      instanceId: "reader",
      now: () => t,
      log: () => {},
    });
    store.setMeta(COLD_PASS_PROGRESS_KEY, JSON.stringify({ examined: 1, known: 5, at: t - 1_000 }));
    expect(reader.indexing()).toEqual({ indexed: 2, examined: 1, known: 5 });
    store.setMeta(
      COLD_PASS_PROGRESS_KEY,
      JSON.stringify({ examined: 1, known: 5, at: t - PROGRESS_STALE_MS - 1 }),
    );
    expect(reader.indexing()).toEqual({ indexed: 2, examined: 1, known: 5, stalled: true });
    // Once the store holds a card per known session, there is no gap.
    store.setMeta(COLD_PASS_PROGRESS_KEY, JSON.stringify({ examined: 2, known: 2, at: t }));
    expect(reader.indexing()).toBeUndefined();
    await reader.stop();
    db.close();
  });

  it("a holder whose pass aborted keeps reporting where it got to while the retry waits", async () => {
    const graph: Graph = { sessions: [], messagesBySession: {} };
    const failTimes: Record<string, number> = {};
    for (let i = 0; i < 6; i++) {
      const id = `s${i}`;
      graph.sessions.push(session(id, id, PROJECT_DIR, 10_000 - i * 1000));
      graph.messagesBySession[id] = [
        bundle(userMessage(`m-${id}`, id, 100), [textPart(`p-${id}`, id, `m-${id}`, id)]),
      ];
      if (i < 5) failTimes[id] = 1; // the five newest fail once: an outage
    }
    const { source } = makeDistillFake(graph, { failTimes });
    const { db, store } = await freshStore();
    const distiller = createDistiller({
      source,
      store,
      gate: makeSpyGate().gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "aborted",
      coldPassRetryMs: 60_000,
      log: () => {},
    });
    distiller.start();
    await waitFor(() => distiller.status().lastError !== undefined);
    expect(distiller.status().coldPass).toBe("idle");
    expect(distiller.indexing()).toEqual({ indexed: 0, examined: 0, known: 6 });
    await distiller.stop();
    db.close();
  });

  it("starts a later pass's progress from zero, not the last pass's counts", async () => {
    const graph = twoSessions();
    // s2 fails its fetch and its retry, so a follow-up pass runs.
    const { source } = makeDistillFake(graph, { failTimes: { s2: 2 } });
    const { db, store } = await freshStore();
    let discoveries = 0;
    let releaseSecond!: () => void;
    const second = new Promise<void>((resolve) => (releaseSecond = resolve));
    const listing = await source.listSessions({ scope: "project", limit: 100 });
    if (!listing.ok) throw new Error(listing.error);
    const distiller = createDistiller({
      source,
      store,
      gate: makeSpyGate().gate,
      limits: { ...TEST_LIMITS, distillConcurrency: 1 },
      instanceId: "second-pass",
      coldPassRetryMs: 5,
      discover: async () => {
        if (++discoveries === 2) await second;
        return listing.items;
      },
      log: () => {},
    });
    distiller.start();
    await waitFor(() => discoveries === 2);
    expect(distiller.status().coldPass).toBe("running");
    expect(distiller.status().examinedCount).toBe(0);
    expect(distiller.status().knownCount).toBe(0);
    releaseSecond();
    await waitFor(() => distiller.status().coldPass === "done");
    await distiller.stop();
    db.close();
  });
});

describe("family rollups read a page at a time", () => {
  const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  /** Cards per rollup page: a few dozen cards span several pages. */
  const PAGE = 8;

  /** A card of `rootId`'s family (the root itself when the ids match). */
  const member = (id: string, rootId: string, t: number, over: Partial<Card> = {}): Card => ({
    ...fullCard(id, t),
    rootId,
    parentId: id === rootId ? null : rootId,
    ...over,
  });

  /**
   * `n` children of `rootId`. Their times repeat, so the newest are chosen by
   * id; ids come in pairs that differ only in case, which a locale comparison
   * orders differently from SQLite's byte order. Hints come from the title,
   * from the summary head (some titles are longer than a hint) or from
   * neither, and some children have no distilled message.
   */
  function children(rootId: string, n: number, t0: number): Card[] {
    return Array.from({ length: n }, (_, i) => {
      const id = `${rootId}-${i % 2 === 0 ? "a" : "A"}${String(i >> 1).padStart(4, "0")}`;
      const variant = i % 4;
      return member(id, rootId, t0 + (i % 3), {
        title: variant === 0 ? `Child ${i}` : variant === 1 ? `Long ${"x".repeat(200)}` : "",
        summaryHead: variant === 2 ? `head of ${id}` : "",
        distilledThrough: i % 5 === 0 ? null : `m-${id}`,
      });
    });
  }

  /** `rootId`'s rollup computed from every card in the store at once. */
  function rollupFromAll(store: Store, rootId: string): FamilyRollup[] {
    return store
      .allCards()
      .filter((card) => card.rootId === rootId && card.sessionId !== rootId)
      .sort((a, b) => b.timeUpdated - a.timeUpdated || a.sessionId.localeCompare(b.sessionId))
      .slice(0, 12)
      .map((child) => {
        const hint = (child.title || child.summaryHead).slice(0, 120);
        const base = { sessionId: child.sessionId, messageId: child.distilledThrough ?? "" };
        return hint ? { ...base, snippet: hint } : base;
      });
  }

  /**
   * A store whose next yield after a call of an armed method waits until
   * that hold is released. Every store call is recorded in `calls`, and
   * those made while `closed` is set in `after` too.
   */
  function holding(store: Store) {
    type Hold = { method: string; held: boolean; release: () => void; wait: Promise<void> };
    const armed: Hold[] = [];
    let next: Hold | undefined;
    const calls: string[] = [];
    const after: string[] = [];
    let closed = false;
    const wrapped = new Proxy(store, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          if (closed) after.push(String(prop));
          const hold = armed.find((h) => h.method === prop);
          if (hold) {
            armed.splice(armed.indexOf(hold), 1);
            next = hold;
          }
          return method.apply(target, args);
        };
      },
    });
    return {
      store: wrapped,
      yieldBetween: async (): Promise<void> => {
        const hold = next;
        next = undefined;
        if (!hold) return macrotask();
        hold.held = true;
        await hold.wait;
      },
      arm(method: keyof Store): Hold {
        let release = (): void => {};
        const wait = new Promise<void>((resolve) => (release = resolve));
        const hold: Hold = { method, held: false, release, wait };
        armed.push(hold);
        return hold;
      },
      close(): void {
        closed = true;
      },
      calls,
      after,
    };
  }

  /** Put a rival's name on the lease row, as a takeover does. */
  const takeLease = (store: Store): void =>
    store.setMeta(
      "distill_lease",
      JSON.stringify({ holder: "rival", heartbeat: Date.now(), ttl: 30_000, build: "x", gen: 1 }),
    );

  async function setup(o: { coldPass: boolean; cards: Card[] }) {
    const { db, store } = await freshStore();
    // One transaction: a commit per card makes the seeding slow when the
    // disk is.
    db.tx(() => {
      for (const card of o.cards) store.upsertCard(card);
    });
    const h = holding(store);
    const distiller = createDistiller({
      source: makeDistillFake({ sessions: [], messagesBySession: {} }).source,
      store: h.store,
      gate: makeSpyGate().gate,
      limits: { ...TEST_LIMITS, coldPass: o.coldPass, distillDelayMs: 0 },
      instanceId: "rollups",
      discover: async () => [],
      yieldBetween: h.yieldBetween,
      rollupPage: PAGE,
      log: () => {},
    });
    return { db, store, h, distiller };
  }

  it("rebuilds a family of several pages after a child deletion as from every card at once", async () => {
    const family = children("R", 40, 5_000);
    const other = children("S", 10, 6_000);
    // The families' cards interleave in the card table.
    const cards = [member("R", "R", 1_000), member("S", "S", 1_000)];
    family.forEach((card, i) => cards.push(card, ...(i < other.length ? [other[i]!] : [])));
    const { db, store, distiller } = await setup({ coldPass: false, cards });
    distiller.start();
    const before = rollupFromAll(store, "R");
    distiller.onEvent({ type: "deleted", sessionID: before[0]!.sessionId });
    await waitFor(() => store.getCard("R")!.familyRollup.length > 0);
    const expected = rollupFromAll(store, "R");
    expect(expected[0]).not.toEqual(before[0]);
    expect(store.getCard("R")!.familyRollup).toEqual(expected);
    await distiller.stop();
    db.close();
  });

  it("builds every root's rollup over a store of several pages as from every card at once", async () => {
    const cards = [
      member("R", "R", 1_000),
      ...children("R", 30, 5_000),
      member("S", "S", 1_000),
      ...children("S", 5, 4_000),
      // A root whose children are gone keeps no rollup.
      member("T", "T", 1_000, { familyRollup: [{ sessionId: "T-gone", messageId: "m" }] }),
      // A child whose root has no card.
      member("U-child", "U", 1_000),
      ...Array.from({ length: 20 }, (_, i) => member(`solo-${i}`, `solo-${i}`, 2_000)),
    ];
    const { db, store, distiller } = await setup({ coldPass: true, cards });
    distiller.start();
    await waitFor(() => distiller.status().coldPass === "done");
    expect(store.getCard("R")!.familyRollup).toEqual(rollupFromAll(store, "R"));
    expect(store.getCard("R")!.familyRollup).toHaveLength(12);
    expect(store.getCard("S")!.familyRollup).toEqual(rollupFromAll(store, "S"));
    expect(store.getCard("S")!.familyRollup).toHaveLength(5);
    expect(store.getCard("T")!.familyRollup).toEqual([]);
    await distiller.stop();
    db.close();
  });

  it("recomputes a family again when a child is deleted while a recompute of it waits", async () => {
    const family = children("R", 30, 5_000);
    const { db, store, h, distiller } = await setup({
      coldPass: false,
      cards: [member("R", "R", 1_000), ...family],
    });
    distiller.start();
    const [first, second] = rollupFromAll(store, "R");
    // The first recompute waits after its first page, which lists `second`.
    const hold = h.arm("familyPage");
    distiller.onEvent({ type: "deleted", sessionID: first!.sessionId });
    await waitFor(() => hold.held);
    distiller.onEvent({ type: "deleted", sessionID: second!.sessionId });
    // Time for a second recompute running beside the first to finish first.
    await new Promise((resolve) => setTimeout(resolve, 50));
    hold.release();
    const ids = () => store.getCard("R")!.familyRollup.map((entry) => entry.sessionId);
    await waitFor(() => ids().length > 0 && !ids().includes(second!.sessionId));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getCard("R")!.familyRollup).toEqual(rollupFromAll(store, "R"));
    await distiller.stop();
    db.close();
  });

  it("keeps a rollup that a recompute started during a full pass wrote", async () => {
    const { db, store, h, distiller } = await setup({
      coldPass: true,
      cards: [
        member("R", "R", 1_000),
        member("R-c", "R", 3_000),
        member("R-d", "R", 2_000),
        // Enough cards that the pass reads two pages; R's family is on the first.
        ...Array.from({ length: 10 }, (_, i) => member(`solo-${i}`, `solo-${i}`, 2_000)),
      ],
    });
    const hold = h.arm("rollupFieldsPage");
    distiller.start();
    await waitFor(() => hold.held);
    // The pass has read R-c; deleting it recomputes R's rollup without it.
    distiller.onEvent({ type: "deleted", sessionID: "R-c" });
    expect(store.getCard("R")!.familyRollup.map((entry) => entry.sessionId)).toEqual(["R-d"]);
    hold.release();
    await waitFor(() => distiller.status().coldPass === "done");
    expect(store.getCard("R")!.familyRollup.map((entry) => entry.sessionId)).toEqual(["R-d"]);
    await distiller.stop();
    db.close();
  });

  it("recomputes a family again after a full pass that found a recompute of it running", async () => {
    // R-z-new is on the recompute's first page (inserted early) and on the
    // pass's last page (its id sorts after every other card).
    const { db, store, h, distiller } = await setup({
      coldPass: true,
      cards: [
        member("R", "R", 1_000),
        member("R-z-new", "R", 9_000, { title: "old title" }),
        ...children("R", 30, 5_000),
        ...Array.from({ length: 10 }, (_, i) => member(`R-solo-${i}`, `R-solo-${i}`, 2_000)),
      ],
    });
    const pass = h.arm("rollupFieldsPage");
    distiller.start();
    await waitFor(() => pass.held);
    // A recompute of R reads its first page, then waits.
    const recompute = h.arm("familyPage");
    distiller.onEvent({ type: "deleted", sessionID: "R-a0000" });
    await waitFor(() => recompute.held);
    // A change no recompute is asked for: the pass reads it, the waiting
    // recompute already read the card before it.
    store.patchCardMeta("R-z-new", { title: "new title" });
    pass.release();
    await waitFor(() => distiller.status().coldPass === "done");
    recompute.release();
    await waitFor(() => store.getCard("R")!.familyRollup[0]?.snippet === "new title");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getCard("R")!.familyRollup).toEqual(rollupFromAll(store, "R"));
    await distiller.stop();
    db.close();
  });

  it("writes no rollup when the lease moves while a recompute of a family waits", async () => {
    const { db, store, h, distiller } = await setup({
      coldPass: false,
      cards: [member("R", "R", 1_000), ...children("R", 30, 5_000)],
    });
    distiller.start();
    const hold = h.arm("familyPage");
    distiller.onEvent({ type: "deleted", sessionID: "R-a0000" });
    await waitFor(() => hold.held);
    takeLease(store);
    const mark = h.calls.length;
    hold.release();
    await waitFor(() => !distiller.status().leaseHeld);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.calls.slice(mark)).not.toContain("setFamilyRollup");
    expect(store.getCard("R")!.familyRollup).toEqual([]);
    await distiller.stop();
    db.close();
  });

  it("writes no rollup when the lease moves while a full pass waits between pages", async () => {
    const { db, store, h, distiller } = await setup({
      coldPass: true,
      cards: [
        member("R", "R", 1_000),
        member("R-c", "R", 3_000),
        ...Array.from({ length: 10 }, (_, i) => member(`solo-${i}`, `solo-${i}`, 2_000)),
      ],
    });
    const hold = h.arm("rollupFieldsPage");
    distiller.start();
    await waitFor(() => hold.held);
    takeLease(store);
    const mark = h.calls.length;
    hold.release();
    await waitFor(() => !distiller.status().leaseHeld && distiller.status().coldPass !== "running");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.calls.slice(mark)).not.toContain("setFamilyRollup");
    expect(store.getCard("R")!.familyRollup).toEqual([]);
    await distiller.stop();
    db.close();
  });

  it("reads nothing more from the store once the distiller stops during a recompute", async () => {
    const { db, h, distiller } = await setup({
      coldPass: false,
      cards: [member("R", "R", 1_000), ...children("R", 30, 5_000)],
    });
    distiller.start();
    const hold = h.arm("familyPage");
    distiller.onEvent({ type: "deleted", sessionID: "R-a0000" });
    await waitFor(() => hold.held);
    const stopping = distiller.stop();
    h.close();
    hold.release();
    await stopping;
    expect(h.after).toEqual([]);
    db.close();
  });
});

describe("session writes from concurrent workers", () => {
  /**
   * A store that, after each session write, schedules a timer like a stall
   * probe's tick, and counts a write made before the previous write's timer
   * has run: two writes in one slice of the loop.
   */
  function pacedStore(store: Store) {
    const counts = { writes: 0, backToBack: 0, appends: 0, tails: 0 };
    let tickPending = false;
    const writes = new Set(["replaceSessionParts", "appendSessionParts", "replaceSessionTail"]);
    const wrapped = new Proxy(store, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function" || !writes.has(String(prop))) return value;
        const method = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          if (tickPending) counts.backToBack++;
          counts.writes++;
          if (prop === "appendSessionParts") counts.appends++;
          if (prop === "replaceSessionTail") counts.tails++;
          try {
            return method.apply(target, args);
          } finally {
            tickPending = true;
            setTimeout(() => (tickPending = false), 0);
          }
        };
      },
    });
    return { store: wrapped, counts };
  }

  const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  /** Eight sessions of one message each. */
  function graph(): Graph {
    const sessions = Array.from({ length: 8 }, (_, i) =>
      session(`s${i}`, `Session ${i}`, PROJECT_DIR, 9_000 - i),
    );
    const messagesBySession: Record<string, MessageBundle[]> = {};
    for (const s of sessions) {
      messagesBySession[s.id] = [
        bundle(userMessage(`m-${s.id}`, s.id, 100), [
          textPart(`p-${s.id}`, s.id, `m-${s.id}`, `work in ${s.id}`),
        ]),
      ];
    }
    return { sessions, messagesBySession };
  }

  async function setup(g: Graph, appendThresholdParts?: number, distillConcurrency = 2) {
    const { source } = makeDistillFake(g);
    const { db, store } = await freshStore();
    const paced = pacedStore(store);
    const distiller = createDistiller({
      source,
      store: paced.store,
      gate: makeSpyGate().gate,
      limits: { ...TEST_LIMITS, distillConcurrency, distillDelayMs: 0 },
      instanceId: "paced",
      idleDebounceMs: 1,
      yieldBetween: macrotask,
      log: () => {},
      ...(appendThresholdParts !== undefined && { appendThresholdParts }),
    });
    return { db, store, paced, distiller };
  }

  it.each([2, 4])(
    "never commits two cold-pass writes of %i workers in one slice of the loop",
    async (workers) => {
      const g = graph();
      const { sessions } = g;
      const { db, store, paced, distiller } = await setup(g, undefined, workers);
      distiller.start();
      await waitFor(() => distiller.status().coldPass === "done");
      expect(paced.counts.writes).toBe(sessions.length);
      expect(paced.counts.backToBack).toBe(0);
      // Every session is indexed as before.
      for (const s of sessions) expect(store.getCard(s.id)?.distillState).toBe("full");
      await distiller.stop();
      db.close();
    },
  );

  it.each([
    ["full reads", undefined, 0],
    ["appends", 0, 8],
  ])(
    "never commits two re-distill writes in one slice of the loop, for %s",
    async (_, threshold, appends) => {
      const g = graph();
      const { db, store, paced, distiller } = await setup(g, threshold);
      distiller.start();
      await waitFor(() => distiller.status().coldPass === "done");
      const coldWrites = paced.counts.writes;
      for (const s of g.sessions) {
        s.time.updated += 1_000;
        g.messagesBySession[s.id]!.push(
          bundle(userMessage(`m2-${s.id}`, s.id, 200), [
            textPart(`p2-${s.id}`, s.id, `m2-${s.id}`, `more ${s.id}`),
          ]),
        );
      }
      for (const s of g.sessions) feed(distiller, idleEvent(s.id));
      await waitFor(() =>
        g.sessions.every((s) => store.getCard(s.id)?.distilledThrough === `m2-${s.id}`),
      );
      expect(paced.counts.writes - coldWrites).toBe(g.sessions.length);
      expect(paced.counts.appends).toBe(appends);
      expect(paced.counts.backToBack).toBe(0);
      await distiller.stop();
      db.close();
    },
  );

  it("never commits two tail writes in one slice of the loop", async () => {
    const v2 = await makeV2PartsDb();
    const T0 = 1_000_000;
    const ids = Array.from({ length: 8 }, (_, i) => `ses_tail_${i}`);
    /** Each session's running reply: a user row and a settled reply before
     *  it, so a write records the settled base a tail write starts from. */
    const running = new Map<string, string>();
    // One transaction: a commit per row makes the fixture slow when the disk
    // is.
    v2.db.tx(() => {
      insertProject(v2.db, { id: "prj", worktree: "/workspace/tail" });
      for (const id of ids) seedSession(id);
    });
    function seedSession(id: string): void {
      insertSession(v2.db, {
        id,
        project_id: "prj",
        directory: "/workspace/tail",
        title: `Title ${id}`,
        time_created: T0,
        time_updated: T0,
      });
      const reply = (seq: number, settled: boolean) => {
        const message = `msg_${id}_${seq}`;
        const at = T0 + seq;
        insertMessage(v2.db, {
          id: message,
          session_id: id,
          type: "assistant",
          seq,
          time_created: at,
          time_updated: settled ? at : Date.now(),
          data: {
            agent: "build",
            model: { id: "m", providerID: "p" },
            content: [],
            time: settled ? { created: at, completed: at + 1 } : { created: at },
          },
        });
        insertPart(v2.db, {
          message_id: message,
          session_id: id,
          ordinal: 0,
          time_created: at,
          time_updated: settled ? at : Date.now(),
          data: { type: "text", text: `reply ${seq} of ${id}` },
        });
        return message;
      };
      insertMessage(v2.db, {
        id: `msg_${id}_1`,
        session_id: id,
        type: "user",
        seq: 1,
        time_created: T0 + 1,
        data: { text: `question for ${id}`, time: { created: T0 + 1 } },
      });
      reply(2, true);
      running.set(id, reply(3, false));
    }
    const opened = await openOpencodeDb(v2.path);
    if (!opened.ok) throw new Error(opened.reason);
    const reader = limitSpy(opened.db);
    const db = await openSqlite(freshDbPath());
    if (!db) throw new Error("no sqlite");
    const result = openStore(db, { host: "opencode-v2", source: v2.path });
    if (!result.ok) throw new Error(result.reason);
    const store = result.store;
    const paced = pacedStore(store);
    const distiller = createDistiller({
      source: createV2HistorySource(reader),
      store: paced.store,
      gate: makeSpyGate().gate,
      limits: { ...TEST_LIMITS, coldPass: false, distillConcurrency: 2, distillDelayMs: 0 },
      instanceId: "paced-tail",
      sync: createV2Sync(reader, {
        pollIntervalMs: 1e9,
        sessionScanEveryMs: 1e12,
        reconcileEveryMs: 1e12,
      }),
      projectorGen: V2_PROJECTOR_GEN,
      idleDebounceMs: 1,
      yieldBetween: macrotask,
      log: () => {},
    });
    try {
      distiller.start();
      // The first writes read in full and record each settled base.
      for (const id of ids) distiller.onEvent({ type: "turn-ended", sessionID: id });
      await waitFor(() => ids.every((id) => store.getCard(id)?.settledBase !== undefined));

      // Every running reply grows: each session is read again from its base.
      v2.db.tx(() => {
        for (const [id, message] of running) {
          v2.db.run(
            "UPDATE session_part SET data = ?, time_updated = ? WHERE message_id = ? AND ordinal = 0",
            [JSON.stringify({ type: "text", text: `grown reply of ${id}` }), Date.now(), message],
          );
        }
      });
      for (const id of ids) distiller.onEvent({ type: "turn-ended", sessionID: id });
      await waitFor(() => paced.counts.tails === ids.length);
      expect(paced.counts.backToBack).toBe(0);
    } finally {
      await distiller.stop();
      reader.close();
      db.close();
      v2.cleanup();
    }
  });
});
