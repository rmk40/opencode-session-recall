# Search Mechanism Implementation Plan

Actionable implementation plan for the search-mechanism work. Scope is **R1
(invocation hooks)**, **R2 (BM25 ranker)**, and **R5 (regex, diversity, query
routing, eval fixtures)** from `search-mechanism-recommendations.md`.

R3 (incremental cache) and R4 (semantic layer) are **explicitly dropped** — searches
are near-instant even on large histories, so no persistent index or embedding layer
is needed. Dropping R4 also removes the model2vec/ONNX caveat entirely.

Every load-bearing fact below was verified against source, not assumed. The
**Verified facts** section records each spike and its evidence.

---

## Verified facts (spikes completed)

### Hook dispatch (opencode core at `../opencode`)

- **`plugin.trigger(name, input, output)`** iterates registered hooks in order and
  calls `fn(input, output)`, awaiting each, then returns the **same `output` object**.
  Hooks mutate `output` in place. (`packages/opencode/src/plugin/index.ts:280-293`)
- **`experimental.chat.system.transform`** — input `{ sessionID, model }`, output
  `{ system: string[] }`. Fires on the system-prompt assembly path of **every** LLM
  request. Hooks **push strings onto `system`**; downstream re-collapses entries.
  (`packages/opencode/src/session/llm/request.ts:69-78`; also triggered in
  `agent/agent.ts:379`)
- **`chat.message`** — input `{ sessionID, agent, model, messageID, variant }`, output
  `{ message, parts }`. Fires when a user message is processed, **before** model parts
  are built; downstream uses the (mutated) `resolvedParts`. Core itself appends
  synthetic parts of shape `{ messageID, sessionID, type: "text", synthetic: true,
text }`. (`packages/opencode/src/session/prompt.ts:982-992`, synthetic example
  `:962-972`)
- **`experimental.session.compacting`** — input `{ sessionID }`, output
  `{ context: string[], prompt?: string }`. Pushing to `context` appends those strings
  into the compaction summary prompt via
  `buildPrompt({ previousSummary, context })`; setting `prompt` replaces it wholesale.
  (`packages/opencode/src/session/compaction.ts:353-358`; `buildPrompt` spreads
  `...input.context` in `packages/core/src/session/compaction.ts:166-173`)
- **`experimental.chat.messages.transform`** — input `{}`, output `{ messages }`.
  Note its input carries **no sessionID** (confirmed; third-party plugins warn about
  this). Not needed for this plan; prefer `chat.message` / `system.transform`.

### Plugin context & registration

- `PluginInput` provides `{ client, project, directory, worktree, serverUrl, $ }`
  (`../opencode/packages/plugin/src/index.ts:56-61`). No `sessionID` at plugin-init
  time — `sessionID` arrives **per hook invocation** in the hook `input`.
- Hooks are returned from the same factory that currently returns `{ tool, config }`
  (`src/opencode-session-recall.ts`). Adding hook keys is additive.
- `ToolContext` (per-tool-call) provides `sessionID, messageID, agent, directory,
worktree, abort, metadata, ask` (`test/helpers.ts:473-483`).

### Test harness

- Fake `OpencodeClient` built by hand in `test/helpers.ts` (`makeFakeHarness`,
  `makeFixture`, `makeContext`, `runTool`/`runToolRaw`).
- Plugin factory is directly testable: `plugin.default.server(ctx, opts)` returns the
  hooks object; `test/plugin.test.ts` already asserts tool registration and config.
- **Tool-size guard already exists** (`test/plugin.test.ts:90-100`): total LLM-facing
  chars `< 9000`, recall `< 5000`. Any system-prompt nudge text and schema additions
  must respect this budget (the nudge string is injected at runtime via the hook, not
  part of tool descriptions, so it does **not** count against this guard — but keep it
  short regardless).
- Vitest + `tsup` ESM build; `npm run check` runs format/lint/typecheck/test/compile.

### MiniSearch (npm)

- **7.2.0, MIT, zero dependencies**, ships ESM (`dist/es/index.js`) + types, ~827KB
  unpacked. Compatible with the plugin's ESM/tsup/TS toolchain.
