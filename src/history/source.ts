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

/**
 * A session listing: host rows, or the host's error string. `truncated` says
 * more sessions matched than the listing returned (decided by reading one row
 * past `limit`). `nextCursor` is set only on a truncated listing in id order,
 * and resumes it as `after`.
 */
export type Listing<T> =
  | { ok: true; items: T[]; truncated: boolean; nextCursor?: string }
  | { ok: false; error: string };

/**
 * A point lookup. `not-found` covers both an explicit not-found error and an
 * empty response; `error` is any other host error; `malformed` is a successful
 * response whose body has the wrong shape, and only `getSession` returns it
 * (v1 `getMessage` passes a truthy body through unchecked, exactly as the
 * tools read it before the seam); `unsupported` is a request this host cannot
 * answer (a part continuation on v1). `error` carries the host's string when
 * there was one, so callers can keep their own wording for the empty case.
 */
export type Lookup<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "not-found"; error?: string }
  | { ok: false; reason: "error"; error: string }
  | { ok: false; reason: "malformed"; error: string }
  | { ok: false; reason: "unsupported"; error: string };

/**
 * One newest-first page of a session's messages. `nextCursor` is opaque and
 * null at the end of the session. `counts` is what this read could not
 * project faithfully, present only when some count is non-zero (v1 never
 * sets it).
 */
export type MessagePage = {
  items: HistoryMessage[];
  nextCursor: string | null;
  counts?: HistoryReadCounts;
};

export type SessionScope = "project" | "global";

/** Whether a listing returns archived sessions. */
export type ArchivedFilter = "include" | "exclude";

/**
 * A listing's order. `"recent"`: newest first, one page. `"id"`: ascending
 * immutable session id, resumable through `after`, so a session updated
 * during a walk is never skipped or listed twice.
 */
export type ListingOrder = "recent" | "id";

// ── Drift ────────────────────────────────────────────────────────────────────

/**
 * Counts of history content a read could not project faithfully. Every field
 * is a count, so the counts of several reads add up ({@link addReadCounts}).
 */
export type HistoryReadCounts = {
  /** Part rows of a type the projector does not read (their content is not
   *  projected). */
  unknownPartTypes: number;
  /** Completed assistant messages that projected no parts although part rows
   *  were read for them. */
  emptyWithParts: number;
  /** Messages a read cut short: they end in a placeholder and carry
   *  `partial`. */
  partialMessages: number;
  /** Part rows attached to a message that is not an assistant message, which
   *  opencode never reads and neither does the projector. */
  strayParts: number;
  /** Part rows over the byte ceiling on their own, projected as placeholders.
   *  A part row within the ceiling is never a placeholder: one that does not
   *  fit beside the rest of a read is left for a continuation instead. */
  oversizedParts: number;
  /** Part rows whose data does not decode, projected as placeholders (only
   *  reads that are not `strict`; a strict read rejects instead). */
  malformedParts: number;
  /** Assistant messages whose stored row kept changing while their part rows
   *  were read (opencode moving inline content into part rows), after the
   *  read's retries. Such a message is returned `partial` with its inline
   *  content left for the continuation, so nothing is read twice. */
  changedMessages: number;
};

/** Where the host database differs from what this build reads. */
export type HistoryDrift = {
  /** Optional host capabilities: `parts` is opencode 2.4's `session_part`
   *  table, read only when it has every column the reader needs. */
  capabilities: { parts: boolean };
  /** The newest applied host migration, and whether this build was tested
   *  against it (an untested one only warns). */
  migration: { newest: string | null; tested: boolean };
  /** Host tables in the history namespace this build does not know, sorted. */
  unknownTables: string[];
  /** Columns an optional capability needs that the database lacks
   *  (`table.column`); that capability is then off. */
  missingColumns: string[];
  /** Part types read that the projector does not know, sorted (capped). */
  unknownPartTypeNames: string[];
  /** Message reads (pages and point reads) recorded. */
  reads: number;
  /** {@link HistoryReadCounts} summed over those reads. */
  counts: HistoryReadCounts;
};

/** The fixed part of {@link HistoryDrift}, known when the database opens. */
export type HistoryDriftBase = Pick<
  HistoryDrift,
  "capabilities" | "migration" | "unknownTables" | "missingColumns"
>;

/** A drift accumulator, shared by every source facade over one database. */
export type HistoryDriftState = {
  /** The drift so far, as a copy. */
  snapshot(): HistoryDrift;
  /** Add one read's counts and the unknown part types it saw. */
  record(counts: HistoryReadCounts, unknownPartTypes?: Iterable<string>): void;
};

/** Unknown part type names a drift state keeps. */
const UNKNOWN_TYPE_NAMES_CAP = 16;

export function emptyReadCounts(): HistoryReadCounts {
  return {
    unknownPartTypes: 0,
    emptyWithParts: 0,
    partialMessages: 0,
    strayParts: 0,
    oversizedParts: 0,
    malformedParts: 0,
    changedMessages: 0,
  };
}

