import type { DistillSignal } from "../distill.js";

/**
 * Map opencode v2 bus events onto distiller signals.
 * Events only lower latency: the poll in `v2-sync.ts` is what keeps the store
 * correct when they are missed.
 *
 * - `session.execution.succeeded|failed|interrupted` and
 *   `session.compaction.ended` end a turn;
 * - `session.step.ended` also ends a turn, throttled to at most one signal per
 *   session per {@link STEP_THROTTLE_MS} (leading and trailing), so a long
 *   autonomous run stays fresh without re-distilling on every step;
 * - `session.revert.committed` is a removal (the next distill is full);
 * - `session.deleted` deletes;
 * - `session.renamed` and `session.moved` patch the card's metadata;
 * - `session.archived` and `session.unarchived` re-distill the session, which
 *   reads its archive time from the session row (the event carries none);
 * - `session.forked` distills the new session in full.
 */

export const STEP_THROTTLE_MS = 60_000;

/** The encoded event fields this mapper reads. */
export type V2BusEvent = { readonly type: string; readonly data?: unknown };

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | undefined {
  return value !== null && typeof value === "object" ? (value as Obj) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export type V2EventMapper = {
  /** Map one event; signals may also arrive later through `emit` (the
   *  trailing edge of the step throttle). */
  map(event: V2BusEvent): void;
  dispose(): void;
};

export function createV2EventMapper(opts: {
  emit: (signal: DistillSignal) => void;
  throttleMs?: number;
  now?: () => number;
}): V2EventMapper {
  const throttleMs = opts.throttleMs ?? STEP_THROTTLE_MS;
  const now = opts.now ?? Date.now;
  const lastStep = new Map<string, number>();
  const trailing = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  const emit = (signal: DistillSignal): void => {
    if (!disposed) opts.emit(signal);
  };

  /** Drop a session's throttle state (and its pending trailing signal). */
  const forget = (sessionID: string): void => {
    const timer = trailing.get(sessionID);
    if (timer) clearTimeout(timer);
    trailing.delete(sessionID);
    lastStep.delete(sessionID);
  };

  /** A turn ended outright: supersedes any pending throttled step. */
  const turnEnded = (sessionID: string): void => {
    forget(sessionID);
    emit({ type: "turn-ended", sessionID });
  };

  const stepEnded = (sessionID: string): void => {
    const at = now();
    const last = lastStep.get(sessionID);
    if (last === undefined || at - last >= throttleMs) {
      lastStep.set(sessionID, at);
      emit({ type: "turn-ended", sessionID });
      return;
    }
    if (trailing.has(sessionID)) return;
    trailing.set(
      sessionID,
      setTimeout(
        () => {
          trailing.delete(sessionID);
          lastStep.set(sessionID, now());
          emit({ type: "turn-ended", sessionID });
        },
        throttleMs - (at - last),
      ),
    );
  };

  return {
    map(event) {
      if (disposed) return;
      const data = obj(event.data);
      const sessionID = text(data?.sessionID);
      if (!sessionID) return;
      switch (event.type) {
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
        case "session.compaction.ended":
          turnEnded(sessionID);
          return;
        case "session.step.ended":
          stepEnded(sessionID);
          return;
        case "session.revert.committed":
          emit({ type: "removal", sessionID });
          return;
        case "session.deleted":
          forget(sessionID);
          emit({ type: "deleted", sessionID });
          return;
        case "session.renamed": {
          const title = typeof data?.title === "string" ? data.title : undefined;
          emit(
            title === undefined
              ? { type: "meta", sessionID }
              : { type: "meta", sessionID, patch: { title } },
          );
          return;
        }
        case "session.moved": {
          const directory = text(obj(data?.location)?.directory);
          const projectId = text(data?.projectID);
          emit({
            type: "meta",
            sessionID,
            ...((directory || projectId) && {
              patch: {
                ...(directory && { directory }),
                ...(projectId && { projectId }),
              },
            }),
          });
          return;
        }
        case "session.archived":
        case "session.unarchived":
          emit({ type: "meta", sessionID });
          return;
        case "session.forked":
          // The fork is a new session: distill it in full.
          emit({ type: "removal", sessionID });
          return;
        default:
          return;
      }
    },
    dispose() {
      disposed = true;
      for (const timer of trailing.values()) clearTimeout(timer);
      trailing.clear();
      lastStep.clear();
    },
  };
}
