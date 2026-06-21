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
`undefined`, not the default. This caused a shipped bug where `recall_messages`
got `role: undefined`, the filter `if (role !== "all")` ran, matched zero
messages, and returned `total: 0` on a fully-loaded session.

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

## How the plugin is loaded (why a rebuild is needed to test live)

- The global opencode config (`~/.config/opencode/opencode.json`) loads this
  plugin **by directory path**, and opencode resolves it via `package.json`
  `main` → `dist/opencode-session-recall.js`. **Source changes do nothing until
  you rebuild `dist/`** (`npm run compile`, or `npx tsup ... --format esm` for a
  quick JS-only rebuild during debugging).
- A **running** opencode process has already loaded the old `dist/`. After
  rebuilding you must **restart the session** (or relaunch) for it to pick up
  changes. Live testing loop: edit → rebuild dist → restart the tuistory session
  → reproduce.
- `files: ["dist"]` in `package.json` means only `dist/` is published to npm;
  CHANGELOG, AGENTS.md, src, etc. never ship.

## Live end-to-end testing with tuistory (when unit tests can't reach it)

Bugs that only manifest through the real opencode host (like the
defaults-not-applied bug) are invisible to vitest. Drive a real session:

1. Make a throwaway workspace: `mktemp -d`, optionally `git init`.
2. Launch: `npx -y tuistory launch "opencode" -s <name> --cols 160 --rows 50 --cwd <tmp> --background`.
   (Run via `npx -y tuistory` — reliable regardless of PATH.)
3. `wait` for the prompt: `npx -y tuistory -s <name> wait "/Ask anything|Build ·/i" --timeout 35000`.
4. `type` a prompt that **explicitly tells the agent which recall tool + args to
   call** (you're testing the tool, not invocation heuristics), then `press enter`.
5. Read results with `read --all` (cumulative, ANSI-stripped) — more reliable
   than `snapshot` mid-render. The TUI's narrow panes wrap JSON, so ask the agent
   to **report specific fields concisely** rather than parsing raw JSON from the
   buffer.
6. Always `close` the session and remove the tmp dir when done. Never
   `daemon-stop` (kills others' sessions).

Cross-project trick: to prove recall finds _this_ project's history from a fresh
session in a tmp dir, search `scope:"global"` for distinctive strings you know
are in the DB. That exercises the cross-project path, which is exactly where the
scoped-vs-unscoped and defaults bugs hide.

## Debugging a "data is there but result is empty" bug

When the SDK clearly has the data but a tool returns nothing, **instrument and
reproduce live** rather than theorize:

- Temporarily `appendFileSync` a JSON line to `/tmp/...` capturing the raw arg
  values and array lengths at each stage (fetched → filtered → sliced). Use a
  dynamic `import("node:fs")` inside the tool so it bundles. Rebuild, restart the
  session, reproduce, then `cat` the file.
- This is how the defaults bug was nailed: the debug showed `dataLen: 590,
filteredLen: 0` with `role` absent — proving the SDK returned 590 messages and
  the filter (not the fetch) dropped them.
- Remove the instrumentation with `git checkout <file>` before committing.

Don't over-trust a session transcript (`.md` export): it can elide/reformat JSON
fields (e.g. a missing `offset`), which sent an earlier investigation down a
wrong path. The live tool output is ground truth; the transcript is not.

## Relevance is gated — don't change ranking blind

`test/eval/` is a labeled relevance harness (corpus + cases + `baseline.json`
locked at MRR/recall@5 = 1.0) wired into `npm run check`. **Any ranking change
must meet or beat the baseline**, or the build fails. If you intend to move the
baseline, do it deliberately in the same change-set and say why. Before tuning
`bm25.ts` constants, run the eval to see the current numbers.

## Tokenizer split is load-bearing

`src/normalize.ts` has two tokenizers and they are not interchangeable:

- `tokenizeAll()` — **duplicate-preserving**, used to feed the BM25 index so term
  frequency is meaningful.
- `tokenize()` — **deduplicated**, used for set-membership / matched-term checks.

Using the deduped one for the index silently degrades BM25 ranking (a real
regression caught in review). Pick the right one for the job.

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
