# opencode-recall v2 — Navigation & Browsing Improvements

**Version:** 0.2
**Date:** 2026-04-13
**Status:** Planning
**Branch:** `main`
**Source:** Real-world usage analysis of v1 tools against the ubiopti project
**Estimated total effort:** 2-3 hours
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
2. BUILD     ->  Verify: bun run typecheck passes with zero errors
3. TEST      ->  Smoke test the relevant functionality
4. REVIEW    ->  @code-review (with review criteria from the task definition)
5. FIX       ->  @code-writer (with specific review findings)
6. RE-REVIEW ->  (if fixes were substantial: >3 files or logic changes)
7. COMMIT    ->  Only after zero blockers from review
8. UPDATE    ->  Mark status table done, record commit SHA
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

| Document          | Purpose                                                     |
| ----------------- | ----------------------------------------------------------- |
| This document     | v2 design and implementation reference                      |
| `PLAN.md`         | v1 plan (completed) — context for existing design decisions |
| `src/index.ts`    | Plugin entry, tool registration, client setup               |
| `src/types.ts`    | Shared result types, `errmsg()` helper                      |
| `src/extract.ts`  | Text extraction, snippet, pruned detection, part formatting |
| `src/search.ts`   | `recall` search tool (will be modified)                     |
| `src/sessions.ts` | `recall_sessions` tool (unchanged)                          |
| `src/get.ts`      | `recall_get` tool (unchanged)                               |

### Validation Commands

```bash
# Typecheck (must pass before every commit)
bun run typecheck

# Smoke test — load plugin in opencode
# Requires restart of opencode after each change
bun -e "const m = await import('./src/index.ts'); console.log('id:', m.default.id)"
```

---

## Plan Maintenance Protocol

This document is a living artifact. Keep it accurate:

1. **Status tables** — update **immediately** after completing each step
2. **Notes column** — record commit SHA, review outcomes, design deviations
3. **Decision log** — record decisions BEFORE implementing
4. **Plan version** — bump when making structural changes

---

## Background: Why v2

Testing the v1 plugin against real sessions (researching UniFi network
issues across the `ubiopti` project, ~200 messages over 3 weeks)
revealed concrete workflow gaps. The agent made ~15 tool calls to piece
together the story, and these patterns emerged:

### What worked

- **Discover → search → retrieve** (3-tool workflow) is natural
- **Role filtering** (`role: "user"`) for finding the human's perspective
- **Type filtering** (`type: "tool"`) for finding technical evidence
- **Cross-project search** via global scope + sessionID targeting

### What was painful

1. **No time filtering** — searching "error" across a 3-week session
   returns ancient results mixed with recent ones
2. **No context expansion** — after finding a match, no way to see
   surrounding messages without guessing message IDs
3. **No conversation browsing** — can't "read the last 5 messages" or
   "show me the start of this session" without a search query
4. **Fixed snippet width** — 200 chars often insufficient to determine
   relevance, leading to excessive `recall_get` calls

### Specific examples from the testing session

- Wanted "last 5 user messages in the ubiopti session" — had to search
  for "network" with `role: "user"` and hope for chronological results
- Found a tool output about AP kickout events — needed the user message
  that triggered it and the assistant's analysis after it
- Wanted to browse the most recent interaction (live chat with Ubiquiti
  support) — had to search for specific text from that conversation

---

## Problem Statement

The v1 tools support content discovery (search) and content retrieval
(get), but lack **temporal navigation** (filter by time), **contextual
browsing** (messages around a match), and **sequential access** (walk
through a conversation). These are essential for reconstructing
narratives from conversation history.

---

## Design

### New capabilities

| Capability            | Tool                    | Params                       |
| --------------------- | ----------------------- | ---------------------------- |
| Time filtering        | `recall` (enhanced)     | `before`, `after`            |
| Wider snippets        | `recall` (enhanced)     | `width`                      |
| Context expansion     | `recall_context` (new)  | `messageID`, `window`        |
| Conversation browsing | `recall_messages` (new) | `offset`, `limit`, `reverse` |

### Tool inventory after v2

