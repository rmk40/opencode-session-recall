import type { Plugin } from "@opencode-ai/plugin";
import { createOpencodeClient, type Session } from "@opencode-ai/sdk/v2";
import { sessions } from "./sessions.js";
import { search, DISCOVERY_LIMIT, type SearchDeps, type SemanticSearchConfig } from "./search.js";
import { get } from "./get.js";
import { context } from "./context.js";
import { messages } from "./messages.js";
import { systemNudge } from "./hooks/system-nudge.js";
import { autoRecall } from "./hooks/auto-recall.js";
import { compactionRecall } from "./hooks/compaction-recall.js";
import { createFetchGate } from "./fetch-gate.js";
import { openSqlite } from "./sqlite.js";
import { openStore, defaultStorePath, type Store, type Card } from "./store.js";
import { createCardsRuntime, cardsLiteFromSessions, type CardSource } from "./cards.js";
import { createDrill } from "./drill.js";
import { createDistiller } from "./distill.js";
import { TOOLS, DEFAULTS, optionalString, errmsg, type Limits } from "./types.js";

/** Opt-in semantic layer defaults (plugin options, off unless enabled). */
const DEFAULT_SEMANTIC_MODEL = "minishlab/potion-base-8M";
const DEFAULT_SEMANTIC_WEIGHT = 0.35;
const MIN_SEMANTIC_WEIGHT = 0.05;
const MAX_SEMANTIC_WEIGHT = 0.95;

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
} & Partial<Limits>;

const server: Plugin = async (ctx, options) => {
  const opts = (options ?? {}) as Options;
  const primary = opts.primary !== false;
  const global = opts.global !== false;
  const nudge = opts.nudge !== false;
  const autoRecallEnabled = opts.autoRecall === true;
  const compactionRecallEnabled = opts.compactionRecall === true;

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
    drillPageMessages: clamp(opts.drillPageMessages, DEFAULTS.drillPageMessages),
    drillCharsPerSession: clamp(opts.drillCharsPerSession, DEFAULTS.drillCharsPerSession),
    drillCharsPerQuery: clamp(opts.drillCharsPerQuery, DEFAULTS.drillCharsPerQuery),
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
  if (opts.semantic === true) {
    try {
      const { SemanticEmbedder } = await import("./semantic/embedder.js");
      const model = optionalString(opts.semanticModel) ?? DEFAULT_SEMANTIC_MODEL;
      const embedder = new SemanticEmbedder(model);
      void embedder.init();
      const weight =
        typeof opts.semanticWeight === "number" && Number.isFinite(opts.semanticWeight)
          ? Math.max(MIN_SEMANTIC_WEIGHT, Math.min(MAX_SEMANTIC_WEIGHT, opts.semanticWeight))
          : DEFAULT_SEMANTIC_WEIGHT;
      semantic = { embedder, weight };
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
  if (storePath) {
    const db = await openSqlite(storePath);
    if (db) store = openStore(db);
  }

  // Degraded cards-lite: fetch the session list once (best-effort) and keep
  // metadata-only cards in memory. The tier-1 runtime reads the live array.
  let liteCards: Card[] = [];
  const cardSource: CardSource = store
    ? { getCards: () => store.allCards(), revision: () => store.getMeta("cards_rev") }
    : { getCards: () => liteCards, revision: () => undefined, degraded: true };
  if (!store) {
    void discover()
      .then((list) => {
        liteCards = cardsLiteFromSessions(list as Parameters<typeof cardsLiteFromSessions>[0]);
      })
      .catch(() => {
        // Best-effort; a failed list just leaves cards-lite empty until retried.
      });
  }

  // One shared fetch gate gates every SDK call in the query/distill paths so the
  // plugin never opens more than `concurrency` server connections at once.
  const gate = createFetchGate({ concurrency: limits.concurrency });

  const cards = createCardsRuntime({
    source: cardSource,
    embedder: semantic?.embedder,
    semanticWeight: semantic?.weight,
  });
  const drill = createDrill({ client, gate, limits, embedder: semantic?.embedder });

  const instanceId =
    globalThis.crypto?.randomUUID?.() ??
    `recall-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const distiller = createDistiller({ client, store, gate, limits, instanceId, discover });
  if (limits.coldPass) distiller.start();

  const deps: SearchDeps = { gate, store, cards, drill };
  const digestSource = { peekDigest: (id: string) => store?.getCard(id)?.summaryHead || undefined };

  return {
    tool: {
      recall_sessions: sessions(client, unscoped, global, limits, digestSource),
      recall: search(client, unscoped, global, limits, deps),
      recall_get: get(client),
      recall_context: context(client, gate, limits),
      recall_messages: messages(client, gate, limits),
    },
    event: async ({ event }) => {
      // The plugin `event` hook is typed against the default SDK vintage; the
      // distiller compiles against the v2 event union the live bus actually
      // delivers. Bridge the vintage gap at this one boundary.
      distiller.onEvent(event as unknown as Parameters<typeof distiller.onEvent>[0]);
    },
    ...(nudge && {
      "experimental.chat.system.transform": systemNudge(),
    }),
    ...(autoRecallEnabled && {
      "chat.message": autoRecall(client, unscoped, global, limits, deps),
    }),
    ...(compactionRecallEnabled && {
      "experimental.session.compacting": compactionRecall(client, unscoped, global, limits, deps),
    }),
    ...(primary && {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- opencode config type not exported
      config: async (c: any) => {
        c.experimental ??= {};
        const existing: string[] = c.experimental.primary_tools ?? [];
        const deduped = new Set(existing);
        for (const t of TOOLS) deduped.add(t);
        c.experimental.primary_tools = [...deduped];
      },
    }),
  };
};

export default {
  id: "opencode-session-recall",
  server,
};
