# Recall Retrieval Efficiency Plan

Response to `docs/multikey-debugging-recall-field-report.md` (2026-07-16), plus a
general capability review of the current search pipeline. The field report's
verdict was that coverage is strong but retrieval efficiency is weak: the agent
had to run seven progressively narrower searches to recover a workflow the data
contained all along.

Revision 2 of this plan lifts four constraints the first revision treated as
fixed (see `## Lifted constraints` and `## Revisions`). The largest change is
an incremental in-memory corpus cache that removes the per-query budgets the
first revision spent several phases working around.

## Goal

Make one or two `recall` calls sufficient for "how did we do X before" queries.
Concretely: exclude the asker's own conversation from historical discovery by
default, stop generated reference material (skill payloads, file reads) from
outranking concrete actions, make grouped session results expose the evidence
that made the session useful, stop one oversized part from eating the whole
expansion budget, make search complete (no scan-order truncation) via an
incremental corpus cache, and, once the cache exists, close the
vocabulary-mismatch gap with an opt-in semantic layer and session digests.
Every ranking change is gated by the relevance eval, extended with a fixture
that reproduces the field report's failure.

## Lifted constraints

Decided 2026-07-16 with the maintainer: the first revision's constraints were
defaults, not requirements. Lifted, in impact order:

1. **"No persistent/incremental index."** Lifted for an in-memory,
   derived, safe-to-discard corpus cache (R3 from
   `search-mechanism-recommendations.md`, previously dropped). OpenCode's DB
   stays the sole source of truth; the cache is a performance layer whose
   eviction never changes results, only latency. No on-disk persistence of
   the index itself.
2. **"`excludeCurrentSession` defaults to false."** Flipped: global- and
   project-scope searches exclude the calling session by default. Callers opt
   back in with `excludeCurrentSession: false`.
3. **"No embeddings / no LLM involvement."** Relaxed to: opt-in, local-only,
   off by default. An embedding layer (static embeddings, brute-force cosine)
   and deterministic-first session digests become late phases gated on the
   cache.
4. **Tool-definition size guard at 5,000/9,000 chars.** Raised to 6,500 for
   `recall` and 11,000 total so the tool description can carry the operator
   recipe. The guard test stays; only the numbers move.
5. **Additive-only output shape.** Relaxed: one consolidation release may
   remove redundant top-level fields (the consumer is a model reading JSON,
   not code).

Deliberately kept: the five-tool surface, the eval baseline gate, defensive
arg coercion with `runToolRaw` tests (host reality, per AGENTS.md), no
external services or second authoritative store, no automatic memory writes,
and Node-free `src/` for all core modules (the semantic phase isolates its
`node:fs`/model loading behind dynamic imports, the pattern AGENTS.md already
documents).

## Remaining constraints

- Ranking changes must meet or beat `test/eval/baseline.json` (currently
  MRR 1.0 / recall@5 1.0). New cases land in the same change-set as the
  feature that makes them pass, so the build never goes red; `baseline.json`
  updates in the same commit with the case-count change noted in `_note`.
- All new args must be defensively coerced in `execute` (the host bypasses
  Zod defaults) and covered by a `runToolRaw` regression test.
- The raised tool-size guard (6,500 / 11,000) still gates schema growth.
- Core `src/` stays Node-free; `npm run check` (tsup then tsc) is the gate.

## Current-state findings

The field report's five complaints, verified against the code, plus issues
found during this review that the report did not name:

1. **Current-session dominance has no countermeasure.** `search.ts` builds
   `targets` from `session.list` with no way to exclude a session. The current
   conversation repeats the query terms verbatim and gets the recency
   multiplier (`RECENCY_MULT_MAX` in `bm25.ts`), so it reliably wins broad
   smart searches asking about the past.

2. **Evidence source is invisible to ranking.** `Candidate.source` only
   distinguishes message/tool/reasoning/title. A skill payload, a `read` dump,
   and a `bash` command input are all `"tool"`. BM25 length normalization
   helps, but a 20,000-char skill body (the `maxCharsPerCandidate` cap) that
   mentions every query term still beats a 60-char command line.

3. **Grouped representatives discard session structure.**
   `groupBySession()` (`search.ts:903`) keeps one best hit and a count. The
   report's workflow session was represented by its skill payload, hiding the
   launch/type/press command sequence that made it the right answer.

4. **Expansion truncation is head-only and per-field.** `truncateExpandedText`
   caps each field at `MAX_EXPANDED_FIELD_CHARS` (4,000) and keeps the head of
   the text. A part carrying two populated fields (output+error, or
   content+error on retry parts; `format()` never emits content alongside
   output for tool parts) can take ~8,000 of the 30,000 char budget, and the
   matched region can be sliced off entirely. There is no per-part cap and no
   match-region preservation.

5. **Every query re-fetches and re-tokenizes the world.** `smartScan` builds
   candidates session by session in provider list order (whatever
   `session.list` returns; typically recently-updated first, but the code
   never sorts, so ordering is not guaranteed) and truncates at
   `maxCandidatesTotal` (3,000). Within a session, messages are scanned
   newest-first. On a large global scan, sessions late in the provider order
   are dropped from the index entirely before BM25 sees them, with only
   `degradeKind: "budget"` as a hint. The same per-query cost is why
   auto-recall is capped at 200 sessions / 1.5s, and why the report's
   two-stage session-first search looked unaffordable. This is the root
   finding; the corpus cache (Phase 2) removes it rather than mitigating it.

6. **Auto-recall blocks are self-polluting.** The `<recall-auto>` synthetic
   text part injected by `hooks/auto-recall.ts` is a plain text part, so
   `searchableFields()` indexes it. A prior auto-recall injection (which
   restates query-like terms) can be found by later searches. The self-tool
   exclusion in `extract.ts` only covers tool parts.

7. **Auto-recall searches include the session it is injecting into.** The hook
   sets `sessionID` in its synthetic context but the search has no exclusion,
   so the freshly typed cue message competes with real history.

8. **Suggestions do not react to result composition.** `buildSuggestions`
   covers zero results, mode mismatch (regex-shaped queries), directory
   misses, title-only hits, hidden-type filters, and low searched-session
   counts, but says nothing when the top hits are all from the current
   session or all generated reference material, which is when guidance is
   most needed.

