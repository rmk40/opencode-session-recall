import { createFetchGate, type FetchGate } from "../fetch-gate.js";
import { openSqlite, type SqliteDb } from "../sqlite.js";
import {
  openStore,
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
import { createDistiller, type Distiller } from "../distill.js";
import type { HistorySession } from "../history/model.js";
import { createUnavailableSource, type HistorySource } from "../history/source.js";
import { createV2HistorySource, openOpencodeDb } from "../history/v2.js";
import { opencodeDbPath } from "../history/v2-path.js";
import { createV2Sync, type V2SyncOptions } from "../history/v2-sync.js";
import { createV2EventMapper } from "../history/v2-events.js";
import type { SearchDeps, SemanticSearchConfig } from "../search.js";
import type { SessionEnrichment } from "../sessions.js";
import type { ResolvedOptions } from "../options.js";
import { DISCOVERY_LIMIT, errmsg, settleWithin, type Limits } from "../types.js";
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
export const V2_PLUGIN_BUILD = pluginBuild(STORE_HOST);
/** Per-phase bound on dispose's awaited waits (as on v1). */
const SHUTDOWN_TIMEOUT_MS = 2_500;

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

async function realPathOf(path: string): Promise<string> {
  try {
    const fs = await loadFs();
    return await fs.promises.realpath(path);
  } catch {
    return path;
  }
}

/** The real path of a file that may not exist yet: its real directory plus
 *  its name. `:memory:` stays as is. */
async function realFilePath(path: string): Promise<string> {
  if (path === ":memory:") return path;
  try {
    const p = await loadPath();
    const resolved = p.resolve(path);
    return p.resolve(await realPathOf(p.dirname(resolved)), p.basename(resolved));
  } catch {
    return path;
  }
}

/** Close a handle, swallowing errors (a failed close must not reject dispose). */
function closeQuietly(db: SqliteDb | null): void {
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
      let source: string | null = null;
      if (located.ok) source = await realPathOf(located.path);
      else sourceProblem = located.reason;

      let store: string | null = null;
      if (!options.ephemeral) {
        const configured = options.storePath ?? (await defaultStorePath(STORE_HOST));
        if (configured) store = await realFilePath(configured);
      }
      return { store, source };
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
  let opencodeDb: SqliteDb | null = null;
  let unavailable: string | undefined;
  if (identity.source === null) {
    unavailable = sourceProblem ?? "no opencode database path";
  } else {
    const opened = await openOpencodeDb(identity.source);
    if (opened.ok) opencodeDb = opened.db;
    else unavailable = opened.reason;
  }
  if (unavailable !== undefined) log(`opencode history unavailable: ${unavailable}`);

  const facades = new Map<string, HistorySource>();
  const globalSource: HistorySource = opencodeDb
    ? createV2HistorySource(opencodeDb)
    : createUnavailableSource("v2-sqlite", unavailable ?? "unknown");
  const sourceFor = (projectID: string): HistorySource => {
    if (!opencodeDb) return globalSource;
    let facade = facades.get(projectID);
    if (!facade) {
      facade = createV2HistorySource(opencodeDb, { projectID });
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
  // against the wrong history. No source path at all means no store.
  let store: Store | null = null;
  let db: SqliteDb | null = null;
  if (identity.store !== null && identity.source !== null) {
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

  // The distiller and cards-lite always discover globally: one store per
  // process serves every location.
  const discover = async (): Promise<HistorySession[]> => {
    const listing = await globalSource.listSessions({ scope: "global", limit: DISCOVERY_LIMIT });
    if (!listing.ok) throw new Error(listing.error);
    return listing.items;
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

  const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const distiller = createDistiller({
    source: globalSource,
    // No history, no distilling: the distiller does not start.
    store: opencodeDb ? store : null,
    gate,
    limits,
    instanceId,
    build: V2_PLUGIN_BUILD,
    gen: EMBED_REPRESENTATION,
    discover,
    log,
    // The poll, checkpoints and deletion reconcile keep the store fresh with
    // no events at all; the yields keep long passes off the shared loop.
    ...(opencodeDb && { sync: createV2Sync(opencodeDb, inputs.sync) }),
    yieldBetween: macrotask,
    ...(inputs.idleDebounceMs !== undefined && { idleDebounceMs: inputs.idleDebounceMs }),
  });
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
  };
  const enrichment: SessionEnrichment | undefined = store
    ? { cards: () => store.allCards() }
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
    track,
    onEvent(event) {
      if (disposed) return;
      if (typeof event?.id === "string" && !freshEvent(event.id)) return;
      mapper.map(event);
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
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
