import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tool } from "@opencode-ai/plugin";
import { search } from "../src/search.js";
import type { SearchOutput, ErrorOutput } from "../src/types.js";
import {
  PROJECT_DIR,
  TEST_LIMITS,
  makeContext,
  makeFakeHarness,
  makeRecallDeps,
  makeStoreNullDeps,
  runTool,
  runToolRaw,
  setStrictNoLimitMessages,
  type FakeHarness,
} from "./helpers.js";

/**
 * Configured ephemeral mode: coverage marker + wording, the scope-default
 * flip and its deep-gate explicitness fork, and content recall via live drill
 * with no store. The whole suite runs under strict no-limit enforcement so a
 * reintroduced unbounded `session.messages` fetch fails loudly.
 */

beforeAll(() => setStrictNoLimitMessages(true));
afterAll(() => setStrictNoLimitMessages(false));

function ephemeralTool(h: FakeHarness, opts: Parameters<typeof makeStoreNullDeps>[2] = {}) {
  const { deps } = makeStoreNullDeps(h, TEST_LIMITS, { mode: "ephemeral", ...opts });
  return search(h.client, h.unscoped, true, TEST_LIMITS, deps);
}

function degradedTool(h: FakeHarness) {
  // Store-null WITHOUT mode: the accidental driver-missing degraded path.
  const { deps } = makeStoreNullDeps(h, TEST_LIMITS);
  return search(h.client, h.unscoped, true, TEST_LIMITS, deps);
}

/** Age every fixture session so a since:"1h" window has zero eligible cards. */
function agedHarness(): FakeHarness {
  const h = makeFakeHarness();
  const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
  for (const s of [...h.sessions, ...h.globalSessions]) s.time.updated = old;
  return h;
}

describe("ephemeral coverage marker + wording", () => {
  it("sets top-level coverage.mode and uses configured-not-broken warning wording", async () => {
    const out = await runToolRaw<SearchOutput>(ephemeralTool(makeFakeHarness()), {
      query: "rateLimit cache",
      match: "smart",
    });
    expect(out.ok).toBe(true);
    expect(out.coverage?.mode).toBe("ephemeral");
    // cards.degraded stays true — accurate — and the block reads full:0.
    expect(out.coverage?.cards).toMatchObject({ full: 0, storeRecency: 0, degraded: true });

    // Own regex, deliberately NOT the eval's /metadata-only|degraded/i.
    const ephemeralWarning = out.warnings?.find((w) =>
      /Ephemeral mode \(configured\).*live drill/.test(w),
    );
    expect(ephemeralWarning).toBeDefined();
    expect(ephemeralWarning).not.toMatch(/metadata-only|degraded/i);
  });

  it("rewords the stale-window degraded suggestion for snapshot lag", async () => {
    const out = await runToolRaw<SearchOutput>(ephemeralTool(agedHarness()), {
      query: "fix review findings batch",
      since: "1h",
    });
    expect(out.coverage?.mode).toBe("ephemeral");
    const suggestion = out.suggestions?.[0];
    expect(suggestion?.reason).toMatch(/No persistent index by configuration \(ephemeral mode\)/);
    expect(suggestion?.reason).toMatch(/live drill/);
    expect(suggestion?.reason).not.toMatch(/metadata-only|degraded/i);
    expect(suggestion?.action).toContain("recall_sessions");
    expect(suggestion?.action).toContain("sessions: [...]");
  });

  it("keeps the driver-missing degraded wording byte-identical (regression pin)", async () => {
    const out = await runToolRaw<SearchOutput>(degradedTool(agedHarness()), {
      query: "fix review findings batch",
      scope: "project",
      since: "1h",
    });
    expect(out.coverage?.mode).toBeUndefined();
    expect(out.warnings).toContain(
      "Cards are metadata-only (card store unavailable); content search is degraded.",
    );
    expect(out.suggestions?.[0]).toEqual({
      reason: "No content index is available (degraded mode); recent sessions are not searchable.",
      action:
        "Use recall_sessions for live session metadata; recall_messages reads a known session directly.",
    });
  });

  it("adds the mode-aware description line only in ephemeral mode", () => {
    const h = makeFakeHarness();
    const ephemeral = ephemeralTool(h);
    const persistent = degradedTool(h);
    expect(ephemeral.description).toContain('The default scope in this mode is "project"');
    expect(ephemeral.description).toContain("not an empty history");
    expect(persistent.description).not.toContain("Ephemeral mode");
    // The static "First call" recipe must not contradict the ephemeral default:
    // a `scope:"global" (default)` clause would instruct the model to always
    // pass global, nullifying the scope flip.
    expect(ephemeral.description).not.toContain('scope:"global" (default)');
    expect(ephemeral.description).toContain('scope:"project" (default in this mode');
    expect(persistent.description).toContain('scope:"global" (default)');
  });
});

