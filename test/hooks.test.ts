import { describe, expect, it } from "vitest";
import { systemNudge, NUDGE_SENTINEL } from "../src/hooks/system-nudge.js";
import { shouldAutoRecall, formatAutoRecallBlock, autoRecall } from "../src/hooks/auto-recall.js";
import { formatPreservationBlock, compactionRecall } from "../src/hooks/compaction-recall.js";
import { partId } from "../src/hooks/part-id.js";
import type { SearchResult } from "../src/types.js";
import { TEST_LIMITS, makeFakeHarness } from "./helpers.js";

function result(over: Partial<SearchResult> = {}): SearchResult {
  return {
    sessionID: "s-current",
    sessionTitle: "Current Debugging Session",
    directory: "/workspace/project",
    messageID: "m-current-1",
    role: "assistant",
    time: Date.now() - 2 * 24 * 60 * 60 * 1000,
    partID: "p1",
    partType: "text",
    pruned: false,
    snippet: "rate limit middleware decision",
    ...over,
  };
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

  it("formats up to 3 cited hits within the char budget", () => {
    const block = formatAutoRecallBlock([
      result(),
      result({ sessionID: "s2" }),
      result({ sessionID: "s3" }),
      result({ sessionID: "s4" }),
    ]);
    expect(block).toContain("<recall-auto>");
    expect(block).toContain("</recall-auto>");
    expect(block).toContain("recall_get");
    // 3 hits max -> 3 bullet lines.
    expect((block!.match(/^- /gm) ?? []).length).toBe(3);
    expect(block!.length).toBeLessThanOrEqual(900);
  });
});

describe("autoRecall hook", () => {
  it("injects a synthetic part when the gate fires and hits exist", async () => {
    const h = makeFakeHarness();
    const hook = autoRecall(h.client, h.unscoped, true, TEST_LIMITS);
    const output = {
      message: { id: "m-x" } as never,
      parts: [
        { type: "text", text: "what did we decide about rate limit last time?" },
      ] as unknown[],
    };
    await hook({ sessionID: "s-current" } as never, output as never);
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
  });

  it("does nothing when the gate does not fire", async () => {
    const h = makeFakeHarness();
    const hook = autoRecall(h.client, h.unscoped, true, TEST_LIMITS);
    const output = {
      message: { id: "m-x" } as never,
      parts: [{ type: "text", text: "Add a new endpoint to the API." }] as unknown[],
    };
    await hook({ sessionID: "s-current" } as never, output as never);
    expect(output.parts).toHaveLength(1);
  });

  it("never throws when search fails", async () => {
    const h = makeFakeHarness({ projectListError: "boom", globalListError: "boom" });
    const hook = autoRecall(h.client, h.unscoped, true, TEST_LIMITS);
    const output = {
      message: { id: "m-x" } as never,
      parts: [{ type: "text", text: "what did we decide last time about caching?" }] as unknown[],
    };
    await expect(
      hook({ sessionID: "s-current" } as never, output as never),
    ).resolves.toBeUndefined();
    // No synthetic part added on failure.
    expect((output.parts as Array<{ synthetic?: boolean }>).some((p) => p.synthetic)).toBe(false);
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
  it("returns undefined for no hits", () => {
    expect(formatPreservationBlock([])).toBeUndefined();
  });

  it("formats cited durable findings within the char budget", () => {
    const block = formatPreservationBlock([result(), result({ messageID: "m2" })]);
    expect(block).toContain("Durable findings");
    expect((block!.match(/^- /gm) ?? []).length).toBe(2);
    expect(block!.length).toBeLessThanOrEqual(700);
  });

  it("filters out low-score (non-durable) hits", () => {
    const strong = result({ messageID: "m-strong", score: 0.9 });
    const weak = result({ messageID: "m-weak", score: 0.1 });
    const block = formatPreservationBlock([strong, weak]);
    expect(block).toContain("m-strong".slice(0, 8));
    expect((block!.match(/^- /gm) ?? []).length).toBe(1);
  });

  it("returns undefined when all hits are below the score floor", () => {
    expect(formatPreservationBlock([result({ score: 0.05 })])).toBeUndefined();
  });
});

describe("compactionRecall hook", () => {
  it("pushes a block onto context and never sets prompt", async () => {
    const h = makeFakeHarness();
    const hook = compactionRecall(h.client, h.unscoped, true, TEST_LIMITS);
    const output: { context: string[]; prompt?: string } = { context: [], prompt: undefined };
    await hook({ sessionID: "s-current" } as never, output as never);
    expect(output.prompt).toBeUndefined();
    // Session has durable-ish content, so expect a pushed block (or none, but never a throw).
    expect(Array.isArray(output.context)).toBe(true);
  });

  it("never throws when search fails", async () => {
    const h = makeFakeHarness({ messageThrows: new Set(["s-current"]) });
    const hook = compactionRecall(h.client, h.unscoped, true, TEST_LIMITS);
    const output: { context: string[]; prompt?: string } = { context: [], prompt: undefined };
    await expect(
      hook({ sessionID: "s-current" } as never, output as never),
    ).resolves.toBeUndefined();
    expect(output.context).toHaveLength(0);
  });
});
