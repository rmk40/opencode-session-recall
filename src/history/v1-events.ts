import type { Event, Part } from "@opencode-ai/sdk/v2";
import { pruned } from "../extract.js";
import type { DistillSignal } from "../distill.js";

/** A part.updated event is removal-shaped when the part signals pruning/
 *  compaction rather than ordinary streaming growth. */
function isRemovalShapedPart(part: Part): boolean {
  return part.type === "compaction" || pruned(part);
}

/** A v1 session's archive time from its `time.archived`, read defensively;
 *  null when it is not archived. */
function archivedAt(info: unknown): number | null {
  const time = (info as { time?: unknown } | null | undefined)?.time;
  const archived = (time as { archived?: unknown } | null | undefined)?.archived;
  return typeof archived === "number" && Number.isFinite(archived) ? archived : null;
}

/**
 * Map one v1 bus event onto a distiller signal, or null when the distiller
 * ignores it. `session.idle` ends a turn; compaction and message/part removal
 * (including a part update that prunes or compacts) force a full re-distill;
 * `session.deleted` drops the session; `session.updated` patches the card's
 * archive time (archiving changes nothing else a turn would re-distill, and
 * a patch that changes nothing writes nothing). Everything else is ignored.
 */
export function v1EventToSignal(event: Event): DistillSignal | null {
  switch (event.type) {
    case "session.idle":
      return { type: "turn-ended", sessionID: event.properties.sessionID };
    case "session.updated":
      return {
        type: "meta",
        sessionID: event.properties.sessionID,
        patch: { timeArchived: archivedAt(event.properties.info) },
      };
    case "session.compacted":
    case "message.removed":
    case "message.part.removed":
      return { type: "removal", sessionID: event.properties.sessionID };
    case "message.part.updated":
      if (isRemovalShapedPart(event.properties.part)) {
        return { type: "removal", sessionID: event.properties.sessionID };
      }
      return null;
    case "session.deleted":
      return { type: "deleted", sessionID: event.properties.sessionID };
    default:
      return null;
  }
}
