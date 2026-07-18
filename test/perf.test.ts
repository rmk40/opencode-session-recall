import { describe, expect, it } from "vitest";
import type { OpencodeClient, GlobalSession, Session } from "@opencode-ai/sdk/v2";
import type { ToolContext } from "@opencode-ai/plugin";
import { search } from "../src/search.js";
import { CorpusCache } from "../src/corpus.js";
import { DEFAULTS, type Limits } from "../src/types.js";
import {
  PROJECT_DIR,
  assistantMessage,
  bundle,
  globalSessionFrom,
  session,
  textPart,
  userMessage,
} from "./helpers.js";

/**
 * Perf regression harness (gated behind RECALL_PERF=1; machine-dependent timing
 * is not CI-stable). Builds a ~60k-part synthetic corpus at the incident
 * benchmark's 1/6 real scale and asserts a WARM smart query completes end to
 * end in low single-digit seconds with index reuse making a repeat no slower.
 *
 * Run: RECALL_PERF=1 npx vitest run test/perf.test.ts
 *
 * The incident benchmark recorded 40.6s / 936MB for one smart query at this
 * scale, dominated by the per-query MiniSearch rebuild (30s) that the
 * persistent index removes. The measured numbers print below.
 */

const ENABLED = process.env.RECALL_PERF === "1";

const SESSION_COUNT = 600;
const PARTS_PER_SESSION = 100;
const MESSAGES_PER_SESSION = 50; // 2 parts per message
/** Every Nth part is a ~20k-char dump, the realistic large-output mix. */
const LARGE_PART_EVERY = 20;
const LARGE_PART_CHARS = 20_000;
/** The warm query end-to-end budget (ms). */
const WARM_QUERY_BUDGET_MS = 3_000;
/** Cache budget large enough to hold the whole benchmark corpus resident (the
 *  ~20k-char dump mix pushes retained chars well past the 50M default), so the
 *  warm query measures index reuse rather than constant re-fetch/re-build. */
const BENCH_CACHE_MAX_CHARS = 500_000_000;

const FILLER_TOKENS = [
  "handler",
  "request",
  "response",
  "payload",
  "buffer",
  "context",
  "session",
  "runtime",
  "adapter",
  "resolver",
  "pipeline",
  "boundary",
  "descriptor",
  "iterator",
  "namespace",
  "traversal",
];

function fillerText(seed: number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    out.push(FILLER_TOKENS[(seed + i) % FILLER_TOKENS.length]!);
  }
  return out.join(" ");
}

/** Build a ~60k-part corpus. A minority of parts carry the query anchor
 *  ("zephyrite calibration") and a minority are 20k-char dumps. */
function buildBenchmarkCorpus(): {
  sessions: Session[];
  globalSessions: GlobalSession[];
  messagesBySession: Record<string, Array<{ info: unknown; parts: unknown[] }>>;
} {
  const sessions: Session[] = [];
  const messagesBySession: Record<string, Array<{ info: unknown; parts: unknown[] }>> = {};
  const now = Date.now();

  for (let s = 0; s < SESSION_COUNT; s++) {
    const id = `s-${s}`;
    const anchored = s % 7 === 0; // ~14% of sessions mention the anchor
    const sess = session(id, `Benchmark session ${s}`, PROJECT_DIR, now - s * 1000);
    sessions.push(sess);

    const messages: Array<{ info: unknown; parts: unknown[] }> = [];
    let partIndex = 0;
    for (let m = 0; m < MESSAGES_PER_SESSION; m++) {
      const messageID = `m-${s}-${m}`;
      const info =
        m % 2 === 0
          ? userMessage(messageID, id, now - s * 1000 - m)
          : assistantMessage(messageID, id, now - s * 1000 - m);
      const parts = [];
      for (let p = 0; p < PARTS_PER_SESSION / MESSAGES_PER_SESSION; p++) {
        const globalPart = partIndex++;
        const partID = `p-${s}-${m}-${p}`;
        let text: string;
        if (globalPart % LARGE_PART_EVERY === 0) {
          text = fillerText(globalPart, LARGE_PART_CHARS / 8); // ~20k chars
        } else if (anchored && globalPart % 11 === 0) {
          text = `decided on zephyrite calibration for ${fillerText(globalPart, 12)}`;
        } else {
          text = fillerText(globalPart, 25);
        }
        parts.push(textPart(partID, id, messageID, text));
      }
      messages.push(bundle(info as never, parts as never) as never);
    }
    messagesBySession[id] = messages;
  }

  return {
    sessions,
    globalSessions: sessions.map(globalSessionFrom),
    messagesBySession,
  };
}

