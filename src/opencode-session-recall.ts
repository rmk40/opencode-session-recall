import type { Plugin } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { sessions } from "./sessions.js";
import { search } from "./search.js";
import { get } from "./get.js";
import { context } from "./context.js";
import { messages } from "./messages.js";
import { TOOLS, DEFAULTS, type Limits } from "./types.js";

type Options = {
  primary?: boolean;
  global?: boolean;
} & Partial<Limits>;

const server: Plugin = async (ctx, options) => {
  const opts = (options ?? {}) as Options;
  const primary = opts.primary !== false;
  const global = opts.global === true;

  const limits: Limits = {
    concurrency: opts.concurrency ?? DEFAULTS.concurrency,
    maxSessions: opts.maxSessions ?? DEFAULTS.maxSessions,
    maxResults: opts.maxResults ?? DEFAULTS.maxResults,
    maxSessionList: opts.maxSessionList ?? DEFAULTS.maxSessionList,
    maxMessages: opts.maxMessages ?? DEFAULTS.maxMessages,
    maxWindow: opts.maxWindow ?? DEFAULTS.maxWindow,
    defaultWidth: opts.defaultWidth ?? DEFAULTS.defaultWidth,
  };

  // Extract the in-process fetch from the v1 client's internals.
  const inner = (ctx.client as any)._client;
  if (!inner?.getConfig)
    throw new Error(
      "opencode-session-recall: SDK internals changed — cannot extract fetch transport",
    );
  const cfg = inner.getConfig();
  if (!cfg.fetch)
    throw new Error("opencode-session-recall: SDK client has no custom fetch");

  const { "x-opencode-directory": _, ...rest } = (cfg.headers ?? {}) as Record<
    string,
    string
  >;

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

  return {
    tool: {
      recall_sessions: sessions(client, unscoped, global, limits),
      recall: search(client, unscoped, global, limits),
      recall_get: get(client),
      recall_context: context(client, limits),
      recall_messages: messages(client, limits),
    },
    ...(primary && {
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
