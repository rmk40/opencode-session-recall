import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Message, Part } from "@opencode-ai/sdk/v2";
import { context as contextTool } from "../src/context.js";
import { get as getTool } from "../src/get.js";
import { messages as messagesTool } from "../src/messages.js";
import { sessions as sessionsTool } from "../src/sessions.js";
import { formatMsg } from "../src/extract.js";
import { createFetchGate } from "../src/fetch-gate.js";
import { encodeContinuation } from "../src/output.js";
import type { ToolDefinition } from "../src/host/opencode-v1-types.js";
import type { HistorySource } from "../src/history/source.js";
import { createV2HistorySource, openOpencodeDb, type V2SourceOptions } from "../src/history/v2.js";
import type { MessageItem, PartOutput } from "../src/types.js";
import {
  MessageJoiner,
  PartJoiner,
  flatMessage,
  flatPart,
  parseBounded,
  type Flat,
  type Out,
} from "./output-join.js";
import {
  PROJECT_DIR,
  TEST_LIMITS,
  assistantMessage,
  bundle,
  completedToolPart,
  errorToolPart,
  makeContext,
  makeFakeHarness,
  reasoningPart,
  runningToolPart,
  session,
  setStrictNoLimitMessages,
  textPart,
  toolResultText,
  userMessage,
  type FakeHarness,
} from "./helpers.js";
import {
  insertMessage,
  insertPart,
  insertProject,
  insertSession,
  limitSpy,
  makeV2Db,
  makeV2PartsDb,
  type V2TestDb,
} from "./v2-db.js";

/**
 * The browse tools' results within OpenCode's output limits: every result
 * stays within 40 KiB and 1,900 lines as valid JSON, and following a trimmed
 * result's continuations to the end shows exactly what one unbounded result
 * would, each part once, in order, with no gap at any cut.
 */

beforeAll(() => setStrictNoLimitMessages(true));
afterAll(() => setStrictNoLimitMessages(false));

const gate = createFetchGate({ concurrency: 4 });
const v2Cleanups: Array<() => void> = [];
afterEach(() => {
  while (v2Cleanups.length > 0) v2Cleanups.pop()!();
});

const noYield = async (): Promise<void> => {};

// ── Running a tool ───────────────────────────────────────────────────────────

/**
 * Run a tool with raw arguments, as the host passes them, and check the
 * result's shape (see {@link parseBounded}).
 */
async function call(
  definition: ToolDefinition,
  args: Record<string, unknown>,
  ctx = makeContext().ctx,
): Promise<Out> {
  return parseBounded(
    toolResultText(await definition.execute(args as Parameters<typeof definition.execute>[0], ctx)),
  );
}

/** Every output of `recall_get` for one message, following its
 *  continuations to the end, with the parts joined. */
async function readMessage(
  tool: ToolDefinition,
  sessionID: string,
  messageID: string,
): Promise<{ outs: Out[]; joiner: PartJoiner }> {
  const outs: Out[] = [];
  const joiner = new PartJoiner();
  let cursor: string | undefined;
  for (let step = 0; step < 500; step++) {
    const out = await call(tool, { sessionID, messageID, ...(cursor && { cursor }) });
    expect(out.ok, out.error).toBe(true);
    outs.push(out);
    for (const part of out.parts as PartOutput[]) joiner.add(part);
    cursor = out.continuation;
    if (!cursor) {
      joiner.end();
      return { outs, joiner };
    }
  }
  throw new Error("recall_get continuations did not end");
}

/** Every output of a tool, following each output's continuation (or, for
 *  `recall_messages`, `pagination.nextCursor`) to the end. `between` runs
 *  after each output that has a next one. */
async function follow(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  next: (out: Out) => string | undefined = (out) => out.continuation,
  between?: (out: Out, step: number) => void,
): Promise<Out[]> {
  const outs: Out[] = [];
  let cursor: string | undefined;
  for (let step = 0; step < 500; step++) {
    const out = await call(tool, { ...args, ...(cursor && { cursor }) });
    expect(out.ok, out.error).toBe(true);
    outs.push(out);
    cursor = next(out);
    if (!cursor) return outs;
    between?.(out, step);
  }
  throw new Error("continuations did not end");
}

type Pagination = { limit: number; returned: number; hasMore: boolean; nextCursor?: string };
const nextPage = (out: Out): string | undefined => (out.pagination as Pagination).nextCursor;

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Mulberry32, so a failing seed replays. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Characters of every UTF-8 width, surrogate pairs and characters JSON
 *  escapes, so a cut's byte accounting and its pair check both matter. */
const ALPHABET = ["a", "z", " ", "é", "€", "中", "😀", "𝄞", "\n", '"', "\\", "\u0001"];

function randomText(rand: () => number, units: number): string {
  let text = "";
  while (text.length < units) text += ALPHABET[Math.floor(rand() * ALPHABET.length)]!;
  return text;
}

