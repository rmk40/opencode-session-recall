import type { Plugin, ToolDefinition, ToolResult } from "./opencode-v1-types.js";
import { sessions, type SessionEnrichment } from "../sessions.js";
import { search, DISCOVERY_LIMIT, type SearchDeps, type SemanticSearchConfig } from "../search.js";
import { get } from "../get.js";
import { context } from "../context.js";
import { messages } from "../messages.js";
import { systemNudge } from "../hooks/system-nudge.js";
import { autoRecall } from "../hooks/auto-recall.js";
import { compactionRecall } from "../hooks/compaction-recall.js";
import { createFetchGate } from "../fetch-gate.js";
import { openSqlite, type SqliteDb } from "../sqlite.js";
import {
  openStore,
  defaultStorePath,
  pluginBuild,
  SEMANTIC_MODEL_KEY,
  VECTORS_REV_KEY,
  type Store,
  type StoreHost,
  type StoreIdentity,
  type Card,
} from "../store.js";
import { EMBED_REPRESENTATION } from "../embedding-text.js";
import { createCardsRuntime, cardsLiteFromSessions, type CardSource } from "../cards.js";
import { createLiteRefresh, type LiteRefreshController } from "../lite-refresh.js";
import { createDrill } from "../drill.js";
import type { HistorySession } from "../history/model.js";
import { v1EventToSignal } from "../history/v1-events.js";
import { createDistiller } from "../distill.js";
import { createSummarizer, type Summarizer } from "../summarize.js";
import { parseOptions } from "../options.js";
import { consoleSink, createLogger } from "../log.js";
import { registry } from "./registry.js";
import { TOOLS, errmsg, settleWithin, type ErrorOutput } from "../types.js";
import { boundResult } from "../output.js";

/** Per-phase bound on dispose()'s awaited waits. The host awaits dispose as a
 *  shutdown finalizer with no timeout of its own, so a never-settling in-flight
 *  SDK request must not hang shutdown forever. Two bounded phases (distiller
 *  stop, tracked operations) after the summarizer's own 15s bound keep total
 *  dispose under ~20s worst case. Timed-out work is detached, not cancelled;
 *  every store write path re-checks stopped/finalized/lease ownership before
 *  writing, so closing SQLite with a detached fetch pending is safe. */
const SHUTDOWN_TIMEOUT_MS = 2_500;

/** v1 plugin log: `[recall] `-prefixed lines on the host console. */
const pluginLog = createLogger(consoleSink);

/** The store identity this entry opens with (see {@link StoreIdentity}): the
 *  v1 host, which has no source database. */
const STORE_IDENTITY: StoreIdentity = { host: "opencode-v1" };
const STORE_HOST: StoreHost = STORE_IDENTITY.host;

/**
 * Plugin build tag — recorded in the distill lease and surfaced in
 * `coverage.semantic.pluginVersion`, so a store shared by mixed-version processes
 * can be diagnosed from one lease read / one tool response.
 *
 * DEVIATION (see the plan's build-tag decision): this is NOT the package.json
 * semver. `src/` cannot read package.json cleanly — `tsconfig` sets `rootDir` to
 * `./src` and leaves `resolveJsonModule` off, so importing `../package.json` fails
 * `tsc`, and a hand-copied version const would drift silently on release (the
 * `npm version` flow only touches package.json). The tag is instead derived from
 * the constants that actually gate mixed-version safety — the schema version,
 * the embedding representation generation and the host — so it never lies about
 * the fence dimensions and needs no release-step upkeep. Swap in a real version
 * here if one can ever be sourced without a Node import.
 */
const PLUGIN_BUILD = pluginBuild(STORE_HOST);

/**
 * The v1 host entry (`@opencode-ai/plugin` 1.3.4+): `server(ctx, options)`
 * returns the tool map and hooks. The v1 history adapter (and with it the SDK
 * client) is loaded lazily, so a v2 host never evaluates it.
 */
