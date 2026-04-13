import type { Plugin } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { sessions } from "./sessions.js";
import { search } from "./search.js";
import { get } from "./get.js";

type Options = {
  primary?: boolean;
  global?: boolean;
};

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
        const existing = cfg.experimental?.primary_tools ?? [];
        cfg.experimental = {
          ...cfg.experimental,
          primary_tools: [
            ...existing,
            "recall",
            "recall_get",
            "recall_sessions",
          ],
        };
      },
    }),
  };
};

export default {
  id: "opencode-recall",
  server,
};
