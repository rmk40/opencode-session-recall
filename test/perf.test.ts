/**
 * Performance regression gates for the distill-then-search architecture.
 *
 * Gated behind RECALL_PERF=1 — machine-dependent wall-clock timing is not
 * CI-stable, so these never run in the normal suite. Enable them to prove the
 * budgets below still hold after a change (the verbose reporter prints
 * passing gates' numbers):
 *
 *     RECALL_PERF=1 npx vitest run test/perf.test.ts --reporter=verbose
 *
 * Budgets:
 *   - Tier-1 card rank p95 < 50ms over 20 varied queries on ~4,700 cards.
 *   - Single-session distill+replace p50 < 150ms (20 sessions of ~64 parts),
 *     and the suppressed replace of the same sessions p50 < 50ms.
 *   - ftsSearch over ~50k slim-index rows < 100ms.
 *   - A drilled smart query end-to-end (~100-session seeded store) < 1.5s.
 *   - Heap stays under 150MB (generous CI headroom; the 80MB steady
 *     target is validated live, not in vitest).
 *
 * On a 12,000-card store with realistic inventories (perf-helpers.ts):
 *   - A cold index build, with semantic off, on with every vector computed,
 *     and on with the persisted vectors reused: no code slice over 50ms with
 *     GC pauses excluded, each build under 60s, and the heap after the
 *     lexical and the reused build under 600MB.
 *   - 400 changed cards applied through ready({ index: true }): no full load,
 *     no code slice over 50ms with GC pauses excluded, under 3s in total.
 *   - The store read a refresh check makes, on a freshly opened copy, idle and
 *     before an apply: each under 2ms. The 400-card apply that follows it: no
 *     code slice over 35ms, that read included.
 *   - 24 `recall` searches with card writes between them: card tier p50 <
 *     250ms, whole search p50 < 1s, no full load.
 * The slice budgets leave out V8's garbage-collection pauses, logged beside
 * them with the raw stalls: building an index of this size makes major
 * collections that, on a loaded machine, pause the loop past the budget on
 * their own. A pause's length follows the heap the collector has to trace,
 * so the heap ceiling catches the growth that lengthens it even while the
 * slices pass. Every gate logs the load average.
 *
 * Each gate warms up before measuring and uses real timers with honest
 * nearest-rank percentiles. The first five gates take a few seconds; the
 * large-store gates take about a minute more.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { OpencodeClient, Message, Part, Session } from "@opencode-ai/sdk/v2";
import type { ToolContext, ToolDefinition } from "../src/host/opencode-v1-types.js";
import { openSqlite, type SqliteDb } from "../src/sqlite.js";
import { type Card, type PartTextRow, type Store } from "../src/store.js";
import {
  createCardsRuntime,
  storeCardSource,
  type CardSource,
  type CardsRuntime,
} from "../src/cards.js";
import { createFetchGate } from "../src/fetch-gate.js";
import { createDrill } from "../src/drill.js";
import { createV1HistorySource } from "../src/history/v1.js";
import { deriveCard, type DistillSessionMeta } from "../src/distill.js";
import { parseQuery } from "../src/query.js";
import { normalize } from "../src/normalize.js";
import { search } from "../src/search.js";
import { DEFAULTS, type Limits, type SearchOutput } from "../src/types.js";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import {
  hashingEmbedder,
  loadAverage,
  perfCorpus,
  stallProbe,
  type PerfCorpus,
  type Stalls,
} from "./perf-helpers.js";
import {
  PROJECT_DIR,
  assistantMessage,
  bundle,
  completedToolPart,
  globalSessionFrom,
  messagesResponse,
  paginateBundles,
  session,
  textPart,
  toolResultText,
  userMessage,
  openV1Store,
} from "./helpers.js";

const ENABLED = process.env.RECALL_PERF === "1";

const NOW = Date.now();
const LIMITS: Limits = { ...DEFAULTS, maxSessions: 10_000 };

/** A suppressed replace of a ~64-part session. */
const SUPPRESSED_WRITE_BUDGET_MS = 50;
/** Cards in the large store, about as many as a long-used live store holds. */
const BIG_CARDS = 12_000;
/** Longest synchronous slice a card-runtime build or update may take, GC
 *  pauses excluded. */
const SLICE_BUDGET_MS = 50;
/** One store read the card runtime's refresh check makes, on the large store. */
const REFRESH_READ_BUDGET_MS = 2;
/** Longest code slice of a 400-card apply, its refresh check included. */
const APPLY_SLICE_BUDGET_MS = 35;
/** Card-tier time of one `recall` search (median) on the large store. */
const CARD_TIER_P50_BUDGET_MS = 250;
/** Applying 400 changed cards through `ready({ index: true })`. A full
 *  rebuild of the large store's index takes 8 s or more. */
const APPLY_TOTAL_BUDGET_MS = 3_000;
/** A whole search on the large store (median), the budget a long-used live
 *  store's searches are held to. */
const SEARCH_P50_BUDGET_MS = 1_000;
/** One cold build of the large store's index, which runs for seconds by
 *  design; this only catches a build that stops scaling. */
const COLD_BUILD_TOTAL_BUDGET_MS = 60_000;
/** Heap in use after a cold build of the large store's index, test process
 *  and corpus included. Builds measure about 383 to 389 MB; a heap that
 *  doubles fails. */
const COLD_BUILD_HEAP_BUDGET_MB = 600;
const SEMANTIC_MODEL = "perf-model";
/** How often the card runtime checks the store for changes, as in production
 *  (cards.ts). The large-store gates advance a fake clock by it, so a refresh
 *  is due exactly where they measure one. */
const REFRESH_MS = 5_000;

// ── Percentile + timing helpers ──────────────────────────────────────────────

/** Nearest-rank percentile (q in [0,1]) over a sample set. */
function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx]!;
}

