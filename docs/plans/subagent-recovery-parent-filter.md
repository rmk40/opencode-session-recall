# Subagent recovery: `parentID` filter on `recall_sessions`

## Goal

Make recall the first-class path for recovering interrupted subagent sessions.
The field report ([subagent-recovery-recall-field-report.md](../subagent-recovery-recall-field-report.md))
documents an incident where an orchestrator's four cancelled `@code-writer`
subagents were unreachable through every recall discovery path, and hand-written
SQL against opencode's database was the fallback. The root asymmetry: opencode's
Task tool delivers a subagent's session ID only in the completion payload; a
cancelled task returns a bare `<error>Task cancelled</error>`, so the
orchestrator provably never holds the IDs it needs for `task_id` resumption.
Discovery through recall is the only general answer, and today discovery is
gated on the card index, which is exactly the layer that lags for young and
cancelled sessions.

This plan adds a live, index-free parent/child lookup to `recall_sessions`,
plus deliberate tool-surface hints so an orchestrator staring at a
`Task cancelled` error is steered to the recovery workflow.

## Constraints

- **No unbounded message fetches.** The incident-path rule (AGENTS.md) is about
  `session.messages` without a `limit`; nothing here touches messages — reads
  stay on the existing paged `recall_messages` path. The children endpoint
  itself is an **unpaginated metadata listing** (`session.children` takes no
  `limit`/cursor and returns the full `Array<Session>`); this is accepted — a
  metadata-only fetch, bounded in practice by subagent fan-out. The
  tool's `limit` arg is a client-side slice, not a network bound. README's
  claim "Every fetch is bounded and paginated" (README.md:276) must be
  narrowed to message fetches as part of this change.
