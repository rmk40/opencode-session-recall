import {
  tool,
  type ToolDefinition,
  type ToolContext,
} from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import {
  errmsg,
  optionalString,
  type SessionItem,
  type SessionsOutput,
  type ErrorOutput,
  type Limits,
} from "./types.js";

export function sessions(
  client: OpencodeClient,
  unscoped: OpencodeClient,
  global: boolean,
  limits: Limits,
): ToolDefinition {
  return tool({
    description: `List sessions from the opencode database. Returns session titles, directories, and timestamps. For cross-project discovery, use scope "global" (enabled by default, disable with plugin option global: false).

This is a metadata-only listing tool, NOT a content search. Session titles are usually auto-generated timestamps and won't match topic keywords. To find prior work on a topic, use recall (content search) instead — it searches inside actual messages and tool outputs. Use recall_sessions to browse recent sessions by project, check session recency, or get session IDs for recall_messages.

Returns { ok, sessions: [{ id, title, directory, time, archived }], returned, scope }. All tools return JSON with ok: true on success or ok: false with error on failure.`,
    args: {
      scope: tool.schema
        .enum(["project", "global"])
        .default("project")
        .describe("project = current project, global = all projects"),
      search: tool.schema
        .string()
        .optional()
        .describe("Case-insensitive substring match on session title"),
      limit: tool.schema
        .number()
        .min(1)
        .max(limits.maxSessionList)
        .default(Math.min(20, limits.maxSessionList))
        .describe("Max sessions to return (newest first)"),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      const search = optionalString(args.search);

      ctx.metadata({
        title: search
          ? `Listing ${args.scope} sessions matching "${search}"`
          : `Listing ${args.scope} sessions`,
      });

      if (args.scope === "global" && !global) {
        const err: ErrorOutput = {
          ok: false,
          error: "Global scope disabled via plugin option: global: false",
        };
        return JSON.stringify(err);
      }

      try {
        const items: SessionItem[] = [];

        if (args.scope === "global") {
          const result = await unscoped.experimental.session.list({
            search,
            limit: args.limit,
          });
          if (result.error) {
            const err: ErrorOutput = {
              ok: false,
              error: `Failed to list sessions: ${errmsg(result.error)}`,
            };
            return JSON.stringify(err);
          }
          if (result.data) {
            for (const s of result.data) {
              items.push({
                id: s.id,
                title: s.title,
                directory: s.directory,
                project: s.project
                  ? { name: s.project.name, worktree: s.project.worktree }
                  : undefined,
                time: { created: s.time.created, updated: s.time.updated },
                archived: s.time.archived != null,
              });
            }
          }
        } else {
          const result = await client.session.list({
            search,
            limit: args.limit,
          });
          if (result.error) {
            const err: ErrorOutput = {
              ok: false,
              error: `Failed to list sessions: ${errmsg(result.error)}`,
            };
            return JSON.stringify(err);
          }
          if (result.data) {
            for (const s of result.data) {
              items.push({
                id: s.id,
                title: s.title,
                directory: s.directory,
                time: { created: s.time.created, updated: s.time.updated },
                archived: s.time.archived != null,
              });
            }
          }
        }

        ctx.metadata({
          title: `Found ${items.length} ${args.scope} sessions${search ? ` matching "${search}"` : ""}`,
        });

        const out: SessionsOutput = {
          ok: true,
          sessions: items,
          returned: items.length,
          scope: args.scope,
        };
        return JSON.stringify(out);
      } catch (e) {
        const err: ErrorOutput = { ok: false, error: errmsg(e) };
        return JSON.stringify(err);
      }
    },
  });
}
