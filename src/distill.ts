import type { Part } from "@opencode-ai/sdk/v2";
import { errmsg, DISCOVERY_LIMIT, type Limits } from "./types.js";
import { compareMessages, type HistoryMessage, type HistorySession } from "./history/model.js";
import { MalformedSessionError, type HistorySource } from "./history/source.js";
import type { Card, FamilyRollup, LeaseInfo, PartTextRow, Store } from "./store.js";
import type { FetchGate } from "./fetch-gate.js";
import { isSelfToolPart, toolNameMatches, isSummarizerTitle } from "./extract.js";
import { tokenize } from "./normalize.js";
import { extractCodeTokens } from "./query.js";
import {
  isDigestToken,
  isUnavailableText,
  DIGEST_HEAD_CHARS,
  stripSubagentPrefix,
} from "./digest.js";
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
/** Consecutive failed re-distills before an unsettled session stops being
 *  re-read on every poll. */
const MAX_UNSETTLED_FAILURES = 3;
/** Cold passes in a row in which a session's fetch (and its end-of-pass
 *  retry) may fail before the session is skipped. */
const MAX_COLD_PASS_FETCH_FAILURES = 3;
/** Distinct sessions failing in a row that mean an outage rather than a few
 *  bad sessions: the cold pass aborts and retries later. */
const MAX_CONSECUTIVE_FETCH_FAILURES = 5;
/** With `yieldBetween`, long store sweeps pause after this many writes. */
const YIELD_EVERY_WRITES = 50;
/** With `yieldBetween`, a poll's dispatch pauses after this many signals. */
const DISPATCH_YIELD_EVERY = 50;

// ── Shared shapes ────────────────────────────────────────────────────────────

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
  messages: HistoryMessage[];
  /** Known session graph (id → parentId) for root resolution. */
  parentById: Map<string, string | null>;
  caps?: { ftsRowsPerSession?: number; inventoryTokens?: number };
};

/** A card plus the slim-index rows it was derived from; the distiller hands both
 *  to {@link Store.replaceSessionParts}. */
export type DerivedCard = { card: Card; rows: PartTextRow[] };

/** A distiller status as cold-pass progress: only while a pass runs. */
export function coldPassProgress(
  status: DistillStatus,
): { examined: number; known: number } | undefined {
  return status.coldPass === "running"
    ? { examined: status.examinedCount, known: status.knownCount }
    : undefined;
}

export type DistillStatus = {
  leaseHeld: boolean;
  coldPass: "idle" | "running" | "done";
  distilledCount: number;
  knownCount: number;
  /** Sessions the current (or last) cold pass has examined so far: distilled,
   *  up to date, quarantined or skipped. With `knownCount`, the pass's
   *  progress while `coldPass` is "running". */
  examinedCount: number;
  /** Sessions currently sidelined as malformed (see the quarantine mechanism);
   *  observability for "the pass is done but N sessions were skipped". */
  quarantinedCount: number;
  /** Sessions the cold pass skips because their fetch failed in
   *  {@link MAX_COLD_PASS_FETCH_FAILURES} consecutive passes. */
  skippedCount: number;
  /** Sessions whose fetch is currently failing but not yet skipped. */
  failingCount: number;
  lastError?: string;
  /** Current distill-lease holder info (this process or whichever build holds it),
   *  from {@link Store.leaseStatus}. Undefined with no store or no lease row yet —
   *  the one-query answer to "who holds the lease" in a mixed-version store. */
  lease?: LeaseInfo;
};

/**
 * A host-neutral distiller trigger. Each host maps its own event stream onto
 * these (v1: `history/v1-events.ts`):
 * - `turn-ended`: the session went quiet; re-distill it (debounced).
 * - `removal`: content was compacted or removed; the next re-distill must be
 *   full, never an append onto a changed transcript.
 * - `deleted`: the session is gone; drop its card and rows.
 * - `meta`: title/directory/project changed. With a `patch` the card's
 *   metadata is patched in place ({@link Store.patchCardMeta}); without one
 *   the session is re-distilled. The v1 mapper never emits it.
 */
export type DistillSignal =
  | { type: "turn-ended"; sessionID: string }
  | { type: "removal"; sessionID: string }
  | { type: "deleted"; sessionID: string }
  | { type: "meta"; sessionID: string; patch?: SessionMetaPatch };

/** Session metadata a `meta` signal carries. */
export type SessionMetaPatch = { title?: string; directory?: string; projectId?: string };

/** A session's tail as a host sees it before a distill: an opaque cursor the
 *  card stores ({@link Card.distillCursor}), and whether the tail was settled
 *  (no assistant, shell or compaction still running). */
export type DistillCheckpoint = { cursor: string; settled: boolean };

/**
 * How a session changed since a stored checkpoint:
 * - `fresh`: nothing past the checkpoint, and it was settled;
 * - `grown`: rows were appended after it (an append is safe);
 * - `rewritten`: the checkpoint row is gone (revert), changed in place, was
 *   unsettled, or there is no usable checkpoint; only a full distill is safe.
 */
export type TailChange = "fresh" | "grown" | "rewritten";

/** The store's `meta` table as a poll sees it; writes are dropped unless this
 *  process holds the lease. */
export type PollMeta = {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
};

/**
 * Host-side freshness for a host whose events are only a latency hint (v2:
 * `history/v2-sync.ts`). With it the distiller checkpoints each session's
 * tail, trusts a card only while its tail is unchanged, polls for changes
 * while holding the lease, re-reads unsettled tails on every poll, and
 * removes cards whose session no longer exists, at the end of a cold pass
 * and every `reconcileEveryMs` from the poll.
 */