/** Mostly short, sometimes far over the budget on its own. */
function randomSize(rand: () => number): number {
  const r = rand();
  if (r < 0.55) return Math.floor(rand() * 200);
  if (r < 0.85) return Math.floor(rand() * 8_000);
  return 20_000 + Math.floor(rand() * 60_000);
}

function randomPart(rand: () => number, sid: string, mid: string, i: number): Part {
  const id = `p-${String(i).padStart(3, "0")}`;
  const text = (): string => randomText(rand, randomSize(rand));
  switch (Math.floor(rand() * 5)) {
    case 0:
      return textPart(id, sid, mid, text());
    case 1:
      return reasoningPart(id, sid, mid, text());
    case 2:
      return completedToolPart(id, sid, mid, "bash", { command: text(), cwd: "/w" }, text(), {
        title: text(),
      });
    case 3:
      return errorToolPart(id, sid, mid, "edit", { path: text(), lines: [1, 2] }, text());
    default:
      return runningToolPart(id, sid, mid, { command: text() });
  }
}

function addMessage(h: FakeHarness, info: Message, parts: Part[]): void {
  (h.messagesBySession[info.sessionID] ??= []).push(bundle(info, parts));
}

/** Nine alternating messages of 20 to 30 KB each in session `s-ctx`,
 *  oldest first: `m-ctx-0` to `m-ctx-8`. */
function addContextSession(h: FakeHarness): string[] {
  const sid = "s-ctx";
  const ids: string[] = [];
  for (let i = 0; i < 9; i++) {
    const mid = `m-ctx-${i}`;
    const created = 1_000_000 + i * 1_000;
    if (i % 2 === 0) {
      addMessage(h, userMessage(mid, sid, created), [
        textPart(`${mid}-p0`, sid, mid, `ask ${i} ${"€é😀 ".repeat(2_500)}`),
      ]);
    } else {
      addMessage(h, assistantMessage(mid, sid, created), [
        reasoningPart(`${mid}-p0`, sid, mid, `think ${i} ${"中a".repeat(4_000)}`),
        completedToolPart(
          `${mid}-p1`,
          sid,
          mid,
          "bash",
          { command: `step ${i}`, flags: ["-x"] },
          `out ${i} ${"line\n".repeat(2_400)}`,
          { title: `run ${i}` },
        ),
      ]);
    }
    ids.push(mid);
  }
  return ids;
}

/** `count` project sessions with ~1 KB multibyte titles, listed after the
 *  fixture's two. */
/** Child `i` of `ses_parent` in {@link parentWithChildren}. */
const child = (i: number): string => `ses_c${String(i).padStart(4, "0")}`;

/** An opencode v2 database holding `ses_parent` and `count` children of it,
 *  child `i` updated at 10,000 + i, so the newest child has the highest id
 *  and sits on the last page by id. Returns the writer connection and a
 *  source over a read-only handle. */
async function parentWithChildren(
  count: number,
): Promise<{ db: V2TestDb["db"]; source: HistorySource }> {
  const t = await makeV2Db();
  v2Cleanups.push(t.cleanup);
  insertProject(t.db, { id: "prj", worktree: "/w/app" });
  t.db.exec("BEGIN");
  insertSession(t.db, {
    id: "ses_parent",
    project_id: "prj",
    directory: "/w/app",
    time_created: 1_000,
    time_updated: 1_000,
  });
  for (let i = 0; i < count; i++) {
    insertSession(t.db, {
      id: child(i),
      project_id: "prj",
      parent_id: "ses_parent",
      directory: "/w/app",
      time_created: 1_000,
      time_updated: 10_000 + i,
    });
  }
  t.db.exec("COMMIT");
  const opened = await openOpencodeDb(t.path);
  if (!opened.ok) throw new Error(opened.reason);
  v2Cleanups.push(() => opened.db.close());
  const source = createV2HistorySource(limitSpy(opened.db), {
    yieldBetween: noYield,
    projectID: "prj",
  });
  return { db: t.db, source };
}

function addListing(h: FakeHarness, count: number): void {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const id = `s-list-${String(i).padStart(3, "0")}`;
    h.sessions.push(session(id, `Listing ${i} ${"€".repeat(300)}`, PROJECT_DIR, now - 10_000 - i));
  }
}

/** The whole-result shape of `messages` (oldest first), newest first. */
function expectedNewestFirst(h: FakeHarness, sid: string): Flat[] {
  return [...h.messagesBySession[sid]!].reverse().map((m) => flatMessage(formatMsg(m)));
}

/** An opencode 2.4 database with session `ses_cut`: a user prompt, then
 *  assistant message `msg_long` whose part rows hold `texts`. Returns a
 *  source with `opts` and one with the default ceiling. */
