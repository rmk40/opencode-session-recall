import type { Plugin } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { sessions } from "./sessions.js";
import { search } from "./search.js";
import { get } from "./get.js";
import { context } from "./context.js";
import { messages } from "./messages.js";

type Options = {
  primary?: boolean;
  global?: boolean;
};

const TOOLS = [
  "recall",
  "recall_get",
  "recall_sessions",
  "recall_context",
  "recall_messages",
];

const server: Plugin = async (ctx, options) => {
  const opts = (options ?? {}) as Options;
  const primary = opts.primary !== false;
  const global = opts.global === true;

  // Extract the in-process fetch from the v1 client's internals.
  // The v1 client uses Server.Default().app.fetch — a direct in-process call,
  // no network socket. We reuse it to create v2 clients that have proper
  // support for limit/search/cursor query params.
  const inner = (ctx.client as any)._client;
  if (!inner?.getConfig)
    throw new Error(
      "opencode-recall: SDK internals changed — cannot extract fetch transport",
    );
  const cfg = inner.getConfig();
  if (!cfg.fetch)
    throw new Error("opencode-recall: SDK client has no custom fetch");

  // Strip only the directory header for the unscoped client, keep auth etc.
  const { "x-opencode-directory": _, ...rest } = (cfg.headers ?? {}) as Record<
    string,
    string
  >;

  // Project-scoped client: includes directory header so session.list/get
  // are scoped to the current project
  const client = createOpencodeClient({
    baseUrl: cfg.baseUrl,
    fetch: cfg.fetch,
    headers: cfg.headers,
    directory: ctx.directory,
  });

  // Unscoped client: no directory header, so experimental.session.list
  // returns sessions across ALL projects. Preserves other headers (auth etc).
  const unscoped = createOpencodeClient({
    baseUrl: cfg.baseUrl,
    fetch: cfg.fetch,
    headers: rest,
  });

  return {
    tool: {
      recall_sessions: sessions(client, unscoped, global),
      recall: search(client, unscoped, global),
      recall_get: get(client),
      recall_context: context(client),
      recall_messages: messages(client),
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
  id: "opencode-recall",
  server,
};
