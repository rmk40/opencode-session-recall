# Recall Dogfooding Round-2 Fixes

Response to the second dogfooding round, run against the
`recall-retrieval-efficiency` branch build. The verdict there: materially
better, broad semantic discovery still inconsistent, plus seven concrete
problems. This plan covers the fixes; each numbered feedback item maps to a
fix or an explicit decision not to change anything.

Root causes were verified against both this repo and the opencode source
(`~/projects/oss/opencode`): the session table has an indexed `parent_id`
column that both list endpoints project into `Session.parentID`, child
sessions appear in list results by default (the `roots` filter is opt-in),
and both `list` and `listGlobal` apply a server-side `limit ?? 100` default
with no clamp on caller-supplied limits.

## Goal

Close the round-2 leaks: discovery must actually cover all history (not the
100 most-recent sessions), a search must never answer with the asker's own
delegation tree, expansion must never leak unbounded tool inputs, fetched web
content must rank as reference material rather than action evidence, and the
suggestion machinery must stop emitting mid-word shards.

## Constraints (unchanged from the executed plan)

- Eval baseline gate (`test/eval/baseline.json`, currently 13 cases at
  MRR/recall@5 = 1.0); new cases land with the fix that satisfies them.
- Defensive arg coercion + `runToolRaw` regression tests for anything new on
  the tool surface (host bypasses Zod defaults, per AGENTS.md).
- Tool-size guard 11,000 / 6,500 chars.
- Node-free core `src/`; five-tool surface; no external services.

## Fixes

### A. Discovery pagination past the server's 100-session default (severity: silent data loss)

Both `session.list` and `experimental.session.list` default to 100 rows
server-side. Our global discovery passes `limit: undefined` when
`maxSessions` is `Infinity`, so "all-history search" has really been
"the 100 most-recently-updated sessions" since the all-history default
shipped. The live verification's "99 sessions searched" was this cap minus
the excluded current session.

Implementation (`src/search.ts`):

1. New constant `DISCOVERY_LIMIT = 10_000`. The server applies caller limits
   unclamped, and session metadata rows are small (~300 bytes), so one large
   request is simpler and safer than cursor pagination (the server's cursor
   is a strict `lt(time_updated)`, which can skip rows that tie on the
   boundary timestamp).
2. Every discovery path that can currently send `undefined` resolves to
   `DISCOVERY_LIMIT` instead (five touch points, per review against source):
   - `sessionListLimit` when `maxSessions` is infinite and no `sessions` arg
     (`search.ts:1771`), consumed by the project (`:1895`) and global
     (`:1908`) list calls;
   - the directory+fallback second global list (`:1922`), which reuses
     `sessionListLimit`;
   - `listLimitForDirectoryFilter`'s no-cap branch (`:470`), which returns
     `undefined` today;
   - prewarm in `src/opencode-session-recall.ts` (`:122`), which calls list
     with `{}` and therefore warms only 100 sessions today.
3. Coverage honesty, scoped to completeness mode only: push
   `"providerLimit"` + the warning ONLY when a request we issued at
   `DISCOVERY_LIMIT` (no caller cap) came back with exactly that many rows —
   tracked per RAW list response at each call site, never from the
   post-dedupe merged total (directory+fallback concatenates two capped
   lists, so the merged length can approach 2× the limit without either
   response hitting the provider cap). Caller-requested `sessions: N` caps
   keep their existing `sessionsLimit` accounting — warning on those would
   over-warn every small explicit request. Warning text:
   `"Discovery returned the maximum requested sessions; older history may
exist beyond this window. Narrow with directory/title or time filters."`
4. Existing tests asserting `limit: undefined` in `calls.globalList`/
   `calls.projectList` (e.g. recall.test.ts:43, :127) are updated to expect
   `DISCOVERY_LIMIT`.
5. `recall_sessions` is untouched: it is a bounded browse tool whose limit is
   already explicit and user-capped.

Tests: the fake harness's `list` implementations must MIMIC the server
default (`slice(0, limit ?? 100)`) or the regression is untestable — update
`test/helpers.ts` and `test/eval/harness.ts` accordingly (verify no existing
test implicitly depended on unlimited fake lists). New test: a fixture with
120+ sessions where the only match lives in session #110; default global
search finds it, and `calls.globalList` shows the explicit large limit. A
second test pins the `providerLimit` + warning behavior when discovery
exactly hits the requested limit.

### B. Exclusion family: the current session's delegation tree (feedback #1)