async function v2CutSession(
  texts: string[],
  opts: V2SourceOptions,
): Promise<{ cut: HistorySource; whole: HistorySource }> {
  const t = await makeV2PartsDb();
  v2Cleanups.push(t.cleanup);
  insertProject(t.db, { id: "prj", worktree: "/w/app" });
  insertSession(t.db, {
    id: "ses_cut",
    project_id: "prj",
    directory: "/w/app",
    time_created: 1_000,
    time_updated: 1_000,
  });
  insertMessage(t.db, {
    id: "msg_user",
    session_id: "ses_cut",
    type: "user",
    seq: 1,
    time_created: 2_001,
    data: { text: "prompt", time: { created: 0 } },
  });
  insertMessage(t.db, {
    id: "msg_long",
    session_id: "ses_cut",
    type: "assistant",
    seq: 2,
    time_created: 2_002,
    data: {
      agent: "build",
      model: { id: "m-1", providerID: "p-1" },
      content: [],
      time: { created: 0, completed: 1 },
    },
  });
  texts.forEach((text, ordinal) =>
    insertPart(t.db, {
      message_id: "msg_long",
      session_id: "ses_cut",
      ordinal,
      time_created: 2_002,
      data: { type: "text", text },
    }),
  );
  const opened = await openOpencodeDb(t.path);
  if (!opened.ok) throw new Error(opened.reason);
  v2Cleanups.push(() => opened.db.close());
  const spy = limitSpy(opened.db);
  return {
    cut: createV2HistorySource(spy, { yieldBetween: noYield, projectID: "prj", ...opts }),
    whole: createV2HistorySource(spy, { yieldBetween: noYield, projectID: "prj" }),
  };
}

/** The parts of `msg_long` as one read without a ceiling returns them. */
async function wholeParts(source: HistorySource): Promise<Flat[]> {
  const read = await source.getMessage("ses_cut", "msg_long");
  if (!read.ok) throw new Error(read.reason);
  expect(read.value.partial).toBeUndefined();
  return formatMsg(read.value).parts.map(flatPart);
}

/** Parts other than the notes a cut read ends with. */
const withoutCutNotes = (parts: Flat[]): Flat[] =>
  parts.filter((p) => !/:cut\d+$/.test(p.id as string));

// ── recall_get ───────────────────────────────────────────────────────────────

describe("recall_get over the output budget", () => {
  it("returns a message of thousands of parts across continuations, each part once and in order", async () => {
    const h = makeFakeHarness();
    const sid = "s-many";
    const parts = Array.from({ length: 3_000 }, (_, i) =>
      textPart(`p-${String(i).padStart(4, "0")}`, sid, "m-many", `step ${i} ${"·".repeat(i % 40)}`),
    );
    addMessage(h, assistantMessage("m-many", sid, 1_000), parts);

    const { outs, joiner } = await readMessage(getTool(h.source, gate), sid, "m-many");
    expect(outs.length).toBeGreaterThan(3);
    expect(joiner.parts).toEqual(formatMsg(h.messagesBySession[sid]![0]!).parts.map(flatPart));
    for (const out of outs) expect(out.message).toMatchObject({ id: "m-many", role: "assistant" });
  });

  it("cuts fields larger than the budget inside their text and resumes at the exact offset", async () => {
    // Each message's emoji run starts at a different code-unit parity, so a
    // cut lands at both halves' boundaries across them.
    const h = makeFakeHarness();
    const sid = "s-huge";
    const input = {
      command: `run ${"€".repeat(20_000)}`,
      env: { NOTE: "😀".repeat(5_000) },
      args: ["--flag", "é".repeat(3_000)],
    };
    for (const prefix of ["", "a", "ab", "abc"]) {
      const mid = `m-huge-${prefix.length}`;
      addMessage(h, assistantMessage(mid, sid, 1_000 + prefix.length), [
        textPart("p-0", sid, mid, `${prefix}${"😀".repeat(25_000)}`),
        completedToolPart("p-1", sid, mid, "bash", input, `out ${"中".repeat(40_000)}`, {
          title: `title ${"é".repeat(2_000)}`,
        }),
        errorToolPart("p-2", sid, mid, "edit", { path: "/a" }, `fail ${"x".repeat(45_000)}`),
      ]);
    }

    const tool = getTool(h.source, gate);
    for (const message of h.messagesBySession[sid]!) {
      const { joiner } = await readMessage(tool, sid, message.info.id);
      expect(joiner.parts).toEqual(formatMsg(message).parts.map(flatPart));
      for (const field of ["content", "input", "output", "error"]) {
        expect([...joiner.cutFields]).toContain(field);
      }
    }
  }, 30_000);

  it("reassembles randomly shaped messages exactly, whatever the part shapes and sizes", async () => {
    const h = makeFakeHarness();
    const tool = getTool(h.source, gate);
    const sid = "s-rand";
    const cutFields = new Set<string>();
    let trimmed = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const rand = prng(seed);
      const mid = `m-rand-${seed}`;
      const parts = Array.from({ length: 1 + Math.floor(rand() * 30) }, (_, i) =>
        randomPart(rand, sid, mid, i),
      );
      const message = bundle(assistantMessage(mid, sid, 1_000 + seed), parts);
      h.messagesBySession[sid] = [message];
      const { outs, joiner } = await readMessage(tool, sid, mid);
      expect(joiner.parts, `seed ${seed}`).toEqual(formatMsg(message).parts.map(flatPart));
      trimmed += outs.filter((out) => out.trimmed).length;
      for (const field of joiner.cutFields) cutFields.add(field);
    }
    // The seeds exercise cuts, and cuts inside each of the large fields.
    expect(trimmed).toBeGreaterThan(20);
    for (const field of ["content", "input", "output"]) expect([...cutFields]).toContain(field);
  }, 30_000);

  it("rejects a continuation for another message or one whose part is gone", async () => {
    const h = makeFakeHarness();
    const tool = getTool(h.source, gate);
    const other = encodeContinuation("recall_get", { m: "m-current-2" });
    expect(
      await call(tool, { sessionID: "s-current", messageID: "m-current-3", cursor: other }),
    ).toEqual({ ok: false, error: expect.stringContaining("m-current-2") });
    const stale = [
      encodeContinuation("recall_get", { m: "m-current-3", part: "p-gone" }),
      encodeContinuation("recall_get", {
        m: "m-current-3",
        part: "p-current-3",
        field: "output",
        offset: 1_000_000,
      }),
    ];
    for (const cursor of stale) {
      const out = await call(tool, { sessionID: "s-current", messageID: "m-current-3", cursor });
      expect(out).toEqual({ ok: false, error: expect.stringContaining("no longer in message") });
    }
  });

  it("reports a continuation into a message's part rows as unsupported on v1", async () => {
    const h = makeFakeHarness();
    const cursor = encodeContinuation("recall_get", { m: "m-current-3", ordinal: 2 });
    const out = await call(getTool(h.source, gate), {
      sessionID: "s-current",
      messageID: "m-current-3",
      cursor,
    });
    expect(out).toEqual({ ok: false, error: expect.stringContaining("no part ordinals") });
  });
});

