# opencode-recall

An [opencode](https://github.com/opencode-ai/opencode) plugin that gives agents the ability to search and retrieve conversation history from the database. Recovers context lost to compaction — original tool outputs, earlier messages, reasoning, and user instructions that were pruned from the agent's context window.

## Why

When opencode compacts a session, the agent loses access to earlier conversation content. Tool outputs get pruned (replaced with "[Old tool result content cleared]") and messages before the compaction boundary are filtered out. But the original data remains in the database. This plugin lets the agent search and retrieve it.

## Install

Add to your `opencode.jsonc`:

```jsonc
{
  "plugin": [
    // Basic — project-scoped search
    "opencode-recall",

    // With options — enable cross-project search
    ["opencode-recall", { "global": true }],
  ],
}
```

For local development:

```jsonc
{
  "plugin": ["./path/to/opencode-recall-plugin"],
}
```

## Options

| Option    | Type      | Default | Description                                               |
| --------- | --------- | ------- | --------------------------------------------------------- |
| `primary` | `boolean` | `true`  | Register tools as primary tools (available to all agents) |
| `global`  | `boolean` | `false` | Enable cross-project search (`scope: "global"`)           |

## Tools

### `recall`

Search conversation history. The primary tool.

**Parameters:**

| Name        | Type                                       | Default     | Description                                 |
| ----------- | ------------------------------------------ | ----------- | ------------------------------------------- |
| `query`     | `string`                                   | required    | Text to search for (case-insensitive)       |
| `scope`     | `"session" \| "project" \| "global"`       | `"session"` | How far to search                           |
| `sessionID` | `string?`                                  | —           | Target a specific session (overrides scope) |
| `type`      | `"text" \| "tool" \| "reasoning" \| "all"` | `"all"`     | Filter by part type                         |
| `role`      | `"user" \| "assistant" \| "all"`           | `"all"`     | Filter by message role                      |
| `sessions`  | `number`                                   | `10`        | Max sessions to scan (1-50)                 |
| `results`   | `number`                                   | `10`        | Max results to return (1-50)                |
| `title`     | `string?`                                  | —           | Filter sessions by title                    |

**Searches:** text parts, tool outputs, tool inputs, tool titles, reasoning text, subtask descriptions.

**Returns:** JSON with matching snippets, session/message/part IDs, and whether each result was pruned.

### `recall_get`

Retrieve full message content by ID. Use after `recall` to get the complete content of a search result.

**Parameters:**

| Name        | Type     | Description                    |
| ----------- | -------- | ------------------------------ |
| `sessionID` | `string` | Session containing the message |
| `messageID` | `string` | Message to retrieve            |

**Returns:** JSON with full message info and all parts (text, tool outputs, reasoning, etc). Tool outputs are returned in full — even if they were pruned from context.

### `recall_sessions`

List sessions for discovery. Use before `recall` to find the right session.

**Parameters:**

| Name     | Type                    | Default     | Description             |
| -------- | ----------------------- | ----------- | ----------------------- |
| `scope`  | `"project" \| "global"` | `"project"` | Scope of search         |
| `search` | `string?`               | —           | Filter by session title |
| `limit`  | `number`                | `20`        | Max sessions (1-100)    |

**Returns:** JSON with session metadata (IDs, titles, directories, timestamps).

## Usage Examples

### Recover pruned tool output from current session

```
recall({ query: "error", scope: "session", type: "tool" })
  → finds compacted tool parts with error output
recall_get({ sessionID: "ses_abc", messageID: "msg_def" })
  → returns original error text
```

### Find how something was done in another session

```
recall_sessions({ search: "CI", scope: "project" })
  → finds "Set up GitHub Actions CI" session
recall({ query: "workflow", sessionID: "ses_xyz" })
  → finds tool outputs with YAML content
recall_get({ sessionID: "ses_xyz", messageID: "msg_uvw" })
  → returns the full workflow file
```

### Find the original user requirement after compaction

```
recall({ query: "requirement", scope: "session", role: "user" })
  → finds user messages from before compaction
```

### Cross-project search (requires `global: true`)

```
recall_sessions({ scope: "global", search: "auth" })
  → lists sessions across all projects
recall({ query: "JWT middleware", sessionID: "ses_other" })
  → searches that session
```

## How It Works

- Uses the opencode SDK client (no direct database access)
- Searches client-side via substring matching after loading messages
- Original tool outputs are preserved in the database even after pruning
- Sessions are scanned newest-first with bounded concurrency (3 at a time)
- Respects abort signals for long-running searches
- Global scope is disabled by default for security

## License

MIT
