# Recall Field Report: Recovering Interrupted Subagent Sessions

Date: 2026-08-13

## Purpose

This report records a recall failure during a live orchestration task in the `atlas` repo, where the fallback was hand-written SQL against opencode's database. The data recall needed was present, indexed retrieval worked once IDs were known, and every discovery path returned zero results. The gap is narrow and fixable, so this writes down exactly what happened and what the plugin should do differently.

## The task

An orchestrator session had four `@code-writer` subagents running in parallel, each fixing review findings in a different batch of files. The user interrupted them mid-flight (they had stalled), which surfaced in the orchestrator as `Task cancelled` errors with no results and no `task_id` lines. The working tree showed ~2,000 lines of edits across 73 files, so the subagents had done most of their work before stopping.

To resume them with `task_id`, the orchestrator needed the four session IDs and each session's tail state: what was finished, what was mid-edit, what verification remained. This is exactly recall's territory. The user asked, reasonably: "You can't see what they've done so far via the sessions?"

## What recall did

Four attempts, all empty:

1. `recall_sessions({ scope: "project", since: "2h" })` returned zero sessions.
2. `recall_sessions({ scope: "global", since: "3h" })` returned zero sessions.
3. `recall({ query: "Fix review findings batch", match: "literal", last: "3h", group: "session", excludeCurrentSession: false })` returned zero results. Coverage told the real story: `sessionsEligible: 0`, `limitedBy: ["time"]`, and `cards.storeRecency` of 1786426593300.
4. `recall({ query: "Profit Center flat-rate apply path severed", match: "literal" })`, a verbatim string from a prompt sent to one of the subagents an hour earlier, returned zero. Without a time bound the search drilled 12 of 4,446 eligible sessions and skipped 4,434 on `sessionsLimit`. The near-misses were unrelated sessions from other projects.

The suggestions block advised trying `match: "smart"` and removing narrowing filters. Both were wrong for this failure; the sessions were not in the index at all.

The fallback that worked took two minutes:

```sql
SELECT id, title, datetime(time_created/1000,'unixepoch','localtime')
FROM session
WHERE time_created > (strftime('%s','now')-10800)*1000
  AND title LIKE '%code-writer%'
ORDER BY time_created DESC;
```

All four sessions came back immediately, titled `Fix batch C findings (@code-writer subagent)` and so on. From there, `recall_messages` on each ID worked perfectly: newest-first pagination gave each fixer's tail state, including one whose final edit was aborted mid-call. That evidence was enough to resume all four with `task_id` and precise "here is where you stopped" prompts, and all four completed.

## Why it failed

**The card index was 64 hours stale.** `storeRecency` decoded to roughly 2.6 days before the query time. The subagent sessions were created 20 minutes before the searches. Nothing created in that 64-hour window was discoverable.

**Every discovery path is gated on the card store, including the one that should not be.** `recall_sessions` is a metadata listing: titles, directories, timestamps. The source rows sat in the `session` table the whole time, indexed by `time_created`, and a bounded scan of them is cheap; that is what the manual SQL did. But `recall_sessions` answered from the derived index and returned zero for a window the primary database could answer trivially. Content search failing on unindexed sessions is at least coherent; the session lister failing is a design choice worth reversing.

**Drill selection cannot reach unindexed sessions either.** The untimed literal search picked its 12 drill targets by card ranking. A session with no card cannot rank, so the exact-substring match sitting in the primary database was structurally unreachable regardless of query quality.

**Coverage diagnosed the problem and the suggestions ignored it.** The response contained everything needed to say "your time window is newer than the index; recent sessions are invisible": `sessionsEligible: 0` alongside `limitedBy: ["time"]` and a `storeRecency` older than the window. Instead the suggestions recommended query broadening, which sends the caller in the wrong direction.

