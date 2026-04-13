# opencode-session-recall

A plugin for [opencode](https://github.com/opencode-ai/opencode) that gives your agent a memory that survives compaction — without building another memory system.

opencode is an open-source AI coding agent that runs in your terminal. It manages long conversations through compaction: summarizing older context to keep the active window focused. But compaction means the agent forgets — original tool outputs, earlier reasoning, the user's exact words.

This plugin adds five tools to the agent's toolkit that let it search and retrieve that lost context on demand, within the current session, across all sessions in the project, or across every project on the machine.

**It doesn't create a separate memory store.** Most agent "memory" solutions add vector databases, embedding pipelines, or knowledge graphs — duplicating your data into yet another system. `opencode-session-recall` does none of that. opencode already stores every message, every tool output, every reasoning trace in its database, even after compaction prunes them from context. This plugin simply gives the agent access to what's already there.

No embeddings. No vector store. No data duplication. No setup. Just install the plugin and the agent can remember.

## What this enables

**"We already solved this."** The agent searches its own history and finds the solution from 2 hours ago that got compacted away, instead of solving the same problem again.

**"How did we do it in that other project?"** Cross-project search finds the JWT middleware implementation from the auth project, the Docker config from the deployment project, the test patterns from the API project.

**"What did you originally ask for?"** After 50+ tool calls and 3 compactions, the agent can pull up the user's exact original requirements to make sure it's still on track.

**"What was that error?"** The full stack trace from the tool output that got pruned is still there. The agent retrieves it instead of reproducing the error.

**"Show me what happened."** Browse any session chronologically, play back the conversation, understand the narrative of how a problem was investigated and solved.

## Install

```jsonc
{
  "plugin": [
    "opencode-session-recall",

    // Enable cross-project search
    ["opencode-session-recall", { "global": true }],
  ],
}
```

## Tools

Five tools, designed around how agents actually navigate conversation history:

### `recall` — Search

The primary tool. Full-text search across text, tool outputs, tool inputs, reasoning, and subtask descriptions. Searches the current session by default, or widen to all project sessions or all sessions globally.

```
recall({ query: "authentication", scope: "project" })
recall({ query: "error", after: <2 days ago>, type: "tool" })
recall({ query: "JWT", sessionID: "ses_from_another_project" })
```

| Param            | Default     | Description                                   |
| ---------------- | ----------- | --------------------------------------------- |
| `query`          | required    | Text to search for (case-insensitive)         |
| `scope`          | `"session"` | `"session"`, `"project"`, or `"global"`       |
| `sessionID`      | —           | Target a specific session (overrides scope)   |
| `type`           | `"all"`     | `"text"`, `"tool"`, `"reasoning"`, or `"all"` |
| `role`           | `"all"`     | `"user"`, `"assistant"`, or `"all"`           |
| `before`/`after` | —           | Timestamp filters (ms epoch)                  |
| `width`          | `200`       | Snippet size (50-1000 chars)                  |
| `sessions`       | `10`        | Max sessions to scan                          |
| `results`        | `10`        | Max results to return                         |

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

## Real-world workflow

This is what it actually looks like when an agent uses these tools to answer "what have we been doing with our UniFi network?" across a 3-week, 600+ message session in a different project:

```
1. recall_sessions({ scope: "global", search: "unifi" })
   → discovers the ubiopti project session

2. recall_messages({ sessionID: "...", limit: 5, role: "user", reverse: true })
   → reads the most recent user messages to understand current state

3. recall({ query: "kickout threshold", sessionID: "...", width: 500 })
   → finds the technical root cause analysis in tool outputs

4. recall_context({ sessionID: "...", messageID: "...", window: 3 })
   → expands around the Ubiquiti support chat to see the full interaction

5. recall({ query: "iwpriv", sessionID: "...", after: <recent timestamp> })
   → finds only recent mentions, not the whole session history
```

Five tool calls, complete narrative reconstructed across projects.

## Options

| Option    | Type      | Default | Description                                         |
| --------- | --------- | ------- | --------------------------------------------------- |
| `primary` | `boolean` | `true`  | Register tools as primary (available to all agents) |
| `global`  | `boolean` | `false` | Enable cross-project search via `scope: "global"`   |

## How it works

This plugin doesn't create a separate memory store. It reads what opencode already has.

When opencode compacts a session, it doesn't delete anything. Tool outputs get a `compacted` timestamp and are replaced with placeholder text in the LLM's context — but the original data stays in the database. Messages before a compaction boundary are skipped when building the LLM context — but they're still there. The plugin accesses all of this through the opencode SDK.

- Uses the opencode SDK client (no direct database queries, no separate storage)
- Zero setup — no embeddings to generate, no indexes to build, no data to sync
- Sessions are scanned newest-first with bounded concurrency
- Respects abort signals for long-running searches
- Global scope is disabled by default

## License

MIT
