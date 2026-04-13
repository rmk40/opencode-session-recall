# opencode-recall Plugin Implementation Plan

**Version:** 0.2
**Date:** 2026-04-12
**Status:** In Progress
**Branch:** `main`
**Source:** This document is the primary design reference.
**Estimated total effort:** 6-10 hours (2-3 sessions)
**Dependencies:** Bun, TypeScript, `@opencode-ai/plugin`, `@opencode-ai/sdk`

---

## How to Use This Document

This plan is designed for execution by an **orchestrator agent** that
delegates implementation to specialized agents (`@code-writer`,
`@code-review`, `@docs-writer`) while maintaining full project context.

The orchestrator NEVER writes implementation code directly. Every line of
code is delegated. The orchestrator's job is to sequence work, provide
context, verify output, enforce quality gates, and maintain this plan.

### Orchestrator Workflow

For **every task**, follow this exact sequence:

```
1. DELEGATE  ->  @code-writer (with detailed prompt from this plan)
2. BUILD     ->  Verify: bun run build passes with zero warnings
3. TEST      ->  Smoke test the relevant functionality
4. LOOK      ->  (if UI changed) Visual verification
5. REVIEW    ->  @code-review (with review criteria from the task definition)
6. FIX       ->  @code-writer (with specific review findings)
7. RE-REVIEW ->  (if fixes were substantial: >3 files or logic changes)
8. COMMIT    ->  Only after zero blockers from review
9. UPDATE    ->  Mark status table done, record commit SHA
```

### Context Window Strategy

- **Load this document at session start** before delegating any work.
- **Include all necessary context in delegation prompts** — delegated
  agents have no prior context. Include file paths, API signatures,
  data model details, and relevant design doc sections.
- **Carry cumulative knowledge forward** — later tasks reference earlier
  implementations. Include file paths and API signatures from prior
  tasks in delegation prompts for dependent tasks.

### Resuming Mid-Plan

An agent resuming mid-plan should:

1. Read this entire document
2. Check the per-task status tables for the first incomplete step
3. Run `git log --oneline -20` and `git status` to orient
4. Read source files created by completed tasks to rebuild context
5. Resume from the first incomplete step

### Authoritative References

| Document                                                    | Purpose                                     |
| ----------------------------------------------------------- | ------------------------------------------- |
| This document                                               | Primary design and implementation reference |
| `packages/plugin/src/index.ts`                              | opencode plugin Hooks interface             |
| `packages/plugin/src/tool.ts`                               | Plugin tool definition API                  |
| `packages/sdk/js/`                                          | opencode SDK client (session/message APIs)  |
| `/Users/rmk/projects/oss/opencode-dynamic-context-pruning/` | Reference plugin implementation (DCP)       |

### Validation Commands

```bash
# Build (must pass before every commit)
bun run build

# Typecheck
bun run typecheck

# Smoke test — load plugin in opencode dev mode
bun run dev
```

---

## Plan Maintenance Protocol

This document is a living artifact. Keep it accurate:

1. **Status tables** — update **immediately** after completing each step
2. **Notes column** — record commit SHA, review outcomes, design deviations
3. **Decision log** — record decisions BEFORE implementing
4. **Plan version** — bump when making structural changes

---

## Problem Statement

### What happens during compaction

opencode manages context window pressure through two mechanisms:

1. **Pruning**: Sets `part.state.time.compacted = Date.now()` on older
   tool call parts. When building LLM context, pruned tool outputs are
   replaced with `"[Old tool result content cleared]"`. The original
   output remains in the database.

2. **Full compaction**: An LLM-generated summary replaces the
   conversation history. `filterCompacted()` walks messages in reverse
   and stops at the most recent compaction boundary. Messages before the
   boundary are excluded from LLM context. They remain in the database.

### What the agent loses

After compaction, the agent cannot access:

- Original tool outputs (file contents, grep results, error messages)
- Early user requirements and instructions
- Reasoning and decision rationale from earlier in the conversation
- Implementation details from prior steps
- Cross-session knowledge from other conversations

### What this plugin does

Provides tools that let the agent search and retrieve conversation
history from the opencode database via the SDK client. This recovers
context lost to compaction within the current session, across sessions
in the same project, or across all projects globally.

---

## Design

### Architecture

A standalone opencode plugin package (`opencode-recall`) that:

1. Registers tools via the `tool` hook
2. Uses the SDK client (from `PluginInput.client`) for all data access
3. Performs client-side search (the SDK has no server-side full-text search)
4. Returns structured text results the LLM can parse and act on

### Why SDK-only (no direct DB access)

- Decoupled from schema changes — the SDK is the stable contract
- No SQLite dependency in the plugin
- Works with any opencode backend (local, remote, future cloud)
- The SDK returns full data including compacted tool outputs (the
  `"[Old tool result content cleared]"` substitution only happens
  when building LLM context, not in API responses)

### SDK Data Access Summary

| Operation             | SDK Method                                                                  | Notes                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| List project sessions | `client.session.list({ search?, limit?, start? })`                          | Scoped to current project, sorted by time_updated DESC, default limit 100, no cursor pagination                         |
| List global sessions  | `client.experimental.session.list({ search?, limit?, cursor?, archived? })` | Cross-project, has cursor pagination via `x-next-cursor` header, excludes archived by default                           |
| Load messages         | `client.session.messages({ sessionID, limit?, before? })`                   | No limit = ALL messages. Returns `{ info, parts }[]` oldest-first. Parts include full tool outputs even when compacted. |
| Load single message   | `client.session.message({ sessionID, messageID })`                          | Returns `{ info, parts }` with all parts                                                                                |

### Key data shapes

**Session**: `{ id, title, directory, projectID, parentID?, time: { created, updated, compacting?, archived? }, summary? }`

**Message (User)**: `{ id, sessionID, role: "user", time: { created }, agent, model, summary?, format? }`

**Message (Assistant)**: `{ id, sessionID, role: "assistant", parentID, modelID, providerID, mode, agent, summary?, cost, tokens, error?, finish? }`

**Part types**: `text` (has `text` field), `reasoning` (has `text`), `tool` (has `tool` name + `state` with `input`/`output`/`status`/`time`), `compaction` (has `auto`), `subtask`, `file`, `snapshot`, `patch`, `step-start`, `step-finish`, `agent`, `retry`

**ToolStateCompleted**: `{ status: "completed", input, output: string, title, metadata, time: { start, end, compacted? } }`

### Compaction detection

A part is "compacted" if:

- It's a tool part with `state.time.compacted` set (pruned output)
- It's a message that would be filtered by `filterCompacted()` — i.e.,
  it exists before the most recent compaction boundary

