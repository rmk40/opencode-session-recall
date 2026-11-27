import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Part } from "@opencode-ai/sdk/v2";
import { search } from "../src/search.js";
import type { SearchOutput } from "../src/types.js";
import {
  PROJECT_DIR,
  TEST_LIMITS,
  assistantMessage,
  bundle,
  globalSessionFrom,
  makeFakeHarness,
  makeRecallDeps,
  reasoningPart,
  runTool,
  session,
  setStrictNoLimitMessages,
  textPart,
  type FakeHarness,
} from "./helpers.js";

/**
 * A time-bounded search selects the sessions that overlap its window: one
 * last updated at or after the lower bound and created at or before the upper
 * one, so a session that kept running past the window is still searched. Each
 * test isolates one selection lane: the slim-index lane of a ranked search,
 * the metadata probe of a named session without a card, and the listing of a
 * deep sweep.
 */

beforeAll(() => setStrictNoLimitMessages(true));
afterAll(() => setStrictNoLimitMessages(false));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The window, well before the fixture's own sessions. */
const AFTER = Date.now() - 10 * 86_400_000;
const BEFORE = AFTER + 86_400_000;

/** A session created at `created` and last updated at `updated`, holding
 *  one message at each of `at` built by `part`. */
function addSession(
  h: FakeHarness,
  id: string,
  title: string,
  created: number,
  updated: number,
  messages: Array<{ at: number; part: (messageID: string) => Part }>,
): void {
  const s = session(id, title, PROJECT_DIR, updated);
  s.time.created = created;
  h.sessions.push(s);
  h.globalSessions.push(globalSessionFrom(s));
  h.messagesBySession[id] = messages.map(({ at, part }, i) => {
    const messageID = `m-${id}-${i + 1}`;
    return bundle(assistantMessage(messageID, id, at), [part(messageID)]);
  });
}

const reasoning =
  (id: string, text: string) =>
  (messageID: string): Part =>
    reasoningPart(`p-${messageID}`, id, messageID, text);
const text =
  (id: string, body: string) =>
  (messageID: string): Part =>
    textPart(`p-${messageID}`, id, messageID, body);

/** Sessions whose history the search read, in first-read order. */
const drilled = (h: FakeHarness): string[] => [
  ...new Set(h.calls.messages.map((c) => c.sessionID)),
];

