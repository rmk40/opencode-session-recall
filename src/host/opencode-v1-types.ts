/**
 * Vendored opencode v1 plugin types (`@opencode-ai/plugin`), checked against
 * 1.18.23.
 *
 * Only the surface `src/` touches is copied, member for member, so the host's
 * own declarations stay assignable to these (the host passes a richer
 * `PluginInput` and `ToolContext`). Vendoring keeps the emitted `.d.ts` free of
 * a package that a v2-only install does not have. One deliberate difference:
 * `ToolDefinition.args` is typed over this package's `zod`, not the copy nested
 * under `@opencode-ai/plugin`, so tests type tools against these types rather
 * than the upstream ones (the two zod versions' types are not mutually
 * assignable). The SDK root types come from `@opencode-ai/sdk`, a runtime
 * dependency of this package.
 */
import type { Config as SdkConfig, Event, Model, Part, UserMessage } from "@opencode-ai/sdk";
import type { z } from "zod";

type AskInput = {
  permission: string;
  patterns: string[];
  always: string[];
  metadata: { [key: string]: unknown };
};

export type ToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  /** Current project directory for this session. */
  directory: string;
  /** Project worktree root for this session. */
  worktree: string;
  abort: AbortSignal;
  metadata(input: { title?: string; metadata?: { [key: string]: unknown } }): void;
  ask(input: AskInput): Promise<void>;
};

export type ToolAttachment = {
  type: "file";
  mime: string;
  url: string;
  filename?: string;
};

export type ToolResult =
  | string
  | {
      title?: string;
      output: string;
      metadata?: { [key: string]: unknown };
      attachments?: ToolAttachment[];
    };

/** A tool as the v1 host consumes it (what `tool()` returns). */
export type ToolDefinition = {
  description: string;
  args: z.ZodRawShape;
  execute(args: z.infer<z.ZodObject<z.ZodRawShape>>, context: ToolContext): Promise<ToolResult>;
};

/** The plugin context fields this plugin reads. The host passes more. */
export type PluginInput = {
  /** The host's default-vintage SDK client; read only by `createV1Clients`. */
  client: unknown;
  directory: string;
};

export type PluginOptions = Record<string, unknown>;

/** The host config object the `config` hook may mutate. */
export type Config = Omit<SdkConfig, "plugin"> & {
  plugin?: Array<string | [string, PluginOptions]>;
};

/** The hooks this plugin registers. */
export interface Hooks {
  dispose?: () => Promise<void>;
  event?: (input: { event: Event }) => Promise<void>;
  config?: (input: Config) => Promise<void>;
  tool?: { [key: string]: ToolDefinition };
  /** Called when a new message is received. */
  "chat.message"?: (
    input: {
      sessionID: string;
      agent?: string;
      model?: { providerID: string; modelID: string };
      messageID?: string;
      variant?: string;
    },
    output: { message: UserMessage; parts: Part[] },
  ) => Promise<void>;
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string; model: Model },
    output: { system: string[] },
  ) => Promise<void>;
  /** Called before session compaction starts. */
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void>;
}

export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;
