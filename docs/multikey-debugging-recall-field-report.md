# Recall Dogfooding Field Report: Multikey Plugin Debugging

Date: 2026-07-16

## Purpose

This report records how `opencode-session-recall` behaved during a real debugging and implementation task in `opencode-multikey`. The task required recovering earlier OpenCode plugin testing practices, especially the Tuistory workflow used in `opencode-ghostauth`, while also tracing a current host compatibility failure.

The report has two goals:

1. Preserve a detailed account of the multikey investigation and the fixes that resulted from it.
2. Turn the recall experience into concrete product recommendations and regression cases for this repository.

This is a dogfooding report, not an implementation plan. Some recommendations overlap with existing documents in `docs/`, especially `recall-search-ux-improvement-plan.md` and `search-mechanism-recommendations.md`. The new value here is the evidence from one complete agent workflow: broad discovery, session narrowing, exact retrieval, terminal reproduction, implementation, testing, and review.

## Executive Summary

Recall helped, but only after several manual refinements.

The initial broad searches did not recover the requested Ghostauth/Tuistory workflow. They ranked the current conversation, prior multikey classifier reviews, and large unrelated tool outputs ahead of the older session that contained the useful terminal-driving sequence. `recall_sessions` with a title filter found the Ghostauth sessions immediately. Later, directory-scoped literal searches for `tuistory`, `launchTerminal`, and `GHOSTAUTH_LIVE_TUI` found the relevant history, including the actual Tuistory command sequence.

The main result is not that recall failed outright. The data was present and searchable. The problem was the amount of query planning required to reach it:

- broad smart search favored freshly repeated task language;
- large tool and skill outputs dominated representative snippets and expansion budgets;
- session-title discovery worked better than the primary content-search path;
- the caller had to know enough about the answer to switch from semantic terms to exact strings;
- useful workflow evidence was spread across several message and tool parts, while grouped results exposed only one representative hit.

The highest-value improvements are:

1. Add an explicit way to exclude the current session from historical discovery.
2. Downrank generated boilerplate such as full skill payloads and CLI help when tighter human-authored or command-input evidence exists.
3. Improve representative-hit selection for `group: "session"` so a session is represented by the evidence most useful to the query, not merely its strongest isolated lexical match.
4. Add a session-first query path that uses title matches to shortlist sessions, then searches deeply inside those sessions.
5. Add evaluation fixtures based on this exact case: a query for prior Ghostauth/Tuistory testing should surface the real launch and interaction commands ahead of skill text, docs audits, and the current conversation.

## Task Context

The reported failure was:

```text
opencode auth login

Select provider
OpenCode Go

Error: Unexpected error
```

The user clarified that:

- OpenCode Go is a built-in provider.
- `opencode-multikey` extends that provider with multi-account rotation.
- the current OpenCode checkout lives at `~/projects/oss/opencode`;
- prior Ghostauth work established a Tuistory-based method for testing live OpenCode plugin behavior;
- recall should be used to recover that prior workflow;
- the final response should include feedback about recall itself.

The task therefore combined four kinds of work:

1. Historical discovery across projects.
2. Current OpenCode source inspection.
3. Live interactive reproduction through Tuistory.
4. A correctness audit of the entire multikey implementation, not only the reported crash.

## What Was Wrong In Multikey

### Immediate Crash

The plugin returned this auth hook:

```ts
auth: {
  provider: "opencode-go",
  loader,
  methods: [],
}
```

Current OpenCode treats any matching plugin auth hook as the selected provider's auth implementation. In `packages/opencode/src/cli/cmd/providers.ts`, it finds the plugin by provider ID and invokes plugin authentication. The handler assumes at least one method:

```ts
const method = plugin.auth.methods[index];

if (method.prompts) {
  // ...
}
```

With `methods: []`, `method` is `undefined`. The installed OpenCode 1.18.3 binary reproduced the exact failure:

```text
undefined is not an object (evaluating 'E.prompts')
```

The plugin intended `methods: []` to mean "loader-only extension of a built-in provider." OpenCode has no such fallthrough behavior. An auth hook with a matching provider ID owns the login path.