describe("a message the history read cut short (v2)", () => {
  it("marks recall_get trimmed even when its output fits, and its continuation reads the rest", async () => {
    // Six ~405-byte part rows: a 1,500-byte read holds three.
    const texts = Array.from({ length: 6 }, (_, i) => `${i}`.repeat(380));
    const { cut, whole } = await v2CutSession(texts, { pageByteCeiling: 1_500 });
    const read = await cut.getMessage("ses_cut", "msg_long");
    if (!read.ok || !read.value.partial) throw new Error("the read was not cut");
    const { omittedParts, omittedBytes } = read.value.partial;

    const { outs, joiner } = await readMessage(getTool(cut, gate), "ses_cut", "msg_long");
    expect(outs[0]).toMatchObject({
      trimmed: true,
      continuation: expect.any(String),
      partial: { omittedParts, omittedBytes },
    });
    const last = outs.at(-1)!;
    expect(last.trimmed).toBeUndefined();
    expect(last.partial).toBeUndefined();
    expect(withoutCutNotes(joiner.parts)).toEqual(await wholeParts(whole));
  }, 30_000);

  it("follows its own continuations inside each read and the read's between them", async () => {
    // Six ~55 KB part rows: each 120,000-byte read holds two, and each read
    // is over the output budget on its own.
    const texts = Array.from({ length: 6 }, (_, i) => `${i} ${"abc€😀 ".repeat(5_000)}`);
    const { cut, whole } = await v2CutSession(texts, { pageByteCeiling: 120_000 });
    const { outs, joiner } = await readMessage(getTool(cut, gate), "ses_cut", "msg_long");
    // Three reads, each over the budget: more outputs than reads.
    expect(joiner.parts.filter((p) => /:cut\d+$/.test(p.id as string))).toHaveLength(2);
    expect(outs.length).toBeGreaterThan(3);
    expect(withoutCutNotes(joiner.parts)).toEqual(await wholeParts(whole));
  }, 30_000);

  it("gives a cut message listed by recall_messages or recall_context the cursor recall_get reads the rest with", async () => {
    const texts = Array.from({ length: 6 }, (_, i) => `${i}`.repeat(380));
    const { cut, whole } = await v2CutSession(texts, { pageByteCeiling: 1_500 });
    const expected = await wholeParts(whole);
    const listed = [
      (await call(messagesTool(cut, gate, TEST_LIMITS), { sessionID: "ses_cut", limit: 10 }))
        .messages as MessageItem[],
      (
        await call(contextTool(cut, gate, TEST_LIMITS), {
          sessionID: "ses_cut",
          messageID: "msg_long",
          window: 1,
        })
      ).messages as MessageItem[],
    ];
    for (const items of listed) {
      const item = items.find((m) => m.message.id === "msg_long")!;
      expect(item.partial).toEqual({
        omittedParts: 3,
        omittedBytes: expect.any(Number),
        cursor: expect.any(String),
      });
      const rest = await call(getTool(cut, gate), {
        sessionID: "ses_cut",
        messageID: "msg_long",
        cursor: item.partial!.cursor,
      });
      expect(rest.trimmed).toBeUndefined();
      expect((rest.parts as PartOutput[]).map(flatPart)).toEqual(expected.slice(3));
    }
  }, 30_000);
});

