# Recall Scale Correctness (Round 3)

Live incident: three smart global searches on the round-2 build ran for
minutes with pegged CPU and rapidly climbing memory. Root cause chain,
empirically confirmed:

- Round-2 Fix A removed the accidental 100-session discovery cap; the real
  corpus is 4,709 sessions / ~360k searchable parts (~47× larger).
- Round-1 Phase 2 deleted the per-query candidate budgets on the stated
  assumption "per-query MiniSearch rebuild is cheap" — true at the ≤10k
  candidates the old discovery window produced, catastrophically false at
  360k.
- Benchmark at 1/6 real scale (60k candidates, realistic 20k-char dump mix):
  **one smart query = 40.6s CPU, 936MB heap.** Split: **index build 30s
  (75%)**, per-hit stage (Levenshtein matched-terms, matched-fields
  re-tokenization, snippets for ALL 31k hits) 10s. Extrapolated to 360k
  parts: minutes and multi-GB per query — the observed hang.

Three unbounded stages, three fixes, plus memory accounting and ops.

## Goal

A warm smart query over a 360k-part corpus completes in low single-digit
seconds with bounded memory, with ranking quality preserved (eval baseline
holds exactly) and the completeness contract intact.

## Constraints

Unchanged: eval baseline gate; runToolRaw coercion for any new tool surface
(none planned); tool-size guard; Node-free core src/. The completeness
contract from round 2 must NOT regress: no scan-order truncation, discovery
stays full-history.

## Fix 1: Persistent incremental MiniSearch index owned by CorpusCache

The per-query index rebuild is the dominant cost and is pure waste: the
corpus changes per session version, not per query.

1. `CorpusCache` owns one long-lived `MiniSearch` instance plus a
   `candidateByPartID: Map<string, Candidate>`:
   - on store (fetch success for a known version): `addAll` the session's
     candidate docs (same fields/boosts/tokenizer as today);
   - on replace: `discard` the previous version's partIDs first;
   - on evict: `discard` the evicted session's partIDs;
   - MiniSearch's default autoVacuum handles tombstone cleanup.
2. **Small-query side path** (review-driven redesign): when the query's
   total eligible candidates are small — `scope:"session"`, explicit
   `sessionID`, narrow directory filters, or any unknown-`updated` sessions —
   below `SIDE_INDEX_THRESHOLD = 20_000` candidates, build a per-query index
   over exactly those candidates, as today. This was always cheap at small
   scale and it simultaneously resolves two review findings: (a) temporary
   `addAll` into the shared index is unsafe (an unknown-version session may
   ALREADY be indexed under an older version, and MiniSearch throws on
   duplicate IDs with no rollback in `addAll`); (b) narrow scopes would
   otherwise pay full global posting traversal, since MiniSearch's `filter`
   runs post-query. Unknown-version sessions ALWAYS route to the side path
   regardless of pool size (they are rare and their candidates are never in
   the persistent index). Mixed case (some cached targets + some unknown):
   side-index the unknown ones and merge with the persistent-index results
   using the existing ceiling-anchor helper.
3. Query path (`bm25Search` reshaped): receives either the cache's
   persistent index + `candidateByPartID`, or (small-query path) a freshly
   built side index. API contract per review: MiniSearch's `filter` receives
   a SearchResult (`{ id, score, ... }`), NOT our candidate — so the
   persistent index switches `idField` to the STABLE STRING partID (today's
   per-query numeric index id goes away), and the filter closure looks up
   `candidateByPartID.get(result.id)` then applies
   `targetSet.has(candidate.sessionID) && candidateEligible(candidate,
filters)`. partID global uniqueness assumption: opencode part IDs are
   globally unique `prt_*` identifiers (title candidates already namespace
   as `<sessionID>:title`); stated as an invariant, and every add path is
   defensively guarded (discard-if-`has()` before add) so a violation
   degrades to replace-not-crash. Every `discard` is
   guarded by `has()` (MiniSearch throws on discarding absent IDs); vacuum
   stays on MiniSearch's auto defaults, with corpus tests covering
   replace/evict/re-add churn through search-visible behavior. No `await`
   may sit between index mutation and the searches that depend on it. The
   assembly step (per-session eligible arrays) remains for coverage counts
   and the literal/regex paths.
4. Shortlist deep pass keeps its own per-query index (shortlist-local IDF is
   the point) but bounded: `DEEP_PASS_MAX_CANDIDATES = 20_000`; when the
   shortlist's eligible candidates exceed it, skip the deep pass and note
   `"title-shortlist:skipped-size"` in `queryPlan.selected`.
5. IDF note: the persistent index spans ALL cached sessions, so IDF is
   corpus-global rather than per-query-target-set. This is a deliberate,
   documented semantic shift (it is also more stable across scopes); the
   eval gates the effect. Filters run post-scoring via `filter`, exactly how
   MiniSearch is designed to be used.
6. The relevance floor, merges (shortlist, semantic), and multipliers move
   to the two-phase structure below.

