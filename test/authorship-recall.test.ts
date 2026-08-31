import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@opencode-ai/plugin";
import type { Part, Session } from "@opencode-ai/sdk/v2";
import { search } from "../src/search.js";
import { deriveCard, type DistillSessionMeta } from "../src/distill.js";
import type { Store } from "../src/store.js";
import type { Drill } from "../src/drill.js";
import type { SearchOutput } from "../src/types.js";
import {
  OTHER_DIR,
  PROJECT_DIR,
  TEST_LIMITS,
  assistantMessage,
  bundle,
  completedToolPart,
  globalSessionFrom,
  makeContext,
  makeFakeHarness,
  makeRecallDeps,
  makeStoreNullDeps,
  runTool,
  runToolRaw,
  session,
  setStrictNoLimitMessages,
  subtaskPart,
  textPart,
  userMessage,
  type FakeHarness,
  type FakeOptions,
} from "./helpers.js";

// No search path may make an unpaginated session.messages call.
beforeAll(() => setStrictNoLimitMessages(true));
afterAll(() => setStrictNoLimitMessages(false));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const NOW = Date.now();

/** A text part carrying the host authorship flags the SDK declares on TextPart. */
function flaggedTextPart(
  id: string,
  sessionID: string,
  messageID: string,
  text: string,
  flags: { synthetic?: boolean; ignored?: boolean },
): Part {
  return { id, sessionID, messageID, type: "text", text, ...flags };
}

function addSession(
  h: FakeHarness,
  id: string,
  title: string,
  updated: number,
  parentID?: string,
): Session {
  const s = session(id, title, PROJECT_DIR, updated, undefined, parentID);
  h.sessions.push(s);
  h.globalSessions.push(globalSessionFrom(s));
  h.messagesBySession[id] = [];
  return s;
}

/**
 * The authorship corpus. One root session with a human prompt, one child
 * session whose "user" is an orchestrating agent, one root session carrying
 * host-flagged parts, and one root session holding the parent-side `subtask`
 * part. Every text carries the same needle so a single query reaches all of
 * them and only authorship separates the buckets.
 */
function makeAuthorshipHarness(options: FakeOptions = {}): FakeHarness {
  const h = makeFakeHarness(options);

  addSession(h, "s-root-human", "Rootward Planning", NOW - 10_000);
  h.messagesBySession["s-root-human"] = [
    bundle(userMessage("m-rh-1", "s-root-human", NOW - 11_000), [
      textPart("p-rh-1", "s-root-human", "m-rh-1", "quarkbeam requirement typed by a person"),
    ]),
    bundle(assistantMessage("m-rh-2", "s-root-human", NOW - 10_500), [
      textPart("p-rh-2", "s-root-human", "m-rh-2", "quarkbeam answer written by the model"),
    ]),
  ];

  addSession(h, "s-child-agent", "Delegated Review", NOW - 9_000, "s-root-human");
  h.messagesBySession["s-child-agent"] = [
    bundle(userMessage("m-ca-1", "s-child-agent", NOW - 9_500), [
      textPart(
        "p-ca-1",
        "s-child-agent",
        "m-ca-1",
        "quarkbeam instruction composed by the orchestrating agent",
      ),
    ]),
  ];

  addSession(h, "s-flags", "Flagged Parts", NOW - 8_000);
  h.messagesBySession["s-flags"] = [
    bundle(userMessage("m-fl-1", "s-flags", NOW - 8_500), [
      textPart("p-fl-plain", "s-flags", "m-fl-1", "quarkbeam typed alongside an attachment"),
      flaggedTextPart("p-fl-synthetic", "s-flags", "m-fl-1", "quarkbeam expanded attachment body", {
        synthetic: true,
      }),
      flaggedTextPart("p-fl-ignored", "s-flags", "m-fl-1", "quarkbeam tui status block", {
        ignored: true,
      }),
    ]),
  ];

  addSession(h, "s-subtask", "Subtask Holder", NOW - 7_000);
  h.messagesBySession["s-subtask"] = [
    bundle(assistantMessage("m-st-1", "s-subtask", NOW - 7_500), [
      subtaskPart(
        "p-st-1",
        "s-subtask",
        "m-st-1",
        "quarkbeam delegation",
        "quarkbeam prompt handed to the subagent",
      ),
    ]),
  ];

  return h;
}

async function setup(h: FakeHarness): Promise<{ recall: ToolDefinition; store: Store }> {
  const { deps, store, cleanup } = await makeRecallDeps(h, TEST_LIMITS);
  cleanups.push(cleanup);
  return { recall: search(h.client, h.unscoped, true, TEST_LIMITS, deps), store };
}

/**
 * Like {@link setup}, but wraps the drill so the SELECTED session set — what
 * tier 1 and tier 1.5 handed to tier 2, before any BM25 scoring — is
 * observable. The tool output only exposes counts, and results are a poor proxy
 * for the pool.
 */
async function setupWithDrillSpy(
  h: FakeHarness,
): Promise<{ recall: ToolDefinition; drilled: () => string[] }> {
  const { deps, cleanup } = await makeRecallDeps(h, TEST_LIMITS);
  cleanups.push(cleanup);
  const selected: string[] = [];
  const record = (input: { sessions: Array<{ sessionId: string }> }): void => {
    for (const target of input.sessions) selected.push(target.sessionId);
  };
  const inner = deps.drill;
  const spy: Drill = {
    drill: (input) => {
      record(input);
      return inner.drill(input);
    },
    pools: (input) => {
      record(input);
      return inner.pools(input);
    },
    deep: (input) => {
      record(input);
      return inner.deep(input);
    },
    cachedChars: () => inner.cachedChars(),
  };
  return {
    recall: search(h.client, h.unscoped, true, TEST_LIMITS, { ...deps, drill: spy }),
    drilled: () => [...new Set(selected)],
  };
}