/**
 * One poll's outcome. `commit` persists the watermarks and keyset positions
 * the poll advanced; the distiller calls it only after dispatching `signals`,
 * so anything that stops the poll before dispatch finishes (a throw, a lost
 * lease, a crash) leaves the windows where they were and the next poll
 * re-reads them. Dispatch only schedules debounced re-distills in memory, so
 * a crash after the commit but before those run does lose the signals; the
 * next process's cold pass covers that, since it re-checks every card's tail
 * against opencode.db. A window that failed contributes no signals and
 * nothing to commit, and is named in `failures`; the other window's work
 * stands.
 */
export type PollResult = {
  signals: DistillSignal[];
  commit(): void;
  failures: string[];
};

export type DistillSync = {
  checkpoint(sessionID: string): Promise<DistillCheckpoint | null>;
  compare(sessionID: string, stored: string | null | undefined): Promise<TailChange>;
  /** Of `ids`, those the host no longer has. */
  missing(ids: string[]): Promise<string[]>;
  /** One poll: signals for sessions that changed since its watermarks. */
  poll(meta: PollMeta): Promise<PollResult>;
  readonly pollIntervalMs: number;
  /** How often the lease holder's poll also drops cards of sessions the host
   *  no longer has ({@link DistillSync.missing}); the cold pass does it too. */
  readonly reconcileEveryMs: number;
};

export type Distiller = {
  start(): void;
  /** Stop accepting or scheduling work immediately, but keep renewing an
   *  already-held lease until {@link stop} finalizes the handoff. */
  quiesce(): void;
  /** Whether this instance still owns a live lease, verified against the store. */
  ownsLease(): boolean;
  stop(): Promise<void>;
  onEvent(signal: DistillSignal): void;
  status(): DistillStatus;
};

export type DistillerOptions = {
  source: HistorySource;
  store: Store | null;
  gate: FetchGate;
  limits: Limits;
  instanceId: string;
  log?: (message: string) => void;
  now?: () => number;
  /** Session discovery for the cold pass. Defaults to a project-scope
   *  `source.listSessions({ limit: DISCOVERY_LIMIT })`; the plugin injects a
   *  global-vs-scoped variant. Returns raw session rows (mapped to card metadata
   *  internally); the distiller still routes the call through the fetch gate. */
  discover?: () => Promise<HistorySession[]>;
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
  /** Host-side freshness (v2). Absent on v1, whose behavior it never changes. */
  sync?: DistillSync;
  /** Awaited between sessions and inside long store sweeps, so a large pass
   *  never holds the event loop (v2 shares it with the whole service).
   *  Absent: no extra yields. */
  yieldBetween?: () => Promise<void>;
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
  // (`synthetic` is declared on the SDK's TextPart, so no cast is needed.)
  return (
    part.type === "text" &&
    part.synthetic === true &&
    part.text?.startsWith("<recall-auto>") === true
  );
}

/** The statement text a summary head is drawn from: user/assistant text or a
 *  subtask's description+prompt. Excludes the synthetic recall-auto sentinel
 *  and a history source's placeholder for an unloadable message. */
function statementText(part: Part): string | undefined {
  if (part.type === "text") {
    if (isRecallAutoText(part) || isUnavailableText(part.text)) return undefined;
    return part.text || undefined;
  }
  if (part.type === "subtask") {
    return [part.description, part.prompt].filter(Boolean).join("\n\n") || undefined;
  }
  return undefined;
}