/** Time one synchronous call in ms (real timer). */
function timeSync(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

/** Time one async call in ms (real timer). */
async function timeAsync(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

/**
 * Collect garbage before sampling the heap. `--expose-gc` is not guaranteed at
 * launch, so enable a one-shot `gc` handle at runtime via V8 flags (a standard
 * trick) rather than depending on how vitest was invoked. Falls back to
 * `globalThis.gc` and finally to a best-effort no-op.
 */
function forceGc(): void {
  const direct = (globalThis as { gc?: () => void }).gc;
  if (direct) {
    direct();
    return;
  }
  try {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as (() => void) | undefined;
    gc?.();
  } catch {
    // Best effort — heapUsed will read a little higher without a collection.
  } finally {
    v8.setFlagsFromString("--no-expose-gc");
  }
}

// ── Synthetic token pools ────────────────────────────────────────────────────

const TOKENS = [
  "handler",
  "request",
  "payload",
  "adapter",
  "resolver",
  "pipeline",
  "descriptor",
  "namespace",
  "traversal",
  "session",
  "runtime",
  "boundary",
  "iterator",
  "checkout",
  "middleware",
  "migration",
  "cache",
  "cluster",
  "manifest",
  "throttle",
];

function tokenStream(seed: number, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(TOKENS[(seed + i) % TOKENS.length]!);
  return out.join(" ");
}

/** ~200-char head text seeded so a minority of cards carry the anchor. */
function headText(seed: number, anchored: boolean): string {
  const base = `session ${seed} ${tokenStream(seed, 24)}`;
  const text = anchored ? `${base} zephyrite calibration decision` : base;
  return text.slice(0, 200).padEnd(200, " x").slice(0, 200);
}

// ── Tier-1: 4,700 synthetic cards ────────────────────────────────────────────

/** A realistic card: ~200-token inventory, ~200-char heads. A minority carry
 *  the query anchor so ranking has real work rather than an empty result. */
function makeSyntheticCard(i: number): Card {
  const anchored = i % 37 === 0; // ~2.7% of cards mention the anchor
  const inventoryTokens = tokenStream(i, 200);
  const inventory = anchored ? `zephyrite calibration ${inventoryTokens}` : inventoryTokens;
  return {
    sessionId: `card-${i}`,
    parentId: null,
    rootId: `card-${i}`,
    title: `Synthetic session ${i} ${TOKENS[i % TOKENS.length]}`,
    slug: `card-${i}`,
    directory: PROJECT_DIR,
    projectId: "project-main",
    agent: "build",
    model: "test-model",
    timeCreated: NOW - i * 1000 - 1000,
    timeUpdated: NOW - i * 1000,
    partCount: 64,
    retainedChars: 12_000,
    summaryHead: headText(i, anchored),
    outcomeHead: headText(i + 1, false),
    inventory,
    files: [`src/module-${i % 50}.ts`],
    tools: ["bash", "read"],
    errors: [],
    familyRollup: [],
    distillState: "full",
    distilledThrough: `msg-${i}`,
    embedding: null,
    embeddingGen: null,
    nlSummary: "",
    summaryHash: "",
  };
}

const TIER1_QUERIES = [
  "zephyrite calibration",
  "handler pipeline adapter",
  "checkout middleware throttle",
  "migration cache cluster",
  "resolver descriptor namespace",
  "session runtime boundary",
  "manifest traversal iterator",
  "payload request handler",
  "zephyrite decision",
  "cache throttle pipeline",
  "adapter resolver runtime",
  "checkout session boundary",
  "namespace manifest cluster",
  "iterator handler payload",
  "migration descriptor cache",
  "calibration pipeline adapter",
  "throttle middleware request",
  "cluster traversal session",
  "boundary resolver manifest",
  "zephyrite calibration pipeline",
];

// ── E2E: a seeded ~100-session store behind the fake client ───────────────────

type Corpus = {
  sessions: Session[];
  messagesBySession: Record<string, { info: Message; parts: Part[] }[]>;
};

/** ~64 parts per session (32 messages × 2 parts); a minority carry the anchor. */
function buildE2ECorpus(count: number): Corpus {
  const sessions: Session[] = [];
  const messagesBySession: Record<string, { info: Message; parts: Part[] }[]> = {};
  for (let s = 0; s < count; s++) {
    const id = `e2e-${s}`;
    const anchored = s % 11 === 0;
    const sess = session(id, `E2E session ${s}`, PROJECT_DIR, NOW - s * 1000);
    sessions.push(sess);
    const bundles: { info: Message; parts: Part[] }[] = [];
    for (let m = 0; m < 32; m++) {
      const mid = `${id}-m${m}`;
      const info =
        m % 2 === 0
          ? userMessage(mid, id, NOW - s * 1000 - m)
          : assistantMessage(mid, id, NOW - s * 1000 - m);
      const anchorHere = anchored && m === 4;
      bundles.push(
        bundle(info, [
          textPart(
            `${id}-m${m}-p0`,
            id,
            mid,
            anchorHere
              ? `decided on zephyrite calibration ${tokenStream(m, 20)}`
              : tokenStream(s + m, 24),
          ),
          completedToolPart(
            `${id}-m${m}-p1`,
            id,
            mid,
            "bash",
            { command: `run step ${m} ${tokenStream(m, 6)}` },
            tokenStream(m, 40),
            { title: `Step ${m}` },
          ),
        ]),
      );
    }
    messagesBySession[id] = bundles;
  }
  return { sessions, messagesBySession };
}

function buildClient(corpus: Corpus): { client: OpencodeClient; unscoped: OpencodeClient } {
  const globalSessions = corpus.sessions.map(globalSessionFrom);
  const client = {
    session: {
      list: async (p?: { limit?: number }) => ({ data: corpus.sessions.slice(0, p?.limit ?? 100) }),
      get: async ({ sessionID }: { sessionID: string }) => {
        const found = globalSessions.find((s) => s.id === sessionID);
        return found ? { data: found } : { error: { data: { message: "not found" } } };
      },
      messages: async (p: { sessionID: string; limit?: number; before?: string }) => {
        const data = corpus.messagesBySession[p.sessionID];
        if (!data) return { error: { data: { message: "Unauthorized" } } };
        const { items, nextCursor } = paginateBundles(data, p.limit ?? 25, p.before);
        return messagesResponse(items, nextCursor);
      },
      message: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
        const found = corpus.messagesBySession[sessionID]?.find((m) => m.info.id === messageID);
        return found ? { data: found } : { error: { data: { message: "not found" } } };
      },
    },
  };
  const unscoped = {
    experimental: {
      session: {
        list: async (p?: { limit?: number }) => ({
          data: globalSessions.slice(0, p?.limit ?? 100),
        }),
      },
    },
  };
  return {
    client: client as unknown as OpencodeClient,
    unscoped: unscoped as unknown as OpencodeClient,
  };
}

function metaOf(s: Session): DistillSessionMeta {
  return {
    id: s.id,
    parentId: s.parentID ?? null,
    title: s.title ?? "",
    slug: s.slug ?? "",
    directory: s.directory ?? "",
    projectId: s.projectID ?? "",
    agent: null,
    model: null,
    timeCreated: s.time.created,
    timeUpdated: s.time.updated,
  };
}

function perfContext(): ToolContext {
  return {
    sessionID: "perf-external",
    messageID: "perf",
    agent: "build",
    directory: PROJECT_DIR,
    worktree: PROJECT_DIR,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => undefined,
  } as unknown as ToolContext;
}

// ── Large-store helpers ──────────────────────────────────────────────────────

/** {@link storeCardSource}, counting the full loads a runtime makes: each
 *  `getCards` call and each keyset walk that starts at the first card. */
function countingSource(store: Store): { source: CardSource; fullLoads: () => number } {
  const base = storeCardSource(store);
  const reads = base.store!;
  let loads = 0;
  return {
    source: {
      ...base,
      getCards: (opts) => {
        loads++;
        return base.getCards(opts);
      },
      store: {
        ...reads,
        cardsPage: (after, limit, opts) => {
          if (after === undefined) loads++;
          return reads.cardsPage(after, limit, opts);
        },
      },
    },
    fullLoads: () => loads,
  };
}

/** A runtime whose every call is timed: `spent()` is the time spent inside it
 *  since the last `reset()`, the card tier's share of a search, and
 *  `byCall()` the time spent in each method since it was created. */
function timedCards(inner: CardsRuntime): CardsRuntime & {
  spent(): number;
  reset(): void;
  byCall(): Record<string, number>;
} {
  let spent = 0;
  const byCall: Record<string, number> = {};
  const add = (name: string, ms: number): void => {
    spent += ms;
    byCall[name] = (byCall[name] ?? 0) + ms;
  };
  const sync =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      const start = performance.now();
      try {
        return fn(...args);
      } finally {
        add(name, performance.now() - start);
      }
    };
  return {
    async ready(opts) {
      const start = performance.now();
      try {
        await inner.ready(opts);
      } finally {
        add(opts?.index ? "ready(index)" : "ready", performance.now() - start);
      }
    },
    rank: sync("rank", inner.rank),
    list: sync("list", inner.list),
    get: sync("get", inner.get),
    exclusionFamily: sync("exclusionFamily", inner.exclusionFamily),
    familyOf: sync("familyOf", inner.familyOf),
    coverage: sync("coverage", inner.coverage),
    semanticStatus: sync("semanticStatus", inner.semanticStatus),
    invalidate: () => inner.invalidate(),
    dispose: () => inner.dispose(),
    spent: () => spent,
    reset: () => {
      spent = 0;
    },
    byCall: () => ({ ...byCall }),
  };
}

