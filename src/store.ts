import type { Row, SqliteDb, SqlValue } from "./sqlite.js";
import { loadFs, loadPath, loadOs } from "./node-import.js";

/**
 * Card + slim-part-index store over a {@link SqliteDb}.
 *
 * The schema is versioned and self-healing: an absent (or pre-v1) stamp drops
 * everything and rebuilds at the current version, a v1 or v2 stamp is upgraded
 * additively in place (chaining v1->v2->v3, preserving all data), a newer stamp
 * makes {@link openStore} return `null` so the caller degrades to ephemeral mode.
 * All of that runs under one `BEGIN IMMEDIATE` so concurrent opencode processes
 * cannot race a rebuild. The newer-stamp refusal is the mixed-version fence: once
 * a store is bumped to v3, older plugin builds sharing the file degrade to
 * read-only ephemeral mode (no writes, no distill lease) rather than corrupting a
 * format they do not understand.
 *
 * Per-session writes are transactional delete-and-insert with an explicit FTS
 * mirror (the `part_fts` table is external-content, so deleting `part_text` rows
 * does not touch the index — the index is maintained by hand). Readers therefore
 * never observe half a replaced session.
 */

export const SCHEMA_VERSION = 3;

const SCHEMA_VERSION_KEY = "schema_version";
const LEASE_KEY = "distill_lease";
/** Meta stamp recording which embedding model produced the persisted card
 *  vectors. The card runtime reuses vectors only when this matches its
 *  configured model (see {@link Store.writeCardEmbeddings}). */
export const SEMANTIC_MODEL_KEY = "semantic_model";
/** Meta counter bumped by every {@link Store.writeCardEmbeddings} (which is the
 *  only vector writer, and covers its own model-change clear-all). Vector writes
 *  deliberately do NOT bump `cards_rev` — vectors are invisible to the lexical
 *  layer — so this separate counter is how a cross-process vector change becomes
 *  visible to another process's in-memory card snapshot (the runtime reloads when
 *  it advances). Fixes the mixed-version incident's silently-stale snapshots. */
export const VECTORS_REV_KEY = "vectors_rev";
/** Meta stamp recording the summarizer prompt-template version the persisted
 *  `nl_summary` values were produced under (see {@link Store.writeSummary}). */
export const SUMMARY_REV_KEY = "summary_rev";
const DEFAULT_FTS_LIMIT = 200;

// A lease whose heartbeat predates any realistic (or injected) cutoff, so a
// freshly created lease row is always immediately acquirable.
const EXPIRED_SENTINEL = JSON.stringify({
  holder: "",
  heartbeat: Number.MIN_SAFE_INTEGER,
  ttl: 0,
});

const PRAGMAS = "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;";