To identify the compaction boundary: scan messages for a user message
with a `compaction` part that has a corresponding completed assistant
message with `summary: true`.

---

## Tool Design

### Design principles

1. **The agent decides scope** — parameters let the agent control how
   wide to search, how many results to return, what types to filter by
2. **Structured output** — return JSON-formatted strings so the agent
   can parse results and make follow-up calls
3. **Progressive disclosure** — search returns snippets; get returns
   full content. Avoids flooding context with large tool outputs.
4. **Metadata for navigation** — every result includes IDs the agent
   can use in follow-up calls (sessionID, messageID)

### Tool: `recall`

The primary search tool. Searches across text, tool outputs, tool
inputs, reasoning, and session titles.

**Description for LLM:**

```
Search your conversation history in the opencode database. Use this
to recover context lost to compaction — original tool outputs, earlier
messages, reasoning, and user instructions that were pruned from your
context window.

Searches text content, tool inputs/outputs, and reasoning. Returns
matching snippets with session/message IDs you can pass to recall_get
for full content.

Start with scope "session" (fastest). Widen to "project" if not found.
Use sessionID param to target a specific session found via
recall_sessions. Use role "user" to find original requirements.
```

**Parameters:**
| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `query` | `string` | yes | — | Text to search for (case-insensitive substring match). Min length 1. |
| `scope` | `enum` | no | `"session"` | `"session"` (current), `"project"` (all project sessions), `"global"` (all sessions everywhere). Global requires explicit opt-in via plugin options. |
| `sessionID` | `string` | no | — | Search a specific session by ID. Overrides `scope`. |
| `type` | `enum` | no | `"all"` | Filter by part type: `"text"`, `"tool"`, `"reasoning"`, `"all"` |
| `role` | `enum` | no | `"all"` | Filter by message role: `"user"`, `"assistant"`, `"all"` |
| `sessions` | `number` | no | `10` | Max sessions to scan (for project/global scope). Min 1, max 50. |
| `results` | `number` | no | `10` | Max results to return. Min 1, max 50. |
| `title` | `string` | no | — | Filter sessions by title (narrows which sessions to scan) |

**Search targets by part type:**

- `text`: `part.text`
- `tool` (completed): `part.state.output`, `part.state.input` (JSON stringified), `part.state.title`
- `tool` (error): `part.state.error`, `part.state.input` (JSON stringified)
- `reasoning`: `part.text`
- `subtask`: `part.description`, `part.prompt`

**Deduplication:** At most one result per part. If a part matches on
multiple fields (e.g., both input and output), use the best snippet
(longest match context).

**Session title matching:** Session titles are NOT returned as search
results (they have no associated message/part). Instead, session title
matching is handled by the `title` parameter, which pre-filters which
sessions to scan. The `recall_sessions` tool is the right way to
discover sessions by title.

**Return format (JSON string):**

```json
{
  "results": [
    {
      "sessionID": "ses_abc123",
      "sessionTitle": "Fix auth middleware",
      "directory": "/Users/rmk/projects/myapp",
      "messageID": "msg_def456",
      "role": "assistant",
      "time": 1712764200000,
      "partID": "part_ghi789",
      "partType": "tool",
      "pruned": true,
      "snippet": "...matching content around the query...",
      "toolName": "Read"
    }
  ],
  "scanned": 5,
  "total": 23,
  "truncated": true
}
```

**`pruned` field semantics:** True only when the part is a completed
tool part with `state.time.compacted` set (its output was pruned from
LLM context). This is distinct from messages that are before a
compaction boundary — those are simply older messages, not pruned.
The agent doesn't need to know about compaction boundaries; it just
needs to know if a tool output was erased from its context.

**Algorithm:**

1. Determine session list based on scope:
   - If `sessionID` param is set: use that single session
   - `"session"`: just the current session (from `toolCtx.sessionID`)
   - `"project"`: `client.session.list({ search: title, limit: sessions })`
   - `"global"`: `client.experimental.session.list({ search: title, limit: sessions })`
     (only if global scope is enabled via plugin options — see Decision D11)
2. For each session (newest first by `time.updated`), with bounded
   concurrency (up to 3 sessions loaded in parallel via `Promise.all`
   batches):
   a. Check `ctx.abort` signal — stop if cancelled
   b. Load messages: `client.session.messages({ sessionID })`
   c. For each message:
   - Skip if `role` filter set and `info.role` doesn't match
   - For each part: - Skip if `type` filter set and `part.type` doesn't match - Get searchable strings from `extract.searchable(part)` - For each string, case-insensitive substring match against `query` - On first match for this part (dedup — one result per part): - Extract snippet (up to 200 chars centered on match) - Set `pruned` from `extract.pruned(part)` - Add to results
     d. Stop when `results` limit reached
3. Return formatted JSON, or JSON error envelope on failure

### Tool: `recall_get`

Retrieve full content of a specific message and all its parts.

**Description for LLM:**

```
Retrieve the full content of a specific message from any session,
including all parts (text, tool outputs, reasoning, etc). Use after
recall to get the complete content of a search result.

For tool parts, returns the original output even if it was compacted
(pruned from your context window).
```

**Parameters:**
| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `sessionID` | `string` | yes | — | Session containing the message |
| `messageID` | `string` | yes | — | Message to retrieve |

**Return format (JSON string):**

```json
{
  "ok": true,
  "message": {
    "id": "msg_def456",
    "role": "assistant",
    "time": 1712764200000,
    "agent": "default",
    "model": "claude-sonnet-4-20250514"
  },
  "parts": [
    {
      "id": "part_1",
      "type": "text",
      "pruned": false,
      "content": "Let me read that file..."
    },
    {
      "id": "part_2",
      "type": "tool",
      "pruned": true,
      "toolName": "Read",
      "title": "Reading src/auth.ts",
      "input": { "path": "src/auth.ts" },
      "output": "import express from 'express';\n..."
    }
  ],
  "context": {
    "sessionTitle": "Fix auth middleware",
    "directory": "/Users/rmk/projects/myapp"
  }
}
```

**Error format (JSON string):**

```json
{
  "ok": false,
  "error": "Message not found: msg_def456 in session ses_abc123"
}
```

All tool responses use this `ok` envelope pattern for consistent parsing.

**Algorithm:**

1. Call `client.session.message({ sessionID, messageID })`.
   Wrap in try/catch — return error envelope on failure.
2. Format each part based on type:
   - `text`: include `text` field
   - `tool`: include `tool` name, `state.input`, `state.output`,
     `state.title`, pruned status
   - `reasoning`: include `text`
   - `compaction`: note that this is a compaction boundary
   - Other types: include type and minimal metadata
