import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import {
  errmsg,
  coerceInt,
  optionalString,
  type ContextOutput,
  type ErrorOutput,
  type Limits,
} from "./types.js";
import { formatMsg } from "./extract.js";

export function context(client: OpencodeClient, limits: Limits): ToolDefinition {
  return tool({
    description: `Get messages around a recall hit to see what was asked before, what happened after, and whether the approach worked. Use recall_get for only the single message.

If memory exists, store only durable findings surfaced here; skip ephemeral details/minutiae.`,
    args: {
      sessionID: tool.schema.string().describe("Session containing the message"),
      messageID: tool.schema.string().describe("Center message to get context around"),
      window: tool.schema
        .number()
        .min(0)
        .max(limits.maxWindow)
        .default(Math.min(3, limits.maxWindow))
        .describe("Messages on each side; overridden by before/after"),
      before: tool.schema
        .number()
        .min(0)
        .max(limits.maxWindow)
        .optional()
        .describe("Messages before target; 0 allowed"),
      after: tool.schema
        .number()
        .min(0)
        .max(limits.maxWindow)
        .optional()
        .describe("Messages after target"),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      ctx.metadata({ title: "Getting context around message..." });

      // Defensive: the live MCP host can bypass Zod defaults, leaving window /
      // before / after undefined (which would make the slice bounds NaN).
      const sessionID = optionalString(args.sessionID);
      const messageID = optionalString(args.messageID);
      if (!sessionID || !messageID) {
        const err: ErrorOutput = { ok: false, error: "sessionID and messageID are required" };
        return JSON.stringify(err);
      }
      const window = coerceInt(args.window, Math.min(3, limits.maxWindow), 0, limits.maxWindow);
      const nb = args.before == null ? window : coerceInt(args.before, window, 0, limits.maxWindow);
      const na = args.after == null ? window : coerceInt(args.after, window, 0, limits.maxWindow);

      try {
        const resp = await client.session.messages({
          sessionID: sessionID,
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
        const idx = msgs.findIndex((m) => m.info.id === messageID);
        if (idx === -1) {
          const err: ErrorOutput = {
            ok: false,
            error: `Message not found: ${messageID}`,
          };
          return JSON.stringify(err);
        }

        const start = Math.max(0, idx - nb);
        const end = Math.min(msgs.length, idx + na + 1);
        const slice = msgs.slice(start, end);

        const items = slice.map((m) => {
          const item = formatMsg(m);
          return { ...item, center: m.info.id === messageID };
        });

        let title: string | undefined;
        let directory: string | undefined;
        try {
          const sess = await client.session.get({ sessionID: sessionID });
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
