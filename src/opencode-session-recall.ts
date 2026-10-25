import type { Plugin } from "@opencode/plugin";
import type { PluginInput } from "@opencode-ai/plugin";

// Keep host APIs lazy: importing the package in V1 must not load V2's plugin API,
// and V2 must not construct a legacy SDK transport.
export default {
  id: "opencode-session-recall",
  async setup(ctx: Plugin.Context) {
    const { default: plugin } = await import("./v2-plugin.js");
    return plugin.setup(ctx);
  },
  async server(ctx: PluginInput, options: Record<string, unknown> = {}) {
    const { server } = await import("./v1-plugin.js");
    return server(ctx, options);
  },
};
