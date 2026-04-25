# Recall Search UX Improvement Plan

## Goal

Make `recall` forgiving, broad by default, and self-explanatory. The tool should behave like a search product: return the best safe results it can, explain any limits, and guide the caller toward a better query when results are weak or empty.

This plan focuses on tool/API behavior, ranking, and response metadata. It does not change the underlying storage model, add embeddings, add generated summaries, or introduce background indexing.

Status: P0/P1 implemented. P2 query-planning exploration remains deferred. This document now records the implemented public contract and remaining deferred ideas.

## Problem Summary

Recent dogfooding showed that `recall` can be technically correct but sharp-edged:

- Optional filters can fail the whole query instead of being ignored or normalized with warnings.
- `since` / `until` are easy to misread.
- `recall_sessions` can find useful session titles while `recall` returns no content, creating a confusing split between metadata and content search.
- Directory filters can hide useful global history with no clear fallback path.
- Expansion limits can turn a good search into a hard error.
- Coverage metadata does not clearly explain how much history was searched or why the search was limited.

The main design correction is to make `recall` the primary discovery tool across titles, messages, and tool output, while keeping narrow browse/retrieve tools available for follow-up inspection.

## Design Principles

- Search all eligible history by default, bounded only by explicit user filters, configured safety caps, provider/API limits, and abort/time-budget safeguards.
- Prefer warnings and partial results over hard failures.
- Preserve compatibility for existing parameters and call patterns.
- Keep hard errors only for invalid required fields, unsafe requests, or valid filters that produce an impossible query window.
- Normalize parameters into a single internal query shape before searching.
- Make every result explain why it matched and what kind of evidence it came from.
- Keep response metadata compact enough for agents to use directly.
- Keep the five-tool surface unless a later change proves a new tool is necessary.
- Avoid LLM synthesis, embeddings, vector search, generated summaries, and extra storage.

## Priority Scope

### P0: Implemented Base Release

These changes addressed the highest-impact feedback and shipped together:

- Change the default session scan from the current implicit `1000` request cap to all sessions returned by the selected scope, subject to configured `maxSessions`, provider/API limits, and abort/time-budget safeguards.
- Add warning and coverage metadata.
- Add forgiving time-filter normalization.
- Return base results instead of hard-failing when expansion exceeds caps.
- Search session titles and message content together in `recall`.
- Add `fallback: true` for directory-scoped searches.
- Add better zero-result guidance.

### P1: Implemented Follow-Up

These follow-up search UX additions are now part of the implemented contract:

- Auto-fitting context expansion with `window: "auto"`.
- Expansion budgets such as `expandBudgetMessages` and `expandBudgetChars`.
- Result confidence and compact `why` metadata for every result.
- First-class structured ranking for tool outputs.
- Near-miss reporting for empty searches.

### P2: Later Exploration

These add more ranking complexity and should be deferred until there is enough dogfooding evidence:

- Internal query plans that combine exact, smart, fuzzy, title, related-term, tool-field, and directory-relaxed searches.
- Related-term expansion.
- More advanced field weighting controls.

## Normalization Architecture

The current schema rejects many invalid values before `execute` can warn and continue. To make forgiving behavior real, implementation should split input handling into two layers:

1. A broad raw-input schema that accepts all values the tool can safely normalize, such as string-or-number date fields and oversized numeric expansion requests.
2. A deterministic normalizer that validates, clamps, downgrades, and emits warnings before search execution.

The raw schema should still reject invalid required fields and unsupported enum values. Forgiving behavior is for optional filters and budgets, not for arbitrary malformed calls.

The normalized internal shape should contain:

```ts
type NormalizedSearch = {
  after?: number;
  before?: number;
  directory?: string;
  fallback: boolean;
  expand: "none" | "context" | "message";
  expandResults: number;
  window: number | "auto";
  expandBudgetMessages?: number;
  expandBudgetChars?: number;
  warnings: string[];
};
```

