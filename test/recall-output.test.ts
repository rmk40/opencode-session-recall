import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, Part } from "@opencode-ai/sdk/v2";
import { search } from "../src/search.js";
import { get as getTool } from "../src/get.js";
import { formatMsg } from "../src/extract.js";
import { createCardsRuntime } from "../src/cards.js";
import { createDrill } from "../src/drill.js";
import { createFetchGate } from "../src/fetch-gate.js";
import { encodeContinuation, type OutputBudget } from "../src/output.js";
import { createV2HistorySource, openOpencodeDb } from "../src/history/v2.js";
import type { HistorySource } from "../src/history/source.js";
import type { ToolDefinition } from "../src/host/opencode-v1-types.js";
import type { ExpandedResult, Limits, PartOutput, SearchResult } from "../src/types.js";
import {
  MessageJoiner,
  flatMessage,
  flatPart,
  parseBounded,
  roundTrip,
  type Flat,
  type Out,
} from "./output-join.js";
import {
  PROJECT_DIR,
  TEST_LIMITS,
  assistantMessage,
  bundle,
  completedToolPart,
  globalSessionFrom,
  makeContext,
  makeRecallDeps,
  makeFakeHarness,
  seedStore,
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
  makeV2PartsDb,
} from "./v2-db.js";

/**
 * `recall`'s output within OpenCode's limits: every output is valid JSON
 * within 40 KiB and 1,900 lines with its header first and the results before
 * the expansions, and following a trimmed output's continuations to the end
 * shows exactly what one unbounded output would, each record once, with no
 * gap at any cut. A continuation that no longer matches its search is refused.
 */

// The unbounded reference output: the same search serialized without the
// output budget, so a joined run of trimmed outputs has an exact oracle.
const budget = vi.hoisted(() => ({ override: undefined as OutputBudget | undefined }));
vi.mock("../src/output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/output.js")>();
  const writeOutput = ((spec) =>
    actual.writeOutput(
      budget.override ? { ...spec, budget: budget.override } : spec,
    )) as typeof actual.writeOutput;
  return { ...actual, writeOutput };
});

beforeAll(() => setStrictNoLimitMessages(true));
afterAll(() => setStrictNoLimitMessages(false));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  budget.override = undefined;
  vi.restoreAllMocks();
});

const NOW = Date.now();

// ── Running recall ───────────────────────────────────────────────────────────

async function recallOver(
  h: FakeHarness,
  limits: Limits = TEST_LIMITS,
  opts: Parameters<typeof makeRecallDeps>[2] = {},
) {
  const { deps, store, cleanup } = await makeRecallDeps(h, limits, opts);
  cleanups.push(cleanup);
  return { tool: search(h.source, true, limits, deps), store };
}

/** Run `recall` with raw arguments and check the output's shape: within the
 *  budget, the header on the first line, and the results before the
 *  expansions, each record on a line of its own. */
async function call(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  ctx = makeContext().ctx,
): Promise<Out> {
  const text = toolResultText(await tool.execute(args as never, ctx));
  const out = parseBounded(text, ["results", "expanded"]);
  if (out.ok) {
    const lines = text.split("\n");
    expect(lines[0]!.startsWith('{"ok":true')).toBe(true);
    const results = lines.findIndex((line) => line.startsWith('"results":'));
    const expanded = lines.findIndex((line) => line.startsWith('"expanded":'));
    expect(results).toBeGreaterThan(0);
    if (out.expanded !== undefined) expect(expanded).toBeGreaterThan(results);
  }
  return out;
}

/** The same search's output without the output budget. */
async function unbounded(tool: ToolDefinition, args: Record<string, unknown>): Promise<Out> {
  budget.override = { bytes: 1e9, lines: 1e9 };
  try {
    const out = JSON.parse(toolResultText(await tool.execute(args as never, makeContext().ctx)));
    expect(out.ok, out.error).toBe(true);
    expect(out.trimmed).toBeUndefined();
    return out as Out;
  } finally {
    budget.override = undefined;
  }
}

/** Every output of a search, following each continuation to the end.
 *  `between` runs after each output that has a next one. */
async function follow(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  between?: (out: Out, step: number) => void,
): Promise<Out[]> {
  const outs: Out[] = [];
  let cursor: string | undefined;
  for (let step = 0; step < 100; step++) {
    const out = await call(tool, { ...args, ...(cursor && { cursor }) });
    expect(out.ok, out.error).toBe(true);
    outs.push(out);
    cursor = out.continuation;
    if (!cursor) return outs;
    between?.(out, step);
  }
  throw new Error("continuations did not end");
}

