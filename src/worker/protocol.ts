import type { DistillSignal, DistillStatus, RepairStatus, SessionMetaPatch } from "../distill.js";
import type { HistoryDrift } from "../history/source.js";
import type { IndexingProgress, Limits } from "../types.js";

/**
 * The messages between the thread that serves the tools (main) and the
 * distiller's worker thread.
 *
 * Every message carries the protocol version (`v`) and the worker generation
 * it belongs to (`generation`, counted from 1 per runtime). Main drops any
 * message whose version differs or whose generation is not the current one,
 * so a retired worker's late replies and status never reach the next one's
 * state. A request that expects a reply (`init`, `vectors`, `stop`) carries an
 * `id` and an absolute `deadline` (ms epoch); its reply names the same `id`
 * and says whether the request was committed or refused, and why.
 *
 * Only small messages cross: paths, options, signals, counters, status and
 * vector rows. No `opencode.db` row, history page, card or slim-index row set
 * goes either way.
 */

export const PROTOCOL_VERSION = 1;

/** The worker module, next to the plugin's entry in `dist/`. */
export const WORKER_ENTRY = "./distill-worker.js";

/** How long a started worker has to report `ready`. */
export const WORKER_READY_TIMEOUT_MS = 10_000;
/** How long a worker has to report its store after `init`. */
export const WORKER_STORE_TIMEOUT_MS = 10_000;
/** How long a vector write waits for its acknowledgement. */
export const VECTOR_WRITE_DEADLINE_MS = 10_000;
/** The most requests main keeps waiting on a reply at once. */
export const MAX_PENDING_REQUESTS = 8;

/** The least time between two status messages. */
export const STATUS_EVERY_MS = 1_000;
/** How often the worker looks for a status change. */
export const STATUS_CHECK_MS = 250;
/** The worker's first wait before it opens a store again whose write lock
 *  another connection held; each later wait doubles, up to
 *  {@link STORE_LOCK_RETRY_MAX_MS}. */
export const STORE_LOCK_RETRY_FIRST_MS = 1_000;
export const STORE_LOCK_RETRY_MAX_MS = 30_000;
/** Log lines the worker posts in one second at most; the rest are counted
 *  and reported as dropped with the next line it posts. */
export const LOG_LINES_PER_SECOND = 200;
/** A log line is cut to this many characters before it is posted. */
export const LOG_LINE_CHARS = 2_000;

/** Signals one `events` message carries at most. */
export const EVENT_BATCH = 256;
/** `events` messages main lets wait on the worker's `ack` at once; later
 *  signals keep coalescing in its outbox until one is acknowledged. */
export const MAX_UNACKED_BATCHES = 2;
/** Sessions main's event outbox holds at most. */
export const OUTBOX_SESSIONS = 4_096;
/** Bytes main's event outbox holds at most (session ids and patch text). */
export const OUTBOX_BYTES = 1 << 20;

type Envelope = { v: typeof PROTOCOL_VERSION; generation: number };

// ── Main to worker ───────────────────────────────────────────────────────────

/** The poll and scan timings the worker's history sync takes (the numeric
 *  `V2SyncOptions`). */
export type WorkerSyncOptions = {
  pollIntervalMs?: number;
  sessionScanEveryMs?: number;
  reconcileEveryMs?: number;
  overlapMs?: number;
  maxLookbackMs?: number;
  pollSessionLimit?: number;
  pollPageRows?: number;
  pollPages?: number;
  sessionScanLimit?: number;
  tailRows?: number;
  abandonAfterMs?: number;
  fingerprintRows?: number;
};

export type InitMessage = Envelope & {
  type: "init";
  id: number;
  deadline: number;
  /** The main bundle's `BUILD_ID`, the store build tag, the representation
   *  generation and the projector generation: the worker refuses to start
   *  unless all four are its own. */
  buildId: string;
  build: string;
  representation: number;
  projectorGen: number;
  storePath: string;
  /** The canonical `opencode.db` path, which is also the store's source
   *  identity. */
  sourcePath: string;
  /** The lease holder id this generation distills as. */
  holderId: string;
  /** The predecessor generation's holder id, whose lease the first acquire
   *  may take over. */
  takeOver?: string;
  limits: Limits;
  sync?: WorkerSyncOptions;
  idleDebounceMs?: number;
  /** The foreground signal's counter (`ForegroundSignal.buffer`). */
  foreground: SharedArrayBuffer;
};

