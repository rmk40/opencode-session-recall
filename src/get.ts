import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { MessageOutput, ErrorOutput } from "./types.js";
import { errmsg } from "./types.js";
import { formatMsg } from "./extract.js";

export function get(client: OpencodeClient): ToolDefinition {
  return tool({
    description: `Retrieve the full content of a specific message from any session, including all parts (text, tool outputs, reasoning, etc). Use after recall to get the complete content of a search result. For tool parts, returns the original output even if it was pruned from your context window. Large outputs may be truncated by the opencode runtime.

Returns { message: { id, role, time, model }, parts: [{ type, content, toolName, input, output, pruned, ... }], context: { sessionTitle, directory } }. Each part has a pruned flag indicating whether it was compacted.

Use recall_context instead if you need surrounding messages for context, not just a single message. Use sessionID and messageID from recall search results.`,
    args: {
      sessionID: tool.schema
        .string()
        .describe("Session containing the message (from recall search results)"),
      messageID: tool.schema.string().describe("Message to retrieve (from recall search results)"),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      ctx.metadata({
        title: `Retrieving message ${args.messageID.slice(0, 20)}...`,
      });

      try {
        const result = await client.session.message({
          sessionID: args.sessionID,
          messageID: args.messageID,
        });
        if (!result.data) {
          const msg = result.error ? errmsg(result.error) : `Message not found: ${args.messageID}`;
          const err: ErrorOutput = { ok: false, error: msg };
          return JSON.stringify(err);
        }

        const item = formatMsg(result.data);

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
