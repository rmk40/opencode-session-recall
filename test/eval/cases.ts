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
];