### Pool Loss During Login

Fixing the null dereference alone would not have made the implementation correct.

The pool was stored under the `opencode-go` auth entry's metadata. A normal built-in login writes a new API entry containing the entered key and no pool metadata. The auth command then exits immediately. The plugin's 30-second reconciliation interval cannot be relied upon to restore metadata before process exit.

This creates a destructive sequence:

1. The old entry contains the full pool in `metadata.pool`.
2. `opencode auth login opencode-go` writes one new standalone key.
3. The old pool metadata disappears.
4. The short-lived auth process exits.
5. A future process sees only the new key, so the previous pool cannot be reconstructed.

The correct login method had to preserve metadata in the same write that stored the newly entered key.

### Host Contract Used By The Fix

OpenCode's API auth method performs the secure password prompt itself. After the plugin's authorization callback returns, core writes:

```ts
key: result.key ?? apiKey;
```

Current OpenCode also merges `result.metadata` into the stored API auth entry.

The plugin can therefore return:

```ts
{
  type: "success",
  metadata: preservedPoolMetadata,
}
```

It intentionally omits `key`. OpenCode retains the key collected through its secure prompt and writes that key alongside the preserved pool metadata. The published plugin type still marks the success key as required, but the runtime fallback is explicit in core.

Metadata returned from plugin authorization first shipped in OpenCode 1.14.49, so the plugin's declared minimum version was raised from `>=1.14.0` to `>=1.14.49`.

## Broader Correctness Findings

The request asked for a review of the whole implementation. Independent reviewers found several issues beyond login.

### `OPENCODE_AUTH_CONTENT` Was Not Imported

The plugin detected a non-empty `OPENCODE_AUTH_CONTENT` and skipped disk reconciliation, but it did not read the `opencode-go` entry from the environment content. An environment-only credential could therefore produce an empty runtime pool.

Core's actual source selection is:

- valid JSON in `OPENCODE_AUTH_CONTENT` wins over disk;
- invalid JSON falls back to `auth.json`.

The plugin now mirrors that precedence. Valid non-object JSON is treated as an active but empty override so stale disk credentials are not imported through an unusable override.

### `freeOnly` Was Enforced Only In One Fallback

Known-paid accounts were excluded only when every account was cooling. Once a known-paid account's cooldown expired, normal selection could authenticate it and spend paid balance even when `freeOnly` was enabled.

The normal request loop now treats known-paid accounts as ineligible before network I/O. If another eligible account exists, it is used. If all eligible accounts are unavailable, the fallback either uses a non-paid cooling account or sends the request without authentication.

### Reconciliation Timer Survived Plugin Disposal

The plugin created an interval but returned no `dispose` hook. A disposed plugin instance could continue reconciling and writing stale option keys into auth state.

The plugin now:

- marks the instance disposed;
- clears the interval;
- prevents new reconciliation work;
- waits for active reconciliation to settle.

### Region Errors Were Treated As Invalid Credentials

The Zen server returns `RegionError` as HTTP 403. The classifier treated unrecognized 401/403 responses as invalid authentication, which cooled valid keys and rotated through the pool even though a different key cannot change the request region.

`RegionError` now passes through as a request-level error.

### Failover Stopped After Eight Keys

Replayable requests were capped at eight attempts despite the README advertising support for any number of keys. A ninth key that would succeed was never tried.

Replayable requests now consider every pool key at most once. Unreplayable request bodies remain limited to one attempt.

### Pool Encoding Could Corrupt Keys

The pool used comma-separated metadata:

```text
sk-one,sk-two
```

Key validation allowed printable commas, and keys entered through OpenCode login bypassed the standalone CLI validator. A key containing a comma could split into multiple credentials on the next read.

New writes use a versioned string encoding:

```text
json:["sk-one","sk-two"]
```

Unprefixed values remain legacy comma-separated data and migrate on the next write. The prefix avoids ambiguity with a legacy key whose literal text happens to look like a JSON array.

### Stale Lock Reclamation Was Not Race-Safe

