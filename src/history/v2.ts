import { openSqliteReadOnly, type Row, type SqlValue, type SqliteDb } from "../sqlite.js";
import type { HistoryMessage, HistorySession } from "./model.js";
import {
  assertBoundedLimit,
  MalformedSessionError,
  type HistorySource,
  type Listing,
  type Lookup,
  type MessagePage,
} from "./source.js";
import {
  CONTENT_TYPES,
  decodeRow,
  identityOf,
  isUserRoleType,
  projectMessage,
  projectSession,
  resolveIdentity,
  sessionContext,
  type DecodedRow,
  type SessionContext,
  type UserIdentity,
  type V2MessageRow,
  type V2SessionRow,
} from "./v2-project.js";

/**
 * The v2 history adapter: opencode v2's own `opencode.db`, read-only.
 *
 * The v2 plugin API cannot list sessions or page messages, so this reads the
 * `session_v2`, `session_message` and `project` tables directly (as
 * cortexkit/magic-context does) and projects rows through
 * `history/v2-project.ts`. The rules:
 *
 * - Read-only: the handle comes from `openSqliteReadOnly` (`query_only`), and
 *   every read is one statement. No transaction is ever held, least of all
 *   across an `await`.
 * - Bounded: every `session_message` statement binds `LIMIT ?` (a test spy
 *   enforces it), and a page also stops at a byte ceiling read from
 *   `length(data)` before any row body is loaded.
 * - Polite: an `await` on a macrotask separates statements, so a page never
 *   holds the shared v2 service's event loop for more than one statement.
 * - Tolerant: a row with unparseable data is skipped (a
 *   `MalformedSessionError` under `strict`); non-content types never leave
 *   SQL.
 */

// ── Schema guard ─────────────────────────────────────────────────────────────

/** Every column this adapter reads (`core/src/session/sql.ts`,
 *  `core/src/project/sql.ts` in opencode v2). */
export const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  session_v2: [
    "id",
    "project_id",
    "parent_id",
    "fork_session_id",
    "slug",
    "directory",
    "title",
    "version",
    "agent",
    "model",
    "time_created",
    "time_updated",
    "time_idle",
    "time_archived",
  ],
  session_message: ["id", "session_id", "type", "seq", "time_created", "time_updated", "data"],
  project: ["id", "name", "worktree"],
};

export type V2SchemaCheck = { ok: true; migration: string | null } | { ok: false; reason: string };

/**
 * Check that every column we read exists. The newest `migration` id is
 * recorded for diagnostics only: an unknown id never refuses, so an opencode
 * patch release that adds a migration does not strand users.
 */
export function checkV2Schema(db: SqliteDb): V2SchemaCheck {
  const missing: string[] = [];
  try {
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      const present = new Set(db.all(`PRAGMA table_info(${table})`).map((row) => row.name));
      for (const column of columns) if (!present.has(column)) missing.push(`${table}.${column}`);
    }
  } catch (error) {
    return { ok: false, reason: `cannot read the opencode.db schema: ${messageOf(error)}` };
  }
  if (missing.length > 0) {
    return { ok: false, reason: `opencode.db schema lacks ${missing.join(", ")}` };
  }
  return { ok: true, migration: newestMigration(db) };
}

/** The newest applied opencode migration id, or null when unreadable. */
function newestMigration(db: SqliteDb): string | null {
  try {
    const row = db.get("SELECT id FROM migration ORDER BY id DESC LIMIT 1");
    return typeof row?.id === "string" ? row.id : null;
  } catch {
    return null;
  }
}

export type OpencodeDbOpen =
  | { ok: true; db: SqliteDb; migration: string | null }
  | { ok: false; reason: string };

/** Open `opencode.db` read-only and check its schema. The handle is closed
 *  on a failed check; never throws. */
export async function openOpencodeDb(path: string): Promise<OpencodeDbOpen> {
  const opened = await openSqliteReadOnly(path);
  if (!opened.ok) return opened;
  const check = checkV2Schema(opened.db);
  if (!check.ok) {
    try {
      opened.db.close();
    } catch {
      // The schema reason is the one worth reporting.
    }
    return check;
  }
  return { ok: true, db: opened.db, migration: check.migration };
}

// ── Cursors ──────────────────────────────────────────────────────────────────

const CURSOR_PREFIX = "v2:";

