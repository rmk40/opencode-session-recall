import type { Row, SqliteDb, SqlValue } from "./sqlite.js";
import { loadFs, loadPath, loadOs } from "./node-import.js";

/**
 * Card + slim-part-index store over a {@link SqliteDb}.
 *
 * The schema is versioned and self-healing: an absent stamp builds v1, an older
 * stamp drops everything and rebuilds, a newer stamp makes {@link openStore}
 * return `null` so the caller degrades to ephemeral mode. All of that runs under
 * one `BEGIN IMMEDIATE` so concurrent opencode processes cannot race a rebuild.
 *
 * Per-session writes are transactional delete-and-insert with an explicit FTS
 * mirror (the `part_fts` table is external-content, so deleting `part_text` rows
 * does not touch the index — the index is maintained by hand). Readers therefore
 * never observe half a replaced session.
 */

export const SCHEMA_VERSION = 1;

const SCHEMA_VERSION_KEY = "schema_version";
const LEASE_KEY = "distill_lease";
const DEFAULT_FTS_LIMIT = 200;

// A lease whose heartbeat predates any realistic (or injected) cutoff, so a
// freshly created lease row is always immediately acquirable.
const EXPIRED_SENTINEL = JSON.stringify({
  holder: "",
  heartbeat: Number.MIN_SAFE_INTEGER,
  ttl: 0,
});

const PRAGMAS = "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;";

// DDL v1, verbatim from the implementation spec. No `prefix=` index: anchors are
// matched as exact quoted phrases, so prefix indexes would be write/disk cost
// with no query to serve them.
const DDL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE card (
  session_id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '',
  directory TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '',
  agent TEXT, model TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  part_count INTEGER NOT NULL DEFAULT 0, retained_chars INTEGER NOT NULL DEFAULT 0,
  summary_head TEXT NOT NULL DEFAULT '', outcome_head TEXT NOT NULL DEFAULT '',
  inventory TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL DEFAULT '[]', tools TEXT NOT NULL DEFAULT '[]',
  errors TEXT NOT NULL DEFAULT '[]', family_rollup TEXT NOT NULL DEFAULT '[]',
  distill_state TEXT NOT NULL DEFAULT 'metadata',
  distilled_through TEXT,
  embedding BLOB
);
CREATE INDEX card_updated ON card(time_updated DESC);
CREATE INDEX card_root ON card(root_id);
CREATE INDEX card_project ON card(project_id);

CREATE TABLE part_text (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, part_id TEXT NOT NULL,
  message_id TEXT NOT NULL, prev_message_id TEXT, next_message_id TEXT,
  class TEXT NOT NULL, time_created INTEGER NOT NULL,
  raw TEXT NOT NULL, norm TEXT NOT NULL
);
CREATE INDEX part_text_session ON part_text(session_id);
CREATE UNIQUE INDEX part_text_part ON part_text(part_id);