| Tool              | Purpose                    | When to use                                               |
| ----------------- | -------------------------- | --------------------------------------------------------- |
| `recall_sessions` | Discover sessions          | First step — find which session                           |
| `recall`          | Content search             | Find specific content by keyword, optionally time-bounded |
| `recall_get`      | Full message retrieval     | Get one message with all parts                            |
| `recall_context`  | **NEW** — Context window   | Get messages around a match                               |
| `recall_messages` | **NEW** — Paginated browse | Walk through conversation chronologically                 |

### Agent workflow patterns enabled by v2

**Pattern 1 — Temporal search:**

```
recall({ query: "error", after: <2 days ago>, scope: "session" })
```

**Pattern 2 — Context expansion:**

```
recall({ query: "kickout" }) → finds match at msg_X
recall_context({ sessionID, messageID: "msg_X", window: 3 })
→ See question, answer, and follow-up around the match
```

**Pattern 3 — Conversation playback:**

```
recall_messages({ sessionID, limit: 5, role: "user", reverse: true })
→ Last 5 user messages (most recent first)
recall_messages({ sessionID, offset: 0, limit: 10 })
→ Read the beginning of the session
```

**Pattern 4 — Progressive exploration:**

```
recall_sessions({ scope: "global", search: "auth" })
recall_messages({ sessionID, limit: 5, reverse: true })
→ See where it left off
recall({ query: "JWT", sessionID })
recall_context({ sessionID, messageID, window: 5 })
→ Full implementation flow
```

---

## Decision Log

| #   | Topic                                           | Decision                                                                  | Rationale                                                                                                                                                                              |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Time param format                               | Millisecond epoch (number), matching opencode's internal timestamp format | Consistent with `time` fields in search results, avoids parsing                                                                                                                        |
| 2   | `recall_context` vs expanding `recall_get`      | New tool                                                                  | Different use case — `recall_get` is "get one message fully", `recall_context` is "get a conversation window". Separate tools keep descriptions focused for the LLM.                   |
| 3   | `recall_messages` offset vs cursor              | Offset-based                                                              | Message arrays are already fully loaded; cursor would add complexity without benefit. Offset is intuitive for agents ("skip 10, give me 10").                                          |
| 4   | `recall_messages` reverse semantics             | Reverses BEFORE slicing                                                   | `reverse: true` with `offset: 0, limit: 5` = "last 5 messages". Intuitive.                                                                                                             |
| 5   | Load strategy for context/messages              | Load all messages, slice in memory                                        | Same approach as `recall`. SDK has no server-side slice-by-index. Single session load is fast.                                                                                         |
| 6   | Role filter on `recall_messages`                | Applied before offset/limit                                               | `offset: 5, limit: 5, role: "user"` = "skip 5 user messages, return next 5 user messages". The pagination is over the filtered set, not the raw message list.                          |
| 7   | `recall_context` window param                   | Single `window` param (symmetric) instead of separate before/after        | Avoids naming ambiguity with `recall`'s `before`/`after` (timestamps). Symmetric windows cover 90% of use cases; asymmetric can be achieved by adjusting `window` and ignoring excess. |
| 8   | Shared `formatMsg()` in extract.ts              | Both `recall_context` and `recall_messages` use it                        | DRY — eliminates duplicated message→MessageItem formatting across 3+ tools. Also used to refactor `recall_get`.                                                                        |
| 9   | `errmsg()` SDK error extraction                 | Check for `data.message` before JSON.stringify                            | SDK errors are plain objects with `{ name, data: { message } }`. Extracting the message gives cleaner output.                                                                          |
| 10  | Unscoped client preserves non-directory headers | Strip only `x-opencode-directory`, keep everything else                   | Prevents breaking auth/session headers in protected setups.                                                                                                                            |
| 11  | Runtime guard on v1→v2 bridge                   | Throw clear error if `_client.getConfig` is missing                       | Turns silent runtime failure into actionable diagnostic if SDK internals change.                                                                                                       |
| 12  | `recall_context` boundary indicators            | `hasMoreBefore`/`hasMoreAfter` booleans                                   | Agent needs to know if the window hit the session boundary or if there's more conversation to explore.                                                                                 |

---

## DRY Invariants