describe("time-bounded session selection", () => {
  it("admits a session from the slim index when it overlaps the window", async () => {
    // The phrase sits only in reasoning parts, which no card holds, so the
    // decoy's title is the one card that ranks and every other session can
    // only arrive through the slim index.
    const h = makeFakeHarness();
    const needle = "The zorvanqix eviction stalls under load.";
    addSession(h, "s-decoy", "Zorvanqix decoy notes", AFTER + 1_000, AFTER + 2_000, [
      { at: AFTER + 1_500, part: text("s-decoy", "unrelated chatter") },
    ]);
    addSession(h, "s-ran-past", "Queue work", AFTER + 1_000, BEFORE + 50_000, [
      { at: AFTER + 2_000, part: reasoning("s-ran-past", needle) },
      { at: BEFORE + 40_000, part: text("s-ran-past", "later work on other things") },
    ]);
    addSession(h, "s-created-at-before", "Queue start", BEFORE, BEFORE + 5_000, [
      { at: BEFORE + 100, part: reasoning("s-created-at-before", needle) },
    ]);
    addSession(h, "s-updated-at-after", "Queue end", AFTER - 5_000, AFTER, [
      { at: AFTER - 100, part: reasoning("s-updated-at-after", needle) },
    ]);
    addSession(h, "s-after", "Queue later", BEFORE + 1, BEFORE + 9_000, [
      { at: BEFORE + 2_000, part: reasoning("s-after", needle) },
    ]);
    addSession(h, "s-before", "Queue earlier", AFTER - 9_000, AFTER - 1, [
      { at: AFTER - 5_000, part: reasoning("s-before", needle) },
    ]);
    const { deps, cleanup } = await makeRecallDeps(h);
    cleanups.push(cleanup);

    const out = await runTool<SearchOutput>(search(h.source, true, TEST_LIMITS, deps), {
      query: '"zorvanqix eviction"',
      match: "smart",
      scope: "global",
      after: AFTER,
      before: BEFORE,
    });
    expect(out.ok).toBe(true);
    expect(drilled(h).sort()).toEqual([
      "s-created-at-before",
      "s-decoy",
      "s-ran-past",
      "s-updated-at-after",
    ]);
    expect(out.results.map((r) => r.sessionID)).toContain("s-ran-past");
  });

  it("drills a named session without a card when its live metadata overlaps the window", async () => {
    const h = makeFakeHarness();
    // Seeded first, so none of the sessions added below has a card.
    const { deps, cleanup } = await makeRecallDeps(h);
    cleanups.push(cleanup);
    const needle = "quillorbent needle";
    addSession(h, "s-ran-past", "Ran past", AFTER + 1_000, BEFORE + 50_000, [
      { at: AFTER + 2_000, part: text("s-ran-past", needle) },
      { at: BEFORE + 40_000, part: text("s-ran-past", "later work on other things") },
    ]);
    addSession(h, "s-created-at-before", "Created at before", BEFORE, BEFORE + 5_000, [
      { at: BEFORE + 100, part: text("s-created-at-before", needle) },
    ]);
    addSession(h, "s-updated-at-after", "Updated at after", AFTER - 5_000, AFTER, [
      { at: AFTER - 100, part: text("s-updated-at-after", needle) },
    ]);
    addSession(h, "s-after", "After", BEFORE + 1, BEFORE + 9_000, [
      { at: BEFORE + 2_000, part: text("s-after", needle) },
    ]);
    addSession(h, "s-before", "Before", AFTER - 9_000, AFTER - 1, [
      { at: AFTER - 5_000, part: text("s-before", needle) },
    ]);

    const out = await runTool<SearchOutput>(search(h.source, true, TEST_LIMITS, deps), {
      query: "quillorbent",
      sessions: ["s-ran-past", "s-created-at-before", "s-updated-at-after", "s-after", "s-before"],
      after: AFTER,
      before: BEFORE,
    });
    expect(out.ok).toBe(true);
    expect(out.coverage?.sessionsEligible).toBe(3);
    expect(drilled(h).sort()).toEqual(["s-created-at-before", "s-ran-past", "s-updated-at-after"]);
    expect(new Set(out.results.map((r) => r.sessionID))).toEqual(new Set(["s-ran-past"]));
    expect(out.warnings?.some((w) => /could not be verified/.test(w))).toBeFalsy();
  });

  it("sweeps a project session in deep mode when it overlaps the window", async () => {
    const h = makeFakeHarness();
    addSession(h, "s-ran-past", "Ran past", AFTER + 1_000, BEFORE + 50_000, [
      {
        at: AFTER + 2_000,
        part: text("s-ran-past", "ownsNone returned false for a shared project"),
      },
      { at: BEFORE + 40_000, part: text("s-ran-past", "later work on other things") },
    ]);
    addSession(h, "s-after", "After", BEFORE + 1, BEFORE + 9_000, [
      { at: BEFORE + 2_000, part: text("s-after", "ownsNone after the window") },
    ]);
    addSession(h, "s-before", "Before", AFTER - 9_000, AFTER - 1, [
      { at: AFTER - 5_000, part: text("s-before", "ownsNone before the window") },
    ]);
    const { deps, cleanup } = await makeRecallDeps(h);
    cleanups.push(cleanup);

    const out = await runTool<SearchOutput>(search(h.source, true, TEST_LIMITS, deps), {
      query: "ownsNone",
      deep: true,
      project: true,
      after: AFTER,
      before: BEFORE,
    });
    expect(out.ok).toBe(true);
    expect(drilled(h)).toEqual(["s-ran-past"]);
    expect(new Set(out.results.map((r) => r.sessionID))).toEqual(new Set(["s-ran-past"]));
  });
});