- **The SDK primitive exists and must be used as-is:**
  `client.session.children({ sessionID })` in `@opencode-ai/sdk/v2`
  ("Retrieve all child sessions that were forked from the specified parent
  session", returns `200: Array<Session>`, errors 400/404). No SQL against
  opencode's DB, no dependency on the card store for this path. The output
  contract is **direct children only**: returned rows are filtered by
  `row.parentID === resolvedParent`, so even if the endpoint returns full
  descendants the contract holds. Grandchildren (a subagent's own subagents)
  are out of scope.
- **Fetch-gate exemption, stated:** `sessions()` does not take the shared
  `FetchGate` today — its `session.list` calls are an existing exception to
  the gate that covers the query/distill paths. The children call joins that
  same retained exception; no gate wiring is added.
- **Zod defaults are not applied by the host.** Every new arg must be coerced
  defensively in `execute` (`optionalString` in `src/types.ts` suffices — no
  new coercion helper is needed), with a `runToolRaw` regression test.
- **Backward compatible output.** `SessionItem` gains only optional fields, and
  ordinary (non-`parentID`) listings emit **byte-identical shapes** to today
  except where the staleness fallback (step 4) engages. No new field is emitted
  on existing happy paths — enforced by a guard test.
- **`src/` stays environment-agnostic** (no Node globals).

## Decisions (resolved during review)

These were open questions or contradictions in earlier drafts; each is now a
firm decision an implementer can follow without judgment calls.

1. **Client: the scoped `client`, matching every other per-session SDK call in
   this repo** (`client.session.get` on arbitrary global-scope targets at
   `src/search.ts:2106`, `client.session.message` in drill, the distiller's
   fetches — all scoped; `unscoped` is used only for the purpose-built
   `experimental.session.list`). A per-session call on `unscoped` would be a
   novel untested transport path. The fake harness stubs `children` on **both**
   fakes, recording into one shared log that tags the source:
   `FakeCalls.children: Array<{ sessionID: string; client: "scoped" | "unscoped" }>`
   — one test asserts `"scoped"`, so the decision is enforced, not just
   documented, while a client switch stays a one-line change. Error paths are
   driven by `FakeOptions.childrenError` (SDK error return) and
   `FakeOptions.childrenThrows` (rejection). The tuistory pass verifies the
   scoped transport against a real server, including an explicit
   foreign-directory parent; if that probe fails, the implementation switches
   to `unscoped` and the assertion flips with it.
2. **`global: false` policy:** the children branch ignores the `scope` arg, and
   the `scope === "global" && !global` early error does not apply to it (the
   check gains a `!parentID` conjunct — see step 1 for placement mechanics).
   The `global` plugin option is still honored for **explicit** parent IDs:
   when `global` is false and the resolved parent is not `ctx.sessionID`,
   returned children are post-filtered by the existing `sameProject` check
   against the caller's directory, and the output `note` reports how many rows
   were withheld (count only, no IDs). When the resolved parent **is**
   `ctx.sessionID` (whether via the `"current"` sugar or an explicit ID that
   equals it), rows are **exempt from the filter**: a session's own children
   were spawned by it, possibly in other worktrees, and the privacy rationale
   (don't leak other projects' sessions) cannot apply to sessions this session
   created. Withholding them would defeat the recovery workflow this plan
   exists for. Known edge: with `global: false` and no `ctx.directory`,
   `sameProject` passes everything (`src/sessions.ts:54-57`) — accepted, since
   without a caller directory there is no scope basis to filter on; same
   behavior as the existing card path.
3. **Output `scope` field:** `SessionsOutput.scope` is required
   (`src/types.ts:379`); on the children branch it is the literal string
   `"children"`, and the output carries `parentID: <resolved id>` echoing the
   resolved parent. No item-level `parentID` field — a single-parent listing
   makes it redundant. `scope: "children"` is a soft widening of the field's
   value set; called out in the CHANGELOG, and it doubles as the discrimination
   rule for callers (a non-string `parentID` degrades to an ordinary listing,
   detectable because `scope` is not `"children"`).
4. **Truncation signal:** the output includes `childCount` on the children
   branch = the **post-filter, pre-slice** count (after summarizer exclusion,
   search/time filters, direct-child filter, and scope withholding). Withheld
   foreign rows are _not_ included — the coarse withheld count in `note` is
   the only disclosure. `childCount > returned` means the recovery set was
   truncated by `limit`. (Distinct from the existing `SessionItem.family.childCount`,
   which counts card-store descendants.)
5. **`distilled` marker semantics:** keyed on **full content distillation**
   via `distillState`: a row gets `distilled: false` when there is no card
   **or** `card.distillState !== "full"`. Not `distilledThrough` — a fully
   distilled session with zero messages legitimately has
   `distilledThrough: null` (`src/distill.ts:488-515`), and card coverage
   already treats `distillState === "full"` as the authority
   (`src/cards.ts:633-641`). Rows backed by a full card omit the field;
   emitted as `false` only, never `true`. The marker is applied **at the two
   call sites** (children branch, staleness-fallback rows) via an explicit
   flag — never inside the shared `enrich()`, which also serves the ordinary
   listing paths that must stay byte-identical. Guard test: ordinary listings
   emit no `distilled` key, in both warm and cards-lite modes.
6. **Pipeline order on the children branch:** filter (direct-child check,
   summarizer exclusion, `search` case-insensitive substring, `since`/`until`
   on `time.updated`, scope withholding per decision 2) → sort by
   `time.updated` descending with `id` ascending as tie-break → slice to
   `limit`. Never slice before sorting.
7. **`note` field ownership:** `note` stays a single optional string. Its three
   producers cannot co-occur: the children branch returns early (its note:
   scope-withheld count), the staleness fallback emits its own note on the
   fallback path, and the degraded no-store note keeps its existing condition
   (`src/sessions.ts:271-275`). One branch, one producer. The fallback note
   must disclose its own bound: it consulted the newest `limit` live sessions
   only (that is all `session.list` returns), so it is honest about not being
   authoritative either.
8. **Two staleness watermarks, deliberately asymmetric.**
   - `recall_sessions` fallback: scope-relative — `since` newer than the
     newest **in-scope** card's `timeUpdated` (`sameProject`-filtered for
     project scope; all cards for global). The watermark counts **all**
     in-scope cards regardless of `distillState`: a metadata card carries
     title/directory/timestamps, which is sufficient coverage for a metadata
     listing. Do **not** harmonize this with decision 5's full-only rule — a
     full-only watermark collapses to 0 in cards-lite mode and would fire a
     live `session.list` on every `since`-filtered call, defeating the
     card-authoritative path (guarded by a cards-lite test asserting no
     fallback). An empty or fully out-of-scope card set gives a watermark of
     `0`, so the fallback always fires there — intentional. Only a lower
     bound (`since`) triggers; `until`-only filters never do, and an inverted
     window (`since > until`) skips the fallback too — the emptiness is the
     caller's bounds, not index lag.
   - `recall` suggestions: **store-wide** `coverage.cards.storeRecency`,
     because no scoped watermark exists in `SearchCoverage` and threading one
     is not worth it for a best-effort hint. Note `storeRecency` is computed
     over full cards only (`src/cards.ts:636-641`), so it is `0` in degraded /
     cards-lite states — the suggestion wording must branch on
     `coverage.cards.degraded` (`src/types.ts:151`) so a missing store is not
     misdiagnosed as index lag. Residual gap, accepted: a fresh card in
     another project can suppress the suggestion for a project-scoped stale
     window. The condition must also handle `coverage.cards` being absent
     (`cards?:` at `src/types.ts:147`), not just `0`.
   - Both are heuristics, not completeness watermarks — one fresh card can
     mask missing sessions within the same scope; that gap is listed in Out
     of scope.

## Approach

1. **`src/sessions.ts` — add a `parentID` arg to `recall_sessions`.**
   - Schema: `parentID: tool.schema.string().optional()` described as
     `Filter to child (subagent) sessions of a parent; "current" = this
session. Live lookup, direct children only — works for cancelled or
in-flight subagents not yet indexed.`
   - Coercion: `optionalString(args.parentID)`. A non-string value (raw host
     path) silently degrades to an ordinary listing — covered by an explicit
     test mirroring `test/tools.test.ts:452-464`, and detectable by callers
     per decision 3. Resolve `"current"` via `ctx.sessionID` (precedent:
     `src/search.ts:1907`); if `"current"` is passed and `ctx.sessionID` is
     absent, return an `ErrorOutput` naming the problem. No ID-collision
     risk: real session IDs are `ses_*`-prefixed.
   - **Placement mechanics (not a physical reordering):** the shared
     preamble stays where it is — `ctx.metadata`, the enrichment-map build
     (`src/sessions.ts:118-131`), `passesTime` (`:133-138`), `enrich()`
     (`:142-158`) — because the children branch needs all of them. The
     global-disabled early return (`:110-116`) gains a `!parentID` conjunct
     instead of moving. The children branch itself goes **inside the existing
     `try`** (top of `:160`), before the card-authoritative time path, so a
     thrown SDK error hits the existing catch (which yields a bare
     `errmsg(e)`, unlike the error-return path's `Failed to list children:`
     prefix — intentionally consistent with how the tool treats other throws;
     the two tests assert different message shapes). `ctx.metadata`: the
     preamble's scope-based call fires first and the children branch issues a
     second call that overwrites it (last-write-wins, same two-call pattern as
     `:104`/`:192` today): `Found N children of <id>` where N is `returned`.
   - Call `client.session.children({ sessionID: resolvedParent })`
     (decision 1). SDK error return → `ErrorOutput`
     (`Failed to list children: ...`); thrown → existing catch. A parent with
     zero children is `ok: true` with an empty list — not an error.
   - Filter rows to direct children (`row.parentID === resolvedParent`), map
     through the existing item shape and `enrich()`, then apply the
     decision-6 pipeline and the decision-5 marker flag. Summarizer workers
     are excluded defensively even though current workers are parentless
     roots (`src/summarize.ts` creates them without `parentID`) — cheap belt,
     not load-bearing.
   - Output: `scope: "children"`, `parentID` echo, `childCount` (decision 4),
     `distilled: false` rows per decision 5, `note` with withheld count when
     scope withholding occurred.

2. **`src/types.ts` — extend the output types.**
   - `SessionItem`: add optional `distilled?: boolean` (emitted as `false`
     only).
   - `SessionsOutput`: add optional `parentID?: string` and
     `childCount?: number` (children branch only).

3. **Tool-surface hint — one sentence, one place.**
   - The `recall_sessions` tool description (the arg description stays a
     terse mechanical one) gains: `To recover cancelled or interrupted
subagents (Task tool returned "Task cancelled" with no task_id), call
this with parentID:"current" — the listing is live and does not depend on
the search index.`
   - No query-intent detection in `recall` — subagent-recovery intent is not
     reliably detectable from query terms. The `parentID` hint reaches `recall`
     callers only through the staleness suggestion (step 4).

4. **Staleness honesty (field-report recommendation 3, narrow version).**
   - `recall_sessions` card-authoritative time path: when the filter selects
     zero sessions **and** the decision-8 condition holds (`since` newer than
     the newest in-scope card), fall through to the live `session.list` branch
     for that window instead of returning an empty card answer, with a `note`
     that the index had not caught up and that only the newest `limit` live
     sessions were consulted (decision 7). The note rides an explicit
     fallback flag into the `session.list` branch — same call-site-flag
     mechanism as `distilled` (decision 5), never inferred inside the shared
     branch, so the existing degraded-mode `note` condition
     (`hasTimeFilter && !allCards`, `src/sessions.ts:271-275`) is untouched.
     Rows without a full card get `distilled: false` via the call-site flag.
   - `recall` search suggestions (`src/search.ts`): `buildSuggestions`
     (`:1361-1377`) and `attachCommonOutput` (`:1536-1553`) do not currently
     receive the resolved time bound — thread the normalized lower bound
     (`after`) through both signatures. When `sessionsEligible` is 0, `after`
     is set, `coverage.cards` is present, and
     `after > coverage.cards.storeRecency`: add a staleness suggestion. Its
     wording branches on `coverage.cards.degraded` (decision 8): non-degraded
     → "the index has not caught up; recent sessions may be missing; for
     cancelled-subagent recovery use
     `recall_sessions({ parentID: "current" })`, otherwise list live session
     metadata with `recall_sessions` using the same `since`" (widening the
     window does **not** recover unindexed sessions — it only admits older
     indexed ones, so it is not offered); degraded → "no content index is
     available; recent sessions are not searchable — use `recall_sessions`
     for live metadata". In both cases **suppress** the two misleading
     generic entries — the literal→smart add (`:1428`) and the "only N
     sessions were searched" add (`:1444`). There is no replace mechanism
     (suggestions are additive, sliced to `MAX_SUGGESTIONS = 3` at
     `:1514-1516`), so suppression is explicit conditions on those two adds.
     **Insertion position:** equal priorities keep insertion order, and other
     priority-0 adds fire earlier in the function — the regex routing hint
     (`:1392`) as well as the zero-result block (directory `:1409`,
     excluded-session `:1420`, type-filter `:1436`) — so the staleness entry
     must be inserted **before all of them** (literally first among
     priority-0, ahead of `:1392`) when its condition holds; the same
     cap-protection precedent as the excluded-session add (`:1417-1419`).
     Otherwise an adversarial combination (e.g. a regex-shaped query plus
     directory and type filters) slices off the one suggestion this step
     exists to deliver.

