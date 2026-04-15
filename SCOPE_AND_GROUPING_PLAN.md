# Global Smart/Fuzzy + Session Grouping

## Goal

Two changes to `recall`:

1. **Promote smart/fuzzy to all scopes** — remove the session-only restriction so `match:"smart"` and `match:"fuzzy"` work with `scope:"project"` and `scope:"global"`.
2. **Add `group:"session"` parameter** — collapse part-level results by session, returning one entry per session with the best-scoring hit as representative.

## Change 1: Promote Smart/Fuzzy to All Scopes

### What

Remove the `PROMOTED_SCOPES` guard. Smart/fuzzy works for all three scopes (`session`, `project`, `global`).

### Code changes

- `src/search.ts` — Delete `PROMOTED_SCOPES` set and the scope guard block.
- `src/search.ts` — Update tool description: remove "Currently available for scope:'session' only."
- `src/search.ts` — Update `match` arg description: remove "(session scope only)".

### Performance safety

The existing budget system already handles multi-session smart scans:

| Budget                    | Value     | Effect                                            |
| ------------------------- | --------- | ------------------------------------------------- |
| `maxCandidatesPerSession` | 500       | Caps per-session candidate count                  |
| `maxCandidatesTotal`      | 3000      | Hard global cap during candidate construction     |
| `maxCharsTotal`           | 2,000,000 | Total searchable text cap                         |
| `PREFUSE_BUDGET_MS`       | 1500      | Skip Fuse.js if prefilter takes too long          |
| `TIME_BUDGET_MS`          | 2000      | Mark results as time-degraded if pipeline exceeds |
| Literal fallback          | automatic | Falls back to literal if smart returns 0 results  |

With default 10 sessions: `buildCandidates` iterates newest-first per session, producing up to 500 candidates each. The global cap of 3000 is enforced during construction (not after prefilter) — once reached, later sessions get zero candidates. Prefilter then reduces survivors further before Fuse.js runs. Broad queries with high prefilter survival rates are the stress case; the time-budget degradation (`rankDegraded`) is the safety net.

Newest-first scan order means older sessions get less coverage under budget pressure. This is acceptable for the initial release.

## Change 2: Add `group:"session"` Parameter

### Schema

```
group: "part" | "session"  (default: "part")
```

- `"part"` — current behavior, unchanged. One result per matching part.
- `"session"` — collapse results by session. One result per session.

### Grouped response shape

When `group:"session"`, the `results` array stays `SearchResult[]` (type-compatible). Each entry represents a session, populated from the best-scoring hit in that session:

```typescript
{
  // All fields from the best-scoring hit in the session:
  sessionID, sessionTitle, directory,
  messageID, role, time, partID, partType, pruned, snippet, toolName,
  score,          // best score in this session (smart/fuzzy only)
  matchMode,
  matchedTerms,   // from the best-scoring hit only
  matchReasons,   // from best hit only (explain=true)
  // New:
  hitCount,       // total part-level hits in this session
}
```

Key decisions:

- **`matchedTerms` from best hit only**, not unioned. The `hitCount` field tells the caller there are more matches to explore. Unioning terms from all hits would imply the best hit matched all terms, which is misleading.
- **`group:"session"` with `scope:"session"`** is a degenerate case — returns at most one result. Valid but unhelpful; not a bug.

### New type additions

```typescript
// In types.ts:
export type GroupMode = "part" | "session";

// Add to SearchResult:
hitCount?: number;  // Present when group:"session"

// Add to SearchOutput:
group?: GroupMode;  // Echo back which grouping was applied
```

### Grouping logic

Grouping is a **post-processing step** after the existing pipeline. No changes to the candidate/prefilter/Fuse/rank pipeline itself.

**Critical:** grouping must happen on the **full ranked result set**, not after the final `limit` slice. Otherwise, top-ranked parts concentrated in one session would consume the limit and hide other sessions.

#### Smart/fuzzy + group:"session"

1. `smartScan` returns **all** ranked results (not sliced to limit) plus total count
2. `groupBySession()` post-processes:
   - Group results by `sessionID`
   - For each group: pick highest-`score` result as representative, set `hitCount` to group size
   - Sort groups by best score descending (time tiebreak)
3. Compute `total` = number of unique sessions with matches
4. Compute `truncated` = total > sliced group count
5. Slice to `results` limit

Implementation: `smartScan` already returns all Fuse matches (no limit passed to Fuse). The current `ranked.slice(0, limit)` inside `smartScan` will move to the caller, after grouping.

#### Literal + group:"session"

1. Literal scan runs over **all targeted sessions** without early exit (remove the `collected.length >= limit` break)
2. Group collected results by `sessionID`
3. For each group: pick most recent result (highest `time`) as representative, set `hitCount` to group size
4. Sort groups by most recent hit time descending
5. Compute `total` = number of unique sessions
6. Compute `truncated` = total > sliced group count
7. Slice to `results` limit

Note: removing the early-exit for literal grouped mode means scanning all sessions. This is the same cost as current literal `scope:"global"` with a high `results` limit. The existing per-session scan limit in `scan()` still bounds per-session work. For very large histories, this could be slower — but the budgets in `buildCandidates` don't apply to literal mode anyway, and literal scan is already fast (simple substring).

#### Literal fallback + group:"session"

When smart finds no results and falls back to literal, the fallback also applies grouping if `group:"session"` was requested. Same logic as literal + group:"session".

### `total` and `truncated` semantics

| group       | `total` means                        | `truncated` means                           |
| ----------- | ------------------------------------ | ------------------------------------------- |
| `"part"`    | Number of matching parts (unchanged) | More parts exist beyond returned results    |
| `"session"` | Number of sessions with matches      | More sessions exist beyond returned results |

### Ordering

| Mode        | group:"part"    | group:"session"       |
| ----------- | --------------- | --------------------- |
| literal     | Session recency | Most recent hit time  |
| smart/fuzzy | Relevance score | Best score in session |

### Metadata title

When `group:"session"`, the metadata title should say "sessions" not "results":

- `Found 5 sessions for "rate limit" (smart, 10 sessions searched)`

## Files to Change

| File              | Changes                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/types.ts`    | Add `GroupMode` type, add `hitCount?: number` to `SearchResult`, add `group?: GroupMode` to `SearchOutput`                     |
| `src/search.ts`   | Remove scope guard, add `group` param, refactor `smartScan` to return full results, add `groupBySession()`, update description |
| `README.md`       | Update scope docs, document `group` param, add grouped example                                                                 |
| `CONTRIBUTING.md` | Update promoted scopes note, document grouping logic                                                                           |

## What This Does NOT Do

- No semantic/concept matching — still lexical fuzzy
- No entity expansion — queries match on token overlap only
- No `recall_sessions` content search — stays title-only
- No new dependencies

## Compatibility

- `group` defaults to `"part"` — zero behavior change for existing callers
- `SearchResult[]` shape preserved — `hitCount` is optional
- `SearchOutput` shape preserved — `group` field is optional
- Smart/fuzzy at broader scopes: new capability, not a breaking change
- Literal path completely unchanged when `group:"part"`

## Release

Version 0.9.0. Local commits only — no push until explicitly approved.
