# Recall round 4: distill-then-search

## Goal

Rebuild recall around what it is actually for: an agent in a live session needs the top
handful of useful moments from history, as small high-signal excerpts, in a few seconds at
most, with memory overhead measured in tens of megabytes. The current architecture (fetch
the entire history over HTTP, hold it in process RAM, index every part per process) cannot
meet that at the measured scale and was the root cause of two live incidents. This document
is the full assessment of the replacement: a two-tier distill-then-search design, walked
top-down (scenarios and budgets) and bottom-up (measured data, real endpoint behavior),
with worst cases enumerated.

Hard budget: no user-visible operation exceeds 30 seconds, and the working target is
low single-digit seconds for a cold query, sub-second warm. Steady-state RAM under 80MB.

## What recall is for (the contract)

The consumer is an LLM agent with a bounded context window. It asks things like "have we
hit this error before," "how did we configure X," "what did we decide last week." It wants
precision, not exhaustiveness: three great excerpts beat fifty ranked ones, and the agent
can always issue a second, narrower query. Recall's previous implicit contract, complete
ranked search over every part ever written, per query, in process memory, is the wrong
contract. Nothing in the usage scenarios below needs it.

## Measured reality (all numbers from read-only queries on 2026-07-17)

Source: `~/.local/share/opencode/opencode.db` (the active channel DB; `opencode-aai.db`
and `opencode-local.db` are other channels), `PRAGMA` stats, full-corpus aggregation, and
the opencode source at `~/projects/oss/opencode` plus the SDK vintage installed in this
repo's `node_modules`.

### The store

| Fact            | Value                                                                 |
| --------------- | --------------------------------------------------------------------- |
| DB file size    | 18.5GB (4,525,357 pages x 4KB), freelist 0 (all live)                 |
| `part` table    | 730,881 rows, **2.76GB** of JSON `data`                               |
| `message` table | 173,020 rows, 797MB (envelopes: role, model, tokens, time)            |
| `event` table   | 757,022 rows, ~11KB avg sampled, est. **~8GB+** (event-sourcing log)  |
| Sessions        | 4,712 with parts; **4,337 children (92%) vs 375 roots**               |
| Projects        | 40 project IDs, 84 distinct directories; largest project 946 sessions |
| Journal mode    | WAL                                                                   |

The 19GB headline number is mostly the event log and message envelopes. The searchable
part corpus is 2.76GB, and it decomposes sharply by type:

| Part type                | Count   | Bytes   | Share of bytes                 |
| ------------------------ | ------- | ------- | ------------------------------ |
| tool                     | 231,026 | 2.44GB  | **88.2%**                      |
| reasoning                | 59,875  | 173.4MB | 6.3%                           |
| text                     | 96,452  | 77.1MB  | 2.8%                           |
| step-finish / step-start | 317,118 | 42.7MB  | 1.5% (noise, already excluded) |
| file / patch / other     | ~26,400 | 41.3MB  | 1.5%                           |

The load-bearing observation: **all human and assistant conversation text across the
entire history is 77MB. With reasoning it is 250MB.** The other 2.4GB is tool output,
which is overwhelmingly low-signal bulk (build logs, file dumps) that our ranking already
penalizes. We have been paying 100% of the cost to index the noisiest 88% of the corpus.

### Distributions (per session)

| Percentile | Parts  | Bytes  |
| ---------- | ------ | ------ |
| p50        | 64     | 223KB  |
| p90        | 200    | 755KB  |
| p99        | 1,905  | 5.7MB  |
| max        | 17,898 | 77.3MB |

Top-10 sessions are 28 to 77MB each. Any design must survive a 77MB / 17,898-part session
without fetching all of it.

### Recency

Sessions by last update: 581 within 7 days, 1,709 within 30 days, all 4,712 within 90
days (opencode adoption is ~4 months old; the store is recent-heavy and growing at
roughly 80+ sessions/day peak). Parts by creation: 275k parts (1.16GB) are older than
90 days, 455k (1.6GB) younger. Consequence: **time-windowing is a weak performance lever
here** (a 90-day window excludes nothing; 30 days still keeps 36% of sessions). Windows
are valuable as _relevance filters_, not as the thing that makes the system fast. The
architecture below is fast at full-history scope; `since`/`until` become semantic
narrowing, never a performance crutch.

### Endpoint and plugin surface (verified in installed SDK + opencode source)

