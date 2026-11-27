import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import { errmsg } from "../types.js";
import type { HistoryMessage, HistorySession } from "./model.js";
import {
  assertBoundedLimit,
  MalformedSessionError,
  type ArchivedFilter,
  type HistorySource,
  type Listing,
  type Lookup,
  type MessagePage,
  type SessionScope,
} from "./source.js";

/**
 * The v1 history adapter: opencode's HTTP SDK, through two clients. `scoped`
 * carries the caller's directory header (project listings, lookups, children,
 * message pages); `unscoped` reaches every project (global listings and the
 * global lookup retry).
 */

/** The two v1 SDK clients the history source reads through. */
export type V1Clients = { scoped: OpencodeClient; unscoped: OpencodeClient };

/**
 * Build the scoped and unscoped v2-vintage SDK clients from the v1 plugin
 * context. The host hands the plugin a default-vintage client; its in-process
 * fetch transport is extracted from the client's internals and reused, so no
 * request leaves the process. `scoped` keeps the caller's directory header;
 * `unscoped` drops it to reach every project. Throws when the internals are
 * not where they are expected (the plugin cannot run without a transport).
 */
export function createV1Clients(ctx: { client: unknown; directory: string }): V1Clients {
  // Extract the in-process fetch from the v1 client's internals.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK internals not typed
  const inner = (ctx.client as any)._client;
  if (!inner?.getConfig)
    throw new Error(
      "opencode-session-recall: SDK internals changed — cannot extract fetch transport",
    );
  const cfg = inner.getConfig();
  if (!cfg.fetch) throw new Error("opencode-session-recall: SDK client has no custom fetch");

  // The rebuilt clients spread their headers, so they must be a plain object:
  // the SDK keeps them as a `Headers` instance, which spreads to `{}` and would
  // drop `Authorization` (a server that requires Basic auth then answers 401).
  const headers = plainHeaders(cfg.headers);
  const rest: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "x-opencode-directory") rest[name] = value;
  }

  const scoped = createOpencodeClient({
    baseUrl: cfg.baseUrl,
    fetch: cfg.fetch,
    headers: rest,
    directory: ctx.directory,
  });

  const unscoped = createOpencodeClient({
    baseUrl: cfg.baseUrl,
    fetch: cfg.fetch,
    headers: rest,
  });

  return { scoped, unscoped };
}

/** Headers in any form the SDK config may hold (`Headers`, entry pairs or a
 *  plain record) as a plain record of string values. */
function plainHeaders(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (input == null) return out;
  if (typeof Headers !== "undefined" && input instanceof Headers) {
    input.forEach((value, name) => {
      out[name] = value;
    });
    return out;
  }
  if (Array.isArray(input)) {
    for (const pair of input) {
      if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0])] = String(pair[1]);
    }
    return out;
  }
  if (typeof input === "object") {
    for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
      if (value != null) out[name] = String(value);
    }
  }
  return out;
}

/** Read `X-Next-Cursor` from a fields-style response's fetch `Response`, case-
 *  insensitively (native `Headers.get` folds case) and defensively (a missing
 *  response, headers, or getter yields null). */