9. **The eval harness cannot express the report's failure.** `runCase` scores
   session rank only. It cannot assert "a tool-input hit appears in the top
   three" or "the current session does not appear". `evalContext()` hard-codes
   `sessionID: "e-noise"`.

10. **No session-level text reflects content.** Every candidate already
    indexes session-level metadata (`titleText` boost 0.3, directory in
    `secondaryText` boost 0.6, `hintText` for tool names in `bm25.ts`), but
    all of it is naming metadata. The report's workflow session was titled
    "Profile and Audit Claude CLI…"; when both title and directory mislead,
    nothing in ranking can bridge to what the session was actually about.
    Session digests (Phase 10) add the first session-level field derived
    from content rather than naming luck.

## Approach

Eleven phases. Each is one change-set: implement, test, eval-gate, review,
document. Phases 0–1 are independent of the cache; Phase 2 is the keystone;
Phases 3–8 build on the cached-corpus architecture; Phases 9–10 are the
lifted-constraint follow-ons; Phase 11 holds deferred sketches.

### Phase 0: Eval fixture and metric extensions (foundation, ships with Phase 1)

Extend the harness so later phases can be measured. No production behavior.

1. `test/eval/corpus.ts`: add four sessions modeled on the field report.
   - `e-cur` ("Multikey auth login debugging", `PROJECT_DIR`, newest): user
     text repeating `ghostauth tuistory auth login plugin debug workflow`
     vocabulary; no actual workflow content. This becomes the eval's current
     session.
   - `e-flow` ("Profile and audit CLI usage tracking", `GHOST_DIR`, old):
     the misleading title is the point. Contains (a) user text describing an
     interactive test, (b) several `completedToolPart("bash")` entries whose
     `input.command` values are `npx tuistory launch "opencode" -s t1 ...`,
     `tuistory -s t1 type "/usage"`, `tuistory -s t1 press enter`, (c) one
     `completedToolPart("skill")` whose output is a long tuistory skill
     payload (use `longFiller` plus tuistory vocabulary), (d) one
     `completedToolPart("read")` file dump mentioning `GHOSTAUTH_LIVE_TUI`.
   - `e-docs` ("Ghostauth docs audit", `GHOST_DIR`): large `read` outputs
     mentioning `GHOSTAUTH_LIVE_TUI` and `tuistory` many times; no commands.
   - `e-tui` ("Terminal UI spike", `OTHER_DIR`): mentions `live TUI test
waitForText`; wrong directory.
     Add `GHOST_DIR` next to `PROJECT_DIR`/`OTHER_DIR` in `test/helpers.ts`.
2. `src/types.ts`: land the `EvidenceClass` union and the optional
   `ResultWhy.evidenceClass` field here as type-only additions with no
   producer, so the harness fields below compile in this change-set. Phase 3
   adds the classifier that populates the field. (Sequencing note: without
   this, the Phase 0/1 commit references an undefined type and the pre-commit
   `npm run check` fails.)
   ```ts
   export type EvidenceClass =
     | "human-text" // text part, user or assistant
     | "reasoning"
     | "tool-input" // hit matched in command/cwd/toolName fields
     | "tool-output"
     | "file-read" // tool name suffix-matches "read"
     | "skill-definition" // tool name suffix-matches "skill"
     | "session-title";
   ```
   The report's `review-report` class is dropped: there is no deterministic
   signal for it.
3. `test/eval/harness.ts`:
   - `evalContext(sessionID = "e-noise")` gains the parameter, and
     `runCase`/`runEval` change to build a fresh context per case from
     `case.ctxSessionID` instead of threading one shared `ctx`
     (`relevance.test.ts` currently passes a single context for all cases).
   - `EvalCase` gains optional `ctxSessionID` and
     `expect?: { notInResults?: string[]; classInTop3?: EvidenceClass[];
maxClassInTop5?: Partial<Record<EvidenceClass, number>> }`.
   - `CaseResult` gains `topClasses: (string | undefined)[]` (from
     `result.why?.evidenceClass`) so class assertions are scoreable.
4. `test/eval/cases.ts`: the report's four queries become cases, added
   per-phase as the behavior lands (listed under each phase below).
5. `test/eval/relevance.test.ts`: assert the `expect` clauses in addition to
   MRR/recall@5; update `baseline.json` numbers in the same commit and note
   the case-count change in the `_note` field.

### Phase 1: Current-session exclusion, on by default (P0)

`src/search.ts`:

1. Args (terse descriptions for the size guard):
   ```ts
   excludeCurrentSession: tool.schema.boolean().default(true)
     .describe("Exclude this session (default); set false to include it"),
   excludeSessionID: tool.schema.string().optional()
     .describe("Exclude one session by ID"),
   ```
2. Defensive coercion in `execute` alongside the existing block. The default
   is scope-aware so the flag never contradicts an explicit target:
   ```ts
   const excludeCurrent =
     typeof args.excludeCurrentSession === "boolean"
       ? args.excludeCurrentSession
       : scope !== "session" && !sessionID;
   ```
   plus `const excludeSessionID = optionalString(args.excludeSessionID)`.
3. Hard errors (contradictions, not forgivable), only for explicit values:
   - `scope === "session"` with explicit `excludeCurrentSession: true`.
   - `sessionID` arg equal to `excludeSessionID` or equal to the current
     session while `excludeCurrentSession` is explicitly true.
     The implicit default never errors; it simply does not apply when the
     caller targeted a specific session.
4. Filtering: build
   `const excluded = new Set([excludeSessionID, excludeCurrent ? optionalString(ctx.sessionID) : undefined].filter(Boolean))`
   and filter the eligible `targets` set (after
   `dedupeSessions`/directory bucketing), leaving `discoveredTargets`
   untouched. `sessionsDiscovered` keeps counting everything found, the
   removed count lands in `skippedByReason.excludedSession`, and the existing
   `sessionsSkipped = sessionsDiscovered - scanned` reconciliation
   (`search.ts:1728`) stays consistent without changes. Push
   `"excludedSession"` onto `limitedBy` (extend the union in `types.ts`
   `SearchCoverage`). Do not filter `discoveredTargets` itself; that would
   undercount discovery and make `skippedByReason` sum past
   `sessionsSkipped`.
