import type { GlobalSession, Message, Part, Session } from "@opencode-ai/sdk/v2";

/**
 * The host-neutral history read model.
 *
 * Every consumer (tools, drill, deep, fetch-window, distiller) reads messages
 * and sessions in these shapes, whichever host produced them. Today they are
 * the v1 SDK shapes verbatim; the v2 projector fills the same fields.
 */

/** One message with its parts (the SDK's `{ info, parts }` bundle). */
export type HistoryMessage = { info: Message; parts: Part[] };

/** One session row. A global listing also carries the owning project summary. */
export type HistorySession = Session & { project?: GlobalSession["project"] };

/**
 * The one chronological message order (oldest first): `time.created`, then
 * `id` as the tiebreak. Every site that sorts messages goes through this
 * comparator (a grep test in `test/` enforces it), so ordering rules can change
 * in exactly one place.
 */
export function compareMessages(a: HistoryMessage, b: HistoryMessage): number {
  return a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id);
}