function benchmarkClients(corpus: ReturnType<typeof buildBenchmarkCorpus>): {
  client: OpencodeClient;
  unscoped: OpencodeClient;
} {
  const client = {
    session: {
      list: async (params?: { limit?: number }) => ({
        data: corpus.sessions.slice(0, params?.limit ?? 100),
      }),
      get: async ({ sessionID }: { sessionID: string }) => {
        const found = corpus.globalSessions.find((s) => s.id === sessionID);
        return found ? { data: found } : { error: { data: { message: "not found" } } };
      },
      messages: async ({ sessionID }: { sessionID: string }) => {
        const data = corpus.messagesBySession[sessionID];
        return data ? { data } : { error: { data: { message: "Unauthorized" } } };
      },
      message: async () => ({ error: { data: { message: "not found" } } }),
    },
  };
  const unscoped = {
    experimental: {
      session: {
        list: async (params?: { limit?: number }) => ({
          data: corpus.globalSessions.slice(0, params?.limit ?? 100),
        }),
      },
    },
  };
  return {
    client: client as unknown as OpencodeClient,
    unscoped: unscoped as unknown as OpencodeClient,
  };
}

function perfContext(): ToolContext {
  return {
    sessionID: "e-external",
    messageID: "perf",
    agent: "build",
    directory: PROJECT_DIR,
    worktree: PROJECT_DIR,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => undefined,
  } as unknown as ToolContext;
}

describe.skipIf(!ENABLED)("perf: warm smart query at 60k parts", () => {
  it("builds once, then answers a warm query in low single-digit seconds", async () => {
    const limits: Limits = {
      ...DEFAULTS,
      maxSessions: SESSION_COUNT,
      cacheMaxChars: BENCH_CACHE_MAX_CHARS,
    };
    const corpus = buildBenchmarkCorpus();
    const { client, unscoped } = benchmarkClients(corpus);
    const cache = new CorpusCache(client, limits);
    const tool = search(client, unscoped, true, limits, cache);

    const run = async (): Promise<number> => {
      const start = performance.now();
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
      const elapsed = performance.now() - start;
      const parsed = JSON.parse(raw) as { ok: boolean; results?: unknown[] };
      expect(parsed.ok).toBe(true);
      expect((parsed.results ?? []).length).toBeGreaterThan(0);
      return elapsed;
    };

    const cold = await run(); // cold: syncs all sessions + builds persistent index
    const stats = cache.stats();
    const warm1 = await run(); // warm: index reused
    const warm2 = await run(); // warm repeat: must not be slower

    const heapMB = process.memoryUsage().heapUsed / (1024 * 1024);
    console.log(
      `[perf] parts=${stats.candidates} sessions=${stats.sessions} ` +
        `chars=${stats.chars}\n` +
        `[perf] cold(build+query)=${cold.toFixed(0)}ms warm1=${warm1.toFixed(0)}ms ` +
        `warm2=${warm2.toFixed(0)}ms heap=${heapMB.toFixed(0)}MB`,
    );

    expect(stats.candidates).toBeGreaterThanOrEqual(SESSION_COUNT * PARTS_PER_SESSION * 0.9);
    expect(warm1).toBeLessThan(WARM_QUERY_BUDGET_MS);
    // Index reuse: a repeat is not materially slower than the first warm query.
    expect(warm2).toBeLessThan(warm1 * 1.5 + 200);
  }, 120_000);
});
