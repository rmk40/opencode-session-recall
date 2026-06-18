# Search Mechanism Analysis & Recommendations

Research and planning only. No implementation. This document analyzes the current
search mechanisms in `opencode-session-recall`, identifies what's lacking, and
recommends concrete changes — covering both **search relevance quality** and the
separate, arguably larger, **"the agent never calls recall" invocation problem**.

It incorporates an independent architecture review from the GPT-5 reviewer and a
library survey of npm-only (no external service) search options.

---

## TL;DR

Two distinct problems, ranked by leverage:

1. **Invocation (highest leverage).** The plugin exposes great tools but uses
   **zero event hooks**. The model almost never calls `recall` unless the user
   literally says "remember"/"recall". A mediocre search that fires at the right
   moment beats an excellent search the model never invokes. Fix this first with
   plugin hooks (`chat.message`, `experimental.session.compacting`,
   `experimental.chat.system.transform`).

2. **Relevance engine.** `recall`'s `smart`/`fuzzy` modes are built on \*\*Fuse.js
   - hand-tuned additive boosts**. Fuse.js is a *fuzzy string matcher*, not a
     *corpus relevance ranker*. It has no term-rarity (IDF) weighting, field-length
     normalization is explicitly disabled (`ignoreFieldNorm: true`), and "degraded
     mode" silently changes the ranking model under load. Replace the core ranker
     with a real **BM25 lexical index\*\* (npm-only, in-memory), keep Fuse for fuzzy
     fallback only.

Everything else (incremental cache, optional local semantic layer, regex mode,
result diversity, eval fixtures) builds on those two.

---

## Part 1 — How search works today

### Tool surface (5 tools, all on-demand, no hooks)

| Tool              | Role                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| `recall`          | Content search across messages/tool-output/reasoning (`src/search.ts`) |
| `recall_sessions` | Session metadata/title browse (`src/sessions.ts`)                      |
| `recall_get`      | One full message (`src/get.ts`)                                        |
| `recall_context`  | N messages around a hit (`src/context.ts`)                             |
| `recall_messages` | Chronological browse (`src/messages.ts`)                               |

The plugin entry (`src/opencode-session-recall.ts`) registers only `tool` and an
optional `config` hook that marks the tools as primary. **No `event`,
`chat.message`, `chat.params`, `experimental.chat.system.transform`,
`experimental.chat.messages.transform`, or `experimental.session.compacting`
hooks are used** — even though the installed `@opencode-ai/plugin` API exposes all
of them (verified in `node_modules/@opencode-ai/plugin/dist/index.d.ts`).

### The `recall` pipeline

1. **Discovery** — `session.list` (scoped session/project/global), then load **all**
   messages+parts per candidate session **at query time**. No persistent index;
   every search re-fetches and re-tokenizes from scratch.
2. **`literal` mode** — case-insensitive substring scan (`scan()` in `search.ts`,
   `matches()` in `extract.ts`).
3. **`smart`/`fuzzy` mode** — multi-stage (`smartScan()`):
   - **Candidates** (`candidates.ts`): one per searchable part, bounded by budgets
     (`maxCandidatesTotal: 3000`, `maxCharsTotal: 2MB`, `maxMessagesPerSession: 1000`).
   - **Prefilter** (`prefilter.ts`): crude lexical gate — full-query substring,
     quoted-phrase substring, token substring, or Levenshtein ≤1 for tokens ≥4 chars.
   - **Fuse.js** (`fuse.js`): weighted keys (primaryText 0.65 / secondaryText 0.2 /
     titleText 0.1 / hintText 0.05), `ignoreLocation: true`, `ignoreFieldNorm: true`,
     threshold 0.3 (smart) / 0.5 (fuzzy).
   - **Rank** (`rank.ts`): invert Fuse score → 0..1, then additive boosts/penalties
     (phrase +0.15, all-tokens +0.1, reasoning +0.05, tool-error +0.05, user +0.03,
     recency ≤+0.05, weak-fuzzy −0.1, poor-coverage −0.08), clamp, sort by score then time.
   - **Time-budget degradation**: 2000ms total / 1500ms pre-Fuse. On exceed, **skip
     Fuse** and return prefilter-ranked results ("degraded mode").
4. **Output** — snippets (`snippet.ts`), `coverage`, `warnings`, `suggestions`,
   `nearMisses`, per-result `why`, optional inline `expand`, session grouping,
   directory-relevance buckets with `fallback`.

The response/UX layer here is genuinely strong (forgiving params, coverage metadata,
suggestions). The weakness is concentrated in the **ranking core** and the **absence
of proactive invocation**.

