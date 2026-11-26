import type { Part } from "@opencode-ai/sdk/v2";
import { errmsg, DISCOVERY_LIMIT, type IndexingProgress, type Limits } from "./types.js";
import { compareMessages, type HistoryMessage, type HistorySession } from "./history/model.js";
import {
  addReadCounts,
  emptyReadCounts,
  MalformedSessionError,
  type HistoryReadCounts,
  type HistorySource,
  type MessagePage,
} from "./history/source.js";
import type {
  Card,
  CardWrite,
  FamilyRollup,
  LeaseInfo,
  PartTextRow,
  RangeHash,
  SettledBase,
  Store,
} from "./store.js";
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
import { cyrb53 } from "./hash.js";

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
 *  bad sessions: the cold pass aborts and retries later. Only sessions with
 *  no strike yet count: a known-bad session is not evidence of an outage.
 *
 *  Small-corpus edge: with fewer sessions than this (four or fewer), an
 *  outage that fails only message fetches (discovery still works) never
 *  reads as one.
 *  Every session then takes a strike per pass and is skipped after
 *  {@link MAX_COLD_PASS_FETCH_FAILURES} passes. Skipping is not permanent: a
 *  later pass still fetches it once, and any change re-distills it. */
const MAX_CONSECUTIVE_FETCH_FAILURES = 5;
/** Sessions a pass sets aside for its end-of-pass retry; failures past this
 *  take a strike without a retry and wait for the follow-up pass. */
const MAX_RETRY_SET = 200;
/** End-of-pass retries failing in a row before the rest of the retry set
 *  takes a strike without being fetched again. */
const MAX_CONSECUTIVE_RETRY_FAILURES = 5;
/** An end-of-pass retry that failed (its strike is already recorded). */
class RetryFailed extends Error {
  constructor() {
    super("end-of-pass retry failed");
  }
}

/** Rows one range hash covers at most: one {@link DistillSync.rangeDigest}
 *  read. */
const RANGE_ROWS = 500;
/** A `seq` below every history row's (they are non-negative). */
const BEFORE_FIRST_SEQ = -1;
/** Cards the range check looks at, at most, per poll while it searches for
 *  one it may check. With the one digest it reads, this is its budget. */
const RECONCILE_SCAN_LIMIT = 64;

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
  /** When the session was archived; absent or null when it is not. */
  timeArchived?: number | null;
};

export type DeriveCardInput = {
  session: DistillSessionMeta;
  /** The session's messages, any order (sorted chronologically internally). */
  messages: HistoryMessage[];
  /** Known session graph (id → parentId) for root resolution. */
  parentById: Map<string, string | null>;
  caps?: { ftsRowsPerSession?: number; inventoryTokens?: number };
  /** The boundary of a running tail: with it, the derivation also returns
   *  the card's settled base, the share of the messages whose `seq` is at
   *  most this. Only messages that all carry a `seq` (v2) can be split. */
  settledThrough?: number;
};

/** A card plus the slim-index rows it was derived from; the distiller hands both
 *  to {@link Store.replaceSessionParts}. `settledBase` is set when
 *  {@link DeriveCardInput.settledThrough} was given and the messages could be
 *  split there. */
export type DerivedCard = { card: Card; rows: PartTextRow[]; settledBase?: SettledBase };

/** Meta key stamped `"1"` when a cold pass first completes on a store. A
 *  rebuild drops `meta`, so a rebuilt store starts without it. */
export const COLD_PASS_COMPLETE_KEY = "coldpass_complete";
/** Meta key where the lease holder shares its running cold pass's progress,
 *  as JSON `{ examined, known, at }`, so every process sharing the store can
 *  report it (see {@link Distiller.indexing}). */
export const COLD_PASS_PROGRESS_KEY = "coldpass_progress";
/** The holder writes {@link COLD_PASS_PROGRESS_KEY} at most this often. */
export const PROGRESS_WRITE_MS = 2_000;
/** Meta key where the lease holder records whether its last session
 *  discovery stopped at its limit (`"1"`, else `"0"`), so every process
 *  sharing the store can report it (see {@link Distiller.discoveryTruncated}). */
export const DISCOVERY_TRUNCATED_KEY = "discovery_truncated";
/** A completed pass that leaves sessions skipped arms another pass after
 *  `coldPassRetryMs` times this, doubling with each consecutive pass that
 *  indexes none of them, up to {@link SKIPPED_RETRY_MAX_FACTOR} (10 minutes
 *  growing to 1 hour by default). It repeats until the skipped sessions heal,
 *  are deleted or leave discovery, so a host-wide fetch outage that skipped
 *  everything recovers once the host heals. Progress (a skipped session
 *  fetched, or a pass ending with none skipped) resets it to the base. */
const SKIPPED_RETRY_FACTOR = 10;
const SKIPPED_RETRY_MAX_FACTOR = 60;
/** Skipped sessions a pass logs one line each for; the rest are counted in
 *  one line at the end of the pass. */
const SKIP_LOG_LIMIT = 3;
/** Shared progress older than this is not a pass in progress: the store gap
 *  is reported instead (`stalled`). The holder refreshes it at least every
 *  heartbeat while a pass runs. */
export const PROGRESS_STALE_MS = 5 * 60_000;

/** Meta key where the lease holder shares the repair sweep's progress
 *  ({@link RepairProgress}, as JSON), so every process can report it. */
export const REPAIR_PROGRESS_KEY = "repair_progress";
/** Meta key naming the projector generation the stored repair reasons were
 *  recorded under. A distiller at a higher generation clears them before it
 *  records its first reason or runs its first sweep, so every card a previous
 *  generation could not repair is tried again and no reason recorded at the
 *  current generation is lost. */
export const REPAIR_GEN_KEY = "repair_gen";

/** The repair sweep's progress: it rebuilds every card below the projector
 *  generation (see {@link Store.staleCards}). */
export type RepairProgress = {
  /** Stale cards not yet rebuilt or marked repair-pending (at the end of a
   *  sweep: the store's stale cards, counted again). */
  pending: number;
  /** Cards with a repair reason, which the sweep leaves alone. */
  repairPending: number;
  /** Cards the running (or last) sweep rebuilt. */
  done: number;
  /** The projector generation the sweep rebuilds to. */
  gen: number;
  /** When this was shared. */
  at: number;
  /** Whether a sweep is running. A running sweep's holder refreshes `at` at
   *  least every heartbeat; {@link Distiller.repair} reports one whose `at`
   *  is older than {@link PROGRESS_STALE_MS} as `stalled` instead. */
  running: boolean;
  stalled?: true;
};

/** Parse a {@link REPAIR_PROGRESS_KEY} value; undefined when malformed. */
export function parseRepairProgress(raw: string | undefined): RepairProgress | undefined {
  if (!raw) return undefined;
  try {
    const { pending, repairPending, done, gen, at, running } = JSON.parse(raw) as Record<
      string,
      unknown
    >;
    if (
      !finite(pending) ||
      !finite(repairPending) ||
      !finite(done) ||
      !finite(gen) ||
      !finite(at) ||
      typeof running !== "boolean"
    ) {
      return undefined;
    }
    return { pending, repairPending, done, gen, at, running };
  } catch {
    return undefined;
  }
}

/** What a distiller reports about card repair ({@link Distiller.repair}). */
export type RepairStatus = {
  sweep?: RepairProgress;
  reconcile?: ReconcileProgress;
};

/** Meta key where the lease holder keeps the range check's position and
 *  counters ({@link ReconcileProgress}, as JSON), so the check resumes where
 *  it stopped after a restart or a lease handoff and every process can report
 *  it. */
export const RECONCILE_PROGRESS_KEY = "reconcile_progress";

/**
 * The range check's state. It walks every eligible card in session id order,
 * one range per poll; a walk over all of them is a sweep.
 */
export type ReconcileProgress = {
  /** Completed sweeps. Range hashes record this value as their `sweepGen`
   *  when written, and again when a check confirms them. */
  sweep: number;
  /** The oldest unchecked range of the running sweep: the card being
   *  walked (null at the start of a sweep) and the `seq` after which its
   *  next range starts (null at the start of the card). */
  session: string | null;
  after: number | null;
  /** When the running sweep started. */
  startedAt: number;
  /** When the previous sweep started, null before one completes. Every
   *  range the running sweep has not reached was checked or recorded no
   *  earlier than this, so it bounds how long a change only this check can
   *  find waits. */
  previousStartedAt: number | null;
  /** Ranges checked, and those that did not match (each dispatched a full
   *  re-index), in the running sweep. */
  checked: number;
  mismatched: number;
  /** When the last range was checked (0 before the first). */
  at: number;
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Parse a {@link RECONCILE_PROGRESS_KEY} value; undefined when malformed. */
export function parseReconcileProgress(raw: string | undefined): ReconcileProgress | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const { sweep, session, after, startedAt, previousStartedAt, checked, mismatched, at } = v;
    if (
      !finite(sweep) ||
      !(session === null || typeof session === "string") ||
      !(after === null || finite(after)) ||
      !finite(startedAt) ||
      !(previousStartedAt === null || finite(previousStartedAt)) ||
      !finite(checked) ||
      !finite(mismatched) ||
      !finite(at)
    ) {
      return undefined;
    }
    return { sweep, session, after, startedAt, previousStartedAt, checked, mismatched, at };
  } catch {
    return undefined;
  }
}

/** Parse a {@link COLD_PASS_PROGRESS_KEY} value; undefined when malformed.
 *  `running: false` means the pass that wrote it ended without completing
 *  the store and no pass is running (older values carry no flag). */
function parseSharedProgress(
  raw: string | undefined,
): { examined: number; known: number; at: number; running: boolean } | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const { examined, known, at, running } = value;
    return typeof examined === "number" &&
      Number.isFinite(examined) &&
      typeof known === "number" &&
      Number.isFinite(known) &&
      typeof at === "number" &&
      Number.isFinite(at)
      ? { examined, known, at, running: running !== false }
      : undefined;
  } catch {
    return undefined;
  }
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
 * - `meta`: title, directory, project or archive state changed. With a
 *   `patch` the card's metadata is patched in place
 *   ({@link Store.patchCardMeta}); without one the session is re-distilled.
 */
export type DistillSignal =
  | { type: "turn-ended"; sessionID: string }
  | { type: "removal"; sessionID: string }
  | { type: "deleted"; sessionID: string }
  | { type: "meta"; sessionID: string; patch?: SessionMetaPatch };

/** Session metadata a `meta` signal carries. `timeArchived` is null for a
 *  session that is not archived; absent, the archive state is left as it
 *  is. */
export type SessionMetaPatch = {
  title?: string;
  directory?: string;
  projectId?: string;
  timeArchived?: number | null;
};

/** A session's tail as a host sees it before a distill: an opaque cursor the
 *  card stores ({@link Card.distillCursor}), and whether the tail was settled
 *  (no assistant, shell or compaction still running). */
export type DistillCheckpoint = { cursor: string; settled: boolean };

/**
 * How a session changed since a stored checkpoint:
 * - `fresh`: nothing past the checkpoint, and it was settled;
 * - `grown`: rows were appended after it (an append is safe);
 * - `tail`: the checkpoint was unsettled, and every row through its boundary
 *   (the newest settled row below the running ones) is unchanged; the rows
 *   past the boundary may have changed in any way, so they alone are read
 *   again ({@link Card.settledBase});
 * - `rewritten`: the checkpoint row is gone (revert), changed in place, was
 *   unsettled with no boundary or a changed one, or there is no usable
 *   checkpoint; only a full distill is safe.
 */
export type TailChange = "fresh" | "grown" | "tail" | "rewritten";

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
  /**
   * A session's rows after `afterSeq`, ascending by `seq`, at most `limit`,
   * each with the state of its part rows. Fewer than `limit` rows means the
   * session ends there, so a caller never asks for more than the host's cap
   * (500 on v2). The range hashes and the range check are built from these.
   * Absent: the host keeps no range hashes.
   */
  rangeDigest?(sessionID: string, afterSeq: number, limit: number): Promise<RangeRow[]>;
  /** Of `sessionIDs`, those with part rows. */
  withParts?(sessionIDs: string[]): Promise<Set<string>>;
  /** A message's `seq`, or null when the session has no such message. */
  seqOf?(sessionID: string, messageID: string): Promise<number | null>;
  /** What a stored checkpoint records, or null when it is not one. */
  inspect?(cursor: string | null | undefined): CheckpointInfo | null;
  /** `cursor` with what a write learned recorded in it: the lowest `seq` it
   *  read when it stopped at the row cap, and the messages it left cut. */
  annotate?(cursor: string, info: { floor?: number; cut?: number }): string;
};

/** One history row as {@link DistillSync.rangeDigest} reads it. */
export type RangeRow = {
  seq: number;
  id: string;
  timeUpdated: number;
  /** Part rows of the message, their newest `time_updated` (0 when none)
   *  and their distinct types, sorted. */
  parts: number;
  partsUpdated: number;
  partTypes: string[];
};