One more wrinkle: these sessions were cancelled rather than completed. If the incremental indexer waits for sessions to reach an idle or terminal state, interrupted subagents are precisely the sessions that never qualify, and they are also precisely the sessions an orchestrator most needs to recover. I could not confirm this from the outside, but the 64-hour lag suggests the indexer had not run at all, which is its own problem.

## Recommendations

**1. Answer recency-bounded discovery from the source database.** When a `since`/`last`/`from` window extends past `storeRecency`, union the card results with a direct query against opencode's `session` table for the uncovered span. For `recall_sessions` this should be unconditional: it is a metadata listing, the source table is small and time-indexed, and the tool should never return fewer sessions than the database holds for the requested window. Cards can still enrich the rows they know about (digests, rollups); rows without cards return bare metadata with a `distilled: false` marker.

**2. Expose the parent/child session relation.** The `session` table has `parent_id`, and subagent sessions carry it. The natural first query in this incident was "list the subagent sessions this session spawned," and no tool parameter can express it. A `parentID` filter on `recall_sessions` (with something like `parentID: "current"` as sugar) would have answered the whole discovery step in one call, index or no index, because it is a pure source-DB lookup. Interrupted-subagent recovery is a real orchestration workflow and deserves a first-class path.

**3. Make staleness a first-class signal with correct advice.** When `sessionsEligible` is 0 and the requested window is newer than `storeRecency`, the suggestion should say so: the index has not caught up, recent sessions may be missing, and (once recommendation 1 lands) the live fallback was engaged. Suggesting `match: "smart"` for an indexing gap trains callers to distrust the suggestions.

**4. Index in-flight and cancelled sessions.** Whatever the trigger for incremental indexing is, it should not require a session to end cleanly. A session that has been writing messages for 40 minutes is searchable history regardless of how it stops. If the indexer runs on a schedule and had simply not fired for 64 hours, that schedule needs a health check; consider triggering an incremental pass on plugin activation and surfacing last-index time in every coverage block, which recall already half-does via `storeRecency`.

**5. Let drill admit uncarded sessions for bounded queries.** When a time bound is present, the drill candidate set should include sessions in the window that lack cards, ranked last if need be. An exact-substring query for text known to exist should not be unreachable because ranking metadata has not been computed yet.

## Addendum (post-fix)

Two of the recommendations above shipped in the plugin
(see [docs/plans/subagent-recovery-parent-filter.md](plans/subagent-recovery-parent-filter.md)):

- **Recommendation 2 shipped in full.** `recall_sessions` now takes a
  `parentID` filter (`"current"` = the calling session) that lists a parent's
  direct children through the live `session.children` SDK endpoint — no card
  store involved, so cancelled and in-flight subagents are discoverable
  immediately. The incident's whole discovery step is now one call.
- **Recommendation 3 shipped in narrow form.** `recall_sessions` falls back to
  the live session list when a `since` window is newer than the newest in-scope
  card (zero-result case only), and `recall`'s suggestions lead with an
  index-lag diagnosis (pointing at the `parentID` recovery path) instead of
  query-broadening advice when the window is provably newer than
  `storeRecency`. The partial-staleness shape — some in-window cards masking
  newer missing sessions — remains unaddressed; recommendation 1 in full is
  the fix.

One asymmetry worth restating for the upstream report: opencode's Task tool
delivers a subagent's session ID only in the completion payload. A cancelled
task returns a bare `Task cancelled` error, so the orchestrator provably never
holds the ID it needs for `task_id` resumption — which is why discovery through
the parent/child relation, not ID bookkeeping, is the general answer.

## What worked

Worth stating, because the incident makes the retrieval tier look good. Once IDs were in hand, `recall_messages` did exactly what the recovery needed: paginated tails, tool inputs and outputs preserved, the aborted mid-call edit visible as an errored part followed by the file-state patch. The resume prompts were written almost entirely from its output. Discovery was the only broken layer, and it broke in a way the primary database could have covered the entire time.