## Fix 2: Two-phase ranking with a bounded refinement window

Today every OR-matched hit (31k in the benchmark) pays: a token-pool Set
build, Levenshtein matched-terms, matched-fields with full re-tokenization
of every field text, and phrase/code-token `includes` over up to 20k chars.
That work only matters near the top.

1. **Phase 1 (all raw hits, O(1) per hit):** relative BM25 score × cheap
   multipliers only — recency, reasoning-part, user-role, error-text and
   name-based penalties for skill/read ONLY. To make these O(1), precompute
   AT CACHE FILL on each candidate: `nameClass` (skill-definition /
   file-read / web-fetch / undefined, from the tool name) and
   `hasErrorText` (the `containsErrorPattern` scan over the SAME truncated
   rawText that is retained, once per version). Fetch-shaped tools get NO
   phase-1 penalty (review finding): whether they are tool-input (boost) or
   web-fetch (penalty) is query-dependent, and pre-penalizing could push
   input-only fetch actions out of the window before phase 2 can raise
   them. Erring high on fetch parts is window-safe; phase 2 corrects.
2. **Refinement window:** sort phase-1, take
   `RANK_WINDOW = max(500, results × 50)` top hits.
3. **Phase 2 (window only):** the full existing stack — exact phrase, exact
   code token, matched terms/coverage (Levenshtein over an ON-DEMAND token
   pool that reproduces today's indexedTokenPool exactly:
   tokenize(rawText) ∪ tokenize(directory) ∪ tokenize(title) ∪
   tokenize(toolName), review finding), matched fields, full evidence-class
   resolution (tool-input vs web-fetch), digest match, weak-fuzzy and
   poor-coverage penalties. Re-sort window ∪ tail (tail keeps phase-1
   scores); apply the relative floor against the refined top.
4. **Merge calibration (review-driven ordering):** mergeShortlistHits and
   mergeSemanticHits are calibrated against FULLY-BOOSTED scores today
   (per-session ceilings, deep tops, lexTop scaling). Therefore each pass
   is refined BEFORE merging: broad phase-1 → broad window refined; deep
   pass (bounded pool) phase-1 → deep window refined; THEN the shortlist
   merge (ceilings and deep tops read refined heads; below-window tails
   carry phase-1 scores, which only matters outside the ranks anchors are
   taken from); THEN the semantic merge (lexTop = refined top; cosine top-K
   is 200 ≤ window, so blended candidates are window members or become
   materialization candidates). Final combined sort → floor → materialize.
5. Ranking-quality argument: total phase-2 multiplier range is ~×0.7–×2.1,
   so any hit that could reach the top-`results` slots after refinement is
   within the top ~2×results·(maxBoost/minBoost) of phase-1 — orders of
   magnitude inside a 500+ window. The eval corpus (15 sessions) sits
   entirely inside every window; with the refine-before-merge ordering the
   anchors read the same fully-boosted values as today, so the baseline is
   EXPECTED to hold exactly — and the eval is the arbiter: if any case
   moves, stop and re-derive the ordering rather than adjusting the
   baseline.

## Fix 3: Lazy result materialization

`rankedToSearchResults` currently materializes every hit (snippet scan over
up to 20k chars each, annotation, object build) before any slicing.

1. Part mode: materialize only the refined window, then run
   diversify → directory ordering → capAndSlice within it (all already
   bounded by the window).