5. Suggestions: pass `currentSessionID: optionalString(ctx.sessionID)` and the
   exclusion state into `buildSuggestions`. Two rules:
   - Exclusion explicitly off and at least half of the top
     `min(5, results.length)` results carry `sessionID === currentSessionID`
     → suggest removing `excludeCurrentSession: false`.
   - Exclusion active and zero results → mention the exclusion in the
     zero-result guidance with `{ excludeCurrentSession: false }` as the
     example, so callers who genuinely wanted in-session search find the
     lever.
6. Tool description: one sentence in the "First call" paragraph:
   `The current session is excluded by default; pass
excludeCurrentSession:false to search it (or use scope:"session").`

`src/hooks/auto-recall.ts`: the new default covers the hook (it searches
`scope: "global"`), so remove nothing, add nothing; assert the behavior in the
hook test (fixes finding 7).

Release note: this is a behavior change for global/project searches. The
rationale (the field report's top finding) goes in the CHANGELOG entry.

Tests: schema-path cases in `test/recall.test.ts`; `runToolRaw` cases proving
raw `undefined`/garbage values coerce to the scope-aware default;
contradiction errors fire only on explicit values; coverage accounting
(`skippedByReason.excludedSession` sums correctly); auto-recall behavior test
in `test/hooks.test.ts`; `scope:"session"` and explicit-`sessionID` searches
still see the current session with no args.

Eval (lands here): the report's historical-workflow query
`ghostauth tuistory test opencode plugin auth login debug workflow` with
`ctxSessionID: "e-cur"` and default args, expecting
`relevantSessionIDs: ["e-flow"]` and `notInResults: ["e-cur"]`.

### Phase 2: Incremental corpus cache (keystone)

Replace per-query fetch/tokenize/budget with a derived in-memory cache.
OpenCode's DB remains the source of truth; the cache is invalidated by
session metadata and is safe to drop at any time (correctness is identical,
only latency changes).

1. **New module `src/corpus.ts`** (Node-free):

   ```ts
   type CachedSession = {
     meta: {
       id: string;
       title: string;
       directory: string;
       updated: number;
       projectID?: string;
       projectWorktree?: string;
     };
     candidates: Candidate[]; // unfiltered: every searchable part
     titleCandidate?: Candidate; // undefined when the title is empty
     messageCount: number;
     charCount: number;
     lastAccess: number; // LRU eviction
   };

   export class CorpusCache {
     constructor(client: OpencodeClient, limits: Limits) {}
     /** Diff targets against the cache by (id, updated); fetch only
      *  changed/missing sessions; evict LRU beyond limits.cacheMaxChars.
      *  Concurrent syncs share per-session in-flight promises. */
     async sync(
       targets: SessionMetaInternal[],
       abort?: AbortSignal,
     ): Promise<{ sessions: CachedSession[]; loadErrors: string[]; loadErrorCount: number }>;
     stats(): { sessions: number; candidates: number; chars: number };
   }
   ```

   Wiring: exactly one instance is created in
   `src/opencode-session-recall.ts` and passed into all three search call
   sites — the registered `recall` tool (`search(client, unscoped, global,
limits, cache)`) and both search-running hooks (`autoRecall(...)` and
   `compactionRecall(...)` each build their own `search()` instance today;
   their factory signatures gain the cache parameter and pass it through).
   Three call sites, one cache.

2. **`src/candidates.ts` rework**: `buildCandidates` loses its query-time
   filter parameters (`type`, `role`, `before`, `after`, `toolName`) and
   builds the complete unfiltered candidate list for a session once per
   session version. Per-candidate truncation (`maxCharsPerCandidate`, 20,000)
   stays. The per-query budgets (`maxCandidatesTotal`,
   `maxCandidatesPerSession`, `maxCharsTotal`, `maxMessagesPerSession`,
   `maxPartsPerSession`) are deleted along with their scan-order-truncation
   behavior; the only size control left is the cache-level
   `cacheMaxChars`. `populateNormalized` runs once at cache-fill time, so
   tokenization cost is paid per session change, not per query.
3. **Query-time filtering**: a pure predicate
   `candidateEligible(c, { type, role, before, after, toolName })` in
   `src/candidates.ts`, applied when assembling the per-query candidate list
   from cached sessions. Filter semantics are exactly today's message/part
   filters (same comparisons, same `partEligible` logic), so all existing
   filter tests carry over.
4. **All three match paths run over the cache.** `scan()` and `regexScan()`
   change from iterating `MsgWithParts` to iterating cached candidates'
   `fieldTexts` (which `searchableFields()` built, so matching semantics are
   unchanged); `smartScan` consumes the filtered cached candidates directly.
   The `session.messages` bulk load in `execute` disappears; `sync()` is the
   only fetch. Title search uses the cached `titleCandidate`, and its
   representative message identity comes from the newest cached candidate
   that passes the role/time filters, replacing
   `findRepresentativeMessage`. This preserves the current edge-case
   behavior: a session whose messages are all filtered out (role/time) yields
   no representative and therefore no title hit, exactly as
   `findRepresentativeMessage` returns `undefined` today. A session with
   messages but zero searchable parts loses its title hit under the cache
   (no candidates to pick from) where today it would not; accept and note
   this as a deliberate edge-case change — a session with nothing searchable
   has nothing to inspect after a title hit anyway.
5. **Expansion fetches on demand.** `expandSearchResults` loses the
   `allLoaded` input and instead fetches messages for only the expanded
   sessions (≤ `expandResults` ≤ 3) via `client.session.messages`, reusing
   the existing formatting path. Failures degrade to a warning per entry,
   consistent with today's sparse-`expanded` contract.
6. **Coverage from cache stats.** `messagesSearched` = distinct `messageID`s
   among filtered candidates; `partsSearched` = filtered candidate count;
   `sessionsSearched` = sessions synced for this query. This is a deliberate
   semantic change from today's `countSearchCoverage`, which counts eligible
   messages/parts before `searchableFields()` yield (so parts with no
   searchable text — e.g. pending tools without input — currently inflate
   `partsSearched`). The new counts mean "messages/parts with searchable
   content that passed the filters", which is more honest; call it out in
   the release notes and update the coverage tests rather than emulating the
   old counts. `nearMisses` derives from cached session metadata. `limitedBy`
   drops `rankingBudget` (no candidate cap remains) and keeps
   `timeBudget`/`abortSignal` as safety valves; `degradeKind: "budget"`
   becomes unreachable and is removed from emission (the type keeps the
   member one release for compatibility).
7. **Limits**: `Limits` gains `cacheMaxChars` (default `50_000_000`; plugin
   option). Eviction is LRU by `lastAccess` with one hard rule: sessions
   belonging to any in-flight `sync()` are pinned and never evicted until
   the query that synced them completes (`sync()` marks its result set;
   eviction skips pinned entries even if that temporarily overshoots
   `cacheMaxChars`). Without pinning, a query whose target set exceeds the
   cap could evict its own sessions between sync and search and silently
   shrink coverage. An evicted session that is targeted again is simply
   re-fetched, so eviction never changes results, only latency.
8. **Hooks**: `AUTO_SESSION_CAP` (200) is deleted; auto-recall searches the
   full scope through the shared cache. The 1.5s wall-clock timeout stays (a
   cold cache on a huge history can exceed it; the hook then injects nothing,
   and the next attempt hits a warm cache). New plugin option
   `prewarm?: boolean` (default false): when true, fire-and-forget a
   `sync()` of the global session list at plugin init so the first hook
   invocation is warm.
9. **Staleness**: invalidation key is `time.updated`. Two failure paths need
   explicit handling:
   - **Metadata fetch failure**: for explicit-`sessionID` and current-session
     targets, `execute` today swallows `session.get` failures and proceeds
     with `updated = 0` (`search.ts`, the two try/catch blocks around
     `client.session.get`). Under the cache, an `updated` of 0 must mean
     "unknown", never "unchanged": a target with unknown `updated` bypasses
     the cache entry (fetch fresh messages this query) and the result is not
     stored under the unknown key, so a stale entry can never be pinned
     alive by repeated metadata failures.
   - **Silent mutation**: if dogfooding surfaces an SDK path that mutates
     messages without touching `updated`, add `messageCount` to the key
     (already stored). Known risk, not a blocker.

Tests: cache hit/miss/invalidation (bump `updated`, session content changes
are picked up); eviction under a tiny `cacheMaxChars` still returns complete
results; concurrent `sync` deduplicates fetches; filter predicate parity with
the old `buildCandidates` filters (port the existing filter tests);
literal/regex/smart parity over cached candidates (existing `recall.test.ts`
suites are the parity gate; they should pass with at most snippet-boundary
adjustments); expansion on-demand fetch and its failure path; coverage counts
from cache stats; auto-recall uncapped + prewarm wiring in
`test/plugin.test.ts`/`test/hooks.test.ts`.

Eval: the full existing suite must hold at baseline. Add a
completeness case: with a corpus larger than the old `maxCandidatesTotal`
(generate ~3,200 filler candidates across sessions), a rare term planted in
the oldest session must still be found — this is the regression test for
finding 5, impossible to pass under the old architecture.

Performance validation (not a unit test): a scratch script under
`$CLAUDE_JOB_DIR/tmp`-style local use, timing first-search (cold) and
second-search (warm) against the maintainer's real history, recorded in the
PR description. Cold must be no worse than today; warm should be
milliseconds.

### Phase 3: Evidence classes in extraction and ranking (P0)

1. Types landed in Phase 0. This phase adds only the producers.
2. `src/extract.ts`:
   - Generalize the suffix logic inside `isSelfTool` into
     `toolNameMatches(toolName: string, base: string): boolean` (bare name or
     separator-prefixed suffix, same `SELF_BOUNDARY` rule) and reimplement
     `isSelfTool` on top of it.
   - `export function evidenceClassFor(partType, toolName, matchedFields): EvidenceClass`
     with the mapping: `title` → session-title; `reasoning` → reasoning;
     `text`/`subtask` → human-text; `tool` → skill-definition when
     `toolNameMatches(toolName, "skill")`, file-read when
     `toolNameMatches(toolName, "read")`, tool-input when every matched field
     is in `{command, cwd, toolName}`, else tool-output. Scope note on
     `command`: `toolInputTexts()` (`extract.ts:45-52`) files the whole JSON
     input under the `command` matched field in addition to the specific
     `command`/`cwd` strings, so a tool part whose only match is inside its
     JSON input classifies as tool-input regardless of tool. That is the
     intended semantics — "matched in what was asked of the tool" — and it
     is what makes non-bash tool invocations (e.g. a tuistory MCP call)
     count as actions; state it in the classifier's doc comment and cover it
     with a table-test row.
   - Self-pollution fix (finding 6): in `searchableFields`, return `[]` for a
     text part when `part.synthetic === true` and the text starts with
     `<recall-auto>`. Only our sentinel; other synthetic parts stay
     searchable. Cache note: this runs at cache-fill time now, which is the
     single choke point — no other path needs the check.
3. `src/bm25.ts`: after `findMatchedFields`, compute the class and apply
   multipliers on the existing structural stack:
   ```ts
   const TOOL_INPUT_MULT = 1.1;
   const SKILL_DEFINITION_MULT = 0.85;
   const FILE_READ_MULT = 0.9;
   ```
   Record `Evidence class: <class>` in `matchReasons` when `explain`. Return
   the class on `Bm25Hit` so `rankedToSearchResults` can set
   `why.evidenceClass`. Constants are starting points; tune against the eval,
   never below baseline.
4. Literal/regex paths: the candidate-scan versions of `scan()`/`regexScan()`
   know the single matched field, so set
   `why.evidenceClass = evidenceClassFor(...)` in the result constructors.
   `titleSearchResult` sets `"session-title"`.
5. `annotateResult` in `search.ts`: preserve an already-set `evidenceClass`.

Tests: classifier table test (including namespaced names like
`mcp__server__read` and non-matches like `myskill`); BM25 ordering test where
a short bash command input beats a long skill payload containing the same
terms; synthetic `<recall-auto>` part absent from the cache; existing
self-tool tests still pass via `toolNameMatches`.

Eval (lands here, smart-mode only; ranking multipliers do not affect the
literal path, and the `maxClassInTop5` diversity contract belongs to Phase 7):
the exact-tool query `tuistory` as `match: "smart"`, `group: "part"`,
directory `GHOST_DIR`, expecting `classInTop3: ["tool-input"]`; and the API
query `launchTerminal` (smart) expecting the workflow session's authored
usage to outrank the skill body. Keep the existing error-recall case
("permission denied configmaps") green; it guards against the tool-output
class being over-penalized (the stderr hit is `tool-output` and must still
win its query).

### Phase 4: Grouped representative selection and topEvidence (P0)

`src/search.ts`, `groupBySession()` rework:

1. Track per session a bounded list (`MAX_GROUP_TRACKED = 4`) of the
   best-scoring hits (insertion in incoming ranked order suffices: results
   arrive pre-sorted in smart mode and scan order in literal/regex).
2. Representative selection: among tracked hits with score within
   `REPRESENTATIVE_TOLERANCE = 0.85` of the session's best score (in literal
   and regex modes, which have no scores, all tracked hits qualify), pick by
   class priority:
   ```ts
   const CLASS_PRIORITY: EvidenceClass[] = [
     "human-text",
     "tool-input",
     "tool-output",
     "reasoning",
     "file-read",
     "skill-definition",
     "session-title",
   ];
   ```
   Ties fall back to the existing rules (score, then recency; title never
   beats content, preserved from the current code).