describe("ephemeral scope default flip", () => {
  it("raw path (host bypasses Zod): omitted scope resolves to project", async () => {
    const out = await runToolRaw<SearchOutput>(ephemeralTool(makeFakeHarness()), {
      query: "Actualyze",
      match: "smart",
    });
    expect(out.ok).toBe(true);
    // The other-project session is bucketed out by the project default.
    expect(out.results.every((r) => r.sessionID !== "s-other")).toBe(true);
    expect(out.coverage?.limitedBy).toContain("scope");
    expect(out.coverage?.skippedByReason?.directory).toBe(1);
  });

  it("parsed path: the .optional() schema materializes no default and omitted scope validates", async () => {
    const definition = ephemeralTool(makeFakeHarness());
    // Direct schema proof: no Zod default lands on parsed args.
    expect(tool.schema.object(definition.args).parse({ query: "x" }).scope).toBeUndefined();

    const out = await runTool<SearchOutput>(definition, { query: "Actualyze", match: "smart" });
    expect(out.ok).toBe(true);
    expect(out.results.every((r) => r.sessionID !== "s-other")).toBe(true);
    expect(out.coverage?.limitedBy).toContain("scope");
  });

  it("raw junk scope warns and falls back to project", async () => {
    const out = await runToolRaw<SearchOutput>(ephemeralTool(makeFakeHarness()), {
      query: "Actualyze",
      match: "smart",
      scope: "bogus",
    });
    expect(out.warnings?.some((w) => w.includes('Ignored scope:"bogus"'))).toBe(true);
    expect(out.warnings?.some((w) => w.includes('using scope:"project"'))).toBe(true);
    expect(out.results.every((r) => r.sessionID !== "s-other")).toBe(true);
  });

  it("explicit scope:'global' is always honored", async () => {
    const out = await runToolRaw<SearchOutput>(ephemeralTool(makeFakeHarness()), {
      query: "Actualyze",
      match: "smart",
      scope: "global",
    });
    expect(out.results.some((r) => r.sessionID === "s-other")).toBe(true);
  });

  it("persistent mode (store-backed) still defaults to global", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await makeRecallDeps(h);
    try {
      const definition = search(h.client, h.unscoped, true, TEST_LIMITS, deps);
      // Schema default is untouched too.
      expect(tool.schema.object(definition.args).parse({ query: "x" }).scope).toBe("global");
      const out = await runToolRaw<SearchOutput>(definition, {
        query: "Actualyze",
        match: "smart",
      });
      expect(out.results.some((r) => r.sessionID === "s-other")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("persistent store-null degraded still defaults to global (never inferred from store===null)", async () => {
    const out = await runToolRaw<SearchOutput>(degradedTool(makeFakeHarness()), {
      query: "Actualyze",
      match: "smart",
    });
    expect(out.results.some((r) => r.sessionID === "s-other")).toBe(true);
  });

  it("without ctx.directory the project default degrades toward global", async () => {
    const { ctx } = makeContext({
      directory: undefined as unknown as string,
      worktree: undefined as unknown as string,
    });
    const out = await runToolRaw<SearchOutput>(
      ephemeralTool(makeFakeHarness()),
      { query: "Actualyze", match: "smart" },
      ctx,
    );
    // No usable project directory → no bucket filter; only the default label moved.
    expect(out.results.some((r) => r.sessionID === "s-other")).toBe(true);
    expect(out.coverage?.skippedByReason?.directory).toBeUndefined();
  });
});

describe("ephemeral deep-gate explicitness (unconditional fork)", () => {
  const REJECTION =
    "deep requires scope: pass sessions:[...], or set a lower time bound (since/last/from) together with project:true or a directory. A global unscoped deep sweep is not allowed.";

  it("rejects a defaulted-scope deep in ephemeral mode despite the resolved project scope", async () => {
    const out = await runToolRaw<ErrorOutput>(ephemeralTool(makeFakeHarness()), {
      query: "rateLimit",
      deep: true,
      since: "7d",
    });
    expect(out).toEqual({ ok: false, error: REJECTION });
  });

  it("rejects a defaulted-scope deep in persistent mode with the same message (pinned)", async () => {
    const h = makeFakeHarness();
    const { deps, cleanup } = await makeRecallDeps(h);
    try {
      const definition = search(h.client, h.unscoped, true, TEST_LIMITS, deps);
      const rejected = await runToolRaw<ErrorOutput>(definition, {
        query: "rateLimit",
        deep: true,
        since: "7d",
      });
      expect(rejected).toEqual({ ok: false, error: REJECTION });

      // Persistent gate behavior pinned: an explicit project constraint passes.
      const accepted = await runToolRaw<SearchOutput>(definition, {
        query: "rateLimit",
        deep: true,
        since: "7d",
        scope: "project",
      });
      expect(accepted.ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("accepts deep with an explicit project-valued constraint in ephemeral mode", async () => {
    const definition = ephemeralTool(makeFakeHarness());
    const viaScope = await runToolRaw<SearchOutput>(definition, {
      query: "rateLimit",
      deep: true,
      since: "7d",
      scope: "project",
    });
    expect(viaScope.ok).toBe(true);

    const viaProject = await runToolRaw<SearchOutput>(definition, {
      query: "rateLimit",
      deep: true,
      since: "7d",
      project: true,
    });
    expect(viaProject.ok).toBe(true);
  });

  it("an explicit scope:'global' does not qualify as a project constraint", async () => {
    const out = await runToolRaw<ErrorOutput>(ephemeralTool(makeFakeHarness()), {
      query: "rateLimit",
      deep: true,
      since: "7d",
      scope: "global",
    });
    expect(out).toEqual({ ok: false, error: REJECTION });
  });

  it("a raw junk scope coerced to project does not count as explicit for the gate", async () => {
    // The runtime fallback resolves "bogus" → "project", but the gate reads the
    // RAW args: a coerced default must never satisfy explicitness.
    const out = await runToolRaw<ErrorOutput>(ephemeralTool(makeFakeHarness()), {
      query: "rateLimit",
      deep: true,
      since: "7d",
      scope: "bogus",
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe(REJECTION);
  });

  it("accepts deep via sessions:[...] and via sessionID in ephemeral mode", async () => {
    const definition = ephemeralTool(makeFakeHarness());
    const viaSessions = await runToolRaw<SearchOutput>(definition, {
      query: "rateLimit",
      deep: true,
      sessions: ["s-project-2"],
    });
    expect(viaSessions.ok).toBe(true);
    expect(viaSessions.coverage?.deep).toBeDefined();

    const viaSessionID = await runToolRaw<SearchOutput>(definition, {
      query: "rateLimit",
      deep: true,
      sessionID: "s-project-2",
    });
    expect(viaSessionID.ok).toBe(true);
  });

  it("accepts deep via explicit scope:'session' with a current session; rejects without one", async () => {
    const definition = ephemeralTool(makeFakeHarness());
    const withCurrent = await runToolRaw<SearchOutput>(definition, {
      query: "rateLimit",
      deep: true,
      scope: "session",
    });
    expect(withCurrent.ok).toBe(true);

    // No current session and no other constraint: scope:"session" alone is not
    // a concrete target and must not slip through the gate.
    const { ctx } = makeContext({ sessionID: undefined as unknown as string });
    const withoutCurrent = await runToolRaw<ErrorOutput>(
      definition,
      { query: "rateLimit", deep: true, scope: "session", since: "7d" },
      ctx,
    );
    expect(withoutCurrent).toEqual({ ok: false, error: REJECTION });
  });

  it("accepts deep via a directory filter + time bound in both modes", async () => {
    const ephemeralOut = await runToolRaw<SearchOutput>(ephemeralTool(makeFakeHarness()), {
      query: "rateLimit",
      deep: true,
      since: "7d",
      directory: PROJECT_DIR,
    });
    expect(ephemeralOut.ok).toBe(true);

    const h = makeFakeHarness();
    const { deps, cleanup } = await makeRecallDeps(h);
    try {
      const definition = search(h.client, h.unscoped, true, TEST_LIMITS, deps);
      const persistentOut = await runToolRaw<SearchOutput>(definition, {
        query: "rateLimit",
        deep: true,
        since: "7d",
        directory: PROJECT_DIR,
      });
      expect(persistentOut.ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("rejects an explicit project constraint without a lower time bound in both modes", async () => {
    const ephemeralOut = await runToolRaw<ErrorOutput>(ephemeralTool(makeFakeHarness()), {
      query: "rateLimit",
      deep: true,
      scope: "project",
    });
    expect(ephemeralOut).toEqual({ ok: false, error: REJECTION });

    const h = makeFakeHarness();
    const { deps, cleanup } = await makeRecallDeps(h);
    try {
      const definition = search(h.client, h.unscoped, true, TEST_LIMITS, deps);
      const persistentOut = await runToolRaw<ErrorOutput>(definition, {
        query: "rateLimit",
        deep: true,
        project: true,
      });
      expect(persistentOut).toEqual({ ok: false, error: REJECTION });
    } finally {
      cleanup();
    }
  });
});

describe("ephemeral refresh trigger wiring at the search tool entry", () => {
  it("fires maybeRefresh once per execute, even when the query is rejected", async () => {
    let calls = 0;
    const definition = ephemeralTool(makeFakeHarness(), { maybeRefresh: () => calls++ });

    await runToolRaw<SearchOutput>(definition, { query: "Actualyze", match: "smart" });
    expect(calls).toBe(1);

    // A gate-rejected deep still counts a trigger: it fires at query entry,
    // before any validation.
    const rejected = await runToolRaw<ErrorOutput>(definition, {
      query: "rateLimit",
      deep: true,
      since: "7d",
    });
    expect(rejected.ok).toBe(false);
    expect(calls).toBe(2);
  });
});

describe("ephemeral content recall via live drill (strict no-limit)", () => {
  it("finds message content with no store through the bounded drill path (not a title hit)", async () => {
    // "permission denied" exists only in s-project-2's tool-error content —
    // no fixture title contains it — so a hit here can only come from a live
    // drilled message part, proving content search works storeless.
    const out = await runToolRaw<SearchOutput>(ephemeralTool(makeFakeHarness()), {
      query: "permission denied checkout cache",
      match: "smart",
    });
    expect(out.ok).toBe(true);
    expect(out.coverage?.mode).toBe("ephemeral");
    // Order-independent: any s-project-2 hit qualifies as long as it is a
    // content (non-title) hit carrying the content-only needle.
    expect(
      out.results.some(
        (r) =>
          r.sessionID === "s-project-2" &&
          r.source !== "title" &&
          r.snippet.includes("permission denied"),
      ),
    ).toBe(true);
  });
});
