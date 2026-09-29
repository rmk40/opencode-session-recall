import { DEFAULTS, optionalString, type Limits } from "./types.js";
import { parseModelId, type SummariesConfig } from "./summarize.js";

/**
 * Plugin option parsing, shared by every host.
 *
 * Options arrive as untyped config JSON (no Zod schema runs over them), so each
 * one is hand-coerced here. {@link parseOptions} is pure: notes the host should
 * log come back as `warnings` instead of being printed.
 */

/** Opt-in semantic layer defaults (plugin options, off unless enabled). */
export const DEFAULT_SEMANTIC_MODEL = "minishlab/potion-base-8M";
export const DEFAULT_SEMANTIC_WEIGHT = 0.35;
const MIN_SEMANTIC_WEIGHT = 0.05;
const MAX_SEMANTIC_WEIGHT = 0.95;

/** The documented option shape. Nothing enforces it: every field is coerced. */
export type RawOptions = {
  primary?: boolean;
  global?: boolean;
  /** `"ephemeral"` runs the plugin with no persistent store and zero disk
   *  artifacts: cards are metadata-only (built live from the session list),
   *  content recall comes from drill/deep at query time, and the semantic
   *  layer is forced off (its embedder writes model weights to the cache dir).
   *  Anything else (including absence) is persistent mode. */
  mode?: "persistent" | "ephemeral";
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
  /** opencode v2 only: read history from this database file instead of the
   *  one opencode itself resolves (`OPENCODE_DB`, the channel, XDG). */
  opencodeDbPath?: string;
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

export type ResolvedOptions = {
  primary: boolean;
  global: boolean;
  nudge: boolean;
  autoRecall: boolean;
  compactionRecall: boolean;
  /** Only the literal string `"ephemeral"` enables ephemeral mode. */
  ephemeral: boolean;
  /** The configured store path; always undefined in ephemeral mode (no store). */
  storePath: string | undefined;
  /** v2 only: the configured `opencode.db` override. */
  opencodeDbPath: string | undefined;
  /** The semantic layer's model and blend weight when it is enabled; always
   *  undefined in ephemeral mode. */
  semantic: { model: string; weight: number } | undefined;
  /** Present when `summaries.enabled === true`. `config` is undefined when the
   *  model is missing or malformed (the feature then stays off). */
  summaries: { config: SummariesConfig | undefined } | undefined;
  limits: Limits;
  /** One-time notes for the host log, in the order they should be written. */
  warnings: string[];
};

export function parseOptions(raw: unknown): ResolvedOptions {
  const opts = (raw ?? {}) as RawOptions;
  const warnings: string[] = [];

  // Only the literal string "ephemeral" enables the mode; anything else —
  // including a typo — is persistent, with a one-time log line as the tell.
  const modeRaw: unknown = opts.mode;
  const ephemeral = modeRaw === "ephemeral";
  if (!ephemeral && typeof modeRaw === "string" && modeRaw !== "" && modeRaw !== "persistent") {
    warnings.push(`unrecognized mode ${JSON.stringify(modeRaw)}; running in persistent mode`);
  }
  if (ephemeral) {
    if (optionalString(opts.storePath)) {
      warnings.push("ephemeral mode: storePath is ignored (no store is opened)");
    }
    if (opts.semantic === true) {
      warnings.push(
        "ephemeral mode: semantic is forced off (the embedder caches model weights on disk)",
      );
    }
    if (opts.summaries?.enabled === true) {
      warnings.push("ephemeral mode: summaries are inert (they require the persistent store)");
    }
    if (opts.compactionRecall === true) {
      warnings.push("ephemeral mode: compactionRecall is inert (it reads the persistent store)");
    }
  }

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

  // Ephemeral force-disables the semantic layer: its embedder writes model
  // weights under the cache dir, which would violate the zero-artifact mode.
  const semantic =
    opts.semantic === true && !ephemeral
      ? {
          model: optionalString(opts.semanticModel) ?? DEFAULT_SEMANTIC_MODEL,
          weight:
            typeof opts.semanticWeight === "number" && Number.isFinite(opts.semanticWeight)
              ? Math.max(MIN_SEMANTIC_WEIGHT, Math.min(MAX_SEMANTIC_WEIGHT, opts.semanticWeight))
              : DEFAULT_SEMANTIC_WEIGHT,
        }
      : undefined;

  let summaries: ResolvedOptions["summaries"];
  if (opts.summaries?.enabled === true) {
    // Never guess a model: a missing or malformed one leaves config undefined.
    const model = optionalString(opts.summaries.model);
    const parsed = model ? parseModelId(model) : undefined;
    let config: SummariesConfig | undefined;
    if (parsed) {
      const maxPromptsPerPass =
        typeof opts.summaries.maxPromptsPerPass === "number" &&
        Number.isFinite(opts.summaries.maxPromptsPerPass) &&
        opts.summaries.maxPromptsPerPass > 0
          ? Math.floor(opts.summaries.maxPromptsPerPass)
          : undefined;
      const agent = optionalString(opts.summaries.agent);
      config = {
        ...parsed,
        ...(agent != null && { agent }),
        ...(maxPromptsPerPass != null && { maxPromptsPerPass }),
      };
    }
    summaries = { config };
  }

  return {
    primary: opts.primary !== false,
    global: opts.global !== false,
    nudge: opts.nudge !== false,
    autoRecall: opts.autoRecall === true,
    compactionRecall: opts.compactionRecall === true,
    ephemeral,
    storePath: ephemeral ? undefined : optionalString(opts.storePath),
    opencodeDbPath: optionalString(opts.opencodeDbPath),
    semantic,
    summaries,
    limits,
    warnings,
  };
}
