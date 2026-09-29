import type { Event, Part } from "@opencode-ai/sdk/v2";
import { pruned } from "../extract.js";
import type { DistillSignal } from "../distill.js";

/** A part.updated event is removal-shaped when the part signals pruning/
 *  compaction rather than ordinary streaming growth. */
function isRemovalShapedPart(part: Part): boolean {
  return part.type === "compaction" || pruned(part);
}

/**
 * Map one v1 bus event onto a distiller signal, or null when the distiller
 * ignores it. `session.idle` ends a turn; compaction and message/part removal
 * (including a part update that prunes or compacts) force a full re-distill;
 * `session.deleted` drops the session. Everything else, `session.updated`
 * included, is ignored.
 */
export function v1EventToSignal(event: Event): DistillSignal | null {
  switch (event.type) {
    case "session.idle":
      return { type: "turn-ended", sessionID: event.properties.sessionID };
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
      return null; // session.updated + everything else: ignored
  }
}
