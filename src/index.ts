import type { Plugin } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { sessions } from "./sessions.js";
import { search } from "./search.js";
import { get } from "./get.js";

type Options = {
  primary?: boolean;
  global?: boolean;
};

const TOOLS = ["recall", "recall_get", "recall_sessions"];

const server: Plugin = async (ctx, options) => {
  const opts = (options ?? {}) as Options;
  const primary = opts.primary !== false;
  const global = opts.global === true;

  // Extract the in-process fetch and config from the v1 client's internals.
  // The v1 client uses Server.Default().app.fetch — a direct in-process call,
  // no network socket. We reuse it to create a v2 client that has proper
  // support for limit/search/cursor query params on session.list etc.
  const inner = (ctx.client as any)._client;
  const cfg = inner.getConfig();

  const client = createOpencodeClient({
    baseUrl: cfg.baseUrl,
    fetch: cfg.fetch,
    headers: cfg.headers,
    directory: ctx.directory,
  });

  return {
    tool: {
      recall_sessions: sessions(client, global),
      recall: search(client, global),
      recall_get: get(client),
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
