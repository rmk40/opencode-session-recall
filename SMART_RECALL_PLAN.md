# Smart Recall Plan

## Purpose

Upgrade `recall` from exact substring search into a deterministic, ranked, `Fuse.js`-backed fuzzy retrieval engine without adding any new infrastructure.

This plan keeps the current product promise intact:

- No new database
- No embeddings
- No background jobs
- No persistent indexing pipeline
- No intermediary LLM in the plugin path

The plugin remains a thin, stateless layer over OpenCode's existing SDK-backed session history. Request-local in-memory structures are implementation details of a single tool invocation, not infrastructure.

## Why This Is The Right Next Step

The current architecture is solid. The weak point is matching quality.

Today, `recall` relies on case-insensitive substring matching. That breaks down on:

- Typos (`npm publsh` vs `npm publish`)
- Separator differences (`rate-limit` vs `rate limit` vs `rateLimit`)
- Path fragments (`src auth ts` vs `src/auth.ts`)
- Multi-term queries where ranking matters more than exact phrase order

The highest-leverage improvement is smarter matching and ranking, not new tools.

## User Outcomes

`recall` should handle queries like:

- `npm publsh` finding `npm publish`
- `rate limit` finding `rate-limit`, `rate_limit`, and `rateLimit`
- `src auth ts` finding `src/auth.ts`
- `kickout treshold` finding `kickout threshold`
- `postgres migration lock` finding relevant migration debugging output even if the exact phrase never appeared as a contiguous string

## Non-Goals

- Semantic search or embeddings
- Background processing or persistent indexing
- An LLM in the plugin path
- Claiming to "extract requirements" or "identify decisions" -- this is lexical retrieval, not understanding

## Dependency Decision

**Fuse.js** is the fuzzy ranking dependency.

Why:

- Strongest adoption and maintenance signal among evaluated libraries
- Works directly on in-memory arrays with no service or persistent index
- Supports weighted keys, fitting conversation-history objects
- Gives fuzzy lexical ranking without forcing a larger search architecture

How it fits:

- Fuse.js ranks request-local candidate objects, not whole transcripts
- It is one layer inside the recall pipeline, not the whole engine
- Normalization, snippet extraction, structural boosts, and deduping remain first-party logic

Product guardrails:

- Normalize text before handing it to Fuse.js
- Search part-level candidates, not whole-session blobs
- Keep `literal` mode permanently available
- Apply our own deterministic boosts after Fuse.js scoring
- Keep snippet extraction and deduping outside of Fuse.js

## Tool Surface Changes

Add two arguments to `recall`:

| Argument  | Type                              | Default     | Purpose                                          |
| --------- | --------------------------------- | ----------- | ------------------------------------------------ |
| `match`   | `"literal" \| "smart" \| "fuzzy"` | `"literal"` | Controls matching strategy                       |
| `explain` | `boolean`                         | `false`     | Returns scoring metadata for debugging and trust |

Future work (not designed here): `group`, `prefer`. Design those when the retrieval core is proven.

### Compatibility

- `literal` mode preserves current behavior exactly: case-insensitive substring matching, current part-level response shape, no Fuse.js scoring, no normalization-driven match widening
- `match: "smart"` is the primary Phase 1 deliverable, initially supported for `session` scope only. `match: "fuzzy"` is exposed in the API as a looser-threshold variant gated to the same promoted scopes, but it is secondary -- rollout validation focuses on `smart`, and `fuzzy` ships when `smart` passes its gates.
- For unpromoted scopes, `recall` rejects non-literal `match` values with an error response that includes a suggestion to use `scope: "session"` (since the default scope is `global`, users who pass `match: "smart"` without setting scope will otherwise get an unexplained rejection)
- `project` and `global` smart/fuzzy mode remain experimental until separately benchmarked

## Result Contract

Phase 1 keeps the current `results: SearchResult[]` shape and existing top-level `SearchOutput` fields (`scanned`, `total`, `truncated`), adding only optional per-result and response-level metadata.

### Per-Result Metadata

| Field          | Type                              | When Present        | Purpose                         |
| -------------- | --------------------------------- | ------------------- | ------------------------------- |
| `score`        | `number`                          | `smart` / `fuzzy`   | Final ranking score             |
| `matchMode`    | `"literal" \| "smart" \| "fuzzy"` | `smart` / `fuzzy`   | Which strategy produced the hit |
| `matchedTerms` | `string[]`                        | `smart` / `fuzzy`   | Query terms that matched        |
| `matchReasons` | `string[]`                        | `explain=true` only | Human-readable explanation      |

