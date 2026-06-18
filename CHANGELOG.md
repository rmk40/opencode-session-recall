# Changelog

All notable changes to this project are documented here. This project follows
[Conventional Commits](https://www.conventionalcommits.org/) and
[Semantic Versioning](https://semver.org/).

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
