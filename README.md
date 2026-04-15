# opencode-session-recall

[![npm version](https://img.shields.io/npm/v/opencode-session-recall)](https://www.npmjs.com/package/opencode-session-recall)
[![npm downloads](https://img.shields.io/npm/dm/opencode-session-recall)](https://www.npmjs.com/package/opencode-session-recall)
[![license](https://img.shields.io/npm/l/opencode-session-recall)](https://github.com/rmk40/opencode-session-recall/blob/main/LICENSE)

**Every conversation your agent has ever had — across every session, every project — is already in the database. It's just not looking.**

[OpenCode](https://github.com/opencode-ai/opencode) stores the full conversation history from every session your agent has ever run — messages, tool calls, tool outputs, reasoning traces. All of it. Not just the current session. Not just the current project. Every project on the machine. Even after compaction shrinks what the model can see, the original content stays in the database — just no longer visible to the agent.

This plugin gives the agent five tools to search and retrieve all of it on demand.

**No new database.**
**No embeddings.**
**No summarization.**
**No duplication.**
**No overhead.**

Just install the plugin. The agent gains access to its entire history.

## The problem is absurd when you think about it

Your agent solves a tricky build error. Twenty minutes later, compaction runs. An hour later, the same error shows up. The agent starts from zero — debugging something it already figured out, while the answer sits in the database it's connected to.

You built rate-limiting middleware in your API project last week. Now you need it in another project. The agent has no idea it ever existed — while the original implementation, the requirements discussion, the edge cases you worked through, all of it is sitting in the same database, in a session from a different project.

You're 200 tool calls and 3 compactions deep. The agent has drifted from your original request. Your exact words are gone from context. But they're not gone — they're in the database. The agent just can't see them.

The data already exists. This plugin removes the blindfold.

## What it looks like

**"We already fixed this."**

```
recall({ query: "ECONNREFUSED retry", scope: "session" })
```

Agent finds its own solution from 2 hours ago. Doesn't re-derive it.

**"It was in that other project."**

```
recall_sessions({ scope: "global", search: "rate limit" })
recall_get({ sessionID: "...", messageID: "..." })
```

Finds the implementation from your API project. Reuses it instead of reinventing it.

**"What did I originally ask for?"**

```
recall_messages({ limit: 5, role: "user" })
```

Pulls up exact original requirements after 3 compactions. Checks its own work against what you actually said.

**"What was that error?"**

```
recall({ query: "TypeError", type: "tool", scope: "session" })
```

Gets the full stack trace from a tool output that got pruned. Doesn't re-run the failing command.

**"Why did we decide on that approach?"**

```
recall({ query: "chose postgres over", scope: "project", type: "reasoning" })
```

Recovers the reasoning behind an architectural decision from three sessions ago. Context that no summary captures.

**"Find it even with a typo."**

```
recall({ query: "prefiltr", match: "fuzzy", scope: "session" })
```

Fuzzy search finds `prefilter` even when the agent misremembers the exact spelling. Results ranked by relevance, not just recency.

## Smart and fuzzy search

Version 0.8.0 adds ranked fuzzy retrieval via [Fuse.js](https://www.fusejs.io/). Three matching strategies:

| Mode                | Behavior                            | Best for                                        |
| ------------------- | ----------------------------------- | ----------------------------------------------- |
| `literal` (default) | Case-insensitive substring match    | Exact terms, all scopes                         |
| `smart`             | Fuzzy ranked search (threshold 0.3) | Uncertain wording, typos, separator differences |
| `fuzzy`             | Looser fuzzy search (threshold 0.5) | Very approximate queries, exploratory search    |

```
recall({ query: "rate limit middleware", match: "smart", scope: "session" })
```

Smart and fuzzy modes:

- **Handle typos** — `prefiltr` finds `prefilter`, `ECONNREFUSD` finds `ECONNREFUSED`
- **Normalize separators** — `rate-limit` matches `rateLimit` matches `rate_limit`
- **Rank by relevance** — results scored 0–1 with structural boosts for exact phrases, full token coverage, reasoning traces, and recency
- **Fall back gracefully** — if smart/fuzzy finds nothing, literal search runs automatically
- **Time-budget degradation** — if ranking takes too long, returns prefilter-ranked results instead of timing out
- **Explain mode** — add `explain: true` to see scoring breakdowns via `matchReasons`

Currently available for `scope: "session"` only. Other scopes will be enabled as benchmarked.

## Recall is not memory

This is not a memory system. Memory is selective and curated. Recall is raw history retrieval — verbatim, exhaustive, on demand.

If you use a persistent memory system alongside this plugin, recall gives it source material. The agent searches history, finds something useful, and stores it deliberately. Discovery first, then permanent memory.

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

To disable cross-project search:

```jsonc
{
  "plugin": [["opencode-session-recall", { "global": false }]],
}
```

## Tools

Five tools, designed around how agents actually navigate conversation history:

### `recall` — Search

The primary tool. Full-text search across messages, tool outputs, tool inputs, reasoning, and subtask descriptions. Searches globally by default, or narrow to the current project or session.

```
recall({ query: "authentication", scope: "project" })
recall({ query: "error", type: "tool", scope: "session" })
recall({ query: "JWT", sessionID: "ses_from_another_project" })
recall({ query: "rate limit", match: "smart", scope: "session" })
recall({ query: "prefiltr", match: "fuzzy", scope: "session", explain: true })
```

| Param            | Default     | Description                                                      |
| ---------------- | ----------- | ---------------------------------------------------------------- |
| `query`          | required    | Text to search for                                               |
| `scope`          | `"global"`  | `"session"`, `"project"`, or `"global"`                          |
| `match`          | `"literal"` | `"literal"`, `"smart"`, or `"fuzzy"` (smart/fuzzy: session only) |
| `explain`        | `false`     | Include scoring metadata in results                              |
| `sessionID`      | —           | Target a specific session (overrides scope)                      |
| `type`           | `"all"`     | `"text"`, `"tool"`, `"reasoning"`, or `"all"`                    |
| `role`           | `"all"`     | `"user"`, `"assistant"`, or `"all"`                              |
| `before`/`after` | —           | Timestamp filters (ms epoch)                                     |
| `width`          | `200`       | Snippet size (50–1000 chars)                                     |
| `sessions`       | `10`        | Max sessions to scan                                             |
| `title`          | —           | Filter by session title substring (rarely needed)                |
| `results`        | `10`        | Max results to return                                            |

Smart/fuzzy results include additional fields:

| Field          | Description                                   |
| -------------- | --------------------------------------------- |
| `score`        | Relevance score (0–1, higher is better)       |
| `matchMode`    | Which strategy produced this result           |
| `matchedTerms` | Query tokens found in the candidate           |
| `matchReasons` | Scoring breakdown (only when `explain: true`) |

Response-level metadata for smart/fuzzy:

| Field         | Description                                         |
| ------------- | --------------------------------------------------- |
| `matchMode`   | `"smart"`, `"fuzzy"`, or `"literal"` (if fell back) |
| `degradeKind` | `"none"`, `"time"`, `"budget"`, or `"fallback"`     |

### `recall_get` — Retrieve

Get the full content of a specific message, including all parts. Tool outputs are returned in their original form, even if they were pruned from context. Use after `recall` finds something interesting.

```
recall_get({ sessionID: "ses_abc", messageID: "msg_def" })
```

### `recall_context` — Expand

Get a window of messages around a specific message. After `recall` finds a match, see what was asked before it and what happened after. Supports symmetric and asymmetric windows.

```
recall_context({ sessionID: "ses_abc", messageID: "msg_def", window: 3 })
recall_context({ sessionID: "ses_abc", messageID: "msg_def", before: 1, after: 5 })
```

Returns `hasMoreBefore`/`hasMoreAfter` so the agent knows if it's at a boundary.

### `recall_messages` — Browse

Paginated message browsing. Walk through a session chronologically, read the beginning, check the most recent messages, or filter by role. Also supports content filtering to combine search and pagination.

```
recall_messages({ limit: 5, role: "user", reverse: true })
recall_messages({ sessionID: "ses_abc", offset: 10, limit: 10 })
recall_messages({ query: "npm", role: "user", reverse: true })
```

Defaults to the current session. Pagination metadata includes `total`, `hasMore`, and `offset`.

### `recall_sessions` — Discover

List sessions by title. The starting point for cross-session and cross-project work.

```
recall_sessions({ scope: "project", search: "auth" })
recall_sessions({ scope: "global", search: "deployment" })
```

## Options

| Option    | Type      | Default | Description                                         |
| --------- | --------- | ------- | --------------------------------------------------- |
| `primary` | `boolean` | `true`  | Register tools as primary (available to all agents) |
| `global`  | `boolean` | `true`  | Allow cross-project search via `scope: "global"`    |

Advanced limits (all have sensible defaults):

| Option           | Default | Description             |
| ---------------- | ------- | ----------------------- |
| `concurrency`    | `3`     | Parallel session loads  |
| `maxSessions`    | `50`    | Max sessions per search |
| `maxResults`     | `50`    | Max results per search  |
| `maxSessionList` | `100`   | Max sessions in listing |
| `maxMessages`    | `50`    | Max messages per browse |
| `maxWindow`      | `10`    | Max context window size |
| `defaultWidth`   | `200`   | Default snippet width   |

## How it works

When OpenCode compacts a session, it doesn't delete anything. Tool outputs get a `compacted` timestamp and are replaced with placeholder text in the LLM's context — but the original data stays in the database. Messages before a compaction boundary are skipped when building the LLM context — but they're still there.

This plugin reads all of it through the OpenCode SDK:

- No direct database queries, no separate storage
- Zero setup — no embeddings to generate, no indexes to build, no data to sync
- Sessions scanned newest-first with bounded concurrency
- Respects abort signals for long-running searches
- Cross-project search enabled by default (disable with `global: false`)

### Smart/fuzzy pipeline

When `match` is `"smart"` or `"fuzzy"`, the search goes through a multi-stage ranking pipeline:

1. **Candidate construction** — Messages are scanned newest-first. Each part's searchable text is extracted and tokenized. Per-session and global budgets cap the candidate pool.
2. **Prefiltering** — Cheap lexical gate using exact substring, quoted phrase, token overlap, and bounded edit-distance (Levenshtein ≤ 1 for tokens ≥ 4 chars). Only candidates with at least one match survive.
3. **Normalization** — Surviving candidates get full stage-2 normalization (camelCase splitting, separator normalization, whitespace collapse) for Fuse.js field matching.
4. **Fuse.js ranking** — Weighted search across primary text (0.65), project directory (0.20), session title (0.10), and tool name (0.05). Returns all matches above the mode threshold.
5. **Structural re-ranking** — Fuse scores are adjusted with deterministic boosts (exact phrase, full token coverage, reasoning traces, error text, user role, recency) and penalties (weak single-token fuzzy, poor coverage).
6. **Snippet selection** — Token-density sliding window finds the most relevant excerpt from the raw text.

The entire pipeline runs within a 2-second post-fetch time budget. If the pre-Fuse stage alone exceeds 1.5 seconds, Fuse.js is skipped and prefilter-ranked results are returned with `degradeKind: "time"`. If the full pipeline completes but exceeds the total budget, Fuse-ranked results are still returned but marked as time-degraded.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details, module guide, and development setup.

## License

MIT
