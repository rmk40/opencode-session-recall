# Recall Tool Surface Extension Plan

## Goal

Reduce turns after a useful `recall` hit while keeping the tool surface small and generated tool-definition payload under roughly 2,000-2,200 tokens.

The common flow is `recall` to find a hit, then `recall_context` or `recall_get` to inspect enough evidence. The highest-value change is letting `recall` optionally return that evidence in the same call.

Status: implemented, then extended by the search UX contract. The README is the canonical user-facing reference for current `recall` parameters, warnings, coverage, result evidence metadata, and optional `expanded` response data.

## Constraints

- Keep the existing five-tool surface.
- Avoid embeddings, generated summaries, or separate storage/indexing infrastructure.
- Keep expansion opt-in. Search now scans all eligible sessions by default unless caller or configuration caps it.
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
- `last`
- `from`
- `to`
- `directory`
- `fallback`
- `toolName`
- `expandBudgetMessages`
- `expandBudgetChars`

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

Type: integer number or `"auto"`

Default: `Math.min(3, limits.maxWindow)`, same as `recall_context`

Min: `0`

Semantics:

Controls messages before and after each expanded hit when `expand: "context"`. Numeric values use the same semantics and `limits.maxWindow` clamp as `recall_context.window`. `"auto"` fits as much context as possible under the expansion budgets. This setting does not affect normal snippets.

Output cap:

- Return partial expansion with `warnings` when requested context exceeds `expandBudgetMessages`, `expandBudgetChars`, or configured limits.
- Include `hasMoreBefore` / `hasMoreAfter` for each expanded context entry.

For `expand: "message"`, return the same formatted message shape as `recall_get` for up to `expandResults` hits, bounded by expansion budgets.

### `last` / `from` / `to` / `since` / `until`

Type: string

Accepted forms include durations such as `"2h"`, `"7d"`, and `"3w"`, date-like strings, and search-oriented strings such as `"30d ago"` or `"now"` where the parameter supports them.

Semantics:

- Relative durations are resolved against execution time (`Date.now()`).
- `last` is the preferred recent-history lower bound.
- `from` and `to` are explicit search-window bounds.
- `since` remains a compatibility alias for `last`.
- `until` remains a compatibility relative upper bound.
- Optional malformed filters warn and are ignored or normalized when safe.
- Nonpositive numeric `before` / `after` keep current `positiveTimestampOrUndefined` behavior and are ignored.
- Multiple valid bounds choose the most restrictive safe window and warn.
- Valid filters that normalize to an impossible window remain hard errors.

Bounds use existing recall semantics: `after` excludes messages at or before the timestamp; `before` excludes messages at or after the timestamp.

### `directory`

Type: string

Semantics:

Filter target sessions by normalized directory before loading messages. Match exact directory or descendant path only: `dir === target || dir.startsWith(target + pathSeparator)` after normalization. Avoid arbitrary substring matching to reduce cross-project false positives.

When `fallback: true`, fill remaining results from exact directory matches, then same-project/worktree matches, then global history when allowed. Results include `directoryRelevance` labels: `"exact"`, `"project"`, `"global"`, or `"unknown"`.

### `toolName`

Type: string

Semantics:

Filter searchable tool parts by exact tool name, such as `"bash"`.

- Valid only when `type` is `"all"` or `"tool"`.
- When provided with `type: "all"`, non-tool parts are excluded; only tool parts with the matching tool name are eligible.
- If `type` is `"text"` or `"reasoning"`, return a clear error.
- Tool-input `command` and `cwd` values are searched explicitly even without a `toolName` filter.

## Output Shape

### `expanded`

When `expand !== "none"`, `SearchOutput` gains `expanded?: ExpandedResult[]`. Entries are ordered by final result order and may be sparse when budgets or load failures prevent full expansion:

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

If a result cannot be expanded because its messages failed to load or expansion budgets are exhausted, omit or truncate that expanded entry; `resultIndex` preserves alignment. `warnings`, `coverage`, and `loadErrorCount` / `loadErrors` explain partial failures.

Current `recall` responses may also include `warnings`, `suggestions`, `coverage`, and `nearMisses`. Results may include `source`, `why`, `titleMatch`, and `directoryRelevance`.

## Testing Coverage

Behavior-focused tests cover:

- `expand: "none"` preserves current output.
- `expand: "context"` returns bounded surrounding messages for top results.
- `expand: "message"` returns the full target message.
- `expandResults` caps expansion count.
- `window` controls context expansion; `window: "auto"` fits context under expansion budgets.
- expansion budget exhaustion returns base results plus partial expansion and warnings.
- grouped expansion targets the grouped representative.
- `last`, `from`, `to`, `since`, and `until` normalize to expected bounds.
- malformed optional time filters warn and search when safe.
- string `before` / `after` values parse as date bounds.
- nonpositive numeric `before` / `after` remain ignored.
- `directory` filters sessions before loading messages.
- `fallback: true` fills from exact/project/global buckets and labels `directoryRelevance`.
- `toolName` filters tool parts and rejects incompatible `type` values.
- command and `cwd` tool inputs are searchable evidence.
- generated tool-definition size remains under the 2,000-2,200 token target using the existing measurement script pattern from prior tool-size checks.

## Documentation Notes

The README includes concise examples for:

- `expand: "context"` to avoid follow-up calls;
- `last: "7d"` and `from` / `to` for recent-history searches;
- `directory` with `fallback: true` and `toolName` for narrowed searches.

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