/** A v1 client whose sessions and messages come from the corpus, so a drill of
 *  any shortlisted card finds text like the card's. */
function corpusClient(corpus: PerfCorpus): {
  client: OpencodeClient;
  unscoped: OpencodeClient;
} {
  const indexOf = (id: string): number | undefined => {
    const m = /^ses_perf_(\d+)$/.exec(id);
    return m ? Number(m[1]) : undefined;
  };
  const sessionOf = (i: number): Session => {
    const card = corpus.card(i);
    return {
      ...session(
        card.sessionId,
        card.title,
        card.directory,
        card.timeUpdated,
        undefined,
        card.parentId ?? undefined,
      ),
      projectID: card.projectId,
    };
  };
  const cache = new Map<string, { info: Message; parts: Part[] }[]>();
  const bundlesOf = (id: string): { info: Message; parts: Part[] }[] | undefined => {
    const i = indexOf(id);
    if (i === undefined) return undefined;
    const cached = cache.get(id);
    if (cached) return cached;
    const card = corpus.card(i);
    const inventory = card.inventory.split(" ");
    const bundles: { info: Message; parts: Part[] }[] = [];
    for (let m = 0; m < 12; m++) {
      const mid = `${id}-m${m}`;
      const at = card.timeCreated + m * 1000;
      const slice = inventory.slice(
        (m * 16) % inventory.length,
        ((m * 16) % inventory.length) + 16,
      );
      bundles.push(
        m % 2 === 0
          ? bundle(userMessage(mid, id, at), [
              textPart(`${mid}-p0`, id, mid, `${card.summaryHead} ${slice.join(" ")}`),
            ])
          : bundle(assistantMessage(mid, id, at), [
              textPart(`${mid}-p0`, id, mid, `${card.outcomeHead} ${slice.join(" ")}`),
              completedToolPart(
                `${mid}-p1`,
                id,
                mid,
                "bash",
                { command: `rg ${slice.slice(0, 3).join(" ")} ${card.files[0] ?? ""}` },
                slice.join("\n"),
                { title: `Search ${m}` },
              ),
            ]),
      );
    }
    cache.set(id, bundles);
    return bundles;
  };
  const client = {
    session: {
      list: async (p?: { limit?: number }) => ({
        data: Array.from({ length: Math.min(p?.limit ?? 100, 100) }, (_, i) => sessionOf(i)),
      }),
      get: async ({ sessionID }: { sessionID: string }) => {
        const i = indexOf(sessionID);
        return i === undefined
          ? { error: { data: { message: "not found" } } }
          : { data: globalSessionFrom(sessionOf(i)) };
      },
      messages: async (p: { sessionID: string; limit?: number; before?: string }) => {
        const data = bundlesOf(p.sessionID);
        if (!data) return { error: { data: { message: "not found" } } };
        const { items, nextCursor } = paginateBundles(data, p.limit ?? 25, p.before);
        return messagesResponse(items, nextCursor);
      },
      message: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
        const found = bundlesOf(sessionID)?.find((m) => m.info.id === messageID);
        return found ? { data: found } : { error: { data: { message: "not found" } } };
      },
    },
  };
  const unscoped = {
    experimental: {
      session: {
        list: async (p?: { limit?: number }) => ({
          data: Array.from({ length: Math.min(p?.limit ?? 100, 100) }, (_, i) =>
            globalSessionFrom(sessionOf(i)),
          ),
        }),
      },
    },
  };
  return {
    client: client as unknown as OpencodeClient,
    unscoped: unscoped as unknown as OpencodeClient,
  };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

