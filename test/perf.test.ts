/**
 * Performance regression gates for the distill-then-search architecture.
 *
 * Gated behind RECALL_PERF=1 — machine-dependent wall-clock timing is not
 * CI-stable, so these never run in the normal suite. Enable them to prove the
 * plan's budgets still hold after a change:
 *
 *     RECALL_PERF=1 npx vitest run test/perf.test.ts
 *
 * Budgets (from docs/plans/recall-distill-then-search.md "## Verification"):
 *   - Tier-1 card rank p95 < 50ms over 20 varied queries on ~4,700 cards.
 *   - Single-session distill+replace p50 < 150ms (20 sessions of ~64 parts).
 *   - ftsSearch over ~50k slim-index rows < 100ms.
 *   - A drilled smart query end-to-end (~100-session seeded store) < 1.5s.
 *   - Heap stays under 150MB (generous CI headroom; the plan's 80MB steady
 *     target is validated live, not in vitest).
 *
 * Each gate warms up before measuring and uses real timers with honest
 * nearest-rank percentiles. Total runtime stays well under ~60s when enabled.
 */
import { describe, expect, it } from "vitest";
import type { OpencodeClient, Message, Part, Session } from "@opencode-ai/sdk/v2";
import type { ToolContext, ToolDefinition } from "@opencode-ai/plugin";
import { openSqlite } from "../src/sqlite.js";
import { openStore, type Card, type PartTextRow } from "../src/store.js";
import { createCardsRuntime } from "../src/cards.js";
import { createFetchGate } from "../src/fetch-gate.js";
import { createDrill } from "../src/drill.js";
import { deriveCard, type DistillSessionMeta } from "../src/distill.js";
import { parseQuery } from "../src/query.js";
import { normalize } from "../src/normalize.js";
import { search } from "../src/search.js";
import { DEFAULTS, type Limits, type SearchOutput } from "../src/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
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
  userMessage,
} from "./helpers.js";

const ENABLED = process.env.RECALL_PERF === "1";

const NOW = Date.now();
const LIMITS: Limits = { ...DEFAULTS, maxSessions: 10_000 };

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

// ── Gates ─────────────────────────────────────────────────────────────────────

describe.skipIf(!ENABLED)("perf: distill-then-search gates", () => {
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
    const store = openStore(db!)!;
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

      const p50 = percentile(latencies, 0.5);

      console.log(
        `[perf] distill+replace: p50=${p50.toFixed(2)}ms p95=${percentile(latencies, 0.95).toFixed(2)}ms (n=${latencies.length})`,
      );
      expect(p50).toBeLessThan(150);
    } finally {
      db!.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ftsSearch over ~50k slim-index rows < 100ms", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-fts-"));
    const db = await openSqlite(join(dir, "store.db"));
    expect(db).not.toBeNull();
    const store = openStore(db!)!;
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
    const store = openStore(db!)!;
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
      const drill = createDrill({ client, gate, limits: LIMITS });
      const tool: ToolDefinition = search(client, unscoped, true, LIMITS, {
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
        return JSON.parse(raw) as SearchOutput;
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
    const store = openStore(db!)!;
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
