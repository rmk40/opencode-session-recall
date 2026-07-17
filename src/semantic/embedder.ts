import { errmsg } from "../types.js";

/**
 * Local, opt-in static-embedding inference (model2vec / potion family).
 *
 * A static embedding model is a plain vocab-size × dims matrix of per-token
 * vectors: embedding a text tokenizes it, looks up each token's row, and mean-
 * pools. There is no ONNX runtime, no native addon, and no per-token neural
 * forward pass — just a matrix lookup and an average — which makes it cheap
 * enough to run over every cached candidate.
 *
 * This is the ONLY module allowed to touch Node APIs, and it does so exclusively
 * through dynamic `import()` behind variable specifiers (`src/` has no Node
 * types; see AGENTS.md). Every failure path is swallowed into `initError` so a
 * missing model, offline machine, or unsupported artifact degrades the whole
 * plugin to lexical-only search rather than throwing.
 */

// ── Minimal local typings for the Node builtins we touch ─────────────────
// `src/` has no @types/node, so we declare only the surface we use and cast the
// dynamic-import results to it. Variable specifiers keep tsc from trying (and
// failing) to resolve the built-in module types.
type FsLike = {
  promises: {
    mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    stat(path: string): Promise<{ size: number }>;
  };
};
type PathLike = { join(...parts: string[]): string };
type OsLike = { homedir(): string };

const NODE_FS = "node:fs";
const NODE_PATH = "node:path";
const NODE_OS = "node:os";

async function loadFs(): Promise<FsLike> {
  return (await import(NODE_FS)) as unknown as FsLike;
}
async function loadPath(): Promise<PathLike> {
  return (await import(NODE_PATH)) as unknown as PathLike;
}
async function loadOs(): Promise<OsLike> {
  return (await import(NODE_OS)) as unknown as OsLike;
}

// ── Constants ────────────────────────────────────────────────────────────
const HUGGINGFACE_BASE = "https://huggingface.co";
const TOKENIZER_FILE = "tokenizer.json";
const WEIGHTS_FILE = "model.safetensors";
const ARTIFACT_FILES = [TOKENIZER_FILE, WEIGHTS_FILE] as const;
const CACHE_SUBDIR = ".cache/opencode-session-recall/models";
/** Cap input length before tokenizing: a whole tool dump would waste work and
 *  a static embedding is dominated by its first few hundred tokens anyway. */
const MAX_EMBED_INPUT_CHARS = 2_000;
const DEFAULT_CONTINUING_PREFIX = "##";
const SAFETENSORS_HEADER_LENGTH_BYTES = 8;
const F16_BYTES = 2;
/** Allocation guard for untrusted shapes (~500M floats = 2GB). */
const MAX_TENSOR_ELEMENTS = 500_000_000;
const F32_BYTES = 4;

// ── safetensors parsing ────────────────────────────────────────────────────

type TensorInfo = {
  dtype: string;
  shape: number[];
  data_offsets: [number, number];
};

type EmbeddingMatrix = { data: Float32Array; vocabSize: number; dims: number };

/** IEEE-754 half (F16) → float. Hand-rolled so no runtime dependency is needed. */
function halfToFloat(half: number): number {
  const sign = (half & 0x8000) >> 15;
  const exponent = (half & 0x7c00) >> 10;
  const fraction = half & 0x03ff;
  let value: number;
  if (exponent === 0) {
    // Subnormal (or zero).
    value = fraction * 2 ** -24;
  } else if (exponent === 0x1f) {
    value = fraction === 0 ? Infinity : NaN;
  } else {
    value = (1 + fraction / 1024) * 2 ** (exponent - 15);
  }
  return sign === 1 ? -value : value;
}

/**
 * Parse a safetensors buffer and return the embeddings matrix.
 *
 * Layout: 8-byte little-endian u64 header length N, then N bytes of JSON
 * mapping tensor name → { dtype, shape, data_offsets:[start,end] }, then the
 * raw little-endian tensor bytes. `data_offsets` are relative to the start of
 * that tensor-data section. The embeddings tensor is the one named
 * "embeddings", or the sole 2-D tensor when no such name exists.
 */
