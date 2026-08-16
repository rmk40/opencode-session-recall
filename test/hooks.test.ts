import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemNudge, NUDGE_SENTINEL, NUDGE_TEXT } from "../src/hooks/system-nudge.js";
import { shouldAutoRecall, formatAutoRecallBlock, autoRecall } from "../src/hooks/auto-recall.js";
import { formatPreservationBlock, compactionRecall } from "../src/hooks/compaction-recall.js";
import { partId } from "../src/hooks/part-id.js";
import type { CardRecallHit } from "../src/hooks/card-recall.js";
import type { Card } from "../src/store.js";
import {
  makeFakeHarness,
  makeRecallDeps,
  setStrictNoLimitMessages,
  type FakeHarness,
} from "./helpers.js";

// The hooks are card-tier only: they must make ZERO message fetches. Strict mode
// hard-fails any no-limit fetch as a backstop; the tests below also assert the
// fetch-call counters stay at zero directly.
beforeAll(() => setStrictNoLimitMessages(true));
afterAll(() => setStrictNoLimitMessages(false));

/** Build the recall deps for a hook test and register cleanup on the harness. */
async function hookDeps(h: FakeHarness): Promise<{
  deps: Awaited<ReturnType<typeof makeRecallDeps>>["deps"];
  cleanup: () => void;
}> {
  const { deps, cleanup } = await makeRecallDeps(h);
  return { deps, cleanup };
}

/** Minimal card for the pure-format tests (no store needed). */
function makeCard(over: Partial<Card> = {}): Card {
  return {
    sessionId: "s-card",
    parentId: null,
    rootId: "s-card",
    title: "Rate limit middleware",
    slug: "rate-limit",
    directory: "/workspace/project",
    projectId: "project-main",
    agent: null,
    model: null,
    timeCreated: Date.now() - 3 * 24 * 60 * 60 * 1000,
    timeUpdated: Date.now() - 2 * 24 * 60 * 60 * 1000,
    partCount: 10,
    retainedChars: 100,
    summaryHead: "Implement rate-limit middleware for checkout",
    outcomeHead: "Landed the middleware and added tests",
    inventory: "rateLimit checkout middleware",
    files: ["src/checkout.ts", "src/limit.ts"],
    tools: ["bash", "edit"],
    errors: ["Error: Unauthorized while loading session messages"],
    familyRollup: [],
    distillState: "full",
    distilledThrough: "m-last",
    embedding: null,
    embeddingGen: null,
    nlSummary: "",
    summaryHash: "",
    ...over,
  };
}

/** A card hit for the auto-recall format tests. */
function hit(over: Partial<Card> = {}, anchors: string[] = []): CardRecallHit {
  return { card: makeCard(over), score: 1, anchors };
}

// ── R1a system nudge ──────────────────────────────────────────────────

describe("systemNudge", () => {
  it("pushes the nudge text into the system array", async () => {
    const hook = systemNudge();
    const output = { system: ["base prompt"] };
    await hook({ model: {} as never }, output);
    expect(output.system).toHaveLength(2);
    expect(output.system[1]).toContain(NUDGE_SENTINEL);
    expect(output.system[1]).toContain("recall");
    // The subagent-recovery hint must ride the nudge: the moment a model needs
    // it (a cancelled Task with no task_id), tool descriptions are easy to
    // skim past, but the system prompt is always in view. Pin both the call
    // AND its trigger condition — dropping the condition would turn a narrow
    // conditional instruction into an unconditional one.
    expect(output.system[1]).toContain('parentID: "current"');
    expect(output.system[1]).toMatch(/cancelled or interrupted.*task_id/);
  });

  it("keeps the nudge text within its per-request budget", () => {
    // Paid on every request, in every session. Raising this is a decision,
    // not drift (same convention as the tool-description budget in
    // plugin.test.ts).
    expect(NUDGE_TEXT.length).toBeLessThan(600);
  });

  it("is idempotent (does not double-inject)", async () => {
    const hook = systemNudge();
    const output = { system: ["base prompt"] };
    await hook({ model: {} as never }, output);
    await hook({ model: {} as never }, output);
    const count = output.system.filter((s) => s.includes(NUDGE_SENTINEL)).length;
    expect(count).toBe(1);
  });

  it("tolerates a missing/!array system field", async () => {
    const hook = systemNudge();
    const output = { system: undefined as unknown as string[] };
    await expect(hook({ model: {} as never }, output)).resolves.toBeUndefined();
  });
});

// ── R1b auto-recall gate ──────────────────────────────────────────────