## Time Filter API

Add clearer time parameters while keeping existing `since` / `until` compatibility:

| Parameter | Example                    | Meaning                                                                     |
| --------- | -------------------------- | --------------------------------------------------------------------------- |
| `last`    | `"365d"`                   | Lower bound at 365 days ago; no explicit upper bound unless supplied        |
| `from`    | `"365d ago"`               | Lower-bound alias for search-oriented wording                               |
| `to`      | `"now"`                    | Upper bound                                                                 |
| `after`   | `"2025-01-01"` or epoch ms | Existing lower-bound field, expanded to accept date strings                 |
| `before`  | `"2026-01-01"` or epoch ms | Existing upper-bound field, expanded to accept date strings                 |
| `since`   | `"7d"`                     | Compatibility alias for `last`                                              |
| `until`   | `"3w"`                     | Compatibility relative upper bound; prefer `to` or `before` in new examples |

Keep existing millisecond comparison semantics internally:

- `after` excludes messages at or before the normalized lower-bound timestamp.
- `before` excludes messages at or after the normalized upper-bound timestamp.
- User-facing docs may use “from” and “to,” but tests should assert the exact existing boundary comparisons.

### Time Normalization Rules

Normalize all time inputs into `{ after?: number, before?: number }`.

Valid lower-bound candidates:

- `after`
- `from`
- `last`
- `since`

Valid upper-bound candidates:

- `before`
- `to`
- `until`

Rules:

- `last: "7d"` and `since: "7d"` resolve to the same lower-bound timestamp and should produce identical result sets and coverage metadata when used alone.
- `from: "365d ago"` resolves to the same kind of lower bound as `after`.
- `to: "now"` resolves to execution time.
- `until: "3w"` resolves to an upper bound at three weeks ago.
- ISO-like date strings are accepted for `after` and `before`.
- Numeric `after` / `before` continue to mean epoch milliseconds.
- If multiple valid lower-bound candidates are present, choose the newest timestamp and warn that the less restrictive lower bounds were ignored.
- If multiple valid upper-bound candidates are present, choose the oldest timestamp and warn that the less restrictive upper bounds were ignored.
- If the chosen lower bound is greater than or equal to the chosen upper bound, return a hard error with the normalized bounds and examples.
- Invalid optional time filters are ignored with warnings unless they can be safely normalized.
- Degenerate `0d` values should not fail search. For upper-bound forms such as `until: "0d"`, normalize to `to: "now"` and warn. For lower-bound forms such as `last: "0d"` or `since: "0d"`, ignore the lower bound and warn because a zero-width recent-history window is rarely useful.

Example warning:

```text
Normalized until:"0d" to to:"now". Prefer to:"now", last:"7d", or before:"2026-01-01".
```

This conflict policy intentionally chooses the most restrictive valid bounds to avoid silently broadening a caller's query beyond what they requested.

## All-History Default

The earlier tool defaulted `sessions` to `Math.min(1000, maxSessions)`. That was safe, but it did not match the product expectation that omitting time filters searches all available history.

P0 changed this behavior:

- If `sessions` is omitted, do not apply an implicit `1000` request cap.
- Search all sessions returned by the selected scope unless a configured `maxSessions`, provider/API limit, abort signal, or time budget stops the search.
- If `sessions` is provided, keep treating it as a caller-requested scan cap.
- If `maxSessions` is configured, keep treating it as a hard plugin safety cap.
- If the search is stopped by a budget or cap, report that in `coverage.limitedBy` and `warnings`.

This is a behavioral change and should be called out in release notes. If implementation profiling shows unacceptable latency, fall back to a config-gated rollout such as `defaultSessions: "all" | number`, but the desired user-facing behavior is all-history search by default.

## Forgiving Parameters

Safe optional-parameter failures should become warnings. Hard errors should remain for invalid required fields and unsafe contradictions.

Convert these cases to warning-based normalization in P0:

- Invalid optional time strings: ignore or normalize according to the time rules.
- Multiple lower-bound time filters: choose the newest valid lower bound and warn.
- Multiple upper-bound time filters: choose the oldest valid upper bound and warn.
- `until: "0d"`: normalize to `to: "now"` and warn.
- `since: "0d"` or `last: "0d"`: ignore lower bound and warn.
- Oversized `window`: clamp to configured `maxWindow` and warn.
- Oversized `expandResults`: clamp to supported maximum and warn.
- Expansion request exceeding total context cap: return base results and partial expansion with warnings.

Keep these as hard errors:

- Invalid required `query`.
- Invalid enum values for fields such as `scope`, `match`, `type`, `role`, `group`, or `expand`.
- Valid time filters whose normalized lower bound is greater than or equal to the upper bound.
- `toolName` combined with `type: "text"` or `type: "reasoning"`, at least for P0. This avoids silently dropping a filter that fundamentally cannot apply to the requested part type.
- Requests that would violate configured hard limits and cannot be clamped safely.

## Partial Results On Expansion Limits

P0 changed the hard-failure behavior. P1 then added auto-fitting expansion controls.

P0 behavior:

- Run the base search first.
- Return normal `results` even if expansion cannot fully fit.
- Expand as many requested hits as fit under the existing context-message and text budgets.
- If expansion is reduced or omitted, add a warning.
- Keep explicit numeric `window` only.

The warning should be computed from the actual cap:

```text
Context expansion capped at 30 messages; expanded 1 of 3 requested results. Reduce window or expandResults to include more hits.
```

P1 behavior:

- Add `window: "auto"`.
- Add `expandBudgetMessages`.
- Add `expandBudgetChars`.
- Fit context automatically under those budgets.

## Unified Title And Content Search

`recall` should search session titles and message content together.

Result sources should be labeled:

```ts
type ResultSource = "message" | "title" | "tool" | "reasoning";
```

Behavior:

- Message/content hits remain primary.
- Title-only hits are included as lower-confidence results.
- Title matches can appear even when no message content matches.
- `recall_sessions` remains useful for lightweight metadata browsing, but it should no longer be the only way to discover title matches.
- `group: "session"` should merge title and content evidence for a session and expose both the representative content hit and any title match.

The minimum compatibility contract is:

- For the same scope/query, if `recall_sessions` would return a session because its title matches, `recall` should be able to return a title-sourced result for that session unless another explicit filter excludes it.
- The two tools do not need identical ordering or identical result sets.

Zero-result responses should explicitly call out title-only evidence when available:

```text
No content hits. Found 1 title hit; rerun with group:"session" or inspect the session.
```

## Search Coverage Metadata

Replace or supplement ambiguous `scanned` metadata with explicit coverage fields.

Proposed output:

```ts
type SearchCoverage = {
  totalSessionsAvailable?: number;
  totalSessionsKnown: boolean;
  sessionsDiscovered: number;
  sessionsEligible: number;
  sessionsSearched: number;
  messagesSearched: number;
  partsSearched: number;
  sessionsSkipped: number;
  skippedByReason?: Record<string, number>;
  directoryBucketsSearched?: Array<"exact" | "project" | "global">;
  directoryBucketCounts?: {
    exact?: number;
    project?: number;
    global?: number;
  };
  limitedBy?: Array<
    | "scope"
    | "sessionID"
    | "title"
    | "directory"
    | "time"
    | "type"
    | "role"
    | "sessionsLimit"
    | "maxSessions"
    | "providerLimit"
    | "loadError"
    | "rankingBudget"
    | "timeBudget"
    | "abortSignal"
  >;
};
```

Definitions and count relationships:

- `totalSessionsAvailable`: count reported by the provider before caller filters, only when available without an extra expensive query. Omit it when unknown rather than emitting a guessed value.
- `totalSessionsKnown`: true only when `totalSessionsAvailable` is populated and known complete.
- `sessionsDiscovered`: session metadata records fetched for this search before filters.
- `sessionsEligible`: discovered sessions remaining after metadata filters such as scope, title, directory, and fallback bucket selection.
- `sessionsSearched`: eligible sessions actually loaded or inspected for messages.
- `sessionsSkipped = sessionsDiscovered - sessionsSearched`; this includes both metadata-filtered sessions and sessions not loaded because of caps, load errors, aborts, or budgets.
- `skippedByReason` should use one primary reason per skipped session and should sum to `sessionsSkipped` when present.
- `directoryBucketsSearched`: fallback buckets actually searched for this request.
- `directoryBucketCounts`: number of final results returned from each fallback bucket.
- `messagesSearched`: messages considered after session load.
- `partsSearched`: searchable message parts considered after message/type/role filters.
- `limitedBy`: compact explanation of why the search may not represent all history. Use `rankingBudget` for ranking degradation and `timeBudget` when elapsed search time stops scanning.

The existing `scanned` field can remain temporarily for compatibility, but documentation should prefer `coverage`.

## Soft Directory Fallback

Directory scoping should support both strict and soft behavior.

Add:

```ts
fallback?: boolean;
```

When `directory` is provided and `fallback: true`, search buckets in this order:

1. Exact directory or descendant.
2. Same project/worktree when reliably known.
3. Global history when allowed.

Directory relevance labels:

```ts
type DirectoryRelevance = "exact" | "project" | "global" | "unknown";
```

Project/worktree derivation:

- Prefer explicit project identity from session metadata when available for both the current session/search context and candidate sessions.
- If project identity is unavailable, use normalized directory ancestry only when there is a clear workspace root from existing OpenCode metadata.
- Do not shell out to discover git roots in P0.
- If reliable project/worktree detection is unavailable, skip the project bucket and warn once in coverage metadata.

Fallback fill policy:

- `fallback: true` means fill up to the requested `results` count.
- Search exact matches first.
- If exact matches return fewer than `results`, search project/worktree matches.
- If the combined exact/project result count is still fewer than `results`, search global matches when global search is enabled.
- Keep exact results ranked above project results, and project results ranked above global fallback results.

If `fallback` is false and a directory filter produces no hits, return a suggestion to retry with `fallback: true`.

## Zero-Result Guidance

Empty or weak searches should return actionable suggestions.

Proposed output:

```ts
type SearchSuggestion = {
  reason: string;
  action: string;
  example?: Record<string, unknown>;
};
```

Examples:

- No content hits, but title hits exist.
- Directory filter excluded all candidate sessions.
- Time filters left only a small search window.
- Only a few sessions were searched due to `sessions`, `maxSessions`, provider limits, or abort/time budgets.
- Literal search found nothing and `match: "smart"` or `match: "fuzzy"` is likely better.
- `type: "text"` may be hiding tool output.

Suggestions should be generated from observed search conditions rather than generic help text.

## Better Expansion Controls

Add self-fitting expansion controls in P1:

```ts
window?: number | "auto";
expandBudgetMessages?: number;
expandBudgetChars?: number;
```

Behavior:

- `window: "auto"` expands as much context as fits within budget.
- `expandBudgetMessages` caps total expanded messages across all expanded results.
- `expandBudgetChars` caps total expanded text across all expanded results.
- Explicit numeric `window` remains available for deterministic callers.
- Budget exhaustion returns partial expansion plus warnings, not a hard failure.

## Result Confidence And Why Metadata

Add compact explanation metadata to results in P1.

Proposed fields:

```ts
type ResultWhy = {
  matchedFields: Array<
    "title" | "text" | "command" | "stdout" | "stderr" | "cwd" | "toolName" | "reasoning"
  >;
  matchedTerms?: string[];
  directoryRelevance?: DirectoryRelevance;
  recency?: "recent" | "older" | "unknown";
  confidence?: "high" | "medium" | "low";
};
```

Guidelines:

- Keep `source` as the canonical top-level field for result type.
- Keep `why` short.
- Do not duplicate long `matchReasons` unless `explain: true` is set.
- Use confidence as a UX label, not a precise probability.
- Title-only hits should usually be `low` or `medium` unless strongly supported by exact query matching.

## Near Misses

For no-result searches, return a compact `nearMisses` section when cheap to compute.

Examples:

- Nearby session titles in the requested directory.
- Top terms from candidate sessions after filters.
- Sessions in the same directory that mention operational terms adjacent to the query space.

Proposed output:

```ts
type NearMiss = {
  sessionID: string;
  title?: string;
  directory?: string;
  reason: string;
  terms?: string[];
};
```

This should stay conservative. Near misses are for diagnosis, not for inventing semantic matches.

Enable near misses only when `results` is empty and computing them does not require loading additional sessions beyond the current search budget.

## First-Class Tool Output Search

Tool output should be searchable and rankable as structured evidence, not just serialized text.

Fields to extract where available:

- Tool name.
- Command text.
- Working directory.
- stdout.
- stderr.
- Exit status or error status.
- Tool result text.

Ranking guidance:

- Exact command matches should rank high for command-like queries.
- stderr/error output should rank high for debugging queries.
- Working directory should contribute to directory relevance, but should not by itself outrank a direct title/message/command/stdout/stderr content match.
- Tool name should support filtering and weak ranking, not dominate results.
- `directoryRelevance` may break ties across otherwise similar hits, but should not reorder an exact content hit below a weak cwd-only hit.

This should improve default `type: "all"` behavior so callers do not need to know when to switch to `type: "tool"`.

## Internal Query Plans

Defer broad query planning until after P0/P1.

Possible later behavior for `match: "smart"`:

- Run exact phrase search.
- Run smart/fuzzy search.
- Run title search.
- Run structured tool-output search.
- If directory-scoped and weak, run directory-relaxed search.
- Merge and rank results with source/confidence metadata.

Guardrails:

- Keep latency bounded.
- Avoid surprising result volume.
- Preserve deterministic raw evidence.
- Report which plan steps ran when `explain: true`.

## Response Shape Additions

The next accepted release should add these top-level fields to `recall` output:

```ts
type SearchOutputAdditions = {
  warnings?: string[];
  suggestions?: SearchSuggestion[];
  coverage?: SearchCoverage;
  nearMisses?: NearMiss[];
};
```

Result additions:

```ts
type SearchResultAdditions = {
  source?: ResultSource;
  why?: ResultWhy;
  directoryRelevance?: DirectoryRelevance;
  titleMatch?: {
    title: string;
    matchedTerms?: string[];
  };
};
```

Response-size caps:

- Return at most 5 warnings.
- Return at most 3 suggestions.
- Return at most 3 near misses.
- Keep the highest-impact warnings first: hard caps reached, time-filter normalization conflicts, expansion truncation, fallback broadening, then lower-impact normalization notes.
- Keep `why` compact by default; verbose scoring remains gated behind `explain: true`.
- Keep existing snippet and expansion truncation behavior.

Compatibility guidance:

- Add fields without removing current fields.
- Keep `results` as the main evidence list.
- Keep `expanded` optional and bounded.
- Keep `loadErrorCount` / `loadErrors`, but incorporate them into `coverage` and `warnings`.
- Treat broadening `before` / `after` from number-only to number-or-string as a schema compatibility risk that needs explicit tests, generated tool-schema verification, and release notes.

## Implementation Phases

The implemented change set followed these phases; Phase 8 remains deferred.

### Phase 1: Warning And Coverage Foundation

- Add the broad raw-input schema and deterministic normalizer.
- Add `warnings` and `suggestions` output support with caps.
- Add `coverage` output support with count relationships.
- Remove the implicit `1000` default session cap when `sessions` is omitted, subject to performance validation.
- Convert the enumerated safe optional-parameter failures into warnings.
- Keep hard errors for invalid required fields, unsupported enums, incompatible `toolName` / `type`, and impossible valid windows.
- Document warning semantics before adding more forgiving behavior.