export function parseSafetensors(bytes: Uint8Array): EmbeddingMatrix {
  if (bytes.byteLength < SAFETENSORS_HEADER_LENGTH_BYTES) {
    throw new Error("safetensors: file shorter than its header-length prefix");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = Number(view.getBigUint64(0, true));
  const headerStart = SAFETENSORS_HEADER_LENGTH_BYTES;
  const dataStart = headerStart + headerLength;
  if (!Number.isSafeInteger(headerLength) || headerLength <= 0 || dataStart > bytes.byteLength) {
    throw new Error("safetensors: header length exceeds file size");
  }

  const headerJson = new TextDecoder().decode(bytes.subarray(headerStart, dataStart));
  const header = JSON.parse(headerJson) as Record<string, unknown>;

  const entries = Object.entries(header).filter(
    ([name, value]) => name !== "__metadata__" && value != null && typeof value === "object",
  ) as Array<[string, TensorInfo]>;

  let tensor = entries.find(([name]) => name === "embeddings")?.[1];
  if (!tensor) {
    const twoDimensional = entries.filter(
      ([, info]) => Array.isArray(info.shape) && info.shape.length === 2,
    );
    if (twoDimensional.length === 1) tensor = twoDimensional[0]![1];
  }
  if (!tensor) {
    throw new Error("safetensors: could not locate the embeddings tensor");
  }

  // Untrusted bytes: validate shape and offsets before any allocation or
  // subarray arithmetic (negative offsets, non-integers, and oversized
  // shapes must fail cleanly, not allocate or read out of bounds).
  const [vocabSize, dims] = tensor.shape;
  if (
    !Number.isSafeInteger(vocabSize) ||
    !Number.isSafeInteger(dims) ||
    !vocabSize ||
    !dims ||
    vocabSize <= 0 ||
    dims <= 0 ||
    vocabSize * dims > MAX_TENSOR_ELEMENTS
  ) {
    throw new Error(`safetensors: unexpected embeddings shape ${JSON.stringify(tensor.shape)}`);
  }
  const [offsetStart, offsetEnd] = tensor.data_offsets;
  const dataLength = bytes.byteLength - dataStart;
  if (
    !Number.isSafeInteger(offsetStart) ||
    !Number.isSafeInteger(offsetEnd) ||
    offsetStart < 0 ||
    offsetEnd < offsetStart ||
    offsetEnd > dataLength
  ) {
    throw new Error(
      `safetensors: tensor offsets ${JSON.stringify(tensor.data_offsets)} out of bounds`,
    );
  }
  const tensorBytes = bytes.subarray(dataStart + offsetStart, dataStart + offsetEnd);
  const tensorView = new DataView(
    tensorBytes.buffer,
    tensorBytes.byteOffset,
    tensorBytes.byteLength,
  );
  const count = vocabSize * dims;
  const data = new Float32Array(count);

  if (tensor.dtype === "F32") {
    if (tensorBytes.byteLength < count * F32_BYTES) {
      throw new Error("safetensors: F32 tensor data shorter than its declared shape");
    }
    for (let i = 0; i < count; i++) data[i] = tensorView.getFloat32(i * F32_BYTES, true);
  } else if (tensor.dtype === "F16") {
    if (tensorBytes.byteLength < count * F16_BYTES) {
      throw new Error("safetensors: F16 tensor data shorter than its declared shape");
    }
    for (let i = 0; i < count; i++)
      data[i] = halfToFloat(tensorView.getUint16(i * F16_BYTES, true));
  } else {
    throw new Error(`safetensors: unsupported dtype ${tensor.dtype} (only F32 and F16)`);
  }

  return { data, vocabSize, dims };
}

// ── WordPiece tokenization ──────────────────────────────────────────────────

type WordPieceModel = {
  vocab: Map<string, number>;
  continuingPrefix: string;
  unkId: number | undefined;
  lowercase: boolean;
};

/** Whether a normalizer config (possibly a Sequence) lowercases its input. */
function normalizerLowercases(normalizer: unknown): boolean {
  if (!normalizer || typeof normalizer !== "object") return false;
  const node = normalizer as Record<string, unknown>;
  if (node.type === "Lowercase") return true;
  if (node.type === "BertNormalizer") return node.lowercase !== false;
  if (node.lowercase === true) return true;
  if (Array.isArray(node.normalizers)) return node.normalizers.some(normalizerLowercases);
  return false;
}

/**
 * Build a WordPiece model from a parsed tokenizer.json. Throws a clear
 * "unsupported tokenizer" error for any non-WordPiece model so the caller can
 * degrade to lexical-only rather than mis-tokenize.
 */
export function buildWordPieceModel(tokenizerJson: unknown): WordPieceModel {
  const root =
    tokenizerJson && typeof tokenizerJson === "object"
      ? (tokenizerJson as Record<string, unknown>)
      : {};
  const model =
    root.model && typeof root.model === "object" ? (root.model as Record<string, unknown>) : {};

  if (model.type !== "WordPiece") {
    throw new Error(
      `unsupported tokenizer: expected model.type "WordPiece", got ${JSON.stringify(model.type)}`,
    );
  }
  if (!model.vocab || typeof model.vocab !== "object") {
    throw new Error("unsupported tokenizer: WordPiece model has no vocab");
  }

  const vocab = new Map<string, number>();
  for (const [token, id] of Object.entries(model.vocab as Record<string, number>)) {
    if (typeof id === "number") vocab.set(token, id);
  }

  const continuingPrefix =
    typeof model.continuing_subword_prefix === "string"
      ? model.continuing_subword_prefix
      : DEFAULT_CONTINUING_PREFIX;

  const unkToken = typeof model.unk_token === "string" ? model.unk_token : undefined;
  const unkId = unkToken != null ? vocab.get(unkToken) : undefined;

  return {
    vocab,
    continuingPrefix,
    unkId,
    lowercase: normalizerLowercases(root.normalizer),
  };
}

const PUNCTUATION_RE = /[^\p{L}\p{N}\s]/u;

/** Split into whitespace-delimited words; each punctuation char is its own word. */
function preTokenize(text: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const char of text) {
    if (/\s/u.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
    } else if (PUNCTUATION_RE.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      words.push(char);
    } else {
      current += char;
    }
  }
  if (current) words.push(current);
  return words;
}

