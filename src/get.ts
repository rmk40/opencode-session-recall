import { tool } from "@opencode-ai/plugin";
import type { createOpencodeClient } from "@opencode-ai/sdk";

type Client = ReturnType<typeof createOpencodeClient>;

export function get(_client: Client) {
  return tool({
    description: "stub",
    args: {},
    async execute() {
      return "{}";
    },
  });
}