---

## Part 2 — What's lacking

### A. Relevance engine weaknesses (Fuse-as-ranker)

These are the concrete failure modes, confirmed by the GPT-5 review:

1. **No IDF / term rarity.** Rare discriminative terms (`zod`, `ECONNREFUSED`,
   a function name) are not preferred over boilerplate (`error`, `config`, `session`,
   `src`, `result`) that saturates chat history. This is the single biggest quality gap.
2. **Field-length normalization disabled.** `ignoreFieldNorm: true` means a 20,000-char
   tool dump that mentions the terms once can outrank a tight 3-line user message that
   is _about_ those terms.
3. **Weak multi-term ranking.** Prefilter survives on _any_ token match, so broad
   queries admit many weak candidates that heuristics must then rescue.
4. **Additive boosts can swamp base relevance.** Fixed `+0.15`/`+0.1` boosts on an
   uncalibrated Fuse distance let a weak-but-recent reasoning hit jump a strong-but-old
   exact match.
5. **No proximity/phrase ranking.** "permission denied npm install" doesn't prefer
   candidates where those terms cluster.
6. **Degraded mode changes correctness.** The same query yields _qualitatively different_
   rankings depending on corpus size and machine speed. For a memory tool, unstable
   recall is a serious defect.

### B. No persistent/incremental index

Every query re-lists, re-fetches, and re-tokenizes the entire candidate corpus. This
is why time/char budgets exist and why "degraded mode" exists. Consequence: `recall`
is not really "search all history" — it's "search whatever subset fit inside this
invocation's budget." This also makes automatic/proactive recall (Part 3) too expensive
to run safely.

### C. No semantic recall

Purely lexical search can't answer vague deictic queries ("that thing where we fixed
the auth redirect loop") unless the exact words recur. Acknowledged as out of scope
historically, but the maintainer is open to **npm-only, no-service** local approaches.

### D. Missing capabilities

- No **regex mode** (high value for error codes, stack traces, file paths, IDs, URLs).
- No **result diversity** (can return 5 hits from one noisy session).
- No **query-type routing** (error string vs. file path vs. vague memory vs. decision
  recall all go through one pipeline).
- No **relevance evaluation fixtures** — no way to know whether a ranking change helps.

### E. The invocation problem (separate, and biggest)

The model rarely calls `recall` spontaneously. The tool descriptions already contain
extensive "when to call" prose; it isn't working. Models call tools when the **prompt**
demands it, the **system prompt** strongly requires it, or **relevant context is already
present** — not because a long description asks them to. The plugin currently has no
mechanism beyond the tool description.

---

## Part 3 — Recommendations

Ordered by leverage. Each item notes npm deps (all in-process, no external service),
risk, and rough effort.

### R1 — Fix invocation with plugin hooks (do this first)

The product problem is bigger than the ranker problem. Three coordinated hooks:

**R1a. Always-on system-prompt nudge** — `experimental.chat.system.transform`.
Inject one _short_ paragraph (not the tool prose) instructing the model to call
`recall` when the user references prior work, previous sessions, remembered decisions,
or uses vague back-references ("that bug", "same as before", "what did we decide").

- Cost: a handful of tokens per request. Risk: low. Effort: trivial.
- Caveat: necessary but **not sufficient** alone.

**R1b. Gated automatic recall on `chat.message`** — the highest-impact invocation fix.
On each user message, run a **cheap trigger check**; only if it fires, run a bounded
recall and inject the top 1–3 high-confidence hits as a compact, cited synthetic
context block (via `experimental.chat.messages.transform` or by prepending to the
system transform).

