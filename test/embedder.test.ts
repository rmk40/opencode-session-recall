import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemanticEmbedder, parseSafetensors } from "../src/semantic/embedder.js";

// ── Fixture builders (hand-constructed model artifacts) ──────────────────

/** A tiny WordPiece tokenizer.json with a lowercasing normalizer. */
const TOKENIZER_JSON = JSON.stringify({
  normalizer: { type: "BertNormalizer", lowercase: true },
  model: {
    type: "WordPiece",
    unk_token: "[UNK]",
    continuing_subword_prefix: "##",
    vocab: {
      "[PAD]": 0,
      "[UNK]": 1,
      auth: 2,
      login: 3,
      terminal: 4,
      "##ing": 5,
    },
  },
});

/** Rows for the 6-token, 4-dim embedding matrix (unnormalized on purpose). */
const ROWS: number[][] = [
  [0, 0, 0, 1], // [PAD]
  [0, 0, 1, 0], // [UNK]
  [1, 0, 0, 0], // auth
  [0, 1, 0, 0], // login
  [1, 1, 0, 0], // terminal
  [0, 1, 0, 0], // ##ing
];

function safetensorsF32(rows: number[][]): Buffer {
  const vocab = rows.length;
  const dims = rows[0]!.length;
  const flat = rows.flat();
  const data = Buffer.alloc(flat.length * 4);
  flat.forEach((value, i) => data.writeFloatLE(value, i * 4));
  const header = Buffer.from(
    JSON.stringify({
      embeddings: { dtype: "F32", shape: [vocab, dims], data_offsets: [0, data.length] },
    }),
    "utf8",
  );
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([length, header, data]);
}

function safetensorsF16(halves: number[], shape: [number, number], dtype = "F16"): Buffer {
  const data = Buffer.alloc(halves.length * 2);
  halves.forEach((half, i) => data.writeUInt16LE(half, i * 2));
  const header = Buffer.from(
    JSON.stringify({ embeddings: { dtype, shape, data_offsets: [0, data.length] } }),
    "utf8",
  );
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([length, header, data]);
}

const tmpDirs: string[] = [];
function fixtureModel(writeWeights = true): string {
  const dir = mkdtempSync(join(tmpdir(), "recall-embed-"));
  tmpDirs.push(dir);
  writeFileSync(join(dir, "tokenizer.json"), TOKENIZER_JSON);
  if (writeWeights) writeFileSync(join(dir, "model.safetensors"), safetensorsF32(ROWS));
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const norm = (v: Float32Array): number => Math.sqrt([...v].reduce((s, x) => s + x * x, 0));

// ── parseSafetensors ─────────────────────────────────────────────────────

describe("parseSafetensors", () => {
  it("reads an F32 matrix with the declared shape", () => {
    const parsed = parseSafetensors(new Uint8Array(safetensorsF32(ROWS)));
    expect(parsed.vocabSize).toBe(6);
    expect(parsed.dims).toBe(4);
    expect([...parsed.data.slice(16, 20)]).toEqual([1, 1, 0, 0]); // terminal row (index 4)
  });

  it("decodes F16 half-floats", () => {
    // 0x3C00=1.0, 0x4000=2.0, 0xC000=-2.0, 0x3800=0.5
    const parsed = parseSafetensors(
      new Uint8Array(safetensorsF16([0x3c00, 0x4000, 0xc000, 0x3800], [2, 2])),
    );
    expect([...parsed.data]).toEqual([1, 2, -2, 0.5]);
  });

  it("falls back to the sole 2-D tensor when none is named 'embeddings'", () => {
    const data = Buffer.alloc(16);
    [3, 0, 0, 4].forEach((v, i) => data.writeFloatLE(v, i * 4));
    const header = Buffer.from(
      JSON.stringify({
        __metadata__: { format: "pt" },
        weight: { dtype: "F32", shape: [2, 2], data_offsets: [0, 16] },
      }),
      "utf8",
    );
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(header.length));
    const parsed = parseSafetensors(new Uint8Array(Buffer.concat([length, header, data])));
    expect(parsed.vocabSize).toBe(2);
    expect([...parsed.data]).toEqual([3, 0, 0, 4]);
  });

  it("throws on an unsupported dtype", () => {
    expect(() => parseSafetensors(new Uint8Array(safetensorsF16([0], [1, 1], "BF16")))).toThrow(
      /unsupported dtype/,
    );
  });

  it("throws when the file is shorter than its header-length prefix", () => {
    expect(() => parseSafetensors(new Uint8Array(4))).toThrow(/shorter than its header-length/);
  });

  it("throws when the declared header length exceeds the file", () => {
    const bytes = Buffer.alloc(16);
    bytes.writeBigUInt64LE(BigInt(1_000), 0);
    expect(() => parseSafetensors(new Uint8Array(bytes))).toThrow(/header length exceeds/);
  });

  it("throws when the embeddings tensor is ambiguous (two unnamed 2-D tensors)", () => {
    const data = Buffer.alloc(16);
    const header = Buffer.from(
      JSON.stringify({
        a: { dtype: "F32", shape: [1, 2], data_offsets: [0, 8] },
        b: { dtype: "F32", shape: [1, 2], data_offsets: [8, 16] },
      }),
      "utf8",
    );
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(header.length));
    expect(() => parseSafetensors(new Uint8Array(Buffer.concat([length, header, data])))).toThrow(
      /could not locate/,
    );
  });

  it("throws when tensor data is shorter than the declared shape", () => {
    const data = Buffer.alloc(8); // 2 floats, but shape declares 2×4 = 8 floats
    const header = Buffer.from(
      JSON.stringify({ embeddings: { dtype: "F32", shape: [2, 4], data_offsets: [0, 8] } }),
      "utf8",
    );
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(header.length));
    expect(() => parseSafetensors(new Uint8Array(Buffer.concat([length, header, data])))).toThrow(
      /shorter than its declared shape/,
    );
  });
});