- `session.messages({ sessionID, limit?, before? })` — **keyset pagination exists in the
  SDK we already compile against.** The current server implementation defaults to 50
  messages with cursors. Bounded partial fetch of any session is available today.
- `session.list` supports `directory`, `roots`; an experimental list variant adds
  `start` (time floor), keyset `cursor`, and title `search`. One metadata request covers
  discovery.
- Plugin hook `event` receives the bus: `session.created/updated/deleted/idle/compacted`,
  `message.updated/removed`, `message.part.updated/removed`. **Push-driven incremental
  sync requires no polling.**
- Session rows carry rich card seeds: title, slug, directory, project, parent, agent,
  model, token totals, timestamps.

## Why the current architecture cannot work (brief)

Every round so far preserved one invariant: the plugin fetches and indexes the full
corpus in process RAM. At 2.76GB of parts that means multi-GB heap transients, minutes of
cold sync through the live server, and (round 3) an eviction budget smaller than the
corpus, which degenerates into refetch-and-reindex thrash on every query. The failure was
not any single algorithm; it was scaling an in-memory design linearly with unbounded
history. Both live incidents (pegged CPU, gigabytes of RSS) are fully explained by this.

## Architecture

Three pieces, one data flow. opencode's DB stays the sole source of truth, accessed only
through the SDK (no direct DB reads, per direction). Our store is derived, versioned,
and safe to delete at any time.

```
opencode server (SDK, paginated)
        |
        v
  [distiller]  -- streams sessions once, one at a time; then event-driven deltas
        |
        v
  card store + slim part index   (SQLite file, ours: ~/.cache/opencode-session-recall/store-v1.db)
        |                \
        v                 v
  Tier 1: card search    Tier 1.5: FTS needle lookup     (both: milliseconds, ~0 RAM)
        \                /
         v              v
  Tier 2: bounded drill-down of top-K sessions via paginated SDK fetch + existing rerank
```

### The card store (Tier 0)

One card per session, built by the distiller:

- **Identity/metadata** (from the session list, no message fetch needed): id, parent id,
  title, slug, directory, project, agent, model, created/updated, token totals.
- **Summary head**: first user message head (existing `buildSessionDigest` logic, grown).
- **Code-token inventory**: top ~200 distinctive identifiers, paths, and commands from
  text/reasoning/tool-input parts (existing `CODE_TOKEN_RE` and digest tokenization).
  This is the anchor layer: identifiers are what agents actually query by.
- **Files touched**: paths from read/edit/write tool inputs (capped).
- **Tools used**, **error signatures** (existing `containsErrorPattern`, top distinct
  error lines), **outcome hint** (last-message head).
- **Family rollup**: 92% of sessions are subagent children. Children get thin cards
  (identity + small inventory) and remain first-class results; each root card
  additionally aggregates a strictly capped set of family highlights, each carrying
  provenance (child session id, message id) so drill-down lands on the child transcript
  that actually did the work, not the parent's summary of it. Rollups update
  transactionally with child re-distill/delete. (The existing `exclusionFamily()` only
  computes exclusion sets from discovered metadata; the family graph itself moves into
  the card store, where parent ids already live.)
- Optional **embedding** (existing potion embedder, over card text; 4.7k cards is ~15s
  once, incremental after; brute-force cosine at query time is <5ms).

Estimated total: ~5MB for 4.7k cards. In-memory tier-1 index over cards (existing
MiniSearch) rebuilds from the store in well under a second at startup; the store itself
is the persistence, so cold process start costs no fetching.

### The slim part index (Tier 1.5)

An FTS5 table in the same SQLite file over **capped text of the human layer only**:
text parts, reasoning parts, tool _inputs_ (commands), and titles. Explicitly not tool
outputs (the 2.4GB noise tier). Indexed text: roughly 300MB raw, ~0.5GB on disk with the
index. This is the needle-lookup layer: exact identifiers, error strings, command
fragments, found in milliseconds by SQLite's C engine with zero JS heap cost, across all
history. Row payload is (part id, session id, message id, class, time), so hits map
straight to drill-down targets.