- Trigger on deictic/history phrases ("last time", "previously", "remember", "same as
  before", "what did we decide", "that error/bug/fix", "in another session"), on new
  sessions in an existing project, and optionally on detected repeated errors.
- Inject only high-confidence results; mark them "possibly relevant"; include
  session/date so the model can deep-dive with `recall_get`/`recall_context`.
- Risks: noise, latency, token cost, model over-trusting stale context. Mitigations:
  top-1–3 only, confidence threshold, strict token cap, plugin option to disable, and
  **this depends on R3 (incremental cache)** to be cheap enough to run inline.
- Effort: medium. **Gate aggressively** — never run broad recall on every message.

**R1c. Compaction preservation on `experimental.session.compacting`** — strategically
critical. Compaction is the exact moment durable context is destroyed. Before it runs,
recall durable findings (decisions, unresolved tasks, user preferences, root causes)
and inject a _small_, cited "durable memory" block into the compaction context.

- Risks: polluting the summary with stale/irrelevant history. Mitigations: durable
  facts only, prefer current-session facts, cite session IDs, keep the block tiny.
- Effort: medium.

> Recommendation: ship R1a immediately; ship R1b/R1c after R3 lands so auto-recall is
> cheap and complete. Make all proactive behavior individually configurable and
> conservative by default.

### R2 — Replace the core ranker with BM25 (in-memory, npm-only)

Make a fielded **BM25** index the basis for `smart` mode. Demote Fuse.js to **fuzzy
fallback / typo recovery / short-field (title, tool-name) matching / near-misses** only.

**Library:** **MiniSearch** is the recommended primary.

- True BM25/BM25+ (tunable `k`, `b`), **true incremental** add/remove/replace (needed
  for R3), **first-class serialization** (`JSON.stringify` / `loadJSON`, needed for an
  optional cache), edit-distance fuzzy, radix-tree (lean memory), native TypeScript,
  actively maintained, zero deps.
- Limitation: no true phrase/proximity operator (approximate with `combineWith: 'AND'`
  - the existing phrase boost in `rank.ts`).

**Alternative:** **Orama** if we want **one** dependency that also covers the eventual
semantic phase (it has native BM25 **+ vector + hybrid** search and file persistence via
a plugin). Trade-off: heavier, faster-moving API, persistence is a separate package.

**Avoid:** `lunr` (immutable — full rebuild on every new doc, fatal for a growing chat
corpus), `wink-bm25` (consolidation freeze + no fuzzy), `FlexSearch` as the _ranker_
(proprietary contextual scoring, weak ESM/TS, opaque relevance — fine for autocomplete,
not for explainable recall).

**What BM25 buys us:** term-rarity weighting, document-length normalization, stable
multi-term ranking, predictable field boosts, far less need for hand-tuned score
patches, and the elimination of "degraded mode" as a _ranking-model_ switch.

Keep the existing structural signals (recency, role, reasoning/error part type,
directory relevance) as **secondary modifiers** layered on the BM25 base score — not as
the primary ranker.

- Effort: medium–high. Highest single quality win after invocation.

### R3 — In-memory incremental index cache (no external service, no duplicated authoritative storage)

OpenCode's DB stays the source of truth. Maintain an in-process derived index keyed by
session id + `time.updated` (+ message count / last message id; content hash only for
suspicious cases). Per query: list sessions, diff against cache, re-fetch only
changed/missing sessions, remove stale docs, add updated docs, then query the in-memory
BM25 index.

- Document granularity: **one searchable part** (or message-part chunk), carrying
  `sessionID/messageID/partID/role/partType/time/toolName/directory/directoryRelevance`
  so ranking stays fielded and result expansion reuses existing `recall_get`/context logic.
- Eliminates repeated tokenization, removes the need for harsh query-time budgets,
  makes search **complete and stable**, and makes R1b auto-recall affordable.
- **Optional** single local cache file (MiniSearch/Orama serialize cleanly): framed
  strictly as _derived, safe-to-delete, schema-versioned, metadata/hash-invalidated_
  cache — like a TypeScript build cache, not a second database. If "no duplicated
  storage" is interpreted strictly, keep persistence **off by default** and stay
  in-memory only.
- Effort: medium–high. Enables both stable search and cheap proactive recall.

### R4 — Optional local semantic layer (hybrid, opt-in, off by default)

Add semantic recall as an **opt-in hybrid** signal, never the default and never a
replacement (technical recall leans hard on exact names: file paths, symbols, error
strings, commands, packages — lexical must stay primary).

**Embeddings (in-process, no service):**

- **transformers.js** (`@huggingface/transformers`) + **all-MiniLM-L6-v2** quantized
  (`dtype: 'q8'`, ~23MB) — highest quality. Cost: pulls `onnxruntime-node` (native
  addon) + a model download; first-call warmup latency.
- **model2vec / Potion static embeddings** — most aligned with the "no overhead"
  spirit: static per-token vectors + mean-pooling, **no neural runtime**, tiny models,
  ~order-of-magnitude faster on CPU for ~10–15% quality drop. **Caveat (verified):**
  there is no first-class MinishLab npm port; the JS path is **through transformers.js
  loading a Potion model that has ONNX artifacts** (tracked in model2vec issue #75 /
  HF ONNX-weights discussions). If a chosen Potion model lacks ONNX artifacts, the
  lookup+pooling is simple enough to hand-roll over the published embedding matrix with
  **no ONNX dependency at all** — which is the real architectural appeal.
- **fastembed-js** — embedding-only middle option (BGE-small via onnxruntime-node);
  smaller API than transformers.js but less active.

**Vector index:** at our scale (thousands of vectors), **skip ANN entirely** — store
`Float32Array` embeddings and do brute-force cosine + top-K (sub-ms to low-ms,
dependency-free, trivially cacheable). Reach for `hnswlib-wasm` (portable, no native
compile) only past ~50–100K vectors. Avoid `hnswlib-node` (native addon, platform
friction) unless we control deployment.

**Hybrid merge:** lexical (BM25) score + semantic score + recency/role/directory
boosts. Disable by default; enable per opt-in; avoid default model downloads.

- Effort: high. Defer until R1–R3 are stable.

### R5 — Smaller, independently valuable additions

- **Regex mode** — bounded scan over cached text (bypasses BM25). High value for error
  codes, stack traces, paths, IDs, URLs, commands. Low–medium effort.
- **Result diversity** — cap N hits per session initially, prefer distinct sessions,
  prefer user/assistant content over repeated tool dumps, surface one representative.
  Low effort, noticeable UX win.
- **Query-type routing** — classify the query (exact/error string → literal/regex;
  keyword → BM25; typo → fuzzy; vague memory → semantic if enabled; "that session
  where…" → title search) and route. Medium effort; composes the above.
- **Evaluation fixtures** — a small relevance test set (exact-error recall, prior-decision
  recall, "same as before", file-path recall, tool-failure recall, cross-session recall,
  broad-noisy query, old-strong vs. recent-weak). Track MRR / recall@5 / latency /
  degraded-mode frequency. Without this we can't prove any ranking change is an
  improvement. Low–medium effort; do it **before** R2 so BM25 is measured, not assumed.

---

## Part 4 — Proposed roadmap

**Phase 0 — Measurement.** Build R5 eval fixtures. Baseline current Fuse-based ranking.

**Phase 1 — Invocation (product usefulness).** R1a system nudge now. Scaffold R1b/R1c
behind config flags (wire fully after Phase 3).

**Phase 2 — Search quality.** R2 BM25 via MiniSearch (Fuse → fuzzy fallback). Re-measure
against Phase 0 fixtures. Add R5 diversity + regex.

**Phase 3 — Performance/completeness.** R3 incremental in-memory cache; optional
serialized cache file (off by default). Remove ranking-altering "degraded mode". Turn on
R1b/R1c now that auto-recall is cheap.

**Phase 4 — Optional semantic.** R4 opt-in hybrid (static embeddings first; brute-force
cosine), off by default.

---

## Part 5 — Dependency summary (all in-process, no external service)

| Need                          | Recommended                                                          | Notes                                                   |
| ----------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| Lexical ranker                | **minisearch**                                                       | BM25+, incremental, serializable, TS, zero-dep          |
| (alt: one-lib lexical+vector) | orama (+ persistence plugin)                                         | heavier, hybrid built-in                                |
| Fuzzy fallback                | **fuse.js** (keep)                                                   | demoted from ranker to fuzzy/short-field                |
| Edit distance                 | **fastest-levenshtein** (keep)                                       | already used in prefilter/rank                          |
| Semantic (opt-in)             | transformers.js + MiniLM-q8, or model2vec/Potion via transformers.js | onnxruntime-node footprint; Potion needs ONNX artifacts |
| Vector index                  | none (brute-force `Float32Array` cosine)                             | ANN unnecessary at our scale                            |

No new database. No embedding server. No background service. The only persistence
introduced is an **optional, derived, safe-to-delete** cache file (off by default).

---

## Out of scope / explicitly avoided

- External vector DB or any networked service.
- A second authoritative store (OpenCode's DB remains source of truth).
- Default model downloads or heavy startup cost (semantic stays opt-in).
- LLM answer synthesis / generated summaries as part of search.
- Automatic memory _writes_ from this plugin (memory stays curated, separate).

## Open questions for the maintainer

1. Is an **optional on-disk derived cache file** acceptable under "no duplicated
   storage", or must caching stay strictly in-memory?
2. For proactive recall (R1b/R1c): acceptable default posture — **off** (opt-in),
   **conservative-on** (tight triggers only), or **on**?
3. Semantic layer: pursue **static embeddings (Potion, lightest)** first, or
   **MiniLM (higher quality, heavier)**? Or defer R4 entirely until R1–R3 prove out?
4. Adopt **MiniSearch** (lean, lexical-only; add semantic separately later) or **Orama**
   (one heavier dep that also covers the eventual semantic phase)?
