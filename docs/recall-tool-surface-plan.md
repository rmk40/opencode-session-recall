# Recall Tool Surface Extension Plan

## Goal

Reduce turns after a useful `recall` hit while keeping the tool surface small and generated tool-definition payload under roughly 2,000-2,200 tokens.

The common flow is `recall` to find a hit, then `recall_context` or `recall_get` to inspect enough evidence. The highest-value change is letting `recall` optionally return that evidence in the same call.

Status: implemented. The README documents the public `recall` parameters and the optional `expanded` response metadata.

## Constraints

- Keep the existing five-tool surface.
- Avoid embeddings, generated summaries, or separate storage/indexing infrastructure.
- Preserve current defaults; new behavior is opt-in.
- Keep expansion fanout bounded so `recall` cannot dump whole sessions accidentally. `expand: "message"` intentionally matches `recall_get` semantics for a small number of opted-in hits.
- Keep memory writes outside this plugin.
- Keep tool descriptions concise enough to stay within the token budget.

## Iteration 1 Scope

Added these parameters to `recall`:

- `expand`
- `expandResults`
- `window`
- `since`
- `until`
- `directory`
- `toolName`

Defer these ideas:

- `topHits`: useful, but grouped-hit/expansion composition needs more design.
- `sort`: useful for “last time,” but it interacts with grouping and literal-vs-smart ranking.
- `queries` / `also`: useful, but adds ranking/noise complexity.
- `fields`: useful only if expansion output proves too large.
- new tools such as `recall_expand`, `recall_decisions`, or `recall_remember`.

## Parameter Semantics

### `expand`

Type: `"none" | "context" | "message"`

Default: `"none"`

Semantics:

- `"none"`: current behavior.
- `"context"`: include surrounding messages for expanded hits.
- `"message"`: include the full matched message for expanded hits.

Expansion applies only to final results after filtering, grouping, sorting, and slicing. With `group: "session"`, expansion targets the representative of each of the first `expandResults` grouped results. This is explicit for iteration 1; `topHits` composition is deferred.

### `expandResults`

Type: integer number

Default: `1`

Min: `1`

Max: `3`

Semantics:

Controls how many final results are expanded when `expand !== "none"`. Ignored when `expand: "none"`.

### `window`

Type: integer number

Default: `Math.min(3, limits.maxWindow)`, same as `recall_context`

Min: `0`

Semantics:

Controls messages before and after each expanded hit when `expand: "context"`. It has the same semantics and `limits.maxWindow` clamp as `recall_context.window`, and does not affect normal snippets.

Output cap:

- Reject `expand: "context"` when `expandResults * (2 * window + 1) > 30` with an error that says to reduce `expandResults` or `window`.
- Include `hasMoreBefore` / `hasMoreAfter` for each expanded context entry.

For `expand: "message"`, return the same formatted message shape as `recall_get` for up to `expandResults` hits. Do not add a separate truncation scheme in iteration 1.

### `since` / `until`

Type: string

Accepted forms: positive integers with `h`, `d`, or `w`, such as `"2h"`, `"7d"`, `"3w"`. `0h`, minutes (`m`), months (`mo`), and years (`y`) are invalid in iteration 1.

Semantics:

- Relative durations are resolved against execution time (`Date.now()`).
- `since` maps to an `after` timestamp.
- `until` maps to a `before` timestamp.
- Invalid strings return a clear error.
- If a positive numeric `after` is supplied with `since`, return an error.
- If a positive numeric `before` is supplied with `until`, return an error.
- Nonpositive numeric `before` / `after` keep current `positiveTimestampOrUndefined` behavior and are ignored.

Bounds use existing recall semantics: `after` excludes messages at or before the timestamp; `before` excludes messages at or after the timestamp.

### `directory`

Type: string

Semantics:

Filter target sessions by normalized directory before loading messages. Match exact directory or descendant path only: `dir === target || dir.startsWith(target + pathSeparator)` after normalization. Avoid arbitrary substring matching to reduce cross-project false positives.

### `toolName`

Type: string

Semantics:

Filter searchable tool parts by exact tool name, such as `"bash"`.

- Valid only when `type` is `"all"` or `"tool"`.
- When provided with `type: "all"`, non-tool parts are excluded; only tool parts with the matching tool name are eligible.
- If `type` is `"text"` or `"reasoning"`, return a clear error.

## Output Shape

### `expanded`

When `expand !== "none"`, `SearchOutput` gains `expanded?: ExpandedResult[]`. Entries are ordered by final result order and may be sparse if an expansion cannot be produced:

```ts
type ExpandedResult = {
  resultIndex: number;
  sessionID: string;
  messageID: string;
  mode: "context" | "message";
  messages?: MessageItem[];
  message?: MessageItem;
  hasMoreBefore?: boolean;
  hasMoreAfter?: boolean;
};
```

For `expand: "context"`, use `messages` plus boundary flags.

For `expand: "message"`, use `message`.

If a result cannot be expanded because its messages failed to load, omit that expanded entry; `resultIndex` preserves alignment, and the existing `loadErrorCount` / `loadErrors` fields still explain partial failures.

## Testing Coverage

Behavior-focused tests cover:

- `expand: "none"` preserves current output.
- `expand: "context"` returns bounded surrounding messages for top results.
- `expand: "message"` returns the full target message.
- `expandResults` caps expansion count.
- `window` controls context expansion and enforces the total expanded-message cap.
- grouped expansion targets the grouped representative.
- `since` / `until` parse valid relative durations and reject invalid strings.
- positive numeric `before` / `after` conflict with `until` / `since`.
- nonpositive numeric `before` / `after` remain ignored.
- `directory` filters sessions before loading messages.
- `toolName` filters tool parts and rejects incompatible `type` values.
- generated tool-definition size remains under the 2,000-2,200 token target using the existing measurement script pattern from prior tool-size checks.

## Documentation Notes

The README includes concise examples for:

- `expand: "context"` to avoid follow-up calls;
- `since: "7d"` for recent-history searches;
- `directory` and `toolName` for narrowed searches.

Keep future README updates concise. Avoid re-expanding the full tool instruction prose.

## Out Of Scope

- New tools.
- Memory writes from this plugin.
- Embeddings/vector search.
- Generated summaries.
- Regex mode.
- Query-variant merging.
- Markdown or other output-format options.

## Review Decisions Applied

- `expand` remains an enum, not a number.
- `topHits` is deferred.
- `sort` is deferred.
- `directory` uses exact-or-prefix matching, not substring matching.
- `toolName` implies tool-only eligibility and rejects incompatible part types.
- Expanded context includes `hasMoreBefore` / `hasMoreAfter`.
- `expand` output is capped by a total expanded-message budget.

## Implementation Order Used

1. Add types/output shape and schema parameters.
2. Add relative duration parser and validation.
3. Add directory and tool-name filtering.
4. Add expansion builders reusing existing `formatMsg` output.
5. Add tests and a tool-definition size measurement check.
6. Update README.