Tokenizer (load-bearing, per review): FTS5 `unicode61` with `tokenchars '_-./'` so
identifiers, paths, and flags (`GHOSTAUTH_LIVE_TUI`, `src/corpus.ts`, `--limit`) survive
as single tokens, plus `prefix='2 3 4'` indexes for partial anchors. We index two
columns per row: raw capped text and the normalized token stream our `tokenize()`
produces (so camelCase splits are findable both ways). Query side: each user token is
quoted into an FTS phrase with operator characters stripped; no raw user input reaches
FTS syntax. Each row stores (part id, message id, previous/next message id, session id,
class, time) — the neighbor IDs are captured for free during the distill walk and make
context retrieval point lookups instead of cursor scans.

Runtime: `bun:sqlite` (opencode runs on Bun; built in) with `node:sqlite` fallback for
tests (Node >= 22.5). Both are stdlib; zero npm dependencies. The driver hides behind a
dynamic-import adapter (same pattern as the semantic module) so `src/` stays free of
Node/Bun globals. If neither driver exists at runtime the plugin degrades to ephemeral
in-memory cards-lite built from `session.list` metadata (no snapshot file, no FTS).

### Query path (Tiers 1 and 2)

1. Parse query (existing `parseQuery`).
2. Tier 1: rank cards (BM25 over card fields + code-token exact hits + optional
   embedding blend + recency prior). Apply metadata predicates (`since`, `until`,
   `project`, `agent`, exclusion family) as filters. Cost: milliseconds.
3. Tier 1.5: FTS lookup of query anchors; merge session hits into the shortlist (this
   catches sessions whose card inventory missed a rare token). Cost: milliseconds.
4. Tier 2: for the top K sessions (default ~12), fetch bounded slices via
   `session.messages(limit, before)` under per-session budgets (below), run the existing
   candidate build + rerank stack (evidence classes, multipliers, snippets) inside those
   sessions only, merge, group, cap. Cost: dominated by fetch of a few MB. Note the
   scope consequence: drilled slices include tool outputs (they arrive in the response
   regardless), so **within shortlisted sessions, tool outputs are fully searchable**.
   The only queries tier 1 + 1.5 + 2 cannot serve are needles that exist _solely_ in a
   tool output of a session nothing else points at; those need the explicit deep mode.
5. Output: same shape as today (grouped results, snippets, queryPlan), with an added
   honest coverage line ("cards current through Xs ago; drilled 12 of 4,712 sessions").

Per-session drill budget: untargeted drill fetches small pages (`limit=25` messages,
newest-first; p50 sessions still fit in one or two pages) and **truncates each part to
existing per-candidate caps immediately after parse**, because the SDK hands us parsed
JSON — byte budgets are enforced on retained data, and an oversized message costs one
parse transient at most, never retention. Paging continues only while under ~1.5MB
retained per session and while anchors keep matching. FTS-targeted drill does not page
at all: rows carry (message id, prev, next), so it is up to three point fetches via
`session.message({ sessionID, messageID })`. Per-query drill budget: ~20MB retained,
hard-capped, shared with the distiller through one global fetch semaphore and byte
budget. A small LRU (the surviving remnant of CorpusCache) holds recently drilled
sessions pinned by (id, updated) so repeat and refined queries are warm.

### The distiller

- **Extraction is a new, narrower path.** The current `searchableFields()` deliberately
  includes tool stdout/stderr; the distiller uses a separate human-layer extractor
  (text, reasoning, tool inputs, titles — never outputs). `searchableFields()` survives
  unchanged for tier-2 ranking of drilled sessions, where outputs _should_ be
  searchable.
- **Cold pass** (once per machine, resumable): page through the session list (keyset
  cursor where the SDK offers it, time-windowed `start` sweeps otherwise — discovery is
  paginated, not assumed to fit one request), distill one session at a time (paginated
  fetch, extract card fields + FTS rows, write in one transaction per session, drop
  raw), checkpoint per session. Volume is ~3.5GB of JSON through the local server.
  Target 2 to 6 minutes wall clock as a background job.
- **The distiller never competes with user-visible work**: one process-wide fetch
  semaphore and byte budget is shared by distill and drill; a foreground query pauses
  the distiller (it resumes from its checkpoint), and slow server responses trigger
  backoff. This is a rule of the design, not a tuning knob.
- **Degraded mode until then**: cards-lite from `session.list` metadata (titles, slugs,
  directories, times; no content fields), with coverage reporting
  `cards: metadata-only`. First-query latency stays under ~2s even on a virgin machine.