CREATE VIRTUAL TABLE part_fts USING fts5(
  raw, norm, content='part_text', content_rowid='id',
  tokenize="unicode61 tokenchars '_-./'"
);
`;

// ── Types ─────────────────────────────────────────────────────────────────

/** One capped family highlight, carrying provenance back to the child that did
 *  the work. The distiller (a later stage) owns the full shape; the store only
 *  round-trips it as JSON. */
export type FamilyRollup = {
  sessionId: string;
  messageId: string;
  snippet?: string;
};

/** One card, mirroring the `card` table with camelCase fields. JSON columns
 *  (`files`/`tools`/`errors`/`family_rollup`) are exposed parsed. */
export type Card = {
  sessionId: string;
  parentId: string | null;
  rootId: string;
  title: string;
  slug: string;
  directory: string;
  projectId: string;
  agent: string | null;
  model: string | null;
  timeCreated: number;
  timeUpdated: number;
  partCount: number;
  retainedChars: number;
  summaryHead: string;
  outcomeHead: string;
  inventory: string;
  files: string[];
  tools: string[];
  errors: string[];
  familyRollup: FamilyRollup[];
  distillState: "metadata" | "full";
  distilledThrough: string | null;
  embedding: Uint8Array | null;
};

/** One slim-index row to be written for a session (session id comes from the
 *  {@link Store.replaceSessionParts} argument, not the row). */
export type PartTextRow = {
  partId: string;
  messageId: string;
  prevMessageId: string | null;
  nextMessageId: string | null;
  class: string;
  timeCreated: number;
  raw: string;
  norm: string;
};

/** One FTS match, carrying the drill-down targets captured during distillation. */
export type FtsHit = {
  sessionId: string;
  partId: string;
  messageId: string;
  prevMessageId: string | null;
  nextMessageId: string | null;
  class: string;
  score: number;
};

export type StoreOptions = {
  /** Injectable clock for lease TTL logic; defaults to `Date.now`. */
  now?: () => number;
};

export type Store = {
  upsertCard(card: Card): void;
  getCard(sessionId: string): Card | undefined;
  allCards(opts?: { withEmbeddings?: boolean }): Card[];
  deleteSession(sessionId: string): void;
  replaceSessionParts(sessionId: string, rows: PartTextRow[], card: Card): void;
  /**
   * Append new slim-index rows to a session's existing rows, enforce the
   * per-session FTS row cap over the combined set (newest-first, same semantics
   * as the full replace path — oldest overflow rows are evicted from the FTS
   * index and `part_text`), then recompute the card from the surviving rows,
   * all inside one transaction. Because the surviving set is exactly the newest
   * `ftsRowsPerSession` rows, the recomputed card matches a full re-distill of
   * the same state even when the session crosses the cap — the equivalence that
   * makes append mode safe. `recompute` receives every surviving
   * {@link PartTextRow} in insertion (oldest-first) order.
   *
   * `boundary` carries the checkpoint (previous newest) message id and the first
   * appended message id, so the checkpoint message's dangling `next_message_id`
   * is repointed across the append seam — matching what a full re-distill would
   * store, which the Tier-2 context walk relies on.
   */
  appendSessionParts(
    sessionId: string,
    rows: PartTextRow[],
    ftsRowsPerSession: number,
    boundary: { checkpointMessageId: string; firstNewMessageId: string },
    recompute: (allRows: PartTextRow[]) => Card,
  ): void;
  ftsSearch(input: { strong: string[]; weak: string[]; limit?: number }): FtsHit[];
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  acquireLease(holder: string, ttlMs: number): boolean;
  heartbeatLease(holder: string): boolean;
  releaseLease(holder: string): boolean;
};

// ── Column layout (single source of truth for card CRUD) ────────────────────

const CARD_COLUMNS = [
  "session_id",
  "parent_id",
  "root_id",
  "title",
  "slug",
  "directory",
  "project_id",
  "agent",
  "model",
  "time_created",
  "time_updated",
  "part_count",
  "retained_chars",
  "summary_head",
  "outcome_head",
  "inventory",
  "files",
  "tools",
  "errors",
  "family_rollup",
  "distill_state",
  "distilled_through",
  "embedding",
] as const;

const CARD_COLUMNS_ALL = CARD_COLUMNS.join(", ");
const CARD_COLUMNS_NO_EMBEDDING = CARD_COLUMNS.filter((c) => c !== "embedding").join(", ");
const CARD_PLACEHOLDERS = CARD_COLUMNS.map(() => "?").join(", ");
const CARD_UPSERT_SET = CARD_COLUMNS.filter((c) => c !== "session_id")
  .map((c) => `${c}=excluded.${c}`)
  .join(", ");
const CARD_UPSERT_SQL = `INSERT INTO card(${CARD_COLUMNS_ALL}) VALUES(${CARD_PLACEHOLDERS}) ON CONFLICT(session_id) DO UPDATE SET ${CARD_UPSERT_SET}`;

// ── Value coercion (defensive against unexpected column shapes) ──────────────

function asString(value: SqlValue | undefined, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: SqlValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: SqlValue | undefined, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return fallback;
}

function parseStringArray(value: SqlValue | undefined): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseRollup(value: SqlValue | undefined): FamilyRollup[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const out: FamilyRollup[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
      const messageId = typeof record.messageId === "string" ? record.messageId : "";
      const snippet = typeof record.snippet === "string" ? record.snippet : undefined;
      out.push(
        snippet === undefined ? { sessionId, messageId } : { sessionId, messageId, snippet },
      );
    }
    return out;
  } catch {
    return [];
  }
}

function rowToCard(row: Row): Card {
  return {
    sessionId: asString(row.session_id),
    parentId: asNullableString(row.parent_id),
    rootId: asString(row.root_id),
    title: asString(row.title),
    slug: asString(row.slug),
    directory: asString(row.directory),
    projectId: asString(row.project_id),
    agent: asNullableString(row.agent),
    model: asNullableString(row.model),
    timeCreated: asNumber(row.time_created),
    timeUpdated: asNumber(row.time_updated),
    partCount: asNumber(row.part_count),
    retainedChars: asNumber(row.retained_chars),
    summaryHead: asString(row.summary_head),
    outcomeHead: asString(row.outcome_head),
    inventory: asString(row.inventory),
    files: parseStringArray(row.files),
    tools: parseStringArray(row.tools),
    errors: parseStringArray(row.errors),
    familyRollup: parseRollup(row.family_rollup),
    distillState: row.distill_state === "full" ? "full" : "metadata",
    distilledThrough: asNullableString(row.distilled_through),
    embedding: row.embedding instanceof Uint8Array ? row.embedding : null,
  };
}

function cardValues(card: Card): SqlValue[] {
  return [
    card.sessionId,
    card.parentId,
    card.rootId,
    card.title,
    card.slug,
    card.directory,
    card.projectId,
    card.agent,
    card.model,
    card.timeCreated,
    card.timeUpdated,
    card.partCount,
    card.retainedChars,
    card.summaryHead,
    card.outcomeHead,
    card.inventory,
    JSON.stringify(card.files),
    JSON.stringify(card.tools),
    JSON.stringify(card.errors),
    JSON.stringify(card.familyRollup),
    card.distillState,
    card.distilledThrough,
    card.embedding,
  ];
}

// ── FTS MATCH construction ───────────────────────────────────────────────────

/** Double-quote one anchor as an FTS phrase, stripping any internal `"` so no
 *  user text can reach FTS query syntax. Returns null for empty anchors. */
