import type { HistoryMessage, HistorySession } from "./model.js";

/**
 * The host-neutral history seam.
 *
 * A {@link HistorySource} is the only way the core reads opencode history. The
 * v1 adapter (`history/v1.ts`) wraps the HTTP SDK clients; a v2 adapter reads
 * `opencode.db`. Consumers keep their own gating (fetch gate, lease checks) at
 * the call site, so a source method is exactly one host read.
 *
 * Error contract: a host error RESPONSE (the SDK's `{ error }` return) becomes
 * `{ ok: false, error }` carrying the same string the model saw before the
 * seam existed. A transport failure that THROWS still rejects, so every
 * caller's existing try/catch keeps producing the same output.
 */

/** A session listing: host rows, or the host's error string. */
export type Listing<T> = { ok: true; items: T[] } | { ok: false; error: string };

/**
 * A point lookup. `not-found` covers both an explicit not-found error and an
 * empty response; `error` is any other host error; `malformed` is a successful
 * response whose body has the wrong shape, and only `getSession` returns it
 * (v1 `getMessage` passes a truthy body through unchecked, exactly as the
 * tools read it before the seam). `error` carries the host's string when there
 * was one, so callers can keep their own wording for the empty case.
 */
export type Lookup<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "not-found"; error?: string }
  | { ok: false; reason: "error"; error: string }
  | { ok: false; reason: "malformed"; error: string };

/** One newest-first page of a session's messages. `nextCursor` is opaque and
 *  null at the end of the session. */
export type MessagePage = { items: HistoryMessage[]; nextCursor: string | null };

export type SessionScope = "project" | "global";

export interface HistorySource {
  /** Which host backend this is. Nothing reads it yet; it exists so tool
   *  `coverage` can show which history a response searched. */
  readonly kind: "v1-http" | "v2-sqlite";
  /** Whether project and global lookups can disagree (v1: a directory-scoped
   *  client can 404 on a session the unscoped client resolves). Callers that
   *  probe project-then-global skip the second probe when this is false. */
  readonly scopedLookup: boolean;
  /**
   * Set when this source cannot read history at all (v2: `opencode.db` is
   * missing, unreadable, in memory, or has an unknown schema), to the reason.
   * Every read then fails with {@link unavailableHistoryError}; `recall`
   * answers from the session cards (see `card-drill.ts`) instead of drilling
   * or sweeping, and `recall_sessions` serves from cards.
   */
  readonly unavailable?: string;
  /**
   * The newest `limit` sessions in `scope`. An empty body is an empty listing.
   * A successful body of the wrong shape is an empty listing by default (the
   * distiller's discovery tolerates it); `strict` rejects it instead, so the
   * `recall_sessions` tool reports an error the way it did before the seam.
   */
  listSessions(o: {
    scope: SessionScope;
    limit: number;
    search?: string;
    strict?: boolean;
  }): Promise<Listing<HistorySession>>;
  getSession(id: string, o: { scope: SessionScope }): Promise<Lookup<HistorySession>>;
  /** Direct children of a session (non-array host payloads become empty). */
  listChildren(parentID: string): Promise<Listing<HistorySession>>;
  /**
   * One bounded page, newest first. `limit` is required and runtime-checked;
   * an unknown cursor or session rejects rather than silently restarting.
   * `strict` turns an ambiguous non-array body into a
   * {@link MalformedSessionError} instead of an empty page.
   */
  messagePage(o: {
    sessionID: string;
    limit: number;
    before?: string;
    strict?: boolean;
  }): Promise<MessagePage>;
  getMessage(sessionID: string, messageID: string): Promise<Lookup<HistoryMessage>>;
}

/** A session whose stored data has the wrong shape (quarantined by the
 *  distiller rather than retried). */
export class MalformedSessionError extends Error {
  override name = "MalformedSessionError";
}

/**
 * Reject any page limit that is not a positive integer. Omitting the limit is
 * the legacy whole-session fetch (the incident path), so every message read
 * checks it at runtime rather than trusting the type.
 */
export function assertBoundedLimit(limit: unknown): asserts limit is number {
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw new Error(`message page limit must be a positive integer, got ${String(limit)}`);
  }
}

/** The error every read of an unavailable source reports. */
export function unavailableHistoryError(reason: string): string {
  return `opencode history unavailable: ${reason}`;
}

/**
 * A source that reads nothing: every method fails with
 * {@link unavailableHistoryError}. Message pages reject (the tools turn that
 * into `{ ok: false, error }`); listings and lookups return the error.
 */
export function createUnavailableSource(
  kind: HistorySource["kind"],
  reason: string,
): HistorySource {
  const error = unavailableHistoryError(reason);
  return {
    kind,
    scopedLookup: false,
    unavailable: reason,
    listSessions: async () => ({ ok: false, error }),
    getSession: async () => ({ ok: false, reason: "error", error }),
    listChildren: async () => ({ ok: false, error }),
    messagePage: async () => {
      throw new Error(error);
    },
    getMessage: async () => ({ ok: false, reason: "error", error }),
  };
}