5. **Tests.**
   - **Fixture:** the shared `makeFixture()` has **no session graph today**
     (the `parentID: "parent"` at `test/helpers.ts:155` is a message-level
     field — do not mistake it for one). Children are **opt-in**: add a
     `FakeOptions.children` map (`parentID → Session[]`), plus `childrenError`/`childrenThrows`
     controls; wire recording `session.children` fakes onto **both** fake
     clients (decision 1) sharing one client-tagged `FakeCalls.children` log.
     The shared default fixture stays graph-free so existing exact-count
     assertions (`test/tools.test.ts:62-64`, `test/recall.test.ts:1073-1084`)
     keep passing.
   - **Children branch** (in `test/tools.test.ts`, which already runs
     `setStrictNoLimitMessages(true)`):
     - explicit parent ID lists its children **via the scoped client**
       (assert the `client: "scoped"` tag); **`session.list` is never
       called** (assert `projectList`/`globalList` empty — index-freedom is
       the premise) and **no message fetch occurs** (assert `calls.messages`
       empty — strict mode alone only catches _unlimited_ calls);
     - `{ scope: "global", parentID: ..., global: false }` → `ok: true`, not
       the `Global scope disabled` error (the `!parentID` conjunct's one
       observable effect);
     - `"current"` sugar resolves `ctx.sessionID`; `"current"` without a
       session ID → error;
     - zero children → `ok: true`, empty, `childCount: 0`;
     - SDK error return (`childrenError`) → `ErrorOutput` with the
       `Failed to list children:` prefix; thrown (`childrenThrows`) →
       `ErrorOutput` with the bare catch-all message (different shapes,
       intentional);
     - more children than `limit` → newest kept, `childCount` = post-filter
       pre-slice total (sort-before-slice);
     - a grandchild row returned by the fake SDK (`parentID` ≠ resolved
       parent) is excluded (direct-child contract);
     - `until`, `since`, and `search` post-filters (search case-insensitive);
     - uncarded child → `distilled: false`; metadata-only card
       (`distillState !== "full"`) → `distilled: false`; **fully distilled
       empty session** (`distillState: "full"`, `distilledThrough: null`) →
       no `distilled` field; full card → enriched, no `distilled` field;
     - **guard:** ordinary (non-`parentID`) listings emit no `distilled` key,
       warm and cards-lite modes;
     - degraded mode (no enrichment) → all rows `distilled: false`;
     - `global: false` + explicit foreign parent → foreign-project rows
       withheld, `note` reports count, `childCount` excludes them;
       `global: false` + `"current"` with a foreign-directory child → row
       returned (exemption); `global: false` + absent `ctx.directory` →
       nothing withheld (documented edge);
     - `runToolRaw` with raw `{ parentID: "current" }` and all else omitted
       (host-bypass); raw non-string `parentID` (e.g. `42`) → ordinary
       listing, `scope` ≠ `"children"`.
   - **Staleness fallback:**
     - zero card matches + `since` newer than newest in-scope card → live
       list consulted, `note` present (including the newest-`limit` bound
       disclosure), uncarded rows `distilled: false`;
     - `since` older than newest in-scope card → zero stays zero, **no** live
       call (the guard that keeps cards authoritative);
     - `since === watermark` boundary (equal is not newer → no fallback);
     - a newer card in a **foreign** project with project scope → in-scope
       watermark still stale → fallback fires (scope-relativity);
     - empty-but-present card store (`allCards: []` is truthy —
       `src/sessions.ts:167` runs the card path) → watermark 0, fallback
       fires;
     - **cards-lite store** (all cards `distillState: "metadata"`, fresh
       timestamps) → watermark counts them → **no** fallback (the
       all-states-watermark guard from decision 8);
     - inverted window (`since > until`) → no fallback;
     - `until`-only zero result → no fallback (existing regression at
       `test/tools.test.ts:519-521` already covers the card-path half).
   - **Suggestions** (in `test/recall.test.ts` — note `:1351` asserts
     `suggestions` has length 3 and `:1066/:1130/:1181/:1392/:1413` pin
     specific entries; the staleness entry must not displace them outside its
     condition):
     - stale-window coverage → staleness suggestion present **and first**,
       literal→smart and sessions-searched entries suppressed;
     - stale window combined with a regex-shaped query plus directory + type
       filters → staleness entry still survives the 3-cap (the `:1392`
       routing hint is also priority-0);
     - stale window in degraded mode (`coverage.cards.degraded`) → the
       no-index wording, not the index-lag wording;
     - non-stale zero-result coverage → generic suggestions unchanged;
     - absent `coverage.cards` → no staleness entry, no crash.
   - **Suite total:** `npm run check` including the eval baseline.