// ── recall_context ───────────────────────────────────────────────────────────

describe("recall_context over the output budget", () => {
  it("returns the whole window across continuations, each message and part once", async () => {
    const h = makeFakeHarness();
    const ids = addContextSession(h);
    const outs = await follow(contextTool(h.source, gate, TEST_LIMITS), {
      sessionID: "s-ctx",
      messageID: "m-ctx-4",
      window: 3,
    });
    expect(outs.length).toBeGreaterThan(2);
    const joiner = new MessageJoiner();
    for (const out of outs) {
      joiner.add(out.messages as MessageItem[]);
      expect(out).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });
    }
    const window = h.messagesBySession["s-ctx"]!.slice(1, 8);
    expect(joiner.cutFields().size).toBeGreaterThan(0);
    expect(joiner.messages()).toEqual(
      window.map((m) => flatMessage({ ...formatMsg(m), center: m.info.id === ids[4] })),
    );
  });

  it("rejects a continuation for another center message, or one whose message left the window", async () => {
    const h = makeFakeHarness();
    addContextSession(h);
    const tool = contextTool(h.source, gate, TEST_LIMITS);
    const args = { sessionID: "s-ctx", messageID: "m-ctx-4", window: 3 };
    const first = await call(tool, args);
    const second = await call(tool, { ...args, cursor: first.continuation });
    // The first output stops before the center, so the continuation resumes
    // at a message a window of 0 leaves out.
    expect((second.messages as MessageItem[])[0]!.message.id).not.toBe("m-ctx-4");

    expect(await call(tool, { ...args, messageID: "m-ctx-5", cursor: first.continuation })).toEqual(
      { ok: false, error: expect.stringContaining("m-ctx-4") },
    );
    expect(await call(tool, { ...args, window: 0, cursor: first.continuation })).toEqual({
      ok: false,
      error: expect.stringContaining("no longer in the window"),
    });
  });
});

// ── recall_messages ──────────────────────────────────────────────────────────

