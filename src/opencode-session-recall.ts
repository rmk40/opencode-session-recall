import type { Plugin, ToolDefinition } from "@opencode-ai/plugin";
import { createOpencodeClient, type Session } from "@opencode-ai/sdk/v2";
import { sessions, type SessionEnrichment } from "./sessions.js";
import { search, DISCOVERY_LIMIT, type SearchDeps, type SemanticSearchConfig } from "./search.js";
import { get } from "./get.js";
import { context } from "./context.js";
import { messages } from "./messages.js";
import { systemNudge } from "./hooks/system-nudge.js";
import { autoRecall } from "./hooks/auto-recall.js";
import { compactionRecall } from "./hooks/compaction-recall.js";
import { createFetchGate } from "./fetch-gate.js";
import { openSqlite, type SqliteDb } from "./sqlite.js";
import {
  openStore,
  defaultStorePath,
  SCHEMA_VERSION,
  SEMANTIC_MODEL_KEY,
  VECTORS_REV_KEY,
  type Store,
  type Card,
} from "./store.js";
import { EMBED_REPRESENTATION } from "./embedding-text.js";
import { createCardsRuntime, cardsLiteFromSessions, type CardSource } from "./cards.js";
import { createDrill } from "./drill.js";
import { createDistiller } from "./distill.js";
import { createSummarizer, parseModelId, type Summarizer } from "./summarize.js";
import { TOOLS, DEFAULTS, optionalString, errmsg, type Limits } from "./types.js";

// `dispose` was added to the host/plugin contract in @opencode-ai/plugin 1.15.11.
// Keep the source compatible with this repository's older tool-result typings
// while declaring the exact minimum-host hook that the package engine requires.
declare module "@opencode-ai/plugin" {
  interface Hooks {
    dispose?: () => Promise<void>;
  }
}

/** Guarded, Node-free logger: `console` is a std global, but `src/` declares no
 *  types, so reach it defensively. */
function pluginLog(message: string): void {
  try {
    (globalThis as { console?: { log?: (msg: string) => void } }).console?.log?.(
      `[recall] ${message}`,
    );
  } catch {
    // Logging is best-effort; never let it throw into plugin init.
  }
}

/** Opt-in semantic layer defaults (plugin options, off unless enabled). */
const DEFAULT_SEMANTIC_MODEL = "minishlab/potion-base-8M";
const DEFAULT_SEMANTIC_WEIGHT = 0.35;
const MIN_SEMANTIC_WEIGHT = 0.05;
const MAX_SEMANTIC_WEIGHT = 0.95;

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
 * the two constants that actually gate mixed-version safety — the schema version
 * and the embedding representation generation — so it never lies about the fence
 * dimensions and needs no release-step upkeep. Swap in a real version here if one
 * can ever be sourced without a Node import.
 */
const PLUGIN_BUILD = `schema${SCHEMA_VERSION}.gen${EMBED_REPRESENTATION}`;

type Options = {
  primary?: boolean;
  global?: boolean;
  /** Inject a system-prompt reminder to use recall (R1a). Default: true. */
  nudge?: boolean;
  /** Run gated automatic recall on each user message (R1b). Default: false. */
  autoRecall?: boolean;
  /** Preserve durable findings into the compaction summary (R1c). Default: false. */
  compactionRecall?: boolean;
  /** Deprecated no-op: the card store persists across processes, so there is
   *  nothing to prewarm. Retained so existing configs do not error. */
  prewarm?: boolean;
  /** Override the card-store file path (default
   *  `~/.cache/opencode-session-recall/store-v1.db`). */
  storePath?: string;
  /** Enable the opt-in, local-only semantic layer. Default: false. */
  semantic?: boolean;
  /** Blend weight for the semantic signal, clamped to [0.05, 0.95]. Default: 0.35. */
  semanticWeight?: number;
  /** HuggingFace model id for static embeddings. Default: minishlab/potion-base-8M. */
  semanticModel?: string;
  /** Opt-in Path B LLM card summaries (off by default; spends the user's tokens).
   *  `model` is required as "providerID/modelID" — no model disables it. `agent`
   *  optionally prompts as a restricted opencode agent (the enforced tool block). */
  summaries?: { enabled?: boolean; model?: string; agent?: string; maxPromptsPerPass?: number };
} & Partial<Limits>;

