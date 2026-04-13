# opencode-recall

**Give your agent a memory that survives compaction.**

When opencode compacts a session, everything before the boundary disappears from the agent's context: tool outputs get replaced with `"[Old tool result content cleared]"`, earlier messages are filtered out, and the original user requirements vanish. The agent forgets what it already solved, what errors it already debugged, what the user originally asked for.

But all of that data is still in the database. `opencode-recall` gives the agent tools to search and retrieve it.

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
    "opencode-recall",

    // Enable cross-project search
    ["opencode-recall", { "global": true }],
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

- Uses the opencode SDK client for all data access (no direct database queries)
- opencode preserves all message and part data in the database, even after compaction prunes it from the agent's context window
- Search is client-side substring matching — no server-side full-text index needed
- Sessions are scanned newest-first with bounded concurrency
- Respects abort signals for long-running searches
- Global scope is disabled by default

## License

MIT
