import { openSqliteReadOnly, type ReadOnlyDb, type Row, type SqlValue } from "../sqlite.js";
import { unavailableText } from "../digest.js";
import type { HistoryMessage, HistorySession } from "./model.js";
import {
  assertBoundedLimit,
  createHistoryDriftState,
  emptyReadCounts,
  hasReadCounts,
  MalformedSessionError,
  type ArchivedFilter,
  type HistoryDriftBase,
  type HistoryDriftState,
  type HistoryReadCounts,
  type HistorySource,
  type Listing,
  type ListingOrder,
  type Lookup,
  type MessagePage,
} from "./source.js";
import {
  CONTENT_TYPES,
  decodePartRow,
  decodeRow,
  identityOf,
  isUserRoleType,
  PART_TYPES,
  projectMessage,
  projectSession,
  resolveIdentity,
  parseModelRef,
  type DecodedRow,
  type MessageParts,
  type SessionContext,
  type UserIdentity,
  type V2MessageRow,
  type V2PartRow,
  type V2SessionRow,
} from "./v2-project.js";

/**
 * The v2 history adapter: opencode v2's own `opencode.db`, read-only.
 *
 * The v2 plugin API cannot list sessions or page messages, so this reads the
 * `session_v2`, `session_message`, `session_part` and `project` tables
 * directly (as cortexkit/magic-context does) and projects rows through
 * `history/v2-project.ts`. The rules:
 *
 * - Read-only: the handle comes from `openSqliteReadOnly` (`query_only`), and
 *   every read is one statement. No transaction is ever held, least of all
 *   across an `await`.
 * - Bounded: every `session_message` and `session_part` statement binds
 *   `LIMIT ?` (a test spy enforces it), and a page also stops at a byte
 *   ceiling on the encoded size of its message rows plus their part rows,
 *   read before any body is loaded. A row larger than the ceiling on its own
 *   is never loaded at all: it projects as a placeholder message (see
 *   {@link placeholderData}), or a part row as a placeholder part, so paging,
 *   drill, deep and the distiller keep moving past it, and the placeholder
 *   text is what gets indexed. The body statements re-read every size, since
 *   rows can grow between statements, and cut where a running total would
 *   pass what is left of the ceiling, so the bytes a page loads never exceed
 *   it. A first message whose parts do not fit loads them in ordinal order up
 *   to the cut (possibly none) and is marked `partial` (see
 *   {@link MessageParts}); `getMessage` continues it from a part ordinal,
 *   charging the envelope's metadata rather than its inline content, and a
 *   continuation may pass the ceiling by at most that metadata
 *   ({@link CONTINUATION_METADATA_MAX}) so that it always moves forward. An
 *   oversized row's placeholder takes the session's agent and model; no
 *   statement reads anything from its body (beyond measuring it, which on
 *   SQLite before 3.43 loads it inside SQLite). (The exceptions are the
 *   compaction status filter, which parses a compaction row's JSON inside
 *   SQLite, and a continuation's envelope read, which has SQLite split a row
 *   within the ceiling into its metadata and its inline content.)
 * - Consistent: opencode moves an assistant's inline content into part rows
 *   on a later write. A read that took the envelope before such a move and
 *   the part rows after it would hold that content twice, so a read whose
 *   envelope held inline content re-checks the row's `time_updated` and size
 *   after its part read and reads the message again when they changed.
 * - Parts by their own statements: part sizes and part bodies are read by
 *   `session_part` statements scoped by session id and the page's message
 *   ids. No `session_message` statement reads `session_part`. A database
 *   without the table (opencode before 2.4) reads inline content only.
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

/**
 * Columns of the tables behind optional capabilities. A table that is absent
 * or lacks a column turns its capability off and never refuses: without
 * `session_part` (opencode before 2.4), assistant content is inline only.
 */
export const OPTIONAL_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  session_part: [
    "message_id",
    "session_id",
    "ordinal",
    "type",
    "call_id",
    "time_created",
    "time_updated",
    "data",
  ],
};

/**
 * The opencode migrations this build was tested against, oldest first: the
 * full migration table of opencode 2.4.1. A database whose newest migration
 * is not listed still opens; it is reported as drift, since it may store
 * history in a shape this build does not read.
 */
export const TESTED_MIGRATIONS: readonly string[] = [
  "20260127222353_familiar_lady_ursula",
  "20260211171708_add_project_commands",
  "20260213144116_wakeful_the_professor",
  "20260225215848_workspace",
  "20260227213759_add_session_workspace_id",
  "20260228203230_blue_harpoon",
  "20260303231226_add_workspace_fields",
  "20260309230000_move_org_to_state",
  "20260312043431_session_message_cursor",
  "20260323234822_events",
  "20260410174513_workspace-name",
  "20260413175956_chief_energizer",
  "20260423070820_add_icon_url_override",
  "20260427172553_slow_nightmare",
  "20260428004200_add_session_path",
  "20260501142318_next_venus",
  "20260504145000_add_sync_owner",
  "20260507164347_add_workspace_time",
  "20260510033149_session_usage",
  "20260511000411_data_migration_state",
  "20260511173437_session-metadata",
  "20260601010001_normalize_storage_paths",
  "20260601202201_amazing_prowler",
  "20260602002951_lowly_union_jack",
  "20260602182828_add_project_directories",
  "20260603001617_session_message_projection_indexes",
  "20260603040000_session_message_projection_order",
  "20260603141458_session_input_inbox",
  "20260603160727_jittery_ezekiel_stane",
  "20260604172448_event_sourced_session_input",
  "20260605003541_add_session_context_snapshot",
  "20260605042240_add_context_epoch_agent",
  "20260611035744_credential",
  "20260611192811_lush_chimera",
  "20260612174303_project_dir_strategy",
  "20260622142730_simplify_session_context_epoch",
  "20260622170816_reset_v2_session_state",
  "20260622202450_simplify_session_input",
  "20260804233008_loose_psylocke",
  "20260805200742_import_legacy_credentials",
  "20260808023530_workspace_domain",
  "20260811161259_execution_claim_attempts",
  "20260812181746_session_inbox",
  "20260812213948_worktree",
  "20260819222447_session_viewed_state",
  "20260823191254_nullable_workspace_binding",
  "20260910120000_clear_v1_session_permission",
  "20260923013825_project_time_active",
  "20261007190000_azure_cli_external_credential",
  "20261010180456_project_time_archived",
  "20261024002554_session_allowance",
  "20261024175301_drop_session_allowance",
  "20261025123711_blob",
  "20261025154125_drop_session_pending",
  "20261026223005_schedule",
  "20261029002625_session_part",
  "20261029073502_session_time_busy",
  "20261029165540_schedule_checks",
  "20261030054400_job",
  "20261116043204_automation",
  "20261116181958_automation_event_position",
  "20261116213417_automation_active_index",
  "20261119211416_machine",
  "20261120004954_machine-key",
];

/** `session*` tables this build knows: the ones it reads and the ones
 *  opencode keeps beside them that hold nothing it indexes. */
const KNOWN_SESSION_TABLES = new Set([
  "session",
  "session_share",
  "session_inbox",
  "session_message",
  "session_part",
  "session_v2",
]);
/** Known table name prefixes: opencode 2.4.1's search tables and their FTS
 *  shadow tables. */
const KNOWN_SESSION_PREFIXES = ["session_search"];
/** `session*` tables listed at most. */
const SESSION_TABLES_LIMIT = 256;