3. Output additions on the grouped `SearchResult` (extend the type in
   `types.ts`):
   ```ts
   evidenceKinds?: EvidenceClass[];   // unique classes seen in this session's hits
   topEvidence?: Array<{ messageID: string; partID: string;
     evidenceClass: EvidenceClass; snippet: string }>;  // max 2
   ```
   `topEvidence` holds up to two tracked hits whose class differs from the
   representative's, snippets re-cut to 120 chars
   (`TOP_EVIDENCE_SNIPPET_CHARS`). This is what would have made the workflow
   session legible without a 191-hit `group:"part"` follow-up.

Tests: representative flips from skill payload to command input when scores
are close; does not flip when the payload's score is genuinely dominant
(outside tolerance); `evidenceKinds`/`topEvidence` populated and bounded;
literal grouped mode unchanged except priority; hitCount semantics unchanged.

Eval (lands here): grouped variant of the workflow query asserting the
`e-flow` representative's `why.evidenceClass` is `human-text` or `tool-input`,
never `skill-definition`.

### Phase 5: Expansion budget allocation (P0)

`src/search.ts` expansion path (on-demand message fetch from Phase 2):

1. New constant `MAX_EXPANDED_PART_CHARS = 6_000`. `truncateExpandedPart`
   creates a per-part sub-budget
   `{ remaining: Math.min(MAX_EXPANDED_PART_CHARS, budget.remaining) }`,
   threads it through the three `truncateExpandedText` calls, then charges the
   consumed amount back to the global budget. The existing
   `MAX_EXPANDED_FIELD_CHARS = 4_000` per-field cap stays as the inner bound.
