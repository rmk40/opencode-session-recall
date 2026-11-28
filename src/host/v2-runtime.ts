import { createFetchGate, type FetchGate } from "../fetch-gate.js";
import {
  openSqlite,
  sqliteThreadSafety,
  SqliteBusyError,
  type ReadOnlyDb,
  type SqliteDb,
} from "../sqlite.js";
import {
  openReadStore,
  openStore,
  peekStoreIdentity,
  defaultStorePath,
  pluginBuild,
  type CardCounters,
  type ReadStore,
  type Store,
  type StoreHost,
  type Card,
} from "../store.js";
import { EMBED_REPRESENTATION } from "../embedding-text.js";
import {
  createCardsRuntime,
  cardsLiteFromSessions,
  inlineVectorWriter,
  storeCardSource,
  type CardSource,
  type CardSourceStore,
  type CardsRuntime,
} from "../cards.js";
import { createLiteRefresh, type LiteRefreshController } from "../lite-refresh.js";
import { createDrill, type Drill } from "../drill.js";
import {
  createDistiller,
  type Distiller,
  type DistillStatus,
  type RepairStatus,
} from "../distill.js";
import type { HistorySession } from "../history/model.js";
import {
  addReadCounts,
  createHistoryDriftState,
  createUnavailableSource,
  type HistoryDrift,
  type HistoryDriftState,
  type HistorySource,
} from "../history/source.js";
import {
  createV2HistorySource,
  openOpencodeDb,
  v2DriftBase,
  type V2SchemaInfo,
} from "../history/v2.js";
import { V2_PROJECTOR_GEN } from "../history/v2-project.js";
import { opencodeDbPath } from "../history/v2-path.js";
import { createV2Sync, type V2SyncOptions } from "../history/v2-sync.js";
import { createV2EventMapper } from "../history/v2-events.js";
import { discoverSessions } from "../history/v2-discovery.js";
import type { SearchDeps, SemanticSearchConfig } from "../search.js";
import type { SessionEnrichment } from "../sessions.js";
import type { ResolvedOptions } from "../options.js";
import { errmsg, settleWithin, type Limits } from "../types.js";
import { yieldInBackground, yieldOnBudget } from "../yield.js";
import { loadFs, loadPath } from "../node-import.js";
import { BUILD_ID } from "../build-id.js";
import { createForegroundSignal, type ForegroundSignal } from "../foreground.js";
import {
  createWorkerController,
  type WorkerController,
  type WorkerControllerOptions,
  type WorkerInit,
} from "../worker/controller.js";
import { createEventOutbox, type EventOutbox, type WorkerSyncOptions } from "../worker/protocol.js";
import { defaultWorkerStarter } from "../worker/start.js";
import type { V2Event } from "./opencode-v2-types.js";
import {
  createIdDedupe,
  noteWorkerExit,
  pendingWorkerExit,
  type ResolvedIdentity,
  type RuntimeFactory,
} from "./runtime.js";

/**
 * The v2 host's process runtime: everything that must exist once per process
 * rather than once per location. Created by {@link v2RuntimeFactory} inside
 * the registry's deferred init (never on `setup`'s admission path), shared by
 * every attached instance, and disposed by the last one to detach.
 *
 * The runtime reads opencode's own `opencode.db` read-only. Each instance gets
 * a facade over it bound to its own opencode project id through
 * {@link V2Runtime.sourceFor}.
 *
 * With a store path and a canonical `opencode.db` that opens, the distiller
 * runs in a worker thread (`src/worker/`): the worker holds the only writable
 * store connection, the lease, the checkpoints and its own `opencode.db`
 * handle, and this thread keeps the tools, the event mapping, the card
 * runtime and every search, over a store connection that only reads
 * (`openReadStore`). After three failed worker generations, or with a SQLite
 * library that is not thread-safe, the distiller runs on this thread as it
 * did without a worker, over a writable store opened here.
 */

const STORE_HOST: StoreHost = "opencode-v2";
/** Build tag recorded in the lease and `coverage.semantic.pluginVersion`. */
export const V2_PLUGIN_BUILD = pluginBuild(STORE_HOST, V2_PROJECTOR_GEN);
/** Per-phase bound on dispose's awaited waits (as on v1). */
const SHUTDOWN_TIMEOUT_MS = 2_500;
/** How long dispose waits for the worker's thread to end after `terminate`. */
const WORKER_EXIT_WAIT_MS = 10_000;
/** How long the runtime's creation waits for the worker's store result. A
 *  runtime created without it serves the degraded card tier, saying the
 *  index is starting, and takes the store's cards once it is open. Shorter
 *  than a tool call's wait for the runtime (`TOOL_READY_WAIT_MS`). */
export const STORE_READY_WAIT_MS = 2_500;
/** The reason the degraded card tier gives while the worker is starting. */
export const INDEX_STARTING_REASON = "the index is starting";
/** Why the distiller of an in-memory store runs on main. */
export const STORE_IN_MEMORY_REASON = "the store is in memory, which no other thread can open";
/** The reason the degraded card tier gives while the worker waits for a
 *  store whose write lock another process holds. */
export const STORE_LOCKED_REASON =
  "the store is locked by another process, and the index is waiting for it";
/** How often the runtime compares the history drift with what it last
 *  logged. */
const DRIFT_LOG_EVERY_MS = 5 * 60_000;
/** Unknown part type names a merged drift snapshot keeps, as each drift
 *  state does. */
const UNKNOWN_TYPE_NAMES_CAP = 16;

export { discoverSessions };

