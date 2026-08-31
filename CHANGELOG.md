# Changelog

All notable changes to this project are documented here. This project follows
[Conventional Commits](https://www.conventionalcommits.org/) and
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- **`authorship` filter on `recall`**: ask for what a human actually typed.
  `role: "user"` is a transport fact, not an authorship one — a survey of this
  machine's corpus (`docs/surveys/user-role-authorship.sql`) found only ~51% of
  user-role text was typed by a person; ~37% is orchestrator-authored prompts
  inside subagent sessions, plus host/tool injection and TUI status blocks.
  Candidates now classify as `human`, `delegated`, `injected`, `model`,
  `title`, or `unknown` from structural signals only (message role, part flags,
  session parentage, part type), and `authorship` selects any of them or an
  array of them. Narrowing to `human` also restricts normal ranked selection to
  root sessions on both the card and FTS paths, so child sessions stop
  consuming drill budget; explicitly named sessions and deep sweeps are exempt.
  Unresolvable parentage classifies `unknown` and is withheld from `human`
  rather than assumed — the filter fails closed. Results carry
  `why.authorship`, and `coverage` reports `limitedBy: ["authorship"]` plus
  `skippedByReason.authorship`, all only when the filter is active or
  `explain: true`, so default responses are unchanged.

## 2.3.0

### Added

- **`mode: "ephemeral"` option** (issue #4): run with no store and no on-disk
  artifacts — no SQLite file, nothing under `~/.cache/opencode-session-recall`,
  no background content indexing. Ranking is metadata-quality over live session
  listings (refreshed lazily, at most once per 60s window); content search
  still works through the bounded live drill and deep paths. Semantic,
  summaries, `compactionRecall`, and sessions enrichment are unavailable in
  this mode, the default scope flips to `"project"` (explicit
  `scope: "global"` still works), and `coverage.mode` reports `"ephemeral"`.
  Persistent-mode behavior is unchanged.

## 2.2.0

Based on PR #3 by @kernel-oops with maintainer fixes.

### Fixed (explicit `sessions` shortlist)

- **An explicitly named session with no card is now searched.** `recall` with a
  `sessions: [...]` shortlist previously resolved targets only through the card
  store, so a session the distiller had not carded yet (a young or just-finished
  session — e.g. a subagent that ended moments ago) silently vanished and the
  response reported `sessionsEligible: 0`. Both shortlist branches (non-deep and
  `deep: true`) now append the uncarded ids as direct drill targets. Uncarded-ness
  is decided against the same cards-facade snapshot the carded filter reads, so a
  session carded milliseconds ago (store has it, ≤5s-stale snapshot does not) is
  still drilled rather than falling between the two views.
- **Uncarded shortlist ids get a live metadata probe.** Probes run lazily in
  small parallel chunks and stop once the session cap is filled, so a long
  shortlist with a small `sessionLimit` never fans out a probe per id. On
  success: a summarizer worker title excludes the id entirely (closing a content
  leak — a worker's prompt/reply is plain text the part-level filters do not
  catch), `before`/`after` bounds apply against the session's `time.updated`
  (previously a young session could satisfy a `before: <90 days ago>` bound),
  and the target carries its real title/directory. A failed scoped probe retries
  once on the unscoped client (workers and cross-project sessions live there);
  only when both fail is the id drilled unverified with selection bounds
  bypassed — and the warning says so. The `title` filter never applies to
  uncarded ids. `excludeSessionID` skips an uncarded id; the current session is
  skipped only on an EXPLICIT `excludeCurrentSession: true` (the implicit
  broad-discovery default does not drop a session the caller named by id).
- **Deep resume honors the same guards.** A `deepCursor` resume that readmits
  uncarded ids via a repeated `sessions: [...]` arg routes them through the
  identical probe/worker-exclusion/bounds path instead of sweeping them
  unguarded.
- **`sessions` is capped at 100 ids** (schema max plus a defensive clamp with a
  warning on the Zod-bypass host path).
- **Coverage semantics:** uncarded shortlist members count toward
  `sessionsEligible` (carded members that pass filters + uncarded ids admitted
  or cap-deferred). The session cap fills carded-first; uncarded ids rank last.
- **New warnings:**
  - `N session id(s) in the shortlist has/have no card visible to this search yet
(not yet indexed, or the index snapshot lags); it was/they were selected for
direct drilling.` — with a suffix `M could not be verified (metadata fetch
failed), so selection time bounds were not applied.` when both probes failed.
  - `N named session id(s) was/were not searched: the session cap was reached.`
    — when the cap truncates uncarded ids.
  - The deep-resume drop warning now suggests repeating `sessions: [...]`
    alongside the cursor, since an untrusted cursor alone readmits only ids the
    card store knows (also documented on the `deepCursor` arg, in the
    `nextCursor` type contract, and in the README).

### Added

- **Bounded shutdown via the optional `dispose` hook.** On hosts that call
  `dispose` (recent opencode versions), the plugin now shuts down in two phases:
  an immediate quiesce (no new distill/summary/hook work starts) followed by a
  bounded drain of in-flight work before SQLite closes. Every wait is
  timeout-capped — a never-settling SDK request is detached, not awaited
  forever — so plugin disposal can never hang the host's shutdown. Detached
  distiller work is fenced by stop/finalize/lease guards and cannot touch the
  closed store; if a foreground tool execution has not settled within the
  bound, the store handle is deliberately left open (the process is exiting
  and the store is derived/rebuildable) rather than risking a use-after-close.
  There is **no new host requirement**: older hosts simply never call
  `dispose` and the plugin behaves exactly as before (no `engines` constraint
  was added).
- **Cold-pass quarantine for malformed legacy sessions.** A session whose
  message payload is structurally malformed (non-array body, unwalkable parts)
  is sidelined for that `timeUpdated` and logged instead of aborting the whole
  pass; it is retried automatically when the session changes and is dropped
  from quarantine on deletion. The quarantine catches only data-shape errors —
  a distiller regression still surfaces as a pass failure. `status()` exposes
  `quarantinedCount`.
- **Transport-vs-absence distinction in the incremental path.** A failed
  session-metadata fetch is now a logged, retryable transport error rather
  than being conflated with "session gone", so a flaky server no longer makes
  the distiller silently skip re-distills.

### Fixed

- **Stale-writer window closed.** Every distiller store write (full/append/
  cold-pass replaces, rollups, deletes, the cold-pass progress cursor) now
  re-verifies authoritative lease ownership against the live lease row
  immediately before the write, so a
  process suspended past the lease TTL cannot clobber the new holder's rows
  when its paused fetch resumes. The self-check demotes only when another
  holder's name is on the row — an expired-looking own heartbeat is not a
  loss, so a long event-loop hiccup no longer costs a lease-retry stall.
- **Summarizer worker handoff safety.** Worker sessions are title-stamped with
  their owner instance; normal cleanup only ever targets workers this instance
  created, and orphan sweeps (other holders' leftovers) stay lease-gated.
  Deleting/aborting a worker this instance owns is deliberately NOT
  lease-gated — losing the writer lease mid-batch no longer leaks the worker
  session. Worker ids are released from the owned set once cleanup completes.
- **No tool-contract change:** `fetchMessagePage` stays lenient on the query
  path — a successful response without an array body is still an empty page
  (`ok: true`) for `recall_messages`/`recall_context`/`recall_get`/drill.
  Only the distiller opts into strict mode (where a non-array body must be
  distinguishable from an empty session for quarantine).

## 2.1.0

### Added

- **`recall_sessions` gains a `parentID` arg** for subagent recovery: a live,
  index-free listing of a parent session's direct children, with
  `parentID: "current"` as sugar for the calling session. Built for the
  "Task cancelled with no task_id" workflow — cancelled or in-flight subagents
  are listed even before the search index has seen them. The children response
  uses `scope: "children"` (a widening of the output `scope` field's value set,
  which previously only held `"project"`/`"global"`; discriminate on it — a
  malformed non-string `parentID` degrades to an ordinary listing) plus a
  `parentID` echo and a `childCount` (post-filter, pre-slice; greater than
  `returned` means `limit` truncated). Rows not yet distilled to content carry
  `distilled: false`.
- **Staleness fallback in `recall_sessions`:** a `since`-filtered listing that
  selects zero sessions while `since` is newer than the newest in-scope indexed
  session now falls back to the live session list for that window (with a
  disclosing `note`) instead of returning an empty card-index answer. Cost, on
  the record: a `since`-filtered call on a quiet window now performs one live
  `session.list` round-trip where it was previously fetch-free; all other
  time-filtered calls stay card-only.
- **Subagent-recovery hint in the system nudge:** the `nudge` line now also
  tells the agent to list a cancelled or interrupted subagent's child sessions
  with `recall_sessions({ parentID: "current" })` when a Task returned no
  `task_id` — the moment that hint is needed, the Task error payload carries
  nothing and tool descriptions are easy to skim past, but the system prompt is
  always in view. Adds ~45 tokens to the nudge (~130 total per request).
- **Staleness suggestion in `recall`:** a zero-eligible search whose lower time
  bound is newer than the index's recency now leads with a suggestion that the
  index has not caught up (pointing at `recall_sessions` and the
  `parentID: "current"` recovery call), instead of the misleading generic
  broaden-your-query hints, which are suppressed in that state.

## 2.0.0

This is the architecture rewrite. Through 0.12.x, `recall` answered a query by
fetching session history over the SDK into process memory and scanning it there.
That search was complete, but its cost scaled with the size of your history: on a
real store (about 4,700 sessions, 2.76GB of parts) a broad "how did we do X
before" query climbed into multiple gigabytes of memory and ran for minutes, and
two such queries became live incidents. 2.0 inverts the model. A background
distiller builds a small derived index (per-session cards, a slim full-text index
over the human layer, optional semantic vectors and LLM summaries) in a local
SQLite file; a query ranks cards in milliseconds, checks the index for an exact
identifier, then drills only the top handful of sessions through bounded paginated
fetches. The retrieval contract changed with it, from exhaustive scanning to
bounded precision-first retrieval with honest coverage reporting, so several tool
signatures and the search output shape changed. The store is derived and safe to
delete; opencode's database stays the sole source of truth, reached only through
the SDK.

### Breaking

- **`recall_messages` is cursor-paginated.** The `offset`, `reverse`, and `total`
  fields are gone. Pass `cursor` from a prior page's `nextCursor` to walk further
  back; the response carries `pagination: { limit, returned, hasMore, nextCursor }`.
  Every page is a bounded newest-first fetch, so browsing a huge session no longer
  reads it whole.
- **The `sessions` recall argument is renamed `sessionLimit`.** The numeric cap on
  how many sessions a query drills into is now `sessionLimit` (still bounded by the
  `maxSessions` option). `sessions` is repurposed as an explicit session-id array:
  without `deep`, drill exactly those; with `deep`, the sweep scope.
- **Regular search no longer sweeps tool outputs across all history.** Outputs are
  searched inside the sessions a query drills into; a global output sweep is now an
  explicit, scope-required `deep: true` mode (see Added). Conversation text,
  reasoning, tool-input commands, and titles are still searched across all history.
- **Global- and project-scope searches exclude the current session by default,**
  along with its subagent family. The asking conversation repeats the query terms
  and used to win its own "how did we do this before" search. Pass
  `excludeCurrentSession: false` (or `scope: "session"`) to include it;
  `excludeSessionID` excludes any one session by id.
- **Search output shape.** Coverage gained `cards`, `semantic`, and `deep` blocks
  and a top-level `nextCursor` for deep continuation. The earlier consolidation
  still holds: top-level `scanned` / `loadErrorCount` / `loadErrors` are folded into
  `coverage` (`sessionsSearched`, `loadErrors: { count, samples }`), result-level
  `directoryRelevance` lives only under `why`, and `degradeKind: "budget"` is gone.

### Added

- **Distill-then-search pipeline and derived store.** A background distiller reads
  history once through the SDK and writes a versioned SQLite store
  (`~/.cache/opencode-session-recall/store-v1.db`): one card per session plus a slim
  FTS index over the human layer (conversation, reasoning, tool-input commands,
  titles). The first cold pass walks every session and checkpoints as it goes;
  opencode's idle events drive incremental updates after that. The store uses the
  runtime's built-in SQLite (`bun:sqlite`, `node:sqlite` for tests), so it adds no
  npm dependency, and degrades to in-memory metadata cards when no driver is present.
- **Deep mode.** `deep: true` sweeps every part of a scoped session set, tool
  outputs included, for a needle no card or slim-index row points at. It requires
  scope (a `sessions` list, or a lower time bound plus a project/directory filter); a
  global unscoped deep is rejected. It runs under char and wall-clock budgets and
  returns a `nextCursor` you pass back as `deepCursor` to resume where coverage
  stopped. `coverage.deep` reports sessions covered, partial, and remaining.
- **`project` filter.** `recall`'s new `project` argument scopes to the current
  project (`true`) or to a named project directory (a path), alongside the existing
  `directory` filter.
- **`recall_sessions` enrichment.** When a distilled card exists for a listed
  session, its entry gains a content `digest`, its top `files` and `tools`, and a
  `family` rollup (child count) for root sessions. New `since` / `until` arguments
  filter by last-updated time, resolved from the recency-complete cards when a store
  is present.
- **Opt-in local semantic layer.** `semantic: true` blends cosine similarity from
  local static embeddings into card ranking. Vectors embed a natural-language
  projection of each card (identifiers split into words), persist lazily with a
  representation generation, reserve `semanticSlots` (default 2) drill slots for the
  top pure-semantic cards, and rescue a semantically-surfaced session that yields no
  lexical hit. A substantive-content floor denies a vector to content-free cards so
  they cannot become project-identity attractors. `coverage.semantic` reports
  readiness, model, weight, vector count, contribution, and the `representation` /
  `pluginVersion` diagnostics. Options: `semantic`, `semanticWeight`,
  `semanticModel`, `semanticSlots`.
- **Opt-in LLM card summaries.** A new `summaries` option runs your own cheap model
  over card fields to write a short summary per session, then folds it into the
  lexical card index, the semantic embedding text, the `recall_sessions` digest, and
  the proactive-hook payloads. It spends your tokens and is off by default; configure
  it as `{ enabled, model, agent?, maxPromptsPerPass? }`. Cost is bounded by
  construction: a throwaway worker session per batch, one prompt in flight, a
  content-hash skip, a per-pass prompt budget, a per-prompt timeout, and a
  consecutive-failure latch. Point `agent` at a deny-all opencode agent for an
  enforced tool block.
- **Multi-process safety.** Several opencode processes share one store safely. A
  schema stamp fences out a build that would misread the format (a newer schema makes
  the plugin degrade rather than misread); persisted vectors carry a write generation
  so an older build cannot downgrade a newer one; and a single-writer lease
  (`distill_lease`, 30s TTL, heartbeated) keeps exactly one distiller writing while
  readers reload off revision counters.
- **New options.** `storePath`, `coldPass`, `drillSessions`, `drillPageMessages`,
  `drillCharsPerSession`, `drillCharsPerQuery`, `deepCharsPerQuery`,
  `distillConcurrency`, `distillDelayMs`, `ftsRowsPerSession`, `inventoryTokens`,
  `semanticSlots`, and the `semantic` / `summaries` families above. `cacheMaxChars`
  is retained but repurposed (see Changed).
- **Evidence classes and grouped-result evidence.** Every hit is classified
  (`human-text`, `tool-input`, `tool-output`, `reasoning`, `file-read`, `web-fetch`,
  `skill-definition`, `session-title`) and reported in `why.evidenceClass`. Ranking
  prefers concrete actions over generated reference material, and session-grouped
  results carry `evidenceKinds` and up to two `topEvidence` snippets of other classes.
- **Composition-aware suggestions.** Guidance reacts to what came back: hits
  dominated by the current session or by generated reference material,
  shortlisted-but-unranked sessions, exact code tokens under a ranked search, and
  high-`hitCount` grouped results each get a concrete next call.

### Changed

- **Proactive hooks are card-based.** `autoRecall` and `compactionRecall` query the
  card tier directly and make zero message fetches, so they add no measurable
  latency. `autoRecall` injects the top cited cards on a cue-matching message;
  `compactionRecall` preserves the session's own card (focus, outcome, errors,
  identifiers, files) into the compaction summary.
- **`recall_context` and inline expansion are bounded.** A context window is
  assembled from bounded newest-first pages, never a whole-session load, and reports
  `hasMoreBefore` / `hasMoreAfter` at boundaries. Expansion is budgeted per part
  (6,000 chars each) and keeps the region around a truncated match.
- **`cacheMaxChars` is repurposed** as the drilled-session LRU budget (default 24
  million chars) that keeps repeat and refined queries warm, no longer a full-corpus
  cache.
- **`prewarm` is a no-op.** The card store persists across processes, so there is
  nothing to prewarm. The option is retained so existing configs do not error.

### Removed

- The fetch-and-scan corpus model and its per-query candidate budgets
  (`maxCandidatesTotal`, `maxCandidatesPerSession`, `maxCharsTotal`,
  `maxMessagesPerSession`, `maxPartsPerSession`). Selection is now card ranking plus
  the slim index, and drilling is bounded and paginated.
- `recall_messages` `offset` / `reverse` / `total`, and the numeric `recall`
  `sessions` argument (renamed `sessionLimit`). See Breaking.

## 0.12.1

A bug-fix release. Search worked, but **retrieving and browsing the results was
broken** — so after `recall` found a hit, reading or paginating it could come
back empty. Searching for things you can't then retrieve is no use; this fixes
the retrieval half of the flow.

### Fixed

- **Tool-argument defaults were not applied, breaking the browse/retrieve
  tools.** opencode passes the model's raw argument object to a plugin tool's
  `execute`; it validates against the Zod schema but does not feed back the
  parsed value, so schema `.default()`s are never materialized. When the model
  omitted `role`, `recall_messages` saw `role: undefined`, its role filter
  matched nothing, and a fully-loaded session reported `total: 0` with no
  messages (verified live: 590 messages fetched, 0 after the filter). The same
  missing-default behavior left `recall_context` with `NaN` slice bounds and
  could make `recall_get` throw on an undefined `messageID`. `recall` (search)
  already coerced its own args defensively; the four browse/retrieve tools now
  do too, via shared `coerceEnum` / `coerceBool` / `coerceInt` helpers plus
  required-argument guards. Impact: retrieving or browsing a session —
  including cross-project results that `recall` surfaces — now works regardless
  of which optional args the caller sends.
- **`recall` could surface its own prior output under renamed tool calls.** When
  tool names are namespaced upstream (e.g. `mcp__…__recall`), they slipped past
  the self-exclusion guard, so recall could match earlier recall results; and
  inline `expand` could include a nearby recall call's output. Both are now
  excluded from search and redacted from expansion, matching by suffix so
  namespaced variants are caught. Explicit `recall_get` / `recall_context`
  remain full-fidelity.

Verified end-to-end by driving a fresh opencode session against real history.

## 0.12.0

This release rebuilds how `recall` ranks results and adds the ability for the
agent to reach for its history on its own. No existing tool parameter changed
its meaning, so upgrades are drop-in.

### Highlights

- **Relevance ranking is now BM25 instead of fuzzy string matching.** `smart`
  and `fuzzy` search are powered by an in-memory [MiniSearch](https://github.com/lucaong/minisearch)
  BM25 index built per query. BM25 weights rare, discriminative terms over
  common boilerplate and normalizes for document length, so a short message that
  is actually about your query beats a long log that merely mentions the words.
- **Proactive recall.** Three opt-level features help the agent search history
  when it should, instead of waiting to be told: a default-on system-prompt
  nudge, and two opt-in hooks (`autoRecall`, `compactionRecall`).
- **`regex` match mode** for exact shapes — error codes, stack traces, file
  paths, IDs, URLs.
- **Result diversity** so one noisy session can't flood a result list.
- **Query-shape routing** that suggests `regex` when a query looks like a
  pattern, without ever overriding the caller.

### Expected effectiveness

The ranker change is measured, not asserted. A new relevance eval harness
(`test/eval/`) scores a labeled corpus of eight retrieval cases that exercise
the situations recall is for: rare-term recall, prior-decision recall, vague
"same as before" recall, typo tolerance, exact-phrase preference, cross-project
recall, and old-but-strong vs. recent-but-weak ranking.

| Ranker              | MRR  | recall@5 |
| ------------------- | ---- | -------- |
| Previous (Fuse.js)  | 0.50 | 0.50     |
| BM25 (this release) | 1.00 | 1.00     |

The previous ranker returned **nothing** on four of the eight cases (exact
phrase, cross-project error, old-strong-vs-recent-weak, and long-document
competition). BM25 returns the correct session at rank 1 for all eight. The
eval is wired into `npm run check` as a regression gate, so future ranking
changes must meet or beat these numbers.

Practical effect: queries that name a specific symbol, error string, file, or
decision now rank the right hit at or near the top far more reliably, and broad
queries no longer get drowned out by long, boilerplate-heavy tool output.

### Added

- **BM25 ranking** (`smart`, `fuzzy`) via MiniSearch, replacing Fuse.js.
  Structural boosts (exact phrase, full token coverage, reasoning traces, error
  output, user messages, recency) and penalties (weak single-token fuzzy, poor
  coverage) are layered on the BM25 base score as multipliers. Scores are
  reported 0–1.
- **`match: "regex"`** — bounded regular-expression scan over message and tool
  content. Invalid patterns return a clear error instead of silently matching
  nothing.
- **Result diversity** — in part-grouped results, a single session's share of
  the initial result list is capped so it can't crowd out other sessions;
  held-back hits backfill if room remains.
- **Query routing** — when a literal query looks like a regular expression, the
  response includes a non-overriding suggestion to use `match: "regex"`.
- **Proactive recall options:**
  - `nudge` (default **on**): adds a short system-prompt reminder to search
    history when you reference prior work. Text only — a few tokens per request,
    no latency, no I/O.
  - `autoRecall` (default **off**): when a message clearly references earlier
    work ("last time", "what did we decide", "same as before", "previously"),
    runs a bounded recall and injects the top one to three cited hits into the
    agent's context before it answers. Hard-bounded to 1.5s and a capped session
    scan so it can never stall a turn; stays quiet when it finds nothing.
  - `compactionRecall` (default **off**): before a session is compacted, pulls
    the strongest durable findings from that session and appends them to the
    compaction prompt so the summary preserves them.
- **Relevance eval harness** (`test/eval/`) with a labeled corpus, MRR and
  recall@5 metrics, and a locked baseline that gates `npm run check`.

### Changed

- `smart`/`fuzzy` no longer have a "degraded mode" that silently switched
  ranking algorithms under load. A time budget still applies, but it only flags
  elevated latency (`degradeKind: "time"`) — the ranking itself is unchanged.
- Tokenization is split: a duplicate-preserving tokenizer feeds the BM25 index
  (so term frequency is meaningful), while a deduplicated tokenizer backs
  set-membership checks.
- README reorganized so the value proposition and install come first and the
  agent-facing reference is grouped at the end. CONTRIBUTING's architecture
  section rewritten for the BM25 pipeline, the three execution paths, and the
  invocation hooks.

### Removed

- Fuse.js dependency and the legacy `fuse` / `prefilter` / `rank` modules.
  MiniSearch's built-in fuzzy matching covers typo tolerance.

### Compatibility

- All existing `recall` parameters keep their meaning; `match` gains a new
  `"regex"` value. The `score` field on results is now BM25-derived (still
  0–1). `nudge` is on by default; `autoRecall` and `compactionRecall` are
  opt-in. No configuration changes are required to upgrade.
