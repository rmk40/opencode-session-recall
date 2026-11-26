import { tool } from "./tool-def.js";
import type { ToolDefinition, ToolContext } from "./host/opencode-v1-types.js";
import type { Part } from "@opencode-ai/sdk/v2";
import {
  errmsg,
  optionalString,
  coerceEnum,
  coerceInt,
  type Limits,
  type MessageItem,
} from "./types.js";
import { searchable, matches } from "./extract.js";
import type { HistorySource, MessagePage } from "./history/source.js";
import type { FetchGate } from "./fetch-gate.js";
import {
  decodeMessagesCursor,
  encodeMessagesCursor,
  fitMessage,
  isContinuation,
  messageItem,
  resumeMessage,
  section,
  writeError,
  writeOutput,
  type MessagePosition,
  type PartPosition,
} from "./output.js";

/** Pages a continuation reads, its own page included, to find the message it
 *  resumes at. The newest page shifts as messages arrive between calls, so
 *  the message can move onto the page after it. */
const RESUME_PAGES = 3;

function msgMatches(msg: { parts: Array<Part> }, query: string): boolean {
  for (const part of msg.parts) {
    for (const text of searchable(part)) {
      if (matches(text, query)) return true;
    }
  }
  return false;
}

export function messages(source: HistorySource, gate: FetchGate, limits: Limits): ToolDefinition {
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
      if (!sid) return writeError("No sessionID provided and no current session available");

      // The cursor is this tool's own continuation, or a history source page
      // cursor a caller may still hold, which reads that page from its start.
      let before = cursor;
      let resume: MessagePosition | undefined;
      if (cursor && isContinuation(cursor)) {
        const decoded = decodeMessagesCursor(cursor);
        if (!decoded.ok) return writeError(decoded.error);
        if (decoded.value.session !== sid) {
          return writeError(
            `This cursor continues session ${decoded.value.session}, not ${sid}; pass that sessionID`,
          );
        }
        before = decoded.value.page ?? undefined;
        resume = decoded.value.at;
      }

      ctx.metadata({ title: "Browsing messages..." });

      try {
        // Always a bounded page (limit + cursor), through the shared gate —
        // never an unpaginated fetch and never outside the concurrency budget.
        const read = (page: string | undefined): Promise<MessagePage> =>
          gate.runQuery(() => source.messagePage({ sessionID: sid, limit, before: page }));
        let page = await read(before);
        let start = 0;
        if (resume) {
          const anchor = resume.message;
          for (let pages = 1; ; pages++) {
            start = page.items.findIndex((m) => m.info.id === anchor);
            if (start !== -1) break;
            if (pages >= RESUME_PAGES || page.nextCursor == null) {
              return writeError(
                `This cursor's message ${anchor} is no longer where it was; browse again without cursor`,
              );
            }
            before = page.nextCursor;
            page = await read(before);
          }
        }

        let items = page.items.slice(start); // newest-first
        if (role !== "all") items = items.filter((m) => m.info.role === role);
        if (query) items = items.filter((m) => msgMatches(m, query));
        const formatted: MessageItem[] = items.map(messageItem);
        // Resume inside the anchor message only while the filters keep it.
        const resumeAt = resume?.at;
        const anchorItem = formatted[0];
        if (resumeAt && anchorItem && anchorItem.message.id === resume?.message) {
          const resumed = resumeMessage(anchorItem, resumeAt);
          if (!resumed) {
            return writeError(
              `This cursor's part ${resumeAt.part} is no longer in message ${resume?.message}; browse again without cursor`,
            );
          }
          formatted[0] = resumed;
        }

        let title: string | undefined;
        let directory: string | undefined;
        try {
          const sess = await gate.runQuery(() => source.getSession(sid, { scope: "project" }));
          if (sess.ok) {
            title = sess.value.title;
            directory = sess.value.directory;
          }
        } catch {
          // Cross-project session
        }

        ctx.metadata({
          title: `Showing ${formatted.length} messages${title ? ` from "${title}"` : ""}${page.nextCursor ? " (more available)" : ""}`,
        });

        const pageCursor = before ?? null;
        const nextPage =
          page.nextCursor != null
            ? encodeMessagesCursor({ session: sid, page: page.nextCursor })
            : undefined;
        return writeOutput<PartPosition>({
          sections: [section("messages", formatted, fitMessage)],
          head: (stop, shown) => {
            // A trimmed output continues at the message it stopped at, on the
            // page it read; otherwise the next page follows.
            const continuation = stop
              ? encodeMessagesCursor({
                  session: sid,
                  page: pageCursor,
                  at: {
                    message: formatted[stop.index]!.message.id,
                    ...(stop.rest && { at: stop.rest }),
                  },
                })
              : undefined;
            const nextCursor = continuation ?? nextPage;
            return {
              ...(continuation && { continuation }),
              fields: {
                context: { sessionTitle: title, directory },
                pagination: {
                  limit,
                  returned: shown.messages ?? 0,
                  hasMore: nextCursor !== undefined,
                  ...(nextCursor !== undefined && { nextCursor }),
                },
              },
            };
          },
        }).text;
      } catch (e) {
        return writeError(errmsg(e));
      }
    },
  });
}
