import type { OpencodeClient, Event, Message, Part, Session } from "@opencode-ai/sdk/v2";
import { errmsg, DISCOVERY_LIMIT, type Limits } from "./types.js";
import type { Card, FamilyRollup, LeaseInfo, PartTextRow, Store } from "./store.js";
import type { FetchGate } from "./fetch-gate.js";
import { isSelfTool, toolNameMatches, pruned, isSummarizerTitle } from "./extract.js";
import { tokenize } from "./normalize.js";
import { extractCodeTokens } from "./query.js";
import { isDigestToken, DIGEST_HEAD_CHARS } from "./digest.js";
import { containsErrorPattern } from "./bm25.js";

/**
 * The distiller: the write side of the card + slim-part store.
 *
 * It owns three jobs. (1) A **human-layer extractor** ({@link distillFields})
 * that — unlike `searchableFields`, which deliberately indexes tool stdout/stderr
 * for tier-2 ranking — never lets a tool OUTPUT into the FTS index; only
 * conversation text, reasoning, and tool INPUTS become rows. (2) A pure
 * **card builder** ({@link deriveCard}) growing out of `buildSessionDigest`.
 * (3) A **scheduler** ({@link createDistiller}) that runs a resumable cold pass
 * under a single-holder lease and applies push-driven incremental updates, all
 * through the shared {@link FetchGate} so it never competes with a live query.
 */

// ── Caps (spec defaults) ─────────────────────────────────────────────────────

const TEXT_CAP = 2_000;
const TOOL_INPUT_CAP = 1_000;
const FILES_CAP = 30;
const TOOLS_CAP = 30;
const ERRORS_CAP = 8;
const ERROR_SIG_CHARS = 200;
const ROLLUP_CAP = 12;
const ROLLUP_HINT_CHARS = 120;
const ROOT_MAX_DEPTH = 16;
const DEFAULT_FTS_ROWS_PER_SESSION = 5_000;
const DEFAULT_INVENTORY_TOKENS = 200;

// ── Scheduler timing (spec defaults; overridable for deterministic tests) ────

const DEFAULT_PAGE_MESSAGES = 50;
const DEFAULT_APPEND_THRESHOLD_PARTS = 2_000;
const DEFAULT_IDLE_DEBOUNCE_MS = 2_000;
const DEFAULT_LEASE_RETRY_MS = 60_000;
const DEFAULT_COLD_PASS_RETRY_MS = 60_000;
const LEASE_TTL_MS = 30_000;
const HEARTBEAT_MS = 10_000;
/** Bound process-lifetime state retained for malformed legacy sessions. */
const MAX_QUARANTINED_SESSIONS = 1_000;

// ── Shared shapes ────────────────────────────────────────────────────────────

type MsgWithParts = { info: Message; parts: Part[] };

class MalformedSessionError extends Error {
  override name = "MalformedSessionError";
}

class SessionMetadataTransportError extends Error {
  override name = "SessionMetadataTransportError";
}

/** Human-layer field extracted from one part; the FTS `norm` column and the
 *  per-row ids are added when this becomes a {@link PartTextRow}. */
export type DistillField = {
  class: "human-text" | "reasoning" | "tool-input";
  field: string;
  text: string;
};

/** Session metadata a card is seeded from (from the session list, no message
 *  fetch needed). `agent`/`model` are read defensively — this SDK vintage's
 *  `Session` does not surface them, so they resolve to null until it does. */
export type DistillSessionMeta = {
  id: string;
  parentId: string | null;
  title: string;
  slug: string;
  directory: string;
  projectId: string;
  agent: string | null;
  model: string | null;
  timeCreated: number;
  timeUpdated: number;
};

export type DeriveCardInput = {
  session: DistillSessionMeta;
  /** The session's messages, any order (sorted chronologically internally). */
  messages: MsgWithParts[];
  /** Known session graph (id → parentId) for root resolution. */
  parentById: Map<string, string | null>;
  caps?: { ftsRowsPerSession?: number; inventoryTokens?: number };
};

/** A card plus the slim-index rows it was derived from; the distiller hands both
 *  to {@link Store.replaceSessionParts}. */
export type DerivedCard = { card: Card; rows: PartTextRow[] };

export type DistillStatus = {
  leaseHeld: boolean;
  coldPass: "idle" | "running" | "done";
  distilledCount: number;
  knownCount: number;
  /** Sessions currently sidelined as malformed (see the quarantine mechanism);
   *  observability for "the pass is done but N sessions were skipped". */
  quarantinedCount: number;
  lastError?: string;
  /** Current distill-lease holder info (this process or whichever build holds it),
   *  from {@link Store.leaseStatus}. Undefined with no store or no lease row yet —
   *  the one-query answer to "who holds the lease" in a mixed-version store. */
  lease?: LeaseInfo;
};

export type Distiller = {
  start(): void;
  /** Stop accepting or scheduling work immediately, but keep renewing an
   *  already-held lease until {@link stop} finalizes the handoff. */
  quiesce(): void;
  /** Whether this instance still owns a live lease, verified against the store. */
  ownsLease(): boolean;
  stop(): Promise<void>;
  onEvent(event: Event): void;
  status(): DistillStatus;
};

export type DistillerOptions = {
  client: OpencodeClient;
  store: Store | null;
  gate: FetchGate;
  limits: Limits;
  instanceId: string;
  log?: (message: string) => void;
  now?: () => number;
  /** Session discovery for the cold pass. Defaults to a scoped
   *  `client.session.list({ limit: DISCOVERY_LIMIT })`; the plugin injects a
   *  global-vs-scoped variant. Returns raw session rows (mapped to card metadata
   *  internally); the distiller still routes the call through the fetch gate. */
  discover?: () => Promise<Session[]>;
  /** Plugin build tag recorded in the distill-lease value for cross-process
   *  diagnosis (see the plugin entry). Defaults to `"unknown"`. */
  build?: string;
  /** Representation generation recorded in the distill-lease value
   *  ({@link import("./embedding-text.js").EMBED_REPRESENTATION}). Defaults to 0. */
  gen?: number;
  // ── Test affordances: default to the spec values above ──
  /** Messages per page fetch (spec: 50). */
  pageMessages?: number;
  /** part_count above which incremental growth uses the append path (spec: 2000). */
  appendThresholdParts?: number;
  /** Idle-event debounce window (spec: 2000ms). */
  idleDebounceMs?: number;
  /** Non-holder lease re-acquisition interval (spec: 60000ms). */
  leaseRetryMs?: number;
  /** Backoff before re-arming a cold pass that aborted on a transient error
   *  (spec: 60000ms). */
  coldPassRetryMs?: number;
  /** Called (while holding the lease) once the cold pass finishes, so the Path B
   *  summarizer can run its own pass over the freshly distilled cards. */
  onColdPassDone?: () => void;
  /** Called (while holding the lease) after an incremental re-distill lands, so
   *  the summarizer can queue a content-hash-gated re-summarize of that session. */
  onSessionDistilled?: (sessionId: string) => void;
};

