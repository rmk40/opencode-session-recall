import { createFetchGate, type FetchGate } from "../fetch-gate.js";
import { openSqlite, type ReadOnlyDb, type SqliteDb } from "../sqlite.js";
import {
  openStore,
  peekStoreIdentity,
  defaultStorePath,
  pluginBuild,
  SEMANTIC_MODEL_KEY,
  VECTORS_REV_KEY,
  type Store,
  type StoreHost,
  type Card,
} from "../store.js";
import { EMBED_REPRESENTATION } from "../embedding-text.js";
import {
  createCardsRuntime,
  cardsLiteFromSessions,
  type CardSource,
  type CardsRuntime,
} from "../cards.js";
import { createLiteRefresh, type LiteRefreshController } from "../lite-refresh.js";
import { createDrill, type Drill } from "../drill.js";
import { createDistiller, type Distiller, type RepairStatus } from "../distill.js";
import type { HistorySession } from "../history/model.js";
import {
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
import type { SearchDeps, SemanticSearchConfig } from "../search.js";
import type { SessionEnrichment } from "../sessions.js";
import type { ResolvedOptions } from "../options.js";
import { errmsg, settleWithin, type Limits } from "../types.js";
import { loadFs, loadPath } from "../node-import.js";
import type { V2Event } from "./opencode-v2-types.js";
import { createIdDedupe, type ResolvedIdentity, type RuntimeFactory } from "./runtime.js";

/**
 * The v2 host's process runtime: everything that must exist once per process
 * rather than once per location. Created by {@link v2RuntimeFactory} inside
 * the registry's deferred init (never on `setup`'s admission path), shared by
 * every attached instance, and disposed by the last one to detach.
 *
 * The runtime reads opencode's own `opencode.db` read-only. The distiller uses
 * a global facade over it (the v2 store is one per process and discovers every
 * project); each instance gets a facade bound to its own opencode project id
 * through {@link V2Runtime.sourceFor}.
 */

const STORE_HOST: StoreHost = "opencode-v2";
/** Build tag recorded in the lease and `coverage.semantic.pluginVersion`. */
export const V2_PLUGIN_BUILD = pluginBuild(STORE_HOST, V2_PROJECTOR_GEN);
/** Per-phase bound on dispose's awaited waits (as on v1). */
const SHUTDOWN_TIMEOUT_MS = 2_500;
/** Sessions per discovery page. */
const DISCOVERY_PAGE = 2_000;
/** How often the runtime compares the history drift with what it last
 *  logged. */
const DRIFT_LOG_EVERY_MS = 5 * 60_000;

/** The runtime-shaping options: first writer wins (see `runtime.ts`). */
export type V2RuntimeOptions = Pick<
  ResolvedOptions,
  "ephemeral" | "storePath" | "opencodeDbPath" | "semantic" | "limits"
> & { summaries: boolean };

export type V2Runtime = {
  readonly options: V2RuntimeOptions;
  readonly gate: FetchGate;
  readonly store: Store | null;
  readonly cards: CardsRuntime;
  readonly drill: Drill;
  readonly distiller: Distiller;
  /** Base search deps; `recall` reads the source's `unavailable` reason. */
  readonly deps: SearchDeps;
  readonly enrichment: SessionEnrichment | undefined;
  /** Set when `opencode.db` cannot be read. */
  readonly unavailable: string | undefined;
  /** The history facade scoped to one opencode project. */
  sourceFor(projectID: string): HistorySource;
  /** The distiller's facade: no project, global listings only. */
  readonly globalSource: HistorySource;
  /** A session's parent id (`null` for a root), or undefined when unknown. */
  parentOf(sessionID: string): Promise<string | null | undefined>;
  /**
   * How `opencode.db` differs from what this build reads (capabilities,
   * migration, unknown tables, and what reads could not project), summed
   * over every facade's reads: the same state each facade's `history()`
   * returns. Undefined when `opencode.db` is unavailable.
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

export type V2RuntimeInputs = {
  options: V2RuntimeOptions;
  /** `ctx.app.channel` of the attaching instance (process-wide). */
  channel: string;
  log: (message: string) => void;
  /** Test affordance: poll timing and the like. */
  sync?: V2SyncOptions;
  /** Test affordance: the distiller's idle debounce. */
  idleDebounceMs?: number;
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

/**
 * The card-only fallback for a source path that cannot be canonicalized:
 * open an EXISTING store, but only when its stamped `source_db` names the
 * same file (both compared as real directory plus name). The store is opened
 * with the stamped string as its source identity, so the exact-string fence
 * matches and nothing is stamped; the caller must not distill into it.
 * Null (and nothing created or written) in every other case, with
 * `refused` set when a matching store was refused by openStore.
 */
async function openStampedStore(
  storePath: string,
  located: string,
): Promise<{ db: SqliteDb; store: Store; stamped: string } | { refused: string } | null> {
  if (storePath === ":memory:") return null;
  const logical = await logicalFilePath(located, null);
  if (logical === null || !(await fileExists(storePath))) return null;
  const db = await openSqlite(storePath);
  if (!db) return null;
  const stamped = peekStoreIdentity(db);
  if (
    stamped.host === STORE_HOST &&
    stamped.source !== undefined &&
    (await logicalFilePath(stamped.source, stamped.source)) === logical
  ) {
    // Existing layout only: a store needing a migration or a rebuild is
    // refused untouched, never rebuilt, since its cards cannot be rebuilt
    // while the source is unavailable.
    const opened = openStore(
      db,
      { host: STORE_HOST, source: stamped.source },
      { existingOnly: true },
    );
    if (opened.ok) return { db, store: opened.store, stamped: stamped.source };
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
  // the sync, so all of them report the same database the same way.
  const drift: HistoryDriftState | undefined = schema
    ? createHistoryDriftState(v2DriftBase(schema))
    : undefined;
  if (schema) logSchemaDrift(schema, log);

  const facades = new Map<string, HistorySource>();
  const globalSource: HistorySource =
    opencodeDb && schema && drift
      ? createV2HistorySource(opencodeDb, { schema, drift })
      : createUnavailableSource("v2-sqlite", unavailable ?? "unknown");
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
  let store: Store | null = null;
  let db: SqliteDb | null = null;
  /** The store was opened read-for-cards through the stamped source. */
  let cardsOnly = false;
  if (identity.store !== null && identity.source !== null && identity.sourceCanonical !== true) {
    const fallback = await openStampedStore(identity.store, identity.source);
    if (fallback && "store" in fallback) {
      ({ db, store } = fallback);
      cardsOnly = true;
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
  } else if (identity.store !== null && identity.source !== null) {
    db = await openSqlite(identity.store);
    if (db) {
      const opened = openStore(db, { host: STORE_HOST, source: identity.source });
      if (opened.ok) store = opened.store;
      else {
        log(`store refused (${opened.reason}): ${identity.store}; running degraded`);
        closeQuietly(db);
        db = null;
      }
    }
  } else if (identity.store !== null) {
    log("no opencode database to pair the store with; running degraded");
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

  const gate = createFetchGate({ concurrency: limits.concurrency });

  const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  // The distiller and cards-lite always discover globally: one store per
  // process serves every location. The listing pages by the immutable
  // session id, so a session updated during the walk is neither skipped nor
  // listed twice, and it has no overall cap. Archived sessions are included
  // in both: archiving hides a session from opencode's list but keeps its
  // history, which is still past work to recall, and cards-lite (the
  // store-less mode) then covers the same sessions the store does.
  const discover = async (): Promise<HistorySession[]> => {
    const sessions: HistorySession[] = [];
    let after: string | undefined;
    for (;;) {
      const listing = await globalSource.listSessions({
        scope: "global",
        limit: DISCOVERY_PAGE,
        order: "id",
        archived: "include",
        ...(after !== undefined && { after }),
      });
      if (!listing.ok) throw new Error(listing.error);
      sessions.push(...listing.items);
      if (!listing.truncated || listing.nextCursor === undefined) return sessions;
      after = listing.nextCursor;
      await macrotask();
    }
  };

  let liteCards: Card[] = [];
  const cardSource: CardSource = store
    ? {
        getCards: (embOpts) => store.allCards(embOpts),
        revision: () => store.getMeta("cards_rev"),
        vectorsRevision: () => store.getMeta(VECTORS_REV_KEY),
        semanticModel: () => store.getMeta(SEMANTIC_MODEL_KEY),
        writeEmbeddings: (model, gen, rows) => store.writeCardEmbeddings(model, gen, rows),
      }
    : { getCards: () => liteCards, revision: () => undefined, degraded: true };

  const cards = createCardsRuntime({
    source: cardSource,
    embedder: semantic?.embedder,
    semanticWeight: semantic?.weight,
    semanticModel: options.semantic?.model,
    semanticReady,
    pluginVersion: V2_PLUGIN_BUILD,
  });

  let liteRefresh: LiteRefreshController | undefined;
  if (!store && opencodeDb) {
    const toLite = (list: HistorySession[]): Card[] =>
      cardsLiteFromSessions(list as Parameters<typeof cardsLiteFromSessions>[0]);
    if (options.ephemeral) {
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
      void liteRefresh.initialRefresh();
    } else {
      void track(
        discover()
          .then((list) => {
            if (!disposed) {
              liteCards = toLite(list);
              cards.invalidate();
            }
          })
          .catch(() => {
            // Best-effort; cards-lite stays empty.
          }),
      );
    }
  }

  const drill = createDrill({ source: globalSource, gate, limits });

  const instanceId =
    globalThis.crypto?.randomUUID?.() ??
    `recall-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const distiller = createDistiller({
    source: globalSource,
    // No history, no distilling: the distiller does not start. Nor for a
    // store opened for cards only: its source path is not canonical.
    store: opencodeDb && !cardsOnly ? store : null,
    gate,
    limits,
    instanceId,
    build: V2_PLUGIN_BUILD,
    gen: EMBED_REPRESENTATION,
    // Cards built under an older projection are rebuilt by the repair
    // sweep, and range checks catch part-only changes.
    projectorGen: V2_PROJECTOR_GEN,
    discover,
    log,
    // The poll, checkpoints and deletion reconcile keep the store fresh with
    // no events at all; the yields keep long passes off the shared loop.
    ...(opencodeDb && {
      sync: createV2Sync(opencodeDb, { ...inputs.sync, ...(schema && { schema }) }),
    }),
    yieldBetween: macrotask,
    ...(inputs.idleDebounceMs !== undefined && { idleDebounceMs: inputs.idleDebounceMs }),
  });
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

  const liteRefreshHook = liteRefresh;
  const deps: SearchDeps = {
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
  };
  const enrichment: SessionEnrichment | undefined = store
    ? { cards: () => store.allCards(), indexing: () => distiller.indexing() }
    : undefined;

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
    store,
    cards,
    drill,
    distiller,
    deps,
    enrichment,
    unavailable,
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
      if (driftTimer !== undefined) clearInterval(driftTimer);
      mapper.dispose();
      distiller.quiesce();
      cards.dispose();
      disposePromise = (async () => {
        const closeAll = (): void => {
          closeQuietly(db);
          db = null;
          closeQuietly(opencodeDb);
          opencodeDb = null;
        };
        try {
          await settleWithin(distiller.stop(), SHUTDOWN_TIMEOUT_MS);
          const ops = await settleWithin(Promise.allSettled([...operations]), SHUTDOWN_TIMEOUT_MS);
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
          closeAll();
        }
      })();
      return disposePromise;
    },
  };
}
