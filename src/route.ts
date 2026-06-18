import type { MatchMode } from "./types.js";

/**
 * Lightweight, conservative query-shape classification.
 *
 * This never overrides the caller's `match` — it only powers *suggestions* so
 * the agent can opt into a better mode. Determinism and zero false-confidence
 * matter more than cleverness here.
 */

/**
 * Constructs that signal deliberate regex *intent* (not just any metachar).
 * Bare `()` / `.` are excluded because parenthesized prose ("rate limit
 * (middleware)") and file paths ("src/foo.ts") use them benignly. The rules
 * also avoid common prose false positives: a sentence-final `?` ("is it safe?"),
 * a trailing `+`/`++` after a bare word ("C++", "5+"), and `$`/`^` used as a
 * currency sign or bullet rather than an anchor.
 */
const REGEX_INTENT = [
  /\\[dwsbDWSB]/, // escape classes: \d \w \s \b
  /\[[^\]]+\]/, // character class: [a-z]
  /[)\]][*+?]/, // quantifier on a group/class: (limit)?  [a-z]+
  /[a-zA-Z0-9][*+?][a-zA-Z([\\]/, // quantifier joining tokens: a+b, foo*bar (not arithmetic like 5+3)
  /\{\d+(?:,\d*)?\}/, // counted quantifier: {3} {2,5}
  /\S\|\S/, // alternation between two tokens: a|b
  /^\^/, // leading anchor: ^foo
  /\$$/, // trailing anchor: foo$
];

/**
 * Looks like a deliberate regex: shows regex *intent* AND compiles as a valid
 * RegExp. Conservative on purpose — this only drives a non-overriding
 * suggestion, so false negatives are cheaper than false positives.
 */
export function looksLikeRegex(query: string): boolean {
  if (!REGEX_INTENT.some((re) => re.test(query))) return false;
  try {
    new RegExp(query);
    return true;
  } catch {
    return false;
  }
}

export type QueryClass = {
  /** Suggested mode, if the shape clearly implies one. Undefined = no opinion. */
  suggested?: MatchMode;
  reason?: string;
};

/**
 * Classify a query against the mode the caller actually used. Returns a
 * suggestion only when the shape clearly implies a different, better mode.
 */
export function classifyQuery(query: string, usedMode: MatchMode): QueryClass {
  if (usedMode !== "regex" && looksLikeRegex(query)) {
    return {
      suggested: "regex",
      reason: "The query contains regex metacharacters.",
    };
  }
  return {};
}