| #   | Invariant                                                        | Canonical location          | Grep check                                                                         |
| --- | ---------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------- |
| 1   | All SDK calls go through `client` or `unscoped` from PluginInput | `src/index.ts`              | `grep -rn 'createOpencodeClient' src/ \| grep -v index`                            |
| 2   | All text extraction logic                                        | `src/extract.ts`            | `grep -rn '\.state\.output\|\.state\.input\|part\.text' src/ \| grep -v extract`   |
| 3   | All part formatting                                              | `src/extract.ts` `format()` | `grep -rn 'PartOutput' src/ \| grep -v types \| grep -v extract \| grep -v import` |
| 4   | Error serialization via `errmsg()`                               | `src/types.ts`              | `grep -rn 'instanceof Error' src/ \| grep -v types`                                |
| 5   | No TODO/FIXME in committed code                                  | Everywhere                  | `grep -rn 'TODO\|FIXME\|HACK\|XXX' src/`                                           |

---

## DRY Verification Checklist

```bash
# Invariant 1: No extra SDK client creation
grep -rn 'createOpencodeClient' src/ | grep -v index

# Invariant 2: Text extraction centralized
grep -rn '\.state\.output\|\.state\.input\|part\.text' src/ | grep -v extract

# Invariant 3: Part formatting centralized
grep -rn 'PartOutput' src/ | grep -v types | grep -v extract | grep -v import

# Invariant 4: Error serialization via errmsg()
grep -rn 'instanceof Error' src/ | grep -v types

# Invariant 5: No TODO/FIXME
grep -rn 'TODO\|FIXME\|HACK\|XXX' src/
```

---

## Execution Sequence

```
Phase 1: Enhance existing + shared types
  RCL2-01 (types + recall params)   -> build -> review -> commit

Phase 2: New tools
  RCL2-02 (recall_context)          -> build -> smoke test -> review -> commit
  RCL2-03 (recall_messages)         -> build -> smoke test -> review -> commit

Phase 3: Integration
  RCL2-04 (index + README + verify) -> build -> smoke test -> review -> commit
```

---

## Phases

### Phase 1: Enhance Existing

**Goal:** `recall` supports time filtering and configurable snippet width.
New shared types are defined for the new tools.

---

### RCL2-01: Types + recall Time/Width Params

**Estimated effort:** 30 minutes
**Dependencies:** None
**Files:** `src/types.ts`, `src/search.ts`, `src/extract.ts`

**Delegation prompt for `@code-writer`:**