/**
 * Greedy longest-match-first WordPiece for one word. Continuation pieces carry
 * the continuing prefix ("##"). If any position fails to match, the entire word
 * maps to the unk id (or is dropped when the vocab has no unk token), matching
 * BERT's WordPiece behavior.
 */
function wordPieceEncode(word: string, model: WordPieceModel): number[] {
  const chars = [...word];
  const ids: number[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = chars.length;
    let matched = -1;
    while (start < end) {
      const piece = (start > 0 ? model.continuingPrefix : "") + chars.slice(start, end).join("");
      const id = model.vocab.get(piece);
      if (id !== undefined) {
        matched = id;
        break;
      }
      end--;
    }
    if (matched === -1) {
      return model.unkId !== undefined ? [model.unkId] : [];
    }
    ids.push(matched);
    start = end;
  }
  return ids;
}

/** Tokenize `text` into vocab ids (NFC-normalized, optionally lowercased). */
export function tokenizeToIds(text: string, model: WordPieceModel): number[] {
  let normalized = text.normalize("NFC");
  if (model.lowercase) normalized = normalized.toLowerCase();
  const ids: number[] = [];
  for (const word of preTokenize(normalized)) {
    for (const id of wordPieceEncode(word, model)) ids.push(id);
  }
  return ids;
}

// ── Embedder ────────────────────────────────────────────────────────────────

export class SemanticEmbedder {
  private readonly model: string;
  private readonly artifactsDirOverride: string | undefined;
  private initPromise: Promise<void> | undefined;
  private _ready = false;
  private _initError: string | undefined;

  private matrix: Float32Array | undefined;
  private vocabSize = 0;
  private dims = 0;
  private tokenizer: WordPieceModel | undefined;

  /**
   * @param model         HuggingFace repo id, e.g. "minishlab/potion-base-8M".
   * @param artifactsDir  When set, load `tokenizer.json`/`model.safetensors`
   *                      from this directory and NEVER download (used by tests
   *                      with a hand-built fixture model). When omitted, the
   *                      artifacts are cached under
   *                      `~/.cache/opencode-session-recall/models/<model>/` and
   *                      downloaded on first use.
   */
  constructor(model: string, artifactsDir?: string) {
    // The model id becomes both a URL path segment and a cache directory
    // path; an unvalidated value could traverse out of the cache dir or
    // alter the remote request. Enforce the strict HuggingFace `org/name`
    // shape (single slash, word/dot/dash segments, no leading dots).
    if (!SemanticEmbedder.isValidModelID(model)) {
      throw new Error(
        `invalid semantic model id ${JSON.stringify(model)}; expected "org/name" (letters, digits, ., _, -)`,
      );
    }
    this.model = model;
    this.artifactsDirOverride = artifactsDir;
  }