/** What a schema check learned beyond the required columns. */
export type V2SchemaInfo = {
  /** The newest applied opencode migration id, or null when unreadable. */
  migration: string | null;
  /** Whether {@link migration} is in {@link TESTED_MIGRATIONS}. */
  migrationTested: boolean;
  /** Whether `session_part` exists with every column in
   *  {@link OPTIONAL_COLUMNS}, so assistant part rows are read. */
  parts: boolean;
  /** Columns of an optional table that exists without them
   *  (`table.column`), sorted; the table's capability is off. */
  missingOptional: string[];
  /** `session*` tables outside the known set, sorted. */
  unknownTables: string[];
};

export type V2SchemaCheck = ({ ok: true } & V2SchemaInfo) | { ok: false; reason: string };

/** A table's column names. The table name is bound, so no statement text
 *  names a history table. */
function columnsOf(db: ReadOnlyDb, table: string): Set<string> {
  return new Set(
    db.all("SELECT name FROM pragma_table_info(?)", [table]).map((row) => String(row.name)),
  );
}

/**
 * Check that every column we read exists. The rest is recorded, never
 * refused: the newest `migration` id (an opencode release that adds one must
 * not strand users), the optional `session_part` capability, and unknown
 * `session*` tables.
 */
export function checkV2Schema(db: ReadOnlyDb): V2SchemaCheck {
  const missing: string[] = [];
  try {
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      const present = columnsOf(db, table);
      for (const column of columns) if (!present.has(column)) missing.push(`${table}.${column}`);
    }
  } catch (error) {
    return { ok: false, reason: `cannot read the opencode.db schema: ${messageOf(error)}` };
  }
  if (missing.length > 0) {
    return { ok: false, reason: `opencode.db schema lacks ${missing.join(", ")}` };
  }
  return { ok: true, ...inspectV2Schema(db) };
}

/** The optional parts of {@link checkV2Schema}. Never throws: anything it
 *  cannot read leaves its capability off. */
export function inspectV2Schema(db: ReadOnlyDb): V2SchemaInfo {
  const migration = newestMigration(db);
  const missingOptional: string[] = [];
  let parts = false;
  try {
    const present = columnsOf(db, "session_part");
    if (present.size > 0) {
      const lacking = OPTIONAL_COLUMNS.session_part!.filter((column) => !present.has(column));
      for (const column of lacking) missingOptional.push(`session_part.${column}`);
      parts = lacking.length === 0;
    }
  } catch {
    parts = false;
  }
  return {
    migration,
    migrationTested: migration !== null && TESTED_MIGRATIONS.includes(migration),
    parts,
    missingOptional: missingOptional.sort(),
    unknownTables: unknownSessionTables(db),
  };
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

/** `session*` tables outside the known set, sorted; empty when unreadable. */
function unknownSessionTables(db: ReadOnlyDb): string[] {
  try {
    const rows = db.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ORDER BY name LIMIT ?",
      ["session%", SESSION_TABLES_LIMIT],
    );
    return rows
      .map((row) => String(row.name))
      .filter(
        (name) =>
          !KNOWN_SESSION_TABLES.has(name) &&
          !KNOWN_SESSION_PREFIXES.some((prefix) => name.startsWith(prefix)),
      );
  } catch {
    return [];
  }
}

/** The fixed drift a schema check implies. */
export function v2DriftBase(schema: V2SchemaInfo): HistoryDriftBase {
  return {
    capabilities: { parts: schema.parts },
    migration: { newest: schema.migration, tested: schema.migrationTested },
    unknownTables: [...schema.unknownTables],
    missingColumns: [...schema.missingOptional],
  };
}

export type OpencodeDbOpen =
  | { ok: true; db: ReadOnlyDb; migration: string | null; schema: V2SchemaInfo }
  | { ok: false; reason: string };

/** Open `opencode.db` read-only and check its schema. The handle is closed
 *  on a failed check; never throws. `schema` is meant for every source
 *  facade over the handle (`V2SourceOptions.schema`). */
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
  const schema: V2SchemaInfo = {
    migration: check.migration,
    migrationTested: check.migrationTested,
    parts: check.parts,
    missingOptional: check.missingOptional,
    unknownTables: check.unknownTables,
  };
  return { ok: true, db: opened.db, migration: check.migration, schema };
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
  /** Per-read cap on summed encoded `data` bytes of message and part rows,
   *  and the largest single row whose body is ever loaded (a larger one
   *  becomes a placeholder). A page always holds at least one message.
   *  Default 4 MiB. */
  pageByteCeiling?: number;
  /** Per-read cap on part rows. A first message with more parts is cut and
   *  continued through `getMessage`. Default 2,000. */
  pagePartRows?: number;
  /** Awaited between statements. Default: one macrotask (`setTimeout(0)`). */
  yieldBetween?: () => Promise<void>;
  /** What the schema check found ({@link openOpencodeDb}'s `schema`).
   *  Default: probed once per handle. */
  schema?: V2SchemaInfo;
  /** The drift state this source records its reads in. Default: one state
   *  per handle, shared by every source over it. */
  drift?: HistoryDriftState;
};

const DEFAULT_PAGE_BYTE_CEILING = 4 * 1024 * 1024;
const DEFAULT_PAGE_PART_ROWS = 2_000;
/** Children per page when the caller gives no limit. */
const CHILDREN_PAGE = 1_000;
/** Messages per `session_part` statement, which binds one or two
 *  parameters for each. */
const PART_ID_CHUNK = 500;
/** Messages a page holds at most, whatever its limit, so the per-message
 *  parameters of its statements stay far below SQLite's bound-parameter
 *  limit. */
const PAGE_MESSAGES_MAX = 5_000;
/** Part rows decoded between yields to the event loop. */
const PARTS_PER_YIELD = 200;
/** The largest envelope metadata (the row's data without its inline content)
 *  a part continuation loads; a larger one is left out and the message takes
 *  the session's agent and model. A continuation can pass the byte ceiling by
 *  at most this much (see `getMessage`). */
export const CONTINUATION_METADATA_MAX = 16 * 1024;
/** Reads of one message tried while its stored row keeps changing under the
 *  part read, before the read settles for leaving its inline content out. */
const ENVELOPE_ATTEMPTS = 3;
/** The lowest part ordinal: a whole message reads from here. */
const FIRST_ORDINAL = Number.MIN_SAFE_INTEGER;
/** Sessions whose immutable fork fields are remembered per source. */
const FORK_MEMO_LIMIT = 512;
/** Rows decoded or projected between yields to the event loop. */
const ROWS_PER_YIELD = 25;
/** Switch rows of one type read at once between a page's oldest and newest
 *  user; a longer run falls back to one seek per user. */
const SWITCH_SCAN_LIMIT = 64;

type SwitchType = "agent-switched" | "model-switched";
/** A switch row whose data is a JSON object; anything else (bad JSON, an
 *  array, a scalar) is skipped in SQL, so it cannot hide an older valid
 *  switch. Nested CASE: `json_type` rejects malformed JSON. */
const SWITCH_OBJECT = "CASE WHEN json_valid(data) THEN json_type(data) = 'object' ELSE 0 END";
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
 * SQL for the encoded size in bytes of `column`. `octet_length` (SQLite
 * 3.43+) reads only the record header; `length(CAST(... AS BLOB))` works
 * everywhere but loads the value inside SQLite. `length(...)` would count
 * characters, which undercounts multibyte text.
 */
function byteLengthSql(db: ReadOnlyDb, column: string): string {
  try {
    db.get("SELECT octet_length('x') AS n");
    return `octet_length(${column})`;
  } catch {
    return `length(CAST(${column} AS BLOB))`;
  }
}