The old advisory lock attempted to reclaim stale lockfiles by checking inode and modification time, then unlinking by pathname. Another process could replace the pathname between the final check and unlink. The late reclaimer could delete a new owner's lock and allow two writers into the critical section.

Automatic stale reclamation was removed. A crashed lock now times out and requires explicit manual removal. This favors credential integrity over automatic recovery.

### Plugin And CLI Writes Needed A Shared Lock

Standalone CLI mutations used the advisory lock, but reconciliation did not. Reconciliation now takes the same lock across its final freshness read and `auth.set` call.

This coordinates plugin reconciliation with `opencode-multikey add/remove`. It cannot coordinate with OpenCode core because core does not use the plugin's lock.

### Remaining Host Limitation

OpenCode performs unlocked whole-file auth read-modify-write operations. This includes provider login, logout, and background OAuth refresh. A standalone CLI mutation cannot safely overlap any of those host writes.

There is no reliable plugin-only compare-and-swap mechanism for a shared JSON file when the host ignores the advisory lock. The README and CLI help now state the limitation directly: run standalone add/remove only when OpenCode is not mutating auth state.

## Changes Made

The final change-set touched these areas:

| Area                  | Change                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Auth method           | Added a non-empty API login method for `opencode-go`                                             |
| Login preservation    | Returned live, stored, and standalone pool metadata without overriding the securely prompted key |
| Auth source selection | Added shared parsing for active, invalid, and inactive `OPENCODE_AUTH_CONTENT`                   |
| Reconciliation        | Imported environment auth state and serialized final writes with CLI mutations                   |
| Lifecycle             | Added plugin disposal and active-reconcile settling                                              |
| Pool storage          | Added `json:` plus JSON-array encoding with legacy migration                                     |
| Selection             | Enforced `freeOnly` during normal and fallback selection                                         |
| Failover              | Removed the eight-key cap for replayable requests                                                |
| Classification        | Passed through `RegionError`                                                                     |
| Validation            | Rejected the internal OAuth dummy sentinel                                                       |
| Locking               | Removed unsafe automatic stale-lock reclamation                                                  |
| Documentation         | Corrected login, environment override, encoding, lock, and concurrency behavior                  |
| Compatibility         | Raised the minimum OpenCode version to 1.14.49                                                   |

## Verification Performed

### Automated Verification

Final verification completed with:

```text
npm test                 74 passed, 0 failed
npm run typecheck        passed
npm run verify:package   passed
git diff --check         passed
```

The new tests cover:

- non-empty API auth methods;
- secure key fallback through an omitted result key;
- managed pool preservation;
- standalone key preservation;
- live option and in-memory key preservation;
- foreign string metadata preservation;
- unreadable auth failure behavior;
- valid and invalid `OPENCODE_AUTH_CONTENT` precedence;
- managed versus unmanaged reconciliation;
- post-login standalone-key absorption;
- comma-containing key round trips;
- JSON-shaped legacy key handling;
- interval disposal;
- lock coverage across `auth.set`;
- `RegionError` pass-through;
- `freeOnly` normal selection and fallback behavior;
- ninth-key success after eight burned keys;
- dummy sentinel rejection.

### Live Tuistory Verification

The installed OpenCode 1.18.3 binary was run through isolated Tuistory sessions. The probes used temporary config and data directories and fake keys, so no real credentials were read or modified.

Before the fix:

```text
Add credential
Error: Unexpected error

undefined is not an object (evaluating 'E.prompts')
```

After the fix:

```text
Add credential
Enter your API key
Login successful
Done
```

Repeated login verified preservation. The final isolated entry had the new standalone key and the previous keys in versioned pool metadata:

```json
{
  "opencode-go": {
    "type": "api",
    "key": "sk-live-smoke-test-3",
    "metadata": {
      "pool": "json:[\"sk-live-smoke-test\",\"sk-live-smoke-test-2\"]",
      "managedBy": "opencode-multikey"
    }
  }
}
```

### Independent Review

Two independent reviewers examined the change-set and surrounding implementation. Findings were fixed and sent back to the same reviewer sessions for re-evaluation. Three rounds were completed.

Final result:

```text
Blockers: 0
Issues:   0
```