- **Incremental**: `session.idle` triggers, debounced. Common case (append-only growth)
  fetches only pages after the per-session checkpoint (last distilled message id) and
  merges: inventories and error signatures recompute from the store's own FTS rows plus
  the appended parts, so no full refetch. Any removal-shaped event
  (`session.compacted`, `message.removed`, `message.part.removed`) voids the checkpoint
  and forces a full bounded re-distill of that session. `session.deleted` drops the
  card and its FTS rows; a periodic reconcile sweep catches missed events.
- **Multi-process protocol** (several opencode processes run one plugin instance each):
  `PRAGMA busy_timeout=5000`, WAL; a `meta` table carries `schema_version` and a distill
  lease (holder id, heartbeat, TTL) — stale leases are taken over on expiry; schema
  migrations run under `BEGIN IMMEDIATE`; per-session writes are transactional
  delete-and-insert so readers never observe half a session; on `schema_version`
  mismatch the newer process rebuilds the store in the background while serving
  degraded.
- **Self-exclusion**: the current session and its family are distilled but flagged, so
  the existing exclusion default keeps working.

## Scenarios, walked end to end

Budgets assume the measured store (4.7k sessions, 2.76GB parts). "Warm" means the store
exists and the process has been up before; "cold process" means fresh process, store
present; "virgin" means no store yet.

1. **Exact anchor (the incident query): `GHOSTAUTH_LIVE_TUI tuistory launchTerminal`,
   global, smart.** Tier 1 hits the inventory (identifiers are exactly what cards keep);
   tier 1.5 confirms and adds any sessions whose cards dropped the token. Drill ~12
   sessions, mostly p50-sized: ~2 to 4MB fetched. **Warm ~0.3 to 1s; cold process
   ~1 to 2s.** Previously: minutes and gigabytes. Worst case: anchor exists only inside a
   giant session's tool output. Cards may still hit via co-occurring command tokens; if
   not, the explicit deep sweep (below) is the honest path.
2. **Broad paraphrase: "how did we handle plugin authentication flows."** No exact
   anchors; BM25 over summaries plus the embedding blend (semantic finally cheap at card
   scale, addressing the round-2 "weak broad paraphrase" feedback head-on). Drill top K.
   **~0.5 to 2s.** Worst case: paraphrase matches nothing; return top recency-weighted
   near-misses labeled as such, in milliseconds, instead of burning minutes.
3. **Temporal: "what did we decide about the eval harness last week."** `since=7d` is a
   card predicate (581 sessions), then rank and drill. **Sub-second to ~1.5s.**
4. **Auto-recall / session start.** The hook queries cards by project + recency and
   injects top cards directly; cards _are_ the summary, no drill needed. **<50ms, no
   fetch.** Previously this hook could trigger a full corpus sync.
5. **Error archaeology: "ECONNRESET during wrangler deploy."** Error signatures live in
   inventories and FTS (error lines appear in text/reasoning too); drill fetches exact
   context. **~1 to 2s.** Worst case: error string only ever appeared in a tool output.
   Deep sweep or expand-by-session covers it; coverage line says so.
6. **"Which sessions touched `src/corpus.ts`?"** Files-touched is card metadata; this is
   a filter, not a search. **Milliseconds.** A capability the old design could not offer
   cheaply.
7. **The triple-query replay (three concurrent global smart queries).** Tier 1 is
   milliseconds each; drills share a fetch semaphore and the LRU dedupes overlapping
   sessions. **All three complete in ~2 to 4s total; RSS stays bounded by the LRU cap
   (~tens of MB).** This is the scenario that previously pegged CPU and climbed to GBs.

## Worst cases and how they are held

