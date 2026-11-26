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
  type MessagesOrder,
  type MessagesStop,
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
  OUTPUT_BUDGET,
  resumeMessage,
  section,
  utf8Length,
  writeError,
  writeOutput,
  type MessagePosition,
  type PartPosition,
} from "./output.js";

/** Pages a continuation reads, its own page included, to find the message it
 *  resumes at. The newest page shifts as messages arrive between calls, so
 *  the message can move onto the page after it. */
const RESUME_PAGES = 3;

/** Messages a filtered browse asks for per page, so a narrow filter does not
 *  cost one page read per few messages. */
const SCAN_PAGE = 50;

/** Messages one call reads while looking for `limit` matches: by default,
 *  and at most. */
const SCAN_DEFAULT = 500;
const SCAN_MAX = 2_000;

/** Pages one call reads at most, whatever its scan budget. A page of large
 *  messages holds few of them and can be as large as the history source's
 *  byte ceiling, so the message count alone does not bound the bytes read. */
const SCAN_PAGES_MAX = 40;

const ROLES = ["user", "assistant", "all"] as const;
const ORDERS = ["newest", "oldest"] as const;

function msgMatches(msg: { parts: Array<Part> }, query: string): boolean {
  for (const part of msg.parts) {
    for (const text of searchable(part)) {
      if (matches(text, query)) return true;
    }
  }
  return false;
}

/** A message the scan kept, as output, with the page cursor it was read
 *  from (null for the first page in the browse's order). */
type Match = { item: MessageItem; page: string | null };