  static isValidModelID(model: string): boolean {
    return (
      /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model) &&
      !model.includes("..")
    );
  }

  get ready(): boolean {
    return this._ready;
  }

  get initError(): string | undefined {
    return this._initError;
  }

  /**
   * Load (and, when needed, download) the model. Idempotent: the first call
   * starts a single in-flight load and every later call awaits it. Never
   * throws — any failure is captured in `initError` and leaves `ready` false.
   */
  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.load().catch((error: unknown) => {
        this._initError = errmsg(error);
        this._ready = false;
      });
    }
    return this.initPromise;
  }

  private async load(): Promise<void> {
    const [fs, path] = await Promise.all([loadFs(), loadPath()]);
    const dir = this.artifactsDirOverride ?? (await this.defaultArtifactsDir(path));

    if (!this.artifactsDirOverride) {
      await this.download(fs, path, dir);
    }

    const tokenizerBytes = await fs.promises.readFile(path.join(dir, TOKENIZER_FILE));
    const weightsBytes = await fs.promises.readFile(path.join(dir, WEIGHTS_FILE));

    const tokenizerJson = JSON.parse(new TextDecoder().decode(tokenizerBytes)) as unknown;
    this.tokenizer = buildWordPieceModel(tokenizerJson);

    const matrix = parseSafetensors(weightsBytes);
    this.matrix = matrix.data;
    this.vocabSize = matrix.vocabSize;
    this.dims = matrix.dims;

    this._ready = true;
  }

  private async defaultArtifactsDir(path: PathLike): Promise<string> {
    const os = await loadOs();
    return path.join(os.homedir(), CACHE_SUBDIR, this.model);
  }

  /** Fetch any missing/empty artifact atomically (temp file then rename). */
  private async download(fs: FsLike, path: PathLike, dir: string): Promise<void> {
    await fs.promises.mkdir(dir, { recursive: true });
    for (const file of ARTIFACT_FILES) {
      const dest = path.join(dir, file);
      try {
        const info = await fs.promises.stat(dest);
        if (info.size > 0) continue;
      } catch {
        // Not present yet; fall through to download.
      }
      const url = `${HUGGINGFACE_BASE}/${this.model}/resolve/main/${file}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`download failed for ${file}: HTTP ${response.status}`);
      }
      const body = new Uint8Array(await response.arrayBuffer());
      const temp = path.join(dir, `${file}.${Date.now()}.download`);
      await fs.promises.writeFile(temp, body);
      await fs.promises.rename(temp, dest);
    }
  }

  /**
   * Embed `text`: tokenize, mean-pool the token vectors, and L2-normalize.
   * Returns undefined when the model is not ready or the text yields no
   * in-vocabulary tokens (so callers can cleanly skip it).
   */
  embed(text: string): Float32Array | undefined {
    if (!this._ready || !this.matrix || !this.tokenizer) return undefined;
    const truncated =
      text.length > MAX_EMBED_INPUT_CHARS ? text.slice(0, MAX_EMBED_INPUT_CHARS) : text;
    const ids = tokenizeToIds(truncated, this.tokenizer);

    const dims = this.dims;
    const pooled = new Float32Array(dims);
    let used = 0;
    for (const id of ids) {
      if (id < 0 || id >= this.vocabSize) continue;
      const base = id * dims;
      for (let d = 0; d < dims; d++) pooled[d]! += this.matrix[base + d]!;
      used++;
    }
    if (used === 0) return undefined;

    let normSquared = 0;
    for (let d = 0; d < dims; d++) {
      pooled[d]! /= used;
      normSquared += pooled[d]! * pooled[d]!;
    }
    const norm = Math.sqrt(normSquared);
    if (norm === 0) return undefined;
    for (let d = 0; d < dims; d++) pooled[d]! /= norm;
    return pooled;
  }
}