### Response-Level Metadata

| Field         | Type                                         | Purpose                                               |
| ------------- | -------------------------------------------- | ----------------------------------------------------- |
| `degradeKind` | `"none" \| "time" \| "budget" \| "fallback"` | What happened during ranking (see below)              |
| `matchMode`   | `"literal" \| "smart" \| "fuzzy"`            | Which strategy actually produced the returned results |

`degradeKind` values:

- `"none"` -- full ranking completed normally
- `"time"` -- post-fetch processing exceeded the time budget; Fuse.js was skipped and prefilter-scored candidates were returned
- `"budget"` -- candidate or scan budgets truncated the search space before ranking; results may be incomplete
- `"fallback"` -- smart/fuzzy returned zero results above threshold; literal results were substituted

`degradeKind` is the single field consumers check. There is no separate `degraded` boolean -- `degradeKind !== "none"` is the degradation signal. This avoids redundant fields that never disagree.

Add more observability fields when real usage shows they're needed.

### Abort Contract

On abort: `{ ok: false, error: "aborted" }`. No degraded fallback runs after an abort signal.

### Fallback When Smart/Fuzzy Returns Nothing

If `match: "smart"` or `match: "fuzzy"` produces zero results above threshold but `literal` mode would have found hits, fall back to literal results and set `matchMode: "literal"` and `degradeKind: "fallback"`. This prevents smart/fuzzy mode from being strictly worse than literal.

Fallback literal results use literal result semantics: no per-result `score`, `matchedTerms`, or `matchReasons` fields. The response-level `matchMode` tells the consumer what happened.

## Matching Model

### Query Normalization

- Lowercase
- Collapse repeated whitespace
- Treat `_`, `-`, `/`, `.` as token boundaries
- Split `camelCase` into tokens
- Preserve original text for display and literal fallback
- Skip fuzzy matching on tokens shorter than 3 characters

Examples: `rateLimit` → `rate`, `limit`. `src/auth.ts` → `src`, `auth`, `ts`.

### Candidate Construction

Two-stage normalization:

1. **Lightweight tokens** for prefiltering (cheap, applied to all parts during scan): lowercase the raw text, split on whitespace and separator characters (`_`, `-`, `/`, `.`), split camelCase boundaries. No further transforms. This produces a token set that the prefilter checks for overlap with query tokens.
2. **Full normalized weighted fields** only for candidates that survive into the Fuse.js input set: assemble the separate weighted text fields (`primaryText`, `secondaryText`, `titleText`, `hintText`) from normalized tokens and raw text, ready for Fuse.js weighted-key search.

Each candidate is a request-local object containing:

- Raw values for output and snippet rendering
- Normalized tokens (stage 1) and weighted fields (stage 2)
- Metadata: part type, tool name, session recency, project scope

Candidates are part-level, never whole-session transcript blobs.

#### Candidate Weighting (Provisional)

| Field           | Example contents                 | Relative weight |
| --------------- | -------------------------------- | --------------- |
| `primaryText`   | message text, tool output, error | 0.65            |
| `secondaryText` | tool input, alternate fields     | 0.20            |
| `titleText`     | tool title, session title        | 0.10            |
| `hintText`      | tool name, path hints            | 0.05            |

These weights are a starting point. Tune them during the spike against real session history.

### Query Parsing

Parse the query into:

- Plain terms
- Quoted phrases
- Path-like fragments (containing `/` or `.`)
- Command-like fragments

Later: exclusions with `-term`, if justified.

### Match Strategies

**`literal`**: Current behavior. Bypasses Fuse.js entirely.

**`smart`**: Fuse.js with conservative thresholds. Combines exact phrase, normalized token, separator-normalized, and bounded fuzzy matching. Returns ranked output with deterministic post-score boosts.

**`fuzzy`**: Same as smart but with looser Fuse.js thresholds. Still deterministic, still bounded.

### Fuse.js Configuration

Recommended defaults for `smart`:

- `includeScore: true`
- `ignoreLocation: true` (critical -- prevents location bias on long texts)
- `ignoreFieldNorm: true` (prevents length-based distortion)
- `shouldSort: true`
- `includeMatches: false` on the primary pass
- Conservative `threshold` (to be determined from spike data)
- Weighted keys mapped to normalized candidate fields

For `fuzzy`: same setup, looser `threshold`.

**Critical path:** Exact threshold values are the most important tuning decision in this plan. They must come from the spike, not intuition. If Fuse.js with the right thresholds doesn't produce meaningfully better results than substring matching on real data, the plan is moot.

When match ranges are needed (`explain=true`), run a second bounded Fuse.js pass with `includeMatches: true` over the final top-N only.

## Ranking Model

Every candidate gets a base score from Fuse.js. Deterministic boosts and penalties are applied afterward.

### Base Match Signals

| Signal                           | Strength  |
| -------------------------------- | --------- |
| Strong Fuse.js primary text hit  | Very high |
| Exact quoted phrase match        | Very high |
| Exact normalized substring match | High      |
| All query terms matched          | High      |
| Separator-normalized match       | Medium    |
| Weak fuzzy match only            | Very low  |

### Structural Boosts

| Signal                                       | Boost  |
| -------------------------------------------- | ------ |
| Match in tool error text                     | Medium |
| Match in user text                           | Medium |
| Match in reasoning                           | Medium |
| Multiple matching fields in the same message | Medium |
| More recent session                          | Small  |
| Current project over global peer match       | Small  |

### Penalties

| Signal                                 | Penalty |
| -------------------------------------- | ------- |
| Match only in a large low-density blob | Medium  |
| Only one weak fuzzy token matched      | High    |
| Poor overall query coverage            | Medium  |

### Ranking Policy

1. Score candidates.
2. Rank by score descending.
3. Break ties by session recency.
4. Break remaining ties by message recency.
5. Respect existing scan bounds.

## Search Execution Model

This is the main behavioral change inside `src/search.ts`.

Today, `scan(...)` stops early once enough matches are found.

Ranked retrieval instead:

1. Scan targeted sessions within the requested scope limit.
2. Build candidates incrementally during scan, not by materializing the full set first.
3. Apply cheap lexical prefilter during construction. A candidate survives if it matches any of: exact raw substring of the full query, quoted phrase presence, normalized token overlap (at least one query token found in candidate tokens), or bounded single-edit typo match on any query token of length 4+ characters. The typo gate uses a cheap edit-distance check (e.g., `fastest-levenshtein` or equivalent) limited to distance ≤ 1 per token, so typo-only queries like `npm publsh` can still reach Fuse.js.
4. Enforce budgets during construction so the candidate pool stays bounded at all times.
5. Normalize only surviving candidate fields and instantiate request-local Fuse.js over that bounded set.
6. Run Fuse.js with the selected match mode.
7. Apply deterministic post-score boosts, penalties, and deduping.
8. Return top results.

### Candidate Budgets

| Budget                           | Value   | Purpose                                                                                                             |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `maxMessagesProcessedPerSession` | 1000    | Cap scan depth per session (checked first)                                                                          |
| `maxPartsProcessedPerSession`    | 5000    | Cap part processing per session (checked second; if the message cap fires first, part cap is moot for that session) |
| `maxSearchableCharsPerCandidate` | 20000   | Truncate very long individual parts                                                                                 |
| `maxSearchableCharsTotal`        | 2000000 | Total text budget across all candidates                                                                             |
| `maxFuseCandidatesPerSession`    | 500     | Per-session Fuse.js input cap                                                                                       |
| `maxFuseCandidatesTotal`         | 3000    | Global Fuse.js input cap                                                                                            |
| `maxExplainCandidates`           | 100     | Second-pass explain budget                                                                                          |

Scan is newest-first within each session. If scan or candidate budgets are hit, keep the newest window and set `degradeKind: "budget"`. This is an acceptable tradeoff for session-scope rollout.

When more candidates survive the prefilter than `maxFuseCandidatesPerSession` allows, keep the candidates with the highest prefilter scores (see prefilter scoring below). This ensures budget truncation is score-aware, not purely scan-order.

### Degradation

Keep it simple: **time-budget only**, measured as wall-clock time from the start of candidate construction (after session data is already in memory).

The time budget covers construction + prefiltering + Fuse.js + post-ranking. It is a single 2000ms ceiling for the entire post-fetch ranking pipeline:

- If construction + prefiltering exceeds 1500ms (provisional -- calibrate from spike data), skip Fuse.js entirely and return the best prefilter-scored candidates with `degradeKind: "time"`.
- If Fuse.js completes but total post-fetch time exceeds 2000ms before the second explain pass, skip the explain pass and return first-pass results.
- On abort, stop immediately. No fallback.

Do not add heap monitoring. If time budgets are met, heap is fine. If they're not, the time trigger catches it.

#### Prefilter scoring for degraded mode

When Fuse.js is skipped, candidates are ranked by a simple prefilter score:

1. Exact raw substring match of the full query → highest score
2. Quoted phrase matches → high score per phrase matched
3. Number of query tokens found as exact substrings or single-edit typo matches in the candidate text → proportional score
4. Tie-break by session recency, then message recency

This is deliberately crude. It exists to make degraded mode return something useful, not to be a good ranker.

### Fetch-Cost Acknowledgment

The candidate budgets bound post-fetch processing but do not bound the SDK fetch itself. The current SDK loads full message arrays per session before scanning begins. For session-scope searches this is typically one fetch. For project/global scopes it can be many.

This is accepted for Phase 1 (session-only rollout). If fetch cost dominates when testing project/global promotion, those scopes stay unpromoted until staged retrieval exists or the problem is otherwise resolved.

## Snippet Selection

Current snippets center on the first literal substring hit. Smart/fuzzy mode needs better snippet selection.

Rules (apply only to smart/fuzzy paths):

- When `explain=false` (default): use the normalized token positions from stage-1 tokenization to find the densest window containing the most query tokens. This is cheap -- it reuses data already computed during prefiltering, no second Fuse.js pass needed. For typo-only fuzzy hits where no exact token position exists, fall back to centering the snippet on the first occurrence of the highest-scoring prefilter token match. This is an intentional limitation -- typo-only snippets will be less precise than exact-token snippets.
- When `explain=true`: run a second bounded Fuse.js pass with `includeMatches: true` over the final top-N and use the precise match ranges for snippet anchoring.
- In both cases: prefer windows containing more matched query terms, prefer exact matches over fuzzy, use the best scoring window rather than the first raw hit.

Literal mode keeps current snippet behavior unchanged.

## Module Layout

Keep existing entry points. Split new concerns into focused internal modules.

### Existing Files (Preserve)

- `src/opencode-session-recall.ts` -- plugin entry, tool registration
- `src/search.ts` -- recall search logic
- `src/messages.ts` -- chronological message browsing
- `src/sessions.ts` -- session discovery
- `src/extract.ts` -- part-to-searchable-text conversion
- `src/get.ts` -- single message retrieval
- `src/context.ts` -- surrounding-message context retrieval
- `src/types.ts` -- shared types and schemas

### New Internal Files

| File                | Responsibility                                                  |
| ------------------- | --------------------------------------------------------------- |
| `src/normalize.ts`  | Text normalization, tokenization, separator handling, camelCase |
| `src/query.ts`      | Parse query into terms, phrases, and matching-ready structure   |
| `src/candidates.ts` | Build request-local candidate objects from messages and parts   |
| `src/prefilter.ts`  | Cheap lexical prefiltering and budget enforcement               |
| `src/fuse.ts`       | Fuse.js configuration, candidate search, score extraction       |
| `src/rank.ts`       | Structural boosts, penalties, final score composition           |
| `src/snippet.ts`    | Best-window snippet extraction                                  |

## Implementation Plan

### Step 0: Spike (Do This First)

Before building anything:

1. Capture the literal baseline: run 30 real queries from your own session history through current substring matching. Record which results are relevant (label before running smart mode to avoid confirmation bias).
2. Extract candidate objects from a few real sessions.
3. Run the same 30 queries through Fuse.js with different thresholds, `ignoreLocation: true`, and `ignoreFieldNorm: true`.
4. Compare ranked results against the literal baseline labels.
5. Determine whether fuzzy results are meaningfully better.
6. Find the threshold range where results are good without excessive false positives.
7. Measure Fuse.js latency at candidate counts of 500, 1000, and 3000 to validate the performance budget.

If the spike doesn't show clear improvement, reconsider the approach before building the full system.

### Phase 1: Smart Recall