`excludeCurrentSession` excludes exactly one ID, so evaluation/subagent
sessions spawned from the current session — which restate the query and
findings — take over the top ranks. This is the round-1 bug reborn one level
down.

Implementation:

1. `SessionMetaInternal` gains `parentID?: string`; `meta()` captures it from
   the list rows (the SDK populates `Session.parentID`), and the two manual
   target branches built from `session.get` (explicit `sessionID` at
   `search.ts:1844` and `scope:"session"` at `:1866`) capture it too — they
   sit outside default exclusion, but leaving them inconsistent would make
   the helper misleading for future callers.
2. New pure helper in `src/search.ts` (exported for tests):
   ```ts
   /** The current session's delegation tree within the discovered set:
    *  walk parentID up to the highest discovered ancestor (bounded depth),
    *  then collect that root's transitive descendants. */
   function exclusionFamily(
     discovered: SessionMetaInternal[],
     currentSessionID: string,
   ): Set<string>;
   ```
   Mechanics: `byID` map + `childrenByParent` multimap over `discovered`;
   ascend from `currentSessionID` via `parentID` (depth cap
   `MAX_FAMILY_DEPTH = 16`, cycle-guarded by a seen-set) to the top-most
   discovered ancestor; BFS descendants from that root. Always includes
   `currentSessionID` itself even when undiscovered.
3. In `execute`, when `excludeCurrent` is active, the excluded set becomes
   `exclusionFamily(discoveredTargets, currentSessionID)` plus
   `excludeSessionID` (which stays a single ID — callers excluding an
   arbitrary session get exactly what they asked for). Placement is exactly
   where exclusion filters today: after
   `discoveredTargets = dedupeSessions(targets)` and before directory
   bucketing, filtering `consideredTargets` while `discoveredTargets` stays
   raw, so the `skippedByReason`/`sessionsSkipped` reconciliation is
   untouched.
4. Accounting unchanged in shape: all removed family members count into
   `skippedByReason.excludedSession`; `limitedBy` unchanged
   (`"excludedSession"`).
