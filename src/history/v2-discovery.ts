import type { HistorySession } from "./model.js";
import type { HistorySource } from "./source.js";

/** Sessions per discovery page. */
const DISCOVERY_PAGE = 2_000;

/**
 * Every session the history holds, as the distiller and cards-lite discover
 * them: globally, since one store per process serves every location. The
 * listing pages by the immutable session id, so a session updated during the
 * walk is neither skipped nor listed twice, and it has no overall cap.
 * Archived sessions are included: archiving hides a session from opencode's
 * list but keeps its history, which is still past work to recall, and
 * cards-lite (the store-less mode) then covers the same sessions the store
 * does. `pause` runs between pages.
 */
export async function discoverSessions(
  source: HistorySource,
  pause: () => Promise<void>,
): Promise<HistorySession[]> {
  const sessions: HistorySession[] = [];
  let after: string | undefined;
  for (;;) {
    const listing = await source.listSessions({
      scope: "global",
      limit: DISCOVERY_PAGE,
      order: "id",
      archived: "include",
      ...(after !== undefined && { after }),
    });
    if (!listing.ok) throw new Error(listing.error);
    sessions.push(...listing.items);
    if (!listing.truncated || listing.nextCursor === undefined) return sessions;
    after = listing.nextCursor;
    await pause();
  }
}
