import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { SessionItem, SessionsOutput, ErrorOutput } from "./types.js";

type Client = OpencodeClient;

export function sessions(client: Client, global: boolean): ToolDefinition {
  return tool({
    description: `List sessions from the opencode database. Use this FIRST to discover which sessions exist, then search their content with recall. Returns session titles, directories, and timestamps. For cross-project discovery, use scope "global" (requires plugin option global: true).`,
    args: {
      scope: tool.schema
        .enum(["project", "global"])
        .default("project")
        .describe("project = current project, global = all projects"),
      search: tool.schema
        .string()
        .optional()
        .describe("Filter by session title"),
      limit: tool.schema
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max sessions to return"),
    },
    async execute(args): Promise<string> {
      if (args.scope === "global" && !global) {
        const err: ErrorOutput = {
          ok: false,
          error:
            "Global scope disabled. Enable via plugin option: global: true",
        };
        return JSON.stringify(err);
      }

      try {
        const items: SessionItem[] = [];

        if (args.scope === "global") {
          const result = await client.experimental.session.list({
            search: args.search,
            limit: args.limit,
          });
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
            search: args.search,
            limit: args.limit,
          });
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

        const out: SessionsOutput = {
          ok: true,
          sessions: items,
          returned: items.length,
          scope: args.scope,
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
