import {
  tool,
  type ToolDefinition,
  type ToolContext,
} from "@opencode-ai/plugin";
import type {
  OpencodeClient,
  Session,
  GlobalSession,
  Part,
} from "@opencode-ai/sdk/v2";
import {
  errmsg,
  type SearchResult,
  type SearchOutput,
  type ErrorOutput,
  type Limits,
} from "./types.js";
import { searchable, snippet, pruned, matches } from "./extract.js";

type MsgWithParts = {
  info: { id: string; role: "user" | "assistant"; time: { created: number } };
  parts: Array<Part>;
};

type SessionMeta = { id: string; title: string; directory: string };

function meta(s: Session | GlobalSession): SessionMeta {
  return { id: s.id, title: s.title, directory: s.directory };
}

function scan(
  messages: MsgWithParts[],
  session: SessionMeta,
  query: string,
  type: string,
  role: string,
  limit: number,
  before?: number,
  after?: number,
  width?: number,
): { results: SearchResult[]; total: number } {
  const results: SearchResult[] = [];
  let total = 0;

  for (const msg of messages) {
    if (results.length >= limit) break;
    const ts = msg.info.time.created;
    if (before != null && ts >= before) continue;
    if (after != null && ts <= after) continue;
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
            snippet: snippet(text, query, width),
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
  unscoped: OpencodeClient,
  global: boolean,
  limits: Limits,
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
        .max(limits.maxSessions)
        .default(10)
        .describe("Max sessions to scan"),
      results: tool.schema
        .number()
        .min(1)
        .max(limits.maxResults)
        .default(10)
        .describe("Max results to return"),
      title: tool.schema
        .string()
        .optional()
        .describe("Filter sessions by title"),
      before: tool.schema
        .number()
        .optional()
        .describe("Only match messages before this timestamp (ms epoch)"),
      after: tool.schema
        .number()
        .optional()
        .describe("Only match messages after this timestamp (ms epoch)"),
      width: tool.schema
        .number()
        .min(50)
        .max(1000)
        .default(limits.defaultWidth)
        .describe("Snippet width in characters"),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      ctx.metadata({ title: `Searching ${args.scope} for "${args.query}"` });

      if (args.scope === "global" && !args.sessionID && !global) {
        const err: ErrorOutput = {
          ok: false,
          error:
            "Global scope disabled. Enable via plugin option: global: true",
        };
        return JSON.stringify(err);
      }

      try {
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
          if (resp.error) {
            const err: ErrorOutput = {
              ok: false,
              error: `Failed to list sessions: ${errmsg(resp.error)}`,
            };
            return JSON.stringify(err);
          }
          if (resp.data) targets = resp.data.map(meta);
        } else {
          const resp = await unscoped.experimental.session.list({
            search: args.title,
            limit: args.sessions,
          });
          if (resp.error) {
            const err: ErrorOutput = {
              ok: false,
              error: `Failed to list sessions: ${errmsg(resp.error)}`,
            };
            return JSON.stringify(err);
          }
          if (resp.data) targets = resp.data.map(meta);
        }

        const collected: SearchResult[] = [];
        let scanned = 0;
        let total = 0;
        let early = false;

        for (let i = 0; i < targets.length; i += limits.concurrency) {
          if (ctx.abort.aborted) {
            early = true;
            break;
          }
          if (collected.length >= args.results) {
            early = true;
            break;
          }

          const remaining = args.results - collected.length;
          const batch = targets.slice(i, i + limits.concurrency);

          const loaded = await Promise.all(
            batch.map(async (t) => {
              try {
                const resp = await client.session.messages({ sessionID: t.id });
                return { session: t, messages: resp.data ?? [] };
              } catch {
                return { session: t, messages: [] as MsgWithParts[] };
              }
            }),
          );

          for (const { session: sess, messages: msgs } of loaded) {
            if (collected.length >= args.results) {
              early = true;
              break;
            }
            const result = scan(
              msgs,
              sess,
              args.query,
              args.type,
              args.role,
              remaining,
              args.before,
              args.after,
              args.width,
            );
            collected.push(...result.results);
            total += result.total;
          }
          scanned += batch.length;
        }

        const final = collected.slice(0, args.results);

        ctx.metadata({
          title: `Found ${final.length} result${final.length !== 1 ? "s" : ""} for "${args.query}" (${scanned} session${scanned !== 1 ? "s" : ""} searched)`,
        });

        const out: SearchOutput = {
          ok: true,
          results: final,
          scanned,
          total,
          truncated: early || total > final.length,
        };
        return JSON.stringify(out);
      } catch (e) {
        const err: ErrorOutput = { ok: false, error: errmsg(e) };
        return JSON.stringify(err);
      }
    },
  });
}
