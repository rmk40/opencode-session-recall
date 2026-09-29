import { describe, expect, it } from "vitest";
import { DEFAULT_SEMANTIC_MODEL, DEFAULT_SEMANTIC_WEIGHT, parseOptions } from "../src/options.js";
import { DEFAULTS } from "../src/types.js";

describe("parseOptions", () => {
  it("applies the documented defaults to an absent or empty config", () => {
    for (const raw of [undefined, null, {}]) {
      const resolved = parseOptions(raw);
      expect(resolved).toEqual({
        primary: true,
        global: true,
        nudge: true,
        autoRecall: false,
        compactionRecall: false,
        ephemeral: false,
        storePath: undefined,
        semantic: undefined,
        summaries: undefined,
        limits: DEFAULTS,
        warnings: [],
      });
    }
  });

  it("turns boolean flags off or on only for the literal booleans", () => {
    const off = parseOptions({ primary: false, global: false, nudge: false });
    expect([off.primary, off.global, off.nudge]).toEqual([false, false, false]);
    const truthy = parseOptions({ primary: "no", autoRecall: "yes", compactionRecall: 1 });
    expect(truthy.primary).toBe(true);
    expect(truthy.autoRecall).toBe(false);
    expect(truthy.compactionRecall).toBe(false);
    const on = parseOptions({ autoRecall: true, compactionRecall: true });
    expect([on.autoRecall, on.compactionRecall]).toEqual([true, true]);
  });

  describe("mode", () => {
    it("enables ephemeral only for the literal string", () => {
      expect(parseOptions({ mode: "ephemeral" }).ephemeral).toBe(true);
      expect(parseOptions({ mode: "Ephemeral" }).ephemeral).toBe(false);
      expect(parseOptions({ mode: true }).ephemeral).toBe(false);
    });

    it("warns on an unrecognized string mode and stays persistent", () => {
      expect(parseOptions({ mode: "ephemerl" }).warnings).toEqual([
        'unrecognized mode "ephemerl"; running in persistent mode',
      ]);
      for (const mode of ["", "persistent", 7, undefined]) {
        expect(parseOptions({ mode }).warnings).toEqual([]);
      }
    });

    it("notes each option ephemeral mode ignores, in order, and drops them", () => {
      const resolved = parseOptions({
        mode: "ephemeral",
        storePath: "/tmp/store.db",
        semantic: true,
        summaries: { enabled: true, model: "p/m" },
        compactionRecall: true,
      });
      expect(resolved.warnings).toEqual([
        "ephemeral mode: storePath is ignored (no store is opened)",
        "ephemeral mode: semantic is forced off (the embedder caches model weights on disk)",
        "ephemeral mode: summaries are inert (they require the persistent store)",
        "ephemeral mode: compactionRecall is inert (it reads the persistent store)",
      ]);
      expect(resolved.storePath).toBeUndefined();
      expect(resolved.semantic).toBeUndefined();
    });

    it("keeps a configured storePath in persistent mode, ignoring blank strings", () => {
      expect(parseOptions({ storePath: "/tmp/store.db" }).storePath).toBe("/tmp/store.db");
      expect(parseOptions({ storePath: "   " }).storePath).toBeUndefined();
      expect(parseOptions({ mode: "ephemeral", storePath: "  " }).warnings).toEqual([]);
    });
  });

  describe("limits", () => {
    it("floors values and clamps them to their minimums", () => {
      const { limits } = parseOptions({
        concurrency: 0,
        maxResults: 7.9,
        defaultWidth: 10,
        distillDelayMs: -5,
        drillPageMessages: 3.2,
      });
      expect(limits.concurrency).toBe(1);
      expect(limits.maxResults).toBe(7);
      expect(limits.defaultWidth).toBe(50);
      expect(limits.distillDelayMs).toBe(0);
      expect(limits.drillPageMessages).toBe(3);
    });

    it("disables the cold pass only for literal false", () => {
      expect(parseOptions({ coldPass: false }).limits.coldPass).toBe(false);
      expect(parseOptions({ coldPass: 0 }).limits.coldPass).toBe(true);
    });

    it("bounds semanticSlots between 0 and the drill fan-out", () => {
      expect(parseOptions({ drillSessions: 4, semanticSlots: 9 }).limits.semanticSlots).toBe(4);
      expect(parseOptions({ semanticSlots: -3 }).limits.semanticSlots).toBe(0);
      expect(parseOptions({ semanticSlots: 0 }).limits.semanticSlots).toBe(0);
      // drillSessions clamps to 1 first, and the slots follow it.
      expect(parseOptions({ drillSessions: 0, semanticSlots: 5 }).limits.semanticSlots).toBe(1);
    });
  });

  describe("semantic", () => {
    it("is off unless semantic is literally true", () => {
      expect(parseOptions({ semantic: "true" }).semantic).toBeUndefined();
      expect(parseOptions({ semantic: true }).semantic).toEqual({
        model: DEFAULT_SEMANTIC_MODEL,
        weight: DEFAULT_SEMANTIC_WEIGHT,
      });
    });

    it("clamps the weight and falls back on non-finite or non-number values", () => {
      const weight = (semanticWeight: unknown) =>
        parseOptions({ semantic: true, semanticWeight }).semantic?.weight;
      expect(weight(2)).toBe(0.95);
      expect(weight(0)).toBe(0.05);
      expect(weight(0.5)).toBe(0.5);
      expect(weight(Number.NaN)).toBe(DEFAULT_SEMANTIC_WEIGHT);
      expect(weight("0.5")).toBe(DEFAULT_SEMANTIC_WEIGHT);
    });

    it("uses a configured model and ignores a blank one", () => {
      expect(parseOptions({ semantic: true, semanticModel: "org/model" }).semantic?.model).toBe(
        "org/model",
      );
      expect(parseOptions({ semantic: true, semanticModel: " " }).semantic?.model).toBe(
        DEFAULT_SEMANTIC_MODEL,
      );
    });
  });

  describe("summaries", () => {
    it("is absent unless enabled is literally true", () => {
      expect(parseOptions({ summaries: { model: "p/m" } }).summaries).toBeUndefined();
      expect(parseOptions({ summaries: { enabled: "true", model: "p/m" } }).summaries).toBe(
        undefined,
      );
      expect(parseOptions({ summaries: true }).summaries).toBeUndefined();
    });

    it("parses the model on the first slash", () => {
      expect(
        parseOptions({ summaries: { enabled: true, model: "openrouter/org/model" } }).summaries,
      ).toEqual({ config: { providerID: "openrouter", modelID: "org/model" } });
    });

    it("leaves config undefined for a missing or malformed model", () => {
      for (const model of [undefined, "", "no-slash", "/model", "provider/"]) {
        expect(parseOptions({ summaries: { enabled: true, model } }).summaries).toEqual({
          config: undefined,
        });
      }
    });

    it("carries agent and a floored positive maxPromptsPerPass", () => {
      expect(
        parseOptions({
          summaries: { enabled: true, model: "p/m", agent: "quiet", maxPromptsPerPass: 3.9 },
        }).summaries?.config,
      ).toEqual({ providerID: "p", modelID: "m", agent: "quiet", maxPromptsPerPass: 3 });
      for (const maxPromptsPerPass of [0, -1, Number.POSITIVE_INFINITY, "4"]) {
        expect(
          parseOptions({ summaries: { enabled: true, model: "p/m", maxPromptsPerPass } }).summaries
            ?.config,
        ).toEqual({ providerID: "p", modelID: "m" });
      }
    });
  });
});