// ── SemanticEmbedder ─────────────────────────────────────────────────────

describe("SemanticEmbedder", () => {
  it("loads a fixture model and reports ready with no network", async () => {
    const embedder = new SemanticEmbedder("fixture/tiny", fixtureModel());
    await embedder.init();
    expect(embedder.ready).toBe(true);
    expect(embedder.initError).toBeUndefined();
  });

  it("embeds a single token to its L2-normalized row", async () => {
    const embedder = new SemanticEmbedder("fixture/tiny", fixtureModel());
    await embedder.init();
    const auth = embedder.embed("auth")!;
    expect([...auth]).toEqual([1, 0, 0, 0]);
    expect(norm(auth)).toBeCloseTo(1, 6);
    // Lowercasing normalizer: "AUTH" tokenizes identically.
    expect([...embedder.embed("AUTH")!]).toEqual([1, 0, 0, 0]);
  });

  it("tokenizes greedily with '##' continuation and mean-pools", async () => {
    const embedder = new SemanticEmbedder("fixture/tiny", fixtureModel());
    await embedder.init();
    // "authing" -> greedy longest match "auth" (row [1,0,0,0]) + "##ing"
    // (row [0,1,0,0]); mean [0.5,0.5,0,0] normalized by sqrt(0.5).
    const v = embedder.embed("authing")!;
    const s = 1 / Math.sqrt(2);
    expect(v[0]).toBeCloseTo(s, 5);
    expect(v[1]).toBeCloseTo(s, 5);
    expect(v[2]).toBeCloseTo(0, 5);
    expect(norm(v)).toBeCloseTo(1, 6);
  });

  it("mean-pools multiple whole tokens then normalizes", async () => {
    const embedder = new SemanticEmbedder("fixture/tiny", fixtureModel());
    await embedder.init();
    // "login terminal" -> rows [0,1,0,0] and [1,1,0,0]; mean [0.5,1,0,0].
    const v = embedder.embed("login terminal")!;
    const denom = Math.sqrt(0.25 + 1);
    expect(v[0]).toBeCloseTo(0.5 / denom, 5);
    expect(v[1]).toBeCloseTo(1 / denom, 5);
  });

  it("maps unknown words to the unk row", async () => {
    const embedder = new SemanticEmbedder("fixture/tiny", fixtureModel());
    await embedder.init();
    expect([...embedder.embed("zzz")!]).toEqual([0, 0, 1, 0]);
  });

  it("returns undefined for text with no tokens", async () => {
    const embedder = new SemanticEmbedder("fixture/tiny", fixtureModel());
    await embedder.init();
    expect(embedder.embed("")).toBeUndefined();
    expect(embedder.embed("   ")).toBeUndefined();
  });

  it("captures init failure without throwing (missing weights file)", async () => {
    const embedder = new SemanticEmbedder("fixture/tiny", fixtureModel(false));
    await expect(embedder.init()).resolves.toBeUndefined();
    expect(embedder.ready).toBe(false);
    expect(embedder.initError).toBeDefined();
    expect(embedder.embed("auth")).toBeUndefined();
  });

  it("rejects a non-WordPiece tokenizer with a clear error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-embed-"));
    tmpDirs.push(dir);
    writeFileSync(
      join(dir, "tokenizer.json"),
      JSON.stringify({ model: { type: "BPE", vocab: {}, merges: [] } }),
    );
    writeFileSync(join(dir, "model.safetensors"), safetensorsF32(ROWS));
    const embedder = new SemanticEmbedder("fixture/tiny", dir);
    await embedder.init();
    expect(embedder.ready).toBe(false);
    expect(embedder.initError).toMatch(/unsupported tokenizer/);
  });

  it("caps embedding input at 2,000 chars", async () => {
    const embedder = new SemanticEmbedder("fixture/tiny", fixtureModel());
    await embedder.init();
    const padded = "auth ".repeat(400); // exactly 2,000 chars
    // Tokens beyond the cap are dropped: 400×"auth" pools to the "auth" row.
    expect(embedder.embed(`${padded}login`)).toEqual(embedder.embed("auth"));
    // Control: the same suffix inside the cap does change the vector.
    expect(embedder.embed("auth login")).not.toEqual(embedder.embed("auth"));
  });

  it("runs init only once (idempotent)", async () => {
    const embedder = new SemanticEmbedder("fixture/tiny", fixtureModel());
    await Promise.all([embedder.init(), embedder.init()]);
    await embedder.init();
    expect(embedder.ready).toBe(true);
  });
});