/** Distiller signals, already coalesced per session ({@link EventOutbox}).
 *  The worker answers each with an `ack` naming its `batch`. */
export type EventsMessage = Envelope & { type: "events"; batch: number; signals: DistillSignal[] };

/** One card vector to persist; `embedding` is transferred when it is a whole
 *  buffer of its own. */
export type VectorRow = { sessionId: string; embedding: Uint8Array; expectedSummaryHash: string };

export type VectorsMessage = Envelope & {
  type: "vectors";
  id: number;
  deadline: number;
  model: string;
  representation: number;
  rows: VectorRow[];
};

export type StopMessage = Envelope & { type: "stop"; id: number; deadline: number };

export type MainMessage = InitMessage | EventsMessage | VectorsMessage | StopMessage;

// ── Worker to main ───────────────────────────────────────────────────────────

/** What the worker reports about its distiller ({@link StatusMessage}). */
export type WorkerStatus = {
  holderId: string;
  distill: DistillStatus;
  indexing?: IndexingProgress;
  repair?: RepairStatus;
  discoveryTruncated: boolean;
  /** What the worker's own `opencode.db` reads could not project. */
  drift?: HistoryDrift;
  /** The longest synchronous store call since the last status, in ms. */
  longestStoreCallMs: number;
};

export type ReadyMessage = Envelope & { type: "ready"; buildId: string };

export type StoreMessage = Envelope &
  (
    | { type: "store"; id: number; ok: true; warning?: string }
    | { type: "store"; id: number; ok: false; reason: string }
  );

export type StatusMessage = Envelope & { type: "status"; status: WorkerStatus };

/** The store's open found its write lock held by another connection past the
 *  busy timeout. The worker opens it again after `retryInMs`; this is no
 *  failure, and the store result follows once an open gets the lock. */
export type WaitingMessage = Envelope & {
  type: "waiting";
  reason: string;
  attempt: number;
  retryInMs: number;
};

/** The worker handed every signal of `events` message `batch` to its
 *  distiller. */
export type AckMessage = Envelope & { type: "ack"; batch: number };

export type LogMessage = Envelope & { type: "log"; line: string; dropped?: number };

/** `store`: the store refused or is damaged, which no restart can fix.
 *  `crash`: anything else that ended the worker's work. */
export type FatalMessage = Envelope & { type: "fatal"; kind: "store" | "crash"; reason: string };

export type ReplyMessage = Envelope & {
  type: "reply";
  id: number;
  outcome: "committed" | "refused" | "failed";
  /** Why a request was refused or failed. */
  reason?: string;
  /** `vectors_rev` right after a committed vector write. */
  revision?: number;
};

export type StoppedMessage = Envelope & { type: "stopped"; id: number };

export type WorkerMessage =
  | ReadyMessage
  | StoreMessage
  | StatusMessage
  | WaitingMessage
  | AckMessage
  | LogMessage
  | FatalMessage
  | ReplyMessage
  | StoppedMessage;

const MAIN_TYPES = new Set(["init", "events", "vectors", "stop"]);
const WORKER_TYPES = new Set([
  "ready",
  "store",
  "status",
  "waiting",
  "ack",
  "log",
  "fatal",
  "reply",
  "stopped",
]);

function enveloped(value: unknown, types: Set<string>): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { v, generation, type } = value as Record<string, unknown>;
  return (
    v === PROTOCOL_VERSION &&
    typeof generation === "number" &&
    Number.isInteger(generation) &&
    typeof type === "string" &&
    types.has(type)
  );
}

/** Whether `value` is a message main sends, at this protocol version. */
export function isMainMessage(value: unknown): value is MainMessage {
  return enveloped(value, MAIN_TYPES);
}

/** Whether `value` is a message a worker sends, at this protocol version. */
export function isWorkerMessage(value: unknown): value is WorkerMessage {
  return enveloped(value, WORKER_TYPES);
}

