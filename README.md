# opencode-session-recall

**Everything your agent ever did is already in the database. It's just not looking.**

OpenCode stores the full conversation history your agent worked through — messages, tool calls, tool outputs, reasoning traces — even after compaction removes them from the active context window. As conversations get long, OpenCode shrinks what the model can see. The old content is still stored, just no longer visible to the agent.

This plugin gives the agent five tools to search and retrieve all of it on demand — within the current session, across every session in the project, or across every project on the machine.

[OpenCode](https://github.com/opencode-ai/opencode) is an open-source AI coding agent that runs in your terminal.

**No new database.**
**No embeddings.**
**No summarization.**
**No duplication.**
**No overhead.**

Just install the plugin. The agent can search its own history.

## The problem is absurd when you think about it

Your agent solves a tricky build error. Twenty minutes later, compaction runs. An hour later, the same error shows up. The agent starts from zero — debugging something it already figured out, while the answer sits in the database it's connected to.

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
```

| Param            | Default    | Description                                   |
| ---------------- | ---------- | --------------------------------------------- |
| `query`          | required   | Text to search for (case-insensitive)         |
| `scope`          | `"global"` | `"session"`, `"project"`, or `"global"`       |
| `sessionID`      | —          | Target a specific session (overrides scope)   |
| `type`           | `"all"`    | `"text"`, `"tool"`, `"reasoning"`, or `"all"` |
| `role`           | `"all"`    | `"user"`, `"assistant"`, or `"all"`           |
| `before`/`after` | —          | Timestamp filters (ms epoch)                  |
| `width`          | `200`      | Snippet size (50–1000 chars)                  |
| `sessions`       | `10`       | Max sessions to scan                          |
| `results`        | `10`       | Max results to return                         |

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

## How it works

When OpenCode compacts a session, it doesn't delete anything. Tool outputs get a `compacted` timestamp and are replaced with placeholder text in the LLM's context — but the original data stays in the database. Messages before a compaction boundary are skipped when building the LLM context — but they're still there.

This plugin reads all of it through the OpenCode SDK:

- No direct database queries, no separate storage
- Zero setup — no embeddings to generate, no indexes to build, no data to sync
- Sessions scanned newest-first with bounded concurrency
- Respects abort signals for long-running searches
- Cross-project search enabled by default (disable with `global: false`)

## License

MIT
