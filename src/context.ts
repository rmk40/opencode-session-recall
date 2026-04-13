import {
  tool,
  type ToolDefinition,
  type ToolContext,
} from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { errmsg, type ContextOutput, type ErrorOutput } from "./types.js";
import { formatMsg } from "./extract.js";

export function context(client: OpencodeClient): ToolDefinition {
  return tool({
    description: `Get messages surrounding a specific message in a session. Use after recall finds a match and you need conversation context — what was asked before, what came after. Returns a window of messages centered on the target.`,
    args: {
      sessionID: tool.schema
        .string()
        .describe("Session containing the message"),
      messageID: tool.schema
        .string()
        .describe("Center message to get context around"),
      window: tool.schema
        .number()
        .min(0)
        .max(10)
        .default(3)
        .describe(
          "Number of messages to include before AND after the target (symmetric). Overridden by before/after if set.",
        ),
      before: tool.schema
        .number()
        .min(0)
        .max(10)
        .optional()
        .describe(
          "Messages to include before the target (overrides window for the before side)",
        ),
      after: tool.schema
        .number()
        .min(0)
        .max(10)
        .optional()
        .describe(
          "Messages to include after the target (overrides window for the after side)",
        ),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      ctx.metadata({ title: "Getting context around message..." });

      const nb = args.before ?? args.window;
      const na = args.after ?? args.window;

      try {
        const resp = await client.session.messages({
          sessionID: args.sessionID,
        });
        if (resp.error) {
          const err: ErrorOutput = { ok: false, error: errmsg(resp.error) };
          return JSON.stringify(err);
        }
        if (!resp.data) {
          const err: ErrorOutput = { ok: false, error: "No messages returned" };
          return JSON.stringify(err);
        }

        const msgs = resp.data;
        const idx = msgs.findIndex((m) => m.info.id === args.messageID);
        if (idx === -1) {
          const err: ErrorOutput = {
            ok: false,
            error: `Message not found: ${args.messageID}`,
          };
          return JSON.stringify(err);
        }

        const start = Math.max(0, idx - nb);
        const end = Math.min(msgs.length, idx + na + 1);
        const slice = msgs.slice(start, end);

        const items = slice.map((m) => {
          const item = formatMsg(m);
          return { ...item, center: m.info.id === args.messageID };
        });

        let title: string | undefined;
        let directory: string | undefined;
        try {
          const sess = await client.session.get({ sessionID: args.sessionID });
          if (sess.data) {
            title = sess.data.title;
            directory = sess.data.directory;
          }
        } catch {
          // Cross-project session
        }

        ctx.metadata({
          title: `Context: ${items.length} messages around target${title ? ` from "${title}"` : ""}`,
        });

        const out: ContextOutput = {
          ok: true,
          messages: items,
          context: { sessionTitle: title, directory },
          hasMoreBefore: start > 0,
          hasMoreAfter: end < msgs.length,
        };
        return JSON.stringify(out);
      } catch (e) {
        const err: ErrorOutput = { ok: false, error: errmsg(e) };
        return JSON.stringify(err);
      }
    },
  });
}