| Worst case                                       | Mitigation                                                                                                                                                                                                                                                         | Bound                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Virgin machine, first query                      | Cards-lite degraded mode + background cold pass, coverage reported                                                                                                                                                                                                 | <2s to first useful answer                            |
| 77MB / 17,898-part session in drill set          | Paginated newest-first fetch, per-session ~1.5MB / per-query ~20MB budgets, FTS-targeted `before` paging                                                                                                                                                           | Giant sessions cost the same as normal ones           |
| Cold pass hammers the live server                | Concurrency 2, politeness delay, start after idle, checkpoint + resume                                                                                                                                                                                             | One-time, background, never blocks queries            |
| Needle only in tool output (unindexed by design) | Outputs of drilled sessions are searched anyway; the residual case (output-only needle in an unshortlisted session) needs explicit `deep`, which requires scope (sessions, or since + project), enforces page/byte/time budgets, and returns a continuation cursor | Bounded seconds, honest misses, never implicit        |
| Giant single message on the first drilled page   | Small untargeted pages (limit=25), immediate post-parse truncation to per-part caps, budgets measured on retained bytes; FTS-targeted drill uses exact `session.message` fetches                                                                                   | One parse transient worst case, zero retention growth |
| Store deleted/corrupt/schema bump                | Version stamp; rebuild from scratch in background; degraded mode meanwhile                                                                                                                                                                                         | Self-healing, no user action                          |
| Multiple opencode processes                      | WAL + busy timeout, distill lease, read-anytime                                                                                                                                                                                                                    | No corruption, no duplicate cold passes               |
| Session deleted upstream                         | `session.deleted` event drops card + FTS rows; periodic reconcile sweep                                                                                                                                                                                            | Store converges                                       |
| Query flood                                      | Tier-1 answers are cheap regardless; drill semaphore + LRU                                                                                                                                                                                                         | RAM flat under load                                   |

The only operation allowed past 30 seconds is the one-time cold distill, and it is a
background job with a working degraded mode in front of it.

## Tool surface (the whole contract, not just search)

The review's sharpest catch: bounding search while `recall_context`, `recall_messages`,
and inline `expand` still call `session.messages({ sessionID })` unpaginated leaves a
user-visible path that reproduces the incident on a 77MB session. Round 4 bounds every
tool:

- **`recall`**: same signature plus `since`/`until`/`project` filters and `deep`
  (default false). The description changes to state coverage honestly: full search over
  conversation text, reasoning, tool inputs, and titles across all history; tool
  _outputs_ are searched within the sessions each query drills into; a global sweep of
  tool outputs requires `deep`. Coverage/warnings in the output repeat this when a
  query looks output-shaped (e.g. asks for log contents).
- **Deep mode** (the only path that touches the 2.4GB output tier) demands scope by
  construction: explicit `sessions` list, or `since` plus a project/directory filter.
  It runs under hard page/byte/time budgets with a continuation cursor and reports
  exactly what slice was covered. There is no global unscoped deep sweep; the tool
  rejects it with guidance rather than attempting it.
- **`recall_context` / `recall_get`**: FTS rows and drill hits carry (message id, prev,
  next), so context is up to three point fetches via `session.message`, with per-part
  truncation. Never a whole-session fetch.
- **`recall_messages`** (timeline): paginated passthrough of `session.messages` with
  `limit`/`before` surfaced to the caller and server defaults respected; per-part
  truncation applies.
- **`recall_sessions`**: serves cards directly (richer than today's digest peek, and
  free).
- **Auto-recall and compaction hooks**: card queries only; no drill, no fetch.

## What survives, what is deleted

Survives (largely intact): `extract.ts` (evidence classes, self-tool exclusion, error
patterns), `query.ts`, the multiplier/rerank layer of `bm25.ts` applied within drilled
sessions, `candidates.ts` per-session candidate build, exclusion families, expansion
tools, truncation/grouping/suggestions in `search.ts`, the semantic embedder (now over
cards), the eval harness (cases rebased onto the new plumbing).

Deleted: the full-corpus CorpusCache (shrinks to a small drilled-session LRU), the
persistent global MiniSearch and its add/discard bookkeeping, two-phase windowed ranking
(unnecessary at drilled scale; single-pass full scoring on a few hundred candidates),
the side-index path, `plan.ts` shortlist merging (subsumed by cards), prewarm-everything.

New: `store.ts` (SQLite card + FTS store, runtime-detected driver), `distill.ts` (card
builder growing out of `buildSessionDigest`, scheduler, lease), event wiring in the
plugin entry.

Round-3 uncommitted work: the persistent-index plumbing this replaces. Recommend
archiving the working tree on a branch for the record and starting round 4 from the
committed round-2 state (decision below).

## Risks

- **Card quality is now the product.** If inventories drop the tokens agents query by,
  tier 1 misses. Held by: tier 1.5 FTS as the exact-anchor safety net, eval cases that
  specifically probe needle recall, and inventory caps tuned against the eval set.
