# Semantic layer: Path C (stay lexical, clean up the opt-in layer)

## Goal

Round-4 dogfooding showed the opt-in semantic layer is mechanically sound but too weak
on the real corpus to solve vocabulary-gap queries (near-pure semantic weight still
ranked the known-good session ~34th; the card text being embedded is identifier soup).
Decision: stay lexical as the product direction. Agents rephrase queries cheaply, the
lexical tiers are strong, and LLM-written summaries (the high-ceiling fix) are not worth
their cost and complexity. This change-set makes the existing opt-in layer honest and
cheap instead of removing it.

## Approach

1. **Remove dead drill-time embedding work** (`src/drill.ts`, entry wiring): drilled
   candidates are embedded but nothing consumes those vectors. Remove the computation
   and the embedder threading into drill. The card-tier blend in `src/cards.ts` keeps
   its embedder; that is the layer that does something.
2. **Lazily persist card vectors** (`src/cards.ts`, `src/store.ts`): the card table's
   `embedding` column is currently empty for all rows while vectors are recomputed
   in-memory every process start (~seconds). After the card-tier embed pass, write the
   vectors back to the store and stamp `meta.semantic_model` with the model id. On
   load, reuse persisted vectors when the model stamp matches and the card row still
   has one (a re-distilled card is upserted without an embedding, so staleness clears
   itself); recompute and rewrite otherwise. No schema change; the column finally means
   what it says.
3. **Temper the docs** (`README.md`, `CONTRIBUTING.md` if it repeats the claim): the
   semantic section currently promises vocabulary-gap retrieval ("how did we test the
   plugin interactively"), which real-corpus testing disproved. Reword to what it
   measurably is: a mild, opt-in ranking nudge that can help borderline paraphrases,
   with rephrasing the query as the reliable path for vocabulary gaps.

## Verification

Existing gates green (eval 17 cases at 1.0/1.0 untouched). New tests: drill never calls
the embedder; second cards load with a matching model stamp uses persisted vectors
(embedder not called); model change or card re-distill triggers recompute and rewrite.

## Out of scope

Removing the semantic layer entirely, part-level semantic in drill, LLM card summaries,
embedding-model upgrades, semantic shortlist quotas. The Path C decision supersedes the
"part-level semantic in drill" future direction recorded during round 4; if semantic is
ever revisited, richer card representation comes first (see Revisions in
recall-distill-then-search.md).