describe("recall_messages over the output budget", () => {
  it("browses a whole session through trimmed pages, each message and part once, newest first", async () => {
    const h = makeFakeHarness();
    addContextSession(h);
    const outs = await follow(
      messagesTool(h.source, gate, TEST_LIMITS),
      { sessionID: "s-ctx", limit: 4 },
      nextPage,
    );
    const joiner = new MessageJoiner();
    for (const out of outs) {
      const items = out.messages as MessageItem[];
      joiner.add(items);
      const pagination = out.pagination as Pagination;
      expect(pagination.returned).toBe(items.length);
      if (out.trimmed) {
        expect(pagination).toMatchObject({ hasMore: true, nextCursor: out.continuation });
      }
    }
    expect(outs.filter((out) => out.trimmed).length).toBeGreaterThan(2);
    expect(joiner.cutFields().size).toBeGreaterThan(0);
    expect(joiner.messages()).toEqual(expectedNewestFirst(h, "s-ctx"));
  });

  it.each(["user", "assistant"] as const)(
    "browses only %s messages through trimmed pages when a role filter is set",
    async (role) => {
      const h = makeFakeHarness();
      addContextSession(h);
      const outs = await follow(
        messagesTool(h.source, gate, TEST_LIMITS),
        { sessionID: "s-ctx", limit: 4, role },
        nextPage,
      );
      const joiner = new MessageJoiner();
      for (const out of outs) joiner.add(out.messages as MessageItem[]);
      expect(outs.some((out) => out.trimmed)).toBe(true);
      expect(joiner.messages()).toEqual(
        expectedNewestFirst(h, "s-ctx").filter(
          (m) => (m.message as { role: string }).role === role,
        ),
      );
    },
  );

  it.each([3, 12])(
    "resumes at the same message when %i newer messages arrive between calls",
    async (arrivals) => {
      // Thirty ~6 KB messages: a 10-message page is cut about two thirds in.
      // The fake's page cursors count positions from the newest message, so
      // arrivals shift every page, and 12 move the resume point onto the
      // page after the newest.
      const h = makeFakeHarness();
      const sid = "s-flow";
      for (let i = 0; i < 30; i++) {
        const mid = `m-flow-${String(i).padStart(2, "0")}`;
        addMessage(h, assistantMessage(mid, sid, 1_000_000 + i * 1_000), [
          textPart(`${mid}-p0`, sid, mid, `${i} ${"flow€ ".repeat(1_000)}`),
        ]);
      }
      const expected = expectedNewestFirst(h, sid);
      const outs = await follow(
        messagesTool(h.source, gate, TEST_LIMITS),
        { sessionID: sid, limit: 10 },
        nextPage,
        (out, step) => {
          if (step !== 0) return;
          expect(out.trimmed).toBe(true);
          for (let k = 0; k < arrivals; k++) {
            const mid = `m-new-${String(k).padStart(2, "0")}`;
            addMessage(h, assistantMessage(mid, sid, 2_000_000 + k), [
              textPart(`${mid}-p0`, sid, mid, `new ${k}`),
            ]);
          }
        },
      );
      const joiner = new MessageJoiner();
      for (const out of outs) joiner.add(out.messages as MessageItem[]);
      expect(joiner.messages()).toEqual(expected);
    },
  );

  it("fails a continuation whose message is gone, rather than skipping or repeating", async () => {
    const h = makeFakeHarness();
    addContextSession(h);
    const tool = messagesTool(h.source, gate, TEST_LIMITS);
    const first = await call(tool, { sessionID: "s-ctx", limit: 4 });
    h.messagesBySession["s-ctx"] = [
      bundle(userMessage("m-fresh", "s-ctx", 5_000_000), [
        textPart("m-fresh-p0", "s-ctx", "m-fresh", "a fresh start"),
      ]),
    ];
    expect(await call(tool, { sessionID: "s-ctx", limit: 4, cursor: first.continuation })).toEqual({
      ok: false,
      error: expect.stringContaining("no longer where it was"),
    });
  });

  it("still takes a history source's own page cursor, and answers with its own", async () => {
    const h = makeFakeHarness();
    const tool = messagesTool(h.source, gate, TEST_LIMITS);
    const plain = (await h.source.messagePage({ sessionID: "s-current", limit: 2 })).nextCursor;
    expect(plain).toEqual(expect.any(String));
    const page = await call(tool, { sessionID: "s-current", limit: 2, cursor: plain });
    expect((page.messages as MessageItem[]).map((m) => m.message.id)).toEqual([
      "m-current-4",
      "m-current-3",
    ]);
    const next = (page.pagination as Pagination).nextCursor!;
    expect(next.startsWith("rc.")).toBe(true);
    const after = await call(tool, { sessionID: "s-current", limit: 2, cursor: next });
    expect((after.messages as MessageItem[]).map((m) => m.message.id)).toEqual([
      "m-current-2",
      "m-current-1",
    ]);
  });

  it("rejects a continuation for another session", async () => {
    const h = makeFakeHarness();
    addContextSession(h);
    const tool = messagesTool(h.source, gate, TEST_LIMITS);
    const first = await call(tool, { sessionID: "s-ctx", limit: 4 });
    expect(
      await call(tool, { sessionID: "s-current", limit: 4, cursor: first.continuation }),
    ).toEqual({ ok: false, error: expect.stringContaining("s-ctx") });
  });
});

// ── recall_sessions ──────────────────────────────────────────────────────────