### Phase 2: Time API Ergonomics

- Add `last`, `from`, and `to`.
- Expand `before` / `after` to accept ISO-like date strings while preserving epoch milliseconds.
- Treat `since` as an exact compatibility alias for `last` for valid duration inputs.
- Preserve `until` as a relative upper-bound compatibility field.
- Improve docs and tool-description examples.
- Add tests for invalid filters returning warnings plus results.

### Phase 3: Unified Title/Content Search

- Include session title candidates in `recall`.
- Label title-only hits with `source: "title"` and lower confidence.
- Merge title and content evidence for grouped session results.
- Add zero-result suggestions that point to title hits.
- Keep `recall_sessions` as metadata browsing, not the only title-search path.

### Phase 4: Directory Fallback

- Add `fallback: true`.
- Build exact/project/global buckets using the derivation rules above.
- Label each result with `directoryRelevance`.
- Use the fallback fill policy to satisfy up to `results` hits.
- Add coverage metadata that shows fallback buckets searched.

### Phase 5: P0 Expansion Warning Behavior

- Return base results even when expansion is too large.
- Clamp oversized numeric expansion parameters with warnings.
- Include as much requested expansion as fits under existing caps.
- Keep truncation deterministic and bounded.

### Phase 6: P1 Expansion Self-Fitting

- Add `window: "auto"`.
- Add `expandBudgetMessages` and `expandBudgetChars`.
- Fit context automatically under configured/requested budgets.
- Return partial expansion with warnings when a requested expansion exceeds those budgets.

### Phase 7: Result Why, Tool Output Ranking, And Near Misses

- Add compact `why` metadata.
- Extract structured tool fields for ranking and snippets.
- Improve default `type: "all"` ranking for commands and command output.
- Add `nearMisses` for empty searches when cheap.

### Phase 8: Query Plans

- Prototype internal multi-step search only after the earlier phases are stable.
- Start behind `match: "smart"` and `explain: true` diagnostics.
- Promote only if dogfooding shows better results without unacceptable noise or latency.

## Testing Plan

Add behavior-focused tests for:

- No time filters search all discovered history unless an explicit `sessions`, configured `maxSessions`, provider/API limit, abort signal, or ranking budget applies.
- Omitted `sessions` no longer applies an implicit `1000` request cap.
- Malformed optional time filters return warnings and still search.
- `last`, `from`, `to`, string `before`, and string `after` resolve expected windows.
- Existing numeric `before` / `after` behavior remains compatible.
- `since: "7d"` and `last: "7d"` produce identical result sets and identical coverage metadata when used alone.
- `until: "0d"` normalizes to `to: "now"` with a warning.
- `last: "0d"` and `since: "0d"` ignore the lower bound with warnings.
- Multiple lower-bound filters choose the newest lower bound and warn.
- Multiple upper-bound filters choose the oldest upper bound and warn.
- Impossible valid windows still produce a clear error with normalized bounds and examples.
- Oversized expansion returns base results plus warnings.
- P0 expansion includes as much context as fits under existing caps.
- P1 expansion budgets include as much context as fits.
- Title-only matches appear in `recall` with low confidence.
- For matching title queries, `recall` can return a title-sourced result for a session that `recall_sessions` would find, unless explicit filters exclude it.
- Grouped session results combine title and content evidence.
- Coverage metadata reports sessions/messages/parts searched and skipped reasons.
- `skippedByReason` sums to `sessionsSkipped` when present.
- `fallback: true` broadens directory search in exact/project/global order and fills up to `results`.
- Directory relevance labels are correct.
- Zero-result suggestions are specific to the observed filters and limits.
- Structured tool output fields match command text, stdout, stderr, cwd, and tool name.
- Capped warnings, suggestions, and near misses do not crowd out `results`.
- Near misses appear only when results are empty and cheap evidence exists.
- Near misses do not load additional sessions beyond the current search budget.

