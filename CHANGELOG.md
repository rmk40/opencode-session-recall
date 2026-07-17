# Changelog

All notable changes to this project are documented here. This project follows
[Conventional Commits](https://www.conventionalcommits.org/) and
[Semantic Versioning](https://semver.org/).

## Unreleased

This release is about retrieval efficiency: making one or two `recall` calls
sufficient for "how did we do X before" queries instead of seven progressively
narrower ones. Search is now complete over the eligible scope (an in-memory
corpus cache replaces the per-query candidate budgets that silently dropped
old sessions), the asker's own conversation and generated reference material
stop crowding out real history, and grouped results expose the evidence that
made a session useful. One release note is breaking: the search output shape
was consolidated.

### Breaking

- **Global- and project-scope searches exclude the current session by
  default.** Broad "how did we do this before" queries used to be won by the
  conversation that asked them — it repeats the query terms verbatim and gets
  the recency boost. Callers who want in-session hits pass
  `excludeCurrentSession: false` (or `scope: "session"`, which always searches
  it); the default never applies when a specific `sessionID` is targeted, and
  a new `excludeSessionID` parameter excludes any one session by ID. Zero-result
  responses name the exclusion in their suggestions so the lever is
  discoverable.
- **Search output shape consolidated.** The consumer is a model reading JSON;
  redundant fields cost tokens on every response. Top-level `scanned` is
  removed (use `coverage.sessionsSearched`); top-level `loadErrorCount` /
  `loadErrors` are folded into `coverage.loadErrors: { count, samples }`;
  result-level `directoryRelevance` now lives only under `why`; and
  `degradeKind: "budget"` is gone (unreachable now that candidate budgets no
  longer exist). Nothing else about `results` entries changed.
- **Coverage counts are content-honest.** `messagesSearched` / `partsSearched`
  now count messages/parts with searchable content that passed the filters,
  instead of everything scanned before text extraction (which inflated
  `partsSearched` with unsearchable parts).

### Added

- **Incremental in-memory corpus cache.** Each session's searchable text is
  built once per session version (keyed by update time) instead of re-fetched
  and re-tokenized on every query. OpenCode's database stays the sole source
  of truth; the cache is LRU-bounded by the new `cacheMaxChars` option
  (default 50 million chars), and eviction only ever costs latency, never
  results. This removes the per-query candidate budgets and their scan-order
  truncation — a rare term in the oldest session is now found regardless of
  history size. A new `prewarm` option (default off) syncs the cache at plugin
  startup so the first search starts warm.
- **Evidence classes.** Every hit is classified deterministically
  (`human-text`, `tool-input`, `tool-output`, `reasoning`, `file-read`,
  `skill-definition`, `session-title`) and the class is reported in
  `why.evidenceClass`. Ranking boosts concrete actions (tool inputs) and
  penalizes generated reference material (skill payloads, file reads), so a
  60-char command line beats a 20,000-char skill body that mentions the same
  terms. Final part-mode slices cap reference material (one skill-definition,
  two file-read) and guarantee a tool-input hit for command-like queries.
- **Grouped results carry their evidence.** Session-grouped results include
  `evidenceKinds` (the classes seen in that session) and up to two
  `topEvidence` snippets of other classes, and the representative hit is
  chosen by class priority among near-best scores — a workflow session is
  represented by its commands, not by the skill payload that happened to
  score highest.
- **Two-stage session-first search.** Smart/fuzzy queries shortlist sessions
  whose title, directory, or digest overlaps the query, then re-rank the
  shortlist's content with its own BM25 index (shortlist-local IDF), merged
  with the broad pass. Code-like tokens (`deploy.yaml`, `launchTerminal`,
  `GHOSTAUTH_LIVE_TUI`) are extracted from the query and boosted on verbatim
  match. With `explain: true`, a new `queryPlan` field records which
  strategies ran.
- **Session digests.** At cache fill, each session gets a content-derived
  digest: the head of its first user message plus its most characteristic
  action vocabulary, built only from statements and commands — file reads and
  skill payloads earn no credit. The digest is indexed alongside title and
  directory, so ranking can find the right session even when its title is
  misleading.
- **Opt-in local semantic layer.** With `semantic: true`, smart/fuzzy ranking
  blends in cosine similarity from local static embeddings
  (`minishlab/potion-base-8M` by default, ~30 MB, downloaded once to
  `~/.cache/opencode-session-recall/models/` on first use). Searches stay
  lexical-only until the model warms, and any failure degrades to
  lexical-only. Off by default; nothing is downloaded unless enabled. New
  options: `semantic`, `semanticWeight`, `semanticModel`.
- **Composition-aware suggestions.** Guidance now reacts to what came back:
  top hits dominated by the current session, or by generated reference
  material, shortlisted-but-unranked sessions, exact code tokens under a
  ranked search, and high-`hitCount` grouped results each get a concrete
  next call.

### Changed

- **Expansion budgets are allocated per part.** One oversized tool dump can no
  longer eat the whole expansion budget: each part is capped at 6,000 chars
  within the total, and when the matched part itself is truncated, the region
  around the match is preserved instead of head-slicing it away.
- **Expansion fetches on demand.** Expanded sessions' messages are fetched
  only when expansion runs, instead of riding on a bulk load of everything
  searched.
- Auto-recall's own injected `<recall-auto>` blocks are no longer searchable,
  so a prior injection can't be found by later searches.

### Removed

- The auto-recall 200-session scan cap. The hook now searches the full scope
  through the shared corpus cache; its 1.5-second wall-clock timeout remains
  the safety valve.
- The per-query candidate budgets (`maxCandidatesTotal`,
  `maxCandidatesPerSession`, `maxCharsTotal`, `maxMessagesPerSession`,
  `maxPartsPerSession`) and their scan-order truncation. `cacheMaxChars` and
  the per-candidate 20,000-char cap are the remaining size controls.

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
