import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { MessageOutput, ErrorOutput } from "./types.js";
import { format } from "./extract.js";

type Client = OpencodeClient;

export function get(client: Client): ToolDefinition {
  return tool({
    description: `Retrieve the full content of a specific message from any session, including all parts (text, tool outputs, reasoning, etc). Use after recall to get the complete content of a search result. For tool parts, returns the original output even if it was pruned from your context window.`,
    args: {
      sessionID: tool.schema
        .string()
        .describe("Session containing the message"),
      messageID: tool.schema.string().describe("Message to retrieve"),
    },
    async execute(args): Promise<string> {
      try {
        const result = await client.session.message({
          sessionID: args.sessionID,
          messageID: args.messageID,
        });
        if (!result.data) {
          const err: ErrorOutput = {
            ok: false,
            error: `Message not found: ${args.messageID} in session ${args.sessionID}`,
          };
          return JSON.stringify(err);
        }

        const msg = result.data;
        const info = msg.info;
        const parts = msg.parts.map(format);

        // Try to get session context, gracefully degrade on failure
        let title: string | undefined;
        let directory: string | undefined;
        try {
          const sess = await client.session.get({ sessionID: args.sessionID });
          if (sess.data) {
            title = sess.data.title;
            directory = sess.data.directory;
          }
        } catch {
          // Cross-project session — can't get context, that's fine
        }

        const out: MessageOutput = {
          ok: true,
          message: {
            id: info.id,
            role: info.role,
            time: info.time.created,
            agent: info.agent,
            model:
              info.role === "assistant" ? info.modelID : info.model.modelID,
          },
          parts,
          context: { sessionTitle: title, directory },
        };
        return JSON.stringify(out);
      } catch (e) {
        const err: ErrorOutput = {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
        return JSON.stringify(err);
      }
    },
  });
}