// Current-version (v3) DDL for a fresh store; older stores reach the same shape
// through the additive migrations below. No `prefix=` index: anchors are matched
// as exact quoted phrases, so prefix indexes would be write/disk cost with no
// query to serve them.
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
  embedding BLOB,
  embedding_gen INTEGER,
  nl_summary TEXT NOT NULL DEFAULT '',
  summary_hash TEXT NOT NULL DEFAULT ''
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
  /** Representation generation the persisted {@link embedding} was produced under
   *  ({@link import("./embedding-text.js").EMBED_REPRESENTATION}), or `null` for a
   *  legacy/unknown-generation row (existing rows after the additive v3 migration,
   *  or a card the distiller cleared). The card runtime treats a null- or
   *  lower-generation vector as absent (recompute path) and never lets a
   *  lower-generation writer overwrite a higher one — a per-row belt on top of the
   *  schema fence for future same-schema representation drift. Written only by
   *  {@link Store.writeCardEmbeddings} (and cleared alongside `embedding` on
   *  re-distill / model change). */
  embeddingGen: number | null;
  /** LLM-written natural-language summary (Path B), or "" when none. Preserved
   *  across re-distills (the distiller's card upsert never overwrites it — only
   *  {@link Store.writeSummary} does), joins the lexical index and the embedding
   *  text, and is preferred over `summaryHead` in browse/hook digests. */
  nlSummary: string;
  /** Change-detection hash of the mechanical fields (plus the prompt-template
   *  version) the current `nlSummary` was produced from; "" when unsummarized.
   *  The summarizer skips a card whose recomputed hash still matches. */
  summaryHash: string;
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
  /**
   * Persist card vectors from a semantic embed pass at representation generation
   * `gen`, stamping the model that produced them ({@link SEMANTIC_MODEL_KEY}). One
   * transaction: on a model change it first clears every existing vector AND its
   * generation (so no old-model BLOB survives under the new stamp), sets the
   * stamp, updates each listed row's `embedding` blob and `embedding_gen`, then
   * bumps {@link VECTORS_REV_KEY}. Rows whose session id is unknown update nothing.
   *
   * A write whose `gen` is LOWER than the store's current maximum `embedding_gen`
   * is rejected WHOLESALE before the stamp or any row changes — the model-change
   * clear-all would otherwise wipe the newer rows' generation and let the per-row
   * guard pass, a silent downgrade. Only a same-or-higher generation advances the
   * stamp, clears, or writes.
   *
   * Each surviving row's write still carries TWO guards:
   * - `expectedSummaryHash`: it lands only when the card's `summary_hash` still
   *   matches what the snapshot was embedded from. A concurrent
   *   {@link Store.writeSummary} changes the hash and nulls the vector to force a
   *   re-embed with the summary text; the guard makes the older, summary-less
   *   vector from a snapshot-in-flight lose that race instead of clobbering the
   *   cleared vector back to stale.
   * - generation: `embedding_gen IS NULL OR embedding_gen <= gen`, the per-row belt
   *   behind the wholesale check above.
   *
   * Deliberately does NOT bump `cards_rev` — vectors are invisible to the lexical
   * layer, so it would trigger a needless lexical reload (and a rebuild/embed/write
   * loop). It bumps `vectors_rev` instead, which the card runtime watches
   * separately so a cross-process vector change still invalidates a stale in-memory
   * snapshot. Callers write from the query path without the distill lease: a write
   * may lose to a concurrent cross-process re-distill that cleared the row's
   * embedding, and self-heals on that card's next re-distill.
   *
   * Returns `{ revision, committed }`: `revision` is the `vectors_rev` value AFTER
   * the call (the bumped value on a write, the unchanged value on a rejection) and
   * `committed` is true only when this call actually wrote. The card runtime trusts
   * `revision === rev0 + 1` as its own write ONLY when `committed` — a rejected
   * write's unchanged `revision` can coincide with a foreign higher-gen write that
   * advanced `vectors_rev` inside the snapshot window, and treating that as its own
   * bump would strand the stale snapshot.
   */
  writeCardEmbeddings(
    model: string,
    gen: number,
    rows: Array<{ sessionId: string; embedding: Uint8Array; expectedSummaryHash: string }>,
  ): CardEmbeddingWrite;
  /**
   * Persist a card's LLM summary and the change-detection hash it was produced
   * from ({@link Card.nlSummary}/{@link Card.summaryHash}). Owns those two
   * columns exclusively — the card upsert never writes them, so a summary
   * survives re-distills. Also clears the persisted vector: the embedding text
   * includes the summary, so a carried-over vector would be stale; null forces
   * the semantic layer to recompute with the summary on the next load (matching
   * the re-distill clear). A no-op when the session id is unknown.
   */
  writeSummary(sessionId: string, summary: string, hash: string): void;
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
  /**
   * Acquire or take over the distill lease, recording the holder plus the
   * acquiring build's `build` tag and representation `gen` in the lease value.
   * The conditional-write SEMANTICS are unchanged (absent / same-holder / expired
   * wins); the extra fields are pure observability so a mixed-version store can be
   * diagnosed with one {@link Store.leaseStatus} read instead of a process hunt.
   */
  acquireLease(holder: string, ttlMs: number, build: string, gen: number): boolean;
  heartbeatLease(holder: string): boolean;
  releaseLease(holder: string): boolean;
  /** Current lease holder info parsed from the lease row, or `undefined` when no
   *  lease row exists. `holder` is `""` for an expired/released sentinel (nobody
   *  holds it); `build`/`gen` are `""`/`0` for a legacy lease written before this
   *  field existed. Read-only; never mutates. */
  leaseStatus(): LeaseInfo | undefined;
};

/** Result of {@link Store.writeCardEmbeddings}: the `vectors_rev` value after the
 *  call, and whether this call actually committed a write (`false` when a
 *  lower-generation write was rejected wholesale). The card runtime needs BOTH to
 *  tell its own committed write from a foreign write whose bumped revision it
 *  merely observed on a rejection. */
export type CardEmbeddingWrite = { revision: number; committed: boolean };

/** Distill-lease holder info surfaced by {@link Store.leaseStatus}. */
export type LeaseInfo = {
  holder: string;
  /** Plugin build tag of the holder (see the plugin entry's build tag). */
  build: string;
  /** Representation generation the holder runs
   *  ({@link import("./embedding-text.js").EMBED_REPRESENTATION}). */
  gen: number;
  /** Holder's last heartbeat (ms epoch, from the holder's clock). */
  heartbeat: number;
  /** Lease TTL the holder set (ms). */
  ttl: number;
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
  "embedding_gen",
  "nl_summary",
  "summary_hash",
] as const;

