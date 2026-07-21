import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin";
import type { OpencodeClient, Part } from "@opencode-ai/sdk/v2";
import {
  errmsg,
  optionalString,
  coerceEnum,
  coerceInt,
  type MessagesOutput,
  type ErrorOutput,
  type Limits,
} from "./types.js";
import { formatMsg, searchable, matches } from "./extract.js";
import { fetchMessagePage } from "./fetch-window.js";
import type { FetchGate } from "./fetch-gate.js";

function msgMatches(msg: { parts: Array<Part> }, query: string): boolean {
  for (const part of msg.parts) {
    for (const text of searchable(part)) {
      if (matches(text, query)) return true;
    }
  }
  return false;
}

export function messages(client: OpencodeClient, gate: FetchGate, limits: Limits): ToolDefinition {
  return tool({
    description: `Browse a known session's messages, newest first, one bounded page at a time. Pass cursor from a prior page's nextCursor to continue. Optional role/query filter the returned page. Use after you know the session; for topical discovery across sessions use recall first.`,
    args: {
      sessionID: tool.schema.string().optional().describe("Session to browse; default current"),
      limit: tool.schema
        .number()
        .min(1)
        .max(limits.maxMessages)
        .default(Math.min(10, limits.maxMessages))
        .describe("Max messages in this page"),
      cursor: tool.schema
        .string()
        .optional()
        .describe("nextCursor from a prior page; omit for the first (newest) page"),
      role: tool.schema
        .enum(["user", "assistant", "all"])
        .default("all")
        .describe("Role filter (within the page)"),
      query: tool.schema
        .string()
        .min(1)
        .optional()
        .describe("Message content substring filter (within the page)"),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      const sid = optionalString(args.sessionID) ?? ctx.sessionID;
      const query = optionalString(args.query);
      // The live MCP host can bypass Zod defaults, so coerce every optional arg
      // defensively. An undefined `role` previously made `role !== "all"` true
      // and filtered out every message (returned: 0 on a non-empty session).
      const role = coerceEnum(args.role, ["user", "assistant", "all"] as const, "all");
      const limit = coerceInt(args.limit, Math.min(10, limits.maxMessages), 1, limits.maxMessages);
      const cursor = optionalString(args.cursor);
      if (!sid) {
        const err: ErrorOutput = {
          ok: false,
          error: "No sessionID provided and no current session available",
        };
        return JSON.stringify(err);
      }

      ctx.metadata({ title: "Browsing messages..." });

      try {
        // Always a bounded page (limit + cursor), through the shared gate —
        // never an unpaginated fetch and never outside the concurrency budget.
        const page = await gate.runQuery(() =>
          fetchMessagePage(client, { sessionID: sid, limit, before: cursor }),
        );

        let items = page.items; // newest-first
        if (role !== "all") items = items.filter((m) => m.info.role === role);
        if (query) items = items.filter((m) => msgMatches(m, query));
        const formatted = items.map(formatMsg);

        let title: string | undefined;
        let directory: string | undefined;
        try {
          const sess = await gate.runQuery(() => client.session.get({ sessionID: sid }));
          if (sess.data) {
            title = sess.data.title;
            directory = sess.data.directory;
          }
        } catch {
          // Cross-project session
        }

        ctx.metadata({
          title: `Showing ${formatted.length} messages${title ? ` from "${title}"` : ""}${page.nextCursor ? " (more available)" : ""}`,
        });

        const out: MessagesOutput = {
          ok: true,
          messages: formatted,
          context: { sessionTitle: title, directory },
          pagination: {
            limit,
            returned: formatted.length,
            hasMore: page.nextCursor != null,
            ...(page.nextCursor != null ? { nextCursor: page.nextCursor } : {}),
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