describe("recall_sessions over the output budget", () => {
  it("returns a listing over the budget across continuations, each session once and in order", async () => {
    const h = makeFakeHarness();
    addListing(h, 120);
    const outs = await follow(sessionsTool(h.source, true, TEST_LIMITS), { limit: 100 });
    expect(outs.length).toBeGreaterThan(1);
    const ids: string[] = [];
    for (const out of outs) {
      const listed = out.sessions as Array<{ id: string }>;
      expect(out).toMatchObject({ scope: "project", returned: listed.length });
      ids.push(...listed.map((s) => s.id));
    }
    expect(ids).toEqual(h.sessions.slice(0, 100).map((s) => s.id));
  });

  it("rejects a continuation whose session is not in the listing", async () => {
    const h = makeFakeHarness();
    addListing(h, 120);
    const tool = sessionsTool(h.source, true, TEST_LIMITS);
    const first = await call(tool, { limit: 100 });
    expect(
      await call(tool, { limit: 100, search: "Checkout", cursor: first.continuation }),
    ).toEqual({ ok: false, error: expect.stringContaining("no longer in this listing") });
  });

  it("is an error with trimmed when the first session alone is over the budget", async () => {
    const h = makeFakeHarness();
    h.sessions.unshift(session("s-vast", "t".repeat(50_000), PROJECT_DIR, Date.now()));
    expect(await call(sessionsTool(h.source, true, TEST_LIMITS), {})).toEqual({
      ok: false,
      trimmed: true,
      error: expect.any(String),
    });
  });

  it("lists a parent's children past the first thousand, so the newest child is found", async () => {
    const { source } = await parentWithChildren(2_500);

    const out = await call(sessionsTool(source, true, TEST_LIMITS), {
      parentID: "ses_parent",
      limit: 3,
    });
    // More pages follow, but every child was read: no read-cap note.
    expect(out).toMatchObject({ ok: true, scope: "children", childCount: 2_500, returned: 3 });
    expect(out.truncated).toBe(true);
    expect(out.note).toBeUndefined();
    expect((out.sessions as Array<{ id: string }>).map((s) => s.id)).toEqual([
      child(2_499),
      child(2_498),
      child(2_497),
    ]);
  }, 30_000);

  it("reports truncated when a parent has more children than one call reads", async () => {
    // A parent whose id-ordered listing never ends.
    const child = (i: number): string => `ses_k${String(i).padStart(6, "0")}`;
    const endless: HistorySource = {
      kind: "v2-sqlite",
      scopedLookup: false,
      listSessions: async () => ({ ok: true, items: [], truncated: false }),
      getSession: async () => ({ ok: false, reason: "not-found" }),
      async listChildren(parentID, o = {}) {
        const start = o.after === undefined ? 0 : Number(o.after.slice("ses_k".length)) + 1;
        const items = Array.from({ length: o.limit ?? 1_000 }, (_, k) =>
          session(
            child(start + k),
            `child ${start + k}`,
            PROJECT_DIR,
            10_000 + start + k,
            undefined,
            parentID,
          ),
        );
        return { ok: true, items, truncated: true, nextCursor: items.at(-1)!.id };
      },
      messagePage: async () => ({ items: [], nextCursor: null }),
      getMessage: async () => ({ ok: false, reason: "not-found" }),
    };
    const out = await call(sessionsTool(endless, true, TEST_LIMITS), {
      parentID: "ses_parent",
      limit: 2,
    });
    expect(out).toMatchObject({
      ok: true,
      truncated: true,
      note: expect.stringContaining("more than"),
    });
    const read = out.childCount as number;
    expect(read).toBeGreaterThan(1_000);
    // The newest child read is the last one read: the listing paged on
    // rather than re-reading its first page.
    expect((out.sessions as Array<{ id: string }>).map((s) => s.id)).toEqual([
      child(read - 1),
      child(read - 2),
    ]);
  });
});

describe("recall_sessions pages past limit", () => {
  const ARGS = { parentID: "ses_parent", limit: 100 };
  const nextCursor = (out: Out): string | undefined => out.nextCursor as string | undefined;

  it("pages through all 2,500 children of a parent, 100 at a time, each once and in order", async () => {
    const { source } = await parentWithChildren(2_500);
    const pages = await follow(sessionsTool(source, true, TEST_LIMITS), ARGS, nextCursor);
    expect(pages).toHaveLength(25);
    const ids: string[] = [];
    pages.forEach((out, i) => {
      const listed = (out.sessions as Array<{ id: string }>).map((s) => s.id);
      expect(out).toMatchObject({ scope: "children", childCount: 2_500, returned: 100 });
      expect(out.trimmed).toBeUndefined();
      // Every page but the last says more children follow.
      expect(out.truncated, `page ${i}`).toBe(i < 24 ? true : undefined);
      ids.push(...listed);
    });
    // Newest first, from child 2,499 down to child 0.
    expect(ids).toEqual(Array.from({ length: 2_500 }, (_, k) => child(2_499 - k)));
  }, 60_000);

  it("refuses the next page when a child not yet shown was updated in between", async () => {
    const { db, source } = await parentWithChildren(2_500);
    const tool = sessionsTool(source, true, TEST_LIMITS);
    const first = await call(tool, ARGS);
    expect(first.nextCursor).toEqual(expect.any(String));
    // Child 5 becomes the newest, so it moves ahead of the next page's
    // first child, into the part of the listing already shown.
    db.run("UPDATE session_v2 SET time_updated = ? WHERE id = ?", [99_999, child(5)]);
    expect(await call(tool, { ...ARGS, cursor: first.nextCursor })).toEqual({
      ok: false,
      error: expect.stringContaining("This listing changed"),
    });
  }, 60_000);

  it("resumes a trimmed page up to its own end, so every page holds limit sessions", async () => {
    const h = makeFakeHarness();
    addListing(h, 170);
    const outs = await follow(sessionsTool(h.source, true, TEST_LIMITS), { limit: 60 }, nextCursor);
    // The outputs up to and including the first one not trimmed make a page.
    const pages: Out[][] = [];
    let page: Out[] = [];
    for (const out of outs) {
      // A trimmed output's next cursor is its continuation.
      if (out.trimmed) expect(out.nextCursor).toBe(out.continuation);
      page.push(out);
      if (!out.trimmed) {
        pages.push(page);
        page = [];
      }
    }
    expect(page).toEqual([]);
    const ids = (group: Out[]): string[] =>
      group.flatMap((out) => (out.sessions as Array<{ id: string }>).map((s) => s.id));
    // 172 sessions (the fixture's two and 170 more): two full pages and the rest.
    expect(pages.map((p) => ids(p).length)).toEqual([60, 60, 52]);
    // Every page was over the budget, so each was trimmed and resumed.
    expect(pages.every((p) => p.length > 1)).toBe(true);
    expect(pages.flat().map((out) => out.truncated)).toEqual(
      pages.flatMap((p, i) => p.map(() => (i < pages.length - 1 ? true : undefined))),
    );
    expect(ids(outs)).toEqual(h.sessions.map((s) => s.id));
  });
});