3. Look up session context. Try `client.session.get({ sessionID })`
   first. If it fails (cross-project session not accessible via
   project-scoped endpoint), gracefully degrade — return the message
   data without session context rather than failing entirely.
4. Return formatted JSON

**Truncation**: If a single tool output exceeds 10,000 chars, keep the
first 5,000 and last 2,000 chars with a `"...[truncated N chars]..."`
marker in the middle. This preserves both the beginning (usually most
relevant) and the end (often has summaries/conclusions).

### Tool: `recall_sessions`

List sessions for discovery — find the right session before searching
its content.

**Description for LLM:**

```
List sessions from the opencode database. Use this FIRST to discover
which sessions exist, then search their content with recall. Returns
session titles, directories, and timestamps. For cross-project
discovery, use scope "global" (requires plugin option global: true).
```

**Parameters:**
| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `scope` | `enum` | no | `"project"` | `"project"` (current project) or `"global"` (all projects) |
| `search` | `string` | no | — | Filter by session title |
| `limit` | `number` | no | `20` | Max sessions to return. Min 1, max 100. |

**Return format (JSON string):**

```json
{
  "sessions": [
    {
      "id": "ses_abc123",
      "title": "Fix auth middleware",
      "directory": "/Users/rmk/projects/myapp",
      "project": { "name": "myapp", "worktree": "/Users/rmk/projects/myapp" },
      "time": { "created": 1712764200000, "updated": 1712787600000 },
      "archived": false
    }
  ],
  "returned": 20,
  "scope": "project"
}
```

Note: `returned` is the count of sessions in the response, NOT the
total available. The SDK doesn't expose a total count. For global scope,
if exactly `limit` sessions are returned, there are likely more.

**Algorithm:**

1. Based on scope, call:
   - `"project"`: `client.session.list({ search, limit })`
   - `"global"`: `client.experimental.session.list({ search, limit })`
     (only if global scope is enabled via plugin options)
2. Map results to session metadata. Session metadata only — no message
   loading. The agent can use `recall` to search content.

3. Return formatted JSON

---

## Agent Use Cases

These scenarios drive the tool design. Each describes what the agent
would do and which tools it would call.

### UC1: "Remember when we set up CI?"

The user references prior work. The agent needs to find it.

```
1. recall_sessions({ search: "CI", scope: "project" })
   → Finds "Set up GitHub Actions CI" session (ses_abc123)
2. recall({ query: "github actions", sessionID: "ses_abc123" })
   → Finds tool outputs with workflow YAML content
3. recall_get({ sessionID: "ses_abc123", messageID: "msg_def456" })
   → Gets the full YAML file content
```

### UC2: "What was the original error?"

After compaction pruned tool outputs in the current session.

```
1. recall({ query: "error", scope: "session", type: "tool" })
   → Finds compacted tool parts with error output
2. recall_get({ sessionID: current, messageID })
   → Gets full error stack trace
```

### UC3: "Do it the same way as the other project"

Cross-project pattern lookup.

```
1. recall({ query: "rate limiting middleware",
           scope: "global", type: "tool" })
   → Finds sessions in other projects with matching tool outputs
2. recall_get({ sessionID, messageID })
   → Gets the implementation code from the other project
```

### UC4: "What did the user originally ask for?"

First messages got compacted away.

```
1. recall({ query: "<something from the user's ask>",
           scope: "session", type: "text" })
   → Finds the original user messages before compaction
2. recall_get({ sessionID: current, messageID })
   → Gets the full original requirement
```

### UC5: Session discovery for cross-project work

```
1. recall_sessions({ scope: "global", search: "auth" })
   → Lists all sessions across projects with "auth" in title
2. recall({ query: "JWT", sessionID: "ses_xyz789" })
   → Searches that specific session for JWT-related content
3. recall_get({ sessionID: "ses_xyz789", messageID: "msg_uvw321" })
   → Gets the full JWT implementation from the other project
```

---

## Performance Analysis

### Current session search

- Load all messages: single SDK call, typically <1000 messages
- In-memory scan: fast (substring match on strings)
- Expected latency: <1 second

### Project-wide search (10 sessions)

- List sessions: 1 SDK call
- Load messages per session: 10 SDK calls (sequential — can't
  parallelize through the SDK client easily)
- Each session: O(messages \* parts) string scans
- Expected latency: 2-5 seconds

### Global search (50 sessions)

- List sessions: 1 SDK call
- Load messages: up to 50 SDK calls
- Expected latency: 5-15 seconds
- Mitigation: early termination on `results` limit, newest sessions
  first

### Memory

Each session's messages are loaded, scanned, then discarded. Peak
memory is one session's messages at a time. Even a large session
(500 messages, 10MB of data) is fine for a Bun process.

---

## Decision Log

| #   | Topic                            | Decision                                                                                                  | Rationale                                                                                                                                         |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | SDK vs direct DB                 | SDK only                                                                                                  | Stable contract, no schema coupling, works with remote backends                                                                                   |
| 2   | Number of tools                  | 3 tools (`recall`, `recall_get`, `recall_sessions`)                                                       | Progressive disclosure: discover → search → retrieve. Keeps each tool focused.                                                                    |
| 3   | Search implementation            | Client-side substring match                                                                               | SDK has no server-side full-text search for message/part content. Substring match is simple, predictable, and fast enough for in-memory scanning. |
| 4   | Output format                    | JSON strings                                                                                              | Structured data the LLM can parse. Includes IDs for follow-up calls.                                                                              |
| 5   | Tool output truncation           | 10,000 char limit per part in recall_get                                                                  | Prevents flooding context. Agent can see it was truncated. Plugin-level truncation also applies (50KB/2000 lines).                                |
| 6   | Session scanning order           | Newest first (by time_updated)                                                                            | Most recent sessions are most likely relevant. Enables early termination.                                                                         |
| 7   | Plugin name                      | `opencode-recall`                                                                                         | "recall" captures the concept of recovering memories/context. Short, clear, not overloaded with meaning.                                          |
| 8   | Cross-project support            | Yes, via `scope: "global"`                                                                                | Real use case: "we did this in another project, find how"                                                                                         |
| 9   | No hasCompaction in session list | Skip compaction detection in recall_sessions                                                              | Would require loading messages for every listed session. Keep list fast.                                                                          |
| 10  | Package location                 | Standalone repo at `~/projects/oss/opencode-recall-plugin/`                                               | Independent package, publishable to npm, follows DCP plugin pattern                                                                               |
| 11  | Global scope gating              | Global scope disabled by default, enabled via plugin option `global: true`                                | Prevents unintentional cross-project data exposure. Users must explicitly opt in.                                                                 |
| 12  | Session targeting                | `recall` has a `sessionID` param that overrides scope                                                     | Required for the discover→search→retrieve workflow (UC1, UC5)                                                                                     |
| 13  | Title matching                   | Session titles are NOT search results — use `title` param to pre-filter, or `recall_sessions` to discover | Title matches have no message/part, don't fit the result schema                                                                                   |
| 14  | Result dedup                     | At most one result per part                                                                               | A single part can match on multiple fields (input, output, title) — dedup to avoid noise                                                          |
| 15  | `pruned` not `compacted`         | Use `pruned` for the boolean field indicating tool output was erased                                      | Clearer semantics — "compacted" is overloaded (means both pruning and full compaction)                                                            |
| 16  | Error envelope                   | All tools return `{ ok: true/false, ... }` JSON                                                           | Consistent parsing for both success and failure cases                                                                                             |
| 17  | Abort signal                     | Long scans check `ctx.abort` between sessions                                                             | Prevents uninterruptible global searches                                                                                                          |
| 18  | Concurrency                      | Load up to 3 sessions in parallel                                                                         | Cuts latency for project/global scope without overwhelming the server                                                                             |
| 19  | Role filter                      | `recall` has a `role` param for user/assistant filtering                                                  | Useful for finding original user requirements (UC4)                                                                                               |

