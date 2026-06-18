# opencode-session-recall

[![npm version](https://img.shields.io/npm/v/opencode-session-recall)](https://www.npmjs.com/package/opencode-session-recall)
[![npm downloads](https://img.shields.io/npm/dm/opencode-session-recall)](https://www.npmjs.com/package/opencode-session-recall)
[![license](https://img.shields.io/npm/l/opencode-session-recall)](https://github.com/rmk40/opencode-session-recall/blob/main/LICENSE)

**Search and retrieve everything your agent has ever done, across every session and every project, straight from OpenCode's own database.**

[OpenCode](https://github.com/opencode-ai/opencode) already keeps the full history of every session you've run: messages, tool calls, tool outputs, and reasoning traces. That history covers every project on the machine, and it survives compaction. When compaction trims the context window, the original content stays in the database; the agent just stops being able to see it.

This plugin adds five tools that read that history on demand. There is no second database, no embeddings, no summarization step, and nothing to sync. You install it, and the agent can search its own past.

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

**System-prompt nudge (`nudge`, on by default).** The plugin adds a short line to the system prompt reminding the agent to search its history when you reference past work. This is just text, so it costs a handful of tokens per request and nothing else. The agent still decides whether and when to call `recall`.

**Automatic recall (`autoRecall`, off by default).** When one of your messages clearly points back at earlier work ("last time", "what did we decide", "same as before", "previously"), the plugin runs a recall for you and drops the top one to three hits, with citations, into the agent's context before it answers. The search is capped at 1.5 seconds and a bounded number of sessions, so it can't stall your turn, and if it finds nothing it stays quiet.

**Compaction preservation (`compactionRecall`, off by default).** Right before a session is compacted, the plugin pulls the strongest durable findings from that session and appends them to the compaction prompt, so the summary the model writes keeps them instead of dropping them.

```jsonc
{
  "plugin": [["opencode-session-recall", { "autoRecall": true, "compactionRecall": true }]],
}
```

`autoRecall` and `compactionRecall` are off by default on purpose. Both do real work at a sensitive moment, an inline search before a reply or an edit to the persistent summary, so a bad trigger costs latency, tokens, or a polluted summary. The nudge has none of those downsides, which is why it ships on. If you want maximum automation, turn the other two on and see how they behave on your own history.

## Options

| Option             | Type      | Default | Description                                                                                         |
| ------------------ | --------- | ------- | --------------------------------------------------------------------------------------------------- |
| `primary`          | `boolean` | `true`  | Register tools as primary (available to all agents)                                                 |
| `global`           | `boolean` | `true`  | Allow cross-project search via `scope: "global"`                                                    |
| `nudge`            | `boolean` | `true`  | Inject a short system-prompt reminder to use recall for past work                                   |
| `autoRecall`       | `boolean` | `false` | On user messages that reference prior work, auto-run a bounded recall and inject the top cited hits |
| `compactionRecall` | `boolean` | `false` | Before compaction, preserve durable findings into the summary                                       |

Advanced limits (all have sensible defaults):

| Option           | Default   | Description                                                                             |
| ---------------- | --------- | --------------------------------------------------------------------------------------- |
| `concurrency`    | `3`       | Parallel session loads                                                                  |
| `maxSessions`    | unlimited | Hard max sessions per search; caps `recall.sessions` and directory-filter broad listing |
| `maxResults`     | `50`      | Max results per search                                                                  |
| `maxSessionList` | `100`     | Max sessions in listing                                                                 |
| `maxMessages`    | `50`      | Max messages per browse                                                                 |
| `maxWindow`      | `10`      | Max context window size                                                                 |
| `defaultWidth`   | `200`     | Default snippet width                                                                   |

## Recall is not memory

This is not a memory system, and it doesn't try to be one. A memory system is selective and curated; recall just returns raw history verbatim, on demand.

The two work well together. If you run a persistent memory system alongside this plugin, recall is where its source material comes from: the agent searches its history, follows the promising hits with `recall_get` or `recall_context`, and then decides what is worth committing to memory.

Good things to keep are user preferences, project decisions, reusable root causes, environment facts, corrections, and approaches that clearly worked or clearly failed. Skip the ephemeral stuff: one-off commands, transient errors, and routine implementation detail.

---

The rest of this document is reference material. The agent gets the full parameter and response schema from each tool's own description at runtime, so you don't need to read it to use the plugin.

## Tools

Five tools, designed around how agents navigate conversation history.

### `recall` — Search

The primary tool. Full-text search across session titles, messages, tool outputs, tool-input commands and `cwd` values, reasoning, and subtask descriptions. Searches globally by default, or narrowed to the current project or session.

It supports four [match modes](#match-modes), session vs. part grouping, time and directory filters, and optional inline expansion of the top hits. Ranked results (`smart` and `fuzzy`) carry a relevance `score` and the matched terms; every result carries a short explanation of why it matched, and the response includes coverage metadata describing what was searched. The agent receives the complete parameter list and response shape in the tool description; the short version:

```
recall({ query: "authentication", scope: "project" })
recall({ query: "rate limit", match: "smart", group: "session" })
recall({ query: "prefiltr", match: "fuzzy", explain: true })
recall({ query: "unauthorized", expand: "context", window: 1 })
recall({ query: "migration", last: "7d", directory: "/workspace/project" })
recall({ query: "npm test", type: "tool", toolName: "bash" })
recall({ query: "ECONNREFUSED|ETIMEDOUT", match: "regex", scope: "global" })
```

Optional filters are forgiving: blank values are ignored, and malformed time filters are dropped or normalized with a warning rather than failing the search. Expansion is bounded; if it would exceed the message or character budget, `recall` returns the base hits plus as much expansion as fits and notes the cap in `warnings` instead of erroring out.

### `recall_get` — Retrieve

Get the full content of a specific message, including all parts. Tool outputs are returned in their original form, even if they were pruned from context. Use after `recall` finds something interesting.

```
recall_get({ sessionID: "ses_abc", messageID: "msg_def" })
```

### `recall_context` — Expand

Get a window of messages around a specific message. After `recall` finds a match, see what was asked before it and what happened after. Supports symmetric and asymmetric windows, and reports `hasMoreBefore`/`hasMoreAfter` at boundaries.

```
recall_context({ sessionID: "ses_abc", messageID: "msg_def", window: 3 })
recall_context({ sessionID: "ses_abc", messageID: "msg_def", before: 1, after: 5 })
```

### `recall_messages` — Browse

Paginated message browsing. Walk through a session chronologically, read the beginning, check the most recent messages, or filter by role. Also supports content filtering to combine search and pagination. Defaults to the current session.

```
recall_messages({ limit: 5, role: "user", reverse: true })
recall_messages({ sessionID: "ses_abc", offset: 10, limit: 10 })
recall_messages({ query: "npm", role: "user", reverse: true })
```

### `recall_sessions` — Discover

List sessions by title, for lightweight recent-session browsing or recency checks. For topical discovery, prefer `recall`; it searches titles and content together and labels title-only hits.

```
recall_sessions({ scope: "project", search: "auth" })
recall_sessions({ scope: "global", search: "deployment" })
```

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

- No direct database queries and no separate storage.
- No setup. There are no embeddings to generate, no index to build, and no data to keep in sync.
- Eligible sessions are scanned newest-first with bounded concurrency, and `maxSessions` is the hard safety cap.
- Long-running searches respect abort signals.
- Cross-project search is on by default; disable it with `global: false`.
- Ranked search works in every scope: session, project, and global.

### Smart/fuzzy pipeline

When `match` is `"smart"` or `"fuzzy"`, the search goes through a BM25 ranking pipeline:

1. **Candidate construction** — Messages are scanned newest-first. Session titles and each part's searchable text are extracted and tokenized. Per-session and global budgets cap the candidate pool.
2. **Normalization** — All candidates get their indexed fields normalized (camelCase splitting, separator normalization, whitespace collapse). There is no separate prefilter survival gate; the BM25 index selects matching documents itself.
3. **BM25 ranking** — A per-query in-memory [MiniSearch](https://github.com/lucaong/minisearch) BM25 index is built across primary text (boost 2), project directory (0.6), session title (0.3), and tool name (0.15). BM25 weights rare terms (IDF) and normalizes for document length. Prefix matching applies to terms over 3 chars and fuzzy tolerance to terms of 4 chars or more (tighter for smart, looser for fuzzy).
4. **Structural re-ranking** — BM25 scores (normalized 0–1) are adjusted with multiplicative boosts (exact phrase, full token coverage, reasoning traces, error text, user role, recency) and penalties (weak single-token fuzzy, poor coverage). A relative score floor drops weak noise without dropping the best hit.
5. **Snippet selection** — A token-density sliding window picks the most relevant excerpt from the raw text.

The pipeline runs within a 2-second post-fetch time budget. If a search exceeds it, the BM25-ranked results are still returned, marked with `degradeKind: "time"` (a latency flag; the ranking is unchanged). If smart or fuzzy finds nothing, literal search runs automatically as a fallback.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details, module guide, and development setup.

## License

MIT
