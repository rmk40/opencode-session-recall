/**
 * Regex match mode for `recall`.
 *
 * A bounded scan over candidate raw text using a user-supplied RegExp. Bypasses
 * BM25/literal entirely — useful for error codes, stack traces, file paths, IDs,
 * URLs, and command patterns where the caller knows the exact shape.
 *
 * Safety: invalid patterns are a caller error (hard error upstream). The only
 * runtime guards are LENGTH CAPS — the pattern is capped at
 * MAX_REGEX_PATTERN_CHARS and each field is truncated to MAX_REGEX_FIELD_CHARS
 * before matching. There is NO per-match timeout: JS regex is synchronous and
 * uninterruptible, so a pathological pattern (e.g. nested quantifiers like
 * `(a+)+$`) over a crafted field can still backtrack catastrophically and block.
 * This is acceptable only because regex mode is explicit, local, single-user,
 * and never on the automatic critical path (the auto-recall/compaction hooks
 * hardcode match:"smart"). Stateful global regexes are reset around exec to
 * avoid `lastIndex` leakage across fields.
 */

/** Max chars of a single field scanned. Bounds input size only — it does NOT
 *  prevent catastrophic backtracking on a crafted pattern (see header). */
const MAX_REGEX_FIELD_CHARS = 50_000;

/** Max pattern length accepted. Caps input size only; a short pattern such as
 *  `(a+)+$` can still backtrack catastrophically (see header). */
export const MAX_REGEX_PATTERN_CHARS = 1_000;

export type CompiledRegex = { ok: true; re: RegExp } | { ok: false; error: string };

/**
 * Compile a user regex. Case-insensitive by default; `g` is always set so we can
 * find match positions for snippets. Returns a structured error rather than
 * throwing so the caller can surface a clean message.
 */
export function compileRegex(pattern: string): CompiledRegex {
  if (pattern.length === 0) return { ok: false, error: "Empty regex pattern." };
  if (pattern.length > MAX_REGEX_PATTERN_CHARS) {
    return {
      ok: false,
      error: `Regex pattern too long (max ${MAX_REGEX_PATTERN_CHARS} chars).`,
    };
  }
  try {
    return { ok: true, re: new RegExp(pattern, "gi") };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Invalid regex: ${msg}` };
  }
}

/** Find the index of the first regex match in text, or -1. Resets regex state. */
export function regexFirstIndex(re: RegExp, text: string): number {
  const slice = text.length > MAX_REGEX_FIELD_CHARS ? text.slice(0, MAX_REGEX_FIELD_CHARS) : text;
  re.lastIndex = 0;
  const m = re.exec(slice);
  re.lastIndex = 0;
  return m ? m.index : -1;
}

/**
 * Build a snippet centered on the first regex match. `matchIndex` may be passed
 * to reuse an index already computed by the scan (avoids a second exec on
 * expensive patterns); when omitted it is computed here.
 */
export function regexSnippet(re: RegExp, text: string, width = 200, matchIndex?: number): string {
  const idx = matchIndex ?? regexFirstIndex(re, text);
  if (idx === -1) return text.slice(0, width) + (text.length > width ? "..." : "");

  const half = Math.floor(width / 2);
  let start = Math.max(0, idx - half);
  const end = Math.min(text.length, start + width);
  if (end - start < width && start > 0) start = Math.max(0, end - width);

  let result = text.slice(start, end);
  if (start > 0) result = "..." + result;
  if (end < text.length) result = result + "...";
  return result;
}
