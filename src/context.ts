import { tool } from "./tool-def.js";
import type { ToolDefinition, ToolContext } from "./host/opencode-v1-types.js";
import { errmsg, coerceInt, optionalString, type Limits, type MessageItem } from "./types.js";
import { fetchMessageWindow } from "./fetch-window.js";
import type { HistorySource } from "./history/source.js";
import type { FetchGate } from "./fetch-gate.js";
import {
  decodeContextCursor,
  encodeContextCursor,
  fitMessage,
  messageItem,
  resumeMessageList,
  section,
  writeError,
  writeOutput,
  type MessagePosition,
  type PartPosition,
} from "./output.js";

/** Never fetch more than this many messages while locating a context window —
 *  the safety valve that keeps an old target in a giant session bounded. */
const MAX_CONTEXT_FETCH = 200;

export function context(source: HistorySource, gate: FetchGate, limits: Limits): ToolDefinition {
  return tool({
    description: `Get messages around a recall hit to see what was asked before, what happened after, and whether the approach worked. Use recall_get for only the single message. A trimmed result continues with cursor: continuation (same arguments).

If memory exists, store only durable findings surfaced here; skip ephemeral details/minutiae.`,
    args: {
      sessionID: tool.schema.string().describe("Session containing the message"),
      messageID: tool.schema.string().describe("Center message to get context around"),
      window: tool.schema
        .number()
        .min(0)
        .max(limits.maxWindow)
        .default(Math.min(3, limits.maxWindow))
        .describe("Messages on each side; overridden by before/after"),
      before: tool.schema
        .number()
        .min(0)
        .max(limits.maxWindow)
        .optional()
        .describe("Messages before target; 0 allowed"),
      after: tool.schema
        .number()
        .min(0)
        .max(limits.maxWindow)
        .optional()
        .describe("Messages after target"),
      cursor: tool.schema
        .string()
        .optional()
        .describe("continuation from a trimmed result; omit for the start"),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      ctx.metadata({ title: "Getting context around message..." });

      // Defensive: the live MCP host can bypass Zod defaults, leaving window /
      // before / after undefined (which would make the slice bounds NaN), and
      // a non-string cursor reads as none.
      const sessionID = optionalString(args.sessionID);
      const messageID = optionalString(args.messageID);
      if (!sessionID || !messageID) return writeError("sessionID and messageID are required");
      const window = coerceInt(args.window, Math.min(3, limits.maxWindow), 0, limits.maxWindow);
      const nb = args.before == null ? window : coerceInt(args.before, window, 0, limits.maxWindow);
      const na = args.after == null ? window : coerceInt(args.after, window, 0, limits.maxWindow);
      const cursor = optionalString(args.cursor);
      let resume: MessagePosition | undefined;
      if (cursor) {
        const decoded = decodeContextCursor(cursor);
        if (!decoded.ok) return writeError(decoded.error);
        if (decoded.value.center !== messageID) {
          return writeError(
            `This cursor continues the context around ${decoded.value.center}, not ${messageID}`,
          );
        }
        resume = decoded.value.at;
      }

      try {
        // Bounded newest-first pagination — never an unpaginated whole-session
        // fetch. Page size covers the requested window in one page for ordinary
        // sessions; the cap bounds the worst case.
        const pageMessages = Math.min(
          limits.maxMessages,
          Math.max(nb + na + 1, Math.min(25, limits.maxMessages)),
        );
        const window = await fetchMessageWindow(
          source,
          {
            sessionID,
            messageID,
            before: nb,
            after: na,
            pageMessages,
            maxMessages: MAX_CONTEXT_FETCH,
          },
          (fn) => gate.runQuery(fn),
        );
        if (window.loadError) return writeError(window.loadError);
        if (window.fetched === 0) return writeError("No messages returned");
        if (window.centerIndex === -1) return writeError(`Message not found: ${messageID}`);

        let items: MessageItem[] = window.messages.map((m) => ({
          ...messageItem(m),
          center: m.info.id === messageID,
        }));
        if (resume) {
          const resumed = resumeMessageList(items, resume);
          if (!resumed) {
            return writeError(
              `This cursor's message ${resume.message} is no longer in the window; get the context again without cursor`,
            );
          }
          items = resumed;
        }

        let title: string | undefined;
        let directory: string | undefined;
        try {
          const sess = await gate.runQuery(() =>
            source.getSession(sessionID, { scope: "project" }),
          );
          if (sess.ok) {
            title = sess.value.title;
            directory = sess.value.directory;
          }
        } catch {
          // Cross-project session
        }

        ctx.metadata({
          title: `Context: ${items.length} messages around target${title ? ` from "${title}"` : ""}`,
        });

        return writeOutput<PartPosition>({
          sections: [section("messages", items, fitMessage)],
          head: (stop) => ({
            ...(stop && {
              continuation: encodeContextCursor({
                center: messageID,
                at: {
                  message: items[stop.index]!.message.id,
                  ...(stop.rest && { at: stop.rest }),
                },
              }),
            }),
            fields: {
              context: { sessionTitle: title, directory },
              hasMoreBefore: window.hasMoreBefore,
              hasMoreAfter: window.hasMoreAfter,
            },
          }),
        }).text;
      } catch (e) {
        return writeError(errmsg(e));
      }
    },
  });
}