// ── Small text helpers ───────────────────────────────────────────────────────

function cap(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

/** The FTS `norm` column: tokenized stream plus verbatim code compounds,
 *  deduped and space-joined — so a camelCase/SCREAMING_CASE identifier is
 *  findable both split and whole. */
function computeNorm(text: string): string {
  return [...new Set([...tokenize(text), ...extractCodeTokens(text)])].join(" ");
}

// ── Part inspection ──────────────────────────────────────────────────────────

function toolInputObject(part: Part): Record<string, unknown> | undefined {
  if (part.type !== "tool") return undefined;
  const input = (part.state as { input?: unknown }).input;
  return input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
}

function stringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!obj) return undefined;
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Whether a text part is auto-recall's synthetic `<recall-auto>` injection,
 *  which must never be indexed (recall would find its own prior injections). */
function isRecallAutoText(part: Part): boolean {
  return (
    part.type === "text" &&
    (part as { synthetic?: boolean }).synthetic === true &&
    part.text?.startsWith("<recall-auto>") === true
  );
}

/** The statement text a summary head is drawn from: user/assistant text or a
 *  subtask's description+prompt. Excludes the synthetic recall-auto sentinel. */
function statementText(part: Part): string | undefined {
  if (part.type === "text") {
    if (isRecallAutoText(part)) return undefined;
    return part.text || undefined;
  }
  if (part.type === "subtask") {
    return [part.description, part.prompt].filter(Boolean).join("\n\n") || undefined;
  }
  return undefined;
}

/** The first genuine text part of a message (for the outcome head). */
function firstTextPartText(msg: MsgWithParts): string | undefined {
  for (const part of msg.parts) {
    if (part.type === "text" && !isRecallAutoText(part) && part.text) return part.text;
  }
  return undefined;
}

function filePathOf(part: Part): string | undefined {
  const input = toolInputObject(part);
  return stringField(input, "filePath") ?? stringField(input, "path");
}

/** First-line error signature from a tool part: a failed state's error, or a
 *  completed output whose text carries an error pattern. Outputs never become
 *  FTS rows, but the distiller sees them while streaming, so their signatures
 *  still reach the card. */
function errorSignatureOf(part: Part): string | undefined {
  if (part.type !== "tool") return undefined;
  const state = part.state;
  if (state.status === "error") {
    const error = (state as { error?: unknown }).error;
    if (typeof error === "string" && error) return cap(firstLine(error), ERROR_SIG_CHARS);
  }
  if (state.status === "completed") {
    const output = (state as { output?: unknown }).output;
    if (typeof output === "string" && output && containsErrorPattern(output)) {
      return cap(firstLine(output), ERROR_SIG_CHARS);
    }
  }
  return undefined;
}

// ── Human-layer extraction ───────────────────────────────────────────────────

/**
 * Extract a part's human-layer fields for the FTS index. Text and subtask parts
 * become `human-text`; reasoning becomes `reasoning`; tool parts contribute
 * INPUTS only — `command`/`cwd` strings always, plus the capped JSON input for
 * tools that are not read/skill (their inputs are generated reference material,
 * not an action, mirroring `buildSessionDigest`'s gating). Self-tool parts and
 * the synthetic recall-auto text yield nothing. Caps are applied after
 * extraction.
 */
export function distillFields(part: Part): DistillField[] {
  switch (part.type) {
    case "text": {
      if (isRecallAutoText(part) || !part.text) return [];
      return [{ class: "human-text", field: "text", text: cap(part.text, TEXT_CAP) }];
    }
    case "reasoning": {
      if (!part.text) return [];
      return [{ class: "reasoning", field: "reasoning", text: cap(part.text, TEXT_CAP) }];
    }
    case "subtask": {
      const combined = [part.description, part.prompt].filter(Boolean).join("\n\n");
      if (!combined) return [];
      return [{ class: "human-text", field: "text", text: cap(combined, TEXT_CAP) }];
    }
    case "tool": {
      if (isSelfTool(part.tool)) return [];
      const input = toolInputObject(part);
      const out: DistillField[] = [];
      const command = stringField(input, "command");
      const cwd = stringField(input, "cwd");
      if (command)
        out.push({ class: "tool-input", field: "command", text: cap(command, TOOL_INPUT_CAP) });
      if (cwd) out.push({ class: "tool-input", field: "cwd", text: cap(cwd, TOOL_INPUT_CAP) });
      const generatedRef =
        toolNameMatches(part.tool, "read") || toolNameMatches(part.tool, "skill");
      if (input && !generatedRef) {
        const json = JSON.stringify(input);
        // Skip empty/degenerate objects; commands and args in a real input are gold.
        if (json && json.length > 2) {
          out.push({ class: "tool-input", field: "command", text: cap(json, TOOL_INPUT_CAP) });
        }
      }
      return out;
    }
    default:
      return [];
  }
}

// ── Card derivation ──────────────────────────────────────────────────────────

type Walk = {
  rows: PartTextRow[];
  files: string[];
  tools: string[];
  errors: string[];
  partCount: number;
  firstUserHead: string;
  lastTextHead: string;
  newestMessageId: string | null;
};

/**
 * Single chronological walk producing the FTS rows and every streaming-derived
 * card contribution. `prevForFirst` is the message id preceding the first walked
 * message (the checkpoint, when appending) so drill neighbor ids stay correct.
 */
