import { GHOST_DIR } from "../helpers.js";
import type { EvalCase } from "./harness.js";

/**
 * Labeled relevance cases over the eval corpus (see corpus.ts).
 *
 * Each case targets a specific ranking competency. All use group:"session" and
 * smart match so scoring is by session relevance rank. scope:"global" so the
 * cross-project session (e-other) is reachable.
 */
export const EVAL_CASES: EvalCase[] = [
  {
    // IDF: a rare term must beat boilerplate-heavy sessions.
    name: "rare-term: ECONNREFUSED",
    args: { query: "ECONNREFUSED", match: "smart", group: "session", scope: "global" },
    relevantSessionIDs: ["e-auth"],
  },
  {
    // Vague semantic-ish recall via overlapping lexical terms.
    name: "decision: postgres over dynamodb",
    args: {
      query: "chose postgres over dynamodb",
      match: "smart",
      group: "session",
      scope: "global",
    },
    relevantSessionIDs: ["e-db"],
  },
  {
    // Multi-term coverage; the reasoning/user message should beat the long
    // boilerplate tool dump in the same and other sessions.
    name: "multi-term: rate limit middleware token bucket",
    args: {
      query: "rate limit middleware token bucket",
      match: "smart",
      group: "session",
      scope: "global",
    },
    relevantSessionIDs: ["e-rate"],
  },
  {
    // Exact phrase preference.
    name: 'phrase: "token bucket"',
    args: {
      query: '"token bucket" checkout',
      match: "smart",
      group: "session",
      scope: "global",
    },
    relevantSessionIDs: ["e-rate"],
  },
  {
    // Typo tolerance: 'postgers' -> 'postgres'.
    name: "typo: postgers migration",
    args: { query: "postgers migration", match: "fuzzy", group: "session", scope: "global" },
    relevantSessionIDs: ["e-db"],
  },
  {
    // Cross-project error recall: only e-other has this.
    name: "cross-project: permission denied configmaps",
    args: {
      query: "permission denied configmaps namespace",
      match: "smart",
      group: "session",
      scope: "global",
    },
    relevantSessionIDs: ["e-other"],
  },
  {
    // Old-strong vs recent-weak: e-rate (older, strong) must beat e-noise
    // (recent, weak "rate" mention) for a rate-limiter query.
    name: "old-strong vs recent-weak: rate limiter checkout",
    args: {
      query: "rate limiter checkout",
      match: "smart",
      group: "session",
      scope: "global",
    },
    relevantSessionIDs: ["e-rate"],
  },
  {
    // OAuth redirect recall, where a long build-output dump in the same
    // session also contains "redirect".
    name: "redirect loop oauth",
    args: {
      query: "oauth redirect loop login callback",
      match: "smart",
      group: "session",
      scope: "global",
    },
    relevantSessionIDs: ["e-auth"],
  },
  {
    // Field report: historical-workflow discovery. The current conversation
    // (e-cur) parrots the whole query; default current-session exclusion must
    // keep it out so the real workflow session (e-flow, misleading title in
    // the ghostauth directory) can surface.
    name: "field-report: prior ghostauth/tuistory workflow excludes current session",
    args: {
      query: "ghostauth tuistory test opencode plugin auth login debug workflow",
      match: "smart",
      group: "session",
      scope: "global",
    },
    ctxSessionID: "e-cur",
    relevantSessionIDs: ["e-flow"],
    expect: {
      notInResults: ["e-cur", "e-cur-sub"],
      // The grouped representative must be conversational or action evidence,
      // never the skill payload that happens to score well lexically.
      classInTop3: ["human-text", "tool-input"],
      maxClassInTop5: { "skill-definition": 0 },
    },
  },
  {
    // Field report: an exact tool query must surface concrete actions (bash
    // tool inputs), not the skill payload that mentions the tool everywhere.
    name: "field-report: exact tool query prefers tool-input evidence",
    args: {
      query: "tuistory",
      match: "smart",
      group: "part",
      scope: "global",
      directory: GHOST_DIR,
    },
    relevantSessionIDs: ["e-flow"],
    expect: { classInTop3: ["tool-input"], maxClassInTop5: { "skill-definition": 1 } },
  },
  {
    // Field report: a literal scan floods with skill payloads by scan order
    // alone (three skill parts across e-flow/e-docs); the class-cap pass must
    // keep the top five diverse regardless of ranking.
    name: "field-report: literal tuistory flood capped to one skill hit",
    args: {
      query: "tuistory",
      match: "literal",
      group: "part",
      scope: "global",
      directory: GHOST_DIR,
    },
    relevantSessionIDs: ["e-flow"],
    expect: { maxClassInTop5: { "skill-definition": 1 } },
  },
  {
    // Field report: authored usage of an API outranks the generic skill body
    // that also contains the literal.
    name: "field-report: authored launchTerminal usage outranks skill body",
    args: {
      query: "launchTerminal",
      match: "smart",
      group: "part",
      scope: "global",
    },
    relevantSessionIDs: ["e-flow"],
    expect: { classInTop3: ["human-text"] },
  },
  {
    // Field report: title/content bridge — deferred from the two-stage-search
    // phase to the session-digest phase. Both sessions' strongest lexical hits
    // are file reads; only the content-derived digest (built from statements
    // and commands, never reads) can order the DOING session above the
    // READING session.
    name: "field-report: ghostauth live test bridges metadata and content",
    args: {
      query: "ghostauth live test",
      match: "smart",
      group: "session",
      scope: "global",
    },
    relevantSessionIDs: ["e-flow"],
  },
];
