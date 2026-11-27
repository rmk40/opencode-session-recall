import type { Row, SqliteDb, SqlValue } from "./sqlite.js";
import { loadFs, loadPath, loadOs } from "./node-import.js";
import { EMBED_REPRESENTATION } from "./embedding-text.js";

/**
 * Card + slim-part-index store over a {@link SqliteDb}.
 *
 * The schema is versioned and self-healing: an absent (or pre-v1) stamp drops
 * everything and rebuilds at the current version, a v1 to v4 stamp is upgraded
 * additively in place (chaining v1->v2->v3->v4->v5, preserving all data), a
 * newer stamp makes {@link openStore} refuse so the caller degrades to cards-lite.
 * All of that runs under one `BEGIN IMMEDIATE` so concurrent opencode processes
 * cannot race a rebuild. The newer-stamp refusal is the mixed-version fence: once
 * a store is bumped to v5, older plugin builds that open the file degrade to
 * read-only cards-lite (no writes, no distill lease) rather than corrupting a
 * format they do not understand.
 *
 * Schema 4 adds the host fence: every store records the host that writes it
 * (`meta.store_host`) and, for the opencode v2 host, the history database it
 * was distilled from (`meta.source_db`). An opener for a different host or
 * source is refused before any migration, and a fence refusal writes nothing, so
 * two hosts pointed at one file never thrash it with rebuilds. Stores stamped 1-3
 * predate the fence and were all written by the v1 host.
 *
 * Schema 5 adds revision accounting and repair state. Every lexical card write
 * allocates the next `cards_rev` inside its own transaction, stamps it on the
 * row it wrote (`card.write_rev`) and advances `cards_stamped` with it, so a
 * reader can tell when an older build (which advances `cards_rev` alone) wrote
 * in between. `card.projector_gen` records which history projection a card was
 * built under, `card.repair_reason` why a stale card could not be rebuilt, and
 * the `range_hash` table holds hashes of source row ranges for later checks.
 *
 * A card distilled while its session's tail was still running also carries
 * its settled base (`card.settled_base`, {@link SettledBase}): what the
 * messages through the newest settled row contribute to it. The next write can
 * then re-read only the tail and replace only the tail's slim-index rows
 * ({@link Store.replaceSessionTail}).
 *
 * Per-session writes are transactional delete-and-insert with an explicit FTS
 * mirror (the `part_fts` table is external-content, so deleting `part_text` rows
 * does not touch the index — the index is maintained by hand). Readers therefore
 * never observe half a replaced session. A replace whose card and rows match
 * what is stored rewrites nothing but its checkpoint (see
 * {@link Store.replaceSessionParts}).
 */

export const SCHEMA_VERSION = 5;

/**
 * Who opens a store: the host lane (recorded in `meta.store_host`) and, for the
 * opencode v2 host, the history database it distills (`meta.source_db`). The v1
 * host reads history over HTTP and has no source; the v2 host must name one.
 *
 * `source` is compared with the stamp by exact string equality, so it must be
 * canonical: the v2 entry passes the `realpath` of the resolved `opencode.db`.
 * Two spellings of one file (a symlink, a relative path, a trailing slash)
 * would otherwise refuse each other as `source-mismatch`.
 */
export type StoreIdentity = { host: "opencode-v1" } | { host: "opencode-v2"; source: string };

/** The opencode host lane that writes a store. Recorded in `meta.store_host`. */
export type StoreHost = StoreIdentity["host"];

/**
 * Plugin build tag, `schema{N}.gen{M}.{host}`, or `schema{N}.gen{M}.proj{P}.{host}`
 * for a host that stamps a history projector generation `P`: recorded in the
 * distill lease and surfaced in `coverage.semantic.pluginVersion`, so one lease
 * read or one tool response shows which build and which host wrote a store.
 * Derived from the constants that gate mixed-version safety rather than the
 * package semver, which `src/` cannot read without a Node import.
 */
export function pluginBuild(host: StoreHost, projectorGen?: number): string {
  const projector = projectorGen === undefined ? "" : `.proj${projectorGen}`;
  return `schema${SCHEMA_VERSION}.gen${EMBED_REPRESENTATION}${projector}.${host}`;
}

const SCHEMA_VERSION_KEY = "schema_version";
/** Meta stamp naming the {@link StoreHost} that owns the store (schema 4+). */
export const STORE_HOST_KEY = "store_host";
/** Meta stamp naming the history database a v2-host store was distilled from.
 *  Absent for v1-host stores, whose history comes over HTTP. */
export const SOURCE_DB_KEY = "source_db";
/** Host implied by a pre-fence (schema 1-3) store: only the v1 host existed. */
const LEGACY_HOST: StoreHost = "opencode-v1";
const LEASE_KEY = "distill_lease";
/** Meta stamp recording which embedding model produced the persisted card
 *  vectors. The card runtime reuses vectors only when this matches its
 *  configured model (see {@link Store.writeCardEmbeddings}). */
export const SEMANTIC_MODEL_KEY = "semantic_model";
/** Meta counter bumped by every {@link Store.writeCardEmbeddings} (which is the
 *  only vector writer, and covers its own model-change clear-all). Vector writes
 *  deliberately do NOT bump `cards_rev` — vectors are invisible to the lexical
 *  layer — so this separate counter is how a cross-process vector change becomes
 *  visible to another process's in-memory card snapshot (the runtime reloads its
 *  vectors when it advances), which would otherwise go stale without any sign. */
export const VECTORS_REV_KEY = "vectors_rev";
/** Meta stamp recording the summarizer prompt-template version the persisted
 *  `nl_summary` values were produced under (see {@link Store.writeSummary}). */
export const SUMMARY_REV_KEY = "summary_rev";
/** Meta counter: the newest lexical card revision. Every stamped write and
 *  every {@link Store.deleteSession} that removed something allocates the next
 *  value inside its own transaction; an older build bumps it after its write. */
export const CARDS_REV_KEY = "cards_rev";
/** Meta counter advanced by one with every revision this build allocates, in
 *  the same transaction. A write that bumps `cards_rev` without it (an older
 *  build's) widens the gap between the two, and later writes never close it. */
export const CARDS_STAMPED_KEY = "cards_stamped";
/** Meta counter advanced by every {@link Store.deleteSession} that removed
 *  something, so a reader knows when to diff its card id set. */
export const CARDS_DELETED_KEY = "cards_deleted";
const DEFAULT_FTS_LIMIT = 200;
/** Default bound on the slim-index rows a plain-word lookup matches (see
 *  {@link boundWeakAnchors}). `bm25()` scores, and the lookup joins and sorts,
 *  every matched row before its LIMIT applies, so an OR over common words
 *  would touch a large share of the index. */
export const WEAK_MATCH_ROWS = 20_000;
/** A word the plain-word OR leaves out still ranks its rows while it is in
 *  fewer than this many times the budget's rows. The cap bounds cost:
 *  `bm25()` reads every row of each phrase in the match to weigh it, so a
 *  word past the cap would cost a walk of its whole posting list. */
const RANKING_ROWS_FACTOR = 5;

// A lease whose heartbeat predates any realistic (or injected) cutoff, so a
// freshly created lease row is always immediately acquirable.
const EXPIRED_SENTINEL = JSON.stringify({
  holder: "",
  heartbeat: Number.MIN_SAFE_INTEGER,
  ttl: 0,
});

/** Connection-only PRAGMA, safe before the fence: it changes nothing on disk. */
const PRE_FENCE_PRAGMAS = "PRAGMA busy_timeout=5000;";
/** Applied only once the fence accepts the store. `journal_mode=WAL` is
 *  persistent (it rewrites the file header), so a refused file must never see
 *  it; it also cannot change inside a transaction, so it runs after the
 *  fence's transaction commits. */
const ACCEPTED_PRAGMAS = "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;";

/** Index behind {@link Store.cardsSince}. Shared by the fresh DDL and the v4 -> v5
 *  migration. */
const WRITE_REV_INDEX_DDL = "CREATE INDEX card_write_rev ON card(write_rev);";

/**
 * Index behind {@link Store.repairPendingCount}: only the cards with a repair
 * reason, so counting them reads none of the others. SQLite keeps it in step
 * with every write to the table, whichever build makes it, so the count stays
 * exact while older builds write. It is no part of a schema version and
 * changes nothing a card means: a build that does not know it writes around
 * it, and an accepted open creates it wherever it is missing (an older
 * build's rebuild, or a store from before it existed).
 */
const REPAIR_PENDING_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS card_repair_pending ON card(session_id) WHERE repair_reason IS NOT NULL;";

/** Per-session hashes of source row ranges, keyed by the range's first `seq`
 *  ({@link RangeHash}). Shared by the fresh DDL and the v4 -> v5 migration. */
const RANGE_HASH_DDL = `
CREATE TABLE range_hash (
  session_id TEXT NOT NULL, start_seq INTEGER NOT NULL,
  end_seq INTEGER NOT NULL, row_count INTEGER NOT NULL,
  hash TEXT NOT NULL, sweep_gen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, start_seq)
) WITHOUT ROWID;
`;

// Current-version (v5) DDL for a fresh store; older stores reach the same shape
// through the additive migrations below. No `prefix=` index: anchors are matched
// as exact quoted phrases, so prefix indexes would be write/disk cost with no
// query to serve them. `distill_cursor` is the v2 host's per-session checkpoint
// ({@link Card.distillCursor}); the v1 lane leaves it NULL, as it does
// `projector_gen` and `settled_base` ({@link Card.settledBase}), where NULL
// means there is no base and the session is re-read in full.
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
  summary_hash TEXT NOT NULL DEFAULT '',
  distill_cursor TEXT,
  projector_gen INTEGER,
  write_rev INTEGER,
  repair_reason TEXT,
  settled_base TEXT,
  time_archived INTEGER
);
CREATE INDEX card_updated ON card(time_updated DESC);
CREATE INDEX card_root ON card(root_id);
CREATE INDEX card_project ON card(project_id);
${WRITE_REV_INDEX_DDL}
${RANGE_HASH_DDL}

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
 *  (`files`/`tools`/`errors`/`family_rollup`) are exposed parsed. Optional
 *  nullable columns read back absent when NULL, so a card written without them
 *  reads back exactly as it was written. */
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
  /** The session's highlights from its children, newest first. Owned by
   *  {@link Store.setFamilyRollup}: card writes keep the stored value (a first
   *  insert takes the card's), so re-distilling a root never clears it. */
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
  /** The v2 host's per-session distill checkpoint (opaque to the store): the
   *  tail the card was distilled against, so the next pass can tell appended
   *  rows from a rewritten tail. Absent/null on v1 and on a card written
   *  without one (the upsert then stores NULL, which reads as "not fresh"). */
  distillCursor?: string | null;
  /** The history projector generation the card's content was derived under.
   *  Only a host that stamps generations sets it; absent on the v1 host and on
   *  a card written before one was stamped. A card below the host's current
   *  generation is stale ({@link Store.staleCards}), and a write below the
   *  stored generation is refused ({@link SessionWrite}). */
  projectorGen?: number | null;
  /** When the session was archived (ms epoch); absent or null when it is not. */
  timeArchived?: number | null;
  /** The `cards_rev` revision of the last stamped write to this card. Set by
   *  the store; ignored on writes. Absent when no stamped write has touched the
   *  card (one migrated from an older schema or written by an older build). */
  writeRev?: number;
  /** Why the card could not be rebuilt at the current projector generation
   *  ({@link Store.markRepairPending}). Set by the store; ignored on writes.
   *  Cleared by any accepted {@link Store.replaceSessionParts}. */
  repairReason?: string;
  /** What the session's messages through its settled boundary contribute to
   *  the card, when the card was distilled against a running tail. Written
   *  with the card's checkpoint, which it belongs to: absent (NULL) when the
   *  checkpoint was settled, or on any card a host without checkpoints
   *  wrote. */
  settledBase?: SettledBase;
};

