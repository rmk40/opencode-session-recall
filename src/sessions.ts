import { tool } from "@opencode-ai/plugin";
import type { createOpencodeClient } from "@opencode-ai/sdk";

type Client = ReturnType<typeof createOpencodeClient>;

export function sessions(_client: Client, _global: boolean) {
  return tool({
    description: "stub",
    args: {},
    async execute() {
      return "{}";
    },
  });
}