/** The text a placeholder carries in place of a message or part row too
 *  large to load. Worded without domain words (see {@link unavailableText}). */
export function oversizedNote(bytes: number, ceiling: number): string {
  return unavailableText(`${bytes}-byte row over the ${ceiling}-byte cap`);
}

/** The text a placeholder carries in place of a message or part row whose
 *  data cannot be decoded (outside `strict`, which rejects instead): the
 *  decoder's reason without its `message <id>` or `message <id> part <n>`
 *  lead. */
export function malformedNote(reason: string): string {
  return unavailableText(reason.replace(/^message \S+ (?:part -?\d+ )?/, ""));
}

/** The text that ends a message whose parts a read cut short: what was left
 *  out and where the rest starts. Worded without domain words. */
export function cutNote(omittedParts: number, omittedBytes: number, nextOrdinal: number): string {
  const size = omittedBytes > 0 ? ` (${omittedBytes} bytes)` : "";
  return unavailableText(
    `${omittedParts} more items${size} over the read cap, continued from ordinal ${nextOrdinal}`,
  );
}

/** `n` comma-separated SQL parameters. */
function bindList(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
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

/**
 * An assistant row's identity from the one `json_extract` with several paths
 * the next-assistant lookup returns: a JSON array `[agent, model.id,
 * model.providerID, model.variant]`, or NULL for a row over the byte ceiling
 * or with invalid JSON. Only non-empty strings count, for every field.
 */
function identityFromArray(value: SqlValue | undefined): {
  agent?: string;
  model?: Record<string, string>;
} {
  if (typeof value !== "string") return {};
  let fields: unknown;
  try {
    fields = JSON.parse(value);
  } catch {
    return {};
  }
  if (!Array.isArray(fields)) return {};
  const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const [agent, id, providerID, variant] = fields.map(text);
  const out: { agent?: string; model?: Record<string, string> } = {};
  if (agent) out.agent = agent;
  if (id) {
    const model: Record<string, string> = { id, providerID: providerID ?? "" };
    if (variant) model.variant = variant;
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

function toPartRow(row: Row): V2PartRow {
  return {
    message_id: asString(row.message_id) ?? "",
    session_id: asString(row.session_id) ?? "",
    ordinal: asNumber(row.ordinal) ?? 0,
    type: asString(row.type) ?? "",
    call_id: asString(row.call_id),
    time_created: asNumber(row.time_created) ?? 0,
    time_updated: asNumber(row.time_updated) ?? 0,
    data: asString(row.data) ?? "",
  };
}

/** Part rows of one message as measured by a size read: from the read's
 *  first ordinal on, the row count, their loadable bytes (a row over the
 *  ceiling costs nothing; it becomes a placeholder) and all their bytes; and
 *  the count of rows before that ordinal. */
type PartSize = { rows: number; bytes: number; total: number; skipped: number };

/** Where a part read stopped short: the message (its position on the page)
 *  and the first ordinal it did not load. */
type PartCut = { pos: number; ordinal: number };

/** One assistant message's part rows as read, before the projector merges
 *  them. `inlineCount` is the number of inline content items when the
 *  envelope was read without them (a continuation); otherwise they are in
 *  the decoded envelope. */
type PartLoad = {
  rows: Row[];
  start: number;
  inlineCount?: number;
  cut?: { nextOrdinal: number; omittedRows: number; omittedBytes: number };
};

/** A message row's identity for change detection: a row that is rewritten
 *  (opencode moving its inline content into part rows) gets a new
 *  `time_updated` and, with its content gone, a new size. */
type Fingerprint = { timeUpdated: number; bytes: number };

/** A decoded (or placeholder) message row, ready to project. */
type Decoded = Extract<DecodedRow, { ok: true }>;

function fingerprintOf(row: Row): Fingerprint {
  return { timeUpdated: asNumber(row.time_updated) ?? 0, bytes: asNumber(row.bytes) ?? 0 };
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.timeUpdated === b.timeUpdated && a.bytes === b.bytes;
}

/** Inline content items in a decoded envelope. */
function inlineCountOf(data: Record<string, unknown>): number {
  return Array.isArray(data.content) ? data.content.length : 0;
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

/** Whether a decoded assistant row says it completed. */
function completedRow(data: Record<string, unknown>): boolean {
  const time = data.time;
  return (
    typeof time === "object" &&
    time !== null &&
    typeof (time as Record<string, unknown>).completed === "number"
  );
}

/** The schema and drift state of each handle, so every facade over one
 *  handle (a runtime's global source and its per-project facades) probes
 *  the schema once and accumulates one drift. */
const sharedByHandle = new WeakMap<
  ReadOnlyDb,
  { schema: V2SchemaInfo; drift: HistoryDriftState }
>();

function sharedState(
  db: ReadOnlyDb,
  opts: V2SourceOptions,
): { schema: V2SchemaInfo; drift: HistoryDriftState } {
  let entry = sharedByHandle.get(db);
  if (!entry) {
    const schema = opts.schema ?? inspectV2Schema(db);
    entry = { schema, drift: createHistoryDriftState(v2DriftBase(schema)) };
    sharedByHandle.set(db, entry);
  }
  return { schema: opts.schema ?? entry.schema, drift: opts.drift ?? entry.drift };
}

export function createV2HistorySource(db: ReadOnlyDb, opts: V2SourceOptions = {}): HistorySource {
  const projectID = opts.projectID;
  const byteCeiling = opts.pageByteCeiling ?? DEFAULT_PAGE_BYTE_CEILING;
  // At least one row: a cap of 0 would cut every read at the same ordinal.
  const partRowCap =
    typeof opts.pagePartRows === "number" && Number.isFinite(opts.pagePartRows)
      ? Math.max(1, Math.floor(opts.pagePartRows))
      : DEFAULT_PAGE_PART_ROWS;
  const pause = opts.yieldBetween ?? macrotask;
  const { schema, drift } = sharedState(db, opts);
  /** Whether part rows are read at all (`session_part` with every column). */
  const partsOn = schema.parts;
  const BYTES = byteLengthSql(db, "data");
  const PART_BYTES = byteLengthSql(db, "p.data");
  /** A row's data without its inline content, and that content, as SQLite
   *  re-encodes them (only ever evaluated on a row within the ceiling whose
   *  data is a JSON object). */
  const META_BYTES = byteLengthSql(db, "json_remove(data, '$.content')");
  const INLINE_BYTES = byteLengthSql(db, "json_extract(data, '$.content')");
  /** `expr` for a row within the ceiling whose data is a JSON object, else
   *  NULL. Binds the ceiling. Nested CASEs, so `json_type` never sees
   *  malformed JSON and nothing parses a row over the ceiling. */
  const ifObject = (expr: string): string =>
    `CASE WHEN ${BYTES} <= ? THEN CASE WHEN json_valid(data) THEN
       CASE WHEN json_type(data) = 'object' THEN ${expr} END END END`;
  /** A row's columns, with `data` NULL when it is larger than the ceiling
   *  now (re-checked here, not trusted from an earlier size read), plus its
   *  size. Binds the ceiling first. The size expression appears twice; with
   *  `octet_length` both reads are header-only, so only the pre-3.43
   *  `length(CAST(...))` fallback pays for it twice (one row, point reads
   *  only; a page measures once in its CTE). */
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
    if (row.data == null && bytes > byteCeiling) {
      const { type, data } = placeholderData(message.type, oversizedNote(bytes, byteCeiling));
      return { ok: true, row: { ...message, type, data: "" }, data };
    }
    return decodeRow(message);
  }

  /**
   * Part row sizes per message, from ordinal `from` on (rows below it are
   * only counted): one `session_part` statement per {@link PART_ID_CHUNK}
   * messages, each after a yield. Messages without part rows are absent.
   */
  async function partSizes(
    sessionID: string,
    ids: string[],
    from: number,
  ): Promise<Map<string, PartSize>> {
    const out = new Map<string, PartSize>();
    if (!partsOn) return out;
    for (let i = 0; i < ids.length; i += PART_ID_CHUNK) {
      const chunk = ids.slice(i, i + PART_ID_CHUNK);
      await pause();
      const rows = read("part sizes", () =>
        db.all(
          `SELECT message_id,
             sum(CASE WHEN ordinal >= ? THEN 1 ELSE 0 END) AS n,
             sum(CASE WHEN ordinal >= ? AND bytes <= ? THEN bytes ELSE 0 END) AS bytes,
             sum(CASE WHEN ordinal >= ? THEN bytes ELSE 0 END) AS total,
             sum(CASE WHEN ordinal < ? THEN 1 ELSE 0 END) AS skipped
           FROM (
             SELECT p.message_id AS message_id, p.ordinal AS ordinal, ${PART_BYTES} AS bytes
             FROM session_part p
             WHERE p.session_id = ? AND p.message_id IN (${bindList(chunk.length)})
           )
           GROUP BY message_id LIMIT ?`,
          [from, from, byteCeiling, from, from, sessionID, ...chunk, chunk.length],
        ),
      );
      for (const row of rows) {
        out.set(asString(row.message_id) ?? "", {
          rows: asNumber(row.n) ?? 0,
          bytes: asNumber(row.bytes) ?? 0,
          total: asNumber(row.total) ?? 0,
          skipped: asNumber(row.skipped) ?? 0,
        });
      }
    }
    return out;
  }

  /**
   * The part rows of a page's assistant messages from ordinal `from` on, in
   * page then ordinal order, under `budget` loadable bytes and the part row
   * cap, one `session_part` statement per {@link PART_ID_CHUNK} messages.
   * Each statement re-reads the sizes, returns a row over the byte ceiling
   * without its data (a placeholder) and stops where a running total would
   * pass what is left of the budget or the cap; the first row it leaves out
   * comes back as `cut`. With `force`, the first row of the message at
   * position 0 always comes back with its data when it is within the ceiling
   * on its own, even past `budget`: a continuation uses it so that every
   * read moves past at least one part row.
   */
  async function readParts(
    sessionID: string,
    page: Array<{ id: string; pos: number }>,
    from: number,
    budget: number,
    force: boolean,
  ): Promise<{ loaded: Row[]; cut?: PartCut }> {
    const loaded: Row[] = [];
    let left = Math.max(0, budget);
    let rowsLeft = partRowCap;
    for (let i = 0; i < page.length; i += PART_ID_CHUNK) {
      const chunk = page.slice(i, i + PART_ID_CHUNK);
      const forcedPos = force && i === 0 ? 0 : -1;
      await pause();
      const rows = read("part rows", () =>
        db.all(
          `WITH page(message_id, pos) AS (VALUES ${chunk.map(() => "(?, ?)").join(", ")}),
           sized AS (
             SELECT p.message_id AS message_id, p.ordinal AS ordinal, g.pos AS pos,
               ${PART_BYTES} AS bytes
             FROM page g JOIN session_part p
               ON p.session_id = ? AND p.message_id = g.message_id AND p.ordinal >= ?
             ORDER BY g.pos, p.ordinal LIMIT ?
           ), budget AS (
             SELECT message_id, ordinal, pos, bytes,
               sum(CASE WHEN bytes <= ? THEN bytes ELSE 0 END)
                 OVER (ORDER BY pos, ordinal ROWS UNBOUNDED PRECEDING) AS running,
               row_number() OVER (ORDER BY pos, ordinal) AS rn
             FROM sized
           ), marked AS (
             SELECT message_id, ordinal, pos, bytes, running,
               CASE WHEN rn <= ? AND (running <= ? OR (rn = 1 AND pos = ?)) THEN 1 ELSE 0 END AS inc
             FROM budget
           ), edge AS (
             SELECT message_id, ordinal, pos, bytes, running, inc,
               lag(inc, 1, 1) OVER (ORDER BY pos, ordinal) AS prev
             FROM marked
           )
           SELECT p.message_id, p.session_id, p.ordinal, p.type, p.call_id, p.time_created,
             p.time_updated, e.pos AS pos, e.bytes AS bytes, e.inc AS inc,
             CASE WHEN e.inc = 1 AND e.bytes <= ? THEN p.data END AS data
           FROM edge e JOIN session_part p ON p.message_id = e.message_id AND p.ordinal = e.ordinal
           WHERE e.inc = 1 OR e.prev = 1
           ORDER BY e.pos, e.ordinal LIMIT ?`,
          [
            ...chunk.flatMap((m) => [m.id, m.pos]),
            sessionID,
            from,
            rowsLeft + 1,
            byteCeiling,
            rowsLeft,
            left,
            forcedPos,
            byteCeiling,
            rowsLeft + 1,
          ],
        ),
      );
      // `inc` is a prefix of the rows in read order, so the one row without
      // it is the first one left out.
      for (const row of rows) {
        if (asNumber(row.inc) !== 1) {
          return {
            loaded,
            cut: { pos: asNumber(row.pos) ?? 0, ordinal: asNumber(row.ordinal) ?? 0 },
          };
        }
        loaded.push(row);
      }
      for (const row of rows) if (row.data != null) left -= asNumber(row.bytes) ?? 0;
      left = Math.max(0, left);
      rowsLeft -= rows.length;
    }
    return { loaded };
  }

  /** Bytes of the part rows a read loaded with their data. */
  function loadedBytes(rows: Row[]): number {
    let sum = 0;
    for (const row of rows) if (row.data != null) sum += asNumber(row.bytes) ?? 0;
    return sum;
  }

  /** The cut that leaves a message's inline content out after the part rows
   *  a read loaded (the next ordinal is past the last of them). */
  function inlineCut(rows: Row[], from: number): NonNullable<PartLoad["cut"]> {
    const last = rows.length > 0 ? asNumber(rows[rows.length - 1]!.ordinal) : null;
    return { nextOrdinal: last === null ? from : last + 1, omittedRows: 0, omittedBytes: 0 };
  }

  /**
   * The ids, among `rows` (message rows with the `time_updated` and `bytes`
   * they were read with), whose stored row changed since: one
   * `session_message` statement per {@link PART_ID_CHUNK} ids, each after a
   * yield. A row that is gone counts as changed.
   */
  async function changedRows(
    sessionID: string,
    rows: Array<{ id: string; was: Fingerprint }>,
  ): Promise<Set<string>> {
    const changed = new Set<string>();
    for (let i = 0; i < rows.length; i += PART_ID_CHUNK) {
      const chunk = rows.slice(i, i + PART_ID_CHUNK);
      await pause();
      const now = read("message fingerprints", () =>
        db.all(
          `SELECT id, time_updated, ${BYTES} AS bytes FROM session_message
           WHERE session_id = ? AND id IN (${bindList(chunk.length)}) LIMIT ?`,
          [sessionID, ...chunk.map((r) => r.id), chunk.length],
        ),
      );
      const byId = new Map(now.map((row) => [asString(row.id) ?? "", row]));
      for (const { id, was } of chunk) {
        const row = byId.get(id);
        if (!row || !sameFingerprint(was, fingerprintOf(row))) changed.add(id);
      }
    }
    return changed;
  }

  /**
   * Part rows of one message as content items for the projector, in ordinal
   * order: a row over the byte ceiling (the only kind a read returns without
   * its data) becomes a text placeholder naming its size, and one whose data
   * does not decode a text placeholder naming why (or a
   * {@link MalformedSessionError} under `strict`). Counts what it saw.
   */
  async function partItems(
    rows: Row[],
    strict: boolean,
    counts: HistoryReadCounts,
    unknownTypes: Set<string>,
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (i > 0 && i % PARTS_PER_YIELD === 0) await pause();
      const row = rows[i]!;
      const part = toPartRow(row);
      if (!PART_TYPES.includes(part.type)) {
        counts.unknownPartTypes++;
        unknownTypes.add(part.type);
      }
      if (row.data == null) {
        counts.oversizedParts++;
        items.push({ type: "text", text: oversizedNote(asNumber(row.bytes) ?? 0, byteCeiling) });
        continue;
      }
      const decoded = decodePartRow(part);
      if (!decoded.ok) {
        if (strict) throw new MalformedSessionError(decoded.reason);
        counts.malformedParts++;
        items.push({ type: "text", text: malformedNote(decoded.reason) });
        continue;
      }
      items.push(decoded.item);
    }
    return items;
  }

  /** The omitted part rows of a message cut at `nextOrdinal`, as a cut. */
  async function cutAt(
    sessionID: string,
    messageID: string,
    nextOrdinal: number,
  ): Promise<NonNullable<PartLoad["cut"]>> {
    const rest = (await partSizes(sessionID, [messageID], nextOrdinal)).get(messageID);
    return {
      nextOrdinal,
      // The read saw at least the row it left out, whatever the sizes say now.
      omittedRows: Math.max(1, rest?.rows ?? 0),
      omittedBytes: rest?.total ?? 0,
    };
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
   *  session is not remembered.
   *
   *  This makes deletion handling depend on call order: a session deleted
   *  before this source first reads it rejects "Session not found", but one
   *  deleted after its first read still has its binds here, finds no rows,
   *  and pages as empty (`nextCursor: null`); only a page that has rows to
   *  project re-reads the session and rejects. Both end the walk. */
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

  /**
   * One listing statement. `"recent"` orders by normalized recency; `"id"` by
   * the immutable session id, after `after` when given. One row past `limit`
   * decides `truncated`, and a truncated id listing resumes from its last id.
   */
  function listing(
    where: string[],
    binds: SqlValue[],
    o: { limit: number; order: ListingOrder; after?: string },
  ): Listing<HistorySession> {
    const clauses = [...where];
    const params = [...binds];
    if (o.after !== undefined) {
      clauses.push("s.id > ?");
      params.push(o.after);
    }
    const clause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const order = o.order === "id" ? "s.id ASC" : `${RECENCY} DESC, s.id DESC`;
    const rows = read("session list", () =>
      db.all(`SELECT ${SESSION_COLUMNS} ${SESSION_FROM} ${clause} ORDER BY ${order} LIMIT ?`, [
        ...params,
        o.limit + 1,
      ]),
    );
    const truncated = rows.length > o.limit;
    const items = rows.slice(0, o.limit).map((row) => projectSession(toSessionRecord(row).row));
    const last = items[items.length - 1];
    if (truncated && o.order === "id" && last) {
      return { ok: true, items, truncated, nextCursor: last.id };
    }
    return { ok: true, items, truncated };
  }

  /** Why a listing's paging options are rejected, or undefined. */
  function pagingError(o: { order?: ListingOrder; after?: unknown }): string | undefined {
    if (o.after === undefined) return undefined;
    if (typeof o.after !== "string") return "a listing cursor must be a string";
    if (o.order !== "id") return 'a listing cursor needs order "id"';
    return undefined;
  }

  /** The latest parseable `type` switch row before `seq`, as a partial
   *  identity: one index seek on (session_id, type, seq). */
  async function switchBefore(
    type: SwitchType,
    sessionID: string,
    seq: number,
    yieldFirst = true,
  ): Promise<Partial<UserIdentity> | undefined> {
    if (yieldFirst) await pause();
    const row = read("switch", () =>
      db.get(
        `SELECT ${MESSAGE_COLUMNS} FROM session_message
         WHERE session_id = ? AND type = ? AND seq < ? AND ${SWITCH_OBJECT}
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
         WHERE session_id = ? AND type = ? AND seq > ? AND seq < ? AND ${SWITCH_OBJECT}
         ORDER BY seq DESC LIMIT ?`,
        [sessionID, type, oldest, newest, SWITCH_SCAN_LIMIT + 1],
      ),
    );
    const truncated = range.length > SWITCH_SCAN_LIMIT;
    const switches = range.map((row) => decodeRow(toMessageRow(row)));
    let seeks = 0;
    for (const seq of userSeqs) {
      if (seq === oldest) continue;
      if (truncated) {
        // Single-row index seeks: yield before the first and then every
        // ROWS_PER_YIELD, not before each one.
        const yieldFirst = seeks++ % ROWS_PER_YIELD === 0;
        out.set(seq, await switchBefore(type, sessionID, seq, yieldFirst));
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
      // The identity of a row over the byte ceiling is NULL, exactly as an
      // on-page oversized assistant's placeholder carries none, so a page and
      // getMessage both fall back to the session for it. One json_extract with
      // several paths keeps it to one parse of the row.
      const row = read("next assistant", () =>
        db.get(
          `SELECT seq,
             CASE WHEN ${BYTES} <= ? THEN
               CASE WHEN json_valid(data) THEN
                 json_extract(data, '$.agent', '$.model.id', '$.model.providerID', '$.model.variant')
               END
             END AS identity
           FROM session_message
           WHERE session_id = ? AND type = 'assistant' AND seq > ?
           ORDER BY seq ASC LIMIT ?`,
          [byteCeiling, sessionID, newestRow, 1],
        ),
      );
      if (row) {
        after = identityOf({
          row: { ...toMessageRow(row), type: "assistant" },
          data: identityFromArray(row.identity),
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
   * Decode body rows (newest first). An undecodable row rejects under
   * `strict` (the distiller's quarantine); otherwise it becomes a placeholder,
   * so a page with rows is never empty and a walk never stops early on bad
   * data. Yields every {@link ROWS_PER_YIELD} rows.
   */
  async function decodeRows(rows: Row[], strict: boolean): Promise<Decoded[]> {
    const decoded: Decoded[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (i > 0 && i % ROWS_PER_YIELD === 0) await pause();
      // An oversized row's placeholder carries no agent or model: reading them
      // would make SQLite parse the whole row, the stall the ceiling exists to
      // prevent. It takes the session's, in pages and point reads alike.
      const d = decodeBody(rows[i]!);
      if (d.ok) {
        decoded.push(d);
        continue;
      }
      if (strict) throw new MalformedSessionError(d.reason);
      decoded.push(malformedPlaceholder(d.row, d.reason));
    }
    return decoded;
  }

  /** The placeholder for a row whose data does not decode. */
  function malformedPlaceholder(row: V2MessageRow, reason: string): Decoded {
    const { type, data } = placeholderData(row.type, malformedNote(reason));
    return { ok: true, row: { ...row, type, data: "" }, data };
  }

  /**
   * Project decoded rows (newest first), each assistant row with its part rows
   * from `parts` (keyed by message id). A part row that does not decode
   * rejects under `strict` and becomes a placeholder otherwise. Yields every
   * {@link ROWS_PER_YIELD} rows. Adds what it could not project faithfully to
   * `counts`.
   */
  async function project(
    decoded: Decoded[],
    session: SessionContext,
    strict: boolean,
    parts: Map<string, PartLoad>,
    counts: HistoryReadCounts,
    unknownTypes: Set<string>,
  ): Promise<HistoryMessage[]> {
    const who = await identities(decoded, session.id, session);
    const fallback = resolveIdentity([], session);
    const items: HistoryMessage[] = [];
    for (let i = 0; i < decoded.length; i++) {
      if (i > 0 && i % ROWS_PER_YIELD === 0) await pause();
      const d = decoded[i]!;
      const load = d.row.type === "assistant" ? parts.get(d.row.id) : undefined;
      let messageParts: MessageParts | undefined;
      if (load) {
        const partList = await partItems(load.rows, strict, counts, unknownTypes);
        messageParts = { items: partList, start: load.start };
        if (load.cut) {
          const inline = load.inlineCount ?? inlineCountOf(d.data);
          const omittedParts = load.cut.omittedRows + inline;
          messageParts.cut = {
            nextOrdinal: load.cut.nextOrdinal,
            omittedParts,
            omittedBytes: load.cut.omittedBytes,
            note: cutNote(omittedParts, load.cut.omittedBytes, load.cut.nextOrdinal),
          };
        }
      }
      const message = projectMessage(d, session, who.get(d.row.id) ?? fallback, messageParts);
      if (!message) continue;
      if (message.partial) counts.partialMessages++;
      if (load && load.rows.length > 0 && message.parts.length === 0 && completedRow(d.data)) {
        counts.emptyWithParts++;
      }
      items.push(message);
    }
    return items;
  }

  /** Record one read's counts in the shared drift state; the counts to put on
   *  a page, when any is non-zero. */
  function recordRead(
    counts: HistoryReadCounts,
    unknownTypes: Set<string>,
  ): HistoryReadCounts | undefined {
    drift.record(counts, unknownTypes);
    return hasReadCounts(counts) ? counts : undefined;
  }

  /**
   * Of the first `keep` rows, the assistant rows (id to position) whose
   * stored row changed while their part rows were read, among those such a
   * change could make hold content twice: the envelope held inline content,
   * part rows were loaded for it and the read was not cut (a cut leaves the
   * inline content out). opencode moves inline content into part rows after
   * the existing ordinals and empties the envelope, so a read that took the
   * envelope before the move and the part rows after it would hold that
   * content twice, under different ids.
   */
  async function movedDuringRead(
    sessionID: string,
    rows: Row[],
    decoded: Decoded[],
    loads: Map<string, PartLoad>,
    keep: number,
  ): Promise<Map<string, number>> {
    const candidates: Array<{ id: string; pos: number; was: Fingerprint }> = [];
    for (let pos = 0; pos < keep; pos++) {
      const d = decoded[pos]!;
      const load = loads.get(d.row.id);
      if (!load || load.cut || load.rows.length === 0 || inlineCountOf(d.data) === 0) continue;
      candidates.push({ id: d.row.id, pos, was: fingerprintOf(rows[pos]!) });
    }
    if (candidates.length === 0) return new Map();
    const changed = await changedRows(sessionID, candidates);
    return new Map(candidates.filter((c) => changed.has(c.id)).map((c) => [c.id, c.pos]));
  }

  /**
   * Continue an assistant message from part ordinal `from` (see
   * `HistorySource.getMessage`). The envelope is read without its inline
   * content: its metadata (the data minus `content`, left out when over
   * {@link CONTINUATION_METADATA_MAX}), the count and size of its inline
   * items and its fingerprint. The part rows from `from` on are read under
   * what the metadata and the inline content leave of the ceiling, the first
   * one forced in; then, when every part row fit, the inline content is read
   * if it still fits, in a statement that also re-reads the fingerprint.
   *
   * The bound: a continuation loads at most the ceiling, except that its
   * forced first part row, which is within the ceiling on its own, loads
   * even when the metadata leaves it too little room. That read loads the
   * metadata and part rows only, never the inline content, so it stays under
   * `byteCeiling + CONTINUATION_METADATA_MAX`. Each continuation moves past
   * at least one part row, so every part row within the ceiling is returned
   * with its data by some continuation.
   */
  async function continueMessage(
    sessionID: string,
    messageID: string,
    from: number,
    fork: SqlValue[],
  ): Promise<Lookup<HistoryMessage>> {
    for (let attempt = 0; ; attempt++) {
      // One primary-key read: no yield before the first.
      if (attempt > 0) await pause();
      const head = read("message head", () =>
        db.get(
          `SELECT ${MESSAGE_META_COLUMNS}, ${BYTES} AS bytes,
             CASE WHEN ${BYTES} > ? THEN 'oversized'
                  WHEN NOT json_valid(data) THEN 'invalid'
                  WHEN json_type(data) <> 'object' THEN 'other'
                  ELSE 'object' END AS shape,
             ${ifObject("json_array_length(data, '$.content')")} AS inline_count,
             ${ifObject(INLINE_BYTES)} AS inline_bytes,
             ${ifObject(META_BYTES)} AS meta_bytes,
             ${ifObject(`CASE WHEN ${META_BYTES} <= ? THEN json_remove(data, '$.content') END`)} AS meta
           FROM session_message
           WHERE id = ? AND session_id = ? AND ${CONTENT_FILTER} AND ${FORK_FILTER} LIMIT ?`,
          [
            byteCeiling,
            byteCeiling,
            byteCeiling,
            byteCeiling,
            byteCeiling,
            CONTINUATION_METADATA_MAX,
            messageID,
            sessionID,
            ...fork,
            1,
          ],
        ),
      );
      if (!head)
        return { ok: false, reason: "not-found", error: `Message not found: ${messageID}` };
      if (head.type !== "assistant") {
        return {
          ok: false,
          reason: "unsupported",
          error: `message ${messageID} is not an assistant message, so it has no part rows to continue`,
        };
      }
      const session = contextOf(sessionID);
      if (!session) return sessionNotFound(sessionID);

      // A placeholder envelope carries its note as its inline content. A
      // real one carries its metadata only, its inline content read last.
      const message = toMessageRow(head);
      const shape = asString(head.shape);
      let decoded: Decoded;
      let charge = 0;
      let inlineCount = 0;
      let inlineBytes = 0;
      if (shape === "oversized") {
        const placeholder = decodeBody(head);
        decoded = placeholder.ok
          ? placeholder
          : malformedPlaceholder(placeholder.row, placeholder.reason);
      } else if (shape === "invalid" || shape === "other") {
        const what = shape === "invalid" ? "is not valid JSON" : "is not an object";
        decoded = malformedPlaceholder(message, `message ${messageID} data ${what}`);
      } else {
        inlineCount = asNumber(head.inline_count) ?? 0;
        inlineBytes = inlineCount > 0 ? (asNumber(head.inline_bytes) ?? 0) : 0;
        let data: Record<string, unknown> = {};
        const meta = asString(head.meta);
        if (meta !== null) {
          const parsed = decodeRow({ ...message, data: meta });
          if (parsed.ok) {
            data = parsed.data;
            charge = asNumber(head.meta_bytes) ?? 0;
          }
        }
        decoded = { ok: true, row: { ...message, data: "" }, data: { ...data, content: [] } };
      }
      const inlinePending = inlineCount > 0;

      const start = (await partSizes(sessionID, [messageID], from)).get(messageID)?.skipped ?? 0;
      const got = await readParts(
        sessionID,
        [{ id: messageID, pos: 0 }],
        from,
        byteCeiling - charge - inlineBytes,
        true,
      );
      const counts = emptyReadCounts();
      const unknownTypes = new Set<string>();
      const load: PartLoad = { rows: got.loaded, start };
      if (inlinePending) load.inlineCount = inlineCount;
      if (got.cut) {
        load.cut = await cutAt(sessionID, messageID, got.cut.ordinal);
      } else if (inlinePending) {
        // With no part row loaded, the metadata and the inline content are
        // the envelope's own size, within the ceiling.
        const room =
          got.loaded.length > 0 ? byteCeiling - charge - loadedBytes(got.loaded) : byteCeiling;
        await pause();
        const tail = read("message inline content", () =>
          db.get(
            `SELECT time_updated, ${BYTES} AS bytes,
               ${ifObject(`CASE WHEN ${INLINE_BYTES} <= ? THEN json_extract(data, '$.content') END`)} AS content
             FROM session_message WHERE id = ? AND session_id = ? LIMIT ?`,
            [byteCeiling, room, messageID, sessionID, 1],
          ),
        );
        if (!tail || !sameFingerprint(fingerprintOf(head), fingerprintOf(tail))) {
          // The row changed under the part read: read it again, then settle
          // for the part rows read, with the inline content left for the
          // continuation (which reads part rows moved there too).
          if (attempt < ENVELOPE_ATTEMPTS - 1) continue;
          load.cut = inlineCut(got.loaded, from);
          counts.changedMessages++;
        } else {
          const items = parseInline(asString(tail.content));
          if (items === undefined) load.cut = inlineCut(got.loaded, from);
          else decoded.data.content = items;
        }
      }
      const [projected] = await project(
        [decoded],
        session,
        false,
        new Map([[messageID, load]]),
        counts,
        unknownTypes,
      );
      recordRead(counts, unknownTypes);
      return projected
        ? { ok: true, value: projected }
        : { ok: false, reason: "not-found", error: `Message not found: ${messageID}` };
    }
  }

  return {
    kind: "v2-sqlite",
    // One database answers every scope, so project and global lookups agree.
    scopedLookup: false,

    history: () => drift.snapshot(),

    async listSessions(o): Promise<Listing<HistorySession>> {
      assertListLimit(o.limit);
      const order = o.order ?? "recent";
      const invalid = pagingError({ order, after: o.after });
      if (invalid) return { ok: false, error: invalid };
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
      }
      // The default mirrors the v1 server: `listGlobal` in opencode's
      // packages/opencode/src/session/session.ts (origin/dev) adds
      // `isNull(time_archived)` unless `input.archived` is set; the project
      // listing (`Session.list`) has no such filter, so project scope keeps
      // archived sessions.
      const archived: ArchivedFilter = o.archived ?? (o.scope === "global" ? "exclude" : "include");
      if (archived === "exclude") where.push("s.time_archived IS NULL");
      if (o.search) {
        where.push("s.title LIKE ? ESCAPE '\\'");
        params.push(likeContains(o.search));
      }
      return listing(where, params, { limit: o.limit, order, after: o.after });
    },

    async getSession(id): Promise<Lookup<HistorySession>> {
      const record = sessionById(id);
      if (!record) return { ok: false, reason: "not-found", error: `Session not found: ${id}` };
      return { ok: true, value: projectSession(record.row) };
    },

    async listChildren(parentID, o = {}): Promise<Listing<HistorySession>> {
      const limit = o.limit ?? CHILDREN_PAGE;
      assertListLimit(limit);
      const order = o.order ?? "recent";
      const invalid = pagingError({ order, after: o.after });
      if (invalid) return { ok: false, error: invalid };
      const where = ["s.parent_id = ?"];
      if (o.archived === "exclude") where.push("s.time_archived IS NULL");
      return listing(where, [parentID], { limit, order, after: o.after });
    },

    async messagePage(o): Promise<MessagePage> {
      assertBoundedLimit(o.limit);
      let below = o.before === undefined ? NO_CURSOR_SEQ : decodeV2Cursor(o.before);
      const fork = forkBinds(o.sessionID);
      if (!fork) throw new Error(`Session not found: ${o.sessionID}`);
      const notFound = new Error(`Session not found: ${o.sessionID}`);

      const strict = o.strict === true;
      const limit = Math.min(o.limit, PAGE_MESSAGES_MAX);

      // Each attempt plans a page from sizes, then reads its bodies. Rows can
      // change eligibility between the two statements (a compaction completing,
      // a row growing), so the cursor comes from the rows actually returned.
      // Only a planned range that emptied entirely retries, bounded.
      for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
        // Sizes first: pick the page without loading a row body.
        await pause();
        const sizes = read("page sizes", () =>
          db.all(
            `SELECT id, type, seq, ${BYTES} AS bytes FROM session_message
             WHERE session_id = ? AND seq < ? AND ${CONTENT_FILTER} AND ${FORK_FILTER}
             ORDER BY seq DESC LIMIT ?`,
            [o.sessionID, below, ...fork, limit + 1],
          ),
        );
        if (sizes.length === 0) return { items: [], nextCursor: null };
        const planned = await partSizes(
          o.sessionID,
          sizes.map((size) => asString(size.id) ?? ""),
          FIRST_ORDINAL,
        );
        // Each message costs its envelope plus, for an assistant, its part
        // rows' bytes and count. The first message is always taken; its parts
        // are cut to fit if they do not.
        let take = 0;
        let bytes = 0;
        let partRows = 0;
        const extra: SqlValue[] = [];
        for (const size of sizes) {
          if (take >= limit) break;
          const rowBytes = asNumber(size.bytes) ?? 0;
          // An oversized row is never loaded, so it costs the page nothing.
          const envelope = rowBytes > byteCeiling ? 0 : rowBytes;
          const id = asString(size.id) ?? "";
          const own = size.type === "assistant" ? planned.get(id) : undefined;
          const cost = envelope + (own?.bytes ?? 0);
          const rowsCost = own?.rows ?? 0;
          if (take > 0 && (bytes + cost > byteCeiling || partRows + rowsCost > partRowCap)) break;
          bytes += cost;
          partRows += rowsCost;
          take++;
          if (own && own.bytes > 0) extra.push(id, own.bytes);
        }
        const newest = asNumber(sizes[0]!.seq) ?? 0;
        const oldest = asNumber(sizes[take - 1]!.seq) ?? 0;
        const plannedMore = sizes.length > take;

        // Bodies, under the cumulative budget: envelope sizes are re-read in
        // the same statement (rows may have grown since the size read), each row's
        // planned part bytes are added to it, a running total cuts the page
        // where it would pass the ceiling, and only rows inside the cut load
        // `data`. The first row is always kept; its parts are cut by the part
        // read when they no longer fit. The CTEs hold only ids, seqs and
        // sizes; bodies are read by the final join.
        await pause();
        const rows = read("page rows", () =>
          db.all(
            `WITH sized AS (
               SELECT id, seq, ${BYTES} AS bytes FROM session_message
               WHERE session_id = ? AND seq <= ? AND seq >= ? AND ${CONTENT_FILTER} AND ${FORK_FILTER}
               ORDER BY seq DESC LIMIT ?
             ), extra(id, bytes) AS (
               VALUES (NULL, 0)${", (?, ?)".repeat(extra.length / 2)}
             ), budget AS (
               SELECT s.seq AS seq, s.bytes AS bytes,
                 sum(CASE WHEN s.bytes <= ? THEN s.bytes ELSE 0 END + coalesce(e.bytes, 0))
                   OVER (ORDER BY s.seq DESC ROWS UNBOUNDED PRECEDING) AS running,
                 row_number() OVER (ORDER BY s.seq DESC) AS rn
               FROM sized s LEFT JOIN extra e ON e.id = s.id
             )
             SELECT ${PAGE_BODY_COLUMNS}
             FROM budget b JOIN session_message m ON m.session_id = ? AND m.seq = b.seq
             WHERE b.running <= ? OR b.rn = 1
             ORDER BY m.seq DESC LIMIT ?`,
            [
              o.sessionID,
              newest,
              oldest,
              ...fork,
              take,
              ...extra,
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

        const decoded = await decodeRows(rows, strict);

        // Parts of the page's assistant rows, under what the envelopes left
        // of the ceiling. A cut in the first message makes it partial and
        // ends the page with it (holding no part row at all when its first
        // one does not fit beside the envelope; a continuation reads it); a
        // cut in a later message ends the page before that message, which
        // leads the next page instead.
        const counts = emptyReadCounts();
        const unknownTypes = new Set<string>();
        const loads = new Map<string, PartLoad>();
        let keep = rows.length;
        const assistants = rows.flatMap((row, pos) =>
          row.type === "assistant" ? [{ id: asString(row.id) ?? "", pos }] : [],
        );
        if (partsOn && assistants.length > 0) {
          let envelopes = 0;
          for (const row of rows) if (row.data != null) envelopes += asNumber(row.bytes) ?? 0;
          const got = await readParts(
            o.sessionID,
            assistants,
            FIRST_ORDINAL,
            byteCeiling - envelopes,
            false,
          );
          if (got.cut) keep = Math.max(1, got.cut.pos);
          for (const { id, pos } of assistants) {
            if (pos >= keep) break;
            loads.set(id, {
              rows: got.loaded.filter((part) => asNumber(part.pos) === pos),
              start: 0,
            });
          }
          if (got.cut?.pos === 0) {
            // Only an assistant row has part rows, so position 0 is one.
            const firstID = asString(rows[0]!.id) ?? "";
            const load = loads.get(firstID);
            if (load) load.cut = await cutAt(o.sessionID, firstID, got.cut.ordinal);
          }
          const moved = await movedDuringRead(o.sessionID, rows, decoded, loads, keep);
          if (moved.size > 0) {
            // Read the page again; on the last attempt, the first message
            // leaves its inline content for the continuation and a later one
            // leads the next page.
            if (attempt < PAGE_ATTEMPTS - 1) continue;
            for (const [id, pos] of moved) {
              if (pos > 0) {
                keep = Math.min(keep, pos);
                continue;
              }
              const load = loads.get(id)!;
              load.cut = inlineCut(load.rows, FIRST_ORDINAL);
              counts.changedMessages++;
              keep = 1;
            }
          }
        }
        const kept = rows.slice(0, keep);
        for (const row of kept) {
          if (row.type === "assistant") continue;
          const stray = planned.get(asString(row.id) ?? "");
          if (stray) counts.strayParts += stray.rows + stray.skipped;
        }

        // If a row became eligible mid-range, LIMIT cut the page above the
        // planned oldest row; resuming from the oldest returned row keeps
        // every row below it for the next page.
        const returnedOldest = asNumber(kept[kept.length - 1]!.seq) ?? oldest;
        const more = plannedMore || returnedOldest > oldest || keep < rows.length;
        const session = contextOf(o.sessionID);
        if (!session) throw notFound;
        const items = await project(
          decoded.slice(0, keep),
          session,
          strict,
          loads,
          counts,
          unknownTypes,
        );
        const pageCounts = recordRead(counts, unknownTypes);
        return {
          items,
          nextCursor: more ? encodeV2Cursor(returnedOldest) : null,
          ...(pageCounts && { counts: pageCounts }),
        };
      }
      // Every attempt's planned range emptied between the size read and the
      // body read. This empty page with a cursor is the one case that can end
      // a drill early (a reader may stop on an empty page); it takes
      // PAGE_ATTEMPTS consecutive whole-range invalidations, which only a
      // concurrent writer rewriting the tail on every read could cause.
      return { items: [], nextCursor: encodeV2Cursor(below) };
    },

    async getMessage(sessionID, messageID, o = {}): Promise<Lookup<HistoryMessage>> {
      const notFound = {
        ok: false as const,
        reason: "not-found" as const,
        error: `Message not found: ${messageID}`,
      };
      const partOrdinal = o.partOrdinal;
      if (partOrdinal !== undefined && !Number.isSafeInteger(partOrdinal)) {
        return {
          ok: false,
          reason: "error",
          error: `part ordinal must be an integer, got ${String(partOrdinal)}`,
        };
      }
      if (partOrdinal !== undefined && !partsOn) {
        return {
          ok: false,
          reason: "unsupported",
          error: "this opencode database has no part rows, so it cannot continue a message",
        };
      }
      const fork = forkBinds(sessionID);
      if (!fork) {
        return { ok: false, reason: "not-found", error: `Session not found: ${sessionID}` };
      }
      if (partOrdinal !== undefined) {
        return continueMessage(sessionID, messageID, partOrdinal, fork);
      }

      for (let attempt = 0; ; attempt++) {
        // One primary-key read: no yield before the first.
        if (attempt > 0) await pause();
        const row = read("message", () =>
          db.get(
            `SELECT ${BODY_COLUMNS} FROM session_message
             WHERE id = ? AND session_id = ? AND ${CONTENT_FILTER} AND ${FORK_FILTER} LIMIT ?`,
            [byteCeiling, messageID, sessionID, ...fork, 1],
          ),
        );
        if (!row) return notFound;
        const session = contextOf(sessionID);
        if (!session) return sessionNotFound(sessionID);
        const decoded = await decodeRows([row], false);

        // An assistant's part rows, under what its envelope left of the
        // ceiling; a first part row that does not fit beside the envelope
        // cuts the message before it, for a continuation to read.
        const counts = emptyReadCounts();
        const unknownTypes = new Set<string>();
        const loads = new Map<string, PartLoad>();
        if (partsOn && row.type === "assistant") {
          const envelope = row.data != null ? (asNumber(row.bytes) ?? 0) : 0;
          const got = await readParts(
            sessionID,
            [{ id: messageID, pos: 0 }],
            FIRST_ORDINAL,
            byteCeiling - envelope,
            false,
          );
          const load: PartLoad = { rows: got.loaded, start: 0 };
          if (got.cut) load.cut = await cutAt(sessionID, messageID, got.cut.ordinal);
          loads.set(messageID, load);
          const moved = await movedDuringRead(sessionID, [row], decoded, loads, 1);
          if (moved.size > 0) {
            if (attempt < ENVELOPE_ATTEMPTS - 1) continue;
            load.cut = inlineCut(load.rows, FIRST_ORDINAL);
            counts.changedMessages++;
          }
        }
        const [message] = await project(decoded, session, false, loads, counts, unknownTypes);
        recordRead(counts, unknownTypes);
        return message ? { ok: true, value: message } : notFound;
      }
    },
  };
}

function sessionNotFound(sessionID: string): { ok: false; reason: "not-found"; error: string } {
  return { ok: false, reason: "not-found", error: `Session not found: ${sessionID}` };
}

/** Inline content items from `json_extract(data, '$.content')`, or undefined
 *  when the read left them out or they are not an array. */
function parseInline(text: string | null): unknown[] | undefined {
  if (text === null) return undefined;
  try {
    const items: unknown = JSON.parse(text);
    return Array.isArray(items) ? items : undefined;
  } catch {
    return undefined;
  }
}