/**
 * A card's settled base: the part of a card that the messages up to the
 * newest settled history row below a running tail (the boundary) contribute.
 * Those messages do not change while the tail runs, so a write can merge the
 * base with a fresh read of the tail instead of reading the whole session
 * ({@link Store.replaceSessionTail}). The store round-trips the aggregates as
 * JSON and reads `rows` itself; the distiller owns their meaning.
 */
export type SettledBase = {
  /** The boundary: `seq` of the newest settled row below the running tail. */
  seq: number;
  /** The newest message at or below the boundary that the card holds, or
   *  null when there is none. Its slim-index rows point at the tail's first
   *  message (`next_message_id`). */
  messageId: string | null;
  /** How many of the session's slim-index rows, oldest first, belong to the
   *  base. The rest belong to the tail. */
  rows: number;
  /** The base messages' share of the card's aggregates, as
   *  {@link Card} stores them. */
  partCount: number;
  summaryHead: string;
  outcomeHead: string;
  files: string[];
  tools: string[];
  errors: string[];
  /** Base messages the card holds cut short. */
  cut: number;
};

/** Result of a stamped write: `changed` is true when it altered what readers
 *  see, which allocated a `cards_rev` revision. False when nothing differed or
 *  there was nothing to write. */
export type CardWrite = { changed: boolean };

/** Result of {@link Store.replaceSessionParts}, {@link Store.appendSessionParts}
 *  and {@link Store.replaceSessionTail}. `refused` is set when nothing was
 *  written: `older-generation` when the card's {@link Card.projectorGen} is
 *  below the stored one, so an older projection never overwrites a newer
 *  one; `base-changed` when a tail write finds the stored settled base is no
 *  longer the one it merged with, or a replace finds the stored rows may no
 *  longer be the ones its caller read ({@link StoredRows}). */
export type SessionWrite = { changed: boolean; refused?: "older-generation" | "base-changed" };

/** A session's slim-index rows as a caller read them before a
 *  {@link Store.replaceSessionParts}, for the write to compare against
 *  instead of reading them inside its transaction. */
export type StoredRows = {
  /** The card's {@link Card.writeRev}, read before the rows; null for a card
   *  no stamped write has touched. */
  writeRev: number | null;
  /** Every stored row of the session, oldest first ({@link Store.sessionRows}). */
  rows: PartTextRow[];
};

/** The checkpoint (previous newest) message of an append, and the first
 *  message it appends ({@link Store.appendSessionParts}). */
export type AppendBoundary = { checkpointMessageId: string; firstNewMessageId: string };

/** The rows a session holds after an append, from {@link appendedRows}. */
export type AppendLayout = {
  /** How many of the oldest stored rows the row cap evicts. */
  evict: number;
  /** Positions among the stored rows of those repointed at the first
   *  appended message. */
  repointed: number[];
  /** The appended rows the session keeps, oldest first: the row cap skips
   *  the oldest when they alone exceed it. */
  inserted: PartTextRow[];
  /** Every row the session holds after the append, oldest first. */
  rows: PartTextRow[];
};

/**
 * The rows {@link Store.appendSessionParts} leaves when it appends `rows` to
 * a session's `stored` rows (both oldest first). Under the row cap it keeps
 * the newest `ftsRowsPerSession` of them, evicting stored rows first, as a
 * full write of the same messages keeps. Rows of the checkpoint message that
 * point at no next message point at the first appended one. A caller that
 * read the stored rows builds the card from these rows before the write.
 */
export function appendedRows(
  stored: PartTextRow[],
  rows: PartTextRow[],
  ftsRowsPerSession: number,
  boundary: AppendBoundary,
): AppendLayout {
  const total = stored.length + rows.length;
  const overflow =
    ftsRowsPerSession > 0 && total > ftsRowsPerSession ? total - ftsRowsPerSession : 0;
  const evict = Math.min(overflow, stored.length);
  const repoint = (row: PartTextRow): PartTextRow =>
    row.messageId === boundary.checkpointMessageId && (row.nextMessageId ?? null) === null
      ? { ...row, nextMessageId: boundary.firstNewMessageId }
      : row;
  const repointed: number[] = [];
  const kept = stored.slice(evict).map((row, i) => {
    const next = repoint(row);
    if (next !== row) repointed.push(evict + i);
    return next;
  });
  const inserted = rows.slice(overflow - evict).map(repoint);
  return { evict, repointed, inserted, rows: [...kept, ...inserted] };
}

/** The tail a {@link Store.replaceSessionTail} writes over a settled base. */
export type SessionTail = {
  /** The settled base the tail was merged with, as read from the card. */
  base: SettledBase;
  /** How many of the base's oldest slim-index rows the row cap evicts. */
  evict: number;
  /** The tail's slim-index rows, oldest first. */
  rows: PartTextRow[];
  /** The tail's first message, which the base's newest message's rows point
   *  at (`next_message_id`), or null when the tail has no message. */
  firstMessageId: string | null;
  /** The card's {@link Card.writeRev} when the caller read its rows, null
   *  for a card no stamped write has touched. */
  writeRev: number | null;
};

/** A hash over one session's source rows from `startSeq` through `endSeq`
 *  (both inclusive), as of when it was taken. `rowCount` is how many rows the
 *  span held and `sweepGen` the check sweep that recorded it. The store keeps
 *  the values opaque; one row per session and `startSeq`. */
export type RangeHash = {
  startSeq: number;
  endSeq: number;
  rowCount: number;
  hash: string;
  sweepGen: number;
};

/** One card {@link Store.staleCards} returns. */
export type StaleCard = { sessionId: string; timeUpdated: number };

/** The revision counters from {@link Store.cardCounters}, read in one
 *  statement so they describe the same moment. Counters read 0 when unset. */
export type CardCounters = {
  cardsRev: number;
  cardsStamped: number;
  cardsDeleted: number;
  vectorsRev: number;
};

/** Card counts and revision counters from {@link Store.cardStats}, read in one
 *  statement so they describe the same moment. Counters read 0 when unset. */
export type CardStats = CardCounters & {
  cards: number;
  fullCards: number;
  repairPending: number;
};

/** One card's persisted vector from {@link Store.cardVectorsPage}: the
 *  {@link Card.embedding} and {@link Card.embeddingGen} columns, plus the
 *  card's {@link Card.writeRev} so a reader can tell whether the row still
 *  belongs to the card version it holds. */
export type CardVectorRow = {
  sessionId: string;
  embedding: Uint8Array | null;
  embeddingGen: number | null;
  writeRev?: number;
};

/** The fields of a card that a family rollup is built from
 *  ({@link Store.rollupFieldsPage}, {@link Store.familyPage}). The stored
 *  rollup is read for a root only, a card whose `rootId` is its own id; any
 *  other card lists it empty. */
export type RollupFields = Pick<
  Card,
  | "sessionId"
  | "rootId"
  | "title"
  | "summaryHead"
  | "timeUpdated"
  | "distilledThrough"
  | "familyRollup"
>;

/** A page of {@link Store.familyPage}. `next` continues the walk and is
 *  absent from the last page. */
export type FamilyPage = { cards: RollupFields[]; next?: number };

/** The store file's page accounting from {@link Store.spaceStats}. Reclaimable
 *  bytes are `freelistCount * pageSize`. */
export type SpaceStats = { pageCount: number; freelistCount: number; pageSize: number };

/** Session metadata {@link Store.refreshCardMeta} writes. `timeArchived` is
 *  compared and written only when given. */