- **SDK behavior drift** (pagination defaults, event names). The SDK is the public
  contract and we compile against it; a server that starts clamping `limit` harder only
  changes page counts, not correctness. Covered by runToolRaw-style integration tests.
- **Distill staleness.** Between idle events a live session's newest turns are not in
  cards. Acceptable: the current session is excluded by default anyway, and drill-down
  always fetches fresh slices; coverage reports store recency.
- **bun:sqlite/node:sqlite availability.** Verified for opencode's runtime (Bun) and
  modern Node; explicit cards-only degradation if absent.
- **Disk footprint** (~0.5GB store on this machine, scaling with history). Derived and
  deletable; documented; a size cap with oldest-first FTS eviction is a cheap follow-up
  if it ever matters.

## Verification

- Eval harness rebased; existing 13 cases preserved in intent, plus new cases: needle
  present in card inventory, needle absent from cards but present in FTS, needle only in
  tool output (expects honest miss + deep-sweep hit), temporal filter, files-touched
  filter, virgin-machine degraded mode.
- Perf gates (env-gated like `perf.test.ts`): tier-1 p95 <50ms on 4.7k synthetic cards;
  single-session distill p50 <150ms; drilled query end-to-end against a mock server
  <1.5s; steady-state heap assertion <80MB with transient peaks under 150MB.
- Incident-tied regression gates (each maps to a shipped failure or a review finding):
  virgin first query under 2s; no user-visible operation over 30s; expand/context on
  the largest real session stays bounded (point fetches only); three concurrent global
  smart queries keep RSS under the ceiling; a foreground query observably pauses the
  cold distill; killing a distill-lease holder mid-pass lets another process take over
  after TTL; deep mode without scope is rejected; deep mode continuation resumes where
  coverage stopped.
- Live: replay the three incident queries via tuistory on the real store with wall-clock
  and RSS measurement; run the cold pass on the real 19GB store and record its time.

## Decisions needed

1. **Round-3 tree**: archive on a branch (recommended) or discard outright. Not merged
   either way.
2. **Tier 1.5 FTS in the initial build** (recommended: yes, same distiller pass, it is
   the needle backbone) or cards-only first with FTS as a fast follow.

(Resolved during review: semantic stays opt-in. Card-scale embedding is cheap, but
default-on adds model load and resident memory against a hard RAM target; revisit only
with measured RSS from the real runtime.)

## Out of scope

Direct reads of opencode's SQLite (rejected by direction), upstream opencode changes
(an FTS endpoint upstream would be welcome but is not assumed), LLM-generated summaries
in cards (the `session.summarize` endpoint exists but costs model calls; cards are
purely mechanical), cross-machine sync of the store.

## Implementation spec (v1)

Everything here was verified against the current opencode source (1-day-old checkout),
the SDK vintage in `node_modules`, and the live runtimes (Bun 1.3.13, Node 26.4).

### Verified endpoint contract

- `session.messages({ sessionID, limit, before })`: `before` without `limit` is a 400;
  `limit` omitted or 0 triggers the legacy full-session fetch (the incident path — round
  4 always passes `limit`). Pages are ordered `time_created DESC, id DESC` (newest
  first). `before` is an opaque base64url cursor `{id, time}`; the next-page cursor
  arrives in the `X-Next-Cursor` response header (the body is the items array). The
  SDK's fields-style results expose `response.headers`, so the cursor is reachable.
- `session.message({ sessionID, messageID })`: exact message fetch; the context
  primitive. No cursor coupling.
- We never synthesize cursors from stored `{id, time}` even though we could; the header
  cursor and the exact-fetch endpoint avoid coupling to the cursor format.

### Module map

- `src/sqlite.ts` — driver adapter. `openSqlite(path): Promise<SqliteDb | null>` via
  dynamic import: `bun:sqlite` when `Bun` global exists, else `node:sqlite`, else null
  (degraded mode). Surface: `exec`, `run`, `get`, `all`, `tx(fn)` (BEGIN
  IMMEDIATE/COMMIT/ROLLBACK), `close`. No Node/Bun globals leak outside this file.
- `src/fetch-gate.ts` — the shared fetch primitive (Codex consult): one semaphore
  (default 4) plus an active-query counter that drill, context/messages tools, and the
  distiller all acquire through; the distiller waits while any query is active, with
  bounded-pause logging so a constant query stream is visible rather than silent.
