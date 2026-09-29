import { openSqliteReadOnly, type ReadOnlyDb, type Row, type SqlValue } from "../sqlite.js";
import { unavailableText } from "../digest.js";
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
  parseModelRef,
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
 *   enforces it), and a page also stops at a byte ceiling on the rows'
 *   encoded size, read before any row body is loaded. A row larger than the
 *   ceiling on its own is never loaded at all: it projects as a placeholder
 *   message (see {@link oversizedData}), so paging, drill, deep and the
 *   distiller keep moving past it, and the placeholder text is what gets
 *   indexed. The body statement re-reads every size, since rows can grow
 *   between the two statements, and cuts the page where a running total
 *   would pass the ceiling, so the bytes a page loads never exceed it. (The compaction status filter still
 *   parses a compaction row's JSON inside SQLite; nothing reaches JS.)
 * - Polite: an `await` on a macrotask separates statements, so a page never
 *   holds the shared v2 service's event loop for more than one statement.
 * - Tolerant: a row with unparseable data becomes a placeholder message (a
 *   `MalformedSessionError` under `strict`), so a page with rows is never
 *   empty; non-content types never leave SQL. The next-page cursor comes from
 *   the rows a page actually returned, so a row that changes eligibility
 *   between the size read and the body read is never skipped.
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
export function checkV2Schema(db: ReadOnlyDb): V2SchemaCheck {
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
function newestMigration(db: ReadOnlyDb): string | null {
  try {
    const row = db.get("SELECT id FROM migration ORDER BY id DESC LIMIT 1");
    return typeof row?.id === "string" ? row.id : null;
  } catch {
    return null;
  }
}

export type OpencodeDbOpen =
  | { ok: true; db: ReadOnlyDb; migration: string | null }
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

/** Opaque page cursor: `base64url("v2:" + seq)`. `seq` is a non-negative
 *  safe integer (up to 16 digits), the same range the decoder accepts. */
export function encodeV2Cursor(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new Error(`cursor seq must be a non-negative safe integer, got ${String(seq)}`);
  }
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
  const match = /^v2:(\d{1,16})$/.exec(decoded);
  if (!match) throw invalid;
  const seq = Number(match[1]);
  if (!Number.isSafeInteger(seq)) throw invalid;
  return seq;
}

// ── Source ───────────────────────────────────────────────────────────────────

export type V2SourceOptions = {
  /** The opencode project id `scope: "project"` filters to. Without one
   *  (the distiller's global facade), project-scope listings reject. */
  projectID?: string;
  /** Per-page cap on summed encoded `data` bytes, and the largest single row
   *  whose body is ever loaded (a larger one becomes a placeholder). A page
   *  always holds at least one row. Default 4 MiB. */
  pageByteCeiling?: number;
  /** Awaited between statements. Default: one macrotask (`setTimeout(0)`). */
  yieldBetween?: () => Promise<void>;
};

const DEFAULT_PAGE_BYTE_CEILING = 4 * 1024 * 1024;
/** Children per parent read in one statement. A parent with more direct
 *  children lists only the most recent 1,000 (v1's `session.children` has no
 *  limit at all); no real session is known to come close. */
const CHILDREN_LIMIT = 1_000;
/** Sessions whose immutable fork fields are remembered per source. */
const FORK_MEMO_LIMIT = 512;
/** Rows decoded or projected between yields to the event loop. */
const ROWS_PER_YIELD = 25;
/** Switch rows of one type read at once between a page's oldest and newest
 *  user; a longer run falls back to one seek per user. */
const SWITCH_SCAN_LIMIT = 64;

type SwitchType = "agent-switched" | "model-switched";
const NO_CURSOR_SEQ = Number.MAX_SAFE_INTEGER;
/** Page plans retried when a whole planned range turns ineligible between the
 *  size read and the body read. */
const PAGE_ATTEMPTS = 3;

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
const MESSAGE_META_COLUMNS = "id, session_id, type, seq, time_created, time_updated";

/**
 * SQL for a row's encoded size in bytes. `octet_length` (SQLite 3.43+) reads
 * only the record header; `length(CAST(data AS BLOB))` works everywhere but
 * loads the value inside SQLite. `length(data)` would count characters, which
 * undercounts multibyte text.
 */
function byteLengthSql(db: ReadOnlyDb): string {
  try {
    db.get("SELECT octet_length('x') AS n");
    return "octet_length(data)";
  } catch {
    return "length(CAST(data AS BLOB))";
  }
}

/** The text a placeholder carries in place of a row too large to load.
 *  Worded without domain words (see {@link unavailableText}). */
export function oversizedNote(bytes: number, ceiling: number): string {
  return unavailableText(`${bytes}-byte row over the ${ceiling}-byte cap`);
}

/** The text a placeholder carries in place of a row whose data cannot be
 *  decoded (outside `strict`, which rejects instead): the decoder's reason
 *  without its `message <id>` lead. */
export function malformedNote(reason: string): string {
  return unavailableText(reason.replace(/^message \S+ /, ""));
}

/**
 * Minimal data for a placeholder row of `type`, shaped so the projector yields
 * one part carrying `note` in the row's own shape, so its role and authorship
 * are what the loaded row's would be: assistant and compaction text, a
 * synthetic (injected) text for `synthetic`, a completed `skill` or `shell`
 * tool part (injected, with an empty input) for those, and plain user text
 * for `user`.
 */
function placeholderData(
  type: string,
  note: string,
): { type: string; data: Record<string, unknown> } {
  switch (type) {
    case "assistant":
      return { type, data: { content: [{ type: "text", text: note }] } };
    case "compaction":
      return { type, data: { status: "completed", summary: note } };
    case "synthetic":
      return { type, data: { text: note } };
    case "skill":
      return { type, data: { skill: "", name: "", text: note } };
    case "shell":
      return { type, data: { status: "exited", exit: 0, output: { output: note } } };
    default:
      return { type: "user", data: { text: note } };
  }
}

/** Longest identity field (agent, model id/provider/variant) read in SQL. */
const IDENTITY_FIELD_CHARS = 512;

/** One string field of a row's JSON, read inside SQLite: NULL unless the data
 *  is valid JSON and the field is a string (nested CASE, since `json_type`
 *  rejects malformed JSON and AND does not short-circuit reliably). */
function jsonTextField(path: string): string {
  return `CASE WHEN json_valid(data) THEN
    CASE WHEN json_type(data, '${path}') = 'text'
      THEN substr(json_extract(data, '${path}'), 1, ${IDENTITY_FIELD_CHARS}) END END`;
}

/** An assistant or compaction row's identity as bounded scalars, so a row
 *  whose body is never loaded still attributes like a loaded one. */
const IDENTITY_COLUMNS = `${jsonTextField("$.agent")} AS id_agent,
  ${jsonTextField("$.model.id")} AS id_model,
  ${jsonTextField("$.model.providerID")} AS id_provider,
  ${jsonTextField("$.model.variant")} AS id_variant`;

/** The identity columns as the JSON shape the projector reads. */
function identityData(row: Row): { agent?: string; model?: Record<string, string> } {
  const out: { agent?: string; model?: Record<string, string> } = {};
  const agent = asString(row.id_agent);
  if (agent) out.agent = agent;
  const id = asString(row.id_model);
  if (id) {
    const model: Record<string, string> = { id, providerID: asString(row.id_provider) ?? "" };
    const variant = asString(row.id_variant);
    if (variant !== null) model.variant = variant;
    out.model = model;
  }
  return out;
}

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

export function createV2HistorySource(db: ReadOnlyDb, opts: V2SourceOptions = {}): HistorySource {
  const projectID = opts.projectID;
  const byteCeiling = opts.pageByteCeiling ?? DEFAULT_PAGE_BYTE_CEILING;
  const pause = opts.yieldBetween ?? macrotask;
  const BYTES = byteLengthSql(db);
  /** A row's columns, with `data` NULL when it is larger than the ceiling
   *  now (re-checked here, not trusted from an earlier size read), plus its
   *  size. Binds the ceiling first. */
  const BODY_COLUMNS = `${MESSAGE_META_COLUMNS}, ${BYTES} AS bytes,
    CASE WHEN ${BYTES} <= ? THEN data END AS data`;
  /** The same columns for a page, from a budgeted range (see messagePage):
   *  `m` is the message row, `b` its size and running page total. */
  const PAGE_BODY_COLUMNS = `m.id, m.session_id, m.type, m.seq, m.time_created, m.time_updated,
    b.bytes AS bytes, CASE WHEN b.bytes <= ? THEN m.data END AS data`;

  /** Decode a body row, or build the placeholder for one too large to load. */
  function decodeBody(row: Row): DecodedRow {
    const message = toMessageRow(row);
    const bytes = asNumber(row.bytes) ?? 0;
    if (row.data === null && bytes > byteCeiling) {
      const { type, data } = placeholderData(message.type, oversizedNote(bytes, byteCeiling));
      return { ok: true, row: { ...message, type, data: "" }, data };
    }
    return decodeRow(message);
  }

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

  /** A session's fork filter binds (isFork, created). Both fields are fixed at
   *  creation, so they are remembered per source (FIFO-bounded); an unknown
   *  session is not remembered. */
  const forkMemo = new Map<string, SqlValue[]>();
  function forkBinds(id: string): SqlValue[] | undefined {
    const known = forkMemo.get(id);
    if (known) return known;
    const row = read("session fork", () =>
      db.get("SELECT fork_session_id, time_created FROM session_v2 WHERE id = ?", [id]),
    );
    if (!row) return undefined;
    const fork = typeof row.fork_session_id === "string" && row.fork_session_id !== "";
    const binds = [fork ? 1 : 0, asNumber(row.time_created) ?? 0];
    if (forkMemo.size >= FORK_MEMO_LIMIT) {
      const oldest = forkMemo.keys().next().value;
      if (oldest !== undefined) forkMemo.delete(oldest);
    }
    forkMemo.set(id, binds);
    return binds;
  }

  /** The session fields projection reads. Directory, agent and model can
   *  change, so they are read per call (one primary-key statement, only when
   *  there are rows to project). */
  function contextOf(id: string): SessionContext | undefined {
    const row = read("session context", () =>
      db.get("SELECT directory, agent, model FROM session_v2 WHERE id = ?", [id]),
    );
    if (!row) return undefined;
    return {
      id,
      directory: asString(row.directory) ?? "",
      agent: asString(row.agent) || null,
      model: parseModelRef(asString(row.model)) ?? null,
    };
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

  /** The latest parseable `type` switch row before `seq`, as a partial
   *  identity: one index seek on (session_id, type, seq). */
  async function switchBefore(
    type: SwitchType,
    sessionID: string,
    seq: number,
  ): Promise<Partial<UserIdentity> | undefined> {
    await pause();
    const row = read("switch", () =>
      db.get(
        `SELECT ${MESSAGE_COLUMNS} FROM session_message
         WHERE session_id = ? AND type = ? AND seq < ? AND json_valid(data)
         ORDER BY seq DESC LIMIT ?`,
        [sessionID, type, seq, 1],
      ),
    );
    if (!row) return undefined;
    const decoded = decodeRow(toMessageRow(row));
    return decoded.ok ? identityOf(decoded) : undefined;
  }

  /**
   * For each user seq (ascending), the latest `type` switch before it,
   * independent of which page the user row sits on. One seek resolves the
   * oldest user; one bounded range read covers the switches between the
   * oldest and newest user. If that range holds more than
   * {@link SWITCH_SCAN_LIMIT} switches, each remaining user gets its own seek
   * instead, so a burst of switches can never push a user's predecessor out
   * of view.
   */
  async function latestSwitches(
    type: SwitchType,
    sessionID: string,
    userSeqs: number[],
  ): Promise<Map<number, Partial<UserIdentity> | undefined>> {
    const out = new Map<number, Partial<UserIdentity> | undefined>();
    const oldest = userSeqs[0]!;
    const newest = userSeqs[userSeqs.length - 1]!;
    out.set(oldest, await switchBefore(type, sessionID, oldest));
    if (newest === oldest) return out;

    await pause();
    const range = read("switch range", () =>
      db.all(
        `SELECT ${MESSAGE_COLUMNS} FROM session_message
         WHERE session_id = ? AND type = ? AND seq > ? AND seq < ? AND json_valid(data)
         ORDER BY seq DESC LIMIT ?`,
        [sessionID, type, oldest, newest, SWITCH_SCAN_LIMIT + 1],
      ),
    );
    const truncated = range.length > SWITCH_SCAN_LIMIT;
    const switches = range.map((row) => decodeRow(toMessageRow(row)));
    for (const seq of userSeqs) {
      if (seq === oldest) continue;
      if (truncated) {
        out.set(seq, await switchBefore(type, sessionID, seq));
        continue;
      }
      // Newest first, so the first one below `seq` is its latest predecessor.
      const hit = switches.find((d) => d.row.seq < seq);
      out.set(seq, hit ? (hit.ok ? identityOf(hit) : undefined) : out.get(oldest));
    }
    return out;
  }

  /**
   * Attribute user-role rows: each field from the latest
   * preceding agent/model switch, else the next assistant, else the session.
   * The switch lookups are per user and independent of page size, so a page
   * and `getMessage` attribute the same row the same way. Every statement is
   * LIMIT-bound; none runs unless the rows include a user.
   */
  async function identities(
    decoded: Array<Extract<DecodedRow, { ok: true }>>,
    sessionID: string,
    session: SessionContext,
  ): Promise<Map<string, UserIdentity>> {
    const out = new Map<string, UserIdentity>();
    const users = decoded.filter((d) => isUserRoleType(d.row.type));
    if (users.length === 0) return out;
    const userSeqs = [...new Set(users.map((d) => d.row.seq))].sort((a, b) => a - b);
    const newestUser = userSeqs[userSeqs.length - 1]!;
    const newestRow = Math.max(...decoded.map((d) => d.row.seq));

    const agents = await latestSwitches("agent-switched", sessionID, userSeqs);
    const models = await latestSwitches("model-switched", sessionID, userSeqs);

    const assistants = decoded
      .filter((d) => d.row.type === "assistant")
      .sort((a, b) => a.row.seq - b.row.seq);
    let after: Partial<UserIdentity> | undefined;
    if (!assistants.some((a) => a.row.seq > newestUser)) {
      await pause();
      const row = read("next assistant", () =>
        db.get(
          `SELECT seq, ${IDENTITY_COLUMNS}
           FROM session_message
           WHERE session_id = ? AND type = 'assistant' AND seq > ?
           ORDER BY seq ASC LIMIT ?`,
          [sessionID, newestRow, 1],
        ),
      );
      if (row) {
        after = identityOf({
          row: { ...toMessageRow(row), type: "assistant" },
          data: identityData(row),
        });
      }
    }

    for (const user of users) {
      const seq = user.row.seq;
      const next = assistants.find((a) => a.row.seq > seq);
      out.set(
        user.row.id,
        resolveIdentity(
          [agents.get(seq), models.get(seq), next ? identityOf(next) : after],
          session,
        ),
      );
    }
    return out;
  }

  /**
   * Decode and project body rows (newest first). An undecodable row rejects
   * the page under `strict` (the distiller's quarantine); otherwise it becomes
   * a placeholder message, so a page with rows is never empty and a walk never
   * stops early on bad data. Yields every {@link ROWS_PER_YIELD} rows.
   */
  async function project(
    rows: Row[],
    session: SessionContext,
    strict: boolean,
  ): Promise<HistoryMessage[]> {
    const decoded: Array<Extract<DecodedRow, { ok: true }>> = [];
    const unloaded: Array<Extract<DecodedRow, { ok: true }>> = [];
    for (let i = 0; i < rows.length; i++) {
      if (i > 0 && i % ROWS_PER_YIELD === 0) await pause();
      const row = rows[i]!;
      const d = decodeBody(row);
      if (d.ok) {
        decoded.push(d);
        // An oversized assistant or compaction lost its identity with its
        // body; recover it below so it attributes like the loaded row would.
        if (row.data === null && (d.row.type === "assistant" || d.row.type === "compaction")) {
          unloaded.push(d);
        }
        continue;
      }
      if (strict) throw new MalformedSessionError(d.reason);
      const { type, data } = placeholderData(d.row.type, malformedNote(d.reason));
      decoded.push({ ok: true, row: { ...d.row, type, data: "" }, data });
    }
    if (unloaded.length > 0) {
      await pause();
      const seqs = unloaded.map((d) => d.row.seq);
      const found = read("oversized identity", () =>
        db.all(
          `SELECT seq, ${IDENTITY_COLUMNS} FROM session_message
           WHERE session_id = ? AND seq IN (${seqs.map(() => "?").join(", ")})
           ORDER BY seq DESC LIMIT ?`,
          [session.id, ...seqs, seqs.length],
        ),
      );
      const bySeq = new Map(found.map((row) => [asNumber(row.seq), identityData(row)]));
      for (const d of unloaded) Object.assign(d.data, bySeq.get(d.row.seq) ?? {});
    }
    const who = await identities(decoded, session.id, session);
    const fallback = resolveIdentity([], session);
    const items: HistoryMessage[] = [];
    for (let i = 0; i < decoded.length; i++) {
      if (i > 0 && i % ROWS_PER_YIELD === 0) await pause();
      const d = decoded[i]!;
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
        // Mirrors the v1 server: `listGlobal` in opencode's
        // packages/opencode/src/session/session.ts (origin/dev) adds
        // `isNull(time_archived)` unless `input.archived` is set, and the plugin
        // never sets it; the project listing (`Session.list`) has no such
        // filter, so project scope keeps archived sessions here too.
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
      let below = o.before === undefined ? NO_CURSOR_SEQ : decodeV2Cursor(o.before);
      const fork = forkBinds(o.sessionID);
      if (!fork) throw new Error(`Session not found: ${o.sessionID}`);
      const notFound = new Error(`Session not found: ${o.sessionID}`);

      // Each attempt plans a page from sizes, then reads its bodies. Rows can
      // change eligibility between the two statements (a compaction completing,
      // a row growing), so the cursor comes from the rows actually returned.
      // Only a planned range that emptied entirely retries, bounded.
      for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
        // Sizes first: pick the page without loading a row body.
        await pause();
        const sizes = read("page sizes", () =>
          db.all(
            `SELECT seq, ${BYTES} AS bytes FROM session_message
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
          // An oversized row is never loaded, so it costs the page nothing.
          const cost = rowBytes > byteCeiling ? 0 : rowBytes;
          if (take > 0 && bytes + cost > byteCeiling) break;
          bytes += cost;
          take++;
        }
        const newest = asNumber(sizes[0]!.seq) ?? 0;
        const oldest = asNumber(sizes[take - 1]!.seq) ?? 0;
        const plannedMore = sizes.length > take;

        // Bodies, under the cumulative budget: sizes are re-read in the same
        // statement (rows may have grown since the plan), a running total
        // over loadable rows cuts the page where it would pass the ceiling,
        // and only rows inside the cut load `data`. The first row always fits
        // (its total is its own size, or 0 when it is oversized). The CTEs
        // hold only seq and size; bodies are read by the final join.
        await pause();
        const rows = read("page rows", () =>
          db.all(
            `WITH sized AS (
               SELECT seq, ${BYTES} AS bytes FROM session_message
               WHERE session_id = ? AND seq <= ? AND seq >= ? AND ${CONTENT_FILTER} AND ${FORK_FILTER}
               ORDER BY seq DESC LIMIT ?
             ), budget AS (
               SELECT seq, bytes,
                 sum(CASE WHEN bytes <= ? THEN bytes ELSE 0 END)
                   OVER (ORDER BY seq DESC ROWS UNBOUNDED PRECEDING) AS running
               FROM sized
             )
             SELECT ${PAGE_BODY_COLUMNS}
             FROM budget b JOIN session_message m ON m.session_id = ? AND m.seq = b.seq
             WHERE b.running <= ?
             ORDER BY m.seq DESC LIMIT ?`,
            [
              o.sessionID,
              newest,
              oldest,
              ...fork,
              take,
              byteCeiling,
              byteCeiling,
              o.sessionID,
              byteCeiling,
              take,
            ],
          ),
        );
        if (rows.length === 0) {
          // The whole planned range became ineligible: continue below it.
          if (!plannedMore) return { items: [], nextCursor: null };
          below = oldest;
          continue;
        }
        // If a row became eligible mid-range, LIMIT cut the page above the
        // planned oldest row; resuming from the oldest returned row keeps
        // every row below it for the next page.
        const returnedOldest = asNumber(rows[rows.length - 1]!.seq) ?? oldest;
        const more = plannedMore || returnedOldest > oldest;
        const session = contextOf(o.sessionID);
        if (!session) throw notFound;
        const items = await project(rows, session, o.strict === true);
        return { items, nextCursor: more ? encodeV2Cursor(returnedOldest) : null };
      }
      return { items: [], nextCursor: encodeV2Cursor(below) };
    },

    async getMessage(sessionID, messageID): Promise<Lookup<HistoryMessage>> {
      const notFound = {
        ok: false as const,
        reason: "not-found" as const,
        error: `Message not found: ${messageID}`,
      };
      const fork = forkBinds(sessionID);
      if (!fork) {
        return { ok: false, reason: "not-found", error: `Session not found: ${sessionID}` };
      }
      // One primary-key read: no yield before it.
      const row = read("message", () =>
        db.get(
          `SELECT ${BODY_COLUMNS} FROM session_message
           WHERE id = ? AND session_id = ? AND ${CONTENT_FILTER} AND ${FORK_FILTER} LIMIT ?`,
          [byteCeiling, messageID, sessionID, ...fork, 1],
        ),
      );
      if (!row) return notFound;
      const session = contextOf(sessionID);
      if (!session)
        return { ok: false, reason: "not-found", error: `Session not found: ${sessionID}` };
      const [message] = await project([row], session, false);
      return message ? { ok: true, value: message } : notFound;
    },
  };
}