---

## DRY Invariants

| #   | Invariant                                          | Canonical location | Grep check                                                           |
| --- | -------------------------------------------------- | ------------------ | -------------------------------------------------------------------- |
| 1   | All SDK calls go through `client` from PluginInput | `src/index.ts`     | `grep -rn 'fetch\|http\|sqlite\|sql' src/ \| grep -v node_modules`   |
| 2   | All text extraction logic                          | `src/extract.ts`   | `grep -rn '\.text\|\.output\|\.input' src/ \| grep -v extract`       |
| 3   | Search matching logic                              | `src/search.ts`    | `grep -rn 'indexOf\|includes\|match\|search' src/ \| grep -v search` |
| 4   | No TODO/FIXME in committed code                    | Everywhere         | `grep -rn 'TODO\|FIXME\|HACK\|XXX' src/`                             |

---

## DRY Verification Checklist

```bash
# Invariant 1: No direct DB/HTTP access
grep -rn 'fetch\|http\|sqlite\|sql' src/ | grep -v node_modules

# Invariant 2: Text extraction centralized
grep -rn '\.state\.output\|\.state\.input\|part\.text' src/ | grep -v extract

# Invariant 3: Search matching centralized
grep -rn 'indexOf\|includes\|\.match\|\.search' src/ | grep -v search

# Invariant 4: No TODO/FIXME
grep -rn 'TODO\|FIXME\|HACK\|XXX' src/
```

---

## Execution Sequence

```
Phase 1: Project Scaffold
  RCL-01 (package setup)     -> build -> review -> commit
  RCL-02 (types & extract)   -> build -> review -> commit

Phase 2: Core Tools
  RCL-03 (recall_sessions)   -> build -> smoke test -> review -> commit
  RCL-04 (recall search)     -> build -> smoke test -> review -> commit
  RCL-05 (recall_get)        -> build -> smoke test -> review -> commit

Phase 3: Integration & Polish
  RCL-06 (config hook)       -> build -> review -> commit
  RCL-07 (README + docs)     -> review -> commit
  RCL-08 (end-to-end test)   -> verify -> commit
```

---

## Phases

### Phase 1: Project Scaffold

**Goal:** A buildable, loadable plugin package with type definitions
and shared utilities.

---

### RCL-01: Package Setup

**Estimated effort:** 30 minutes
**Dependencies:** None
**Files:** `package.json`, `tsconfig.json`, `src/index.ts`

**Delegation prompt for `@code-writer`:**

> Create a new opencode plugin project at
> `/Users/rmk/projects/oss/opencode-recall-plugin/`.
>
> **package.json** — model after the DCP plugin at
> `/Users/rmk/projects/oss/opencode-dynamic-context-pruning/package.json`:
>
> ```json
> {
>   "name": "opencode-recall",
>   "version": "0.1.0",
>   "type": "module",
>   "description": "OpenCode plugin that lets agents search and retrieve conversation history lost to compaction",
>   "main": "./src/index.ts",
>   "exports": {
>     ".": "./src/index.ts",
>     "./server": "./src/index.ts"
>   },
>   "scripts": {
>     "dev": "opencode plugin dev",
>     "typecheck": "tsc --noEmit"
>   },
>   "peerDependencies": {
>     "@opencode-ai/plugin": ">=1.2.0"
>   },
>   "dependencies": {
>     "@opencode-ai/sdk": "^1.3.2",
>     "zod": "^4.3.6"
>   },
>   "devDependencies": {
>     "@opencode-ai/plugin": "^1.4.3",
>     "typescript": "^6.0.2"
>   }
> }
> ```
>
> Note: Since this is a Bun-based project and will be loaded via
> `opencode plugin dev` (which runs the source directly), the main
> entrypoint points to `.ts` source files — no build step needed.
> `zod` is a runtime dependency because `tool.schema` is a re-export
> but the plugin also uses zod directly for argument schemas. For npm
> publishing later, add a `tsc` build step and change exports to
> `./dist/`.
>
> **tsconfig.json** — strict TypeScript, ESM target, module NodeNext.
>
> **src/index.ts** — minimal plugin skeleton:
>
> ```typescript
> import type { Plugin } from "@opencode-ai/plugin"
>
> const server: Plugin = async (ctx, options) => {
>   return {
>     tool: {
>       // tools will be added in subsequent tasks
>     },
>   }
> }
>
> export default {
>   id: "opencode-recall",
>   server,
> }
> ```
>
> Initialize git. Do NOT run npm install — the orchestrator will do that.

**Review criteria for `@code-review`:**

> - package.json follows the opencode plugin conventions (exports,
>   peerDependencies, scripts)
> - tsconfig.json is strict mode
> - Plugin skeleton compiles
> - Module format is V1 (default export with id + server)

**Acceptance criteria:**

- `bun run typecheck` passes
- Plugin can be loaded via `opencode plugin dev`

**Status:**

| Step                     | Status  | Notes |
| ------------------------ | ------- | ----- |
| Delegate to @code-writer | pending |       |
| Build verification       | pending |       |
| Smoke test               | pending |       |
| Delegate to @code-review | pending |       |
| Fix review findings      | pending |       |
| Commit                   | pending | SHA:  |
| Plan updated             | pending |       |