/**
 * Freeze `Date.now` for the duration of `body`. BM25 applies a wall-clock
 * recency multiplier (`src/bm25.ts`), so two invocations a millisecond apart
 * produce scores that differ in the last few float digits. Byte-identity
 * comparisons therefore need a fixed clock; nothing here depends on timers
 * advancing.
 */
async function withFrozenClock<T>(body: () => Promise<T>): Promise<T> {
  const fixed = Date.now();
  const spy = vi.spyOn(Date, "now").mockReturnValue(fixed);
  try {
    return await body();
  } finally {
    spy.mockRestore();
  }
}

/** The (sessionID, partID) identity of every returned result. */
function ids(out: SearchOutput): string[] {
  return out.results.map((r) => `${r.sessionID}/${r.partID}`).sort();
}

function authorshipOfResult(out: SearchOutput, partID: string): string | undefined {
  return out.results.find((r) => r.partID === partID)?.why?.authorship;
}

// ── The classifier's buckets, end to end through the tool ────────────────────

describe("recall authorship filtering", () => {
  it('"human" keeps only root-session typed text — dropping delegated, injected, model and title', async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      authorship: "human",
    });
    expect(out.ok).toBe(true);
    expect(ids(out)).toEqual(["s-flags/p-fl-plain", "s-root-human/p-rh-1"]);
    for (const result of out.results) expect(result.why?.authorship).toBe("human");
  });

  it('"delegated" returns child-session prompts AND parent-side subtask parts', async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      authorship: "delegated",
    });
    expect(out.ok).toBe(true);
    // Deliberately both indexed locations of one delegation: the parent's
    // subtask part and the child session's user text.
    expect(ids(out)).toEqual(["s-child-agent/p-ca-1", "s-subtask/p-st-1"]);
    for (const result of out.results) expect(result.why?.authorship).toBe("delegated");
  });

  it('"injected" returns the synthetic and host-ignored user parts', async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      authorship: "injected",
    });
    expect(out.ok).toBe(true);
    expect(ids(out)).toEqual(["s-flags/p-fl-ignored", "s-flags/p-fl-synthetic"]);
  });

  it('"model" returns assistant text only', async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      authorship: "model",
    });
    expect(out.ok).toBe(true);
    expect(ids(out)).toEqual(["s-root-human/p-rh-2"]);
  });

  it("an array unions buckets", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      authorship: ["human", "model"],
    });
    expect(out.ok).toBe(true);
    expect(ids(out)).toEqual(["s-flags/p-fl-plain", "s-root-human/p-rh-1", "s-root-human/p-rh-2"]);
  });

  it("an attachment body classifies injected while the human's own prompt survives", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      explain: true,
    });
    expect(out.ok).toBe(true);
    // All three parts ride the SAME user message; only the flags separate them.
    expect(authorshipOfResult(out, "p-fl-plain")).toBe("human");
    expect(authorshipOfResult(out, "p-fl-synthetic")).toBe("injected");
    expect(authorshipOfResult(out, "p-fl-ignored")).toBe("injected");
  });

  it("filters the literal and regex routes too", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    const literal = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "literal",
      results: 50,
      authorship: "human",
    });
    expect(literal.ok).toBe(true);
    expect(ids(literal)).toEqual(["s-flags/p-fl-plain", "s-root-human/p-rh-1"]);
    for (const result of literal.results) expect(result.why?.authorship).toBe("human");

    const regex = await runTool<SearchOutput>(recall, {
      query: "quark\\w+",
      match: "regex",
      results: 50,
      authorship: "human",
    });
    expect(regex.ok).toBe(true);
    expect(ids(regex)).toEqual(["s-flags/p-fl-plain", "s-root-human/p-rh-1"]);
    for (const result of regex.results) expect(result.why?.authorship).toBe("human");
  });

  it("filters a deep sweep", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      deep: true,
      sessions: ["s-root-human", "s-child-agent", "s-flags", "s-subtask"],
      authorship: "human",
    });
    expect(out.ok).toBe(true);
    expect(ids(out)).toEqual(["s-flags/p-fl-plain", "s-root-human/p-rh-1"]);
  });
});

// ── Title selection (the r4 ordering fix) ────────────────────────────────────
// The title candidate is DERIVED from the eligible pool, so the authorship pass
// has to run after title construction — otherwise authorship:"title" returns
// nothing on every session.