function walkMessages(chrono: MsgWithParts[], prevForFirst: string | null): Walk {
  const rows: PartTextRow[] = [];
  const files: string[] = [];
  const tools: string[] = [];
  const errors: string[] = [];
  let partCount = 0;
  let firstUserHead = "";
  let lastTextHead = "";

  for (let i = 0; i < chrono.length; i++) {
    const msg = chrono[i]!;
    const prevMessageId = i === 0 ? prevForFirst : chrono[i - 1]!.info.id;
    const nextMessageId = i === chrono.length - 1 ? null : chrono[i + 1]!.info.id;
    partCount += msg.parts.length;

    for (const part of msg.parts) {
      let fieldIndex = 0;
      for (const field of distillFields(part)) {
        rows.push({
          partId: `${part.id}#${fieldIndex++}`,
          messageId: msg.info.id,
          prevMessageId,
          nextMessageId,
          class: field.class,
          timeCreated: msg.info.time.created,
          raw: field.text,
          norm: computeNorm(field.text),
        });
      }
    }

    if (!firstUserHead && msg.info.role === "user") {
      for (const part of msg.parts) {
        const text = statementText(part);
        if (text) {
          firstUserHead = text.slice(0, DIGEST_HEAD_CHARS);
          break;
        }
      }
    }
    const text = firstTextPartText(msg);
    if (text) lastTextHead = text.slice(0, DIGEST_HEAD_CHARS);

    for (const part of msg.parts) {
      if (part.type !== "tool" || isSelfTool(part.tool)) continue;
      tools.push(part.tool);
      if (
        toolNameMatches(part.tool, "read") ||
        toolNameMatches(part.tool, "edit") ||
        toolNameMatches(part.tool, "write")
      ) {
        const filePath = filePathOf(part);
        if (filePath) files.push(filePath);
      }
      const signature = errorSignatureOf(part);
      if (signature) errors.push(signature);
    }
  }

  return {
    rows,
    files,
    tools,
    errors,
    partCount,
    firstUserHead,
    lastTextHead,
    newestMessageId: chrono.length ? chrono[chrono.length - 1]!.info.id : null,
  };
}

function sortChronological(messages: MsgWithParts[]): MsgWithParts[] {
  return [...messages].sort(
    (a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id),
  );
}

/** Keep the newest `cap` rows (rows arrive oldest-first, so the tail is newest). */
function capRows(rows: PartTextRow[], limit: number): PartTextRow[] {
  return rows.length > limit ? rows.slice(rows.length - limit) : rows;
}

/**
 * The card inventory: top code-token anchors and digest-scored statement/command
 * tokens, computed purely from the slim-index rows so a full re-distill and an
 * append recompute over the same rows agree exactly. Code anchors are the layer
 * agents query by, so they take priority under the combined cap.
 */
function deriveInventory(rows: Array<{ class: string; raw: string }>, limit: number): string {
  const digest = new Map<string, number>();
  const code = new Map<string, number>();
  for (const row of rows) {
    const digestBearing =
      row.class === "human-text" || (row.class === "tool-input" && !row.raw.startsWith("{"));
    if (digestBearing) {
      for (const token of tokenize(row.raw)) {
        if (isDigestToken(token)) digest.set(token, (digest.get(token) ?? 0) + 1);
      }
    }
    for (const token of extractCodeTokens(row.raw)) {
      code.set(token, (code.get(token) ?? 0) + 1);
    }
  }
  const byFrequency = (entries: Map<string, number>): string[] =>
    [...entries.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of [...byFrequency(code), ...byFrequency(digest)]) {
    if (out.length >= limit) break;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out.join(" ");
}

/** Distinct list keeping each item's LAST occurrence position (recency order). */
function distinctKeepLast(items: string[]): string[] {
  const seen = new Set<string>();
  const reversed: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (seen.has(item)) continue;
    seen.add(item);
    reversed.push(item);
  }
  return reversed.reverse();
}

/** Merge keeping the most-recent occurrences, capped to the `cap` newest. Used
 *  for files, where newest-touched wins. Stable under old⊕new: `merge(full)` and
 *  `merge(old, new)` land on the same set + order. */
function mergeKeepLast(existing: string[], incoming: string[], size: number): string[] {
  const distinct = distinctKeepLast([...existing, ...incoming]);
  return distinct.slice(Math.max(0, distinct.length - size));
}

/** Merge keeping first occurrences, capped to the first `cap`. Used for tools
 *  and error signatures, where the earliest distinct entries are kept. */
function mergeKeepFirst(existing: string[], incoming: string[], size: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...existing, ...incoming]) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= size) break;
  }
  return out;
}

/**
 * Resolve a session's root by walking parentID up the KNOWN session set (bounded
 * like `exclusionFamily`). A parent absent from the set — or no parent — makes
 * the highest known session the root.
 */
export function resolveRootId(
  sessionId: string,
  parentById: Map<string, string | null>,
  maxDepth = ROOT_MAX_DEPTH,
): string {
  let current = sessionId;
  const seen = new Set<string>([current]);
  for (let depth = 0; depth < maxDepth; depth++) {
    const parent = parentById.get(current);
    if (parent == null || seen.has(parent) || !parentById.has(parent)) break;
    seen.add(parent);
    current = parent;
  }
  return current;
}

/**
 * Build a session's card plus its slim-index rows from the walked messages.
 * Pure and deterministic: the same session state always yields the same card,
 * which is what lets append-mode recompute equal a full re-distill. Family
 * rollup is left empty here — the distiller fills it for roots after children
 * are known.
 */
export function deriveCard(input: DeriveCardInput): DerivedCard {
  const { session, messages, parentById } = input;
  const ftsRowsPerSession = input.caps?.ftsRowsPerSession ?? DEFAULT_FTS_ROWS_PER_SESSION;
  const inventoryTokens = input.caps?.inventoryTokens ?? DEFAULT_INVENTORY_TOKENS;

  const chrono = sortChronological(messages);
  const walk = walkMessages(chrono, null);
  const rows = capRows(walk.rows, ftsRowsPerSession);
  const retainedChars = rows.reduce((sum, row) => sum + row.raw.length, 0);

  const card: Card = {
    sessionId: session.id,
    parentId: session.parentId,
    rootId: resolveRootId(session.id, parentById),
    title: session.title,
    slug: session.slug,
    directory: session.directory,
    projectId: session.projectId,
    agent: session.agent,
    model: session.model,
    timeCreated: session.timeCreated,
    timeUpdated: session.timeUpdated,
    partCount: walk.partCount,
    retainedChars,
    summaryHead: walk.firstUserHead,
    outcomeHead: walk.lastTextHead,
    inventory: deriveInventory(rows, inventoryTokens),
    files: mergeKeepLast([], walk.files, FILES_CAP),
    tools: mergeKeepFirst([], walk.tools, TOOLS_CAP),
    errors: mergeKeepFirst([], walk.errors, ERRORS_CAP),
    familyRollup: [],
    distillState: "full",
    distilledThrough: walk.newestMessageId,
    embedding: null,
    embeddingGen: null,
    // Summaries are owned by the summarizer's separate write path; these
    // defaults apply only on a brand-new insert (the card upsert preserves any
    // existing summary across re-distills).
    nlSummary: "",
    summaryHash: "",
  };
  return { card, rows };
}

