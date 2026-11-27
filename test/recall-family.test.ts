import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Part } from "@opencode-ai/sdk/v2";
import type { ToolDefinition } from "../src/host/opencode-v1-types.js";
import { buildSuggestions, search, type SearchDeps } from "../src/search.js";
import { encodeDeepCursor } from "../src/drill.js";
import { parseQuery } from "../src/query.js";
import type {
  ErrorOutput,
  Limits,
  SearchCoverage,
  SearchOutput,
  SearchResult,
  SearchSuggestion,
} from "../src/types.js";
import {
  OTHER_DIR,
  PROJECT_DIR,
  TEST_LIMITS,
  assistantMessage,
  bundle,
  errorToolPart,
  globalSessionFrom,
  makeContext,
  makeFakeHarness,
  makeRecallDeps,
  reasoningPart,
  runTool,
  runToolRaw,
  session,
  setStrictNoLimitMessages,
  textPart,
  userMessage,
  type FakeHarness,
} from "./helpers.js";

/**
 * recall and the current session's family (its parent, siblings and
 * subagents): what the default exclusion and `excludeFamily` remove at each
 * selection step, what they count and report, and how the relatives the
 * default keeps are ordered against other history.
 */

beforeAll(() => setStrictNoLimitMessages(true));
afterAll(() => setStrictNoLimitMessages(false));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const NOW = Date.now();
const MINUTE = 60_000;

async function recallOver(
  h: FakeHarness,
  limits: Limits = TEST_LIMITS,
): Promise<{ tool: ToolDefinition; deps: SearchDeps }> {
  const { deps, cleanup } = await makeRecallDeps(h, limits);
  cleanups.push(cleanup);
  return { tool: search(h.source, true, limits, deps), deps };
}

type SessionSpec = {
  id: string;
  title?: string;
  parent?: string;
  dir?: string;
  /** Minutes ago the session was last updated. */
  ago: number;
  /** The first user message. */
  user?: string;
  /** The assistant's reply text. */
  reply?: string;
  /** A reasoning part on the assistant's reply, which the card inventory leaves out. */
  reasoning?: string;
};

/** Add a session with up to one user message and one assistant reply. */
function addSession(h: FakeHarness, spec: SessionSpec): void {
  const updated = NOW - spec.ago * MINUTE;
  const s = session(
    spec.id,
    spec.title ?? `Session ${spec.id}`,
    spec.dir ?? PROJECT_DIR,
    updated,
    undefined,
    spec.parent,
  );
  h.sessions.push(s);
  h.globalSessions.push(globalSessionFrom(s));
  const messages = [];
  if (spec.user !== undefined) {
    messages.push(
      bundle(userMessage(`m-${spec.id}-u`, spec.id, updated - 2_000), [
        textPart(`p-${spec.id}-u`, spec.id, `m-${spec.id}-u`, spec.user),
      ]),
    );
  }
  if (spec.reply !== undefined || spec.reasoning !== undefined) {
    const parts: Part[] = [];
    if (spec.reasoning !== undefined) {
      parts.push(reasoningPart(`p-${spec.id}-r`, spec.id, `m-${spec.id}-a`, spec.reasoning));
    }
    if (spec.reply !== undefined) {
      parts.push(textPart(`p-${spec.id}-a`, spec.id, `m-${spec.id}-a`, spec.reply));
    }
    messages.push(bundle(assistantMessage(`m-${spec.id}-a`, spec.id, updated - 1_000), parts));
  }
  h.messagesBySession[spec.id] = messages;
}

const sessionsOf = (out: SearchOutput): string[] => out.results.map((r) => r.sessionID);
const findSuggestion = (out: SearchOutput, text: string): SearchSuggestion | undefined =>
  out.suggestions?.find((s) => s.reason.includes(text));

/**
 * f-root has two subagents, f-kid and f-sib; f-sib has a subagent of its own,
 * f-nephew. f-out is unrelated. Every one of them says "lanternfish" in a
 * reply.
 */
function familyTree(): FakeHarness {
  const h = makeFakeHarness();
  const reply = "The lanternfish ledger is reconciled.";
  addSession(h, { id: "f-root", title: "Tree root", ago: 50, user: "Split the work.", reply });
  addSession(h, { id: "f-kid", title: "Tree kid", parent: "f-root", ago: 40, reply });
  addSession(h, { id: "f-sib", title: "Tree sibling", parent: "f-root", ago: 30, reply });
  addSession(h, { id: "f-nephew", title: "Tree nephew", parent: "f-sib", ago: 20, reply });
  addSession(h, { id: "f-out", title: "Outside notes", ago: 10, reply });
  return h;
}