const server: Plugin = async (ctx, options) => {
  const opts = (options ?? {}) as Options;
  const primary = opts.primary !== false;
  const global = opts.global !== false;
  const nudge = opts.nudge !== false;
  const autoRecallEnabled = opts.autoRecall === true;
  const compactionRecallEnabled = opts.compactionRecall === true;
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

  const clamp = (val: number | undefined, fallback: number, min = 1) =>
    Math.max(min, Math.floor(val ?? fallback));

  const limits: Limits = {
    concurrency: clamp(opts.concurrency, DEFAULTS.concurrency),
    maxSessions: clamp(opts.maxSessions, DEFAULTS.maxSessions),
    maxResults: clamp(opts.maxResults, DEFAULTS.maxResults),
    maxSessionList: clamp(opts.maxSessionList, DEFAULTS.maxSessionList),
    maxMessages: clamp(opts.maxMessages, DEFAULTS.maxMessages),
    maxWindow: clamp(opts.maxWindow, DEFAULTS.maxWindow),
    defaultWidth: clamp(opts.defaultWidth, DEFAULTS.defaultWidth, 50),
    cacheMaxChars: clamp(opts.cacheMaxChars, DEFAULTS.cacheMaxChars),
    distillConcurrency: clamp(opts.distillConcurrency, DEFAULTS.distillConcurrency),
    distillDelayMs: Math.max(0, Math.floor(opts.distillDelayMs ?? DEFAULTS.distillDelayMs)),
    ftsRowsPerSession: clamp(opts.ftsRowsPerSession, DEFAULTS.ftsRowsPerSession),
    inventoryTokens: clamp(opts.inventoryTokens, DEFAULTS.inventoryTokens),
    coldPass: opts.coldPass !== false,
    drillSessions: clamp(opts.drillSessions, DEFAULTS.drillSessions),
    // Reserved semantic slots: min 0 (0 disables the reservation), never more
    // than the drill fan-out itself.
    semanticSlots: Math.min(
      clamp(opts.drillSessions, DEFAULTS.drillSessions),
      Math.max(0, Math.floor(opts.semanticSlots ?? DEFAULTS.semanticSlots)),
    ),
    drillPageMessages: clamp(opts.drillPageMessages, DEFAULTS.drillPageMessages),
    drillCharsPerSession: clamp(opts.drillCharsPerSession, DEFAULTS.drillCharsPerSession),
    drillCharsPerQuery: clamp(opts.drillCharsPerQuery, DEFAULTS.drillCharsPerQuery),
    deepCharsPerQuery: clamp(opts.deepCharsPerQuery, DEFAULTS.deepCharsPerQuery),
  };

  // Extract the in-process fetch from the v1 client's internals.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK internals not typed
  const inner = (ctx.client as any)._client;
  if (!inner?.getConfig)
    throw new Error(
      "opencode-session-recall: SDK internals changed — cannot extract fetch transport",
    );
  const cfg = inner.getConfig();
  if (!cfg.fetch) throw new Error("opencode-session-recall: SDK client has no custom fetch");

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { "x-opencode-directory": _, ...rest } = (cfg.headers ?? {}) as Record<string, string>;

  const client = createOpencodeClient({
    baseUrl: cfg.baseUrl,
    fetch: cfg.fetch,
    headers: cfg.headers,
    directory: ctx.directory,
  });

  const unscoped = createOpencodeClient({
    baseUrl: cfg.baseUrl,
    fetch: cfg.fetch,
    headers: rest,
  });

  // Opt-in, local-only semantic layer. Off by default; any failure to load the
  // embedder module or construct the model degrades to a plain cache with no
  // semantic signal (lexical-only). init() is fired and forgotten — it never
  // throws to callers, and searches stay lexical until the model warms.
  let semantic: SemanticSearchConfig | undefined;
  let semanticModel: string | undefined;
  let semanticReady: Promise<void> | undefined;
  if (opts.semantic === true) {
    try {
      const { SemanticEmbedder } = await import("./semantic/embedder.js");
      const model = optionalString(opts.semanticModel) ?? DEFAULT_SEMANTIC_MODEL;
      const embedder = new SemanticEmbedder(model);
      // Idempotent: start loading and keep the promise so the card runtime can
      // run its first embed pass the moment the model is ready.
      semanticReady = embedder.init();
      const weight =
        typeof opts.semanticWeight === "number" && Number.isFinite(opts.semanticWeight)
          ? Math.max(MIN_SEMANTIC_WEIGHT, Math.min(MAX_SEMANTIC_WEIGHT, opts.semanticWeight))
          : DEFAULT_SEMANTIC_WEIGHT;
      semantic = { embedder, weight };
      semanticModel = model;
    } catch {
      // Plain cache, no semantic.
    }
  }

  // Session discovery for the distiller cold pass: global scope reads the
  // unscoped experimental list, otherwise the directory-scoped list. Always
  // sends an explicit limit (the server defaults to 100 rows).
  const discover = async (): Promise<Session[]> => {
    const resp = global
      ? await unscoped.experimental.session.list({ limit: DISCOVERY_LIMIT })
      : await client.session.list({ limit: DISCOVERY_LIMIT });
    if (resp.error) throw new Error(errmsg(resp.error));
    return Array.isArray(resp.data) ? (resp.data as Session[]) : [];
  };

  // ── Card store (Tier 0) ──
  // The derived, versioned store is the sole persistence. If SQLite is
  // unavailable (no driver, unwritable dir) or the schema is newer than this
  // build understands, `store` stays null and the plugin degrades to ephemeral
  // cards-lite built from the session list.
  const storePath = optionalString(opts.storePath) ?? (await defaultStorePath());
  let store: Store | null = null;
  let db: SqliteDb | null = null;
  if (storePath) {
    db = await openSqlite(storePath);
    if (db) store = openStore(db);
  }

  // Degraded cards-lite: fetch the session list once (best-effort) and keep
  // metadata-only cards in memory. The tier-1 runtime reads the live array.
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
  if (!store) {
    void track(
      discover()
        .then((list) => {
          if (!disposed)
            liteCards = cardsLiteFromSessions(list as Parameters<typeof cardsLiteFromSessions>[0]);
        })
        .catch(() => {
          // Best-effort; a failed list just leaves cards-lite empty until retried.
        }),
    );
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
  const drill = createDrill({ client, gate, limits });

  const instanceId =
    globalThis.crypto?.randomUUID?.() ??
    `recall-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Path B summarizer (opt-in). The distiller drives it — after the cold pass and
  // on the idle-debounce re-distill path — so it only ever runs while this
  // process holds the distill lease.
  let summarizer: Summarizer | undefined;
  const distiller = createDistiller({
    client,
    store,
    gate,
    limits,
    instanceId,
    build: PLUGIN_BUILD,
    gen: EMBED_REPRESENTATION,
    discover,
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
  if (store && opts.summaries?.enabled === true) {
    const model = optionalString(opts.summaries.model);
    const parsed = model ? parseModelId(model) : undefined;
    if (parsed) {
      const maxPromptsPerPass =
        typeof opts.summaries.maxPromptsPerPass === "number" &&
        Number.isFinite(opts.summaries.maxPromptsPerPass) &&
        opts.summaries.maxPromptsPerPass > 0
          ? Math.floor(opts.summaries.maxPromptsPerPass)
          : undefined;
      const agent = optionalString(opts.summaries.agent);
      summarizer = createSummarizer({
        client,
        store,
        gate,
        config: {
          ...parsed,
          ...(agent != null && { agent }),
          ...(maxPromptsPerPass != null && { maxPromptsPerPass }),
        },
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

  const deps: SearchDeps = { gate, store, cards, drill, semantic };
  // recall_sessions serves the card store directly when it exists (digest, top
  // files/tools, family rollups); degraded mode leaves listings bare.
  const enrichment: SessionEnrichment | undefined = store
    ? { cards: () => store.allCards() }
    : undefined;

  const guardTool = (definition: ToolDefinition): ToolDefinition => ({
    ...definition,
    execute: (args, context) => {
      if (disposed) {
        return Promise.reject(new Error("opencode-session-recall: plugin has been disposed"));
      }
      return track(definition.execute(args, context));
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
      recall_sessions: guardTool(sessions(client, unscoped, global, limits, enrichment)),
      recall: guardTool(search(client, unscoped, global, limits, deps)),
      recall_get: guardTool(get(client, gate)),
      recall_context: guardTool(context(client, gate, limits)),
      recall_messages: guardTool(messages(client, gate, limits)),
    },
    event: async ({ event }) => {
      if (disposed) return;
      // The plugin `event` hook is typed against the default SDK vintage; the
      // distiller compiles against the v2 event union the live bus actually
      // delivers. Bridge the vintage gap at this one boundary.
      distiller.onEvent(event as unknown as Parameters<typeof distiller.onEvent>[0]);
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
        // Summarizer.stop() is bounded. Its late SDK promises are detached and
        // ownership/lease guarded, so phase 2 may safely release the lease once
        // this settles even when an SDK request itself never does.
        if (summarizer) await Promise.allSettled([summarizer.stop()]);
        await distiller.stop();
        await Promise.allSettled([...operations]);
        db?.close();
        db = null;
      })();
      return disposePromise;
    },
  };
};

export default {
  id: "opencode-session-recall",
  server,
};
