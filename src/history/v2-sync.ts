import type { ReadOnlyDb, Row, SqlValue } from "../sqlite.js";
import { cyrb53 } from "../hash.js";
import { yieldOnBudget } from "../yield.js";
import type {
  CheckpointInfo,
  DistillCheckpoint,
  DistillSignal,
  DistillSync,
  PollMeta,
  PollResult,
  RangeRow,
  TailChange,
} from "../distill.js";
import { inspectV2Schema, type V2SchemaInfo } from "./v2.js";

/**
 * Freshness for the v2 distiller, read straight from `opencode.db`.
 *
 * v2 events are live only and are lost while the service is down or a
 * location is evicted, so they are a latency hint. This module is what keeps
 * the store correct without them:
 *
 * - **Checkpoints.** Before each distill the session's tail is snapshotted
 *   (see {@link Checkpoint}, stored as `card.distill_cursor`). A later
 *   {@link DistillSync.compare} tells an unchanged tail from appended rows
 *   and from a rewritten one (a revert removes the checkpoint row; streaming
 *   output updates it in place). opencode 2.4 writes an assistant's content
 *   to `session_part` without touching its message row, so the checkpoint
 *   also records the part state of the newest row (the belt) and a
 *   fingerprint of the rows ending at it, each row with its part count and
 *   newest part `time_updated`. Rows appended after the checkpoint are
 *   outside the fingerprint, so they read as growth, never as a rewrite.
 * - **Unsettled tails.** An assistant without `time.completed`, or a shell or
 *   compaction still `running`, among the newest rows marks the checkpoint
 *   unsettled, which the distiller re-reads on every poll. The predicate is
 *   the one opencode's fork projector uses (`core/src/session/projector.ts`).
 *   A row unchanged for {@link V2SyncOptions.abandonAfterMs} counts as
 *   settled, so a crashed turn cannot keep a session re-distilling forever.
 *   An unsettled checkpoint also records its boundary, the newest settled
 *   row below the running ones, with a fingerprint of the rows ending at it:
 *   while those rows are unchanged, only the rows past the boundary need
 *   reading again (`tail`).
 * - **The poll** (lease holder only): every 30 s the message window reads
 *   the rows created past a persisted watermark and up to its cutoff, the
 *   start of the poll that began the window, through the indexed
 *   `session_message_time_created_idx`, in pages of `pollPageRows` rows
 *   keyed by `(time_created, id)` with a yield before each, at most
 *   `pollPages` of them a poll, and signals the sessions they belong to, at
 *   most `pollSessionLimit` per poll. A window resumed by later polls keeps
 *   its cutoff. Once drained, it sets its watermark to the cutoff, so a row
 *   committed behind the position while the pages were read is read again
 *   by the next window. Every 5
 *   minutes a bounded scan of `session_v2`, one page keyed by `(time,
 *   session id)`, catches renames, moves, archiving and other metadata-only
 *   changes. Both watermarks carry an overlap for late commits. A window
 *   with more in it than one poll takes keeps its position between polls,
 *   and its watermark moves only once it is drained. So a window that fills
 *   up (more changed sessions than the limit, or many sharing one timestamp
 *   inside the overlap) always moves forward on the next poll. Every
 *   `reconcileEveryMs` the poll also drops cards of sessions that are gone
 *   from `session_v2`, so a deletion with no event is caught without a new
 *   cold pass. A poll returns its watermark updates for the distiller to
 *   commit after it dispatched the signals, and a failing window is
 *   isolated from the other. A part-only change in a settled session moves
 *   neither window; the distiller's range check finds it
 *   ({@link DistillSync.rangeDigest}).
 * - **Range digests.** A session's rows in `seq` order with the state of
 *   their part rows, for the distiller's range hashes, and which sessions
 *   have part rows at all ({@link DistillSync.withParts}).
 *
 * Every `session_message` and `session_part` statement binds `LIMIT ?`,
 * reads happen one statement at a time with a yield point between them
 * that yields to the event loop once a slice of work has run, and nothing
 * here writes to `opencode.db`.
 */

export const POLL_WATERMARK_KEY = "v2_poll_watermark";
export const SESSION_WATERMARK_KEY = "v2_session_watermark";
/** The message poll's position `[time, sessionId]` as older builds keep it,
 *  by session. Read only as a lower bound, so a window an older build left
 *  half drained is read again from there, and cleared once a window drains. */
export const POLL_CURSOR_KEY = "v2_poll_cursor";
/** The session scan's keyset position `[time, sessionId]` inside a window
 *  being drained; empty when the window starts fresh. */
export const SESSION_CURSOR_KEY = "v2_session_cursor";
/** The message poll's position `[time_created, messageId, cutoff]` inside a
 *  window being drained: the last row it read and the start of the poll that
 *  began the window, which every poll of the window reads up to. Empty when
 *  the window starts fresh. */