// ── Paginated fetch ──────────────────────────────────────────────────────────

export type MessagePage = { items: MsgWithParts[]; nextCursor: string | null };

/** Read `X-Next-Cursor` from a fields-style response's fetch `Response`, case-
 *  insensitively (native `Headers.get` folds case) and defensively (a missing
 *  response, headers, or getter yields null). */
function readNextCursor(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const headers = (response as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return null;
  const get = (headers as { get?: unknown }).get;
  if (typeof get !== "function") return null;
  try {
    const value = (get as (name: string) => unknown).call(headers, "X-Next-Cursor");
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Fetch one page of a session's messages. ALWAYS sends `limit` — omitting it
 * triggers the legacy full-session fetch (the incident path) and `before`
 * without `limit` is a 400. The next-page cursor rides the `X-Next-Cursor`
 * header; the body is the `{ info, parts }` array. Throws on an SDK error so the
 * caller's try/catch handles fetch failures uniformly.
 *
 * A successful response whose body is not an array is ambiguous: the query path
 * (browse/context/drill) treats it as a deliberate "empty page, ok:true" — a
 * documented decision for sessions with no data — while the distiller passes
 * `strict: true` so its quarantine can distinguish a malformed session from an
 * empty one.
 */
export async function fetchMessagePage(
  client: OpencodeClient,
  opts: { sessionID: string; limit: number; before?: string; strict?: boolean },
): Promise<MessagePage> {
  const params =
    opts.before != null
      ? { sessionID: opts.sessionID, limit: opts.limit, before: opts.before }
      : { sessionID: opts.sessionID, limit: opts.limit };
  const resp = await client.session.messages(params);
  if (resp.error) throw new Error(errmsg(resp.error));
  if (!Array.isArray(resp.data)) {
    if (opts.strict) {
      throw new MalformedSessionError("successful message response was not an array");
    }
    return { items: [], nextCursor: readNextCursor(resp.response) };
  }
  const items = resp.data as MsgWithParts[];
  return { items, nextCursor: readNextCursor(resp.response) };
}

// ── The distiller ────────────────────────────────────────────────────────────

function toMeta(session: Session): DistillSessionMeta {
  const record = session as unknown as Record<string, unknown>;
  const time = (record.time ?? {}) as { created?: number; updated?: number };
  return {
    id: typeof record.id === "string" ? record.id : "",
    parentId: typeof record.parentID === "string" ? record.parentID : null,
    title: typeof record.title === "string" ? record.title : "",
    slug: typeof record.slug === "string" ? record.slug : "",
    directory: typeof record.directory === "string" ? record.directory : "",
    projectId: typeof record.projectID === "string" ? record.projectID : "",
    agent: typeof record.agent === "string" ? record.agent : null,
    model: typeof record.model === "string" ? record.model : null,
    timeCreated: typeof time.created === "number" ? time.created : 0,
    timeUpdated: typeof time.updated === "number" ? time.updated : 0,
  };
}

/** A part.updated event is removal-shaped when the part signals pruning/
 *  compaction rather than ordinary streaming growth. */
function isRemovalShapedPart(part: Part): boolean {
  return part.type === "compaction" || pruned(part);
}

const noopStatus = (): DistillStatus => ({
  leaseHeld: false,
  coldPass: "idle",
  distilledCount: 0,
  knownCount: 0,
  quarantinedCount: 0,
});

export function createDistiller(options: DistillerOptions): Distiller {
  const { client, gate, limits, instanceId } = options;

  // Store unavailable (degraded mode): every method is a clean no-op.
  if (!options.store) {
    return {
      start() {},
      quiesce() {},
      ownsLease: () => false,
      async stop() {},
      onEvent() {},
      status: noopStatus,
    };
  }
  const store: Store = options.store;

  const log = options.log;
  const now = options.now ?? Date.now;
  const pageMessages = options.pageMessages ?? DEFAULT_PAGE_MESSAGES;
  const appendThresholdParts = options.appendThresholdParts ?? DEFAULT_APPEND_THRESHOLD_PARTS;
  const idleDebounceMs = options.idleDebounceMs ?? DEFAULT_IDLE_DEBOUNCE_MS;
  const leaseRetryMs = options.leaseRetryMs ?? DEFAULT_LEASE_RETRY_MS;
  const coldPassRetryMs = options.coldPassRetryMs ?? DEFAULT_COLD_PASS_RETRY_MS;
  // Recorded in the lease value for cross-process diagnosis; no behavioral effect.
  const build = options.build ?? "unknown";
  const gen = options.gen ?? 0;
  const caps = {
    ftsRowsPerSession: limits.ftsRowsPerSession,
    inventoryTokens: limits.inventoryTokens,
  };
  const logMsg = (message: string): void => {
    if (log) log(`[recall distill @${now()}] ${message}`);
  };

  type Timer = ReturnType<typeof setTimeout>;

  let stopped = false;
  let finalized = false;
  let leaseHeld = false;
  let coldPassState: DistillStatus["coldPass"] = "idle";
  let lastError: string | undefined;
  let knownCount = 0;
  let distilledCount = 0;

  let heartbeatTimer: Timer | undefined;
  let leaseRetryTimer: Timer | undefined;
  let coldPassRetryTimer: Timer | undefined;
  const debounceTimers = new Map<string, Timer>();
  let coldPassPromise: Promise<void> | undefined;
  const inFlight = new Map<string, Promise<void>>();
  const pendingRerun = new Set<string>();
  const quarantined = new Map<string, number>();
  let stopPromise: Promise<void> | undefined;
  /** Sessions that saw a removal-shaped event since their last full distill, so
   *  the next re-distill takes the full path rather than appending. */
  const removalSince = new Set<string>();

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const discover =
    options.discover ??
    (async (): Promise<Session[]> => {
      const resp = await client.session.list({ limit: DISCOVERY_LIMIT });
      if (resp.error) throw new Error(errmsg(resp.error));
      return Array.isArray(resp.data) ? (resp.data as Session[]) : [];
    });

  /** Bump the card-revision counter after every store write, so the tier-1 card
   *  runtime knows to reload lazily. A separate write from the data write, which
   *  is acceptable for a refresh hint (also time-gated on the reader). */
  function bumpCardsRev(): void {
    const current = Number(store.getMeta("cards_rev")) || 0;
    store.setMeta("cards_rev", String(current + 1));
  }

  // ── Fetch primitives (all through the gate at background priority) ──

  async function discoverSessions(): Promise<DistillSessionMeta[]> {
    const sessions = await gate.runBackground(() => {
      if (stopped || !leaseHeld) return Promise.resolve([]);
      return discover();
    });
    // Never distill the summarizer's worker session — its prompts embed card
    // digests, which recall must not surface (see isSummarizerTitle).
    return sessions.map(toMeta).filter((meta) => !isSummarizerTitle(meta.title));
  }

  async function fetchSessionMeta(sessionID: string): Promise<DistillSessionMeta | null> {
    const resp = await gate.runBackground(() => {
      if (stopped || !leaseHeld) return Promise.resolve(null);
      return client.session.get({ sessionID });
    });
    if (!resp) return null;
    if (resp.error) {
      throw new SessionMetadataTransportError(
        `session ${sessionID} metadata fetch failed: ${errmsg(resp.error)}`,
      );
    }
    if (resp.data == null) return null;
    if (typeof resp.data !== "object") {
      throw new MalformedSessionError(`session ${sessionID} metadata response was not an object`);
    }
    return toMeta(resp.data as Session);
  }

  /** Page a session newest-first, stopping once `maxRows` human-layer rows have
   *  accrued so a giant session never forces a full fetch (its newest rows win
   *  the per-session cap). */
  async function fetchSessionMessages(sessionID: string, maxRows: number): Promise<MsgWithParts[]> {
    const all: MsgWithParts[] = [];
    let cursor: string | undefined;
    let rowCount = 0;
    let first = true;
    do {
      if (stopped || !leaseHeld) return all;
      if (!first && limits.distillDelayMs > 0) {
        await sleep(limits.distillDelayMs);
        if (stopped || !leaseHeld) return all;
      }
      first = false;
      const before = cursor;
      const page = await gate.runBackground(() => {
        if (stopped || !leaseHeld) return Promise.resolve({ items: [], nextCursor: null });
        return fetchMessagePage(client, { sessionID, limit: pageMessages, before, strict: true });
      });
      try {
        for (const msg of page.items) {
          all.push(msg);
          for (const part of msg.parts) rowCount += distillFields(part).length;
        }
      } catch (error) {
        throw new MalformedSessionError(errmsg(error));
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor && rowCount < maxRows);
    return all;
  }

  /** Page newest-first collecting only messages newer than `checkpoint`, halting
   *  as soon as the checkpoint message is reached. `reached` is false when the
   *  pages exhausted without ever seeing the checkpoint (it was compacted/removed
   *  upstream), which means append is unsafe and the caller must fall back to a
   *  full re-distill. */
  async function fetchNewMessages(
    sessionID: string,
    checkpoint: string,
  ): Promise<{ messages: MsgWithParts[]; reached: boolean }> {
    const collected: MsgWithParts[] = [];
    let cursor: string | undefined;
    let first = true;
    let reached = false;
    do {
      if (stopped || !leaseHeld) return { messages: collected, reached: false };
      if (!first && limits.distillDelayMs > 0) {
        await sleep(limits.distillDelayMs);
        if (stopped || !leaseHeld) return { messages: collected, reached: false };
      }
      first = false;
      const before = cursor;
      const page = await gate.runBackground(() => {
        if (stopped || !leaseHeld) return Promise.resolve({ items: [], nextCursor: null });
        return fetchMessagePage(client, { sessionID, limit: pageMessages, before, strict: true });
      });
      try {
        for (const msg of page.items) {
          if (msg.info.id === checkpoint) {
            reached = true;
            break;
          }
          collected.push(msg);
        }
      } catch (error) {
        throw new MalformedSessionError(errmsg(error));
      }
      cursor = reached ? undefined : (page.nextCursor ?? undefined);
    } while (cursor);
    return { messages: collected, reached };
  }

  // ── Root / family ──

  function parentChainOf(session: DistillSessionMeta): Map<string, string | null> {
    const map = new Map<string, string | null>();
    map.set(session.id, session.parentId);
    let parent = session.parentId;
    let depth = 0;
    while (parent && depth < ROOT_MAX_DEPTH && !map.has(parent)) {
      const card = store.getCard(parent);
      if (!card) break;
      map.set(parent, card.parentId);
      parent = card.parentId;
      depth++;
    }
    return map;
  }

  function buildRollup(children: Card[]): FamilyRollup[] {
    return [...children]
      .sort((a, b) => b.timeUpdated - a.timeUpdated || a.sessionId.localeCompare(b.sessionId))
      .slice(0, ROLLUP_CAP)
      .map((child) => {
        const hint = (child.title || child.summaryHead).slice(0, ROLLUP_HINT_CHARS);
        const base = { sessionId: child.sessionId, messageId: child.distilledThrough ?? "" };
        return hint ? { ...base, snippet: hint } : base;
      });
  }

  function recomputeRootRollup(rootId: string): void {
    // Rollup writes replace the root card row; verify authoritative ownership
    // once per rollup batch (callers reach here after awaited fetches, so the
    // cached flag alone can be stale after a >TTL suspension).
    if (!ownsLease()) return;
    const root = store.getCard(rootId);
    if (!root) return;
    const children = store
      .allCards()
      .filter((card) => card.rootId === rootId && card.sessionId !== rootId);
    store.upsertCard({ ...root, familyRollup: buildRollup(children) });
    bumpCardsRev();
  }

  function recomputeAllRootRollups(): void {
    // One authoritative ownership read for the whole rollup sweep (see
    // recomputeRootRollup); per-row checks would multiply SQLite reads for
    // no additional safety.
    if (!ownsLease()) return;
    const rootCards = new Map<string, Card>();
    const childrenByRoot = new Map<string, Card[]>();
    // Load embeddings too: the rollup upsert below rewrites every card column, so
    // a root loaded without its persisted vector would wipe it on write —
    // silently defeating vector persistence for every family root on each cold
    // pass, including warm restarts that skip re-distilling those cards.
    for (const card of store.allCards({ withEmbeddings: true })) {
      if (card.rootId === card.sessionId) rootCards.set(card.sessionId, card);
      else {
        const siblings = childrenByRoot.get(card.rootId);
        if (siblings) siblings.push(card);
        else childrenByRoot.set(card.rootId, [card]);
      }
    }
    for (const [rootId, root] of rootCards) {
      const rollup = buildRollup(childrenByRoot.get(rootId) ?? []);
      if (rollup.length > 0 || root.familyRollup.length > 0) {
        store.upsertCard({ ...root, familyRollup: rollup });
        bumpCardsRev();
      }
    }
  }

  // ── Distill one session ──

  async function distillFull(session: DistillSessionMeta): Promise<void> {
    const messages = await fetchSessionMessages(session.id, caps.ftsRowsPerSession);
    // Cheap flag check before parentChainOf touches the store: a detached
    // continuation (the fetch settled after dispose's bounded wait) must not
    // read SQLite, which may already be closed.
    if (stopped || !leaseHeld) return;
    const { card, rows } = deriveCard({
      session,
      messages,
      parentById: parentChainOf(session),
      caps,
    });
    // Authoritative re-check (live lease row, not the cached flag): a process
    // suspended past the TTL can lose the lease to a rival before its heartbeat
    // callback ever runs; the resumed fetch must not replace the new holder's
    // rows. One leaseStatus() read per write batch.
    if (stopped || !ownsLease()) return;
    store.replaceSessionParts(session.id, rows, card);
    bumpCardsRev();
  }

  async function distillAppend(session: DistillSessionMeta, oldCard: Card): Promise<void> {
    const checkpoint = oldCard.distilledThrough;
    if (!checkpoint) {
      await distillFull(session);
      return;
    }
    const { messages: newMessages, reached } = await fetchNewMessages(session.id, checkpoint);
    // Authoritative ownership check before the append write (see distillFull);
    // only synchronous derivation sits between here and appendSessionParts.
    if (stopped || !ownsLease()) return;
    // If the checkpoint message was never found, the newest pages are NOT a clean
    // append tail (they'd re-insert already-stored parts and hit a UNIQUE
    // violation, wedging the session). Fall back to a full re-distill.
    if (!reached) {
      await distillFull(session);
      return;
    }
    if (newMessages.length === 0) return; // nothing appended; card stays current

    const chrono = sortChronological(newMessages);
    const walk = walkMessages(chrono, checkpoint);
    const rootId = resolveRootId(session.id, parentChainOf(session));
    const boundary = { checkpointMessageId: checkpoint, firstNewMessageId: chrono[0]!.info.id };

    store.appendSessionParts(
      session.id,
      walk.rows,
      caps.ftsRowsPerSession,
      boundary,
      (allRows) => ({
        sessionId: session.id,
        parentId: session.parentId,
        rootId,
        title: session.title,
        slug: session.slug,
        directory: session.directory,
        projectId: session.projectId,
        agent: session.agent,
        model: session.model,
        timeCreated: session.timeCreated,
        timeUpdated: session.timeUpdated,
        partCount: oldCard.partCount + walk.partCount,
        retainedChars: allRows.reduce((sum, row) => sum + row.raw.length, 0),
        summaryHead: oldCard.summaryHead || walk.firstUserHead,
        outcomeHead: walk.lastTextHead || oldCard.outcomeHead,
        inventory: deriveInventory(allRows, caps.inventoryTokens),
        files: mergeKeepLast(oldCard.files, walk.files, FILES_CAP),
        tools: mergeKeepFirst(oldCard.tools, walk.tools, TOOLS_CAP),
        errors: mergeKeepFirst(oldCard.errors, walk.errors, ERRORS_CAP),
        familyRollup: oldCard.familyRollup,
        distillState: "full",
        distilledThrough: walk.newestMessageId ?? checkpoint,
        // Clear any persisted vector: the append changed the inventory and
        // heads the embedding is derived from, so a carried-over vector would be
        // stale. Null forces the semantic layer to recompute on the next load,
        // matching a full re-distill (deriveCard also stores a null embedding).
        embedding: null,
        embeddingGen: null,
        // Preserved by the store's card upsert (excluded from its UPDATE SET);
        // these values apply only to a first insert.
        nlSummary: "",
        summaryHash: "",
      }),
    );
    bumpCardsRev();
  }

  // ── Cold pass ──

  async function runPool<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void> {
    let index = 0;
    let firstError: unknown;
    const width = Math.max(1, Math.floor(concurrency));
    const runner = async (): Promise<void> => {
      while (firstError === undefined) {
        const i = index++;
        if (i >= items.length) return;
        try {
          await worker(items[i]!);
        } catch (error) {
          if (firstError === undefined) firstError = error;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, items.length) }, () => runner()));
    if (firstError !== undefined) throw firstError;
  }

  async function runColdPass(): Promise<void> {
    if (coldPassState === "running") return;
    coldPassState = "running";
    lastError = undefined;
    logMsg("cold pass started");
    try {
      const discovered = await discoverSessions();
      knownCount = discovered.length;
      const liveUpdates = new Map(discovered.map((session) => [session.id, session.timeUpdated]));
      for (const [sessionId, timeUpdated] of quarantined) {
        // Deletions and updates both invalidate quarantine. An updated session is
        // retried below; a deleted one no longer consumes retained state.
        if (liveUpdates.get(sessionId) !== timeUpdated) quarantined.delete(sessionId);
      }
      const parentById = new Map(discovered.map((s) => [s.id, s.parentId] as const));
      const sorted = [...discovered].sort(
        (a, b) => b.timeUpdated - a.timeUpdated || a.id.localeCompare(b.id),
      );
      let examined = 0;
      let distilled = 0;

      await runPool(sorted, limits.distillConcurrency, async (session) => {
        if (stopped || !leaseHeld) return; // paused / lost lease — resume on next start
        // Resume is driven purely by per-card state: a session already at 'full'
        // for its current updated time is skipped. (A watermark fast-skip is
        // unsafe under concurrency > 1 — a slow newer session that fails could be
        // skipped past by faster older ones — so it is deliberately not used.)
        const existing = store.getCard(session.id);
        const upToDate =
          existing?.distillState === "full" && existing.timeUpdated === session.timeUpdated;
        if (!upToDate) {
          if (quarantined.get(session.id) === session.timeUpdated) {
            examined++;
            recordProgress(session.timeUpdated);
            return;
          }

          let messages: MsgWithParts[];
          try {
            messages = await fetchSessionMessages(session.id, caps.ftsRowsPerSession);
          } catch (error) {
            if (!(error instanceof MalformedSessionError)) throw error;
            quarantine(session, error);
            examined++;
            recordProgress(session.timeUpdated);
            return;
          }

          let card: Card;
          let rows: PartTextRow[];
          try {
            ({ card, rows } = deriveCard({ session, messages, parentById, caps }));
          } catch (error) {
            // Quarantine only data-shape failures (mirroring the fetch path
            // above): a TypeError walking malformed legacy parts is this
            // session's problem; anything else is a deriveCard regression that
            // must surface as a pass failure, not silently sideline sessions.
            if (!(error instanceof MalformedSessionError) && !(error instanceof TypeError)) {
              throw error;
            }
            quarantine(session, error);
            examined++;
            recordProgress(session.timeUpdated);
            return;
          }
          // The lease can drop (heartbeat takeover) during the fetch above; a
          // non-holder must never write. Re-check right before the write —
          // authoritatively, against the live lease row, because a suspension
          // past the TTL loses the lease before the heartbeat callback flips
          // the cached flag — and skip it, counting the session as not
          // distilled.
          if (stopped || !ownsLease()) return;
          store.replaceSessionParts(session.id, rows, card);
          bumpCardsRev();
          distilled++;
          distilledCount = distilled; // status counts only sessions actually distilled
        }
        examined++;
        recordProgress(session.timeUpdated);
      });

      // Losing the lease (a takeover) or stopping mid-pass must NOT finish the
      // pass or recompute rollups as if complete — leave it idle so the new
      // holder (or a restart) redoes the remainder.
      if (stopped || !leaseHeld) {
        coldPassState = "idle";
        return;
      }
      recomputeAllRootRollups();
      coldPassState = "done";
      logMsg(
        `cold pass done (${distilled} distilled / ${examined} examined / ${knownCount} known)`,
      );
      options.onColdPassDone?.();
    } catch (error) {
      lastError = errmsg(error);
      coldPassState = "idle"; // resumable: per-card skip resumes on the next run
      logMsg(`cold pass aborted: ${lastError}`);
      // A transient failure must not kill the pass for the process lifetime;
      // re-arm on a backoff while we still hold the lease.
      scheduleColdPassRetry();
    }
  }

  function quarantine(session: DistillSessionMeta, error: unknown): void {
    // Reinsertion keeps FIFO eviction aligned with the latest failure.
    quarantined.delete(session.id);
    quarantined.set(session.id, session.timeUpdated);
    while (quarantined.size > MAX_QUARANTINED_SESSIONS) {
      const oldest = quarantined.keys().next().value;
      if (oldest === undefined) break;
      quarantined.delete(oldest);
    }
    logMsg(
      `session ${session.id} quarantined at timeUpdated ${session.timeUpdated}: ${errmsg(error)}`,
    );
  }

  function startColdPass(): Promise<void> {
    if (stopped || !leaseHeld) return Promise.resolve();
    if (coldPassPromise) return coldPassPromise;
    const running = runColdPass().finally(() => {
      if (coldPassPromise === running) coldPassPromise = undefined;
    });
    coldPassPromise = running;
    return running;
  }

  function scheduleColdPassRetry(): void {
    if (stopped || !leaseHeld) return;
    clearTimer(coldPassRetryTimer);
    coldPassRetryTimer = setTimeout(() => {
      coldPassRetryTimer = undefined;
      if (stopped || !leaseHeld) return;
      if (coldPassState === "idle" && lastError !== undefined) void startColdPass();
    }, coldPassRetryMs);
  }

  // Progress marker: the lowest `time_updated` processed so far this sweep,
  // persisted (spec meta key `coldpass_cursor`) for coverage/observability
  // (Stage 3). Resume correctness comes from the per-card skip above.
  let progressFloor: number | undefined;
  function recordProgress(timeUpdated: number): void {
    if (stopped || !leaseHeld) return;
    if (progressFloor == null || timeUpdated < progressFloor) {
      progressFloor = timeUpdated;
      store.setMeta("coldpass_cursor", String(timeUpdated));
    }
  }

  // ── Incremental ──

  function scheduleReDistill(sessionID: string): void {
    const existing = debounceTimers.get(sessionID);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      sessionID,
      setTimeout(() => {
        debounceTimers.delete(sessionID);
        startReDistill(sessionID);
      }, idleDebounceMs),
    );
  }

  function startReDistill(sessionID: string): void {
    if (stopped || !leaseHeld) return; // non-holders and stopped instances write nothing
    if (inFlight.has(sessionID)) {
      pendingRerun.add(sessionID); // coalesce: run once more after the in-flight pass
      return;
    }
    const running = runReDistill(sessionID).finally(() => {
      inFlight.delete(sessionID);
      if (!stopped && pendingRerun.delete(sessionID)) scheduleReDistill(sessionID);
    });
    inFlight.set(sessionID, running);
  }

  async function runReDistill(sessionID: string): Promise<void> {
    // Snapshot-and-clear the removal flag BEFORE any await: a removal event that
    // arrives mid-distill re-adds it independently, so the coalesced rerun still
    // forces a full re-distill instead of appending onto a compacted transcript.
    const hadRemoval = removalSince.delete(sessionID);
    let succeeded = false;
    try {
      const session = await fetchSessionMeta(sessionID);
      // A request already in flight at stop time settles late, past dispose's
      // bounded wait — by then SQLite may be closed, so a detached continuation
      // must not reach the store reads below.
      if (stopped || !leaseHeld) return;
      // The summarizer's worker session emits idle events as it is prompted; it
      // is never distilled or carded (its prompts embed card digests).
      if (session && isSummarizerTitle(session.title)) return;
      if (session) {
        const existing = store.getCard(sessionID);
        const canAppend =
          existing != null &&
          existing.distilledThrough != null &&
          existing.partCount > appendThresholdParts &&
          !hadRemoval;
        if (canAppend && existing) await distillAppend(session, existing);
        else await distillFull(session);
        if (stopped || !leaseHeld) return;
        // Keep the root's family highlights current with its live children.
        const stored = store.getCard(sessionID);
        if (stored && stored.rootId !== sessionID) recomputeRootRollup(stored.rootId);
        succeeded = true;
        options.onSessionDistilled?.(sessionID);
      }
    } catch (error) {
      lastError = errmsg(error);
      logMsg(`session ${sessionID} re-distill failed: ${lastError}`);
    } finally {
      // If the distill did not land, preserve the removal signal for the retry.
      if (!succeeded && hadRemoval) removalSince.add(sessionID);
    }
  }

  function handleDeleted(sessionID: string): void {
    if (!ownsLease()) return; // authoritative: this path deletes rows immediately
    const rootId = store.getCard(sessionID)?.rootId;
    store.deleteSession(sessionID);
    bumpCardsRev();
    const timer = debounceTimers.get(sessionID);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(sessionID);
    }
    removalSince.delete(sessionID);
    quarantined.delete(sessionID);
    if (rootId && rootId !== sessionID) recomputeRootRollup(rootId);
  }

  // ── Lease management ──

  function clearTimer(timer: Timer | undefined): void {
    if (timer !== undefined) clearTimeout(timer);
  }

  function scheduleHeartbeat(): void {
    clearTimer(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined;
      if (finalized || !leaseHeld) return;
      if (store.heartbeatLease(instanceId)) scheduleHeartbeat();
      else {
        // Lost the lease (taken over): stop acting as holder and try to regain.
        // Log who took it (build/gen) — the incident was an old build holding the
        // lease forever, invisible until someone hunted processes.
        leaseHeld = false;
        const taker = store.leaseStatus();
        logMsg(
          taker && taker.holder && taker.holder !== instanceId
            ? `lease lost to ${taker.holder} (build ${taker.build || "?"}, gen ${taker.gen})`
            : "lease lost",
        );
        if (!stopped) scheduleLeaseRetry();
      }
    }, HEARTBEAT_MS);
  }

  function scheduleLeaseRetry(): void {
    if (stopped || finalized) return;
    clearTimer(leaseRetryTimer);
    leaseRetryTimer = setTimeout(() => {
      leaseRetryTimer = undefined;
      acquire();
    }, leaseRetryMs);
  }

  function acquire(): void {
    if (stopped) return;
    if (store.acquireLease(instanceId, LEASE_TTL_MS, build, gen)) {
      leaseHeld = true;
      logMsg(`lease acquired (build ${build}, gen ${gen})`);
      scheduleHeartbeat();
      if (limits.coldPass && coldPassState === "idle") void startColdPass();
    } else {
      leaseHeld = false;
      scheduleLeaseRetry();
    }
  }

  function ownsLease(): boolean {
    if (!leaseHeld || finalized) return false;
    // Authoritative check against the live lease row. Ownership is lost only
    // when someone else's name is on the row (a takeover happened) or the row
    // is gone — NOT when our own heartbeat merely looks stale: an expired
    // heartbeat means a rival COULD take over, and heartbeat freshness is the
    // ACQUIRE-side concern of that rival. Self-demoting on staleness would cost
    // a full lease-retry stall after any >TTL event-loop hiccup.
    const current = store.leaseStatus();
    const owned = current?.holder === instanceId;
    if (!owned) {
      leaseHeld = false;
      clearTimer(heartbeatTimer);
      heartbeatTimer = undefined;
      if (!stopped) scheduleLeaseRetry();
    }
    return owned;
  }

  function quiesce(): void {
    if (stopped) return;
    stopped = true;
    clearTimer(leaseRetryTimer);
    clearTimer(coldPassRetryTimer);
    leaseRetryTimer = undefined;
    coldPassRetryTimer = undefined;
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    pendingRerun.clear();
    // Deliberately retain heartbeatTimer: summary worker cleanup is lease-owned
    // and plugin disposal finalizes this distiller only after that cleanup has
    // settled or reached its shutdown bound.
  }

  return {
    start(): void {
      if (stopped) return;
      acquire();
    },

    quiesce,

    ownsLease,

    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      quiesce();
      finalized = true;
      clearTimer(heartbeatTimer);
      clearTimer(leaseRetryTimer);
      clearTimer(coldPassRetryTimer);
      heartbeatTimer = undefined;
      leaseRetryTimer = undefined;
      coldPassRetryTimer = undefined;
      if (leaseHeld) {
        try {
          store.releaseLease(instanceId);
        } catch {
          // Best-effort release; a stale lease is taken over on TTL anyway.
        }
      }
      leaseHeld = false;
      const running = [coldPassPromise, ...inFlight.values()].filter(
        (promise): promise is Promise<void> => promise !== undefined,
      );
      stopPromise = Promise.allSettled(running).then(() => {});
      return stopPromise;
    },

    onEvent(event: Event): void {
      if (stopped) return;
      switch (event.type) {
        case "session.idle":
          scheduleReDistill(event.properties.sessionID);
          break;
        case "session.compacted":
        case "message.removed":
        case "message.part.removed":
          removalSince.add(event.properties.sessionID);
          scheduleReDistill(event.properties.sessionID);
          break;
        case "message.part.updated":
          if (isRemovalShapedPart(event.properties.part)) {
            removalSince.add(event.properties.sessionID);
            scheduleReDistill(event.properties.sessionID);
          }
          break;
        case "session.deleted":
          handleDeleted(event.properties.sessionID);
          break;
        default:
          break; // session.updated + everything else: ignored
      }
    },

    status(): DistillStatus {
      const lease = store.leaseStatus();
      // Report the cached flag: status() must be side-effect-free (ownsLease()
      // mutates lease state and re-arms timers; it is for write gates only).
      return {
        leaseHeld,
        coldPass: coldPassState,
        distilledCount,
        knownCount,
        quarantinedCount: quarantined.size,
        ...(lastError !== undefined ? { lastError } : {}),
        ...(lease ? { lease } : {}),
      };
    },
  };
}