describe("title candidates under authorship", () => {
  function titleOnlyHarness(): FakeHarness {
    const h = makeFakeHarness();
    addSession(h, "s-titled", "Zorpglide Investigation", NOW - 6_000);
    h.messagesBySession["s-titled"] = [
      bundle(userMessage("m-ti-1", "s-titled", NOW - 6_500), [
        textPart("p-ti-1", "s-titled", "m-ti-1", "content that never mentions the needle"),
      ]),
    ];
    return h;
  }

  // Literal mode, deliberately: in smart mode every candidate in a session
  // carries the session title in its indexed `titleText`, so a title-word query
  // also hits the session's content. A literal scan matches `fieldTexts`, where
  // only the title candidate carries the title — which is what makes this a
  // genuinely title-only hit.
  it('returns the title under "any"', async () => {
    const { recall } = await setup(titleOnlyHarness());
    const out = await runTool<SearchOutput>(recall, { query: "zorpglide", match: "literal" });
    expect(out.ok).toBe(true);
    expect(out.results.some((r) => r.source === "title")).toBe(true);
  });

  it('returns the title under authorship:"title" — it is selectable, not merely suppressed', async () => {
    const { recall } = await setup(titleOnlyHarness());
    const out = await runTool<SearchOutput>(recall, {
      query: "zorpglide",
      match: "literal",
      authorship: "title",
    });
    expect(out.ok).toBe(true);
    const titles = out.results.filter((r) => r.source === "title");
    expect(titles.length).toBeGreaterThan(0);
    for (const result of out.results) expect(result.why?.authorship).toBe("title");
  });

  it('returns nothing under authorship:"human" when the only hit would be a title', async () => {
    const { recall } = await setup(titleOnlyHarness());
    const out = await runTool<SearchOutput>(recall, {
      query: "zorpglide",
      match: "literal",
      authorship: "human",
    });
    expect(out.ok).toBe(true);
    expect(out.results).toEqual([]);
  });

  it('keeps BOTH buckets under authorship:["human","title"]', async () => {
    // A fixture where a literal query matches the session title AND a human
    // text part, so a regression that collapsed the union to {human} would drop
    // the title result and fail here.
    const h = makeFakeHarness();
    addSession(h, "s-both", "Zorpglide Investigation", NOW - 6_000);
    h.messagesBySession["s-both"] = [
      bundle(userMessage("m-bo-1", "s-both", NOW - 6_500), [
        textPart("p-bo-1", "s-both", "m-bo-1", "zorpglide typed by a person"),
      ]),
      bundle(assistantMessage("m-bo-2", "s-both", NOW - 6_400), [
        textPart("p-bo-2", "s-both", "m-bo-2", "zorpglide answered by the model"),
      ]),
    ];
    const { recall } = await setup(h);

    const out = await runTool<SearchOutput>(recall, {
      query: "zorpglide",
      match: "literal",
      results: 50,
      authorship: ["human", "title"],
    });
    expect(out.ok).toBe(true);
    const buckets = out.results.map((r) => r.why?.authorship);
    expect(buckets).toContain("human");
    expect(buckets).toContain("title");
    // And the model answer, which matches the same literal, is excluded.
    expect(out.results.some((r) => r.partID === "p-bo-2")).toBe(false);
    for (const bucket of buckets) expect(["human", "title"]).toContain(bucket);
  });
});

// ── Parentage plumbing: all six DrillTarget construction sites ───────────────

describe("parentage plumbing", () => {
  it("tier-1 ranking branch (the DEFAULT path) reads parentage from the card", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);
    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      explain: true,
    });
    expect(out.ok).toBe(true);
    // Root card → null → human; child card → parent id → delegated. Both
    // targets are built inline in the tier-1 branch, not via registerTarget.
    expect(authorshipOfResult(out, "p-rh-1")).toBe("human");
    expect(authorshipOfResult(out, "p-ca-1")).toBe("delegated");
  });

  it("registerTarget (explicit shortlist) reads parentage from the card", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);
    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      explain: true,
      sessions: ["s-root-human", "s-child-agent"],
    });
    expect(out.ok).toBe(true);
    expect(authorshipOfResult(out, "p-rh-1")).toBe("human");
    expect(authorshipOfResult(out, "p-ca-1")).toBe("delegated");
  });

  it("the single-target branch reads parentage from the live session fetch", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    const child = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      explain: true,
      sessionID: "s-child-agent",
    });
    expect(child.ok).toBe(true);
    expect(authorshipOfResult(child, "p-ca-1")).toBe("delegated");

    // A fetched Session with NO parentID maps to null (root), not undefined.
    const root = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      explain: true,
      sessionID: "s-root-human",
    });
    expect(root.ok).toBe(true);
    expect(authorshipOfResult(root, "p-rh-1")).toBe("human");
  });

  it("the single-target branch degrades to unknown when the metadata fetch fails", async () => {
    const h = makeAuthorshipHarness({ getThrows: new Set(["s-root-human"]) });
    const { recall } = await setup(h);
    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      explain: true,
      sessionID: "s-root-human",
    });
    expect(out.ok).toBe(true);
    // NOT "human": a metadata-less target must never claim a human author.
    expect(authorshipOfResult(out, "p-rh-1")).toBe("unknown");
  });

  it("resolveUncarded reads parentage from the probe, and a failed probe yields unknown", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);
    // Added AFTER seeding → the client serves messages but no card exists, so
    // these ids take the uncarded probe path.
    const probed = addSession(h, "s-uncarded-child", "Uncarded Child", NOW - 5_000, "s-root-human");
    h.messagesBySession[probed.id] = [
      bundle(userMessage("m-uc-1", probed.id, NOW - 5_500), [
        textPart("p-uc-1", probed.id, "m-uc-1", "quarkbeam from an uncarded child session"),
      ]),
    ];

    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      explain: true,
      sessions: ["s-uncarded-child"],
    });
    expect(out.ok).toBe(true);
    expect(authorshipOfResult(out, "p-uc-1")).toBe("delegated");
  });

  it("reads parentage from the UNSCOPED retry when the scoped probe throws", async () => {
    // The one remaining fail-open shape: scoped `session.get` throws, the
    // unscoped retry succeeds, and a mishandled parentID would map to null →
    // `human` for a child session.
    const h = makeAuthorshipHarness({ getThrows: new Set(["s-uncarded-child"]) });
    const { recall } = await setup(h);
    const probed = addSession(h, "s-uncarded-child", "Uncarded Child", NOW - 5_000, "s-root-human");
    h.messagesBySession[probed.id] = [
      bundle(userMessage("m-uc-1", probed.id, NOW - 5_500), [
        textPart("p-uc-1", probed.id, "m-uc-1", "quarkbeam via the unscoped retry"),
      ]),
    ];

    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      explain: true,
      sessions: ["s-uncarded-child"],
    });
    expect(out.ok).toBe(true);
    expect(authorshipOfResult(out, "p-uc-1")).toBe("delegated");
  });

  it("a double probe failure yields unknown, not human", async () => {
    const h = makeAuthorshipHarness({
      getThrows: new Set(["s-unprobeable"]),
      unscopedGetThrows: new Set(["s-unprobeable"]),
    });
    const { recall } = await setup(h);
    const unprobeable = addSession(h, "s-unprobeable", "Unprobeable", NOW - 5_000);
    h.messagesBySession[unprobeable.id] = [
      bundle(userMessage("m-up-1", unprobeable.id, NOW - 5_500), [
        textPart("p-up-1", unprobeable.id, "m-up-1", "quarkbeam in an unverifiable session"),
      ]),
    ];

    const explained = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      explain: true,
      sessions: ["s-unprobeable"],
    });
    expect(explained.ok).toBe(true);
    expect(authorshipOfResult(explained, "p-up-1")).toBe("unknown");

    // And it is genuinely withheld from authorship:"human".
    const human = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      sessions: ["s-unprobeable"],
      authorship: "human",
    });
    expect(human.ok).toBe(true);
    expect(human.results).toEqual([]);
  });

  it("targetFor's metadata-less fallback (deep on an uncarded single target) yields unknown", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);
    const fresh = addSession(h, "s-deep-uncarded", "Deep Uncarded", NOW - 4_000);
    h.messagesBySession[fresh.id] = [
      bundle(userMessage("m-du-1", fresh.id, NOW - 4_500), [
        textPart("p-du-1", fresh.id, "m-du-1", "quarkbeam swept without any card"),
      ]),
    ];

    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      explain: true,
      deep: true,
      sessionID: "s-deep-uncarded",
    });
    expect(out.ok).toBe(true);
    expect(authorshipOfResult(out, "p-du-1")).toBe("unknown");
  });

  it("adds no session.get fetches — parentage rides existing metadata", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    const before = h.calls.get.length;
    await runTool<SearchOutput>(recall, { query: "quarkbeam", match: "smart", results: 50 });
    const plain = h.calls.get.length - before;

    const mid = h.calls.get.length;
    await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      authorship: "human",
    });
    expect(h.calls.get.length - mid).toBe(plain);

    // Same pin on the explicit-shortlist path, whose probes DO call session.get:
    // the count must be unchanged by the new argument, not merely zero.
    const shortlistBefore = h.calls.get.length;
    await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      sessions: ["s-root-human", "s-child-agent"],
    });
    const shortlistPlain = h.calls.get.length - shortlistBefore;

    const shortlistMid = h.calls.get.length;
    await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      sessions: ["s-root-human", "s-child-agent"],
      authorship: "human",
    });
    expect(h.calls.get.length - shortlistMid).toBe(shortlistPlain);
  });
});

