import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Part } from "@opencode-ai/sdk/v2";
import { bm25Search, type Bm25Hit, type Bm25Mode } from "../src/bm25.js";
import {
  buildCandidates,
  buildTitleCandidate,
  MAX_CHARS_PER_CANDIDATE,
  populateNormalized,
  type Candidate,
} from "../src/candidates.js";
import { buildSessionDigest } from "../src/corpus.js";
import { normalize, tokenize } from "../src/normalize.js";
import { parseQuery } from "../src/query.js";
import { mergeShortlistHits, rerankDrilled } from "../src/rerank.js";
import { referenceBm25Search } from "./fixtures/reference-bm25.js";
import { mulberry32 } from "./perf-helpers.js";
import {
  assistantMessage,
  completedToolPart,
  errorToolPart,
  reasoningPart,
  subtaskPart,
  textPart,
  userMessage,
} from "./helpers.js";

// The ranker's BM25+ scores must equal a MiniSearch index built over the
// same pool, and its matched terms and fields the ones found by tokenizing
// every field. The corpus mixes the shapes that decide those: prefix and
// near-miss word families, code-shaped tokens, repeated directories, titles
// and digests, multi-field tool parts, tool outputs past the per-candidate
// cap, and Unicode case and whitespace.

const NOW = 1_790_000_000_000;
const MODES: Bm25Mode[] = ["smart", "fuzzy"];

const WORDS = [
  "deploy",
  "deployment",
  "deployed",
  "deploys",
  "redeploy",
  "depot",
  "wrangler",
  "worker",
  "workers",
  "workflow",
  "cache",
  "cached",
  "caching",
  "cachet",
  "config",
  "configure",
  "configuration",
  "confirm",
  "token",
  "tokens",
  "tokenizer",
  "launch",
  "launcher",
  "lunch",
  "inference",
  "infer",
  "interface",
  "governed",
  "governor",
  "sign",
  "signal",
  "design",
  "desktop",
  "app",
  "apply",
  "application",
  "in",
  "is",
  "it",
  "on",
  "of",
  "a",
  "the",
  "calibration",
  "calibrate",
  "zephyrite",
  "zephyr",
  "ghostauth",
  "sqlite",
  "ranking",
  "rank",
  "error",
  "failed",
  "naïve",
  "straße",
  "ΑΣ",
  "σοφίας",
  "İstanbul",
  "café",
];

type Rand = () => number;

