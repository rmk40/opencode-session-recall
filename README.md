# opencode-session-recall

[![npm version](https://img.shields.io/npm/v/opencode-session-recall)](https://www.npmjs.com/package/opencode-session-recall)
[![npm downloads](https://img.shields.io/npm/dm/opencode-session-recall)](https://www.npmjs.com/package/opencode-session-recall)
[![license](https://img.shields.io/npm/l/opencode-session-recall)](https://github.com/rmk40/opencode-session-recall/blob/main/LICENSE)

**Search and retrieve everything your agent has ever done, across every session and every project, straight from OpenCode's own database.**

[OpenCode](https://github.com/opencode-ai/opencode) already keeps the full history of every session you've run: messages, tool calls, tool outputs, and reasoning traces. That history covers every project on the machine, and it survives compaction. When compaction trims the context window, the original content stays in the database; the agent just stops being able to see it.

This plugin adds five tools that read that history on demand. To answer in a couple of seconds without pulling gigabytes into memory, it keeps a small derived index alongside opencode's data: one card per session, plus a slim full-text index over the human layer (conversation text, reasoning traces, and the commands tools ran). That index lives in a local SQLite file under `~/.cache/opencode-session-recall/`, built once in the background through the opencode SDK and updated incrementally as sessions change. It is derived and safe to delete at any time; opencode's own database stays the sole source of truth, and the index adds zero npm dependencies because it uses the runtime's built-in SQLite. Embeddings are still an opt-in local layer that stays off by default. You install it, and the agent can search its own past.

## Why you want this

The agent forgets things it already knows, and that costs you time on every project.

Say it works through a nasty build error and gets it fixed. Compaction runs, the conversation gets trimmed, and an hour later the same error comes back. The agent has no record of the fix in its context, so it debugs the whole thing again from scratch, even though the answer is sitting in the database it's connected to.

Or you build rate-limiting middleware in one project this week and need the same thing in another project next week. To the agent the earlier work never happened. The implementation, the requirements you talked through, the edge cases you caught, are all still in the database in a session from the other project, and none of it gets reused.

Or you're a few hundred tool calls and several compactions into a long session, and the agent has quietly drifted from what you originally asked for. Your exact wording is gone from the context window, so there's nothing left to check the work against. It isn't actually gone, though. It's in the database, and this plugin lets the agent go read it.

## What it looks like

**Recover a fix from earlier in the session.**

```
recall({ query: "ECONNREFUSED retry", scope: "session" })
```

The agent pulls up the solution it landed on two hours ago instead of working it out a second time.

**Reuse work from another project.**

```
recall_sessions({ scope: "global", search: "rate limit" })
recall_get({ sessionID: "...", messageID: "..." })
```

It finds the rate-limiting implementation from the other project and reuses it.

**Check against the original request.**

```
recall_messages({ limit: 5, role: "user" })
```

After several compactions, the agent reads back your first few messages and compares its work to what you actually asked for.

**Get a tool output that was pruned.**

```
recall({ query: "TypeError", type: "tool", scope: "session" })
```

The full stack trace is still in the database, so the agent reads it instead of re-running the command that failed.

**Recover the reasoning behind a decision.**

```
recall({ query: "chose postgres over", scope: "project", type: "reasoning" })
```

It retrieves why an architectural call was made several sessions ago, the kind of context a summary usually drops.

**Search past a typo.**

```
recall({ query: "prefiltr", match: "fuzzy", scope: "session" })
```

Fuzzy matching finds `prefilter` even when the spelling is off, and ranks results by relevance rather than recency.

**See every session that touched a topic.**

```
recall({ query: "rate limiting", scope: "global", match: "smart", group: "session" })
```

One call returns the matching sessions across all your projects, each with a `hitCount` and a representative snippet.

## Install

```bash
opencode plugin opencode-session-recall
```

Or add it to your `opencode.json`:

```jsonc
{
  "plugin": ["opencode-session-recall"],
}
```

That's the whole setup. The agent picks up the tools on the next session and uses them on its own; you don't have to teach it the syntax. To disable cross-project search:

```jsonc
{
  "plugin": [["opencode-session-recall", { "global": false }]],
}
```

## Getting the agent to actually use it

A search tool only helps if the agent reaches for it. The plugin has three features aimed at that, at increasing levels of automation. The first is on by default; the other two you turn on yourself.

**System-prompt nudge (`nudge`, on by default).** The plugin adds a short line to the system prompt reminding the agent to search its history when you reference past work, and to list this session's children with `recall_sessions({ parentID: "current" })` when a subagent Task was cancelled or interrupted after starting without returning its `task_id`. This is just text, so it costs roughly 130 tokens per request and nothing else. The agent still decides whether and when to call `recall`.

**Automatic recall (`autoRecall`, off by default).** When one of your messages clearly points back at earlier work ("last time", "what did we decide", "same as before", "previously"), the plugin runs a recall for you and drops the top one to three hits, with citations, into the agent's context before it answers. This runs entirely against the session cards, so it fetches no messages and adds no measurable latency to your turn, and if nothing matches it stays quiet.

**Compaction preservation (`compactionRecall`, off by default).** Right before a session is compacted, the plugin reads that session's own distilled card, its focus, its outcome, the errors it hit, and its key identifiers and files, and appends that to the compaction prompt, so the summary the model writes keeps them instead of dropping them. This is also a card read, with no message fetch.

```jsonc
{
  "plugin": [["opencode-session-recall", { "autoRecall": true, "compactionRecall": true }]],
}
```

`autoRecall` and `compactionRecall` are off by default on purpose. Both act at a sensitive moment, a card lookup before a reply or an edit to the persistent summary, so a bad trigger costs tokens or a polluted summary even though the lookup itself is cheap. The nudge has none of those downsides, which is why it ships on. If you want maximum automation, turn the other two on and see how they behave on your own history.

## Options

| Option             | Type      | Default                    | Description                                                                                                                                   |
| ------------------ | --------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `primary`          | `boolean` | `true`                     | Register tools as primary (available to all agents)                                                                                           |
| `global`           | `boolean` | `true`                     | Allow cross-project search via `scope: "global"`                                                                                              |
| `nudge`            | `boolean` | `true`                     | Inject a short system-prompt reminder to use recall for past work                                                                             |
| `autoRecall`       | `boolean` | `false`                    | On user messages that reference prior work, auto-run a bounded recall and inject the top cited hits                                           |
| `compactionRecall` | `boolean` | `false`                    | Before compaction, preserve the session's distilled card into the summary                                                                     |
| `prewarm`          | `boolean` | `false`                    | Deprecated no-op, kept so existing configs don't error; the card store persists across processes                                              |
| `semantic`         | `boolean` | `false`                    | Enable the opt-in local [semantic layer](#semantic-search-opt-in)                                                                             |
| `semanticWeight`   | `number`  | `0.35`                     | Blend weight for the semantic signal, clamped to 0.05–0.95                                                                                    |
| `semanticModel`    | `string`  | `minishlab/potion-base-8M` | Hugging Face model id for the static-embedding model                                                                                          |
| `summaries`        | `object`  | off                        | Opt-in LLM card summaries: `{ enabled, model: "providerID/modelID", agent?, maxPromptsPerPass? }`. See [LLM summaries](#llm-summaries-opt-in) |
| `mode`             | `string`  | `"persistent"`             | `"ephemeral"` runs with no store and no on-disk artifacts. See [Ephemeral mode](#ephemeral-mode-opt-in)                                       |

Advanced limits (all have sensible defaults):

| Option                 | Default                                        | Description                                                                    |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `storePath`            | `~/.cache/opencode-session-recall/store-v1.db` | Path to the derived SQLite store                                               |
| `coldPass`             | `true`                                         | Run the background distiller cold pass that builds the store                   |
| `concurrency`          | `3`                                            | Max concurrent SDK fetches shared by drill and distiller                       |
| `drillSessions`        | `12`                                           | How many shortlisted sessions a query drills into                              |
| `semanticSlots`        | `2`                                            | Drill slots reserved for the top pure-semantic cards (semantic on); 0 disables |
| `drillPageMessages`    | `25`                                           | Messages per page during an untargeted drill                                   |
| `drillCharsPerSession` | `1,500,000`                                    | Retained-chars budget per drilled session                                      |
| `drillCharsPerQuery`   | `20,000,000`                                   | Retained-chars budget across all sessions in one drill                         |
| `deepCharsPerQuery`    | `30,000,000`                                   | Retained-chars budget for one deep (output-inclusive) sweep                    |
| `cacheMaxChars`        | `24,000,000`                                   | Retained-chars budget for the drilled-session LRU; keeps repeat queries warm   |
| `distillConcurrency`   | `2`                                            | Sessions the cold pass distills in parallel                                    |
| `distillDelayMs`       | `25`                                           | Politeness delay between a session's page fetches during distillation          |
| `ftsRowsPerSession`    | `5000`                                         | Per-session slim-index row cap; giant sessions keep their newest rows          |
| `inventoryTokens`      | `200`                                          | Card inventory token cap (code anchors plus digest tokens)                     |
| `maxSessions`          | unlimited                                      | Hard max sessions per search; caps `recall.sessionLimit`                       |
| `maxResults`           | `50`                                           | Max results per search                                                         |
| `maxSessionList`       | `100`                                          | Max sessions in a listing                                                      |
| `maxMessages`          | `50`                                           | Max messages per browse page                                                   |
| `maxWindow`            | `10`                                           | Max context window size                                                        |
| `defaultWidth`         | `200`                                          | Default snippet width                                                          |

## Recall is not memory

This is not a memory system, and it doesn't try to be one. A memory system is selective and curated; recall just returns raw history verbatim, on demand.

The two work well together. If you run a persistent memory system alongside this plugin, recall is where its source material comes from: the agent searches its history, follows the promising hits with `recall_get` or `recall_context`, and then decides what is worth committing to memory.

Good things to keep are user preferences, project decisions, reusable root causes, environment facts, corrections, and approaches that clearly worked or clearly failed. Skip the ephemeral stuff: one-off commands, transient errors, and routine implementation detail.

## What changed in 2.0

The sections above describe 2.0. This one explains what it replaced, and why the change earned a major version.

1.x searched by fetching. Every query pulled session history over the SDK into process memory and scanned it there, one query at a time. That search was complete: it read everything in scope, so it never missed. The price was that its cost scaled with the size of your history. On a small history you never felt it. On a real one it broke down. Measured on an actual store of about 4,700 sessions and 2.76GB of parts, a single "how did we do X before" query climbed into multiple gigabytes of memory and ran for minutes with the CPU pegged. Two of those became live incidents.

2.0 inverts the model. A background distiller reads your history once, through the SDK, and builds a small derived index beside opencode's data: one card per session, a slim full-text index over the human layer (conversation, reasoning, and the commands tools ran), and, when you enable them, semantic vectors and short LLM-written summaries. A query no longer touches your history to decide where to look. It ranks the cards in milliseconds, checks the slim index for an exact identifier the cards might have dropped, and only then drills the top handful of sessions through bounded, paginated fetches. The same incident queries now return in seconds, a few per call, with the right session on top. The one-time cold pass that builds the index ran about 8 minutes on that store and left a 526MB file.

The retrieval contract changed with the architecture. 1.x promised exhaustive scanning; 2.0 promises bounded, precision-first retrieval with honest coverage reporting, so a response says how many sessions it actually drilled and what it skipped instead of implying it read everything. Tool outputs are searched inside the sessions a query drills into, not swept across all of history on every call, because that tier is roughly 88% of the corpus and mostly low-signal build logs. When you truly need an output that lives only in a session nothing else points at, `deep: true` runs that sweep within an explicit scope.

The store is derived and disposable. Delete the file and the distiller rebuilds it in the background; nothing you can lose lives only there. opencode's own database stays the sole source of truth, reached only through the SDK, never by a direct query. Several opencode processes can run against one store at once without corrupting it: a schema stamp fences out any build that would misread the format, persisted vectors carry a write generation so an older build cannot downgrade a newer one, and a single-writer lease keeps exactly one distiller writing at a time.

The rest of this document is reference material. The agent gets the full parameter and response schema from each tool's own description at runtime, so you don't need to read it to use the plugin.

## Tools

Five tools, designed around how agents navigate conversation history.

### `recall` (search)

The primary tool. Full-text search across session titles, messages, tool outputs, tool-input commands and `cwd` values, reasoning, and subtask descriptions. Searches globally by default, or narrowed to the current project or session.

Project- and global-scope searches exclude the current session by default, along with its whole delegation tree of subagent sessions (they restate the query and findings), so "how did we do X before" queries return history instead of the conversation that just asked. Pass `excludeCurrentSession: false` to include them (session scope always searches the current session), or `excludeSessionID` to exclude one specific session.

It supports four [match modes](#match-modes), session vs. part grouping, time filters (`since`/`until`/`last`/`from`/`to`/`before`/`after`), directory and project filters, and optional inline expansion of the top hits. Ranked results (`smart` and `fuzzy`) carry a relevance `score` and the matched terms; every result carries a short explanation of why it matched (`why`), including an `evidenceClass` that says what kind of evidence the hit is: something a person said (`human-text`), a command that ran (`tool-input`), its output (`tool-output`), reasoning, a session title, or generated reference material (`file-read`, `web-fetch` for fetched web content, `skill-definition`). Session-grouped results additionally carry `evidenceKinds` (the classes seen in that session) and up to two `topEvidence` snippets of other classes, so a session's hit is legible without a follow-up part-level search. The response includes coverage metadata describing what was searched, suggestions that react to the result composition (all hits from the current session, all generated reference material, shortlisted-but-unranked sessions), and, with `explain: true`, a `queryPlan` naming which search strategies ran. The agent receives the complete parameter list and response shape in the tool description; the short version:

```
recall({ query: "authentication", scope: "project" })
recall({ query: "rate limit", match: "smart", group: "session" })
recall({ query: "prefiltr", match: "fuzzy", explain: true })
recall({ query: "unauthorized", expand: "context", window: 1 })
recall({ query: "migration", since: "7d", directory: "/workspace/project" })
recall({ query: "npm test", type: "tool", toolName: "bash" })
recall({ query: "ECONNREFUSED|ETIMEDOUT", match: "regex", scope: "global" })
recall({ query: "OOMKilled", deep: true, sessions: ["ses_abc"] })
```

Regular search covers conversation text, reasoning, tool-input commands, and titles across all history, and it also searches tool _outputs_ within the handful of sessions each query drills into. It does not sweep every tool output across all history, because that tier is large and low-signal. When you need an output that lives only in some session nothing else points at, `deep: true` runs that sweep, but only within an explicit scope: pass a `sessions` list, or a lower time bound (`since`) together with `project: true` or a directory. A global unscoped deep is rejected with guidance. A deep sweep reads every part of each scoped session (outputs included) under char and wall-clock budgets; if a budget stops it partway, the response reports what it covered and returns a `nextCursor` you pass back as `deepCursor` to continue — and if the original request named not-yet-indexed sessions via `sessions`, repeat that `sessions` list alongside the cursor, since the untrusted cursor alone only readmits ids the card store knows. Without `deep`, a `sessions` list is still useful as an explicit shortlist: drill exactly those sessions and skip card ranking for selection; sessions named before the indexer has carded them are probed live and drilled directly, with a warning noting the direct path. `sessionLimit` caps how many sessions a normal query drills into.

Optional filters are forgiving: blank values are ignored, and malformed time filters are dropped or normalized with a warning rather than failing the search. Expansion is bounded; if it would exceed the message or character budget, `recall` returns the base hits plus as much expansion as fits and notes the cap in `warnings` instead of erroring out. Within the expansion budget each part is also capped individually (6,000 chars), so one giant tool dump can't starve its sibling messages, and when the matched part itself is truncated the region around the match is kept rather than blindly keeping the head.

Output-shape note for anyone parsing responses across versions: the top-level `scanned`, `loadErrorCount`, and `loadErrors` fields are gone (use `coverage.sessionsSearched` and `coverage.loadErrors`), `directoryRelevance` lives only under `why`, and `degradeKind: "budget"` no longer exists. Coverage now also carries a `cards` block (store totals and freshness) and, for a deep sweep, a `deep` block (sessions covered, partial, remaining) alongside the top-level `nextCursor`. See the [changelog](CHANGELOG.md) for the full list.

### `recall_get` (retrieve)

Get the full content of a specific message, including all parts. Tool outputs are returned in their original form, even if they were pruned from context. Use after `recall` finds something interesting.

```
recall_get({ sessionID: "ses_abc", messageID: "msg_def" })
```

### `recall_context` (expand)

Get a window of messages around a specific message. After `recall` finds a match, see what was asked before it and what happened after. Supports symmetric and asymmetric windows, and reports `hasMoreBefore`/`hasMoreAfter` at boundaries. The window is assembled from bounded newest-first pages, never a whole-session load, so it stays cheap even on a huge session.

```
recall_context({ sessionID: "ses_abc", messageID: "msg_def", window: 3 })
recall_context({ sessionID: "ses_abc", messageID: "msg_def", before: 1, after: 5 })
```

### `recall_messages` (browse)

One bounded page of a session's messages, newest first. Pass `cursor` from a prior page's `nextCursor` to walk further back; `limit` sets the page size. Optional `role` and `query` filter within the returned page. Defaults to the current session.

```
recall_messages({ limit: 5, role: "user" })
recall_messages({ sessionID: "ses_abc", limit: 10, cursor: "..." })
recall_messages({ query: "npm", role: "user" })
```

### `recall_sessions` (discover)

List sessions by title, for lightweight recent-session browsing or recency checks. When a distilled card exists for a session, its entry is enriched from the card: a content `digest`, the top `files` and `tools` it touched, and, for a root session, a `family` rollup with its child count. `since`/`until` filter by last-updated time. For topical discovery, prefer `recall`; it searches titles and content together and labels title-only hits.

```
recall_sessions({ scope: "project", search: "auth" })
recall_sessions({ scope: "global", search: "deployment", since: "7d" })
recall_sessions({ parentID: "current" })
```

`parentID` switches the tool to a live parent/child lookup: it lists the direct children (subagent sessions) of the given parent, with `"current"` as sugar for the calling session. The listing comes straight from the server, not the search index, so it finds cancelled or in-flight subagents the index has not caught up to — the recovery path when a Task tool returns "Task cancelled" without a `task_id`. From the listed IDs, `recall_messages` reads each child's tail state. Only direct children are returned (not grandchildren), and the response uses `scope: "children"` with a `parentID` echo and a `childCount`; `childCount > returned` means the `limit` truncated the listing. A malformed (non-string) `parentID` degrades to an ordinary listing, so check `scope === "children"` to discriminate. Rows whose content is not yet distilled into the search index carry `distilled: false`; rows backed by a fully distilled card omit the field.

When a `since` filter selects nothing and the lower bound is newer than the newest indexed session, the tool falls back to a live listing for that window (marked with a `note`), so index lag never silently hides brand-new sessions.

## Match modes

`recall` supports four ways to match a query. `literal` is the default; the ranked modes use [BM25](https://en.wikipedia.org/wiki/Okapi_BM25) via [MiniSearch](https://github.com/lucaong/minisearch).

| Mode                | Behavior                                   | Best for                                        |
| ------------------- | ------------------------------------------ | ----------------------------------------------- |
| `literal` (default) | Case-insensitive substring match           | Exact terms, all scopes                         |
| `smart`             | BM25 ranked search, tight fuzzy tolerance  | Uncertain wording, typos, separator differences |
| `fuzzy`             | BM25 ranked search, looser fuzzy tolerance | Very approximate queries, exploratory search    |
| `regex`             | Bounded regex scan over content            | Error codes, stack traces, paths, IDs, URLs     |

In `smart` and `fuzzy` mode, BM25 ranks rarer, more specific terms above common boilerplate and adjusts for document length, so a short message that is actually about your query beats a long log that happens to mention the words once. Each result gets a 0–1 score, with boosts for exact phrases, full token coverage, reasoning traces, error output, user messages, and recency.

These modes also tolerate typos (`prefiltr` finds `prefilter`, `ECONNREFUSD` finds `ECONNREFUSED`) and treat separators as interchangeable (`rate-limit`, `rateLimit`, and `rate_limit` all match each other). If a ranked search finds nothing, `recall` automatically retries as a literal search. Pass `explain: true` to see the per-result scoring breakdown in `matchReasons`.

`regex` mode scans content with a regular expression you supply. It is the right tool for exact shapes like error codes, stack traces, file paths, IDs, and URLs. An invalid pattern returns an error rather than silently matching nothing.

All four modes work in every scope: `"session"`, `"project"`, and `"global"`.

## How it works

Compaction in OpenCode doesn't delete anything. Tool outputs get a `compacted` timestamp and are swapped for placeholder text in the model's context, and messages before a compaction boundary are skipped when the context is rebuilt, but in both cases the original rows stay in the database.

This plugin reads them back through the OpenCode SDK:

- No direct database queries. All access goes through the SDK; opencode's database stays the sole source of truth.
- One derived index, built in the background and safe to delete. There is nothing for you to set up or sync. ([Ephemeral mode](#ephemeral-mode-opt-in) skips the index entirely.)
- Every message fetch is bounded and paginated. A search never pulls a whole session into memory, and a background distiller never competes with a live query. (Metadata listings, like the parent/child lookup, are single bounded-in-practice calls.)
- Long-running work respects abort signals.
- Cross-project search is on by default; disable it with `global: false`.
- All four match modes work in every scope: session, project, and global.

### The derived store

Everything in this section describes the default persistent mode; [ephemeral mode](#ephemeral-mode-opt-in) opts out of all of it. A background distiller reads history through the SDK once and writes a compact index to a local SQLite file (`~/.cache/opencode-session-recall/store-v1.db`). The first cold pass walks every session one at a time, distills each into a card plus a set of slim index rows, and checkpoints as it goes; after that, opencode's `session.idle` and related events drive incremental updates, so the store stays current without polling. It is derived and versioned: delete the file and it rebuilds itself in the background, and a store written by a newer build than yours makes the plugin fall back to a degraded metadata-only mode rather than misread it. Multiple opencode processes share the file safely through a single-writer lease. The store uses the runtime's built-in SQLite (`bun:sqlite`, with `node:sqlite` for tests), so it adds no npm dependency; if neither driver is available, the plugin degrades to in-memory metadata cards with no persistence.

### Two tiers: cards and the slim index

Every query answers from the store first, with no fetching:

- **Cards (tier 1).** One card per session holds its identity, a summary head, an inventory of the distinctive identifiers/paths/commands it used, the files and tools it touched, and error signatures. A query ranks these cards with BM25 (over card fields) plus exact code-token hits and a recency prior to pick a shortlist of sessions worth looking at. This is also what `recall_sessions`, `autoRecall`, and `compactionRecall` serve directly.
- **Slim full-text index (tier 1.5).** An FTS5 table over the _human layer only_: conversation text, reasoning, tool-input commands, and titles. Tool _outputs_ are excluded here by design, because they are the bulk of the corpus and the noisiest part of it. This tier catches a rare identifier or error string whose card happened to drop it, and merges those sessions into the shortlist.

### Bounded drill (tier 2)

For the shortlisted sessions (default 12, `drillSessions`), the plugin fetches bounded newest-first pages through the SDK, truncates each part to a per-part cap immediately, and runs the ranking stack over just those sessions under per-session and per-query char budgets. Drilled slices arrive with their tool outputs, so within the sessions a query drills into, outputs _are_ searched. Ranking within the drilled pool is the same BM25-plus-structural-boosts stack as before (exact phrase, exact code tokens like `deploy.yaml` or `GHOSTAUTH_LIVE_TUI`, full token coverage, tool inputs, reasoning, error text, user role, recency; penalties for skill payloads, file reads, weak single-token fuzzy, and poor coverage), with a relative score floor that drops noise without dropping the best hit. `literal` and `regex` scan the same drilled pool, so their matches also cover the drilled sessions' outputs; `coverage` reports how many sessions were drilled so a miss is legible. If smart or fuzzy finds nothing, `recall` retries as a literal scan over the same pool.

### Deep mode

The one thing tiers 1 through 2 cannot serve is a needle that exists only in a tool output of a session nothing else points at. `deep: true` is the explicit escape hatch: it sweeps every part of a scoped set of sessions, outputs included. It requires scope by construction (a `sessions` list, or `since` plus a project/directory filter) and runs under char and wall-clock budgets, returning a continuation `nextCursor` when a budget stops it partway. A global unscoped deep is rejected rather than attempted.

### Degraded modes

The plugin always answers something. With no SQLite driver, it serves metadata-only cards built from the session list. While the cold pass is still running, it serves whatever is distilled so far and reports the distilled fraction in `coverage.cards`. A schema newer than the running build, or a corrupt file, triggers a background rebuild while the degraded path serves in the meantime.

### Ephemeral mode (opt-in)

`mode: "ephemeral"` runs the plugin with no store at all: no SQLite file is opened, nothing is written under `~/.cache/opencode-session-recall`, and no background content indexing runs. Session ranking works from metadata cards built from the session list, and content search still happens, live, through the bounded drill and deep paths. `coverage.mode` reports `"ephemeral"` so a miss stays legible.

```jsonc
{
  "plugin": [["opencode-session-recall", { "mode": "ephemeral" }]],
}
```

What you give up, and what it costs:

- **No content index.** Ranking is metadata-quality (titles, directories, recency) rather than card-quality. Content matches come from live drill at query time instead of an index built once in the background, so the content cost is per query: bounded by the same drill session/page/char caps, but recurring. The per-query cost is higher than persistent mode's because there are no index anchors to aim at: drill pages newest-first through up to `drillSessions` sessions instead of jumping to known hits. The mode's only background network work is the one bounded startup `session.list` plus a metadata refresh at most once per 60 seconds (queries trigger it; `autoRecall` can too).
- **Features that need the store are off.** `semantic` is force-disabled (its model cache is itself a disk artifact), `summaries` never runs, `compactionRecall` is inert, and `recall_sessions` listings lose their card enrichment.
- **The default scope is `"project"`, not `"global"`.** Metadata-only ranking over a many-thousand-session global corpus is noise, so a defaulted query stays in the current project and reports `limitedBy: ["scope"]`. An explicit `scope: "global"` works as always.

Switching an existing install to ephemeral does not clean up after persistent mode: the old store file stays where it was, and any orphaned `[recall-summarizer]` worker sessions stay too, because ephemeral never holds the lease that sweeps them. Delete `~/.cache/opencode-session-recall/` yourself if you want it gone.

Two things ephemeral mode is not: `coldPass: false` only skips the background distiller and still creates the cache directory and store file, so it is not a no-artifact setting. And if what you want is full search quality without persistent disk artifacts, point `storePath` at a tmpfs or ramdisk instead; that keeps the whole index, on storage that vanishes on reboot.

### Semantic search (opt-in)

Lexical ranking is the default and the only thing that runs unless you set `semantic: true`. With it on, the tier-1 card ranking blends a cosine-similarity signal from local static embeddings into each card's lexical score. The embedded text is a natural-language projection of the card, not its raw fields: identifiers are split into words (`launchTerminal` becomes `launch terminal`, `GHOSTAUTH_LIVE_TUI` becomes `ghostauth live tui`), and file paths, tools, and heads are rendered as plain prose, so a paraphrase query lands closer to the session that did the work. Two of the drill slots are reserved for the top pure-semantic cards, and a session the semantic tier surfaced that then produces no lexical hit is rescued with its top-cosine part as the evidence, labeled semantic in `why`. With `explain: true` each result reports a `why.semanticSimilarity`, and `coverage.semantic` reports the model, the blend weight, how many cards carry a vector, and how many of the returned results the tier contributed, plus two diagnostics that make mixed-version confusion visible from a single response: the embedding `representation` generation and this build's `pluginVersion` tag (the same tag the distill lease records).

The default embedding model is small, so treat semantic as a real help on some vocabulary gaps rather than a guarantee on all of them. It lifts paraphrases whose concepts the model relates and misses ones it does not; enabling [LLM summaries](#llm-summaries-opt-in) improves it further by embedding a written description of each session instead of only its mechanical fields. When a query still misses, rephrasing toward the history's wording stays the reliable fallback.

The model (`minishlab/potion-base-8M` by default, roughly 30 MB) is downloaded once to `~/.cache/opencode-session-recall/models/` on first use; nothing else leaves the machine, and inference is a plain matrix lookup in-process, with no ONNX runtime and no native addon. Ranking stays lexical while the model loads, with a warning in the output, and the blend switches on automatically once loading finishes, with no need for new activity to trigger it. Any failure (download, load, or inference) degrades to lexical-only rather than erroring. To disable it, omit the option; nothing is downloaded unless `semantic: true` is set.

### LLM summaries (opt-in)

`summaries` runs your own model over your session history to write a short natural-language summary for each card, then folds those summaries into search. It is off by default and it spends your tokens, so turn it on deliberately:

```jsonc
{
  "opencode-session-recall": {
    "summaries": { "enabled": true, "model": "anthropic/claude-haiku-4-5" },
  },
}
```

The `model` is required as `"providerID/modelID"`; without a valid one the feature stays off, because it never guesses a model. Pick a cheap, fast one: each summary is two or three plain sentences about what a session did and how it ended, so a small model is enough.

A written summary improves three things when present. It joins both the lexical card index and the semantic embedding text, so a paraphrase query has more to match than raw identifiers (this compounds with the semantic layer). It becomes the `recall_sessions` digest. And the auto-recall and compaction hook payloads prefer it over the mechanical summary head.

The cost is bounded by construction. The SDK has no completion endpoint, so the summarizer drives a throwaway worker session per batch (titled `[recall-summarizer]`, tools disabled, excluded from every recall path) and batches about fifteen cards per prompt. All summary work runs through one serialized queue on the process holding the distill lease, after the distiller cold pass and on the same idle path a re-distill uses, so only one prompt is ever in flight. A content hash skips any card whose fields have not changed. A shared per-pass prompt budget (`summaries.maxPromptsPerPass`, default 200) bounds how many prompts run, a per-prompt timeout aborts a stuck generation (so it caps spend, not just waiting), and the run stops early if the model fails several times in a row. Worker create, delete, and list calls share the recall fetch gate; the long-running prompt itself does not, so it never holds a permit that would stall a foreground query. Changing the prompt template re-summarizes everything once. Summaries do not sync across machines; each machine builds its own from the local store.

On safety: the worker prompt carries only card fields (never message bodies), disables tools two ways best-effort (a disabled-tools map on the prompt and a deny-all permission ruleset on the throwaway session, probed once and dropped if the server rejects the shape), and only its text reply is read. Neither disable is a hard guarantee, because opencode derives tool access from the agent, not the prompt. For an enforced block, define a deny-all agent and point `summaries.agent` at it, so the model behind the summarizer literally cannot run a tool:

```json title="opencode.json"
{
  "agent": {
    "recall-summarizer": { "permission": { "*": "deny" } }
  }
}
```

Then set `summaries` to `{ "enabled": true, "model": "…", "agent": "recall-summarizer" }`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details, module guide, and development setup.

## License

MIT