// ── Selection restriction (step 5): both paths ──────────────────────────────

describe("root-only selection under authorship:{human}", () => {
  it("drops child-session cards from the tier-1 ranking shortlist", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);
    // A needle only the child session carries: under "any" it is found, under
    // "human" the session is never even drilled.
    h.messagesBySession["s-child-agent"]!.push(
      bundle(userMessage("m-ca-2", "s-child-agent", NOW - 9_200), [
        textPart("p-ca-2", "s-child-agent", "m-ca-2", "wibbleforth appears only here"),
      ]),
    );

    const any = await runTool<SearchOutput>(recall, { query: "quarkbeam", match: "smart" });
    const restricted = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      authorship: "human",
    });
    expect(any.ok && restricted.ok).toBe(true);
    // The child card is filtered out of `eligible` before the drill fan-out.
    expect(restricted.coverage!.sessionsEligible).toBeLessThan(any.coverage!.sessionsEligible);
    expect(restricted.coverage!.sessionsSearched).toBeLessThan(any.coverage!.sessionsSearched);
  });

  it("names the drilled sessions honestly: a child session is not searched", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    // A needle that exists ONLY in the child session, so both runs return
    // nothing under "human" and `nearMisses` reports what WAS searched.
    h.messagesBySession["s-child-agent"]!.push(
      bundle(userMessage("m-ca-3", "s-child-agent", NOW - 9_100), [
        textPart("p-ca-3", "s-child-agent", "m-ca-3", "wibbleforth lives only in the child"),
      ]),
    );

    const restricted = await runTool<SearchOutput>(recall, {
      query: "wibbleforth",
      match: "smart",
      authorship: "human",
    });
    expect(restricted.ok).toBe(true);
    expect(restricted.results).toEqual([]);
    expect(restricted.nearMisses?.map((m) => m.sessionID) ?? []).not.toContain("s-child-agent");
  });

  it("drops a child session reachable ONLY through the FTS injection path", async () => {
    const h = makeAuthorshipHarness();
    const { recall, store } = await setup(h);

    // A child session whose CARD carries no trace of the needle but whose slim
    // FTS rows do: it can only reach the shortlist via the tier-1.5 injection,
    // which bypasses cards.rank/CardFilters entirely.
    const ftsChild = addSession(h, "s-fts-child", "Unrelated Ledger", NOW - 3_000, "s-root-human");
    const real = [
      bundle(userMessage("m-fc-1", ftsChild.id, NOW - 3_500), [
        textPart("p-fc-1", ftsChild.id, "m-fc-1", "blimwaxen needle hidden in the transcript"),
      ]),
    ];
    const decoy = [
      bundle(userMessage("m-fc-1", ftsChild.id, NOW - 3_500), [
        textPart("p-fc-1", ftsChild.id, "m-fc-1", "ledger reconciliation notes"),
      ]),
    ];
    h.messagesBySession[ftsChild.id] = real;
    const meta: DistillSessionMeta = {
      id: ftsChild.id,
      parentId: "s-root-human",
      title: ftsChild.title,
      slug: ftsChild.id,
      directory: PROJECT_DIR,
      projectId: "project-main",
      agent: null,
      model: null,
      timeCreated: ftsChild.time.created,
      timeUpdated: ftsChild.time.updated,
    };
    const parentById = new Map<string, string | null>([[ftsChild.id, "s-root-human"]]);
    const caps = {
      ftsRowsPerSession: TEST_LIMITS.ftsRowsPerSession,
      inventoryTokens: TEST_LIMITS.inventoryTokens,
    };
    const { rows } = deriveCard({ session: meta, messages: real, parentById, caps });
    const { card } = deriveCard({ session: meta, messages: decoy, parentById, caps });
    store.replaceSessionParts(ftsChild.id, rows, card);
    store.setMeta("cards_rev", "2");

    const any = await runTool<SearchOutput>(recall, { query: "blimwaxen", match: "smart" });
    expect(any.ok).toBe(true);
    // Reached only because the FTS injection admitted it.
    expect(any.results.some((r) => r.sessionID === ftsChild.id)).toBe(true);

    const restricted = await runTool<SearchOutput>(recall, {
      query: "blimwaxen",
      match: "smart",
      authorship: "human",
    });
    expect(restricted.ok).toBe(true);
    expect(restricted.results.some((r) => r.sessionID === ftsChild.id)).toBe(false);
    expect(restricted.coverage!.sessionsSearched).toBeLessThan(any.coverage!.sessionsSearched);
    expect(restricted.nearMisses?.map((m) => m.sessionID) ?? []).not.toContain(ftsChild.id);
  });

  it("drills an unverifiable target and withholds it at the part level, not at selection", async () => {
    // NOT a test of the root-only restriction: `sessions:[...]` takes the
    // explicit-shortlist branch, which never sets rootOnly. What it pins is the
    // other half of the promise — a target whose parentage could not be
    // resolved is still fetched and searched, and it is the part-level rule
    // (unknown ≠ human) that withholds it, with the empty-pool warning saying so.
    const h = makeAuthorshipHarness({
      getThrows: new Set(["s-unknown-parent"]),
      unscopedGetThrows: new Set(["s-unknown-parent"]),
    });
    const { recall } = await setup(h);
    const unknown = addSession(h, "s-unknown-parent", "Unknown Parentage", NOW - 2_000);
    h.messagesBySession[unknown.id] = [
      bundle(userMessage("m-un-1", unknown.id, NOW - 2_500), [
        textPart("p-un-1", unknown.id, "m-un-1", "quarkbeam in an unresolvable session"),
      ]),
    ];

    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      sessions: ["s-unknown-parent"],
      authorship: "human",
    });
    expect(out.ok).toBe(true);
    expect(out.coverage!.sessionsSearched).toBe(1);
    expect(out.results).toEqual([]);
    expect(out.warnings?.some((w) => /unknown 1/.test(w))).toBe(true);

    // The card-level counterpart lives in test/cards.test.ts: `Card.parentId`
    // is two-state, so a card can only express root or child — a card whose
    // stored value is degenerate is the only "unknown" selection can see, and
    // rootOnly keeps it.
  });

  it("does not apply the restriction to cards.list — a caller-named child session is still drilled", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    // Explicit shortlist: the caller named the child by id, so it must be
    // drilled (and honestly return nothing) rather than silently dropped.
    const shortlist = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      sessions: ["s-child-agent"],
      authorship: "human",
    });
    expect(shortlist.ok).toBe(true);
    expect(shortlist.coverage!.sessionsSearched).toBe(1);
    expect(shortlist.results).toEqual([]);

    // Same for deep.
    const deep = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      deep: true,
      sessions: ["s-child-agent"],
      authorship: "human",
    });
    expect(deep.ok).toBe(true);
    expect(deep.coverage!.sessionsSearched).toBe(1);
  });

  it("loses no session that could produce a result: set-inclusion at the SELECTED-pool layer", async () => {
    // Asserted on the sessions handed to the drill, BEFORE any scoring. The
    // results list is the wrong layer for this: MiniSearch emits only matches
    // and BM25 applies a relative floor, so `results: 50` does not make the
    // returned list equal to the scored pool, and a newly admitted root session
    // can displace a prior result at the cap. Ordering and scores are not
    // compared — only which sessions were selected.
    const h = makeAuthorshipHarness();
    const unrestricted = await setupWithDrillSpy(h);
    await runTool<SearchOutput>(unrestricted.recall, { query: "quarkbeam", match: "smart" });

    const restricted = await setupWithDrillSpy(h);
    await runTool<SearchOutput>(restricted.recall, {
      query: "quarkbeam",
      match: "smart",
      authorship: "human",
    });

    const before = unrestricted.drilled();
    const after = new Set(restricted.drilled());
    expect(before.length).toBeGreaterThan(0);
    expect(after.size).toBeGreaterThan(0);

    // Every session the unrestricted run selected that is NOT positively a
    // child is still selected. Child sessions may be dropped: no candidate in
    // one can classify `human`, so they could contribute nothing either way.
    const childIds = new Set(["s-child-agent"]);
    for (const id of before) {
      if (childIds.has(id)) continue;
      expect(after.has(id), `restricted run must still select ${id}`).toBe(true);
    }
    expect(after.has("s-child-agent")).toBe(false);
  });
});