/** The buffers of `rows` that can be transferred: each embedding that views
 *  the whole of a buffer no other row shares. Any other embedding is copied
 *  by the structured clone instead. */
export function transferableBuffers(rows: readonly VectorRow[]): ArrayBuffer[] {
  const seen = new Map<ArrayBufferLike, number>();
  for (const row of rows) {
    const buffer = row.embedding.buffer;
    seen.set(buffer, (seen.get(buffer) ?? 0) + 1);
  }
  const transfer: ArrayBuffer[] = [];
  for (const row of rows) {
    const { buffer, byteOffset, byteLength } = row.embedding;
    if (
      buffer instanceof ArrayBuffer &&
      seen.get(buffer) === 1 &&
      byteOffset === 0 &&
      byteLength === buffer.byteLength
    ) {
      transfer.push(buffer);
    }
  }
  return transfer;
}

// ── Main's event outbox ──────────────────────────────────────────────────────

/** One session's pending signals, merged. */
type Pending = {
  deleted: boolean;
  removal: boolean;
  /** A re-distill: a turn ended. */
  recheck: boolean;
  /** The metadata patches seen, merged field by field, later values first. */
  patch?: SessionMetaPatch;
  /** Metadata changed without a patch, or with one that did not fit the byte
   *  bound: a patchless `meta`, for which the distiller reads the session's
   *  metadata from `opencode.db` again. It also re-distills the session, so
   *  it stands for a re-check too. */
  reread: boolean;
  bytes: number;
};

/** The bytes charged for one field over its text: the key, the value's
 *  header and the slot that holds it. */
const FIELD_OVERHEAD_BYTES = 16;
/** The bytes charged for one session's entry over its id's text. */
const ENTRY_OVERHEAD_BYTES = 32;

/** A conservative size for `text`: 2 bytes per UTF-16 code unit, the most a
 *  JavaScript string takes per code unit in memory and in the structured
 *  clone that posts it, plus the field's overhead. */
function textBytes(text: string | undefined): number {
  return text === undefined ? 0 : 2 * text.length + FIELD_OVERHEAD_BYTES;
}

/** What a session's entry costs before any patch. */
function entryBytes(sessionID: string): number {
  return 2 * sessionID.length + ENTRY_OVERHEAD_BYTES;
}

function patchBytes(patch: SessionMetaPatch | undefined): number {
  if (!patch) return 0;
  return (
    textBytes(patch.title) +
    textBytes(patch.directory) +
    textBytes(patch.projectId) +
    (patch.timeArchived !== undefined ? FIELD_OVERHEAD_BYTES : 0) +
    FIELD_OVERHEAD_BYTES
  );
}

/** Whether a session's pending signals hold something only the history
 *  sync's slower scans would find again: a deletion or a metadata change. */
function holdsChange(pending: Pending): boolean {
  return pending.deleted || pending.patch !== undefined || pending.reread;
}

/**
 * Main's outbox of distiller signals, coalesced per session while they wait
 * to be posted. Coalescing loses no deletion, metadata patch or archive
 * change: a deletion is kept as one, patches merge field by field (the later
 * value wins), metadata changes without a patch become one patchless `meta`,
 * and turn ends become one re-check of the session; the distiller answers
 * the last two by reading `opencode.db` again. A deleted session's other
 * signals are dropped with it.
 *
 * At {@link OUTBOX_SESSIONS} sessions or {@link OUTBOX_BYTES} bytes, a new
 * session evicts the oldest session that holds only a re-check or a removal,
 * which the history sync's poll finds again; when every pending session
 * holds a deletion or a metadata change, the new session's signal is dropped
 * and counted. The sync's session scan and its deletion reconcile then catch
 * it. A patch that would take the outbox past its byte bound, merged or new,
 * is replaced by a patchless `meta` signal: the distiller then reads the
 * session's metadata from `opencode.db` again, so the change is kept without
 * its text.
 */
