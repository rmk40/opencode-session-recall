# Genuine prompt filtering: `authorship` on `recall`

## Goal

Let a caller ask for **what a human actually typed**, separately from
everything else that carries `role: "user"` in the transcript. Today
`role: "user"` is roughly a coin flip: about half of the user-role text in
this machine's corpus was not typed by a person.

The deliverable is a new `authorship` argument on `recall` plus the
classifier behind it. `role` keeps its current transport-level meaning and
its current behavior.

## The measurement that drives the design

One query over the live opencode store (`~/.local/share/opencode/opencode.db`;
the SQL is committed at `docs/surveys/user-role-authorship.sql` so the
numbers stay auditable). All user-role **text** parts, 17,054 total:

| Session parentage | Part flags     | Meaning                        | Parts | Share |
| ----------------- | -------------- | ------------------------------ | ----: | ----: |
| root              | none           | **human-typed**                | 8,651 | 50.7% |
| child             | none           | **agent-authored** (delegated) | 6,282 | 36.8% |
| _unresolvable_    | none           | parentage unknown              | 1,372 |  8.0% |
| root              | `ignored: 1`   | TUI plugin status blocks       |   537 |  3.1% |
| root              | `synthetic: 1` | host/tool injection            |    94 |  0.6% |
| child             | `synthetic: 1` | host/tool injection            |    86 |  0.5% |
| _unresolvable_    | `synthetic: 1` | injection, parentage unknown   |    32 |  0.2% |

Four things this changes about the design:

1. **The dominant contaminant is subagent sessions (36.8%)**, not the
   injected content I first assumed (1.3% combined). In a child session the
   "user" is the orchestrating agent, so every delegated prompt ("Review the
   uncommitted change-set in …", "Round 2: I addressed your round-1
   findings …") is indexed today as if a human typed it.
2. **A boolean is the wrong shape.** Agent-authored prompts are valuable for
   reconstructing direction; they are a different _kind_ of evidence, not
   noise. The filter must distinguish, not delete.
3. **Parentage is unresolvable for 8.2% of the corpus** (sessions absent
   from the primary session table). Any classifier that treats "no parent
   field" as "root" fails open on one part in twelve. `unknown` must be a
   first-class value.
4. **The strongest signal is structural** (`parentID`, part flags), not
   textual. No wording heuristics.

Verified sub-case: a file attachment produces synthetic text parts holding
the expanded file body, and **the human's own prompt survives as a separate
unflagged part in the same message**. Classifying synthetic as `injected`
loses attachment bodies, never the typed words.

Two populations are already excluded upstream and are **not** in the counts
above as searchable content: this plugin's `[recall-summarizer]` worker
sessions (dropped by `isSummarizerTitle`, `src/extract.ts:54`) and its own
`<recall-auto>` blocks (`src/extract.ts:135-140`).

## Constraints

- `role` semantics and behavior do not change.
- **Responses are byte-identical when `authorship` is absent or `"any"`
  and `explain` is false.** `explain: true` is a diagnostic surface and is
  exempt (it may carry `why.authorship`); the eval baseline is unaffected
  because its rank-scored cases pass no `explain`.
- **Ranking is untouched when `authorship` is absent.** No scoring
  constant, tokenizer, or indexed text changes. Step 5 does change the
  drilled pool when the filter is active, and the pool is a ranking input
  (BM25 builds a per-query index over exactly the candidates it is handed),
  so the guarantee is scoped to the unfiltered case.
- Classification is **structural only** — message role, part flags, session
  parentage, part type. No content sniffing.
- Parentage comes from data already in the search path (`Card.parentId`,
  and the `Session` object `probeMeta` already fetches). **No new fetch
  site**, no `session.get` per drill target.
- The host drops Zod defaults, so the new arg is coerced defensively with a
  `runToolRaw` regression test (AGENTS.md).
- `src/` stays free of Node globals.

## Step 0 — spike before implementing

**Verify `ignored` is actually populated over the SDK boundary.** The
survey read the raw `part` table; the plugin reads parts over the SDK HTTP
API. The installed SDK _does_ declare both flags on `TextPart`
(`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:148-149`), so the
existing casts in `src/extract.ts:136` / `src/distill.ts:201` are legacy,
not evidence of absence. But a declared optional field can still be
`undefined` in every real response, and nothing in `src/` reads `ignored`
today.

Probe a live session over the API and pin the answer in a fixture taken
from a **real** response (not a hand-built fake, which would assume the
conclusion).

**Spike result (2026-08-28): the flag IS populated.** A live
`GET /session/{id}/message/{id}` against a known `ignored` part returned
`{ "type": "text", "ignored": true, ... }`. The response is pinned at
`test/fixtures/sdk-ignored-part.json` (body redacted; only the flag shape
matters). **The `ignored` rule ships.** The paragraph below is retained as
the recorded decision criterion, not an open question.

**If the flag is not populated, state the cost before deciding.** The 537
TUI status blocks are root-session, unflagged text, so they fall through to
rule 8 and classify **`human`** — a ~3.1% false-positive rate in the one
bucket the feature is named for. Either ship with that documented, or hold
the feature for a different signal. Do not ship a rule that silently never
fires.

## Approach

1. **Classifier (`src/authorship.ts`), an ordered decision list** — total by
   construction, with part type deciding before role and role before
   parentage:

   ```
   1. partType === "title"                        → "title"       (session metadata, not a transcript part)
   2. partType === "subtask"                      → "delegated"   (agent-authored by construction)
   3. role === "assistant"                        → "model"
   4. role === "user" && (synthetic || ignored)   → "injected"
   5. role === "user" && partType !== "text"      → "injected"    (reasoning/tool on a user envelope)
   6. role === "user" && parentage === unknown    → "unknown"
   7. role === "user" && hasParent                → "delegated"
   8. role === "user" && !hasParent               → "human"
   9. fallback                                    → "unknown"
   ```

   Rule 1 exists because the title candidate is a synthetic search
   candidate built from session metadata, not a transcript part (see step
   4). It is named `title` rather than `generated` deliberately: the
   structural classifier knows the candidate is a title, not who or what
   produced the string (titles can be user-edited). Rules 2 and 3 resolve
   the subtask/model collision explicitly: a subtask part rides an
   assistant message and is still `delegated`, because the question the
   filter answers is "who composed this instruction", not "which envelope
   carried it".

2. **Parentage plumbing** (the gap that makes rule 6/7/8 possible).
   Thread `parentID?: string | null | undefined` through
   `DrillTarget` → `SessionMeta` → `Candidate`, distinguishing three states:
   present, explicitly absent (root), and **unknown**. Sources, all existing:
   - card-backed targets: `Card.parentId`, already read at
     `src/search.ts:2165` and discarded;
   - probe path: `probeMeta` already fetches the live `Session`
     (`src/search.ts:2259`); read its `parentID`;
   - the two fallback sites that have no metadata at all —
     `targetFor`'s uncarded fallback (`src/search.ts:2214`) and
     `resolveUncarded`'s double-probe-failure fallback (`:2334`) — set
     `unknown`, never root.

   **Encoding discipline** (the tri-state only works if the two negative
   cases stay distinct): `string` = has parent; `null` = metadata was
   obtained and said root; `undefined` = metadata unavailable → `unknown`.
   A successful `Session` fetch whose `parentID` is absent maps to `null`,
   never `undefined`. Read it defensively (`typeof x === "string"`), as
   `src/distill.ts:606` already does, since the probe cast site is
   `Session | GlobalSession`.

   This encoding is **safe by omission**, which is why it was chosen over a
   boolean plus a separate flag: a `DrillTarget` literal that simply forgets
   the key yields `undefined` → `unknown` → fail-closed. A missed
   construction site degrades (withholds results, warns) rather than lying
   (claiming agent text is human).

   **All six `DrillTarget` construction sites** must be updated —
   `src/search.ts:2188` (`registerTarget`), `2209` and `2214`
   (`targetFor` + its metadata-less fallback), `2321` and `2333`
   (`resolveUncarded` + its double-probe-failure fallback), `2385`
   (single-target branch), and — **the primary one, missed in r2** —
   the tier-1 ranking branch at **`src/search.ts:2703-2713`**, which builds
   target literals inline rather than through `registerTarget`. That is the
   branch a bare `recall("…")` takes, so omitting it would leave the
   headline path unclassified while every explicit-target path worked. It
   already has the card in hand (`cardById`, populated from both `eligible`
   and the FTS injection), so it reads `card?.parentId` directly.

   One further `SessionMeta`-shaped literal exists at `src/drill.ts:419`
   (built for `buildTitleCandidate`). It deliberately does **not** need
   parentage: rule 1 fires on `partType` before parentage is consulted, so
   a title classifies `title` regardless. Noted so the six-site enumeration
   is not read as having missed it.

   **Known limitation of the card source.** `Card.parentId` is
   `string | null` (`src/store.ts:112`) and the distiller collapses missing
   and non-string to `null` (`src/distill.ts:606`), so a card-backed target
   cannot express `unknown` — card `null` is read as root. Accepted:
   a card exists only for a session the distiller discovered, so in
   practice a card-backed target has real metadata behind it. This is a
   practical argument, not a proof — a derived store can retain a card for
   a session whose current metadata is gone, and (per Risks) the survey and
   runtime `unknown` populations do not bound each other. Closing the gap
   entirely would need a card column, i.e. the deferred schema work. Stated
   here so the tri-state is not claimed to be more complete than it is.

3. **`authorship` argument.** Values `"human" | "delegated" | "injected" |
"model" | "title" | "unknown" | "any"`, or an array of the non-`any`
   values. Default `"any"`. Symmetric with the classifier so every value
   that can appear in output can also be selected.

   Normalization (`pickEnumSet`, new — `pickEnum` is string-only and returns
   the whole fallback on a bad value):
   - non-string, non-array → `"any"` + warning;
   - string: as `pickEnum` today;
   - array: **drop invalid members individually**, warn naming each dropped
     value; deduplicate; if `"any"` appears anywhere the result is `"any"`;
     if the array is empty or empties after filtering → `"any"` + warning.

   Rejecting the whole array on one bad member would silently widen the
   result set, which is the wrong failure direction for a filter whose
   purpose is exclusion.

4. **Filter placement — three ordered stages inside `poolFor`, and the
   order is load-bearing.** r3 put the authorship pass before the title was
   built, which made `authorship: "title"` return nothing on every session:
   the title candidate is _derived from_ the filtered pool, not merely
   appended to it (`src/drill.ts:414-425` — `representative = eligible[0]`,
   and `buildTitleCandidate` needs its `messageID`/`role`/`time`,
   `src/candidates.ts:141-169`). Empty pool, no representative, no title.

   The correct order:
   1. **`candidateEligible`** (existing predicate: type, role, time,
      toolName) → pool `E`.
   2. **Title construction** from `E`, exactly as today: representative is
      `E[0]`, and the title candidate is appended when `searchTitles` is on.
      The representative may be a candidate the authorship pass will later
      drop; that is correct, because the title is session metadata (rule 1),
      not that message's words.
   3. **Authorship pass** over the _combined_ pool, title included.

   With this order the title needs no special-casing at all: it classifies
   `title` (rule 1) and the ordinary filter decides. `"human"` drops it,
   `"title"` keeps only it, `["human","title"]` keeps both, `"any"` is
   unchanged. Per-bucket drop counts are attributable because the
   authorship pass is its own stage.

   **Plumbing (the input side, missing from r3's body despite its revision
   log — three type sites):** the authorship predicate reaches `poolFor`
   via `DrillInput` (`src/drill.ts:62`) and `DeepInput` (`:109`), set at
   both call sites (`src/search.ts:2759`, `:3028`); `poolFor`'s own
   parameter type is inline at `src/drill.ts:412`. It mirrors the existing
   `filter` member rather than replacing it — they are separate stages.

5. **Selection-tier win for the dominant bucket (no schema change).**
   Trigger on the **normalized set**, not the raw argument: apply when the
   set is exactly `{human}` (so `["human"]` triggers it and
   `["human","delegated"]` does not).

   **Both selection paths need the restriction** — they are independent:
   - _Tier-1 card ranking_: a **new** `CardFilters` member (roots only).
     `CardFilters` (`src/cards.ts:84-102`) does **not** already express
     this — `excludeFamilyOf` excludes one named family and cannot say
     "roots only", so this is a new member plus a `passesFilters` branch.
   - _Tier-1.5 FTS injection_: does **not** go through `cards.rank` or
     `CardFilters` at all. It reads the store directly and applies its own
     admission chain (`src/search.ts:2646-2685`), so it needs the same
     check inline beside the existing guards (`if (rootOnly && card.parentId != null) continue;`).
     This is not a marginal leak: FTS rows are the `human-text` class,
     which is exactly where delegated prompts live, so for a prompt-shaped
     query child sessions arrive disproportionately via `ftsOnly`.

   **Scope the new member carefully.** `passesFilters` is shared by
   `rank()` and `list()` (`src/cards.ts:500`, used at `:570` and `:619`),
   and `cards.list` backs the **explicit-shortlist** branch
   (`src/search.ts:2504`) and the **deep** branches (`:2456`, `:2485`).
   Applying it there would silently drop a session the caller named by id,
   which the surrounding code deliberately never does (see the
   uncarded-shortlist comments at `:2227-2250`). So: apply at the tier-1
   ranking branch (`cardFilters`, `:2555`) and the FTS injection only.

   **The invariant is no-result-loss, not identity.** No candidate in a
   child session can classify `human` (rule 7 fires before rule 8), so
   under a `{human}` filter such a session contributes zero results either
   way — nothing can be lost. (Child sessions do also contain `injected`
   candidates, not only `delegated`/`model`; the property that matters is
   simply that none are `human`.) But results
   are _not_ identical: freeing shortlist slots admits root sessions the
   unrestricted run never drilled, and BM25 builds a per-query index over
   exactly the pool it is handed and normalizes by the top raw score
   (`src/bm25.ts:235-270`), so dropping child-session candidates shifts IDF,
   average document length, and the normalizer for the surviving results
   too. The claim is: **every result the unrestricted run returned is still
   returned; ordering may shift and additional root sessions may appear.**

   Assert this at the **scored-pool** layer, not the capped output: a newly
   admitted root session can displace a previously returned result under
   `results`, so "every prior result is in the final response" is false at
   the cap. The honest invariant is that no _candidate or session_ that
   could produce a result is lost from the pool.

   The restriction drops only a card whose parentage reads as a positive
   **child**; root and unresolvable values are **kept** (fail-open at
   selection, fail-closed at filtering — the part-level rule still decides).
   Both the restriction and the classifier read parentage through one shared
   helper (`parentageOf`), so they cannot disagree about a value: if selection
   dropped a session the classifier would have called `human`, the
   no-result-loss invariant would break.

   Note what "unresolvable" can and cannot mean here. `Card.parentId` is
   two-state, so a card can only say root or child — the only unresolvable
   value it can hold is a degenerate one (empty/whitespace), which
   `parentageOf` maps to `unknown` and the restriction keeps. The runtime
   `unknown` population this plan is really about — uncarded targets and probe
   failures — never reaches this branch at all: those ids arrive through the
   explicit shortlist, which has no root-only restriction. They are drilled and
   then withheld by the part-level rule, with the empty-pool warning reporting
   it.

   This retires most of the 36.8% problem. Part-flag-level selection
   awareness (`injected`) still needs the deferred index work.

6. **Reporting, without changing default responses.**
   - `coverage.limitedBy` gains `"authorship"` when the filter is active.
     Additive: the union already declares an unused `"role"` member
     (`src/types.ts:135`), and nothing is pushed when `authorship` is
     `"any"`.
   - A warning when the authorship pass emptied an otherwise non-empty
     pool, naming the dropped buckets and counts. Requires carrying counts
     out of `poolFor` on `DrilledPool` → `DrillOutput`/`DeepOutput`
     (`src/drill.ts:77-80`) to both call sites (`src/search.ts:2753`,
     `:3028`).
   - `why.authorship` on results **only when `authorship !== "any"` or
     `explain: true`** (the `explain` case is exempted from the
     byte-identical constraint, see Constraints). It must be added at
     **all three** result constructors — corrected from r2, which had the
     first two labels swapped:
     - `candidateResult`, the **literal/regex** path,
       `src/search.ts:688-716` (does _not_ spread `candidate.why`);
     - `rankedToSearchResults`, the **ranked** path that spreads
       `candidate.why`, `src/search.ts:787-843`;
     - the **semantic rescue**, `src/search.ts:858-899`.

     All three funnel through `annotateResult` (`src/search.ts:266-281`),
     which is where a default could live — but it has no candidate access,
     so the per-route addition is still required.

   - Under `group: "session"`, secondary evidence rides `TopEvidence`
     (`src/types.ts:211-216`), which carries `evidenceClass` but no
     authorship. Add it there too, so grouped output is not the one shape
     that cannot answer the question — as an **optional** field emitted
     under the _same_ active-filter-or-`explain` predicate as
     `why.authorship`. Populating it unconditionally would change default
     grouped responses and break the compatibility gate. The
     byte-identical regression must cover `group: "session"` output, not
     just the flat shape.
   - A warning for combinations that are empty by construction
     (`authorship: "human"` with `type: "tool"` or a `toolName`), beside the
     existing guard at `src/search.ts:2036-2038`. Include the case a
     subagent hits first: `recall` runs _inside_ child sessions routinely,
     so `scope: "session"` + `authorship: "human"` from a subagent is always
     empty. That takes the single-target branch, which bypasses step 5
     entirely — confirm the empty-pool warning reaches it. Mirror case,
     now that `"title"` is selectable: `authorship: "title"` with
     `type !== "all"` or any `toolName` is also always empty, because
     `canSearchTitles` (`src/search.ts:508-510`) suppresses title
     construction at stage 2 before authorship ever runs. Same warning.

7. **Docs.** README gains a "Whose words are these?" subsection under the
   recall arguments: the buckets, why `role: "user"` answers a different
   question, the measured shares as motivation, and the two documented
   asymmetries (attachment bodies classify `injected`; a delegated prompt
   is indexed twice — as the parent's `subtask` part and as the child
   session's user text — and `authorship: "delegated"` returns both, by
   design, from different sessions).

## Risks

- **Part-flag contaminants still narrow only at filter time.** `injected`
  content can still consume drill budget. Bounded (1.3% of the corpus) and
  now visible via `limitedBy` plus the empty-pool warning.
- **`parentID` as the human/delegated discriminator assumes a human never
  types directly into a child session.** True for Task-tool subagents in
  opencode today. If it changes, `delegated` over-claims. One function to
  revisit.
- **`unknown` withholds content from `authorship: "human"`.** Deliberate —
  the filter's promise is kept — but it means a bounded slice of history is
  excluded. Mitigated by the warning, the coverage entry, and `"any"` as a
  complete escape hatch. The 8.2% survey figure is **indicative, not a
  bound**: it counts sessions absent from the primary session table,
  whereas the plugin's `unknown` population is a different set — uncarded
  targets and probe failures (`src/search.ts:2214`, `:2334`). Neither
  contains the other.
- **Over-trusting `ignored`.** It is a host rendering hint. Right for the
  537 observed TUI blocks; if a host ever set it on real prompts they would
  classify `injected`. Step 0 gates whether the rule ships at all.

## Verification

- `npm run check` green; eval baseline unmoved — and the reason is stated
  precisely: no fixture passes `authorship`, and with the argument absent
  no predicate, no indexed text, and no scoring constant changes.
- **Classifier unit table**, one case per rule plus the collisions: subtask
  on an assistant envelope (→ `delegated`, not `model`), title (→
  `title`), user + `ignored` + `synthetic` together, user + non-text
  part, root vs child vs unknown parentage, assistant with every part type.
- **Parentage plumbing**: each of the **six** `DrillTarget` sites yields
  the expected tri-state — including the tier-1 branch (`:2703-2713`), the
  default-path case — and specifically that the two metadata-less
  fallbacks produce `unknown` and **not** `human`; and that a fetched
  `Session` with no `parentID` yields `null` (root), not `undefined`.
  **No-new-fetch is pinned on `h.calls.get`**, not on the strict suite:
  `setStrictNoLimitMessages` only throws on `session.messages` without a
  limit (`test/helpers.ts:544-549`) and says nothing about `session.get`.
  Assert `h.calls.get.length` is unchanged across the same query with and
  without `authorship`, as `test/recall.test.ts:2394-2403` already does for
  probe fan-out. Keep the strict suite as a general guard.
- **Filter behavior**: `"human"` excludes child-session prompts, `ignored`
  blocks, synthetic parts, titles, and unknown-parentage parts;
  `"delegated"` returns child-session prompts and parent `subtask` parts;
  `"title"` returns the title candidate (proving it is selectable, not
  merely suppressed); array form unions; absent/`"any"` byte-identical to
  today with `explain: false` (pinned by comparing full serialized output
  on a fixture corpus).
- **Coercion** (`runToolRaw`): absent, junk string, non-string, array with a
  junk member (dropped individually, warned), empty array, array containing
  `"any"`, duplicates.
- **Coverage/reporting**: `limitedBy` contains `"authorship"` only when
  filtering; empty-pool warning fires with correct bucket names and counts;
  `why.authorship` present on all three result routes when filtering or
  `explain`, absent otherwise.
- **Title suppression**: a query whose only hit would be a title returns
  nothing under `authorship: "human"`, returns the title under `"any"`,
  and returns the title under `authorship: "title"`.
- **Selection restriction**: with `authorship: "human"`, child-session
  cards are not shortlisted **via either path** — card ranking _and_ FTS
  injection (assert via coverage counts, with a fixture where a child
  session is reachable only through `ftsOnly`); unknown-parentage cards
  still are; and the invariant asserted is **set-inclusion at the
  scored-pool layer, not identity and not at the results cap**: every
  session/candidate the unrestricted run scored is still scored by the
  restricted run. Do not assert that every prior _returned result_ survives
  (a newly admitted root session can displace one under `results`), and do
  not assert equal ordering or equal scores.
- **Regression pins**: `role` behavior, `evidenceClass` values, and the
  degraded/ephemeral paths unchanged.

## Out of scope

- **The `<system-reminder>` strip** (in the first draft, cut here). It
  cannot be done at one extraction path: `searchableFields`
  (`src/extract.ts:127`) feeds search text and snippets, while
  `distillFields` (`src/distill.ts:263-301`) independently produces the
  persisted FTS rows and card heads. Stripping one splits the index from the
  drill — tier-1.5 would match reminder text, shortlist the session, spend
  drill budget, and find nothing. Stripping both makes every persisted row
  and card head stale, which per AGENTS.md means a `SCHEMA_VERSION` bump, a
  full re-distill, and re-derived embeddings. For 7 parts (0.04%) that is
  the wrong trade. Neither extractor currently receives the message role
  either, so it would need its own plumbing. Revisit only alongside the
  index work.
- **Full** tier-1.5 authorship awareness — i.e. per-row/part-flag
  filtering in the FTS index — which needs the `part_text` schema change
  (the deferred "B" work). Step 5's parent-aware FTS _admission_ is
  in scope and is a different thing: it filters injected cards by session
  parentage, not FTS rows by part authorship.
- Adding `authorship`/`role` to `recall_context` / `recall_get`, and the
  `recall_messages` pagination semantics.
- Adding `"role"` to `coverage.limitedBy` (would change existing responses;
  the new argument ships honest, the old one is left alone deliberately).
- Renaming `evidenceClass: "human-text"` or the FTS `class` values, both of
  which already misleadingly cover assistant text.
- Ranking weight changes, including `USER_ROLE_MULT`.
- Deduplicating a delegated prompt across its two indexed locations.

## Revisions

- **r2 (post-panel round 1):** Survey corrected — the buckets did not sum
  because 8.2% of user-role text lives in sessions absent from the primary
  session table; re-queried with a `LEFT JOIN` and `unknown` is now a
  measured bucket rather than an oversight. Classifier restated as an
  ordered, total decision list with explicit subtask-vs-model and
  title precedence (both reviewers: not total, not mutually exclusive).
  Parentage plumbing specified end to end with the two fail-open fallback
  sites named (both reviewers: `parentID` is not in scope at candidate
  construction). Title candidates suppressed under a narrowed filter (both
  reviewers: generated titles would satisfy `authorship: "human"`).
  `<system-reminder>` strip cut to Out of scope with the dual-extractor and
  re-distill reasoning (both reviewers). `why.authorship` gated so default
  responses stay byte-identical (both reviewers: it contradicted the
  compatibility claim), and all three result constructors named (gpt5).
  Root-only card shortlisting for `authorship: "human"` adopted as a
  behavior-equivalent selection win using existing `Card.parentId` (opus:
  the 36.8% bucket does not need the deferred schema work). Empty-pool
  warning given real plumbing rather than a downgraded promise (both).
  `pickEnumSet` semantics defined including per-member drop and the
  widening-failure rationale (both). Step 0 spike added to verify `ignored`
  crosses the SDK boundary before the rule ships (opus). Filter value set
  made symmetric with classifier output (opus). Survey SQL committed for
  auditability (opus). Renamed `authored` → `authorship` to match the `why`
  field (opus).
- **r3 (post-panel round 2):** **Sixth `DrillTarget` site** found by both
  reviewers — the tier-1 ranking branch (`src/search.ts:2703-2713`) builds
  target literals inline, and it is the _default_ recall path; r2's
  five-site enumeration would have left the headline route unclassified.
  Parentage encoding discipline added (`string`/`null`/`undefined`
  distinct; fetched-but-absent maps to `null`, defensive `typeof` read).
  `Card.parentId` documented as two-state, so card-backed `null` reads as
  root — the tri-state is no longer claimed to be complete (opus).
  `"generated"` renamed `"title"` (gpt5: the classifier knows it is a
  title, not who wrote it) and title candidates are now suppressed only
  when the set excludes `"title"`, since blanket suppression made that
  value unselectable (gpt5 blocker). Step 5 substantially rewritten: the
  FTS injection path bypasses `CardFilters` entirely and needs its own
  root check (both); `CardFilters` needs a **new** member, not
  `excludeFamilyOf` (opus); the member must not reach `cards.list`, which
  backs explicit-shortlist and deep and must never drop a named session
  (opus); and the equality claim is replaced by **set-inclusion**, since
  freeing shortlist slots admits new sessions and BM25 is pool-relative
  (both). `explain: true` exempted from the byte-identical constraint
  rather than contradicting it (both). Result-constructor labels corrected
  — r2 had `candidateResult` and `rankedToSearchResults` swapped (both) —
  and `TopEvidence` added so grouped output carries authorship (opus).
  Step 5 trigger defined on the normalized set (opus). `DrillInput`/
  `DeepInput` plumbing named (opus). No-new-fetch pin moved from the
  strict suite to `h.calls.get`, which is what actually observes
  `session.get` (opus). Step 0 reframed: the SDK _does_ declare both flags
  (`types.gen.d.ts:148-149`), so the spike verifies population rather than
  existence, and the 3.1% false-positive cost of dropping the `ignored`
  rule is now stated as a go/no-go input (opus + gpt5). "Ranking is
  untouched" scoped to the unfiltered case (opus). Subagent
  `scope:"session"` + `"human"` case added to the warning requirements
  (opus). The 8.2% "upper bound" claim downgraded to indicative (opus).
- **r4 (post-panel round 3):** Title selection fixed properly — both
  reviewers found that r3's ordering made `authorship: "title"` return
  nothing on every session, because the title candidate is _derived from_
  the filtered pool (`representative = eligible[0]`), not appended to it,
  so an authorship pass that runs first leaves nothing to build from.
  `poolFor` is now three ordered stages (eligibility → title construction →
  authorship over the combined pool), which also removes the special-casing:
  the title classifies `title` and the ordinary filter decides. The
  `"generated"` → `"title"` rename is completed in the argument value list
  and Verification, where r3 had left the public contract stale (both).
  Set-inclusion moved to the scored-pool layer, since a newly admitted root
  session can displace a prior result at the `results` cap (gpt5).
  `TopEvidence.authorship` made optional and gated by the same
  filter-or-`explain` predicate, with grouped output added to the
  byte-identical regression (gpt5). `DrillInput`/`DeepInput`/`poolFor`
  input plumbing written into the body rather than only claimed in the r3
  log (opus). Child-session invariant restated as "none classify `human`"
  rather than "all are delegated or model" (gpt5). Card two-state rationale
  softened from proof to practice (gpt5). Tier-1.5 out-of-scope qualified
  as _full per-row_ awareness, distinct from step 5's parent-aware
  admission (gpt5). Encoding documented as safe-by-omission (opus). The
  seventh `SessionMeta`-shaped literal at `src/drill.ts:419` noted as
  deliberately parentage-free (opus). SDK citation moved off the
  `node_modules` path and the redundant casts flagged for a decision (opus).