describe("excludeFamily refusals", () => {
  it.each([
    {
      name: 'scope:"session"',
      current: "f-kid",
      args: { scope: "session" },
      error: 'excludeFamily cannot be combined with scope:"session"',
    },
    {
      name: "an explicit excludeCurrentSession:false",
      current: "f-kid",
      args: { excludeCurrentSession: false },
      error: "excludeCurrentSession:false includes",
    },
    {
      name: "a sessionID naming the current session",
      current: "f-kid",
      args: { sessionID: "f-kid" },
      error: "sessionID targets a session excludeFamily:true excludes",
    },
    {
      name: "a sessionID naming its parent",
      current: "f-kid",
      args: { sessionID: "f-root" },
      error: "sessionID targets a session excludeFamily:true excludes",
    },
    {
      name: "a sessionID naming a sibling",
      current: "f-kid",
      args: { sessionID: "f-sib" },
      error: "sessionID targets a session excludeFamily:true excludes",
    },
    {
      name: "a sessionID naming a subagent",
      current: "f-root",
      args: { sessionID: "f-nephew" },
      error: "sessionID targets a session excludeFamily:true excludes",
    },
  ])("refuses excludeFamily:true with $name", async ({ current, args, error }) => {
    const { tool } = await recallOver(familyTree());
    const out = await runTool<ErrorOutput>(
      tool,
      { query: "lanternfish", excludeFamily: true, ...args },
      makeContext({ sessionID: current }).ctx,
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain(error);
  });

  it("accepts excludeFamily:true with a sessionID outside the family or excludeCurrentSession:true", async () => {
    const { tool } = await recallOver(familyTree());
    const { ctx } = makeContext({ sessionID: "f-kid" });

    const outside = await runTool<SearchOutput>(
      tool,
      { query: "lanternfish", excludeFamily: true, sessionID: "f-out" },
      ctx,
    );
    expect(outside.ok).toBe(true);
    expect(new Set(sessionsOf(outside))).toEqual(new Set(["f-out"]));

    const both = await runTool<SearchOutput>(
      tool,
      { query: "lanternfish", excludeFamily: true, excludeCurrentSession: true },
      ctx,
    );
    expect(both.ok).toBe(true);
    expect(new Set(sessionsOf(both))).toEqual(new Set(["f-out"]));
  });

  it("refuses nothing for an excludeFamily value other than true", async () => {
    const { tool } = await recallOver(familyTree());
    const { ctx } = makeContext({ sessionID: "f-kid" });
    for (const excludeFamily of ["yes", 1]) {
      const out = await runToolRaw<SearchOutput>(
        tool,
        { query: "lanternfish", excludeFamily, scope: "session" },
        ctx,
      );
      expect(out.ok, String(excludeFamily)).toBe(true);
      expect(new Set(sessionsOf(out)), String(excludeFamily)).toEqual(new Set(["f-kid"]));
    }
  });
});

describe("coverage of the excluded sessions", () => {
  it("counts only the family members that have cards", async () => {
    // c-kid's parent c-gone has no card; its sibling c-sib does.
    const h = makeFakeHarness();
    const reply = "The quartzlope gauge drifted.";
    addSession(h, { id: "c-kid", parent: "c-gone", ago: 30, reply });
    addSession(h, { id: "c-sib", parent: "c-gone", ago: 20, reply });
    addSession(h, { id: "c-out", ago: 10, reply });
    const { tool } = await recallOver(h);
    const { ctx } = makeContext({ sessionID: "c-kid" });

    const family = await runTool<SearchOutput>(
      tool,
      { query: "quartzlope", excludeFamily: true },
      ctx,
    );
    expect(new Set(sessionsOf(family))).toEqual(new Set(["c-out"]));
    expect(family.coverage?.skippedByReason?.excludedSession).toBe(2);

    const byDefault = await runTool<SearchOutput>(tool, { query: "quartzlope" }, ctx);
    expect(new Set(sessionsOf(byDefault))).toEqual(new Set(["c-sib", "c-out"]));
    expect(byDefault.coverage?.skippedByReason?.excludedSession).toBe(1);
  });
});

describe("the slim-index lookup and the exclusion", () => {
  /**
   * The rare word "zorvanqix" sits only in reasoning parts, which the card
   * inventory leaves out, so only the slim index finds x-root (the current
   * session) and its subagents x-kid and x-far (another directory). The
   * outsider x-anchor's card matches the query's other word.
   */
  function slimHarness(): FakeHarness {
    const h = makeFakeHarness();
    addSession(h, {
      id: "x-root",
      title: "Queue planning",
      ago: 40,
      user: "Plan the queue work.",
      reasoning: "The zorvanqix backlog drains slowly.",
    });
    addSession(h, {
      id: "x-kid",
      title: "Queue check",
      parent: "x-root",
      ago: 30,
      user: "Check the queue.",
      reasoning: "The zorvanqix eviction stalls under load.",
    });
    addSession(h, {
      id: "x-far",
      title: "Queue check elsewhere",
      parent: "x-root",
      dir: OTHER_DIR,
      ago: 25,
      user: "Check the other queue.",
      reasoning: "Another zorvanqix eviction stall.",
    });
    addSession(h, {
      id: "x-anchor",
      title: "Migration status",
      ago: 10,
      user: "Note the anchorleaf migration status.",
    });
    return h;
  }
  const QUERY = { query: "zorvanqix anchorleaf", match: "smart", group: "session" };

  it("admits relatives only it matches, and leaves out what the exclusion removes", async () => {
    const h = slimHarness();
    const { tool, deps } = await recallOver(h);
    // The cards miss the rare word, so the slim index is the only way in.
    const ranked = deps.cards.rank(parseQuery(QUERY.query), {}).map((hit) => hit.sessionId);
    expect(ranked).toEqual(["x-anchor"]);
    const { ctx } = makeContext({ sessionID: "x-root" });

    const byDefault = await runTool<SearchOutput>(tool, QUERY, ctx);
    expect(new Set(sessionsOf(byDefault))).toEqual(new Set(["x-anchor", "x-kid", "x-far"]));

    const withCurrent = await runTool<SearchOutput>(
      tool,
      { ...QUERY, excludeCurrentSession: false },
      ctx,
    );
    expect(new Set(sessionsOf(withCurrent))).toEqual(
      new Set(["x-anchor", "x-kid", "x-far", "x-root"]),
    );

    const family = await runTool<SearchOutput>(tool, { ...QUERY, excludeFamily: true }, ctx);
    expect(sessionsOf(family)).toEqual(["x-anchor"]);
  });

  it.each([
    { name: "every directory", args: {}, reason: "2 sessions in the current session's family" },
    {
      name: "the project scope, which keeps the other directory out",
      args: { scope: "project" },
      reason: "1 session in the current session's family",
    },
  ])("counts the relatives it matches across $name", async ({ args, reason }) => {
    const { tool } = await recallOver(slimHarness());
    const out = await runTool<SearchOutput>(
      tool,
      { ...QUERY, ...args, excludeFamily: true },
      makeContext({ sessionID: "x-root" }).ctx,
    );
    expect(sessionsOf(out)).toEqual(["x-anchor"]);
    expect(findSuggestion(out, reason)?.example).toEqual({ excludeFamily: false });
  });

  it("does not count relatives the roots-only restriction would drop anyway", async () => {
    const { tool } = await recallOver(slimHarness());
    const out = await runTool<SearchOutput>(
      tool,
      { ...QUERY, excludeFamily: true, authorship: "human" },
      makeContext({ sessionID: "x-root" }).ctx,
    );
    expect(sessionsOf(out)).toEqual(["x-anchor"]);
    expect(findSuggestion(out, "in the current session's family")).toBeUndefined();
    // The current session is a root, so it still counts.
    expect(
      findSuggestion(out, "The current session matches the query, but excludeFamily:true"),
    ).toBeDefined();
  });
});

describe("uncarded sessions named in sessions: under excludeFamily", () => {
  // u-kid has a card naming u-parent, which has none yet; u-stranger and
  // u-young have none either.
  async function setup() {
    const h = makeFakeHarness();
    addSession(h, { id: "u-kid", parent: "u-parent", ago: 30, reply: "Nothing here." });
    const { tool } = await recallOver(h);
    const needle = "The plinthwick valve sticks.";
    addSession(h, { id: "u-parent", ago: 40, reply: needle });
    addSession(h, { id: "u-stranger", ago: 20, reply: needle });
    addSession(h, { id: "u-young", ago: 5, reply: needle });
    return tool;
  }
  const searched = (out: SearchOutput): Set<string> => new Set(sessionsOf(out));

  it("skips an uncarded parent of the current session", async () => {
    const tool = await setup();
    const { ctx } = makeContext({ sessionID: "u-kid" });
    const args = { query: "plinthwick", sessions: ["u-parent", "u-stranger"] };

    expect(searched(await runTool<SearchOutput>(tool, args, ctx))).toEqual(
      new Set(["u-parent", "u-stranger"]),
    );
    const family = await runTool<SearchOutput>(tool, { ...args, excludeFamily: true }, ctx);
    expect(searched(family)).toEqual(new Set(["u-stranger"]));
    expect(family.coverage?.sessionsSearched).toBe(1);
  });

  it("skips the current session when it has no card yet", async () => {
    const tool = await setup();
    const { ctx } = makeContext({ sessionID: "u-young" });
    const args = { query: "plinthwick", sessions: ["u-young", "u-stranger"] };

    expect(searched(await runTool<SearchOutput>(tool, args, ctx))).toEqual(
      new Set(["u-young", "u-stranger"]),
    );
    const family = await runTool<SearchOutput>(tool, { ...args, excludeFamily: true }, ctx);
    expect(searched(family)).toEqual(new Set(["u-stranger"]));
  });
});

describe("carded sessions named in a list under excludeFamily", () => {
  // From f-kid, the family is f-root, f-kid, f-sib and f-nephew.
  const named = ["f-root", "f-sib", "f-nephew", "f-out"];

  it.each([{ deep: false }, { deep: true }])(
    "drops the named relatives and counts them (deep: $deep)",
    async ({ deep }) => {
      const { tool } = await recallOver(familyTree());
      const { ctx } = makeContext({ sessionID: "f-kid" });
      const args = { query: "lanternfish", sessions: named, ...(deep && { deep: true }) };

      const byDefault = await runTool<SearchOutput>(tool, args, ctx);
      expect(new Set(sessionsOf(byDefault))).toEqual(new Set(named));

      const family = await runTool<SearchOutput>(tool, { ...args, excludeFamily: true }, ctx);
      expect(new Set(sessionsOf(family))).toEqual(new Set(["f-out"]));
      expect(family.coverage?.sessionsSearched).toBe(1);
      expect(family.coverage?.skippedByReason?.excludedSession).toBe(3);
      expect(family.coverage?.limitedBy).toContain("excludedSession");
    },
  );

  it("counts a named session once when excludeSessionID names it as well", async () => {
    const { tool } = await recallOver(familyTree());
    const { ctx } = makeContext({ sessionID: "f-kid" });
    const args = { query: "lanternfish", sessions: named, excludeFamily: true };
    const excludedFor = async (excludeSessionID: string): Promise<number | undefined> =>
      (await runTool<SearchOutput>(tool, { ...args, excludeSessionID }, ctx)).coverage
        ?.skippedByReason?.excludedSession;

    // f-sib is a relative excludeFamily drops already.
    expect(await excludedFor("f-sib")).toBe(3);
    // f-out survives the family drop, so excludeSessionID removes it.
    expect(await excludedFor("f-out")).toBe(4);
    // An id the list does not name removes nothing from it.
    expect(await excludedFor("s-other")).toBe(3);
  });

  it("drops the relatives a deep cursor names before it takes any target", async () => {
    const { tool } = await recallOver(familyTree());
    const { ctx } = makeContext({ sessionID: "f-kid" });
    const deepCursor = encodeDeepCursor({
      v: 1,
      remaining: ["f-sib", "f-nephew", "f-out"],
      current: "f-root",
      before: null,
    });
    const args = { query: "lanternfish", deepCursor };

    const byDefault = await runTool<SearchOutput>(tool, args, ctx);
    expect(new Set(sessionsOf(byDefault))).toEqual(new Set(named));

    const family = await runTool<SearchOutput>(tool, { ...args, excludeFamily: true }, ctx);
    expect(new Set(sessionsOf(family))).toEqual(new Set(["f-out"]));
    expect(family.coverage?.sessionsSearched).toBe(1);
    expect(family.coverage?.skippedByReason?.excludedSession).toBe(3);
  });

  it("drops a named current session only on an explicit excludeCurrentSession:true", async () => {
    const { tool } = await recallOver(familyTree());
    const { ctx } = makeContext({ sessionID: "f-kid" });
    const args = { query: "lanternfish", sessions: ["f-kid", "f-out"] };

    const byDefault = await runTool<SearchOutput>(tool, args, ctx);
    expect(new Set(sessionsOf(byDefault))).toEqual(new Set(["f-kid", "f-out"]));

    const explicit = await runTool<SearchOutput>(
      tool,
      { ...args, excludeCurrentSession: true },
      ctx,
    );
    expect(sessionsOf(explicit)).toEqual(["f-out"]);
    expect(explicit.coverage?.skippedByReason?.excludedSession).toBe(1);
  });
});

describe("the suggestion naming excluded sessions that match", () => {
  const CURRENT_DEFAULT =
    "The current session matches the query, but recall excludes it by default.";

  describe("through the tool", () => {
    it("names the current session on a few results, up to the results asked for", async () => {
      // "checkout" matches s-current (excluded) and s-project-2 only.
      const { tool } = await recallOver(makeFakeHarness());
      const args = { query: "checkout", match: "smart", group: "session" };

      const few = await runTool<SearchOutput>(tool, args);
      expect(sessionsOf(few)).toEqual(["s-project-2"]);
      expect(findSuggestion(few, CURRENT_DEFAULT)?.example).toEqual({
        excludeCurrentSession: false,
      });

      const asked = await runTool<SearchOutput>(tool, { ...args, results: 1 });
      expect(sessionsOf(asked)).toEqual(["s-project-2"]);
      expect(findSuggestion(asked, "current session")).toBeUndefined();
    });

    it("names the exclusion on an empty result the current session did not match", async () => {
      const { tool } = await recallOver(makeFakeHarness());
      const out = await runTool<SearchOutput>(tool, { query: "zzqnomatchword", match: "smart" });
      expect(out.results).toEqual([]);
      expect(out.coverage?.skippedByReason?.excludedSession).toBe(1);
      expect(findSuggestion(out, CURRENT_DEFAULT)).toBeUndefined();
      expect(findSuggestion(out, "This search excluded the current session.")?.example).toEqual({
        excludeCurrentSession: false,
      });
    });

    it("keeps the unmeasured zero-result hint for a search over named sessions", async () => {
      // s-current matches nothing here; a named-list search does not rank
      // cards, so it cannot tell, and still names the exclusion.
      const { tool } = await recallOver(makeFakeHarness());
      const args = { query: "zzqnomatchword", sessions: ["s-other"] };

      const byDefault = await runTool<SearchOutput>(tool, args);
      expect(byDefault.results).toEqual([]);
      expect(findSuggestion(byDefault, "This search excluded the current session.")).toBeDefined();

      const family = await runTool<SearchOutput>(tool, { ...args, excludeFamily: true });
      expect(
        findSuggestion(family, "This search excluded the current session and its family.")?.example,
      ).toEqual({ excludeFamily: false });
    });

    it("counts the matching relatives excludeFamily left out", async () => {
      const { tool } = await recallOver(familyTree());
      const { ctx } = makeContext({ sessionID: "f-root" });
      const args = { query: "lanternfish", match: "smart", group: "session", excludeFamily: true };

      const all = await runTool<SearchOutput>(tool, args, ctx);
      expect(sessionsOf(all)).toEqual(["f-out"]);
      expect(
        findSuggestion(
          all,
          "3 sessions in the current session's family (its parent, siblings or subagents) match the query, but excludeFamily:true left them out.",
        )?.example,
      ).toEqual({ excludeFamily: false });

      // excludeSessionID removes its session whatever excludeFamily says.
      const named = await runTool<SearchOutput>(tool, { ...args, excludeSessionID: "f-sib" }, ctx);
      expect(findSuggestion(named, "2 sessions in the current session's family")).toBeDefined();
    });

    it("leaves out relatives the title filter would remove anyway", async () => {
      // "tree" is in the family's titles only, so only their cards match it.
      const { tool } = await recallOver(familyTree());
      const { ctx } = makeContext({ sessionID: "f-root" });
      const args = { query: "tree", match: "smart", group: "session", excludeFamily: true };

      const all = await runTool<SearchOutput>(tool, args, ctx);
      expect(findSuggestion(all, "3 sessions in the current session's family")).toBeDefined();

      const titled = await runTool<SearchOutput>(tool, { ...args, title: "kid" }, ctx);
      expect(titled.results).toEqual([]);
      expect(findSuggestion(titled, "1 session in the current session's family")?.reason).toContain(
        "matches the query, but excludeFamily:true left it out.",
      );
    });
  });

  describe("buildSuggestions", () => {
    const coverage: SearchCoverage = {
      totalSessionsKnown: false,
      sessionsDiscovered: 10,
      sessionsEligible: 10,
      sessionsSearched: 10,
      messagesFetched: 10,
      messagesCandidate: 10,
      messagesEligible: 10,
      partsSearched: 10,
      sessionsSkipped: 0,
    };
    function hit(id: string, opts: { title?: boolean } = {}): SearchResult {
      return {
        sessionID: `s-${id}`,
        sessionTitle: id,
        directory: PROJECT_DIR,
        messageID: `m-${id}`,
        role: "assistant",
        time: 1_000,
        partID: `p-${id}`,
        partType: opts.title ? "title" : "text",
        pruned: false,
        snippet: id,
        ...(opts.title && { source: "title" as const }),
      };
    }
    const results = (n: number): SearchResult[] =>
      Array.from({ length: n }, (_, i) => hit(String(i)));
    const suggest = (over: Partial<Parameters<typeof buildSuggestions>[0]>): SearchSuggestion[] =>
      buildSuggestions({
        results: [],
        coverage,
        fallback: false,
        matchMode: "smart",
        type: undefined,
        query: "anything",
        currentSessionID: "s-current",
        currentSessionExcluded: true,
        excludeExplicitOff: false,
        codeTokens: [],
        shortlistIDs: [],
        ...over,
      }) ?? [];
    const reasons = (over: Partial<Parameters<typeof buildSuggestions>[0]>): string[] =>
      suggest(over).map((s) => s.reason);

    it.each([
      { shown: 0, requested: 10, named: true },
      { shown: 2, requested: 10, named: true },
      { shown: 3, requested: 10, named: false },
      { shown: 1, requested: 2, named: true },
      { shown: 2, requested: 2, named: false },
      { shown: 0, requested: 1, named: true },
      { shown: 1, requested: 1, named: false },
      { shown: 2, requested: undefined, named: true },
      { shown: 3, requested: undefined, named: false },
    ])(
      "names the matching current session with $shown of $requested results: $named",
      ({ shown, requested, named }) => {
        const out = reasons({
          results: results(shown),
          excludedMatches: { current: true, relatives: 0 },
          ...(requested !== undefined && { requested }),
        });
        expect(out.includes(CURRENT_DEFAULT)).toBe(named);
      },
    );

    it("ranks the suggestion with the zero-result guidance only when nothing was found", () => {
      const excludedMatches = { current: true, relatives: 0 };
      // Zero results: ahead of the generic literal-mode hint.
      expect(reasons({ results: [], matchMode: "literal", excludedMatches })).toEqual([
        CURRENT_DEFAULT,
        "Literal search found no hits.",
      ]);
      // A few results: behind the title-only hint.
      expect(reasons({ results: [hit("t", { title: true })], excludedMatches })).toEqual([
        "Only session-title hits matched; no message content matched the query.",
        CURRENT_DEFAULT,
      ]);
    });

    it.each([
      { name: "measured to match", excludedMatches: { current: true, relatives: 0 } },
      { name: "not measured", excludedMatches: undefined },
    ])(
      "keeps the exclusion hint and the tool-name hint when every other hint fires too ($name)",
      ({ excludedMatches }) => {
        // An empty literal search shaped like a pattern, under a directory
        // filter without fallback and a toolName that matched nothing: the
        // routing, directory and literal hints all want the three slots.
        const out = reasons({
          results: [],
          matchMode: "literal",
          query: "foo|bar",
          directory: "/workspace/project",
          coverage: {
            ...coverage,
            toolNames: {
              filter: "bassh",
              accepted: ["bassh"],
              matched: 0,
              parts: 4,
              distinct: 1,
              top: [{ name: "bash", count: 4 }],
              closest: "bash",
            },
          },
          ...(excludedMatches && { excludedMatches }),
        });
        expect(out).toHaveLength(3);
        expect(out[0]).toBe(
          excludedMatches ? CURRENT_DEFAULT : "This search excluded the current session.",
        );
        expect(out[1]).toContain('toolName:"bassh" matched none');
        // The routing hint takes the last slot; the directory hint is cut.
        expect(out[2]).toContain("It may be intended as a pattern.");
      },
    );

    it("names the relatives ahead of the current session, by count", () => {
      const one = suggest({
        excludeFamily: true,
        excludedMatches: { current: true, relatives: 1 },
      });
      expect(one).toEqual([
        {
          reason:
            "1 session in the current session's family (its parent, siblings or subagents) matches the query, but excludeFamily:true left it out.",
          action: "Drop excludeFamily to search them.",
          example: { excludeFamily: false },
        },
      ]);
      expect(
        reasons({ excludeFamily: true, excludedMatches: { current: false, relatives: 2 } }),
      ).toEqual([
        "2 sessions in the current session's family (its parent, siblings or subagents) match the query, but excludeFamily:true left them out.",
      ]);
    });

    it("names both arguments when excludeFamily left out a matching current session", () => {
      expect(
        suggest({ excludeFamily: true, excludedMatches: { current: true, relatives: 0 } }),
      ).toEqual([
        {
          reason: "The current session matches the query, but excludeFamily:true left it out.",
          action:
            "Drop excludeFamily and pass excludeCurrentSession:false if you meant to search this conversation.",
          example: { excludeFamily: false, excludeCurrentSession: false },
        },
      ]);
    });

    it("names the exclusion on an empty result when no excluded session was measured to match", () => {
      // The measurement can miss the current session (its card waiting for
      // the index, or a match only in text the cards leave out).
      const none = { current: false, relatives: 0 };
      expect(suggest({ excludedMatches: none })).toEqual([
        {
          reason: "This search excluded the current session.",
          action: "Pass excludeCurrentSession:false if you meant to search this conversation.",
          example: { excludeCurrentSession: false },
        },
      ]);
      expect(suggest({ excludeFamily: true, excludedMatches: none })).toEqual([
        {
          reason: "This search excluded the current session and its family.",
          action: "Drop excludeFamily to search its parent, siblings and subagents.",
          example: { excludeFamily: false },
        },
      ]);
      // A result, or a current session that was not excluded, gets nothing.
      expect(suggest({ results: results(1), excludedMatches: none })).toEqual([]);
      expect(suggest({ currentSessionExcluded: false, excludedMatches: none })).toEqual([]);
    });

    describe("without a measurement of what matched", () => {
      it("names the exclusion on an empty result after the current session was excluded", () => {
        expect(suggest({})).toEqual([
          {
            reason: "This search excluded the current session.",
            action: "Pass excludeCurrentSession:false if you meant to search this conversation.",
            example: { excludeCurrentSession: false },
          },
        ]);
        expect(suggest({ excludeFamily: true })).toEqual([
          {
            reason: "This search excluded the current session and its family.",
            action: "Drop excludeFamily to search its parent, siblings and subagents.",
            example: { excludeFamily: false },
          },
        ]);
      });

      it("says nothing on any result, or when the current session was not excluded", () => {
        expect(suggest({ results: results(1) })).toEqual([]);
        expect(suggest({ currentSessionExcluded: false })).toEqual([]);
      });
    });
  });
});

describe("relatives the default keeps, ordered against other history", () => {
  describe("a subagent whose best match is its prompt", () => {
    /** d-echo's prompt, which its parent d-root wrote, repeats the query;
     *  its reply holds nothing. d-real answers it once. */
    function echoHarness(): FakeHarness {
      const h = makeFakeHarness();
      addSession(h, { id: "d-root", title: "Orchestrator", ago: 60, user: "Split the work." });
      addSession(h, {
        id: "d-echo",
        title: "Delegated lookup",
        parent: "d-root",
        ago: 20,
        user: "Find the cobaltine ferrule setting: cobaltine ferrule, cobaltine ferrule.",
        reply: "Done.",
      });
      addSession(h, {
        id: "d-real",
        title: "Hardware notes",
        ago: 40,
        reply: "The cobaltine ferrule is set in the press config.",
      });
      return h;
    }
    const args = { query: "cobaltine ferrule", match: "smart", group: "session" };

    it("ranks just below the best result from outside the family", async () => {
      const { tool } = await recallOver(echoHarness());
      const out = await runTool<SearchOutput>(tool, args, makeContext({ sessionID: "d-root" }).ctx);
      expect(sessionsOf(out)).toEqual(["d-real", "d-echo"]);
    });

    it("keeps its place in a time-bounded search", async () => {
      const { tool } = await recallOver(echoHarness());
      const out = await runTool<SearchOutput>(
        tool,
        { ...args, since: "30d" },
        makeContext({ sessionID: "d-root" }).ctx,
      );
      expect(sessionsOf(out)).toEqual(["d-echo", "d-real"]);
    });
  });

  describe("relatives that outrank everything else", () => {
    /** w-root (the caller) has three subagents whose replies say "basaltine"
     *  three times; three outsiders say it once. w-root says it most. */
    function windowHarness(): FakeHarness {
      const h = makeFakeHarness();
      addSession(h, {
        id: "w-root",
        title: "Survey lead",
        ago: 90,
        reply: "basaltine basaltine basaltine basaltine basaltine summary",
      });
      for (const [i, id] of ["w-r1", "w-r2", "w-r3"].entries()) {
        addSession(h, {
          id,
          title: `Survey part ${i}`,
          parent: "w-root",
          ago: 10 + i,
          reply: "basaltine basaltine basaltine noted",
        });
      }
      for (const [i, id] of ["w-o1", "w-o2", "w-o3"].entries()) {
        addSession(h, {
          id,
          title: `Field log ${i}`,
          ago: 30 + i,
          reply: "basaltine noted elsewhere today",
        });
      }
      return h;
    }
    const RELATIVES = new Set(["w-r1", "w-r2", "w-r3"]);
    const OUTSIDERS = new Set(["w-o1", "w-o2", "w-o3"]);
    const args = { query: "basaltine", match: "smart", group: "session", results: 6 };
    /** "r" for a relative, "o" for an outsider, "c" for the caller. */
    const shape = (out: SearchOutput): string =>
      sessionsOf(out)
        .map((id) =>
          RELATIVES.has(id) ? "r" : OUTSIDERS.has(id) ? "o" : id === "w-root" ? "c" : "?",
        )
        .join("");

    it("hold two of the first five results while other results remain", async () => {
      const { tool } = await recallOver(windowHarness());
      const out = await runTool<SearchOutput>(tool, args, makeContext({ sessionID: "w-root" }).ctx);
      expect(shape(out)).toBe("rrooor");
    });

    it("keep their order in a time-bounded search or one over named sessions", async () => {
      const { tool } = await recallOver(windowHarness());
      const { ctx } = makeContext({ sessionID: "w-root" });

      const bounded = await runTool<SearchOutput>(tool, { ...args, since: "30d" }, ctx);
      expect(shape(bounded)).toBe("rrrooo");

      const named = await runTool<SearchOutput>(
        tool,
        { ...args, sessions: [...RELATIVES, ...OUTSIDERS] },
        ctx,
      );
      expect(shape(named)).toBe("rrrooo");
    });

    it("do not count the current session among them", async () => {
      const { tool } = await recallOver(windowHarness());
      const out = await runTool<SearchOutput>(
        tool,
        { ...args, excludeCurrentSession: false },
        makeContext({ sessionID: "w-root" }).ctx,
      );
      expect(shape(out)).toBe("crroor");
    });
  });

  describe("the drill shortlist", () => {
    /** s-r1..s-r3, subagents of the caller, name the query in their titles
     *  and are the newest, so their cards rank first; two outsiders mention
     *  it once. */
    function shortlistHarness(): FakeHarness {
      const h = makeFakeHarness();
      addSession(h, { id: "s-boss", title: "Coordinator", ago: 90, user: "Split the work." });
      for (const [i, id] of ["s-r1", "s-r2", "s-r3"].entries()) {
        addSession(h, {
          id,
          title: `Gabbroite survey ${i}`,
          parent: "s-boss",
          ago: 5 + i,
          reply: "gabbroite gabbroite gabbroite mapped",
        });
      }
      for (const [i, id] of ["s-o1", "s-o2"].entries()) {
        addSession(h, { id, title: `Field log ${i}`, ago: 40 + i, reply: "gabbroite seen once" });
      }
      return h;
    }
    const relatives = (out: SearchOutput): number =>
      new Set(sessionsOf(out).filter((id) => id.startsWith("s-r"))).size;
    const outsiders = (out: SearchOutput): number =>
      new Set(sessionsOf(out).filter((id) => id.startsWith("s-o"))).size;

    it("gives relatives two of three drill slots and the third to the next session outside", async () => {
      const { tool, deps } = await recallOver(shortlistHarness());
      const ranked = deps.cards.rank(parseQuery("gabbroite"), {}).map((hit) => hit.sessionId);
      expect(ranked.slice(0, 3).sort()).toEqual(["s-r1", "s-r2", "s-r3"]);
      const { ctx } = makeContext({ sessionID: "s-boss" });
      const args = { query: "gabbroite", match: "smart", group: "session", sessionLimit: 3 };

      const out = await runTool<SearchOutput>(tool, args, ctx);
      expect(out.coverage?.sessionsSearched).toBe(3);
      expect(relatives(out)).toBe(2);
      expect(outsiders(out)).toBe(1);

      // A time-bounded search drills the three best cards.
      const bounded = await runTool<SearchOutput>(tool, { ...args, since: "30d" }, ctx);
      expect(bounded.coverage?.sessionsSearched).toBe(3);
      expect(relatives(bounded)).toBe(3);
      expect(outsiders(bounded)).toBe(0);
    });

    describe("a relative only the slim-index lookup finds", () => {
      /** a-root (the caller) has five subagents whose cards rank on "relay"
       *  and one, a-needle, whose only match is "relay-west.png" in a
       *  reasoning part. Two hundred code tokens it mentions more often fill
       *  its card's inventory first, so the card leaves the needle out and
       *  only the slim index holds it. Ten older outsiders mention "relay"
       *  too, so the card-ranked sessions fill the twelve drill slots with
       *  more left to take the family's spare ones. */
      function needleHarness(opts: { echo?: boolean } = {}): FakeHarness {
        const filler = Array.from(
          { length: 200 },
          (_, i) => `a_${String(i).padStart(3, "0")}`,
        ).join(" ");
        const h = makeFakeHarness();
        if (opts.echo) {
          // A subagent whose prompt, the first message its orchestrator wrote,
          // names the needle past the opening statement its card keeps; the
          // tokens it mentions more often leave the needle out of the card's
          // inventory as well.
          addSession(h, {
            id: "a-echo",
            title: "Image lookup",
            parent: "a-root",
            ago: 50,
            user:
              "Read the image bucket listing and the tile manifest and compare every " +
              "entry with the render log and the mirror sync report from last night " +
              "before the regional mirrors and the cache layer pick up the next map " +
              "release. Then find where relay-west.png is used.",
            reasoning: `Checked ${filler}`,
            reply: `Checked ${filler}`,
          });
        }
        addSession(h, { id: "a-root", title: "Map rollout", ago: 120, user: "Split the work." });
        for (const i of [1, 2, 3, 4, 5]) {
          addSession(h, {
            id: `a-r${i}`,
            title: `Relay provider check ${i}`,
            parent: "a-root",
            ago: 10 + i,
            reply: `Checked the relay provider settings for region ${i}.`,
          });
        }
        addSession(h, {
          id: "a-needle",
          title: "Tile audit",
          parent: "a-root",
          ago: 60,
          user: "Audit the broken tiles.",
          reasoning: `The broken tile is relay-west.png in the image bucket. Checked ${filler}`,
          reply: `Checked ${filler}`,
        });
        for (let i = 1; i <= 10; i++) {
          addSession(h, {
            id: `a-o${i}`,
            title: `Ops notes ${i}`,
            ago: 30 + i,
            reply:
              "Noted the relay timing next to the queue depth, the worker counts and the nightly build schedule.",
          });
        }
        return h;
      }
      const args = {
        query: "relay-west.png",
        scope: "global",
        excludeCurrentSession: false,
        results: 5,
      };

      it.each([{ match: "literal" }, { match: "smart" }])(
        "drills it ahead of the card-ranked relatives and returns it first ($match)",
        async ({ match }) => {
          const { tool, deps } = await recallOver(needleHarness());
          // Its card misses the needle; the five card-ranked relatives' cards match it.
          const ranked = deps.cards
            .rank(parseQuery(args.query), {})
            .map((hit) => hit.sessionId)
            .filter((id) => id.startsWith("a-"));
          expect(ranked).not.toContain("a-needle");
          expect(ranked.filter((id) => id.startsWith("a-r")).length).toBe(5);

          const out = await runTool<SearchOutput>(
            tool,
            { ...args, match },
            makeContext({ sessionID: "a-root" }).ctx,
          );
          expect(out.coverage?.sessionsSearched).toBe(12);
          expect(out.results[0]?.sessionID).toBe("a-needle");
          // The family still holds four drill slots: the needle and the first
          // three card-ranked relatives.
          const drilled = new Set(
            out.coverage?.sessionStops?.sessions.map((s) => s.sessionID) ?? [],
          );
          expect(drilled.has("a-r4") || drilled.has("a-r5")).toBe(false);
        },
      );

      it.each([{ match: "literal" }, { match: "smart" }])(
        "does not prefer a relative the lookup found only in its delegated prompt ($match)",
        async ({ match }) => {
          const { tool, deps } = await recallOver(needleHarness({ echo: true }));
          const ranked = deps.cards.rank(parseQuery(args.query), {}).map((hit) => hit.sessionId);
          expect(ranked).not.toContain("a-echo");

          const out = await runTool<SearchOutput>(
            tool,
            { ...args, match },
            makeContext({ sessionID: "a-root" }).ctx,
          );
          // The family's four slots go to a-needle and three card-ranked
          // relatives, so a-echo's prompt is never drilled.
          expect(out.results[0]?.sessionID).toBe("a-needle");
          expect(sessionsOf(out)).not.toContain("a-echo");
        },
      );

      it("takes the oldest message read for the session's own text when the read stopped at the row cap", async () => {
        const { tool, deps } = await recallOver(needleHarness({ echo: true }));
        // An opencode v2 write that stopped at the per-session row cap records
        // the lowest seq it read as the checkpoint's floor, so the message
        // with no previous one in the index is not the session's first.
        const card = deps.store!.getCard("a-echo")!;
        deps.store!.upsertCard({
          ...card,
          distillCursor: JSON.stringify({
            v: 2,
            seq: 40,
            unsettled: null,
            msgUpdated: 1,
            sessKey: 1,
            msgId: null,
            parts: 0,
            partsUpdated: 0,
            fp: "fp",
            floor: 30,
          }),
        });

        const out = await runTool<SearchOutput>(
          tool,
          { ...args, match: "literal" },
          makeContext({ sessionID: "a-root" }).ctx,
        );
        // a-echo now counts as found, so it keeps a drill slot and its match
        // is returned.
        expect(sessionsOf(out)).toContain("a-echo");
        expect(sessionsOf(out)).toContain("a-needle");
      });
    });

    describe("a plain-word query", () => {
      /** p-root (the caller) has two subagents whose only match is in a
       *  tool's error output, which their cards hold and the slim index does
       *  not, and a third, p-echo, whose reply restates the query in a
       *  message its card's opening and closing statements leave out; the
       *  code tokens it mentions more often fill its card's inventory, so
       *  only the slim index matches it. */
      function plainHarness(): FakeHarness {
        const filler = Array.from(
          { length: 200 },
          (_, i) => `p_${String(i).padStart(3, "0")}`,
        ).join(" ");
        const h = makeFakeHarness();
        addSession(h, { id: "p-root", title: "Gateway work", ago: 120, user: "Split the work." });
        for (const i of [1, 2]) {
          const id = `p-r${i}`;
          const updated = NOW - (10 + i) * MINUTE;
          const s = session(
            id,
            `Relay provider timeout fix ${i}`,
            PROJECT_DIR,
            updated,
            undefined,
            "p-root",
          );
          h.sessions.push(s);
          h.globalSessions.push(globalSessionFrom(s));
          h.messagesBySession[id] = [
            bundle(userMessage(`m-${id}-u`, id, updated - 2_000), [
              textPart(`p-${id}-u`, id, `m-${id}-u`, "Fix the gateway."),
            ]),
            bundle(assistantMessage(`m-${id}-a`, id, updated - 1_000), [
              errorToolPart(
                `p-${id}-a`,
                id,
                `m-${id}-a`,
                "bash",
                { command: "make check" },
                "relay provider timeout after 30s",
              ),
            ]),
          ];
        }
        const echoAt = NOW - 100 * MINUTE;
        const echo = session(
          "p-echo",
          "Delegated lookup",
          PROJECT_DIR,
          echoAt,
          undefined,
          "p-root",
        );
        h.sessions.push(echo);
        h.globalSessions.push(globalSessionFrom(echo));
        h.messagesBySession[echo.id] = [
          bundle(userMessage("m-echo-1", echo.id, echoAt - 3_000), [
            textPart("p-echo-1", echo.id, "m-echo-1", "Check the edge proxies first."),
          ]),
          bundle(assistantMessage("m-echo-2", echo.id, echoAt - 2_000), [
            textPart(
              "p-echo-2",
              echo.id,
              "m-echo-2",
              "Looking for the relay provider timeout setting.",
            ),
          ]),
          bundle(assistantMessage("m-echo-3", echo.id, echoAt - 1_000), [
            reasoningPart("p-echo-3r", echo.id, "m-echo-3", `Checked ${filler}`),
            textPart("p-echo-3", echo.id, "m-echo-3", `Checked ${filler}`),
          ]),
        ];
        addSession(h, {
          id: "p-out",
          title: "Ops log",
          ago: 90,
          reply: "Noted the relay timing next to the queue depth and the worker counts.",
        });
        return h;
      }

      it("keeps the card-ranked relatives ahead of a reply restating the query", async () => {
        const { tool, deps } = await recallOver(plainHarness());
        const query = "relay provider timeout";
        const ranked = deps.cards.rank(parseQuery(query), {}).map((hit) => hit.sessionId);
        // The cards rank both failing subagents; only the slim index finds the echo.
        expect(ranked).toContain("p-r1");
        expect(ranked).toContain("p-r2");
        expect(ranked).not.toContain("p-echo");

        // Three drill slots, of which the family may take two.
        const out = await runTool<SearchOutput>(
          tool,
          { query, match: "smart", group: "session", sessionLimit: 3 },
          makeContext({ sessionID: "p-root" }).ctx,
        );
        expect(out.coverage?.sessionsSearched).toBe(3);
        expect(sessionsOf(out)).toEqual(expect.arrayContaining(["p-r1", "p-r2"]));
        expect(sessionsOf(out)).not.toContain("p-echo");
      });
    });
  });
});