/** Opaque page cursor: `base64url("v2:" + seq)`. */
export function encodeV2Cursor(seq: number): string {
  return btoa(`${CURSOR_PREFIX}${seq}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a cursor; anything that is not one of ours rejects. */
export function decodeV2Cursor(cursor: string): number {
  const invalid = new Error(`Invalid message cursor: ${cursor.slice(0, 64)}`);
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid;
  let decoded: string;
  try {
    decoded = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw invalid;
  }
  const match = /^v2:(\d{1,15})$/.exec(decoded);
  if (!match) throw invalid;
  return Number(match[1]);
}

// ── Source ───────────────────────────────────────────────────────────────────

export type V2SourceOptions = {
  /** The opencode project id `scope: "project"` filters to. Without one
   *  (the distiller's global facade), project-scope listings reject. */
  projectID?: string;
  /** Per-page cap on summed `length(data)`; a page always holds at least one
   *  row. Default 4 MiB. */
  pageByteCeiling?: number;
  /** Awaited between statements. Default: one macrotask (`setTimeout(0)`). */
  yieldBetween?: () => Promise<void>;
};

const DEFAULT_PAGE_BYTE_CEILING = 4 * 1024 * 1024;
/** Children per parent read in one statement. */
const CHILDREN_LIMIT = 1_000;
/** Switch rows scanned to attribute a page's user rows. */
const SWITCH_SCAN_LIMIT = 64;
const NO_CURSOR_SEQ = Number.MAX_SAFE_INTEGER;

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SESSION_COLUMNS = `s.id, s.project_id, s.parent_id, s.fork_session_id, s.slug,
  s.directory, s.title, s.version, s.agent, s.model, s.time_created, s.time_updated,
  s.time_idle, s.time_archived, p.name AS project_name, p.worktree AS project_worktree`;
const SESSION_FROM = "FROM session_v2 s LEFT JOIN project p ON p.id = s.project_id";
/** Normalized recency; `coalesce` because multi-argument `max` is NULL when
 *  any argument is. */
const RECENCY = "max(s.time_updated, coalesce(s.time_idle, 0))";

const CONTENT_TYPE_LIST = CONTENT_TYPES.map((type) => `'${type}'`).join(", ");
/** Content rows only. A compaction counts once completed; its JSON is read
 *  through a lazy CASE so no other row's data is parsed, and a compaction
 *  with unparseable data passes through for the decoder to report. */
const CONTENT_FILTER = `type IN (${CONTENT_TYPE_LIST})
  AND CASE WHEN type <> 'compaction' THEN 1
           WHEN json_valid(data) THEN json_extract(data, '$.status') = 'completed'
           ELSE 1 END`;
/** Forked sessions start with copies of the parent's rows; exclude them with
 *  opencode's own rule (`core/src/session/stats.ts:100`): keep a row unless
 *  the session is a fork and the row predates the fork. Binds (isFork,
 *  sessionCreated). */
const FORK_FILTER = "(? = 0 OR time_created >= ?)";
const MESSAGE_COLUMNS = "id, session_id, type, seq, time_created, time_updated, data";

type SessionRecord = { row: V2SessionRow; fork: boolean };

function asString(value: SqlValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: SqlValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function toSessionRecord(row: Row): SessionRecord {
  return {
    fork: typeof row.fork_session_id === "string" && row.fork_session_id !== "",
    row: {
      id: asString(row.id) ?? "",
      project_id: asString(row.project_id) ?? "",
      parent_id: asString(row.parent_id),
      slug: asString(row.slug) ?? "",
      directory: asString(row.directory) ?? "",
      title: asString(row.title),
      version: asString(row.version) ?? "",
      agent: asString(row.agent),
      model: asString(row.model),
      time_created: asNumber(row.time_created) ?? 0,
      time_updated: asNumber(row.time_updated) ?? 0,
      time_idle: asNumber(row.time_idle),
      time_archived: asNumber(row.time_archived),
      project_name: asString(row.project_name),
      project_worktree: asString(row.project_worktree),
    },
  };
}

function toMessageRow(row: Row): V2MessageRow {
  return {
    id: asString(row.id) ?? "",
    session_id: asString(row.session_id) ?? "",
    type: asString(row.type) ?? "",
    seq: asNumber(row.seq) ?? 0,
    time_created: asNumber(row.time_created) ?? 0,
    time_updated: asNumber(row.time_updated) ?? 0,
    data: asString(row.data) ?? "",
  };
}

/** Escape LIKE wildcards so a title search matches literally. */
function likeContains(search: string): string {
  return `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function assertListLimit(limit: unknown): asserts limit is number {
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw new Error(`session list limit must be a positive integer, got ${String(limit)}`);
  }
}

export function createV2HistorySource(db: SqliteDb, opts: V2SourceOptions = {}): HistorySource {
  const projectID = opts.projectID;
  const byteCeiling = opts.pageByteCeiling ?? DEFAULT_PAGE_BYTE_CEILING;
  const pause = opts.yieldBetween ?? macrotask;

  /** One statement; a driver error rejects with context (a transport-style
   *  failure in the source contract). */
  function read<T>(what: string, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw new Error(`opencode history read failed (${what}): ${messageOf(error)}`, {
        cause: error,
      });
    }
  }

  function sessionById(id: string): SessionRecord | undefined {
    const row = read("session", () =>
      db.get(`SELECT ${SESSION_COLUMNS} ${SESSION_FROM} WHERE s.id = ?`, [id]),
    );
    return row ? toSessionRecord(row) : undefined;
  }

  function listing(where: string[], params: SqlValue[], limit: number): HistorySession[] {
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = read("session list", () =>
      db.all(
        `SELECT ${SESSION_COLUMNS} ${SESSION_FROM} ${clause}
         ORDER BY ${RECENCY} DESC, s.id DESC LIMIT ?`,
        [...params, limit],
      ),
    );
    return rows.map((row) => projectSession(toSessionRecord(row).row));
  }

  /**
   * Attribute user-role rows: each field from the latest
   * preceding agent/model switch, else the next assistant, else the session.
   * Two bounded statements at most, both only when the rows include a user.
   */
  async function identities(
    decoded: Array<Extract<DecodedRow, { ok: true }>>,
    sessionID: string,
    session: SessionContext,
  ): Promise<Map<string, UserIdentity>> {
    const out = new Map<string, UserIdentity>();
    const users = decoded.filter((d) => isUserRoleType(d.row.type));
    if (users.length === 0) return out;
    const newestUser = Math.max(...users.map((d) => d.row.seq));
    const newestRow = Math.max(...decoded.map((d) => d.row.seq));

    await pause();
    const switches = read("switches", () =>
      db.all(
        `SELECT ${MESSAGE_COLUMNS} FROM session_message
         WHERE session_id = ? AND type IN ('agent-switched', 'model-switched') AND seq < ?
         ORDER BY seq DESC LIMIT ?`,
        [sessionID, newestUser, SWITCH_SCAN_LIMIT],
      ),
    )
      .map((row) => decodeRow(toMessageRow(row)))
      .filter((d): d is Extract<DecodedRow, { ok: true }> => d.ok);

    const assistants = decoded
      .filter((d) => d.row.type === "assistant")
      .sort((a, b) => a.row.seq - b.row.seq);
    let after: Partial<UserIdentity> | undefined;
    if (!assistants.some((a) => a.row.seq > newestUser)) {
      await pause();
      const row = read("next assistant", () =>
        db.get(
          `SELECT seq,
             CASE WHEN json_valid(data) THEN json_extract(data, '$.agent') END AS agent,
             CASE WHEN json_valid(data) THEN json_extract(data, '$.model') END AS model
           FROM session_message
           WHERE session_id = ? AND type = 'assistant' AND seq > ?
           ORDER BY seq ASC LIMIT ?`,
          [sessionID, newestRow, 1],
        ),
      );
      if (row) {
        after = identityOf({
          row: { ...toMessageRow(row), type: "assistant" },
          data: { agent: row.agent, model: row.model },
        });
      }
    }

    for (const user of users) {
      const seq = user.row.seq;
      const agentSwitch = switches.find((s) => s.row.seq < seq && s.row.type === "agent-switched");
      const modelSwitch = switches.find((s) => s.row.seq < seq && s.row.type === "model-switched");
      const next = assistants.find((a) => a.row.seq > seq);
      out.set(
        user.row.id,
        resolveIdentity(
          [
            agentSwitch && identityOf(agentSwitch),
            modelSwitch && identityOf(modelSwitch),
            next ? identityOf(next) : after,
          ],
          session,
        ),
      );
    }
    return out;
  }

  /** Decode rows (newest first), dropping or, under `strict`, rejecting
   *  unparseable ones, then project them. */
  async function project(
    rows: V2MessageRow[],
    record: SessionRecord,
    strict: boolean,
  ): Promise<HistoryMessage[]> {
    const decoded: Array<Extract<DecodedRow, { ok: true }>> = [];
    for (const row of rows) {
      const d = decodeRow(row);
      if (d.ok) decoded.push(d);
      else if (strict) throw new MalformedSessionError(d.reason);
    }
    const session = sessionContext(record.row);
    const who = await identities(decoded, record.row.id, session);
    const fallback = resolveIdentity([], session);
    const items: HistoryMessage[] = [];
    for (const d of decoded) {
      const message = projectMessage(d, session, who.get(d.row.id) ?? fallback);
      if (message) items.push(message);
    }
    return items;
  }

  return {
    kind: "v2-sqlite",
    // One database answers every scope, so project and global lookups agree.
    scopedLookup: false,

    async listSessions(o): Promise<Listing<HistorySession>> {
      assertListLimit(o.limit);
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (o.scope === "project") {
        if (projectID === undefined) {
          throw new Error(
            'this opencode history source has no project id, so scope "project" is unavailable; use scope "global"',
          );
        }
        where.push("s.project_id = ?");
        params.push(projectID);
      } else {
        // Mirrors v1's global listing, which hides archived sessions.
        where.push("s.time_archived IS NULL");
      }
      if (o.search) {
        where.push("s.title LIKE ? ESCAPE '\\'");
        params.push(likeContains(o.search));
      }
      return { ok: true, items: listing(where, params, o.limit) };
    },

    async getSession(id): Promise<Lookup<HistorySession>> {
      const record = sessionById(id);
      if (!record) return { ok: false, reason: "not-found", error: `Session not found: ${id}` };
      return { ok: true, value: projectSession(record.row) };
    },

    async listChildren(parentID): Promise<Listing<HistorySession>> {
      return { ok: true, items: listing(["s.parent_id = ?"], [parentID], CHILDREN_LIMIT) };
    },

    async messagePage(o): Promise<MessagePage> {
      assertBoundedLimit(o.limit);
      const below = o.before === undefined ? NO_CURSOR_SEQ : decodeV2Cursor(o.before);
      const record = sessionById(o.sessionID);
      if (!record) throw new Error(`Session not found: ${o.sessionID}`);
      const fork = [record.fork ? 1 : 0, record.row.time_created];

      // Sizes first: pick the page without loading a row body.
      await pause();
      const sizes = read("page sizes", () =>
        db.all(
          `SELECT seq, length(data) AS bytes FROM session_message
           WHERE session_id = ? AND seq < ? AND ${CONTENT_FILTER} AND ${FORK_FILTER}
           ORDER BY seq DESC LIMIT ?`,
          [o.sessionID, below, ...fork, o.limit + 1],
        ),
      );
      if (sizes.length === 0) return { items: [], nextCursor: null };
      let take = 0;
      let bytes = 0;
      for (const size of sizes) {
        if (take >= o.limit) break;
        const rowBytes = asNumber(size.bytes) ?? 0;
        if (take > 0 && bytes + rowBytes > byteCeiling) break;
        bytes += rowBytes;
        take++;
      }
      const newest = asNumber(sizes[0]!.seq) ?? 0;
      const oldest = asNumber(sizes[take - 1]!.seq) ?? 0;
      const more = sizes.length > take;

      await pause();
      const rows = read("page rows", () =>
        db.all(
          `SELECT ${MESSAGE_COLUMNS} FROM session_message
           WHERE session_id = ? AND seq <= ? AND seq >= ? AND ${CONTENT_FILTER} AND ${FORK_FILTER}
           ORDER BY seq DESC LIMIT ?`,
          [o.sessionID, newest, oldest, ...fork, take],
        ),
      ).map(toMessageRow);

      const items = await project(rows, record, o.strict === true);
      return { items, nextCursor: more ? encodeV2Cursor(oldest) : null };
    },

    async getMessage(sessionID, messageID): Promise<Lookup<HistoryMessage>> {
      const record = sessionById(sessionID);
      if (!record) {
        return { ok: false, reason: "not-found", error: `Session not found: ${sessionID}` };
      }
      const notFound = {
        ok: false as const,
        reason: "not-found" as const,
        error: `Message not found: ${messageID}`,
      };
      await pause();
      const row = read("message", () =>
        db.get(
          `SELECT ${MESSAGE_COLUMNS} FROM session_message
           WHERE id = ? AND session_id = ? AND ${FORK_FILTER} LIMIT ?`,
          [messageID, sessionID, record.fork ? 1 : 0, record.row.time_created, 1],
        ),
      );
      if (!row) return notFound;
      const decoded = decodeRow(toMessageRow(row));
      if (!decoded.ok) return { ok: false, reason: "malformed", error: decoded.reason };
      const [message] = await project([decoded.row], record, false);
      return message ? { ok: true, value: message } : notFound;
    },
  };
}