> In the opencode-recall plugin at
> `/Users/rmk/projects/oss/opencode-recall-plugin/`, make these changes:
>
> **`src/types.ts`** — add new output types:
>
> ```typescript
> export type MessageItem = {
>   message: {
>     id: string;
>     role: "user" | "assistant";
>     time: number;
>     agent?: string;
>     model?: string;
>   };
>   parts: PartOutput[];
>   center?: boolean; // only used by recall_context
> };
>
> export type ContextOutput = {
>   ok: true;
>   messages: MessageItem[];
>   context: {
>     sessionTitle?: string;
>     directory?: string;
>   };
>   hasMoreBefore: boolean;
>   hasMoreAfter: boolean;
> };
>
> export type MessagesOutput = {
>   ok: true;
>   messages: MessageItem[];
>   context: {
>     sessionTitle?: string;
>     directory?: string;
>   };
>   pagination: {
>     offset: number;
>     returned: number;
>     total: number;
>     hasMore: boolean;
>   };
> };
> ```
>
> **`src/extract.ts`** — add a shared `formatMsg()` function for
> converting SDK messages to `MessageItem`:
>
> ```typescript
> import type {
>   Message,
>   AssistantMessage,
>   UserMessage,
> } from "@opencode-ai/sdk/v2";
> import type { MessageItem } from "./types.js";
>
> export function formatMsg(msg: {
>   info: Message;
>   parts: Array<Part>;
> }): MessageItem {
>   const info = msg.info;
>   let model: string | undefined;
>   if (info.role === "assistant") model = (info as AssistantMessage).modelID;
>   else model = (info as UserMessage).model.modelID;
>
>   return {
>     message: {
>       id: info.id,
>       role: info.role,
>       time: info.time.created,
>       agent: info.agent,
>       model,
>     },
>     parts: msg.parts.map(format),
>   };
> }
> ```
>
> This eliminates the duplicated message formatting in `get.ts`,
> `context.ts`, and `messages.ts`. Update `get.ts` to use it too.
>
> Also extract the repeated input serialization into a helper:
>
> ```typescript
> function input(val: unknown): string {
>   const raw = JSON.stringify(val);
>   return raw.length > INPUT_SEARCH_LIMIT
>     ? raw.slice(0, INPUT_SEARCH_LIMIT)
>     : raw;
> }
> ```
>
> Replace the 3 inline `JSON.stringify(state.input)` + truncation
> blocks with calls to `input(state.input)`.
>
> **`src/types.ts`** — improve `errmsg()` to extract SDK error messages:
>
> ```typescript
> export function errmsg(e: unknown): string {
>   if (e instanceof Error) return e.message;
>   if (typeof e === "string") return e;
>   if (e && typeof e === "object" && "data" in e) {
>     const data = (e as any).data;
>     if (data?.message) return data.message;
>   }
>   try {
>     return JSON.stringify(e);
>   } catch {
>     return String(e);
>   }
> }
> ```
>
> **`src/index.ts`** — add runtime guard on the v1→v2 client bridge
> and preserve headers on the unscoped client:
>
> ```typescript
> const inner = (ctx.client as any)._client;
> if (!inner?.getConfig)
>   throw new Error(
>     "opencode-recall: SDK internals changed — cannot extract fetch transport",
>   );
> const cfg = inner.getConfig();
> if (!cfg.fetch)
>   throw new Error("opencode-recall: SDK client has no custom fetch");
>
> // Strip only the directory header for the unscoped client
> const { "x-opencode-directory": _, ...rest } = (cfg.headers ?? {}) as Record<
>   string,
>   string
> >;
>
> const client = createOpencodeClient({
>   baseUrl: cfg.baseUrl,
>   fetch: cfg.fetch,
>   headers: cfg.headers,
>   directory: ctx.directory,
> });
>
> const unscoped = createOpencodeClient({
>   baseUrl: cfg.baseUrl,
>   fetch: cfg.fetch,
>   headers: rest,
> });
> ```
>
> **`src/search.ts`** — change `parts: Array<any>` to
> `parts: Array<Part>` in the `scan()` signature. Import `Part` from
> `@opencode-ai/sdk/v2`.
>
> Snippet width already parameterized — no extract.ts change needed
> for that.
>
> **`src/search.ts`** — add three new params to the `recall` tool:
>
> New args (add after existing `title` arg):
>
> ```typescript
> before: tool.schema.number().optional()
>   .describe("Only match messages before this timestamp (ms epoch)"),
> after: tool.schema.number().optional()
>   .describe("Only match messages after this timestamp (ms epoch)"),
> width: tool.schema.number().min(50).max(1000).default(200)
>   .describe("Snippet width in characters"),
> ```
>
> In the `scan()` function, add a timestamp filter. The current
> signature is:
>
> ```typescript
> function scan(messages, session, query, type, role, limit);
> ```
>
> Add `before`, `after`, and `width` parameters:
>
> ```typescript
> function scan(
>   messages,
>   session,
>   query,
>   type,
>   role,
>   limit,
>   before?,
>   after?,
>   width?,
> );
> ```
>
> At the start of the message loop, before checking role:
>
> ```typescript
> const ts = msg.info.time.created;
> if (before && ts >= before) continue;
> if (after && ts <= after) continue;
> ```
>
> Pass `width` to `snippet()`:
>
> ```typescript
> snippet: snippet(text, query, width),
> ```
>
> In the `execute()` function, pass the new params through to `scan()`:
>
> ```typescript
> const result = scan(
>   messages,
>   sess,
>   args.query,
>   args.type,
>   args.role,
>   remaining,
>   args.before,
>   args.after,
>   args.width,
> );
> ```
>
> Update the description to mention time filtering.
>
> Style: follow opencode style guide — single-word names, const, early
> returns. Keep scan() flat.

**Review criteria for `@code-review`:**

> - Time filter uses strict inequality (before = exclusive, after = exclusive)
> - Width param plumbed through to snippet() correctly
> - New types follow existing patterns (ok envelope, PartOutput reuse)
> - MessageItem.center is optional (only recall_context uses it)
> - No breaking changes to existing recall behavior (all new params optional with defaults)
> - `formatMsg()` in extract.ts handles both UserMessage and AssistantMessage model extraction
> - `errmsg()` extracts SDK `data.message` before falling back to JSON.stringify
> - Runtime guard on `_client.getConfig()` bridge throws clear error
> - Unscoped client preserves all headers except `x-opencode-directory`
> - `scan()` uses `Array<Part>` not `Array<any>`
> - Input serialization helper eliminates duplication in `searchable()`

