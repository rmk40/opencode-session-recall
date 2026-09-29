import { describe, expect, it } from "vitest";
import {
  createUnavailableSource,
  unavailableHistoryError,
  type HistorySource,
} from "../src/history/source.js";
import { search } from "../src/search.js";
import { sessions } from "../src/sessions.js";
import { get } from "../src/get.js";
import { context } from "../src/context.js";
import { messages } from "../src/messages.js";
import { createDrill } from "../src/drill.js";
import { createFetchGate } from "../src/fetch-gate.js";
import type { SearchOutput, SessionsOutput } from "../src/types.js";
import {
  bundle,
  globalSessionFrom,
  makeContext,
  makeFakeHarness,
  makeRecallDeps,
  OTHER_DIR,
  PROJECT_DIR,
  runTool,
  session,
  TEST_LIMITS,
  textPart,
  userMessage,
} from "./helpers.js";

/**
 * A history source that cannot read anything (v2 with
 * opencode.db missing, unreadable, in memory, or of an unknown schema). Each
 * tool degrades exactly as specified and nothing throws.
 */

const REASON = "cannot open /data/opencode.db";
const ERROR = unavailableHistoryError(REASON);

/** The unavailable source, counting every read so tests can prove none ran. */
function countingUnavailable(): { source: HistorySource; reads: () => number } {
  const inner = createUnavailableSource("v2-sqlite", REASON);
  let reads = 0;
  const count =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      reads++;
      return fn(...args);
    };
  return {
    source: {
      ...inner,
      listSessions: count(inner.listSessions),
      getSession: count(inner.getSession),
      listChildren: count(inner.listChildren),
      messagePage: count(inner.messagePage),
      getMessage: count(inner.getMessage),
    },
    reads: () => reads,
  };
}