// ── Gates ─────────────────────────────────────────────────────────────────────

// The budgets are the assertions on what each gate measures. The test timeout
// only has to outlast the setup, which a loaded machine slows many times over.
describe.skipIf(!ENABLED)("perf: distill-then-search gates", { timeout: 120_000 }, () => {
  it("tier-1 card rank p95 < 50ms over 20 queries on ~4,700 cards", () => {
    const cards = Array.from({ length: 4_700 }, (_, i) => makeSyntheticCard(i));
    const runtime = createCardsRuntime({
      source: { getCards: () => cards, revision: () => "1" },
    });

    // Warm up: the first rank() builds the MiniSearch index over all cards.
    for (let w = 0; w < 3; w++) runtime.rank(parseQuery(TIER1_QUERIES[w]!), {});

    const latencies = TIER1_QUERIES.map((q) => {
      const query = parseQuery(q);
      return timeSync(() => {
        runtime.rank(query, {});
      });
    });

    const p95 = percentile(latencies, 0.95);

    console.log(
      `[perf] tier-1 rank: p50=${percentile(latencies, 0.5).toFixed(2)}ms p95=${p95.toFixed(2)}ms (n=${latencies.length})`,
    );
    expect(p95).toBeLessThan(50);
  });

  it("single-session distill+replace p50 < 150ms (20 sessions of ~64 parts)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-store-"));
    const db = await openSqlite(join(dir, "store.db"));
    expect(db).not.toBeNull();
    const store = openV1Store(db!)!;
    try {
      const build = (
        s: number,
      ): { meta: DistillSessionMeta; msgs: { info: Message; parts: Part[] }[] } => {
        const id = `distill-${s}`;
        const sess = session(id, `Distill ${s}`, PROJECT_DIR, NOW - s * 1000);
        const msgs: { info: Message; parts: Part[] }[] = [];
        for (let m = 0; m < 32; m++) {
          const mid = `${id}-m${m}`;
          const info =
            m % 2 === 0
              ? userMessage(mid, id, NOW - s * 1000 - m)
              : assistantMessage(mid, id, NOW - s * 1000 - m);
          msgs.push(
            bundle(info, [
              textPart(`${id}-m${m}-p0`, id, mid, tokenStream(s + m, 24)),
              completedToolPart(
                `${id}-m${m}-p1`,
                id,
                mid,
                "bash",
                { command: `step ${m}` },
                tokenStream(m, 40),
                {
                  title: `Step ${m}`,
                },
              ),
            ]),
          );
        }
        return { meta: metaOf(sess), msgs };
      };

      const parentById = new Map<string, string | null>();
      const caps = {
        ftsRowsPerSession: LIMITS.ftsRowsPerSession,
        inventoryTokens: LIMITS.inventoryTokens,
      };

      // Warm up a couple of sessions (schema/index paths hot).
      for (let w = 0; w < 2; w++) {
        const { meta, msgs } = build(1000 + w);
        const { card, rows } = deriveCard({ session: meta, messages: msgs, parentById, caps });
        store.replaceSessionParts(meta.id, rows, card);
      }

      const latencies: number[] = [];
      for (let s = 0; s < 20; s++) {
        const { meta, msgs } = build(s);
        latencies.push(
          timeSync(() => {
            const { card, rows } = deriveCard({ session: meta, messages: msgs, parentById, caps });
            store.replaceSessionParts(meta.id, rows, card);
          }),
        );
      }

      // The same sessions again: nothing changed, so every write is suppressed
      // (it compares the stored card and rows and writes only the checkpoint).
      const suppressed: number[] = [];
      const distillSuppressed: number[] = [];
      let unchanged = 0;
      for (let s = 0; s < 20; s++) {
        const { meta, msgs } = build(s);
        distillSuppressed.push(
          timeSync(() => {
            const { card, rows } = deriveCard({ session: meta, messages: msgs, parentById, caps });
            const start = performance.now();
            const write = store.replaceSessionParts(meta.id, rows, card);
            suppressed.push(performance.now() - start);
            if (!write.changed) unchanged++;
          }),
        );
      }

      const p50 = percentile(latencies, 0.5);
      const suppressedP50 = percentile(suppressed, 0.5);

      console.log(
        `[perf] distill+replace: p50=${p50.toFixed(2)}ms p95=${percentile(latencies, 0.95).toFixed(2)}ms (n=${latencies.length}); ` +
          `suppressed replace: p50=${suppressedP50.toFixed(2)}ms p95=${percentile(suppressed, 0.95).toFixed(2)}ms; ` +
          `distill+suppressed replace: p50=${percentile(distillSuppressed, 0.5).toFixed(2)}ms p95=${percentile(distillSuppressed, 0.95).toFixed(2)}ms ` +
          `(load ${loadAverage()})`,
      );
      expect(p50).toBeLessThan(150);
      expect(unchanged).toBe(20);
      expect(suppressedP50).toBeLessThan(SUPPRESSED_WRITE_BUDGET_MS);
    } finally {
      db!.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ftsSearch over ~50k slim-index rows < 100ms", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-fts-"));
    const db = await openSqlite(join(dir, "store.db"));
    expect(db).not.toBeNull();
    const store = openV1Store(db!)!;
    try {
      // 50 sessions × 1,000 rows = 50k part_text/FTS rows. A ~1% band carries the
      // rare anchor so the query returns a bounded, realistic hit set.
      const ROWS_PER_SESSION = 1_000;
      const SESSIONS = 50;
      for (let s = 0; s < SESSIONS; s++) {
        const sid = `fts-${s}`;
        const rows: PartTextRow[] = [];
        for (let r = 0; r < ROWS_PER_SESSION; r++) {
          const anchored = r % 100 === 0;
          const raw = anchored ? `zephyranchor ${tokenStream(r, 30)}` : tokenStream(s + r, 30);
          rows.push({
            partId: `${sid}-p${r}`,
            messageId: `${sid}-m${r}`,
            prevMessageId: null,
            nextMessageId: null,
            class: r % 3 === 0 ? "reasoning" : "human-text",
            timeCreated: NOW - r,
            raw,
            norm: normalize(raw),
          });
        }
        const card = makeSyntheticCard(s);
        card.sessionId = sid;
        card.rootId = sid;
        store.replaceSessionParts(sid, rows, card);
      }

      // Warm up the query planner/index.
      for (let w = 0; w < 3; w++)
        store.ftsSearch({ strong: ["zephyranchor"], weak: ["calibration"] });

      const latencies: number[] = [];
      for (let i = 0; i < 20; i++) {
        latencies.push(
          timeSync(() => {
            const hits = store.ftsSearch({ strong: ["zephyranchor"], weak: ["pipeline", "cache"] });
            if (hits.length === 0) throw new Error("ftsSearch returned no hits — anchor missing");
          }),
        );
      }

      const p95 = percentile(latencies, 0.95);

      console.log(
        `[perf] ftsSearch(50k rows): p50=${percentile(latencies, 0.5).toFixed(2)}ms p95=${p95.toFixed(2)}ms (n=${latencies.length})`,
      );
      expect(p95).toBeLessThan(100);
    } finally {
      db!.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drilled smart query end-to-end < 1.5s (~100-session seeded store)", async () => {
    const corpus = buildE2ECorpus(100);
    const { client, unscoped } = buildClient(corpus);
    const dir = mkdtempSync(join(tmpdir(), "perf-e2e-"));
    const db = await openSqlite(join(dir, "store.db"));
    expect(db).not.toBeNull();
    const store = openV1Store(db!)!;
    try {
      const parentById = new Map<string, string | null>(
        corpus.sessions.map((s) => [s.id, s.parentID ?? null]),
      );
      const caps = {
        ftsRowsPerSession: LIMITS.ftsRowsPerSession,
        inventoryTokens: LIMITS.inventoryTokens,
      };
      for (const s of corpus.sessions) {
        const { card, rows } = deriveCard({
          session: metaOf(s),
          messages: corpus.messagesBySession[s.id] ?? [],
          parentById,
          caps,
        });
        store.replaceSessionParts(s.id, rows, card);
      }
      store.setMeta("cards_rev", "1");

      const gate = createFetchGate({ concurrency: LIMITS.concurrency });
      const cards = createCardsRuntime({
        source: { getCards: () => store.allCards(), revision: () => store.getMeta("cards_rev") },
      });
      const source = createV1HistorySource({ scoped: client, unscoped });
      const drill = createDrill({ source, gate, limits: LIMITS });
      const tool: ToolDefinition = search(source, true, LIMITS, {
        gate,
        store,
        cards,
        drill,
      });

      const runQuery = async (): Promise<SearchOutput> => {
        const raw = await tool.execute(
          {
            query: "zephyrite calibration",
            match: "smart",
            group: "session",
            scope: "global",
            results: 10,
          } as Parameters<typeof tool.execute>[0],
          perfContext(),
        );
        return JSON.parse(toolResultText(raw)) as SearchOutput;
      };

      // Warm up (cold LRU/index), then measure a fresh drilled query.
      await runQuery();
      const elapsed = await timeAsync(async () => {
        const out = await runQuery();
        expect(out.ok).toBe(true);
        expect(out.results.length).toBeGreaterThan(0);
      });

      console.log(`[perf] e2e drilled smart query: ${elapsed.toFixed(1)}ms`);
      expect(elapsed).toBeLessThan(1_500);
    } finally {
      db!.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("heap stays under 150MB after the tier-1 + e2e runs", async () => {
    // Rebuild the two heaviest resident structures (4,700-card index + a
    // 100-session store) and hold them while sampling heapUsed.
    const cards = Array.from({ length: 4_700 }, (_, i) => makeSyntheticCard(i));
    const runtime = createCardsRuntime({ source: { getCards: () => cards, revision: () => "1" } });
    runtime.rank(parseQuery("zephyrite calibration"), {});

    const corpus = buildE2ECorpus(100);
    const dir = mkdtempSync(join(tmpdir(), "perf-mem-"));
    const db = await openSqlite(join(dir, "store.db"));
    const store = openV1Store(db!)!;
    try {
      const parentById = new Map<string, string | null>(
        corpus.sessions.map((s) => [s.id, s.parentID ?? null]),
      );
      const caps = {
        ftsRowsPerSession: LIMITS.ftsRowsPerSession,
        inventoryTokens: LIMITS.inventoryTokens,
      };
      for (const s of corpus.sessions) {
        const { card, rows } = deriveCard({
          session: metaOf(s),
          messages: corpus.messagesBySession[s.id] ?? [],
          parentById,
          caps,
        });
        store.replaceSessionParts(s.id, rows, card);
      }

      forceGc();
      const heapMB = process.memoryUsage().heapUsed / (1024 * 1024);
      // Reference the live structures so nothing is collected before the sample.
      expect(cards.length).toBe(4_700);
      expect(store.allCards().length).toBe(100);

      console.log(`[perf] heapUsed after tier-1 + e2e: ${heapMB.toFixed(1)}MB`);
      expect(heapMB).toBeLessThan(150);
    } finally {
      db!.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Runs after the gates above, so their heap sample never includes this store.
describe.skipIf(!ENABLED)(`perf: card runtime on a ${BIG_CARDS}-card store`, () => {
  const corpus = perfCorpus({ now: NOW });
  let templateDir = "";
  let templatePath = "";
  const opened: Array<{ db: SqliteDb; dir: string }> = [];

  // One store file, built once through the stamped write path and copied for
  // each gate, so every gate starts from the same store.
  beforeAll(async () => {
    templateDir = mkdtempSync(join(tmpdir(), "perf-cards-"));
    templatePath = join(templateDir, "store.db");
    const db = await openSqlite(templatePath);
    if (!db) throw new Error("no sqlite");
    const store = openV1Store(db)!;
    const start = performance.now();
    for (let i = 0; i < BIG_CARDS; i++) store.replaceSessionParts(corpus.id(i), [], corpus.card(i));
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    console.log(
      `[perf] built a ${BIG_CARDS}-card store in ${(performance.now() - start).toFixed(0)}ms (load ${loadAverage()})`,
    );
  }, 600_000);

  afterEach(() => {
    for (const { db, dir } of opened.splice(0)) {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    if (templateDir) rmSync(templateDir, { recursive: true, force: true });
  });

  /** A copy of the built store, closed after the gate. */
  async function copyStore(): Promise<Store> {
    const dir = mkdtempSync(join(tmpdir(), "perf-cards-copy-"));
    const path = join(dir, "store.db");
    copyFileSync(templatePath, path);
    const db = await openSqlite(path);
    if (!db) throw new Error("no sqlite");
    opened.push({ db, dir });
    return openV1Store(db)!;
  }

  /**
   * Run `fn` from a collected heap and return its wall time and the stalls
   * during it. A process starts with no other runtime's garbage, whose
   * collection (a 12,000-card index is a few hundred MB) would otherwise land
   * inside the measurement.
   */
  async function measured(fn: () => Promise<void>): Promise<{ totalMs: number } & Stalls> {
    forceGc();
    const probe = stallProbe();
    try {
      probe.reset();
      const start = performance.now();
      await fn();
      const totalMs = performance.now() - start;
      return { totalMs, ...(await probe.stalls()) };
    } finally {
      probe.stop();
    }
  }

  /** Record a measurement's numbers under `prefix`. */
  const record = (
    results: Record<string, number>,
    prefix: string,
    m: { totalMs: number } & Stalls,
  ): void => {
    results[`${prefix}TotalMs`] = m.totalMs;
    results[`${prefix}MaxSliceMs`] = m.maxOutsideGcMs;
    results[`${prefix}MaxStallMs`] = m.maxMs;
    results[`${prefix}MaxGcPauseMs`] = m.maxGcMs;
    results[`${prefix}GcMs`] = m.gcMs;
  };

  const heapMB = (): number => {
    forceGc();
    return process.memoryUsage().heapUsed / (1024 * 1024);
  };

  it(`a cold index build keeps each code slice under ${SLICE_BUDGET_MS} ms excluding GC pauses and its heap under ${COLD_BUILD_HEAP_BUDGET_MB} MB, with semantic off and on`, async () => {
    const store = await copyStore();
    const results: Record<string, number> = {};
    const load = loadAverage();
    // Vector writes are store transactions on the loop: timed apart, so a
    // long slice can be put down to one.
    const writes = { count: 0, maxMs: 0 };
    const semantic = (embedder: ReturnType<typeof hashingEmbedder>): CardsRuntime => {
      const base = storeCardSource(store);
      writes.count = 0;
      writes.maxMs = 0;
      return createCardsRuntime({
        source: {
          ...base,
          writeEmbeddings: (model, gen, rows) => {
            const start = performance.now();
            try {
              return base.writeEmbeddings!(model, gen, rows);
            } finally {
              writes.count++;
              writes.maxMs = Math.max(writes.maxMs, performance.now() - start);
            }
          },
        },
        embedder,
        semanticWeight: 0.4,
        semanticModel: SEMANTIC_MODEL,
      });
    };

    // Semantic off: the card map and the index, built in chunks.
    {
      const runtime = createCardsRuntime({ source: storeCardSource(store) });
      try {
        record(results, "lexical", await measured(() => runtime.ready({ index: true })));
        results.lexicalHeapMB = heapMB();
        results.cards = runtime.coverage().totalCards;
        results.lexicalHits = runtime.rank(parseQuery(corpus.query(0)), {}).length;
      } finally {
        runtime.dispose();
      }
    }

    // Semantic on, first start: every vector is computed and persisted.
    {
      const embedder = hashingEmbedder();
      const runtime = semantic(embedder);
      try {
        record(results, "embed", await measured(() => runtime.ready({ index: true })));
        results.embedWrites = writes.count;
        results.embedWriteMaxMs = writes.maxMs;
        results.embedCalls = embedder.calls();
        results.embedVectors = runtime.semanticStatus()?.cardsWithVectors ?? -1;
      } finally {
        runtime.dispose();
      }
    }

    // Semantic on, a later start: the persisted vectors are reused.
    {
      const embedder = hashingEmbedder();
      const runtime = semantic(embedder);
      try {
        record(results, "reuse", await measured(() => runtime.ready({ index: true })));
        results.reuseWrites = writes.count;
        results.reuseHeapMB = heapMB();
        results.reuseEmbedCalls = embedder.calls();
        results.reuseVectors = runtime.semanticStatus()?.cardsWithVectors ?? -1;
      } finally {
        runtime.dispose();
      }
    }

    console.log(
      `[perf] cold build (${BIG_CARDS} cards, load ${load}):`,
      JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, round1(v)]))),
    );
    console.log(
      `[perf] cold build heap (ceiling ${COLD_BUILD_HEAP_BUDGET_MB}MB): ` +
        `lexical ${round1(results.lexicalHeapMB!)}MB with raw stall ${round1(results.lexicalMaxStallMs!)}ms ` +
        `(GC pause max ${round1(results.lexicalMaxGcPauseMs!)}ms), ` +
        `reuse ${round1(results.reuseHeapMB!)}MB with raw stall ${round1(results.reuseMaxStallMs!)}ms ` +
        `(GC pause max ${round1(results.reuseMaxGcPauseMs!)}ms)`,
    );
    expect(results.cards).toBe(BIG_CARDS);
    expect(results.lexicalHits).toBeGreaterThan(0);
    expect(results.embedVectors).toBeGreaterThan(BIG_CARDS * 0.9);
    expect(results.reuseEmbedCalls).toBe(0);
    expect(results.reuseVectors).toBe(results.embedVectors);
    for (const phase of ["lexical", "embed", "reuse"]) {
      expect(results[`${phase}MaxSliceMs`], phase).toBeLessThan(SLICE_BUDGET_MS);
      expect(results[`${phase}TotalMs`], phase).toBeLessThan(COLD_BUILD_TOTAL_BUDGET_MS);
    }
    expect(results.lexicalHeapMB).toBeLessThan(COLD_BUILD_HEAP_BUDGET_MB);
    expect(results.reuseHeapMB).toBeLessThan(COLD_BUILD_HEAP_BUDGET_MB);
  }, 300_000);

  it(`400 changed cards apply through ready({ index: true }) without a full load or a code slice over ${SLICE_BUDGET_MS} ms excluding GC pauses`, async () => {
    const store = await copyStore();
    const counted = countingSource(store);
    let clock = Date.now();
    const runtime = createCardsRuntime({
      source: counted.source,
      refreshIntervalMs: REFRESH_MS,
      now: () => clock,
    });
    try {
      await runtime.ready({ index: true });
      const loadsBefore = counted.fullLoads();

      // 400 cards spread over the store, each with new content and a marker.
      const changed = Array.from({ length: 400 }, (_, k) => k * 29 + 3);
      const writeStart = performance.now();
      for (const i of changed) {
        const card = corpus.card(i, 1);
        store.replaceSessionParts(card.sessionId, [], {
          ...card,
          inventory: `${card.inventory} applymarker`,
        });
      }
      const writeMs = performance.now() - writeStart;

      // The next refresh check is due.
      clock += REFRESH_MS;
      const load = loadAverage();
      const applied = await measured(() => runtime.ready({ index: true }));
      const fullLoads = counted.fullLoads() - loadsBefore;
      const marked = runtime
        .rank(parseQuery("applymarker"), {})
        .filter((hit) => hit.card.inventory.endsWith(" applymarker")).length;

      console.log(
        `[perf] incremental apply of ${changed.length} cards: total=${applied.totalMs.toFixed(1)}ms ` +
          `maxSlice=${applied.maxOutsideGcMs.toFixed(1)}ms (stall ${applied.maxMs.toFixed(1)}ms, ` +
          `GC pause max ${applied.maxGcMs.toFixed(1)}ms of ${applied.gcMs.toFixed(1)}ms; writes ${writeMs.toFixed(0)}ms, ` +
          `full loads ${fullLoads}, marked hits ${marked}, load ${load})`,
      );
      expect(fullLoads).toBe(0);
      expect(marked).toBe(changed.length);
      expect(applied.maxOutsideGcMs).toBeLessThan(SLICE_BUDGET_MS);
      expect(applied.totalMs).toBeLessThan(APPLY_TOTAL_BUDGET_MS);
    } finally {
      runtime.dispose();
    }
  }, 300_000);

  it(`a refresh check reads the store in under ${REFRESH_READ_BUDGET_MS} ms, and 400 changed cards apply with no code slice over ${APPLY_SLICE_BUDGET_MS} ms including that read`, async () => {
    // A copy opened afresh: none of its card pages are in SQLite's cache yet.
    const store = await copyStore();
    const counted = countingSource(store);
    const reads = counted.source.store!;
    /** How long each refresh-check read of the store took. */
    const checks: number[] = [];
    let clock = Date.now();
    const runtime = createCardsRuntime({
      source: {
        ...counted.source,
        store: {
          ...reads,
          stats: () => {
            const start = performance.now();
            try {
              return reads.stats();
            } finally {
              checks.push(performance.now() - start);
            }
          },
        },
      },
      refreshIntervalMs: REFRESH_MS,
      now: () => clock,
    });
    try {
      const load = loadAverage();
      await runtime.ready({ index: true });
      // The cold load reads the counters before anything else touches the cards.
      const firstRead = checks[0] ?? Number.NaN;

      // Refresh checks that find nothing to apply.
      checks.length = 0;
      for (let i = 0; i < 20; i++) {
        clock += REFRESH_MS;
        await runtime.ready();
      }
      const idle = [...checks];

      const changed = Array.from({ length: 400 }, (_, k) => k * 29 + 3);
      for (const i of changed) {
        const card = corpus.card(i, 1);
        store.replaceSessionParts(card.sessionId, [], {
          ...card,
          inventory: `${card.inventory} applymarker`,
        });
      }
      const loadsBefore = counted.fullLoads();
      checks.length = 0;
      clock += REFRESH_MS;
      const applied = await measured(() => runtime.ready({ index: true }));
      const applyRead = checks[0] ?? Number.NaN;
      const fullLoads = counted.fullLoads() - loadsBefore;
      const marked = runtime
        .rank(parseQuery("applymarker"), {})
        .filter((hit) => hit.card.inventory.endsWith(" applymarker")).length;

      console.log(
        `[perf] refresh check on ${BIG_CARDS} cards: first read ${firstRead.toFixed(2)}ms, ` +
          `idle checks p50=${percentile(idle, 0.5).toFixed(3)}ms max=${Math.max(...idle).toFixed(3)}ms ` +
          `(n=${idle.length}), before the apply ${applyRead.toFixed(3)}ms; apply of ${changed.length} cards: ` +
          `total=${applied.totalMs.toFixed(1)}ms maxSlice=${applied.maxOutsideGcMs.toFixed(1)}ms ` +
          `(stall ${applied.maxMs.toFixed(1)}ms, GC pause max ${applied.maxGcMs.toFixed(1)}ms), ` +
          `full loads ${fullLoads}, marked hits ${marked} (load ${load} before, ${loadAverage()} after)`,
      );
      expect(idle).toHaveLength(20);
      expect(firstRead).toBeLessThan(REFRESH_READ_BUDGET_MS);
      expect(Math.max(...idle)).toBeLessThan(REFRESH_READ_BUDGET_MS);
      expect(applyRead).toBeLessThan(REFRESH_READ_BUDGET_MS);
      expect(fullLoads).toBe(0);
      expect(marked).toBe(changed.length);
      expect(applied.maxOutsideGcMs).toBeLessThan(APPLY_SLICE_BUDGET_MS);
    } finally {
      runtime.dispose();
    }
  }, 300_000);

  it(`recall card tier p50 < ${CARD_TIER_P50_BUDGET_MS}ms over 24 searches with card writes between them`, async () => {
    const store = await copyStore();
    const counted = countingSource(store);
    // The refresh interval passes before every search, so each one applies
    // the writes made before it.
    let clock = Date.now();
    const inner = createCardsRuntime({
      source: counted.source,
      refreshIntervalMs: REFRESH_MS,
      now: () => clock,
    });
    const cards = timedCards(inner);
    const { client, unscoped } = corpusClient(corpus);
    const gate = createFetchGate({ concurrency: LIMITS.concurrency });
    const source = createV1HistorySource({ scoped: client, unscoped });
    const drill = createDrill({ source, gate, limits: LIMITS });
    const tool: ToolDefinition = search(source, true, LIMITS, { gate, store, cards, drill });
    const runQuery = async (query: string): Promise<SearchOutput> => {
      const raw = await tool.execute(
        { query, match: "smart", group: "session", scope: "global", results: 10 } as Parameters<
          typeof tool.execute
        >[0],
        perfContext(),
      );
      return JSON.parse(toolResultText(raw)) as SearchOutput;
    };

    // Warm start: the map and the index are built before the first search.
    await cards.ready({ index: true });
    const loadsBefore = counted.fullLoads();
    forceGc();

    const SEARCHES = 24;
    const WARMUP = 2;
    const versions = new Map<number, number>();
    let nextNew = BIG_CARDS;
    let deleted = 0;
    const cardTier: number[] = [];
    const totals: number[] = [];
    let withResults = 0;
    const load = loadAverage();
    let warm: Record<string, number> = {};
    for (let s = 0; s < WARMUP + SEARCHES; s++) {
      if (s === WARMUP) warm = cards.byCall();
      clock += REFRESH_MS;
      // A handful of writes, as re-distills of active sessions and a new
      // session make them; now and then a deletion.
      for (let w = 0; w < 4; w++) {
        const i = (s * 397 + w * 2_903) % BIG_CARDS;
        const version = (versions.get(i) ?? 0) + 1;
        versions.set(i, version);
        store.replaceSessionParts(corpus.id(i), [], corpus.card(i, version));
      }
      store.replaceSessionParts(corpus.id(nextNew), [], corpus.card(nextNew));
      nextNew++;
      if (s % 6 === 5) {
        store.deleteSession(corpus.id((s * 1_009 + 17) % BIG_CARDS));
        deleted++;
      }

      cards.reset();
      const start = performance.now();
      const out = await runQuery(corpus.query(s));
      const total = performance.now() - start;
      expect(out.ok).toBe(true);
      if (s < WARMUP) continue;
      if (out.results.length > 0) withResults++;
      cardTier.push(cards.spent());
      totals.push(total);
    }
    const fullLoads = counted.fullLoads() - loadsBefore;
    const p50 = percentile(cardTier, 0.5);
    inner.dispose();

    console.log(
      `[perf] recall on ${BIG_CARDS} cards: card tier p50=${p50.toFixed(1)}ms p95=${percentile(cardTier, 0.95).toFixed(1)}ms ` +
        `max=${Math.max(...cardTier).toFixed(1)}ms; whole search p50=${percentile(totals, 0.5).toFixed(1)}ms ` +
        `p95=${percentile(totals, 0.95).toFixed(1)}ms (n=${cardTier.length}, ${withResults} with results, ` +
        `${deleted} deletions, full loads ${fullLoads}, load ${load}); card tier by call, summed over the measured searches: ` +
        JSON.stringify(
          Object.fromEntries(
            Object.entries(cards.byCall()).map(([k, v]) => [k, round1(v - (warm[k] ?? 0))]),
          ),
        ),
    );
    expect(fullLoads).toBe(0);
    expect(withResults).toBeGreaterThan(SEARCHES / 2);
    expect(p50).toBeLessThan(CARD_TIER_P50_BUDGET_MS);
    expect(percentile(totals, 0.5)).toBeLessThan(SEARCH_P50_BUDGET_MS);
  }, 300_000);
});
