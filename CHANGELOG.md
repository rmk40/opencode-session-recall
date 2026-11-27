# Changelog

All notable changes to this project are documented here. This project follows
[Conventional Commits](https://www.conventionalcommits.org/) and
[Semantic Versioning](https://semver.org/).

## Unreleased

The store stays at schema 5, so upgrading needs no migration. Restart every
OpenCode process after upgrading, the opencode v2 background service included
(`opencode service restart`), since a running process keeps the version it
loaded.

### Changed

- **`recall` excludes only the current session by default.** Project- and
  global-scope searches used to leave out the current session's whole
  family, its parent, siblings and subagents. They now leave out the current
  session alone, so an orchestrator can find what its own subagents found.
  `excludeFamily: true` leaves out the whole family again. It is refused
  with `scope: "session"`, with `excludeCurrentSession: false` and with a
  `sessionID` in the family, since each of those asks for a session the flag
  excludes. Under `excludeFamily: true` a `sessions` list (with or without
  `deep`) and a deep cursor drop the relatives they name and count each one
  under `coverage.skippedByReason.excludedSession`.
  - Without a time bound, a relative whose best match is the prompt its
    orchestrator wrote ranks just below the best result from outside the
    family. Relatives hold at most two of the first five results and a third
    of the drill slots (never fewer than two). A time-bounded search keeps
    their order, as do a search of one session and a search of a named list.
    A relative whose reply only restates the query is not demoted, so
    `excludeFamily: true` is the way to leave it out.
  - On zero or few results (fewer than three, or fewer than `results` when
    that is smaller), a suggestion names the excluded sessions that matched
    the query and the argument that brings them back. An empty result after
    the current session was excluded always names that exclusion.
  - The opencode v1 `autoRecall` hook still leaves out the current session's
    whole family.
- **`recall_messages` with `role` or `query` reads on until `limit` messages
  match.** The filters used to apply only to the one page a call read, so a
  narrow filter could return nothing from a session full of matches. A call
  now reads page after page. It stops once `limit` messages match, once it
  has read `scan` messages (default 500, at most 2,000) or 40 pages, once its
  matches fill the output budget or at the end of the session. `pagination`
  reports `scanned`, `matched`, `returned`, `order` and the `stop` reason
  (`limit`, `scanBudget`, `outputBudget` or `end`). `nextCursor` resumes
  right after the last message the call read, or inside the message where a
  trimmed output stopped. It finds its place even when the next call changes
  `limit`, `role` or `query`. Cursors from 3.0 still work.
  `maxMessages` still caps `limit`.
- **A time bound keeps the sessions that overlap its window.** `recall`
  used to keep a session only when its last update fell inside the window,
  so an upper bound (`until`, `to`, `before`) left out every session that
  kept running past it, such as the subagents an orchestrator started in
  that window. A session now qualifies when it was created at or before the
  upper bound and last updated at or after the lower bound (`last`, `since`,
  `from`, `after`). Results still come only from messages inside the
  window. Card ranking, the slim index, the deep listing and named sessions
  without a card all apply the rule. `recall_sessions` still filters by
  last update.
- **The drill reads toward the window.** On opencode v2 a search with an
  upper bound starts reading each session at the last message created at or
  before it. A search with a lower bound stops once it has read every
  message created inside the window, even where a retried step left
  creation times out of order. Messages outside the window no longer count
  against `drillCharsPerSession` or `drillCharsPerQuery`. Reading past them
  has bounds of its own, four times each of those budgets in chars, 2,000
  messages a session and 8,000 messages a search. Messages looked up from
  the slim index count toward them as well. The session where a search
  reaches one reports `sessionBudget` or `queryBudget`, or `targetsCut` when
  only its slim-index lookups were left. On opencode v1, which cannot start
  mid-session, the drill reads past the newer messages from the newest one.
  In `coverage.sessionStops`, `fetched` counts the messages read outside the
  window too and `candidate` counts only those inside it. A deep sweep reads
  the same way and returns a continuation once it has read past four times
  its budget outside the window.

### Added

- **`order: "oldest"` on `recall_messages`** starts at a session's first
  message and reads forward. It needs opencode v2. On v1 the tool returns an
  error that says oldest-first browsing is unsupported there. A cursor keeps
  the order it was made in. Passed with the other order, it is refused.
- **`toolName` aliases.** `bash`/`shell`, `task`/`subagent` and
  `apply_patch`/`patch` (tools opencode v2 renamed) each count as one tool,
  whatever the case. Any other name still matches exactly, case included.
- **`coverage.toolNames` when a `toolName` search finds nothing.** When the
  searched sessions hold tool parts, the response describes the tool parts
  the drill read that pass every other filter. It gives the names the filter
  accepts, how many parts it matched, the total, the number of distinct
  names and the ten most frequent names with their counts. A suggestion
  offers the closest name as the retry. After a deep sweep that stopped
  before covering its scope, the suggestion says to continue the sweep
  first. When the authorship filter removed every part of the named tool
  (`excludedByAuthorship`), it says to widen `authorship` instead.
- **`coverage.cards.pending`** counts the cards a search left out of card
  ranking because the index had yet to take their latest content. It
  appears only when the search stopped waiting for the index with such cards
  left.

### Fixed

- **A rename, move, archive or unarchive made while its session is being
  distilled is no longer lost.** A re-distill, a repair sweep or a cold pass
  that read the session before the change wrote the old metadata back over
  it. The distiller now reads the session's metadata again once the last
  such write has finished, on both hosts. A failed read is retried up to five
  times with a doubling delay.
- **Archiving or unarchiving a session without new messages updates its
  card.** The card kept its old archived state until the session changed
  again. The opencode v2 session scan and archive events update it, as does
  `session.updated` on v1.
- **Family exclusion covers a subagent's own subagents.** When the current
  session had a parent, the family walk never visited it as a child, so its
  own subagents stayed in the results. This affected the v1 `autoRecall`
  hook and the family exclusion that was `recall`'s default, which
  `excludeFamily: true` now applies.

### Performance

The measured numbers below come from the `RECALL_PERF=1` gates
(`test/perf.test.ts`, `test/perf-v2.test.ts`), which run on synthetic data,
most of them on a store of 12,000 cards.

- **The card index is updated in place.** A process used to reload every
  card and rebuild the whole card index on the event loop at its first
  search after any card write. It now checks the store at most every 5
  seconds, applies only the cards written since its last check and replaces
  each changed card's entry in the index. It loads every card only on a cold
  start, after the store was reset and after an older build wrote cards
  without recording a revision for them. That load reads 250 cards at a time
  with a pause between pages, while a full index build works in slices of
  about 8 ms, so neither holds up other work in the process. A search of one
  session or of a named list never waits for the index. A stored vector is
  reused only when the current model wrote it for the card version the
  process holds, so a model switch neither reuses the old model's vectors nor
  embeds current cards again.
  - Over 24 searches with card writes between them, the card tier took a
    median of 32 to 42 ms of each search and the whole search 65 to 81 ms.
    Applying 400 changed cards took 0.7 to 1.1 s, with no slice of the event
    loop over 23 ms. A cold build of the lexical index took under 11 s, with
    no code slice over 25 ms once garbage-collection pauses are left out.
- **Family rollups are read one family at a time.** Each child write or
  deletion used to read every card in the store to recompute its root's
  rollup. The distiller now reads only that root's family, in pages of 500
  cards with a pause between them. It runs one recompute per root at a time.
  The full rollup pass after a cold pass reads only the rollup columns, in
  pages of the same size. In the gates, the longest event-loop
  slice of a repair sweep over 400 stale cards in the 12,000-card store was
  22 to 36 ms, against 107 to 122 ms while each write read every card.
- **On opencode v2 a streaming session's tail is re-read alone.** While a
  session's last turn was still running, each poll re-read the session in
  full. The distiller now re-reads only the messages past the newest settled
  one and merges them with what the card already holds. It skips the read
  when nothing past that point changed and reads in full when a message up
  to that point changed. In the gates, a tail write to a card of 5,000
  indexed rows took about 180 ms, against about 1.6 s for the session's
  first write, which read it in full.
- **A full write changes only the rows that differ.** When an indexed session
  changed, the distiller wrote it again by deleting every row it held in the
  slim index along with its index entry, then inserting them all in one
  transaction. On a real session of 5,000 indexed rows, changing one row held
  the event loop for about 300 ms on a warm file and for seconds while the
  disk was busy. The write now keeps the stored rows whose parts are still in
  the same order and overwrites only those whose fields differ. It deletes the
  rows that are gone and inserts the new ones. The index changes for those
  rows only. The distiller reads the stored rows before the write, 500 at a
  time with a pause between reads. The write still commits as one
  transaction, so a search never sees half a session. A row added before one
  that stays, or a part that moves, still rewrites every row after it. A tail
  write over a running turn compares the turn's rows the same way. In the
  gates, a full write that changed one row of a 5,000-row card, added one and
  evicted the oldest took 23 to 25 ms from its first read to its commit, with
  no slice over 8 ms. Before, it took 97 to 100 ms in one slice. It now runs 9
  row and index statements, against 15,001.
- **An append builds its card before its write.** Once a session has more
  than 2,000 parts, the distiller appends new messages to its card. The
  append read every stored row of the session twice inside its transaction
  and derived the card's inventory there, over every row it kept. It now
  reads the stored rows before the write, 500 at a time with a pause between
  reads. It derives the card before the write too, pausing as it goes. The
  transaction reads only the rows it evicts. Ranking the inventory also no
  longer sorts every token. A session with a real spread of code tokens can
  hold over 200,000 distinct ones. That sort alone held the event loop for
  over 100 ms. The inventory comes out the same. In the gates, with 5,000 indexed rows the
  size of a real session's, appending one message held the event loop for at
  most 21 to 24 ms, against 504 to 644 ms in one slice before. A full re-read
  of the same card held it for at most 23 to 29 ms, against 202 to 263 ms.
- **`recall_get` continuations read on from where the output stopped.** On
  opencode v2 a continuation into a message's part rows reads from the row
  of the part where the previous output stopped, about two outputs' worth at
  a time, instead of reading the message again from the start.
- **Concurrent distiller writes yield to the event loop between them.**
  Cold-pass workers, repair-sweep workers and concurrent re-distills pause
  after each session write before the next one runs, so their writes share
  the event loop with other work one time slice at a time.
- **Smart and fuzzy searches rank drilled messages without building a search
  index.** Each search used to build an in-memory index over every message
  part the drill read and a second one over the card shortlist's sessions.
  The ranking now counts what its scores depend on in one pass over the parts
  and scores only the parts holding a query word, with the same results as
  before. When every drilled session is on the shortlist, the second pass
  reuses the first one's results. Each message read is tokenized once.
  Measured on synthetic drilled pools, ranking about 1,400 parts (3.1 million
  characters) took 8 to 57 ms against 270 to 530 ms before. About 13,000
  parts took 64 to 290 ms against 3.0 to 5.5 s.
- **A lookup by plain words reads a bounded part of the slim index.** A search
  without a code token or a quoted phrase also looks its words up in the slim
  index of message text. That lookup used to score every row holding any of
  the words. When between one and 19,999 rows hold every word of the query,
  it now lists those rows first, newest first and without scoring them. The
  rest of its results come from the query's rarer words, taken from the
  rarest while their rows add up to at most 20,000. A word left out of those
  still ranks the rows it shares with them while it is in fewer than 100,000
  rows. A query whose every word is in 20,000 rows or more returns only the
  rows holding all its words. A single common word is not looked up. Code
  tokens and phrases are looked up as before.
  - On a synthetic index of 2 million rows, the eight words of "actualyze
    desktop app launcher sign in governed inference" matched 1.3 million rows
    and took 1.8 s. The lookup now takes 49 ms and a ten-word question 53 ms.
    Two words in 900,000 rows each that share one row take 20 ms. Queries of
    common words that share too many rows to list are skipped after 16 to
    44 ms.
- **Reads and passes yield on a time budget.** The opencode v2 history
  reader and sync, the card runtime, the distiller and session discovery
  used to wait out a `setTimeout(0)` turn, about 1.25 ms, before nearly
  every statement or page. They now hand the event loop back only once
  about 8 ms of work has run, through `setImmediate`, which lets due timers
  and ready I/O run in a few microseconds. Callers waiting at once take
  turns, one slice each. A drill of 12 sessions of 70 messages each took 32
  to 39 ms against 440 ms. In the gates the v2 cold pass took 12 s against
  33 s and a repair sweep over 400 stale cards 2 s against 6 s.
- **A search goes ahead of the distiller.** The distiller's passes, the
  history reads they make, the v2 sync and discovery yield through a
  background yield point that shares the time slice with a search's reads
  and card build. While a search waits, the background takes one turn in
  eight, so a cold pass slows down during the search but keeps going. Over
  12,000 sessions the first search after a restart took 32.5 s during a
  cold pass against 7.0 s with none running. Over six runs since, it took
  3.9 to 7.9 s against 3.4 to 6.8 s, at most 1.2 times as long. The pass
  finished 7 to 13 s after it.
- **Time-bounded searches read less.** Over 12 subagents that each wrote
  40 messages inside a window and 600 after it, a drill read 480 messages
  in 26 ms instead of 7,680 in 358 ms. With a lower bound near the end of 12
  sessions of 2,000 messages, it read 600 in 25 ms instead of 14,700 in
  563 ms.
  - A session that kept running long past the upper bound is read from the
    bound. Finding where to start in a session of 4,896 messages before the
    bound and 60,000 after it took 12 ms, in ten statements that read no
    message bodies.
  - A session that wrote nothing inside a window with both bounds is not
    read at all.
- **A history page read costs the page, not the session.** On opencode v2 a
  page read looked its messages up in a way SQLite could run as a walk of
  every message in the session for each message on the page. On a real
  session of 34,333 messages one page of 50 took 120 ms of CPU. Each read now
  looks its messages up by position. In the gates a page of a
  35,000-message session takes under 2 ms of CPU whether it is the newest,
  the oldest or one from the middle, against 1.9 s for the middle one when
  SQLite had no automatic index to use.
- **The message poll reads in pages.** On opencode v2 the first poll after a
  restart grouped every message since its watermark by session in one
  statement, which SQLite ran over an index of every message in the
  database. It now reads the new messages 2,000 at a time in order of
  creation with a pause between pages. Each session is signaled once. In the
  gates a poll over 200,000 new messages after 600,000 older ones held the
  event loop for at most 10 ms, against 26 ms in one statement.

## 3.0.1

### Fixed

- **opencode v1 servers that require authentication work again.** The plugin
  rebuilds its SDK clients from the host's transport, and it copied the
  host's headers by spreading them. The SDK keeps them as a `Headers`
  object, which spreads to nothing, so `Authorization` was dropped. A
  server with Basic auth (for example one started with
  `OPENCODE_SERVER_PASSWORD`) then answered every request with 401 and
  recall indexed nothing. Both clients now keep every host header.
  Reported with a fix by @air391 in #5.

## 3.0.0

### Added

- **opencode v2 support.** The same package now runs on opencode 2.0 through
  2.4 (checked against 2.4.1) as well as opencode v1 (1.3.4 and later). One
  default export serves both: v1 calls `server()`, v2 calls `setup()`,
  and `setup` stays inert under v1. On v2:
  - The five tools, `nudge` and `primary` work as on v1. `primary` hides
    the tools from sessions that have a parent session and refuses them
    there. Tool calls show no custom titles, since v2 has no channel for
    them.
  - History is read from opencode's own `opencode.db`, strictly read-only,
    because v2's plugin API cannot page sessions. The file is found the
    way opencode finds it; the new `opencodeDbPath` option overrides it.
  - The index lives in its own store, `store-opencode-v2.db`, stamped with
    the host and the database it was built from. One process runtime
    serves every location and indexes every project; `global: false`
    limits queries, not indexing.
  - Discovery walks every session in pages by session id, with no overall
    cap and archived sessions included, so `recall` searches archived
    sessions too.
  - `recall_sessions` with `parentID` reads the children in pages by
    session id, up to 10,000, so a child updated during the walk is neither
    skipped nor listed twice. A parent with more children gets
    `truncated: true` and a note.
  - A poll keeps the index fresh with no events: new messages within
    about 30 seconds, renames and other metadata-only changes within
    about 5 minutes. Each card checkpoints its session's tail, so a
    streaming, rewritten or reverted session is re-read rather than
    appended to.
  - When `opencode.db` cannot be read, responses say why in
    `coverage.source`, `recall` answers from the session cards alone
    (a selected session whose card has nothing to offer counts under
    `coverage.skippedByReason.noCardCandidate`), and the message-reading
    tools return the reason as their error.
    That holds when the file is missing or its path cannot be resolved
    too: a store stamped for the same file is opened for its cards,
    without being re-stamped or distilled into.
  - `autoRecall`, `compactionRecall` and `summaries` are not available yet;
    enabling one logs a line and changes nothing.
  - Plugin output goes to `~/.cache/opencode-session-recall/recall.log`
    when `RECALL_DEBUG=1` is set, since v2 discards plugin console output.
  - The `@opencode-ai/plugin` peer dependency is now optional (and at
    least 1.3.4), so a v2-only install needs no v1 package.

- **opencode 2.4 `session_part` content is read and indexed.** opencode 2.4
  stores an assistant message's content in a separate `session_part` table.
  The v2 history reader now reads those rows together with any inline
  content, in the order opencode reads them, so that text, reasoning and
  tool calls reach the index and every tool. A message too large for one
  read (over 4 MiB with its parts, or more than 2,000 part rows) comes back
  with `partial`. `recall_get` continues it from where the read stopped.
  - Cards built without part rows are rebuilt by a background repair sweep
    after each cold pass, sessions with part rows first. A rebuild whose
    read looks like it lost content (part rows of an unknown type, or a
    completed assistant message that reads empty despite its part rows)
    keeps the existing card and marks it instead of overwriting it.
  - opencode writes a part without touching its message row, so a
    part-only change in a settled session moves neither poll. A background
    range check finds it by comparing stored hashes of each session's rows
    with `opencode.db`, one range per poll while no tool call is reading
    history. It re-indexes a session whose rows changed.
  - `recall` responses on v2 carry `coverage.history`, which reports whether
    part rows are read, the newest opencode migration and whether this version was
    tested against it, unknown history tables, counts of what reads could
    not project and the progress of the repair sweep and the range check.

- **Output trimming and continuations on every tool.** All five tools keep
  a result within what OpenCode passes to the model whole (2,000 lines and
  50 KiB). A result that does not fit in 40 KiB and 1,900 lines carries
  `trimmed: true` and a `continuation`, written ahead of the records. Every
  tool takes a new `cursor` argument that resumes exactly there. A part cut
  or resumed inside a text field says so in `cutAt` or `resumedAt`.
  `recall` trims expansions before results. Its continuation re-runs the
  search with the time bounds the first call resolved. A continuation is refused, with a hint to start again without
  it, when it is passed with different arguments or what it points at has
  changed. Both hosts also withhold any result over OpenCode's limit and
  return a small error with `trimmed: true` in its place.

- **`authorship` filter on `recall`**: ask for what a human actually typed.
  `role: "user"` is a transport fact, not an authorship one — a survey of this
  machine's corpus (`docs/surveys/user-role-authorship.sql`) found only ~51% of
  user-role text was typed by a person; ~37% is orchestrator-authored prompts
  inside subagent sessions, plus host/tool injection and TUI status blocks.
  Candidates now classify as `human`, `delegated`, `injected`, `model`,
  `title`, or `unknown` from structural signals only (message role, part flags,
  session parentage, part type), and `authorship` selects any of them or an
  array of them. Narrowing to `human` also restricts normal ranked selection to
  root sessions on both the card and FTS paths, so child sessions stop
  consuming drill budget; explicitly named sessions and deep sweeps are exempt.
  Unresolvable parentage classifies `unknown` and is withheld from `human`
  rather than assumed — the filter fails closed. Results carry
  `why.authorship`, and `coverage` reports `limitedBy: ["authorship"]` plus
  `skippedByReason.authorship`, all only when the filter is active or
  `explain: true`, so default responses are unchanged.

### Changed

- While the background cold pass is still building the index for the
  first time, `recall` responses carry `coverage.cards.indexing`
  (`{ indexed, examined, known }`: sessions with a card, sessions the
  current pass has checked, sessions known) and a warning such as
  "Indexing in progress: 1008 of 6101 sessions indexed; 0 checked in this
  pass; older history may be missing."
  `recall_sessions` adds the same note, with an `indexing` field, to
  listings it selects from the index (a `since`/`until` filter, or the
  card listing served while the history is unavailable); plain listings
  are live and carry neither. Before, the card counts alone read
  as complete while older sessions were not indexed yet. Every opencode
  process sharing the store reports the pass, not only the one running
  it; if no pass has made progress for 5 minutes the warning says the
  index is incomplete and not being built right now (`stalled: true`).
  Once a pass has indexed every session (nothing waiting for a retry, and
  no skipped session without a card), later passes (such as the check on
  every restart) report nothing.
- The v1 cold pass now yields to the event loop between sessions, inside
  a large session's card derivation, and every 50 family-rollup writes,
  so a big history no longer holds the host's loop for long stretches.
  After a rollup pause the root's card is re-read from the store before
  it is written, so a card re-distilled during the pause is never
  overwritten with the older copy. Cards and results are unchanged.
- Plugin log lines now go through an internal log sink (`src/log.ts`)
  instead of calling `console.log` directly. v1 output is unchanged: the
  same `[recall] ...` lines reach the console, and there is no new option.
  On opencode v2, which discards plugin console output, the same lines go
  to a debug log file instead (see the v2 entry under Added).
- **The store moves to schema 5.** An existing store at schema 3 or 4
  (`store-v1.db`, or a v2 store at schema 4) upgrades in place on first
  open, keeping every card, index row, vector and summary. The upgrade only adds columns and one table.
  `card.distill_cursor` and `card.projector_gen` stay empty under opencode
  v1 (they are for the v2 host). The others are `card.write_rev`,
  `card.repair_reason`, `card.settled_base`, `card.time_archived` and the
  `range_hash` table. The store now records which opencode host
  writes it (`meta.store_host`), so a store owned by another host is refused
  before any migration: the plugin runs in the degraded metadata-only mode and
  logs one `store refused (<reason>)` line instead of rebuilding the file.
  Every card write now allocates its revision in its own transaction and
  stamps it on the card (`card.write_rev`, with the `cards_stamped` and
  `cards_deleted` counters). A write that changes nothing a reader sees
  allocates none.
  **Restart every opencode process after upgrading.** The schema fence
  takes effect when a process opens the store, so an older process that is
  already running keeps writing to the store as the older version until it
  restarts.
  Downgrade consequence: an older plugin build (schema 3 or 4) sees the upgraded
  store as newer and runs degraded. To downgrade cleanly or reset a refused
  store, quit every opencode process sharing the store, delete the store
  file, and restart; it rebuilds in the background.
- The build tag in `coverage.semantic.pluginVersion` and in the distill
  lease's `build` field now names the host: `schema5.gen4.opencode-v1`
  instead of `schema3.gen4`. The v2 host also names its history projector
  generation (`schema5.gen4.proj1.opencode-v2`).
- **`coverage.messagesSearched` is replaced by three counts.**
  `messagesFetched` is how many messages the drill read (from history or
  from its cache), `messagesCandidate` how many of those produced a
  searchable candidate and `messagesEligible` how many still had one after
  the query's filters, which is what the match path searched.
  `coverage.sessionStops` lists the first 10 target sessions with the same
  counts and why the drill stopped reading each (`end`, `anchor`,
  `sessionBudget`, `queryBudget`, `targetsCut`, `loadError`, `aborted`, or
  `budget` and `wallClock` for a deep sweep), plus `cached: true` for a
  session read entirely from the drill cache.
- **Warnings name only content a search may have missed.** The warning
  that the card store held the maximum discoverable sessions is gone, since
  it fired on the number of cards alone. `coverage.limitedBy` gains
  `"providerLimit"`, with a warning, only when session discovery stopped
  at its limit. On v1 the lease holder records that in the store
  (`meta.discovery_truncated`), so every process sharing it reports it. On
  v2 a response warns when `opencode.db` holds content this version cannot
  read or while cards are waiting to be rebuilt (or could not be). It also
  warns when a result session was indexed with messages cut short. An opencode
  migration this version was not tested against is reported in
  `coverage.history` without a warning of its own.
- **`recall_messages` cursors are continuation tokens.**
  `pagination.nextCursor` is now an opaque `rc.` token. On a trimmed page it
  resumes inside that page. Otherwise it reads the next one. A raw page
  cursor from an earlier version is still accepted and reads that page from
  its start.
- **`recall_sessions` pages past `limit`.** A listing with more matching
  sessions than `limit` carries `truncated: true` and a `nextCursor`, in
  every listing mode (live, children or selected from the cards). Passed
  back as `cursor` with the same arguments, `nextCursor` returns the next
  `limit` sessions. On a trimmed page it equals the `continuation` and
  returns the rest of that page first. A listing bounded to the newest
  `limit` live sessions (the staleness fallback, or `since`/`until` without
  a card store) stays one page. Listings served from the cards now report
  `archived` from the card instead of always `false`.
- On opencode v1 a tool whose `execute` rejects now returns a bounded
  `{ ok: false, error }` result instead of passing the rejection to the
  host.
- On opencode v1, cards now record when their session was archived
  (`card.time_archived`).
- A session whose first user message starts with the exact line
  `You are a subagent spawned by another session.` no longer carries that
  line in its summary head (the card head and the session digest). This is opencode v2's
  subagent prompt prefix; under v1 it only affects sessions that happen to
  start with it, and an existing card's head changes only when its session
  is next distilled.
- A message whose whole text is exactly one of the placeholders the v2
  history source writes for a row it cannot load (for example
  `[unavailable: data is not valid JSON]`) is no longer used as a session's
  summary head or digest vocabulary. Under v1 this only reaches text
  literally written in that shape.
- `recall_sessions` still returns `{ ok: false }` when the server answers a
  session listing with a body that is not an array, but the error text is
  now `session listing response was not an array` instead of the runtime's
  own TypeError message (such as `result.data is not iterable`).

### Fixed

- **The cold pass no longer stalls on sessions the host keeps failing
  on.** If opencode could not serve a session (seen live on 1.18.33, where
  booting that session's project directory failed with
  `no such column: project_id`), every cold pass aborted on it and retried
  it every 60 s, so older sessions were never indexed. A failing session
  now no longer stops the pass: it is set aside, the pass indexes
  everything else, and the session is retried once at the end. If that
  retry fails too, a follow-up pass tries again after 60 s; after three
  passes the session is skipped (logged one line each for the first few,
  then as a count), so it stops holding passes back; a later pass still
  tries it once, and so does any change to it. While skipped sessions
  remain, another pass tries them after 10 minutes, and again with the
  wait doubling up to 1 hour while none of them heals, until they heal,
  are deleted or leave the session list; so an outage that failed every
  fetch recovers once the host heals. Five sessions failing in a row
  still abort the pass as an outage, but only sessions not already known
  to fail count toward that, and an aborted pass counts against every
  session that failed in it, so a failure that repeats cannot abort
  passes forever.

## 2.3.0

### Added

- **`mode: "ephemeral"` option** (issue #4): run with no store and no on-disk
  artifacts — no SQLite file, nothing under `~/.cache/opencode-session-recall`,
  no background content indexing. Ranking is metadata-quality over live session
  listings (refreshed lazily, at most once per 60s window); content search
  still works through the bounded live drill and deep paths. Semantic,
  summaries, `compactionRecall`, and sessions enrichment are unavailable in
  this mode, the default scope flips to `"project"` (explicit
  `scope: "global"` still works), and `coverage.mode` reports `"ephemeral"`.
  Persistent-mode behavior is unchanged.

## 2.2.0

Based on PR #3 by @kernel-oops with maintainer fixes.

### Fixed (explicit `sessions` shortlist)

- **An explicitly named session with no card is now searched.** `recall` with a
  `sessions: [...]` shortlist previously resolved targets only through the card
  store, so a session the distiller had not carded yet (a young or just-finished
  session — e.g. a subagent that ended moments ago) silently vanished and the
  response reported `sessionsEligible: 0`. Both shortlist branches (non-deep and
  `deep: true`) now append the uncarded ids as direct drill targets. Uncarded-ness
  is decided against the same cards-facade snapshot the carded filter reads, so a
  session carded milliseconds ago (store has it, ≤5s-stale snapshot does not) is
  still drilled rather than falling between the two views.
- **Uncarded shortlist ids get a live metadata probe.** Probes run lazily in
  small parallel chunks and stop once the session cap is filled, so a long
  shortlist with a small `sessionLimit` never fans out a probe per id. On
  success: a summarizer worker title excludes the id entirely (closing a content
  leak — a worker's prompt/reply is plain text the part-level filters do not
  catch), `before`/`after` bounds apply against the session's `time.updated`
  (previously a young session could satisfy a `before: <90 days ago>` bound),
  and the target carries its real title/directory. A failed scoped probe retries
  once on the unscoped client (workers and cross-project sessions live there);
  only when both fail is the id drilled unverified with selection bounds
  bypassed — and the warning says so. The `title` filter never applies to
  uncarded ids. `excludeSessionID` skips an uncarded id; the current session is
  skipped only on an EXPLICIT `excludeCurrentSession: true` (the implicit
  broad-discovery default does not drop a session the caller named by id).
- **Deep resume honors the same guards.** A `deepCursor` resume that readmits
  uncarded ids via a repeated `sessions: [...]` arg routes them through the
  identical probe/worker-exclusion/bounds path instead of sweeping them
  unguarded.
- **`sessions` is capped at 100 ids** (schema max plus a defensive clamp with a
  warning on the Zod-bypass host path).
- **Coverage semantics:** uncarded shortlist members count toward
  `sessionsEligible` (carded members that pass filters + uncarded ids admitted
  or cap-deferred). The session cap fills carded-first; uncarded ids rank last.
- **New warnings:**
  - `N session id(s) in the shortlist has/have no card visible to this search yet
(not yet indexed, or the index snapshot lags); it was/they were selected for
direct drilling.` — with a suffix `M could not be verified (metadata fetch
failed), so selection time bounds were not applied.` when both probes failed.
  - `N named session id(s) was/were not searched: the session cap was reached.`
    — when the cap truncates uncarded ids.
  - The deep-resume drop warning now suggests repeating `sessions: [...]`
    alongside the cursor, since an untrusted cursor alone readmits only ids the
    card store knows (also documented on the `deepCursor` arg, in the
    `nextCursor` type contract, and in the README).

### Added

- **Bounded shutdown via the optional `dispose` hook.** On hosts that call
  `dispose` (recent opencode versions), the plugin now shuts down in two phases:
  an immediate quiesce (no new distill/summary/hook work starts) followed by a
  bounded drain of in-flight work before SQLite closes. Every wait is
  timeout-capped — a never-settling SDK request is detached, not awaited
  forever — so plugin disposal can never hang the host's shutdown. Detached
  distiller work is fenced by stop/finalize/lease guards and cannot touch the
  closed store; if a foreground tool execution has not settled within the
  bound, the store handle is deliberately left open (the process is exiting
  and the store is derived/rebuildable) rather than risking a use-after-close.
  There is **no new host requirement**: older hosts simply never call
  `dispose` and the plugin behaves exactly as before (no `engines` constraint
  was added).
- **Cold-pass quarantine for malformed legacy sessions.** A session whose
  message payload is structurally malformed (non-array body, unwalkable parts)
  is sidelined for that `timeUpdated` and logged instead of aborting the whole
  pass; it is retried automatically when the session changes and is dropped
  from quarantine on deletion. The quarantine catches only data-shape errors —
  a distiller regression still surfaces as a pass failure. `status()` exposes
  `quarantinedCount`.
- **Transport-vs-absence distinction in the incremental path.** A failed
  session-metadata fetch is now a logged, retryable transport error rather
  than being conflated with "session gone", so a flaky server no longer makes
  the distiller silently skip re-distills.

### Fixed

- **Stale-writer window closed.** Every distiller store write (full/append/
  cold-pass replaces, rollups, deletes, the cold-pass progress cursor) now
  re-verifies authoritative lease ownership against the live lease row
  immediately before the write, so a
  process suspended past the lease TTL cannot clobber the new holder's rows
  when its paused fetch resumes. The self-check demotes only when another
  holder's name is on the row — an expired-looking own heartbeat is not a
  loss, so a long event-loop hiccup no longer costs a lease-retry stall.
- **Summarizer worker handoff safety.** Worker sessions are title-stamped with
  their owner instance; normal cleanup only ever targets workers this instance
  created, and orphan sweeps (other holders' leftovers) stay lease-gated.
  Deleting/aborting a worker this instance owns is deliberately NOT
  lease-gated — losing the writer lease mid-batch no longer leaks the worker
  session. Worker ids are released from the owned set once cleanup completes.
- **No tool-contract change:** `fetchMessagePage` stays lenient on the query
  path — a successful response without an array body is still an empty page
  (`ok: true`) for `recall_messages`/`recall_context`/`recall_get`/drill.
  Only the distiller opts into strict mode (where a non-array body must be
  distinguishable from an empty session for quarantine).

## 2.1.0

### Added

- **`recall_sessions` gains a `parentID` arg** for subagent recovery: a live,
  index-free listing of a parent session's direct children, with
  `parentID: "current"` as sugar for the calling session. Built for the
  "Task cancelled with no task_id" workflow — cancelled or in-flight subagents
  are listed even before the search index has seen them. The children response
  uses `scope: "children"` (a widening of the output `scope` field's value set,
  which previously only held `"project"`/`"global"`; discriminate on it — a
  malformed non-string `parentID` degrades to an ordinary listing) plus a
  `parentID` echo and a `childCount` (post-filter, pre-slice; greater than
  `returned` means `limit` truncated). Rows not yet distilled to content carry
  `distilled: false`.
- **Staleness fallback in `recall_sessions`:** a `since`-filtered listing that
  selects zero sessions while `since` is newer than the newest in-scope indexed
  session now falls back to the live session list for that window (with a
  disclosing `note`) instead of returning an empty card-index answer. Cost, on
  the record: a `since`-filtered call on a quiet window now performs one live
  `session.list` round-trip where it was previously fetch-free; all other
  time-filtered calls stay card-only.
- **Subagent-recovery hint in the system nudge:** the `nudge` line now also
  tells the agent to list a cancelled or interrupted subagent's child sessions
  with `recall_sessions({ parentID: "current" })` when a Task returned no
  `task_id` — the moment that hint is needed, the Task error payload carries
  nothing and tool descriptions are easy to skim past, but the system prompt is
  always in view. Adds ~45 tokens to the nudge (~130 total per request).
- **Staleness suggestion in `recall`:** a zero-eligible search whose lower time
  bound is newer than the index's recency now leads with a suggestion that the
  index has not caught up (pointing at `recall_sessions` and the
  `parentID: "current"` recovery call), instead of the misleading generic
  broaden-your-query hints, which are suppressed in that state.

## 2.0.0

This is the architecture rewrite. Through 0.12.x, `recall` answered a query by
fetching session history over the SDK into process memory and scanning it there.
That search was complete, but its cost scaled with the size of your history: on a
real store (about 4,700 sessions, 2.76GB of parts) a broad "how did we do X
before" query climbed into multiple gigabytes of memory and ran for minutes, and
two such queries became live incidents. 2.0 inverts the model. A background
distiller builds a small derived index (per-session cards, a slim full-text index
over the human layer, optional semantic vectors and LLM summaries) in a local
SQLite file; a query ranks cards in milliseconds, checks the index for an exact
identifier, then drills only the top handful of sessions through bounded paginated
fetches. The retrieval contract changed with it, from exhaustive scanning to
bounded precision-first retrieval with honest coverage reporting, so several tool
signatures and the search output shape changed. The store is derived and safe to
delete; opencode's database stays the sole source of truth, reached only through
the SDK.

### Breaking

- **`recall_messages` is cursor-paginated.** The `offset`, `reverse`, and `total`
  fields are gone. Pass `cursor` from a prior page's `nextCursor` to walk further
  back; the response carries `pagination: { limit, returned, hasMore, nextCursor }`.
  Every page is a bounded newest-first fetch, so browsing a huge session no longer
  reads it whole.
- **The `sessions` recall argument is renamed `sessionLimit`.** The numeric cap on
  how many sessions a query drills into is now `sessionLimit` (still bounded by the
  `maxSessions` option). `sessions` is repurposed as an explicit session-id array:
  without `deep`, drill exactly those; with `deep`, the sweep scope.
- **Regular search no longer sweeps tool outputs across all history.** Outputs are
  searched inside the sessions a query drills into; a global output sweep is now an
  explicit, scope-required `deep: true` mode (see Added). Conversation text,
  reasoning, tool-input commands, and titles are still searched across all history.
- **Global- and project-scope searches exclude the current session by default,**
  along with its subagent family. The asking conversation repeats the query terms
  and used to win its own "how did we do this before" search. Pass
  `excludeCurrentSession: false` (or `scope: "session"`) to include it;
  `excludeSessionID` excludes any one session by id.
- **Search output shape.** Coverage gained `cards`, `semantic`, and `deep` blocks
  and a top-level `nextCursor` for deep continuation. The earlier consolidation
  still holds: top-level `scanned` / `loadErrorCount` / `loadErrors` are folded into
  `coverage` (`sessionsSearched`, `loadErrors: { count, samples }`), result-level
  `directoryRelevance` lives only under `why`, and `degradeKind: "budget"` is gone.

### Added

- **Distill-then-search pipeline and derived store.** A background distiller reads
  history once through the SDK and writes a versioned SQLite store
  (`~/.cache/opencode-session-recall/store-v1.db`): one card per session plus a slim
  FTS index over the human layer (conversation, reasoning, tool-input commands,
  titles). The first cold pass walks every session and checkpoints as it goes;
  opencode's idle events drive incremental updates after that. The store uses the
  runtime's built-in SQLite (`bun:sqlite`, `node:sqlite` for tests), so it adds no
  npm dependency, and degrades to in-memory metadata cards when no driver is present.
- **Deep mode.** `deep: true` sweeps every part of a scoped session set, tool
  outputs included, for a needle no card or slim-index row points at. It requires
  scope (a `sessions` list, or a lower time bound plus a project/directory filter); a
  global unscoped deep is rejected. It runs under char and wall-clock budgets and
  returns a `nextCursor` you pass back as `deepCursor` to resume where coverage
  stopped. `coverage.deep` reports sessions covered, partial, and remaining.
- **`project` filter.** `recall`'s new `project` argument scopes to the current
  project (`true`) or to a named project directory (a path), alongside the existing
  `directory` filter.
- **`recall_sessions` enrichment.** When a distilled card exists for a listed
  session, its entry gains a content `digest`, its top `files` and `tools`, and a
  `family` rollup (child count) for root sessions. New `since` / `until` arguments
  filter by last-updated time, resolved from the recency-complete cards when a store
  is present.
- **Opt-in local semantic layer.** `semantic: true` blends cosine similarity from
  local static embeddings into card ranking. Vectors embed a natural-language
  projection of each card (identifiers split into words), persist lazily with a
  representation generation, reserve `semanticSlots` (default 2) drill slots for the
  top pure-semantic cards, and rescue a semantically-surfaced session that yields no
  lexical hit. A substantive-content floor denies a vector to content-free cards so
  they cannot become project-identity attractors. `coverage.semantic` reports
  readiness, model, weight, vector count, contribution, and the `representation` /
  `pluginVersion` diagnostics. Options: `semantic`, `semanticWeight`,
  `semanticModel`, `semanticSlots`.
- **Opt-in LLM card summaries.** A new `summaries` option runs your own cheap model
  over card fields to write a short summary per session, then folds it into the
  lexical card index, the semantic embedding text, the `recall_sessions` digest, and
  the proactive-hook payloads. It spends your tokens and is off by default; configure
  it as `{ enabled, model, agent?, maxPromptsPerPass? }`. Cost is bounded by
  construction: a throwaway worker session per batch, one prompt in flight, a
  content-hash skip, a per-pass prompt budget, a per-prompt timeout, and a
  consecutive-failure latch. Point `agent` at a deny-all opencode agent for an
  enforced tool block.
- **Multi-process safety.** Several opencode processes share one store safely. A
  schema stamp fences out a build that would misread the format (a newer schema makes
  the plugin degrade rather than misread); persisted vectors carry a write generation
  so an older build cannot downgrade a newer one; and a single-writer lease
  (`distill_lease`, 30s TTL, heartbeated) keeps exactly one distiller writing while
  readers reload off revision counters.
- **New options.** `storePath`, `coldPass`, `drillSessions`, `drillPageMessages`,
  `drillCharsPerSession`, `drillCharsPerQuery`, `deepCharsPerQuery`,
  `distillConcurrency`, `distillDelayMs`, `ftsRowsPerSession`, `inventoryTokens`,
  `semanticSlots`, and the `semantic` / `summaries` families above. `cacheMaxChars`
  is retained but repurposed (see Changed).
- **Evidence classes and grouped-result evidence.** Every hit is classified
  (`human-text`, `tool-input`, `tool-output`, `reasoning`, `file-read`, `web-fetch`,
  `skill-definition`, `session-title`) and reported in `why.evidenceClass`. Ranking
  prefers concrete actions over generated reference material, and session-grouped
  results carry `evidenceKinds` and up to two `topEvidence` snippets of other classes.
- **Composition-aware suggestions.** Guidance reacts to what came back: hits
  dominated by the current session or by generated reference material,
  shortlisted-but-unranked sessions, exact code tokens under a ranked search, and
  high-`hitCount` grouped results each get a concrete next call.

### Changed

- **Proactive hooks are card-based.** `autoRecall` and `compactionRecall` query the
  card tier directly and make zero message fetches, so they add no measurable
  latency. `autoRecall` injects the top cited cards on a cue-matching message;
  `compactionRecall` preserves the session's own card (focus, outcome, errors,
  identifiers, files) into the compaction summary.
- **`recall_context` and inline expansion are bounded.** A context window is
  assembled from bounded newest-first pages, never a whole-session load, and reports
  `hasMoreBefore` / `hasMoreAfter` at boundaries. Expansion is budgeted per part
  (6,000 chars each) and keeps the region around a truncated match.
- **`cacheMaxChars` is repurposed** as the drilled-session LRU budget (default 24
  million chars) that keeps repeat and refined queries warm, no longer a full-corpus
  cache.
- **`prewarm` is a no-op.** The card store persists across processes, so there is
  nothing to prewarm. The option is retained so existing configs do not error.

### Removed

- The fetch-and-scan corpus model and its per-query candidate budgets
  (`maxCandidatesTotal`, `maxCandidatesPerSession`, `maxCharsTotal`,
  `maxMessagesPerSession`, `maxPartsPerSession`). Selection is now card ranking plus
  the slim index, and drilling is bounded and paginated.
- `recall_messages` `offset` / `reverse` / `total`, and the numeric `recall`
  `sessions` argument (renamed `sessionLimit`). See Breaking.

## 0.12.1

A bug-fix release. Search worked, but **retrieving and browsing the results was
broken** — so after `recall` found a hit, reading or paginating it could come
back empty. Searching for things you can't then retrieve is no use; this fixes
the retrieval half of the flow.

### Fixed

- **Tool-argument defaults were not applied, breaking the browse/retrieve
  tools.** opencode passes the model's raw argument object to a plugin tool's
  `execute`; it validates against the Zod schema but does not feed back the
  parsed value, so schema `.default()`s are never materialized. When the model
  omitted `role`, `recall_messages` saw `role: undefined`, its role filter
  matched nothing, and a fully-loaded session reported `total: 0` with no
  messages (verified live: 590 messages fetched, 0 after the filter). The same
  missing-default behavior left `recall_context` with `NaN` slice bounds and
  could make `recall_get` throw on an undefined `messageID`. `recall` (search)
  already coerced its own args defensively; the four browse/retrieve tools now
  do too, via shared `coerceEnum` / `coerceBool` / `coerceInt` helpers plus
  required-argument guards. Impact: retrieving or browsing a session —
  including cross-project results that `recall` surfaces — now works regardless
  of which optional args the caller sends.
- **`recall` could surface its own prior output under renamed tool calls.** When
  tool names are namespaced upstream (e.g. `mcp__…__recall`), they slipped past
  the self-exclusion guard, so recall could match earlier recall results; and
  inline `expand` could include a nearby recall call's output. Both are now
  excluded from search and redacted from expansion, matching by suffix so
  namespaced variants are caught. Explicit `recall_get` / `recall_context`
  remain full-fidelity.

Verified end-to-end by driving a fresh opencode session against real history.

## 0.12.0

This release rebuilds how `recall` ranks results and adds the ability for the
agent to reach for its history on its own. No existing tool parameter changed
its meaning, so upgrades are drop-in.

### Highlights

- **Relevance ranking is now BM25 instead of fuzzy string matching.** `smart`
  and `fuzzy` search are powered by an in-memory [MiniSearch](https://github.com/lucaong/minisearch)
  BM25 index built per query. BM25 weights rare, discriminative terms over
  common boilerplate and normalizes for document length, so a short message that
  is actually about your query beats a long log that merely mentions the words.
- **Proactive recall.** Three opt-level features help the agent search history
  when it should, instead of waiting to be told: a default-on system-prompt
  nudge, and two opt-in hooks (`autoRecall`, `compactionRecall`).
- **`regex` match mode** for exact shapes — error codes, stack traces, file
  paths, IDs, URLs.
- **Result diversity** so one noisy session can't flood a result list.
- **Query-shape routing** that suggests `regex` when a query looks like a
  pattern, without ever overriding the caller.

### Expected effectiveness

The ranker change is measured, not asserted. A new relevance eval harness
(`test/eval/`) scores a labeled corpus of eight retrieval cases that exercise
the situations recall is for: rare-term recall, prior-decision recall, vague
"same as before" recall, typo tolerance, exact-phrase preference, cross-project
recall, and old-but-strong vs. recent-but-weak ranking.

| Ranker              | MRR  | recall@5 |
| ------------------- | ---- | -------- |
| Previous (Fuse.js)  | 0.50 | 0.50     |
| BM25 (this release) | 1.00 | 1.00     |

The previous ranker returned **nothing** on four of the eight cases (exact
phrase, cross-project error, old-strong-vs-recent-weak, and long-document
competition). BM25 returns the correct session at rank 1 for all eight. The
eval is wired into `npm run check` as a regression gate, so future ranking
changes must meet or beat these numbers.

Practical effect: queries that name a specific symbol, error string, file, or
decision now rank the right hit at or near the top far more reliably, and broad
queries no longer get drowned out by long, boilerplate-heavy tool output.

### Added

- **BM25 ranking** (`smart`, `fuzzy`) via MiniSearch, replacing Fuse.js.
  Structural boosts (exact phrase, full token coverage, reasoning traces, error
  output, user messages, recency) and penalties (weak single-token fuzzy, poor
  coverage) are layered on the BM25 base score as multipliers. Scores are
  reported 0–1.
- **`match: "regex"`** — bounded regular-expression scan over message and tool
  content. Invalid patterns return a clear error instead of silently matching
  nothing.
- **Result diversity** — in part-grouped results, a single session's share of
  the initial result list is capped so it can't crowd out other sessions;
  held-back hits backfill if room remains.
- **Query routing** — when a literal query looks like a regular expression, the
  response includes a non-overriding suggestion to use `match: "regex"`.
- **Proactive recall options:**
  - `nudge` (default **on**): adds a short system-prompt reminder to search
    history when you reference prior work. Text only — a few tokens per request,
    no latency, no I/O.
  - `autoRecall` (default **off**): when a message clearly references earlier
    work ("last time", "what did we decide", "same as before", "previously"),
    runs a bounded recall and injects the top one to three cited hits into the
    agent's context before it answers. Hard-bounded to 1.5s and a capped session
    scan so it can never stall a turn; stays quiet when it finds nothing.
  - `compactionRecall` (default **off**): before a session is compacted, pulls
    the strongest durable findings from that session and appends them to the
    compaction prompt so the summary preserves them.
- **Relevance eval harness** (`test/eval/`) with a labeled corpus, MRR and
  recall@5 metrics, and a locked baseline that gates `npm run check`.

### Changed

- `smart`/`fuzzy` no longer have a "degraded mode" that silently switched
  ranking algorithms under load. A time budget still applies, but it only flags
  elevated latency (`degradeKind: "time"`) — the ranking itself is unchanged.
- Tokenization is split: a duplicate-preserving tokenizer feeds the BM25 index
  (so term frequency is meaningful), while a deduplicated tokenizer backs
  set-membership checks.
- README reorganized so the value proposition and install come first and the
  agent-facing reference is grouped at the end. CONTRIBUTING's architecture
  section rewritten for the BM25 pipeline, the three execution paths, and the
  invocation hooks.

### Removed

- Fuse.js dependency and the legacy `fuse` / `prefilter` / `rank` modules.
  MiniSearch's built-in fuzzy matching covers typo tolerance.

### Compatibility

- All existing `recall` parameters keep their meaning; `match` gains a new
  `"regex"` value. The `score` field on results is now BM25-derived (still
  0–1). `nudge` is on by default; `autoRecall` and `compactionRecall` are
  opt-in. No configuration changes are required to upgrade.