export const POLL_ROW_CURSOR_KEY = "v2_poll_row_cursor";

export type V2SyncOptions = {
  /** Message poll interval. Default 30 s. */
  pollIntervalMs?: number;
  /** Minimum time between `session_v2` scans. Default 5 minutes. */
  sessionScanEveryMs?: number;
  /** Minimum time between the poll's deletion reconciles (cards whose
   *  session is gone from `session_v2`). Default 5 minutes. */
  reconcileEveryMs?: number;
  /** Watermark overlap for rows committed after their timestamp. Default 5 s. */
  overlapMs?: number;
  /** A watermark older than this is clamped (the cold pass covers the rest).
   *  Default 1 hour. */
  maxLookbackMs?: number;
  /** Sessions returned by one message poll. Default 500. */
  pollSessionLimit?: number;
  /** Message rows one statement of the message poll reads. Default 2,000. */
  pollPageRows?: number;
  /** Statements one message poll runs at most; the next poll goes on from
   *  where it stopped. Default 10. */
  pollPages?: number;
  /** Sessions returned by one `session_v2` scan (one page). Default 2,000. */
  sessionScanLimit?: number;
  /** Rows inspected for an unsettled tail. Default 20. */
  tailRows?: number;
  /** An unsettled row untouched this long counts as settled. Default 1 hour. */
  abandonAfterMs?: number;
  /** Rows ending at the checkpoint row that its fingerprint covers.
   *  Default 64. */
  fingerprintRows?: number;
  /** What the schema check found (`openOpencodeDb`'s `schema`), which says
   *  whether `session_part` is read. Default: probed once. */
  schema?: V2SchemaInfo;
  now?: () => number;
  /** Awaited between statements. Default: {@link yieldOnBudget}, which
   *  yields to the event loop only once a slice of work has run. */
  yieldBetween?: () => Promise<void>;
};

/**
 * The stored checkpoint (`card.distill_cursor`). Version 1, written by older
 * builds, lacks the part state and the fingerprint and always compares as
 * rewritten.
 */
type Checkpoint = {
  v: 2;
  /** The newest row: its `seq`, id and `time_updated` (0 and null for an
   *  empty session). */
  seq: number;
  msgId: string | null;
  msgUpdated: number;
  /** The session's recency, as the session scan computes it. */
  sessKey: number;
  /** The lowest `seq` of a row still running, or null when settled. */
  unsettled: number | null;
  /** With a running tail, the boundary: the newest row below the running
   *  ones (its `seq` and id) and the hash of the rows ending at it, as `fp`
   *  hashes those ending at `seq`. `covered` when `fp` covers every row past
   *  the boundary. Absent when the checkpoint is settled, or when no row
   *  below the running ones is among the rows it inspected (so none is known
   *  to be settled). */
  base?: { seq: number; id: string; fp: string; covered?: true };
  /** Part rows of the newest row and their newest `time_updated` (0 when
   *  it has none). */
  parts: number;
  partsUpdated: number;
  /** Hash of the rows ending at `seq` (at most `fingerprintRows`), each with
   *  its id, `time_updated` and part state. */
  fp: string;
  /** The lowest `seq` the write read, when it stopped at the per-session
   *  row cap. Absent when it read the whole session. */
  floor?: number;
  /** Messages the card holds cut short (they end in a placeholder). */
  cut?: number;
  /** The write that stored this checkpoint found the tail moved during its
   *  read: the checkpoint is the one taken before the read, and the card may
   *  hold rows newer than it describes. */
  moved?: true;
};

/** A stored checkpoint of any version: the fields every version shares,
 *  checked, and the rest unchecked. */
type StoredCheckpoint = { v: 1 | 2; seq: number; unsettled: number | null } & Partial<
  Omit<Checkpoint, "v" | "seq" | "unsettled">
>;

const MISSING_CHUNK = 500;
/** Message ids per `session_part` statement. */
const PART_CHUNK = 500;
/** Rows one range digest reads at most. */
export const RANGE_DIGEST_MAX = 500;