Build and ship `match: "smart"` (and `match: "fuzzy"`) as opt-in:

1. Add Fuse.js dependency.
2. Implement `src/normalize.ts`, `src/query.ts`, `src/candidates.ts`, `src/prefilter.ts`.
3. Implement `src/fuse.ts` as thin Fuse.js wrapper.
4. Implement `src/rank.ts` with structural boosts.
5. Implement `src/snippet.ts` for smart-mode snippet selection.
6. Refactor `scan(...)` in `src/search.ts` to collect scored candidates.
7. Add `match` and `explain` arguments to `recall`.
8. Add scope guard rejecting smart/fuzzy for unpromoted scopes.
9. Add time-budget degradation.
10. Ship as opt-in for `session` scope.

Deliverable: Opt-in smart recall with better ordering and typo tolerance. `fuzzy` is available but secondary -- rollout validation focuses on `smart`.

### Phase 2a: Scope Promotion and Default Switch (If Phase 1 Proves Useful)

1. Benchmark smart mode against `project` and `global` scopes.
2. Promote scopes that meet performance and relevance targets.
3. Consider making `smart` the default if results are consistently better.
4. Keep `literal` permanently available.

### Phase 2b: New Features (Future, Not Designed Here)

Design grouping (`group`) and type preferences (`prefer`) based on real usage patterns from Phase 1 and 2a. These are separate design efforts, not part of the smart recall rollout.

## Testing

### Before Implementation

Capture a baseline from real session history. The spike (Step 0) serves as the initial baseline.

### Unit Tests

- Normalization and tokenization
- CamelCase splitting and separator equivalence
- Query parsing
- Fuse.js threshold behavior
- Ranking composition
- Budget enforcement and degradation
- Snippet window selection

### Integration Tests

Build fixture sessions covering:

- Typo queries
- Path and command queries
- Formatting variant queries
- Matches late in long tool outputs
- Large noisy sessions
- Cross-project and cross-session results
- Budget truncation and degraded fallback

### Regression Tests

- Exact literal search still works
- Part/role/time filtering still works
- Scope behavior is unchanged
- Self-recursive results remain excluded

### Rollout Validation

Before promoting smart mode for any scope:

- Run at least 30 real queries from actual session history, with expected-relevant results labeled _before_ running smart mode (not judged post-hoc). At least 20 of the 30 must have at least one relevant result in the test corpus to ensure the ranking system is actually exercised.
- First relevant hit position must improve or stay unchanged on at least 80% of queries with relevant results
- First relevant hit may regress on no more than 5% of queries with relevant results
- On queries with no relevant hit, smart mode must return empty on at least 90%
- P95 end-to-end latency (including fetch) must stay within 2x P95 literal baseline for session/project, 2.5x for global. Rollout gates use end-to-end latency; internal degradation triggers use post-fetch time only.
- Time-budget degradation (`degradeKind: "time"`) must not trigger on more than 10% of queries
- Zero-result fallback (`degradeKind: "fallback"`) is counted separately and is acceptable up to 15% of queries (since it still returns literal results), but if fallback exceeds 10%, investigate whether Fuse.js thresholds are too aggressive before promoting
- Budget truncation (`degradeKind: "budget"`) is expected for large sessions and is not gated, but must be monitored

Before making smart the default:

- Complete at least one release with smart as opt-in
- Evaluate at least 50 real queries for the promoted scope
- Keep the literal regression suite green
- Keep `literal` available as a permanent escape hatch

## Risks

| Risk                                             | Mitigation                                             |
| ------------------------------------------------ | ------------------------------------------------------ |
| Fuse.js thresholds produce noisy false positives | Start conservative; tune from spike data               |
| Fuse.js location bias on long texts              | `ignoreLocation: true`                                 |
| Field-length distortion                          | `ignoreFieldNorm: true`                                |
| Ranking feels arbitrary                          | Ship `explain: true` for tuning and trust              |
| Performance regresses on large sessions          | Time-budget degradation; session-only initial rollout  |
| Smart returns worse results than literal         | Automatic fallback to literal when smart finds nothing |

## Bottom Line

1. Do the spike first.
2. Keep the architecture.
3. Wrap Fuse.js in a deterministic matching, ranking, and snippet system.
4. Ship `match: "smart"` as opt-in for session scope.
5. Expand based on evidence, not speculation.
