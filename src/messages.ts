import {
  tool,
  type ToolDefinition,
  type ToolContext,
} from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { errmsg, type MessagesOutput, type ErrorOutput } from "./types.js";
import { formatMsg, searchable } from "./extract.js";

function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

function msgMatches(msg: { parts: Array<any> }, query: string): boolean {
  for (const part of msg.parts) {
    for (const text of searchable(part)) {
      if (matches(text, query)) return true;
    }
  }
  return false;
}

export function messages(client: OpencodeClient): ToolDefinition {
  return tool({
    description: `Browse messages in a session chronologically with pagination. Use to play back conversation history, see what happened in order, or find the user's original requirements. Use reverse=true to start from the most recent messages (offset 0 = newest). Use offset to paginate through results.`,
    args: {
      sessionID: tool.schema
        .string()
        .optional()
        .describe(
          "Session to browse. Defaults to current session if not provided.",
        ),
      offset: tool.schema
        .number()
        .min(0)
        .default(0)
        .describe(
          "Skip this many messages from the start (or end if reversed)",
        ),
      limit: tool.schema
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Max messages to return"),
      role: tool.schema
        .enum(["user", "assistant", "all"])
        .default("all")
        .describe("Filter by message role"),
      reverse: tool.schema
        .boolean()
        .default(false)
        .describe("If true, start from most recent messages"),
      query: tool.schema
        .string()
        .optional()
        .describe(
          "Only include messages containing this text (searches all parts)",
        ),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      const sid = args.sessionID ?? ctx.sessionID;
      ctx.metadata({ title: "Browsing messages..." });

      try {
        const resp = await client.session.messages({ sessionID: sid });
        if (resp.error) {
          const err: ErrorOutput = { ok: false, error: errmsg(resp.error) };
          return JSON.stringify(err);
        }
        if (!resp.data) {
          const err: ErrorOutput = { ok: false, error: "No messages returned" };
          return JSON.stringify(err);
        }

        let filtered = resp.data;
        if (args.role !== "all")
          filtered = filtered.filter((m) => m.info.role === args.role);
        if (args.query)
          filtered = filtered.filter((m) => msgMatches(m, args.query!));

        const ordered = args.reverse ? [...filtered].reverse() : filtered;
        const slice = ordered.slice(args.offset, args.offset + args.limit);
        const items = slice.map(formatMsg);

        let title: string | undefined;
        let directory: string | undefined;
        try {
          const sess = await client.session.get({ sessionID: sid });
          if (sess.data) {
            title = sess.data.title;
            directory = sess.data.directory;
          }
        } catch {
          // Cross-project session
        }

        ctx.metadata({
          title: `Showing ${items.length} of ${filtered.length} messages (offset ${args.offset})${title ? ` from "${title}"` : ""}`,
        });

        const out: MessagesOutput = {
          ok: true,
          messages: items,
          context: { sessionTitle: title, directory },
          pagination: {
            offset: args.offset,
            returned: items.length,
            total: filtered.length,
            hasMore: args.offset + args.limit < filtered.length,
          },
        };
        return JSON.stringify(out);
      } catch (e) {
        const err: ErrorOutput = { ok: false, error: errmsg(e) };
        return JSON.stringify(err);
      }
    },
  });
}