---

### RCL-02: Types & Text Extraction

**Estimated effort:** 1 hour
**Dependencies:** RCL-01
**Files:** `src/types.ts`, `src/extract.ts`

**Delegation prompt for `@code-writer`:**

> In the opencode-recall plugin at
> `/Users/rmk/projects/oss/opencode-recall-plugin/`, create two files:
>
> **`src/types.ts`** — shared type definitions:
>
> The SDK client type is obtained from the plugin input. Define result
> types for the tools:
>
> ```typescript
> // The SDK types we'll reference
> // import type { createOpencodeClient } from "@opencode-ai/sdk"
> // type Client = ReturnType<typeof createOpencodeClient>
>
> export type SearchResult = {
>   sessionID: string
>   sessionTitle: string
>   directory: string
>   messageID: string
>   role: "user" | "assistant"
>   time: number
>   partID: string
>   partType: string
>   pruned: boolean
>   snippet: string
>   toolName?: string
> }
>
> export type SearchOutput = {
>   ok: true
>   results: SearchResult[]
>   scanned: number
>   total: number
>   truncated: boolean
> }
>
> export type MessageOutput = {
>   ok: true
>   message: {
>     id: string
>     role: string
>     time: number
>     agent?: string
>     model?: string
>   }
>   parts: PartOutput[]
>   context: {
>     sessionTitle?: string
>     directory?: string
>   }
> }
>
> export type PartOutput = {
>   id: string
>   type: string
>   pruned: boolean
>   content?: string
>   toolName?: string
>   title?: string
>   input?: unknown
>   output?: string
>   error?: string
> }
>
> export type SessionOutput = {
>   id: string
>   title: string
>   directory: string
>   project?: { name?: string; worktree: string }
>   time: { created: number; updated: number }
>   archived: boolean
> }
>
> export type ErrorOutput = {
>   ok: false
>   error: string
> }
> ```
>
> **`src/extract.ts`** — text extraction from parts:
>
> This is the centralized module for extracting searchable text from
> opencode message parts. The SDK returns parts as objects with a `type`
> discriminant.
>
> Part shapes (from `@opencode-ai/sdk`):
>
> - `{ type: "text", text: string }`
> - `{ type: "reasoning", text: string }`
> - `{ type: "tool", tool: string, state: ToolState }` where:
>   - ToolStateCompleted: `{ status: "completed", input, output: string, title, time: { compacted? } }`
>   - ToolStateError: `{ status: "error", input, error: string }`
>   - ToolStatePending: `{ status: "pending", input }`
>   - ToolStateRunning: `{ status: "running", input }`
> - `{ type: "compaction", auto: boolean }`
> - `{ type: "subtask", prompt, description }`
> - Other types: `file`, `snapshot`, `patch`, `step-start`, `step-finish`,
>   `agent`, `retry`
>
> Create these functions:
>
> `searchable(part)` — returns an array of strings to search against
> for a given part. For text: `[part.text]`. For tool (completed):
> `[part.state.output, JSON.stringify(part.state.input), part.state.title]`.
> For tool (error): `[part.state.error, JSON.stringify(part.state.input)]`.
> For reasoning: `[part.text]`. For subtask: `[part.description, part.prompt]`.
> For other types: `[]`.
>
> `snippet(text, query, width = 200)` — given a text string and a
> query, returns a snippet of up to `width` chars centered on the first
> match. If the match is near the start, show from start. If near end,
> show the end. Add "..." at truncation points. Case-insensitive
> matching.
>
> `pruned(part)` — returns boolean: true if the part is a tool part
> with `state.status === "completed"` and `state.time?.compacted` set.
> Only completed tool parts can be pruned — error/pending/running parts
> are never pruned.
>
> `format(part)` — returns a `PartOutput` object for the recall_get
> response. Extracts content based on part type. Truncates tool outputs
> at 10,000 chars using head+tail strategy (first 5K + last 2K with
> marker in middle).
>
> Use the SDK types via `import type { Part } from "@opencode-ai/sdk"`.
> If the SDK Part type doesn't expose the discriminated fields cleanly,
> use type assertions as needed — the runtime data will have these fields.
>
> Style: follow the opencode style guide (single-word names where
> possible, const over let, early returns, no destructuring).

**Review criteria for `@code-review`:**

> - All searchable text extraction is in extract.ts (DRY invariant 2)
> - Handles all part types without throwing on unknown types
> - Snippet function handles edge cases (query at start, end, no match)
> - Pruned detection is correct (checks `state.status === "completed"` AND `state.time?.compacted`)
> - Type assertions are minimal and justified

**Acceptance criteria:**

- `bun run typecheck` passes
- Extract functions handle all 12 part types
- Snippet function correctly centers on match

**Status:**

| Step                     | Status  | Notes |
| ------------------------ | ------- | ----- |
| Delegate to @code-writer | pending |       |
| Build verification       | pending |       |
| Smoke test               | pending |       |
| Delegate to @code-review | pending |       |
| Fix review findings      | pending |       |
| Commit                   | pending | SHA:  |
| Plan updated             | pending |       |

---

### Phase 2: Core Tools

**Goal:** All three tools implemented and working.

---

### RCL-03: recall_sessions Tool

**Estimated effort:** 45 minutes
**Dependencies:** RCL-02
**References:** SDK session listing APIs (see Design section above)
**Files:** `src/sessions.ts`, update `src/index.ts`

**Delegation prompt for `@code-writer`:**

