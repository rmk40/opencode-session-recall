import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { createRuntime } from "./runtime.js";
import { TOOLS } from "./types.js";

export const server: Plugin = async (ctx, options = {}) => {
  // V1 exposes no public transport accessor. Preserve its supplied in-process
  // fetch and authentication rather than discovering or starting another server.
  const inner = (
    ctx.client as unknown as {
      _client?: {
        getConfig?: () => { baseUrl?: string; fetch?: typeof fetch; headers?: HeadersInit };
      };
    }
  )._client;
  if (typeof inner?.getConfig !== "function")
    throw new Error("Recall: V1 SDK transport unavailable (_client.getConfig)");
  const config = inner.getConfig();
  const headers = new Headers(config.headers);
  const scopedHeaders = Object.fromEntries(headers);
  headers.delete("x-opencode-directory");
  const client = createOpencodeClient({
    ...config,
    headers: scopedHeaders,
    directory: ctx.directory,
  });
  const unscoped = createOpencodeClient({ ...config, headers });
  // A caller cannot select V2's default cache through an internal option.
  const hooks = await createRuntime(client, unscoped, { ...options, hostV2: false });
  let disposed = false;
  return {
    ...hooks,
    // Both sides use Zod 4; the legacy package pins a different minor in its
    // declarations. V1 consumes these schemas structurally at runtime.
    tool: hooks.tool as unknown as Hooks["tool"],
    ...(options.primary !== false && {
      config: async (config) => {
        if (disposed) return;
        config.experimental ??= {};
        config.experimental.primary_tools = [
          ...new Set([...(config.experimental.primary_tools ?? []), ...TOOLS]),
        ];
      },
    }),
    dispose: async () => {
      disposed = true;
      await hooks.dispose?.();
    },
  };
};
