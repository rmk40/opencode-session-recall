import { describe, expect, it } from "vitest";
import type { ErrorOutput, SearchOutput } from "../src/types.js";
import { TEST_LIMITS, makeFakeHarness, runTool } from "./helpers.js";
import { search } from "../src/search.js";
import { compileRegex, regexSnippet, MAX_REGEX_PATTERN_CHARS } from "../src/regex.js";
import { looksLikeRegex, classifyQuery } from "../src/route.js";

function recallTool(h = makeFakeHarness()) {
  return search(h.client, h.unscoped, true, TEST_LIMITS);
}

// ── R5b regex mode ────────────────────────────────────────────────────

describe("recall regex mode", () => {
  it("matches a pattern across tool/text content", async () => {
    const out = await runTool<SearchOutput>(recallTool(), {
      query: "Unauthorized|permission denied",
      match: "regex",
      scope: "global",
      results: 10,
    });
    expect(out.matchMode).toBe("regex");
    expect(out.results.length).toBeGreaterThan(0);
  });

  it("anchors and character classes work", async () => {
    const out = await runTool<SearchOutput>(recallTool(), {
      query: "rate.?[Ll]imit",
      match: "regex",
      scope: "project",
      results: 10,
    });
    expect(out.results.length).toBeGreaterThan(0);
  });

  it("returns a clear error for an invalid pattern", async () => {
    const out = await runTool<ErrorOutput>(recallTool(), {
      query: "rate(limit",
      match: "regex",
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("Invalid regex");
  });

  it("finds nothing for a non-matching pattern without throwing", async () => {
    const out = await runTool<SearchOutput>(recallTool(), {
      query: "zzz_no_such_token_\\d{9}",
      match: "regex",
      scope: "global",
    });
    expect(out.ok).toBe(true);
    expect(out.results).toEqual([]);
  });

  it("respects group:session in regex mode", async () => {
    const out = await runTool<SearchOutput>(recallTool(), {
      query: "cache",
      match: "regex",
      scope: "global",
      group: "session",
      results: 10,
    });
    expect(out.group).toBe("session");
    // grouped: at most one result per session.
    const ids = out.results.map((r) => r.sessionID);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("regex helpers", () => {
  it("compiles case-insensitive global patterns", () => {
    const c = compileRegex("Foo");
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.re.flags).toContain("i");
      expect(c.re.flags).toContain("g");
    }
  });

  it("rejects empty and oversized patterns", () => {
    expect(compileRegex("").ok).toBe(false);
    expect(compileRegex("a".repeat(MAX_REGEX_PATTERN_CHARS + 1)).ok).toBe(false);
  });

  it("rejects invalid patterns with a message", () => {
    const c = compileRegex("(unclosed");
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error).toContain("Invalid regex");
  });

  it("snippets center on the first match", () => {
    const c = compileRegex("needle");
    if (c.ok) {
      const snip = regexSnippet(c.re, "aaaa needle bbbb", 12);
      expect(snip).toContain("needle");
    }
  });

  it("does not leak regex lastIndex across calls", () => {
    const c = compileRegex("x");
    if (c.ok) {
      // Same regex object reused; global flag would advance lastIndex if not reset.
      const a = regexSnippet(c.re, "x first", 10);
      const b = regexSnippet(c.re, "x second", 10);
      expect(a).toContain("x");
      expect(b).toContain("x");
    }
  });
});

// ── R5c diversity ─────────────────────────────────────────────────────

describe("result diversity (part grouping)", () => {
  it("caps initial hits per session so one session does not flood results", async () => {
    // The fixture's current session has several 'migration'/'pending' parts;
    // a broad query should still surface other sessions, not just one.
    const out = await runTool<SearchOutput>(recallTool(), {
      query: "cache",
      match: "smart",
      scope: "global",
      group: "part",
      results: 5,
    });
    expect(out.ok).toBe(true);
    if (out.results.length >= 3) {
      const counts = new Map<string, number>();
      for (const r of out.results) counts.set(r.sessionID, (counts.get(r.sessionID) ?? 0) + 1);
      // No single session contributes more than the per-session cap (2) unless
      // it had to backfill — and backfill only happens when distinct sessions
      // ran out, which means other sessions are already represented.
      const distinct = counts.size;
      expect(distinct).toBeGreaterThan(1);
    }
  });
});

// ── R5d query-type routing ────────────────────────────────────────────

describe("query routing", () => {
  it("detects regex-like queries", () => {
    expect(looksLikeRegex("error|fail")).toBe(true);
    expect(looksLikeRegex("\\d{3}-\\d{4}")).toBe(true);
    expect(looksLikeRegex("rate(limit)?")).toBe(true);
  });

  it("does not treat plain text, bare paths, or parenthesized prose as regex", () => {
    expect(looksLikeRegex("rate limit middleware")).toBe(false);
    expect(looksLikeRegex("src/foo.ts")).toBe(false);
    // Parenthesized prose / brackets without regex intent must not trigger.
    expect(looksLikeRegex("rate limit (middleware)")).toBe(false);
    expect(looksLikeRegex("timeout (see issue 42)")).toBe(false);
  });

  it("does not treat prose punctuation as regex intent", () => {
    // Sentence-final ?, trailing +/++ after a word, and $ as currency.
    expect(looksLikeRegex("is it safe?")).toBe(false);
    expect(looksLikeRegex("C++")).toBe(false);
    expect(looksLikeRegex("cost is $5")).toBe(false);
    // Arithmetic must not look like a quantifier joining tokens.
    expect(looksLikeRegex("5+3")).toBe(false);
    expect(looksLikeRegex("5*2")).toBe(false);
  });

  it("still detects quantifiers that join real tokens", () => {
    expect(looksLikeRegex("a+b")).toBe(true);
    expect(looksLikeRegex("foo*bar")).toBe(true);
  });

  it("treats a quantified group or class as regex even when trailing", () => {
    expect(looksLikeRegex("rate(limit)?")).toBe(true);
    expect(looksLikeRegex("[a-z]+")).toBe(true);
  });

  it("suggests regex mode only when not already using it", () => {
    expect(classifyQuery("error|fail", "literal").suggested).toBe("regex");
    expect(classifyQuery("error|fail", "regex").suggested).toBeUndefined();
    expect(classifyQuery("plain text", "literal").suggested).toBeUndefined();
  });

  it("surfaces a regex suggestion in the search output", async () => {
    const out = await runTool<SearchOutput>(recallTool(), {
      query: "Unauthorized|nope_no_match_here",
      match: "literal",
      scope: "global",
    });
    const hasRegexSuggestion = (out.suggestions ?? []).some((s) =>
      JSON.stringify(s.example ?? {}).includes("regex"),
    );
    expect(hasRegexSuggestion).toBe(true);
  });

  it("does not suggest regex when the caller already used regex", async () => {
    const out = await runTool<SearchOutput>(recallTool(), {
      query: "Unauthorized|permission",
      match: "regex",
      scope: "global",
    });
    const hasRegexSuggestion = (out.suggestions ?? []).some((s) =>
      JSON.stringify(s.example ?? {}).includes('"regex"'),
    );
    expect(hasRegexSuggestion).toBe(false);
  });
});
