import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import {
  errmsg,
  coerceInt,
  optionalString,
  type ContextOutput,
  type ErrorOutput,
  type Limits,
} from "./types.js";
import { formatMsg } from "./extract.js";
import { fetchMessageWindow } from "./fetch-window.js";
import type { FetchGate } from "./fetch-gate.js";

/** Never fetch more than this many messages while locating a context window —
 *  the safety valve that keeps an old target in a giant session bounded. */
const MAX_CONTEXT_FETCH = 200;

export function context(client: OpencodeClient, gate: FetchGate, limits: Limits): ToolDefinition {
  return tool({
    description: `Get messages around a recall hit to see what was asked before, what happened after, and whether the approach worked. Use recall_get for only the single message.

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
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      ctx.metadata({ title: "Getting context around message..." });

      // Defensive: the live MCP host can bypass Zod defaults, leaving window /
      // before / after undefined (which would make the slice bounds NaN).
      const sessionID = optionalString(args.sessionID);
      const messageID = optionalString(args.messageID);
      if (!sessionID || !messageID) {
        const err: ErrorOutput = { ok: false, error: "sessionID and messageID are required" };
        return JSON.stringify(err);
      }
      const window = coerceInt(args.window, Math.min(3, limits.maxWindow), 0, limits.maxWindow);
      const nb = args.before == null ? window : coerceInt(args.before, window, 0, limits.maxWindow);
      const na = args.after == null ? window : coerceInt(args.after, window, 0, limits.maxWindow);

      try {
        // Bounded newest-first pagination — never an unpaginated whole-session
        // fetch. Page size covers the requested window in one page for ordinary
        // sessions; the cap bounds the worst case.
        const pageMessages = Math.min(
          limits.maxMessages,
          Math.max(nb + na + 1, Math.min(25, limits.maxMessages)),
        );
        const window = await fetchMessageWindow(
          client,
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
        if (window.loadError) {
          const err: ErrorOutput = { ok: false, error: window.loadError };
          return JSON.stringify(err);
        }
        if (window.fetched === 0) {
          const err: ErrorOutput = { ok: false, error: "No messages returned" };
          return JSON.stringify(err);
        }
        if (window.centerIndex === -1) {
          const err: ErrorOutput = { ok: false, error: `Message not found: ${messageID}` };
          return JSON.stringify(err);
        }

        const items = window.messages.map((m) => {
          const item = formatMsg(m);
          return { ...item, center: m.info.id === messageID };
        });

        let title: string | undefined;
        let directory: string | undefined;
        try {
          const sess = await gate.runQuery(() => client.session.get({ sessionID: sessionID }));
          if (sess.data) {
            title = sess.data.title;
            directory = sess.data.directory;
          }
        } catch {
          // Cross-project session
        }

        ctx.metadata({
          title: `Context: ${items.length} messages around target${title ? ` from "${title}"` : ""}`,
        });

        const out: ContextOutput = {
          ok: true,
          messages: items,
          context: { sessionTitle: title, directory },
          hasMoreBefore: window.hasMoreBefore,
          hasMoreAfter: window.hasMoreAfter,
        };
        return JSON.stringify(out);
      } catch (e) {
        const err: ErrorOutput = { ok: false, error: errmsg(e) };
        return JSON.stringify(err);
      }
    },
  });
}