describe("shouldAutoRecall gate", () => {
  const textPart = (text: string) => ({ type: "text", text });

  it("fires on history cue phrases", () => {
    const d = shouldAutoRecall([textPart("How did we fix the auth bug last time?")]);
    expect(d.run).toBe(true);
  });

  it("does not fire on ordinary task messages", () => {
    const d = shouldAutoRecall([textPart("Please add a rate limiter to the checkout API.")]);
    expect(d.run).toBe(false);
  });

  it("does not fire on bare before/earlier in ordinary task phrasing", () => {
    expect(shouldAutoRecall([textPart("clean this up before committing the change")]).run).toBe(
      false,
    );
    expect(shouldAutoRecall([textPart("run the earlier command again on the file")]).run).toBe(
      false,
    );
  });

  it("fires on scoped historical phrasing", () => {
    expect(shouldAutoRecall([textPart("use the same config as before for the build")]).run).toBe(
      true,
    );
    expect(shouldAutoRecall([textPart("check the earlier session about caching here")]).run).toBe(
      true,
    );
  });

  it("declines when nothing useful remains after stripping cues", () => {
    // "remember" is a cue but leaves no real term once stripped/punctuation removed.
    expect(shouldAutoRecall([textPart("remember?? !! ...")]).run).toBe(false);
  });

  it("skips very short messages", () => {
    expect(shouldAutoRecall([textPart("remember")]).run).toBe(false);
  });

  it("skips slash commands", () => {
    expect(shouldAutoRecall([textPart("/recall something we did before")]).run).toBe(false);
  });

  it("skips explicit recall() requests", () => {
    expect(shouldAutoRecall([textPart("call recall(query: 'before') for me please now")]).run).toBe(
      false,
    );
  });

  it("ignores synthetic parts when extracting user text", () => {
    const d = shouldAutoRecall([
      { type: "text", text: "plain task with no cues here at all", synthetic: false },
      { type: "text", text: "remember the previous decision", synthetic: true },
    ]);
    expect(d.run).toBe(false);
  });

  it("derives a query stripped of cue words", () => {
    const d = shouldAutoRecall([textPart("what did we decide about the postgres migration?")]);
    expect(d.run).toBe(true);
    if (d.run) {
      expect(d.query.toLowerCase()).toContain("postgres");
      expect(d.query.toLowerCase()).not.toContain("what did we decide");
    }
  });
});

describe("formatAutoRecallBlock", () => {
  it("returns undefined for no hits", () => {
    expect(formatAutoRecallBlock([])).toBeUndefined();
  });

  it("formats up to 3 cited card hits within the char budget", () => {
    const block = formatAutoRecallBlock([
      hit({ sessionId: "s1" }, ["rateLimit"]),
      hit({ sessionId: "s2" }),
      hit({ sessionId: "s3" }),
      hit({ sessionId: "s4" }),
    ]);
    expect(block).toContain("<recall-auto>");
    expect(block).toContain("</recall-auto>");
    expect(block).toContain("recall");
    // 3 hits max -> 3 bullet lines, each carrying the card's title + session id.
    expect((block!.match(/^- /gm) ?? []).length).toBe(3);
    expect(block).toContain("Rate limit middleware");
    expect(block).toContain("session s1");
    // Matched anchors are surfaced when present.
    expect(block).toContain("anchors: rateLimit");
    expect(block!.length).toBeLessThanOrEqual(900);
  });
});