function quoteAnchor(anchor: string): string | null {
  const stripped = anchor.replace(/"/g, "").trim();
  return stripped ? `"${stripped}"` : null;
}

/**
 * Build a MATCH expression. When any strong anchor survives quoting, the match
 * is the strong anchors AND-joined and weak anchors are dropped entirely — weak
 * anchors must never *narrow* a strong-anchored query (the earlier
 * `strong AND (weak OR …)` wrongly *required* a weak match). Only when there are
 * no strong anchors do weak anchors form an OR union. Returns null when every
 * anchor drops out. No raw user text ever reaches this string unquoted.
 */
export function buildMatch(strong: string[], weak: string[]): string | null {
  const strongQuoted = strong.map(quoteAnchor).filter((a): a is string => a !== null);
  if (strongQuoted.length > 0) return strongQuoted.join(" AND ");
  const weakQuoted = weak.map(quoteAnchor).filter((a): a is string => a !== null);
  if (weakQuoted.length > 0) return weakQuoted.join(" OR ");
  return null;
}

// ── Schema management ────────────────────────────────────────────────────────

function readSchemaVersion(db: SqliteDb): number | null {
  const hasMeta = db.get(
    "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='meta'",
  );
  if (!hasMeta) return null;
  const row = db.get("SELECT value FROM meta WHERE key=?", [SCHEMA_VERSION_KEY]);
  if (!row || typeof row.value !== "string") return null;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rebuild(db: SqliteDb): void {
  // The store owns the whole file, so an older layout is dropped wholesale.
  // Drop the FTS virtual table first (that removes its shadow tables), then any
  // remaining regular tables — including stragglers from a foreign layout.
  db.exec("DROP TABLE IF EXISTS part_fts;");
  const tables = db.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  );
  for (const table of tables) {
    const name = asString(table.name);
    if (name) db.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
  db.exec(DDL);
  db.run("INSERT INTO meta(key, value) VALUES(?, ?)", [SCHEMA_VERSION_KEY, String(SCHEMA_VERSION)]);
}

/**
 * Open a {@link Store} over an already-open {@link SqliteDb}. Applies the
 * connection PRAGMAs, then checks/repairs the schema under one transaction.
 * Returns `null` when the on-disk schema is newer than this code understands, or
 * on any unexpected failure, so the caller can fall back to ephemeral mode.
 */
export function openStore(db: SqliteDb, opts?: StoreOptions): Store | null {
  const now = opts?.now ?? Date.now;
  try {
    db.exec(PRAGMAS);
    const outcome = db.tx((): "ok" | "newer" => {
      const current = readSchemaVersion(db);
      if (current !== null && current > SCHEMA_VERSION) return "newer";
      if (current !== SCHEMA_VERSION) rebuild(db);
      return "ok";
    });
    if (outcome === "newer") return null;
    return new SqliteStore(db, now);
  } catch {
    return null;
  }
}

// ── Store implementation ─────────────────────────────────────────────────────

class SqliteStore implements Store {
  constructor(
    private readonly db: SqliteDb,
    private readonly now: () => number,
  ) {}

  upsertCard(card: Card): void {
    this.db.run(CARD_UPSERT_SQL, cardValues(card));
  }

  getCard(sessionId: string): Card | undefined {
    const row = this.db.get(`SELECT ${CARD_COLUMNS_ALL} FROM card WHERE session_id=?`, [sessionId]);
    return row ? rowToCard(row) : undefined;
  }

  allCards(opts?: { withEmbeddings?: boolean }): Card[] {
    const columns = opts?.withEmbeddings === true ? CARD_COLUMNS_ALL : CARD_COLUMNS_NO_EMBEDDING;
    const rows = this.db.all(`SELECT ${columns} FROM card ORDER BY time_updated DESC`);
    return rows.map(rowToCard);
  }

  deleteSession(sessionId: string): void {
    this.db.tx(() => {
      this.evictFts(sessionId);
      this.db.run("DELETE FROM part_text WHERE session_id=?", [sessionId]);
      this.db.run("DELETE FROM card WHERE session_id=?", [sessionId]);
    });
  }

  replaceSessionParts(sessionId: string, rows: PartTextRow[], card: Card): void {
    this.db.tx(() => {
      this.evictFts(sessionId);
      this.db.run("DELETE FROM part_text WHERE session_id=?", [sessionId]);
      for (const row of rows) this.insertRow(sessionId, row);
      this.upsertCard(card);
    });
  }

  appendSessionParts(
    sessionId: string,
    rows: PartTextRow[],
    ftsRowsPerSession: number,
    boundary: { checkpointMessageId: string; firstNewMessageId: string },
    recompute: (allRows: PartTextRow[]) => Card,
  ): void {
    this.db.tx(() => {
      const old = this.db.all(
        "SELECT id, raw, norm FROM part_text WHERE session_id=? ORDER BY id",
        [sessionId],
      );
      const total = old.length + rows.length;
      const overflow =
        ftsRowsPerSession > 0 && total > ftsRowsPerSession ? total - ftsRowsPerSession : 0;
      // Newest-first cap over old + new (matching capRows): evict the oldest
      // `overflow` rows — from the existing rows first (front of `old`), and any
      // remaining overflow simply skips the oldest new rows so they never insert.
      const evictOld = Math.min(overflow, old.length);
      for (let i = 0; i < evictOld; i++) {
        const row = old[i]!;
        this.db.run("INSERT INTO part_fts(part_fts, rowid, raw, norm) VALUES('delete', ?, ?, ?)", [
          asNumber(row.id),
          asString(row.raw),
          asString(row.norm),
        ]);
        this.db.run("DELETE FROM part_text WHERE id=?", [asNumber(row.id)]);
      }
      for (let i = overflow - evictOld; i < rows.length; i++) this.insertRow(sessionId, rows[i]!);
      // Repoint the checkpoint message's dangling next pointer at the first
      // appended message (only surviving checkpoint rows still NULL). A no-op
      // when the checkpoint was evicted by the cap — as it would be in a full
      // re-distill of the same state.
      this.db.run(
        "UPDATE part_text SET next_message_id=? WHERE session_id=? AND message_id=? AND next_message_id IS NULL",
        [boundary.firstNewMessageId, sessionId, boundary.checkpointMessageId],
      );
      this.upsertCard(recompute(this.readSessionRows(sessionId)));
    });
  }

  /** Insert one slim-index row into `part_text` and mirror it into the
   *  external-content FTS index under its freshly assigned rowid. Caller
   *  supplies the transaction. */
  private insertRow(sessionId: string, row: PartTextRow): void {
    const { lastInsertRowid } = this.db.run(
      "INSERT INTO part_text(session_id, part_id, message_id, prev_message_id, next_message_id, class, time_created, raw, norm) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        sessionId,
        row.partId,
        row.messageId,
        row.prevMessageId,
        row.nextMessageId,
        row.class,
        row.timeCreated,
        row.raw,
        row.norm,
      ],
    );
    this.db.run("INSERT INTO part_fts(rowid, raw, norm) VALUES(?, ?, ?)", [
      lastInsertRowid,
      row.raw,
      row.norm,
    ]);
  }

  /** Read every slim-index row for a session in insertion (oldest-first) order.
   *  Used by {@link appendSessionParts} to recompute the card from the full row
   *  set. */
  private readSessionRows(sessionId: string): PartTextRow[] {
    const rows = this.db.all(
      "SELECT part_id, message_id, prev_message_id, next_message_id, class, time_created, raw, norm FROM part_text WHERE session_id=? ORDER BY id",
      [sessionId],
    );
    return rows.map((row) => ({
      partId: asString(row.part_id),
      messageId: asString(row.message_id),
      prevMessageId: asNullableString(row.prev_message_id),
      nextMessageId: asNullableString(row.next_message_id),
      class: asString(row.class),
      timeCreated: asNumber(row.time_created),
      raw: asString(row.raw),
      norm: asString(row.norm),
    }));
  }

  /** Delete a session's rows from the external-content FTS index using their
   *  original indexed values (the FTS `'delete'` command requires them). Must
   *  run before the `part_text` rows are deleted. Caller supplies the tx. */
  private evictFts(sessionId: string): void {
    const old = this.db.all("SELECT id, raw, norm FROM part_text WHERE session_id=?", [sessionId]);
    for (const row of old) {
      this.db.run("INSERT INTO part_fts(part_fts, rowid, raw, norm) VALUES('delete', ?, ?, ?)", [
        asNumber(row.id),
        asString(row.raw),
        asString(row.norm),
      ]);
    }
  }

  ftsSearch(input: { strong: string[]; weak: string[]; limit?: number }): FtsHit[] {
    const match = buildMatch(input.strong ?? [], input.weak ?? []);
    if (!match) return [];
    const limit =
      input.limit != null && Number.isFinite(input.limit) && input.limit > 0
        ? Math.floor(input.limit)
        : DEFAULT_FTS_LIMIT;
    const rows = this.db.all(
      `SELECT p.session_id, p.part_id, p.message_id, p.prev_message_id, p.next_message_id, p.class, bm25(part_fts) AS score
       FROM part_fts JOIN part_text p ON p.id = part_fts.rowid
       WHERE part_fts MATCH ? ORDER BY score LIMIT ?`,
      [match, limit],
    );
    return rows.map((row) => ({
      sessionId: asString(row.session_id),
      partId: asString(row.part_id),
      messageId: asString(row.message_id),
      prevMessageId: asNullableString(row.prev_message_id),
      nextMessageId: asNullableString(row.next_message_id),
      class: asString(row.class),
      score: asNumber(row.score),
    }));
  }

  getMeta(key: string): string | undefined {
    const row = this.db.get("SELECT value FROM meta WHERE key=?", [key]);
    return row && typeof row.value === "string" ? row.value : undefined;
  }

  setMeta(key: string, value: string): void {
    this.db.run(
      "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [key, value],
    );
  }

  /**
   * Acquire or take over the distill lease as a single conditional write,
   * verified via the changes count — never an application-level
   * read-check-write. Succeeds when the row is absent, already held by this
   * holder, or expired (heartbeat older than `ttlMs` ago).
   */
  acquireLease(holder: string, ttlMs: number): boolean {
    const now = this.now();
    const cutoff = now - ttlMs;
    const value = JSON.stringify({ holder, heartbeat: now, ttl: ttlMs });
    return this.db.tx(() => {
      this.db.run("INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)", [
        LEASE_KEY,
        EXPIRED_SENTINEL,
      ]);
      const res = this.db.run(
        `UPDATE meta SET value=? WHERE key=? AND (json_extract(value,'$.holder')=? OR json_extract(value,'$.heartbeat') < ?)`,
        [value, LEASE_KEY, holder, cutoff],
      );
      return res.changes > 0;
    });
  }

  heartbeatLease(holder: string): boolean {
    const res = this.db.run(
      `UPDATE meta SET value=json_set(value,'$.heartbeat',?) WHERE key=? AND json_extract(value,'$.holder')=?`,
      [this.now(), LEASE_KEY, holder],
    );
    return res.changes > 0;
  }

  releaseLease(holder: string): boolean {
    const res = this.db.run(
      `UPDATE meta SET value=? WHERE key=? AND json_extract(value,'$.holder')=?`,
      [EXPIRED_SENTINEL, LEASE_KEY, holder],
    );
    return res.changes > 0;
  }
}

// ── Default store path ───────────────────────────────────────────────────────
// `src/` has no Node types, so the os/path/fs surface is reached only through
// the shared dynamic-import loaders in `node-import.ts`.

const STORE_CACHE_SUBDIR = ".cache/opencode-session-recall";
const STORE_FILENAME = "store-v1.db";

/**
 * Resolve the default store path (`~/.cache/opencode-session-recall/store-v1.db`)
 * and ensure its directory exists. Async because the only way to reach os/path/fs
 * from `src/` is dynamic import. Returns `null` if the directory cannot be
 * created (e.g. the drivers are unavailable), so the caller degrades.
 */
export async function defaultStorePath(): Promise<string | null> {
  try {
    const [fs, path, os] = await Promise.all([loadFs(), loadPath(), loadOs()]);
    const dir = path.join(os.homedir(), STORE_CACHE_SUBDIR);
    await fs.promises.mkdir(dir, { recursive: true });
    return path.join(dir, STORE_FILENAME);
  } catch {
    return null;
  }
}