**Acceptance criteria:**

- `bun run typecheck` passes
- `recall` without new params behaves identically to v1
- `recall` with `before`/`after` filters results by timestamp
- `recall` with `width: 500` returns wider snippets
- `errmsg()` on SDK error objects returns clean message string
- Runtime guard throws on missing `_client.getConfig`
- No `Array<any>` in search.ts
- `formatMsg()` exists in extract.ts and is importable

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

### Phase 2: New Tools

**Goal:** `recall_context` and `recall_messages` implemented and working.

---

### RCL2-02: recall_context Tool

**Estimated effort:** 30 minutes
**Dependencies:** RCL2-01 (for MessageItem type)
**Files:** `src/context.ts`

**Delegation prompt for `@code-writer`:**

> In the opencode-recall plugin at
> `/Users/rmk/projects/oss/opencode-recall-plugin/`, create a new tool.
>
> **`src/context.ts`** — the `recall_context` tool:
>
> Import dependencies:
>
> ```typescript
> import {
>   tool,
>   type ToolDefinition,
>   type ToolContext,
> } from "@opencode-ai/plugin";
> import type {
>   OpencodeClient,
>   AssistantMessage,
>   UserMessage,
> } from "@opencode-ai/sdk/v2";
> import {
>   errmsg,
>   type ContextOutput,
>   type MessageItem,
>   type ErrorOutput,
> } from "./types.js";
> import { format } from "./extract.js";
> ```
>
> Export a function `context(client)` that takes the OpencodeClient and
> returns a ToolDefinition.
>
> Tool definition:
>
> - Description: `"Get messages surrounding a specific message in a
session. Use after recall finds a match and you need conversation
context — what was asked before, what came after. Returns a window
of messages centered on the target."`
> - Args:
>   - `sessionID`: `tool.schema.string()` — required
>   - `messageID`: `tool.schema.string()` — required, the center message
>   - `window`: `tool.schema.number().min(0).max(10).default(3)` — number
>     of messages to include before AND after the target
>
> Execute function:
>
> 1. Set metadata title: `"Getting context around message..."`
> 2. Load all messages: `client.session.messages({ sessionID })`
> 3. Check `resp.error` — if set, return error envelope via `errmsg()`
> 4. If `!resp.data`, return error envelope
> 5. Find the target message index by matching `msg.info.id === messageID`
> 6. If not found, return error envelope: `"Message not found: {id}"`
> 7. Calculate window: `start = max(0, idx - window)`,
>    `end = min(messages.length, idx + window + 1)`
> 8. Slice the messages array
> 9. Format each message using `formatMsg()` from `extract.ts` (see
>    RCL2-01). Set `center: msg.info.id === messageID` on each item.
> 10. Get session context (try/catch, graceful degradation):
>     `client.session.get({ sessionID })` for title/directory
> 11. Build boundary indicators:
>     `hasMoreBefore = start > 0`
>     `hasMoreAfter = end < messages.length`
> 12. Update metadata: `"Context: {window} messages around target
from '{title}'"`
> 13. Return `JSON.stringify(ContextOutput)`
>
> Error handling: try/catch wrapper, return `{ ok: false, error }`
> via `errmsg()`.
>
> Style: single-word names, const, early returns.

**Review criteria for `@code-review`:**

> - Window calculation handles edge cases (target at start, target at end)
> - `center: true` only set on the exact target message
> - Message formatting via `formatMsg()` from extract.ts (DRY invariant 3)
> - Error handling via errmsg() (DRY invariant 4)
> - `resp.error` checked before using `resp.data`
> - Session context gracefully degrades
> - `hasMoreBefore`/`hasMoreAfter` correct at boundaries
> - No off-by-one in slice boundaries

**Acceptance criteria:**

- `bun run typecheck` passes
- Returns correct window around a message
- Target at first message returns no before, full after
- Target at last message returns full before, no after

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

### RCL2-03: recall_messages Tool

**Estimated effort:** 30 minutes
**Dependencies:** RCL2-01 (for MessageItem type)
**Files:** `src/messages.ts`