const pick = <T>(rand: Rand, items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;

/** One word-shaped token: plain, or joined as code (camelCase, snake_case,
 *  a path, dotted, SCREAMING_CASE, hyphenated). */
function token(rand: Rand): string {
  const a = pick(rand, WORDS);
  const b = pick(rand, WORDS);
  const shape = rand();
  if (shape < 0.7) return a;
  if (shape < 0.76) return `${a}${b[0]!.toUpperCase()}${b.slice(1)}`;
  if (shape < 0.82) return `${a}_${b}`;
  if (shape < 0.86) return `src/${a}/${b}.ts`;
  if (shape < 0.9) return `${a}.${b}`;
  if (shape < 0.94) return `${a}_${b}`.toUpperCase();
  return `${a}-${b}`;
}

/** Prose of about `words` tokens with mixed separators and punctuation. */
function prose(rand: Rand, words: number): string {
  const separators = [" ", " ", " ", " ", "  ", "\n", "\t", "\u00a0", ", ", ": ", '"'];
  let out = "";
  for (let i = 0; i < words; i++) out += token(rand) + pick(rand, separators);
  return out.trim();
}

function partsFor(rand: Rand, sid: string, mid: string, dir: string, user: boolean): Part[] {
  if (user) {
    return rand() < 0.15
      ? [subtaskPart(`${mid}-s`, sid, mid, prose(rand, 6), prose(rand, 30))]
      : [textPart(`${mid}-t`, sid, mid, prose(rand, 5 + Math.floor(rand() * 40)))];
  }
  const parts: Part[] = [];
  if (rand() < 0.4) parts.push(reasoningPart(`${mid}-r`, sid, mid, prose(rand, 20 + rand() * 60)));
  if (rand() < 0.6) parts.push(textPart(`${mid}-t`, sid, mid, prose(rand, 10 + rand() * 80)));
  const tools = Math.floor(rand() * 3);
  for (let k = 0; k < tools; k++) {
    const tool = pick(rand, ["bash", "read", "edit", "webfetch", "skill", "mcp__docs__search"]);
    const id = `${mid}-k${k}`;
    if (rand() < 0.15) {
      parts.push(errorToolPart(id, sid, mid, tool, { command: prose(rand, 5) }, prose(rand, 12)));
      continue;
    }
    // A few outputs pass the per-candidate cap, so the candidate's raw text
    // is cut and the output field holds tokens the raw text does not.
    const long = rand() < 0.04;
    const output = long
      ? `${prose(rand, 60)} ${"padding ".repeat(Math.ceil(MAX_CHARS_PER_CANDIDATE / 8))} ${prose(rand, 40)}`
      : prose(rand, 5 + rand() * 120);
    const input =
      tool === "read"
        ? { filePath: `${dir}/${token(rand)}.ts` }
        : { command: prose(rand, 3 + rand() * 8), cwd: dir };
    parts.push(completedToolPart(id, sid, mid, tool, input, output, { title: prose(rand, 3) }));
  }
  return parts;
}

/** Each session's candidates as the drill builds them: per message, newest
 *  first, normalized, stamped with the session digest, with the session's
 *  title candidate last. */
function corpus(seed: number, sessions: number, messages: number): Candidate[][] {
  const rand = mulberry32(seed);
  const pools: Candidate[][] = [];
  for (let s = 0; s < sessions; s++) {
    const sid = `ses-${seed}-${s}`;
    const dir = `/work/${pick(rand, WORDS)}-${s % 3}`;
    const meta = { id: sid, title: prose(rand, 4), directory: dir, parentID: null };
    const built: Candidate[] = [];
    for (let m = messages - 1; m >= 0; m--) {
      const mid = `${sid}-m${String(m).padStart(3, "0")}`;
      const time = NOW - s * 86_400_000 - (messages - m) * 600_000;
      const user = m % 3 === 0;
      const info = user ? userMessage(mid, sid, time) : assistantMessage(mid, sid, time);
      const { candidates } = buildCandidates(
        [{ info, parts: partsFor(rand, sid, mid, dir, user) }],
        meta,
      );
      for (const candidate of candidates) populateNormalized(candidate);
      built.push(...candidates);
    }
    const digest = buildSessionDigest(built);
    const digestText = digest ? normalize(digest) : "";
    const pool: Candidate[] = built.map((candidate) => ({ ...candidate, digestText }));
    const newest = pool[0];
    const title =
      newest &&
      buildTitleCandidate(meta, {
        id: newest.messageID,
        role: newest.role,
        time: { created: newest.time },
      });
    if (title) {
      populateNormalized(title);
      title.digestText = digestText;
      pool.push(title);
    }
    pools.push(pool);
  }
  return pools;
}

/** Queries over the corpus vocabulary: fixed shapes (prose, short words,
 *  prefixes, typos, phrases, code tokens, duplicates) and seeded ones. */
function queries(seed: number, count: number): string[] {
  const fixed = [
    "deploy",
    "deplyo wrangler",
    "deploym",
    "desktop app launcher sign in governed inference",
    '"wrangler deploy" cache',
    "ghostAuth zephyrite_calibration",
    "src/cache/tokenizer.ts",
    "in",
    "app is",
    "ΑΣ straße",
    "σοφιας naive cafe",
    "İstanbul",
    "cache cache configuration",
    "CONFIG_TOKEN rankings",
    "workflw caching confgure",
    "zzzz",
    '""',
  ];
  const rand = mulberry32(seed);
  const seeded: string[] = [];
  for (let i = 0; i < count; i++) {
    const words: string[] = [];
    const n = 1 + Math.floor(rand() * 4);
    for (let w = 0; w < n; w++) {
      let word = token(rand);
      const edit = rand();
      if (edit < 0.2 && word.length > 4) {
        const at = 1 + Math.floor(rand() * (word.length - 2));
        word = word.slice(0, at) + "x" + word.slice(at + 1);
      } else if (edit < 0.35 && word.length > 5) {
        word = word.slice(0, word.length - 2);
      }
      words.push(word);
    }
    seeded.push(words.join(" "));
  }
  return [...fixed, ...seeded];
}

type Projection = {
  partID: string;
  matchedTerms: string[];
  matchedFields: string[];
  evidenceClass: string;
  matchReasons: string[];
};

const project = (hits: Bm25Hit[]): Projection[] =>
  hits.map((hit) => ({
    partID: hit.candidate.partID,
    matchedTerms: hit.matchedTerms,
    matchedFields: hit.matchedFields,
    evidenceClass: hit.evidenceClass,
    matchReasons: hit.matchReasons,
  }));

/** Hits in the same order with the same metadata and scores within a
 *  relative 1e-12: float sums in another order differ in the last bits. */
function expectSameHits(actual: Bm25Hit[], expected: Bm25Hit[], label: string): void {
  expect(project(actual), label).toEqual(project(expected));
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i]!.score;
    const got = actual[i]!.score;
    expect(Math.abs(got - want) / want, `${label} #${i} score`).toBeLessThan(1e-12);
  }
}

