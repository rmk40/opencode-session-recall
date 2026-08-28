import type { Card } from "./store.js";

/**
 * Ephemeral-mode cards-lite refresh controller.
 *
 * The lite `CardSource` is otherwise a frozen one-shot snapshot: `discover()`
 * runs once at plugin init and `revision()` stays `() => undefined`, so sessions
 * created after init would be invisible forever. This controller makes the
 * snapshot lazily self-healing without introducing a second rebuild mechanism:
 * it owns `lastAttemptAt` and the single in-flight promise, and on a successful
 * list it assigns the new cards and calls `CardsRuntime.invalidate()` — the
 * SOLE rebuild signal (the lite source's `revision()` remains a pure
 * `() => undefined` getter).
 *
 * Contract (see docs/plans/ephemeral-mode.md, step 3):
 * - `maybeRefresh()` is called fire-and-forget at query entry; the triggering
 *   query proceeds on the current snapshot. New sessions become visible on the
 *   first query after the discover resolves (bound = discover latency —
 *   `invalidate()` bypasses the card runtime's refresh-interval gate).
 * - A successful discover always assigns, including an empty result (an empty
 *   success assigns the empty set); only FAILURE keeps the previous cards,
 *   bumping just `lastAttemptAt`, with retries no sooner than the next window
 *   (backoff = the window itself; no hammering). Accepted consequence: a
 *   failed init discover leaves an empty card set until the next window —
 *   ~60s worst case after a start where the server wasn't ready.
 * - The init discover and any refresh share one in-flight promise
 *   (single-flight): concurrent stale queries never fan out duplicate
 *   `session.list` calls.
 */

/** Refresh window: `maybeRefresh` no-ops within this span of the last attempt. */
export const LITE_REFRESH_WINDOW_MS = 60_000;

export type LiteRefreshDeps = {
  /** Bounded metadata discover (`session.list` mapped to cards-lite). */
  list: () => Promise<Card[]>;
  /** Publish a successful snapshot (the entry file's `liteCards` array). */
  assign: (cards: Card[]) => void;
  /** `CardsRuntime.invalidate` — the sole rebuild signal after a successful
   *  assign, so the first subsequent card access rebuilds immediately. */
  invalidate: () => void;
  /** Route a refresh list through the shared fetch gate's QUERY path: unlike
   *  the one-shot init discover, a refresh shares the query path with in-flight
   *  drill fetches and must respect `limits.concurrency`. Resolved lazily by
   *  the caller's closure — the entry file builds the lite `CardSource` before
   *  `createFetchGate`, so capturing the gate eagerly would hit the TDZ. */
  runQuery: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Register the in-flight attempt with the plugin's dispose accounting. */
  track?: <T>(operation: Promise<T>) => Promise<T>;
  /** Plugin dispose guard: a list that settles after dispose must not assign
   *  or invalidate. */
  disposed?: () => boolean;
  now?: () => number;
  windowMs?: number;
};

export type LiteRefreshController = {
  /** Fire-and-forget query-entry trigger. No-ops while a refresh is in flight
   *  or within the refresh window of the last attempt. */
  maybeRefresh(): void;
  /** The one-shot init discover: shares the single-flight promise with
   *  refreshes but deliberately skips the fetch gate (at init no queries are
   *  competing for permits). */
  initialRefresh(): Promise<void>;
};

export function createLiteRefresh(deps: LiteRefreshDeps): LiteRefreshController {
  const now = deps.now ?? Date.now;
  const windowMs = deps.windowMs ?? LITE_REFRESH_WINDOW_MS;
  const track = deps.track ?? (<T>(operation: Promise<T>) => operation);
  const disposed = deps.disposed ?? (() => false);

  let lastAttemptAt = -Infinity;
  let inFlight: Promise<void> | undefined;

  function attempt(gated: boolean): Promise<void> {
    // Bump at start: the attempt time is what the backoff window measures from,
    // and on failure it is the ONLY state that changes.
    lastAttemptAt = now();
    // Fire-and-forget must hold by construction: a sync-throwing injected
    // list/runQuery is converted into a failed attempt instead of escaping
    // maybeRefresh's caller.
    let source: Promise<Card[]>;
    try {
      source = gated ? deps.runQuery(() => deps.list()) : deps.list();
    } catch (error) {
      source = Promise.reject(error);
    }
    const settled: Promise<void> = source
      .then(
        (cards) => {
          if (disposed()) return;
          // A throwing assign/invalidate must not reject `settled` (track
          // defaults to identity, so a rejection would surface as unhandled).
          try {
            deps.assign(cards);
            // Sole rebuild signal: invalidate() sets the runtime's loaded flag
            // false, so the first subsequent card access rebuilds immediately,
            // bypassing the runtime's refresh-interval gate.
            deps.invalidate();
          } catch {
            // Treated like a failed attempt: window-length backoff applies.
          }
        },
        () => {
          // Failure: keep the previous cards. lastAttemptAt (bumped above) is
          // the window-length backoff — retry no sooner than the next window.
        },
      )
      .finally(() => {
        if (inFlight === settled) inFlight = undefined;
      });
    inFlight = settled;
    void track(settled);
    return settled;
  }

  return {
    maybeRefresh(): void {
      if (disposed() || inFlight) return;
      // The rule: refresh only when the window has elapsed since the last
      // attempt. (A never-attempted controller has lastAttemptAt = -Infinity,
      // so it always fires.) Rationale for why there is no separate empty-set
      // trigger: an empty card set is subsumed by this same window — failed or
      // empty attempts bumped lastAttemptAt, so they retry no sooner than the
      // next window, and a genuinely empty server re-lists at most once per
      // window — bounded, never hammering.
      if (now() - lastAttemptAt < windowMs) return;
      void attempt(true);
    },

    initialRefresh(): Promise<void> {
      if (disposed()) return Promise.resolve();
      if (inFlight) return inFlight;
      return attempt(false);
    },
  };
}