export type CardMetaRefresh = {
  title: string;
  directory: string;
  projectId: string;
  timeUpdated: number;
  timeArchived?: number | null;
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

/** A slim-index lookup. `strong` anchors (code tokens and phrases) are all
 *  required; without one, the lookup matches the `weak` anchors (plain words)
 *  as {@link Store.ftsSearch} describes, under `weakRowBudget` (default
 *  {@link WEAK_MATCH_ROWS}). `limit` caps the rows returned (default 200). */
export type FtsQuery = {
  strong: string[];
  weak: string[];
  limit?: number;
  weakRowBudget?: number;
};

/** One FTS match, carrying the drill-down targets captured during distillation. */
export type FtsHit = {
  sessionId: string;
  partId: string;
  messageId: string;
  prevMessageId: string | null;
  nextMessageId: string | null;
  class: string;
  /** The row's `bm25()` (lower is better), or `-Infinity` for a row holding
   *  every plain word of the query, which is listed first unscored. */
  score: number;
};

export type StoreOptions = {
  /** Injectable clock for lease TTL logic; defaults to `Date.now`. */
  now?: () => number;
  /** Open only a store already at the current schema: refuse
   *  (`needs-migration` / `needs-rebuild`) instead of migrating or rebuilding
   *  it, so the file is never written. For a caller that must keep existing
   *  cards intact (the v2 card-only fallback, which cannot rebuild them). */
  existingOnly?: boolean;
};

/** Why {@link openStore} refused a store; the caller degrades to cards-lite.
 *  Every refusal but `error` is non-writing: decided by reads alone, its
 *  transaction rolls back.
 *  - `newer`: the schema stamp is newer than this build understands.
 *  - `needs-migration` / `needs-rebuild` (only with `existingOnly`): the
 *    store is at an older schema, or has no valid schema stamp or layout,
 *    so opening it would migrate or rebuild it.
 *  - `host-mismatch`: another host lane owns the store (or its host stamp is
 *    missing or unknown).
 *  - `source-mismatch`: the store was distilled from a different history
 *    database.
 *  - `error`: the open, the schema check or a migration threw. The
 *    transaction's rollback undoes a partial migration, but unlike a fence
 *    refusal this is a failure path, not a decision made before any write. */
export type StoreRefusal =
  | "newer"
  | "host-mismatch"
  | "source-mismatch"
  | "needs-migration"
  | "needs-rebuild"
  | "error";

/** The refusals the fence decides; `error` is anything that threw instead. */
type FenceRefusal = Exclude<StoreRefusal, "error">;

export type OpenStoreResult =
  /** `warning` is set when the store opened but could not be switched to WAL
   *  (a performance setting, not a correctness one); the host may log it. */
  { ok: true; store: Store; warning?: string } | { ok: false; reason: StoreRefusal };

export type Store = {
  /**
   * Write one card row as given, outside the revision accounting: no
   * `cards_rev` is allocated, and `write_rev` and `repair_reason` keep their
   * stored values. On conflict the store-owned columns (the summary pair and
   * the family rollup) keep theirs too. The distiller writes through the
   * stamped methods instead.
   */
  upsertCard(card: Card): void;
  getCard(sessionId: string): Card | undefined;
  /** The card's {@link Card.writeRev} alone, from one indexed read;
   *  undefined when there is no card or no stamped write has touched it. */
  cardWriteRev(sessionId: string): number | undefined;
  allCards(opts?: { withEmbeddings?: boolean }): Card[];
  /**
   * Cards whose last stamped write is newer than revision `rev`, oldest
   * revision first, at most `limit` of them (a positive integer; anything else
   * reads as 1). Each revision stamps one card, so paging continues from the
   * last card's {@link Card.writeRev}. A write that stamped nothing (an older
   * build's, or a delete) is not listed; {@link cardCounters} exposes the
   * counters that reveal it.
   */
  cardsSince(rev: number, limit: number, opts?: { withEmbeddings?: boolean }): Card[];
  /**
   * Cards in session-id order whose id sorts after `after` (from the first
   * card when undefined), at most `limit` of them (a positive integer;
   * anything else reads as 1). Paging continues from the last card's id, so
   * a card written during a walk is never listed twice.
   */
  cardsPage(after: string | undefined, limit: number, opts?: { withEmbeddings?: boolean }): Card[];
  /**
   * Every card's persisted vector in session-id order after `after`, at most
   * `limit` rows, read as {@link cardsPage} pages. A card with no vector is
   * listed with `embedding: null`, so the caller can tell it from a card that
   * is gone.
   */
  cardVectorsPage(after: string | undefined, limit: number): CardVectorRow[];
  /**
   * The {@link RollupFields} of every card in session-id order after `after`,
   * at most `limit` of them, read as {@link cardsPage} pages.
   */
  rollupFieldsPage(after: string | undefined, limit: number): RollupFields[];
  /**
   * The {@link RollupFields} of the cards whose root is `rootId`, the root's
   * own card included, at most `limit` of them (a positive integer; anything
   * else reads as 1): from the start of the family when `after` is undefined,
   * otherwise from the previous page's `next`. The walk follows the
   * `card_root` index in the order the cards were inserted, so a page reads
   * only its own rows however large the family is. A card rewritten during a
   * walk keeps its place. A card deleted or first written during the walk may
   * or may not be listed, and one deleted and written again may be listed
   * twice, the newer listing last. `next` is a rowid, which `VACUUM` can
   * renumber, so a walk assumes no `VACUUM` runs during it (the store runs none).
   */
  familyPage(rootId: string, after: number | undefined, limit: number): FamilyPage;
  /**
   * The revision counters, from one statement over `meta` alone: a few key
   * lookups, whatever the size of the card table. What a reader polls to
   * learn whether cards changed.
   */
  cardCounters(): CardCounters;
  /**
   * How many cards carry a {@link Card.repairReason}. Counted through an index
   * over those cards alone, so it reads as many index entries as there are
   * such cards (every accepted open but an `existingOnly` one creates the
   * index when missing; without it the count reads every card instead).
   */
  repairPendingCount(): number;
  /**
   * Card counts plus the revision counters, from one statement. The counts
   * read every card, so no path polls this: {@link cardCounters} and
   * {@link repairPendingCount} serve those.
   */
  cardStats(): CardStats;
  /** The store file's page count, free-list pages and page size. Read-only. */
  spaceStats(): SpaceStats;
  /**
   * Cards a host at projector generation `gen` should rebuild: those below
   * `gen` (a NULL generation included) and, whatever their generation, those
   * whose checkpoint is `v: 1`. A host that passes `gen` writes later
   * checkpoint versions, so a `v: 1` checkpoint marks a card an older build
   * overwrote. Cards with a {@link Card.repairReason} are left out. Newest
   * first. Returns nothing when `gen` is undefined, so a host without
   * generations never sees stale cards.
   */
  staleCards(gen?: number): StaleCard[];
  /**
   * Record why a card could not be rebuilt, which takes it out of
   * {@link staleCards} until an accepted replace or {@link clearRepairReasons}
   * clears it. Allocates no revision: readers do not see the reason.
   * `changed` is false when the card is unknown or already has this reason.
   */
  markRepairPending(sessionId: string, reason: string): CardWrite;
  /** Clear every card's repair reason, returning how many were set. */
  clearRepairReasons(): number;
  /** A session's stored range hashes, by ascending `startSeq`. */
  getRangeHashes(sessionId: string): RangeHash[];
  /** Store range hashes for a session in one transaction, replacing any stored
   *  hash with the same `startSeq` and leaving the others. */
  putRangeHashes(sessionId: string, ranges: RangeHash[]): void;
  /** Delete a session's range hashes, returning how many there were. */
  clearRangeHashes(sessionId: string): number;
  /** How many slim-index rows a session has. */
  sessionRowCount(sessionId: string): number;
  /** The message id of a session's slim-index row at `offset` in insertion
   *  (oldest-first) order, or undefined past the last row. */
  sessionRowMessage(sessionId: string, offset: number): string | undefined;
  /** A session's slim-index rows in insertion (oldest-first) order, from
   *  `offset`, at most `limit` (a positive integer; anything else reads one). */
  sessionRows(sessionId: string, offset: number, limit: number): PartTextRow[];
  /** Every card's session id, without loading the cards. */
  cardSessionIds(): string[];
  /** How many cards the store holds. */
  cardCount(): number;
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
   * the re-distill clear). Stamps a revision. A no-op when the session id is
   * unknown or the card already holds this summary and hash.
   */
  writeSummary(sessionId: string, summary: string, hash: string): CardWrite;
  /**
   * Delete a session's card, slim-index rows, FTS entries and range hashes in
   * one transaction. When anything was removed it allocates a revision (no row
   * is left to stamp) and advances {@link CARDS_DELETED_KEY}.
   */
  deleteSession(sessionId: string): CardWrite;
  /**
   * Patch a card's session metadata in place (title, directory, project and
   * the archive time, null for a session that is not archived) with a
   * revision, without touching its content. Title and directory feed the
   * embedded text, so a change to either drops the vector. `changed` is
   * false, and nothing is written, when no card exists or no value differs.
   * Used by a host's metadata signals (renames, moves, archiving).
   */
  patchCardMeta(
    sessionId: string,
    patch: { title?: string; directory?: string; projectId?: string; timeArchived?: number | null },
  ): CardWrite;
  /**
   * Refresh a card's session metadata after an append that found no new
   * messages. When the title, directory, project, `timeUpdated` or a given
   * `timeArchived` differs, it writes them with a revision and drops the
   * vector if the title or directory changed. Either way it stores
   * `distillCursor` as the card's checkpoint and drops its settled base. A
   * no-op for an unknown session.
   */
  refreshCardMeta(
    sessionId: string,
    meta: CardMetaRefresh,
    distillCursor: string | null,
  ): CardWrite;
  /**
   * Replace a session's family rollup with a revision, keeping every other
   * column, the vector included. `changed` is false, and nothing is written,
   * when the card is unknown or its rollup is already this one.
   */
  setFamilyRollup(sessionId: string, rollup: FamilyRollup[]): CardWrite;
  /**
   * Replace a session's slim-index rows and card in one transaction.
   *
   * Refused (`refused: "older-generation"`, nothing written) when the card's
   * {@link Card.projectorGen} is below the stored one. A card that names no
   * projector generation skips this check, and the write stores NULL over the
   * stored generation, suppressed or not. {@link appendSessionParts} differs:
   * it keeps the stored generation unless its recomputed card names one.
   *
   * When the stored card and rows already match the new ones, the write is
   * suppressed: only the checkpoint ({@link Card.distillCursor}), the
   * projector generation and the settled base are written, no revision is
   * allocated and the stored vector is kept. The comparison covers every
   * column a card write stores except the vector pair, the checkpoint, the
   * generation and the settled base, and every field of every row in order.
   * Otherwise the card is rewritten with a revision, and the rows are made
   * to equal `rows` by writing only the rows that differ: a stored row of
   * the same part, in order, is kept and overwritten only when a field
   * differs, every other stored row is deleted, and the rest of `rows` is
   * inserted, the FTS index kept in step for exactly those rows. Rows that
   * did not change keep their rowids and index entries; a row added before
   * a stored row that stays, or a part that moves, rewrites every row after
   * it. Any accepted replace, suppressed or not, clears the card's
   * {@link Card.repairReason}. `opts.rangeHashes` are stored in the same
   * transaction (see {@link putRangeHashes}), suppressed or not; with
   * `opts.replaceRangeHashes` they replace every hash stored for the session
   * instead. A refused or failed replace leaves the stored rows, index
   * entries, card and hashes as they were.
   *
   * With `opts.stored`, the rows the caller read before the call, the
   * transaction compares against those and reads only the session's rowids
   * (and, for the rows it deletes or overwrites the text of, their indexed
   * text). It is refused with `base-changed`, writing nothing, unless the
   * card is still stored at the revision `opts.stored.writeRev` and the
   * session still holds that many rows: a stamped write changed them since.
   */
  replaceSessionParts(
    sessionId: string,
    rows: PartTextRow[],
    card: Card,
    opts?: { rangeHashes?: RangeHash[]; replaceRangeHashes?: boolean; stored?: StoredRows },
  ): SessionWrite;
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
   *
   * The recomputed card keeps the stored projector generation unless it names
   * one, and is refused like a replace when it names a lower one (the whole
   * append rolls back). When no row was added, evicted or repointed and the
   * recomputed card matches the stored one (compared as in
   * {@link replaceSessionParts}), only the checkpoint, generation and settled
   * base are written, with no revision. A repair reason is kept: an append
   * does not rebuild the card. `opts` stores range hashes as
   * {@link replaceSessionParts} does, and like it keeps the stored ones when
   * the append is refused or fails.
   *
   * With `opts.stored`, the rows the caller read before the call, the
   * transaction lays the rows out from those ({@link appendedRows}) and
   * `recompute` receives that layout's rows, which the caller can build the
   * card from beforehand. The transaction reads the session's rowids and the
   * indexed text of the rows it evicts, and no other stored row. It is
   * refused with `base-changed`, writing nothing, unless the card is still
   * stored at the revision `opts.stored.writeRev` and the session still
   * holds that many rows.
   */
  appendSessionParts(
    sessionId: string,
    rows: PartTextRow[],
    ftsRowsPerSession: number,
    boundary: AppendBoundary,
    recompute: (allRows: PartTextRow[]) => Card,
    opts?: { rangeHashes?: RangeHash[]; replaceRangeHashes?: boolean; stored?: StoredRows },
  ): SessionWrite;
  /**
   * Replace the tail of a card distilled against a running tail, keeping its
   * settled base, in one transaction. The session's oldest `tail.base.rows`
   * slim-index rows are the base's: the oldest `tail.evict` of them are
   * evicted (the row cap), the rest are kept, and the rows after them (the
   * previous tail's) are made to equal `tail.rows`, writing only the rows
   * that differ as {@link replaceSessionParts} does. The rows of the base's
   * newest message ({@link SettledBase.messageId}) are repointed at
   * `tail.firstMessageId`, as an append of the same messages would store
   * them. `card` is the card the caller built from the
   * rows it read ({@link sessionRows}) with those changes, so the
   * transaction reads only the rows it replaces.
   *
   * Refused with `base-changed`, writing nothing, unless the card still holds
   * exactly `tail.base`, at least its rows and the revision `tail.writeRev`
   * the caller read them at: another write changed the card since. Refused
   * with `older-generation` like {@link appendSessionParts}, whose
   * generation, suppression (no row evicted, replaced or repointed and an
   * unchanged card write only the checkpoint, generation and settled base,
   * with no revision), repair reason and range hash rules it follows.
   */
  replaceSessionTail(
    sessionId: string,
    tail: SessionTail,
    card: Card,
    opts?: { rangeHashes?: RangeHash[]; replaceRangeHashes?: boolean },
  ): SessionWrite;
  /**
   * Look slim-index rows up. With a strong anchor, every strong anchor is
   * required, the weak ones are ignored and rows come best `bm25()` first.
   *
   * Without one, the weak anchors (plain words) are looked up in two steps.
   * When there are two or more and between one and budget-1 rows hold them
   * all, those rows come first, newest first and unscored. The rest of
   * `limit` comes from the anchors {@link boundWeakAnchors} keeps under the
   * budget, ORed and best `bm25()` first, skipping rows already listed. The
   * anchors it leaves out stay in that match as ranking-only terms, which add
   * to `bm25()` without widening the rows matched, while each is in fewer
   * than five times the budget's rows. When it keeps none, the first step is
   * the whole lookup.
   */
  ftsSearch(input: FtsQuery): FtsHit[];
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
  "distill_cursor",
  "projector_gen",
  "time_archived",
  "settled_base",
] as const;

type CardColumn = (typeof CARD_COLUMNS)[number];

// Columns a card write must NEVER overwrite: each is owned by its own write
// path ({@link Store.writeSummary} for the summary pair,
// {@link Store.setFamilyRollup} for the rollup) and would otherwise be wiped on
// every re-distill, which has neither to supply. A new-card insert takes the
// card's values; on conflict they are simply left out of the UPDATE SET.
const STORE_OWNED_COLUMNS = new Set<CardColumn>(["nl_summary", "summary_hash", "family_rollup"]);

// Columns a content write stores but does not compare when deciding whether
// anything changed: the vector pair (a suppressed write keeps the stored
// vector), and the checkpoint, projector generation and settled base, which
// are written either way and which readers do not see.
const UNCOMPARED_COLUMNS = new Set<CardColumn>([
  "embedding",
  "embedding_gen",
  "distill_cursor",
  "projector_gen",
  "settled_base",
]);

/** Columns read into a {@link Card} beyond those a card write supplies; only
 *  the store writes them. */
const CARD_STORE_COLUMNS = ["write_rev", "repair_reason"] as const;