One reviewer left two optional observations: a cosmetic debounce-key overlap and a theoretical legacy key beginning with the reserved `json:` prefix. Neither changes current behavior for real OpenCode Go keys.

## Recall Usage During The Task

The following sections describe the historical-search experience in execution order.

### Search 1: Broad Project Search For The Current Failure

The first query searched the current multikey project:

```json
{
  "query": "opencode-multikey OpenCode Go auth login provider plugin multiple accounts unexpected error",
  "scope": "project",
  "match": "smart",
  "group": "session",
  "results": 8,
  "expand": "context",
  "window": 2
}
```

This was useful for recent multikey context. It found prior classifier reviews and confirmed earlier decisions about Zen error mapping. It did not answer the later request about Ghostauth/Tuistory testing because the scope was limited to the current project.

This result was appropriate for the query and scope.

### Search 2: Broad Global Search For Ghostauth And Tuistory

After the user asked for the Ghostauth workflow, the search broadened:

```json
{
  "query": "ghostauth tuistory test opencode plugin auth login debug workflow",
  "scope": "global",
  "match": "smart",
  "group": "session",
  "results": 10,
  "expand": "context",
  "window": 3
}
```

The result set was poor. The top hit was the current multikey conversation because it had just repeated most query terms. Other returned sessions were recent but unrelated. The useful Ghostauth testing session did not appear in the small top set.

The response showed a large global scan, but practical recall remained low because ranking favored fresh lexical overlap over historical task relevance.

### Search 3: `recall_sessions` By Title

The next call used session metadata directly:

```json
{
  "scope": "global",
  "search": "ghostauth",
  "limit": 20
}
```

This immediately returned the relevant Ghostauth project sessions, including:

- debugging `/ghostauth` command behavior;
- comparing slash-command wiring;
- Ghostauth implementation reviews;
- Ghostauth API and scope audits.

This was the best discovery step in the workflow. It identified the right project and session family with little noise.

The result matters because the documented product direction says `recall` should be the primary discovery tool and `recall_sessions` should be a lightweight browse tool. In this case, the browse tool was materially better at initial discovery.

### Search 4: Smart Search Constrained By Ghostauth Title

The next query added a title constraint:

```json
{
  "query": "tuistory live TUI auth login provider plugin methods built-in extend",
  "scope": "global",
  "match": "smart",
  "group": "session",
  "title": "ghostauth",
  "results": 10,
  "expand": "context",
  "window": 4
}
```

This found Ghostauth sessions, but the representative hits were mostly large source reads and reviewer outputs about auth methods or slash-command wiring. Those hits were topically related but did not expose the requested Tuistory testing recipe.

The search narrowed to the right neighborhood but still required manual inspection.

### Search 5: Directory-Constrained Smart Search

The search then used the exact Ghostauth directory:

```json
{
  "query": "launchTerminal opencode live TUI test waitForText auth login ghostauth",
  "scope": "global",
  "match": "smart",
  "group": "session",
  "directory": "/Users/rmk/projects/oss/opencode-ghostauth",
  "results": 10,
  "expand": "context",
  "window": 5
}
```

The directory filter worked. All eligible sessions came from the correct project. Ranking still preferred recent sidebar review sessions and tool output containing general TUI language. The actual workflow session was not clearly surfaced as the best answer.

This illustrates an important distinction: filtering was correct, ranking within the filtered corpus was not aligned with the user's intent.

### Search 6: Browse A Guessed Session

A direct `recall_messages` query for `tuistory` was run against a session chosen from the Ghostauth title list. It returned zero messages.

This was not enough evidence to call `recall_messages` broken. The chosen session was about slash-command debugging and may not have contained the Tuistory transcript. It did show that session-level browsing is unforgiving when the caller chooses the wrong nearby session.

### Search 7: Literal Queries After The Implementation Was Complete

At the end of the task, exact literal searches were used to evaluate recall more deliberately:

```json
{
  "query": "launchTerminal",
  "scope": "global",
  "match": "literal",
  "group": "part",
  "directory": "/Users/rmk/projects/oss/opencode-ghostauth",
  "fallback": false,
  "expand": "context",
  "window": 2
}
```