export const server: Plugin = async (ctx, options) => {
  // First, before any await: a v2-shaped setup() the v1.18 external layer runs
  // in this process can then see it is not on a v2 host (second check only).
  registry().v1ServerActive = true;
  const {
    primary,
    global,
    nudge,
    autoRecall: autoRecallEnabled,
    compactionRecall: compactionRecallEnabled,
    ephemeral,
    storePath: configuredStorePath,
    semantic: semanticOptions,
    summaries: summariesOptions,
    limits,
    warnings,
  } = parseOptions(options);
  for (const warning of warnings) pluginLog(warning);

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

  // Every history read goes through `source`; the scoped client itself is
  // still handed to the summarizer, which prompts worker sessions with it.
  const { createV1Clients, createV1HistorySource } = await import("../history/v1.js");
  const { scoped: client, unscoped } = createV1Clients(ctx);
  const source = createV1HistorySource({ scoped: client, unscoped });

  // Opt-in, local-only semantic layer. Off by default; any failure to load the
  // embedder module or construct the model degrades to a plain cache with no
  // semantic signal (lexical-only). init() is fired and forgotten — it never
  // throws to callers, and searches stay lexical until the model warms.
  let semantic: SemanticSearchConfig | undefined;
  let semanticModel: string | undefined;
  let semanticReady: Promise<void> | undefined;
  // Ephemeral force-disables the semantic layer: SemanticEmbedder.init() runs
  // BEFORE the store block and eagerly writes model weights under the cache
  // dir, which would violate the mode's zero-artifact contract.
  if (semanticOptions) {
    try {
      const { SemanticEmbedder } = await import("../semantic/embedder.js");
      const model = semanticOptions.model;
      const embedder = new SemanticEmbedder(model);
      // Idempotent: start loading and keep the promise so the card runtime can
      // run its first embed pass the moment the model is ready.
      semanticReady = embedder.init();
      semantic = { embedder, weight: semanticOptions.weight };
      semanticModel = model;
    } catch {
      // Plain cache, no semantic.
    }
  }

  // Session discovery for the distiller cold pass: global scope reads the
  // unscoped experimental list, otherwise the directory-scoped list. Always
  // sends an explicit limit (the server defaults to 100 rows).
  const discover = async (): Promise<HistorySession[]> => {
    const listing = await source.listSessions({
      scope: global ? "global" : "project",
      limit: DISCOVERY_LIMIT,
    });
    if (!listing.ok) throw new Error(listing.error);
    return listing.items;
  };

  // ── Card store (Tier 0) ──
  // The derived, versioned store is the sole persistence. If SQLite is
  // unavailable (no driver, unwritable dir) or openStore refuses the file (a
  // newer schema, another host's store, or an open error), `store` stays null
  // and the plugin degrades to ephemeral cards-lite built from the session
  // list; a refusal also logs its reason once. In configured ephemeral mode the
  // whole open sequence — including defaultStorePath(), which mkdirs the cache
  // dir — is skipped: `store`/`db` stay null by construction.
  let store: Store | null = null;
  let db: SqliteDb | null = null;
  if (!ephemeral) {
    const storePath = configuredStorePath ?? (await defaultStorePath(STORE_HOST));
    if (storePath) {
      db = await openSqlite(storePath);
      if (db) {
        const opened = openStore(db, STORE_IDENTITY);
        if (opened.ok) store = opened.store;
        else {
          pluginLog(`store refused (${opened.reason}): ${storePath}; running degraded`);
          // A refused store is never read or written, so release its handle now
          // rather than holding a lock-capable connection until dispose.
          try {
            db.close();
          } catch {
            // Best-effort: degraded mode does not depend on the close.
          }
          db = null;
        }
      }
    }
  }

  // Degraded cards-lite: fetch the session list once (best-effort) and keep
  // metadata-only cards in memory. The tier-1 runtime reads the live array.
  // Configured ephemeral mode additionally wires the refresh controller so
  // the snapshot self-heals (sessions created after init become visible); the
  // accidental driver-missing degraded path keeps the frozen one-shot snapshot.
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
  let liteRefresh: LiteRefreshController | undefined;
  if (!store) {
    if (ephemeral) {
      liteRefresh = createLiteRefresh({
        list: async () =>
          cardsLiteFromSessions((await discover()) as Parameters<typeof cardsLiteFromSessions>[0]),
        assign: (next) => {
          liteCards = next;
        },
        // `cards` and `gate` are declared BELOW this block (the CardSource
        // literal must exist before the runtime, and the gate block follows) —
        // resolve them lazily in closures that only run after init completes.
        // Capturing either eagerly here would hit the TDZ; do not reorder.
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
            if (!disposed)
              liteCards = cardsLiteFromSessions(
                list as Parameters<typeof cardsLiteFromSessions>[0],
              );
          })
          .catch(() => {
            // Best-effort; a failed list just leaves cards-lite empty until retried.
          }),
      );
    }
  }

  // One shared fetch gate gates every SDK call in the query/distill paths so the
  // plugin never opens more than `concurrency` server connections at once.
  const gate = createFetchGate({ concurrency: limits.concurrency });

  const cards = createCardsRuntime({
    source: cardSource,
    embedder: semantic?.embedder,
    semanticWeight: semantic?.weight,
    semanticModel,
    semanticReady,
    pluginVersion: PLUGIN_BUILD,
  });
  const drill = createDrill({ source, gate, limits });

  const instanceId =
    globalThis.crypto?.randomUUID?.() ??
    `recall-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Path B summarizer (opt-in). The distiller drives it — after the cold pass and
  // on the idle-debounce re-distill path — so it only ever runs while this
  // process holds the distill lease.
  let summarizer: Summarizer | undefined;
  const distiller = createDistiller({
    source,
    store,
    gate,
    limits,
    instanceId,
    build: PLUGIN_BUILD,
    gen: EMBED_REPRESENTATION,
    discover,
    // Yield between sessions and inside a card's derivation, so a large
    // session never holds the host's event loop in one slice.
    yieldBetween: () => new Promise((resolve) => setTimeout(resolve, 0)),
    onColdPassDone: () => {
      if (!disposed && summarizer) {
        // Summarizer.stop() owns the bounded shutdown of this drain. Do not add
        // it to the plugin's general operation set, which is intentionally
        // unbounded for DB-capable hooks and distiller work.
        void summarizer
          .runColdPass()
          .catch((error) => pluginLog(`summarizer cold pass failed: ${errmsg(error)}`));
      }
    },
    onSessionDistilled: (sessionId) => {
      if (!disposed) summarizer?.queue(sessionId);
    },
  });
  if (store && summariesOptions) {
    if (summariesOptions.config) {
      summarizer = createSummarizer({
        client,
        store,
        gate,
        config: summariesOptions.config,
        ownerToken: instanceId,
        leaseHeld: () => distiller.ownsLease(),
        log: pluginLog,
      });
    } else {
      // Never guess a model; disable with a one-time note.
      pluginLog(
        'summaries enabled but "model" is missing or malformed (expected "providerID/modelID"); summaries disabled',
      );
    }
  }
  if (limits.coldPass) distiller.start();

  const liteRefreshHook = liteRefresh;
  const deps: SearchDeps = {
    gate,
    store,
    cards,
    drill,
    semantic,
    // Configured, never derived from store === null: the accidental degraded
    // path must keep its existing behavior and wording.
    ...(ephemeral && { mode: "ephemeral" as const }),
    ...(liteRefreshHook && { maybeRefresh: () => liteRefreshHook.maybeRefresh() }),
    indexing: () => distiller.indexing(),
  };
  // recall_sessions serves the card store directly when it exists (digest, top
  // files/tools, family rollups); degraded mode leaves listings bare.
  const enrichment: SessionEnrichment | undefined = store
    ? { cards: () => store.allCards(), indexing: () => distiller.indexing() }
    : undefined;

  // The backstop: whatever a tool returns or rejects with, OpenCode never
  // receives a result it would cut (see `boundResult`). A rejection becomes
  // a JSON error output like every other failure.
  const bounded = (result: ToolResult): ToolResult =>
    typeof result === "string"
      ? boundResult(result)
      : { ...result, output: boundResult(result.output) };
  const rejected = (error: unknown): ToolResult => {
    const err: ErrorOutput = { ok: false, error: errmsg(error) };
    return boundResult(JSON.stringify(err));
  };

  const guardTool = (definition: ToolDefinition): ToolDefinition => ({
    ...definition,
    execute: (args, context) => {
      if (disposed) {
        // Match every other failure in this codebase: a JSON error output, not
        // a rejection.
        const err: ErrorOutput = {
          ok: false,
          error: "opencode-session-recall: plugin has been disposed",
        };
        return Promise.resolve(JSON.stringify(err));
      }
      return track(definition.execute(args, context)).then(bounded, rejected);
    },
  });

  const guardHook =
    <TArgs extends unknown[]>(
      hook: (...args: TArgs) => Promise<void>,
    ): ((...args: TArgs) => Promise<void>) =>
    async (...args) => {
      if (disposed) return;
      await track(hook(...args));
    };

  const nudgeHook = nudge ? systemNudge() : undefined;
  const autoRecallHook = autoRecallEnabled ? autoRecall(deps) : undefined;
  const compactionHook = compactionRecallEnabled ? compactionRecall(deps) : undefined;

  return {
    tool: {
      recall_sessions: guardTool(sessions(source, global, limits, enrichment)),
      recall: guardTool(search(source, global, limits, deps)),
      recall_get: guardTool(get(source, gate)),
      recall_context: guardTool(context(source, gate, limits)),
      recall_messages: guardTool(messages(source, gate, limits)),
    },
    event: async ({ event }) => {
      if (disposed) return;
      // The plugin `event` hook is typed against the default SDK vintage; the
      // mapper compiles against the v2 event union the live bus actually
      // delivers. Bridge the vintage gap at this one boundary.
      const signal = v1EventToSignal(event as unknown as Parameters<typeof v1EventToSignal>[0]);
      if (signal) distiller.onEvent(signal);
    },
    ...(nudgeHook && {
      "experimental.chat.system.transform": guardHook(nudgeHook),
    }),
    ...(autoRecallHook && {
      "chat.message": guardHook(autoRecallHook),
    }),
    ...(compactionHook && {
      "experimental.session.compacting": guardHook(compactionHook),
    }),
    ...(primary && {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- opencode config type not exported
      config: async (c: any) => {
        if (disposed) return;
        c.experimental ??= {};
        const existing: string[] = c.experimental.primary_tools ?? [];
        const deduped = new Set(existing);
        for (const t of TOOLS) deduped.add(t);
        c.experimental.primary_tools = [...deduped];
      },
    }),
    dispose: () => {
      if (disposePromise) return disposePromise;
      disposed = true;
      // Phase 1 is synchronous: no distill/retry/incremental work can start
      // after dispose() returns its promise. The heartbeat deliberately remains
      // active so lease-owned summarizer cleanup can finish safely.
      distiller.quiesce();
      cards.dispose();
      disposePromise = (async () => {
        // Summarizer.stop() is internally bounded (its own 15s shutdown
        // timeout). Its late SDK promises are detached and ownership/lease
        // guarded, so phase 2 may safely release the lease once this settles
        // even when an SDK request itself never does. The catch covers the rare
        // rejecting drain (e.g. a store write threw) — shutdown must not care.
        if (summarizer) await summarizer.stop().catch(() => {});
        // Bound the remaining waits: an SDK request that never settles would
        // otherwise hang the host's shutdown (dispose is awaited untimed).
        //
        // The two waits differ in what protects a detached continuation:
        // - Distiller work is finalized/lease-guarded before every store
        //   read/write, so a distiller fetch that settles after the timeout can
        //   never reach SQLite. Closing after a distiller timeout is safe.
        // - `operations` tracks FOREGROUND tool executions, which have no such
        //   guards: a paused recall/drill fetch can resume straight into card
        //   coverage reads. If they have not all settled within the bound,
        //   DEFER the close instead: it fires after disposePromise has resolved
        //   (cannot hang the host), only once every straggler has settled
        //   (never closes under a live reader), and so closes eventually — no
        //   handle leak when opencode disposes a cached per-directory instance
        //   without the process exiting. A straggler that truly never settles
        //   degrades to an unclosed handle on a derived, rebuildable store —
        //   harmless, unlike a use-after-close.
        const closeDb = (): void => {
          try {
            db?.close();
          } catch {
            // Best-effort: a throwing close must not reject disposePromise
            // (or escape the detached deferral) into the host.
          }
          db = null;
        };
        await settleWithin(distiller.stop(), SHUTDOWN_TIMEOUT_MS);
        const ops = await settleWithin(Promise.allSettled([...operations]), SHUTDOWN_TIMEOUT_MS);
        if (ops.timedOut) {
          // Diagnosable, not silent: until the stragglers settle, the SQLite
          // handle stays open — this line is the marker if it never closes.
          pluginLog(
            `dispose: ${operations.size} operation(s) outlived the ${SHUTDOWN_TIMEOUT_MS}ms bound; deferring SQLite close until they settle`,
          );
          void Promise.allSettled([...operations]).then(() => {
            pluginLog("dispose: deferred SQLite close firing (stragglers settled)");
            closeDb();
          });
        } else {
          closeDb();
        }
      })();
      return disposePromise;
    },
  };
};