// ── Joining trimmed outputs ──────────────────────────────────────────────────

const resultsOf = (out: Out): SearchResult[] => (out.results as SearchResult[] | undefined) ?? [];
const expandedOf = (out: Out): ExpandedResult[] =>
  (out.expanded as ExpandedResult[] | undefined) ?? [];

/** An expansion as one whole output shows it, its parts flattened. */
function flatExpansion(record: ExpandedResult): Flat {
  const { message, messages, ...envelope } = roundTrip(record);
  return message
    ? { ...envelope, message: flatMessage(message) }
    : { ...envelope, messages: (messages ?? []).map(flatMessage) };
}

/**
 * The expansions of consecutive outputs joined back together. Pieces of one
 * expansion (one per result) must be adjacent and agree on everything but
 * their messages, whose pieces the message joiner puts back together.
 */
function joinExpansions(outs: readonly Out[]): { expansions: Flat[]; cutFields: Set<string> } {
  type Entry = { resultIndex: number; envelope: Flat; joiner: MessageJoiner; single: boolean };
  const entries: Entry[] = [];
  for (const out of outs) {
    for (const record of expandedOf(out)) {
      const { message, messages, ...envelope } = record;
      let entry = entries.at(-1);
      if (entry?.resultIndex === record.resultIndex) {
        expect(envelope).toEqual(entry.envelope);
      } else {
        expect(
          entries.map((e) => e.resultIndex),
          `expansion of result ${record.resultIndex} shown twice`,
        ).not.toContain(record.resultIndex);
        entry = {
          resultIndex: record.resultIndex,
          envelope,
          joiner: new MessageJoiner(),
          single: message !== undefined,
        };
        entries.push(entry);
      }
      entry.joiner.add(message ? [message] : (messages ?? []));
    }
  }
  const cutFields = new Set(entries.flatMap((e) => [...e.joiner.cutFields()]));
  const expansions = entries.map((e) => {
    const joined = e.joiner.messages();
    return e.single ? { ...e.envelope, message: joined[0] } : { ...e.envelope, messages: joined };
  });
  return { expansions, cutFields };
}

/** Whether some output resumed an expansion inside one of its parts. */
const resumedInsidePart = (outs: readonly Out[]): boolean =>
  outs.some((out) =>
    expandedOf(out).some((record) =>
      [...(record.message ? [record.message] : []), ...(record.messages ?? [])].some((item) =>
        item.parts.some((part: PartOutput) => part.resumedAt !== undefined),
      ),
    ),
  );

// ── Fixtures ─────────────────────────────────────────────────────────────────

function addSession(
  h: FakeHarness,
  s: ReturnType<typeof session>,
  messages: Array<{ info: Message; parts: Part[] }>,
): void {
  h.sessions.push(s);
  h.globalSessions.push(globalSessionFrom(s));
  h.messagesBySession[s.id] = messages;
}

/** About `units` UTF-16 code units of text of every UTF-8 width, a surrogate
 *  pair among them, so a cut's byte accounting and its pair check both
 *  matter. */
const blob = (units: number): string => "€é中😀a".repeat(Math.ceil(units / 6));

/**
 * `sessions` project sessions, `s-bulk-0` newest, each of eight messages
 * that mention `bulkneedle` among multibyte text: user asks, and assistant
 * answers with four text parts and a bash call, over 40 KiB in all, so an
 * expansion of one answer is cut inside a part.
 */
function addBulk(h: FakeHarness, sessions = 5, newest = NOW - 10_000): string[] {
  const ids: string[] = [];
  for (let s = 0; s < sessions; s++) {
    const sid = `s-bulk-${s}`;
    const updated = newest - s * 10_000;
    const messages: Array<{ info: Message; parts: Part[] }> = [];
    for (let i = 0; i < 8; i++) {
      const mid = `${sid}-m${i}`;
      const created = updated - 9_000 + i * 1_000;
      if (i % 2 === 0) {
        messages.push(
          bundle(userMessage(mid, sid, created), [
            textPart(`${mid}-p0`, sid, mid, `ask ${i} ${blob(1_500)} bulkneedle ${blob(1_500)}`),
          ]),
        );
      } else {
        messages.push(
          bundle(assistantMessage(mid, sid, created), [
            ...[0, 1, 2, 3].map((k) =>
              textPart(`${mid}-p${k}`, sid, mid, `answer ${i}.${k} bulkneedle ${blob(3_700)}`),
            ),
            completedToolPart(
              `${mid}-p4`,
              sid,
              mid,
              "bash",
              { command: `bulkneedle run ${i} ${"€".repeat(1_200)}` },
              `out ${i} ${"中😀".repeat(1_300)}`,
              { title: `step ${i}` },
            ),
          ]),
        );
      }
    }
    addSession(h, session(sid, `Bulk ${s}`, PROJECT_DIR, updated), messages);
    ids.push(sid);
  }
  return ids;
}