6. **Docs.**
   - README: `recall_sessions` tool documentation (new arg, the recovery
     workflow, the
     `distilled` marker, direct-children-only, the `scope`-based
     discrimination rule for the raw-host degrade), and narrow the
     "Every fetch is bounded and paginated" sentence (README.md:276) to
     message fetches.
   - CONTRIBUTING.md:89 one-line `sessions.ts` summary.
   - CHANGELOG entry, including the `scope: "children"` value-set widening.
   - Field report addendum: the tool-surface asymmetry (ID delivered on
     success, withheld on cancel), recommendation 2 shipped, recommendation 3
     shipped in narrow form.

## Risks

- **`session.children` availability across opencode versions.** Older servers
  may not expose the endpoint; the SDK call errors. Mitigation: clean
  `ErrorOutput` — no silent fallback that could mask unavailability.
- **Scoped-client transport for foreign parents.** Decision 1 follows the
  repo-wide precedent (scoped client for all per-session calls, including
  cross-project ones), but `children` is a new endpoint and the directory
  header's effect on it is unverified. The tuistory pass explicitly tests an
  explicit foreign-directory parent; the both-fakes harness keeps a client
  switch cheap if the live test contradicts the precedent.
- **Suggestion churn.** The suppression conditions and the first-position
  insertion touch existing pinned suggestion tests
  (`test/recall.test.ts` list above) and compete for `MAX_SUGGESTIONS = 3`
  slots. The eval harness gates ranking, not suggestions, but the named unit
  tests do gate suggestions — run the full suite, not just the eval.
