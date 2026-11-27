# AGENTS.md

Operational notes for agents working on this plugin. This is the stuff that is
**not** obvious from the code and cost real time to learn. Architecture, build
steps, and conventions live in [CONTRIBUTING.md](CONTRIBUTING.md) — read that for
the "what"; this file is the "things that will bite you."

## The #1 gotcha: opencode does NOT apply your Zod `.default()`s

When opencode calls a plugin tool's `execute`, it passes the **model's raw
argument object** straight through. It validates against the Zod schema but
**throws away the parsed result**, so any `.default(...)`, coercion, or
transform you declared in the schema is **never materialized** in `args`.

Concretely: if the model omits an optional arg, your `execute` sees it as
`undefined`, not the default. A `recall_messages` that trusted its `role`
default would get `role: undefined`, run the filter `if (role !== "all")`,
match zero messages and return `total: 0` on a fully-loaded session.

**Rule: never trust `args.x` to be defaulted/validated. Coerce every optional
arg defensively at the top of `execute`.** Helpers exist for this:

- `coerceEnum(value, allowed, fallback)`, `coerceBool(value, fallback)`,
  `coerceInt(value, fallback, min, max)` in `src/types.ts` — use these in the
  browse/retrieve tools (`messages`, `context`, `sessions`, `get`).
- `recall` (`search.ts`) has its own richer `pickEnum`/`pickNumber` that also
  emit `warnings`. Match that tool's style if you add args there.
- Also guard _required_ string args (`optionalString(args.x)` + an explicit
  error) — `undefined` required args will otherwise throw on `.slice()` or make
  slice bounds `NaN`.

The schema still matters (it generates the JSON schema the model sees and
validates types), but it is **not** your runtime safety net.

## Self-recall exclusion: match tool names by suffix, not equality

`recall` must never return its own prior output (no recall-finds-recall). The
guard is `isSelfTool()` in `src/extract.ts`, used by `searchableFields()`.

The non-obvious part: **tool names can be renamed/namespaced upstream of this
plugin** (e.g. `mcp__opencode-session-recall__recall`, `provider.recall_get`).
An exact-equality check against the `TOOLS` constant misses those. `isSelfTool`
matches a bare name OR a `TOOLS` name preceded by a separator (`[._/-]`), while
rejecting unrelated names like `myrecall`. If you add a search path or a new
recall tool, route it through `searchableFields`/`isSelfTool` so the exclusion
holds. Expansion is a separate path — `truncateExpandedPart` in `search.ts`
redacts self-tool bodies there too.

## `src/` has no Node types — keep runtime code environment-agnostic

`tsconfig.json` declares no `types`/`lib`, so **`Buffer`, `node:crypto`,
`node:fs`, etc. are NOT available in `src/`** and will fail `tsc`. Use Web/std
globals instead (`globalThis.crypto.getRandomValues`, `BigInt`, string ops). See
`src/hooks/part-id.ts` for the pattern (it reimplements an opencode id format
with zero Node deps). The `test/` tree _does_ have `@types/node`.

Corollary on `npm run compile`: it runs `tsup` (bundles the JS) **then**
`tsc --emitDeclarationOnly`. If you use a Node-only global, **tsup will succeed
and emit a working `dist/.js`** while `tsc` fails afterward — easy to miss. Don't
trust a green bundle; check the whole `compile` step.

## SQLite drivers: keep `bun:sqlite` in the tsup external list