// Columns the card upsert must NEVER overwrite: they are owned by a separate
// write path ({@link Store.writeSummary}) and would otherwise be wiped on every
// re-distill (deriveCard has no summary to supply). On a new-card insert they
// take their DEFAULT ''; on conflict they are simply left out of the UPDATE SET.
const SUMMARY_OWNED_COLUMNS = new Set<string>(["nl_summary", "summary_hash"]);

const CARD_COLUMNS_ALL = CARD_COLUMNS.join(", ");
const CARD_COLUMNS_NO_EMBEDDING = CARD_COLUMNS.filter((c) => c !== "embedding").join(", ");
const CARD_PLACEHOLDERS = CARD_COLUMNS.map(() => "?").join(", ");
const CARD_UPSERT_SET = CARD_COLUMNS.filter(
  (c) => c !== "session_id" && !SUMMARY_OWNED_COLUMNS.has(c),
)
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

/** A nullable INTEGER column (e.g. `embedding_gen`): a real number when present,
 *  `null` for SQL NULL or any non-numeric value. Distinct from {@link asNumber},
 *  which floors an absent value to 0 — here `null` must survive as "unknown". */
function asNullableNumber(value: SqlValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
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
    embeddingGen: asNullableNumber(row.embedding_gen),
    nlSummary: asString(row.nl_summary),
    summaryHash: asString(row.summary_hash),
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
    card.embeddingGen,
    card.nlSummary,
    card.summaryHash,
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

/** Stamp the schema-version meta row to `version` (upsert). Shared by the
 *  additive migrations so each records the version it actually reached. */
function stampVersion(db: SqliteDb, version: number): void {
  db.run(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [SCHEMA_VERSION_KEY, String(version)],
  );
}

/**
 * Additive v1 -> v2 upgrade: add the Path B summary columns in place, preserving
 * every existing card row, slim-index row, FTS entry, and persisted vector. No
 * rebuild, no re-distill. The columns carry a DEFAULT so existing rows read as
 * unsummarized. Stamps v2; a v1 store chains straight on into {@link migrateV2ToV3}.
 */
function migrateV1ToV2(db: SqliteDb): void {
  db.exec("ALTER TABLE card ADD COLUMN nl_summary TEXT NOT NULL DEFAULT ''");
  db.exec("ALTER TABLE card ADD COLUMN summary_hash TEXT NOT NULL DEFAULT ''");
  stampVersion(db, 2);
}

/**
 * Additive v2 -> v3 upgrade: add the per-row representation generation column in
 * place, preserving every card / slim-index / FTS / vector / summary row and the
 * meta stamps. The column is nullable with NO default, so existing rows read as
 * `NULL` — an "unknown/legacy generation" the card runtime treats as absent and
 * any writer may overwrite. Stamps the LITERAL destination version 3 (not
 * `SCHEMA_VERSION`): a future v4 bump must add its own v3->v4 step, and a v2 store
 * running that build must land on 3 here first so the ladder then applies v3->v4.
 */
function migrateV2ToV3(db: SqliteDb): void {
  db.exec("ALTER TABLE card ADD COLUMN embedding_gen INTEGER");
  stampVersion(db, 3);
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
      // Newer than this build understands: refuse (degrade), never misread it.
      if (current !== null && current > SCHEMA_VERSION) return "newer";
      if (current === SCHEMA_VERSION) return "ok";
      // v1 and v2 upgrade additively in place, keeping all data; v1 chains through
      // both migrations. Anything else older (absent stamp or a foreign layout) is
      // dropped and rebuilt fresh.
      if (current === 1) {
        migrateV1ToV2(db);
        migrateV2ToV3(db);
      } else if (current === 2) {
        migrateV2ToV3(db);
      } else {
        rebuild(db);
      }
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

  writeCardEmbeddings(
    model: string,
    gen: number,
    rows: Array<{ sessionId: string; embedding: Uint8Array; expectedSummaryHash: string }>,
  ): CardEmbeddingWrite {
    return this.db.tx((): CardEmbeddingWrite => {
      // FIRST, before touching the stamp or any row: reject a lower-generation
      // write WHOLESALE. Because the generation folds into the model stamp
      // (`model:gen`), a lagging writer always has a different stamp than a newer
      // one, so it would take the clear-all branch below, NULL the newer rows'
      // generation, and then its per-row guard would pass — a silent downgrade.
      // The up-front check closes that: only a same-or-higher generation writer
      // may advance the stamp, clear rows, or write. (MAX over an all-NULL/empty
      // column is NULL — an unestablished store any generation may seed.)
      const maxGen = this.currentMaxGen();
      if (maxGen !== null && gen < maxGen) {
        // No-op: unchanged vectors_rev, and committed:false. The unchanged rev may
        // COINCIDE with a foreign higher-gen write that advanced it inside the
        // caller's snapshot window, so the caller must NOT treat it as its own
        // bump — the `committed` flag is what keeps that stale snapshot reloading.
        return { revision: this.currentVectorsRev(), committed: false };
      }
      // On a model change, drop every existing vector AND its generation before
      // writing the new ones: a card the new model cannot embed (embed returned
      // undefined, so it is absent from `rows`) would otherwise keep an old-model
      // BLOB that the next load reuses as current under the new stamp.
      if (this.getMeta(SEMANTIC_MODEL_KEY) !== model) {
        this.db.run(
          "UPDATE card SET embedding=NULL, embedding_gen=NULL WHERE embedding IS NOT NULL",
        );
      }
      this.setMeta(SEMANTIC_MODEL_KEY, model);
      for (const row of rows) {
        // Two guards (see the interface doc): the summary hash makes a stale,
        // summary-less vector lose to a concurrent writeSummary; the generation
        // guard (`embedding_gen IS NULL OR embedding_gen <= ?`) is the per-row belt
        // behind the wholesale up-front check above (always satisfied here, since
        // gen >= maxGen >= every row's generation).
        this.db.run(
          "UPDATE card SET embedding=?, embedding_gen=? WHERE session_id=? AND summary_hash=? AND (embedding_gen IS NULL OR embedding_gen <= ?)",
          [row.embedding, gen, row.sessionId, row.expectedSummaryHash, gen],
        );
      }
      // Vectors are invisible to cards_rev by design, so bump vectors_rev instead
      // — the one signal that makes this change (including the clear-all above)
      // visible to another process's in-memory card snapshot. committed:true plus
      // the bumped value lets the card runtime confirm THIS call's own write
      // (exactly rev0+1 AND committed means no foreign write interleaved).
      return { revision: this.bumpVectorsRev(), committed: true };
    });
  }

  /** The highest `embedding_gen` currently stored, or `null` when no row carries a
   *  generation (an empty/all-legacy store any generation may seed). */
  private currentMaxGen(): number | null {
    const row = this.db.get("SELECT MAX(embedding_gen) AS m FROM card");
    return asNullableNumber(row?.m);
  }

  /** The current vectors-revision counter as a number (0 when unset). */
  private currentVectorsRev(): number {
    return Number(this.getMeta(VECTORS_REV_KEY)) || 0;
  }

  /** Increment the vectors-revision counter (see {@link VECTORS_REV_KEY}) and
   *  return the new value. Caller supplies the transaction. */
  private bumpVectorsRev(): number {
    const next = this.currentVectorsRev() + 1;
    this.setMeta(VECTORS_REV_KEY, String(next));
    return next;
  }

  writeSummary(sessionId: string, summary: string, hash: string): void {
    this.db.run("UPDATE card SET nl_summary=?, summary_hash=?, embedding=NULL WHERE session_id=?", [
      summary,
      hash,
      sessionId,
    ]);
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
       WHERE part_fts MATCH ?
       ORDER BY score, p.time_created DESC, p.session_id, p.part_id
       LIMIT ?`,
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
  acquireLease(holder: string, ttlMs: number, build: string, gen: number): boolean {
    const now = this.now();
    const cutoff = now - ttlMs;
    // `build`/`gen` ride the value for diagnosis only; the WHERE clause below is
    // unchanged, so acquire semantics (absent / same-holder / expired) are too.
    // A heartbeat updates only `$.heartbeat` (json_set), so they survive renewals.
    const value = JSON.stringify({ holder, heartbeat: now, ttl: ttlMs, build, gen });
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

  leaseStatus(): LeaseInfo | undefined {
    const raw = this.getMeta(LEASE_KEY);
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    return {
      holder: typeof record.holder === "string" ? record.holder : "",
      build: typeof record.build === "string" ? record.build : "",
      gen: typeof record.gen === "number" ? record.gen : 0,
      heartbeat: typeof record.heartbeat === "number" ? record.heartbeat : 0,
      ttl: typeof record.ttl === "number" ? record.ttl : 0,
    };
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