```json
{
  "query": "GHOSTAUTH_LIVE_TUI",
  "scope": "global",
  "match": "literal",
  "group": "part",
  "directory": "/Users/rmk/projects/oss/opencode-ghostauth",
  "fallback": false,
  "expand": "context",
  "window": 2
}
```

```json
{
  "query": "tuistory",
  "scope": "global",
  "match": "literal",
  "group": "part",
  "directory": "/Users/rmk/projects/oss/opencode-ghostauth",
  "fallback": false,
  "expand": "context",
  "window": 2
}
```

These searches found the missing evidence. The `tuistory` query returned the real historical workflow, including:

- loading the Tuistory skill;
- running `tuistory --help`;
- launching an interactive terminal session;
- setting session dimensions and environment variables;
- taking snapshots;
- typing slash commands;
- pressing keys;
- reading terminal output.

The useful session was titled `Profile and Audit Claude CLI: Usage Tracking Changes and Signature Compatibility`. Its title did not contain Ghostauth testing language, even though it lived in the Ghostauth project and contained the terminal workflow.

The literal `launchTerminal` query mostly found the full Tuistory skill payload rather than a project-authored test. The literal `GHOSTAUTH_LIVE_TUI` query found both the skill's OpenCode addendum and project docs mentioning the live smoke lane.

These results proved the history was available. They also showed why the earlier smart query missed it: the workflow was represented by exact command vocabulary and tool parts, not by the broader phrase "how we test Ghostauth plugins."

## What Recall Did Well

### Complete Cross-Project Reach

The tools searched the Ghostauth project from a multikey session without needing a separate index or manual transcript export. Directory filtering correctly isolated the external project.

### Exact Retrieval Once The Anchor Was Known

Literal searches for `tuistory`, `launchTerminal`, and `GHOSTAUTH_LIVE_TUI` located the relevant evidence. Tool-input commands were searchable, which was essential because the practical workflow lived in terminal invocations.

### Session Metadata Discovery

`recall_sessions(search: "ghostauth")` was fast and useful. It surfaced the available historical neighborhoods before expensive content inspection.

### Context Expansion

When the correct hit was found, context expansion showed the surrounding decision and the next terminal action. This was enough to reconstruct intent, not just retrieve a command fragment.

### Transparent Coverage And Limits

Responses disclosed sessions discovered, sessions searched, messages searched, parts searched, directory buckets, and expansion-budget warnings. That made it possible to distinguish "no data exists" from "the top results were not useful."

### Searchable Tool Inputs

The final literal search exposed actual `tuistory` commands from Bash tool inputs. Searching only rendered output would not have been sufficient.

## What Made Recall Hard To Use

### Current-Session Dominance

The broad global query repeated words from the user's current request. The current conversation therefore became a strong lexical match and ranked above the older history being requested.

This is a recurring pattern for historical discovery. The current turn naturally contains the query terms because the user has just described what should be recalled. Unless the caller explicitly excludes the current session, the search can answer with a reflection of the question instead of prior evidence.

### Large Generated Outputs Dominated Results

Several high-ranking hits came from:

- full skill payloads;
- large source-file reads;
- reviewer reports;
- code-index output;
- complete CLI help text.

These parts contain many query terms and can overwhelm short, high-value evidence such as:

```text
tuistory -s ccint type "/usage"
tuistory -s ccint press enter
```

BM25 length normalization helps, but this case shows that source class also matters. A full skill definition is generated reference material. It should not outrank a concrete historical action when the query asks what was done before.

### Session Grouping Hid The Workflow

`group: "session"` returns one representative hit per session. In the relevant session, the strongest lexical part was often the Tuistory skill body or a large tool output. The representative did not summarize that the session also contained the launch, type, press, and snapshot sequence.

The grouped result was technically representative of the lexical match, but not representative of the session's usefulness.

### Title Discovery And Content Discovery Remained Split

`recall_sessions` found Ghostauth sessions more reliably than `recall`. This reproduces a failure mode already described in `recall-search-ux-improvement-plan.md`: title metadata can identify the right history while content ranking fails to expose it.