The derived store opens SQLite through a runtime-detected driver (`src/sqlite.ts`):
`bun:sqlite` when the `Bun` global exists (opencode's runtime), else `node:sqlite`
(Node >= 22.5, which the tests run on), else null (degraded, in-memory cards). `node:`
specifiers are auto-external in tsup, but `bun:sqlite` is **not**, so it MUST stay in
the `compile` script's `--external bun:sqlite`. Drop it and tsup tries to bundle a
module that only exists inside Bun, and the build breaks. As everywhere in `src/`, the
adapter is the one place a Bun/Node global may appear; nothing else in `src/` may
import `bun:*` or `node:*` directly.

## How the plugin is loaded (why a rebuild is needed to test live)

- One default export serves both hosts: `{ id, server, setup }` from
  `src/opencode-session-recall.ts`. opencode v1 (`@opencode-ai/plugin` 1.3.4+) reads
  `id` and calls `server(ctx, options)`. opencode v2 (`@opencode/plugin` 2.0.x)
  decodes `{ id, setup }` and calls `setup(ctx)`. v1.18+ also calls `setup` with a
  partial context, so `setup` first runs a capability probe (`isV2HostContext` in
  `src/host/v2.ts`) and stays inert unless the context has `session.hook`,
  `tool.transform`, `event.subscribe` and `location.directory`. `server()` sets
  `registry.v1ServerActive` as a second guard.
- **v1** loads a local directory through `package.json` (`main`, and `exports` for
  npm installs) → `dist/opencode-session-recall.js`.
- **v2** loads a local directory by trying `<dir>/server.*` then `<dir>/index.*`,
  and never reads `package.json` for it; the root `server.js` shim re-exports the
  build. npm installs resolve through `exports` (`.` and `./server`) and never see
  the shim, which is not in `files`.
- **Source changes do nothing until you rebuild `dist/`** (`npm run compile`, or
  `npx tsup ... --format esm` for a quick JS-only rebuild during debugging).
- A **running** opencode process has already loaded the old `dist/`. After
  rebuilding you must **restart the session** (or relaunch) for it to pick up
  changes. Live testing loop: edit → rebuild dist → restart the tuistory session
  → reproduce. On v2 the plugin runs inside the background service, so restart
  that (`opencode service restart`), not only the TUI.
- Logging differs per host. v1 logs `[recall] ...` lines with `console.log`,
  and few of them: option warnings, a store refusal, summarizer failures and
  dispose deferrals. The v1 distiller gets no `log`, so lease and cold-pass
  lines never print. Where console output lands on 1.18.33 (checked with a
  probe plugin): under `opencode serve`, on its stdout (`console.error` on
  stderr), but only once a request has loaded the instance. Under the TUI
  the server runs in a Bun Worker: `console.log` is painted straight over the
  TUI screen (gone on the next redraw) and `console.error` goes to the
  process's stderr (the terminal, unless redirected).
  Neither reaches opencode's log file (`$XDG_DATA_HOME/opencode/log/`). To
  see v1 lines, run `serve` and redirect its output. v2 discards plugin
  console output, so it logs only when `RECALL_DEBUG=1` is set in the
  service's environment, to `~/.cache/opencode-session-recall/recall.log`
  (size-capped, one rotation).
- On v2, give `storePath` and `opencodeDbPath` as absolute paths in live test
  configs: both resolve against the working directory of the background service
  the plugin runs in, not the project the TUI was started from.
- `files: ["dist"]` in `package.json` means only `dist/` is published to npm;
  CHANGELOG, AGENTS.md, src, etc. never ship.

## Live end-to-end testing with tuistory (when unit tests can't reach it)

Bugs that only manifest through the real opencode host (like the
defaults-not-applied bug) are invisible to vitest. Drive a real session:

1. Make a throwaway workspace: `mktemp -d`, optionally `git init`.
2. Launch: `npx -y tuistory launch "opencode --standalone" -s <name> --cols 160 --rows 50 --cwd <tmp> --background`.
   (Run via `npx -y tuistory` — reliable regardless of PATH.) On v2,
   `--standalone` makes the TUI run its own server instead of attaching to
   the shared background service. The 1.18 CLI has no `--standalone`, so a
   v1 run launches the v1 binary without it.
3. `wait` for the prompt: `npx -y tuistory -s <name> wait "/Ask anything|Build ·/i" --timeout 35000`.
4. `type` a prompt that **explicitly tells the agent which recall tool + args to
   call** (you're testing the tool, not invocation heuristics), then `press enter`.
5. Read results with `read --all` (cumulative, ANSI-stripped) — more reliable
   than `snapshot` mid-render. The TUI's narrow panes wrap JSON, so ask the agent
   to **report specific fields concisely** rather than parsing raw JSON from the
   buffer.
6. Always `close` the session and remove the tmp dir when done. Never
   `daemon-stop` (kills others' sessions).

tuistory shares one daemon between every caller. When `launch` finds it
unresponsive, it replaces it ("Relay port ... is occupied but not answering;
replacing wedged daemon"), which ends every session the old daemon held,
yours and other agents' alike. Check that a session still exists before you
read from it.

Cross-project trick: to prove recall finds _this_ project's history from a fresh
session in a tmp dir, search `scope:"global"` for distinctive strings you know
are in the DB. That exercises the cross-project path, which is exactly where the
scoped-vs-unscoped and defaults bugs hide.

### Which binary, which database

On this machine the v1 binary is
`/opt/homebrew/lib/node_modules/opencode-ai/bin/opencode.exe` (1.18.33) and `opencode`
on `PATH` is v2. The v2 reader was last checked live against opencode 2.4.1. Isolate
every live run with temporary
`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME` directories.

On v2, `opencode serve` rejects `--standalone` ("Unrecognized flag"). Run the TUI as
`opencode --standalone` through tuistory instead. Make API calls such as
`session.fork` with `opencode api --standalone`. The 1.18 CLI has no `--standalone`.
Run it as `serve --pure` on a private port.

v1 cold-pass tests need a database with v1 tables. No ready-made one exists on this
machine, so build it in the temp data directory. Start the 1.18.33 binary once so it
creates a fresh `opencode/opencode.db`, stop it, then copy a few sessions into it from
the v1 `session`, `message` and `part` tables of a database that still has them,
attached read-only and filtered by session id. Copying a whole live database does not
work, because 1.18.33 re-runs its migrations on the copied schema and fails ("table
`project_directory` already exists").

### v2 hazards: a copied opencode.db can run real turns

A v2 service opened on a **copy** of a live `opencode.db` resumes sessions that
were mid-turn when the copy was taken, and can start real model turns with the
copy's stored credentials. Before launching v2 against a copy, scrub it (tables
from opencode's `packages/core/src/{credential,account,session}/sql.ts`):

```sql
DELETE FROM credential;
DELETE FROM account;
DELETE FROM account_state;
DELETE FROM control_account;
-- time_suspended is the execution claim; claimed root sessions resume on start.
UPDATE session_v2 SET time_suspended = NULL, resume_attempts = 0
  WHERE time_suspended IS NOT NULL;
-- Queued and admitted prompts would be drained into new turns.
DELETE FROM session_pending;
DELETE FROM session_inbox;
-- Background subagent recovery jobs also resume on start.
DELETE FROM kv WHERE key LIKE 'job.%';
```

Also unset provider API keys in the launching shell. v2 runs the plugin in a
background service: give the temporary config its own port
(`opencode service set port <free port>` with the temp `XDG_CONFIG_HOME` exported) so
it cannot collide with, or attach to, your real service. Even `opencode plugin list`
can start that private service in the background; stop it with
`opencode service stop` (same environment) when done. On 2.0.18 `opencode plugin
list` shows a local (`file://`) plugin only with `--builtin`, so its absence from
the plain listing does not mean it failed to load.

## Debugging a "data is there but result is empty" bug

When the SDK clearly has the data but a tool returns nothing, **instrument and
reproduce live** rather than theorize:

- Temporarily `appendFileSync` a JSON line to `/tmp/...` capturing the raw arg
  values and array lengths at each stage (fetched → filtered → sliced). Use a
  dynamic `import("node:fs")` inside the tool so it bundles. Lint rejects a
  literal `node:` import outside `src/sqlite.ts` and `src/node-import.ts`, so
  this instrumentation cannot be committed by accident. Rebuild, restart the
  session, reproduce, then `cat` the file.
- A line such as `dataLen: 590, filteredLen: 0` with `role` absent proves the
  SDK returned 590 messages and the filter (not the fetch) dropped them.
- Remove the instrumentation with `git checkout <file>` before committing.

Don't over-trust a session transcript (`.md` export): it can elide/reformat JSON
fields (e.g. a missing `offset`), which sent an earlier investigation down a
wrong path. The live tool output is ground truth; the transcript is not.

## Relevance is gated — don't change ranking blind

`test/eval/` is a labeled relevance harness wired into `npm run check`.
`baseline.json` locks MRR/recall@5 = 1.0 over 19 rank-scored cases. On top of
those, `relevance.test.ts` adds two behavioral assertions: an output-only needle
that must be an honest miss without `deep` and a hit with a scoped deep sweep,
and a virgin degraded-mode query that must return metadata-quality results with
`coverage.cards.degraded` set. **Any ranking change must meet or beat the
baseline**, or the build fails. If you intend to move the baseline, do it
deliberately in the same change-set and say why. Before tuning ranking constants
(`bm25.ts` for the drilled rerank, `cards.ts` for the card tier), run the eval to
see the current numbers.

## The derived store rebuilds itself; don't hand-migrate it

The card + slim-FTS store lives at `~/.cache/opencode-session-recall/store-v1.db`
for the v1 host (the filename is fixed at `store-v1.db` regardless of schema;
`defaultStorePath(host)` gives the v2 host `store-opencode-v2.db`; `storePath`
overrides the whole path). It is derived state, never authoritative: safe to delete
at any time, and it rebuilds in the background on the next run. `store.ts` stamps
`schema_version` in the `meta` table (currently `SCHEMA_VERSION = 5`). On open: a
matching stamp is used as-is; a v1, v2, v3 or v4 stamp is migrated **additively in
place** (`migrateV1ToV2` adds the summary columns, `migrateV2ToV3` adds
`embedding_gen`, `migrateV3ToV4` adds `distill_cursor` and stamps
`store_host = 'opencode-v1'`, `migrateV4ToV5` adds the schema-5 columns and the
`range_hash` table, with no data loss and no re-distill); an absent stamp
or a foreign layout is dropped and rebuilt; a **newer** stamp makes `openStore`
refuse (`{ ok: false, reason: "newer" }`) so the plugin degrades to cards-lite
rather than misreading a format it doesn't understand. So the migration story for a
schema change is: add a `v(N-1)→vN` additive step when you can, bump
`SCHEMA_VERSION`, and ship. Old in-place stores upgrade, foreign ones rebuild.

Schema 4 adds the **host fence**. `openStore(db, identity)` takes a
`StoreIdentity`: `{ host: "opencode-v1" }` or
`{ host: "opencode-v2", source }`, so v1 cannot pass a source and v2 must. It
compares the host with `meta.store_host` (schema 1-3 without a stamp implies
`opencode-v1`) and the source with `meta.source_db` by exact string, so the v2
`source` must be a canonical `realpath`. A present host stamp is checked **first**,
before `schema_version` is even read, so no schema state (missing, garbled,
pre-fence) can rebuild or migrate another host's file. A mismatch refuses with
`host-mismatch` or `source-mismatch` **before any migration**, so a v2 opener never
upgrades a v1 store. Fence refusals (`newer`, `host-mismatch`, `source-mismatch`)
never rebuild or write, since two hosts pointed at one file would otherwise wipe each
other on every start: they are decided by reads, the transaction rolls back, and
`journal_mode=WAL` is only set after the fence accepts, because it rewrites the file
header. An `error` refusal is a failure path instead: its rollback undoes a partial
migration. A failed WAL switch after an accepted open is not a refusal at all: the
store opens with `warning` set. The reset is manual: quit every opencode process
sharing the store, delete the store file, restart.

A matching identity is not enough when the caller cannot rebuild what a rebuild
drops. The v2 card-only fallback (the store opened for its cards while
`opencode.db` is missing or unreadable) passes `existingOnly: true`: a store that
would be migrated or rebuilt (a missing or garbled `schema_version`, a legacy
schema) refuses as `needs-migration` or `needs-rebuild` without writing, instead of
losing its cards. Any new caller in that position must do the same.

The stamp-first fence reads `meta.store_host` before it knows the schema, so **every
future schema must keep the `meta(key, value)` table and the `store_host` key
readable**. Today a renamed key falls through to the schema check (and refuses as
`newer`), and a changed `meta` shape throws (and refuses as `error`). Both are still
safe refusals, but the reason stops naming the other host, which is what tells a user
that the fix is a separate store rather than a plugin upgrade.

Several opencode processes run one plugin instance each and share the file,
coordinated by a single `distill_lease` row in `meta` (holder, heartbeat, 30s TTL,
plus the writer's build/gen for diagnosis); only the lease holder writes, stale
leases are taken over on expiry, and per-session writes are transactional so readers
never see half a session. Two revision counters drive lazy reader reloads and they
are NOT interchangeable. `cards_rev` covers lexical card writes and the tier-1
runtime watches it. The store allocates it inside each write's own transaction (see
the next section), so the distiller and the summarizer never bump it themselves.
`writeCardEmbeddings` bumps `vectors_rev` instead, because vectors are invisible to
the lexical index, so bumping `cards_rev` for them would churn every reader for
nothing. A lexical write that allocates no revision stays invisible to readers. The
card runtime applies only the cards stamped since its last refresh (see the card
runtime section below), so it keeps serving the old card until its next full load.

## Schema 5 card writes account for their own revisions

Schema 5 adds five nullable `card` columns and one table. Existing rows read NULL in
each column.

- `projector_gen` is the history projector generation the card was built under (see
  the projector section below). The v1 host leaves it NULL.
- `write_rev` is the `cards_rev` revision of the last stamped write to the card,
  indexed for `cardsSince`.
- `repair_reason` says why a stale card could not be rebuilt (`markRepairPending`).
- `settled_base` is the card's settled base, which every card write stores with the
  checkpoint. It is set only when the checkpoint is unsettled with a boundary (see the
  checkpoint section below). It records the boundary's `seq` and the newest message at
  or below it. It also records how many of the session's oldest `part_text` rows
  belong to that prefix and the prefix's share of the card's aggregates (part count,
  summary and outcome heads, files, tools, errors, cut messages). NULL means there is
  no base and the
  next re-read of the session is full. `refreshCardMeta` clears it with the
  checkpoint it writes.
- `time_archived` is when the session was archived. Both hosts fill it from the
  session's metadata.
- The `range_hash` table holds hashes of source row ranges per session, keyed by
  the range's first `seq`, for the v2 range check.

Every lexical write (`replaceSessionParts`, `appendSessionParts`,
`replaceSessionTail`, `patchCardMeta`, `refreshCardMeta`, `writeSummary`,
`setFamilyRollup`) allocates the next `cards_rev` through the store's private
`nextRev()` inside its own transaction, stamps it on the row as `write_rev` and
advances the `cards_stamped` meta counter with it.
`deleteSession` allocates a revision too, with no row left to stamp, advances
`cards_deleted` and clears the session's range hashes. An older build bumps
`cards_rev` alone, so the gap between `cards_rev` and `cards_stamped` grows with each
of its writes and never closes. `cardStats()` reads every counter in one statement.
**A new lexical write path allocates through `nextRev()` in its own transaction**,
never by bumping `cards_rev` from outside the store.

Each write returns `{ changed }`, true only when it changed what a reader sees and
so allocated a revision. When `replaceSessionParts` finds the stored card and rows
equal to the new ones, it writes the checkpoint, the projector generation, the
settled base and any range hashes it was handed, clears the repair reason, allocates
no revision and keeps the vector. An append or tail write that changes no row and
leaves the card as it was writes the same and keeps the repair reason.
`patchCardMeta`, `refreshCardMeta`, `writeSummary` and `setFamilyRollup` allocate a
revision only when a value changed. `patchCardMeta` settles a patch that changes
nothing with a plain read, before any transaction. The distiller skips rollup
recomputes and summarizer work after an unchanged write. `family_rollup` is
store-owned. Card writes keep the stored value and only `setFamilyRollup` replaces
it, so re-indexing a root never clears its rollup.

`replaceSessionTail` writes a card distilled against a running tail without
rereading its settled base. The caller reads the base's rows (`sessionRows`) and
builds the card before the transaction. Inside it the store reads only the rows it
replaces, after checking that the card still holds the caller's settled base, at
least its rows and the `write_rev` the caller read them at. Any other state refuses
the write as `base-changed` with nothing written. The distiller then reads the
session in full. The previous tail's rows are replaced unless they equal the new
ones. The rows of the base's newest message are repointed at the tail's first
message. Under the row cap the card keeps what an append of the same messages
keeps, which is the aggregates of every message the card has held and the newest
`ftsRowsPerSession` rows. A longer tail evicts the base's oldest rows. A shorter one
would need back rows that an earlier write evicted, so the distiller reads in full
when the store holds exactly the cap (every eviction leaves exactly the cap).

## The card runtime applies store changes in place

`src/cards.ts` keeps two layers per process. The card map (`cardById`) holds every
card and serves `list`, `get`, `exclusionFamily`, `familyOf`, `coverage` and
`semanticStatus`. The search index (the MiniSearch index and the card vectors) is
brought up to date only by `rank()` and `ready({ index: true })`, so a call that
reads only the map never waits on index work. Both hosts build the card source
with `storeCardSource(store)`, which adds the reads an incremental refresh needs
(`cardStats`, `cardsSince`, `cardSessionIds`, `cardsPage`, `cardVectorsPage`). A
source without them (cards-lite, the static sources in tests) reloads every card
whenever its revision changes.

The runtime reads the store's counters at most every 5 seconds
(`REFRESH_INTERVAL_MS`) and picks one of three things to do.

- Nothing, when `cards_rev` and `cards_deleted` have not moved.
- An apply, which reads the cards stamped after the highest `write_rev` it applied
  (`cardsSince`, 250 per page) and diffs the card id set when `cards_deleted`
  moved. An apply of up to 250 revisions runs in place. A larger one runs as a
  chunked job while the current map serves.
- A full load, on a cold start, after `invalidate()`, when a counter went
  backwards (the store was reset or replaced) and when `cards_rev` advanced
  further than `cards_stamped` (an older build wrote without stamping). It reads
  `cardsPage` keyset pages of 250 with a yield point between them. The one
  exception is a map that was never loaded or was invalidated. A synchronous
  accessor that reaches it first loads it in place, since nothing may serve
  before it. `rank()` may then rebuild the index in place too.

Every card the map changes, adds or drops lands in `dirty`. `rank()` applies up to
64 dirty cards to the index in place (`MAX_SYNC_DOCS`). It removes each old
document and adds the new one, which keeps document frequencies exact. A card
whose document did not change costs no index work. More dirty cards are applied
the same way by a chunked job. More than half the index takes a full build
instead. Both work in slices of 8 ms (`SLICE_MS`) while `rank()` serves the index
it has. A card still in `dirty` is scored neither lexically nor semantically.
`rank()` counts the ones that passed its filters in `RankStats.pending`, which
`recall` reports as `coverage.cards.pending`. With no index at all `rank()` builds
one in place on the caller's turn, so an async caller awaits
`ready({ index: true })` first, as `recall`'s tier-1 branch and the hooks'
`cardRecall` do. `ready()` waits through at most 8 jobs (`MAX_READY_ROUNDS`), so a
store that keeps changing cannot hold a caller forever.

The runtime has two job slots. At most one map job (a load or an apply) and one
index job (a build, an in-place apply or a vector reload) run at a time. The two
may run side by side. One `tick()` clock orders them. A load or a build installs
only over state that an older start produced, so a slow build never replaces a
newer one. A full load records in `dirty` every card whose content changed,
whether or not an index exists yet. A build that took its snapshot before the load
then installs with those cards still marked. Any new path that changes the map
must mark `dirty` the same way, or the index keeps serving the old document.

A stored vector is reused only when three things hold. It was read under this
process's model stamp with no vector write landing during the read
(`stampedRead`), its `embedding_gen` is the current `EMBED_REPRESENTATION` and it
belongs to the card version the map holds. A vector the process computed itself
is kept until its card's content changes, so a full build or another process's
model switch embeds nothing that is still current. A foreign `vectors_rev` change
reloads only the vectors (`vectorReloadSteps`), never the cards. `stampedRead`
can trust an unmoved `vectors_rev` because `writeCardEmbeddings` bumps it in the
same transaction as every vector it writes and clears every stored vector before
it changes the model stamp. **Write a card vector or `meta.semantic_model` only
through `writeCardEmbeddings`.** A write that set `embedding` without that bump
would let another process reuse the vector under the wrong model's stamp. A
lexical write may clear a vector (`embedding = NULL`, as a re-distill or
`writeSummary` does). Readers learn of the card through its new `write_rev` and
keep their in-memory vector only while the content it came from is unchanged.

## Distiller write paths stay in short slices

`store.allCards()` reads every row of `card` in one synchronous call. On the perf
gates' 12,000-card store that call took 80 to 100 ms. On v2 such a call stalls
every session the shared service runs. **Never call `allCards()` on a path that
runs per session write.** A child's write or deletion recomputes its root's
rollup from `store.familyPage(rootId, after, 500)`, which walks the `card_root`
index a page of rowids at a time and reads only the columns a rollup needs.
`recomputeRootRollup` pauses between pages and re-checks `stopped` and the lease
after each pause. One recompute runs per root at a time. A change that arrives
meanwhile makes it run once more. The full pass after a cold pass pages
`store.rollupFieldsPage` by session id with the same checks. It skips a root that
a recompute wrote during the pass and asks a running recompute to run again
instead of writing over it. `familyPage`'s `next` is a rowid, which `VACUUM` can
renumber, so a walk assumes no `VACUUM` runs during it (the store runs none). A
new write path that needs cards beyond the session it writes pages through one of
these reads, or a keyset read such as `cardsPage`, with a yield between pages.

Concurrent distiller workers (cold-pass workers, repair-sweep workers and
concurrent re-distills) each yield before a write. Those yields can end in the
same turn of the event loop, so after each session write (a replace, an append or
a tail write) the distiller starts a yield (`yieldAfterWrite`) that the next write
waits for, then re-checks `stopped` and the lease. Writes then run back to back
only within one slice of the time budget below. A new session write path calls
`yieldAfterWrite()` after its write and waits out `writeYield` before it.

## Yield on a time budget, through `src/yield.ts`

A `setTimeout(0)` turn costs about 1.25 ms in both Bun and Node (timers are
clamped to 1 ms), several times what one history statement costs, so a history
reader that awaited one before every statement would spend about a third of a
median search waiting on timers. Every long-running loop therefore awaits a
yield point, and the default yield point (`yieldOnBudget`, one per process)
yields to the event loop only once `SLICE_MS` (8 ms) of work has run since
anything last yielded through it. The v2 reader, the v2 sync, the card runtime's
chunked jobs, the distiller and discovery all default to it. A yield itself is
`macrotask()`, which uses `setImmediate` where the runtime has it and
`setTimeout(0)` otherwise. **Do not use `MessageChannel` for it.** Node and Bun
deliver a port's messages back to back without returning to the event loop, so a
chain of such yields keeps timers from ever firing (a probe of 200 slices of 3 ms
saw no interval tick at all). Callers past the budget wait in line on one
pending yield, and only the first to resume takes the slice it starts: resumed
waiters all run before any of them does its work, so a waiter cannot tell from
the clock whether another already holds the slice. A pending yield older than
100 ms, or from a clock that went backwards, is replaced, because a test that
swaps fake timers in and out can drop its callback and would otherwise stall
every later caller in the process. A test that injects `yieldBetween` gets it
called at every yield point, so tests that interleave writes between statements
keep working. **Do not add a per-statement `setTimeout(0)`**; await the
component's yield point instead.

## Time windows: sessions overlap, reads go toward the window

A search's `since`/`until` (or `after`/`before`) keeps the sessions that overlap
the window: last updated at or after the lower bound and created at or before the
upper one (`CardFilters`, the slim-index lane, the deep listing, the live probe
of uncarded ids and the hooks' FTS backfill all apply the same rule). A subagent
that kept running for hours past the bound stays findable. The per-message
filters still apply the exact window, so results never leave it.

The drill and the deep sweep read toward the window (`DrillInput.window`).
Creation times rise with seq only mostly (opencode moves a retried assistant's
`time_created` to the step's start), so **neither end of a walk may trust one
message's time.**

- With an upper bound, a walk starts at `HistorySource.seekPage`: below the
  highest seq of any row created at or before the bound. On v2 the newest 16
  rows down the `(session_id, time_created, id)` index give a lower bound on
  that seq, then range reads over at most 2,000 seqs each (`SCAN_RANGE`) walk
  down from the session's newest row to it and stop at the first row at or
  before the bound. Past 40,000 seqs (`SCAN_ROWS_MAX`) the walk starts at the
  newest page instead.
- Past the lower bound, a walk ends only once it has read a message whose
  `info.seq` is at or below `HistorySource.seqFloor`, the lowest seq of a row
  created inside the window. On v2 one read pages the window's rows up the
  creation-time index 1,000 at a time and range reads walk seq up from the
  oldest row, in turn, and whichever finishes first is exact. It is asked once
  a walk meets an older message and cached per session and window.
- Every one of these statements binds `LIMIT ?` and reads only `seq`,
  `time_created` and `id`, never `data`.
- Messages outside the window stay out of the pool and charge neither the
  per-session nor the per-query budget. Reading past them has its own bounds,
  `OUT_OF_WINDOW_FACTOR` (4) times each budget in chars and
  `OUT_OF_WINDOW_MESSAGES` (2,000) messages a walk, four times that for a drill
  or a deep sweep, a page with nothing inside counting as at least one. A drill
  stops as `sessionBudget` or `queryBudget` on them and a deep sweep returns a
  continuation.
- v1 cannot seek or find a floor and answers `unsupported`, which the drill
  remembers for the rest of its life. So a v1 walk reads every newer message
  first and, past the lower bound, reads on until a page holds nothing inside
  the window (the anchor stop) or a bound ends it.
- The drill cache keys pages by cursor, which no window changes, and keeps seek
  and floor answers per bound. A slice's signature names its start and its
  window, so a build is reused only for the same window.

## Embedding representation changes MUST ride a schema bump

`EMBED_REPRESENTATION` in `embedding-text.ts` is a monotonic integer stamping what a
persisted card vector _means_: the projection `embeddingTextOf` builds, the model,
and how vectors are compared. It folds into the vector stamp (`meta.semantic_model`
= `model:gen`) and into each row's `embedding_gen`. **Any change to representation
semantics must bump `SCHEMA_VERSION` (store.ts) in the same change-set.** A
representation change without a schema bump passes the store's version fence. Two
builds at different representations then share one store and race the global
`semantic_model` stamp. Each clears and rewrites every vector to its own
representation on a loop. The schema bump fences the older build out
of the lease and all writes (a newer stamp makes its `openStore` refuse, so that
process degrades to cards-lite). The fence only reaches a build that **opens** the
store after the bump: an older process whose connection is already open keeps its
lease and keeps writing until it restarts. That is safe only because every migration
is additive and every statement names its columns, so the old writes still fit the
new layout; a non-additive schema change would need more than a stamp. The per-row
`embedding_gen` guard (`embedding_gen IS NULL OR embedding_gen <= gen`, plus a
wholesale reject of any lower-`gen` write, so an old build can never downgrade a
newer vector) is the belt for same-schema drift. Bump both together.

Mixed builds are diagnosable, not silent: the lease and every `coverage.semantic`
carry a `pluginVersion` build tag (`schema{N}.gen{M}.{host}`, or
`schema{N}.gen{M}.proj{P}.{host}` for a host with a projector generation, from
`pluginBuild(host, projectorGen?)` in `store.ts`, derived from `SCHEMA_VERSION`,
`EMBED_REPRESENTATION`, the projector generation and the host), so one lease read or
one tool response shows which build and host wrote what.

## Projector generation changes ride a schema bump too

`V2_PROJECTOR_GEN` in `src/history/v2-project.ts` stamps what a v2 card's content
_means_, which is how the projector turns `session_message` and `session_part` rows
into messages. The v2 host stamps it on every card it writes in full
(`card.projector_gen`). A change to what the projector produces from the same rows
bumps it. **That bump must ride a `SCHEMA_VERSION` bump in the same change-set**, for
the same reason as `EMBED_REPRESENTATION`. Without it a build of the older projection
keeps opening the store and writes its cards over repaired ones.

The store backs the generation with a guard. A replace or append whose card names a
lower generation than the stored one is refused (`refused: "older-generation"`) and
writes nothing. `staleCards(gen)` lists cards below the generation (NULL included)
and cards whose checkpoint is `v: 1`, which only an older build writes, leaving out
cards with a `repair_reason`. A distiller at a higher generation than
`meta.repair_gen` clears every stored repair reason before it records a reason or
runs a sweep, so the cards an earlier generation gave up on are tried again.

All of it is inert on v1, which passes no generation. `staleCards` returns nothing,
the guard does nothing, the repair sweep and the range check never start and v1
cards keep a NULL `projector_gen`. Put any new v2-only mechanism in shared code
behind the same check.

## The repair sweep and the range check (v2 only)

Both run only in the lease holder and only with a projector generation and the v2
sync. They write through the same lease-checked paths as every other distiller write.

The repair sweep (`runRepairSweep` in `distill.ts`) starts after each cold pass,
which leaves cards below the generation to it. It takes `staleCards(gen)`, archived
sessions included, puts the sessions that have part rows first (`withParts`) and
rebuilds each with `distillFull` at `distillConcurrency` through the fetch gate's
background lane. A session already being re-distilled is skipped, since that write
stamps the generation too. A session that is gone is left to the deletion reconcile.
A malformed session, or a card the loss guard kept, gets a `repair_reason` and leaves
the stale set. A card leaves it only when its rebuild commits or it gets a reason, so
an interrupted sweep resumes from the store. Progress goes in
`meta.repair_progress` (`{ pending, repairPending, done, gen, at, running }`), which
every process reports as `coverage.history.repair`.

The loss guard protects existing cards from a projection that lost content. When a
read holds part rows of unknown types, or completed assistant messages that project
empty although part rows exist, the distiller keeps the stored card as it is and
records the loss as its repair reason. Later changes to a repair-pending card take
the capped full read, never an append, so the card is replaced once the lossy
message falls past the per-session row cap.

The range check (`checkOneRange`) finds changes no poll window sees. A part-only
change in a settled session moves neither the message poll nor the session scan. The
check runs from `runPoll`, reads one range digest (at most 500 rows) per poll and
looks at no more than 64 cards per poll for one it may check. It runs only while no
cold pass or sweep is running and `gate.activeQueries()` is zero. It checks only
fully indexed cards at the current generation with a settled `v: 2` checkpoint, no
repair reason and no write pending. Within a card it checks only rows at or above the
lowest `seq` the card's last full write read (its floor). A mismatch, or a range with
no stored hash,
dispatches a removal, which re-indexes the session in full. Its position and counters
live in `meta.reconcile_progress`.

The hashes come from the index writes themselves. Every index write (a full write,
an append, a tail write, a sweep rebuild) takes a range digest of the settled rows it
is about to read before it reads them. Over a settled tail that is every row it
reads. Over a running tail it is the rows through the checkpoint's boundary. The
running rows get their hashes from the write that first reads them settled, so the
write that settles a tail hashes only the rows past the boundary. A write stores
its hashes in its own transaction, a suppressed write included. A row that changes
in between is recorded in its older state and fails the next check. A write with no
settled rows to read, or over a repair-pending card, keeps the stored hashes. Since
a range with no hash counts as changed, no hash ever exists without an index write
that read the same rows.

## The v2 checkpoint and running tails

The checkpoint (`card.distill_cursor`, from `src/history/v2-sync.ts`) records the
newest row, the session's recency, the newest row's part state and a fingerprint of
the 64 rows ending at it. When a row among the newest 20 still runs (an assistant
without `time.completed`, a shell or compaction `running`), the checkpoint is
unsettled. It then also records its boundary (`base`), the newest inspected row
below the lowest running one, with the fingerprint of the rows ending there and
whether the main fingerprint covers every row past it. A running tail never
compares as fresh or grown. It compares as `tail` while the boundary row and the
rows ending at it are unchanged. Otherwise, or without a boundary, it compares as
`rewritten`.

On `tail` the distiller re-reads only the messages past the boundary and merges
them with the card's settled base (`replaceSessionTail`). It reads and writes
nothing when a checkpoint taken first shows nothing past the boundary changed and
the card holds the session's metadata. After its read it compares the stored
checkpoint once more and reads in full if a row through the boundary changed at any
point since the card was written. The two checkpoints around a read only prove
nothing changed during the read. Row times only move forward, so this one check
covers the gap before the first of them too.

When the tail moves during a read, the write stores the checkpoint taken before the
read when that one is unsettled (marked `moved`) and otherwise none. A moved
checkpoint still compares as `tail`, since the card's rows past the boundary are
read again on the next poll. It is never taken as proof that nothing changed,
because the card may hold rows newer than it describes.

## Metadata patches during a distill

A metadata patch (a rename, a move, an archive or unarchive) is applied to the card
at once. If a re-distill or sweep of the session is running, or a cold pass that has
not written the session yet, that writer read the session's metadata earlier and
writes it over the patch. So the distiller notes the session and reads its metadata
from the host again once the last such writer has finished. A cold pass follows up
the sessions it never wrote when it ends. A failed read keeps the follow-up and
retries it after a delay that doubles each time, up to five times.

## The summarizer only runs while holding the distill lease

Path B summaries (`summarize.ts`) are not an independent loop. The distiller drives
them. `onColdPassDone` kicks the first pass and `onSessionDistilled` queues cards,
both only while this process holds the lease, and every persisted summary write checks
`leaseHeld()` first. All summary work drains through one serialized queue (at most one
prompt in flight). So if the lease moves to another process, summaries move with it: a
non-holder queues nothing and writes nothing. The throwaway worker sessions it prompts
are titled `[recall-summarizer]` (the `SUMMARIZER_SENTINEL`) and are excluded from
every recall path by `isSummarizerTitle`; a crashed holder's orphaned workers are
swept best-effort on the next holder's startup, never adopted. If you add a summary
write path, gate it on the lease or two processes will double-write.

## `session.messages` without a `limit` is the incident path

The two original live incidents were an unpaginated `session.messages({ sessionID })`
that pulled a whole (up to 77MB) session into memory. That is the legacy
full-session fetch, and it must never run. There are exactly two sanctioned readers
of message history. The first and general one is `HistorySource.messagePage()`
(`src/history/source.ts`): its `limit` is required and checked at runtime
(`assertBoundedLimit`). Drill, deep, the browse/context tools, and the distiller all
page through it. Under v1 it is backed by
`fetchMessagePage()` in `src/history/v1.ts`, the one place that calls
`session.messages`: it runs the same limit check before any request, ALWAYS sends
`limit`, and reads the next-page cursor from the `X-Next-Cursor` header. Only the
v1 entry may import `src/history/v1.ts` (an ESLint `no-restricted-imports` rule),
so the core cannot reach the SDK call directly. Tests enforce this: the fake
client throws `UNBOUNDED_MESSAGES_ERROR` on any no-limit call when strict mode is
on (`setStrictNoLimitMessages(true)` in `test/helpers.ts`), and the `runTool`
helpers hard-fail if a tool swallows that throw into an error output. Suites that
intentionally exercise the legacy full-return path (some distiller fixtures) opt
out by leaving strict mode off. If you add a new fetch site, route it through
`source.messagePage` and cover it under a strict-mode suite.

The second is `src/history/v2-sync.ts`, the v2 distiller's poll, checkpoint and
range-digest reads, which query opencode v2's `session_message` and `session_part`
tables directly (the v2 history source in `src/history/v2.ts` does too, behind
`messagePage` and `getMessage`). Those two files are the only places that read
`session_part`. Part sizes, part bodies and part state come from their own
statements scoped by session id and the message ids in hand. No `session_message`
statement reads `session_part`. There the rule is "every `session_message` and
`session_part` statement binds `LIMIT ?`", enforced by the `limitSpy` wrapper in
`test/v2-db.ts`, which fails any such statement that does not end in `LIMIT ?` with
a positive integer bound. Any new suite that exercises code reading either table
must hand it a `limitSpy`-wrapped handle. New code must not add a third reader.

A v2 read also stops at bytes. One byte ceiling (`pageByteCeiling`, 4 MiB by
default) covers a page's message rows and their part rows together. A part-row cap
(`pagePartRows`, 2,000 by default) covers the part rows. When the first message
of a page does not fit, the read loads its parts in ordinal order up to the cut,
ends the message with one placeholder part and marks it `partial`
(`{ nextOrdinal, omittedParts, omittedBytes }`). `getMessage(..., { partOrdinal })`
reads the rest. A continuation charges the envelope's metadata rather than its
inline content, so it may pass the ceiling by at most `CONTINUATION_METADATA_MAX`
(16 KiB) and always moves forward. v1 has no part ordinals and answers a
`partOrdinal` with `unsupported`.

The ceiling covers message bodies and part rows only. The lookups that attribute each
user row to an agent and a model (`identities` in `src/history/v2.ts`) run after those
reads and are not charged to it, because which rows they need depends on which rows the
reads kept. Per switch type a page reads one switch row for its oldest user row, at
most `SWITCH_SCAN_LIMIT + 1` (65) between its oldest and newest user row and, when
there are more, one per remaining user row. It also reads the agent and model fields
of one assistant row. That bounds the number of rows these lookups read, but nothing
caps their bytes outside the page ceiling. A switch row holds the agent or model chosen,
the previous one, event metadata and a timestamp, and the reader does not cap its size.

## What the v2 reader relies on in opencode 2.4

The v2 reader was written against opencode 2.4.1's stored layout (the full
migration list is `TESTED_MIGRATIONS` in `src/history/v2.ts`). These behaviors are
not visible from this repository's code. A change to any of them is a reader change.

- A new assistant message stores `data.content = []` in `session_message` and one
  `session_part` row per content item, keyed by `(message_id, ordinal)`. The part's
  `type` column is authoritative.
- Writing a part sets the part's `time_updated` and never touches the message row.
  The row gets a later `time_updated` only when its envelope changes, at completion.
  While a message streams, its parts can be newer than its row. This is why the v2
  checkpoint (`v: 2`) records the newest row's part count and newest part
  `time_updated` and why its fingerprint covers each of the 64 rows ending at the
  checkpoint with their part state.
- opencode reads a message as its part rows by ordinal followed by any inline
  content. The projector merges in the same order. Part ids are positions in that
  merged list (`${messageId}:${i}`), so a session with no part rows projects exactly
  as it did before 2.4.
- opencode moves inline content into part rows lazily, appending it after the
  existing ordinals on the next part write, which keeps every merged position. A
  read whose envelope held inline content re-checks the row's `time_updated` and
  size after its part read and reads again when they changed. After 3 attempts it
  returns the message `partial` with the inline content left for the continuation,
  so nothing is read twice.
- Forks copy the parent's message rows as stored and its part rows remapped to the
  fork's message and session ids. The older 2.2.5 layout inlined the parts into the
  copied rows instead. The reader handles both.
- A database without `session_part` (opencode before 2.4) reads inline content
  only. A missing table or column turns the capability off and is never a refusal.

## Tool output goes through `src/output.ts`

OpenCode passes a tool result to the model whole only up to 2,000 lines and 50 KiB.
Past either it cuts at a line boundary, so a one-line JSON result over the limit
reaches the model with none of its content. Every tool therefore returns through
`writeOutput` (or `writeError`), which writes the header fields first and one record
per line and stays within `OUTPUT_BUDGET` (40 KiB, 1,900 lines). When the records do
not all fit it sets `trimmed: true` and a `continuation` (an `rc.` token naming its
tool) ahead of the record arrays. The tool takes the continuation back as `cursor`.
Both hosts then run `boundResult` on what a tool returns at `HOST_OUTPUT_LIMIT` and
replace anything over it with a small error that carries `trimmed: true`. On v1 a
rejected `execute` becomes the same kind of bounded error result. A new tool or a new return path in an existing
one goes through `writeOutput` and takes a defensively coerced `cursor`. The host
backstop is there for a path that forgets.

## Perf gates are behind `RECALL_PERF=1`

`test/perf.test.ts` and `test/perf-v2.test.ts` are `describe.skipIf`'d off by
default because they measure machine-dependent wall-clock time. Run them
deliberately, with the verbose reporter so passing gates print their numbers:

```bash
RECALL_PERF=1 npx vitest run test/perf.test.ts test/perf-v2.test.ts --reporter=verbose
```

`test/perf.test.ts` holds these budgets.

- Tier-1 card rank p95 under 50 ms over 20 queries on about 4,700 cards.
- Single-session distill plus replace p50 under 150 ms, with the suppressed
  replace of the same sessions p50 under 50 ms.
- `ftsSearch` over about 50,000 slim-index rows under 100 ms.
- A drilled smart query end to end under 1.5 s on a store of about 100 sessions.
- Heap under 150 MB after those runs.
- On a 12,000-card store with realistic inventories (`perfCorpus` in
  `test/perf-helpers.ts`), a cold index build in each of three setups (semantic
  off, semantic on, semantic on reusing persisted vectors). Each keeps every code
  slice under 50 ms and finishes under 60 s. The heap after the lexical and the
  reused build stays under 600 MB.
- On the same store, 400 changed cards applied through `ready({ index: true })`
  with no full load, no code slice over 50 ms and under 3 s in total.
- On the same store, 24 `recall` searches with card writes between them, with no
  full load, a card-tier p50 under 250 ms and a whole-search p50 under 1 s.

`test/perf-v2.test.ts` holds every gate to no code slice over 50 ms.

- A full v2 cold pass over a large synthetic `opencode.db`, one poll cycle, a
  `listSessions` call and an append re-distill of a 4,000-row session.
- A tail write over a 5,000-row card, under 1 s.
- A repair sweep over 400 stale cards in a 12,000-card store, under 30 s.
- A child session's write and then its deletion in a 12,000-card store whose root
  has 2,400 other children, each under 1 s.
- Paged discovery of 10,501 sessions and of a root's 2,400 children through the
  runtime's own paging (`discoverSessions`, `listAllChildren`), each under 1 s.
- A range check over a 500-row session, run eight times, each check under 250 ms.

The slice budgets leave out V8's garbage-collection pauses. `stallProbe()` in
`test/perf-helpers.ts` ticks a 0 ms interval and splits each gap between ticks
into the code that ran and the GC pauses a `PerformanceObserver` reported inside
it. It first drains the entries still on their way, since a collection's entry
reaches the observer only after two immediates. Each gate asserts the GC-free
slice (`…MaxSliceMs`) and logs the raw stall (`…MaxStallMs`) and the longest GC
pause beside it. On a loaded machine a major collection of a heap of a few
hundred MB can pause the loop past 50 ms on its own, so a gate on the raw stall
would fail on machine load rather than on the code. A pause still lasts longer
the more heap the process retains. The heap ceilings catch that growth. A raw
stall that grows from run to run while the slices pass points at retained memory.
Every gate logs the load average (`loadAverage()`), since a wall-clock number
means little without it on a shared machine. A failing v2 gate names the slowest
synchronous calls it could attribute and the calls inside the worst stall.

If a change makes the store, the card runtime, the distiller or the query path
heavier, run these before assuming it's fine. When one fails, fix the code it
names rather than loosen the budget.

## Tokenizer split is load-bearing

`src/normalize.ts` has two tokenizers and they are not interchangeable:

- `tokenizeAll()` — **duplicate-preserving**, used to feed the BM25 index so term
  frequency is meaningful.
- `tokenize()` — **deduplicated**, used for set-membership / matched-term checks.

Using the deduped one for the index silently degrades BM25 ranking, because
every term then counts once per document. Pick the right one for the job.

## Testing the host-bypass path

To reproduce the "opencode didn't apply defaults" condition in a unit test, use
**`runToolRaw`** (in `test/helpers.ts`) instead of `runTool`. `runTool` applies
the Zod schema (so defaults are present — masking the bug); `runToolRaw` calls
`execute` with the raw object, exactly like the host. `messages`, `context`, and
`sessions` have `runToolRaw` regression tests for this; add one when you touch a
tool's arg handling.

## Release mechanics

- Tag-driven: pushing a `v*` tag runs `npm run ci`, `npm publish`, and creates a
  GitHub release. Pushing `main` makes a rolling "Latest Snapshot" prerelease.
- Release notes come from **`CHANGELOG.md`**: `release.yml` extracts the section
  matching the tag version (`## <version>`) into `--notes-file`. So **add the
  CHANGELOG section before tagging**, or the release falls back to auto-generated
  notes. Bump with `npm version <v> --no-git-tag-version`, then a
  `chore(release): <v>` commit, then the annotated tag.
- Pre-commit/pre-push hooks run the full `check` (format, lint, typecheck, test,
  compile), so commits/pushes are slow but verified. Expect the recompile output
  on every commit.