> In the opencode-recall plugin at
> `/Users/rmk/projects/oss/opencode-recall-plugin/`, implement the
> `recall_sessions` tool.
>
> **`src/sessions.ts`** — the tool implementation:
>
> Import `tool` from `@opencode-ai/plugin`. The tool needs access to
> the SDK client, which is available from the plugin's closure (passed
> from `src/index.ts`).
>
> Export a function `sessions(client)` that takes the SDK client and
> returns a `ToolDefinition`.
>
> Tool definition:
>
> - Name: `recall_sessions` (the key in the tool map)
> - Description: (see Tool Design section in this document)
> - Args:
>   - `scope`: `z.enum(["project", "global"]).default("project")`
>     described as "project = current project, global = all projects"
>   - `search`: `z.string().optional()` described as "Filter by title"
>   - `limit`: `z.number().min(1).max(100).default(20)` described as
>     "Max sessions to return"
>
> The factory function takes `client` AND a `global` boolean (from
> plugin options) to gate global scope access.
>
> Execute function:
>
> 1. If scope is `"global"` and global is not enabled, return an error
>    envelope: `{ ok: false, error: "Global scope disabled. Enable via plugin option: global: true" }`
> 2. Based on scope:
>    - `"project"`: call `client.session.list({ search, limit })`
>    - `"global"`: call `client.experimental.session.list({ search, limit })`
> 3. Map results to `SessionOutput[]` from types.ts
>    - For global results, the response includes a `project` field
>    - For project results, `project` is not available (return undefined)
>    - `archived`: check `time.archived` is set (truthy)
> 4. Return `JSON.stringify({ ok: true, sessions, returned: sessions.length, scope })`
>
> SDK client method signatures:
>
> ```typescript
> client.session.list({ search?: string, limit?: number })
>   → Promise<Session[]>
>
> client.experimental.session.list({ search?: string, limit?: number })
>   → Promise<GlobalSession[]>  // has .project field
> ```
>
> **Update `src/index.ts`:**
> Import the sessions function and register the tool:
>
> ```typescript
> import { sessions } from "./sessions.js"
>
> const server: Plugin = async (ctx) => {
>   return {
>     tool: {
>       recall_sessions: sessions(ctx.client),
>     },
>   }
> }
> ```
>
> Style: single-word names, const, early returns, no destructuring.

**Review criteria for `@code-review`:**

> - SDK calls use correct parameters
> - Global vs project scope correctly dispatched
> - Response shape matches SessionOutput type
> - Limit respected

**Acceptance criteria:**

- `bun run typecheck` passes
- Tool appears when loaded via `opencode plugin dev`
- Returns session list for both scopes

**Status:**

| Step                     | Status  | Notes |
| ------------------------ | ------- | ----- |
| Delegate to @code-writer | pending |       |
| Build verification       | pending |       |
| Smoke test               | pending |       |
| Delegate to @code-review | pending |       |
| Fix review findings      | pending |       |
| Commit                   | pending | SHA:  |
| Plan updated             | pending |       |

---

### RCL-04: recall Search Tool

**Estimated effort:** 2 hours
**Dependencies:** RCL-02, RCL-03
**References:** SDK messages API, extract.ts, types.ts
**Files:** `src/search.ts`, update `src/index.ts`

**Delegation prompt for `@code-writer`:**

> In the opencode-recall plugin at
> `/Users/rmk/projects/oss/opencode-recall-plugin/`, implement the
> `recall` search tool. This is the primary tool — the most important
> one in the plugin.
>
> **`src/search.ts`** — the tool implementation:
>
> Export a function `search(client, global)` that takes the SDK
> client and a `global` boolean (from plugin options) and returns a
> `ToolDefinition`. The current session ID comes from `toolCtx.sessionID`
> at call time.
>
> Tool definition:
>
> - Name: `recall` (the key in the tool map)
> - Description: (see Tool Design section — this is the full-text
>   search tool for conversation history)
> - Args:
>   - `query`: `z.string().min(1)` — required, the search text
>   - `scope`: `z.enum(["session", "project", "global"]).default("session")`
>   - `sessionID`: `z.string().optional()` — search a specific session
>     (overrides scope)
>   - `type`: `z.enum(["text", "tool", "reasoning", "all"]).default("all")`
>   - `role`: `z.enum(["user", "assistant", "all"]).default("all")`
>   - `sessions`: `z.number().min(1).max(50).default(10)` — max sessions
>     to scan (ignored for session/sessionID scope)
>   - `results`: `z.number().min(1).max(50).default(10)` — max results
>   - `title`: `z.string().optional()` — filter sessions by title
>
> Execute function — this is the core search algorithm:
>
> ```
> 1. Gate global scope: if scope is "global" and global is not enabled,
>    return error envelope.
>
> 2. Build session list:
>    - If sessionID param is set: [{ id: sessionID }]
>    - scope "session": [{ id: ctx.sessionID }]
>    - scope "project": client.session.list({ search: title, limit: sessions })
>    - scope "global": client.experimental.session.list({ search: title, limit: sessions })
>
> 3. Process sessions with bounded concurrency (3 at a time):
>    Create batches of 3 sessions. For each batch, use Promise.all to
>    load messages in parallel. Between batches, check ctx.abort.
>
>    For each session's messages:
>    a. For each message:
>       - Skip if role filter set and info.role doesn't match
>       - For each part:
>         - Skip if type filter set and part.type doesn't match
>         - Get searchable strings from extract.searchable(part)
>         - For each string, case-insensitive indexOf against query
>         - On first match for this part (dedup — one result per part):
>           - Create SearchResult with snippet from extract.snippet()
>           - Set pruned from extract.pruned(part)
>           - Add to results
>    b. If results.length >= args.results, stop all iteration
>    c. Track total match count across all scanned sessions
>
> 4. Return JSON.stringify({ ok: true, results, scanned, total, truncated })
>    On error, return JSON.stringify({ ok: false, error: message })
> ```
>
> **Session info for results**: When scope is "session" or sessionID
> is set, load session metadata via `client.session.get()`. For
> project/global scope, session list already has title/directory.
> If session.get() fails (cross-project), use empty strings for
> title/directory.
>
> **Abort handling**: Check `ctx.abort.aborted` between session
> batches. If aborted, return whatever results have been collected
> so far with `truncated: true`.
>
> **Error handling**: Wrap each session's message load in try/catch.
> If a session fails to load, skip it and continue to the next.
> Log the error but don't crash the entire search.
>
> SDK types reference:
>
> ```typescript
> // Message response from client.session.messages()
> type MessageWithParts = {
>   info: UserMessage | AssistantMessage
>   parts: Part[]
> }
> // info.id = message ID
> // info.role = "user" | "assistant"
> // info.time.created = timestamp (number, ms)
> // Each part has: id, sessionID, messageID, type, + type-specific fields
> ```
>
> Import `searchable`, `snippet`, `pruned` from `./extract.js`.
> Import types from `./types.js`.
>
> **Update `src/index.ts`:**
> The search tool needs `toolCtx.sessionID` at call time, not at
> registration time. The factory captures client and global flag;
> execute reads sessionID from toolCtx:
>
> ```typescript
> // In search.ts:
> export function search(client, global) {
>   return tool({
>     description: "...",
>     args: { ... },
>     async execute(args, ctx) {
>       // ctx.sessionID is the current session
>       // ctx.abort is the AbortSignal
>     }
>   })
> }
> ```
>
> Register as: `recall: search(ctx.client, opts.global === true)`
>
> Style: single-word names, const, early returns, no destructuring.
> Keep the search loop as flat as possible — avoid deep nesting.
> Extract a helper function if the loop body gets complex.