- `src/store.ts` — schema, migration, DAO: cards CRUD, per-session transactional
  replace, FTS query, meta/lease.
- `src/distill.ts` — human-layer extractor (new, narrower than `searchableFields`),
  card builder (grows from `buildSessionDigest`), cold pass, incremental updates,
  pause/resume coordination with queries.
- `src/cards.ts` — tier-1 runtime: load all cards at startup (~5MB), MiniSearch index
  over card fields, metadata filters, family grouping, optional embedding blend.
- `src/drill.ts` — tier-2: bounded paginated fetch, budgets, candidate build + existing
  rerank over drilled sessions, shared fetch semaphore.
- `src/search.ts` — orchestrates tiers; keeps truncation, grouping, suggestions,
  output shaping. `src/corpus.ts` shrinks to the drilled-session LRU. `src/plan.ts` is
  deleted.

### DDL v1

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
-- keys: schema_version, distill_lease {holder,heartbeat,ttl}, coldpass_cursor

CREATE TABLE card (
  session_id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '',
  directory TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '',
  agent TEXT, model TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  part_count INTEGER NOT NULL DEFAULT 0, retained_chars INTEGER NOT NULL DEFAULT 0,
  summary_head TEXT NOT NULL DEFAULT '', outcome_head TEXT NOT NULL DEFAULT '',
  inventory TEXT NOT NULL DEFAULT '',       -- space-joined top tokens
  files TEXT NOT NULL DEFAULT '[]', tools TEXT NOT NULL DEFAULT '[]',
  errors TEXT NOT NULL DEFAULT '[]', family_rollup TEXT NOT NULL DEFAULT '[]',
  distill_state TEXT NOT NULL DEFAULT 'metadata',  -- 'metadata' | 'full'
  distilled_through TEXT,                          -- checkpoint: last message id seen
  embedding BLOB
);
CREATE INDEX card_updated ON card(time_updated DESC);
CREATE INDEX card_root ON card(root_id);
CREATE INDEX card_project ON card(project_id);

CREATE TABLE part_text (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, part_id TEXT NOT NULL,
  message_id TEXT NOT NULL, prev_message_id TEXT, next_message_id TEXT,
  class TEXT NOT NULL, time_created INTEGER NOT NULL,
  raw TEXT NOT NULL, norm TEXT NOT NULL
);
CREATE INDEX part_text_session ON part_text(session_id);
CREATE UNIQUE INDEX part_text_part ON part_text(part_id);

CREATE VIRTUAL TABLE part_fts USING fts5(
  raw, norm, content='part_text', content_rowid='id',
  tokenize="unicode61 tokenchars '_-./'"
);
```

No `prefix=` index in v1 (Codex consult): anchors are matched as exact quoted phrases,
so prefix indexes are disk and write cost with no query to serve them. If explicit
prefix queries appear later, add `prefix='3 4'`, never `2`.

External-content FTS: text is stored once (in `part_text`), the FTS table holds only
the index, session deletes walk the indexed `part_text_session` index, and `snippet()`
still works. Per-session replace, in one `BEGIN IMMEDIATE` transaction: read old rows,
issue `INSERT INTO part_fts(part_fts, rowid, raw, norm) VALUES('delete', ...)` per row
(with the old values, before deleting them), delete from `part_text`, insert new rows
into both, upsert the card, commit. Readers never see half a session.

Lease acquisition/takeover is a single conditional
`UPDATE meta SET value=? WHERE key='distill_lease' AND (<expired> OR <holder matches>)`
inside the transaction, verified via the driver's changes count — never
application-level read-check-write (Codex consult).

### Distill caps (defaults, all configurable)

Per-part indexed text: text/reasoning 2,000 chars, tool inputs 1,000, titles 200.
FTS rows per session: 5,000 (giants hit the cap newest-first; coverage marks it).
Inventory 200 tokens, files 30, errors 8, rollup 12 entries per root. Estimated store
at current history: ~350-500MB on disk.

### FTS query construction

Anchors = code tokens + user-quoted phrases + rare plain tokens. Each anchor is
individually double-quoted with internal `"` stripped (no user text ever reaches FTS
syntax); multi-word phrases are quoted as phrases only when the user actually quoted
them (phrase = adjacency semantics, never a convenience join). Join rule (Codex
consult): strong anchors (code tokens, user phrases) are AND-joined; weak/overflow
plain tokens join by OR. Ranked by `bm25(part_fts)` ascending with narrow selected
columns: `SELECT p.session_id, p.part_id, p.message_id, p.prev_message_id,
p.next_message_id, p.class, bm25(part_fts) score FROM part_fts JOIN part_text p ON
p.id = part_fts.rowid WHERE part_fts MATCH ? ORDER BY score LIMIT 200`, grouped by
session in JS and merged into the card shortlist.