export type EventOutbox = {
  add(signal: DistillSignal): void;
  /** Every pending signal in the order its session first arrived, emptied.
   *  With `limit`, only the sessions whose signals fit in `limit` together,
   *  the first one always, which leave the outbox whole. */
  drain(limit?: number): DistillSignal[];
  /** Put `older` back ahead of every signal pending: the pending ones are
   *  added again after them, so for a session they share, the pending
   *  signals win as later arrivals do. The bounds apply as to any add. */
  requeue(older: readonly DistillSignal[]): void;
  size(): number;
  /** Signals dropped at the bound since the outbox was made. */
  dropped(): number;
};

export function createEventOutbox(bounds: { sessions?: number; bytes?: number } = {}): EventOutbox {
  const maxSessions = bounds.sessions ?? OUTBOX_SESSIONS;
  const maxBytes = bounds.bytes ?? OUTBOX_BYTES;
  const pending = new Map<string, Pending>();
  let bytes = 0;
  let dropped = 0;

  const evictOne = (): boolean => {
    for (const [id, entry] of pending) {
      if (holdsChange(entry)) continue;
      pending.delete(id);
      bytes -= entry.bytes;
      dropped++;
      return true;
    }
    return false;
  };

  const outbox: EventOutbox = {
    add(signal) {
      const id = signal.sessionID;
      let entry = pending.get(id);
      if (!entry) {
        const base = entryBytes(id);
        // Room for the patch too while evicting allows, unless it could never
        // fit; the session alone must fit, and its patch becomes a re-read
        // when it does not.
        const whole = base + (signal.type === "meta" ? patchBytes(signal.patch) : 0);
        const cost = whole <= maxBytes ? whole : base;
        while (pending.size >= maxSessions || bytes + cost > maxBytes) {
          if (!evictOne()) break;
        }
        if (pending.size >= maxSessions || bytes + base > maxBytes) {
          dropped++;
          return;
        }
        entry = { deleted: false, removal: false, recheck: false, reread: false, bytes: base };
        pending.set(id, entry);
        bytes += entry.bytes;
      }
      if (entry.deleted) return;
      switch (signal.type) {
        case "deleted":
          bytes -= patchBytes(entry.patch);
          entry.bytes -= patchBytes(entry.patch);
          entry.deleted = true;
          entry.removal = false;
          entry.recheck = false;
          entry.reread = false;
          entry.patch = undefined;
          return;
        case "removal":
          entry.removal = true;
          return;
        case "turn-ended":
          entry.recheck = true;
          return;
        case "meta": {
          if (!signal.patch) {
            entry.reread = true;
            return;
          }
          const before = patchBytes(entry.patch);
          const merged = { ...entry.patch, ...signal.patch };
          const after = patchBytes(merged);
          if (bytes - before + after > maxBytes) {
            entry.patch = undefined;
            entry.reread = true;
            entry.bytes -= before;
            bytes -= before;
            return;
          }
          entry.patch = merged;
          entry.bytes += after - before;
          bytes += after - before;
          return;
        }
      }
    },
    drain(limit = Infinity) {
      const out: DistillSignal[] = [];
      for (const [sessionID, entry] of pending) {
        const signals: DistillSignal[] = [];
        if (entry.deleted) {
          signals.push({ type: "deleted", sessionID });
        } else {
          if (entry.patch) signals.push({ type: "meta", sessionID, patch: entry.patch });
          // A patchless meta re-distills the session, as a re-check does.
          if (entry.reread) signals.push({ type: "meta", sessionID });
          if (entry.removal) signals.push({ type: "removal", sessionID });
          if (entry.recheck && !entry.reread) signals.push({ type: "turn-ended", sessionID });
        }
        if (out.length > 0 && out.length + signals.length > limit) break;
        out.push(...signals);
        pending.delete(sessionID);
        bytes -= entry.bytes;
      }
      return out;
    },
    requeue(older) {
      // A pending session's drained signals coalesce again to the same
      // entry, so adding them after `older` merges exactly as their own
      // arrival after `older` would have.
      const newer = outbox.drain();
      for (const signal of older) outbox.add(signal);
      for (const signal of newer) outbox.add(signal);
    },
    size: () => pending.size,
    dropped: () => dropped,
  };
  return outbox;
}