// ── Reporting ────────────────────────────────────────────────────────────────

describe("authorship reporting", () => {
  it('adds "authorship" to coverage.limitedBy only when filtering', async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    const plain = await runTool<SearchOutput>(recall, { query: "quarkbeam", match: "smart" });
    expect(plain.coverage?.limitedBy ?? []).not.toContain("authorship");

    const any = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      authorship: "any",
    });
    expect(any.coverage?.limitedBy ?? []).not.toContain("authorship");

    const filtered = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      authorship: "human",
    });
    expect(filtered.coverage?.limitedBy).toContain("authorship");
  });

  it("warns with bucket names and counts when the pass empties an otherwise non-empty pool", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      sessions: ["s-child-agent"],
      authorship: "human",
    });
    expect(out.ok).toBe(true);
    expect(out.results).toEqual([]);
    const warning = out.warnings?.find((w) => w.includes("removed every candidate from"));
    expect(warning).toBeDefined();
    expect(warning).toContain("1 of 1 drilled session");
    expect(warning).toContain("delegated 1");
    // Nothing came back, so the advice half is included.
    expect(warning).toContain("Widen it");
    expect(warning).toContain('authorship:"any"');
  });

  it("detects the emptied pool PER SESSION, so a survivor elsewhere cannot hide it", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    // The root session yields a human hit; the child session is emptied. A
    // global "nothing survived anywhere" test would stay silent here.
    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      authorship: "human",
    });
    expect(out.ok).toBe(true);
    expect(out.results.length).toBeGreaterThan(0);
    const warning = out.warnings?.find((w) => w.includes("removed every candidate from"));
    expect(warning).toBeDefined();
    // Only the emptied pools contribute to the breakdown (here s-subtask, whose
    // single subtask part is `delegated`), so it explains the emptiness rather
    // than restating the whole query.
    expect(warning).toContain("(delegated 1)");
    // The query succeeded, so it is a report, not advice: telling a caller with
    // results to "widen it" would be noise.
    expect(warning).not.toContain("Widen it");
  });

  it("counts only the CONTENDING sessions the root-only restriction removed", async () => {
    const h = makeAuthorshipHarness();
    // A second child session that this query has no signal for: it was never in
    // contention, so the restriction cost the caller nothing by dropping it and
    // it must not inflate the count. Without this the number would be "every
    // child card in the store", which on a real store is orders of magnitude
    // off and would dominate sessionsSkipped.
    addSession(h, "s-child-quiet", "Unrelated Child", NOW - 8_800, "s-root-human");
    h.messagesBySession["s-child-quiet"] = [
      bundle(userMessage("m-cq-1", "s-child-quiet", NOW - 8_900), [
        textPart("p-cq-1", "s-child-quiet", "m-cq-1", "nothing about the needle here"),
      ]),
    ];
    const { recall } = await setup(h);

    const plain = await runTool<SearchOutput>(recall, { query: "quarkbeam", match: "smart" });
    expect(plain.coverage?.skippedByReason?.authorship).toBeUndefined();

    const restricted = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      authorship: "human",
    });
    // s-child-agent contends for "quarkbeam"; s-child-quiet does not.
    expect(restricted.coverage?.skippedByReason?.authorship).toBe(1);
    expect(restricted.coverage!.sessionsSkipped).toBeGreaterThan(plain.coverage!.sessionsSkipped);
  });

  it("counts only children that would have taken a shortlist slot", async () => {
    // The shortlist is one session wide, and a root session outranks the child,
    // so the restriction cost the caller nothing: the child was never going to
    // be drilled. Without the cap-aware narrowing this reports 1 — the failure
    // mode that made the real-corpus number read 4,488 of 4,978 child sessions,
    // since semantic scoring puts almost every card above zero.
    const h = makeAuthorshipHarness();
    const { deps, cleanup } = await makeRecallDeps(h, { ...TEST_LIMITS, drillSessions: 1 });
    cleanups.push(cleanup);
    const recall = search(h.client, h.unscoped, true, { ...TEST_LIMITS, drillSessions: 1 }, deps);

    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      scope: "global",
      authorship: "human",
    });
    expect(out.ok).toBe(true);
    expect(out.coverage?.skippedByReason?.authorship).toBeUndefined();
  });

  it("does not count a child session the directory scope would have dropped anyway", async () => {
    const h = makeAuthorshipHarness();
    // A contending child session in ANOTHER directory: a project-scoped query
    // never had it in play, so authorship did not remove it.
    const foreign = session(
      "s-child-foreign",
      "Foreign Child",
      OTHER_DIR,
      NOW - 8_700,
      undefined,
      "s-root-human",
    );
    h.sessions.push(foreign);
    h.globalSessions.push(globalSessionFrom(foreign));
    h.messagesBySession[foreign.id] = [
      bundle(userMessage("m-cf-1", foreign.id, NOW - 8_800), [
        textPart("p-cf-1", foreign.id, "m-cf-1", "quarkbeam in another project"),
      ]),
    ];
    const { recall } = await setup(h);

    const scoped = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      scope: "project",
      authorship: "human",
    });
    expect(scoped.ok).toBe(true);
    expect(scoped.coverage?.skippedByReason?.authorship).toBe(1);

    // Globally, both child sessions are in play and both are counted.
    const global = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      scope: "global",
      authorship: "human",
    });
    expect(global.coverage?.skippedByReason?.authorship).toBe(2);
  });

  it("the empty-pool warning reaches the single-target branch a subagent takes", async () => {
    // `scope:"session"` from inside a child session bypasses the selection tier
    // entirely, so the warning is the only signal the caller gets.
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);
    const { ctx } = makeContext({ sessionID: "s-child-agent" });

    const out = await runTool<SearchOutput>(
      recall,
      { query: "quarkbeam", match: "smart", scope: "session", authorship: "human" },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(out.results).toEqual([]);
    expect(out.warnings?.some((w) => w.includes("removed every candidate from"))).toBe(true);
  });

  it("warns for combinations that are empty by construction", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    const toolType = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      type: "tool",
      authorship: "human",
    });
    expect(toolType.warnings?.some((w) => /matches nothing: tool parts classify/.test(w))).toBe(
      true,
    );

    const named = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      toolName: "bash",
      authorship: ["human", "delegated"],
    });
    expect(named.warnings?.some((w) => /toolName matches nothing/.test(w))).toBe(true);

    const title = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      type: "text",
      authorship: "title",
    });
    expect(
      title.warnings?.some((w) =>
        /authorship:"title" matches nothing with a type or toolName/.test(w),
      ),
    ).toBe(true);
  });

  it("suggests widening to any when a narrowed filter returns nothing", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    const empty = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      sessions: ["s-child-agent"],
      authorship: "human",
    });
    expect(empty.results).toEqual([]);
    expect(empty.suggestions?.some((sug) => /Retry with authorship:"any"/.test(sug.action))).toBe(
      true,
    );

    // Not offered on a plain query, nor when the filter did return something.
    const plain = await runTool<SearchOutput>(recall, { query: "nothingmatchesthis" });
    expect(plain.suggestions?.some((sug) => /authorship/.test(sug.action))).toBeFalsy();
  });

  it("does not warn for combinations that can match", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);
    const out = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      type: "tool",
      authorship: ["model", "injected"],
    });
    expect(out.warnings?.some((w) => /matches nothing/.test(w))).toBeFalsy();
  });

  it("emits topEvidence.authorship under the same gate, and omits it by default", async () => {
    // A session with two evidence CLASSES, so grouping actually produces
    // secondary evidence (topEvidence only carries hits whose class differs
    // from the representative's).
    const h = makeFakeHarness();
    addSession(h, "s-mixed", "Mixed Evidence", NOW - 6_000);
    h.messagesBySession["s-mixed"] = [
      bundle(userMessage("m-mx-1", "s-mixed", NOW - 6_500), [
        textPart("p-mx-1", "s-mixed", "m-mx-1", "flimsywitch discussed in prose"),
      ]),
      bundle(assistantMessage("m-mx-2", "s-mixed", NOW - 6_400), [
        completedToolPart(
          "p-mx-2",
          "s-mixed",
          "m-mx-2",
          "bash",
          { command: "flimsywitch --check" },
          "flimsywitch output",
        ),
      ]),
    ];
    const { recall } = await setup(h);

    const base = {
      query: "flimsywitch",
      match: "smart" as const,
      group: "session" as const,
      results: 50,
    };

    const plain = await runTool<SearchOutput>(recall, base);
    const plainEvidence = plain.results.find((r) => (r.topEvidence?.length ?? 0) > 0);
    expect(plainEvidence).toBeDefined();
    for (const evidence of plainEvidence!.topEvidence!) {
      expect(evidence.authorship).toBeUndefined();
    }

    const explained = await runTool<SearchOutput>(recall, { ...base, explain: true });
    const withEvidence = explained.results.find((r) => (r.topEvidence?.length ?? 0) > 0);
    expect(withEvidence).toBeDefined();
    for (const evidence of withEvidence!.topEvidence!) {
      expect(evidence.authorship).toBeDefined();
    }

    const filtered = await runTool<SearchOutput>(recall, {
      ...base,
      authorship: ["human", "model"],
    });
    const filteredEvidence = filtered.results.find((r) => (r.topEvidence?.length ?? 0) > 0);
    expect(filteredEvidence).toBeDefined();
    for (const evidence of filteredEvidence!.topEvidence!) {
      expect(evidence.authorship).toBeDefined();
    }
  });
});

