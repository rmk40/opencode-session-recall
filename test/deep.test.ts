import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { search } from "../src/search.js";
import { createFetchGate, type FetchGate } from "../src/fetch-gate.js";
import { encodeDeepCursor } from "../src/drill.js";
import type { ErrorOutput, Limits, SearchOutput } from "../src/types.js";
import {
  PROJECT_DIR,
  TEST_LIMITS,
  assistantMessage,
  bundle,
  completedToolPart,
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

// Deep mode is the only path allowed to make unbounded (whole-session) sweeps,
// so it fetches with a limit but keeps paging — strict no-limit mode stays ON to
// prove even deep never issues a limit-less fetch.
beforeAll(() => setStrictNoLimitMessages(true));
afterAll(() => setStrictNoLimitMessages(false));

const NOW = Date.now();

/** Add a session (project + global lists + messages) to an existing harness. */
function addSession(
  h: FakeHarness,
  s: ReturnType<typeof session>,
  messages: {
    info: import("@opencode-ai/sdk/v2").Message;
    parts: import("@opencode-ai/sdk/v2").Part[];
  }[],
): void {
  h.sessions.push(s);
  h.globalSessions.push(globalSessionFrom(s));
  h.messagesBySession[s.id] = messages;
}

async function recallDeps(h: FakeHarness, limits: Limits, gate?: FetchGate) {
  return makeRecallDeps(h, limits, gate ? { gate } : {});
}

// ── Scope gate ───────────────────────────────────────────────────────────────

describe("deep scope validation", () => {
  it("rejects a global unscoped deep with guidance", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await makeRecallDeps(h);
    try {
      const recall = search(h.client, h.unscoped, true, TEST_LIMITS, deps);
      const out = await runTool<ErrorOutput>(recall, {
        query: "anything",
        deep: true,
        scope: "global",
      });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/deep requires scope/i);
      expect(out.error).toMatch(/sessions/i);
    } finally {
      cleanup();
    }
  });

  it("accepts deep with an explicit sessions list", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await makeRecallDeps(h);
    try {
      const recall = search(h.client, h.unscoped, true, TEST_LIMITS, deps);
      const out = await runTool<SearchOutput>(recall, {
        query: "rate",
        deep: true,
        sessions: ["s-project-2"],
      });
      expect(out.ok).toBe(true);
      expect(out.coverage?.deep).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("accepts deep with since + a project/directory constraint", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await makeRecallDeps(h);
    try {
      const recall = search(h.client, h.unscoped, true, TEST_LIMITS, deps);
      const out = await runTool<SearchOutput>(recall, {
        query: "rate",
        deep: true,
        since: "30d",
        project: true,
      });
      expect(out.ok).toBe(true);
      expect(out.coverage?.deep).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("rejects a malformed deepCursor with guidance (never throws)", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await makeRecallDeps(h);
    try {
      const recall = search(h.client, h.unscoped, true, TEST_LIMITS, deps);
      const garbage = await runTool<ErrorOutput>(recall, {
        query: "rate",
        deepCursor: "!!!not-a-valid-cursor!!!",
      });
      expect(garbage.ok).toBe(false);
      expect(garbage.error).toMatch(/deepCursor is malformed/i);

      // Valid base64url, but wrong JSON shape → still a clean rejection.
      const wrongShape = await runTool<ErrorOutput>(recall, {
        query: "rate",
        deepCursor: Buffer.from(JSON.stringify({ v: 2 })).toString("base64url"),
      });
      expect(wrongShape.ok).toBe(false);
      expect(wrongShape.error).toMatch(/deepCursor is malformed/i);
    } finally {
      cleanup();
    }
  });

  it("sweeps an explicitly named session with no card yet (uncarded shortlist member)", async () => {
    const h = makeFakeHarness();
    // Seed the store from the current fixture FIRST, then add the session:
    // messages exist on the fake client, but no card — the young-session window.
    const { deps, cleanup } = await makeRecallDeps(h);
    const young = session("s-deep-young", "Deep Young", PROJECT_DIR, NOW - 1_000);
    addSession(h, young, [
      bundle(assistantMessage("m-deep-young-1", young.id, NOW - 2_000), [
        completedToolPart(
          "p-deep-young-1",
          young.id,
          "m-deep-young-1",
          "bash",
          { command: "run" },
          "output-only crunkleberry needle",
        ),
      ]),
    ]);
    try {
      const recall = search(h.client, h.unscoped, true, TEST_LIMITS, deps);
      const out = await runTool<SearchOutput>(recall, {
        query: "crunkleberry",
        deep: true,
        sessions: ["s-deep-young"],
      });
      expect(out.ok).toBe(true);
      expect(out.coverage?.deep?.sessionsCovered).toBe(1);
      expect(out.coverage?.sessionsEligible).toBe(1);
      expect(out.results.some((r) => r.sessionID === "s-deep-young")).toBe(true);
      expect(out.warnings?.some((w) => /no card yet .*selected for direct drilling/i.test(w))).toBe(
        true,
      );
    } finally {
      cleanup();
    }
  });

  it("deep: skips an uncarded member excluded by excludeSessionID or excludeCurrentSession", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await makeRecallDeps(h);
    const young = session("s-deep-excl", "Deep Excluded", PROJECT_DIR, NOW - 1_000);
    addSession(h, young, [
      bundle(userMessage("m-deep-excl-1", young.id, NOW - 2_000), [
        textPart("p-deep-excl-1", young.id, "m-deep-excl-1", "murkfen only here"),
      ]),
    ]);
    try {
      const recall = search(h.client, h.unscoped, true, TEST_LIMITS, deps);
      const excluded = await runTool<SearchOutput>(recall, {
        query: "murkfen",
        deep: true,
        sessions: ["s-deep-excl"],
        excludeSessionID: "s-deep-excl",
      });
      expect(excluded.ok).toBe(true);
      expect(excluded.results.some((r) => r.sessionID === "s-deep-excl")).toBe(false);
      expect(excluded.coverage?.sessionsSearched).toBe(0);

      const { ctx } = makeContext({ sessionID: "s-deep-excl" });
      const currentExcluded = await runTool<SearchOutput>(
        recall,
        {
          query: "murkfen",
          deep: true,
          sessions: ["s-deep-excl"],
          excludeCurrentSession: true,
        },
        ctx,
      );
      expect(currentExcluded.ok).toBe(true);
      expect(currentExcluded.results.some((r) => r.sessionID === "s-deep-excl")).toBe(false);
      expect(currentExcluded.coverage?.sessionsSearched).toBe(0);
    } finally {
      cleanup();
    }
  });
});

// ── Output-only needle: the honest-miss pair ─────────────────────────────────

describe("deep finds output-only needles that non-deep honestly misses", () => {
  // A needle that lives ONLY in a tool OUTPUT (never in text/reasoning/tool
  // input), so the card inventory and the slim FTS index do not carry it.
  const NEEDLE = "needlexyztoken";

  function buildHarness(): FakeHarness {
    const h = makeFakeHarness();
    const deepSession = session(
      "s-deep-needle",
      "Pipeline investigation",
      PROJECT_DIR,
      NOW - 100_000,
    );
    addSession(h, deepSession, [
      bundle(userMessage("m-deep-1", deepSession.id, NOW - 100_500), [
        textPart("p-deep-1", deepSession.id, "m-deep-1", "please investigate the deploy pipeline"),
      ]),
      bundle(assistantMessage("m-deep-2", deepSession.id, NOW - 100_400), [
        completedToolPart(
          "p-deep-2",
          deepSession.id,
          "m-deep-2",
          "bash",
          { command: "run pipeline" },
          `pipeline log output contains ${NEEDLE} at line 5`,
        ),
      ]),
    ]);
    // A newer, needle-free session so the capped non-deep drill lands here.
    const newer = session("s-newer", "Newest unrelated", PROJECT_DIR, NOW - 1_000);
    addSession(h, newer, [
      bundle(userMessage("m-new-1", newer.id, NOW - 1_500), [
        textPart("p-new-1", newer.id, "m-new-1", "unrelated newest session about widgets"),
      ]),
    ]);
    return h;
  }

  it("non-deep smart misses the output-only needle; deep finds it", async () => {
    const h = buildHarness();
    // Cap the non-deep drill fan-out to 1 so it drills the newest (needle-free)
    // near-miss and never reaches s-deep-needle — the honest miss.
    const limits: Limits = { ...TEST_LIMITS, drillSessions: 1 };
    const { deps, cleanup } = await recallDeps(h, limits);
    try {
      const recall = search(h.client, h.unscoped, true, limits, deps);

      const shallow = await runTool<SearchOutput>(recall, {
        query: NEEDLE,
        match: "smart",
        group: "session",
        excludeCurrentSession: false,
      });
      expect(shallow.ok).toBe(true);
      expect(shallow.results.some((r) => r.sessionID === "s-deep-needle")).toBe(false);
      expect(JSON.stringify(shallow.results)).not.toContain(NEEDLE);

      const deep = await runTool<SearchOutput>(recall, {
        query: NEEDLE,
        match: "smart",
        group: "session",
        deep: true,
        sessions: ["s-deep-needle"],
      });
      expect(deep.ok).toBe(true);
      expect(deep.results.some((r) => r.sessionID === "s-deep-needle")).toBe(true);
      // The coverage block states deep's honest scope.
      expect(deep.coverage?.deep?.sessionsCovered).toBe(1);
      expect(deep.warnings?.some((w) => /Deep sweep searched tool outputs/i.test(w))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("accepts an explicit sessionID as deep scope (sessions:[that id])", async () => {
    const h = buildHarness();
    const { deps, cleanup } = await recallDeps(h, TEST_LIMITS);
    try {
      const recall = search(h.client, h.unscoped, true, TEST_LIMITS, deps);
      const out = await runTool<SearchOutput>(recall, {
        query: NEEDLE,
        match: "smart",
        group: "session",
        deep: true,
        sessionID: "s-deep-needle",
      });
      expect(out.ok).toBe(true);
      expect(out.results.some((r) => r.sessionID === "s-deep-needle")).toBe(true);
      expect(out.coverage?.deep?.sessionsCovered).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("routes every deep fetch through the shared gate", async () => {
    const h = buildHarness();
    const real = createFetchGate({ concurrency: 4 });
    let queries = 0;
    const spy: FetchGate = {
      runQuery: (fn) => {
        queries++;
        return real.runQuery(fn);
      },
      runBackground: (fn) => real.runBackground(fn),
      activeQueries: () => real.activeQueries(),
    };
    const { deps, cleanup } = await recallDeps(h, TEST_LIMITS, spy);
    try {
      const recall = search(h.client, h.unscoped, true, TEST_LIMITS, deps);
      await runTool<SearchOutput>(recall, {
        query: NEEDLE,
        deep: true,
        sessions: ["s-deep-needle"],
      });
      expect(queries).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});

// ── Budget stop + cursor continuation ────────────────────────────────────────

describe("deep budget stop and cursor continuation", () => {
  const SHARED = "sharedterm";

  function buildHarness(): { h: FakeHarness; ids: string[] } {
    const h = makeFakeHarness();
    const ids: string[] = [];
    // Three equal-sized sessions, newest-first sA > sB > sC. Each holds ~311
    // retained chars, so a 400-char per-query budget covers exactly two before
    // stopping (311 < 400 < 622).
    const specs: Array<[string, number]> = [
      ["s-deepA", NOW - 10_000],
      ["s-deepB", NOW - 20_000],
      ["s-deepC", NOW - 30_000],
    ];
    for (const [id, updated] of specs) {
      const s = session(id, `Deep ${id}`, PROJECT_DIR, updated);
      addSession(h, s, [
        bundle(userMessage(`${id}-m1`, id, updated - 500), [
          textPart(`${id}-p1`, id, `${id}-m1`, `${SHARED} ${"x".repeat(300)}`),
        ]),
      ]);
      ids.push(id);
    }
    return { h, ids };
  }

  it("covers two sessions, emits a cursor, and resumes on the third", async () => {
    const { h, ids } = buildHarness();
    const limits: Limits = { ...TEST_LIMITS, deepCharsPerQuery: 400 };
    const { deps, cleanup } = await recallDeps(h, limits);
    try {
      const recall = search(h.client, h.unscoped, true, limits, deps);

      const first = await runTool<SearchOutput>(recall, {
        query: SHARED,
        match: "literal",
        group: "session",
        deep: true,
        sessions: ids,
      });
      expect(first.ok).toBe(true);
      expect(first.coverage?.deep?.sessionsCovered).toBe(2);
      expect(first.coverage?.deep?.sessionsRemaining).toBe(1);
      expect(first.coverage?.deep?.exhaustedBudget).toBe(true);
      expect(first.nextCursor).toBeDefined();
      const firstSessions = new Set(first.results.map((r) => r.sessionID));
      expect(firstSessions.has("s-deepA")).toBe(true);
      expect(firstSessions.has("s-deepB")).toBe(true);
      expect(firstSessions.has("s-deepC")).toBe(false);

      // Resume: the cursor picks up exactly at the third session.
      const second = await runTool<SearchOutput>(recall, {
        query: SHARED,
        match: "literal",
        group: "session",
        deepCursor: first.nextCursor,
      });
      expect(second.ok).toBe(true);
      expect(second.coverage?.deep?.sessionsCovered).toBe(1);
      expect(second.coverage?.deep?.sessionsRemaining).toBe(0);
      expect(second.nextCursor).toBeUndefined();
      const secondSessions = new Set(second.results.map((r) => r.sessionID));
      expect(secondSessions.has("s-deepC")).toBe(true);
      expect(secondSessions.has("s-deepA")).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("stops cleanly on the wall-clock budget between pages", async () => {
    const { h, ids } = buildHarness();
    // A clock that jumps past the wall-clock budget after the first read, so the
    // sweep stops between sessions and hands back a cursor.
    let ticks = 0;
    const clock = () => NOW + (ticks++ === 0 ? 0 : 10_000);
    const { deps, cleanup } = await makeRecallDeps(h, TEST_LIMITS, {
      now: clock,
      deepWallClockMs: 100,
    });
    try {
      const recall = search(h.client, h.unscoped, true, TEST_LIMITS, deps);
      const out = await runTool<SearchOutput>(recall, {
        query: SHARED,
        match: "literal",
        deep: true,
        sessions: ids,
      });
      expect(out.ok).toBe(true);
      expect(out.coverage?.deep?.exhaustedBudget).toBe(true);
      expect(out.coverage?.deep?.sessionsRemaining).toBeGreaterThan(0);
      expect(out.nextCursor).toBeDefined();
    } finally {
      cleanup();
    }
  });
});

// ── Zod-bypass coercion (AGENTS.md host path) ────────────────────────────────

describe("deep args survive the Zod-bypass host path", () => {
  it("coerces raw deep/sessions/deepCursor without throwing", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await makeRecallDeps(h);
    try {
      const recall = search(h.client, h.unscoped, true, TEST_LIMITS, deps);

      // Raw boolean + raw array forwarded straight through (no Zod defaults).
      const raw = await runToolRaw<SearchOutput>(recall, {
        query: "rate",
        deep: true,
        sessions: ["s-project-2", "  ", 123],
      });
      expect(raw.ok).toBe(true);
      expect(raw.coverage?.deep).toBeDefined();

      // A non-string deepCursor must not be treated as a cursor (coerced away),
      // so this is a plain non-deep search, not a malformed-cursor rejection.
      const nonStringCursor = await runToolRaw<SearchOutput>(recall, {
        query: "rate",
        deepCursor: 42,
      });
      expect(nonStringCursor.ok).toBe(true);
      expect(nonStringCursor.coverage?.deep).toBeUndefined();

      // A raw malformed cursor string is still rejected cleanly.
      const bad = await runToolRaw<ErrorOutput>(recall, {
        query: "rate",
        deepCursor: "@@@garbage@@@",
      });
      expect(bad.ok).toBe(false);
      expect(bad.error).toMatch(/deepCursor is malformed/i);
    } finally {
      cleanup();
    }
  });
});

// ── Cursor hardening on resume ───────────────────────────────────────────────

describe("deep cursor hardening", () => {
  it("drops unknown ids with a warning and proceeds with known ids", async () => {
    // A well-formed cursor is still untrusted: known ids sweep, unknown ids are
    // dropped and reported. Resume stays stateless (the cursor is all we carry).
    const encoded = encodeDeepCursor({
      v: 1,
      remaining: ["s-unknown-xyz"],
      current: "s-project-2",
      before: null,
    });
    expect(encoded).not.toMatch(/[+/=]/); // url-safe, unpadded
    const h = makeFakeHarness();
    const { deps, cleanup } = await makeRecallDeps(h);
    try {
      const recall = search(h.client, h.unscoped, true, TEST_LIMITS, deps);
      const out = await runTool<SearchOutput>(recall, { query: "rate", deepCursor: encoded });
      expect(out.ok).toBe(true);
      // s-project-2 is a known card → swept; the unknown id is dropped.
      expect(out.coverage?.deep?.sessionsCovered).toBe(1);
      expect(out.warnings?.some((w) => /Deep resume dropped 1 session id/i.test(w))).toBe(true);
      expect(out.warnings?.some((w) => /s-unknown-xyz/.test(w))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
