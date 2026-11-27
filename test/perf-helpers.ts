/**
 * Pieces shared by the RECALL_PERF=1 gates in test/perf.test.ts and
 * test/perf-v2.test.ts: an event-loop stall probe, the load average each gate
 * logs beside its numbers, a seeded card corpus with realistic inventories and
 * a deterministic embedder.
 */
import { loadavg } from "node:os";
import { PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import type { CandidateEmbedder } from "../src/corpus.js";
import type { Card } from "../src/store.js";

/** Gaps shorter than this are not kept for {@link stallProbe}'s GC split. */
const GAP_FLOOR_MS = 2;

/** A probe's stalls since its last reset, with V8's garbage-collection pauses
 *  told apart from the code that ran. */
export type Stalls = {
  /** The longest gap between ticks, whatever filled it. */
  maxMs: number;
  /** The longest gap less the GC pauses inside it: the longest slice the
   *  code itself held the loop. */
  maxOutsideGcMs: number;
  /** The longest single GC pause, and all of them together. */
  maxGcMs: number;
  gcMs: number;
  gcCount: number;
};

/**
 * The longest gap between ticks of a 0 ms interval while it runs, and where
 * it was (start and end times). `stalls()` also splits the gaps since the
 * last reset, or those in a `performance.now()` window, by the GC pauses V8
 * reported in them: a major collection of a heap of a few hundred MB pauses
 * the loop for tens of milliseconds, and far longer when the machine's load
 * starves the collector's helper threads. Gaps under 2 ms are not kept, so a
 * window without a longer one reports 0.
 */
export function stallProbe(): {
  reset(): void;
  max(): number;
  worst(): { from: number; to: number };
  stalls(window?: { from: number; to: number }): Promise<Stalls>;
  stop(): void;
} {
  let last = performance.now();
  let resetAt = last;
  let max = 0;
  let worst = { from: 0, to: 0 };
  let gaps: Array<{ from: number; to: number }> = [];
  const gcs: Array<{ from: number; to: number }> = [];
  const record = (entries: readonly PerformanceEntry[]): void => {
    for (const entry of entries) {
      gcs.push({ from: entry.startTime, to: entry.startTime + entry.duration });
    }
  };
  const observer = new PerformanceObserver((list) => record(list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  const timer = setInterval(() => {
    const now = performance.now();
    if (now - last > max) {
      max = now - last;
      worst = { from: last, to: now };
    }
    if (now - last > GAP_FLOOR_MS) gaps.push({ from: last, to: now });
    last = now;
  }, 0);
  return {
    reset() {
      max = 0;
      last = performance.now();
      resetAt = last;
      gaps = [];
      // A pause reported after this reset may be older; `resetAt` drops it.
      gcs.length = 0;
    },
    max: () => max,
    worst: () => worst,
    async stalls(window): Promise<Stalls> {
      // A collection's entry reaches the observer in two steps: a native
      // immediate after the collection buffers it, and an immediate the
      // observer queues then delivers it. Wait out both and one timer turn
      // (which also lets the interval record the last gap), then take what is
      // buffered but not yet delivered.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 0));
      record(observer.takeRecords());
      const from = Math.max(resetAt, window?.from ?? resetAt);
      const to = window?.to ?? Infinity;
      const clip = (span: { from: number; to: number }) => ({
        from: Math.max(span.from, from),
        to: Math.min(span.to, to),
      });
      const inWindow = (span: { from: number; to: number }) => span.to > from && span.from < to;
      const pauses = gcs.filter(inWindow).map(clip);
      const kept = window ? gaps.filter(inWindow).map(clip) : gaps;
      let maxOutsideGcMs = 0;
      for (const gap of kept) {
        let inGc = 0;
        for (const gc of pauses) {
          inGc += Math.max(0, Math.min(gap.to, gc.to) - Math.max(gap.from, gc.from));
        }
        maxOutsideGcMs = Math.max(maxOutsideGcMs, gap.to - gap.from - inGc);
      }
      const durations = pauses.map((gc) => gc.to - gc.from);
      return {
        maxMs: window ? Math.max(0, ...kept.map((gap) => gap.to - gap.from)) : max,
        maxOutsideGcMs,
        maxGcMs: durations.length > 0 ? Math.max(...durations) : 0,
        gcMs: durations.reduce((a, b) => a + b, 0),
        gcCount: durations.length,
      };
    },
    stop: () => {
      clearInterval(timer);
      observer.disconnect();
    },
  };
}

/** The 1, 5 and 15 minute load averages, logged beside a gate's numbers:
 *  wall-clock budgets mean little without them on a shared machine. */
export function loadAverage(): string {
  return loadavg()
    .map((value) => value.toFixed(2))
    .join(" ");
}

/** Deterministic PRNG (mulberry32), so a corpus always comes out the same. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── A card corpus with realistic inventories ─────────────────────────────────

/** Vocabulary size: distinct words the corpus draws from. */
const VOCABULARY = 20_000;
const CONSONANTS = "bcdfghjklmnprstvwz";
const VOWELS = "aeiouy";
/** Word lengths 3 to 12, weighted like English content words (most have 5
 *  to 9 letters). The spread keeps words as far apart in edit distance as
 *  real ones, which the card index's fuzzy and prefix matching depends on. */
const LENGTH_WEIGHTS = [4, 8, 12, 14, 14, 13, 11, 9, 8, 7];

/** Every vocabulary word, distinct and pronounceable, fixed per rank. */
const WORDS: string[] = (() => {
  const total = LENGTH_WEIGHTS.reduce((a, b) => a + b, 0);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let rank = 0; out.length < VOCABULARY; rank++) {
    const rand = mulberry32(rank * 2_654_435_761 + 12_345);
    let pick = rand() * total;
    let length = 3;
    for (const weight of LENGTH_WEIGHTS) {
      if ((pick -= weight) < 0) break;
      length++;
    }
    let w = "";
    let vowel = rand() < 0.3;
    while (w.length < length) {
      const set = vowel ? VOWELS : CONSONANTS;
      w += set[Math.floor(rand() * set.length)];
      // Now and then two consonants in a row, as in "string" or "buffer".
      vowel = vowel ? false : rand() < 0.8;
    }
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
})();

/** The `rank`-th vocabulary word. */
function word(rank: number): string {
  return WORDS[rank]!;
}

/** Zipf-distributed ranks over `size` items with exponent `s`, as words in
 *  session text are: a few very common, a long tail of rare ones. */
function zipf(size: number, s: number): (rand: () => number) => number {
  const cdf = new Float64Array(size);
  let sum = 0;
  for (let r = 0; r < size; r++) {
    sum += 1 / Math.pow(r + 1, s);
    cdf[r] = sum;
  }
  return (rand) => {
    const x = rand() * sum;
    let lo = 0;
    let hi = size - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cdf[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

const TOOLS = ["bash", "read", "edit", "grep", "glob", "write", "task", "webfetch"];

let messageRanks: ((rand: () => number) => number) | undefined;

/**
 * Message text of about `chars` characters, as people and agents write it in
 * a coding session: Zipf-distributed words with code identifiers, snake_case
 * names and file paths among them. Most of its tokens are distinct, so the
 * slim index's normalized text of a row is about as long as its text.
 * Deterministic in `seed`.
 */
export function perfMessageText(seed: number, chars: number): string {
  const rankOf = (messageRanks ??= zipf(VOCABULARY, 1.05));
  const rand = mulberry32(fnv1a(`message:${seed}`));
  const pick = (): string => word(rankOf(rand));
  const camel = (n: number): string =>
    Array.from({ length: n }, (_, k) => {
      const w = pick();
      return k === 0 ? w : w[0]!.toUpperCase() + w.slice(1);
    }).join("");
  let out = "";
  while (out.length < chars) {
    const kind = rand();
    if (kind < 0.25) out += `${camel(2 + Math.floor(rand() * 2))} `;
    else if (kind < 0.33) out += `${pick()}_${pick()} `;
    else if (kind < 0.43) out += `src/${pick()}/${camel(2)}.ts `;
    else out += `${pick()} `;
  }
  return out.slice(0, chars).trim();
}

export type PerfCorpus = {
  /** Session id of card `i`. */
  id(i: number): string;
  /** Card `i` at content `version` (0 is the first). Its family, directory
   *  and creation time depend on `i` alone; a later version has new content
   *  and a later `timeUpdated`, as a re-distill of an active session does. */
  card(i: number, version?: number): Card;
  /** Query `i` of a fixed sequence: two to four vocabulary words of middling
   *  frequency, sometimes two of them joined as a code identifier. */
  query(i: number): string;
};

/**
 * Cards shaped like the distiller's: an inventory of 200 distinct tokens (code
 * identifiers, file paths, plain words and rare id-like tokens) drawn from a
 * Zipf-distributed vocabulary, about 200-character heads, files, tools and
 * some errors. A third of the cards are children of a root card, and the
 * directories span a dozen projects. Deterministic in `seed`.
 */
export function perfCorpus(o: {
  now: number;
  seed?: number;
  inventoryTokens?: number;
}): PerfCorpus {
  const seed = o.seed ?? 1;
  const inventoryTokens = o.inventoryTokens ?? 200;
  const rankOf = zipf(VOCABULARY, 1.05);
  const id = (i: number): string => `ses_perf_${String(i).padStart(6, "0")}`;

  const words = (rand: () => number, n: number): string[] =>
    Array.from({ length: n }, () => word(rankOf(rand)));
  const camel = (parts: string[]): string =>
    parts.map((p, k) => (k === 0 ? p : p[0]!.toUpperCase() + p.slice(1))).join("");
  const text = (rand: () => number, chars: number): string => {
    let out = "";
    while (out.length < chars) out += `${word(rankOf(rand))} `;
    return out.slice(0, chars).trim();
  };
  const hex = (rand: () => number): string =>
    Math.floor(rand() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  const path = (rand: () => number): string =>
    `src/${word(rankOf(rand))}/${camel(words(rand, 2))}.ts`;

  function inventory(rand: () => number): string {
    const tokens = new Set<string>();
    while (tokens.size < inventoryTokens) {
      const pick = rand();
      if (pick < 0.4) tokens.add(camel(words(rand, 2 + Math.floor(rand() * 2))));
      else if (pick < 0.5) tokens.add(words(rand, 2).join("_"));
      else if (pick < 0.6) tokens.add(path(rand));
      else if (pick < 0.92) tokens.add(word(rankOf(rand)));
      else tokens.add(`${word(rankOf(rand))}_${hex(rand)}`);
    }
    return [...tokens].join(" ");
  }

  return {
    id,
    card(i, version = 0): Card {
      const shape = mulberry32(seed * 7919 + i);
      const rootIndex = i % 6 === 1 || i % 6 === 2 ? i - (i % 6) : i;
      const project = (rootIndex * 7) % 12;
      const timeCreated = o.now - 90 * 86_400_000 + Math.floor(shape() * 80 * 86_400_000);
      const rand = mulberry32(fnv1a(`${seed}:${i}:${version}`));
      const title = words(rand, 3 + Math.floor(rand() * 4)).join(" ");
      const errors =
        rand() < 0.2
          ? Array.from(
              { length: 1 + Math.floor(rand() * 2) },
              () => `TypeError: ${camel(words(rand, 2))} is not a function`,
            )
          : [];
      return {
        sessionId: id(i),
        parentId: rootIndex === i ? null : id(rootIndex),
        rootId: id(rootIndex),
        title: title[0]!.toUpperCase() + title.slice(1),
        slug: id(i),
        directory: `/workspace/project-${project}`,
        projectId: `prj-${project}`,
        agent: rootIndex === i ? "build" : "general",
        model: "test-model",
        timeCreated,
        timeUpdated: Math.min(o.now, timeCreated + 3_600_000 + version * 60_000),
        partCount: 40 + Math.floor(rand() * 400),
        retainedChars: 20_000 + Math.floor(rand() * 200_000),
        summaryHead: text(rand, 200),
        outcomeHead: text(rand, 200),
        inventory: inventory(rand),
        files: Array.from({ length: 1 + Math.floor(rand() * 4) }, () => path(rand)),
        tools: TOOLS.filter(() => rand() < 0.5),
        errors,
        familyRollup: [],
        distillState: "full",
        distilledThrough: `msg_${id(i)}_${version}`,
        embedding: null,
        embeddingGen: null,
        nlSummary: "",
        summaryHash: "",
      };
    },
    query(i): string {
      const rand = mulberry32(fnv1a(`${seed}:query:${i}`));
      const n = 2 + Math.floor(rand() * 3);
      const terms = Array.from({ length: n }, () => word(20 + Math.floor(rand() * 1_500)));
      return rand() < 0.25
        ? `${camel(terms.slice(0, 2))} ${terms.slice(2).join(" ")}`.trim()
        : terms.join(" ");
    },
  };
}

// ── A deterministic embedder ─────────────────────────────────────────────────

/**
 * A hashing bag-of-words embedder at a real model's dimension: deterministic,
 * so a reused vector equals a recomputed one, and cheap, so a gate measures
 * the card runtime rather than the model. Counts its calls.
 */
export function hashingEmbedder(dim = 384): CandidateEmbedder & { calls(): number } {
  let calls = 0;
  return {
    ready: true,
    calls: () => calls,
    embed(input: string): Float32Array | undefined {
      calls++;
      const vec = new Float32Array(dim);
      for (const token of input.toLowerCase().split(/[^a-z0-9]+/)) {
        if (token.length >= 4) vec[fnv1a(token) % dim]! += 1;
      }
      let norm = 0;
      for (const x of vec) norm += x * x;
      if (norm === 0) return undefined;
      norm = Math.sqrt(norm);
      for (let k = 0; k < dim; k++) vec[k]! /= norm;
      return vec;
    },
  };
}