const CARD_READ_COLUMNS = [...CARD_COLUMNS, ...CARD_STORE_COLUMNS];
const CARD_COLUMNS_ALL = CARD_READ_COLUMNS.join(", ");
const CARD_COLUMNS_NO_EMBEDDING = CARD_READ_COLUMNS.filter((c) => c !== "embedding").join(", ");
/** The columns of {@link RollupFields}, the stored rollup for roots only. */
const ROLLUP_FIELD_COLUMNS =
  "session_id, root_id, title, summary_head, time_updated, distilled_through, " +
  "CASE WHEN root_id = session_id THEN family_rollup END AS family_rollup";
const CARD_PLACEHOLDERS = CARD_COLUMNS.map(() => "?").join(", ");
const CARD_UPSERT_SET = CARD_COLUMNS.filter(
  (c) => c !== "session_id" && !STORE_OWNED_COLUMNS.has(c),
)
  .map((c) => `${c}=excluded.${c}`)
  .join(", ");
const CARD_UPSERT_SQL = `INSERT INTO card(${CARD_COLUMNS.join(", ")}) VALUES(${CARD_PLACEHOLDERS}) ON CONFLICT(session_id) DO UPDATE SET ${CARD_UPSERT_SET}`;
// A stamped content write also records its revision.
const CARD_STAMPED_UPSERT_SQL = `INSERT INTO card(${CARD_COLUMNS.join(", ")}, write_rev) VALUES(${CARD_PLACEHOLDERS}, ?) ON CONFLICT(session_id) DO UPDATE SET ${CARD_UPSERT_SET}, write_rev=excluded.write_rev`;

const CARD_COMPARED_COLUMNS = CARD_COLUMNS.filter(
  (c) => c !== "session_id" && !STORE_OWNED_COLUMNS.has(c) && !UNCOMPARED_COLUMNS.has(c),
);
/** Position of each compared column in {@link cardValues}' output. */
const CARD_COMPARED_INDEXES = CARD_COMPARED_COLUMNS.map((c) => CARD_COLUMNS.indexOf(c));
/** What a content write reads first: the stored generation (for the guard),
 *  the settled base and revision (for a tail write's check) and every
 *  compared column. */
const CARD_COMPARE_SQL = `SELECT projector_gen, settled_base, write_rev, ${CARD_COMPARED_COLUMNS.join(", ")} FROM card WHERE session_id=?`;

const PART_ROW_COLUMNS =
  "part_id, message_id, prev_message_id, next_message_id, class, time_created, raw, norm";

// ── Value coercion (defensive against unexpected column shapes) ──────────────

function asString(value: SqlValue | undefined, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: SqlValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/** An {@link FtsHit} from a slim-index lookup row. */
function ftsHitOf(row: Row, score: number): FtsHit {
  return {
    sessionId: asString(row.session_id),
    partId: asString(row.part_id),
    messageId: asString(row.message_id),
    prevMessageId: asNullableString(row.prev_message_id),
    nextMessageId: asNullableString(row.next_message_id),
    class: asString(row.class),
    score,
  };
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

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** A stored `settled_base` value, or undefined for NULL or anything that is
 *  not a whole {@link SettledBase} (the card is then re-read in full). */
function parseSettledBase(value: SqlValue | undefined): SettledBase | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const b = parsed as Record<string, unknown>;
  if (
    typeof b.seq !== "number" ||
    !Number.isFinite(b.seq) ||
    !(b.messageId === null || typeof b.messageId === "string") ||
    !isCount(b.rows) ||
    !isCount(b.partCount) ||
    typeof b.summaryHead !== "string" ||
    typeof b.outcomeHead !== "string" ||
    !isStringArray(b.files) ||
    !isStringArray(b.tools) ||
    !isStringArray(b.errors) ||
    !isCount(b.cut)
  ) {
    return undefined;
  }
  return {
    seq: b.seq,
    messageId: b.messageId,
    rows: b.rows,
    partCount: b.partCount,
    summaryHead: b.summaryHead,
    outcomeHead: b.outcomeHead,
    files: b.files,
    tools: b.tools,
    errors: b.errors,
    cut: b.cut,
  };
}

/** The stored form of a settled base: its fields in one fixed order, so the
 *  same base always serializes to the same string (a tail write compares the
 *  stored string with the base it merged with). */
function serializeSettledBase(base: SettledBase): string {
  return JSON.stringify({
    seq: base.seq,
    messageId: base.messageId,
    rows: base.rows,
    partCount: base.partCount,
    summaryHead: base.summaryHead,
    outcomeHead: base.outcomeHead,
    files: base.files,
    tools: base.tools,
    errors: base.errors,
    cut: base.cut,
  });
}

function rowToRollupFields(row: Row): RollupFields {
  return {
    sessionId: asString(row.session_id),
    rootId: asString(row.root_id),
    title: asString(row.title),
    summaryHead: asString(row.summary_head),
    timeUpdated: asNumber(row.time_updated),
    distilledThrough: asNullableString(row.distilled_through),
    familyRollup: parseRollup(row.family_rollup),
  };
}

function rowToCard(row: Row): Card {
  const projectorGen = asNullableNumber(row.projector_gen);
  const timeArchived = asNullableNumber(row.time_archived);
  const writeRev = asNullableNumber(row.write_rev);
  const settledBase = parseSettledBase(row.settled_base);
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
    // Omitted when NULL, so a v1 card reads back exactly as it was written.
    ...(typeof row.distill_cursor === "string" && { distillCursor: row.distill_cursor }),
    ...(projectorGen !== null && { projectorGen }),
    ...(timeArchived !== null && { timeArchived }),
    ...(writeRev !== null && { writeRev }),
    ...(typeof row.repair_reason === "string" && { repairReason: row.repair_reason }),
    ...(settledBase !== undefined && { settledBase }),
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
    card.distillCursor ?? null,
    card.projectorGen ?? null,
    card.timeArchived ?? null,
    card.settledBase ? serializeSettledBase(card.settledBase) : null,
  ];
}

/** One stored column value against what a write would bind, reading a bigint
 *  as a number and an absent value as NULL. */
function sameSqlValue(stored: SqlValue | undefined, next: SqlValue): boolean {
  const a = typeof stored === "bigint" ? Number(stored) : (stored ?? null);
  const b = typeof next === "bigint" ? Number(next) : next;
  return a === b;
}

/** Whether a stored card row (read with {@link CARD_COMPARE_SQL}) already holds
 *  every compared column of `card`. */
function sameCard(stored: Row, card: Card): boolean {
  const values = cardValues(card);
  return CARD_COMPARED_COLUMNS.every((column, i) =>
    sameSqlValue(stored[column], values[CARD_COMPARED_INDEXES[i]!]!),
  );
}

/** Whether stored slim-index rows (in id order) equal `rows`, field by field
 *  and in order. */
function sameRows(stored: Row[], rows: PartTextRow[]): boolean {
  if (stored.length !== rows.length) return false;
  return rows.every((row, i) => sameRow(stored[i]!, row));
}

/** Whether a stored slim-index row (read with {@link PART_ROW_COLUMNS})
 *  holds every field of `row`. */
function sameRow(old: Row, row: PartTextRow): boolean {
  return (
    sameSqlValue(old.part_id, row.partId) &&
    sameSqlValue(old.message_id, row.messageId) &&
    sameSqlValue(old.prev_message_id, row.prevMessageId ?? null) &&
    sameSqlValue(old.next_message_id, row.nextMessageId ?? null) &&
    sameSqlValue(old.class, row.class) &&
    sameSqlValue(old.time_created, row.timeCreated) &&
    sameIndexedText(old, row)
  );
}

/** Whether a stored slim-index row holds the text of `row` that the FTS
 *  index holds. */
function sameIndexedText(old: Row, row: PartTextRow): boolean {
  return sameSqlValue(old.raw, row.raw) && sameSqlValue(old.norm, row.norm);
}

/** A slim-index row a caller read ({@link Store.sessionRows}) as a stored
 *  row with rowid `id`. */
function storedRow(id: SqlValue | undefined, row: PartTextRow): Row {
  return {
    id: id ?? null,
    part_id: row.partId,
    message_id: row.messageId,
    prev_message_id: row.prevMessageId ?? null,
    next_message_id: row.nextMessageId ?? null,
    class: row.class,
    time_created: row.timeCreated,
    raw: row.raw,
    norm: row.norm,
  };
}

/** The writes {@link planRowDiff} plans. */
type RowDiff = {
  /** Rowids of the stored rows to delete. */
  removed: number[];
  /** Stored rows to overwrite in place with the new row of the same part,
   *  and whether its indexed text differs. */
  updated: Array<{ id: number; row: PartTextRow; text: boolean }>;
  /** New rows to insert after every stored row left, oldest first. */
  added: PartTextRow[];
};

/**
 * The writes that make a session's stored rows (`stored`, with their rowids,
 * in rowid order) hold exactly `rows` in order. Rows are read back in rowid
 * order and an inserted row's rowid is above every stored one, so a stored
 * row keeps its place only while the rows of `rows` match stored rows of the
 * same part in rowid order. Each of those is overwritten when a field
 * differs and left alone otherwise. From the first row of `rows` with no
 * such match, every row is inserted, and every stored row left unmatched is
 * deleted. Evicting the oldest rows, changing rows in place, removing rows
 * and appending rows touch only those rows; a row added before a stored row
 * that stays, or a part that moves, rewrites every row after it.
 */
function planRowDiff(stored: Row[], rows: PartTextRow[]): RowDiff {
  const at = new Map<string, number>();
  stored.forEach((row, i) => at.set(asString(row.part_id), i));
  const kept = new Set<number>();
  const updated: RowDiff["updated"] = [];
  let last = -1;
  let next = 0;
  for (; next < rows.length; next++) {
    const row = rows[next]!;
    const i = at.get(row.partId);
    if (i === undefined || i <= last) break;
    last = i;
    kept.add(i);
    const old = stored[i]!;
    if (!sameRow(old, row)) {
      updated.push({ id: asNumber(old.id), row, text: !sameIndexedText(old, row) });
    }
  }
  return {
    removed: stored.filter((_, i) => !kept.has(i)).map((row) => asNumber(row.id)),
    updated,
    added: rows.slice(next),
  };
}

/** Whether applying `next` would change any of a card's stored metadata. */
function metaDiffers(stored: StoredCardMeta, next: StoredCardMeta): boolean {
  return (
    next.title !== stored.title ||
    next.directory !== stored.directory ||
    next.projectId !== stored.projectId ||
    next.timeUpdated !== stored.timeUpdated ||
    next.timeArchived !== stored.timeArchived
  );
}

/** A stored slim-index row (read with {@link PART_ROW_COLUMNS}). */
function rowToPart(row: Row): PartTextRow {
  return {
    partId: asString(row.part_id),
    messageId: asString(row.message_id),
    prevMessageId: asNullableString(row.prev_message_id),
    nextMessageId: asNullableString(row.next_message_id),
    class: asString(row.class),
    timeCreated: asNumber(row.time_created),
    raw: asString(row.raw),
    norm: asString(row.norm),
  };
}

/** Whether a write at projector generation `next` must be refused because the
 *  stored card is at a higher one. No generation on either side never refuses. */
function belowStoredGen(next: number | null | undefined, stored: SqlValue | undefined): boolean {
  const storedGen = asNullableNumber(stored);
  return next != null && storedGen !== null && next < storedGen;
}

function rowToRangeHash(row: Row): RangeHash {
  return {
    startSeq: asNumber(row.start_seq),
    endSeq: asNumber(row.end_seq),
    rowCount: asNumber(row.row_count),
    hash: asString(row.hash),
    sweepGen: asNumber(row.sweep_gen),
  };
}

/** A page size from a caller's limit: a positive integer, else 1. */
function pageLimit(limit: number): number {
  return Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
}