**Delegation prompt for `@code-writer`:**

> In the opencode-recall plugin at
> `/Users/rmk/projects/oss/opencode-recall-plugin/`, create a new tool.
>
> **`src/messages.ts`** — the `recall_messages` tool:
>
> Import dependencies:
>
> ```typescript
> import {
>   tool,
>   type ToolDefinition,
>   type ToolContext,
> } from "@opencode-ai/plugin";
> import type {
>   OpencodeClient,
>   AssistantMessage,
>   UserMessage,
> } from "@opencode-ai/sdk/v2";
> import {
>   errmsg,
>   type MessagesOutput,
>   type MessageItem,
>   type ErrorOutput,
> } from "./types.js";
> import { format } from "./extract.js";
> ```
>
> Export a function `messages(client)` that takes the OpencodeClient and
> returns a ToolDefinition.
>
> Tool definition:
>
> - Description: `"Browse messages in a session chronologically with
pagination. Use to play back conversation history, see what happened
in order, or find the user's original requirements. Use reverse=true
to start from the most recent messages (offset 0 = newest). Use
offset to paginate through results."`
> - Args:
>   - `sessionID`: `tool.schema.string()` — required
>   - `offset`: `tool.schema.number().min(0).default(0)` — skip this many
>     messages from the start (or end if reversed)
>   - `limit`: `tool.schema.number().min(1).max(50).default(10)` — max messages
>   - `role`: `tool.schema.enum(["user", "assistant", "all"]).default("all")` —
>     filter by role
>   - `reverse`: `tool.schema.boolean().default(false)` — if true, newest first
>
> Execute function:
>
> 1. Set metadata title: `"Browsing messages in session..."`
> 2. Load all messages: `client.session.messages({ sessionID })`
> 3. Check `resp.error` — if set, return error envelope via `errmsg()`.
>    If `!resp.data`, return error envelope.
> 4. Apply role filter:
>    ```typescript
>    const filtered =
>      role === "all" ? msgs : msgs.filter((m) => m.info.role === role);
>    ```
> 5. If reverse, reverse the filtered array (copy first: `[...filtered].reverse()`)
> 6. Apply pagination: `filtered.slice(offset, offset + limit)`
> 7. Format each message using `formatMsg()` from `extract.ts`
>    (see RCL2-01). Do not set `center` field.
> 8. Get session context (try/catch, graceful degradation)
> 9. Build pagination metadata:
>    ```typescript
>    pagination: {
>      offset: offset,
>      returned: result.length,
>      total: filtered.length,  // total after role filter
>      hasMore: offset + limit < filtered.length,
>    }
>    ```
> 10. Update metadata: `"Showing {N} of {total} messages
(offset {offset})"`
> 11. Return `JSON.stringify(MessagesOutput)`
>
> Error handling: try/catch wrapper, return `{ ok: false, error }`
> via `errmsg()`.
>
> Style: single-word names, const, early returns.

**Review criteria for `@code-review`:**

> - Role filter applied BEFORE offset/limit (pagination over filtered set)
> - Reverse applied BEFORE offset/limit (offset 0 with reverse = most recent)
> - `total` reflects filtered count, not raw count
> - `hasMore` is accurate
> - Empty result for out-of-range offset (not an error)
> - Message formatting via `formatMsg()` from extract.ts (DRY invariant 3)
> - Error handling via errmsg() (DRY invariant 4)
> - `resp.error` checked before using `resp.data`

**Acceptance criteria:**

- `bun run typecheck` passes
- `offset: 0, limit: 5` returns first 5 messages
- `offset: 0, limit: 5, reverse: true` returns last 5 messages (newest first)
- `role: "user"` only returns user messages, pagination over that set
- `hasMore` correctly indicates if more pages exist

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

### Phase 3: Integration

**Goal:** New tools registered, README updated, end-to-end verified.

---

### RCL2-04: Index + README + Verification

**Estimated effort:** 30 minutes
**Dependencies:** RCL2-01, RCL2-02, RCL2-03
**Files:** `src/index.ts`, `README.md`

**Delegation prompt for `@code-writer`:**

