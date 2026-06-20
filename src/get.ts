import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { MessageOutput, ErrorOutput } from "./types.js";
import { errmsg, optionalString } from "./types.js";
import { formatMsg } from "./extract.js";

export function get(client: OpencodeClient): ToolDefinition {
  return tool({
    description: `Retrieve one full message from recall results, including text, reasoning, tool inputs/outputs, and pruned tool output. Use recall_context for surrounding conversation.

If memory exists, store only durable findings surfaced here; skip ephemeral details/minutiae.`,
    args: {
      sessionID: tool.schema.string().describe("Session containing the message"),
      messageID: tool.schema.string().describe("Message to retrieve"),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      // Defensive: the live MCP host can bypass Zod, so required args may be
      // missing rather than schema-validated.
      const sessionID = optionalString(args.sessionID);
      const messageID = optionalString(args.messageID);
      if (!sessionID || !messageID) {
        const err: ErrorOutput = { ok: false, error: "sessionID and messageID are required" };
        return JSON.stringify(err);
      }
      ctx.metadata({
        title: `Retrieving message ${messageID.slice(0, 20)}...`,
      });

      try {
        const result = await client.session.message({
          sessionID,
          messageID,
        });
        if (!result.data) {
          const msg = result.error ? errmsg(result.error) : `Message not found: ${messageID}`;
          const err: ErrorOutput = { ok: false, error: msg };
          return JSON.stringify(err);
        }

        const item = formatMsg(result.data);

        let title: string | undefined;
        let directory: string | undefined;
        try {
          const sess = await client.session.get({ sessionID: sessionID });
          if (sess.data) {
            title = sess.data.title;
            directory = sess.data.directory;
          }
        } catch {
          // Cross-project session — can't get context, that's fine
        }

        ctx.metadata({
          title: `${item.message.role} message (${item.parts.length} part${item.parts.length !== 1 ? "s" : ""})${title ? ` from "${title}"` : ""}`,
        });

        const out: MessageOutput = {
          ok: true,
          message: item.message,
          parts: item.parts,
          context: { sessionTitle: title, directory },
        };
        return JSON.stringify(out);
      } catch (e) {
        const err: ErrorOutput = { ok: false, error: errmsg(e) };
        return JSON.stringify(err);
      }
    },
  });
}