// ── Compatibility: default responses are byte-identical ─────────────────────

describe("authorship compatibility", () => {
  const shapes = [
    { name: "flat", args: { group: "part" as const } },
    { name: 'group:"session"', args: { group: "session" as const } },
  ];

  for (const shape of shapes) {
    it(`absent, undefined and "any" serialize identically (${shape.name})`, async () => {
      const h = makeAuthorshipHarness();
      const { recall } = await setup(h);
      const base = { query: "quarkbeam", match: "smart" as const, results: 50, ...shape.args };

      const { absent, explicitAny, explicitUndefined } = await withFrozenClock(async () => ({
        absent: await runTool<SearchOutput>(recall, base),
        explicitAny: await runTool<SearchOutput>(recall, { ...base, authorship: "any" }),
        explicitUndefined: await runToolRaw<SearchOutput>(recall, {
          ...base,
          explain: false,
          authorship: undefined,
        }),
      }));

      expect(JSON.stringify(explicitAny)).toBe(JSON.stringify(absent));
      expect(JSON.stringify(explicitUndefined)).toBe(JSON.stringify(absent));

      // Nothing authorship-shaped leaks into a default response.
      const serialized = JSON.stringify(absent);
      expect(serialized).not.toContain("authorship");
      expect(serialized).not.toContain("sessionParentID");
      expect(absent.coverage?.limitedBy ?? []).not.toContain("authorship");
    });
  }

  it("works on the degraded (store-null) path without changing its default output", async () => {
    const h = makeAuthorshipHarness();
    const { deps } = makeStoreNullDeps(h, TEST_LIMITS);
    const recall = search(h.client, h.unscoped, true, TEST_LIMITS, deps);
    const base = { query: "quarkbeam", match: "smart" as const, results: 50 };

    const { absent, any } = await withFrozenClock(async () => ({
      absent: await runTool<SearchOutput>(recall, base),
      any: await runTool<SearchOutput>(recall, { ...base, authorship: "any" }),
    }));
    expect(JSON.stringify(any)).toBe(JSON.stringify(absent));
    expect(absent.coverage?.cards?.degraded).toBe(true);

    // Cards-lite DOES carry parentage (cardsLiteFromSessions reads parentID off
    // the live session rows), so the filter is fully functional here — the
    // degraded path loses content indexing, not authorship.
    const human = await runTool<SearchOutput>(recall, { ...base, authorship: "human" });
    expect(human.ok).toBe(true);
    expect(human.coverage?.limitedBy).toContain("authorship");
    expect(ids(human)).toEqual(["s-flags/p-fl-plain", "s-root-human/p-rh-1"]);
    for (const result of human.results) expect(result.why?.authorship).toBe("human");

    // And the child session is still recognized as delegated, not misread as
    // human, on a store-null card source.
    const delegated = await runTool<SearchOutput>(recall, {
      ...base,
      authorship: "delegated",
    });
    expect(ids(delegated)).toEqual(["s-child-agent/p-ca-1", "s-subtask/p-st-1"]);
  });

  it("leaves role behavior and evidenceClass values untouched", async () => {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);

    const user = await runTool<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      role: "user",
    });
    expect(user.ok).toBe(true);
    // `role` stays transport-level: it keeps the delegated and injected parts.
    expect(ids(user)).toEqual([
      "s-child-agent/p-ca-1",
      "s-flags/p-fl-ignored",
      "s-flags/p-fl-plain",
      "s-flags/p-fl-synthetic",
      "s-root-human/p-rh-1",
    ]);
    for (const result of user.results) expect(result.why?.evidenceClass).toBe("human-text");
  });
});