export function messages(source: HistorySource, gate: FetchGate, limits: Limits): ToolDefinition {
  return tool({
    description: `Browse a known session's messages, newest first (or oldest first), in bounded pages. With role or query set, it reads on until limit messages match or its scan budget runs out, and reports what it scanned. Pass cursor from a prior nextCursor to continue. Use after you know the session; for topical discovery across sessions use recall first.`,
    args: {
      sessionID: tool.schema.string().optional().describe("Session to browse; default current"),
      limit: tool.schema
        .number()
        .min(1)
        .max(limits.maxMessages)
        .default(Math.min(10, limits.maxMessages))
        .describe("Max messages returned"),
      cursor: tool.schema
        .string()
        .optional()
        .describe("nextCursor from a prior call; omit to start at the first page"),
      role: tool.schema.enum(ROLES).default("all").describe("Role filter"),
      query: tool.schema.string().min(1).optional().describe("Message content substring filter"),
      order: tool.schema
        .enum(ORDERS)
        .optional()
        .describe('"newest" (default) or "oldest" first; oldest needs opencode v2'),
      scan: tool.schema
        .number()
        .min(1)
        .max(SCAN_MAX)
        .default(SCAN_DEFAULT)
        .describe("Max messages read looking for matches"),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      const sid = optionalString(args.sessionID) ?? ctx.sessionID;
      const query = optionalString(args.query);
      // The live MCP host can bypass Zod defaults, so coerce every optional arg
      // defensively. An undefined `role` previously made `role !== "all"` true
      // and filtered out every message (returned: 0 on a non-empty session).
      const role = coerceEnum(args.role, ROLES, "all");
      const limit = coerceInt(args.limit, Math.min(10, limits.maxMessages), 1, limits.maxMessages);
      const scan = coerceInt(args.scan, SCAN_DEFAULT, 1, SCAN_MAX);
      // No default here: a continuation keeps the order it was made in, and
      // only an order the caller actually passed can conflict with it.
      const requested: MessagesOrder | undefined =
        typeof args.order === "string" && (ORDERS as readonly string[]).includes(args.order)
          ? (args.order as MessagesOrder)
          : undefined;
      const cursor = optionalString(args.cursor);
      if (!sid) return writeError("No sessionID provided and no current session available");

      // The cursor is this tool's own continuation, or a history source page
      // cursor a caller may still hold, which reads that page from its start.
      let order: MessagesOrder = requested ?? "newest";
      let pageCursor: string | null = cursor ?? null;
      let resume: MessagePosition | undefined;
      if (cursor && isContinuation(cursor)) {
        const decoded = decodeMessagesCursor(cursor);
        if (!decoded.ok) return writeError(decoded.error);
        if (decoded.value.session !== sid) {
          return writeError(
            `This cursor continues session ${decoded.value.session}, not ${sid}; pass that sessionID`,
          );
        }
        const made = decoded.value.order ?? "newest";
        if (requested && requested !== made) {
          return writeError(
            `This cursor browses ${made} first; pass order "${made}" with it, or omit order`,
          );
        }
        order = made;
        pageCursor = decoded.value.page;
        resume = decoded.value.at;
      }
      const ascending = order === "oldest";
      if (ascending && !source.messagePageAscending) {
        return writeError(
          'order "oldest" is not supported by this opencode history source (opencode v1 pages newest first only); browse with order "newest"',
        );
      }
      const filtered = role !== "all" || query !== undefined;
      const pageSize = filtered ? Math.max(limit, SCAN_PAGE) : limit;

      ctx.metadata({ title: "Browsing messages..." });

      try {
        // Always a bounded page (limit + cursor), through the shared gate —
        // never an unpaginated fetch and never outside the concurrency budget.
        const read = (page: string | null, size: number): Promise<MessagePage> =>
          gate.runQuery(() =>
            ascending
              ? source.messagePageAscending!({
                  sessionID: sid,
                  limit: size,
                  after: page ?? undefined,
                })
              : source.messagePage({ sessionID: sid, limit: size, before: page ?? undefined }),
          );
        let page = await read(pageCursor, pageSize);
        let pages = 1;
        let index = 0;
        if (resume) {
          const anchor = resume.message;
          for (;;) {
            index = page.items.findIndex((m) => m.info.id === anchor);
            if (index !== -1) break;
            if (pages >= RESUME_PAGES || page.nextCursor == null) {
              return writeError(
                `This cursor's message ${anchor} is no longer where it was; browse again without cursor`,
              );
            }
            pageCursor = page.nextCursor;
            page = await read(pageCursor, pageSize);
            pages++;
          }
        }

        // Scan from there, page by page, until `limit` messages match, the
        // matches fill the output budget, the scan budget runs out or the
        // session ends. `next` is where the scan stopped: the page and the
        // first message on it left unscanned, or the start of the next page.
        const found: Match[] = [];
        let scanned = 0;
        let foundBytes = 0;
        let stopped: MessagesStop | undefined;
        let next: { page: string | null; anchor?: string } | undefined;
        const budgetStop = (): MessagesStop | undefined =>
          found.length >= limit
            ? "limit"
            : foundBytes >= OUTPUT_BUDGET.bytes
              ? "outputBudget"
              : scanned >= scan
                ? "scanBudget"
                : undefined;
        for (;;) {
          for (; index < page.items.length; index++) {
            stopped = budgetStop();
            if (stopped) break;
            const message = page.items[index]!;
            scanned++;
            if (role !== "all" && message.info.role !== role) continue;
            if (query && !msgMatches(message, query)) continue;
            const item = messageItem(message);
            found.push({ item, page: pageCursor });
            foundBytes += utf8Length(JSON.stringify(item));
          }
          if (stopped) {
            next = { page: pageCursor, anchor: page.items[index]!.info.id };
            break;
          }
          if (page.nextCursor == null) {
            stopped = "end";
            break;
          }
          stopped = budgetStop() ?? (pages >= SCAN_PAGES_MAX ? "scanBudget" : undefined);
          if (stopped) {
            next = { page: page.nextCursor };
            break;
          }
          pageCursor = page.nextCursor;
          // Unfiltered, every message matches, so a page asks for only the
          // matches still wanted.
          const wanted = filtered ? pageSize : limit - found.length;
          page = await read(pageCursor, Math.min(wanted, scan - scanned));
          pages++;
          index = 0;
        }

        const formatted = found.map((match) => match.item);
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
          title: `Showing ${formatted.length} messages${title ? ` from "${title}"` : ""}${next ? " (more available)" : ""}`,
        });

        const orderField = ascending ? { order: "oldest" as const } : {};
        const scanNext = next
          ? encodeMessagesCursor({
              session: sid,
              ...orderField,
              page: next.page,
              ...(next.anchor !== undefined && { at: { message: next.anchor } }),
            })
          : undefined;
        return writeOutput<PartPosition>({
          sections: [section("messages", formatted, fitMessage)],
          head: (stop, shown) => {
            // A trimmed output continues at the message it stopped at, on the
            // page that message was read from; otherwise the scan continues
            // after the last message it read.
            const continuation = stop
              ? encodeMessagesCursor({
                  session: sid,
                  ...orderField,
                  page: found[stop.index]!.page,
                  at: {
                    message: formatted[stop.index]!.message.id,
                    ...(stop.rest && { at: stop.rest }),
                  },
                })
              : undefined;
            const nextCursor = continuation ?? scanNext;
            return {
              ...(continuation && { continuation }),
              fields: {
                context: { sessionTitle: title, directory },
                pagination: {
                  limit,
                  order,
                  returned: shown.messages ?? 0,
                  matched: found.length,
                  scanned,
                  stop: stopped,
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