/** What a stored checkpoint records ({@link DistillSync.inspect}). */
export type CheckpointInfo = {
  /** Format version. Version 1 is an older build's and makes the card
   *  stale. */
  version: number;
  /** `seq` of the newest row the checkpoint describes. */
  seq: number;
  /** Whether the tail was settled when the checkpoint was taken. */
  settled: boolean;
  /** For an unsettled checkpoint, the `seq` of the newest settled row below
   *  the running ones, when the checkpoint recorded one. */
  boundary?: number;
  /** The lowest `seq` the card's last full write read, when it stopped at
   *  the per-session row cap; rows below it are not in the card. */
  floor?: number;
  /** Messages the card holds cut short: each ends in a placeholder that says
   *  what was left out, and nothing past it is indexed. */
  cut?: number;
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
  /**
   * The cold pass's progress, for queries to report, while the store is
   * really incomplete: no pass has ever completed on this store
   * ({@link COLD_PASS_COMPLETE_KEY}) and more sessions are known than the
   * store has cards (`indexed`). Undefined otherwise, so a re-verify pass over a complete
   * store on every restart reports nothing.
   *
   * The lease holder with a pass running reports its own counts (while it is
   * still discovering: only while the store has no card at all). Every other
   * process, and a holder whose pass aborted and waits for its retry, reads
   * the progress the holder shares in {@link COLD_PASS_PROGRESS_KEY}; when
   * that is older than {@link PROGRESS_STALE_MS} nothing is indexing, and the
   * store gap is reported as `stalled`.
   * Query-path cost: in-memory state, up to two meta reads and one card
   * count; no lease read and no map scan.
   */
  indexing(): IndexingProgress | undefined;
  /**
   * The repair sweep's and the range check's progress, as the lease holder
   * shares them in meta, so every process reports the same. Undefined when
   * the host stamps no projector generation (neither runs). Query-path cost:
   * two meta reads.
   */
  repair(): RepairStatus | undefined;
  /**
   * Whether the lease holder's last session discovery stopped at its limit,
   * so older sessions may be missing from the store, as the holder records
   * it in {@link DISCOVERY_TRUNCATED_KEY}; false before any discovery and
   * without a store. Query-path cost: one meta read.
   */
  discoveryTruncated(): boolean;
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
  /** Whether the last {@link discover} call stopped at its limit, read right
   *  after each discovery and recorded in {@link DISCOVERY_TRUNCATED_KEY}.
   *  The default discovery reports its own listing's `truncated`; with an
   *  injected `discover` and no reader, nothing is recorded. */
  discoveryTruncated?: () => boolean;
  /** Plugin build tag recorded in the distill-lease value for cross-process
   *  diagnosis (see the plugin entry). Defaults to `"unknown"`. */
  build?: string;
  /** Representation generation recorded in the distill-lease value
   *  ({@link import("./embedding-text.js").EMBED_REPRESENTATION}). Defaults to 0. */
  gen?: number;
  /**
   * The host's history projector generation, stamped on every card this
   * distiller writes in full ({@link Card.projectorGen}). Only a host that
   * versions its projection passes one (v2). With it, and with a `sync`
   * that reads range digests, the distiller also records range hashes on
   * every write, repairs stale cards in a sweep after each cold pass and
   * checks one range per poll for changes no poll window sees. Absent: none
   * of that runs.
   */
  projectorGen?: number;
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

/** Slim-index rows a message contributes. */
function rowsOf(msg: HistoryMessage): number {
  let rows = 0;
  for (const part of msg.parts) rows += distillFields(part).length;
  return rows;
}

/** What one distiller read of a session returned. */
type SessionRead = {
  messages: HistoryMessage[];
  /** Messages still cut short once their continuations were followed. */
  cut: number;
  /** What the read's pages could not project faithfully, summed. */
  counts: HistoryReadCounts;
  /** The lowest `seq` read, when the read stopped at the per-session row cap
   *  with older messages left. */
  floor?: number;
};

/** A session's rows as a write digested them before its read, in groups of
 *  one digest read each, and the range-check sweep current at the time. */
type Digest = { groups: RangeRow[][]; sweepGen: number };

/**
 * Why a read's projection is known to have lost content, or undefined: part
 * rows of a type the projector does not read (every assistant content type
 * carries content), or completed assistant messages that projected nothing
 * although part rows were read for them.
 */
function lossOf(counts: HistoryReadCounts): string | undefined {
  const found: string[] = [];
  if (counts.unknownPartTypes > 0) {
    found.push(`${counts.unknownPartTypes} part rows of unknown types`);
  }
  if (counts.emptyWithParts > 0) {
    found.push(`${counts.emptyWithParts} completed assistant messages empty despite part rows`);
  }
  return found.length > 0 ? `projection lost content: ${found.join(", ")}` : undefined;
}

/** The hash a range of rows is recorded and checked under. */
function rangeHashOf(rows: RangeRow[]): string {
  return cyrb53(
    rows
      .map(
        (r) =>
          `${r.seq}\t${r.id}\t${r.timeUpdated}\t${r.parts}\t${r.partsUpdated}\t${r.partTypes.join(",")}`,
      )
      .join("\n"),
  );
}

/** What one range check found ({@link compareSpans}). */
type SpanCheck = {
  /** Stored spans the read holds in full and that still match. */
  confirmed: RangeHash[];
  /** The `seq` through which the card is now checked. */
  verified: number;
  /** Whether everything through the checkpoint is checked. */
  done: boolean;
  /** The first difference: where it starts and what it is. */
  mismatch?: { seq: number; reason: string };
};

/**
 * Compare one digest read with a card's stored range hashes. `rows` are the
 * session's rows after `start` in `seq` order, at most {@link RANGE_ROWS}, a
 * shorter read meaning the session ends there; `end` is the checkpoint's
 * `seq`. The stored spans are walked by their recorded boundaries from
 * `start` towards `end`, and each must hold exactly the rows it recorded:
 * rows gone from a span (a whole span deleted included), a changed row, a row
 * outside every span, or a span that starts at or below `start` (one that
 * covers rows below the card's floor) is a mismatch. The walk stops at a
 * span the read does not reach, to go on from `verified` next time.
 */
function compareSpans(rows: RangeRow[], spans: RangeHash[], start: number, end: number): SpanCheck {
  const complete = rows.length < RANGE_ROWS;
  const lastRead = rows.length > 0 ? rows[rows.length - 1]!.seq : start;
  const confirmed: RangeHash[] = [];
  let verified = start;
  let k = 0;
  const differ = (seq: number, reason: string): SpanCheck => ({
    confirmed,
    verified,
    done: false,
    mismatch: { seq, reason },
  });
  for (const span of spans) {
    if (span.endSeq <= start) continue;
    if (span.startSeq > end) break;
    if (span.startSeq <= start) return differ(span.startSeq, "hash starts below the floor");
    const next = rows[k];
    if (next && next.seq < span.startSeq) return differ(next.seq, "no stored hash");
    if (span.endSeq > lastRead && !complete) {
      // A span holds at most one read's rows, so only rows added inside it
      // can keep the first one out of reach.
      if (confirmed.length === 0) return differ(span.startSeq, "hash differs");
      return { confirmed, verified, done: false };
    }
    const inSpan: RangeRow[] = [];
    while (k < rows.length && rows[k]!.seq <= span.endSeq) inSpan.push(rows[k++]!);
    if (inSpan.length < span.rowCount) return differ(span.startSeq, "rows missing");
    if (inSpan.length > span.rowCount || rangeHashOf(inSpan) !== span.hash) {
      return differ(span.startSeq, "hash differs");
    }
    confirmed.push(span);
    verified = span.endSeq;
    if (verified >= end) return { confirmed, verified, done: true };
  }
  const unhashed = rows[k];
  if (unhashed && unhashed.seq <= end) return differ(unhashed.seq, "no stored hash");
  return { confirmed, verified, done: complete || lastRead >= end };
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
  /** Walked messages still cut short. */
  cut: number;
  /** The walk's state at the split it was given ({@link splitAt}). */
  prefix?: WalkPrefix;
};

/** What a run of messages contributes to a card's aggregates, the lists
 *  capped as the card stores them. */
type CardAggregates = Pick<
  Card,
  "partCount" | "summaryHead" | "outcomeHead" | "files" | "tools" | "errors"
>;

/** A walk's state after its first messages. */
type WalkPrefix = {
  aggregates: CardAggregates;
  /** Slim-index rows those messages produced. */
  rows: number;
  /** The last of them, or null when there were none. */
  newestMessageId: string | null;
  /** Those of them still cut short. */
  cut: number;
};

/** A walk's (or a prefix's) aggregates, its lists capped as a card stores
 *  them. */
function aggregatesOf(walk: {
  partCount: number;
  firstUserHead: string;
  lastTextHead: string;
  files: string[];
  tools: string[];
  errors: string[];
}): CardAggregates {
  return {
    partCount: walk.partCount,
    summaryHead: walk.firstUserHead,
    outcomeHead: walk.lastTextHead,
    files: mergeKeepLast([], walk.files, FILES_CAP),
    tools: mergeKeepFirst([], walk.tools, TOOLS_CAP),
    errors: mergeKeepFirst([], walk.errors, ERRORS_CAP),
  };
}

/**
 * The aggregates of older messages followed by newer ones: what one walk
 * over both gives. Merging the capped lists gives the same lists as merging
 * the whole ones: the newest files and the first tools and errors that
 * survive the cap all come from the capped lists.
 */
function mergeAggregates(older: CardAggregates, newer: CardAggregates): CardAggregates {
  return {
    partCount: older.partCount + newer.partCount,
    summaryHead: older.summaryHead || newer.summaryHead,
    outcomeHead: newer.outcomeHead || older.outcomeHead,
    files: mergeKeepLast(older.files, newer.files, FILES_CAP),
    tools: mergeKeepFirst(older.tools, newer.tools, TOOLS_CAP),
    errors: mergeKeepFirst(older.errors, newer.errors, ERRORS_CAP),
  };
}

/**
 * The index of the first message in `chrono` past `boundary`: the messages
 * before it make up the settled prefix. Undefined without a boundary, or when
 * a message carries no `seq` (only v2 messages do, and `chrono` is in `seq`
 * order when they all do).
 */
function splitAt(chrono: HistoryMessage[], boundary: number | undefined): number | undefined {
  if (boundary === undefined) return undefined;
  let split = 0;
  for (const msg of chrono) {
    const seq = msg.info.seq;
    if (typeof seq !== "number") return undefined;
    if (seq <= boundary) split++;
  }
  return split;
}

/**
 * Single chronological walk producing the FTS rows and every streaming-derived
 * card contribution. `prevForFirst` is the message id preceding the first walked
 * message (the checkpoint, when appending) so drill neighbor ids stay correct.
 */
function createWalker(
  chrono: HistoryMessage[],
  prevForFirst: string | null,
): { step(i: number): void; snapshot(): WalkPrefix; result(): Walk } {
  const rows: PartTextRow[] = [];
  const files: string[] = [];
  const tools: string[] = [];
  const errors: string[] = [];
  let partCount = 0;
  let firstUserHead = "";
  let lastTextHead = "";
  let cut = 0;
  let walked: string | null = null;

  const step = (i: number): void => {
    const msg = chrono[i]!;
    const prevMessageId = i === 0 ? prevForFirst : chrono[i - 1]!.info.id;
    const nextMessageId = i === chrono.length - 1 ? null : chrono[i + 1]!.info.id;
    partCount += msg.parts.length;
    if (msg.partial) cut++;
    walked = msg.info.id;

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
    snapshot: () => ({
      aggregates: aggregatesOf({ partCount, firstUserHead, lastTextHead, files, tools, errors }),
      rows: rows.length,
      newestMessageId: walked,
      cut,
    }),
    result: () => ({
      rows,
      files,
      tools,
      errors,
      partCount,
      firstUserHead,
      lastTextHead,
      newestMessageId: chrono.length ? chrono[chrono.length - 1]!.info.id : null,
      cut,
    }),
  };
}

/** Walk `chrono`, also taking the walk's state ({@link Walk.prefix}) after
 *  its first `split` messages when a split is given. */
function walkMessages(chrono: HistoryMessage[], prevForFirst: string | null, split?: number): Walk {
  const walker = createWalker(chrono, prevForFirst);
  let prefix: WalkPrefix | undefined;
  for (let i = 0; i < chrono.length; i++) {
    if (i === split) prefix = walker.snapshot();
    walker.step(i);
  }
  if (split === chrono.length) prefix = walker.snapshot();
  return prefix ? { ...walker.result(), prefix } : walker.result();
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
  split?: number,
): Promise<Walk> {
  const walker = createWalker(chrono, prevForFirst);
  let prefix: WalkPrefix | undefined;
  for (let i = 0; i < chrono.length; i++) {
    if (i > 0 && i % DERIVE_YIELD_EVERY === 0) await pause();
    if (i === split) prefix = walker.snapshot();
    walker.step(i);
  }
  if (split === chrono.length) prefix = walker.snapshot();
  return prefix ? { ...walker.result(), prefix } : walker.result();
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
  const walk = walkMessages(chrono, null, splitAt(chrono, input.settledThrough));
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
  const walk = await walkMessagesCooperative(
    chrono,
    null,
    pause,
    splitAt(chrono, input.settledThrough),
  );
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
  const card = buildCard(
    session,
    resolveRootId(session.id, parentById),
    aggregatesOf(walk),
    rows,
    inventory,
    walk.newestMessageId,
    [],
  );
  const settledBase =
    input.settledThrough === undefined || !walk.prefix
      ? undefined
      : settledBaseOf(
          input.settledThrough,
          walk.prefix,
          rows.length - (walk.rows.length - walk.prefix.rows),
        );
  return settledBase ? { card, rows, settledBase } : { card, rows };
}

/**
 * A settled base at `boundary` from the walk state of the messages through
 * it, holding `rows` of the stored rows: those left of the rows its messages
 * produced once the tail's rows took their place under the row cap. Undefined
 * when the tail's rows alone did not fit.
 */
function settledBaseOf(
  boundary: number,
  prefix: WalkPrefix,
  rows: number,
): SettledBase | undefined {
  if (rows < 0) return undefined;
  return {
    seq: boundary,
    messageId: prefix.newestMessageId,
    rows,
    ...prefix.aggregates,
    cut: prefix.cut,
  };
}

/**
 * A card with the session's metadata, the aggregates of its messages and the
 * slim-index rows it keeps. Every card write builds its card here, so a full
 * derivation, an append and a tail write of the same messages agree.
 */
function buildCard(
  session: DistillSessionMeta,
  rootId: string,
  aggregates: CardAggregates,
  rows: PartTextRow[],
  inventory: string,
  distilledThrough: string | null,
  familyRollup: FamilyRollup[],
): Card {
  return {
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
    partCount: aggregates.partCount,
    retainedChars: rows.reduce((sum, row) => sum + row.raw.length, 0),
    summaryHead: aggregates.summaryHead,
    outcomeHead: aggregates.outcomeHead,
    inventory,
    files: aggregates.files,
    tools: aggregates.tools,
    errors: aggregates.errors,
    // Store-owned: a card write keeps the stored rollup, so this applies only
    // to a first insert.
    familyRollup,
    distillState: "full",
    distilledThrough,
    // A write that changes the card stores a null vector, which the
    // semantic layer recomputes on the next load; a suppressed write keeps
    // the stored one.
    embedding: null,
    embeddingGen: null,
    // Summaries are owned by the summarizer's separate write path; these
    // defaults apply only on a brand-new insert (the card upsert preserves any
    // existing summary across re-distills).
    nlSummary: "",
    summaryHash: "",
    // A card write stores this over the stored value, so it always comes
    // from the session.
    ...(session.timeArchived != null && { timeArchived: session.timeArchived }),
  };
}

// ── The distiller ────────────────────────────────────────────────────────────

function toMeta(session: HistorySession): DistillSessionMeta {
  const record = session as unknown as Record<string, unknown>;
  const time = (record.time ?? {}) as { created?: number; updated?: number; archived?: number };
  return {
    ...(typeof time.archived === "number" && { timeArchived: time.archived }),
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
      indexing: () => undefined,
      repair: () => undefined,
      discoveryTruncated: () => false,
    };
  }
  const store: Store = options.store;
  /** Whether a cold pass has ever completed on this store (any process). */
  let indexComplete = store.getMeta(COLD_PASS_COMPLETE_KEY) === "1";

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
  const projectorGen = options.projectorGen;
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
  /** The poll in flight, if any: stop() waits for it, so no read of the
   *  history outlives the stop (the host closes the handle after it). */
  let pollPromise: Promise<void> | undefined;
  /** The repair sweep in flight, if any (stop() waits for it too), the
   *  timer that retries a sweep some sessions failed in, and the sessions
   *  the sweep is rebuilding now: a re-distill signaled for one of them runs
   *  after it, like one signaled during another re-distill. */
  let sweepPromise: Promise<void> | undefined;
  let sweepRetryTimer: ReturnType<typeof setTimeout> | undefined;
  const sweeping = new Set<string>();
  /** The progress this holder last shared, refreshed on each heartbeat while
   *  its sweep runs. */
  let sweepProgress: RepairProgress | undefined;
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
   *  pass after `coldPassRetryMs`; at the limit the session is skipped (a
   *  later pass fetches it once, with no retry, and events still re-distill
   *  it). Only several sessions with no strike failing in a row, an outage
   *  signal, aborts the pass, and that charges a strike to each session that
   *  failed in it. Cleared when the session distills or is found current, is
   *  deleted, or is no longer discovered. FIFO-bounded like the quarantine. */
  const coldPassFetchFailures = new Map<string, number>();
  /** Entries of {@link coldPassFetchFailures} at or past the skip limit, and
   *  below it: kept at every mutation so status() never walks the map. */
  let skippedSessions = 0;
  let failingSessions = 0;

  /** Set (or with `undefined`, clear) a session's strike count, keeping the
   *  two counters in step and the map FIFO-bounded like the quarantine. */
  function setStrikes(sessionId: string, strikes: number | undefined): void {
    const old = coldPassFetchFailures.get(sessionId);
    if (old !== undefined) {
      if (old >= MAX_COLD_PASS_FETCH_FAILURES) skippedSessions--;
      else failingSessions--;
      coldPassFetchFailures.delete(sessionId);
    }
    if (strikes === undefined) return;
    // Reinsertion keeps FIFO eviction aligned with the latest failure.
    coldPassFetchFailures.set(sessionId, strikes);
    if (strikes >= MAX_COLD_PASS_FETCH_FAILURES) skippedSessions++;
    else failingSessions++;
    while (coldPassFetchFailures.size > MAX_QUARANTINED_SESSIONS) {
      const oldest = coldPassFetchFailures.keys().next().value;
      if (oldest === undefined) break;
      setStrikes(oldest, undefined);
    }
  }

  /** Delay before the next pass for skipped sessions; see
   *  {@link SKIPPED_RETRY_FACTOR}. */
  let skippedRetryMs = coldPassRetryMs * SKIPPED_RETRY_FACTOR;

  /** A session fetched or found current: clear its strikes, and if it was
   *  skipped, that is progress, so the skipped-pass backoff starts over. */
  function clearStrikesOnSuccess(sessionId: string): void {
    if ((coldPassFetchFailures.get(sessionId) ?? 0) >= MAX_COLD_PASS_FETCH_FAILURES) {
      skippedRetryMs = coldPassRetryMs * SKIPPED_RETRY_FACTOR;
    }
    setStrikes(sessionId, undefined);
  }

  /** One more strike for a session whose fetch failed; returns the count. */
  function bumpFetchFailure(sessionId: string): number {
    const strikes = (coldPassFetchFailures.get(sessionId) ?? 0) + 1;
    setStrikes(sessionId, strikes);
    return strikes;
  }
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

  let defaultDiscoveryTruncated = false;
  const discover =
    options.discover ??
    (async (): Promise<HistorySession[]> => {
      const listing = await source.listSessions({ scope: "project", limit: DISCOVERY_LIMIT });
      if (!listing.ok) throw new Error(listing.error);
      defaultDiscoveryTruncated = listing.truncated;
      return listing.items;
    });
  const discoveryTruncated: (() => boolean) | undefined =
    options.discoveryTruncated ?? (options.discover ? undefined : () => defaultDiscoveryTruncated);

  /** Record whether the discovery just made stopped at its limit, writing
   *  only when that changed. Holder-only. */
  function shareDiscoveryTruncated(truncated: boolean): void {
    if (stopped || !leaseHeld) return;
    const value = truncated ? "1" : "0";
    if (store.getMeta(DISCOVERY_TRUNCATED_KEY) === value || !ownsLease()) return;
    store.setMeta(DISCOVERY_TRUNCATED_KEY, value);
  }

  // ── Fetch primitives (all through the gate at background priority) ──

  async function discoverSessions(): Promise<DistillSessionMeta[]> {
    let listed = false;
    const sessions = await gate.runBackground(() => {
      if (stopped || !leaseHeld) return Promise.resolve([]);
      listed = true;
      return discover();
    });
    if (listed && discoveryTruncated) shareDiscoveryTruncated(discoveryTruncated());
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

  /**
   * Follow a message a read cut short (`partial`) through its continuations
   * (`getMessage` from its next part ordinal), so the card gets the whole
   * message. Each continuation replaces the message's last part, which is
   * always the cut placeholder, with the parts it read. It stops, leaving the
   * message partial, once the session's rows reach `maxRows` (counting
   * `rowsBefore` from the rest of the read), when the source cannot continue
   * (`unsupported`, a vanished message), or when the lease is lost. The
   * continuations are strict, as the page read is, so a part whose data does
   * not decode rejects as a malformed session, and what they could not
   * project is added to `counts` for the loss guard.
   */
  async function completeMessage(
    sessionID: string,
    msg: HistoryMessage,
    rowsBefore: number,
    maxRows: number,
    counts: HistoryReadCounts,
  ): Promise<HistoryMessage> {
    let current = msg;
    while (current.partial) {
      if (stopped || !leaseHeld) return current;
      if (rowsBefore + rowsOf(current) >= maxRows) return current;
      if (limits.distillDelayMs > 0) {
        await sleep(limits.distillDelayMs);
        if (stopped || !leaseHeld) return current;
      }
      const from = current.partial.nextOrdinal;
      const next = await gate.runBackground(() => {
        if (stopped || !leaseHeld) return Promise.resolve(null);
        return source.getMessage(sessionID, msg.info.id, { partOrdinal: from, strict: true });
      });
      if (!next?.ok) return current;
      if (next.counts) addReadCounts(counts, next.counts);
      const parts = [...current.parts.slice(0, -1), ...next.value.parts];
      const partial = next.value.partial;
      current = partial ? { info: msg.info, parts, partial } : { info: msg.info, parts };
      // A continuation always moves past at least one part row; one that does
      // not cannot finish the message.
      if (partial && partial.nextOrdinal <= from) return current;
    }
    return current;
  }

  /** Add a page's read counts to a read's running total. */
  function countPage(into: HistoryReadCounts, page: MessagePage): void {
    if (page.counts) addReadCounts(into, page.counts);
  }

  /** Page a session newest-first, stopping once `maxRows` human-layer rows have
   *  accrued so a giant session never forces a full fetch (its newest rows win
   *  the per-session cap). */
  async function fetchSessionMessages(sessionID: string, maxRows: number): Promise<SessionRead> {
    const all: HistoryMessage[] = [];
    const counts = emptyReadCounts();
    let cursor: string | undefined;
    let rowCount = 0;
    let cut = 0;
    let first = true;
    const read = (): SessionRead => ({ messages: all, cut, counts });
    do {
      if (stopped || !leaseHeld) return read();
      if (!first && limits.distillDelayMs > 0) {
        await sleep(limits.distillDelayMs);
        if (stopped || !leaseHeld) return read();
      }
      first = false;
      const before = cursor;
      const page = await gate.runBackground(() => {
        if (stopped || !leaseHeld) return Promise.resolve({ items: [], nextCursor: null });
        return source.messagePage({ sessionID, limit: pageMessages, before, strict: true });
      });
      countPage(counts, page);
      try {
        for (const item of page.items) {
          const msg = item.partial
            ? await completeMessage(sessionID, item, rowCount, maxRows, counts)
            : item;
          if (msg.partial) cut++;
          all.push(msg);
          rowCount += rowsOf(msg);
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
    // Stopped at the row cap with older pages left: rows below the oldest
    // message read are not in the card.
    if (cursor) {
      let floor: number | undefined;
      for (const msg of all) {
        const seq = msg.info.seq;
        if (typeof seq === "number" && (floor === undefined || seq < floor)) floor = seq;
      }
      if (floor !== undefined) return { ...read(), floor };
    }
    return read();
  }

  /** Page newest-first collecting only messages newer than `checkpoint`, halting
   *  as soon as the checkpoint message is reached. `reached` is false when the
   *  pages exhausted without ever seeing the checkpoint (it was compacted/removed
   *  upstream), which means append is unsafe and the caller must fall back to a
   *  full re-distill. */
  function fetchNewMessages(
    sessionID: string,
    checkpoint: string,
  ): Promise<SessionRead & { reached: boolean }> {
    return fetchUntil(
      sessionID,
      (msg) => (msg.info.id === checkpoint ? "reached" : undefined),
      "unreached",
    );
  }

  /**
   * Page newest-first collecting only the messages past a settled base's
   * boundary, halting at the first message at or below it. `reached` is true
   * only when that message is the base's newest one (or, for a base with no
   * message, when the pages run out first), so the collected messages are
   * exactly what follows the base. A message without a `seq`, or a tail whose
   * rows reach the row cap, is not reached either: the caller reads in full.
   */
  function fetchTailMessages(
    sessionID: string,
    base: SettledBase,
  ): Promise<SessionRead & { reached: boolean }> {
    const cap = caps.ftsRowsPerSession;
    return fetchUntil(
      sessionID,
      (msg) => {
        const seq = msg.info.seq;
        if (typeof seq !== "number") return "unreached";
        if (seq > base.seq) return undefined;
        return msg.info.id === base.messageId ? "reached" : "unreached";
      },
      base.messageId === null ? "reached" : "unreached",
      cap > 0 ? cap : undefined,
    );
  }

  /**
   * Page newest-first collecting messages until `stop` gives a verdict on
   * one: `reached` when the stored content ends there, so the collected
   * messages are exactly what lies past it, `unreached` when the history no
   * longer matches the stored content. The message given a verdict is not
   * collected. Pages that run out first give `exhausted`, and collecting
   * `maxRows` slim-index rows first stops the read unreached. A cut message
   * is continued as in a full read, under the same per-session row cap.
   */
  async function fetchUntil(
    sessionID: string,
    stop: (msg: HistoryMessage) => "reached" | "unreached" | undefined,
    exhausted: "reached" | "unreached",
    maxRows?: number,
  ): Promise<SessionRead & { reached: boolean }> {
    const collected: HistoryMessage[] = [];
    const counts = emptyReadCounts();
    let cursor: string | undefined;
    let first = true;
    let verdict: "reached" | "unreached" | undefined;
    let rowCount = 0;
    let cut = 0;
    const unreached = (): SessionRead & { reached: boolean } => ({
      messages: collected,
      cut,
      counts,
      reached: false,
    });
    do {
      if (stopped || !leaseHeld) return unreached();
      if (!first && limits.distillDelayMs > 0) {
        await sleep(limits.distillDelayMs);
        if (stopped || !leaseHeld) return unreached();
      }
      first = false;
      const before = cursor;
      const page = await gate.runBackground(() => {
        if (stopped || !leaseHeld) return Promise.resolve({ items: [], nextCursor: null });
        return source.messagePage({ sessionID, limit: pageMessages, before, strict: true });
      });
      countPage(counts, page);
      try {
        for (const item of page.items) {
          verdict = stop(item);
          if (verdict !== undefined) break;
          const msg = item.partial
            ? await completeMessage(sessionID, item, rowCount, caps.ftsRowsPerSession, counts)
            : item;
          if (msg.partial) cut++;
          collected.push(msg);
          rowCount += rowsOf(msg);
        }
      } catch (error) {
        // TypeError only, matching fetchSessionMessages: a data-shape failure
        // (`info` missing on a malformed message) quarantines; anything else
        // is a regression and must surface. Same residual risk as there — see
        // the accepted-tradeoff note at the cold pass's deriveCard catch.
        if (!(error instanceof TypeError)) throw error;
        throw new MalformedSessionError(errmsg(error));
      }
      if (verdict === undefined && maxRows !== undefined && rowCount >= maxRows) return unreached();
      cursor = verdict !== undefined ? undefined : (page.nextCursor ?? undefined);
    } while (cursor);
    return { messages: collected, cut, counts, reached: (verdict ?? exhausted) === "reached" };
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
   * row grew), the session is queued for the next poll and the card is
   * stored with the earlier tail when that one was unsettled, else with no
   * checkpoint, which the next compare treats as rewritten (a full
   * re-distill). An unsettled checkpoint is never trusted as current: the
   * next compare reads its running rows again, and a change during the fetch
   * to the rows through its boundary makes that compare rewritten. A
   * checkpoint therefore never claims content the distill did not read, and
   * an empty append can never stamp a newer tail over it.
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
    if (before && after && !before.settled) return { checkpoint: before, moved: true };
    return { checkpoint: null, moved: after !== null };
  }

  /** The boundary of an unsettled checkpoint ({@link CheckpointInfo.boundary}),
   *  undefined for a settled one or none. */
  function boundaryOf(checkpoint: DistillCheckpoint | null): number | undefined {
    if (!checkpoint || checkpoint.settled) return undefined;
    return sync?.inspect?.(checkpoint.cursor)?.boundary;
  }

  /** The `seq` through which a checkpoint's rows are settled: every row when
   *  it is settled, else its boundary, if it has one. */
  function settledThrough(checkpoint: DistillCheckpoint | null): number | undefined {
    if (checkpoint?.settled) return Number.POSITIVE_INFINITY;
    return boundaryOf(checkpoint);
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

  /** A checkpoint's cursor with what the write learned recorded in it, or
   *  null without a checkpoint. */
  function cursorOf(
    checkpoint: DistillCheckpoint | null,
    info: { floor?: number; cut?: number },
  ): string | null {
    if (!checkpoint) return null;
    return sync?.annotate ? sync.annotate(checkpoint.cursor, info) : checkpoint.cursor;
  }

  /** Stamp a card with the projector generation (when the host has one), its
   *  checkpoint and, when that checkpoint is unsettled, its settled base
   *  (sync hosts only; v1 cards keep their exact shape). */
  function stampCard(
    card: Card,
    checkpoint: DistillCheckpoint | null,
    info: { floor?: number; cut?: number } = {},
    settledBase?: SettledBase,
  ): Card {
    const stamped = projectorGen === undefined ? card : { ...card, projectorGen };
    if (!sync) return stamped;
    return {
      ...stamped,
      distillCursor: cursorOf(checkpoint, info),
      ...(settledBase && boundaryOf(checkpoint) === settledBase.seq && { settledBase }),
    };
  }

  /** Whether this distiller records range hashes and checks ranges. */
  const rangesOn = projectorGen !== undefined && sync?.rangeDigest !== undefined;

  /**
   * Whether a card needs rebuilding at this distiller's projector generation:
   * it names none or a lower one, or its checkpoint is version 1, which only
   * an older build writes (the same test as {@link Store.staleCards}, which
   * also leaves out repair-pending cards). Never true without a generation.
   */
  function belowGeneration(card: Card): boolean {
    if (projectorGen === undefined) return false;
    if (card.projectorGen == null || card.projectorGen < projectorGen) return true;
    return sync?.inspect?.(card.distillCursor)?.version === 1;
  }

  /** The `sweepGen` a range hash recorded now carries. */
  function currentSweepGen(): number {
    return parseReconcileProgress(store.getMeta(RECONCILE_PROGRESS_KEY))?.sweep ?? 0;
  }

  /**
   * A session's rows after `afterSeq` and through `throughSeq`, in groups of
   * up to {@link RANGE_ROWS} rows (one digest read each), for a write to
   * record as range hashes ({@link spansOf}). A write takes them before it
   * reads anything else, so a row that changes between this digest and the
   * write's own read is recorded with its older state and fails the next
   * range check. Undefined when range hashes are off, or when the lease was
   * lost or the distiller stopped mid-digest (the write does not happen
   * then).
   */
  async function digestSpans(
    sessionID: string,
    afterSeq: number,
    throughSeq: number,
  ): Promise<Digest | undefined> {
    const digest = sync?.rangeDigest;
    if (!rangesOn || !digest) return undefined;
    const sweepGen = currentSweepGen();
    const groups: RangeRow[][] = [];
    let after = afterSeq;
    for (;;) {
      const rows = await gate.runBackground(() => {
        if (stopped || !leaseHeld) return Promise.resolve<RangeRow[] | null>(null);
        return digest(sessionID, after, RANGE_ROWS);
      });
      if (rows === null) return undefined;
      const within = rows.filter((row) => row.seq <= throughSeq);
      if (within.length > 0) groups.push(within);
      // A short read is the end of the session.
      if (rows.length < RANGE_ROWS || within.length < rows.length) break;
      after = rows[rows.length - 1]!.seq;
    }
    return { groups, sweepGen };
  }

  /**
   * The range hashes of a digest, each group trimmed to the rows at or above
   * `floor` (a group left empty is dropped), so the first one starts at the
   * write's floor and no hash covers a row below it.
   */
  function spansOf(digest: Digest, floor: number | undefined): RangeHash[] {
    const spans: RangeHash[] = [];
    for (const group of digest.groups) {
      const rows = floor === undefined ? group : group.filter((row) => row.seq >= floor);
      if (rows.length === 0) continue;
      spans.push({
        startSeq: rows[0]!.seq,
        endSeq: rows[rows.length - 1]!.seq,
        rowCount: rows.length,
        hash: rangeHashOf(rows),
        sweepGen: digest.sweepGen,
      });
    }
    return spans;
  }

  /**
   * The digest a write takes before its read of the rows after `afterSeq`,
   * or undefined to keep the stored hashes. Only rows that are settled now
   * are hashed: every row when the tail is settled, and when it is running,
   * the rows through its boundary ({@link settledThrough}). A running row
   * changes in place, so the first write that reads it settled hashes it,
   * and the range check never checks an unsettled checkpoint meanwhile; the
   * settled rows a write over a running tail reads are hashed now, so the
   * write that settles the tail reads and hashes only the rows past them.
   * Nor is a repair-pending card's digest taken: its re-reads are usually
   * kept by the loss guard, which writes no hashes, so a whole-session digest
   * on each of them would be wasted work that grows with the session. A
   * re-read that does replace the card leaves the stored hashes, the range
   * check finds them out of date and the re-index it dispatches takes the
   * digest.
   */
  async function digestFor(
    sessionID: string,
    before: DistillCheckpoint | null,
    afterSeq: number,
  ): Promise<Digest | undefined> {
    const through = settledThrough(before);
    if (through === undefined || through <= afterSeq) return undefined;
    if (store.getCard(sessionID)?.repairReason !== undefined) return undefined;
    return digestSpans(sessionID, afterSeq, through);
  }

  /**
   * Make the stored repair reasons this distiller's projector generation's,
   * before it records one or the sweep reads the stale set. When
   * {@link REPAIR_GEN_KEY} names no generation or a lower one, every reason
   * belongs to an earlier generation: they are cleared, so those cards are
   * tried again, and this generation is stamped. Every reason this distiller
   * records is preceded by this call, so a reason recorded at the current
   * generation (by the cold pass, a re-distill or the sweep) is never
   * cleared. A higher stamp is a newer build's, whose reasons are left
   * alone. No-op without a projector generation.
   */
  function adoptRepairGeneration(): void {
    if (projectorGen === undefined) return;
    const raw = store.getMeta(REPAIR_GEN_KEY);
    const stamped = raw !== undefined && /^-?\d+$/.test(raw) ? Number(raw) : undefined;
    if (stamped !== undefined && stamped >= projectorGen) return;
    const cleared = store.clearRepairReasons();
    store.setMeta(REPAIR_GEN_KEY, String(projectorGen));
    if (cleared > 0) {
      logMsg(`cleared ${cleared} repair reason(s) for projector generation ${projectorGen}`);
    }
  }

  /** Record a read's projection loss as the card's repair reason. */
  function markLoss(sessionId: string, loss: string, kept: boolean): void {
    adoptRepairGeneration();
    store.markRepairPending(sessionId, loss);
    logMsg(`session ${sessionId} ${kept ? "kept its card" : "is repair-pending"}: ${loss}`);
  }

  /**
   * Store a full derivation with its checkpoint, its settled base (when the
   * checkpoint is unsettled), the generation and, with a
   * `digest`, its range hashes trimmed to the read's floor, which replace
   * every hash stored for the session in the same transaction (hashes of an
   * earlier write can start at seqs this one's do not, rows removed since,
   * and a range check must never find them). Without a digest the stored
   * hashes are kept. Returns the store's verdict.
   *
   * The loss guard: when the read shows the projection lost content
   * ({@link lossOf}), an existing card is kept as it is, nothing is written
   * and the card gets the loss as its repair reason (`kept`), which takes it
   * out of the stale set until a projector generation bump clears it. With no
   * card to keep, the card is written and then marked the same way. The
   * read's counts are in the source's drift state already.
   */
  function writeFull(
    session: DistillSessionMeta,
    derived: DerivedCard,
    read: SessionRead,
    checkpoint: DistillCheckpoint | null,
    moved: boolean,
    digest: Digest | undefined,
  ): CardWrite & { kept?: string } {
    const loss = lossOf(read.counts);
    if (loss && store.getCard(session.id)) {
      markLoss(session.id, loss, true);
      // The tail read is current even though the card is kept, so a session
      // whose turn has ended stops being re-read on every poll.
      noteSettled(session.id, checkpoint, moved);
      return { changed: false, kept: loss };
    }
    const card = stampCard(
      derived.card,
      checkpoint,
      { floor: read.floor, cut: read.cut },
      derived.settledBase,
    );
    const rangeHashes = digest ? spansOf(digest, read.floor) : undefined;
    const result = store.replaceSessionParts(
      session.id,
      derived.rows,
      card,
      rangeHashes ? { rangeHashes, replaceRangeHashes: true } : undefined,
    );
    // An accepted replace clears the repair reason, so the mark follows it.
    if (loss && !result.refused) markLoss(session.id, loss, false);
    noteSettled(session.id, checkpoint, moved);
    return { changed: result.changed };
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
    // Rollup writes change the root card row; verify authoritative ownership
    // once per rollup batch (callers reach here after awaited fetches, so the
    // cached flag alone can be stale after a >TTL suspension).
    if (!ownsLease()) return;
    const root = store.getCard(rootId);
    if (!root) return;
    const children = store
      .allCards()
      .filter((card) => card.rootId === rootId && card.sessionId !== rootId);
    store.setFamilyRollup(rootId, buildRollup(children));
  }

  async function recomputeAllRootRollups(): Promise<void> {
    // One authoritative ownership read for the whole rollup sweep (see
    // recomputeRootRollup); per-row checks would multiply SQLite reads for
    // no additional safety. A host that yields mid-sweep re-checks after each
    // pause instead.
    if (!ownsLease()) return;
    const rootCards = new Map<string, Card>();
    const childrenByRoot = new Map<string, Card[]>();
    for (const card of store.allCards()) {
      if (card.rootId === card.sessionId) rootCards.set(card.sessionId, card);
      else {
        const siblings = childrenByRoot.get(card.rootId);
        if (siblings) siblings.push(card);
        else childrenByRoot.set(card.rootId, [card]);
      }
    }
    // Counts every setFamilyRollup call, including those that skip an
    // unchanged rollup: each still runs a transaction.
    let rollupCalls = 0;
    for (const [rootId, root] of rootCards) {
      const rollup = buildRollup(childrenByRoot.get(rootId) ?? []);
      if (rollup.length > 0 || root.familyRollup.length > 0) {
        if (pause && ++rollupCalls % YIELD_EVERY_WRITES === 0) {
          await pause();
          if (stopped || !ownsLease()) return;
        }
        // Writes only the rollup column, so a card re-distilled during a pause
        // keeps its new content.
        store.setFamilyRollup(rootId, rollup);
      }
    }
  }

  // ── Distill one session ──

  async function distillFull(session: DistillSessionMeta): Promise<CardWrite & { kept?: string }> {
    const before = await fetchCheckpoint(session.id);
    const digest = await digestFor(session.id, before, BEFORE_FIRST_SEQ);
    const read = await fetchSessionMessages(session.id, caps.ftsRowsPerSession);
    const { checkpoint, moved } = await bracketCheckpoint(session.id, before);
    // Cheap flag check before parentChainOf touches the store: a detached
    // continuation (the fetch settled after dispose's bounded wait) must not
    // read SQLite, which may already be closed.
    if (stopped || !leaseHeld) return { changed: false };
    const boundary = boundaryOf(checkpoint);
    const derived = await derive({
      session,
      messages: read.messages,
      parentById: parentChainOf(session),
      caps,
      ...(boundary !== undefined && { settledThrough: boundary }),
    });
    if (pause) await pause();
    // Authoritative re-check (live lease row, not the cached flag): a process
    // suspended past the TTL can lose the lease to a rival before its heartbeat
    // callback ever runs; the resumed fetch must not replace the new holder's
    // rows. One leaseStatus() read per write batch.
    if (stopped || !ownsLease()) return { changed: false };
    return writeFull(session, derived, read, checkpoint, moved, digest);
  }

  /**
   * The floor of a card after an append adds `newRows` slim-index rows to
   * the `keptRows` stored ones (oldest first, as the store inserts them; by
   * default every stored row, while a tail write keeps only its base's).
   * Under the per-session row cap the store evicts the oldest rows, so the
   * floor moves up to the message that owns the oldest row left (its `seq`
   * from the appended messages, or read from the history for a stored one).
   * Otherwise the card keeps the floor it had. `null` when that message is
   * gone from the history, so the stored rows no longer describe the
   * session; `aborted` when the lease was lost. Only the range check reads
   * the floor, so without range hashes the card keeps its floor and this
   * reads nothing.
   */
  async function floorAfterAppend(
    sessionID: string,
    stored: number | undefined,
    newRows: PartTextRow[],
    appended: HistoryMessage[],
    keptRows?: number,
  ): Promise<{ floor: number | undefined } | null | "aborted"> {
    const cap = caps.ftsRowsPerSession;
    if (!rangesOn || cap <= 0) return { floor: stored };
    const kept = keptRows ?? store.sessionRowCount(sessionID);
    const evicted = kept + newRows.length - cap;
    if (evicted <= 0) return { floor: stored };
    const owner =
      evicted >= kept
        ? newRows[evicted - kept]?.messageId
        : store.sessionRowMessage(sessionID, evicted);
    if (owner === undefined) return { floor: stored };
    let seq = appended.find((msg) => msg.info.id === owner)?.info.seq;
    const seqOf = sync.seqOf;
    if (seq === undefined && seqOf) {
      const found = await gate.runBackground(() => {
        if (stopped || !leaseHeld) return Promise.resolve<number | null | "aborted">("aborted");
        return seqOf(sessionID, owner);
      });
      if (found === "aborted") return "aborted";
      if (found === null) return null;
      seq = found;
    }
    if (seq === undefined) return { floor: stored };
    return { floor: stored === undefined ? seq : Math.max(stored, seq) };
  }

  /**
   * A session's stored range hashes once its floor moves up to `floor`:
   * spans wholly below it are dropped, and the one span that holds rows on
   * both sides of it is trimmed to the rows at or above it. That span is
   * read again first and trimmed only when it still matches its stored hash,
   * so a change the range check would have found is not hashed away;
   * `changed` when it no longer matches, `aborted` when the lease was lost.
   */
  async function spansAboveFloor(
    sessionID: string,
    floor: number,
  ): Promise<RangeHash[] | "changed" | "aborted"> {
    const digest = sync?.rangeDigest;
    const kept: RangeHash[] = [];
    for (const span of store.getRangeHashes(sessionID)) {
      if (span.endSeq < floor) continue;
      if (span.startSeq >= floor) {
        kept.push(span);
        continue;
      }
      if (!digest) return "changed";
      const rows = await gate.runBackground(() => {
        if (stopped || !leaseHeld) return Promise.resolve<RangeRow[] | null>(null);
        return digest(sessionID, span.startSeq - 1, span.rowCount);
      });
      if (rows === null) return "aborted";
      const inSpan = rows.filter((row) => row.seq <= span.endSeq);
      if (
        inSpan.length !== span.rowCount ||
        inSpan[0]?.seq !== span.startSeq ||
        rangeHashOf(inSpan) !== span.hash
      ) {
        return "changed";
      }
      const above = inSpan.filter((row) => row.seq >= floor);
      if (above.length === 0) continue;
      kept.push({
        startSeq: above[0]!.seq,
        endSeq: above[above.length - 1]!.seq,
        rowCount: above.length,
        hash: rangeHashOf(above),
        sweepGen: span.sweepGen,
      });
    }
    return kept;
  }

  async function distillAppend(
    session: DistillSessionMeta,
    oldCard: Card,
  ): Promise<CardWrite & { kept?: string }> {
    const checkpoint = oldCard.distilledThrough;
    if (!checkpoint) return distillFull(session);
    const before = await fetchCheckpoint(session.id);
    // The rows past the stored checkpoint are the ones this append reads.
    const stored = sync?.inspect?.(oldCard.distillCursor) ?? null;
    const digest = stored ? await digestFor(session.id, before, stored.seq) : undefined;
    const fetched = await fetchNewMessages(session.id, checkpoint);
    const { checkpoint: tail, moved } = await bracketCheckpoint(session.id, before);
    // Authoritative ownership check before the append write (see distillFull);
    // only synchronous derivation sits between here and appendSessionParts.
    if (stopped || !ownsLease()) return { changed: false };
    // If the checkpoint message was never found, the newest pages are NOT a clean
    // append tail (they'd re-insert already-stored parts and hit a UNIQUE
    // violation, wedging the session). Fall back to a full re-distill.
    if (!fetched.reached) return distillFull(session);
    // The loss guard, before anything is written: an append can evict stored
    // rows at the cap and replaces the card's aggregates, so a lossy one
    // keeps the card, its rows and its checkpoint, as a full write does.
    const loss = lossOf(fetched.counts);
    if (loss) {
      markLoss(session.id, loss, true);
      noteSettled(session.id, tail, moved);
      return { changed: false, kept: loss };
    }
    // The card keeps the cut messages of the write that read its rows.
    const cut = (stored?.cut ?? 0) + fetched.cut;
    const newMessages = fetched.messages;
    if (newMessages.length === 0) {
      const info = { ...(stored?.floor !== undefined && { floor: stored.floor }), cut };
      // Nothing appended. A sync host still refreshes the card's metadata and
      // checkpoint, or the cold pass would keep finding it stale.
      if (!sync) return { changed: false };
      // A title or directory change also changes the embedded text, so the
      // store drops the persisted vector with it.
      const result = store.refreshCardMeta(
        session.id,
        {
          title: session.title,
          directory: session.directory,
          projectId: session.projectId,
          timeUpdated: session.timeUpdated,
          timeArchived: session.timeArchived ?? null,
        },
        cursorOf(tail, info),
      );
      // Rows that are not messages (a switch, an idle marker) can still move
      // the checkpoint past the stored hashes.
      const spans = digest ? spansOf(digest, stored?.floor) : [];
      if (spans.length > 0) store.putRangeHashes(session.id, spans);
      noteSettled(session.id, tail, moved);
      return result;
    }

    const chrono = sortChronological(newMessages);
    // An append that reads a running tail splits the messages it read at the
    // tail's boundary, so the card's settled base can be recorded.
    const settled = boundaryOf(tail);
    const walk = walkMessages(chrono, checkpoint, splitAt(chrono, settled));
    const placed = await floorAfterAppend(session.id, stored?.floor, walk.rows, chrono);
    if (placed === "aborted") return { changed: false };
    // The oldest row left belongs to a message the history no longer has.
    if (placed === null) return distillFull(session);
    if (stopped || !ownsLease()) return { changed: false };
    const info = { ...(placed.floor !== undefined && { floor: placed.floor }), cut };
    // An append that evicts more rows than the card held raises the floor
    // into the rows it read, so its own hashes are trimmed to the floor too.
    let rangeHashes = digest ? spansOf(digest, placed.floor) : undefined;
    let replaceRangeHashes = false;
    if (rangesOn && placed.floor !== undefined && placed.floor !== stored?.floor) {
      // The append evicts rows: the stored hashes follow the floor up.
      const kept = await spansAboveFloor(session.id, placed.floor);
      if (kept === "aborted") return { changed: false };
      if (kept === "changed") return distillFull(session);
      if (stopped || !ownsLease()) return { changed: false };
      rangeHashes = [...kept, ...(rangeHashes ?? [])];
      replaceRangeHashes = true;
    }
    const rootId = resolveRootId(session.id, parentChainOf(session));
    const boundary = { checkpointMessageId: checkpoint, firstNewMessageId: chrono[0]!.info.id };
    /** Rows of the messages past the tail's boundary: the rest of the
     *  surviving rows belong to the settled base. */
    const tailRows = walk.rows.length - (walk.prefix?.rows ?? 0);

    const result = store.appendSessionParts(
      session.id,
      walk.rows,
      caps.ftsRowsPerSession,
      boundary,
      (allRows) =>
        stampCard(
          buildCard(
            session,
            rootId,
            mergeAggregates(oldCard, aggregatesOf(walk)),
            allRows,
            deriveInventory(allRows, caps.inventoryTokens),
            walk.newestMessageId ?? checkpoint,
            oldCard.familyRollup,
          ),
          tail,
          info,
          settled === undefined || !walk.prefix
            ? undefined
            : settledBaseOf(
                settled,
                {
                  ...walk.prefix,
                  aggregates: mergeAggregates(oldCard, walk.prefix.aggregates),
                  newestMessageId: walk.prefix.newestMessageId ?? checkpoint,
                  cut: (stored?.cut ?? 0) + walk.prefix.cut,
                },
                allRows.length - tailRows,
              ),
        ),
      rangeHashes ? { rangeHashes, replaceRangeHashes } : undefined,
    );
    noteSettled(session.id, tail, moved);
    return { changed: result.changed };
  }

  /**
   * How a tail write fits the per-session row cap, or null when only a full
   * read can: the card keeps the newest `cap` rows of its base and tail, as a
   * full write of the same messages does. A longer tail evicts the base's
   * oldest rows. A shorter one would bring back rows of base messages a
   * previous write evicted, which the card no longer holds; that is only
   * possible while the store holds exactly `cap` rows (every eviction leaves
   * exactly that many), so a store below the cap keeps all of its base.
   */
  function planTail(
    baseRows: number,
    storedRows: number,
    tailRows: number,
  ): { evict: number } | null {
    const cap = caps.ftsRowsPerSession;
    if (cap <= 0) return { evict: 0 };
    if (tailRows >= cap) return null;
    const room = cap - tailRows;
    if (room < baseRows) return { evict: baseRows - room };
    if (room > baseRows && storedRows >= cap) return null;
    return { evict: 0 };
  }

  /**
   * The settled base a `tail` change may merge with: the card's, when the
   * card is fully indexed at this distiller's projector generation (none and
   * NULL are the same) with no repair reason, and the base belongs to the
   * card's checkpoint.
   */
  function tailBase(card: Card): SettledBase | undefined {
    const base = card.settledBase;
    if (!base || card.distillState !== "full" || card.repairReason !== undefined) return undefined;
    if ((card.projectorGen ?? null) !== (projectorGen ?? null)) return undefined;
    return sync?.inspect?.(card.distillCursor)?.boundary === base.seq ? base : undefined;
  }

  /**
   * Re-index a session whose rows through its card's boundary are unchanged
   * while the rows past it run (a `tail` change). Only the messages past the
   * boundary are read, and the card is rebuilt as its settled base
   * ({@link Card.settledBase}) merged with them: the card a full write of the
   * same messages stores, under the append's row cap rule (rows a write
   * evicted stay evicted). The stored rows past the base are replaced in one
   * transaction ({@link Store.replaceSessionTail}). The settled rows past
   * the base, if any, get range hashes from a digest taken before the read;
   * a tail still running keeps the stored hashes.
   *
   * A full read runs instead when the boundary went back below the base (a
   * row in it runs again), when the read does not end at the base's newest
   * message, when the tail alone fills the row cap, when the cap would need
   * base rows the card no longer holds, or when another write replaced the
   * card since it was read.
   */
  async function distillTail(
    session: DistillSessionMeta,
    oldCard: Card,
    base: SettledBase,
  ): Promise<CardWrite & { kept?: string }> {
    const stored = sync?.inspect?.(oldCard.distillCursor) ?? null;
    const before = await fetchCheckpoint(session.id);
    if (stopped || !leaseHeld) return { changed: false };
    if (!before || (settledThrough(before) ?? BEFORE_FIRST_SEQ) < base.seq) {
      return distillFull(session);
    }
    const digest = await digestFor(session.id, before, base.seq);
    const fetched = await fetchTailMessages(session.id, base);
    const { checkpoint, moved } = await bracketCheckpoint(session.id, before);
    if (stopped || !ownsLease()) return { changed: false };
    if (!fetched.reached) return distillFull(session);
    // The loss guard, as for an append: a lossy tail keeps the card, its rows
    // and its checkpoint.
    const loss = lossOf(fetched.counts);
    if (loss) {
      markLoss(session.id, loss, true);
      noteSettled(session.id, checkpoint, moved);
      return { changed: false, kept: loss };
    }
    const chrono = sortChronological(fetched.messages);
    const settled = boundaryOf(checkpoint);
    const walk = walkMessages(chrono, base.messageId, splitAt(chrono, settled));
    const plan = planTail(base.rows, store.sessionRowCount(session.id), walk.rows.length);
    if (!plan) return distillFull(session);
    let floor = stored?.floor;
    let rangeHashes = digest ? spansOf(digest, floor) : undefined;
    let replaceRangeHashes = false;
    if (plan.evict > 0) {
      const placed = await floorAfterAppend(session.id, floor, walk.rows, chrono, base.rows);
      if (placed === "aborted") return { changed: false };
      // The oldest row left belongs to a message the history no longer has.
      if (placed === null) return distillFull(session);
      if (rangesOn && placed.floor !== undefined && placed.floor !== floor) {
        // The stored hashes follow the floor up, as an evicting append's do.
        const kept = await spansAboveFloor(session.id, placed.floor);
        if (kept === "aborted") return { changed: false };
        if (kept === "changed") return distillFull(session);
        rangeHashes = [...kept, ...(digest ? spansOf(digest, placed.floor) : [])];
        replaceRangeHashes = true;
      }
      floor = placed.floor;
      if (stopped || !ownsLease()) return { changed: false };
    }
    const info = { ...(floor !== undefined && { floor }), cut: base.cut + fetched.cut };
    const rootId = resolveRootId(session.id, parentChainOf(session));
    /** Rows of the messages past the new boundary. */
    const tailRows = walk.rows.length - (walk.prefix?.rows ?? 0);
    const result = store.replaceSessionTail(
      session.id,
      { base, evict: plan.evict, rows: walk.rows, firstMessageId: chrono[0]?.info.id ?? null },
      (allRows) =>
        stampCard(
          buildCard(
            session,
            rootId,
            mergeAggregates(base, aggregatesOf(walk)),
            allRows,
            deriveInventory(allRows, caps.inventoryTokens),
            walk.newestMessageId ?? base.messageId,
            oldCard.familyRollup,
          ),
          checkpoint,
          info,
          settled === undefined || !walk.prefix
            ? undefined
            : settledBaseOf(
                settled,
                {
                  ...walk.prefix,
                  aggregates: mergeAggregates(base, walk.prefix.aggregates),
                  newestMessageId: walk.prefix.newestMessageId ?? base.messageId,
                  cut: base.cut + walk.prefix.cut,
                },
                allRows.length - tailRows,
              ),
        ),
      rangeHashes ? { rangeHashes, replaceRangeHashes } : undefined,
    );
    // Another write replaced the card since it was read.
    if (result.refused === "base-changed") return distillFull(session);
    noteSettled(session.id, checkpoint, moved);
    return { changed: result.changed };
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
    // A new pass's progress starts from nothing: never report the previous
    // pass's counts while this one is still discovering.
    examinedCount = 0;
    knownCount = 0;
    lastError = undefined;
    // Another process may have completed a pass since this one last looked.
    indexComplete ||= store.getMeta(COLD_PASS_COMPLETE_KEY) === "1";
    logMsg("cold pass started");
    /** Sessions whose fetch failed this pass, retried once at its end. Also
     *  what an outage abort charges a strike to (see the catch below). */
    const failedThisPass: DistillSessionMeta[] = [];
    /** Set when the pass aborts as an outage (not a stop or a lost lease). */
    let outageAbort = false;
    try {
      const discovered = await discoverSessions();
      knownCount = discovered.length;
      shareProgress(true);
      const liveUpdates = new Map(discovered.map((session) => [session.id, session.timeUpdated]));
      for (const [sessionId, timeUpdated] of quarantined) {
        // Deletions and updates both invalidate quarantine. An updated session is
        // retried below; a deleted one no longer consumes retained state.
        if (liveUpdates.get(sessionId) !== timeUpdated) quarantined.delete(sessionId);
      }
      // A session gone from the host no longer counts as failing or skipped.
      for (const sessionId of [...coldPassFetchFailures.keys()]) {
        if (!liveUpdates.has(sessionId)) setStrikes(sessionId, undefined);
      }
      const parentById = new Map(discovered.map((s) => [s.id, s.parentId] as const));
      const sorted = [...discovered].sort(
        (a, b) => b.timeUpdated - a.timeUpdated || a.id.localeCompare(b.id),
      );
      let examined = 0;
      let distilled = 0;
      /** Fetch failures in a row of sessions with no strike yet. Only fetches
       *  move it: an up-to-date or quarantined session is not a fetch and
       *  leaves it as is, and a known-bad session's failure does not add to
       *  it (it is not evidence of an outage). A successful fetch resets it. */
      let consecutiveFailures = 0;
      /** Set when a session still fails short of the skip limit: the pass
       *  completes, and a follow-up pass retries it. The first such failure,
       *  and how many there were. */
      let retryFailure: string | undefined;
      let retryFailureCount = 0;
      /** Sessions skipped this pass, and those of them with no card: the
       *  store is not complete while any session lacks one. */
      let skippedThisPass = 0;
      let skippedWithoutCard = 0;

      const countExamined = (session: DistillSessionMeta): void => {
        examined++;
        examinedCount = examined;
        recordProgress(session.timeUpdated);
        shareProgress();
      };

      /** A failure this pass will not retry again: one strike, then either a
       *  follow-up pass (below the limit) or a skip. */
      const strike = (session: DistillSessionMeta, error: unknown): void => {
        const failures = bumpFetchFailure(session.id);
        if (failures < MAX_COLD_PASS_FETCH_FAILURES) {
          retryFailure ??= `session ${session.id} fetch failed: ${errmsg(error)}`;
          retryFailureCount++;
          return;
        }
        skippedThisPass++;
        if (!store.getCard(session.id)) skippedWithoutCard++;
        if (skippedThisPass <= SKIP_LOG_LIMIT) {
          logMsg(
            `session ${session.id} skipped: ${failures} cold passes failed to fetch it (${errmsg(error)}); later passes and changes to it still try it, without holding a pass back`,
          );
        }
        countExamined(session);
      };

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
        // A card built below the projector generation is left to the repair
        // sweep, which takes sessions with part rows first; a change to the
        // session still re-indexes it through the per-session path.
        if (existing && belowGeneration(existing)) {
          countExamined(session);
          return;
        }
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
            countExamined(session);
            return;
          }

          let read: SessionRead;
          let digest: Digest | undefined;
          let checkpoint: DistillCheckpoint | null;
          let moved: boolean;
          try {
            const before = await fetchCheckpoint(session.id);
            digest = await digestFor(session.id, before, BEFORE_FIRST_SEQ);
            read = await fetchSessionMessages(session.id, caps.ftsRowsPerSession);
            ({ checkpoint, moved } = await bracketCheckpoint(session.id, before));
          } catch (error) {
            // Every error except MalformedSessionError (quarantined below)
            // takes this path: not only host or transport failures, but any
            // other throw from the fetch or checkpoint reads too.
            if (!(error instanceof MalformedSessionError)) {
              if (stopped || !leaseHeld) throw error;
              if (retry) {
                strike(session, error);
                throw new RetryFailed();
              }
              const strikes = coldPassFetchFailures.get(session.id) ?? 0;
              if (strikes >= MAX_COLD_PASS_FETCH_FAILURES) {
                // Already past the limit: no end-of-pass retry either.
                strike(session, error);
                return;
              }
              if (strikes === 0) {
                // Several sessions with no history of failing, failing in a
                // row, is an outage: abort and retry the whole pass later.
                consecutiveFailures++;
                if (consecutiveFailures >= MAX_CONSECUTIVE_FETCH_FAILURES) {
                  failedThisPass.push(session);
                  outageAbort = true;
                  throw error;
                }
              }
              if (failedThisPass.length >= MAX_RETRY_SET) {
                strike(session, error);
                return;
              }
              failedThisPass.push(session);
              return;
            }
            quarantine(session, error);
            countExamined(session);
            return;
          }
          consecutiveFailures = 0;
          clearStrikesOnSuccess(session.id);

          let derived: DerivedCard;
          try {
            const boundary = boundaryOf(checkpoint);
            derived = await derive({
              session,
              messages: read.messages,
              parentById,
              caps,
              ...(boundary !== undefined && { settledThrough: boundary }),
            });
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
            countExamined(session);
            return;
          }
          // The lease can drop (heartbeat takeover) during the fetch above; a
          // non-holder must never write. Re-check right before the write —
          // authoritatively, against the live lease row, because a suspension
          // past the TTL loses the lease before the heartbeat callback flips
          // the cached flag — and skip it, counting the session as not
          // distilled.
          if (stopped || !ownsLease()) return;
          if (writeFull(session, derived, read, checkpoint, moved, digest).kept === undefined) {
            distilled++;
            distilledCount = distilled; // status counts only sessions actually distilled
          }
        } else {
          // Indexed and current (perhaps by another holder): not failing.
          clearStrikesOnSuccess(session.id);
        }
        countExamined(session);
      };

      await runPool(sorted, limits.distillConcurrency, (session) => processSession(session, false));
      // Sessions that failed are retried once, now that the rest is indexed.
      // Several retries failing in a row stop the retries: the rest take a
      // strike unfetched and wait for the follow-up pass.
      let retryFailures = 0;
      for (const session of failedThisPass) {
        if (stopped || !leaseHeld) break;
        if (retryFailures >= MAX_CONSECUTIVE_RETRY_FAILURES) {
          strike(session, new Error("not retried: earlier retries in this pass kept failing"));
          continue;
        }
        try {
          await processSession(session, true);
          retryFailures = 0;
        } catch (error) {
          if (!(error instanceof RetryFailed)) throw error;
          retryFailures++;
        }
      }
      failedThisPass.length = 0;

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
      // The store is complete only when nothing is waiting for a retry and
      // no skipped session lacks a card; otherwise the gap stays reported.
      const complete = retryFailure === undefined && skippedWithoutCard === 0;
      if (complete && !indexComplete) {
        indexComplete = true;
        store.setMeta(COLD_PASS_COMPLETE_KEY, "1"); // lease verified just above
      } else if (!complete) {
        // A follow-up pass is near: still in progress. Only skipped sessions
        // left: nothing is indexing until the long backoff below.
        shareProgress(true, retryFailure !== undefined);
      }
      if (skippedThisPass > SKIP_LOG_LIMIT) {
        logMsg(
          `${skippedThisPass - SKIP_LOG_LIMIT} more session(s) skipped this pass after repeated fetch failures`,
        );
      }
      logMsg(
        `cold pass done (${distilled} distilled / ${examined} examined / ${knownCount} known)`,
      );
      options.onColdPassDone?.();
      // Cards below the projector generation were left to the sweep.
      startRepairSweep();
      if (retryFailure !== undefined) {
        // Some sessions still fail: the rest is indexed, and a follow-up pass
        // (which skips everything up to date) retries them later.
        lastError =
          retryFailureCount > 1
            ? `${retryFailure} (and ${retryFailureCount - 1} more)`
            : retryFailure;
        scheduleColdPassRetry(true);
      } else if (skippedSessions > 0) {
        // Skipped sessions are not retried by follow-ups. Another pass on a
        // long backoff tries them again, and again (doubling, capped) while
        // none of them heals, until they heal, are deleted or leave
        // discovery; a host-wide fetch outage recovers when the host heals.
        scheduleColdPassRetry(true, skippedRetryMs);
        skippedRetryMs = Math.min(skippedRetryMs * 2, coldPassRetryMs * SKIPPED_RETRY_MAX_FACTOR);
      }
      // No session left skipped: the next skipped-only run starts at the base.
      if (skippedSessions === 0) skippedRetryMs = coldPassRetryMs * SKIPPED_RETRY_FACTOR;
    } catch (error) {
      lastError = errmsg(error);
      coldPassState = "idle"; // resumable: per-card skip resumes on the next run
      logMsg(`cold pass aborted: ${lastError}`);
      // An outage abort charges a strike to every session that failed this
      // pass, so a failure that repeats pass after pass still reaches the
      // skip limit instead of aborting forever. Their failures are known from
      // then on and no longer count toward the next outage.
      if (outageAbort && !stopped && leaseHeld) {
        // This can take a session past the skip limit without the "skipped"
        // log line: that line belongs to a pass that reaches its end, and the
        // session is simply fetched once, unretried, by the next one.
        for (const session of failedThisPass) bumpFetchFailure(session.id);
      }
      // Other processes keep reporting where the pass got to until the retry
      // (or, past the staleness bound, the gap it left).
      shareProgress(true);
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

  // ── Repair sweep (hosts with a projector generation) ──

  /** Share the sweep's progress in {@link REPAIR_PROGRESS_KEY}, at most every
   *  {@link PROGRESS_WRITE_MS} unless `force`. Holder-only. */
  let repairWrittenAt = Number.NEGATIVE_INFINITY;
  function shareRepair(progress: Omit<RepairProgress, "at">, force = false): void {
    if (stopped || !leaseHeld) return;
    const t = now();
    sweepProgress = { ...progress, at: t };
    if (!force && t - repairWrittenAt < PROGRESS_WRITE_MS) return;
    if (!ownsLease()) return;
    repairWrittenAt = t;
    store.setMeta(REPAIR_PROGRESS_KEY, JSON.stringify(sweepProgress));
  }

  /** Start a repair sweep unless one is running (holder only, and only with
   *  a projector generation and a sync host). */
  function startRepairSweep(): void {
    if (projectorGen === undefined || !sync || stopped || !leaseHeld || sweepPromise) return;
    clearTimer(sweepRetryTimer);
    sweepRetryTimer = undefined;
    const running = runRepairSweep(projectorGen)
      .catch((error: unknown) => {
        lastError = errmsg(error);
        logMsg(`repair sweep failed: ${lastError}`);
        scheduleSweepRetry();
      })
      .finally(() => {
        if (sweepPromise === running) sweepPromise = undefined;
        sweepProgress = undefined;
      });
    sweepPromise = running;
  }

  function scheduleSweepRetry(): void {
    if (stopped || !leaseHeld) return;
    clearTimer(sweepRetryTimer);
    sweepRetryTimer = setTimeout(() => {
      sweepRetryTimer = undefined;
      startRepairSweep();
    }, coldPassRetryMs);
  }

  /**
   * Rebuild one stale card. `gone` when the session no longer exists (its
   * card is left to the deletion reconcile), `marked` when it is malformed or
   * the loss guard kept its card (both get a repair reason), `done` when its
   * card is now at the current generation, `skipped` when the lease was lost
   * or another write left it stale.
   */
  async function repairOne(sessionId: string): Promise<"done" | "marked" | "gone" | "skipped"> {
    try {
      const session = await fetchSessionMeta(sessionId);
      if (stopped || !leaseHeld) return "skipped";
      if (!session || isSummarizerTitle(session.title)) return "gone";
      const result = await distillFull(session);
      if (stopped || !leaseHeld) return "skipped";
      if (result.kept !== undefined) return "marked";
      const card = store.getCard(sessionId);
      return card && !belowGeneration(card) ? "done" : "skipped";
    } catch (error) {
      // A data-shape failure, as the cold pass quarantines it; anything else
      // (a transport failure) leaves the card stale for the next sweep.
      if (!(error instanceof MalformedSessionError) && !(error instanceof TypeError)) throw error;
      if (stopped || !ownsLease()) return "skipped";
      adoptRepairGeneration();
      store.markRepairPending(sessionId, `malformed: ${errmsg(error)}`);
      logMsg(`session ${sessionId} is repair-pending: ${errmsg(error)}`);
      return "marked";
    }
  }

  /**
   * The repair sweep: rebuild every card below projector generation `gen`
   * ({@link Store.staleCards}, archived sessions included), sessions with
   * part rows first, at `distillConcurrency`, through the fetch gate behind
   * foreground work. A session being re-distilled is skipped (that write
   * stamps the generation too). A card leaves the stale set only when its
   * rebuild commits or it gets a repair reason, so an interrupted sweep
   * resumes from the store on the next one. Failing fetches leave their
   * cards stale and arm another sweep; several in a row mean an outage and
   * stop this one.
   */
  async function runRepairSweep(gen: number): Promise<void> {
    if (stopped || !ownsLease()) return;
    // A new generation retries every card an earlier one could not repair.
    adoptRepairGeneration();
    const stale = store.staleCards(gen);
    const repairPending = (): number => store.cardStats().repairPending;
    if (stale.length === 0) {
      shareRepair(
        { pending: 0, repairPending: repairPending(), done: 0, gen, running: false },
        true,
      );
      return;
    }
    const ids = stale.map((card) => card.sessionId);
    const withParts = sync?.withParts;
    const bearing = withParts
      ? await gate.runBackground(() => {
          if (stopped || !leaseHeld) return Promise.resolve(new Set<string>());
          return withParts(ids);
        })
      : new Set<string>();
    if (stopped || !leaseHeld) return;
    // Newest first within each group (staleCards' order).
    const ordered = [
      ...ids.filter((id) => bearing.has(id)),
      ...ids.filter((id) => !bearing.has(id)),
    ];
    logMsg(`repair sweep started: ${ordered.length} stale card(s), ${bearing.size} with part rows`);
    let done = 0;
    let settled = 0;
    let failed = 0;
    let firstFailure: string | undefined;
    let consecutiveFailures = 0;
    let aborted = false;
    /** Sessions this sweep did not rebuild: being re-distilled when it got
     *  to them, or left stale by its own write (a lost lease, a refusal). */
    const skipped: string[] = [];
    const progress = (running: boolean): Omit<RepairProgress, "at"> => ({
      pending: ordered.length - settled,
      repairPending: repairPending(),
      done,
      gen,
      running,
    });
    shareRepair(progress(true), true);

    await runPool(ordered, limits.distillConcurrency, async (sessionId) => {
      if (stopped || !leaseHeld || aborted) return;
      if (pause) {
        await pause();
        if (stopped || !leaseHeld || aborted) return;
      }
      if (inFlight.has(sessionId)) {
        skipped.push(sessionId);
        return;
      }
      sweeping.add(sessionId);
      try {
        const outcome = await repairOne(sessionId);
        consecutiveFailures = 0;
        if (outcome === "done") done++;
        if (outcome === "done" || outcome === "marked") settled++;
        if (outcome === "skipped") skipped.push(sessionId);
      } catch (error) {
        failed++;
        firstFailure ??= `session ${sessionId}: ${errmsg(error)}`;
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FETCH_FAILURES) aborted = true;
      } finally {
        sweeping.delete(sessionId);
        if (!stopped && pendingRerun.delete(sessionId)) scheduleReDistill(sessionId);
      }
      // Counting repair-pending cards reads every card, so only when the
      // progress is due to be shared.
      if (now() - repairWrittenAt >= PROGRESS_WRITE_MS) shareRepair(progress(true));
    });
    if (stopped || !ownsLease()) return;
    if (done > 0) await recomputeAllRootRollups();
    if (stopped || !ownsLease()) return;
    shareRepair(
      {
        pending: store.staleCards(gen).length,
        repairPending: repairPending(),
        done,
        gen,
        running: false,
      },
      true,
    );
    logMsg(
      `repair sweep ${aborted ? "stopped after repeated failures" : "done"}: ${done} rebuilt, ${failed} failed`,
    );
    if (failed > 0) {
      lastError = failed > 1 ? `${firstFailure} (and ${failed - 1} more)` : firstFailure;
    }
    // A skipped card the re-distill that held it did not rebuild stays stale,
    // and nothing else would reach it before the next cold pass.
    const stillStale = skipped.filter((id) => {
      const card = store.getCard(id);
      return card !== undefined && card.repairReason === undefined && belowGeneration(card);
    });
    if (stillStale.length > 0) {
      logMsg(`repair sweep left ${stillStale.length} card(s) it skipped stale; retrying them`);
    }
    if (failed > 0 || stillStale.length > 0) scheduleSweepRetry();
  }

  // ── Range check (hosts with a projector generation and range digests) ──

  /** This process's sorted card ids for the running range-check sweep, read
   *  when it first needs them and dropped when the sweep completes. */
  let reconcileIds: string[] | undefined;

  function readReconcile(): ReconcileProgress {
    return (
      parseReconcileProgress(store.getMeta(RECONCILE_PROGRESS_KEY)) ?? {
        sweep: 0,
        session: null,
        after: null,
        startedAt: now(),
        previousStartedAt: null,
        checked: 0,
        mismatched: 0,
        at: 0,
      }
    );
  }

  /** The checkpoint of a card the range check may look at now, or
   *  undefined: it must be fully indexed at this generation with a settled
   *  checkpoint and no repair reason, and no write may be pending for it. */
  function checkable(card: Card): CheckpointInfo | undefined {
    const id = card.sessionId;
    if (card.distillState !== "full" || card.repairReason !== undefined) return undefined;
    if (card.projectorGen !== projectorGen) return undefined;
    if (
      unsettled.has(id) ||
      inFlight.has(id) ||
      sweeping.has(id) ||
      reDistillQueue.has(id) ||
      debounceTimers.has(id) ||
      pendingRerun.has(id) ||
      removalSince.has(id)
    ) {
      return undefined;
    }
    const info = sync?.inspect?.(card.distillCursor);
    return info && info.version !== 1 && info.settled ? info : undefined;
  }

  /** The first index in sorted `ids` whose id is at or after `id`. */
  function lowerBound(ids: string[], id: string): number {
    let lo = 0;
    let hi = ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ids[mid]! < id) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Check stored ranges for a change no poll window sees (a part row
   * rewritten in a settled session moves neither the message nor the
   * session watermark). Runs from the poll, one digest read (at most
   * {@link RANGE_ROWS} rows) per poll, only while this process holds the
   * lease, no cold pass or repair sweep runs and no foreground query is in
   * the fetch gate.
   *
   * It walks the cards in session id order, skipping any it may not check
   * ({@link checkable}), at most {@link RECONCILE_SCAN_LIMIT} per poll. For a
   * card it starts at its floor (the lowest `seq` its last full write read;
   * rows below it are not in the card) or at the session's start, and walks
   * the stored spans by their recorded boundaries to its checkpoint
   * ({@link compareSpans}), as many as the digest holds. Matching spans
   * record the current sweep; a mismatch, or rows with no stored hash,
   * dispatches a removal, so the session is re-indexed in full and that
   * write records fresh hashes. The position, the sweep count and the
   * counters persist in {@link RECONCILE_PROGRESS_KEY}.
   */
  async function checkOneRange(): Promise<void> {
    const digest = sync?.rangeDigest;
    if (!rangesOn || !digest || projectorGen === undefined) return;
    if (stopped || coldPassState === "running" || sweepPromise || gate.activeQueries() > 0) return;
    if (!ownsLease()) return;
    reconcileIds ??= store.cardSessionIds().sort();
    const ids = reconcileIds;
    if (ids.length === 0) {
      reconcileIds = undefined;
      return;
    }
    let state = readReconcile();
    let index = state.session === null ? 0 : lowerBound(ids, state.session);
    let after = state.session !== null && ids[index] === state.session ? state.after : null;

    const save = (): void => {
      if (!stopped && ownsLease()) store.setMeta(RECONCILE_PROGRESS_KEY, JSON.stringify(state));
    };
    /** Move to the next card, completing the sweep past the last one. */
    const advance = (): void => {
      index++;
      after = null;
      if (index < ids.length) {
        state = { ...state, session: ids[index]!, after: null };
        return;
      }
      logMsg(
        `range check sweep ${state.sweep + 1} done: ${state.checked} range(s), ${state.mismatched} changed`,
      );
      state = {
        sweep: state.sweep + 1,
        session: null,
        after: null,
        startedAt: now(),
        previousStartedAt: state.startedAt,
        checked: 0,
        mismatched: 0,
        at: state.at,
      };
      reconcileIds = undefined;
    };

    for (let scanned = 0; scanned < RECONCILE_SCAN_LIMIT; scanned++) {
      if (index >= ids.length) {
        // A stored position past every card: the sweep is done.
        index = ids.length - 1;
        advance();
        save();
        return;
      }
      const id = ids[index]!;
      const card = store.getCard(id);
      const info = card ? checkable(card) : undefined;
      if (!info) {
        advance();
        if (index >= ids.length) {
          save();
          return;
        }
        continue;
      }
      const spans = store.getRangeHashes(id);
      // Rows below the floor are not in the card, so the walk starts at it.
      const first = info.floor !== undefined ? info.floor - 1 : BEFORE_FIRST_SEQ;
      // A position inside a stored span means the card's hashes were
      // rewritten since the walk stopped there: walk the card again. A
      // position below the floor (an append that evicted rows raised it
      // since) resumes at the floor.
      const resume =
        after !== null && !spans.some((span) => span.startSeq <= after! && span.endSeq > after!)
          ? Math.max(after, first)
          : first;
      if (resume >= info.seq) {
        advance();
        if (index >= ids.length) {
          save();
          return;
        }
        continue;
      }
      const rows = await gate.runBackground(() => {
        if (stopped || !leaseHeld) return Promise.resolve<RangeRow[] | null>(null);
        return digest(id, resume, RANGE_ROWS);
      });
      if (rows === null || stopped || !ownsLease()) return;
      const found = compareSpans(rows, spans, resume, info.seq);
      state = {
        ...state,
        session: id,
        after: resume,
        checked: state.checked + found.confirmed.length + (found.mismatch ? 1 : 0),
        at: now(),
      };
      const restamp = found.confirmed
        .filter((span) => span.sweepGen !== state.sweep)
        .map((span) => ({ ...span, sweepGen: state.sweep }));
      if (restamp.length > 0) store.putRangeHashes(id, restamp);
      if (found.mismatch) {
        logMsg(
          `session ${id} changed in rows ${found.mismatch.seq} and on (${found.mismatch.reason}); re-indexing it`,
        );
        state = { ...state, mismatched: state.mismatched + 1 };
        advance();
        save();
        dispatch({ type: "removal", sessionID: id });
        return;
      }
      if (found.done) advance();
      else state = { ...state, after: found.verified };
      save();
      return;
    }
    save();
  }

  function quarantine(session: DistillSessionMeta, error: unknown): void {
    // A malformed session is quarantined, not failing: drop any fetch strikes
    // so it is not counted twice or kept alive by the skipped-pass backoff.
    setStrikes(session.id, undefined);
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

  /** Re-arm a cold pass after `delayMs` (default `coldPassRetryMs`): after
   *  an aborted pass (`lastError` set, state idle), or as a follow-up after a
   *  completed one (sessions still failing, or skipped ones on a long
   *  backoff). */
  function scheduleColdPassRetry(followUp = false, delayMs = coldPassRetryMs): void {
    if (stopped || !leaseHeld) return;
    clearTimer(coldPassRetryTimer);
    coldPassRetryTimer = setTimeout(() => {
      coldPassRetryTimer = undefined;
      if (stopped || !leaseHeld || coldPassState === "running") return;
      // An abort's retry is moot once some other pass has run to the end.
      if (followUp || (coldPassState === "idle" && lastError !== undefined)) {
        void startColdPass();
      }
    }, delayMs);
  }

  /** Share this pass's progress in {@link COLD_PASS_PROGRESS_KEY}, at most
   *  every {@link PROGRESS_WRITE_MS} unless `force`. Holder-only (the lease
   *  is verified before the write), and never once the store is complete. */
  let progressWrittenAt = Number.NEGATIVE_INFINITY;
  function shareProgress(force = false, running = true): void {
    if (stopped || !leaseHeld || indexComplete) return;
    const t = now();
    if (!force && t - progressWrittenAt < PROGRESS_WRITE_MS) return;
    if (!ownsLease()) return;
    progressWrittenAt = t;
    store.setMeta(
      COLD_PASS_PROGRESS_KEY,
      JSON.stringify({ examined: examinedCount, known: knownCount, at: t, running }),
    );
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
    if (inFlight.has(sessionID) || sweeping.has(sessionID)) {
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
        let base: SettledBase | undefined;
        if (sync && existing) {
          const change = await tailChange(sessionID, existing.distillCursor);
          if (stopped || !leaseHeld) return;
          if (
            change === "fresh" &&
            !hadRemoval &&
            existing.distillState === "full" &&
            existing.timeUpdated === session.timeUpdated &&
            existing.title === session.title &&
            existing.directory === session.directory &&
            (existing.timeArchived ?? null) === (session.timeArchived ?? null) &&
            // A card below the projector generation is rebuilt whatever its
            // tail says; the repair sweep skips sessions being re-distilled.
            !belowGeneration(existing)
          ) {
            succeeded = true; // nothing changed since the card was written
            return;
          }
          // A running tail changes in place, so it is never appended to: it
          // is read again from its boundary when the card has a settled base
          // there, and in full otherwise.
          rewritten = change === "rewritten" || change === "tail";
          if (change === "tail" && !hadRemoval) base = tailBase(existing);
        }
        // An append extends the stored card, so it must be at this
        // distiller's projector generation (none and NULL are the same). A
        // repair-pending card is re-read in full instead: the loss guard keeps
        // its checkpoint where the last write left it, so an append would page
        // back to it on every turn with no row cap, while the capped full read
        // costs the same each turn and replaces the card once the lossy
        // message is past the cap.
        const canAppend =
          existing != null &&
          existing.distilledThrough != null &&
          existing.partCount > appendThresholdParts &&
          (existing.projectorGen ?? null) === (projectorGen ?? null) &&
          existing.repairReason === undefined &&
          !hadRemoval &&
          !rewritten;
        const result =
          base && existing
            ? await distillTail(session, existing, base)
            : canAppend && existing
              ? await distillAppend(session, existing)
              : await distillFull(session);
        if (stopped || !leaseHeld) return;
        succeeded = true;
        reDistillFailures.delete(sessionID);
        clearStrikesOnSuccess(sessionID); // it fetched fine: no longer failing
        // An unchanged write left readers nothing new: no rollup to refresh
        // and nothing to summarize.
        if (result.changed) {
          // Keep the root's family highlights current with its live children.
          const stored = store.getCard(sessionID);
          if (stored && stored.rootId !== sessionID) recomputeRootRollup(stored.rootId);
          options.onSessionDistilled?.(sessionID);
        }
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
    setStrikes(sessionID, undefined);
    if (rootId && rootId !== sessionID) recomputeRootRollup(rootId);
  }

  function handleMeta(sessionID: string, patch: SessionMetaPatch): void {
    if (!ownsLease()) return; // authoritative: this path writes immediately
    // An unknown session has no card to patch and is picked up by the next
    // distill.
    store.patchCardMeta(sessionID, patch);
  }

  // ── Poll (sync hosts) ──

  function schedulePoll(): void {
    if (!sync || stopped || !leaseHeld) return;
    clearTimer(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      const running = runPoll().finally(() => {
        if (pollPromise === running) pollPromise = undefined;
        schedulePoll();
      });
      pollPromise = running;
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
    // Changes no poll window sees, one digest at a time. This runs before the
    // poll's signals are dispatched: the poll's overlap re-signals a recently
    // active session on every poll, and a session with a re-distill pending
    // is not checked, so after dispatch such a session would never be. By
    // now the previous poll's debounced re-distills have run.
    try {
      await checkOneRange();
    } catch (error) {
      lastError = errmsg(error);
      logMsg(`range check failed: ${lastError}`);
    }
    if (stopped || !leaseHeld) return;
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
      if (store.heartbeatLease(instanceId)) {
        // Keep shared progress fresh through a long stretch on one session.
        if (coldPassState === "running") shareProgress();
        // And the sweep's, so readers never take a long rebuild for a stall.
        if (sweepPromise && sweepProgress) shareRepair(sweepProgress);
        scheduleHeartbeat();
      } else {
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
      noteForeignHolder();
      scheduleLeaseRetry();
    }
  }

  /** The holder and build last logged by {@link noteForeignHolder}. */
  let foreignHolderLogged: string | undefined;
  /**
   * Log, once per holder, a lease held by another build: until that process
   * restarts it keeps writing as its own build (an older one stamps no
   * projector generation and writes cards the repair sweep must rebuild).
   */
  function noteForeignHolder(): void {
    const holder = store.leaseStatus();
    if (!holder?.holder || holder.holder === instanceId || holder.build === build) return;
    const key = `${holder.holder} ${holder.build}`;
    if (key === foreignHolderLogged) return;
    foreignHolderLogged = key;
    logMsg(
      `lease held by ${holder.holder} running build ${holder.build || "(unknown, an older one)"}, not this build ${build}; restart every OpenCode process sharing the store to run one build`,
    );
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
    clearTimer(sweepRetryTimer);
    leaseRetryTimer = undefined;
    coldPassRetryTimer = undefined;
    pollTimer = undefined;
    sweepRetryTimer = undefined;
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
      const running = [coldPassPromise, pollPromise, sweepPromise, ...inFlight.values()].filter(
        (promise): promise is Promise<void> => promise !== undefined,
      );
      stopPromise = Promise.allSettled(running).then(() => {});
      return stopPromise;
    },

    onEvent(signal: DistillSignal): void {
      if (stopped) return;
      dispatch(signal);
    },

    indexing(): IndexingProgress | undefined {
      if (indexComplete) return undefined;
      if (coldPassState === "running" && leaseHeld) {
        const cards = store.cardCount();
        if (knownCount === 0) {
          return cards === 0 ? { indexed: 0, examined: 0, known: 0 } : undefined;
        }
        return knownCount > cards
          ? { indexed: cards, examined: examinedCount, known: knownCount }
          : undefined;
      }
      // Not running a pass here: what the holder shares, if the store is
      // still incomplete. Completion is stamped by whichever process got there.
      if (store.getMeta(COLD_PASS_COMPLETE_KEY) === "1") {
        indexComplete = true;
        return undefined;
      }
      const shared = parseSharedProgress(store.getMeta(COLD_PASS_PROGRESS_KEY));
      if (!shared) return undefined;
      const cards = store.cardCount();
      if (shared.known <= cards) return undefined;
      if (!shared.running || now() - shared.at > PROGRESS_STALE_MS) {
        return { indexed: cards, examined: shared.examined, known: shared.known, stalled: true };
      }
      return { indexed: cards, examined: shared.examined, known: shared.known };
    },

    repair(): RepairStatus | undefined {
      if (projectorGen === undefined) return undefined;
      let sweep = parseRepairProgress(store.getMeta(REPAIR_PROGRESS_KEY));
      // A holder refreshes a running sweep's progress every heartbeat, so an
      // old one is a sweep whose holder went away.
      if (sweep?.running && now() - sweep.at > PROGRESS_STALE_MS) {
        sweep = { ...sweep, running: false, stalled: true };
      }
      const reconcile = parseReconcileProgress(store.getMeta(RECONCILE_PROGRESS_KEY));
      return { ...(sweep && { sweep }), ...(reconcile && { reconcile }) };
    },

    discoveryTruncated(): boolean {
      return store.getMeta(DISCOVERY_TRUNCATED_KEY) === "1";
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
        skippedCount: skippedSessions,
        failingCount: failingSessions,
        ...(lastError !== undefined ? { lastError } : {}),
        ...(lease ? { lease } : {}),
      };
    },
  };
}