// ── Round trips ──────────────────────────────────────────────────────────────

// The fixtures are large, so a loaded machine needs more than the default.
describe("recall output over the budget", { timeout: 30_000 }, () => {
  it("returns every result across continuations when the results alone are over the budget", async () => {
    const h = makeFakeHarness();
    addBulk(h);
    const { tool } = await recallOver(h);
    const args = { query: "bulkneedle", scope: "project", results: 50, width: 1_000 };

    const outs = await follow(tool, args);
    const reference = await unbounded(tool, args);
    expect(resultsOf(reference)).toHaveLength(50);
    expect(outs.length).toBeGreaterThan(2);
    for (const out of outs.slice(0, -1)) expect(out.trimmed).toBe(true);
    expect(outs.at(-1)!.trimmed).toBeUndefined();
    expect(outs.flatMap(resultsOf)).toEqual(resultsOf(reference));
    // `truncated` (more results exist) is the search's, on every output.
    for (const out of outs) expect(out.truncated).toBe(reference.truncated);
  });

  it.each(["message", "context"] as const)(
    "resumes %s expansions cut inside a part after the results, each record once",
    async (expand) => {
      const h = makeFakeHarness();
      addBulk(h);
      const { tool } = await recallOver(h);
      const args = {
        query: "bulkneedle",
        scope: "project",
        results: 20,
        width: 1_000,
        expand,
        expandResults: 3,
        window: 1,
      };

      const outs = await follow(tool, args);
      const reference = await unbounded(tool, args);
      expect(expandedOf(reference)).toHaveLength(3);
      expect(outs.flatMap(resultsOf)).toEqual(resultsOf(reference));
      const { expansions, cutFields } = joinExpansions(outs);
      expect(expansions).toEqual(expandedOf(reference).map(flatExpansion));
      // Some output stopped inside an expansion's part and the next resumed it.
      expect(cutFields.size).toBeGreaterThan(0);
      expect(resumedInsidePart(outs)).toBe(true);
      // Every result is shown before the first expansion.
      const firstExpanded = outs.findIndex((out) => expandedOf(out).length > 0);
      expect(outs.slice(firstExpanded + 1).every((out) => resultsOf(out).length === 0)).toBe(true);
    },
  );

  it("trims the expansions first, showing every result in the first output", async () => {
    const h = makeFakeHarness();
    addBulk(h);
    const { tool } = await recallOver(h);
    const args = {
      query: "bulkneedle",
      scope: "project",
      results: 5,
      expand: "message",
      expandResults: 3,
    };

    const outs = await follow(tool, args);
    const reference = await unbounded(tool, args);
    expect(outs.length).toBeGreaterThan(1);
    expect(resultsOf(outs[0]!)).toEqual(resultsOf(reference));
    for (const out of outs.slice(1)) expect(resultsOf(out)).toEqual([]);
    expect(joinExpansions(outs).expansions).toEqual(expandedOf(reference).map(flatExpansion));
  });

  it("resumes with the time bounds its search resolved, so a relative bound does not move", async () => {
    // Every match sits just inside `last: "2h"` at the first call; five
    // minutes later the same bound, resolved again, would exclude them all.
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const h = makeFakeHarness();
    addBulk(h, 3, NOW - 2 * 3_600_000 + 60_000);
    const { tool } = await recallOver(h);
    const args = { query: "bulkneedle", scope: "project", results: 50, width: 1_000, last: "2h" };
    const reference = await unbounded(tool, args);
    expect(resultsOf(reference).length).toBeGreaterThan(20);

    const outs = await follow(tool, args, () => {
      clock = NOW + 5 * 60_000;
    });
    expect(outs.length).toBeGreaterThan(1);
    expect(outs.flatMap(resultsOf)).toEqual(resultsOf(reference));
    // A fresh search at the later time finds none of them.
    expect(resultsOf(await call(tool, args))).toEqual([]);
  });

  it("keeps a deep sweep's nextCursor apart from the continuation of its output", async () => {
    // Each session retains about 90,000 chars, so the sweep covers two of the
    // five and stops with a nextCursor; its 48 wide results span outputs.
    const h = makeFakeHarness();
    const ids = addBulk(h);
    const limits: Limits = { ...TEST_LIMITS, deepCharsPerQuery: 150_000 };
    const { tool } = await recallOver(h, limits);
    const args = { query: "bulkneedle", deep: true, sessions: ids, results: 50, width: 1_000 };

    const outs = await follow(tool, args);
    const reference = await unbounded(tool, args);
    const nextCursor = reference.nextCursor as string;
    expect(nextCursor).toEqual(expect.any(String));
    expect(outs.length).toBeGreaterThan(1);
    // Each output is the same sweep's, so each carries its nextCursor.
    for (const out of outs) expect(out.nextCursor).toBe(nextCursor);
    expect(outs.flatMap(resultsOf)).toEqual(resultsOf(reference));
    const swept = new Set(resultsOf(reference).map((r) => r.sessionID));
    expect([...swept].sort()).toEqual(["s-bulk-0", "s-bulk-1"]);

    // The output's continuation belongs to the sweep that made it: beside
    // the sweep's cursor it continues another search.
    expect(
      await call(tool, {
        query: "bulkneedle",
        deepCursor: nextCursor,
        results: 50,
        width: 1_000,
        cursor: outs[0]!.continuation,
      }),
    ).toEqual({ ok: false, error: expect.stringContaining("continues a different search") });

    // nextCursor, passed as deepCursor without cursor, continues the sweep.
    const resumed = await follow(tool, {
      query: "bulkneedle",
      deepCursor: nextCursor,
      results: 50,
      width: 1_000,
    });
    const later = new Set(resumed.flatMap(resultsOf).map((r) => r.sessionID));
    expect(later.has("s-bulk-0")).toBe(false);
    expect(later.has("s-bulk-1")).toBe(false);
    expect(later.has("s-bulk-2")).toBe(true);
  });

  it("gives an expanded message the history read cut short the recall_get cursor for its rest", async () => {
    // Six ~405-byte part rows: a 1,500-byte read holds three.
    const { cut, whole } = await v2CutSession(
      Array.from({ length: 6 }, (_, i) => `${i === 0 ? "partneedle " : ""}${`${i}`.repeat(380)}`),
    );
    const gate = createFetchGate({ concurrency: 2 });
    const cards = createCardsRuntime({
      source: { getCards: () => [], revision: () => undefined, degraded: true },
    });
    const drill = createDrill({ source: cut, gate, limits: TEST_LIMITS });
    const tool = search(cut, true, TEST_LIMITS, { gate, store: null, cards, drill });

    const out = await call(tool, { query: "partneedle", sessionID: "ses_cut", expand: "message" });
    expect(out.ok, out.error).toBe(true);
    const expanded = expandedOf(out)[0]!;
    expect(expanded.messageID).toBe("msg_long");
    expect(expanded.message!.partial).toEqual({
      omittedParts: 3,
      omittedBytes: expect.any(Number),
      cursor: expect.any(String),
    });

    const rest = parseBounded(
      toolResultText(
        await getTool(cut, gate).execute(
          {
            sessionID: "ses_cut",
            messageID: "msg_long",
            cursor: expanded.message!.partial!.cursor,
          },
          makeContext().ctx,
        ),
      ),
    );
    expect(rest.ok, rest.error).toBe(true);
    const read = await whole.getMessage("ses_cut", "msg_long");
    if (!read.ok) throw new Error(read.reason);
    const all = formatMsg(read.value).parts.map(flatPart);
    expect((rest.parts as PartOutput[]).map(flatPart)).toEqual(all.slice(3));
  });
});