The eventual useful session had a title about Claude CLI profiling, not plugin testing. A robust search needed both signals:

- directory and project identity from metadata;
- exact terminal actions from message parts.

Neither signal alone was enough.

### Smart Search Needed Answer-Specific Vocabulary

The user asked for "how we test Ghostauth" and mentioned Tuistory. The useful evidence contained `tuistory`, but much of the practical recipe was represented by command verbs and API names such as:

- `launch`;
- `snapshot`;
- `type`;
- `press`;
- `wait`;
- `launchTerminal`;
- `GHOSTAUTH_LIVE_TUI`.

The caller had to know these anchors before search became precise. That limits recall's value for cases where the whole point is recovering forgotten vocabulary.

### Expansion Spent Budget On The Wrong Material

Expanded smart results repeatedly hit the 30,000-character budget. Large tool payloads consumed most of the expansion while the useful action sequence remained outside the returned window or appeared only after further searches.

The warning was correct, but the allocation policy did not maximize useful evidence.

### Result Volume Became Difficult To Triage

The final literal `tuistory` search found 191 matching parts in the exact project directory. This was good recall but poor precision. The first 20 results included user text, skill payloads, CLI help, docs references, source reads, and actual commands.

The caller still had to classify result types manually.

### Weak Search Did Not Trigger A Better Internal Plan

The first smart search did not automatically try a title shortlist, exact-token variant, or tool-input-focused pass. The caller manually changed tools and query forms.

The existing P2 idea of an internal query plan is directly supported by this field report.

## Recommendations

### P0: Add Current-Session Exclusion

Add an optional parameter:

```ts
excludeCurrentSession?: boolean
```

Recommended behavior:

- default `false` for compatibility;
- strongly recommend `true` in the tool description for prior-session discovery;
- allow an explicit `excludeSessionID` for callers that know the session;
- include the exclusion in coverage metadata.

Potential API:

```ts
recall({
  query: "ghostauth tuistory plugin testing",
  scope: "global",
  excludeCurrentSession: true,
});
```

Regression case:

- current session repeats all query terms;
- older session contains the actual implementation or command sequence;
- with exclusion enabled, the older session must rank first.

### P0: Treat Generated Reference Payloads As A Separate Evidence Class

Add source classes for ranking and explanation:

```ts
type EvidenceClass =
  | "human-text"
  | "reasoning"
  | "tool-input"
  | "tool-output"
  | "skill-definition"
  | "file-read"
  | "review-report"
  | "session-title";
```

The implementation does not need perfect semantic classification. Useful deterministic signals already exist:

- tool name `skill` identifies skill payloads;
- tool name `read` identifies file reads;
- tool input command identifies terminal actions;
- role and part type distinguish human text, reasoning, and tool content.

Recommended ranking behavior:

- exact tool-input commands receive a strong boost for command-like queries;
- skill payloads remain searchable but receive a penalty when the same terms occur in human text or tool inputs;
- large file reads receive normal BM25 length normalization and a source penalty for workflow queries;
- result `why` includes the evidence class.

This is not a request to hide tool outputs. Tool outputs are often the only source of an error or result. The goal is to stop generated reference material from becoming the default representative when tighter evidence exists.

### P0: Improve Grouped Representative Selection

For `group: "session"`, select a representative using utility, not only the highest isolated score.

Recommended tie-break order for similarly scored hits:

1. human-authored text that states the task or decision;
2. tool input that demonstrates the action;
3. concise tool output showing the result;
4. reasoning;
5. large generated reference output.

Add compact secondary evidence to grouped results:

```ts
{
  sessionID: "...",
  representative: { /* current result */ },
  evidenceKinds: ["human-text", "tool-input", "tool-output"],
  topEvidence: [
    { messageID: "...", partID: "...", kind: "tool-input", snippet: "tuistory ..." },
    { messageID: "...", partID: "...", kind: "human-text", snippet: "run interactive ..." }
  ]
}
```

Keep `topEvidence` small, perhaps two entries. This would have made the useful session obvious without requiring `group: "part"` and 191 raw hits.