function num(value: SqlValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function str(value: SqlValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/** `n` comma-separated SQL parameters. */
function bindList(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

type KeysetPos = { t: number; id: string };

function parsePos(stored: string | undefined): KeysetPos | null {
  if (!stored) return null;
  try {
    const value = JSON.parse(stored) as unknown;
    if (
      Array.isArray(value) &&
      typeof value[0] === "number" &&
      Number.isFinite(value[0]) &&
      typeof value[1] === "string"
    ) {
      return { t: value[0], id: value[1] };
    }
  } catch {
    // A garbled position restarts the window.
  }
  return null;
}

/** The message poll's row position, with the cutoff of the window it is in
 *  when the position records one (`[time, messageId, cutoff]`). */
function parseRowPos(stored: string | undefined): (KeysetPos & { cutoff?: number }) | null {
  const pos = parsePos(stored);
  if (!pos) return null;
  const cutoff = (JSON.parse(stored!) as unknown[])[2];
  return typeof cutoff === "number" && Number.isFinite(cutoff) ? { ...pos, cutoff } : pos;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A stored checkpoint's shared fields (`v`, `seq`, `unsettled`) checked, or
 *  null for anything that is not a checkpoint of a known version. */
function parseAny(stored: string | null | undefined): StoredCheckpoint | null {
  if (typeof stored !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const cp = value as Record<string, unknown>;
  if ((cp.v !== 1 && cp.v !== 2) || !isNumber(cp.seq)) return null;
  if (!(cp.unsettled === null || isNumber(cp.unsettled))) return null;
  return cp as StoredCheckpoint;
}

function parseCheckpoint(stored: string | null | undefined): Checkpoint | null {
  const value = parseAny(stored);
  if (
    value === null ||
    value.v !== 2 ||
    !isNumber(value.msgUpdated) ||
    !isNumber(value.sessKey) ||
    !(value.msgId === null || typeof value.msgId === "string") ||
    !isNumber(value.parts) ||
    !isNumber(value.partsUpdated) ||
    typeof value.fp !== "string" ||
    !(value.floor === undefined || isNumber(value.floor)) ||
    !(value.cut === undefined || isNumber(value.cut)) ||
    !(value.base === undefined || isBase(value.base)) ||
    !(value.moved === undefined || value.moved === true)
  ) {
    return null;
  }
  return value as Checkpoint;
}

function isBase(value: unknown): value is Checkpoint["base"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const base = value as Record<string, unknown>;
  return (
    isNumber(base.seq) &&
    typeof base.id === "string" &&
    typeof base.fp === "string" &&
    (base.covered === undefined || base.covered === true)
  );
}

/**
 * What a stored checkpoint records beyond freshness, or null when `stored`
 * is not a checkpoint. Version 1 checkpoints (older builds) report their
 * version and tail only.
 */
export function inspectCheckpoint(stored: string | null | undefined): CheckpointInfo | null {
  const value = parseAny(stored);
  if (!value) return null;
  const seq = value.seq;
  const settled = value.unsettled === null;
  if (value.v === 1) return { version: 1, seq, settled };
  const cp = parseCheckpoint(stored);
  if (!cp) return null;
  return {
    version: 2,
    seq,
    settled,
    ...(!settled && cp.base !== undefined && { boundary: cp.base.seq }),
    ...(cp.floor !== undefined && { floor: cp.floor }),
    ...(cp.cut !== undefined && cp.cut > 0 && { cut: cp.cut }),
    ...(cp.moved && { moved: true }),
  };
}

/** `stored` with a write's row floor, cut messages and moved read recorded;
 *  any other value (an older version, garbage) is returned unchanged. */
export function annotateCheckpoint(
  stored: string,
  info: { floor?: number; cut?: number; moved?: boolean },
): string {
  const cp = parseCheckpoint(stored);
  if (!cp) return stored;
  const next: Checkpoint = { ...cp };
  delete next.floor;
  delete next.cut;
  delete next.moved;
  if (info.floor !== undefined) next.floor = info.floor;
  if (info.cut !== undefined && info.cut > 0) next.cut = info.cut;
  if (info.moved) next.moved = true;
  return JSON.stringify(next);
}

/**
 * Whether `current`, a checkpoint just taken, shows that nothing past the
 * boundary of `stored`, a card's checkpoint, changed: both describe the same
 * running tail field for field (the write's annotations aside), and
 * `current`'s fingerprint covers every row past the boundary, so no row
 * there changed unseen. Never for a checkpoint a moved read stored, whose
 * card may hold rows newer than it describes.
 */
export function sameTail(stored: string | null | undefined, current: string): boolean {
  const before = parseCheckpoint(stored);
  const now = parseCheckpoint(current);
  if (!before || !now || before.moved || before.unsettled === null || !now.base?.covered) {
    return false;
  }
  const strip = (cp: Checkpoint): string => {
    const rest: Checkpoint = { ...cp };
    delete rest.floor;
    delete rest.cut;
    delete rest.moved;
    return JSON.stringify(rest);
  };
  return strip(before) === strip(now);
}

export function createV2Sync(db: ReadOnlyDb, opts: V2SyncOptions = {}): DistillSync {
  const pollIntervalMs = opts.pollIntervalMs ?? 30_000;
  const sessionScanEveryMs = opts.sessionScanEveryMs ?? 300_000;
  const reconcileEveryMs = opts.reconcileEveryMs ?? 300_000;
  const overlapMs = opts.overlapMs ?? 5_000;
  const maxLookbackMs = opts.maxLookbackMs ?? 3_600_000;
  const pollSessionLimit = Math.max(1, Math.floor(opts.pollSessionLimit ?? 500));
  const pollPageRows = Math.max(1, Math.floor(opts.pollPageRows ?? 2_000));
  const pollPages = Math.max(1, Math.floor(opts.pollPages ?? 10));
  const sessionScanLimit = opts.sessionScanLimit ?? 2_000;
  const tailRows = opts.tailRows ?? 20;
  const abandonAfterMs = opts.abandonAfterMs ?? 3_600_000;
  const fingerprintRows = Math.max(1, Math.floor(opts.fingerprintRows ?? 64));
  const now = opts.now ?? Date.now;
  const pause = opts.yieldBetween ?? yieldOnBudget;
  /** Whether `session_part` is read (opencode 2.4+). */
  const partsOn = (opts.schema ?? inspectV2Schema(db)).parts;
  let lastScanAt = Number.NEGATIVE_INFINITY;

  /** `time_compacting` exists in every 2.0.x schema, but it is not one of the
   *  columns the history source requires, so check before reading it. */
  let recencyExpr: string | undefined;
  function recency(): string {
    if (recencyExpr === undefined) {
      let compacting: boolean;
      try {
        compacting = db
          .all("PRAGMA table_info(session_v2)")
          .some((row) => row.name === "time_compacting");
      } catch {
        compacting = false;
      }
      // Multi-argument max() is NULL when any argument is: wrap every
      // nullable operand.
      recencyExpr = compacting
        ? "max(time_updated, coalesce(time_idle, 0), coalesce(time_compacting, 0))"
        : "max(time_updated, coalesce(time_idle, 0))";
    }
    return recencyExpr;
  }

  /** The session's recency, by the same expression the session scan uses,
   *  so a scan and a checkpoint agree on what "changed" means. */
  function sessionKey(sessionID: string): number | null {
    const row = db.get(`SELECT ${recency()} AS k FROM session_v2 WHERE id = ?`, [sessionID]);
    return row ? (num(row.k) ?? 0) : null;
  }

  function unsettledSeq(rows: Row[], at: number): number | null {
    let first: number | null = null;
    for (const row of rows) {
      const type = str(row.type);
      const running =
        (type === "assistant" && row.completed === null) ||
        ((type === "shell" || type === "compaction") && row.status === "running");
      if (!running) continue;
      const updated = num(row.time_updated) ?? 0;
      if (at - updated >= abandonAfterMs) continue; // abandoned, not running
      const seq = num(row.seq);
      if (seq !== null && (first === null || seq < first)) first = seq;
    }
    return first;
  }

  /**
   * Part count, newest part `time_updated` and part types of each of `ids`
   * (messages of `sessionID`): one grouped `session_part` statement per
   * {@link PART_CHUNK} ids, each after a yield. Messages without part rows,
   * and every message on a database without `session_part`, are absent.
   */
  async function partState(
    sessionID: string,
    ids: string[],
    withTypes: boolean,
  ): Promise<Map<string, { parts: number; updated: number; types: string[] }>> {
    const out = new Map<string, { parts: number; updated: number; types: string[] }>();
    if (!partsOn || ids.length === 0) return out;
    const types = withTypes ? ", group_concat(DISTINCT type) AS types" : "";
    for (let i = 0; i < ids.length; i += PART_CHUNK) {
      const chunk = ids.slice(i, i + PART_CHUNK);
      await pause();
      const rows = db.all(
        `SELECT message_id, count(*) AS n, max(time_updated) AS t${types} FROM session_part
         WHERE session_id = ? AND message_id IN (${bindList(chunk.length)})
         GROUP BY message_id LIMIT ?`,
        [sessionID, ...chunk, chunk.length],
      );
      for (const row of rows) {
        const listed = str(row.types);
        out.set(str(row.message_id) ?? "", {
          parts: num(row.n) ?? 0,
          updated: num(row.t) ?? 0,
          types: listed ? listed.split(",").sort() : [],
        });
      }
    }
    return out;
  }

  /**
   * The fingerprint of the rows ending at `seq`: up to `fingerprintRows`
   * rows newest first, each as `(seq, id, time_updated, part count, newest
   * part time_updated)`, read by two bounded statements. Rows after `seq`
   * are outside it, so appended rows never change it. `newest` is the row
   * at the top of the window, with its part state (the belt). `reaches` is
   * the lowest `seq` the window covers: the oldest row in it, or none when
   * the window holds every row through `seq`.
   */
  async function fingerprint(
    sessionID: string,
    seq: number,
  ): Promise<{
    hash: string;
    newest?: { seq: number; id: string; updated: number; parts: number; partsUpdated: number };
    reaches: number;
  }> {
    await pause();
    const rows = db.all(
      `SELECT seq, id, time_updated FROM session_message
       WHERE session_id = ? AND seq <= ? ORDER BY seq DESC LIMIT ?`,
      [sessionID, seq, fingerprintRows],
    );
    const ids = rows.map((row) => str(row.id) ?? "");
    const parts = await partState(sessionID, ids, false);
    const lines: string[] = [];
    let newest:
      | { seq: number; id: string; updated: number; parts: number; partsUpdated: number }
      | undefined;
    for (const row of rows) {
      const id = str(row.id) ?? "";
      const own = parts.get(id);
      const entry = {
        seq: num(row.seq) ?? 0,
        id,
        updated: num(row.time_updated) ?? 0,
        parts: own?.parts ?? 0,
        partsUpdated: own?.updated ?? 0,
      };
      newest ??= entry;
      lines.push(
        `${entry.seq}\t${entry.id}\t${entry.updated}\t${entry.parts}\t${entry.partsUpdated}`,
      );
    }
    const reaches =
      rows.length < fingerprintRows
        ? Number.NEGATIVE_INFINITY
        : (num(rows[rows.length - 1]?.seq) ?? Number.POSITIVE_INFINITY);
    return { hash: cyrb53(lines.join("\n")), ...(newest && { newest }), reaches };
  }

  async function checkpoint(sessionID: string): Promise<DistillCheckpoint | null> {
    const sessKey = sessionKey(sessionID);
    if (sessKey === null) return null;
    await pause();
    const rows = db.all(
      `SELECT seq, id, type, time_updated,
         CASE WHEN type = 'assistant' THEN
           CASE WHEN json_valid(data) THEN json_extract(data, '$.time.completed') END
         END AS completed,
         CASE WHEN type IN ('shell', 'compaction') THEN
           CASE WHEN json_valid(data) THEN json_extract(data, '$.status') END
         END AS status
       FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT ?`,
      [sessionID, tailRows],
    );
    const tail = rows[0];
    const unsettled = unsettledSeq(rows, now());
    const seq = num(tail?.seq) ?? 0;
    const msgId = str(tail?.id);
    const fp =
      msgId === null
        ? { hash: cyrb53(""), reaches: Number.NEGATIVE_INFINITY }
        : await fingerprint(sessionID, seq);
    // The belt is the tail row's own part state; a fingerprint whose newest
    // row is another one (the tail was removed between the statements) then
    // fails the next compare, as it should.
    const belt = "newest" in fp && fp.newest?.id === msgId ? fp.newest : undefined;
    const found = unsettled === null ? undefined : await boundary(sessionID, rows, unsettled);
    const base = found && fp.reaches <= found.seq ? { ...found, covered: true as const } : found;
    const value: Checkpoint = {
      v: 2,
      seq,
      msgId,
      msgUpdated: num(tail?.time_updated) ?? 0,
      sessKey,
      unsettled,
      ...(base && { base }),
      parts: belt?.parts ?? 0,
      partsUpdated: belt?.partsUpdated ?? 0,
      fp: fp.hash,
    };
    return { cursor: JSON.stringify(value), settled: unsettled === null };
  }

  /**
   * The boundary of a running tail: the newest of the inspected `rows`
   * (newest first) below `unsettled`, the lowest running `seq`, with the
   * fingerprint of the rows ending at it. The boundary must be a row seen
   * not to run, so a tail whose running rows reach the oldest inspected row
   * has none; rows older than the inspected ones count as settled, as they
   * do for a settled checkpoint. Undefined then, or when the row is gone by
   * the time its fingerprint is read.
   */
  async function boundary(
    sessionID: string,
    rows: Row[],
    unsettled: number,
  ): Promise<Checkpoint["base"]> {
    const below = rows.find((row) => (num(row.seq) ?? Number.POSITIVE_INFINITY) < unsettled);
    const seq = num(below?.seq);
    const id = str(below?.id);
    if (seq === null || id === null) return undefined;
    const fp = await fingerprint(sessionID, seq);
    return fp.newest?.id === id && fp.newest.seq === seq ? { seq, id, fp: fp.hash } : undefined;
  }

  async function compare(
    sessionID: string,
    stored: string | null | undefined,
  ): Promise<TailChange> {
    const cp = parseCheckpoint(stored);
    // A version 1 checkpoint (an older build's) has no part state, so it is
    // rewritten.
    if (!cp) return "rewritten";
    // An unsettled tail is never fresh or grown: the running row changes in
    // place, so an append from it would keep its partial text. While the rows
    // through its boundary are unchanged it is a `tail`, which re-reads only
    // the rows past the boundary on every poll while a turn streams (only for
    // sessions with a live or recently abandoned turn, see abandonAfterMs).
    // Without a boundary, or with a changed one, it is rewritten.
    if (cp.unsettled !== null) {
      if (!cp.base) return "rewritten";
      const fp = await fingerprint(sessionID, cp.base.seq);
      const row = fp.newest;
      if (!row || row.seq !== cp.base.seq || row.id !== cp.base.id) return "rewritten";
      return fp.hash === cp.base.fp ? "tail" : "rewritten";
    }
    const sessKey = sessionKey(sessionID);
    if (sessKey === null) return "rewritten";
    await pause();
    const tail = db.get(
      "SELECT seq, id, time_updated FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT ?",
      [sessionID, 1],
    );
    const tailSeq = num(tail?.seq) ?? 0;
    if (cp.msgId === null) {
      if (tail) return "grown";
      return sessKey === cp.sessKey ? "fresh" : "grown";
    }
    const fp = await fingerprint(sessionID, cp.seq);
    const row = fp.newest;
    // The checkpoint row is gone (a revert) or moved: nothing distilled from
    // it can be trusted.
    if (!row || row.seq !== cp.seq || row.id !== cp.msgId) return "rewritten";
    // It changed in place (streaming output, a completed compaction), or its
    // part rows did (opencode writes parts without touching the row).
    if (row.updated !== cp.msgUpdated) return "rewritten";
    if (row.parts !== cp.parts || row.partsUpdated !== cp.partsUpdated) return "rewritten";
    // A row before it changed, was removed, or had its parts change.
    if (fp.hash !== cp.fp) return "rewritten";
    if (tailSeq < cp.seq) return "rewritten";
    if (tailSeq > cp.seq) return "grown";
    return sessKey === cp.sessKey ? "fresh" : "grown";
  }

  async function rangeDigest(
    sessionID: string,
    afterSeq: number,
    limit: number,
  ): Promise<RangeRow[]> {
    const take = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, RANGE_DIGEST_MAX) : 1;
    await pause();
    const rows = db.all(
      `SELECT seq, id, time_updated FROM session_message
       WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      [sessionID, afterSeq, take],
    );
    const parts = await partState(
      sessionID,
      rows.map((row) => str(row.id) ?? ""),
      true,
    );
    return rows.map((row) => {
      const id = str(row.id) ?? "";
      const own = parts.get(id);
      return {
        seq: num(row.seq) ?? 0,
        id,
        timeUpdated: num(row.time_updated) ?? 0,
        parts: own?.parts ?? 0,
        partsUpdated: own?.updated ?? 0,
        partTypes: own?.types ?? [],
      };
    });
  }

  async function seqOf(sessionID: string, messageID: string): Promise<number | null> {
    await pause();
    const row = db.get("SELECT seq FROM session_message WHERE id = ? AND session_id = ? LIMIT ?", [
      messageID,
      sessionID,
      1,
    ]);
    return num(row?.seq);
  }

  async function withParts(sessionIDs: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (!partsOn) return found;
    for (let i = 0; i < sessionIDs.length; i += PART_CHUNK) {
      const chunk = sessionIDs.slice(i, i + PART_CHUNK);
      await pause();
      // EXISTS stops at a session's first part row (the session_id prefix of
      // the part index), so a session with many parts costs one seek.
      const rows = db.all(
        `WITH ids(id) AS (VALUES ${chunk.map(() => "(?)").join(", ")})
         SELECT id FROM ids
         WHERE EXISTS (SELECT 1 FROM session_part WHERE session_id = ids.id)
         LIMIT ?`,
        [...chunk, chunk.length],
      );
      for (const row of rows) {
        const id = str(row.id);
        if (id !== null) found.add(id);
      }
    }
    return found;
  }

  async function missing(ids: string[]): Promise<string[]> {
    const gone: string[] = [];
    for (let i = 0; i < ids.length; i += MISSING_CHUNK) {
      const chunk = ids.slice(i, i + MISSING_CHUNK);
      await pause();
      const present = new Set(
        db
          .all(`SELECT id FROM session_v2 WHERE id IN (${chunk.map(() => "?").join(", ")})`, chunk)
          .map((row) => str(row.id)),
      );
      for (const id of chunk) if (!present.has(id)) gone.push(id);
    }
    return gone;
  }

  /** The persisted watermark, clamped to the lookback. Unset starts at `at`:
   *  the query subtracts the overlap once. */
  function watermark(meta: PollMeta, key: string, at: number): number {
    const stored = Number(meta.get(key));
    const start = Number.isFinite(stored) && stored > 0 ? stored : at;
    return Math.max(start, at - maxLookbackMs);
  }

  type Page = { rows: Row[]; commit: Array<[string, string]> };

  /**
   * One page of a window: rows whose key `k` is past `mark - overlap` and past
   * the persisted keyset position, ordered by `(k, id)`. A full page records
   * its last key and leaves the watermark alone; a short page means the
   * window is drained, so the watermark moves to the newest key seen and the
   * position clears. Every poll therefore moves forward, even when one
   * timestamp is shared by more rows than a page holds. The updates are
   * returned, not written: the caller commits them after dispatch. Null when
   * `live` turned false at its yield.
   */
  async function page(
    meta: PollMeta,
    keys: { mark: string; pos: string },
    at: number,
    limit: number,
    query: (lower: number, pos: KeysetPos | null, limit: number) => Row[],
    keyOf: (row: Row) => { t: number | null; id: string | null },
    live: () => boolean,
  ): Promise<Page | null> {
    const mark = watermark(meta, keys.mark, at);
    const pos = parsePos(meta.get(keys.pos));
    // A clamped watermark (after long downtime) must not outrun a window that
    // is still being drained: keep reading from the persisted position. Keys
    // are integer milliseconds, so `pos.t - 1` admits rows at exactly pos.t,
    // which the keyset tie-break (same time, larger id) still needs.
    const lower = pos ? Math.min(mark - overlapMs, pos.t - 1) : mark - overlapMs;
    await pause();
    if (!live()) return null;
    // One row past the page tells a full page from a drained window.
    const fetched = query(lower, pos, limit + 1);
    const rows = fetched.slice(0, limit);
    const last = rows.length > 0 ? keyOf(rows[rows.length - 1]!) : undefined;
    if (fetched.length > limit) {
      // Unreachable: the scan key is coalesced with a primary-key id. Should
      // it ever happen, the window cannot be resumed or declared drained, so
      // fail it rather than repeat or skip rows.
      if (!last || last.t === null || last.id === null) {
        throw new Error(`poll page for ${keys.mark} ended on a row without a key`);
      }
      return { rows, commit: [[keys.pos, JSON.stringify([last.t, last.id])]] };
    }
    const newest = last?.t ?? pos?.t ?? null;
    return {
      rows,
      commit: [
        [keys.mark, String(Math.max(mark, newest ?? mark))],
        [keys.pos, ""],
      ],
    };
  }

  /**
   * The message window: sessions with rows created past `mark - overlap` and
   * at or before the window's cutoff, found by reading those rows in
   * `(time_created, id)` order through the `time_created` index,
   * {@link pollPageRows} per statement with a yield before each. The cutoff
   * is `at`, the start of the poll that began the window, and every poll
   * that resumes the window reads up to it. A poll stops once it holds
   * {@link pollSessionLimit} sessions and the next row would add another, or
   * after {@link pollPages} full pages, recording the last row read and the
   * cutoff as its position. Otherwise a short page shows the window drained,
   * which sets the watermark to the cutoff. Each session is listed once,
   * where its first row in the window is. Null when `live` turned false at a
   * yield.
   */
  async function messageWindow(
    meta: PollMeta,
    at: number,
    live: () => boolean,
  ): Promise<{ sessions: string[]; commit: Array<[string, string]> } | null> {
    const mark = watermark(meta, POLL_WATERMARK_KEY, at);
    // A clamped watermark (after long downtime) must not outrun a window that
    // is still being drained: reading resumes strictly past the persisted
    // row. An older build's position by session bounds the window from below
    // only, so everything from its time on is read again (keys are integer
    // milliseconds, so `older.t - 1` admits rows at exactly older.t).
    const resumed = parseRowPos(meta.get(POLL_ROW_CURSOR_KEY));
    let after: KeysetPos | null = resumed && { t: resumed.t, id: resumed.id };
    const older = parsePos(meta.get(POLL_CURSOR_KEY));
    const lower = older ? Math.min(mark - overlapMs, older.t - 1) : mark - overlapMs;
    // The window ends at the start of the poll that began it, however many
    // polls read it, and once drained it sets the watermark there, never to
    // the newest row read. The pages are read over time, so a row committed
    // meanwhile behind the position is then inside the next window's
    // overlap, as it would be after one statement read at the start. The
    // watermark is set, not raised, so a window an older build moved it past
    // meanwhile still leaves that overlap to be read.
    const cutoff = resumed?.cutoff ?? at;
    const sessions: string[] = [];
    const seen = new Set<string>();
    const drained = (): Array<[string, string]> => [
      [POLL_WATERMARK_KEY, String(cutoff)],
      [POLL_ROW_CURSOR_KEY, ""],
      [POLL_CURSOR_KEY, ""],
    ];
    /** Where the next poll goes on from: the last row read, and the cutoff. */
    const resume = (): Array<[string, string]> => [
      [POLL_ROW_CURSOR_KEY, JSON.stringify([after!.t, after!.id, cutoff])],
    ];
    for (let pages = 0; ; pages++) {
      // A poll holds a fetch permit throughout, so a long window is left to
      // the next polls past `pollPages` pages.
      if (pages >= pollPages) return { sessions, commit: resume() };
      await pause();
      if (!live()) return null;
      const position = after;
      const rows = position
        ? db.all(
            `SELECT id, session_id, time_created FROM session_message
             WHERE time_created >= ? AND time_created <= ? AND (time_created > ? OR id > ?)
             ORDER BY time_created ASC, id ASC LIMIT ?`,
            [position.t, cutoff, position.t, position.id, pollPageRows],
          )
        : db.all(
            `SELECT id, session_id, time_created FROM session_message
             WHERE time_created > ? AND time_created <= ?
             ORDER BY time_created ASC, id ASC LIMIT ?`,
            [lower, cutoff, pollPageRows],
          );
      for (const row of rows) {
        const t = num(row.time_created);
        const id = str(row.id);
        const sessionID = str(row.session_id);
        // Unreachable: all three columns are NOT NULL. Should it ever happen,
        // the window cannot be resumed past the row, so fail it rather than
        // repeat or skip rows.
        if (t === null || id === null || sessionID === null) {
          throw new Error("poll page ended on a row without a key");
        }
        if (!seen.has(sessionID)) {
          if (seen.size >= pollSessionLimit) return { sessions, commit: resume() };
          seen.add(sessionID);
          sessions.push(sessionID);
        }
        after = { t, id };
      }
      if (rows.length < pollPageRows) return { sessions, commit: drained() };
    }
  }

  async function poll(meta: PollMeta, live: () => boolean = () => true): Promise<PollResult> {
    const signals: DistillSignal[] = [];
    const updates: Array<[string, string]> = [];
    const failures: string[] = [];
    const at = now();
    const stopped: PollResult = { signals: [], failures: [], commit: () => {} };

    // New messages, through the time_created index.
    try {
      const changed = await messageWindow(meta, at, live);
      if (!changed) return stopped;
      for (const sessionID of changed.sessions) {
        signals.push({ type: "turn-ended", sessionID });
      }
      updates.push(...changed.commit);
    } catch (error) {
      failures.push(`message poll: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!live()) return stopped;

    // Metadata-only changes, through a bounded scan of session_v2.
    if (at - lastScanAt >= sessionScanEveryMs) {
      const scannedBefore = lastScanAt;
      lastScanAt = at;
      try {
        const expr = recency();
        const sessions = await page(
          meta,
          { mark: SESSION_WATERMARK_KEY, pos: SESSION_CURSOR_KEY },
          at,
          sessionScanLimit,
          (lower, pos, n) =>
            db.all(
              `SELECT id, title, directory, project_id, time_archived, ${expr} AS r FROM session_v2
               WHERE ${expr} > ?
               ${pos ? `AND (${expr} > ? OR (${expr} = ? AND id > ?))` : ""}
               ORDER BY r ASC, id ASC LIMIT ?`,
              pos ? [lower, pos.t, pos.t, pos.id, n] : [lower, n],
            ),
          (row) => ({ t: num(row.r), id: str(row.id) }),
          live,
        );
        if (!sessions) {
          // Stopped before the scan read anything: the next poll scans.
          lastScanAt = scannedBefore;
          return stopped;
        }
        for (const row of sessions.rows) {
          const id = str(row.id);
          if (!id) continue;
          signals.push({
            type: "meta",
            sessionID: id,
            patch: {
              title: str(row.title) ?? "",
              ...(str(row.directory) !== null && { directory: str(row.directory) ?? "" }),
              ...(str(row.project_id) !== null && { projectId: str(row.project_id) ?? "" }),
              // Archiving and unarchiving move the session's time_updated, so
              // the scan sees them.
              timeArchived: num(row.time_archived),
            },
          });
          signals.push({ type: "turn-ended", sessionID: id });
        }
        updates.push(...sessions.commit);
      } catch (error) {
        failures.push(`session scan: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      signals,
      failures,
      commit: () => {
        for (const [key, value] of updates) meta.set(key, value);
      },
    };
  }

  return {
    checkpoint,
    compare,
    missing,
    poll,
    pollIntervalMs,
    reconcileEveryMs,
    rangeDigest,
    withParts,
    seqOf,
    inspect: inspectCheckpoint,
    annotate: annotateCheckpoint,
    sameTail,
  };
}