describe("unavailable history source", () => {
  it("fails every read with the unavailable error", async () => {
    const source = createUnavailableSource("v2-sqlite", REASON);
    expect(source.unavailable).toBe(REASON);
    expect(await source.listSessions({ scope: "global", limit: 5 })).toEqual({
      ok: false,
      error: ERROR,
    });
    expect(await source.getMessage("s", "m")).toEqual({ ok: false, reason: "error", error: ERROR });
    await expect(source.messagePage({ sessionID: "s", limit: 5 })).rejects.toThrow(ERROR);
  });

  it("recall answers from the cards, reads nothing, and names the reason", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await makeRecallDeps(h, TEST_LIMITS);
    try {
      const { source, reads } = countingUnavailable();
      const gate = createFetchGate({ concurrency: 2 });
      const drill = createDrill({ source, gate, limits: TEST_LIMITS });
      const recall = search(source, true, TEST_LIMITS, { ...deps, gate, drill });
      for (const args of [
        { query: "rateLimit", scope: "global" },
        { query: "rateLimit checkout", scope: "global", match: "smart" },
        // A deep sweep cannot run; the scoped sessions are searched by card.
        { query: "rateLimit", deep: true, sessions: ["s-current", "s-project-2"] },
      ]) {
        const out = await runTool<SearchOutput>(recall, args);
        expect(out.ok, JSON.stringify(args)).toBe(true);
        expect(out.results.length, JSON.stringify(args)).toBeGreaterThan(0);
        // Every result is card-derived: a card field or the session title.
        for (const result of out.results) {
          expect(result.partID).toMatch(/:card:|:title$/);
        }
        expect(out.coverage?.source).toEqual({
          kind: "v2-sqlite",
          available: false,
          reason: REASON,
        });
        expect(out.coverage?.cards?.total).toBeGreaterThan(0);
        expect(out.warnings?.some((w) => w.startsWith(ERROR) && /session cards only/.test(w))).toBe(
          true,
        );
      }
      expect(reads()).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("recall from cards keeps scope and eligibility filters", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await makeRecallDeps(h, TEST_LIMITS);
    try {
      const { source } = countingUnavailable();
      const drill = createDrill({ source, gate: deps.gate, limits: TEST_LIMITS });
      const recall = search(source, true, TEST_LIMITS, { ...deps, drill });
      // "walkthrough" matches only the other project's card.
      const global = await runTool<SearchOutput>(recall, {
        query: "walkthrough",
        scope: "global",
      });
      expect(global.results.some((r) => r.directory === OTHER_DIR)).toBe(true);
      const project = await runTool<SearchOutput>(recall, {
        query: "walkthrough",
        scope: "project",
      });
      expect(project.results).toEqual([]);
      const userOnly = await runTool<SearchOutput>(recall, {
        query: "rateLimit",
        scope: "global",
        role: "user",
      });
      expect(userOnly.results.length).toBeGreaterThan(0);
      expect(userOnly.results.every((r) => r.role === "user")).toBe(true);
      const assistantOnly = await runTool<SearchOutput>(recall, {
        query: "rateLimit",
        scope: "global",
        role: "assistant",
      });
      expect(assistantOnly.results.every((r) => r.role === "assistant")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("recall from cards never claims a role or author a card field does not record", async () => {
    const h = makeFakeHarness();
    // A session with only a user request: no answer exists.
    const lone = session("s-user-only", "Zebra question", PROJECT_DIR, Date.now() - 5_000);
    h.sessions.push(lone);
    h.globalSessions.push(globalSessionFrom(lone));
    h.messagesBySession[lone.id] = [
      bundle(userMessage("m-lone", lone.id, Date.now() - 5_500), [
        textPart("p-lone", lone.id, "m-lone", "zebraneedle asked but never answered"),
      ]),
    ];
    const { deps, cleanup } = await makeRecallDeps(h, TEST_LIMITS);
    try {
      const { source } = countingUnavailable();
      const drill = createDrill({ source, gate: deps.gate, limits: TEST_LIMITS });
      const recall = search(source, true, TEST_LIMITS, { ...deps, drill });
      const lonely = (out: SearchOutput) => out.results.filter((r) => r.sessionID === lone.id);

      for (const narrowing of [{ role: "assistant" }, { authorship: "model" }]) {
        const out = await runTool<SearchOutput>(recall, {
          query: "zebraneedle",
          scope: "global",
          ...narrowing,
        });
        expect(out.ok).toBe(true);
        expect(lonely(out), JSON.stringify(narrowing)).toEqual([]);
      }
      // Unfiltered, the request is found as what it is: user text.
      const plain = await runTool<SearchOutput>(recall, { query: "zebraneedle", scope: "global" });
      expect(lonely(plain).length).toBeGreaterThan(0);
      expect(lonely(plain).every((r) => r.role === "user")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("recall from cards matches a metadata-only card by its title, within the filters", async () => {
    const h = makeFakeHarness();
    const { deps, store, cleanup } = await makeRecallDeps(h, TEST_LIMITS);
    try {
      const at = Date.now() - 3_000;
      const base = store.getCard("s-project-2")!;
      store.upsertCard({
        ...base,
        sessionId: "s-meta-only",
        rootId: "s-meta-only",
        parentId: null,
        title: "Quokka migration plan",
        summaryHead: "",
        outcomeHead: "",
        nlSummary: "",
        inventory: "",
        files: [],
        tools: [],
        errors: [],
        distillState: "metadata",
        distilledThrough: null,
        timeCreated: at,
        timeUpdated: at,
      });
      store.setMeta("cards_rev", String(Number(store.getMeta("cards_rev") ?? 0) + 1));
      const { source } = countingUnavailable();
      const drill = createDrill({ source, gate: deps.gate, limits: TEST_LIMITS });
      const recall = search(source, true, TEST_LIMITS, { ...deps, drill });
      const quokka = (out: SearchOutput) =>
        out.results.filter((r) => r.sessionID === "s-meta-only");

      const plain = await runTool<SearchOutput>(recall, { query: "Quokka", scope: "global" });
      expect(quokka(plain).map((r) => r.partType)).toEqual(["title"]);
      // A title claims no message role or text type.
      for (const narrowing of [{ role: "user" }, { type: "text" }, { authorship: "human" }]) {
        const out = await runTool<SearchOutput>(recall, {
          query: "Quokka",
          scope: "global",
          ...narrowing,
        });
        expect(quokka(out), JSON.stringify(narrowing)).toEqual([]);
      }
    } finally {
      cleanup();
    }
  });

  it("recall with no cards returns the empty result with the reason", async () => {
    const h = makeFakeHarness();
    const { deps, store, cleanup } = await makeRecallDeps(h, TEST_LIMITS);
    try {
      for (const card of store.allCards()) store.deleteSession(card.sessionId);
      store.setMeta("cards_rev", "2");
      const { source } = countingUnavailable();
      const drill = createDrill({ source, gate: deps.gate, limits: TEST_LIMITS });
      const out = await runTool<SearchOutput>(
        search(source, true, TEST_LIMITS, { ...deps, drill }),
        {
          query: "rateLimit",
          scope: "global",
        },
      );
      expect(out.ok).toBe(true);
      expect(out.results).toEqual([]);
      expect(out.coverage?.source?.reason).toBe(REASON);
    } finally {
      cleanup();
    }
  });

  it("recall_get, recall_context and recall_messages return the unavailable error", async () => {
    const { source } = countingUnavailable();
    const gate = createFetchGate({ concurrency: 2 });
    const args = { sessionID: "s-current", messageID: "m-current-1" };
    for (const definition of [
      get(source, gate),
      context(source, gate, TEST_LIMITS),
      messages(source, gate, TEST_LIMITS),
    ]) {
      expect(await runTool(definition, args)).toEqual({ ok: false, error: ERROR });
    }
  });

  it("recall_sessions serves project, global and children listings from cards", async () => {
    const h = makeFakeHarness();
    const { store, cleanup } = await makeRecallDeps(h, TEST_LIMITS);
    try {
      const { source, reads } = countingUnavailable();
      const tool = sessions(source, true, TEST_LIMITS, { cards: () => store.allCards() });

      const project = await runTool<SessionsOutput>(tool, { scope: "project" });
      expect(project.ok).toBe(true);
      expect(project.sessions.map((s) => s.id).sort()).toEqual(["s-current", "s-project-2"]);
      expect(project.note).toContain(ERROR);

      const global = await runTool<SessionsOutput>(tool, {
        scope: "global",
        search: "walkthrough",
      });
      expect(global.sessions.map((s) => s.id)).toEqual(["s-other"]);
      expect(global.sessions[0]?.directory).toBe(OTHER_DIR);

      const children = await runTool<SessionsOutput>(tool, { parentID: "s-current" });
      expect(children).toMatchObject({ ok: true, scope: "children", childCount: 0 });

      const { ctx } = makeContext({ sessionID: "" });
      const noCurrent = await runTool(tool, { parentID: "current" }, ctx);
      expect(noCurrent.ok).toBe(false);
      expect(reads()).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("recall_sessions without a card store returns the unavailable error", async () => {
    const { source } = countingUnavailable();
    const out = await runTool(sessions(source, true, TEST_LIMITS), { scope: "project" });
    expect(out).toEqual({ ok: false, error: ERROR });
  });
});
