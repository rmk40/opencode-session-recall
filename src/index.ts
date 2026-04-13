import type { Plugin } from "@opencode-ai/plugin";
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

  return {
    tool: {
      recall_sessions: sessions(ctx.client, global),
      recall: search(ctx.client, global),
      recall_get: get(ctx.client),
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
