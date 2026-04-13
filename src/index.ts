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

  // Extract the in-process fetch from the v1 client's internals.
  // The v1 client uses Server.Default().app.fetch — a direct in-process call,
  // no network socket. We reuse it to create v2 clients that have proper
  // support for limit/search/cursor query params.
  const inner = (ctx.client as any)._client;
  const cfg = inner.getConfig();

  // Project-scoped client: includes directory header so session.list/get
  // are scoped to the current project
  const client = createOpencodeClient({
    baseUrl: cfg.baseUrl,
    fetch: cfg.fetch,
    headers: cfg.headers,
    directory: ctx.directory,
  });

  // Unscoped client: no directory header, so experimental.session.list
  // returns sessions across ALL projects
  const unscoped = createOpencodeClient({
    baseUrl: cfg.baseUrl,
    fetch: cfg.fetch,
  });

  return {
    tool: {
      recall_sessions: sessions(client, unscoped, global),
      recall: search(client, unscoped, global),
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