**Review criteria for `@code-review`:**

> - Search is case-insensitive
> - All part types handled via extract.searchable()
> - Early termination when results limit reached
> - At most one result per part (dedup across multiple matched fields)
> - Results include correct pruned status
> - No data leaked between sessions (results properly attributed)
> - Role filter correctly applied at message level
> - Bounded concurrency (3 sessions at a time, not unlimited)
> - ctx.abort checked between batches
> - Global scope gated by the `global` flag
> - Error handling: graceful if a session fails to load (skip, don't crash)
> - JSON error envelope on failure, not thrown exceptions

**Acceptance criteria:**

- `bun run typecheck` passes
- Can find text in current session
- Can find text across project sessions
- Returns correct snippets with match context
- Respects results limit

**Status:**

| Step                     | Status  | Notes |
| ------------------------ | ------- | ----- |
| Delegate to @code-writer | pending |       |
| Build verification       | pending |       |
| Smoke test               | pending |       |
| Delegate to @code-review | pending |       |
| Fix review findings      | pending |       |
| Commit                   | pending | SHA:  |
| Plan updated             | pending |       |

---

### RCL-05: recall_get Tool

**Estimated effort:** 45 minutes
**Dependencies:** RCL-02
**Files:** `src/get.ts`, update `src/index.ts`

**Delegation prompt for `@code-writer`:**

> In the opencode-recall plugin at
> `/Users/rmk/projects/oss/opencode-recall-plugin/`, implement the
> `recall_get` tool.
>
> **`src/get.ts`** — the tool implementation:
>
> Export a function `get(client)` that takes the SDK client and returns
> a `ToolDefinition`.
>
> Tool definition:
>
> - Name: `recall_get` (the key in the tool map)
> - Description: (see Tool Design section — retrieves full message content)
> - Args:
>   - `sessionID`: `z.string()` — required
>   - `messageID`: `z.string()` — required
>
> Execute function:
>
> 1. Call `client.session.message({ sessionID, messageID })` to get
>    the message and all its parts
> 2. Call `client.session.get({ sessionID })` to get session context
>    (title, directory)
> 3. Format the message info:
>    - `id`, `role`, `time` (from info.time.created)
>    - `agent` (from info.agent)
>    - `model` (from info.modelID if assistant, or info.model.modelID if user)
> 4. Format each part using `extract.format(part)` from extract.ts
> 5. Return `JSON.stringify(MessageOutput)` from types.ts
>
> Error handling: Wrap the SDK calls in try/catch. On failure, return
> a JSON error envelope `{ ok: false, error: "..." }` — not a throw.
> The LLM should see a structured error, not a tool execution failure.
> For session context (`client.session.get()`), gracefully degrade if
> the call fails (cross-project sessions may not be accessible) — return
> the message data with empty context rather than failing entirely.
>
> **Update `src/index.ts`:**
>
> ```typescript
> import { get } from "./get.js"
> // ...
> tool: {
>   recall_sessions: sessions(ctx.client),
>   recall: search(ctx.client),
>   recall_get: get(ctx.client),
> }
> ```
>
> Style: single-word names, const, early returns.

**Review criteria for `@code-review`:**

> - Correct SDK method calls
> - All part types handled via extract.format()
> - Tool output truncation at 10,000 chars with note
> - Error handling for not-found messages
> - Response includes session context (title, directory)

**Acceptance criteria:**

- `bun run typecheck` passes
- Can retrieve any message by ID
- Compacted tool outputs show original content
- Large tool outputs truncated with note

**Status:**

| Step                     | Status  | Notes |
| ------------------------ | ------- | ----- |
| Delegate to @code-writer | pending |       |
| Build verification       | pending |       |
| Smoke test               | pending |       |
| Delegate to @code-review | pending |       |
| Fix review findings      | pending |       |
| Commit                   | pending | SHA:  |
| Plan updated             | pending |       |

---

### Phase 3: Integration & Polish

**Goal:** Plugin is fully integrated, documented, and tested end-to-end.

---

### RCL-06: Config Hook & Primary Tools

**Estimated effort:** 30 minutes
**Dependencies:** RCL-03, RCL-04, RCL-05
**Files:** update `src/index.ts`

**Delegation prompt for `@code-writer`:**

> In the opencode-recall plugin at
> `/Users/rmk/projects/oss/opencode-recall-plugin/`, add a `config` hook
> that registers the recall tools as primary tools so they're available
> to all agents.
>
> **Update `src/index.ts`:**
>
> Add a `config` hook to the plugin return value:
>
> ```typescript
> config: async (cfg) => {
>   const existing = cfg.experimental?.primary_tools ?? []
>   cfg.experimental = {
>     ...cfg.experimental,
>     primary_tools: [...existing, "recall", "recall_get", "recall_sessions"],
>   }
> }
> ```
>
> This ensures the recall tools are available to all agents without
> requiring per-agent tool configuration.
>
> Also add plugin options support for customization:
>
> ```typescript
> type Options = {
>   primary?: boolean  // default true — register as primary tools
>   global?: boolean   // default false — enable cross-project search
> }
>
> const server: Plugin = async (ctx, options) => {
>   const opts = (options ?? {}) as Options
>   const primary = opts.primary !== false
>   const global = opts.global === true
>
>   return {
>     tool: {
>       recall_sessions: sessions(ctx.client, global),
>       recall: search(ctx.client, global),
>       recall_get: get(ctx.client),
>     },
>     ...(primary && {
>       config: async (cfg) => { ... }
>     }),
>   }
> }
> ```

**Review criteria for `@code-review`:**

> - Config hook correctly adds to primary_tools without overwriting
> - Options type is clean
> - Default behavior is primary=true, global=false
> - Global flag correctly threaded through to sessions and search tools

**Acceptance criteria:**

- Plugin tools appear for all agents when loaded
- Setting `primary: false` in config tuple disables primary registration
- Global scope returns error unless `global: true` in options

**Status:**

| Step                     | Status  | Notes |
| ------------------------ | ------- | ----- |
| Delegate to @code-writer | pending |       |
| Build verification       | pending |       |
| Smoke test               | pending |       |
| Delegate to @code-review | pending |       |
| Fix review findings      | pending |       |
| Commit                   | pending | SHA:  |
| Plan updated             | pending |       |

---

### RCL-07: README

**Estimated effort:** 30 minutes
**Dependencies:** RCL-06
**Files:** `README.md`

**Delegation prompt for `@docs-writer`:**

> Write a README.md for the opencode-recall plugin at
> `/Users/rmk/projects/oss/opencode-recall-plugin/`.
>
> The plugin provides 3 tools that let opencode agents search and
> retrieve conversation history from the database, recovering context
> lost to compaction.
>
> Include:
>
> 1. What the plugin does and why it's useful
> 2. Installation (`opencode.jsonc` config)
> 3. Configuration options (`primary` option)
> 4. Tool reference for all 3 tools with parameters and examples
> 5. Use cases with example tool call sequences
>
> Keep it practical and concise. The audience is opencode users who
> want to enhance their agent's memory.

**Status:**

| Step                     | Status  | Notes |
| ------------------------ | ------- | ----- |
| Delegate to @docs-writer | pending |       |
| Delegate to @code-review | pending |       |
| Commit                   | pending | SHA:  |
| Plan updated             | pending |       |

---

### RCL-08: End-to-End Verification

**Estimated effort:** 30 minutes
**Dependencies:** RCL-07
**Files:** None (verification only)

**Manual steps:**

1. Configure plugin in opencode: add to `opencode.jsonc`
2. Start opencode with the plugin loaded
3. Verify all 3 tools appear in the tool list
4. In a session with history, test each tool:
   - `recall_sessions` — returns sessions
   - `recall` with scope "session" — finds content
   - `recall_get` — retrieves full message
5. Create a compaction (or use a session that has one), verify:
   - `recall` finds content before the compaction boundary
   - `recall_get` returns original tool outputs for compacted parts

**Acceptance criteria:**

- All 3 tools work end-to-end
- Compacted content is recoverable
- Cross-project search works
- DRY verification checklist passes

**Status:**

| Step                   | Status  | Notes |
| ---------------------- | ------- | ----- |
| Configure plugin       | pending |       |
| Verify tool list       | pending |       |
| Test recall_sessions   | pending |       |
| Test recall search     | pending |       |
| Test recall_get        | pending |       |
| Test compacted content | pending |       |
| DRY checklist          | pending |       |
| Plan updated           | pending |       |

---

## Commit Protocol

**Format:** Conventional Commits

| Task   | Commit Message                                    |
| ------ | ------------------------------------------------- |
| RCL-01 | `feat(recall): scaffold plugin package`           |
| RCL-02 | `feat(recall): add types and text extraction`     |
| RCL-03 | `feat(recall): implement recall_sessions tool`    |
| RCL-04 | `feat(recall): implement recall search tool`      |
| RCL-05 | `feat(recall): implement recall_get tool`         |
| RCL-06 | `feat(recall): add config hook for primary tools` |
| RCL-07 | `docs(recall): add README`                        |
| RCL-08 | `chore(recall): end-to-end verification`          |

---

## File Impact Summary

| File              | Task(s)                | Purpose                         |
| ----------------- | ---------------------- | ------------------------------- |
| `package.json`    | RCL-01                 | Package config, deps, scripts   |
| `tsconfig.json`   | RCL-01                 | TypeScript config               |
| `src/index.ts`    | RCL-01, 03, 04, 05, 06 | Plugin entry, tool registration |
| `src/types.ts`    | RCL-02                 | Shared type definitions         |
| `src/extract.ts`  | RCL-02                 | Text extraction from parts      |
| `src/sessions.ts` | RCL-03                 | recall_sessions tool            |
| `src/search.ts`   | RCL-04                 | recall search tool              |
| `src/get.ts`      | RCL-05                 | recall_get tool                 |
| `README.md`       | RCL-07                 | User documentation              |

---

## Risk Register

| Risk                                       | Likelihood | Impact | Mitigation                                                                           |
| ------------------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------------ |
| Large sessions slow down search            | Medium     | Medium | Early termination on results limit, newest-first ordering, bounded concurrency       |
| SDK types don't match runtime data         | Low        | Medium | Type assertions where needed, runtime checks                                         |
| Tool output floods agent context           | Medium     | High   | 10K char truncation in recall_get, snippet-only in recall                            |
| SDK API changes break plugin               | Low        | High   | Pin SDK version in devDependencies, use stable endpoints                             |
| Search misses due to substring limitations | Medium     | Low    | Document limitation, suggest future regex/fuzzy support                              |
| Cross-project data exposure                | Medium     | High   | Global scope disabled by default, requires explicit `global: true` in plugin options |
| Cross-project session.get() fails          | Medium     | Low    | Graceful degradation — return data without session context                           |
| Long-running global scan blocks agent      | Low        | Medium | Check ctx.abort between session batches, return partial results                      |
| Duplicate results for same part            | Medium     | Low    | Dedup to one result per part, best snippet wins                                      |

---

## Rollback Plan

| Task          | Rollback strategy                            |
| ------------- | -------------------------------------------- |
| RCL-01        | Delete the project directory                 |
| RCL-02-08     | `git revert` — each commit is self-contained |
| Full rollback | Remove plugin from `opencode.jsonc` config   |

---

## Out of Scope

| Item                                | Rationale                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| MCP server interface                | Not useful — only opencode agents use opencode data                           |
| Regex/fuzzy search                  | Substring match is sufficient for v1. Can add later.                          |
| Server-side search API              | Would require opencode core changes. Client-side is fine for now.             |
| Full-text index                     | Overkill for the expected data sizes. SQLite FTS would require DB access.     |
| Part-level pagination in recall_get | v1 returns full message. Can add part pagination if messages get enormous.    |
| Caching                             | Sessions don't change retroactively. Could cache, but premature optimization. |
| Writing/modifying sessions          | Read-only plugin. No mutation of history.                                     |

---

## Future Considerations (post-v1)

- **Semantic search**: Use embeddings to find conceptually similar content,
  not just substring matches. Would require an embedding model.
- **Regex support**: Add regex option to `recall` for pattern matching.
- **Time-range filtering**: Add `before`/`after` timestamp params to `recall`.
- **Part-type statistics**: Add a tool to summarize what's in a session
  (how many messages, how many tool calls, total tokens, etc.) without
  loading full content.
- **Auto-recall on compaction**: Hook into `experimental.session.compacting`
  to automatically include relevant recalled context in the compaction summary.
- **Cross-session context injection**: Use `experimental.chat.messages.transform`
  to inject recalled context directly into the message history.

---

## Post-Completion Checklist

- [ ] `bun run typecheck` passes
- [ ] All 3 tools work end-to-end in opencode
- [ ] DRY verification checklist passes
- [ ] No TODO/FIXME comments in source
- [ ] `@code-review` returns zero blockers on final codebase
- [ ] All status tables in this plan are marked done with commit SHAs
- [ ] README is current and accurate