### P0: Cap Expansion Per Part

Expansion has a total budget but large individual parts can consume most of it. Add a per-part character cap before allocating the remaining budget.

Suggested defaults:

```ts
maxExpandedPartChars: 8_000;
maxExpandedToolOutputChars: 6_000;
```

For oversized parts:

- preserve the beginning and the matched region;
- include an omission marker;
- return identifiers so `recall_get` can retrieve the complete message;
- do not let one skill body or CLI help dump consume the whole expansion budget.

### P1: Add A Session-First Search Plan

When a query contains a project or feature name, use a two-stage search:

1. Score session metadata using title, directory, project, and session summary fields.
2. Search content deeply inside the strongest session candidates.

This is different from returning title hits as ordinary parts. The title is used to choose where to search, while content still supplies the evidence.

For the dogfooding query, a session-first plan could have:

1. shortlisted Ghostauth sessions by directory and title;
2. searched those sessions for `tuistory`, `TUI`, `launch`, `snapshot`, and tool-input commands;
3. returned the launch sequence rather than the current multikey conversation.

Expose the plan in compact metadata:

```ts
queryPlan: {
  variants: ["smart-content", "title-shortlist", "tool-input-exact"],
  selected: "title-shortlist+tool-input-exact"
}
```

### P1: Add Lightweight Query Variants

The internal query plan does not need embeddings or LLM-generated synonyms. Deterministic variants are enough for many workflows:

- preserve the full phrase;
- extract quoted strings and code-like tokens;
- identify package, project, command, path, and error-code tokens;
- search exact uncommon tokens separately;
- search tool inputs when the query contains command verbs such as run, launch, type, press, test, or reproduce;
- search titles and directories for project names.

The final answer should merge and deduplicate these variants rather than expose separate result sets.

### P1: Add Result Diversity By Evidence Type

Current diversity focuses on session grouping. Add optional diversity across evidence classes.

For example, the first five results could be limited to:

- at most two file-read hits;
- at most one skill-definition hit;
- at least one human-text hit when available;
- at least one tool-input hit for command-like queries.

This would keep broad searches from returning five variants of the same large source dump.

### P1: Add A "Previous Workflow" Recipe To The Tool Description

The tool description can give the agent a deterministic fallback recipe:

```text
For "how did we test/debug this before": search smart with group:"session" and
excludeCurrentSession:true. If weak, search the project directory literally for
the named tool/package, then inspect top tool-input hits with recall_context.
```

This is preferable to expecting every agent to rediscover the sequence of `recall_sessions`, title filtering, directory filtering, literal mode, and part grouping.

### P1: Improve Weak-Result Guidance

The response already provides suggestions and near misses. Add guidance based on result composition:

- If the current session supplies most top hits, suggest `excludeCurrentSession:true`.
- If title matches exist but content confidence is low, suggest or automatically run a title-shortlisted search.
- If skill/file-read outputs dominate, suggest `type:"tool"` with a command-oriented evidence preference.
- If one session contains many matches, suggest `group:"part"` scoped to that session.
- If exact code-like tokens are present, suggest `match:"literal"` for those tokens.

### P2: Add Workflow-Aware Sequence Retrieval

Many useful memories are sequences rather than isolated facts:

1. launch a process;
2. wait for readiness;
3. type a command;
4. press Enter;
5. inspect output;
6. close the session.

Once one matching tool-input part is found, sequence retrieval could collect neighboring tool calls in the same assistant turn or adjacent turns. This can remain deterministic and bounded.

Possible output:

```ts
sequence?: {
  before: SearchHit[]
  match: SearchHit
  after: SearchHit[]
}
```

This is more useful for recovering operational workflows than ordinary message context, which includes all parts but does not label the action sequence.

### P2: Add Dogfooding Feedback Capture

The plugin has a relevance harness, but the product lacks a simple way to record that a search was useful only after several refinements.

A local, explicit feedback command could record:

- query parameters;
- selected useful hit IDs;
- top returned but rejected hit IDs;
- missing topic description;
- whether the user had to switch tools or match modes.

This does not need telemetry or automatic upload. A JSON fixture generator for maintainers would be enough.

