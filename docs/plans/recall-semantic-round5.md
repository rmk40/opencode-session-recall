# Round 5: semantic Paths A and B

## Goal

Make semantic retrieval actually solve vocabulary-gap queries, superseding the Path C
"stay lexical" decision by user direction. Round-4 dogfooding proved the mechanics work
but the representation fails: near-pure semantic weight still ranked the known-good
session ~34th because cards embed identifier soup and dispatch-instruction summaries.
Path A fixes the representation mechanically and makes semantic results reachable
end-to-end. Path B adds LLM-written card summaries on top, which also improves
natural-question ranking, browsing, and hook payloads. Everything is gated by a new
realistic eval built from the failing real-corpus case.

## Path A: mechanical representation and plumbing

1. **Realistic semantic eval first** (nothing tunes blind): synthetic corpus shaped
   like the real failure — a target implementation session whose card is identifier
   soup (camelCase tokens, paths, a dispatch-instruction summary head, garbage title)
   plus 30+ distractor sessions flavored with adjacent vocabulary (UI, keyboard,
   extension work). Cases: the four failing paraphrase queries ("pseudo-terminal
   testing real host", "PTY harness inside interactive host", "test plugin
   interactively", "terminal add-on end to end"). Gate: with semantic enabled, the
   target enters the drill shortlist (top 12) and appears in final results. Runs with
   the real model under the existing env-gated semantic suite, plus a fake-embedder
   variant in the default gate that pins the plumbing (quota, contribution) without
   model variance.
2. **Embedding text builder** (`embeddingTextOf(card)`, new module or in cards.ts):
   a natural-language projection built from card fields — identifiers split into words
   (camelCase, snake, kebab, dotted, path segments: `launchTerminal` becomes "launch
   terminal", `GHOSTAUTH_LIVE_TUI` becomes "ghostauth live tui"), file basenames and
   directory names split likewise, fields rendered as labeled prose ("project X;
   wrote files ...; ran tools ...; errors ...; about: <summary head> <outcome
   head>"), deduped, capped ~2,000 chars. This text is what gets embedded; the
   lexical index continues to use the raw fields. Splitting reuses/extends the
   existing normalize/tokenize machinery.
3. **Reserved semantic shortlist slots**: when semantic is on and ready, reserve 2 of
   `drillSessions` for the top pure-semantic cards not already shortlisted (mirroring
   the FTS-needle reservation pattern, including the cap==1 guard). Config
   `semanticSlots`, default 2, clamped.
4. **Zero-lexical-hit contribution** (supersedes the round-4 option-(a) drop): a
   semantically-shortlisted session that drills to zero lexical hits no longer
   vanishes. Bounded part-level semantic rescue for those sessions only: embed the
   drilled candidates (the code removed in Path C returns, but scoped — only
   semantic-shortlisted, zero-lexical-hit sessions, capped candidates), pick the
   top-cosine part as the evidence, score from the blended card+part similarity,
   labeled in `why` as semantic evidence. Bounded by the drill budgets already in
   place.
5. **Diagnostics**: `coverage.semantic` {ready, model, weight, cardsWithVectors,
   contributed} and, with `explain: true`, per-result semantic similarity in
   `matchReasons`/`why`.

## Path B: LLM card summaries

**Feasibility (verified)**: no completion endpoint exists in the SDK or server, but
`session.prompt` accepts per-call `model {providerID, modelID}`, `system`, and
`agent` overrides. B therefore uses a **worker-session summarizer**: one dedicated
session (title sentinel `[recall-summarizer]`), batch prompts (~15 card digests per
turn, JSON-in/JSON-out), a cheap configured model, deleted or reused across runs.

1. **Schema**: additive migration v1 -> v2: `ALTER TABLE card ADD COLUMN nl_summary
TEXT NOT NULL DEFAULT ''` plus meta `summary_rev` (prompt-version stamp). Additive
   means no store rebuild; v1 stores upgrade in place.
2. **Summarizer** (`src/summarize.ts`): opt-in via plugin option `summaries: { model:
"provider/model", enabled: true }` (off by default; spends the user's tokens).
   Cold pass: after distillation, batch through undistilled-summary cards
   newest-first through the fetch gate at background priority; per-batch prompt
   renders each card's mechanical fields and asks for 2-3 plain sentences of what the
   session did and how it ended; responses parsed defensively (malformed item ->
   skipped, retried once, then left empty). Incremental: on the same idle-debounce
   path, re-summarize only when the card's content hash changed materially.
   Lease-holder only, same as distillation.
3. **Exclusions**: the worker session is excluded from distillation, cards, and
   search by title sentinel (same suffix-matching discipline as self-tool exclusion);
   its own events are ignored by the distiller.
4. **Consumption**: `nl_summary` joins the lexical card index as a boosted field,
   joins `embeddingTextOf` (compounding with A), surfaces in `recall_sessions`
   digests and hook payloads when present.
5. **Docs**: README gains an honest summaries section (what it costs, what it
   improves, off by default); the semantic section updated once A+B land.

## Risks

- Worker-session churn and cost: bounded by batching (~300 turns for the full
  history at 15/batch), the cheap model override, and opt-in default-off.
- Recursive noise: the worker session must never be distilled or searched; the
  sentinel exclusion is tested.
- Summary drift: `summary_rev` stamp forces re-summarization when the prompt
  changes; content-hash gating prevents rework when nothing changed.
- Part-level rescue reintroduces drill-time embedding: scoped to
  semantic-shortlisted zero-hit sessions only, so the Path C dead-code concern
  (unconditional embedding nothing reads) does not return.

## Verification

The new semantic eval (fake-embedder plumbing variant in the default gate; real-model
variant env-gated) plus: reserved-slot behavior incl. cap guards, zero-hit rescue
produces labeled evidence, worker-session exclusion, batch parse failure handling,
additive migration from a populated v1 store, summary_rev re-summarization,
content-hash skip. Existing 17-case lexical baseline stays at 1.0. Live: rerun the
four failing paraphrase queries on the real store with semantic on, before and after
B, and record ranks in this doc.

## Live results (running record)

- 2026-07-20, Path A only (rep4 with identity de-weighting + substantive floor;
  summaries not yet populated because the distill lease was held by an instance
  started before the summaries config landed): cardsWithVectors 4,590 of 4,724
  (the floor correctly denies ~130 content-free cards). "pseudo-terminal testing
  real host" now surfaces the implementation at rank 7 in user-visible results
  (previously absent; hybrid card rank 136). The three hardest paraphrases ("PTY
  harness inside interactive host", "test plugin interactively", "how did we
  test the plugin interactively") remain absent, as predicted: that residual is
  Path B's load. Re-measure all four after the summary pass populates
  (config is set; the pass starts on the next restart of the lease-holding
  instance).

## Out of scope

Embedding-model upgrades, upstream completion-endpoint requests, summarizing with the
session's own expensive default model, cross-machine summary sync.