/** A count from a SQL value or a meta counter string; 0 when absent. */
function asCount(value: SqlValue | undefined): number {
  if (typeof value === "string") return Number(value) || 0;
  return asNumber(value);
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

/**
 * The weak anchors a plain-word lookup ORs, distinct and in their given
 * order: the rarest first, as long as the rows they match add up to at most
 * `budget`, and none that matches `budget` rows or more. `rowsOf` counts the
 * rows an anchor matches, stopping at `budget`; a repeated anchor is counted
 * once. The OR is there to find sessions holding the query's distinctive
 * words, and a word that common is not one: it would make the OR match most
 * of the index. When every anchor is that common, none is kept. On an index
 * where the anchors' rows fit the budget together, all are kept.
 */
export function boundWeakAnchors(
  anchors: readonly string[],
  rowsOf: (anchor: string) => number,
  budget: number,
): string[] {
  const counted = [...new Set(anchors)].map((anchor, index) => ({
    anchor,
    index,
    rows: rowsOf(anchor),
  }));
  const rarestFirst = [...counted].sort((a, b) => a.rows - b.rows || a.index - b.index);
  const kept = new Set<number>();
  let total = 0;
  for (const { index, rows } of rarestFirst) {
    if (rows >= budget || total + rows > budget) break;
    kept.add(index);
    total += rows;
  }
  return counted.filter(({ index }) => kept.has(index)).map(({ anchor }) => anchor);
}

/**
 * A MATCH over `phrases` (quoted) that matches the rows of the `kept` ones
 * ORed and ranks with `ranking` too: `(kept OR …) AND (kept OR … OR ranking
 * OR …)` matches exactly the kept rows, and `bm25()` scores every phrase in
 * it, so a row holding a ranking phrase as well outranks one holding only a
 * kept phrase. The kept phrases appear twice and weigh twice. Without
 * ranking phrases it is the plain OR.
 */
function rankedMatch(
  phrases: readonly string[],
  kept: readonly string[],
  ranking: readonly string[],
): string {
  const keptOr = kept.join(" OR ");
  if (ranking.length === 0) return keptOr;
  const all = phrases.filter((phrase) => kept.includes(phrase) || ranking.includes(phrase));
  return `(${keptOr}) AND (${all.join(" OR ")})`;
}

// ── Schema management ────────────────────────────────────────────────────────

function hasMetaTable(db: SqliteDb): boolean {
  return (
    db.get("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='meta'") !==
    undefined
  );
}

function readSchemaVersion(db: SqliteDb): number | null {
  if (!hasMetaTable(db)) return null;
  const value = readMetaValue(db, SCHEMA_VERSION_KEY);
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** One `meta` value over the raw connection (the table must exist). */
function readMetaValue(db: SqliteDb, key: string): string | undefined {
  const row = db.get("SELECT value FROM meta WHERE key=?", [key]);
  return row && typeof row.value === "string" ? row.value : undefined;
}

/** Upsert one `meta` value over the raw connection. */
function writeMetaValue(db: SqliteDb, key: string, value: string): void {
  db.run(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [key, value],
  );
}

/** Stamp the owning host and, when given, the source identity. Shared by
 *  {@link rebuild} and {@link migrateV3ToV4}. */
function stampIdentity(db: SqliteDb, host: StoreHost, source: string | undefined): void {
  writeMetaValue(db, STORE_HOST_KEY, host);
  if (source !== undefined) writeMetaValue(db, SOURCE_DB_KEY, source);
}

function rebuild(db: SqliteDb, host: StoreHost, source: string | undefined): void {
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
  stampIdentity(db, host, source);
}

/** Stamp the schema-version meta row to `version` (upsert). Shared by the
 *  additive migrations so each records the version it actually reached. */
function stampVersion(db: SqliteDb, version: number): void {
  writeMetaValue(db, SCHEMA_VERSION_KEY, String(version));
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
 * Additive v3 -> v4 upgrade: add the nullable `card.distill_cursor` column (the
 * v2 host's per-session checkpoint; existing rows read NULL) and stamp the host
 * fence. Every pre-fence store was written by the v1 host, so the stamp is
 * {@link LEGACY_HOST}; {@link openStore} only reaches this step for a v1-host
 * opener, having refused any other host before migrating. Stamps the literal
 * destination version 4, like {@link migrateV2ToV3}.
 */
function migrateV3ToV4(db: SqliteDb): void {
  db.exec("ALTER TABLE card ADD COLUMN distill_cursor TEXT");
  stampIdentity(db, LEGACY_HOST, undefined);
  stampVersion(db, 4);
}

/**
 * Additive v4 -> v5 upgrade: add the nullable `card.projector_gen`,
 * `card.write_rev` (with its index), `card.repair_reason`, `card.settled_base`
 * and `card.time_archived` columns, and the `range_hash` table. Existing rows
 * read NULL in each: no generation (so a host that stamps one sees them as
 * stale), no stamped revision, no repair reason, no settled base. The host
 * stamp is already present on every v4 store, so identity is untouched. Stamps
 * the literal destination version 5, like {@link migrateV2ToV3}.
 */
function migrateV4ToV5(db: SqliteDb): void {
  db.exec("ALTER TABLE card ADD COLUMN projector_gen INTEGER");
  db.exec("ALTER TABLE card ADD COLUMN write_rev INTEGER");
  db.exec("ALTER TABLE card ADD COLUMN repair_reason TEXT");
  db.exec("ALTER TABLE card ADD COLUMN settled_base TEXT");
  db.exec("ALTER TABLE card ADD COLUMN time_archived INTEGER");
  db.exec(WRITE_REV_INDEX_DDL);
  db.exec(RANGE_HASH_DDL);
  stampVersion(db, 5);
}

/** A store at schema 1-3, written before the host fence existed: all of them
 *  belong to the v1 host. */
function isPreFence(version: number | null): boolean {
  return version === 1 || version === 2 || version === 3;
}

/** A store at an older schema that upgrades additively in place. */
function isMigratable(version: number | null): boolean {
  return isPreFence(version) || version === 4;
}

/** The identity stamps, if the file has a `meta` table at all. */
function readStampedIdentity(db: SqliteDb): { host?: string; source?: string } {
  if (!hasMetaTable(db)) return {};
  return {
    host: readMetaValue(db, STORE_HOST_KEY),
    source: readMetaValue(db, SOURCE_DB_KEY),
  };
}

/**
 * The host and source a store file is stamped with, read without migrating,
 * rebuilding or writing anything (a missing `meta` table reads as no stamp).
 * Lets an opener learn which exact source string {@link openStore} would
 * accept before it opens the store. Never throws: an unreadable file reads
 * as no stamp.
 */
export function peekStoreIdentity(db: SqliteDb): { host?: string; source?: string } {
  try {
    return readStampedIdentity(db);
  } catch {
    return {};
  }
}

/**
 * The host fence for a store at a known schema version. A pre-fence store
 * (schema 1-3) implies {@link LEGACY_HOST}; a v4 or later store must carry an
 * exact host stamp (a missing or unknown one is refused, never guessed). Source
 * identity must match exactly, absent on both sides for the v1 host.
 */
function checkIdentity(
  db: SqliteDb,
  preFence: boolean,
  host: StoreHost,
  source: string | undefined,
): FenceRefusal | null {
  const stampedHost = preFence ? LEGACY_HOST : readMetaValue(db, STORE_HOST_KEY);
  if (stampedHost !== host) return "host-mismatch";
  if (readMetaValue(db, SOURCE_DB_KEY) !== source) return "source-mismatch";
  return null;
}

/**
 * Open a {@link Store} for `identity` over an already-open {@link SqliteDb}. Sets
 * the busy timeout, checks the fence and migrates or rebuilds under one
 * transaction, and only then switches an accepted store to WAL. A failed WAL
 * switch does not fail the open: the transaction has already committed, and
 * journal mode and sync level are performance settings, so the store is
 * returned with a `warning` instead.
 *
 * Refuses without writing (no migration, no rebuild, no write) when
 * another host owns the store, when the store was distilled from a different
 * `identity.source`, or when the schema stamp is newer than this build. A host
 * stamp is checked first, before the schema stamp is even read, so a store
 * stamped for another host is refused whatever its schema state; a pre-fence
 * (schema 1-3) store without a stamp implies the v1 host, so a v2-host opener
 * never upgrades a v1 store. Any
 * unexpected failure is refused as `error`. Refusals never rebuild: rebuilding
 * would make two hosts sharing one file wipe each other on every start. An
 * absent stamp or a foreign layout is still dropped and rebuilt for `host`.
 */
export function openStore(
  db: SqliteDb,
  identity: StoreIdentity,
  opts?: StoreOptions,
): OpenStoreResult {
  const now = opts?.now ?? Date.now;
  const host = identity.host;
  const source = identity.host === "opencode-v2" ? identity.source : undefined;
  try {
    db.exec(PRE_FENCE_PRAGMAS);
    db.tx((): void => {
      // A refusal throws so the transaction rolls back rather than commits:
      // the refusal path is non-writing by construction, not by care.
      const refusal = fenceRefusal(db, host, source);
      if (refusal) throw new StoreRefused(refusal);
      const current = readSchemaVersion(db);
      const migratable = isMigratable(current);
      if (opts?.existingOnly && current !== SCHEMA_VERSION) {
        throw new StoreRefused(migratable ? "needs-migration" : "needs-rebuild");
      }
      if (current === SCHEMA_VERSION || migratable) {
        // v1 to v4 upgrade additively in place, keeping all data, each
        // chaining through every later step.
        if (current === 1) migrateV1ToV2(db);
        if (current === 1 || current === 2) migrateV2ToV3(db);
        if (isPreFence(current)) migrateV3ToV4(db);
        if (migratable) migrateV4ToV5(db);
      } else {
        // Anything else older (absent stamp or a foreign layout) is dropped
        // and rebuilt fresh for this host.
        rebuild(db, host, source);
      }
      // A caller that must not write keeps counting without it.
      if (!opts?.existingOnly) db.exec(REPAIR_PENDING_INDEX_DDL);
    });
    let warning: string | undefined;
    try {
      db.exec(ACCEPTED_PRAGMAS);
    } catch (error) {
      warning = `could not enable WAL: ${error instanceof Error ? error.message : String(error)}`;
    }
    const store = new SqliteStore(db, now);
    return warning === undefined ? { ok: true, store } : { ok: true, store, warning };
  } catch (error) {
    return { ok: false, reason: error instanceof StoreRefused ? error.reason : "error" };
  }
}

/** A deliberate refusal, thrown inside the fence transaction to roll it back. */
class StoreRefused extends Error {
  constructor(readonly reason: FenceRefusal) {
    super(`store refused: ${reason}`);
  }
}

/** Thrown inside an append's transaction to roll it back when the recomputed
 *  card is below the stored projector generation. */
class OlderGenerationRefused extends Error {
  constructor() {
    super("card write refused: older projector generation");
  }
}

/** The session metadata columns {@link SqliteStore} patches and refreshes. */
type StoredCardMeta = {
  title: string;
  directory: string;
  projectId: string;
  timeUpdated: number;
  timeArchived: number | null;
};

/**
 * Every refusal {@link openStore} makes, in order, or null to proceed. Reads
 * only. Stamp first: a store that names another owner is refused before its
 * schema stamp is read, so no schema state (missing, unparseable, or
 * pre-fence) can lead to rebuilding or migrating another host's file.
 */
function fenceRefusal(
  db: SqliteDb,
  host: StoreHost,
  source: string | undefined,
): FenceRefusal | null {
  const stamped = readStampedIdentity(db);
  if (stamped.host !== undefined) {
    if (stamped.host !== host) return "host-mismatch";
    if (stamped.source !== source) return "source-mismatch";
  }
  const current = readSchemaVersion(db);
  // Newer than this build understands: refuse (degrade), never misread it.
  if (current !== null && current > SCHEMA_VERSION) return "newer";
  // Past the stamped block, this still catches what it cannot: a v4 or v5
  // store with no host stamp, and a hand-stamped pre-fence store whose stamp
  // claims a host other than the v1 host its schema implies.
  if (current === SCHEMA_VERSION || isMigratable(current)) {
    return checkIdentity(db, isPreFence(current), host, source);
  }
  return null;
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

  cardWriteRev(sessionId: string): number | undefined {
    const row = this.db.get("SELECT write_rev FROM card WHERE session_id=?", [sessionId]);
    return asNullableNumber(row?.write_rev) ?? undefined;
  }

  allCards(opts?: { withEmbeddings?: boolean }): Card[] {
    const columns = opts?.withEmbeddings === true ? CARD_COLUMNS_ALL : CARD_COLUMNS_NO_EMBEDDING;
    const rows = this.db.all(`SELECT ${columns} FROM card ORDER BY time_updated DESC`);
    return rows.map(rowToCard);
  }

  cardCount(): number {
    const row = this.db.get("SELECT count(*) AS n FROM card");
    return row && typeof row.n === "number" ? row.n : Number(row?.n ?? 0);
  }

  sessionRowCount(sessionId: string): number {
    return asCount(
      this.db.get("SELECT count(*) AS n FROM part_text WHERE session_id=?", [sessionId])?.n,
    );
  }

  sessionRows(sessionId: string, offset: number, limit: number): PartTextRow[] {
    const from = Number.isInteger(offset) && offset > 0 ? offset : 0;
    const take = Number.isInteger(limit) && limit >= 1 ? limit : 1;
    return this.db
      .all(
        `SELECT ${PART_ROW_COLUMNS} FROM part_text WHERE session_id=? ORDER BY id LIMIT ? OFFSET ?`,
        [sessionId, take, from],
      )
      .map(rowToPart);
  }

  sessionRowMessage(sessionId: string, offset: number): string | undefined {
    if (!Number.isInteger(offset) || offset < 0) return undefined;
    const row = this.db.get(
      "SELECT message_id FROM part_text WHERE session_id=? ORDER BY id LIMIT 1 OFFSET ?",
      [sessionId, offset],
    );
    return typeof row?.message_id === "string" ? row.message_id : undefined;
  }

  cardSessionIds(): string[] {
    return this.db
      .all("SELECT session_id FROM card")
      .map((row) => row.session_id)
      .filter((id): id is string => typeof id === "string");
  }

  cardsSince(rev: number, limit: number, opts?: { withEmbeddings?: boolean }): Card[] {
    const columns = opts?.withEmbeddings === true ? CARD_COLUMNS_ALL : CARD_COLUMNS_NO_EMBEDDING;
    const after = Number.isFinite(rev) ? rev : 0;
    const rows = this.db.all(
      `SELECT ${columns} FROM card WHERE write_rev > ? ORDER BY write_rev, session_id LIMIT ?`,
      [after, pageLimit(limit)],
    );
    return rows.map(rowToCard);
  }

  /** `columns` of the cards whose id sorts after `after` (every card when
   *  undefined), in id order, at most `limit` rows. */
  private keysetPage(columns: string, after: string | undefined, limit: number): Row[] {
    return after === undefined
      ? this.db.all(`SELECT ${columns} FROM card ORDER BY session_id LIMIT ?`, [pageLimit(limit)])
      : this.db.all(
          `SELECT ${columns} FROM card WHERE session_id > ? ORDER BY session_id LIMIT ?`,
          [after, pageLimit(limit)],
        );
  }

  cardsPage(after: string | undefined, limit: number, opts?: { withEmbeddings?: boolean }): Card[] {
    const columns = opts?.withEmbeddings === true ? CARD_COLUMNS_ALL : CARD_COLUMNS_NO_EMBEDDING;
    return this.keysetPage(columns, after, limit).map(rowToCard);
  }

  cardVectorsPage(after: string | undefined, limit: number): CardVectorRow[] {
    const rows = this.keysetPage("session_id, embedding, embedding_gen, write_rev", after, limit);
    return rows.map((row) => {
      const writeRev = asNullableNumber(row.write_rev);
      return {
        sessionId: asString(row.session_id),
        embedding: row.embedding instanceof Uint8Array ? row.embedding : null,
        embeddingGen: asNullableNumber(row.embedding_gen),
        ...(writeRev !== null && { writeRev }),
      };
    });
  }

  rollupFieldsPage(after: string | undefined, limit: number): RollupFields[] {
    return this.keysetPage(ROLLUP_FIELD_COLUMNS, after, limit).map(rowToRollupFields);
  }

  familyPage(rootId: string, after: number | undefined, limit: number): FamilyPage {
    const take = pageLimit(limit);
    // The rowid is the last key of every index, so `root_id=? AND rowid>?`
    // is one range of card_root, already in rowid order; paging by session
    // id instead would sort the whole family for every page.
    const rows =
      after === undefined
        ? this.db.all(
            `SELECT rowid AS row_key, ${ROLLUP_FIELD_COLUMNS} FROM card WHERE root_id=? ORDER BY rowid LIMIT ?`,
            [rootId, take],
          )
        : this.db.all(
            `SELECT rowid AS row_key, ${ROLLUP_FIELD_COLUMNS} FROM card WHERE root_id=? AND rowid>? ORDER BY rowid LIMIT ?`,
            [rootId, after, take],
          );
    const cards = rows.map(rowToRollupFields);
    const next = rows.length === take ? asNullableNumber(rows[rows.length - 1]!.row_key) : null;
    return next === null ? { cards } : { cards, next };
  }

  cardCounters(): CardCounters {
    const row = this.db.get(
      `SELECT (SELECT value FROM meta WHERE key=?) AS cards_rev,
              (SELECT value FROM meta WHERE key=?) AS cards_stamped,
              (SELECT value FROM meta WHERE key=?) AS cards_deleted,
              (SELECT value FROM meta WHERE key=?) AS vectors_rev`,
      [CARDS_REV_KEY, CARDS_STAMPED_KEY, CARDS_DELETED_KEY, VECTORS_REV_KEY],
    );
    return {
      cardsRev: asCount(row?.cards_rev),
      cardsStamped: asCount(row?.cards_stamped),
      cardsDeleted: asCount(row?.cards_deleted),
      vectorsRev: asCount(row?.vectors_rev),
    };
  }

  repairPendingCount(): number {
    return asCount(
      this.db.get("SELECT count(*) AS n FROM card WHERE repair_reason IS NOT NULL")?.n,
    );
  }

  cardStats(): CardStats {
    const row = this.db.get(
      `SELECT c.cards, c.full_cards, c.repair_pending,
         (SELECT value FROM meta WHERE key=?) AS cards_rev,
         (SELECT value FROM meta WHERE key=?) AS cards_stamped,
         (SELECT value FROM meta WHERE key=?) AS cards_deleted,
         (SELECT value FROM meta WHERE key=?) AS vectors_rev
       FROM (SELECT count(*) AS cards,
                    coalesce(sum(distill_state = 'full'), 0) AS full_cards,
                    coalesce(sum(repair_reason IS NOT NULL), 0) AS repair_pending
             FROM card) AS c`,
      [CARDS_REV_KEY, CARDS_STAMPED_KEY, CARDS_DELETED_KEY, VECTORS_REV_KEY],
    );
    return {
      cards: asCount(row?.cards),
      fullCards: asCount(row?.full_cards),
      repairPending: asCount(row?.repair_pending),
      cardsRev: asCount(row?.cards_rev),
      cardsStamped: asCount(row?.cards_stamped),
      cardsDeleted: asCount(row?.cards_deleted),
      vectorsRev: asCount(row?.vectors_rev),
    };
  }

  spaceStats(): SpaceStats {
    return {
      pageCount: asCount(this.db.get("PRAGMA page_count")?.page_count),
      freelistCount: asCount(this.db.get("PRAGMA freelist_count")?.freelist_count),
      pageSize: asCount(this.db.get("PRAGMA page_size")?.page_size),
    };
  }

  staleCards(gen?: number): StaleCard[] {
    if (gen === undefined || !Number.isFinite(gen)) return [];
    // CASE, not AND: SQLite does not promise to skip json_extract on a
    // malformed checkpoint, and json_extract throws on one.
    const rows = this.db.all(
      `SELECT session_id, time_updated FROM card
       WHERE repair_reason IS NULL
         AND (projector_gen IS NULL OR projector_gen < ?
              OR (CASE WHEN json_valid(distill_cursor) THEN json_extract(distill_cursor, '$.v') END) = 1)
       ORDER BY time_updated DESC, session_id`,
      [gen],
    );
    return rows.map((row) => ({
      sessionId: asString(row.session_id),
      timeUpdated: asNumber(row.time_updated),
    }));
  }

  markRepairPending(sessionId: string, reason: string): CardWrite {
    const { changes } = this.db.run(
      "UPDATE card SET repair_reason=? WHERE session_id=? AND repair_reason IS NOT ?",
      [reason, sessionId, reason],
    );
    return { changed: changes > 0 };
  }

  clearRepairReasons(): number {
    return this.db.run("UPDATE card SET repair_reason=NULL WHERE repair_reason IS NOT NULL")
      .changes;
  }

  getRangeHashes(sessionId: string): RangeHash[] {
    return this.db
      .all(
        "SELECT start_seq, end_seq, row_count, hash, sweep_gen FROM range_hash WHERE session_id=? ORDER BY start_seq",
        [sessionId],
      )
      .map(rowToRangeHash);
  }

  putRangeHashes(sessionId: string, ranges: RangeHash[]): void {
    if (ranges.length === 0) return;
    this.db.tx(() => this.writeRangeHashes(sessionId, ranges));
  }

  clearRangeHashes(sessionId: string): number {
    return this.db.run("DELETE FROM range_hash WHERE session_id=?", [sessionId]).changes;
  }

  /** Upsert range hashes by `(session, startSeq)`. Caller supplies the
   *  transaction. */
  private writeRangeHashes(sessionId: string, ranges: RangeHash[] | undefined): void {
    for (const range of ranges ?? []) {
      this.db.run(
        `INSERT INTO range_hash(session_id, start_seq, end_seq, row_count, hash, sweep_gen)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, start_seq) DO UPDATE SET end_seq=excluded.end_seq,
           row_count=excluded.row_count, hash=excluded.hash, sweep_gen=excluded.sweep_gen`,
        [sessionId, range.startSeq, range.endSeq, range.rowCount, range.hash, range.sweepGen],
      );
    }
  }

  /** Increment a meta counter and return its new value. Caller supplies the
   *  transaction. */
  private bumpCounter(key: string): number {
    const next = (Number(this.getMeta(key)) || 0) + 1;
    this.setMeta(key, String(next));
    return next;
  }

  /** Allocate the next `cards_rev` and count it in `cards_stamped`. Caller
   *  supplies the transaction and stamps the revision on what it wrote. */
  private nextRev(): number {
    const rev = this.bumpCounter(CARDS_REV_KEY);
    this.bumpCounter(CARDS_STAMPED_KEY);
    return rev;
  }

  /** Write a card with a freshly allocated revision (see
   *  {@link CARD_STAMPED_UPSERT_SQL}). Caller supplies the transaction. */
  private writeStampedCard(card: Card): void {
    this.db.run(CARD_STAMPED_UPSERT_SQL, [...cardValues(card), this.nextRev()]);
  }

  /** Store only the checkpoint, projector generation and settled base of an
   *  unchanged card. Caller supplies the transaction. */
  private writeCheckpoint(sessionId: string, card: Card): void {
    this.db.run(
      "UPDATE card SET distill_cursor=?, projector_gen=?, settled_base=? WHERE session_id=?",
      [
        card.distillCursor ?? null,
        card.projectorGen ?? null,
        card.settledBase ? serializeSettledBase(card.settledBase) : null,
        sessionId,
      ],
    );
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
    return this.bumpCounter(VECTORS_REV_KEY);
  }

  writeSummary(sessionId: string, summary: string, hash: string): CardWrite {
    return this.db.tx((): CardWrite => {
      const stored = this.db.get("SELECT nl_summary, summary_hash FROM card WHERE session_id=?", [
        sessionId,
      ]);
      if (!stored || (stored.nl_summary === summary && stored.summary_hash === hash)) {
        return { changed: false };
      }
      this.db.run(
        "UPDATE card SET nl_summary=?, summary_hash=?, embedding=NULL, write_rev=? WHERE session_id=?",
        [summary, hash, this.nextRev(), sessionId],
      );
      return { changed: true };
    });
  }

  deleteSession(sessionId: string): CardWrite {
    return this.db.tx((): CardWrite => {
      this.evictFts(
        this.db.all("SELECT id, raw, norm FROM part_text WHERE session_id=?", [sessionId]),
      );
      const parts = this.db.run("DELETE FROM part_text WHERE session_id=?", [sessionId]).changes;
      const cards = this.db.run("DELETE FROM card WHERE session_id=?", [sessionId]).changes;
      this.db.run("DELETE FROM range_hash WHERE session_id=?", [sessionId]);
      if (parts === 0 && cards === 0) return { changed: false };
      // No row is left to stamp, but the revision still moves so readers see
      // the removal, and cards_deleted tells them to diff their id sets.
      this.nextRev();
      this.bumpCounter(CARDS_DELETED_KEY);
      return { changed: true };
    });
  }

  patchCardMeta(
    sessionId: string,
    patch: { title?: string; directory?: string; projectId?: string; timeArchived?: number | null },
  ): CardWrite {
    const patched = (stored: StoredCardMeta): StoredCardMeta => ({
      ...stored,
      title: patch.title ?? stored.title,
      directory: patch.directory ?? stored.directory,
      projectId: patch.projectId ?? stored.projectId,
      timeArchived: patch.timeArchived === undefined ? stored.timeArchived : patch.timeArchived,
    });
    // Hosts send most patches with nothing new in them: a plain read settles
    // those without a write transaction.
    const current = this.readCardMeta(sessionId);
    if (!current || !metaDiffers(current, patched(current))) return { changed: false };
    return this.db.tx(() => this.writeCardMeta(sessionId, patched));
  }

  /** The session metadata a card stores, or undefined without a card. */
  private readCardMeta(sessionId: string): StoredCardMeta | undefined {
    const row = this.db.get(
      "SELECT title, directory, project_id, time_updated, time_archived FROM card WHERE session_id=?",
      [sessionId],
    );
    if (!row) return undefined;
    return {
      title: asString(row.title),
      directory: asString(row.directory),
      projectId: asString(row.project_id),
      timeUpdated: asNumber(row.time_updated),
      timeArchived: asNullableNumber(row.time_archived),
    };
  }

  refreshCardMeta(
    sessionId: string,
    meta: CardMetaRefresh,
    distillCursor: string | null,
  ): CardWrite {
    return this.db.tx(() =>
      this.writeCardMeta(
        sessionId,
        (stored) => ({
          title: meta.title,
          directory: meta.directory,
          projectId: meta.projectId,
          timeUpdated: meta.timeUpdated,
          timeArchived: meta.timeArchived === undefined ? stored.timeArchived : meta.timeArchived,
        }),
        distillCursor,
      ),
    );
  }

  /**
   * Apply `next` to a card's session metadata. When any value differs it
   * writes them all with a revision; title and directory feed the embedded
   * text (embeddingTextOf), so a change to either also drops the vector and
   * its generation, which the semantic layer recomputes on the next load.
   * `distillCursor`, when given, is stored either way, and the settled base
   * dropped with it: a base belongs to the checkpoint it was written with.
   * Caller supplies the transaction.
   */
  private writeCardMeta(
    sessionId: string,
    next: (stored: StoredCardMeta) => StoredCardMeta,
    distillCursor?: string | null,
  ): CardWrite {
    const stored = this.readCardMeta(sessionId);
    if (!stored) return { changed: false };
    const meta = next(stored);
    const embedded = meta.title !== stored.title || meta.directory !== stored.directory;
    const changed = metaDiffers(stored, meta);
    const cursorSet = distillCursor === undefined ? "" : ", distill_cursor=?, settled_base=NULL";
    const cursorParam: SqlValue[] = distillCursor === undefined ? [] : [distillCursor];
    if (!changed) {
      if (distillCursor !== undefined) {
        this.db.run("UPDATE card SET distill_cursor=?, settled_base=NULL WHERE session_id=?", [
          distillCursor,
          sessionId,
        ]);
      }
      return { changed: false };
    }
    const vectorSet = embedded ? ", embedding=NULL, embedding_gen=NULL" : "";
    this.db.run(
      `UPDATE card SET title=?, directory=?, project_id=?, time_updated=?, time_archived=?,
         write_rev=?${vectorSet}${cursorSet} WHERE session_id=?`,
      [
        meta.title,
        meta.directory,
        meta.projectId,
        meta.timeUpdated,
        meta.timeArchived,
        this.nextRev(),
        ...cursorParam,
        sessionId,
      ],
    );
    return { changed: true };
  }

  setFamilyRollup(sessionId: string, rollup: FamilyRollup[]): CardWrite {
    return this.db.tx((): CardWrite => {
      const json = JSON.stringify(rollup);
      const stored = this.db.get("SELECT family_rollup FROM card WHERE session_id=?", [sessionId]);
      if (!stored || stored.family_rollup === json) return { changed: false };
      this.db.run("UPDATE card SET family_rollup=?, write_rev=? WHERE session_id=?", [
        json,
        this.nextRev(),
        sessionId,
      ]);
      return { changed: true };
    });
  }

  replaceSessionParts(
    sessionId: string,
    rows: PartTextRow[],
    card: Card,
    opts?: { rangeHashes?: RangeHash[]; replaceRangeHashes?: boolean; stored?: StoredRows },
  ): SessionWrite {
    return this.db.tx((): SessionWrite => {
      const stored = this.db.get(CARD_COMPARE_SQL, [sessionId]);
      if (belowStoredGen(card.projectorGen, stored?.projector_gen)) {
        return { changed: false, refused: "older-generation" };
      }
      const storedRows = opts?.stored
        ? this.preparedRows(sessionId, stored, opts.stored)
        : this.db.all(
            `SELECT id, ${PART_ROW_COLUMNS} FROM part_text WHERE session_id=? ORDER BY id`,
            [sessionId],
          );
      if (!storedRows) return { changed: false, refused: "base-changed" };
      if (opts?.replaceRangeHashes) {
        this.db.run("DELETE FROM range_hash WHERE session_id=?", [sessionId]);
      }
      const changed = !stored || !sameCard(stored, card) || !sameRows(storedRows, rows);
      if (changed) {
        this.writeRowDiff(sessionId, storedRows, rows);
        this.writeStampedCard(card);
      } else {
        this.writeCheckpoint(sessionId, card);
      }
      this.db.run(
        "UPDATE card SET repair_reason=NULL WHERE session_id=? AND repair_reason IS NOT NULL",
        [sessionId],
      );
      this.writeRangeHashes(sessionId, opts?.rangeHashes);
      return { changed };
    });
  }

  appendSessionParts(
    sessionId: string,
    rows: PartTextRow[],
    ftsRowsPerSession: number,
    boundary: AppendBoundary,
    recompute: (allRows: PartTextRow[]) => Card,
    opts?: { rangeHashes?: RangeHash[]; replaceRangeHashes?: boolean; stored?: StoredRows },
  ): SessionWrite {
    try {
      return this.db.tx((): SessionWrite => {
        const stored = this.db.get(CARD_COMPARE_SQL, [sessionId]);
        const appended = opts?.stored
          ? this.appendToPrepared(sessionId, stored, opts.stored, rows, ftsRowsPerSession, boundary)
          : this.appendToStored(sessionId, rows, ftsRowsPerSession, boundary);
        if (!appended) return { changed: false, refused: "base-changed" };
        const recomputed = recompute(appended.rows);
        // An append extends the card at its stored generation unless the
        // recomputed card names one.
        const card: Card =
          recomputed.projectorGen === undefined
            ? { ...recomputed, projectorGen: asNullableNumber(stored?.projector_gen) }
            : recomputed;
        if (belowStoredGen(card.projectorGen, stored?.projector_gen)) {
          throw new OlderGenerationRefused();
        }
        const changed = appended.rowsChanged || !stored || !sameCard(stored, card);
        if (changed) this.writeStampedCard(card);
        else this.writeCheckpoint(sessionId, card);
        if (opts?.replaceRangeHashes) {
          this.db.run("DELETE FROM range_hash WHERE session_id=?", [sessionId]);
        }
        this.writeRangeHashes(sessionId, opts?.rangeHashes);
        return { changed };
      });
    } catch (error) {
      if (error instanceof OlderGenerationRefused) {
        return { changed: false, refused: "older-generation" };
      }
      throw error;
    }
  }

  /** An append over the rows read inside its transaction: every stored row
   *  is read, with its text, and then read again for the card. Caller
   *  supplies the transaction. */
  private appendToStored(
    sessionId: string,
    rows: PartTextRow[],
    ftsRowsPerSession: number,
    boundary: AppendBoundary,
  ): { rowsChanged: boolean; rows: PartTextRow[] } {
    const old = this.db.all("SELECT id, raw, norm FROM part_text WHERE session_id=? ORDER BY id", [
      sessionId,
    ]);
    const total = old.length + rows.length;
    const overflow =
      ftsRowsPerSession > 0 && total > ftsRowsPerSession ? total - ftsRowsPerSession : 0;
    // Newest-first cap over old + new (matching capRows): evict the oldest
    // `overflow` rows — from the existing rows first (front of `old`), and any
    // remaining overflow simply skips the oldest new rows so they never insert.
    const evictOld = Math.min(overflow, old.length);
    this.evictFts(old.slice(0, evictOld));
    for (let i = 0; i < evictOld; i++) {
      this.db.run("DELETE FROM part_text WHERE id=?", [asNumber(old[i]!.id)]);
    }
    const firstInserted = overflow - evictOld;
    for (let i = firstInserted; i < rows.length; i++) this.insertRow(sessionId, rows[i]!);
    // Repoint the checkpoint message's dangling next pointer at the first
    // appended message (only surviving checkpoint rows still NULL). A no-op
    // when the checkpoint was evicted by the cap — as it would be in a full
    // re-distill of the same state.
    const repointed = this.db.run(
      "UPDATE part_text SET next_message_id=? WHERE session_id=? AND message_id=? AND next_message_id IS NULL",
      [boundary.firstNewMessageId, sessionId, boundary.checkpointMessageId],
    ).changes;
    return {
      rowsChanged: evictOld > 0 || firstInserted < rows.length || repointed > 0,
      rows: this.readSessionRows(sessionId),
    };
  }

  /** An append over the rows a caller read before its transaction
   *  (`prepared`), laid out by {@link appendedRows}, or undefined when they
   *  may no longer be the stored ones, as {@link preparedIds} decides. Reads
   *  the session's rowids and only the evicted rows' indexed text. Caller
   *  supplies the transaction. */
  private appendToPrepared(
    sessionId: string,
    card: Row | undefined,
    prepared: StoredRows,
    rows: PartTextRow[],
    ftsRowsPerSession: number,
    boundary: AppendBoundary,
  ): { rowsChanged: boolean; rows: PartTextRow[] } | undefined {
    const ids = this.preparedIds(sessionId, card, prepared);
    if (!ids) return undefined;
    const layout = appendedRows(prepared.rows, rows, ftsRowsPerSession, boundary);
    if (layout.evict > 0) {
      this.evictFts(
        this.db.all("SELECT id, raw, norm FROM part_text WHERE session_id=? ORDER BY id LIMIT ?", [
          sessionId,
          layout.evict,
        ]),
      );
      for (let i = 0; i < layout.evict; i++) {
        this.db.run("DELETE FROM part_text WHERE id=?", [ids[i]!]);
      }
    }
    for (const row of layout.inserted) this.insertRow(sessionId, row);
    for (const i of layout.repointed) {
      this.db.run("UPDATE part_text SET next_message_id=? WHERE id=?", [
        boundary.firstNewMessageId,
        ids[i]!,
      ]);
    }
    return {
      rowsChanged: layout.evict > 0 || layout.inserted.length > 0 || layout.repointed.length > 0,
      rows: layout.rows,
    };
  }

  replaceSessionTail(
    sessionId: string,
    tail: SessionTail,
    next: Card,
    opts?: { rangeHashes?: RangeHash[]; replaceRangeHashes?: boolean },
  ): SessionWrite {
    const { base, evict } = tail;
    return this.db.tx((): SessionWrite => {
      const stored = this.db.get(CARD_COMPARE_SQL, [sessionId]);
      if (
        !stored ||
        stored.settled_base !== serializeSettledBase(base) ||
        asNullableNumber(stored.write_rev) !== tail.writeRev ||
        !Number.isInteger(evict) ||
        evict < 0 ||
        evict > base.rows ||
        this.sessionRowCount(sessionId) < base.rows
      ) {
        return { changed: false, refused: "base-changed" };
      }
      // Like an append, a tail write extends the card at its stored
      // generation unless the card names one.
      const card: Card =
        next.projectorGen === undefined
          ? { ...next, projectorGen: asNullableNumber(stored.projector_gen) }
          : next;
      if (belowStoredGen(card.projectorGen, stored.projector_gen)) {
        return { changed: false, refused: "older-generation" };
      }
      // Only the rows this write can change are read: the evicted ones, the
      // previous tail's and those of the base's newest message, which point
      // at the tail's first message.
      const evicted =
        evict > 0
          ? this.db.all(
              "SELECT id, raw, norm FROM part_text WHERE session_id=? ORDER BY id LIMIT ?",
              [sessionId, evict],
            )
          : [];
      const oldTail = this.db.all(
        `SELECT id, ${PART_ROW_COLUMNS} FROM part_text WHERE session_id=? ORDER BY id LIMIT -1 OFFSET ?`,
        [sessionId, base.rows],
      );
      const gone = new Set(evicted.map((row) => asNumber(row.id)));
      const repoint =
        base.messageId !== null &&
        this.db
          .all("SELECT id, next_message_id FROM part_text WHERE session_id=? AND message_id=?", [
            sessionId,
            base.messageId,
          ])
          .some(
            (row) =>
              !gone.has(asNumber(row.id)) &&
              !sameSqlValue(row.next_message_id, tail.firstMessageId),
          );
      const tailChanged = !sameRows(oldTail, tail.rows);
      this.evictFts(evicted);
      for (const row of evicted) {
        this.db.run("DELETE FROM part_text WHERE id=?", [asNumber(row.id)]);
      }
      if (repoint) {
        this.db.run("UPDATE part_text SET next_message_id=? WHERE session_id=? AND message_id=?", [
          tail.firstMessageId,
          sessionId,
          base.messageId,
        ]);
      }
      if (tailChanged) this.writeRowDiff(sessionId, oldTail, tail.rows);
      const changed = evict > 0 || repoint || tailChanged || !sameCard(stored, card);
      if (changed) this.writeStampedCard(card);
      else this.writeCheckpoint(sessionId, card);
      if (opts?.replaceRangeHashes) {
        this.db.run("DELETE FROM range_hash WHERE session_id=?", [sessionId]);
      }
      this.writeRangeHashes(sessionId, opts?.rangeHashes);
      return { changed };
    });
  }

  /** The rows a caller read before this transaction (`prepared`), each with
   *  the rowid at its place now ({@link preparedIds}). Caller supplies the
   *  transaction. */
  private preparedRows(
    sessionId: string,
    card: Row | undefined,
    prepared: StoredRows,
  ): Row[] | undefined {
    const ids = this.preparedIds(sessionId, card, prepared);
    return ids && prepared.rows.map((row, i) => storedRow(ids[i], row));
  }

  /** The session's rowids in order, one per row a caller read before this
   *  transaction (`prepared`), or undefined when those rows may no longer be
   *  the stored ones: the card (`card`, read in this transaction) is gone, a
   *  stamped write moved its revision, or the session holds another number
   *  of rows. Reads only the rowids, from the session's index. Caller
   *  supplies the transaction. */
  private preparedIds(
    sessionId: string,
    card: Row | undefined,
    prepared: StoredRows,
  ): number[] | undefined {
    if (!card || asNullableNumber(card.write_rev) !== prepared.writeRev) return undefined;
    const ids = this.db
      .all("SELECT id FROM part_text WHERE session_id=? ORDER BY id", [sessionId])
      .map((row) => asNumber(row.id));
    return ids.length === prepared.rows.length ? ids : undefined;
  }

  /**
   * Make a session's stored rows (`stored`, with their rowids, in rowid
   * order) hold exactly `rows`, writing only the rows {@link planRowDiff}
   * plans to delete, overwrite or insert, and keep the FTS index in step for
   * exactly those rows. The index entries of the rows it deletes, or whose
   * text it overwrites, are removed with the values those rows hold in this
   * transaction, read by rowid (the FTS `'delete'` command requires them).
   * Deletes run before inserts because part ids are unique: a part that
   * moves is deleted from its old place before it is inserted at its new
   * one. Caller supplies the transaction.
   */
  private writeRowDiff(sessionId: string, stored: Row[], rows: PartTextRow[]): void {
    const diff = planRowDiff(stored, rows);
    const dropped = [...diff.removed, ...diff.updated.filter((u) => u.text).map((u) => u.id)];
    const entries: Row[] = [];
    for (const id of dropped) {
      const row = this.db.get("SELECT id, raw, norm FROM part_text WHERE id=?", [id]);
      if (row) entries.push(row);
    }
    this.evictFts(entries);
    for (const id of diff.removed) this.db.run("DELETE FROM part_text WHERE id=?", [id]);
    for (const { id, row, text } of diff.updated) {
      this.db.run(
        "UPDATE part_text SET message_id=?, prev_message_id=?, next_message_id=?, class=?, time_created=?, raw=?, norm=? WHERE id=?",
        [
          row.messageId,
          row.prevMessageId,
          row.nextMessageId,
          row.class,
          row.timeCreated,
          row.raw,
          row.norm,
          id,
        ],
      );
      if (text) {
        this.db.run("INSERT INTO part_fts(rowid, raw, norm) VALUES(?, ?, ?)", [
          id,
          row.raw,
          row.norm,
        ]);
      }
    }
    for (const row of diff.added) this.insertRow(sessionId, row);
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
      `SELECT ${PART_ROW_COLUMNS} FROM part_text WHERE session_id=? ORDER BY id`,
      [sessionId],
    );
    return rows.map(rowToPart);
  }

  /** Delete slim-index rows (read with their `id`, `raw` and `norm`) from the
   *  external-content FTS index using their original indexed values (the FTS
   *  `'delete'` command requires them). Must run before the `part_text` rows
   *  are deleted. Caller supplies the tx. */
  private evictFts(old: Row[]): void {
    for (const row of old) {
      this.db.run("INSERT INTO part_fts(part_fts, rowid, raw, norm) VALUES('delete', ?, ?, ?)", [
        asNumber(row.id),
        asString(row.raw),
        asString(row.norm),
      ]);
    }
  }

  ftsSearch(input: FtsQuery): FtsHit[] {
    const budget =
      input.weakRowBudget != null && Number.isFinite(input.weakRowBudget) && input.weakRowBudget > 0
        ? Math.floor(input.weakRowBudget)
        : WEAK_MATCH_ROWS;
    const limit =
      input.limit != null && Number.isFinite(input.limit) && input.limit > 0
        ? Math.floor(input.limit)
        : DEFAULT_FTS_LIMIT;
    // Strong anchors as before; only a plain-word lookup is bounded.
    const strong = buildMatch(input.strong ?? [], []);
    if (strong) return this.scoredRows(strong, limit);
    return this.plainWordRows(input.weak ?? [], budget, limit);
  }

  /** A lookup by plain words under `budget` (see {@link Store.ftsSearch}). */
  private plainWordRows(words: readonly string[], budget: number, limit: number): FtsHit[] {
    const phrases = [...new Set(words.map(quoteAnchor).filter((a): a is string => a !== null))];
    const kept = boundWeakAnchors(phrases, (phrase) => this.matchRows(phrase, budget), budget);
    let full: FtsHit[] = [];
    if (phrases.length >= 2) {
      const together = phrases.join(" AND ");
      const rows = this.recentRows(together, limit);
      // Fewer than `limit` rows are the whole match, so only a full list
      // needs counting; an AND walks its posting lists once per statement.
      const total = rows.length < limit ? rows.length : this.matchRows(together, budget);
      if (total > 0 && total < budget) full = rows;
    }
    if (kept.length === 0 || full.length >= limit) return full;
    const rankCap = Math.min(budget * RANKING_ROWS_FACTOR, Number.MAX_SAFE_INTEGER);
    const ranking = phrases.filter(
      (phrase) => !kept.includes(phrase) && this.matchRows(phrase, rankCap) < rankCap,
    );
    // Every row holding all the words holds a kept one, so the kept lookup
    // lists them again; `limit` rows leave enough once they are skipped.
    const listed = new Set(full.map((hit) => hit.partId));
    const rest = this.scoredRows(rankedMatch(phrases, kept, ranking), limit).filter(
      (hit) => !listed.has(hit.partId),
    );
    return [...full, ...rest.slice(0, limit - full.length)];
  }

  /** The rows `match` matches, best `bm25()` first. */
  private scoredRows(match: string, limit: number): FtsHit[] {
    const rows = this.db.all(
      `SELECT p.session_id, p.part_id, p.message_id, p.prev_message_id, p.next_message_id, p.class, bm25(part_fts) AS score
       FROM part_fts JOIN part_text p ON p.id = part_fts.rowid
       WHERE part_fts MATCH ?
       ORDER BY score, p.time_created DESC, p.session_id, p.part_id
       LIMIT ?`,
      [match, limit],
    );
    return rows.map((row) => ftsHitOf(row, asNumber(row.score)));
  }

  /** The rows `match` matches, newest written first, unscored. `bm25()`
   *  would first read every row of each phrase in the match to weigh it; in
   *  rowid order FTS5 reads the posting lists only up to the LIMIT. */
  private recentRows(match: string, limit: number): FtsHit[] {
    const rows = this.db.all(
      `SELECT p.session_id, p.part_id, p.message_id, p.prev_message_id, p.next_message_id, p.class
       FROM part_fts JOIN part_text p ON p.id = part_fts.rowid
       WHERE part_fts MATCH ?
       ORDER BY part_fts.rowid DESC
       LIMIT ?`,
      [match, limit],
    );
    return rows.map((row) => ftsHitOf(row, Number.NEGATIVE_INFINITY));
  }

  /** The slim-index rows a MATCH expression matches, counted up to `cap`:
   *  FTS5 yields matches lazily, so the count stops at `cap`. An AND walks
   *  its phrases' posting lists until then, skipping ahead between them. */
  private matchRows(match: string, cap: number): number {
    const row = this.db.get(
      "SELECT count(*) AS n FROM (SELECT 1 FROM part_fts WHERE part_fts MATCH ? LIMIT ?)",
      [match, cap],
    );
    return asNumber(row?.n);
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
/** Default store filename per host. The v1 name predates the host fence and is
 *  kept so existing v1 stores upgrade in place instead of rebuilding. Separate
 *  files give each host its own lease, revision counters and semantic stamp. */
const STORE_FILENAMES: Record<StoreHost, string> = {
  "opencode-v1": "store-v1.db",
  "opencode-v2": "store-opencode-v2.db",
};

/**
 * Resolve the default store path for `host` under
 * `~/.cache/opencode-session-recall/` (`store-v1.db` for the v1 host,
 * `store-opencode-v2.db` for the v2 host) and ensure its directory exists.
 * Async because the only way to reach os/path/fs from `src/` is dynamic import.
 * Returns `null` if the directory cannot be created (e.g. the drivers are
 * unavailable), so the caller degrades.
 */
export async function defaultStorePath(host: StoreHost): Promise<string | null> {
  try {
    const [fs, path, os] = await Promise.all([loadFs(), loadPath(), loadOs()]);
    const dir = path.join(os.homedir(), STORE_CACHE_SUBDIR);
    await fs.promises.mkdir(dir, { recursive: true });
    return path.join(dir, STORE_FILENAMES[host]);
  } catch {
    return null;
  }
}