## Proposed Evaluation Fixture

Add a corpus fixture representing this dogfooding case.

### Sessions

Create at least these synthetic sessions:

1. **Current multikey debugging session**
   - repeats `ghostauth`, `tuistory`, `auth login`, and `plugin debugging` in the current request;
   - contains no historical Tuistory command sequence.

2. **Ghostauth workflow session**
   - title does not directly say "plugin testing";
   - directory is the Ghostauth project;
   - contains human text describing an interactive test;
   - contains tool inputs for Tuistory launch, wait, type, press, snapshot, and close;
   - contains a full Tuistory skill payload.

3. **Ghostauth docs review session**
   - contains many mentions of `GHOSTAUTH_LIVE_TUI` and `tuistory` in large file reads;
   - does not perform a live test.

4. **Unrelated recent TUI session**
   - contains `live`, `TUI`, `test`, and `waitForText`;
   - belongs to another directory.

### Queries And Expected Results

#### Historical workflow query

```text
ghostauth tuistory test opencode plugin auth login debug workflow
```

Expected:

- with current-session exclusion, the workflow session ranks first;
- the representative is human text or a concrete tool input, not the skill body;
- the docs review session may appear but ranks lower;
- unrelated TUI history does not outrank exact-directory evidence.

#### Exact tool query

```text
tuistory
```

Expected:

- result diversity includes a concrete tool input in the top three;
- no more than one skill-definition result appears in the top five;
- grouped workflow session exposes both human and tool-input evidence kinds.

#### API query

```text
launchTerminal
```

Expected:

- a project-authored live-test file or invocation outranks the generic skill definition when both exist;
- if only the skill contains the literal, the skill remains retrievable.

#### Title/content bridge query

```text
ghostauth live test
```

Expected:

- session metadata narrows to the Ghostauth directory;
- content evidence from a differently titled workflow session is still returned.

### Metrics

The existing MRR and recall-at-five metrics should be supplemented with:

- useful evidence class in top three;
- current-session false-positive rate for prior-history queries;
- maximum count of same-class generated outputs in top five;
- grouped-session representative quality;
- expansion budget share consumed by the largest part.

## Suggested Implementation Order

1. Add the dogfooding fixture and lock current behavior into a failing evaluation case.
2. Add current-session exclusion and related guidance.
3. Add evidence-class tagging to searchable candidates and `why` output.
4. Change grouped representative selection and add two-item secondary evidence.
5. Add per-part expansion caps.
6. Add deterministic title-shortlist and tool-input query variants.
7. Add evidence-type diversity.
8. Explore workflow sequence retrieval only after the simpler ranking changes are measured.

This order keeps the first changes small and testable. It also separates ranking improvements from larger API additions.

## Operator Lessons

Some friction came from search strategy rather than product behavior. The following operator sequence worked reliably:

1. Start with `recall` using short distinctive terms, not a sentence-sized query.
2. Use `group: "session"` for broad discovery.
3. If a project name is known, use `directory` early.
4. If broad smart results are weak, run `recall_sessions` by title to identify the project neighborhood.
5. Switch to `group: "part"` and `match: "literal"` for exact tools, commands, symbols, or environment variables.
6. Prefer tool-input evidence for operational workflows.
7. Expand only the best hit or use `recall_context` after finding a strong anchor.

These are useful practices, but the product should automate more of them. A historical-search tool should not require the caller to remember the forgotten command before it can recover the workflow.

## Conclusion

Recall ultimately supplied the historical evidence needed to choose and operate Tuistory correctly. It also recovered relevant prior multikey decisions. The underlying coverage was strong.

The weak point was retrieval efficiency. The primary smart-search path did not surface the requested prior workflow without title browsing, directory narrowing, exact literal queries, and part-level inspection. Large generated outputs were overrepresented, and current-session language competed directly with older evidence.

The most important product direction is to make historical intent explicit in ranking: exclude the current session when requested, distinguish concrete actions from generated reference material, bridge session metadata with content search, and return more useful grouped representatives. The proposed fixture turns those goals into measurable behavior rather than another round of ranking intuition.
