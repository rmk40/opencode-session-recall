import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2";
import { errmsg } from "./types.js";
import { fetchMessagePage } from "./distill.js";

// Re-export the bounded page primitive so the browse tools have a single
// pagination entry point (they never call the unpaginated `session.messages`).
export { fetchMessagePage } from "./distill.js";

/**
 * Bounded message-window fetch.
 *
 * The incident path was an unpaginated `session.messages({ sessionID })` that
 * pulled a whole (possibly 77MB) session into memory. Context around a hit is
 * instead assembled from bounded newest-first pages: we page with an explicit
 * `limit` and the `X-Next-Cursor` `before` cursor, stop once the target message
 * plus its requested older/newer neighbors are covered, and hard-cap the fetch
 * so a target that lives deep in a giant session costs a bounded number of pages
 * (returning partial context with `hasMore*` flags) rather than the whole thing.
 *
 * Newest-first is the SDK's native page order, so every message NEWER than the
 * target is fetched before the target is reached; the `before` (older) side is
 * what paging extends toward, bounded by `after`-count and the page cap.
 */

type MsgWithParts = { info: Message; parts: Part[] };

/** Wrap an SDK call, e.g. through the shared fetch gate. Defaults to a direct
 *  call for the browse tools, which do not share the query-path gate. */
export type FetchRunner = <T>(fn: () => Promise<T>) => Promise<T>;
const directRunner: FetchRunner = (fn) => fn();

export type MessageWindow = {
  /** Window messages, chronological (oldest-first). Empty when the target was
   *  not found within the fetch cap or the session had none. */
  messages: MsgWithParts[];
  /** Index of the target within {@link MessageWindow.messages}, -1 if absent. */
  centerIndex: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  /** Total messages fetched (0 distinguishes an empty/no-data session from a
   *  target that was simply not located within the fetched window). */
  fetched: number;
  /** Present when a page fetch failed. */
  loadError?: string;
};

export type MessageWindowOptions = {
  sessionID: string;
  messageID: string;
  /** Older neighbors requested (chronologically before the target). */
  before: number;
  /** Newer neighbors requested (chronologically after the target). */
  after: number;
  /** Messages per page fetch. */
  pageMessages: number;
  /** Hard cap on total messages fetched before giving up (safety valve for a
   *  target buried in a huge session). */
  maxMessages: number;
};

/**
 * Fetch a bounded window of messages around `messageID`. Pages newest-first via
 * {@link fetchMessagePage} (always with a `limit`) until the target plus
 * `before` older neighbors are covered, the session ends, or the message cap is
 * reached — never an unbounded fetch.
 */
export async function fetchMessageWindow(
  client: OpencodeClient,
  opts: MessageWindowOptions,
  run: FetchRunner = directRunner,
): Promise<MessageWindow> {
  const collected: MsgWithParts[] = []; // newest-first accumulation
  const seen = new Set<string>();
  let cursor: string | undefined;
  let reachedEnd = false;
  let loadError: string | undefined;

  do {
    // Clamp the page request to the remaining cap capacity so a non-dividing
    // page size can never retain more than `maxMessages`; the append is also
    // truncated below as a belt-and-suspenders guarantee.
    const remaining = opts.maxMessages - collected.length;
    if (remaining <= 0) break;
    const limit = Math.min(opts.pageMessages, remaining);
    let page;
    try {
      page = await run(() =>
        fetchMessagePage(client, { sessionID: opts.sessionID, limit, before: cursor }),
      );
    } catch (error) {
      loadError = errmsg(error);
      break;
    }
    for (const msg of page.items) {
      if (collected.length >= opts.maxMessages) break;
      if (seen.has(msg.info.id)) continue;
      seen.add(msg.info.id);
      collected.push(msg);
    }
    cursor = page.nextCursor ?? undefined;
    if (!cursor) {
      reachedEnd = true;
      break;
    }
    // Stop once the target is covered with enough older context. In newest-first
    // order, messages after the target index are the OLDER ones.
    const idx = collected.findIndex((m) => m.info.id === opts.messageID);
    if (idx !== -1 && collected.length - 1 - idx >= opts.before) break;
    if (collected.length >= opts.maxMessages) break;
  } while (cursor);

  const chrono = [...collected].sort(
    (a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id),
  );
  const centerIndex = chrono.findIndex((m) => m.info.id === opts.messageID);
  if (centerIndex === -1) {
    return {
      messages: [],
      centerIndex: -1,
      hasMoreBefore: !reachedEnd,
      hasMoreAfter: false,
      fetched: collected.length,
      ...(loadError !== undefined ? { loadError } : {}),
    };
  }

  const start = Math.max(0, centerIndex - opts.before);
  const end = Math.min(chrono.length, centerIndex + opts.after + 1);
  const windowMsgs = chrono.slice(start, end);
  // More older messages exist if the window was trimmed at the front, or the cap
  // stopped paging before the requested older neighbors were reached.
  const hasMoreBefore = start > 0 || (!reachedEnd && centerIndex - opts.before < 0);
  const hasMoreAfter = end < chrono.length;

  return {
    messages: windowMsgs,
    centerIndex: centerIndex - start,
    hasMoreBefore,
    hasMoreAfter,
    fetched: collected.length,
    ...(loadError !== undefined ? { loadError } : {}),
  };
}