Manual dogfooding should replay the confusing cases that produced this feedback:

- Directory-scoped search with no local hits but global hits available.
- Title-only search that previously required `recall_sessions`.
- `until: "0d"` or similar degenerate relative filter.
- `expand: "context"` with an oversized window.
- Tool-output-heavy debugging search.
- Tool-input-heavy searches where the query appears in a command or working directory.
- A global search over more than 1000 sessions, if enough local history exists.

## Documentation Plan

Update README and tool descriptions with concise examples:

- All-history default search.
- `last: "30d"` for recent history.
- `from: "365d ago", to: "now"` for explicit windows.
- `before: "2026-01-01"` and `after: "2025-01-01"` for date bounds.
- `directory` with `fallback: true`.
- Title/content unified results.
- Reading `warnings`, `suggestions`, and `coverage`.
- Tool-output search without overusing `type: "tool"`.

Keep generated tool descriptions short. Move detailed semantics to README and this plan rather than expanding every tool parameter description.

## Compatibility And Rollout

- Preserve all existing public parameters.
- Preserve `since` and `until` but stop recommending them as the primary API.
- Preserve numeric `before` / `after` epoch semantics.
- Add string support to `before` / `after` carefully because generated schemas and clients may notice the broader union type.
- Add fields instead of replacing result shape fields.
- Treat warning-based downgrades as a minor-version behavior change because callers receive more successful responses, not fewer.
- Treat the all-history default as the main rollout risk because it can increase latency on machines with large histories.
- Add golden response fixtures for representative searches before and after the change.
- Golden fixtures should cover numeric `before` / `after`, `since` / `until`, omitted `sessions`, new string date support, title-only hits, directory fallback, and expansion truncation warnings.
- Include release notes that call out new warnings, coverage fields, title hits, directory fallback, and all-history default behavior.
- If performance measurements are poor, add a config flag before enabling all-history default broadly.

## Risks

- Forgiving invalid filters could hide caller mistakes if warnings are ignored.
- Changing the default session cap could increase latency for users with very large histories.
- Title-only hits could add noise if ranked too high.
- Directory fallback could surprise callers who expected strict locality, even though it is opt-in.
- More metadata could increase response size and tool-description complexity.
- Broader raw-input schemas could make generated tool definitions less precise.
- Internal query planning could add latency and ranking opacity if introduced too early.

Mitigations:

- Keep strict directory behavior unless `fallback: true` is set.
- Keep warnings prominent and concise.
- Rank title-only and fallback hits below direct content hits.
- Cap warning/suggestion/near-miss counts.
- Add compact metadata by default and reserve verbose scoring for `explain: true`.
- Defer query plans until simpler changes are proven.
- Performance-test all-history default before release.

## Out Of Scope

- LLM answer synthesis.
- Embeddings or vector database search.
- Background indexing or duplicated storage.
- Automatic memory writes.
- New task-specific tools such as `recall_decisions`.
- Removing `recall_sessions`.

## Open Questions

- Should invalid `toolName` with non-tool `type` remain a hard error permanently, or should a later release downgrade it after observing usage?
- Should all-history default be enabled immediately if profiling is acceptable, or shipped behind `defaultSessions: "all" | number` for one release?

## Success Criteria

- Common searches do not require `since` / `until`.
- Omitting `sessions` searches beyond the current implicit 1000-session cap unless a real configured/provider/budget limit applies.
- Malformed optional filters rarely cause hard tool failure.
- Oversized expansion returns non-empty base `results` plus a warning when matches exist.
- `recall` can find sessions by title and content in one call.
- Directory-scoped searches can broaden safely when `fallback: true` is set.
- Empty results include concrete next actions.
- Coverage metadata makes it clear what was searched and what was skipped.
- Tool-output-heavy debugging history is easier to rediscover from default search.
