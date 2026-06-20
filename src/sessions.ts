import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import {
  errmsg,
  optionalString,
  coerceEnum,
  coerceInt,
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
    description: `List session metadata: titles, directories, timestamps, archival state. Use only for recent-session browsing, finding a session ID/title/timeframe, or recency checks. Not content search; for topical discovery use recall.`,
    args: {
      scope: tool.schema
        .enum(["project", "global"])
        .default("project")
        .describe("project=current project, global=all projects"),
      search: tool.schema.string().optional().describe("Title substring"),
      limit: tool.schema
        .number()
        .min(1)
        .max(limits.maxSessionList)
        .default(Math.min(20, limits.maxSessionList))
        .describe("Max sessions returned"),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      const search = optionalString(args.search);
      // Defensive: live MCP host can bypass Zod defaults.
      const scope = coerceEnum(args.scope, ["project", "global"] as const, "project");
      const limit = coerceInt(
        args.limit,
        Math.min(20, limits.maxSessionList),
        1,
        limits.maxSessionList,
      );

      ctx.metadata({
        title: search
          ? `Listing ${scope} sessions matching "${search}"`
          : `Listing ${scope} sessions`,
      });

      if (scope === "global" && !global) {
        const err: ErrorOutput = {
          ok: false,
          error: "Global scope disabled via plugin option: global: false",
        };
        return JSON.stringify(err);
      }

      try {
        const items: SessionItem[] = [];

        if (scope === "global") {
          const result = await unscoped.experimental.session.list({
            search,
            limit: limit,
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
            limit: limit,
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
          title: `Found ${items.length} ${scope} sessions${search ? ` matching "${search}"` : ""}`,
        });

        const out: SessionsOutput = {
          ok: true,
          sessions: items,
          returned: items.length,
          scope: scope,
        };
        return JSON.stringify(out);
      } catch (e) {
        const err: ErrorOutput = { ok: false, error: errmsg(e) };
        return JSON.stringify(err);
      }
    },
  });
}