2. Match-region preservation for the matched part only: pass the parsed query
   (or compiled regex / literal string) into `expandSearchResults`; when
   formatting the center message, for the part whose `id === result.partID`
   and whose field text exceeds its allowance, use a new helper
   `truncatePreservingMatch(text, matchIndex, cap)` (place it in
   `src/snippet.ts` next to the window helpers): keep the first
   `cap * 0.4` chars, an omission marker
   `\n[… N chars omitted; use recall_get for the full message]\n`, and a
   window centered on the first match position for the remainder. Non-matched
   parts keep today's head-slice behavior.
3. Warning when the per-part cap fires:
   `"One or more parts exceeded the per-part expansion cap (6000 chars); bodies were sampled around the match."`

Tests: one giant part no longer starves siblings (assert the following
message's parts are non-empty under a full budget); matched region survives
truncation (query token present in the truncated output); budgets still sum
under `expandBudgetChars`; `recall_get` pointer text present; helper edge
cases (match inside the kept head, match near the end) unit-tested directly.

### Phase 6: Two-stage session-first search, exact-token boost, query plan (P1)

With the cache, the report's full two-stage design is affordable; the first
revision's narrowed build-order tweak is superseded.

1. `src/query.ts`: `ParsedQuery` gains `codeTokens: string[]` extracted from
   the raw query with
   `/[A-Za-z0-9]+(?:[_./-][A-Za-z0-9]+)+|[a-z]+(?:[A-Z][a-z0-9]+)+|[A-Z]{2,}[A-Z0-9_]*/g`,
   filtered to length ≥ 4, deduped. This catches `GHOSTAUTH_LIVE_TUI`,
   `launchTerminal`, `deploy.yaml`, `opencode-multikey`: the anchors the
   report says the caller had to already know. Tokenization in
   `normalize.ts` splits them apart today; this keeps the compound available.
2. `src/bm25.ts`: `EXACT_TOKEN_MULT = 1.12` applied once when any
   `codeToken` appears case-insensitively verbatim in `candidate.rawText`.
   Explain reason `Exact code token`.
3. Two-stage plan for `match: "smart" | "fuzzy"` (new `src/plan.ts`):
   - **Stage A (metadata shortlist)**: score every cached session by query
     overlap against `tokenize(title + " " + directory)` (tokens of length
     ≥ 4; Phase 10 adds the digest text to this pool). Sessions with
     overlap ≥ 1 form the shortlist, capped at `SHORTLIST_MAX = 25`.
   - **Stage B (deep + broad)**: run BM25 once over the full filtered
     candidate set (broad pass, unchanged), and once over a SECOND
     MiniSearch index built only from the shortlist sessions' filtered
     candidates. The second build is required, not an optimization choice:
     MiniSearch computes IDF at index-build time over the supplied
     documents, so filtering the broad index's results cannot remove the
     broad corpus's term statistics — only a shortlist-only index gives the
     deep pass its own IDF. Shortlist candidate counts are small (≤ 25
     sessions), so the extra build is cheap over cached, pre-normalized
     candidates. Merge by `partID`, keeping the higher normalized score;
     shortlist-pass hits get `SHORTLIST_MULT = 1.1`. One ranked list out; no
     separate result sets.
   - Rationale: the deep pass re-ranks within the shortlist under
     shortlist-local IDF, which is what the report's "title identified the
     right neighborhood but content ranking failed" finding needs.
4. Query-plan transparency: `SearchOutput` gains
   `queryPlan?: { variants: string[]; selected: string[] }` (the report's
   shape), emitted only when `explain: true`. Variants recorded from what
   ran: `"bm25-broad"`, `"title-shortlist"` (with the shortlist size),
   `"exact-token-boost"`, `"literal-fallback"`.
5. The Phase 2 completeness change already removed the candidate cap, so no
   build-order protection is needed; Stage A is pure ranking.

Tests: codeTokens extraction table; exact-token boost ordering (a candidate
containing verbatim `GHOSTAUTH_LIVE_TUI` beats one containing only the split
tokens); shortlist formation from title/directory overlap; the deep pass
builds a shortlist-only index — assert via a fixture where a term is rare
inside the shortlist but common in the broad corpus, so the deep pass ranks
it above what broad IDF would allow (this fails if the implementation merely
filters the broad index); merged scoring keeps the higher of broad/deep
scores and applies the shortlist multiplier exactly once; queryPlan only
under explain.

Eval (lands here): the title/content bridge query `ghostauth live test`
(smart, global) expecting `e-flow` in top ranks despite its unrelated title,
via directory metadata shortlisting plus content.

### Phase 7: Evidence diversity and composition-aware guidance (P1)

1. `src/search.ts`: class caps within the initial fill,
   ```ts
   const CLASS_CAPS: Partial<Record<EvidenceClass, number>> = {
     "skill-definition": 1,
     "file-read": 2,
   };
   ```
   implemented as a separate pass applied AFTER `orderForDirectoryFallback`
   and immediately before the final slice in `applyGroupAndSlice`, not inside
   `diversify()`. `diversify()` runs before the directory re-sort
   (`search.ts:1940`), and that re-sort (directoryRank → score → time) is
   class-blind, so a cap applied inside `diversify()` would be silently
   defeated whenever `directory && fallback` reorders the list. The pass is a
   stable filter with held-back backfill (same semantics as `diversify()`'s
   per-session cap), so directory-bucket ordering among surviving hits is
   preserved. The per-session cap stays in `diversify()` unchanged.
2. Tool-input guarantee: when `query.codeTokens.length > 0` or the query
   matches `/\b(run|launch|type|press|test|reproduce|install|start)\b/i`, and
   the final slice contains no `tool-input` hit but the held-back pool does,
   swap the best tool-input hit into the last slot. Deterministic, bounded,
   part-mode only (grouped mode is covered by Phase 4). Plumbing note:
   `applyGroupAndSlice` currently returns only `{ final, total, truncated }`
   and discards the pre-slice ordered list, so the class-cap pass and this
   swap cannot bolt on after it. Reshape the part-mode branch so the
   ordered, diversified, directory-sorted list flows into one combined
   `capAndSlice(ordered, limit, classCaps, query)` step that owns the class
   caps, the tool-input swap, and the final slice, and returns the same
   `{ final, total, truncated }` shape to callers.
3. `buildSuggestions` additions (with the Phase 1 current-session rules this
   completes the report's weak-result guidance list):
   - ≥3 of the top 5 results classed `skill-definition`/`file-read` → suggest
     re-running oriented to actions: `type:"tool"` and the tool-input recipe.
   - Grouped top result with `hitCount >= 10` → suggest
     `{ group: "part", sessionID: <id> }` to inspect that session.
   - `codeTokens` present and `match` is smart → suggest
     `{ match: "literal", query: <first codeToken> }`.
   - Title-shortlist sessions exist (Stage A found overlap) but none appear
     in the results → suggest `{ title: <matched term> }`. Reinstated from
     the report's guidance list now that Phase 6 gives it a real mechanism.
     Cap stays `MAX_SUGGESTIONS = 3`; order the new rules after the existing
     zero-result ones so empty-result guidance still wins.
4. Tool description recipe (the report's P1 "previous workflow" recipe),
   appended to the description under the raised 6,500-char guard:
   `For "how did we do X before": match:"smart", group:"session" (current
session is already excluded by default); if weak, search the project
directory literally for the tool/command name and inspect tool-input hits
with expand or recall_context.`
   Raise the guard numbers in `test/plugin.test.ts` (recall 5,000 → 6,500,
   total 9,000 → 11,000) in this change-set, with a comment stating the new
   budget is a decision, not drift.

Tests: class caps hold with backfill; tool-input swap fires only for
command-like queries; suggestion composition rules; raised tool-size guard
green.

Eval (lands here; this phase owns `maxClassInTop5`): extend the corpus with
two more `skill`-tool parts across `e-flow` and `e-docs` so a literal
`tuistory` scan genuinely floods with skill-definition hits, then assert
`maxClassInTop5: { "skill-definition": 1 }` on the literal `tuistory` query
(`group: "part"`, directory `GHOST_DIR`). Literal scan order, not score,
produces the flood, which is exactly what the class-cap pass must fix. Add
the same assertion to the Phase 3 smart-mode `tuistory` case now that the cap
enforces it regardless of ranking.

### Phase 8: Output shape consolidation (lifted additive-only constraint)

One breaking-cleanup release, versioned and release-noted. The consumer is a
model reading JSON; the cost of a break is one release note, and the benefit
is fewer tokens per response and less redundancy for the model to parse.

1. Remove top-level `scanned` (superseded by `coverage.sessionsSearched`).
2. Fold `loadErrorCount`/`loadErrors` into
   `coverage.loadErrors?: { count: number; samples: string[] }`.
3. Drop result-level duplicate `directoryRelevance` (it stays in `why`);
   keep top-level `source` (agents key on it).
4. Remove `degradeKind: "budget"` emission (dead since Phase 2); keep
   `"time" | "fallback" | "none"`.
5. Update the tool description's output notes, README, and all tests in one
   change-set. Nothing else about `results` entries changes.

### Phase 9: Opt-in semantic layer (lifted constraint 3, gated on Phase 2)

Closes the report's deepest finding: recall requires knowing the answer's
vocabulary. Lexical-first stays the law; semantic is an additional signal,
off by default.

1. **Plugin options**: `semantic?: boolean` (default false),
   `semanticWeight?: number` (default 0.35).
2. **New `src/semantic/` directory**, the only place allowed to touch Node
   APIs, always via dynamic `import()` (the AGENTS.md instrumentation
   pattern) so `tsc` stays clean and non-Node runtimes degrade gracefully:
   - `embedder.ts`: static-embedding model (model2vec/potion family:
     per-token vectors, mean pooling — no ONNX runtime, no native addon).
     Model artifact (~30MB matrix) downloaded once via `fetch` to
     `~/.cache/opencode-session-recall/models/<name>/` using
     `import("node:fs")`; loaded into a `Float32Array` table. Load failure →
     warn once in search output, run lexical-only.
   - `similarity.ts`: brute-force cosine over `Float32Array`s (no ANN at this
     scale, per the recommendations doc).
3. **Embedding at cache-fill**: `CorpusCache` gains an optional embed step;
   each candidate stores `embedding?: Float32Array` computed once per session
   version. Cost is amortized exactly like tokenization.
4. **Hybrid merge in `smartScan`**: when enabled, compute the query
   embedding, take cosine top-K (K = 200) over the filtered candidates, and
   merge: `final = (1 - w) * lexRelative + w * cosine` for candidates in
   both sets; semantic-only candidates enter with `lexRelative = 0` and must
   clear `MIN_RELATIVE_SCORE` after the merge. `why.matchedFields` gains
   nothing; `matchReasons` (explain) records `Semantic: <cos>`.
   `queryPlan.variants` gains `"semantic"`.
5. **Eval**: `test/eval/semantic.test.ts` behind `RECALL_EVAL_SEMANTIC=1`
   (model download makes it unfit for default `npm run check`). Cases: the
   report's vocabulary-gap query ("how did we test the plugin interactively
   in a terminal") must retrieve `e-flow` with zero content-word overlap
   enforced in the fixture; plus a negative case asserting exact-error
   lexical queries are not degraded (lexical suite must stay at baseline with
   `semantic: true`).
6. **Docs**: README section with the storage location, model size, first-run
   download behavior, and how to disable.

This phase is deliberately last-but-one: it needs the cache (Phase 2), and
its value should be measured against the fully-improved lexical pipeline, not
against today's.

### Phase 10: Session digests (finding 10; deterministic first, LLM optional)

1. **Deterministic digest (ships first, no spike needed)**: at cache-fill,
   compute per session `digestText`: the first user message's first 200 chars
   plus the session's top 8 rarest tokens (by corpus document frequency,
   computable from the cache). Stored on `CachedSession`, indexed as a fifth
   BM25 field `digestText` with boost 0.4 (between `secondaryText` 0.6 and
   `titleText` 0.3; tune via eval), and added to Phase 6's Stage A metadata
   pool. This directly attacks the misleading-title finding with zero
   model dependency.
2. **LLM digest (spike-gated follow-up)**: a spike task first — verify the
   OpenCode SDK can run a summarization prompt without creating a visible
   session or side effects. If supported: opt-in `digests: "llm"` option,
   lazily generated, cached by `(sessionID, updated)`, budget-capped (only
   sessions touched by a search), replacing the deterministic digest text.
   If the SDK cannot do this cleanly, the deterministic digest stands and
   the LLM variant is dropped, recorded in this plan's Revisions.

Eval: a bridge case where neither title nor directory matches but the digest
does (first user message states the task in the query's vocabulary while all
subsequent content uses command vocabulary).

### Phase 11 (deferred): sequence retrieval and feedback capture (P2)

Not scheduled; design notes so a future change-set can start cold:

- **Workflow sequences.** After Phase 4, `topEvidence` covers most of the
  need. If dogfooding still shows gaps, add
  `sequence?: { before: SearchHit[]; match: SearchHit; after: SearchHit[] }`
  built from the matched part's neighboring tool parts within the same
  assistant turn, bounded to ±3 tool parts. With the cache, neighbors are
  already in memory; no new I/O.
- **Feedback capture.** A `test/eval/`-side fixture generator, not a product
  feature: a small script that takes a JSON description of a bad search
  (params, expected session, rejected hits) and emits a corpus session plus a
  case skeleton. Keeps the report's "record the refinement pain" idea without
  telemetry.
- **`recall_sessions` directory filter.** The report showed title browse is a
  strong discovery path; a `directory` arg (client-side filter over the list
  response, same `directoryMatches` helper) would make it stronger. Cheap,
  but schema growth; take it only if dogfooding asks again.

## Risks

- **Cache correctness is now load-bearing.** A staleness bug returns wrong
  history silently. Mitigations: invalidation is a comparison on `updated`
  (plus `messageCount` if needed) with two core correctness constraints from
  Phase 2 — an unknown `updated` (failed `session.get`) bypasses the cache
  and is never stored, and in-flight-sync pinning stops eviction from
  shrinking a running query's coverage; eviction otherwise only affects
  latency by construction; the parity tests port the entire existing
  filter/match suite onto the cached path; live tuistory verification
  exercises the cold→warm→invalidate cycle against a real host.
- **Memory footprint.** 50MB default text cap plus candidate overhead
  (tokens, normalized fields roughly double raw text) could reach
  ~150–200MB resident on maximal histories. Mitigations: `cacheMaxChars` is
  a plugin option; eviction is correct-by-construction; the performance
  validation in Phase 2 measures real numbers before release.
- **Default flip surprises a caller.** `excludeCurrentSession: true` changes
  global/project results for anyone who wanted in-session hits. Mitigations:
  scope-aware default never applies to explicit targets; zero-result
  suggestions name the lever; CHANGELOG headline.
- **Class penalties regress error recall.** Debugging queries often live in
  tool output. Mitigation: penalties apply only to `skill-definition` and
  `file-read`, never plain `tool-output`; `ERROR_TEXT_MULT` is untouched; the
  existing cross-project stderr eval case gates every phase.
- **Multiplier stacking drifts ranking.** Phases 3, 6, and 9 add signals to
  a multiplicative stack. Mitigation: the eval corpus grows in the same
  change-sets; any baseline movement is explicit in `baseline.json`'s
  `_note`; semantic merge is measured behind its own env-gated suite before
  any default changes.
- **Semantic model distribution.** A 30MB first-run download inside a plugin
  is a support surface (offline machines, proxies). Mitigations: opt-in,
  lexical fallback on any failure, documented cache path, no download unless
  `semantic: true`.
- **Two-stage merge double-boosts.** A shortlist session's candidates already
  carry `titleText` field boosts. Mitigation: `SHORTLIST_MULT` is small
  (1.1), the merge keeps max-not-sum of the two passes, and the bridge eval
  case plus baseline gate bound the drift.
- **Match-region truncation complexity.** Phase 5's splice helper has edge
  cases (match inside the kept head, match near end). Mitigation: pure
  function in `snippet.ts` with direct unit tests before wiring in.
- **`groupBySession` memory.** Tracking 4 hits per session instead of 1 is
  bounded by `MAX_GROUPED_LITERAL_RESULTS = 1000` incoming results; worst
  case ~4,000 retained references, acceptable.

## Verification

- `npm run check` (format, lint, typecheck, tests, compile) per phase.
- Relevance eval gates every ranking-touching phase; new cases land with the
  phase that satisfies them; `baseline.json` updated in the same commit.
  Semantic eval runs behind `RECALL_EVAL_SEMANTIC=1`.
- `runToolRaw` regression tests for every new or changed arg (host-bypass
  path, per AGENTS.md).
- Phase 2 performance validation against a real history (cold vs warm
  timings recorded in the PR).
- Live tuistory smoke after Phases 1, 2, and 5 (host-visible behavior):
  rebuild `dist/`, launch a throwaway opencode session, then
  (1) a global search for a distinctive string from this project's history
  confirming the current session is absent by default,
  (2) repeat the same search twice to confirm warm-cache latency and
  identical results, then add a message and search again to confirm
  invalidation,
  (3) an `expand:"context"` search against a session with a large tool dump,
  confirming sibling messages survive truncation.
  Close the session and remove the tmp dir.
- Docs per change-set: README parameter table (`excludeCurrentSession`,
  `excludeSessionID`, `queryPlan`, `topEvidence`, `cacheMaxChars`, `prewarm`,
  `semantic`), CONTRIBUTING architecture section (cache, two-stage plan,
  semantic module), CHANGELOG sections before any tag; the Phase 8 break gets
  its own release-note headline.

## Out of scope

- External services, vector databases, or any second authoritative store
  (the cache is derived and in-memory; the only disk artifact is the opt-in
  semantic model download, which is a static asset, not data).
- On-disk persistence of the index/cache itself (revisit only if cold-start
  latency proves painful in practice).
- LLM-generated query variants or synonym expansion (deterministic
  `codeTokens` only; semantic embeddings cover the vague-query case).
- New tools or removal of `recall_sessions`.
- Automatic memory writes.
- The report's `review-report` evidence class (no deterministic signal).

## Revisions

- **r2 execution notes (2026-07-16).** Recorded during implementation:
  - Phase 10's digest deviates from the "top 8 rarest by corpus document
    frequency" sketch: cross-session DF is unstable while the cache fills
    incrementally, so the digest uses in-session frequency over stopworded
    statement/action tokens (text/subtask parts and true command/cwd strings;
    read/skill tools and JSON pseudo-commands earn no credit). The main
    ranking signal is a DIGEST_MATCH_MULT (×1.15 when ≥ half the query tokens
    appear in the digest) rather than the field boost alone — field-boost
    arithmetic could not close the bridge case; the multiplier did.
  - The LLM digest variant is dropped: the SDK's `session.prompt` only sends
    visible messages into real sessions (create → prompt → delete), which
    costs model quota per digested session and pollutes history when cleanup
    fails. The deterministic digest stands.
  - `queryPlan.variants` is a capability inventory; `selected` records what
    ran (Phase 6 wording said "recorded from what ran" for the whole object).
  - Internal ranking scores are unclamped (clamped once at output): clamping
    per-hit erased every positive boost at the relative top.
  - The mergeShortlistHits ceiling is per-session with a floor-level re-entry
    for sessions whose broad counterparts the relative floor dropped
    (checkpoint-review findings).

- **r2 (2026-07-16).** Maintainer lifted constraints previously treated as
  hard. Added: Phase 2 incremental corpus cache (revives R3; deletes
  per-query candidate budgets, scan-order truncation, and the auto-recall
  session cap; expansion fetches on demand), `excludeCurrentSession` now
  defaults to true for global/project scopes (was opt-in), Phase 6 upgraded
  from a candidate-build-order tweak to the report's full two-stage
  title-shortlist search (the previously-dropped title-shortlist suggestion
  is reinstated in Phase 7), tool-size guard raised to 6,500/11,000, Phase 8
  output consolidation (breaking, release-noted), Phase 9 opt-in local
  semantic layer, Phase 10 session digests (deterministic first, LLM
  spike-gated). Finding 5 rewritten as the root architectural finding;
  finding 10 added. Phase numbering shifted (evidence classes 2→3,
  representatives 3→4, expansion 4→5, diversity 6→7).
- **r2 review round 2 (2026-07-16).** Codex confirmed all ten round-1
  findings resolved; two residual items fixed: Phase 6's deep pass now
  specifies a second shortlist-only MiniSearch index (MiniSearch fixes IDF at
  build time, so filtering the broad index cannot remove IDF dilution) with a
  test that fails on a filter-only implementation, and the cache risk bullet
  now names the unknown-`updated` bypass and in-flight-sync pinning as core
  correctness constraints.
- **r2 review (2026-07-16).** Codex review of r2: 4 discrepancies (session
  ordering claim, suggestions enumeration, "titles are the only session-level
  text", coverage-count semantics), 3 soundness issues (updated=0 staleness
  path, eviction pinning, applyGroupAndSlice reshaping for the tool-input
  swap), 3 gaps (title representative edge case, JSON-input `command`
  classification, three-call-site cache wiring). All addressed in place.
- **r1 (2026-07-16).** Initial plan; reviewed by Opus (2 rounds: 4 issues,
  4 nits, then 1 nit — all addressed).