/** The first genuine text part of a message (for the outcome head). */
function firstTextPartText(msg: HistoryMessage): string | undefined {
  for (const part of msg.parts) {
    if (
      part.type === "text" &&
      !isRecallAutoText(part) &&
      !isUnavailableText(part.text) &&
      part.text
    ) {
      return part.text;
    }
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
      if (isSelfToolPart(part)) return [];
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
function createWalker(
  chrono: HistoryMessage[],
  prevForFirst: string | null,
): { step(i: number): void; result(): Walk } {
  const rows: PartTextRow[] = [];
  const files: string[] = [];
  const tools: string[] = [];
  const errors: string[] = [];
  let partCount = 0;
  let firstUserHead = "";
  let lastTextHead = "";

  const step = (i: number): void => {
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
        const head = text ? stripSubagentPrefix(text) : "";
        if (head) {
          firstUserHead = head.slice(0, DIGEST_HEAD_CHARS);
          break;
        }
      }
    }
    const text = firstTextPartText(msg);
    if (text) lastTextHead = text.slice(0, DIGEST_HEAD_CHARS);

    for (const part of msg.parts) {
      if (part.type !== "tool" || isSelfToolPart(part)) continue;
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
  };

  return {
    step,
    result: () => ({
      rows,
      files,
      tools,
      errors,
      partCount,
      firstUserHead,
      lastTextHead,
      newestMessageId: chrono.length ? chrono[chrono.length - 1]!.info.id : null,
    }),
  };
}

function walkMessages(chrono: HistoryMessage[], prevForFirst: string | null): Walk {
  const walker = createWalker(chrono, prevForFirst);
  for (let i = 0; i < chrono.length; i++) walker.step(i);
  return walker.result();
}

/** How often a cooperative derivation yields: every this many messages (the
 *  walk) or rows (the inventory). */
export const DERIVE_YIELD_EVERY = 250;

/** {@link walkMessages}, yielding every {@link DERIVE_YIELD_EVERY} messages.
 *  Same steps in the same order, so the result is identical. */
async function walkMessagesCooperative(
  chrono: HistoryMessage[],
  prevForFirst: string | null,
  pause: () => Promise<void>,
): Promise<Walk> {
  const walker = createWalker(chrono, prevForFirst);
  for (let i = 0; i < chrono.length; i++) {
    if (i > 0 && i % DERIVE_YIELD_EVERY === 0) await pause();
    walker.step(i);
  }
  return walker.result();
}

function sortChronological(messages: HistoryMessage[]): HistoryMessage[] {
  return [...messages].sort(compareMessages);
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
type InventoryCounts = { digest: Map<string, number>; code: Map<string, number> };

function countInventoryRow(counts: InventoryCounts, row: { class: string; raw: string }): void {
  const digestBearing =
    row.class === "human-text" || (row.class === "tool-input" && !row.raw.startsWith("{"));
  if (digestBearing) {
    for (const token of tokenize(row.raw)) {
      if (isDigestToken(token)) counts.digest.set(token, (counts.digest.get(token) ?? 0) + 1);
    }
  }
  for (const token of extractCodeTokens(row.raw)) {
    counts.code.set(token, (counts.code.get(token) ?? 0) + 1);
  }
}

function inventoryFromCounts(counts: InventoryCounts, limit: number): string {
  const byFrequency = (entries: Map<string, number>): string[] =>
    [...entries.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of [...byFrequency(counts.code), ...byFrequency(counts.digest)]) {
    if (out.length >= limit) break;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out.join(" ");
}

function deriveInventory(rows: Array<{ class: string; raw: string }>, limit: number): string {
  const counts: InventoryCounts = { digest: new Map(), code: new Map() };
  for (const row of rows) countInventoryRow(counts, row);
  return inventoryFromCounts(counts, limit);
}

/** {@link deriveInventory}, yielding every {@link DERIVE_YIELD_EVERY} rows. */
async function deriveInventoryCooperative(
  rows: Array<{ class: string; raw: string }>,
  limit: number,
  pause: () => Promise<void>,
): Promise<string> {
  const counts: InventoryCounts = { digest: new Map(), code: new Map() };
  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && i % DERIVE_YIELD_EVERY === 0) await pause();
    countInventoryRow(counts, rows[i]!);
  }
  return inventoryFromCounts(counts, limit);
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
  const caps = deriveCaps(input);
  const chrono = sortChronological(input.messages);
  const walk = walkMessages(chrono, null);
  const rows = capRows(walk.rows, caps.ftsRowsPerSession);
  return assembleCard(input, walk, rows, deriveInventory(rows, caps.inventoryTokens));
}

/**
 * {@link deriveCard} for a caller that must not hold the event loop (the v2
 * host runs inside the shared opencode service): the same steps in the same
 * order, yielding through `pause` after the sort and every
 * {@link DERIVE_YIELD_EVERY} messages or rows, so the card and rows are
 * identical to the synchronous result.
 */
export async function deriveCardCooperative(
  input: DeriveCardInput,
  pause: () => Promise<void>,
): Promise<DerivedCard> {
  const caps = deriveCaps(input);
  const chrono = sortChronological(input.messages);
  await pause();
  const walk = await walkMessagesCooperative(chrono, null, pause);
  const rows = capRows(walk.rows, caps.ftsRowsPerSession);
  await pause();
  const inventory = await deriveInventoryCooperative(rows, caps.inventoryTokens, pause);
  return assembleCard(input, walk, rows, inventory);
}

function deriveCaps(input: DeriveCardInput): {
  ftsRowsPerSession: number;
  inventoryTokens: number;
} {
  return {
    ftsRowsPerSession: input.caps?.ftsRowsPerSession ?? DEFAULT_FTS_ROWS_PER_SESSION,
    inventoryTokens: input.caps?.inventoryTokens ?? DEFAULT_INVENTORY_TOKENS,
  };
}

function assembleCard(
  input: DeriveCardInput,
  walk: Walk,
  rows: PartTextRow[],
  inventory: string,
): DerivedCard {
  const { session, parentById } = input;
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
    inventory,
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

// ── The distiller ────────────────────────────────────────────────────────────

function toMeta(session: HistorySession): DistillSessionMeta {
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

const noopStatus = (): DistillStatus => ({
  leaseHeld: false,
  coldPass: "idle",
  distilledCount: 0,
  knownCount: 0,
  examinedCount: 0,
  quarantinedCount: 0,
  skippedCount: 0,
  failingCount: 0,
});

export function createDistiller(options: DistillerOptions): Distiller {
  const { source, gate, limits, instanceId } = options;

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
  let examinedCount = 0;

  let heartbeatTimer: Timer | undefined;
  let leaseRetryTimer: Timer | undefined;
  let coldPassRetryTimer: Timer | undefined;
  const debounceTimers = new Map<string, Timer>();
  let coldPassPromise: Promise<void> | undefined;
  const inFlight = new Map<string, Promise<void>>();
  const pendingRerun = new Set<string>();
  /** Sync hosts only: sessions waiting for a re-distill slot. A poll can
   *  signal hundreds of sessions at once; at most `distillConcurrency`
   *  re-distills run at a time and the rest wait here, in signal order. */
  const reDistillQueue = new Set<string>();
  /** When the deletions were last reconciled (the cold pass or the poll). */
  let lastReconcileAt = Date.now();
  /** Consecutive failed re-distills of an unsettled session. Past
   *  {@link MAX_UNSETTLED_FAILURES} the session leaves the per-poll re-read
   *  set, so a session that always fails is not retried forever (a later
   *  signal or cold pass still picks it up). */
  const reDistillFailures = new Map<string, number>();
  const reDistillWidth = Math.max(1, Math.floor(limits.distillConcurrency));
  const quarantined = new Map<string, number>();
  /** Consecutive cold passes in which a session's fetch failed with an error
   *  that is not a data-shape one (any error other than MalformedSessionError:
   *  a transport failure, a host error, anything). A failing session no longer
   *  stops the pass: it is set aside, the pass goes on, and it is retried once
   *  at the end. A failed retry counts one strike and asks for a follow-up
   *  pass after `coldPassRetryMs`; at the limit the session is skipped (still
   *  tried by events and later passes). Only several distinct sessions failing
   *  in a row, an outage signal, aborts the pass. FIFO-bounded like the
   *  quarantine. */
  const coldPassFetchFailures = new Map<string, number>();
  let stopPromise: Promise<void> | undefined;
  /** Sessions that saw a removal-shaped event since their last full distill, so
   *  the next re-distill takes the full path rather than appending. */
  const removalSince = new Set<string>();
  const sync = options.sync;
  const pause = options.yieldBetween;
  /** Sessions last distilled against an unsettled tail; every poll re-reads
   *  them even when no new row arrived. */
  const unsettled = new Set<string>();
  let pollTimer: Timer | undefined;

  /** Cancellable inter-page politeness sleep. The timers are tracked so
   *  quiesce() can cancel them: an untracked setTimeout with a long
   *  distillDelayMs would otherwise keep the runtime alive past dispose. A
   *  cancelled sleep resolves immediately; the caller's stopped/lease check
   *  right after it does the actual bail-out. */
  const pageDelayTimers = new Map<Timer, () => void>();
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        pageDelayTimers.delete(timer);
        resolve();
      }, ms);
      pageDelayTimers.set(timer, resolve);
    });
  function cancelPageDelays(): void {
    for (const [timer, resolve] of pageDelayTimers) {
      clearTimeout(timer);
      resolve();
    }
    pageDelayTimers.clear();
  }

  const discover =
    options.discover ??
    (async (): Promise<HistorySession[]> => {
      const listing = await source.listSessions({ scope: "project", limit: DISCOVERY_LIMIT });
      if (!listing.ok) throw new Error(listing.error);
      return listing.items;
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
    const lookup = await gate.runBackground(() => {
      if (stopped || !leaseHeld) return Promise.resolve(null);
      return source.getSession(sessionID, { scope: "project" });
    });
    if (!lookup) return null;
    if (!lookup.ok) {
      // A recognizable not-found (or an empty response) is ABSENCE (session
      // gone → nothing to distill), not a transport failure to retry.
      if (lookup.reason === "not-found") return null;
      if (lookup.reason === "malformed") {
        throw new MalformedSessionError(`session ${sessionID} metadata response was not an object`);
      }
      throw new SessionMetadataTransportError(
        `session ${sessionID} metadata fetch failed: ${lookup.error}`,
      );
    }
    return toMeta(lookup.value);
  }

  /** Page a session newest-first, stopping once `maxRows` human-layer rows have
   *  accrued so a giant session never forces a full fetch (its newest rows win
   *  the per-session cap). */
  async function fetchSessionMessages(
    sessionID: string,
    maxRows: number,
  ): Promise<HistoryMessage[]> {
    const all: HistoryMessage[] = [];
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
        return source.messagePage({ sessionID, limit: pageMessages, before, strict: true });
      });
      try {
        for (const msg of page.items) {
          all.push(msg);
          for (const part of msg.parts) rowCount += distillFields(part).length;
        }
      } catch (error) {
        // Only a TypeError here is a data-shape failure (e.g. `parts` missing
        // on a malformed legacy message); anything else is a code regression
        // that must abort the pass, not quarantine the session. TypeError is a
        // proxy, not a proof — see the accepted-tradeoff note at the cold
        // pass's deriveCard catch for the residual risk this carries.
        if (!(error instanceof TypeError)) throw error;
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
  ): Promise<{ messages: HistoryMessage[]; reached: boolean }> {
    const collected: HistoryMessage[] = [];
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
        return source.messagePage({ sessionID, limit: pageMessages, before, strict: true });
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
        // TypeError only, matching fetchSessionMessages: a data-shape failure
        // (`info` missing on a malformed message) quarantines; anything else
        // is a regression and must surface. Same residual risk as there — see
        // the accepted-tradeoff note at the cold pass's deriveCard catch.
        if (!(error instanceof TypeError)) throw error;
        throw new MalformedSessionError(errmsg(error));
      }
      cursor = reached ? undefined : (page.nextCursor ?? undefined);
    } while (cursor);
    return { messages: collected, reached };
  }

  /**
   * Derive a card for a store write. With `yieldBetween`, the derivation
   * yields before it starts (so it does not share a slice with the fetch and
   * tail read before it) and cooperatively while it runs; callers yield again
   * before the store transaction. The result is identical either way.
   */
  async function derive(input: DeriveCardInput): Promise<DerivedCard> {
    if (!pause) return deriveCard(input);
    await pause();
    return deriveCardCooperative(input, pause);
  }

  /** The session's tail (sync hosts only); see {@link bracketCheckpoint}. */
  async function fetchCheckpoint(sessionID: string): Promise<DistillCheckpoint | null> {
    if (!sync) return null;
    return gate.runBackground(() => {
      if (stopped || !leaseHeld) return Promise.resolve(null);
      return sync.checkpoint(sessionID);
    });
  }

  /**
   * The checkpoint a distill may stamp, given the tail taken BEFORE its fetch.
   * The tail is read again AFTER the fetch; only when both describe the same
   * tail (same newest row, same `time_updated`, same session key, same
   * unsettled state) is the fetched content known to be what the checkpoint
   * describes. If the tail moved during the fetch (a row landed, a streaming
   * row grew), the card is stored with no checkpoint, which the next compare
   * treats as rewritten (a full re-distill), and the session is queued for
   * the next poll. A checkpoint therefore never claims content the distill
   * did not read, and an empty append can never stamp a newer tail over it.
   */
  async function bracketCheckpoint(
    sessionID: string,
    before: DistillCheckpoint | null,
  ): Promise<{ checkpoint: DistillCheckpoint | null; moved: boolean }> {
    if (!sync) return { checkpoint: null, moved: false };
    const after = await fetchCheckpoint(sessionID);
    if (before && after && before.cursor === after.cursor) {
      return { checkpoint: after, moved: false };
    }
    return { checkpoint: null, moved: after !== null };
  }

  async function tailChange(
    sessionID: string,
    stored: string | null | undefined,
  ): Promise<TailChange> {
    if (!sync) return "grown";
    return gate.runBackground(() => {
      if (stopped || !leaseHeld) return Promise.resolve<TailChange>("rewritten");
      return sync.compare(sessionID, stored);
    });
  }

  /** Stamp a derived card with its checkpoint (sync hosts only; v1 cards keep
   *  their exact shape). */
  function withCheckpoint(card: Card, checkpoint: DistillCheckpoint | null): Card {
    return sync ? { ...card, distillCursor: checkpoint?.cursor ?? null } : card;
  }

  function noteSettled(
    sessionID: string,
    checkpoint: DistillCheckpoint | null,
    moved = false,
  ): void {
    if (!sync) return;
    if (moved || (checkpoint && !checkpoint.settled)) unsettled.add(sessionID);
    else unsettled.delete(sessionID);
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

  async function recomputeAllRootRollups(): Promise<void> {
    // One authoritative ownership read for the whole rollup sweep (see
    // recomputeRootRollup); per-row checks would multiply SQLite reads for
    // no additional safety. A host that yields mid-sweep re-checks after each
    // pause instead.
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
    let written = 0;
    let paused = false;
    for (const [rootId, root] of rootCards) {
      const rollup = buildRollup(childrenByRoot.get(rootId) ?? []);
      if (rollup.length > 0 || root.familyRollup.length > 0) {
        if (pause && ++written % YIELD_EVERY_WRITES === 0) {
          await pause();
          if (stopped || !ownsLease()) return;
          paused = true;
        }
        // After a pause a card may have been re-distilled; never write the
        // stale snapshot over it.
        const base = paused ? store.getCard(rootId) : root;
        if (!base) continue;
        store.upsertCard({ ...base, familyRollup: rollup });
        bumpCardsRev();
      }
    }
  }

  // ── Distill one session ──

  async function distillFull(session: DistillSessionMeta): Promise<void> {
    const before = await fetchCheckpoint(session.id);
    const messages = await fetchSessionMessages(session.id, caps.ftsRowsPerSession);
    const { checkpoint, moved } = await bracketCheckpoint(session.id, before);
    // Cheap flag check before parentChainOf touches the store: a detached
    // continuation (the fetch settled after dispose's bounded wait) must not
    // read SQLite, which may already be closed.
    if (stopped || !leaseHeld) return;
    const { card, rows } = await derive({
      session,
      messages,
      parentById: parentChainOf(session),
      caps,
    });
    if (pause) await pause();
    // Authoritative re-check (live lease row, not the cached flag): a process
    // suspended past the TTL can lose the lease to a rival before its heartbeat
    // callback ever runs; the resumed fetch must not replace the new holder's
    // rows. One leaseStatus() read per write batch.
    if (stopped || !ownsLease()) return;
    store.replaceSessionParts(session.id, rows, withCheckpoint(card, checkpoint));
    bumpCardsRev();
    noteSettled(session.id, checkpoint, moved);
  }

  async function distillAppend(session: DistillSessionMeta, oldCard: Card): Promise<void> {
    const checkpoint = oldCard.distilledThrough;
    if (!checkpoint) {
      await distillFull(session);
      return;
    }
    const before = await fetchCheckpoint(session.id);
    const { messages: newMessages, reached } = await fetchNewMessages(session.id, checkpoint);
    const { checkpoint: tail, moved } = await bracketCheckpoint(session.id, before);
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
    if (newMessages.length === 0) {
      // Nothing appended. A sync host still refreshes the card's metadata and
      // checkpoint, or the cold pass would keep finding it stale.
      if (sync) {
        // A title or directory change also changes the embedded text, so the
        // persisted vector is dropped with it (as patchCardMeta does).
        const identityChanged =
          oldCard.title !== session.title || oldCard.directory !== session.directory;
        store.upsertCard(
          withCheckpoint(
            {
              ...oldCard,
              title: session.title,
              directory: session.directory,
              projectId: session.projectId,
              timeUpdated: session.timeUpdated,
              ...(identityChanged && { embedding: null, embeddingGen: null }),
            },
            tail,
          ),
        );
        bumpCardsRev();
        noteSettled(session.id, tail, moved);
      }
      return;
    }

    const chrono = sortChronological(newMessages);
    const walk = walkMessages(chrono, checkpoint);
    const rootId = resolveRootId(session.id, parentChainOf(session));
    const boundary = { checkpointMessageId: checkpoint, firstNewMessageId: chrono[0]!.info.id };

    store.appendSessionParts(session.id, walk.rows, caps.ftsRowsPerSession, boundary, (allRows) =>
      withCheckpoint(
        {
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
        },
        tail,
      ),
    );
    bumpCardsRev();
    noteSettled(session.id, tail, moved);
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
      examinedCount = 0;
      /** Sessions whose fetch failed this pass, retried once at its end. */
      const failedThisPass: DistillSessionMeta[] = [];
      let consecutiveFailures = 0;
      /** Set when an end-of-pass retry failed short of the skip limit. */
      let retryFailure: string | undefined;

      const processSession = async (session: DistillSessionMeta, retry: boolean): Promise<void> => {
        if (stopped || !leaseHeld) return; // paused / lost lease — resume on next start
        // Resume is driven purely by per-card state: a session already at 'full'
        // for its current updated time is skipped. (A watermark fast-skip is
        // unsafe under concurrency > 1 — a slow newer session that fails could be
        // skipped past by faster older ones — so it is deliberately not used.)
        if (pause) {
          await pause();
          if (stopped || !leaseHeld) return;
        }
        const existing = store.getCard(session.id);
        let upToDate =
          existing?.distillState === "full" && existing.timeUpdated === session.timeUpdated;
        // A sync host also needs the tail unchanged: v2 session times do not
        // move on assistant output.
        if (upToDate && sync) {
          upToDate = (await tailChange(session.id, existing?.distillCursor)) === "fresh";
          if (stopped || !leaseHeld) return;
        }
        if (!upToDate) {
          if (quarantined.get(session.id) === session.timeUpdated) {
            examined++;
            examinedCount = examined;
            recordProgress(session.timeUpdated);
            return;
          }

          let messages: HistoryMessage[];
          let checkpoint: DistillCheckpoint | null;
          let moved: boolean;
          try {
            const before = await fetchCheckpoint(session.id);
            messages = await fetchSessionMessages(session.id, caps.ftsRowsPerSession);
            ({ checkpoint, moved } = await bracketCheckpoint(session.id, before));
          } catch (error) {
            // Any error but a data-shape one (MalformedSessionError, below).
            if (!(error instanceof MalformedSessionError)) {
              if (stopped || !leaseHeld) throw error;
              if (!retry) {
                // Several distinct sessions failing in a row is an outage:
                // abort and retry the whole pass later, as before.
                consecutiveFailures++;
                if (consecutiveFailures >= MAX_CONSECUTIVE_FETCH_FAILURES) throw error;
                failedThisPass.push(session);
                return;
              }
              const failures = (coldPassFetchFailures.get(session.id) ?? 0) + 1;
              coldPassFetchFailures.delete(session.id);
              coldPassFetchFailures.set(session.id, failures);
              while (coldPassFetchFailures.size > MAX_QUARANTINED_SESSIONS) {
                const oldest = coldPassFetchFailures.keys().next().value;
                if (oldest === undefined) break;
                coldPassFetchFailures.delete(oldest);
              }
              if (failures < MAX_COLD_PASS_FETCH_FAILURES) {
                retryFailure = `session ${session.id} fetch failed: ${errmsg(error)}`;
                return;
              }
              logMsg(
                `session ${session.id} skipped for this cold pass after ${failures} consecutive fetch failures: ${errmsg(error)}`,
              );
              examined++;
              examinedCount = examined;
              examinedCount = examined;
              recordProgress(session.timeUpdated);
              return;
            }
            quarantine(session, error);
            examined++;
            examinedCount = examined;
            examinedCount = examined;
            recordProgress(session.timeUpdated);
            return;
          }
          consecutiveFailures = 0;
          coldPassFetchFailures.delete(session.id);

          let card: Card;
          let rows: PartTextRow[];
          try {
            ({ card, rows } = await derive({ session, messages, parentById, caps }));
            if (pause) await pause();
          } catch (error) {
            // Quarantine only data-shape failures (mirroring the fetch path
            // above): a TypeError walking malformed legacy parts is this
            // session's problem; anything else is a deriveCard regression that
            // must surface as a pass failure, not silently sideline sessions.
            //
            // ACCEPTED TRADEOFF (referenced by the page-walk catches above):
            // TypeError is a proxy for "malformed data", not a proof. A
            // TypeError REGRESSION in distillFields/deriveCard — a bug of ours
            // that happens to throw TypeError — quarantines sessions while the
            // pass reports "done" instead of aborting. Residual risk accepted
            // because the alternative (annotating every field access to
            // distinguish data-shape from code-bug TypeErrors) is worse;
            // bounded by quarantinedCount observability in status() and the
            // MAX_QUARANTINED_SESSIONS (1000) cap.
            if (!(error instanceof MalformedSessionError) && !(error instanceof TypeError)) {
              throw error;
            }
            quarantine(session, error);
            examined++;
            examinedCount = examined;
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
          store.replaceSessionParts(session.id, rows, withCheckpoint(card, checkpoint));
          bumpCardsRev();
          noteSettled(session.id, checkpoint, moved);
          distilled++;
          distilledCount = distilled; // status counts only sessions actually distilled
        }
        examined++;
        examinedCount = examined;
        examinedCount = examined;
        recordProgress(session.timeUpdated);
      };

      await runPool(sorted, limits.distillConcurrency, (session) => processSession(session, false));
      // Sessions that failed are retried once, now that the rest is indexed.
      for (const session of failedThisPass) {
        if (stopped || !leaseHeld) break;
        await processSession(session, true);
      }

      // Losing the lease (a takeover) or stopping mid-pass must NOT finish the
      // pass or recompute rollups as if complete — leave it idle so the new
      // holder (or a restart) redoes the remainder. Authoritative check: a
      // demoted instance whose rollup recompute silently no-oped must not
      // declare "done" or kick the summarizer.
      if (stopped || !ownsLease()) {
        coldPassState = "idle";
        return;
      }
      if (sync) {
        await reconcileDeletions();
        lastReconcileAt = Date.now();
      }
      if (stopped || !ownsLease()) {
        coldPassState = "idle";
        return;
      }
      await recomputeAllRootRollups();
      if (stopped || !ownsLease()) {
        coldPassState = "idle";
        return;
      }
      coldPassState = "done";
      logMsg(
        `cold pass done (${distilled} distilled / ${examined} examined / ${knownCount} known)`,
      );
      options.onColdPassDone?.();
      if (retryFailure !== undefined) {
        // Some sessions still fail: the rest is indexed, and a follow-up pass
        // (which skips everything up to date) retries them later.
        lastError = retryFailure;
        scheduleFollowUpPass();
      }
    } catch (error) {
      lastError = errmsg(error);
      coldPassState = "idle"; // resumable: per-card skip resumes on the next run
      logMsg(`cold pass aborted: ${lastError}`);
      // A transient failure must not kill the pass for the process lifetime;
      // re-arm on a backoff while we still hold the lease.
      scheduleColdPassRetry();
    }
  }

  /** Drop cards whose session the host no longer has (sync hosts only; safe
   *  because such a store is only ever written from that one source). */
  async function reconcileDeletions(): Promise<void> {
    if (!sync) return;
    const ids = store.cardSessionIds();
    const gone = await gate.runBackground(() => {
      if (stopped || !leaseHeld) return Promise.resolve<string[]>([]);
      return sync.missing(ids);
    });
    let removed = 0;
    for (const id of gone) {
      if (stopped || !leaseHeld) return;
      if (pause && removed > 0 && removed % YIELD_EVERY_WRITES === 0) await pause();
      handleDeleted(id);
      removed++;
    }
    if (removed > 0) logMsg(`removed ${removed} card(s) of deleted sessions`);
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

  /** A later pass for sessions whose fetch failed in a completed pass. */
  function scheduleFollowUpPass(): void {
    if (stopped || !leaseHeld) return;
    clearTimer(coldPassRetryTimer);
    coldPassRetryTimer = setTimeout(() => {
      coldPassRetryTimer = undefined;
      if (stopped || !leaseHeld) return;
      if (coldPassState !== "running") void startColdPass();
    }, coldPassRetryMs);
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
      // Authoritative ownership gate (same as every other distiller store
      // write): this is reached from the quarantine branches and the common
      // up-to-date skip path, all after awaited fetches. Checked only when the
      // floor actually moves, so the hot skip path usually costs nothing extra.
      if (!ownsLease()) return;
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
    // A sync host bounds incremental re-distills (v1 keeps its unbounded,
    // event-paced behavior).
    if (sync && inFlight.size >= reDistillWidth) {
      reDistillQueue.add(sessionID);
      return;
    }
    const running = runReDistill(sessionID).finally(() => {
      inFlight.delete(sessionID);
      if (!stopped && pendingRerun.delete(sessionID)) scheduleReDistill(sessionID);
      drainReDistillQueue();
    });
    inFlight.set(sessionID, running);
  }

  function drainReDistillQueue(): void {
    while (!stopped && leaseHeld && reDistillQueue.size > 0 && inFlight.size < reDistillWidth) {
      const next = reDistillQueue.values().next().value;
      if (next === undefined) return;
      reDistillQueue.delete(next);
      startReDistill(next);
    }
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
        let rewritten = false;
        if (sync && existing) {
          const change = await tailChange(sessionID, existing.distillCursor);
          if (stopped || !leaseHeld) return;
          if (
            change === "fresh" &&
            !hadRemoval &&
            existing.distillState === "full" &&
            existing.timeUpdated === session.timeUpdated &&
            existing.title === session.title &&
            existing.directory === session.directory
          ) {
            succeeded = true; // nothing changed since the card was written
            return;
          }
          rewritten = change === "rewritten";
        }
        const canAppend =
          existing != null &&
          existing.distilledThrough != null &&
          existing.partCount > appendThresholdParts &&
          !hadRemoval &&
          !rewritten;
        if (canAppend && existing) await distillAppend(session, existing);
        else await distillFull(session);
        if (stopped || !leaseHeld) return;
        // Keep the root's family highlights current with its live children.
        const stored = store.getCard(sessionID);
        if (stored && stored.rootId !== sessionID) recomputeRootRollup(stored.rootId);
        succeeded = true;
        reDistillFailures.delete(sessionID);
        options.onSessionDistilled?.(sessionID);
      }
    } catch (error) {
      lastError = errmsg(error);
      logMsg(`session ${sessionID} re-distill failed: ${lastError}`);
      if (unsettled.has(sessionID)) {
        const failures = (reDistillFailures.get(sessionID) ?? 0) + 1;
        if (failures >= MAX_UNSETTLED_FAILURES) {
          unsettled.delete(sessionID);
          reDistillFailures.delete(sessionID);
          logMsg(
            `session ${sessionID} no longer re-read on every poll after ${failures} failed re-distills`,
          );
        } else {
          reDistillFailures.set(sessionID, failures);
        }
      }
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
    unsettled.delete(sessionID);
    reDistillQueue.delete(sessionID);
    reDistillFailures.delete(sessionID);
    if (rootId && rootId !== sessionID) recomputeRootRollup(rootId);
  }

  function handleMeta(sessionID: string, patch: SessionMetaPatch): void {
    if (!ownsLease()) return; // authoritative: this path writes immediately
    // patchCardMeta bumps cards_rev itself; an unknown session has no card to
    // patch and is picked up by the next distill.
    store.patchCardMeta(sessionID, patch);
  }

  // ── Poll (sync hosts) ──

  function schedulePoll(): void {
    if (!sync || stopped || !leaseHeld) return;
    clearTimer(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void runPoll().finally(schedulePoll);
    }, sync.pollIntervalMs);
  }

  async function runPoll(): Promise<void> {
    if (!sync || stopped || !leaseHeld) return;
    const meta: PollMeta = {
      get: (key) => store.getMeta(key),
      set: (key, value) => {
        if (!stopped && ownsLease()) store.setMeta(key, value);
      },
    };
    try {
      const result = await gate.runBackground(() => {
        if (stopped || !leaseHeld) return Promise.resolve<PollResult | null>(null);
        return sync.poll(meta);
      });
      if (!result || stopped || !leaseHeld) return;
      // Metadata signals each run a patchCardMeta transaction: yield every
      // DISPATCH_YIELD_EVERY so a large session scan cannot hold the loop.
      for (let i = 0; i < result.signals.length; i++) {
        if (pause && i > 0 && i % DISPATCH_YIELD_EVERY === 0) {
          await pause();
          // Stopped or demoted mid-dispatch: commit nothing, re-read next time.
          if (stopped || !leaseHeld) return;
        }
        dispatch(result.signals[i]!);
      }
      // Only now that every signal is dispatched may the windows move on.
      result.commit();
      for (const failure of result.failures) {
        lastError = failure;
        logMsg(`poll failed: ${failure}`);
      }
      // Unsettled tails are re-read even when no row arrived.
      for (const sessionID of unsettled) scheduleReDistill(sessionID);
      // Deletions made with no event (or while no process held the lease)
      // are caught on a slow cadence, not only by the next cold pass. A
      // running cold pass reconciles on its own at its end.
      if (coldPassState !== "running" && Date.now() - lastReconcileAt >= sync.reconcileEveryMs) {
        lastReconcileAt = Date.now();
        await reconcileDeletions();
      }
    } catch (error) {
      lastError = errmsg(error);
      logMsg(`poll failed: ${lastError}`);
    }
  }

  function dispatch(signal: DistillSignal): void {
    switch (signal.type) {
      case "turn-ended":
        scheduleReDistill(signal.sessionID);
        break;
      case "meta":
        if (signal.patch) handleMeta(signal.sessionID, signal.patch);
        else scheduleReDistill(signal.sessionID);
        break;
      case "removal":
        removalSince.add(signal.sessionID);
        scheduleReDistill(signal.sessionID);
        break;
      case "deleted":
        handleDeleted(signal.sessionID);
        break;
    }
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
        clearTimer(pollTimer);
        pollTimer = undefined;
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
      schedulePoll();
      // Re-distills queued when the lease was lost resume now, not only when
      // some later re-distill finishes.
      drainReDistillQueue();
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
      clearTimer(pollTimer);
      pollTimer = undefined;
      if (!stopped) scheduleLeaseRetry();
    }
    return owned;
  }

  function quiesce(): void {
    if (stopped) return;
    stopped = true;
    clearTimer(leaseRetryTimer);
    clearTimer(coldPassRetryTimer);
    clearTimer(pollTimer);
    leaseRetryTimer = undefined;
    coldPassRetryTimer = undefined;
    pollTimer = undefined;
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    pendingRerun.clear();
    reDistillQueue.clear();
    // Wake any inter-page politeness sleep immediately: with a long
    // distillDelayMs those timers would otherwise keep the runtime alive past
    // dispose. The woken fetch loop bails on its stopped check.
    cancelPageDelays();
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

    onEvent(signal: DistillSignal): void {
      if (stopped) return;
      dispatch(signal);
    },

    status(): DistillStatus {
      const lease = store.leaseStatus();
      // Derive leaseHeld from the lease row already read for the `lease` field:
      // authoritative AND side-effect-free (unlike ownsLease(), which mutates
      // lease state and re-arms timers — that one is for write gates only), and
      // no extra SQLite read. `leaseHeld &&` keeps a released/finalized
      // instance reporting false even if the row still names it briefly.
      return {
        leaseHeld: leaseHeld && lease?.holder === instanceId,
        coldPass: coldPassState,
        distilledCount,
        knownCount,
        examinedCount,
        quarantinedCount: quarantined.size,
        skippedCount: [...coldPassFetchFailures.values()].filter(
          (n) => n >= MAX_COLD_PASS_FETCH_FAILURES,
        ).length,
        failingCount: [...coldPassFetchFailures.values()].filter(
          (n) => n < MAX_COLD_PASS_FETCH_FAILURES,
        ).length,
        ...(lastError !== undefined ? { lastError } : {}),
        ...(lease ? { lease } : {}),
      };
    },
  };
}
