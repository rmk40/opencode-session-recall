import type { GlobalSession, Message, Part, Session } from "@opencode-ai/sdk/v2";

/**
 * The host-neutral history read model.
 *
 * Every consumer (tools, drill, deep, fetch-window, distiller) reads messages
 * and sessions in these shapes, whichever host produced them. Today they are
 * the v1 SDK shapes verbatim; the v2 projector (`history/v2-project.ts`) fills
 * the same fields and adds `seq`.
 */

/**
 * A message's info. `seq` is the v2 host's per-session row order
 * (`session_message.seq`); v1 messages never carry it.
 */
export type HistoryMessageInfo = Message & { seq?: number };

/**
 * What a read left out of a message whose parts did not fit in it. The
 * message's parts then end in one placeholder text part, and
 * `HistorySource.getMessage` with `partOrdinal: nextOrdinal` reads the rest.
 */
export type MessagePartial = {
  /** The part ordinal the rest starts at. */
  nextOrdinal: number;
  /** Content items left out: part rows from `nextOrdinal` on, plus the
   *  message's inline content items. */
  omittedParts: number;
  /** Encoded bytes of the part rows left out, as measured when the read was
   *  cut. Inline content left out counts in `omittedParts` only. */
  omittedBytes: number;
};

/** One message with its parts (the SDK's `{ info, parts }` bundle). `partial`
 *  is set only on a v2 message a read cut short; v1 never sets it. */
export type HistoryMessage = { info: HistoryMessageInfo; parts: Part[]; partial?: MessagePartial };

/** One session row. A global listing also carries the owning project summary. */
export type HistorySession = Session & { project?: GlobalSession["project"] };

/**
 * The one chronological message order (oldest first). When both messages carry
 * a v2 `seq`, it decides: v2 retries rewrite an assistant's `time.created`
 * (`core/src/session/message-updater.ts:214-229` in opencode v2) and migrated
 * synthetic rows share their user row's timestamp, so time is not the row
 * order there. Otherwise `time.created`, then `id` as the tiebreak (v1
 * messages never carry `seq`, so v1 ordering is unchanged). Every site that
 * sorts messages goes through this comparator (a grep test in `test/` enforces
 * it), so ordering rules can change in exactly one place.
 */
export function compareMessages(a: HistoryMessage, b: HistoryMessage): number {
  const seqA = a.info.seq;
  const seqB = b.info.seq;
  if (typeof seqA === "number" && typeof seqB === "number" && seqA !== seqB) return seqA - seqB;
  return a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id);
}
