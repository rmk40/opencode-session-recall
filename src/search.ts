import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin";
import type {
  OpencodeClient,
  Session,
  GlobalSession,
} from "@opencode-ai/sdk/v2";
import type { SearchResult, SearchOutput, ErrorOutput } from "./types.js";
import { searchable, snippet, pruned } from "./extract.js";

type Client = OpencodeClient;

const CONCURRENCY = 3;

type SessionMeta = { id: string; title: string; directory: string };

function meta(s: Session | GlobalSession): SessionMeta {
  return { id: s.id, title: s.title, directory: s.directory };
}

function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

async function scan(
  client: Client,
  session: SessionMeta,
  query: string,
  type: string,
  role: string,
  results: SearchResult[],
  limit: number,
): Promise<number> {
  let total = 0;
  const resp = await client.session.messages({ sessionID: session.id });
  if (!resp.data) return 0;

  for (const msg of resp.data) {
    if (results.length >= limit) break;
    if (role !== "all" && msg.info.role !== role) continue;

    for (const part of msg.parts) {
      if (results.length >= limit) break;
      if (type !== "all" && part.type !== type) continue;

      const texts = searchable(part);
      let matched = false;

      for (const text of texts) {
        if (!matches(text, query)) continue;
        total++;
        if (matched) continue; // dedup: one result per part
        matched = true;

        if (results.length < limit) {
          results.push({
            sessionID: session.id,
            sessionTitle: session.title,
            directory: session.directory,
            messageID: msg.info.id,
            role: msg.info.role,
            time: msg.info.time.created,
            partID: part.id,
            partType: part.type,
            pruned: pruned(part),
            snippet: snippet(text, query),
            toolName: part.type === "tool" ? part.tool : undefined,
          });
        }
      }
    }
  }
  return total;
}

export function search(client: Client, global: boolean): ToolDefinition {
  return tool({
    description: `Search your conversation history in the opencode database. Use this to recover context lost to compaction — original tool outputs, earlier messages, reasoning, and user instructions that were pruned from your context window.

Searches text content, tool inputs/outputs, and reasoning. Returns matching snippets with session/message IDs you can pass to recall_get for full content.

Start with scope "session" (fastest). Widen to "project" if not found. Use sessionID param to target a specific session found via recall_sessions. Use role "user" to find original requirements.`,
    args: {
      query: tool.schema
        .string()
        .min(1)
        .describe("Text to search for (case-insensitive)"),
      scope: tool.schema
        .enum(["session", "project", "global"])
        .default("session")
        .describe(
          "session = current, project = all project sessions, global = all",
        ),
      sessionID: tool.schema
        .string()
        .optional()
        .describe("Search a specific session (overrides scope)"),
      type: tool.schema
        .enum(["text", "tool", "reasoning", "all"])
        .default("all")
        .describe("Filter by part type"),
      role: tool.schema
        .enum(["user", "assistant", "all"])
        .default("all")
        .describe("Filter by message role"),
      sessions: tool.schema
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Max sessions to scan"),
      results: tool.schema
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Max results to return"),
      title: tool.schema
        .string()
        .optional()
        .describe("Filter sessions by title"),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      if (args.scope === "global" && !args.sessionID && !global) {
        const err: ErrorOutput = {
          ok: false,
          error:
            "Global scope disabled. Enable via plugin option: global: true",
        };
        return JSON.stringify(err);
      }

      try {
        const results: SearchResult[] = [];
        let scanned = 0;
        let total = 0;

        // Build session list
        let targets: SessionMeta[] = [];

        if (args.sessionID) {
          // Explicit session target
          let title = "";
          let directory = "";
          try {
            const sess = await client.session.get({
              sessionID: args.sessionID,
            });
            if (sess.data) {
              title = sess.data.title;
              directory = sess.data.directory;
            }
          } catch {
            // Can't get metadata, proceed anyway
          }
          targets = [{ id: args.sessionID, title, directory }];
        } else if (args.scope === "session") {
          let title = "";
          let directory = "";
          try {
            const sess = await client.session.get({ sessionID: ctx.sessionID });
            if (sess.data) {
              title = sess.data.title;
              directory = sess.data.directory;
            }
          } catch {
            // proceed without metadata
          }
          targets = [{ id: ctx.sessionID, title, directory }];
        } else if (args.scope === "project") {
          const resp = await client.session.list({
            search: args.title,
            limit: args.sessions,
          });
          if (resp.data) targets = resp.data.map(meta);
        } else {
          const resp = await client.experimental.session.list({
            search: args.title,
            limit: args.sessions,
          });
          if (resp.data) targets = resp.data.map(meta);
        }

        // Process in batches with bounded concurrency
        for (let i = 0; i < targets.length; i += CONCURRENCY) {
          if (ctx.abort.aborted) break;
          if (results.length >= args.results) break;

          const batch = targets.slice(i, i + CONCURRENCY);
          const counts = await Promise.all(
            batch.map(async (t) => {
              try {
                return await scan(
                  client,
                  t,
                  args.query,
                  args.type,
                  args.role,
                  results,
                  args.results,
                );
              } catch {
                return 0; // skip failed sessions
              }
            }),
          );
          scanned += batch.length;
          for (const c of counts) total += c;
        }

        const out: SearchOutput = {
          ok: true,
          results,
          scanned,
          total,
          truncated: results.length >= args.results || ctx.abort.aborted,
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