- **Partial staleness remains unhandled.** The zero-result trigger misses the
  more common shape: some in-window cards exist while newer sessions are
  missing. Known, accepted, and listed in Out of scope (recommendation 1 in
  full is the fix).

## Verification

- `npm run check` (format, lint, typecheck, tests, eval baseline, compile).
- The named unit suites above, including both `runToolRaw` host-bypass cases
  and the byte-identical guard test.
- Live end-to-end via tuistory (AGENTS.md recipe): spawn a session that
  launches a subagent, cancel it, then in the parent ask the agent to call
  `recall_sessions({ parentID: "current" })` and confirm the cancelled child
  is listed with its ID — the exact incident replay. Additionally probe an
  explicit foreign-directory parent to verify the scoped-client transport,
  and observe whether the endpoint returns descendants (the direct-child
  filter makes the contract hold either way).

## Out of scope

- Field-report recommendation 1 in full (unconditional live-DB union for all
  time-bounded listings) — only the narrow zero-result staleness fallback
  ships here, and the partial-staleness shape (fresh card masking missing
  sessions in the same scope, or a foreign-project card masking a
  project-scoped stale window on the suggestion side) is knowingly
  unaddressed by it.
- Recommendation 4 (indexing in-flight/cancelled sessions). The distiller's
  **incremental** trigger is `session.idle` plus compaction/removal events
  (`src/distill.ts:1132-1155`), and the cold pass sweeps independently —
  but a cancelled session may never emit idle, so its incremental indexing
  can lag until a cold pass. Fixing distiller triggers is a separate change;
  the `parentID` path makes recovery independent of it.