describe("autoRecall hook", () => {
  it("injects a synthetic part when the gate fires and cards match", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await hookDeps(h);
    const hook = autoRecall(deps);
    const output = {
      message: { id: "m-x" } as never,
      parts: [
        { type: "text", text: "what did we decide about rate limit last time?" },
      ] as unknown[],
    };
    await hook({ sessionID: "s-current" } as never, output as never);
    cleanup();
    const synthetic = (
      output.parts as Array<{
        id?: string;
        messageID?: string;
        sessionID?: string;
        type?: string;
        synthetic?: boolean;
        text?: string;
      }>
    ).find((p) => p.synthetic);
    expect(synthetic).toBeDefined();
    expect(synthetic?.text).toContain("<recall-auto>");
    // Must carry a valid opencode part id (core's assign() already ran).
    expect(synthetic?.id).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(synthetic?.messageID).toBe("m-x");
    expect(synthetic?.sessionID).toBe("s-current");
    expect(synthetic?.type).toBe("text");
    // Card-tier only: not a single message fetch.
    expect(h.calls.messages).toHaveLength(0);
    expect(h.calls.message).toHaveLength(0);
  });

  it("excludes the session it fires in from injected citations", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await hookDeps(h);
    const hook = autoRecall(deps);
    const output = {
      message: { id: "m-x" } as never,
      // "rate limit" matches both s-current (rate-limit middleware) and
      // s-project-2 (rateLimit cache); only the latter may be cited.
      parts: [
        { type: "text", text: "what did we decide about rate limit last time?" },
      ] as unknown[],
    };
    await hook({ sessionID: "s-current" } as never, output as never);
    cleanup();
    const synthetic = (output.parts as Array<{ synthetic?: boolean; text?: string }>).find(
      (p) => p.synthetic,
    );
    expect(synthetic?.text).toContain(`session ${"s-project-2".slice(0, 8)}`);
    expect(synthetic?.text).not.toContain(`session ${"s-current".slice(0, 8)}`);
  });

  it("does nothing when the gate does not fire", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await hookDeps(h);
    const hook = autoRecall(deps);
    const output = {
      message: { id: "m-x" } as never,
      parts: [{ type: "text", text: "Add a new endpoint to the API." }] as unknown[],
    };
    await hook({ sessionID: "s-current" } as never, output as never);
    cleanup();
    expect(output.parts).toHaveLength(1);
    expect(h.calls.messages).toHaveLength(0);
  });

  it("makes zero message fetches and never throws even when cards yield nothing", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await hookDeps(h);
    const hook = autoRecall(deps);
    const output = {
      message: { id: "m-x" } as never,
      // Cue fires, but no card matches these terms → inject nothing.
      parts: [
        { type: "text", text: "what did we decide last time about zzznonexistentterm?" },
      ] as unknown[],
    };
    await expect(
      hook({ sessionID: "s-current" } as never, output as never),
    ).resolves.toBeUndefined();
    cleanup();
    expect((output.parts as Array<{ synthetic?: boolean }>).some((p) => p.synthetic)).toBe(false);
    // The whole point of the card-tier rework: no drill, no fetch.
    expect(h.calls.messages).toHaveLength(0);
    expect(h.calls.message).toHaveLength(0);
  });
});

// ── part-id ───────────────────────────────────────────────────────────

describe("partId", () => {
  it("produces opencode-compatible ascending ids", () => {
    const id = partId();
    expect(id).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  it("is monotonic for ids generated in the same millisecond", () => {
    const a = partId(1_000_000);
    const b = partId(1_000_000);
    expect(a < b).toBe(true);
  });

  it("orders later timestamps after earlier ones", () => {
    const a = partId(1_000_000);
    const b = partId(2_000_000);
    expect(a < b).toBe(true);
  });
});

// ── R1c compaction preservation ───────────────────────────────────────

describe("formatPreservationBlock", () => {
  it("returns undefined when there is no card", () => {
    expect(formatPreservationBlock(undefined)).toBeUndefined();
  });

  it("renders the current session's durable card fields within the char budget", () => {
    const block = formatPreservationBlock(makeCard());
    expect(block).toContain("Durable context from this session");
    expect(block).toContain("Focus: Implement rate-limit middleware");
    expect(block).toContain("Latest: Landed the middleware");
    expect(block).toContain("Errors: Error: Unauthorized");
    expect(block).toContain("Key identifiers: rateLimit checkout middleware");
    expect(block).toContain("Files: src/checkout.ts, src/limit.ts");
    expect(block!.length).toBeLessThanOrEqual(700);
  });

  it("returns undefined for an empty (content-less) card", () => {
    const empty = makeCard({
      summaryHead: "",
      outcomeHead: "",
      inventory: "",
      errors: [],
      files: [],
    });
    expect(formatPreservationBlock(empty)).toBeUndefined();
  });
});

describe("compactionRecall hook", () => {
  it("pushes the current session's card block onto context, never sets prompt, and does not fetch", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await hookDeps(h);
    const hook = compactionRecall(deps);
    const output: { context: string[]; prompt?: string } = { context: [], prompt: undefined };
    await hook({ sessionID: "s-current" } as never, output as never);
    cleanup();
    expect(output.prompt).toBeUndefined();
    // s-current has a distilled card, so a durable block is preserved.
    expect(output.context.length).toBe(1);
    expect(output.context[0]).toContain("Durable context from this session");
    // Card-tier only: no message fetches.
    expect(h.calls.messages).toHaveLength(0);
    expect(h.calls.message).toHaveLength(0);
  });

  it("never throws and pushes nothing when the session has no card", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await hookDeps(h);
    const hook = compactionRecall(deps);
    const output: { context: string[]; prompt?: string } = { context: [], prompt: undefined };
    await expect(
      hook({ sessionID: "s-unknown-session" } as never, output as never),
    ).resolves.toBeUndefined();
    cleanup();
    expect(output.context).toHaveLength(0);
    expect(h.calls.messages).toHaveLength(0);
  });
});