function readNextCursor(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const headers = (response as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return null;
  const get = (headers as { get?: unknown }).get;
  if (typeof get !== "function") return null;
  try {
    const value = (get as (name: string) => unknown).call(headers, "X-Next-Cursor");
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Fetch one page of a session's messages. ALWAYS sends `limit` — omitting it
 * triggers the legacy full-session fetch (the incident path) and `before`
 * without `limit` is a 400. The next-page cursor rides the `X-Next-Cursor`
 * header; the body is the `{ info, parts }` array. Throws on an SDK error so the
 * caller's try/catch handles fetch failures uniformly, and rejects a limit that
 * is not a positive integer before any request.
 *
 * A successful response whose body is not an array is ambiguous: the query path
 * (browse/context/drill) treats it as a deliberate "empty page, ok:true" — a
 * documented decision for sessions with no data — while the distiller passes
 * `strict: true` so its quarantine can distinguish a malformed session from an
 * empty one.
 */
export async function fetchMessagePage(
  client: OpencodeClient,
  opts: { sessionID: string; limit: number; before?: string; strict?: boolean },
): Promise<MessagePage> {
  // Checked here, in the primitive, so no caller can reach the unbounded fetch
  // by passing a limit the type allows but the host treats as absent.
  assertBoundedLimit(opts.limit);
  const params =
    opts.before != null
      ? { sessionID: opts.sessionID, limit: opts.limit, before: opts.before }
      : { sessionID: opts.sessionID, limit: opts.limit };
  const resp = await client.session.messages(params);
  if (resp.error) throw new Error(errmsg(resp.error));
  if (!Array.isArray(resp.data)) {
    if (opts.strict) {
      throw new MalformedSessionError("successful message response was not an array");
    }
    return { items: [], nextCursor: readNextCursor(resp.response) };
  }
  const items = resp.data as HistoryMessage[];
  return { items, nextCursor: readNextCursor(resp.response) };
}

/** Whether an SDK error return means "session does not exist" (absence)
 *  rather than a transport failure. `session.get`'s 404 body is the generic
 *  `NotFoundError` discriminated by `name: "NotFoundError"` (SessionGetErrors
 *  in the v2 typings) — that is the primary check. The `_tag:
 *  "SessionNotFoundError"` shape belongs to OTHER endpoints' 404s and the
 *  fields-style `response.status` is transport-level; both are kept as
 *  belt-and-suspenders fallbacks. Any matching signal → absence. */
export function isNotFoundError(error: unknown, response: unknown): boolean {
  if (error && typeof error === "object") {
    const shaped = error as { name?: unknown; _tag?: unknown };
    if (shaped.name === "NotFoundError") return true;
    if (shaped._tag === "SessionNotFoundError") return true;
  }
  return (
    response != null &&
    typeof response === "object" &&
    (response as { status?: unknown }).status === 404
  );
}

/** The fields of an SDK response this adapter reads. */
type SdkResponse = { data?: unknown; error?: unknown; response?: unknown };

/** An error return as a failed lookup: a recognizable 404 is `not-found`,
 *  anything else `error`; both keep the host's message. */
function errorLookup(resp: SdkResponse): {
  ok: false;
  reason: "not-found" | "error";
  error: string;
} {
  return {
    ok: false,
    reason: isNotFoundError(resp.error, resp.response) ? "not-found" : "error",
    error: errmsg(resp.error),
  };
}

/**
 * A listing response: an error return keeps the host's message, and a
 * non-array body is an empty listing. `archived: "exclude"` drops archived
 * sessions, for endpoints that cannot filter them, before the listing is cut
 * to `limit`. `limit`, when given, is how many rows the caller asked for; the
 * request asked for one more, so a response that holds it is truncated.
 * Whether rows past it match cannot be known once some were dropped, so the
 * listing is then truncated even when fewer than `limit` sessions remain.
 */
function toListing(
  resp: SdkResponse,
  o: { limit?: number; archived?: ArchivedFilter } = {},
): Listing<HistorySession> {
  if (resp.error) return { ok: false, error: errmsg(resp.error) };
  const rows = Array.isArray(resp.data) ? (resp.data as HistorySession[]) : [];
  let items = o.archived === "exclude" ? rows.filter((s) => !isArchived(s)) : rows;
  const truncated = o.limit !== undefined && rows.length > o.limit;
  if (o.limit !== undefined) items = items.slice(0, o.limit);
  return { ok: true, items, truncated };
}

/** Whether a listed session is archived, read defensively: a host body of the
 *  wrong shape is passed through, not thrown on. */
function isArchived(session: unknown): boolean {
  if (typeof session !== "object" || session === null) return false;
  const time = (session as { time?: unknown }).time;
  if (typeof time !== "object" || time === null) return false;
  return (time as { archived?: unknown }).archived != null;
}

/** Why a part continuation fails on v1. */
const NO_PART_ORDINALS =
  "the v1 history source has no part ordinals, so it cannot continue a message";
const NO_SEEK =
  "the v1 history source pages newest first from the session's end only, so it cannot seek";

export function createV1HistorySource(clients: V1Clients): HistorySource {
  const { scoped, unscoped } = clients;
  const clientFor = (scope: SessionScope): OpencodeClient =>
    scope === "global" ? unscoped : scoped;

  return {
    kind: "v1-http",
    // One client for both scopes means one lookup answers both.
    scopedLookup: scoped !== unscoped,

    async listSessions(o): Promise<Listing<HistorySession>> {
      // The v1 endpoints page by time, not by id.
      if (o.order === "id" || o.after !== undefined) {
        return { ok: false, error: "the v1 history source cannot list sessions in id order" };
      }
      // One row past the limit decides `truncated`.
      const params =
        o.search !== undefined ? { search: o.search, limit: o.limit + 1 } : { limit: o.limit + 1 };
      // Only the global endpoint filters archived sessions (it hides them
      // unless asked); the project endpoint returns them and the exclusion
      // happens here.
      const resp: SdkResponse =
        o.scope === "global"
          ? await unscoped.experimental.session.list(
              o.archived === "include" ? { ...params, archived: true } : params,
            )
          : await scoped.session.list(params);
      // `strict` keeps the sessions tool's contract: a truthy non-array body
      // throws a TypeError, which the tool's outer catch turns into
      // `{ ok: false, error }`, and a falsy body is an empty listing.
      // Discovery (not strict) reads `Array.isArray(data) ? data : []`.
      if (o.strict && !resp.error && resp.data && !Array.isArray(resp.data)) {
        throw new TypeError("session listing response was not an array");
      }
      return toListing(resp, {
        limit: o.limit,
        archived: o.scope === "project" ? o.archived : undefined,
      });
    },

    async getSession(id, o): Promise<Lookup<HistorySession>> {
      const resp: SdkResponse = await clientFor(o.scope).session.get({ sessionID: id });
      if (resp.error) return errorLookup(resp);
      if (resp.data == null) return { ok: false, reason: "not-found" };
      if (typeof resp.data !== "object") {
        return { ok: false, reason: "malformed", error: "session response was not an object" };
      }
      return { ok: true, value: resp.data as HistorySession };
    },

    async listChildren(parentID, o = {}): Promise<Listing<HistorySession>> {
      // The endpoint has no paging, so every child comes back at once.
      return toListing(await scoped.session.children({ sessionID: parentID }), {
        archived: o.archived,
      });
    },

    // No `messagePageAscending`: the v1 endpoint pages newest first only, so
    // callers report oldest-first paging as unsupported here.
    async messagePage(o): Promise<MessagePage> {
      return fetchMessagePage(scoped, o);
    },

    // The v1 endpoint's cursors come only from its own pages, so a walk
    // bounded above reads from the newest message and skips what it must.
    async seekPage(): Promise<Lookup<string | null | undefined>> {
      return { ok: false, reason: "unsupported", error: NO_SEEK };
    },

    async getMessage(sessionID, messageID, o = {}): Promise<Lookup<HistoryMessage>> {
      if (o.partOrdinal !== undefined) {
        return { ok: false, reason: "unsupported", error: NO_PART_ORDINALS };
      }
      const resp: SdkResponse = await scoped.session.message({ sessionID, messageID });
      if (resp.error) return errorLookup(resp);
      if (!resp.data) return { ok: false, reason: "not-found" };
      return { ok: true, value: resp.data as HistoryMessage };
    },
  };
}
