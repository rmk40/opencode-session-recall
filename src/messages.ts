import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin";
import type { OpencodeClient, Part } from "@opencode-ai/sdk/v2";
import {
  errmsg,
  optionalString,
  type MessagesOutput,
  type ErrorOutput,
  type Limits,
} from "./types.js";
import { formatMsg, searchable, matches } from "./extract.js";

function msgMatches(msg: { parts: Array<Part> }, query: string): boolean {
  for (const part of msg.parts) {
    for (const text of searchable(part)) {
      if (matches(text, query)) return true;
    }
  }
  return false;
}

export function messages(client: OpencodeClient, limits: Limits): ToolDefinition {
  return tool({
    description: `Browse a known session chronologically with full messages and pagination. Use after you know the session and need to replay, inspect beginning/end, or filter within it. For topical discovery across sessions use recall first. reverse=true starts newest.`,
    args: {
      sessionID: tool.schema.string().optional().describe("Session to browse; default current"),
      offset: tool.schema.number().min(0).default(0).describe("Messages to skip"),
      limit: tool.schema
        .number()
        .min(1)
        .max(limits.maxMessages)
        .default(Math.min(10, limits.maxMessages))
        .describe("Max messages returned"),
      role: tool.schema.enum(["user", "assistant", "all"]).default("all").describe("Role filter"),
      reverse: tool.schema.boolean().default(false).describe("Newest first"),
      query: tool.schema.string().min(1).optional().describe("Message content substring filter"),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      const sid = optionalString(args.sessionID) ?? ctx.sessionID;
      const query = optionalString(args.query);
      if (!sid) {
        const err: ErrorOutput = {
          ok: false,
          error: "No sessionID provided and no current session available",
        };
        return JSON.stringify(err);
      }

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
        if (args.role !== "all") filtered = filtered.filter((m) => m.info.role === args.role);
        if (query) filtered = filtered.filter((m) => msgMatches(m, query));

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