// Each case runs the reference index build over the pool once per query.
describe("BM25 ranking parity with a MiniSearch index over the pool", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scores, orders and explains every hit as the reference does", () => {
    const pool = corpus(7, 5, 24).flat();
    let compared = 0;
    for (const mode of MODES) {
      for (const [i, text] of queries(11, 25).entries()) {
        const query = parseQuery(text);
        const explain = i % 2 === 0;
        const expected = referenceBm25Search(pool, query, mode, explain);
        expectSameHits(bm25Search(pool, query, mode, explain), expected, `${mode} ${text}`);
        compared += expected.length;
      }
    }
    // The corpus and queries are dense enough that most comparisons carry hits.
    expect(compared).toBeGreaterThan(5_000);
  });

  it("merges the broad and deep passes as the reference does for any deep set", () => {
    const sessions = corpus(23, 4, 12);
    const pools = sessions.map((candidates) => ({
      target: { sessionId: candidates[0]!.sessionID },
      candidates,
    }));
    const ids = pools.map((pool) => pool.target.sessionId);
    const deepSets = [new Set(ids), new Set(ids.slice(0, 2)), new Set<string>()];
    for (const mode of MODES) {
      for (const text of queries(29, 8)) {
        const query = parseQuery(text);
        for (const deepSet of deepSets) {
          const broad = pools.flatMap((pool) => pool.candidates);
          const deep = pools
            .filter((pool) => deepSet.has(pool.target.sessionId))
            .flatMap((pool) => pool.candidates);
          const expected = mergeShortlistHits(
            referenceBm25Search(broad, query, mode, true),
            referenceBm25Search(deep, query, mode, true),
            true,
          );
          const label = `${mode} ${text} deep=${deepSet.size}`;
          expectSameHits(rerankDrilled(pools, deepSet, query, mode, true), expected, label);
        }
      }
    }
  });

  it("matches the reference on candidates built outside the candidate builder", () => {
    // Hand-built candidates carry no precomputed primary terms and no
    // completeness flag; some are never normalized, some name fields the raw
    // text does not hold, as card and test candidates do.
    const rand = mulberry32(41);
    const pool: Candidate[] = [];
    for (let i = 0; i < 120; i++) {
      const rawText = prose(rand, 3 + Math.floor(rand() * 30));
      const command = prose(rand, 4);
      const shape = i % 4;
      const candidate: Candidate = {
        sessionID: `hand-${i % 5}`,
        sessionTitle: prose(rand, 3),
        directory: `/hand/${pick(rand, WORDS)}`,
        messageID: `hm-${i}`,
        role: i % 3 === 0 ? "user" : "assistant",
        time: NOW - i * 3_600_000,
        partID: `hp-${i}`,
        partType: shape === 2 ? "tool" : shape === 3 ? "title" : "text",
        isPruned: false,
        rawText,
        fieldTexts:
          shape === 2
            ? [
                { field: "stdout", text: `${rawText} ${prose(rand, 20)}` },
                { field: "command", text: command },
              ]
            : [{ field: shape === 3 ? "title" : "text", text: rawText }],
        tokens: tokenize(rawText),
        ...(shape === 2 && { toolName: pick(rand, ["bash", "read", "webfetch"]) }),
        ...(i % 7 === 0 && { digestText: normalize(prose(rand, 5)) }),
      };
      if (shape !== 1) populateNormalized(candidate);
      pool.push(candidate);
    }
    for (const mode of MODES) {
      for (const text of queries(43, 10)) {
        const query = parseQuery(text);
        const expected = referenceBm25Search(pool, query, mode, true);
        expectSameHits(bm25Search(pool, query, mode, true), expected, `${mode} ${text}`);
      }
    }
  });
});