2. Grouped mode (review-corrected for completeness): GROUPING runs over the
   FULL phase-1 hit list as (sessionID, score, partID, time) tuples — no
   materialization, no window — so group DISCOVERY, `total`, and `hitCount`
   remain complete exactly as today (a session whose only hits sit deep in
   the tail still appears as a grouped result). The top
   `MAX_GROUP_TRACKED` hits per session are tracked during that same pass;
   phase-2 refinement and materialization then run only over the tracked
   hits of the sessions that can reach the final slice (top
   `results × 5` sessions by best phase-1 score — bounded at ≤ 4×that many
   hits; the ×5 headroom covers directory-fallback reordering). Sessions
   beyond that window appear in `total` but are never RETURNED, so their
   unrefined representatives are never visible — no observable quality
   regression for tail-only sessions (review point addressed).
   `evidenceKinds` derives from the session's TRACKED hits — the one
   contract narrowing, release-noted (README wording: "classes among the
   session's strongest hits").
3. smartSnippet, `annotateResult`, and `why` construction run only on
   materialized hits.

## Fix 4: Honest memory accounting and retention cuts

Benchmark heap was 936MB at 1/6 scale; `cacheMaxChars` counts only
`rawText`, while each candidate ALSO retains `fieldTexts` (a full second
copy), `tokens` (a third), and `primaryText` (a fourth).

1. `charCount` counts what is actually retained AFTER the retention cuts:
   rawText + Σ fieldTexts (primaryText is released per 4.3 so it is NOT
   counted; the small per-session normalized fields are shared or
   negligible and excluded — review consistency fix). The 50M default now
   means ~50M chars held, so LRU eviction engages at real budgets. Document
   in README (`cacheMaxChars` semantics: retained text, not raw text).
2. Drop `Candidate.tokens` retention entirely: consumers are the digest
   builder (fill-time — use a transient local), and phase-2 matched-terms
   (window-only — the on-demand pool defined in Fix 2.3, which reproduces
   indexedTokenPool's title/directory/toolName coverage, not just rawText).
   Update helpers/tests that construct candidates.
3. `primaryText` is still needed by the persistent index only at add time
   and by the deep-pass/side indexes (bounded pools): release it after the
   persistent add (`candidate.primaryText = undefined`) and HARD-rehydrate
   via `normalize(rawText)` before any side/deep index add — never fall
   back to indexing "" (today's silent `?? ""` fallback becomes a
   rehydrate step; review finding). (titleText/secondaryText/hintText/
   digestText are small or shared — retained.)
4. Semantic embeddings at this scale are ~1KB × parts (≈360MB); note in the
   README semantic section that memory scales with corpus size; no code
   change this round (opt-in feature).

## Fix 5: Ops and guardrails

1. `DEFAULTS.concurrency` 3 → 8: the cold sync of 4,709 sessions at
   concurrency 3 is minutes of serialized localhost HTTP for no benefit.
2. README: document cold-start expectations at full-history scale and
   recommend `prewarm: true`; note that the first search on a large history
   pays the sync once.
3. Perf regression harness: `test/perf.test.ts` gated behind
   `RECALL_PERF=1` (machine-dependent timing is not CI-stable): builds the
   60k synthetic corpus, asserts a warm smart query end-to-end under
   3 seconds and that a second identical query is not slower (index reuse).
   Run once during this change-set and record numbers in the plan Revisions.
4. The wall-clock TIME_BUDGET stays as the safety valve but should now be
   an anomaly, not a routine ceiling.
5. Cold-sync sharing note: the per-session-version in-flight map already
   single-flights fetches across the tool, both hooks, and prewarm — a
   hook that times out (Promise.race) abandons a sync that keeps running
   and warming the shared cache, which is the desired behavior; pins are
   released in the execute finally when that background completion lands.
   The post-abort tail is bounded by one in-flight batch
   (`concurrency` fetches). Document, and cover with a test where two
   searches race one cold sync.
6. Literal/regex hardening: the wall-clock check currently sits between
   sessions only; add a coarse check every N candidates (e.g. 512) inside
   the scan loops so a single huge session cannot overrun the budget by
   itself.

## Execution

One change-set (the fixes are interlocking: the index move reshapes
bm25Search's signature, which the phasing and materialization build on),
implemented against this plan, then:

- full `npm run check` (eval must hold at exactly baseline);
- Opus + Codex implementation review to zero findings;
- the perf harness run at 60k scale with before/after numbers recorded;
- live re-test of the three incident queries via tuistory: all three must
  return, warm queries in seconds, memory stable across repeats.

## Risks

- **Persistent-index memory** is a new steady-state cost (the inverted
  index over the retained corpus). It replaces N per-query rebuilt copies
  with one; combined with the retention cuts, steady-state should be well
  below today's single-query peak. The perf harness records heap.
- **Corpus-global IDF** (Fix 1.5) slightly changes scores for narrow-scope
  searches. Eval-gated; also arguably more correct (term rarity is a
  property of the history, not of the filter).
- **Window misses**: a hit needing the maximum phase-2 boost from deep in
  the tail could theoretically be excluded by the window. The window is
  ≥500 for default requests and scales with `results`; the multiplier-range
  argument bounds the exposure, and the eval plus the round-2 field cases
  gate observable regressions.
- **evidenceKinds narrowing** is a minor output-contract change,
  release-noted.
- **MiniSearch discard/vacuum behavior** under heavy replace churn is the
  new moving part; the corpus tests must cover replace/evict/re-add through
  the index (search-visible behavior, not internals).
- **Eviction vs in-flight queries**: mini.search is synchronous and a
  query's targets are pinned until its finally-release, so the shared index
  cannot lose a query's own sessions mid-query; the invariant to preserve
  in implementation is that the persistent-index search runs while the
  query's pins are held (before release), which the current execute
  structure already guarantees. A concurrent query may evict sessions
  OUTSIDE this query's target set — harmless by construction.
- **Deep-pass/side-index rehydration** re-derives normalize(rawText) for
  bounded pools (worst case DEEP_PASS_MAX_CANDIDATES × 20k chars ≈ 400M
  chars in a pathological shortlist); typical shortlists are far smaller,
  and the cap plus skip-note bound the cost. Accepted trade for the
  primaryText memory cut.

## Out of scope

- Literal/regex scan costs (native `includes` over the corpus, bounded by
  SCAN_TIME_BUDGET) — acceptable today; revisit if dogfooding shows pain.
- Semantic embedding memory reduction.
- Serialized on-disk index persistence.