/** The runtime-shaping options: first writer wins (see `runtime.ts`). */
export type V2RuntimeOptions = Pick<
  ResolvedOptions,
  "ephemeral" | "storePath" | "opencodeDbPath" | "semantic" | "limits"
> & { summaries: boolean };

export type V2Runtime = {
  readonly options: V2RuntimeOptions;
  readonly gate: FetchGate;
  /** The store the tools read: main's reader while the distiller runs in a
   *  worker, a writable store when it runs on this thread, null without one.
   *  It can change after creation (see {@link revision}). */
  readonly store: ReadStore | null;
  readonly cards: CardsRuntime;
  readonly drill: Drill;
  readonly distiller: Distiller;
  /** Base search deps; `recall` reads the source's `unavailable` reason. */
  readonly deps: SearchDeps;
  readonly enrichment: SessionEnrichment | undefined;
  /** Set when `opencode.db` cannot be read. */
  readonly unavailable: string | undefined;
  /** Counts the changes of {@link store}, {@link cards}, {@link deps} and
   *  {@link enrichment}: tools built over an older value are rebuilt. */
  revision(): number;
  /** The count of tool calls running, which the worker's background work
   *  gives way to. */
  readonly foreground: ForegroundSignal;
  /** The history facade scoped to one opencode project. */
  sourceFor(projectID: string): HistorySource;
  /** The drill's facade: no project, global listings only. The distiller
   *  reads through one like it whose reads yield in the background. */
  readonly globalSource: HistorySource;
  /** A session's parent id (`null` for a root), or undefined when unknown. */
  parentOf(sessionID: string): Promise<string | null | undefined>;
  /**
   * How `opencode.db` differs from what this build reads (capabilities,
   * migration, unknown tables, and what reads could not project), summed
   * over every facade's reads, the worker's included: the same state each
   * facade's `history()` returns. Undefined when `opencode.db` is unavailable.
   */
  history(): HistoryDrift | undefined;
  /** The repair sweep's and the range check's progress, as the lease holder
   *  shares them in the store; undefined without a store or a source. */
  repair(): RepairStatus | undefined;
  /** One bus event from any attached instance; deduplicated by id. */
  onEvent(event: V2Event): void;
  /** Track a foreground operation so dispose never closes a handle under it. */
  track<T>(operation: Promise<T>): Promise<T>;
  dispose(): Promise<void>;
};

/** The worker settings a test may replace. */
export type V2WorkerInputs = Partial<
  Pick<
    WorkerControllerOptions,
    | "start"
    | "restartDelaysMs"
    | "readyTimeoutMs"
    | "storeTimeoutMs"
    | "watchdogEveryMs"
    | "maxFailures"
  >
>;

export type V2RuntimeInputs = {
  options: V2RuntimeOptions;
  /** `ctx.app.channel` of the attaching instance (process-wide). */
  channel: string;
  log: (message: string) => void;
  /** Test affordance: poll timing and the like. */
  sync?: V2SyncOptions;
  /** Test affordance: the distiller's idle debounce. */
  idleDebounceMs?: number;
  /** Test affordance: how worker generations start and time out, or `false`
   *  to run the distiller on this thread. */
  worker?: V2WorkerInputs | false;
  /** Test affordance: wraps main's store reader handle (see
   *  `ReadStoreOptions.wrapReader`). */
  wrapReader?: (db: ReadOnlyDb) => ReadOnlyDb;
};

/** The runtime-shaping values an attaching instance compares. */
export function runtimeShape(options: V2RuntimeOptions): Record<string, unknown> {
  return {
    semantic: options.semantic ?? null,
    summaries: options.summaries,
    limits: options.limits,
  };
}

/** The canonical path of an existing file or directory, or null when it
 *  cannot be resolved (it does not exist, or is not accessible). No fallback:
 *  a caller that stamps the result must know it is canonical. */
async function tryRealPath(path: string): Promise<string | null> {
  try {
    const fs = await loadFs();
    return await fs.promises.realpath(path);
  } catch {
    return null;
  }
}

/** The real path of a store file: the file itself when it exists (so a
 *  symlinked store file resolves to its target), else its real directory
 *  plus its name (the file is created on first open). `:memory:` stays. */
async function realFilePath(path: string): Promise<string> {
  if (path === ":memory:") return path;
  try {
    const p = await loadPath();
    const resolved = p.resolve(path);
    const whole = await tryRealPath(resolved);
    if (whole !== null) return whole;
    const dir = (await tryRealPath(p.dirname(resolved))) ?? p.dirname(resolved);
    return p.resolve(dir, p.basename(resolved));
  } catch {
    return path;
  }
}

/** A file's logical path: its real directory plus its name, for a file that
 *  cannot itself be canonicalized (missing, or unreadable under a runtime
 *  whose realpath opens the file). `fallback` when the directory cannot be
 *  resolved either. */
async function logicalFilePath<F>(path: string, fallback: F): Promise<string | F> {
  try {
    const p = await loadPath();
    const resolved = p.resolve(path);
    const dir = await tryRealPath(p.dirname(resolved));
    return dir === null ? fallback : p.resolve(dir, p.basename(resolved));
  } catch {
    return fallback;
  }
}

