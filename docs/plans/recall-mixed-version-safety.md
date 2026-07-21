# Mixed-version store safety

## Goal

Multiple opencode processes share one mutable store, and they will routinely run
different plugin builds (instances restart at different times). Live troubleshooting
showed the failure: rep3-era and rep4-era processes racing the global semantic stamp
(each clears and rewrites all vectors to its own representation), in-memory vector
snapshots going silently stale across processes (embedding writes do not bump
`cards_rev` by design), floored cards resurrected from pre-floor snapshots, and an
old process renewing the distill lease forever so new-build features (the
summarizer) never run. Root cause: rep4 changed representation semantics without a
schema bump, bypassing the store's existing mixed-version fence.

## Approach

1. **Schema v3, and the rule that created this bug**: bump `SCHEMA_VERSION` to 3.
   The existing ladder fences every older build out (newer-version refusal degrades
   them to ephemeral metadata mode: no writes, no lease). Record the rule in code
   next to `EMBED_REPRESENTATION`: any change to representation semantics MUST ride
   a schema bump.
2. **Per-row representation generation** (additive in the v3 migration):
   `embedding_gen INTEGER` on `card`. `EMBED_REPRESENTATION` becomes a monotonic
   integer generation (rep4 -> 4) exposed alongside the model in the stamp. Reads
   use only rows whose `embedding_gen` matches the process's generation; writes are
   conditional `WHERE embedding_gen IS NULL OR embedding_gen <= ?` so a lagging
   process can never downgrade a newer row (belt on top of the schema fence, for
   future same-schema representation drift).
3. **`vectors_rev` meta**: bumped by every embedding write and clear-all. The card
   runtime's refresh check compares it (alongside `cards_rev`); its own writes
   update the cached value so no self-reload loop forms. Cross-process vector
   changes now invalidate in-memory snapshots within the refresh interval.
4. **Lease observability**: the lease value gains `build` (plugin version) and
   `gen` fields; `status()` and logs surface who holds it. The schema fence already
   prevents old builds from holding the lease once v3 lands; the tag makes future
   diagnosis one query instead of a process hunt.
5. **Coverage transparency**: `coverage.semantic` gains `representation` (the
   generation) and `pluginVersion`, so mixed-version confusion is visible in tool
   output.

## Verification

Two-handle tests simulating version skew: a lower-generation writer cannot
overwrite a higher-generation row; a reader reloads vectors when another handle
bumps `vectors_rev` (and does not reload on its own writes); v2 store with data
upgrades additively to v3; the newer-refusal ladder still degrades; coverage
carries representation and pluginVersion. Full gates + lexical baseline + plumbing
eval stay green.

## Out of scope

Retroactively fixing already-running old builds (impossible from new code; the
restart-all workaround covers the transition), cross-machine coordination.