> In the opencode-recall plugin at
> `/Users/rmk/projects/oss/opencode-recall-plugin/`:
>
> **`src/index.ts`** — register the new tools:
>
> Add imports:
>
> ```typescript
> import { context } from "./context.js";
> import { messages } from "./messages.js";
> ```
>
> Add to the TOOLS array:
>
> ```typescript
> const TOOLS = [
>   "recall",
>   "recall_get",
>   "recall_sessions",
>   "recall_context",
>   "recall_messages",
> ];
> ```
>
> Add to the tool map in the return value:
>
> ```typescript
> tool: {
>   recall_sessions: sessions(client, unscoped, global),
>   recall: search(client, unscoped, global),
>   recall_get: get(client),
>   recall_context: context(client),
>   recall_messages: messages(client),
> },
> ```
>
> **`README.md`** — add documentation for:
>
> 1. New `before`, `after`, `width` params on `recall`
> 2. New `recall_context` tool with params and example
> 3. New `recall_messages` tool with params and example
> 4. New usage patterns section showing the 4 workflow patterns
>    from the Design section of this plan
>
> Follow the existing README style. Keep it concise.

**Review criteria for `@code-review`:**

> - All 5 tools registered in TOOLS array and tool map
> - Primary tools list includes all 5
> - README accurately documents all params with correct types/defaults
> - README examples are realistic

**Acceptance criteria:**

- `bun run typecheck` passes
- All 5 tools appear when plugin is loaded
- README is current and accurate

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

## Commit Protocol

**Format:** Conventional Commits

| Task    | Commit Message                                                   |
| ------- | ---------------------------------------------------------------- |
| RCL2-01 | `feat(recall): add time filtering and snippet width to search`   |
| RCL2-02 | `feat(recall): add recall_context tool for conversation windows` |
| RCL2-03 | `feat(recall): add recall_messages tool for paginated browsing`  |
| RCL2-04 | `feat(recall): register v2 tools and update README`              |

---

## File Impact Summary

| File              | Task(s) | Purpose                                        |
| ----------------- | ------- | ---------------------------------------------- |
| `src/types.ts`    | RCL2-01 | Add MessageItem, ContextOutput, MessagesOutput |
| `src/search.ts`   | RCL2-01 | Add before/after/width params and filtering    |
| `src/context.ts`  | RCL2-02 | New recall_context tool                        |
| `src/messages.ts` | RCL2-03 | New recall_messages tool                       |
| `src/index.ts`    | RCL2-04 | Register new tools                             |
| `README.md`       | RCL2-04 | Document new tools and params                  |

---

## Risk Register

| Risk                                           | Likelihood | Impact | Mitigation                                                                         |
| ---------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------- |
| Large session loads for context/messages tools | Medium     | Low    | Same approach as recall; single session at a time, data discarded after formatting |
| Message ID not found in recall_context         | Medium     | Low    | Clear error message; agent retries with correct ID from search results             |
| Reverse + offset confusion                     | Low        | Medium | Clear description in tool; decision D4 documents the semantics                     |
| Breaking changes to recall output              | Low        | High   | All new params are optional with defaults matching v1 behavior                     |

---

## Rollback Plan

| Task    | Rollback strategy                                            |
| ------- | ------------------------------------------------------------ |
| RCL2-01 | `git revert` — new params are optional, no breaking changes  |
| RCL2-02 | Delete `src/context.ts`, remove from index — self-contained  |
| RCL2-03 | Delete `src/messages.ts`, remove from index — self-contained |
| RCL2-04 | `git revert` — registration and docs only                    |

---

## Out of Scope

| Item                             | Rationale                                                               |
| -------------------------------- | ----------------------------------------------------------------------- |
| Regex search                     | Substring is sufficient; agent can refine queries iteratively           |
| Batch/OR queries                 | Agent can make multiple recall calls; OR complicates result attribution |
| Session stats in recall_sessions | Would require loading messages for every listed session — too expensive |
| Server-side search               | Would require opencode core changes                                     |
| Semantic/embedding search        | Requires embedding model; deferred to v3                                |

---

## Post-Completion Checklist

- [ ] `bun run typecheck` passes
- [ ] All 5 tools work end-to-end in opencode
- [ ] DRY verification checklist passes
- [ ] No TODO/FIXME comments in source
- [ ] `@code-review` returns zero blockers on final codebase
- [ ] All status tables in this plan are marked done with commit SHAs
- [ ] README is current and accurate
- [ ] Existing v1 behavior unchanged (no regressions)