// ── Defensive coercion (the host drops Zod defaults) ─────────────────────────

describe("authorship coercion under the host-bypass path", () => {
  async function raw(args: Record<string, unknown>): Promise<SearchOutput> {
    const h = makeAuthorshipHarness();
    const { recall } = await setup(h);
    return runToolRaw<SearchOutput>(recall, {
      query: "quarkbeam",
      match: "smart",
      results: 50,
      ...args,
    });
  }

  it("absent behaves as any", async () => {
    const out = await raw({});
    expect(out.ok).toBe(true);
    expect(out.results.length).toBeGreaterThan(2);
    expect(out.coverage?.limitedBy ?? []).not.toContain("authorship");
  });

  it("a junk string falls back to any with a warning", async () => {
    const out = await raw({ authorship: "hooman" });
    expect(out.ok).toBe(true);
    expect(
      out.warnings?.some((w) => /Ignored authorship:"hooman"; using authorship:"any"/.test(w)),
    ).toBe(true);
    expect(out.coverage?.limitedBy ?? []).not.toContain("authorship");
  });

  it("an explicit null is junk, not omission: it warns", async () => {
    const out = await raw({ authorship: null });
    expect(out.ok).toBe(true);
    expect(
      out.warnings?.some((w) => /Ignored authorship:null; using authorship:"any"/.test(w)),
    ).toBe(true);
    expect(out.coverage?.limitedBy ?? []).not.toContain("authorship");
  });

  it("a non-string, non-array value falls back to any with a warning", async () => {
    const out = await raw({ authorship: 7 });
    expect(out.ok).toBe(true);
    expect(out.warnings?.some((w) => /Ignored authorship:7; using authorship:"any"/.test(w))).toBe(
      true,
    );
  });

  it("drops invalid array members INDIVIDUALLY rather than widening the filter", async () => {
    const out = await raw({ authorship: ["human", "nonsense", 3] });
    expect(out.ok).toBe(true);
    // The valid member still filters — rejecting the whole array would have
    // silently returned everything.
    expect(ids(out)).toEqual(["s-flags/p-fl-plain", "s-root-human/p-rh-1"]);
    expect(
      out.warnings?.some((w) => /Ignored invalid authorship values "nonsense", 3/.test(w)),
    ).toBe(true);
    expect(out.coverage?.limitedBy).toContain("authorship");
  });

  it("an empty array falls back to any with a warning", async () => {
    const out = await raw({ authorship: [] });
    expect(out.ok).toBe(true);
    expect(
      out.warnings?.some((w) => /Ignored empty authorship; using authorship:"any"/.test(w)),
    ).toBe(true);
    expect(out.coverage?.limitedBy ?? []).not.toContain("authorship");
  });

  it("an array that empties after filtering falls back to any", async () => {
    const out = await raw({ authorship: ["bogus"] });
    expect(out.ok).toBe(true);
    expect(out.warnings?.some((w) => /Ignored invalid authorship value "bogus"/.test(w))).toBe(
      true,
    );
    expect(out.warnings?.some((w) => /Ignored empty authorship/.test(w))).toBe(true);
    expect(out.coverage?.limitedBy ?? []).not.toContain("authorship");
  });

  it('an array containing "any" collapses to any', async () => {
    const out = await raw({ authorship: ["human", "any"] });
    expect(out.ok).toBe(true);
    expect(out.coverage?.limitedBy ?? []).not.toContain("authorship");
    expect(out.results.length).toBeGreaterThan(2);
  });

  it("deduplicates repeated members", async () => {
    const out = await raw({ authorship: ["human", "human", "human"] });
    expect(out.ok).toBe(true);
    expect(ids(out)).toEqual(["s-flags/p-fl-plain", "s-root-human/p-rh-1"]);
    // A duplicate is not an invalid member: no drop warning.
    expect(out.warnings?.some((w) => /Ignored invalid authorship/.test(w))).toBeFalsy();
  });
});
