# opencode-session-recall

[![npm version](https://img.shields.io/npm/v/opencode-session-recall)](https://www.npmjs.com/package/opencode-session-recall)
[![npm downloads](https://img.shields.io/npm/dm/opencode-session-recall)](https://www.npmjs.com/package/opencode-session-recall)
[![license](https://img.shields.io/npm/l/opencode-session-recall)](https://github.com/rmk40/opencode-session-recall/blob/main/LICENSE)

**Search and retrieve everything your agent has ever done, across every session and every project, straight from OpenCode's own database.**

[OpenCode](https://github.com/opencode-ai/opencode) already keeps the full history of every session you've run: messages, tool calls, tool outputs, and reasoning traces. That history covers every project on the machine, and it survives compaction. When compaction trims the context window, the original content stays in the database; the agent just stops being able to see it.

This plugin adds five tools that read that history on demand. There is no second database, no summarization step, and nothing to sync; embeddings exist only as an opt-in local layer that is off by default. You install it, and the agent can search its own past.

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

**Automatic recall (`autoRecall`, off by default).** When one of your messages clearly points back at earlier work ("last time", "what did we decide", "same as before", "previously"), the plugin runs a recall for you and drops the top one to three hits, with citations, into the agent's context before it answers. The search is capped at 1.5 seconds so it can't stall your turn, and if it finds nothing it stays quiet. It searches the full scope through the shared corpus cache, so a cold first attempt may time out quietly and later attempts hit a warm cache; set `prewarm: true` to warm the cache at startup instead.

**Compaction preservation (`compactionRecall`, off by default).** Right before a session is compacted, the plugin pulls the strongest durable findings from that session and appends them to the compaction prompt, so the summary the model writes keeps them instead of dropping them.

```jsonc
{
  "plugin": [["opencode-session-recall", { "autoRecall": true, "compactionRecall": true }]],
}
```

`autoRecall` and `compactionRecall` are off by default on purpose. Both do real work at a sensitive moment, an inline search before a reply or an edit to the persistent summary, so a bad trigger costs latency, tokens, or a polluted summary. The nudge has none of those downsides, which is why it ships on. If you want maximum automation, turn the other two on and see how they behave on your own history.

## Options

| Option             | Type      | Default                    | Description                                                                                         |
| ------------------ | --------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| `primary`          | `boolean` | `true`                     | Register tools as primary (available to all agents)                                                 |
| `global`           | `boolean` | `true`                     | Allow cross-project search via `scope: "global"`                                                    |
| `nudge`            | `boolean` | `true`                     | Inject a short system-prompt reminder to use recall for past work                                   |
| `autoRecall`       | `boolean` | `false`                    | On user messages that reference prior work, auto-run a bounded recall and inject the top cited hits |
| `compactionRecall` | `boolean` | `false`                    | Before compaction, preserve durable findings into the summary                                       |
| `prewarm`          | `boolean` | `false`                    | Warm the [corpus cache](#the-corpus-cache) at plugin startup so the first search starts warm        |
| `semantic`         | `boolean` | `false`                    | Enable the opt-in local [semantic layer](#semantic-search-opt-in)                                   |
| `semanticWeight`   | `number`  | `0.35`                     | Blend weight for the semantic signal, clamped to 0.05–0.95                                          |
| `semanticModel`    | `string`  | `minishlab/potion-base-8M` | Hugging Face model id for the static-embedding model                                                |

Advanced limits (all have sensible defaults):

| Option           | Default      | Description                                                                             |
| ---------------- | ------------ | --------------------------------------------------------------------------------------- |
| `concurrency`    | `3`          | Parallel session loads                                                                  |
| `maxSessions`    | unlimited    | Hard max sessions per search; caps `recall.sessions` and directory-filter broad listing |
| `maxResults`     | `50`         | Max results per search                                                                  |
| `maxSessionList` | `100`        | Max sessions in listing                                                                 |
| `maxMessages`    | `50`         | Max messages per browse                                                                 |
| `maxWindow`      | `10`         | Max context window size                                                                 |
| `defaultWidth`   | `200`        | Default snippet width                                                                   |
| `cacheMaxChars`  | `50,000,000` | Raw-text budget for the in-memory corpus cache; LRU-evicted beyond it                   |

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

Project- and global-scope searches exclude the current session — and its whole delegation tree of subagent sessions, which restate the query and findings — by default, so "how did we do X before" queries return history instead of the conversation that just asked. Pass `excludeCurrentSession: false` to include them (session scope always searches the current session), or `excludeSessionID` to exclude one specific session.

It supports four [match modes](#match-modes), session vs. part grouping, time and directory filters, and optional inline expansion of the top hits. Ranked results (`smart` and `fuzzy`) carry a relevance `score` and the matched terms; every result carries a short explanation of why it matched (`why`), including an `evidenceClass` that says what kind of evidence the hit is: something a person said (`human-text`), a command that ran (`tool-input`), its output (`tool-output`), reasoning, a session title, or generated reference material (`file-read`, `web-fetch` for fetched web content, `skill-definition`). Session-grouped results additionally carry `evidenceKinds` (the classes seen in that session) and up to two `topEvidence` snippets of other classes, so a session's hit is legible without a follow-up part-level search. The response includes coverage metadata describing what was searched, suggestions that react to the result composition (all hits from the current session, all generated reference material, shortlisted-but-unranked sessions), and, with `explain: true`, a `queryPlan` naming which search strategies ran. The agent receives the complete parameter list and response shape in the tool description; the short version:

```
recall({ query: "authentication", scope: "project" })
recall({ query: "rate limit", match: "smart", group: "session" })
recall({ query: "prefiltr", match: "fuzzy", explain: true })
recall({ query: "unauthorized", expand: "context", window: 1 })
recall({ query: "migration", last: "7d", directory: "/workspace/project" })
recall({ query: "npm test", type: "tool", toolName: "bash" })
recall({ query: "ECONNREFUSED|ETIMEDOUT", match: "regex", scope: "global" })
```

Optional filters are forgiving: blank values are ignored, and malformed time filters are dropped or normalized with a warning rather than failing the search. Expansion is bounded; if it would exceed the message or character budget, `recall` returns the base hits plus as much expansion as fits and notes the cap in `warnings` instead of erroring out. Within the expansion budget each part is also capped individually (6,000 chars), so one giant tool dump can't starve its sibling messages, and when the matched part itself is truncated the region around the match is kept rather than blindly keeping the head.

Output-shape note for anyone parsing responses across versions: the top-level `scanned`, `loadErrorCount`, and `loadErrors` fields are gone (use `coverage.sessionsSearched` and `coverage.loadErrors`), `directoryRelevance` lives only under `why`, and `degradeKind: "budget"` no longer exists. See the [changelog](CHANGELOG.md) for the full list.

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
- No setup. There is no index to build and no data to keep in sync; searches run over an in-memory [corpus cache](#the-corpus-cache) that is derived from the database and safe to discard.
- Sessions are fetched with bounded concurrency and scanned newest-first, and `maxSessions` is the hard safety cap.
- Long-running searches respect abort signals.
- Cross-project search is on by default; disable it with `global: false`.
- Ranked search works in every scope: session, project, and global.

### The corpus cache

Search doesn't re-fetch and re-tokenize history on every query. Each session's searchable text is built once per session version into an in-memory cache, keyed by the session's update time; OpenCode's database stays the sole source of truth, and a session that changes is re-fetched on the next search that targets it. The cache is bounded by `cacheMaxChars` (default 50 million chars of raw text) with LRU eviction, and eviction only ever costs latency, never results: an evicted session that is targeted again is simply re-fetched. Because there is no longer a per-query candidate budget, search is complete over the eligible scope; a rare term in your oldest session is found no matter how large the history is.

### Smart/fuzzy pipeline

When `match` is `"smart"` or `"fuzzy"`, the search goes through a BM25 ranking pipeline:

1. **Candidate assembly** — Cached candidates for the eligible sessions are gathered from the [corpus cache](#the-corpus-cache), with the query's message/part filters applied. Extraction, tokenization, and normalization (camelCase splitting, separator normalization, whitespace collapse) already happened at cache-fill time.
2. **BM25 ranking, two passes** — A per-query in-memory [MiniSearch](https://github.com/lucaong/minisearch) BM25 index is built across primary text (boost 2), project directory (0.6), session digest (0.4), session title (0.3), and tool name (0.15). BM25 weights rare terms (IDF) and normalizes for document length. Prefix matching applies to terms over 3 chars and fuzzy tolerance to terms of 4 chars or more (tighter for smart, looser for fuzzy). Sessions whose title, directory, or digest overlaps the query are also shortlisted and re-ranked with a second, shortlist-only index, so the right neighborhood's content competes under its own term statistics; the two passes merge into one ranked list.
3. **Structural re-ranking** — BM25 scores (normalized 0–1) are adjusted with multiplicative boosts (exact phrase, exact code tokens like `deploy.yaml` or `GHOSTAUTH_LIVE_TUI`, full token coverage, tool inputs, reasoning traces, error text, user role, digest match, recency) and penalties (skill payloads, file reads, weak single-token fuzzy, poor coverage). A relative score floor drops weak noise without dropping the best hit.
4. **Snippet selection** — A token-density sliding window picks the most relevant excerpt from the raw text.

The pipeline runs within a 2-second post-fetch time budget. If a search exceeds it, the BM25-ranked results are still returned, marked with `degradeKind: "time"` (a latency flag; the ranking is unchanged). If smart or fuzzy finds nothing, literal search runs automatically as a fallback. With `explain: true`, `queryPlan.selected` records which of these strategies actually ran.

### Session digests

At cache-fill time each session gets a short content-derived digest: the head of its first user message plus its most characteristic action vocabulary. The digest is built only from statements and commands (what was said and what was run); file reads and skill payloads earn no credit, so a session that merely read about a topic doesn't look like it worked on it. Digest text is indexed alongside title and directory, which lets ranking find the right session even when its title is misleading.

### Semantic search (opt-in)

Lexical search is the default and the only thing that runs unless you set `semantic: true`. With it on, smart/fuzzy ranking blends in a cosine-similarity signal from local static embeddings, which helps when your query's vocabulary doesn't match the history's ("how did we test the plugin interactively" finding a session full of terminal commands).

The model (`minishlab/potion-base-8M` by default, roughly 30 MB) is downloaded once to `~/.cache/opencode-session-recall/models/` on first use; nothing else leaves the machine, and inference is a plain matrix lookup in-process, with no ONNX runtime and no native addon. Searches stay lexical-only until the model has loaded, with a warning in the output, and any failure (download, load, or inference) degrades to lexical-only rather than erroring. To disable it, omit the option; nothing is downloaded unless `semantic: true` is set.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details, module guide, and development setup.

## License

MIT
