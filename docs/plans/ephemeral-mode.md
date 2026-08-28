# Ephemeral mode: opt-in no-store operation

## Goal

Answer issue #4 ("no eager indexing, no artifacts on disk") with a config
option, `mode: "ephemeral"`, that deliberately runs the plugin on its
existing degraded cards-lite path: no SQLite store is opened, nothing is
written under `~/.cache/opencode-session-recall`, and no background
content indexing runs. Content search still works live through drill and
deep sweeps; only the pre-built content index is absent, and coverage says
so honestly.

This replaces an earlier plan that ran a bounded distiller against an
in-memory SQLite database. That approach was abandoned deliberately: nearly
all of its complexity (launch-frozen budgets, page allowances, chars
accounting) existed to keep an eager in-memory indexer from reproducing the
memory/CPU incident the persistent store was built to fix. This plan runs
no eager content work; the only startup network call is the one bounded
`session.list` (up to this plugin's `DISCOVERY_LIMIT`) that seeds
metadata cards — same as degraded mode today, and stated as such in the
issue reply.

## Constraints

- Zero disk artifacts in ephemeral mode. Two known write paths must both
  be closed:
  - the store: `defaultStorePath()` (which mkdirs the cache dir,
    `src/store.ts:933-942`) and `openSqlite`/`openStore` are never called;
  - the semantic embedder: model weights are cached under
    `~/.cache/opencode-session-recall/models/` by `SemanticEmbedder`
    (`src/semantic/embedder.ts:25`, mkdir+writeFile `:389-406`) eagerly at
    init (`src/opencode-session-recall.ts:191-208`), **before** the
    store-open block — so ephemeral mode force-disables `semantic` with a
    `pluginLog` note. (A cards-lite embed pass would be pointless anyway:
    lite cards have empty summary/files/inventory fields, so
    `embeddingTextOf` falls below `SUBSTANTIVE_FLOOR` and no lite card
    could ever get a vector.)
- No new paginated fetch sites. All paginated session-message scans ride
  the existing `fetchMessagePage` gate (`src/distill.ts:579`, re-exported
  by `src/fetch-window.ts`) — drill (`src/drill.ts:283`) and deep
  (`src/drill.ts:493`) already do. (Point reads via `session.message`,
  e.g. `recall_get`, are unaffected — the AGENTS.md rule is about
  unbounded message scans.)
- Persistent-mode behavior byte-identical when `mode` is absent or
  `"persistent"` — including when the store fails to open on its own
  (driver missing): that stays the existing degraded path with its
  existing wording. Ephemeral is signaled only by configuration, never
  inferred from `store === null`.
- The eval baseline must not move (ranking unchanged; every eval case
  passes `scope: "global"` explicitly, so the scope-default flip cannot
  reach them).
- Plugin options have no Zod schema and arrive as untyped JSON, so `mode`
  is hand-coerced like every other option in the entry file's coercion
  block. (The AGENTS.md host-drops-defaults gotcha applies to _tool args_
  — relevant to the scope-default tests below, not to `mode` itself.)

## Approach

1. **Config.** Add `mode?: "persistent" | "ephemeral"` to the `Options`
   type (`src/opencode-session-recall.ts:81-106`) and coerce it in the
   existing coercion block (`:109-114`): only the literal string
   `"ephemeral"` enables the mode; anything else is persistent. An
   unrecognized non-empty `mode` string logs one `pluginLog` line at init
   (the per-query warnings channel is tool-scoped and does not exist at
   plugin init). Interactions, each with a `pluginLog` note:
   - `storePath` set + ephemeral → ignored (ephemeral wins);
   - `semantic: true` + ephemeral → forced off (constraint above);
   - `summaries.enabled` + ephemeral → inert (already gated on `store`
     at `:304`);
   - `compactionRecall: true` + ephemeral → **inert**: the hook reads the
     store directly (`deps.store?.getCard`,
     `src/hooks/compaction-recall.ts:64`) and is a permanent no-op
     without one. Wiring it to cards-lite would not help — its
     preservation block builds from summary/inventory fields that are
     empty on lite cards. Documented as unavailable in ephemeral mode.

2. **Skip the store open.** Guard the whole open sequence at
   `src/opencode-session-recall.ts:226-232` — including the
   `defaultStorePath()` call at `:226` — with the mode flag; leave
   `db`/`store` null. Downstream null branches then do most of the work:
   - cards-lite `CardSource` with `degraded: true` (`:245`) filled by
     `discover()` → `cardsLiteFromSessions` (`:246-257`,
     `src/cards.ts:276-315`);
   - `createDistiller` returns its all-no-op object when `options.store`
     is falsy (`src/distill.ts:636-645`) — no cold pass, no lease, no
     heartbeat;
   - summarizer never created (`:304`); sessions enrichment absent
     (`:340-342`);
   - tier-1.5 slim-FTS candidates skipped (`src/search.ts:2593`).

3. **Cards-lite refresh (new, ephemeral-only).** The existing lite source
   is a frozen one-shot snapshot: `discover()` runs once at init, and
   `revision: () => undefined` means `refreshIfStale`
   (`src/cards.ts:474-487`) never rebuilds — so sessions created after
   plugin init are invisible forever, and a query that races init can
   snapshot an empty card set. Tolerable as an accident path; not as an
   advertised mode. Design (pinned after three review rounds; the panel
   rejected an earlier draft that both bumped a `revision()` stamp _and_
   called `invalidate()` — two rebuild triggers with different timing —
   while claiming pure getters. r4 resolves to **one mechanism, the
   controller**, and `revision()` stays a genuine pure getter):
   - **A refresh controller in its own module** (e.g.
     `src/lite-refresh.ts`), constructed by the entry file, testable as a
     unit (this is deliberate: entry-file-inline state would force
     refresh tests through the whole plugin `server(...)`, and a
     test-local reimplementation would test a copy instead of the real
     machine). It owns `lastAttemptAt` and the single-flight promise, and
     exposes `maybeRefresh()`.
   - **Trigger:** `search.execute` and `cardRecall` call
     `maybeRefresh()` once at query entry (via a deps hook),
     **fire-and-forget**; the triggering query proceeds on the current
     snapshot. `maybeRefresh` no-ops unless the refresh window (60s) has
     elapsed since the last attempt — the empty-card-set case is subsumed
     by the same window (a never-attempted controller always fires;
     failed/empty attempts back off exactly one window). Accepted
     consequence: a failed init discover leaves an empty card set until
     the next window, ~60s worst case after a start where the server
     wasn't ready.
   - **Completion:** on a successful list, assign `liteCards`, then call
     `CardsRuntime.invalidate()` (`src/cards.ts:202`, `:671` — exists
     today with zero callers; its "for tests" comment gets updated since
     this makes it production behavior). `invalidate()` sets
     `loaded = false`, so the **first subsequent card access rebuilds
     immediately**, bypassing the runtime's 5s `refreshIntervalMs` gate
     (`REFRESH_INTERVAL_MS`, `src/cards.ts:32`, resolved at `:355`).
   - **Contract, stated exactly:** the triggering query uses the old
     snapshot; new sessions are visible on the first query after the
     discover resolves (bound = discover latency, no fixed 5s constant).
     Failed or empty discovers retry no sooner than the next window.
     Worst case for the empty-race path is one discover round-trip of
     empty results, then self-heal — never permanent.
   - **Single-flight:** the init discover and any refresh share one
     in-flight promise; concurrent stale queries must not fan out
     duplicate `session.list` calls.
   - **Gated + tracked:** the refresh list call runs through
     `gate.runQuery` (unlike the one-shot init call, it shares the query
     path with in-flight drill fetches and must respect
     `limits.concurrency`, `:259-261`), is `track()`ed and
     disposed-guarded like the init discover (`:247-256`). Construction
     ordering note: the lite `CardSource` literal (`:237-245`) is built
     before `createFetchGate` (`:261`), so the controller resolves `gate`
     lazily in its closure — do not reorder the blocks (TDZ trap).
   - **Failure/empty handling:** on failure, keep previous cards, bump
     only `lastAttemptAt`, retry no sooner than the refresh window
     (backoff = the window itself; no hammering). A genuinely empty
     server (zero sessions) re-lists at most once per window — bounded,
     accepted, and stated here so it reads as a decision.
   - Persistent path untouched: its source has a real store-backed
     revision already; the lite source's `revision()` can remain
     `() => undefined` since `invalidate()` is now the sole rebuild
     signal.

4. **Mode plumbing.** A static `mode?: "ephemeral"` field on `SearchDeps`
   (`src/search.ts:63-73`), set at deps construction in the entry file,
   and added to the deps destructuring at `search.ts:1700`
   (`{ cards, drill, store, gate }` today — steps 5-7 all read it).
   Never derived from `store === null`. The field is optional, so
   existing construction sites (`test/eval/harness.ts:160` and `:195`,
   `test/helpers.ts`, `test/recall.test.ts:1486`) compile unchanged —
   only sites that want ephemeral behavior are touched, and
   `makeDegradedEvalSearch` (`harness.ts:195`) deliberately stays
   mode-less: it models driver-missing degradation and must keep
   protecting that path.

5. **Coverage + wording.** Add a **top-level** `mode?: "ephemeral"` to
   `SearchCoverage` (`src/types.ts`, near `:108` — not nested under
   `cards`), filled at the single construction site in
   `buildOutputContext` (`src/search.ts:2764-2784`). When — and only
   when — `deps.mode` is set, reword two sites:
   - the generic degraded warning (`src/search.ts:2725-2728`);
   - the degraded sub-branch of the **stale-time-window suggestion**
     (`:1414-1420` — precisely: it is gated by `staleWindow`,
     `:1408-1413`, which requires a time lower bound AND
     `sessionsEligible === 0` AND `after > storeRecency`; there is no
     general no-index message). In ephemeral mode `storeRecency` is
     always 0 (`coverage()` advances it only for full cards,
     `src/cards.ts:642-649`), but lite cards carry real `timeUpdated`
     values, so an in-window `since` usually matches eligible cards and
     the branch does **not** fire routinely — it fires exactly when the
     snapshot has not caught up to the queried window (the refresh-lag
     case step 3 exists for). Reworded for that meaning: "no persistent
     index by configuration — content matches come from live drill; for
     very recent sessions, list with `recall_sessions` and name them via
     `sessions: [...]`".
     The driver-missing degraded path keeps its current wording
     byte-identical (the eval asserts `/metadata-only|degraded/i`; the new
     wording intentionally does not match that regex, and the new coverage
     test must not reuse it). `cards.degraded` stays `true` — accurate.
     The cards block in ephemeral coverage reads
     `{ total: N, full: 0, storeRecency: 0 }`; the interpretation note
     ("full: 0 / storeRecency: 0 is the configured state, not an empty
     history") lives in the **tool description** (step 6), stated once —
     not repeated in per-query warnings, which stay short.
     `recall_sessions`/`recall_get`/`recall_context`/`recall_messages` are
     **explicitly out of scope** for the marker: they are live fetches
     already, and `recall_sessions`' existing no-store caveat behavior is
     unchanged.

6. **Tool description.** One mode-aware line in the static description
   template (`src/search.ts:1702-1714`): states the configured ephemeral
   mode, recommends drill/`deep`/named sessions for content recall, and
   **states that the default scope is project** — so the model treats
   `limitedBy: ["scope"]` on defaulted queries as configured behavior,
   not damage to fix by reflexively re-querying `scope: "global"`
   (which would double the cost of the mode whose point is cost).

7. **Default scope flip (severable) — without breaking deep-gate
   explicitness.** In ephemeral mode, default `scope` to `"project"`:
   metadata-only ranking over a many-thousand-session global corpus is
   noise. The panel surfaced two traps, resolved as follows:
   - **A schema `.default("project")` would destroy explicitness
     detection**: parsed callers would receive `args.scope === "project"`
     even when the user omitted it, making an omitted scope
     indistinguishable from an explicit one (and `runTool` in tests
     parses schemas, so tests would diverge from raw-host behavior). So
     in ephemeral mode the scope schema is
     `tool.schema.enum([...]).optional()` — **explicitly `.optional()`,
     not merely default-less**: a bare enum is _required_ in Zod, the
     host does validate (it discards the parsed result but runs the
     schema), and a required `scope` would fail omitted calls and
     publish `scope` as required in the model-facing JSON schema,
     nullifying the runtime default entirely. (`sessionID`/`title`/
     `directory` at `search.ts:1730`/`:1772`/`:1786` are the existing
     `.optional()` pattern.) The runtime `pickEnum` fallback then
     resolves `undefined → "project"` — concretely, the `"global"`
     literal at `src/search.ts:1862` becomes
     `deps.mode ? "project" : "global"` — and the description documents
     the default. `args.scope === undefined` reliably means "not
     supplied" under both parsed and raw execution; persistent mode
     keeps `.default("global")` untouched.
   - **The deep gate keys on explicit constraints, unconditionally** (not
     mode-conditionally): the project constraint counts only when an
     explicitly supplied, **project-valued** constraint exists
     (`args.scope === "project"` or `"session"` supplied by the caller,
     `args.project === true`, `args.sessions`, or a directory filter —
     an explicit `scope: "global"` naturally does not qualify). In
     persistent mode this is provably byte-identical — the global schema
     default means resolved `"project"` only ever arises from explicit
     args today — and an unconditional gate removes a mode branch from
     security-adjacent logic (a mode-conditional gate is where a future
     refactor would reintroduce the loosening). **Implementation
     invariant:** this is a _fork_, not a redefinition — introduce a
     separate `explicitProjectScope` used **only** by the deep gate
     (`:2085-2100`); `projectScope` at `:2067` and everything downstream
     of the _resolved_ scope (`bucketDirectory` `:2069`, tier-1
     bucketing `:2514`/`:2531-2537`) keep the resolved value, which is
     the only thing that makes the flip do anything. Redefining
     `projectScope` itself would be invisible in persistent tests while
     silently reducing this whole step to a no-op. A defaulted-scope
     `deep` call is rejected in both modes, same message.
     Persistent-mode gate behavior is pinned by regression test.
   - Coverage side effect, named: with the project default resolved,
     defaulted ephemeral queries report `limitedBy: ["scope"]` (`:2515`)
     whenever a usable project directory exists, and
     `skippedByReason.directory` when global-relevance cards were
     actually filtered (`:2531-2537` — conditional, not universal) —
     accurate (cards really were dropped) and deliberate; the
     description line (step 6) exists so the model reads it correctly. Also pinned by
     test: when `ctx.directory` is absent, the project default degrades
     toward global (`:2069`, `:2514`) — unchanged, only the default
     label moves. Explicit `scope: "global"` always works. This whole
     step is severable if it proves contentious.

8. **Docs + issue reply.** README config section documents `mode`, its
   trade-offs, and migration:
   - metadata-quality ranking + live drill instead of an index;
   - **cost shape, stated accurately**: persistent mode pays content
     indexing once in the background; ephemeral pays for content at
     query time — with no slim-FTS anchors (`search.ts:2593`), drill
     falls back to untargeted newest-first paging
     (`src/drill.ts:277-299`) across up to `drillSessions` sessions per
     `recall` query. The hooks do **not** fetch messages in any mode:
     `autoRecall` is card-tier only (`src/hooks/auto-recall.ts:166-171`,
     "no drill, no message fetch") — its only ephemeral cost is that
     ranking may trigger the bounded 60s-windowed metadata refresh
     (step 3) — and `compactionRecall` is inert without a store
     (step 1);
   - switching an existing install to ephemeral leaves the old store
     file and any orphaned `[recall-summarizer]` worker sessions behind
     (ephemeral never holds the lease that sweeps them) — delete
     `~/.cache/opencode-session-recall/` manually;
   - `storePath` on a tmpfs/ramdisk as the alternative for full search
     quality without persistent disk artifacts.
     Reply on issue #4 offering the knob, honestly noting the one startup
     `session.list` call.

## Risks

- **Users enable it expecting full-quality search.** Mitigated by the
  coverage marker, honest wording, and the README trade-off note.
  Ephemeral ranking quality is **deliberately ungated** by the eval
  baseline (which measures the store-backed tool only); the degraded eval
  case is a smoke floor, not a quality gate, and the plan states that
  rather than pretending otherwise.
- **Per-query cost is higher than persistent mode.** Bounded (drill
  session/page caps, gated refresh) but recurring; named accurately in
  README (step 8).
- **Config typo silently lands in persistent mode.** Accepted: persistent
  is the safe default; the init `pluginLog` line is the tell.
- **Scope flip surprises an ephemeral user with global habits.** The
  description states the flipped default; explicit `scope` always wins;
  the deep gate is unchanged in strictness (step 7).

## Verification

- `npm run check` green; eval baseline untouched.
- Test infrastructure: `test/helpers.ts`' `makeRecallDeps` is
  unconditionally store-backed (throws when `openSqlite`/`openStore`
  fail, `:824-826`), so ephemeral search/coverage/scope tests get a
  **new store-null deps builder** with the lite source and `mode` set.
  The refresh state machine is **not** re-implemented in test helpers:
  it lives in its own module (step 3) and its unit tests construct the
  real controller with an injected clock and a fake list function —
  `cardsNow`/`cardsRefreshIntervalMs` (`:818-819`) only drive the
  `CardsRuntime` side (the `invalidate()`-triggered rebuild), not the
  controller's window state. `makeDegradedEvalSearch` stays mode-less
  (step 4).
- New tests:
  - **Plugin-level mode coercion** (in `test/plugin.test.ts`, via the
    plugin `server(...)` construction helper — `runToolRaw` cannot test
    plugin options): `mode` absent / `"persistent"` / `"ephemeral"` /
    junk string / non-string, asserting store-open behavior for each.
  - **No-artifact proof, both variants** (the sqlite module is already
    mocked in `plugin.test.ts:16-43`, so the spy pattern exists):
    (a) ephemeral with **no** `storePath` → `defaultStorePath` and
    `openSqlite` never invoked; (b) ephemeral with a sentinel temp-dir
    `storePath` → nothing created there; (c) ephemeral +
    `semantic: true` → the mocked embedder constructor and `init()` are
    never invoked — the existing mock (`plugin.test.ts:47-57`) is a
    plain class with no call record, so it gains a `vi.fn()` (or
    module-scoped counter) first; asserting on filesystem absence would
    be vacuous under module mocking. The live tuistory pass provides the
    real-filesystem confirmation.
  - **No background content work**: ephemeral + `coldPass: true` +
    `summaries.enabled: true` → beyond the permitted metadata
    `session.list`, **no distiller-initiated message fetches** at
    startup or after a session event (phrased that way deliberately —
    drill legitimately calls `session.messages` with a limit during
    queries); no summarizer sessions; clean dispose.
  - **Cards-lite refresh** (real controller unit + injected clock/list
    fn): a session created after init becomes visible on the first query
    after the discover resolves (not same-query; and a successful
    refresh followed by an immediate query sees the new cards — pinning
    that `invalidate()` really bypasses the 5s runtime gate); concurrent
    stale queries produce exactly one `session.list` (single-flight);
    failed refresh keeps previous cards and retries only after the
    window; empty-server discovery does not hammer (≤ one list per
    window); dispose while a refresh is in flight is clean; the
    `autoRecall` hook path triggers at most one list per window.
  - **Coverage marker + wording**: `coverage.mode === "ephemeral"`,
    configured-not-broken wording (asserted with its own regex, not the
    eval's `/metadata-only|degraded/i`); driver-missing degraded path
    byte-identical wording (regression pin).
  - **Scope decision paths** (`runToolRaw` where host-bypass matters):
    ephemeral raw missing scope → project; ephemeral parsed
    (`.optional()` schema, no default) → project via runtime fallback,
    and an omitted scope passes validation; raw junk
    scope warns and falls back to project; explicit `scope: "global"`
    honored; persistent mode — including store-null degraded — still
    defaults global; `deep` without explicit scope rejected in **both**
    modes (the unconditional gate), persistent gate behavior pinned;
    no-`ctx.directory` behavior pinned.
  - **Drill-in-ephemeral** under a strict no-limit suite
    (`setStrictNoLimitMessages(true)`): content hit via live drill with
    no store, proving the fetch gate holds.
  - **Description budget**: the existing size gate
    (`plugin.test.ts:213-226`) gains an ephemeral-construction variant so
    the mode-aware description line is measured too.
- Live tuistory pass: scratch opencode config with `mode: "ephemeral"`
  and an isolated `HOME` (or pre/post directory snapshot — an existing
  cache dir makes "untouched" ambiguous), verify recall works,
  `~/.cache/opencode-session-recall` untouched including `models/`,
  restart clean.

## Out of scope

- Any eager or bounded in-memory content indexing (the abandoned prior
  approach).
- Ranking changes: cards-lite metadata ranking is used as-is, ungated by
  the eval baseline (stated in Risks).
- Summaries and sessions enrichment in ephemeral mode — naturally absent
  with the store, deliberately not reintroduced. Persisted embeddings
  likewise; the embedder itself is force-disabled (Constraints).
- `autoRecall` behavior changes: it ranks cards without a project filter
  (`src/hooks/auto-recall.ts:166-171`) and works unchanged over
  cards-lite; it fetches no messages in any mode. `compactionRecall` is
  **inert** in ephemeral mode (store read; step 1) — documented, not
  worked around.
- The relationship to `coldPass: false`: that knob suppresses
  `distiller.start()` (`:335`) but still creates the cache dir and store
  file — it is not ephemeral mode, and the README says so in one line.
- Naming: "ephemeral" already appears in internal vocabulary for the
  cards-lite path (`test/eval/harness.ts:177-182`, entry comment
  `:224`) — checked, consistent, deliberately reused.

## Revisions

- **r2 (post-panel round 1):** Semantic embedder identified by all three
  reviewers as a zero-artifact violation → force-disabled with `pluginLog`
  (Constraints, step 1). Mode plumbing made explicit: `SearchDeps.mode`,
  never inferred from `store === null` (step 4). Cards-lite
  frozen-snapshot problem → lazy query-driven refresh (step 3). Deep-gate
  loosening from the scope flip flagged (step 7). Mode coercion test
  moved from `runToolRaw` to plugin-level construction tests;
  no-artifact test strengthened; background-work and refresh tests
  added. Warning mechanism corrected to `pluginLog`. Cost trade-off,
  migration guidance, eager-list honesty, eval-ungated statement,
  `coldPass` disambiguation, `storePath` precedence, summaries-inert
  log, top-level coverage field, description budget variant,
  wording-regex independence added.
- **r3 (post-panel round 2):** Hook claims corrected — they were
  backwards: `compactionRecall` reads the store directly and is
  **inert** in ephemeral (now a step-1 interaction with `pluginLog`);
  `autoRecall` never fetches messages in any mode; the per-query cost
  note rewritten around what actually drills (the `recall` tool's
  anchor-less fallback paging) plus the refresh-list cost autoRecall can
  trigger. Refresh design pinned (all three reviewers): entry-file-owned
  fire-and-forget via `CardsRuntime.invalidate()`, single-flight shared
  with init, separate `discoverStamp`/`lastAttemptAt`, stringified
  revision, stamp-after-assignment ordering, `gate.runQuery` +
  `track()`/dispose guards, window-length backoff, empty-server
  acceptance, eventual-consistency contract (~5s worst case for the
  empty race) with tests for single-flight/failure/dispose. Deep gate
  redesigned per gpt5+fable: **no schema scope default in ephemeral**
  (schema default would materialize and destroy explicitness detection;
  runtime fallback resolves undefined → project) and the explicit-only
  gate made **unconditional** (byte-identical in persistent, no mode
  branch in security-adjacent logic). `limitedBy: ["scope"]` /
  `skippedByReason.directory` coverage side effect named and pinned;
  description states the default so the model doesn't re-query global.
  `storeRecency`-always-0 consequence named: the stale-window branch is
  the routine ephemeral answer; cards-block interpretation note added.
  Harness split: `makeDegradedEvalSearch` stays mode-less; new
  store-null deps builder in helpers (existing `makeRecallDeps` throws
  without a store). Semantic no-artifact test asserts on the mocked
  embedder spy, not vacuous filesystem checks; live pass isolates
  `HOME`. Background-work assertion rephrased to distiller-initiated
  fetches. `test/recall.test.ts:1486` construction site noted; naming
  overlap recorded as checked.
- **r4 (post-panel round 3):** Ephemeral scope schema made explicitly
  `.optional()` (panel blocker: a default-less bare enum is _required_
  in Zod — the host validates even though it discards the parse — so
  omitted calls would fail and the model-facing schema would demand
  `scope`, nullifying the runtime default); `pickEnum` fallback named
  concretely (`search.ts:1862` literal becomes mode-dependent).
  Refresh design de-contradicted (all three reviewers): the dual
  mechanism (stamp-revision AND `invalidate()`) collapsed to
  **controller + `invalidate()` only** — a separate testable module
  owning `lastAttemptAt`/single-flight, `maybeRefresh()` called
  fire-and-forget at query entry, `invalidate()` on completion
  bypassing the 5s gate; timing contract restated exactly (visible on
  first query after discover resolves; failed/empty retries
  window-bounded); `revision()` stays `() => undefined`; the
  "getters stay pure" claim is now true; TDZ ordering note for the
  lazily resolved gate; `invalidate()`'s "for tests" comment updated.
  Deep-gate fork invariant named (separate `explicitProjectScope` for
  the gate only; `projectScope` and resolved-scope consumers
  unchanged — redefinition would silently no-op the flip), and the
  explicit constraint restricted to project-valued args. Stale-window
  firing condition corrected (fable: requires `sessionsEligible === 0`
  and `after > storeRecency`; lite cards carry real `timeUpdated`, so
  it fires on snapshot-lag, not routinely) and the wording reframed for
  that meaning. `skippedByReason.directory` made conditional in the
  coverage side-effect note. Cards-block interpretation note moved from
  per-query warning to the tool description (warning prose diet).
  Refresh tests retargeted at the real controller unit (not a helper
  reimplementation; `cardsNow` drives only the runtime side), plus the
  immediate-visibility and autoRecall-trigger assertions. Embedder mock
  spy-ification noted (`plugin.test.ts:47-57` has no call record).
  Deps destructuring at `search.ts:1700` named. `REFRESH_INTERVAL_MS`
  citation corrected (`cards.ts:32`, resolved at `:355`).
- **r5 (post-code-review reconciliation):** Step-3 trigger sentence aligned
  with the implemented/tested behavior — the empty-set clause is subsumed by
  the window backoff, and the failed-init consequence (empty set for up to
  one window) is stated as accepted.