- Recommendation 5 (drill admitting uncarded sessions for bounded queries).
- Grandchild discovery (children of children).
- Any opencode-side change (e.g. including the session ID in the Task
  cancellation error) — worth filing upstream, not part of this plugin.

## Revisions

- **r2 (post-review round 1, 3 reviewers):** added the Decisions section
  (client, `global:false` policy, `scope:"children"`, `childCount`,
  `distilled` semantics, pipeline order, `note` ownership, staleness
  watermark). Corrected the false fixture claim, the overstated
  "no unbounded fetches" constraint, and the distiller trigger description.
  Specified the suggestion suppression mechanism. Rewrote the broken step-3
  sentence. Expanded the test plan with negative/boundary cases and named
  files.
- **r3 (post-review round 2):** reversed the client decision to the scoped
  `client` (repo-wide per-session precedent — `unscoped` would be a novel
  transport path; fakes stub both). Specified branch placement mechanics
  (inside the existing `try`, after the shared preamble; the global-disabled
  check gains a `!parentID` conjunct — no physical reordering). `distilled`
  re-keyed from `distilledThrough` to `distillState !== "full"` (empty-session
  edge), applied via call-site flag never inside `enrich()`, with a
  byte-identical guard test. Resolved the `"current"`-vs-`sameProject`
  interaction (resolved-ID exemption) and the absent-`ctx.directory` edge.
  Direct-child contract now enforced by filtering, not assumed. `childCount`
  pinned to post-filter pre-slice, excluding withheld rows. Documented the
  deliberate two-watermark asymmetry and the absent-`coverage.cards` guard.
  Staleness suggestion pinned to first among priority-0 adds (cap survival).
  Fallback note discloses its newest-`limit` bound. `ctx.metadata` titles for
  the children branch. Replaced the strict-mode claim with a direct
  `calls.messages` assertion.
