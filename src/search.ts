import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin";
import type {
  OpencodeClient,
  Session,
  GlobalSession,
} from "@opencode-ai/sdk/v2";
import {
  errmsg,
  type SearchResult,
  type SearchOutput,
  type ErrorOutput,
} from "./types.js";
import { searchable, snippet, pruned } from "./extract.js";

const CONCURRENCY = 3;

type SessionMeta = { id: string; title: string; directory: string };

function meta(s: Session | GlobalSession): SessionMeta {
  return { id: s.id, title: s.title, directory: s.directory };
}

function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

function scan(
  messages: Array<{
    info: { id: string; role: "user" | "assistant"; time: { created: number } };
    parts: Array<any>;
  }>,
  session: SessionMeta,
  query: string,
  type: string,
  role: string,
  limit: number,
): { results: SearchResult[]; total: number } {
  const results: SearchResult[] = [];
  let total = 0;

  for (const msg of messages) {
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
        if (matched) continue;
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
  return { results, total };
}

export function search(
  client: OpencodeClient,
  global: boolean,
): ToolDefinition {
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
        // Build session list
        let targets: SessionMeta[] = [];

        if (args.sessionID) {
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

        // Collect results per-session then merge to avoid race conditions
        const collected: SearchResult[] = [];
        let scanned = 0;
        let total = 0;
        let early = false;

        for (let i = 0; i < targets.length; i += CONCURRENCY) {
          if (ctx.abort.aborted) {
            early = true;
            break;
          }
          if (collected.length >= args.results) {
            early = true;
            break;
          }

          const remaining = args.results - collected.length;
          const batch = targets.slice(i, i + CONCURRENCY);

          // Load messages in parallel, scan sequentially per-session
          const loaded = await Promise.all(
            batch.map(async (t) => {
              try {
                const resp = await client.session.messages({ sessionID: t.id });
                return { session: t, messages: resp.data ?? [] };
              } catch {
                return { session: t, messages: [] as Array<any> };
              }
            }),
          );

          for (const { session: sess, messages } of loaded) {
            if (collected.length >= args.results) {
              early = true;
              break;
            }
            const result = scan(
              messages,
              sess,
              args.query,
              args.type,
              args.role,
              remaining,
            );
            collected.push(...result.results);
            total += result.total;
          }
          scanned += batch.length;
        }

        // Trim to limit (in case last batch produced excess)
        const final = collected.slice(0, args.results);

        const out: SearchOutput = {
          ok: true,
          results: final,
          scanned,
          total,
          truncated: early || total > final.length,
        };
        return JSON.stringify(out);
      } catch (e) {
        const err: ErrorOutput = {
          ok: false,
          error: errmsg(e),
        };
        return JSON.stringify(err);
      }
    },
  });
}
