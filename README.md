# opencode-session-recall

[![npm version](https://img.shields.io/npm/v/opencode-session-recall)](https://www.npmjs.com/package/opencode-session-recall)
[![npm downloads](https://img.shields.io/npm/dm/opencode-session-recall)](https://www.npmjs.com/package/opencode-session-recall)
[![license](https://img.shields.io/npm/l/opencode-session-recall)](https://github.com/rmk40/opencode-session-recall/blob/main/LICENSE)
[![discord](https://img.shields.io/badge/discord-discussion-5865F2?logo=discord&logoColor=white)](https://discord.com/channels/1391832426048651334/1493798786550464672)

**Search and retrieve everything your agent has done, across every session and every project, from OpenCode's own history.**

[OpenCode](https://opencode.ai) keeps the full history of every session on the machine, with its messages, tool calls, tool outputs and reasoning. Compaction hides older content from the model but leaves it in the database. This plugin gives the agent five tools that search and read that history on demand, so it can reuse a fix, a decision or a requirement instead of working it out again.

It runs on OpenCode v1 (1.3.4 and later) and OpenCode v2 (2.0 through 2.4) from one package. A small derived index beside OpenCode's data keeps searches fast and bounded. It holds one card per session and a slim full-text index over conversation text, reasoning and the commands tools ran. The index is a local SQLite file that builds itself in the background. You can delete it at any time, because OpenCode's own database stays the only source of truth.

## What's new

These are the largest recent changes. [CHANGELOG.md](CHANGELOG.md) has every detail.

- OpenCode v2 is supported from the same package, 2.4 included. Since 2.4, OpenCode stores what an assistant writes in separate part rows. Recall reads those rows, so assistant text, reasoning and tool calls written after the 2.4 upgrade show up in searches. Cards built before the plugin read part rows repair themselves in the background.
- Searches are faster. Each process updates its card index in place with only the cards that changed, where it used to rebuild the whole index at the first search after any write. Because loading and building the index run in short slices, a search no longer stalls other sessions in the same OpenCode process.
- Your own subagents are searchable by default. Project and global searches leave out only the current session, which lets an orchestrator find what its subagents found. Pass `excludeFamily: true` to leave out the whole delegation tree, meaning the current session's parent, siblings and subagents.
- `recall_messages` keeps reading until it finds matches. With `role` or `query` set, a call reads page after page until `limit` messages match or its scan budget runs out. Its cursor resumes exactly where the call stopped. On OpenCode v2, `order: "oldest"` reads a session forward from its first message.
- `toolName` understands renamed tools. `bash`/`shell`, `task`/`subagent` and `apply_patch`/`patch` match each other, in any case. When a `toolName` search finds nothing, the response lists the tool names it saw and suggests the closest one.
- A time-bounded search matches every session that overlaps the window and starts its reads inside the window instead of at the newest message.
- Results say what they left out. A result too large for OpenCode to pass to the model whole comes back trimmed, with a continuation that returns the rest. `coverage` reports what each search read and why it stopped reading each session. On v2 a warning appears when `opencode.db` holds content this version cannot read. Archived sessions are searched there too. A parent's subagent listing pages through up to 10,000 children before it marks the tree as truncated.

## Why you want this

The agent forgets what it already worked out. Say it fixes a nasty build error, compaction trims the conversation and an hour later the same error comes back. Nothing about the fix is left in its context. It debugs the whole thing again while the answer sits in the database it is connected to.

Or you built rate-limiting middleware in one project last week and need the same thing in another project now. The implementation, the requirements you talked through and the edge cases you caught are all in a session from the first project. With recall the agent can find that session and reuse the work.

## What it looks like

The agent writes calls like these on its own, without you learning the syntax.

Recover a fix from earlier in the session instead of working it out a second time.

```
recall({ query: "ECONNREFUSED retry", scope: "session" })
```

Find work from another project and read the message that holds it.

```
recall_sessions({ scope: "global", search: "rate limit" })
recall_get({ sessionID: "ses_abc", messageID: "msg_def" })
```

After several compactions, read your first messages back and check the work against what you asked for. Oldest-first browsing needs OpenCode v2. On v1 the agent pages back to them from the newest message.

```
recall_messages({ role: "user", order: "oldest", limit: 5 })
```

Read a stack trace that was pruned from context instead of re-running the command that produced it.

```
recall({ query: "TypeError", type: "tool", scope: "session" })
```

List the sessions in every project that touched a topic, each with a hit count and a representative snippet.

```
recall({ query: "rate limiting", scope: "global", match: "smart", group: "session" })
```

## Install

The same package works on both OpenCode generations.

### OpenCode v1

```bash
opencode plugin opencode-session-recall
```

Or add it to your `opencode.json`.

```jsonc
{
  "plugin": ["opencode-session-recall"],
}
```

Options go in a `[name, options]` pair. This one turns off cross-project search.

```jsonc
{
  "plugin": [["opencode-session-recall", { "global": false }]],
}
```

### OpenCode v2

```bash
opencode plugin add opencode-session-recall
```

Or list it under `plugins`, with options in an object.

```jsonc
{
  "plugins": [{ "package": "opencode-session-recall", "options": { "global": false } }],
}
```

v2 also reads the v1 `plugin` form above, so an existing config keeps working.

The agent picks up the tools in its next session and calls them on its own. Restart every OpenCode process after installing or upgrading, because a running process keeps the plugin version it loaded. On v2 that includes the background service (`opencode service restart`).

## Getting the agent to use it

A search tool only helps if the agent calls it. Three options make that more likely, at increasing levels of automation. Only the first is on by default.

- `nudge` (on by default) adds a short line to the system prompt telling the agent to search its history when you refer to earlier work. On v1 it also tells the agent to list the session's children with `recall_sessions({ parentID: "current" })` when a subagent Task was cancelled without returning its `task_id`. The agent still decides when to call `recall`.
- `autoRecall` (off by default, v1 only) watches your messages for references to earlier work, such as "last time" or "what did we decide". On a match it runs a recall against the session cards and puts up to three cited hits into the agent's context before it answers. When nothing matches it adds nothing.
- `compactionRecall` (off by default, v1 only) appends the session's card to the compaction prompt right before compaction, so the summary keeps the session's focus, outcome, errors and key files.

```jsonc
{
  "plugin": [["opencode-session-recall", { "autoRecall": true, "compactionRecall": true }]],
}
```

`autoRecall` and `compactionRecall` are off by default because each acts at a sensitive moment. A bad trigger spends tokens before a reply or puts noise into the persistent summary. Turn them on and see how they behave on your own history.

## Options

| Option             | Type      | Default                    | Description                                                                                                                                                |
| ------------------ | --------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `primary`          | `boolean` | `true`                     | Offer the tools to primary agents only, hiding them from subagents                                                                                         |
| `global`           | `boolean` | `true`                     | Allow cross-project search with `scope: "global"`                                                                                                          |
| `nudge`            | `boolean` | `true`                     | Add a short system-prompt reminder to search past work                                                                                                     |
| `autoRecall`       | `boolean` | `false`                    | Recall automatically when a message refers to earlier work (v1 only)                                                                                       |
| `compactionRecall` | `boolean` | `false`                    | Keep the session's card in its compaction summary (v1 only)                                                                                                |
| `prewarm`          | `boolean` | `false`                    | Does nothing. Older configs that set it still load                                                                                                         |
| `semantic`         | `boolean` | `false`                    | Turn on the local [semantic layer](#semantic-search-opt-in)                                                                                                |
| `semanticWeight`   | `number`  | `0.35`                     | Blend weight for the semantic signal, clamped to 0.05 through 0.95                                                                                         |
| `semanticModel`    | `string`  | `minishlab/potion-base-8M` | Hugging Face id of the static-embedding model                                                                                                              |
| `summaries`        | `object`  | off                        | Opt-in LLM card summaries, as `{ enabled, model: "providerID/modelID", agent?, maxPromptsPerPass? }` (v1 only). See [LLM summaries](#llm-summaries-opt-in) |
| `mode`             | `string`  | `"persistent"`             | `"ephemeral"` runs with no store and writes nothing to disk. See [Ephemeral mode](#ephemeral-mode-opt-in)                                                  |
| `opencodeDbPath`   | `string`  | OpenCode's own path        | The `opencode.db` to read (v2 only). See [OpenCode v2 notes](#opencode-v2-notes)                                                                           |

<details>
<summary>Advanced limits</summary>

| Option                 | Default                                        | Description                                                                                        |
| ---------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `storePath`            | `~/.cache/opencode-session-recall/store-v1.db` | Path to the derived SQLite store. The v2 default is `store-opencode-v2.db` in the same directory   |
| `coldPass`             | `true`                                         | Run the background cold pass that builds the store                                                 |
| `concurrency`          | `3`                                            | Most history reads at once, shared by the tools, the drill and the distiller                       |
| `drillSessions`        | `12`                                           | Shortlisted sessions a query reads                                                                 |
| `semanticSlots`        | `2`                                            | Drill slots kept for the top semantic matches when `semantic` is on. `0` turns the reservation off |
| `drillPageMessages`    | `25`                                           | Messages per page in an untargeted drill                                                           |
| `drillCharsPerSession` | `1,500,000`                                    | Characters a drill keeps from one session                                                          |
| `drillCharsPerQuery`   | `20,000,000`                                   | Characters a drill keeps across all its sessions                                                   |
| `deepCharsPerQuery`    | `30,000,000`                                   | Characters one deep sweep keeps                                                                    |
| `cacheMaxChars`        | `24,000,000`                                   | Characters the drill's page cache holds, which keeps repeat queries warm                           |
| `distillConcurrency`   | `2`                                            | Sessions the cold pass, the repair sweep and re-distills each work on at once                      |
| `distillDelayMs`       | `25`                                           | Pause between one session's page reads while distilling                                            |
| `ftsRowsPerSession`    | `5000`                                         | Slim-index rows kept per session. A larger session keeps its newest rows                           |
| `inventoryTokens`      | `200`                                          | Token cap on a card's inventory of code anchors and digest terms                                   |
| `maxSessions`          | unlimited                                      | Largest `sessionLimit` a `recall` call takes                                                       |
| `maxResults`           | `50`                                           | Most results one search returns                                                                    |
| `maxSessionList`       | `100`                                          | Largest `limit` a `recall_sessions` page takes                                                     |
| `maxMessages`          | `50`                                           | Largest `limit` a `recall_messages` call takes. It also caps `recall_context` pages and expansion  |
| `maxWindow`            | `10`                                           | Largest context window                                                                             |
| `defaultWidth`         | `200`                                          | Default snippet width                                                                              |

</details>

## OpenCode v2 notes

On v2 the plugin registers the same five tools with the same arguments and results. `nudge`, `primary`, `global`, `mode`, `semantic` and the advanced limits work as on v1. A few things differ.

History comes from `opencode.db`, because v2's plugin API cannot page messages. The plugin opens the file read-only, never writes to it and holds no read transaction open. It finds the file the way OpenCode does, through `OPENCODE_DB`, the build channel and `XDG_DATA_HOME`. Set `opencodeDbPath` to read a different file. When the file is missing or unreadable, every response says why in `coverage.source`. `recall` then answers from the session cards an earlier run built. The tools that read messages return the reason as their error.

The v2 index has its own store, `~/.cache/opencode-session-recall/store-opencode-v2.db`, next to v1's `store-v1.db`. Each store records the host and the history database it was built from and refuses to be used by the other, so the two never overwrite each other. One v2 process indexes every project into that file, archived sessions included. `global: false` limits only what searches can reach. New messages reach the index within about 30 seconds and renames, moves and archiving within about 5 minutes.

The plugin runs inside OpenCode's background service, so give `storePath` and `opencodeDbPath` as absolute paths. A relative path resolves against the service's working directory instead of your project.

Some features are not available on v2 yet. `autoRecall`, `compactionRecall` and `summaries` log a line when turned on and change nothing. Tool calls show no custom titles in the TUI, since v2 gives plugin tools no title channel.

v2 discards plugin console output. Set `RECALL_DEBUG=1` in the environment of the OpenCode service to log to `~/.cache/opencode-session-recall/recall.log`, which is size-capped with one rotation.

If the log says `store refused (<reason>)`, quit every OpenCode v2 process, including the background service (`opencode service stop`). Then delete `~/.cache/opencode-session-recall/store-opencode-v2.db` and start OpenCode again. The store rebuilds in the background.

## Tools

The agent gets each tool's full arguments and response shape from its description at runtime. This section covers what each tool is for.

Every tool keeps its result within what OpenCode passes to the model whole, which is 2,000 lines and 50 KiB. A result that would not fit in 40 KiB and 1,900 lines comes back with `trimmed: true` and a `continuation`, written ahead of the records. Passing the `continuation` back as `cursor`, with the same other arguments, returns the rest from exactly where the output stopped. If what it points at changed in the meantime, the tool refuses it with an error that says to start again without `cursor`.

### `recall`

Searches session titles, messages, reasoning, the commands tools ran and the tool outputs of the sessions it drills into. It searches every project by default, or one project or session with `scope`. `match` picks `literal` (the default, a case-insensitive substring), `smart` or `fuzzy` (BM25 ranking through [MiniSearch](https://github.com/lucaong/minisearch), forgiving of typos and of separators such as `rate-limit` against `rateLimit`) or `regex`. Other arguments filter by `type`, `role`, `authorship`, `toolName`, time bounds such as `since` and `until`, directory or project. `group: "session"` returns one result per session, `expand` inlines context around the top hits and `deep: true` sweeps tool outputs in a scoped set of sessions ([Deep mode](#deep-mode)).

Project and global searches leave out the current session unless you pass `excludeCurrentSession: false`. `excludeFamily: true` also leaves out the current session's parent, siblings and subagents. `authorship: "human"` keeps only what a person typed, since `role: "user"` also covers prompts an orchestrating agent wrote for its subagents and text the host injected. Each result explains its match in `why`. The response's `coverage` reports what the search read and skipped.

```
recall({ query: "rate limit", match: "smart", group: "session" })
recall({ query: "migration", since: "7d", directory: "/workspace/project" })
recall({ query: "npm test", type: "tool", toolName: "bash" })
recall({ query: "ECONNREFUSED|ETIMEDOUT", match: "regex", scope: "global" })
recall({ query: "OOMKilled", deep: true, sessions: ["ses_abc"] })
```

### `recall_get`

Returns the full content of one message with all its parts. Tool outputs come back in their original form, even when they were pruned from context. Use it after `recall` finds something. On v2 a message too large for one history read (over 4 MiB with its parts, or more than 2,000 part rows) carries `partial`. Following its continuations reads the remaining parts.

### `recall_context`

Returns the messages around one message, to show what was asked before a match and what happened after it. Pass `window` for a symmetric window, or `before` and `after`. `hasMoreBefore` and `hasMoreAfter` mark the session's ends. Built from bounded pages, the window stays cheap on a huge session.

```
recall_context({ sessionID: "ses_abc", messageID: "msg_def", before: 1, after: 5 })
```

### `recall_messages`

Browses one session's messages, the current session by default, newest first or with `order: "oldest"` on v2. `limit` (default 10, at most `maxMessages`) caps the messages returned. With `role` or `query` set, a call reads on until `limit` messages match, reading at most `scan` messages (default 500, at most 2,000) or 40 pages. `pagination` reports the counts `scanned`, `matched` and `returned`, with the reason the call stopped in `stop`. `pagination.nextCursor` resumes right after the last message the call read, even when the next call changes `limit`, `role` or `query`.

```
recall_messages({ query: "npm", role: "user", scan: 1000 })
```

### `recall_sessions`

Lists sessions by title, enriched from each session's card with a content `digest`, the top `files` and `tools` it touched and, for a root session, a `family` rollup. Filter with `scope`, `search` and `since` or `until`. For topical discovery `recall` works better, since it searches titles and content together. `parentID: "current"` lists the direct children of the calling session live from OpenCode, including cancelled or in-flight subagents the index has not reached yet. Use it to recover a subagent whose Task returned "Task cancelled" without a `task_id`. Long listings come in pages through `cursor`.

```
recall_sessions({ scope: "global", search: "deployment", since: "7d" })
recall_sessions({ parentID: "current" })
```

## How it works

Compaction in OpenCode doesn't delete anything. Tool outputs are swapped for placeholder text in the model's context and messages before a compaction boundary are skipped when the context is rebuilt, but the original rows stay in the database. The plugin reads them back through the OpenCode SDK on v1 and from `opencode.db`, read-only, on v2.

Retrieval is bounded and precision-first. A search ranks sessions from a small index and then reads only the top few, in bounded pages, so it never pulls a whole session into memory. It does not read everything in scope. Each response's `coverage` says how many sessions it read, where it stopped in each one and what it skipped. A miss can then be told apart from an absence.

### Cards and the slim index

Every query starts from the store, without reading any history. One card per session holds its title, a summary head, the distinctive identifiers, paths and commands it used, the files and tools it touched and its error signatures. A query ranks the cards with BM25, exact code-token hits and a recency prior to pick a shortlist of sessions. `recall_sessions`, `autoRecall` and `compactionRecall` read the cards directly.

The slim full-text index is an FTS5 table over conversation text, reasoning, tool-input commands and titles. It leaves out tool outputs, which make up most of the history and most of its noise. It catches a rare identifier or error string a card dropped and adds that session to the shortlist.

### Bounded drill

For the shortlisted sessions (12 by default, set by `drillSessions`), the plugin reads bounded pages, caps each part as it arrives and ranks the results under per-session and per-query character budgets. The drilled sessions' tool outputs are searched here. Ranking is BM25 plus boosts for exact phrases, code tokens such as `deploy.yaml`, reasoning, error text and user messages, with penalties for skill payloads and file reads. If `smart` or `fuzzy` finds nothing, `recall` retries as a literal scan over the same sessions.

### Deep mode

The drill cannot find a needle that exists only in a tool output of a session nothing else points at. `deep: true` sweeps every part of a scoped set of sessions, outputs included. It needs a scope, which is either a `sessions` list or a lower time bound with a project or directory filter. A global unscoped sweep is rejected. It runs under character and wall-clock budgets. When a budget stops it, the response returns a `nextCursor` to pass back as `deepCursor`.

### The derived store

The store lives in `~/.cache/opencode-session-recall/store-v1.db` on v1 and `store-opencode-v2.db` on v2. A first cold pass distills every session into a card and slim-index rows, checkpointing as it goes. After that, OpenCode's events keep the store current on v1 and a poll of `opencode.db` keeps it current on v2. While the cold pass runs, responses carry `coverage.cards.indexing` and warn that older history may be missing.

The store uses the runtime's built-in SQLite, so it adds no npm dependency. Several OpenCode processes can share it, with a single-writer lease letting one of them write at a time. The store is versioned. A store written by a newer build, one owned by the other OpenCode host or one built from a different history database is refused and left unwritten. The plugin then logs `store refused (<reason>)` and answers from metadata-only cards, as it does when no SQLite driver is available. An older build therefore runs degraded against a store a newer build upgraded.

To reset a store, quit every OpenCode process that shares it, delete the file and start OpenCode again. It rebuilds in the background.

### Ephemeral mode (opt-in)

`mode: "ephemeral"` runs with no store. It opens no SQLite file, writes nothing under `~/.cache/opencode-session-recall` and runs no background indexing. Sessions are ranked from the session list's metadata and content search runs live through the drill, so ranking is weaker and each query reads more. `semantic`, `summaries` and `compactionRecall` are off. A query without a `scope` searches the current project.

```jsonc
{
  "plugin": [["opencode-session-recall", { "mode": "ephemeral" }]],
}
```

Switching an existing install to ephemeral leaves the old store file in place. Delete `~/.cache/opencode-session-recall/` yourself if you want it gone.

### Semantic search (opt-in)

With `semantic: true`, card ranking blends in similarity from a small local static-embedding model, which helps a paraphrase find a session that used different words. The model (`minishlab/potion-base-8M` by default) is downloaded once to `~/.cache/opencode-session-recall/models/` and runs in-process. Nothing else leaves the machine. Any failure to download, load or run it falls back to lexical ranking.

### LLM summaries (opt-in)

`summaries` has your own model write a two- or three-sentence summary of each card. The summary joins the card's search text and becomes its `recall_sessions` digest. It spends your tokens, so it runs only when you name a model as `"providerID/modelID"`. A cheap, fast model is enough. It is not available on OpenCode v2 yet.

```jsonc
{
  "plugin": [
    [
      "opencode-session-recall",
      { "summaries": { "enabled": true, "model": "anthropic/claude-haiku-4-5" } },
    ],
  ],
}
```

Only the process holding the store's write lease writes summaries. It sends one prompt at a time with about fifteen cards in each and stops a pass after `maxPromptsPerPass` prompts (200 by default). A card whose fields have not changed is skipped. The prompts run in throwaway sessions titled `[recall-summarizer]`, which every recall path excludes. The prompt carries card fields and never message bodies. It asks OpenCode to disable tools, which OpenCode does not guarantee. For an enforced block, define a deny-all agent and set `summaries.agent` to it.

```json title="opencode.json"
{
  "agent": {
    "recall-summarizer": { "permission": { "*": "deny" } }
  }
}
```

## Recall is not memory

This plugin is not a memory system. A memory system keeps a selected, curated record. Recall returns raw history verbatim when the agent asks for it.

The two work well together. With a memory system alongside, recall is where its source material comes from. The agent searches its history, follows the promising hits with `recall_get` or `recall_context` and then decides what is worth keeping. User preferences, project decisions, reusable root causes and approaches that clearly worked or failed are worth keeping. One-off commands, transient errors and routine implementation detail are not.

## Questions and feedback

There is a [discussion thread](https://discord.com/channels/1391832426048651334/1493798786550464672) for this plugin in the OpenCode Discord. Discord only resolves that link once you are in the server, so join through [discord.gg/opencode](https://discord.gg/opencode) first if you are not already. Bugs and feature requests are better as [GitHub issues](https://github.com/rmk40/opencode-session-recall/issues), where they can be tracked against a release.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details, a module guide and development setup.

## License

MIT