5. Contradiction errors unchanged: only exact current-session conflicts
   error; explicitly targeting a sibling/child via `sessionID` is allowed
   (the default doesn't apply when `sessionID` is set).
6. Tool description: the existing exclusion sentence gains three words
   ("...and its subagent sessions...") within the size guard.

Tests: fixture tree root → current → {child, grandchild} plus a sibling
under root; searching from `current` excludes all of them; searching with
ctx set to the child excludes root/sibling too (ancestor walk); orphaned
`parentID` pointing outside the discovered window still excludes the known
subtree; `excludeCurrentSession: false` restores everything; cycle in
parentID data does not hang; `runToolRaw` unaffected (no new args).

Eval: add `e-cur-sub`, a child of `e-cur` (`parentID: "e-cur"`) restating the
workflow query and "findings"; the field-report workflow case gains
`notInResults: ["e-cur", "e-cur-sub"]`. Requires the eval corpus session
builder to accept a `parentID` (extend `session()` in `test/helpers.ts` with
an optional options arg).

### C. Expansion `input` leak (feedback #5)

`truncateExpandedPart` budgets `content`/`output`/`error` but spreads
`part.input` through untouched — a Write-style tool input embedding a whole
file bypasses every expansion budget. That is the 85–90 KB responses.

Implementation (`src/search.ts`):

1. New constant `MAX_EXPANDED_INPUT_CHARS = 2_000`.
2. In `truncateExpandedPart` (after the self-tool redaction), process
   `part.input`: serialize with `JSON.stringify` (try/catch → `undefined` on
   circular); if the serialized form fits both `MAX_EXPANDED_INPUT_CHARS`
   and the remaining part budget, keep the ORIGINAL value (shape preserved
   for small inputs) and charge the serialized length to the part budget;
   otherwise replace with the truncated serialized STRING plus the existing
   `EXPANSION_TRUNCATED` marker, charging what was kept. Set
   `partBudget.truncated` accordingly so the existing warnings fire.
   The self-tool redaction's early return currently spreads `part.input`
   through untouched; fold `input: undefined` into that return so the
   "never leak unbounded inputs" claim holds on every path (and the
   redaction comment stays honest).
3. `recall_get`/`recall_context` untouched (full-fidelity retrieval is their
   contract; the marker already points at `recall_get`).

Tests: oversized input (e.g. 50 KB embedded file text) is truncated to a
marked string and the response stays bounded; small object input passes
through with identity (still an object, not a string); input length is
charged against the part budget (a part with a large-but-capped input leaves
correspondingly less for `output`); `JSON.stringify` edge cases —
`undefined` (e.g. an input that is a bare `undefined` or a lone function)
and a throwing serializer (circular reference) — degrade to omitting the
input, never to an unhandled error.

### D. `penCode`: boundary-anchor the code-token regex (feedback #6)

`CODE_TOKEN_RE`'s camelCase alternative has no left boundary, so "OpenCode"
matches from its second character and the literal-search suggestion emits
`query: "penCode"`.

Implementation (`src/query.ts`): prefix the whole alternation with a
lookbehind — supported in every runtime this plugin targets:

```ts
const CODE_TOKEN_RE =
  /(?<![A-Za-z0-9])(?:[A-Za-z0-9]+(?:[_./-][A-Za-z0-9]+)+|[a-z]+(?:[A-Z][a-z0-9]+)+|[A-Z]{2,}[A-Z0-9_]*)/g;
```

Note the deliberate consequence: a PascalCase single word ("OpenCode")
matches NO alternative (it is ordinary prose naming, not a code anchor), so
neither the boost nor the suggestion fires on it.

Tests (rows in the existing codeTokens table): `"use OpenCode here"` → `[]`;
`"deploy myVarName now"` → `["myVarName"]`; `"xOpenCode"` →
`["xOpenCode"]` and NOT containing `"penCode"` — the lookbehind blocks a
match STARTING mid-word but rightly keeps a legitimate lowercase-led
camelCase token whole (review correction: asserting `[]` here would tempt
an implementer to break real camelCase anchors); existing rows unchanged.

### E. Fetched-reference evidence class (feedback #3)

Firecrawl/webfetch output is classified `tool-output` today, which is
deliberately unpenalized (error-recall protection) — so fetched web pages
and search dumps rank as action evidence. They are reference material, like
file reads.

Implementation:

1. `EvidenceClass` gains `"web-fetch"` (`src/types.ts`).
2. `evidenceClassFor` (`src/extract.ts`): AFTER the tool-input check, when
   `toolNameMatches` any of
   `["webfetch", "fetch", "scrape", "crawl", "search", "extract"]`
   (a `WEB_FETCH_BASES` const; suffix matching makes
   `mcp__firecrawl__firecrawl_scrape` and `web_search` match), classify as
   `"web-fetch"`; otherwise `tool-output`. Ordering matters (review
   finding): tool-input keeps precedence, so a COMMAND/input-only match on a
   `code_search`/`archive_extract`-style tool still classifies as the action
   it is — only output-side matches on fetch-shaped tools become reference
   material. Known remaining overreach, accepted and documented: an
   output-side match on any tool whose name ends in `search`/`fetch`/
   `extract` classifies as fetched reference; those are lookups by
   construction, the ×0.85 penalty is mild, and the base list is easily
   amended. (Adjudication note: the two plan reviewers disagreed on this
   ordering. Resolution: input precedence wins — asking to scrape a URL IS
   the action a workflow query wants to recover, while the fetched page
   content is the reference material the round-2 feedback saw dominating;
   "Firecrawl outputs", not Firecrawl commands, were the complaint. The
   ordering is load-bearing, not cosmetic: toolInputTexts files the entire
   JSON input under the command field, so EVERY completed fetch part carries
   a command-field candidate — a before-input check would swallow all of
   them and no fetch tool could ever classify as tool-input.)
3. `src/bm25.ts`: `WEB_FETCH_MULT = 0.85` (same tier as skill payloads —
   this is exactly the material the feedback saw dominating).
4. `CLASS_CAPS` (`src/search.ts`): `"web-fetch": 2` (same as file-read).
5. `CLASS_PRIORITY`: insert after `"file-read"`.
6. Reviewer-session content stays unaddressed by class (no deterministic
   signal — decision carried over from round 1); Fix B removes the worst
   instances (reviewer subagents of the current session).

Tests: classifier rows (bare + namespaced fetch/scrape/search names; a bash
part is untouched; an input-only match on `code_search` stays tool-input —
the precedence row); a BM25 ordering test where a fetched page loses to a
command input at equal lexical strength; cap test row in the capAndSlice
suite. Docs: README and CONTRIBUTING must add `web-fetch` everywhere the
class union, multiplier table, and caps are documented (README lists only
file-read/skill-definition as reference material today).

### F. Representative tolerance (feedback #4)

`topEvidence` frequently held the right material while a lexically dominant
weak-class hit kept the representative slot: the 0.85 tolerance is too tight
for the utility ordering to act.

Implementation: `REPRESENTATIVE_TOLERANCE` 0.85 → 0.7 (`src/search.ts`),
comment updated. Gated by: the existing representative unit tests (the
dominant-hit case sits at 0.5, still outside 0.7) and the full eval. If the
eval regresses, stop at 0.75 and record the number in this plan's Revisions.

### G. Best-effort digests in `recall_sessions` (feedback #7, optional)

`recall_sessions` is title-only at the DB level (`LIKE` on title), so a
misleading title is invisible to it by construction. Full digest support
would require message fetches, breaking its cheap-browse contract. Instead:
attach digests only for sessions already warm in the shared cache.

Implementation: `CorpusCache.peekDigest(id: string): string | undefined`
(read-only, no fetch, no pin); `sessions()` gains the cache parameter and
adds `digest?: string` (first 160 chars) to `SessionItem` when available.
Plugin entry passes the shared cache. Zero new fetches, zero behavior change
when cold.

Tests: warm cache → digest present; cold → absent; output shape additive.

### Explicitly not code changes

- **Broad paraphrases (feedback #2):** the designed answer is the semantic
  layer, which is opt-in and was not enabled in the round-2 test. Action:
  the env-gated semantic eval already covers the paraphrase shape; the
  README's semantic section is the enablement path. Recommend re-running the
  round-2 paraphrase queries with `semantic: true` before any further
  lexical work; if they still fail WITH semantic enabled, that is a new
  finding for a round 3.
- **Generated-evidence "reviewer sessions"** beyond Fix B/E: no
  deterministic classification signal; unchanged decision from round 1.

## Execution order

Two change-sets, then the review loop:

1. **Change-set 1 (completeness + exclusion):** A + B, with the harness
   server-cap mimicry and the eval corpus child-session addition. These two
   interact (family filtering runs over the now-complete discovered set), so
   they ship together.
2. **Change-set 2 (ranking + hygiene):** C + D + E + F + G and the doc
   touch-ups (README/CONTRIBUTING/CHANGELOG Unreleased additions).
3. Opus + Codex review of both change-sets; fix to zero findings; full
   `npm run check` gate throughout; live tuistory spot-check of A + B
   (a global search must now report sessionsSearched > 100 on a history
   that size, and a subagent-heavy session must not leak its children).

## Risks

- **A: response size of large discovery.** 10k metadata rows ≈ ~3 MB JSON
  from a local server — fine; the cache means repeat cost is metadata-diff
  only. If a history exceeds `DISCOVERY_LIMIT`, coverage now says so
  honestly (`providerLimit` + warning) instead of silently hiding it.
- **A: harness cap mimicry breaks unrelated tests.** Any existing test with
  > 100 fixture sessions would newly truncate — audit shows the largest
  > fixture is ~10 sessions plus the 5-session filler test (well under).
- **B: family over-exclusion.** A user searching from a subagent loses the
  parent's content by default. That is the correct default for "search prior
  history" (the parent IS the current conversation, one level up), and
  `excludeCurrentSession: false` restores everything.
- **B: window-bounded ancestry.** If an ancestor lies outside the discovered
  window, the walk stops at the highest discovered ancestor; with Fix A the
  window is effectively the whole history, so this is theoretical.
- **E: `search`/`fetch` suffix overreach** could down-rank an action tool
  with an unlucky name. Bounded: ×0.85 is a mild penalty, the cap still
  allows two hits, and the constant list is easily amended.
- **F: ranking drift.** Single-constant change gated by the eval; fallback
  documented.

## Verification

- `npm run check` per change-set; eval baseline holds (plus the new
  child-session case).
- `runToolRaw` coverage: no new tool args (B/C/D/E/F are behavior); G adds
  an output field only.
- Live tuistory: (1) global search on the real history reports
  sessionsSearched greater than the old 100 ceiling; (2) from a session with
  live subagent children, the workflow query returns no family members;
  (3) an expansion over a Write-heavy session stays bounded.
- CHANGELOG Unreleased gains all of A–G.

## Out of scope

- Cursor-based incremental discovery (revisit only if `DISCOVERY_LIMIT`
  proves insufficient in practice).
- Reviewer-session classification.
- Changing the semantic layer's default posture (round-3 decision, after a
  semantic-enabled retest).