/** Whether a file exists, without creating it (opening SQLite would). */
async function fileExists(path: string): Promise<boolean> {
  try {
    const fs = await loadFs();
    await fs.promises.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A store the card-only fallback found: read-only, or writable when no
 *  connection had it open in WAL mode. */
type CardOnlyStore =
  | { kind: "reader"; store: ReadStore; close: () => void; stamped: string }
  | { kind: "writable"; db: SqliteDb; store: Store; stamped: string };

/**
 * The card-only fallback for a source path that cannot be canonicalized:
 * open an EXISTING store, but only when its stamped `source_db` names the
 * same file (both compared as real directory plus name). It is opened with
 * the stamped string as its source identity, so the exact-string fence
 * matches and nothing is stamped; the caller must not distill into it.
 *
 * It opens a reader first ({@link openReadStore}), which takes no lock. Only
 * when the store has no WAL files beside it (`no-wal`), so no connection
 * anywhere holds it open, is it opened with a writable connection, for
 * existing layouts only: a store needing a migration or a rebuild is refused
 * untouched, since its cards cannot be rebuilt while the source is
 * unavailable. Null (and nothing created or written) when no store matches,
 * with `refused` set when a matching store was refused.
 */
async function openCardOnlyStore(
  storePath: string,
  located: string,
  wrapReader: ((db: ReadOnlyDb) => ReadOnlyDb) | undefined,
): Promise<CardOnlyStore | { refused: string } | null> {
  if (storePath === ":memory:") return null;
  const logical = await logicalFilePath(located, null);
  if (logical === null || !(await fileExists(storePath))) return null;
  const opened = await openReadStore(
    storePath,
    { host: STORE_HOST, source: located },
    {
      acceptSource: async (stamped) => (await logicalFilePath(stamped, stamped)) === logical,
      ...(wrapReader && { wrapReader }),
    },
  );
  if (opened.ok) {
    return {
      kind: "reader",
      store: opened.store,
      close: opened.close,
      stamped: opened.source ?? located,
    };
  }
  switch (opened.reason) {
    case "no-wal":
      return openStampedStore(storePath, logical);
    case "host-mismatch":
    case "source-mismatch":
    case "missing":
      return null;
    default:
      return { refused: opened.reason };
  }
}

/** {@link openCardOnlyStore}'s writable open, for a store no connection
 *  holds open. */
async function openStampedStore(
  storePath: string,
  logical: string,
): Promise<CardOnlyStore | { refused: string } | null> {
  const db = await openSqlite(storePath);
  if (!db) return null;
  const stamped = peekStoreIdentity(db);
  if (
    stamped.host === STORE_HOST &&
    stamped.source !== undefined &&
    (await logicalFilePath(stamped.source, stamped.source)) === logical
  ) {
    const opened = openStore(
      db,
      { host: STORE_HOST, source: stamped.source },
      { existingOnly: true },
    );
    if (opened.ok) return { kind: "writable", db, store: opened.store, stamped: stamped.source };
    closeQuietly(db);
    return { refused: opened.reason };
  }
  closeQuietly(db);
  return null;
}

/** Log what the schema check found that this build was not tested against
 *  (the log is the debug sink, so this shows only under `RECALL_DEBUG`). A
 *  database without `session_part` (opencode before 2.4) is not drift. */
function logSchemaDrift(schema: V2SchemaInfo, log: (message: string) => void): void {
  const notes: string[] = [];
  if (schema.missingOptional.length > 0) {
    notes.push(`part rows not read, the table lacks ${schema.missingOptional.join(", ")}`);
  }
  if (!schema.migrationTested) {
    notes.push(`untested newest migration ${schema.migration ?? "(unreadable)"}`);
  }
  if (schema.unknownTables.length > 0) {
    notes.push(`unknown history tables ${schema.unknownTables.join(", ")}`);
  }
  if (notes.length > 0) log(`opencode history drift: ${notes.join("; ")}`);
}

/** The read counts a drift snapshot holds, as one line; empty when every
 *  read projected faithfully. */
function readDriftLine(drift: HistoryDrift): string {
  const found = Object.entries(drift.counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name} ${count}`);
  if (drift.unknownPartTypeNames.length > 0) {
    found.push(`unknown part types ${drift.unknownPartTypeNames.join(", ")}`);
  }
  return found.join(", ");
}

/** This thread's drift with the worker's reads added in: reads and counts
 *  summed, unknown part types joined. The database's own fields (schema,
 *  migration, tables) are this thread's, read from the same file. */
function mergeDrift(main: HistoryDrift, worker: HistoryDrift | undefined): HistoryDrift {
  if (!worker) return main;
  const counts = { ...main.counts };
  addReadCounts(counts, worker.counts);
  const names = [...new Set([...main.unknownPartTypeNames, ...worker.unknownPartTypeNames])]
    .sort()
    .slice(0, UNKNOWN_TYPE_NAMES_CAP);
  return { ...main, reads: main.reads + worker.reads, counts, unknownPartTypeNames: names };
}

/** The numeric fields of the sync test options, which can cross a thread. */
function workerSyncOptions(sync: V2SyncOptions | undefined): WorkerSyncOptions | undefined {
  if (!sync) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(sync)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out as WorkerSyncOptions;
}

/**
 * The store reads a card source makes over main's reader. A reader never
 * waits on a lock, so a refresh's counter read that finds one reads as
 * "nothing changed" (the counters it last returned) and the next refresh
 * tries again; every other read throws {@link SqliteBusyError} to its caller.
 */
function cardReadsOf(reader: ReadStore): CardSourceStore {
  let last: CardCounters | undefined;
  return {
    allCards: (opts) => reader.allCards(opts),
    getMeta: (key) => reader.getMeta(key),
    cardCounters: () => {
      try {
        last = reader.cardCounters();
        return last;
      } catch (error) {
        if (error instanceof SqliteBusyError && last) return last;
        throw error;
      }
    },
    cardsSince: (rev, limit, opts) => reader.cardsSince(rev, limit, opts),
    cardSessionIds: () => reader.cardSessionIds(),
    cardsPage: (after, limit, opts) => reader.cardsPage(after, limit, opts),
    cardVectorsPage: (after, limit) => reader.cardVectorsPage(after, limit),
  };
}

/** What a distiller reports before it has said anything. */
function idleStatus(): DistillStatus {
  return {
    leaseHeld: false,
    coldPass: "idle",
    distilledCount: 0,
    knownCount: 0,
    examinedCount: 0,
    quarantinedCount: 0,
    skippedCount: 0,
    failingCount: 0,
  };
}

/** Close a handle, swallowing errors (a failed close must not reject dispose). */
function closeQuietly(db: Pick<SqliteDb, "close"> | null): void {
  try {
    db?.close();
  } catch {
    // Best-effort.
  }
}

/**
 * The registry factory for one attaching instance. `resolve` settles the real
 * store and source paths (the merge identity); `create` opens everything.
 */
export function v2RuntimeFactory(inputs: V2RuntimeInputs): RuntimeFactory<V2Runtime> {
  const { options } = inputs;
  /** Why no source path could be resolved, when `identity.source` is null. */
  let sourceProblem: string | undefined;

  return {
    async resolve(): Promise<ResolvedIdentity> {
      const located = await opencodeDbPath({
        channel: inputs.channel,
        override: options.opencodeDbPath,
      });
      // Read through the canonical path when there is one; otherwise the
      // located path may still be read, but create() will not stamp a store
      // with it (a later canonical spelling would refuse it forever).
      let source: string | null = null;
      let sourceCanonical = false;
      if (located.ok) {
        const real = await tryRealPath(located.path);
        source = real ?? located.path;
        sourceCanonical = real !== null;
      } else {
        sourceProblem = located.reason;
      }

      let store: string | null = null;
      if (!options.ephemeral) {
        const configured = options.storePath ?? (await defaultStorePath(STORE_HOST));
        if (configured) store = await realFilePath(configured);
      }
      return { store, source, sourceCanonical };
    },

    create: (identity) => createV2Runtime(identity, inputs, sourceProblem),

    dispose: (runtime) => runtime.dispose(),
  };
}

async function createV2Runtime(
  identity: ResolvedIdentity,
  inputs: V2RuntimeInputs,
  sourceProblem: string | undefined,
): Promise<V2Runtime> {
  const { options, log } = inputs;
  const limits: Limits = options.limits;

  // ── opencode.db (read-only) ──
  let opencodeDb: ReadOnlyDb | null = null;
  let schema: V2SchemaInfo | undefined;
  let unavailable: string | undefined;
  if (identity.source === null) {
    unavailable = sourceProblem ?? "no opencode database path";
  } else {
    const opened = await openOpencodeDb(identity.source);
    if (opened.ok) {
      opencodeDb = opened.db;
      schema = opened.schema;
    } else unavailable = opened.reason;
  }
  if (unavailable !== undefined) log(`opencode history unavailable: ${unavailable}`);

  // One schema and one drift state for every facade over the handle, and
  // the sync, so all of them report the same database the same way. A
  // worker's reads arrive with its status and are added in.
  let workerDrift: HistoryDrift | undefined;
  const ownDrift = schema ? createHistoryDriftState(v2DriftBase(schema)) : undefined;
  const drift: HistoryDriftState | undefined = ownDrift && {
    record: (counts, names) => ownDrift.record(counts, names),
    snapshot: () => mergeDrift(ownDrift.snapshot(), workerDrift),
  };
  if (schema) logSchemaDrift(schema, log);

  const facades = new Map<string, HistorySource>();
  const globalSource: HistorySource =
    opencodeDb && schema && drift
      ? createV2HistorySource(opencodeDb, { schema, drift })
      : createUnavailableSource("v2-sqlite", unavailable ?? "unknown");
  // A distiller on this thread reads through a global facade of its own
  // whose reads yield in the background, so a search reading or building
  // meanwhile goes first.
  const distillSource: HistorySource =
    opencodeDb && schema && drift
      ? createV2HistorySource(opencodeDb, { schema, drift, yieldBetween: yieldInBackground })
      : globalSource;
  const sourceFor = (projectID: string): HistorySource => {
    if (!opencodeDb || !schema || !drift) return globalSource;
    let facade = facades.get(projectID);
    if (!facade) {
      facade = createV2HistorySource(opencodeDb, { projectID, schema, drift });
      facades.set(projectID, facade);
    }
    return facade;
  };

  // ── Semantic layer (opt-in; never in ephemeral mode) ──
  let semantic: SemanticSearchConfig | undefined;
  let semanticReady: Promise<void> | undefined;
  if (options.semantic) {
    try {
      const { SemanticEmbedder } = await import("../semantic/embedder.js");
      const embedder = new SemanticEmbedder(options.semantic.model);
      semanticReady = embedder.init();
      semantic = { embedder, weight: options.semantic.weight };
    } catch {
      // Lexical-only.
    }
  }
  if (options.summaries) {
    log("summaries are not available on opencode v2 yet; the option is ignored");
  }

  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const operations = new Set<Promise<unknown>>();
  const track = <T>(operation: Promise<T>): Promise<T> => {
    operations.add(operation);
    void operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
    return operation;
  };

  // Every tool call counts in it, and so does each of the gate's queries; a
  // worker's background work gives way while it is non-zero.
  const foreground = createForegroundSignal();
  const gate = createFetchGate({ concurrency: limits.concurrency, foreground });

  const discover = (): Promise<HistorySession[]> => discoverSessions(globalSource, yieldOnBudget);
  const drill = createDrill({ source: globalSource, gate, limits });

  const instanceId =
    globalThis.crypto?.randomUUID?.() ??
    `recall-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // ── Store, cards and the distiller: what the tools read changes when the
  // worker's store opens later, or when the distiller moves to this thread.
  /** The store the tools read. */
  let store: ReadStore | null = null;
  /** A writable store this thread opened (inline distilling, or the
   *  card-only fallback when no connection held the store open). */
  let writableDb: SqliteDb | null = null;
  /** Main's reader, while the distiller runs in a worker or the card-only
   *  fallback reads. */
  let reader: { store: ReadStore; close: () => void } | null = null;
  let liteCards: Card[] = [];
  const liteSource: CardSource = {
    getCards: () => liteCards,
    revision: () => undefined,
    degraded: true,
  };
  let degradedReason: string | undefined;
  let revision = 0;
  let distillerMode: () => string | undefined = () => undefined;
  let distillerWarning: () => string | undefined = () => undefined;
  /** The distiller on this thread: inert unless it distills here. */
  let inline: Distiller = createDistiller({
    source: distillSource,
    store: null,
    gate,
    limits,
    instanceId,
  });
  let controller: WorkerController | undefined;
  /** Signals that arrive while the distiller moves to this thread, until the
   *  distiller there exists. */
  let handoff: EventOutbox | undefined;
  /** Why the distiller stopped after its move to this thread failed. */
  let inlineStopped: string | undefined;
  /** The real store path the worker distills into, when one runs. */
  let workerStore: string | undefined;

  const makeInline = (target: Store, takeOver?: string): Distiller =>
    createDistiller({
      source: distillSource,
      store: target,
      gate,
      limits,
      instanceId,
      build: V2_PLUGIN_BUILD,
      gen: EMBED_REPRESENTATION,
      // Cards built under an older projection are rebuilt by the repair
      // sweep, and range checks catch part-only changes.
      projectorGen: V2_PROJECTOR_GEN,
      ...(takeOver !== undefined && { takeOverLease: takeOver }),
      discover: () => discoverSessions(distillSource, yieldInBackground),
      log,
      // The poll, checkpoints and deletion reconcile keep the store fresh with
      // no events at all; the yields keep long passes off the shared loop and
      // behind a search's work.
      ...(opencodeDb && {
        sync: createV2Sync(opencodeDb, {
          yieldBetween: yieldInBackground,
          ...inputs.sync,
          ...(schema && { schema }),
        }),
      }),
      yieldBetween: yieldInBackground,
      ...(inputs.idleDebounceMs !== undefined && { idleDebounceMs: inputs.idleDebounceMs }),
    });

  const inWorker = (): boolean => controller !== undefined && controller.mode().kind === "worker";

  // The facade every caller holds: the worker's view from its status while
  // it runs there, the distiller on this thread otherwise.
  const distiller: Distiller = {
    start() {
      if (!inWorker()) inline.start();
    },
    quiesce() {
      controller?.quiesce();
      handoff = undefined;
      inline.quiesce();
    },
    ownsLease() {
      return inWorker() ? controller?.status()?.distill.leaseHeld === true : inline.ownsLease();
    },
    async stop() {
      if (controller && inWorker()) await controller.stop(SHUTDOWN_TIMEOUT_MS);
      else await inline.stop();
    },
    onEvent(signal) {
      if (controller && inWorker()) controller.post(signal);
      else if (handoff) handoff.add(signal);
      else inline.onEvent(signal);
    },
    status() {
      return inWorker() ? (controller?.status()?.distill ?? idleStatus()) : inline.status();
    },
    indexing() {
      return inWorker() ? controller?.status()?.indexing : inline.indexing();
    },
    repair() {
      return inWorker() ? controller?.status()?.repair : inline.repair();
    },
    discoveryTruncated() {
      return inWorker()
        ? controller?.status()?.discoveryTruncated === true
        : inline.discoveryTruncated();
    },
  };

  const makeCards = (source: CardSource): CardsRuntime =>
    createCardsRuntime({
      source,
      embedder: semantic?.embedder,
      semanticWeight: semantic?.weight,
      semanticModel: options.semantic?.model,
      semanticReady,
      pluginVersion: V2_PLUGIN_BUILD,
      log,
    });

  let liteRefresh: LiteRefreshController | undefined;
  /** The source the tools' card runtime reads. */
  let cardsSource: CardSource = liteSource;
  let cards: CardsRuntime = makeCards(liteSource);
  let deps: SearchDeps;
  let enrichment: SessionEnrichment | undefined;

  const rebuildDeps = (): void => {
    const liteRefreshHook = liteRefresh;
    deps = {
      gate,
      store,
      cards,
      drill,
      semantic,
      ...(options.ephemeral && { mode: "ephemeral" as const }),
      ...(liteRefreshHook && { maybeRefresh: () => liteRefreshHook.maybeRefresh() }),
      indexing: () => distiller.indexing(),
      history: () => drift?.snapshot(),
      repair: () => distiller.repair(),
      distiller: () => distillerMode(),
      distillerWarning: () => distillerWarning(),
      ...(degradedReason !== undefined && { cardsDegradedReason: degradedReason }),
    };
    const enriched = store;
    enrichment = enriched
      ? { cards: () => enriched.allCards(), indexing: () => distiller.indexing() }
      : undefined;
  };
  rebuildDeps();

  /** Serve the tools from `source` from now on, with `reason` for degraded
   *  cards. */
  const installCards = (source: CardSource, reason?: string): void => {
    const previous = cards;
    cardsSource = source;
    cards = makeCards(source);
    degradedReason = reason;
    rebuildDeps();
    revision++;
    previous.dispose();
  };

  let liteStarted = false;
  /** Fill the degraded card tier from one discovery of `opencode.db`. With
   *  `upkeep`, the discovery yields in the background, since no tool call
   *  waits on it. */
  const startLite = (upkeep = false): void => {
    if (liteStarted || !opencodeDb || options.ephemeral) return;
    liteStarted = true;
    const toLite = (list: HistorySession[]): Card[] =>
      cardsLiteFromSessions(list as Parameters<typeof cardsLiteFromSessions>[0]);
    void track(
      (upkeep ? discoverSessions(distillSource, yieldInBackground) : discover())
        .then((list) => {
          if (disposed) return;
          // Only the degraded tier reads these cards. A store-backed card
          // runtime installed since then has nothing to gain from them, and
          // an invalidate would force its full reload; a later return to
          // the degraded tier discovers again.
          if (cardsSource !== liteSource) {
            liteStarted = false;
            return;
          }
          liteCards = toLite(list);
          cards.invalidate();
        })
        .catch(() => {
          // Best-effort; cards-lite stays empty.
        }),
    );
  };

  /** Close `open` once every tool call running now has settled: those may
   *  still read through it, and a closed handle would fail them mid-read. */
  const closeAfterUsers = (open: { close: () => void }): void => {
    void Promise.allSettled([...operations]).then(() => closeQuietly({ close: open.close }));
  };

  // ── Derived store ──
  // Stamped with the real source path, so a store built from another
  // opencode.db refuses (`source-mismatch`) instead of being reconciled
  // against the wrong history. No source path, or one that could not be
  // canonicalized, means no store: the file is not even opened, so nothing
  // is stamped with a spelling a later run would refuse. (So an unresolvable
  // source, `:memory:` or an empty override, loses the card tier as well;
  // see createUnavailableSource.) One exception keeps the card tier when
  // opencode.db is missing or unreadable: an existing store stamped for the
  // same file is opened for cards only, never stamped or distilled into.
  // An in-memory store is private to the connection that opens it: neither a
  // worker's store nor main's reader could see the other's, so it runs here.
  const inMemoryStore = identity.store === ":memory:";
  const threadSafety =
    identity.store !== null &&
    identity.source !== null &&
    identity.sourceCanonical === true &&
    !inMemoryStore
      ? await sqliteThreadSafety()
      : undefined;
  if (identity.store !== null && identity.source !== null && identity.sourceCanonical !== true) {
    const fallback = await openCardOnlyStore(identity.store, identity.source, inputs.wrapReader);
    if (fallback && "kind" in fallback) {
      if (fallback.kind === "reader") {
        reader = { store: fallback.store, close: fallback.close };
        store = fallback.store;
        installCards(storeCardSource(cardReadsOf(fallback.store), undefined));
      } else {
        writableDb = fallback.db;
        store = fallback.store;
        installCards(storeCardSource(fallback.store, inlineVectorWriter(fallback.store)));
      }
      log(
        `opencode database path ${identity.source} could not be canonicalized; serving cards from the store stamped for ${fallback.stamped}, without distilling`,
      );
    } else {
      const refused = fallback?.refused
        ? ` (the store stamped for it was refused: ${fallback.refused})`
        : "";
      log(
        `opencode database path ${identity.source} could not be canonicalized${refused}; running degraded without a store`,
      );
    }
  } else if (
    identity.store !== null &&
    identity.source !== null &&
    opencodeDb &&
    inputs.worker !== false &&
    threadSafety !== 0 &&
    !inMemoryStore
  ) {
    const storePath = identity.store;
    const sourcePath = identity.source;
    const workerInputs = inputs.worker ?? {};
    const init: WorkerInit = {
      buildId: BUILD_ID,
      build: V2_PLUGIN_BUILD,
      representation: EMBED_REPRESENTATION,
      projectorGen: V2_PROJECTOR_GEN,
      storePath,
      sourcePath,
      limits,
      ...(inputs.sync && { sync: workerSyncOptions(inputs.sync) }),
      ...(inputs.idleDebounceMs !== undefined && { idleDebounceMs: inputs.idleDebounceMs }),
      foreground: foreground.buffer,
    };
    degradedReason = INDEX_STARTING_REASON;
    rebuildDeps();
    const fixHint = `Indexing resumes after OpenCode restarts; if it does not, quit every OpenCode process and delete ${storePath} (it rebuilds), or set a separate storePath.`;
    distillerMode = () => {
      if (inlineStopped !== undefined) return `stopped: ${inlineStopped}`;
      const mode = controller?.mode();
      if (!mode) return undefined;
      if (mode.kind === "worker") return mode.detail ? `worker: ${mode.detail}` : "worker";
      return `${mode.kind}: ${mode.reason}`;
    };
    distillerWarning = () => {
      const mode = controller?.mode();
      const reason = inlineStopped ?? (mode?.kind === "stopped" ? mode.reason : undefined);
      return reason !== undefined
        ? `New sessions are not being indexed: ${reason}. ${fixHint}`
        : undefined;
    };

    /** Indexing stops on this thread for `why`: logged, reported as
     *  `stopped` with the warning, and the cards already stored keep
     *  serving (the degraded tier's, without a store). */
    const stopOnMain = (why: string, detail: string): void => {
      log(
        `the distiller could not run on the main thread either (${detail}); serving the cards already stored`,
      );
      inlineStopped = why;
      if (!store) {
        // The degraded tier serves what discovery finds, without saying the
        // index is starting.
        startLite(true);
        installCards(liteSource);
      }
    };

    /** The distiller moves to this thread over a writable store, once the
     *  last worker's thread has ended. Until it exists, signals wait in
     *  {@link handoff}. */
    const goInline = (reason: string, lastHolder: string | undefined): void => {
      handoff = createEventOutbox();
      let previousReader: typeof reader = null;
      void (async () => {
        try {
          if (disposed) return;
          const db = await openSqlite(storePath);
          if (disposed) {
            closeQuietly(db);
            return;
          }
          const opened = db ? openStore(db, { host: STORE_HOST, source: sourcePath }) : undefined;
          if (!db || !opened || !opened.ok) {
            closeQuietly(db);
            const why = opened && !opened.ok ? opened.reason : "SQLite is unavailable";
            stopOnMain(`the store did not open on the main thread either (${why})`, why);
            return;
          }
          if (opened.warning !== undefined) log(opened.warning);
          writableDb = db;
          previousReader = reader;
          reader = null;
          store = opened.store;
          installCards(storeCardSource(opened.store, inlineVectorWriter(opened.store)));
          const next = makeInline(opened.store, lastHolder);
          inline = next;
          try {
            // The lease first: a deletion or a metadata patch is applied only
            // by the lease holder, and dropped otherwise, as by any distiller
            // that does not hold it (whose holder's polls and cold pass catch
            // it). A lease another process holds is no failure: the distiller
            // retries on its lease loop as every non-holder does. A throw,
            // such as a write lock held past the busy timeout, is one.
            if (limits.coldPass) next.start();
          } catch (error) {
            void next.stop();
            const why = errmsg(error);
            stopOnMain(`the distiller did not start on the main thread (${why})`, why);
            return;
          }
          const queued = [...(controller?.drainEvents() ?? []), ...(handoff?.drain() ?? [])];
          handoff = undefined;
          let failed = 0;
          for (const signal of queued) {
            try {
              next.onEvent(signal);
            } catch (error) {
              // The distiller runs on: its polls and its deletion reconcile
              // find what a signal it could not apply carried.
              if (failed++ === 0)
                log(`a queued signal failed on the main thread: ${errmsg(error)}`);
            }
          }
          if (failed > 1) log(`${failed} queued signals failed on the main thread`);
          log(`the distiller runs on the main thread (${reason})`);
        } catch (error) {
          const why = errmsg(error);
          stopOnMain(`the distiller did not start on the main thread (${why})`, why);
        } finally {
          handoff = undefined;
          if (previousReader) closeAfterUsers(previousReader);
        }
      })();
    };

    /** Open main's reader over the store, if none is open, and serve its
     *  cards. `quiet` logs no refusal, for an open ahead of the worker's. */
    const openReader = async (
      quiet: boolean,
    ): Promise<{ ok: true } | { ok: false; reason: string }> => {
      if (reader) return { ok: true };
      if (disposed) return { ok: false, reason: "the runtime is disposed" };
      const opened = await openReadStore(
        storePath,
        { host: STORE_HOST, source: sourcePath },
        { ...(inputs.wrapReader && { wrapReader: inputs.wrapReader }) },
      );
      if (!opened.ok) {
        const reason = `${opened.reason}${opened.detail ? `: ${opened.detail}` : ""}`;
        if (!quiet) log(`store reader refused (${reason}): ${storePath}`);
        return { ok: false, reason };
      }
      if (disposed || reader) {
        // Disposed meanwhile, or another open got there first.
        opened.close();
        return reader ? { ok: true } : { ok: false, reason: "the runtime is disposed" };
      }
      reader = { store: opened.store, close: opened.close };
      store = opened.store;
      const writer = controller?.writeVectors;
      installCards(storeCardSource(cardReadsOf(opened.store), writer));
      return { ok: true };
    };

    // An earlier runtime's worker on this store whose thread has not ended
    // yet: this one starts its own only after that, and its tools read the
    // store's cards meanwhile when a reader opens.
    const earlierWorker = pendingWorkerExit(storePath);
    workerStore = storePath;
    controller = createWorkerController({
      ...(earlierWorker && { startAfter: earlierWorker }),
      start: workerInputs.start ?? defaultWorkerStarter(),
      instanceId,
      init,
      log,
      onStoreOpen: () => openReader(false),
      onStopped(reason) {
        log(`store refused (${reason}): ${storePath}; running degraded`);
        if (!reader) {
          startLite(true);
          installCards(liteSource);
        }
      },
      onInline: goInline,
      onStatus(status) {
        workerDrift = status.drift;
      },
      onWaiting() {
        // Until the store opens, the degraded tier says why it is waiting.
        if (reader || disposed || degradedReason === STORE_LOCKED_REASON) return;
        degradedReason = STORE_LOCKED_REASON;
        rebuildDeps();
        revision++;
      },
      readLease: () => reader?.store.leaseStatus(),
      ...(workerInputs.restartDelaysMs && { restartDelaysMs: workerInputs.restartDelaysMs }),
      ...(workerInputs.readyTimeoutMs !== undefined && {
        readyTimeoutMs: workerInputs.readyTimeoutMs,
      }),
      ...(workerInputs.storeTimeoutMs !== undefined && {
        storeTimeoutMs: workerInputs.storeTimeoutMs,
      }),
      ...(workerInputs.watchdogEveryMs !== undefined && {
        watchdogEveryMs: workerInputs.watchdogEveryMs,
      }),
      ...(workerInputs.maxFailures !== undefined && { maxFailures: workerInputs.maxFailures }),
    });
    if (earlierWorker) void openReader(true);
    const settled = await settleWithin(controller.settled(), STORE_READY_WAIT_MS);
    // Still starting: serve what discovery finds until the store opens.
    if (settled.timedOut && !reader && controller.mode().kind === "worker") startLite(true);
  } else if (identity.store !== null && identity.source !== null) {
    const db = await openSqlite(identity.store);
    if (db) {
      const opened = openStore(db, { host: STORE_HOST, source: identity.source });
      if (opened.ok) {
        writableDb = db;
        store = opened.store;
        installCards(storeCardSource(opened.store, inlineVectorWriter(opened.store)));
        // No history, no distilling: the distiller does not start.
        if (opencodeDb) {
          inline = makeInline(opened.store);
          const reason = inMemoryStore
            ? STORE_IN_MEMORY_REASON
            : threadSafety === 0
              ? "sqlite is not thread-safe"
              : "the worker is turned off";
          distillerMode = () => `inline: ${reason}`;
        }
      } else {
        log(`store refused (${opened.reason}): ${identity.store}; running degraded`);
        closeQuietly(db);
      }
    }
  } else if (identity.store !== null) {
    log("no opencode database to pair the store with; running degraded");
  }

  if (!store && !controller && opencodeDb) {
    if (options.ephemeral) {
      const toLite = (list: HistorySession[]): Card[] =>
        cardsLiteFromSessions(list as Parameters<typeof cardsLiteFromSessions>[0]);
      liteRefresh = createLiteRefresh({
        list: async () => toLite(await discover()),
        assign: (next) => {
          liteCards = next;
        },
        invalidate: () => cards.invalidate(),
        runQuery: (fn) => gate.runQuery(fn),
        track,
        disposed: () => disposed,
      });
      rebuildDeps();
      void liteRefresh.initialRefresh();
    } else {
      startLite();
    }
  }

  // What reads could not project, logged when it changes (debug log only).
  let driftLogged = "";
  const logDrift = (): void => {
    const snapshot = drift?.snapshot();
    if (!snapshot) return;
    const line = readDriftLine(snapshot);
    if (line === driftLogged) return;
    driftLogged = line;
    if (line) log(`opencode history drift: ${line} (over ${snapshot.reads} reads)`);
  };
  const driftTimer = drift ? setInterval(logDrift, DRIFT_LOG_EVERY_MS) : undefined;
  // A Node or Bun timer must not keep the process alive on its own.
  (driftTimer as { unref?: () => void } | undefined)?.unref?.();
  if (limits.coldPass) distiller.start();
  const mapper = createV2EventMapper({ emit: (signal) => distiller.onEvent(signal) });

  const freshEvent = createIdDedupe();

  const parentOf = async (sessionID: string): Promise<string | null | undefined> => {
    if (!opencodeDb) return undefined;
    const lookup = await globalSource.getSession(sessionID, { scope: "global" });
    if (!lookup.ok) return undefined;
    return lookup.value.parentID ?? null;
  };

  return {
    options,
    gate,
    get store() {
      return store;
    },
    get cards() {
      return cards;
    },
    drill,
    distiller,
    get deps() {
      return deps;
    },
    get enrichment() {
      return enrichment;
    },
    unavailable,
    revision: () => revision,
    foreground,
    sourceFor,
    globalSource,
    parentOf,
    history: () => drift?.snapshot(),
    repair: () => distiller.repair(),
    track,
    onEvent(event) {
      if (disposed) return;
      if (typeof event?.id === "string" && !freshEvent(event.id)) return;
      mapper.map(event);
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      // No worker generation starts from here on, a pending restart included,
      // so the current one's thread is the last: a later runtime on this
      // store starts its worker only once that thread has ended.
      controller?.retire();
      if (controller && workerStore !== undefined) {
        noteWorkerExit(workerStore, controller.exited());
      }
      if (driftTimer !== undefined) clearInterval(driftTimer);
      mapper.dispose();
      distiller.quiesce();
      disposePromise = (async () => {
        const closeAll = (): void => {
          const open = reader;
          reader = null;
          if (open) closeQuietly({ close: open.close });
          closeQuietly(writableDb);
          writableDb = null;
          closeQuietly(opencodeDb);
          opencodeDb = null;
        };
        try {
          // Vector writes waiting to be sent to the worker, or to run here.
          await cards.flushVectorWrites(SHUTDOWN_TIMEOUT_MS);
          cards.dispose();
          if (controller && inWorker()) {
            await controller.stop(SHUTDOWN_TIMEOUT_MS);
          } else {
            await settleWithin(inline.stop(), SHUTDOWN_TIMEOUT_MS);
          }
          const ops = await settleWithin(Promise.allSettled([...operations]), SHUTDOWN_TIMEOUT_MS);
          // Every handle a tool call may still read through, the reader
          // included, closes only once those calls have settled; dispose
          // itself waits no longer than its bound.
          if (ops.timedOut) {
            log(
              `dispose: ${operations.size} operation(s) outlived the ${SHUTDOWN_TIMEOUT_MS}ms bound; deferring the SQLite close until they settle`,
            );
            void Promise.allSettled([...operations]).then(closeAll);
          } else {
            closeAll();
          }
        } catch (error) {
          log(`dispose failed: ${errmsg(error)}`);
          void Promise.allSettled([...operations]).then(closeAll);
        }
        // The runtime stays retiring until the worker's thread has ended, so
        // a runtime replacing it on the same store waits for that.
        await controller?.terminate(WORKER_EXIT_WAIT_MS);
      })();
      return disposePromise;
    },
  };
}