- Built-in **BM25+** scoring (`bm25: { k, b, d }` — docs say tuning is "almost never
  necessary"; prefer `boost`/`boostDocument`).
- `search(query, options)` returns `Array<{ id, score, terms, match, ...storedFields }>`.
- Relevant search options (verified): `boost: {field: n}`, `boostDocument: (id, term,
storedFields) => number` (**falsy return drops the result** — usable for diversity),
  `boostTerm`, `combineWith: 'AND'|'OR'`, `fields`, `filter: (result)=>boolean`,
  `fuzzy: number|boolean`, `maxFuzzy`, `prefix`, plus index-vs-search `tokenize` /
  `processTerm` overrides.
- Constructor: `new MiniSearch({ fields, storeFields, tokenize, processTerm,
searchOptions })`. Docs (id `/lucaong/minisearch`).

---

## R1 — Invocation hooks

Goal: make `recall` actually used. Three coordinated, individually-configurable hooks.
Conservative defaults. New plugin options (extend `Options` in
`src/opencode-session-recall.ts`).

### New options

```ts
type Options = {
  primary?: boolean;
  global?: boolean;
  // R1 additions:
  nudge?: boolean; // R1a system-prompt reminder. Default: true
  autoRecall?: boolean; // R1b gated auto-recall on chat.message. Default: false
  compactionRecall?: boolean; // R1c preserve durable findings at compaction. Default: false
} & Partial<Limits>;
```

Rationale for defaults: R1a is cheap and safe (on). R1b/R1c inject content into the
model's context and carry noise/latency risk, so they ship **opt-in** until dogfooded.

### R1a — system-prompt nudge (`experimental.chat.system.transform`)

- **New file** `src/hooks/system-nudge.ts` exporting a factory
  `systemNudge(): NonNullable<Hooks["experimental.chat.system.transform"]>`.
- Behavior: `output.system.push(NUDGE_TEXT)`. One short paragraph (~3-4 sentences,
  target < 400 chars). Content: instruct the model to call `recall` when the user
  references prior work / previous sessions / past decisions, or uses vague
  back-references ("that bug", "same as before", "what did we decide"), before
  re-deriving anything.
- Idempotency: guard against double-injection if the same `system` array is processed
  twice — check `!output.system.some(s => s.includes(NUDGE_SENTINEL))` using a short
  sentinel substring.
- Wire in factory only when `nudge !== false`.

**Tests** (`test/hooks-system-nudge.test.ts`): pushes text; idempotent on repeat
invocation; omitted when `nudge:false`; nudge string stays under length budget.

### R1b — gated auto-recall (`chat.message`)

The highest-impact and highest-risk piece. Must be cheaply gated so it almost never
runs broad searches.

- **New file** `src/hooks/auto-recall.ts` exporting
  `autoRecall(client, unscoped, global, limits): NonNullable<Hooks["chat.message"]>`.
- **Trigger gate** (pure function `shouldAutoRecall(parts): { run: boolean; query?: string }`):
  - Extract user text from `output.parts` (type `text`).
  - Fire only when text matches a tight allowlist of deictic/history cues
    (case-insensitive word-boundary regex): `last time`, `previously`, `earlier`,
    `before`, `remember`, `recall`, `same as before`, `what did we (decide|do|use)`,
    `the (approach|fix|bug|error|decision) (we|you)`, `in another session`,
    `prior (fix|session|work)`, `we already`.
  - Derive a compact query from the surrounding noun phrase / the user text minus the
    cue words (bounded length; fall back to the whole message capped at N chars).
  - Hard skip if message is too short, is a slash command, or contains an explicit
    `recall(` style request (the model is already going to call it).
- **Execution**: call the existing search core (see R2 refactor — extract a callable
  `runSearch(params)` that both the tool and this hook share) with conservative params:
  `match: "smart"`, `group: "session"`, `results: 3`, `scope: "global"`, snippet width
  small. Wrap in try/catch — **never throw** (a hook throwing would disrupt the turn).
  Bound with the existing time budget; if it returns nothing, do nothing.
- **Injection**: append one synthetic text part to `output.parts` of shape
  `{ messageID, sessionID, type: "text", synthetic: true, text: BLOCK }` (shape verified
  from core). `BLOCK` is a compact, clearly-labeled, cited list:
  ```
  <recall-auto>
  Possibly relevant prior history (auto-recall; verify before relying on it):
  - [<sessionTitle> · <relative date> · session <id8>] <snippet>
  ...
  Use recall_get / recall_context for full detail.
  </recall-auto>
  ```
  Cap at 3 hits and a total char budget (~800). Mark clearly as "possibly relevant" so
  the model treats it as a lead, not ground truth.
- **Config/option**: only register when `autoRecall === true`.
- **Concurrency/perf note**: `chat.message` is awaited inline before the model runs, so
  the auto-recall latency is on the critical path — keep `results` small and reuse the
  existing 2s budget. Document this in README.

**Tests** (`test/hooks-auto-recall.test.ts`): gate fires on cue phrases, not on plain
task messages; derived query is sane; injects ≤3 cited hits as a synthetic part;
injects nothing on zero results; never throws when search errors (inject a failing fake
client); disabled when `autoRecall:false`; respects char/hit caps.

### R1c — compaction preservation (`experimental.session.compacting`)

- **New file** `src/hooks/compaction-recall.ts` exporting
  `compactionRecall(client, limits): NonNullable<Hooks["experimental.session.compacting"]>`.
- Behavior: on compaction of `input.sessionID`, run a bounded **session-scoped** recall
  for durable-signal terms (decisions, requirements, errors, root causes) over that
  session, and push **one compact block** onto `output.context` (do **not** set
  `output.prompt` — appending is safer and preserves default summarization). The block
  instructs the summarizer to preserve durable facts/decisions/unresolved tasks, with
  cited message IDs so the summary can reference them.
- Keep it tiny (a few hundred chars). Prefer current-session evidence. try/catch; never
  throw.
- Only register when `compactionRecall === true`.

**Tests** (`test/hooks-compaction-recall.test.ts`): pushes a bounded block to `context`;
never sets `prompt`; never throws on search error; disabled when option off; block under
char budget.

### Factory wiring (`src/opencode-session-recall.ts`)

Return the hooks conditionally alongside existing `tool`/`config`:

```ts
return {
  tool: { ... },
  ...(nudge && { "experimental.chat.system.transform": systemNudge() }),
  ...(autoRecall && { "chat.message": autoRecall(client, unscoped, global, limits) }),
  ...(compactionRecall && {
    "experimental.session.compacting": compactionRecall(client, limits),
  }),
  ...(primary && { config: async (c) => { ... } }),
};
```

**Plugin tests** (`test/plugin.test.ts`): hooks present/absent per option; default
posture (`nudge` on, others off); existing tool-size guard still passes.

---

## R2 — BM25 ranker via MiniSearch

Replace **Fuse.js as the relevance engine** in `smart`/`fuzzy` modes with a per-query
in-memory **MiniSearch BM25** index. Keep Fuse only as a fuzzy fallback for low-result
queries and short-field matching. `literal` mode is unchanged. Per-query rebuild is fine
(searches are fast; no cache needed — R3 dropped).

### Architecture

Introduce `src/bm25.ts` (parallel to `src/fuse.ts`), and refactor `smartScan` in
`src/search.ts` to call it instead of `prefilter → fuse → rank`. The candidate model
(`src/candidates.ts`) already produces exactly the fielded documents we need.

**Index construction (per query):**

- `fields: ["primaryText", "secondaryText", "titleText", "hintText"]` — reuse the
  existing normalized fields from `populateNormalized()` (so we drop the separate
  prefilter+Fuse normalization path).
- `storeFields`: the candidate identity + ranking signals needed by `boostDocument`
  (`time`, `role`, `partType`, `directoryRelevance`, `toolName`, plus
  `sessionID/messageID/partID` for output mapping). Store the candidate index, not the
  whole candidate, to keep the index lean; keep a `Map<id, Candidate>` alongside.
- `tokenize` / `processTerm`: reuse `src/normalize.ts` (`tokenize`) so indexing matches
  the rest of the plugin (camelCase split, separator handling, lowercase). Provide the
  **same** tokenizer to `searchOptions.tokenize` so query and index agree.

**Query construction:**

- Per-field boosts mirroring current intent: `primaryText` 1 (base), `titleText` lower,
  `hintText`/`toolName` low, `secondaryText`/directory low. Use `boost`, not `bm25`
  tuning.
- `combineWith`: default `OR`, but apply an all-tokens boost via `boostDocument` (see
  below) to reward full coverage — replicating the current `ALL_TOKENS_BOOST` without
  excluding partial matches.
- `fuzzy`: `smart` → `0.2`, `fuzzy` → a looser value (e.g. `0.3`), gated to terms of
  length ≥ 4 via the function form (mirrors current typo policy: edit-distance for
  tokens ≥4). `prefix: term => term.length > 3` for partial-term help.
- Quoted phrases: MiniSearch has no phrase operator. Preserve current phrase handling by
  keeping the **exact-phrase boost** in a post-step (`rawText.includes(phrase)`) applied
  via `boostDocument` or a final additive pass — see "Structural signals" below.

**Structural signals (port from `src/rank.ts`):**

- Move the existing boosts/penalties into a single `boostDocument(id, term, stored)`
  multiplier so they ride on a calibrated BM25 base instead of an uncalibrated Fuse
  distance:
  - recency (decay over `RECENCY_WINDOW_MS`), reasoning-part, tool-error-text,
    user-role, exact-phrase, all-tokens-coverage → multipliers > 1.
  - poor-coverage, weak-single-token → multipliers < 1.
  - Convert the current additive constants to multiplicative equivalents (e.g.
    `+0.15` → `×1.15`); document the mapping. This is the one place to re-tune against
    the R5 eval fixtures rather than guess.
- `boostDocument` returning falsy drops a result — reserve that for R5 diversity, not
  for ranking.

**Output mapping:** convert MiniSearch results back to `SearchResult[]` exactly as
`rankedToSearchResults` does today (snippets via `smartSnippet`, `why`, `matchedTerms`,
`source`, `directoryRelevance`, `titleMatch`). Reuse that function; only the producer of
the ranked list changes.

### Fuse demotion

- Keep `src/fuse.ts` but call it only when BM25 returns **zero** results (fuzzy
  fallback) — preserves the current "smart/fuzzy falls back to literal/looser" promise
  and the README's stated behavior.
- Delete the `prefilter → fuse → rank` ordering from the primary path. `prefilter.ts`'s
  degraded-mode scorer is **no longer needed for ranking** because BM25 is fast and
  doesn't have the pre-Fuse time-budget cliff; remove "degraded mode" as a
  ranking-model switch (this fixes the stability defect noted in the recommendations).
  Keep a single overall time budget as a safety valve that returns partial results, but
  it no longer swaps algorithms.

### Dependency change

- Add `minisearch@^7.2.0` to `dependencies`. Keep `fuse.js` (now fallback-only) and
  `fastest-levenshtein` (still used by the fuzzy gate logic / R5).

### Risk & compatibility

- Public response shape is **unchanged** (`SearchResult`, `coverage`, `why`, etc.).
  `score` semantics change from Fuse-inverted to BM25-derived (still 0..1 after
  normalization). Document in release notes; `explain:true` `matchReasons` text updates.
- Snippets still computed from `rawText` (unchanged), so no position-mapping issues.

**Tests** (`test/bm25.test.ts` + extend `test/recall.test.ts`):

- rare-term query ranks the discriminative-term doc above a boilerplate-heavy doc
  (the IDF win — a case the current Fuse path fails);
- long tool-dump does not outrank a tight relevant message for the same terms
  (field-length-norm win);
- typo within edit-distance still matches (`prefiltr`→`prefilter`);
- multi-term `AND`-coverage outranks single-term partial;
- exact-phrase boost preserved;
- structural boosts (recency/role/reasoning/error) reproduce current ordering intent on
  the existing fixture;
- zero-result smart query falls back to Fuse, then literal;
- score stays within 0..1; `why`/`matchedTerms` populated;
- regression: existing `recall.test.ts` assertions still pass (update only where Fuse
  score numbers were asserted directly, if any).

---

## R5 — Regex, diversity, query routing, eval fixtures

Build the **eval fixtures first** so R2's re-tuning is measured, not guessed.

### R5a — Eval fixtures (do first)

- **New dir** `test/eval/` with a small labeled corpus (extend `makeFixture` or a
  dedicated fixture) and a set of `{ query, params, expectedTopSessionID|expectedRank }`
  cases covering: exact error-string recall, prior-decision recall, vague "same as
  before", file-path recall, tool-failure recall, cross-session/project recall,
  broad-noisy query, and old-strong-vs-recent-weak.
- **New file** `test/eval/relevance.test.ts` computing MRR and recall@5 over the cases
  and asserting thresholds. Run under vitest (part of `npm run check`). This is the
  gate that proves R2 ≥ the Fuse baseline. Capture the **baseline numbers from the
  current Fuse pipeline before R2 lands** (a one-time recorded snapshot in the test
  file comments or a committed `baseline.json`).

### R5b — Regex mode

- Add `match: "regex"` to the `recall` schema enum (`src/search.ts` args + the
  `pickEnum` defense list + `MatchMode` in `src/types.ts`).
- Behavior: bounded scan over candidate `rawText` using a `RegExp`. Compile with a
  try/catch → on invalid pattern return a hard error (`ok:false`) with a clear message
  (invalid regex is a caller error, not a forgiving case). Apply a global timeout/size
  bound to mitigate catastrophic backtracking: cap total scanned chars (reuse candidate
  budgets) and wrap matching per-candidate; optionally reject patterns over a length
  cap. Bypass BM25/Fuse entirely; snippet centers on first match.
- Snippets: extend `smartSnippet`/`snippet` to accept a match position, or add a small
  regex-snippet helper.
- Schema-size: one enum value + a short description clause; stay under the existing
  tool-size guard.

**Tests**: literal-vs-regex parity on simple patterns; matches error codes / paths /
IDs; invalid pattern → clear error; bounded on pathological input; respects
type/role/scope filters.

### R5c — Result diversity

- After ranking, before slicing to `results`, apply a diversity pass in
  `group: "part"` mode: cap hits-per-session to a small N (e.g. 2) for the initial fill,
  preferring distinct sessions, then backfill if under `results`. `group: "session"`
  already collapses per session, so this targets the part-grouped path.
- Prefer user/assistant content over repeated tool dumps when scores are close
  (tie-break already partly exists; extend it).
- Make the per-session cap a constant (not a new public param) to avoid schema growth.

**Tests**: a session with 5 strong hits no longer floods results; distinct sessions
surface; `group:"session"` unaffected; backfill still reaches `results` when few
sessions match.

### R5d — Query-type routing (compose the above)

- **New file** `src/route.ts` exporting `classifyQuery(query, args)` →
  `{ mode: "literal"|"regex"|"smart"|"fuzzy", reason }`, applied **only** when the
  caller did not explicitly set `match` (respect explicit `match`).
- Heuristics (cheap, deterministic): looks-like-regex (contains regex metachars in a
  way that parses) → suggest regex but **do not** auto-switch silently (instead surface
  a `suggestion`); looks-like-error-string / quoted exact phrase → `literal`; ordinary
  keywords → `smart`. Keep this conservative: prefer emitting a `suggestion` (existing
  mechanism) over overriding the caller, to avoid surprising behavior. Default `match`
  stays `literal` for compatibility; routing only nudges via suggestions unless we later
  decide to flip the default.
- This is the lowest-priority item; it mostly wires existing `suggestions` output to
  query shape. Defer if time-constrained.

**Tests**: classifier returns expected mode/suggestion per query shape; explicit `match`
always wins; suggestions surfaced, caller not silently overridden.

---

## Build / tooling impact

- `package.json`: add `minisearch@^7.2.0` to `dependencies`. No devDep changes (vitest
  covers new tests). `tsup` ESM build already handles a zero-dep ESM package.
- `npm run check` (format, lint, typecheck, test, compile) must stay green; the
  tool-size guard in `test/plugin.test.ts` is the schema-growth gate for R5b's enum
  addition and any description edits.
- README: document new options (`nudge`/`autoRecall`/`compactionRecall`), the BM25
  ranker (update the "Smart and fuzzy search" section — it currently credits Fuse.js as
  the ranker), `match:"regex"`, and the auto-recall latency note. `@docs-writer` is
  warranted at execution time because options + a `match` enum value + ranker behavior
  are observable-contract changes.

## Suggested execution order

1. **R5a eval fixtures** + record Fuse baseline (gives R2 a target).
2. **R2 BM25** (extract shared `runSearch`, swap ranker, demote Fuse, remove degraded
   mode) → must meet/beat baseline.
3. **R1a nudge** (cheap, safe, immediate value).
4. **R1b auto-recall** + **R1c compaction** (reuse `runSearch` from step 2; ship opt-in).
5. **R5b regex**, **R5c diversity**, **R5d routing** (independent, ordered by value).

Each numbered step is its own change-set: implement → `@test-writer` for new public
surface → dual `@code-review-opus` + `@code-review-gpt5` → address findings →
`@docs-writer` where the contract changed.

## What this plan deliberately excludes

- No persistent/on-disk index or cache (R3 dropped — searches are already fast).
- No embeddings / semantic search / model downloads (R4 dropped).
- No new external service or database of any kind.
- No new public search params beyond the `match:"regex"` enum value and the three
  plugin options; diversity/routing use constants and existing `suggestions`.