### Drill mechanics

Global fetch gate: one semaphore (default 4 concurrent SDK calls) + one per-query
retained-chars budget shared by all tiers; the distiller acquires the same semaphore at
lower priority and pauses while any query is active. Untargeted drill: pages of
`limit=25`, newest-first, per-part truncation to existing caps immediately after
parse, stop at 1.5M retained chars per session or when anchors stop matching, hard cap
~20M retained chars per query. Targeted drill (FTS hit): `session.message` point
fetches for (message, prev, next). Drilled slices feed the existing candidate build +
rerank (single-phase; two-phase windowing is deleted). LRU of drilled sessions keyed by
(session id, time.updated), default budget 24M chars (repurposed `cacheMaxChars`).

### Config additions (Limits)

`storePath` (default `~/.cache/opencode-session-recall/store-v1.db`), `drillSessions`
12, `drillCharsPerSession` 1.5M, `drillCharsPerQuery` 20M, `drillPageMessages` 25,
`distillConcurrency` 2, `distillDelayMs` 25, `ftsRowsPerSession` 5000,
`inventoryTokens` 200, `coldPass` true. Existing `cacheMaxChars` becomes the drilled
LRU budget (new default 24M). All coerced defensively per AGENTS.md.

### Degraded modes (explicit ladder)

1. No SQLite driver: cards-lite in memory from `session.list` each process; no FTS; no
   persistence; coverage says `store: unavailable`.
2. Store present, cold pass incomplete: serve what exists; coverage reports distilled
   fraction and `cards: partial`.
3. Store schema newer than code: read-only refusal, degraded mode 1 behavior, log once.
4. Corrupt store: delete file, recreate, background rebuild (mode 2 meanwhile).

### Build notes

`node:` imports are auto-external in tsup; `bun:sqlite` must be added to tsup
`external`. Tests run the real `node:sqlite` (Node 26 locally and in CI) with a
temp-file store per test; the adapter's null path is unit-tested by forcing import
failure.

## Revisions

- 2026-07-17: Codex review round 1 (verdict: direction sound, plan incomplete; 4
  blockers, 12 issues, 1 nit). All findings accepted and folded in: bounded
  expand/context/messages tools added to the contract (blocker 1); stored
  prev/next message ids + exact `session.message` fetch replace cursor-scanning for
  context (blocker 2); deep mode constrained to scoped, budgeted, continuable sweeps
  (blocker 3); small untargeted pages + post-parse truncation with budgets on retained
  bytes (blocker 4); shared distill/query semaphore with pause-on-query (5);
  append-checkpoint incremental with removal-event full re-distill and card recompute
  from stored rows (6); concrete multi-process protocol: schema*version, BEGIN
  IMMEDIATE migrations, lease TTL takeover, transactional per-session replace (7); FTS
  tokenizer specified: unicode61 tokenchars `*-./`, dual raw/normalized columns, prefix
indexes, query escaping (8); distiller gets its own human-layer extractor,
`searchableFields` survives only for drilled ranking (9, 10); tool descriptions state
  output-tier coverage honestly (11); family rollups capped with child provenance,
  children first-class (12); discovery treated as paginated with honest coverage when
  capped (13); one global byte budget, transient peak allowance in gates (14);
  semantic stays opt-in (15); sqlite behind a dynamic-import adapter with test fake
  (16); incident-tied regression gates enumerated (17).
- 2026-07-17: Implementation spec (v1) added after endpoint-contract verification
  (pagination cursor lives in the X-Next-Cursor header; `before` requires `limit`;
  pages are newest-first; `session.message` point fetch exists). Codex consult on the
  spec: external-content FTS confirmed; `prefix=` dropped for v1; lease takeover
  changed to a conditional UPDATE checked via changes(); MATCH join rule refined
  (strong anchors AND, weak OR, phrases only when user-quoted); shared `fetch-gate`
  module added; JSON-snapshot fallback cut (degraded mode is ephemeral metadata only).
