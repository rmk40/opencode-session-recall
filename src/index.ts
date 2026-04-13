import type { Plugin } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
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

  // The plugin receives a v1-typed client, but at runtime it's the v2 client
  // which includes experimental.session for cross-project queries
  const client = ctx.client as unknown as OpencodeClient;

  return {
    tool: {
      recall_sessions: sessions(client, global),
      recall: search(client, global),
      recall_get: get(client),
    },
    ...(primary && {
      config: async (cfg: any) => {
        cfg.experimental ??= {};
        const existing: string[] = cfg.experimental.primary_tools ?? [];
        const deduped = new Set(existing);
        for (const t of TOOLS) deduped.add(t);
        cfg.experimental.primary_tools = [...deduped];
      },
    }),
  };
};

export default {
  id: "opencode-recall",
  server,
};
