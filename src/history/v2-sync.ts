import type { ReadOnlyDb, Row, SqlValue } from "../sqlite.js";
import type {
  DistillCheckpoint,
  DistillSignal,
  DistillSync,
  PollMeta,
  PollResult,
  TailChange,
} from "../distill.js";

/**
 * Freshness for the v2 distiller, read straight from `opencode.db`.
 *
 * v2 events are live only and are lost while the service is down or a
 * location is evicted, so they are a latency hint. This module is what keeps
 * the store correct without them:
 *
 * - **Checkpoints.** Before each distill the session's tail is snapshotted
 *   (`{ seq, msgId, msgUpdated, sessKey, unsettled }`, stored as
 *   `card.distill_cursor`). A later {@link DistillSync.compare} tells an
 *   unchanged tail from appended rows and from a rewritten one (a revert
 *   removes the checkpoint row; streaming output updates it in place).
 * - **Unsettled tails.** An assistant without `time.completed`, or a shell or
 *   compaction still `running`, among the newest rows marks the checkpoint
 *   unsettled, which the distiller re-reads on every poll. The predicate is
 *   the one opencode's fork projector uses (`core/src/session/projector.ts`).
 *   A row unchanged for {@link V2SyncOptions.abandonAfterMs} counts as
 *   settled, so a crashed turn cannot keep a session re-distilling forever.
 * - **The poll** (lease holder only): every 30 s the indexed
 *   `session_message_time_created_idx` finds sessions with new rows past a
 *   persisted watermark; every 5 minutes a bounded scan of `session_v2`
 *   catches renames, moves and other metadata-only changes. Both watermarks
 *   carry an overlap for late commits. Each window is read in bounded pages
 *   keyed by `(time, session id)`, with the key persisted between polls, and
 *   the watermark moves only once the window is drained. So a page that
 *   fills up (more changed sessions than the page limit, or many sharing one
 *   timestamp inside the overlap) always moves forward on the next poll.
 *   Each window reads one page per turn: the message window one page per
 *   poll, the session scan one page per `sessionScanEveryMs`. A poll returns
 *   its watermark updates for the distiller to commit after it dispatched
 *   the signals, and a failing window is isolated from the other.
 *
 * Every `session_message` statement binds `LIMIT ?`, reads happen one
 * statement at a time with a macrotask between them, and nothing here writes
 * to `opencode.db`.
 */

export const POLL_WATERMARK_KEY = "v2_poll_watermark";
export const SESSION_WATERMARK_KEY = "v2_session_watermark";
/** The keyset position `[time, sessionId]` inside a window being drained;
 *  empty when the window starts fresh. */
export const POLL_CURSOR_KEY = "v2_poll_cursor";
export const SESSION_CURSOR_KEY = "v2_session_cursor";

export type V2SyncOptions = {
  /** Message poll interval. Default 30 s. */
  pollIntervalMs?: number;
  /** Minimum time between `session_v2` scans. Default 5 minutes. */
  sessionScanEveryMs?: number;
  /** Watermark overlap for rows committed after their timestamp. Default 5 s. */
  overlapMs?: number;
  /** A watermark older than this is clamped (the cold pass covers the rest).
   *  Default 1 hour. */
  maxLookbackMs?: number;
  /** Sessions returned by one message poll (one page of its window).
   *  Default 500. */
  pollSessionLimit?: number;
  /** Sessions returned by one `session_v2` scan (one page). Default 2,000. */
  sessionScanLimit?: number;
  /** Rows inspected for an unsettled tail. Default 20. */
  tailRows?: number;
  /** An unsettled row untouched this long counts as settled. Default 1 hour. */
  abandonAfterMs?: number;
  now?: () => number;
  /** Awaited between statements. Default: one macrotask. */
  yieldBetween?: () => Promise<void>;
};

type Checkpoint = {
  v: 1;
  seq: number;
  msgId: string | null;
  msgUpdated: number;
  sessKey: number;
  unsettled: number | null;
};