// ── Continuations across tools ───────────────────────────────────────────────

describe("continuations", () => {
  /** A harness and every browse tool over it, with a trimmed continuation
   *  from each. */
  async function tokens() {
    const h = makeFakeHarness();
    addContextSession(h);
    addListing(h, 120);
    addMessage(h, assistantMessage("m-vast", "s-ctx", 9_000_000), [
      textPart("m-vast-p0", "s-ctx", "m-vast", "v".repeat(100_000)),
    ]);
    const tools = {
      recall_get: {
        tool: getTool(h.source, gate),
        args: { sessionID: "s-ctx", messageID: "m-vast" },
      },
      recall_context: {
        tool: contextTool(h.source, gate, TEST_LIMITS),
        args: { sessionID: "s-ctx", messageID: "m-ctx-4", window: 3 },
      },
      recall_messages: {
        tool: messagesTool(h.source, gate, TEST_LIMITS),
        args: { sessionID: "s-ctx", limit: 4 },
      },
      recall_sessions: { tool: sessionsTool(h.source, true, TEST_LIMITS), args: { limit: 100 } },
    };
    const issued: Record<string, string> = {};
    for (const [name, { tool, args }] of Object.entries(tools)) {
      const out = await call(tool, args);
      expect(out.trimmed, name).toBe(true);
      issued[name] = out.continuation!;
    }
    return { tools, issued };
  }

  it("name the tool they continue, and every other tool rejects them", async () => {
    const { tools, issued } = await tokens();
    for (const [name, token] of Object.entries(issued)) {
      expect(token.startsWith("rc.")).toBe(true);
      const payload = JSON.parse(Buffer.from(token.slice(3), "base64url").toString("utf8")) as {
        k: unknown;
      };
      expect(payload.k).toBe(name);
    }
    for (const [name, { tool, args }] of Object.entries(tools)) {
      for (const [issuer, token] of Object.entries(issued)) {
        if (issuer === name) continue;
        expect(await call(tool, { ...args, cursor: token }), `${issuer} → ${name}`).toEqual({
          ok: false,
          error: `This cursor continues ${issuer}, not ${name}`,
        });
      }
    }
  });

  it("reject malformed tokens as invalid", async () => {
    const { tools } = await tokens();
    const raw = (text: string): string => `rc.${Buffer.from(text).toString("base64url")}`;
    const broken = [
      "rc.",
      "rc.***",
      raw("not json"),
      raw("[1,2]"),
      raw('{"v":2,"k":"recall_get","m":"m-vast"}'),
      raw('{"v":1,"m":"m-vast"}'),
    ];
    // Well-formed tokens of the right tool whose fields are not a position.
    const badFields: Record<string, Array<Record<string, string | number | null>>> = {
      recall_get: [
        {},
        { m: "m-vast", ordinal: -1 },
        { m: "m-vast", ordinal: 1.5 },
        { m: "m-vast", part: "" },
        { m: "m-vast", part: "m-vast-p0", field: "bogus", offset: 1 },
        { m: "m-vast", part: "m-vast-p0", field: "content" },
        { m: "m-vast", offset: 3 },
      ],
      recall_context: [
        { anchorId: "m-ctx-3" },
        { c: "m-ctx-4" },
        { c: "m-ctx-4", anchorId: "m-ctx-3", field: "content", offset: 1 },
      ],
      recall_messages: [
        { page: null },
        { s: "s-ctx" },
        { s: "s-ctx", page: 5 },
        { s: "s-ctx", page: null, part: "m-ctx-8-p0" },
      ],
      recall_sessions: [
        {},
        { anchorId: "" },
        { anchorId: 5 },
        // A position without the count of sessions its rest covers, or with
        // none of them, or that resumes a trimmed page with none of it left.
        { anchorId: "s-list-050", n: 52, h: "ids", t: "rest" },
        { anchorId: "s-list-050", n: 52, h: "ids", t: "rest", r: 0 },
        { anchorId: "s-list-050", n: 52, h: "ids", t: "rest", r: 1, l: 0 },
      ],
    };
    for (const [name, { tool, args }] of Object.entries(tools)) {
      const cursors = [
        ...broken,
        ...badFields[name]!.map((fields) => encodeContinuation(name, fields)),
      ];
      for (const cursor of cursors) {
        const out = await call(tool, { ...args, cursor });
        expect(out, `${name} ${cursor}`).toEqual({
          ok: false,
          error: expect.stringMatching(/^Invalid cursor/),
        });
      }
    }
  });
});