// ── Refusals ─────────────────────────────────────────────────────────────────

/** The fields a continuation carries. */
const fieldsOf = (token: string): Record<string, string | number | null> =>
  JSON.parse(Buffer.from(token.slice("rc.".length), "base64url").toString("utf8")) as Record<
    string,
    string | number | null
  >;

describe("recall continuations that no longer fit their search", { timeout: 30_000 }, () => {
  const ARGS = { query: "bulkneedle", scope: "project", results: 50, width: 1_000 };

  it("refuses a continuation passed with other arguments", async () => {
    const h = makeFakeHarness();
    addBulk(h);
    const { tool } = await recallOver(h);
    const cursor = (await call(tool, ARGS)).continuation!;
    expect(cursor).toEqual(expect.any(String));
    for (const changed of [
      { query: "bulkneedle answer" },
      { width: 900 },
      { results: 49 },
      { match: "smart" },
      { role: "user" },
      { scope: "global" },
      { last: "7d" },
      { excludeCurrentSession: false },
    ]) {
      expect(await call(tool, { ...ARGS, ...changed, cursor }), JSON.stringify(changed)).toEqual({
        ok: false,
        error: expect.stringContaining("continues a different search"),
      });
    }
    // The same search, run from another session, is another search too.
    expect(
      await call(tool, { ...ARGS, cursor }, makeContext({ sessionID: "s-project-2" }).ctx),
    ).toEqual({ ok: false, error: expect.stringContaining("continues a different search") });
  });

  it("takes a continuation back with arguments that differ only by the defaults the tool fills in", async () => {
    const h = makeFakeHarness();
    addBulk(h);
    const { tool } = await recallOver(h);
    const defaults = {
      match: "literal",
      explain: false,
      group: "part",
      type: "all",
      role: "all",
      fallback: false,
      expand: "none",
      expandResults: 1,
      window: 3,
      deep: false,
    };
    const first = await call(tool, { ...ARGS, ...defaults });
    const viaDefaults = await call(tool, { ...ARGS, ...defaults, cursor: first.continuation });
    const viaRaw = await call(tool, { ...ARGS, cursor: first.continuation });
    expect(viaRaw.ok, viaRaw.error).toBe(true);
    expect(resultsOf(viaRaw)).toEqual(resultsOf(viaDefaults));
  });

  it("refuses a continuation once the results up to its anchor changed", async () => {
    const h = makeFakeHarness();
    addBulk(h);
    const { tool, store } = await recallOver(h, TEST_LIMITS, { cardsRefreshIntervalMs: 0 });
    const first = await call(tool, ARGS);
    store.deleteSession(resultsOf(first)[0]!.sessionID);
    expect(await call(tool, { ...ARGS, cursor: first.continuation })).toEqual({
      ok: false,
      error: expect.stringContaining("search again without cursor"),
    });
  });

  it("continues with the search's new tail when only results after its anchor changed", async () => {
    const h = makeFakeHarness();
    addBulk(h);
    const { tool, store } = await recallOver(h, TEST_LIMITS, { cardsRefreshIntervalMs: 0 });
    const first = await call(tool, ARGS);
    const shown = resultsOf(first);
    const before = await unbounded(tool, ARGS);
    // The top session gains a match older than all of its others, which ranks
    // after the first output's results, and is indexed again (a new write
    // revision, so the drill reads it again).
    const top = resultsOf(before)[0]!.sessionID;
    const oldest = Math.min(...h.messagesBySession[top]!.map((m) => m.info.time.created));
    h.messagesBySession[top]!.unshift(
      bundle(userMessage(`${top}-old`, top, oldest - 1_000), [
        textPart(`${top}-old-p0`, top, `${top}-old`, "an old bulkneedle note"),
      ]),
    );
    store.setMeta("cards_rev", "500");
    seedStore(store, {
      sessions: h.sessions.filter((s) => s.id === top),
      globalSessions: [],
      messagesBySession: h.messagesBySession,
    });
    store.setMeta("cards_rev", "1000");

    const after = await unbounded(tool, ARGS);
    expect(resultsOf(after)).not.toEqual(resultsOf(before));
    const rest: Out[] = [];
    let cursor = first.continuation;
    while (cursor) {
      const out = await call(tool, { ...ARGS, cursor });
      expect(out.ok, out.error).toBe(true);
      rest.push(out);
      cursor = out.continuation;
    }
    expect([...shown, ...rest.flatMap(resultsOf)]).toEqual(resultsOf(after));
  });

  it("refuses a tampered continuation whose anchor, prefix or expansion is not the search's", async () => {
    const h = makeFakeHarness();
    addBulk(h);
    const { tool } = await recallOver(h);
    const results = (await call(tool, ARGS)).continuation!;
    const expandArgs = { ...ARGS, results: 5, width: 120, expand: "message", expandResults: 3 };
    const inside = (await call(tool, expandArgs)).continuation!;
    expect(fieldsOf(inside)).toMatchObject({ x: expect.any(Number), anchorId: expect.any(String) });

    const tamper = (token: string, change: Record<string, string | number>): string =>
      encodeContinuation("recall", { ...fieldsOf(token), ...change, v: undefined, k: undefined });
    const cases: Array<[Record<string, unknown>, string]> = [
      [ARGS, tamper(results, { ri: 999 })],
      [ARGS, tamper(results, { rp: "p-other" })],
      [ARGS, tamper(results, { rs: "s-other" })],
      [ARGS, tamper(results, { h: "0" })],
      [expandArgs, tamper(inside, { x: (fieldsOf(inside).x as number) + 1 })],
      [expandArgs, tamper(inside, { h: "0" })],
      [expandArgs, tamper(inside, { anchorId: "m-gone" })],
      [expandArgs, tamper(inside, { part: "p-gone" })],
    ];
    for (const [args, cursor] of cases) {
      expect(await call(tool, { ...args, cursor }), JSON.stringify(fieldsOf(cursor))).toEqual({
        ok: false,
        error: expect.stringContaining("search again without cursor"),
      });
    }
  });

  it("refuses a continuation into an expansion whose part is gone from its message", async () => {
    const h = makeFakeHarness();
    addBulk(h);
    const { tool } = await recallOver(h);
    const args = { ...ARGS, results: 5, width: 120, expand: "message", expandResults: 3 };
    const first = await call(tool, args);
    const { anchorId, part } = fieldsOf(first.continuation!);
    expect(part).toEqual(expect.any(String));
    // The expanded message is read again on the continuation; the drill's
    // results come from its cache, so only the expansion changed.
    const message = Object.values(h.messagesBySession)
      .flat()
      .find((m) => m.info.id === anchorId)!;
    message.parts = message.parts.filter((p) => p.id !== part);
    expect(await call(tool, { ...args, cursor: first.continuation })).toEqual({
      ok: false,
      error: expect.stringContaining("search again without cursor"),
    });
  });

  it("rejects a malformed continuation, or another tool's, as invalid", async () => {
    const h = makeFakeHarness();
    addBulk(h);
    const { tool } = await recallOver(h);
    const base = fieldsOf((await call(tool, ARGS)).continuation!);
    const bad: Array<Record<string, string | number | null | undefined>> = [
      {},
      { ...base, q: undefined },
      { ...base, ri: -1 },
      { ...base, ri: 1.5 },
      { ...base, rs: "" },
      { ...base, h: undefined },
      { ...base, after: "yesterday" },
      { ...base, anchorId: "m-1" },
      { ...base, x: -1 },
      { ...base, x: 0, part: "p-1" },
      { ...base, x: 0, anchorId: "m-1", part: "p-1", field: "content" },
      { ...base, x: 0, anchorId: "m-1", part: "p-1", field: "bogus", offset: 1 },
    ];
    for (const fields of bad) {
      const cursor = encodeContinuation("recall", { ...fields, v: undefined, k: undefined });
      expect(await call(tool, { ...ARGS, cursor }), JSON.stringify(fields)).toEqual({
        ok: false,
        error: expect.stringMatching(/^Invalid cursor/),
      });
    }
    const foreign = encodeContinuation("recall_get", { m: "m-1" });
    expect(await call(tool, { ...ARGS, cursor: foreign })).toEqual({
      ok: false,
      error: "This cursor continues recall_get, not recall",
    });
  });

  it("requires a query even when the host passes the arguments unchecked", async () => {
    const { tool } = await recallOver(makeFakeHarness());
    for (const args of [{}, { query: "" }, { query: 7 }, { query: null, cursor: "rc.x" }]) {
      expect(await call(tool, args), JSON.stringify(args)).toEqual({
        ok: false,
        error: "query is required",
      });
    }
  });
});

// ── v2 fixture ───────────────────────────────────────────────────────────────

/** An opencode 2.4 database with session `ses_cut`: a user prompt, then
 *  assistant message `msg_long` whose part rows hold `texts`. Returns a
 *  source whose reads stop at 1,500 bytes and one with the default ceiling. */
async function v2CutSession(
  texts: string[],
): Promise<{ cut: HistorySource; whole: HistorySource }> {
  const t = await makeV2PartsDb();
  cleanups.push(t.cleanup);
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
  cleanups.unshift(() => opened.db.close());
  const spy = limitSpy(opened.db);
  const noYield = async (): Promise<void> => {};
  return {
    cut: createV2HistorySource(spy, {
      yieldBetween: noYield,
      projectID: "prj",
      pageByteCeiling: 1_500,
    }),
    whole: createV2HistorySource(spy, { yieldBetween: noYield, projectID: "prj" }),
  };
}