const MISSING_CHUNK = 500;

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function num(value: SqlValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function str(value: SqlValue | undefined): string | null {
  return typeof value === "string" ? value : null;
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

function parseCheckpoint(stored: string | null | undefined): Checkpoint | null {
  if (typeof stored !== "string") return null;
  try {
    const value = JSON.parse(stored) as Partial<Checkpoint>;
    if (
      value?.v !== 1 ||
      typeof value.seq !== "number" ||
      typeof value.msgUpdated !== "number" ||
      typeof value.sessKey !== "number" ||
      !(value.msgId === null || typeof value.msgId === "string") ||
      !(value.unsettled === null || typeof value.unsettled === "number")
    ) {
      return null;
    }
    return value as Checkpoint;
  } catch {
    return null;
  }
}

export function createV2Sync(db: ReadOnlyDb, opts: V2SyncOptions = {}): DistillSync {
  const pollIntervalMs = opts.pollIntervalMs ?? 30_000;
  const sessionScanEveryMs = opts.sessionScanEveryMs ?? 300_000;
  const overlapMs = opts.overlapMs ?? 5_000;
  const maxLookbackMs = opts.maxLookbackMs ?? 3_600_000;
  const pollSessionLimit = opts.pollSessionLimit ?? 500;
  const sessionScanLimit = opts.sessionScanLimit ?? 2_000;
  const tailRows = opts.tailRows ?? 20;
  const abandonAfterMs = opts.abandonAfterMs ?? 3_600_000;
  const now = opts.now ?? Date.now;
  const pause = opts.yieldBetween ?? macrotask;
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
    const value: Checkpoint = {
      v: 1,
      seq: num(tail?.seq) ?? 0,
      msgId: str(tail?.id),
      msgUpdated: num(tail?.time_updated) ?? 0,
      sessKey,
      unsettled,
    };
    return { cursor: JSON.stringify(value), settled: unsettled === null };
  }

  async function compare(
    sessionID: string,
    stored: string | null | undefined,
  ): Promise<TailChange> {
    const cp = parseCheckpoint(stored);
    // An unsettled tail is always "rewritten": the running row changes in
    // place, so an append from it would keep its partial text. The cost is a
    // full re-distill of that session on every poll while a turn streams,
    // bounded by the per-session row cap and only for sessions with a live or
    // recently abandoned turn (see abandonAfterMs).
    if (!cp || cp.unsettled !== null) return "rewritten";
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
    await pause();
    const row = db.get(
      "SELECT seq, time_updated FROM session_message WHERE id = ? AND session_id = ? LIMIT ?",
      [cp.msgId, sessionID, 1],
    );
    // The checkpoint row is gone (a revert) or moved: nothing distilled from
    // it can be trusted.
    if (!row || num(row.seq) !== cp.seq) return "rewritten";
    // It changed in place (streaming output, a completed compaction).
    if (num(row.time_updated) !== cp.msgUpdated) return "rewritten";
    if (tailSeq < cp.seq) return "rewritten";
    if (tailSeq > cp.seq) return "grown";
    return sessKey === cp.sessKey ? "fresh" : "grown";
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

  /**
   * One page of a window: rows whose key `k` is past `mark - overlap` and past
   * the persisted keyset position, ordered by `(k, id)`. A full page stores
   * its last key and leaves the watermark alone; a short page means the
   * window is drained, so the watermark moves to the newest key seen and the
   * position clears. Every poll therefore moves forward, even when one
   * timestamp is shared by more rows than a page holds.
   */
  type Page = { rows: Row[]; commit: Array<[string, string]> };

  /**
   * One page of a window: rows whose key `k` is past `mark - overlap` and past
   * the persisted keyset position, ordered by `(k, id)`. A full page records
   * its last key and leaves the watermark alone; a short page means the
   * window is drained, so the watermark moves to the newest key seen and the
   * position clears. Every poll therefore moves forward, even when one
   * timestamp is shared by more rows than a page holds. The updates are
   * returned, not written: the caller commits them after dispatch.
   */
  async function page(
    meta: PollMeta,
    keys: { mark: string; pos: string },
    at: number,
    limit: number,
    query: (lower: number, pos: KeysetPos | null, limit: number) => Row[],
    keyOf: (row: Row) => { t: number | null; id: string | null },
  ): Promise<Page> {
    const mark = watermark(meta, keys.mark, at);
    const pos = parsePos(meta.get(keys.pos));
    // A clamped watermark (after long downtime) must not outrun a window that
    // is still being drained: keep reading from the persisted position.
    const lower = pos ? Math.min(mark - overlapMs, pos.t) : mark - overlapMs;
    await pause();
    // One row past the page tells a full page from a drained window.
    const fetched = query(lower, pos, limit + 1);
    const rows = fetched.slice(0, limit);
    const last = rows.length > 0 ? keyOf(rows[rows.length - 1]!) : undefined;
    if (fetched.length > limit) {
      // Unreachable: the message key is max(time_created) of a non-empty group
      // (NOT NULL column) with a NOT NULL session_id, and the scan key is
      // coalesced with a primary-key id. Should it ever happen, the window
      // cannot be resumed or declared drained, so fail it rather than repeat
      // or skip rows.
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

  async function poll(meta: PollMeta): Promise<PollResult> {
    const signals: DistillSignal[] = [];
    const updates: Array<[string, string]> = [];
    const failures: string[] = [];
    const at = now();

    // New messages, through the time_created index.
    try {
      const changed = await page(
        meta,
        { mark: POLL_WATERMARK_KEY, pos: POLL_CURSOR_KEY },
        at,
        pollSessionLimit,
        (lower, pos, n) =>
          db.all(
            `SELECT session_id, max(time_created) AS t FROM session_message
             WHERE time_created > ? GROUP BY session_id
             ${pos ? "HAVING max(time_created) > ? OR (max(time_created) = ? AND session_id > ?)" : ""}
             ORDER BY t ASC, session_id ASC LIMIT ?`,
            pos ? [lower, pos.t, pos.t, pos.id, n] : [lower, n],
          ),
        (row) => ({ t: num(row.t), id: str(row.session_id) }),
      );
      for (const row of changed.rows) {
        const id = str(row.session_id);
        if (id) signals.push({ type: "turn-ended", sessionID: id });
      }
      updates.push(...changed.commit);
    } catch (error) {
      failures.push(`message poll: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Metadata-only changes, through a bounded scan of session_v2.
    if (at - lastScanAt >= sessionScanEveryMs) {
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
              `SELECT id, title, directory, project_id, ${expr} AS r FROM session_v2
               WHERE ${expr} > ?
               ${pos ? `AND (${expr} > ? OR (${expr} = ? AND id > ?))` : ""}
               ORDER BY r ASC, id ASC LIMIT ?`,
              pos ? [lower, pos.t, pos.t, pos.id, n] : [lower, n],
            ),
          (row) => ({ t: num(row.r), id: str(row.id) }),
        );
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

  return { checkpoint, compare, missing, poll, pollIntervalMs };
}