/** Add `from` into `into`, field by field. */
export function addReadCounts(into: HistoryReadCounts, from: HistoryReadCounts): void {
  into.unknownPartTypes += from.unknownPartTypes;
  into.emptyWithParts += from.emptyWithParts;
  into.partialMessages += from.partialMessages;
  into.strayParts += from.strayParts;
  into.oversizedParts += from.oversizedParts;
  into.malformedParts += from.malformedParts;
  into.changedMessages += from.changedMessages;
}

/** Whether any count is non-zero. */
export function hasReadCounts(counts: HistoryReadCounts): boolean {
  return (
    counts.unknownPartTypes > 0 ||
    counts.emptyWithParts > 0 ||
    counts.partialMessages > 0 ||
    counts.strayParts > 0 ||
    counts.oversizedParts > 0 ||
    counts.malformedParts > 0 ||
    counts.changedMessages > 0
  );
}

export function createHistoryDriftState(base: HistoryDriftBase): HistoryDriftState {
  const counts = emptyReadCounts();
  const names = new Set<string>();
  let reads = 0;
  return {
    snapshot: () => ({
      capabilities: { ...base.capabilities },
      migration: { ...base.migration },
      unknownTables: [...base.unknownTables],
      missingColumns: [...base.missingColumns],
      unknownPartTypeNames: [...names].sort(),
      reads,
      counts: { ...counts },
    }),
    record(read, unknownPartTypes = []) {
      reads++;
      addReadCounts(counts, read);
      for (const name of unknownPartTypes) {
        if (names.size >= UNKNOWN_TYPE_NAMES_CAP) break;
        names.add(name);
      }
    },
  };
}

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
   * Up to `limit` sessions in `scope`, in `order` (default `"recent"`). An
   * empty body is an empty listing. A successful body of the wrong shape is
   * an empty listing by default (the distiller's discovery tolerates it);
   * `strict` rejects it instead, so the `recall_sessions` tool reports an
   * error the way it did before the seam. `after` (the previous page's
   * `nextCursor`) needs `order: "id"`. `archived` defaults to excluding
   * archived sessions from global listings and including them in project
   * listings, as each opencode endpoint does. v1 lists in `"recent"` order
   * only and fails an `"id"` listing.
   */
  listSessions(o: {
    scope: SessionScope;
    limit: number;
    search?: string;
    strict?: boolean;
    order?: ListingOrder;
    after?: string;
    archived?: ArchivedFilter;
  }): Promise<Listing<HistorySession>>;
  getSession(id: string, o: { scope: SessionScope }): Promise<Lookup<HistorySession>>;
  /**
   * Direct children of a session (non-array host payloads become empty),
   * archived ones included unless `archived: "exclude"`. v2 lists `limit` of
   * them (default 1,000) in `order` (default `"recent"`), an `"id"` listing
   * resumable through `after`. v1 has no paging: it ignores `limit`, `order`
   * and `after` and returns every child with `truncated: false`.
   */
  listChildren(
    parentID: string,
    o?: { limit?: number; order?: ListingOrder; after?: string; archived?: ArchivedFilter },
  ): Promise<Listing<HistorySession>>;
  /**
   * One bounded page, newest first. `limit` is required and runtime-checked;
   * an unknown cursor or session rejects rather than silently restarting.
   * `strict` turns an ambiguous non-array body into a
   * {@link MalformedSessionError} instead of an empty page. A message whose
   * parts do not fit the page is returned `partial` (see `HistoryMessage`).
   */
  messagePage(o: {
    sessionID: string;
    limit: number;
    before?: string;
    strict?: boolean;
  }): Promise<MessagePage>;
  /**
   * One message. `partOrdinal` continues a message a read cut short (its
   * `partial.nextOrdinal`): the result holds the part rows from that ordinal
   * on, then the message's inline content, with the same part ids a whole
   * read gives them, and is itself `partial` when the rest still does not
   * fit. Following `partial.nextOrdinal` until a read is not `partial`
   * returns every part. Only an assistant message has part ordinals: v1, a
   * v2 database without part rows and a v2 message of any other type answer
   * a `partOrdinal` with `unsupported`.
   */
  getMessage(
    sessionID: string,
    messageID: string,
    o?: { partOrdinal?: number },
  ): Promise<Lookup<HistoryMessage>>;
  /**
   * How the host database differs from what this build reads (see
   * {@link HistoryDrift}), accumulated across every facade over the same
   * database. v1 and unavailable sources leave it unset.
   */
  history?(): HistoryDrift;
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
 *
 * On v2 there are two ways to be unavailable, and they differ in whether the
 * card tier survives. An `opencode.db` that resolves to a path but cannot be
 * read (missing, unreadable, unknown schema) still opens the derived store,
 * so `recall` and `recall_sessions` answer from cards an earlier run built.
 * A path that cannot be resolved at all (`:memory:`, an empty override) opens
 * no store: there is no source identity to check a store against, so the
 * card tier is lost too. Reading the last stamped source instead is a
 * deliberate non-goal for now.
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