- **r5 (post-implementation review, panel findings — all fixed):** the
  staleness-fallback `note` now branches on whether the live list produced
  in-window rows: rows present → the supported index-lag wording; zero rows →
  a fact-only quiet-window note ("No indexed session in scope is newer than
  `since`, so the newest N live sessions were checked; none fell in the
  window either") with no causal lag claim, pinned by a negative assertion.
  The bound wording gains a "matching" qualifier when `search` narrowed
  the list call. The children branch guards `result.data` with
  `Array.isArray` (divergent non-array payloads degrade to an empty list, not
  a TypeError), and the `"current"` sugar is case-insensitive. The
  sessions-side watermark skips summarizer worker cards, so a fresh worker
  card cannot mask real lag. CHANGELOG records the fallback's cost: one live
  `session.list` round-trip on a quiet `since` window where the call was
  previously fetch-free. Tests added for each, plus a blank/whitespace
  `parentID` raw-degrade case; the suppression assertion on the
  sessions-searched suggestion is pinned to its exact wording.
- **r4 (post-review round 3, zero blockers — clarifications only):**
  sessions-side watermark pinned to **all** in-scope cards regardless of
  `distillState` (a full-only watermark would collapse in cards-lite and fire
  the fallback on every `since` call), with a cards-lite no-fallback test.
  Staleness suggestion wording branches on `coverage.cards.degraded` (missing
  store ≠ index lag) and no longer offers "widen the window" (which cannot
  recover unindexed sessions); insertion pinned ahead of the `:1392` regex
  routing hint with an adversarial regex-query cap test. `FakeCalls.children`
  entries tagged `client: "scoped" | "unscoped"` with a scoped assertion;
  `childrenError`/`childrenThrows` fixture controls named. Inverted-window
  (`since > until`) fallback skip. `ctx.metadata` overwrite semantics
  (last-write-wins, N = `returned`), divergent throw-vs-error message shapes
  noted as intentional, `!parentID`-conjunct observable-effect test,
  `until`-only existing regression cited, README "arg table" → "tool
  documentation".
