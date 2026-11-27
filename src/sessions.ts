import { tool } from "./tool-def.js";
import type { ToolDefinition, ToolContext } from "./host/opencode-v1-types.js";
import {
  errmsg,
  optionalString,
  coerceEnum,
  coerceInt,
  type SessionItem,
  type SessionsOutput,
  type Limits,
  type IndexingStatus,
  indexingWarning,
} from "./types.js";
import type { Card } from "./store.js";
import { isSummarizerTitle } from "./extract.js";
import { unavailableHistoryError, type HistorySource } from "./history/source.js";
import type { HistorySession } from "./history/model.js";
import { cyrb53 } from "./hash.js";
import {
  decodeSessionsCursor,
  encodeSessionsCursor,
  section,
  writeError,
  writeOutput,
  type SessionsCursor,
} from "./output.js";

/** Card-backed enrichment for the sessions browser: a snapshot of all cards the
 *  distiller has built. `session.list` stays the authoritative listing; when a
 *  card exists for a listed session it contributes a richer digest, its top
 *  files/tools, and a family rollup for roots — all from a point lookup, never a
 *  fetch. Undefined in degraded mode (no store), where listings stay bare. */
export type SessionEnrichment = {
  cards(): Card[];
  /** The cold pass's progress while it builds an incomplete store (see
   *  SearchDeps.indexing). */
  indexing?: IndexingStatus;
};

const SESSION_DIGEST_CHARS = 160;
const MAX_FILES = 5;
const MAX_TOOLS = 5;
/** Children read per listing call, and the most calls one children listing
 *  makes. A parent with more children than these read is reported
 *  `truncated`. */
const CHILDREN_PAGE = 1_000;
const CHILDREN_PAGES_MAX = 10;
/** Reads one call makes of a live listing, at most, the first one included.
 *  A read that the filters left short of the sessions the call needs is
 *  followed by one that asks for those sessions plus the rows the filters
 *  dropped from it (the shortfall). */
const LIVE_READS_MAX = 3;
/** Why a live listing that summarizer workers fill ends short, after
 *  {@link LIVE_READS_MAX} reads. */
const WORKERS_CROWD =
  "too many summarizer worker sessions (never listed) come first for one call to read that far; narrow the listing with search";

/** A listing's output fields other than its sessions, which a page sets. */
type ListingFields = Omit<SessionsOutput, "ok" | "sessions" | "returned">;

/** A fingerprint of a set of sessions: their ids in id order, hashed, so a
 *  session that moves within the set leaves it unchanged. */
function idsFingerprint(items: readonly SessionItem[]): string {
  return cyrb53(JSON.stringify(items.map((item) => item.id).sort()));
}

/** A fingerprint of a run of sessions: each one's id and `updated` time in
 *  listing order, hashed, so any session added, removed, updated or moved
 *  changes it. */
function runFingerprint(items: readonly SessionItem[]): string {
  return cyrb53(JSON.stringify(items.map((item) => [item.id, item.time.updated])));
}

/** Every child of `parentID`, paged in id order so a child updated during the
 *  walk is neither skipped nor listed twice, up to
 *  `CHILDREN_PAGE * CHILDREN_PAGES_MAX` of them. */
export async function listAllChildren(
  source: HistorySource,
  parentID: string,
): Promise<
  { ok: true; items: HistorySession[]; truncated: boolean } | { ok: false; error: string }
> {
  const items: HistorySession[] = [];
  let after: string | undefined;
  for (let pages = 1; ; pages++) {
    const result = await source.listChildren(parentID, {
      order: "id",
      limit: CHILDREN_PAGE,
      ...(after !== undefined && { after }),
    });
    if (!result.ok) return result;
    items.push(...result.items);
    if (!result.truncated) return { ok: true, items, truncated: false };
    if (pages >= CHILDREN_PAGES_MAX || result.nextCursor === undefined) {
      return { ok: true, items, truncated: true };
    }
    after = result.nextCursor;
  }
}

/** Parse a `since`/`until` bound: a relative duration (`2h`/`7d`/`3w`), an ISO
 *  date, or a ms-epoch number. Returns undefined for anything unparseable. */
function parseTimeBound(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const relative = /^(\d+)([hdw])(?:\s+ago)?$/i.exec(value.trim());
  if (relative) {
    const amount = Number(relative[1]);
    if (!Number.isSafeInteger(amount) || amount < 0) return undefined;
    const unit = relative[2]?.toLowerCase();
    const hours = unit === "h" ? amount : unit === "d" ? amount * 24 : amount * 24 * 7;
    return now - hours * 60 * 60 * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeDir(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

/** Project-scope membership for the card path: a card's directory is the caller's
 *  directory or a descendant of it. With no caller directory, nothing is scoped
 *  out (best-effort, matching the list call's lenient project scoping). */
function sameProject(cardDir: string, callerDir: string | undefined): boolean {
  if (!callerDir) return true;
  const dir = normalizeDir(cardDir);
  return dir === callerDir || (dir != null && dir.startsWith(`${callerDir}/`));
}

export function sessions(
  source: HistorySource,
  global: boolean,
  limits: Limits,
  enrichment?: SessionEnrichment,
): ToolDefinition {
  /** A listing selected from the cards while the index is still being built
   *  may be missing sessions: say so, with the pass's progress. Only the
   *  card-selected paths use it; a live listing is complete as it is. */
  const withIndexing = (out: ListingFields): ListingFields => {
    const progress = enrichment?.indexing?.();
    if (!progress) return out;
    const warning = indexingWarning(progress);
    return { ...out, indexing: progress, note: out.note ? `${out.note} ${warning}` : warning };
  };
  /**
   * One page of a listing as output. `listed` is the whole listing this call
   * holds, in order and without card enrichment; the page is the `limit`
   * sessions from the cursor's session on (from the start without one, and
   * the rest of the page for a cursor into a trimmed one), passed through
   * `decorate` and trimmed to the budget. A trimmed page carries a
   * `continuation` at the first session not shown, and `nextCursor` names
   * that session whether the budget or the end of the page stopped the
   * output. `truncated` says more sessions match than the page holds: the
   * listing goes on past it, the source holds rows past those this call read
   * (`more`), or `fields` says so already. When `more` is set but the call
   * holds no session past the page to continue from, its note says why.
   *
   * The listing is rebuilt on every call, so a cursor resumes only when the
   * sessions before its anchor are exactly the ones already shown (in any
   * order: a shown session that was updated may have moved to the top) and
   * the listing from the anchor on is unchanged, session for session, as far
   * as the call that made the cursor held it. A change in between could
   * otherwise skip a session (one moved ahead of the anchor) or show one
   * twice (the anchor moved). When `more.short` is set, the reads ended
   * before they reached every session the call needed, so a cursor whose
   * anchor or rest lies past `listed` is refused for that reason, not as a
   * change.
   */
  const respond = (
    fields: ListingFields,
    listed: readonly SessionItem[],
    page: {
      cursor: SessionsCursor | undefined;
      limit: number;
      decorate?: (item: SessionItem) => SessionItem;
      more?: { short: boolean };
    },
  ): string => {
    const { cursor, limit } = page;
    let start = 0;
    if (cursor) {
      start = listed.findIndex((item) => item.id === cursor.anchor);
      if (page.more?.short && (start === -1 || start + cursor.restCount > listed.length)) {
        return writeError(
          `This cursor's place in the listing could not be reached: ${WORKERS_CROWD}, then list again without cursor`,
        );
      }
      if (start === -1) {
        return writeError(
          `This cursor's session ${cursor.anchor} is no longer in this listing; list again without cursor`,
        );
      }
      const restEnd = start + cursor.restCount;
      if (
        start !== cursor.shown ||
        restEnd > listed.length ||
        idsFingerprint(listed.slice(0, start)) !== cursor.ids ||
        runFingerprint(listed.slice(start, restEnd)) !== cursor.rest
      ) {
        return writeError(
          `This listing changed since the cursor was made (sessions were updated, added or removed); list again without cursor`,
        );
      }
    }
    // A cursor into a trimmed page shows the rest of that page; any other
    // cursor, or none, starts a page of `limit`.
    const end = Math.min(listed.length, start + Math.min(limit, cursor?.left ?? limit));
    const shown = listed.slice(start, end);
    const records = page.decorate ? shown.map(page.decorate) : shown;
    const truncated = fields.truncated === true || end < listed.length || page.more !== undefined;
    const rest: Record<string, unknown> = { ...fields };
    delete rest.truncated;
    if (page.more && end === listed.length) {
      const note = `More sessions exist past these, but ${WORKERS_CROWD}.`;
      rest.note = fields.note ? `${fields.note} ${note}` : note;
    }
    /** A cursor at `next`; `pageEnd` makes it resume a trimmed page that
     *  ends there. */
    const cursorAt = (next: number, pageEnd?: number): string =>
      encodeSessionsCursor({
        anchor: listed[next]!.id,
        shown: next,
        ids: idsFingerprint(listed.slice(0, next)),
        rest: runFingerprint(listed.slice(next)),
        restCount: listed.length - next,
        ...(pageEnd !== undefined && { left: pageEnd - next }),
      });
    return writeOutput({
      sections: [section("sessions", records)],
      head: (stop, counts) => {
        const continuation = stop ? cursorAt(start + stop.index, end) : undefined;
        const nextCursor = continuation ?? (end < listed.length ? cursorAt(end) : undefined);
        return {
          ...(continuation && { continuation }),
          fields: {
            returned: counts.sessions ?? 0,
            ...rest,
            ...(truncated && { truncated: true }),
            ...(nextCursor && { nextCursor }),
          },
        };
      },
    }).text;
  };
  return tool({
    description: `List session metadata: titles, directories, timestamps, archival state, plus (when a distilled card exists) a content digest, top files/tools, and a family rollup for roots. Use only for recent-session browsing, finding a session ID/title/timeframe, or recency checks. Not content search; for topical discovery use recall. To recover cancelled or interrupted subagents (Task tool returned "Task cancelled" with no task_id), call this with parentID:"current" — the listing is live and does not depend on the search index. To read on, pass cursor: nextCursor (same arguments): it resumes a trimmed result, then pages past limit while truncated.`,
    args: {
      scope: tool.schema
        .enum(["project", "global"])
        .default("project")
        .describe("project=current project, global=all projects"),
      parentID: tool.schema
        .string()
        .optional()
        .describe(
          'Filter to child (subagent) sessions of a parent; "current" = this session. Live lookup, direct children only — works for cancelled or in-flight subagents not yet indexed.',
        ),
      search: tool.schema.string().optional().describe("Title substring"),
      since: tool.schema
        .string()
        .optional()
        .describe("Only sessions updated since: 2h, 7d, 3w, or a date"),
      until: tool.schema
        .string()
        .optional()
        .describe("Only sessions updated before: 2h, 7d, 3w, or a date"),
      limit: tool.schema
        .number()
        .min(1)
        .max(limits.maxSessionList)
        .default(Math.min(20, limits.maxSessionList))
        .describe("Max sessions returned per page"),
      cursor: tool.schema
        .string()
        .optional()
        .describe("nextCursor (or continuation) from a prior result; omit for the start"),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      const search = optionalString(args.search);
      // Defensive: live MCP host can bypass Zod defaults. A non-string parentID
      // degrades to an ordinary listing (detectable: scope !== "children"),
      // and a non-string cursor reads as none.
      const parentID = optionalString(args.parentID);
      const scope = coerceEnum(args.scope, ["project", "global"] as const, "project");
      const limit = coerceInt(
        args.limit,
        Math.min(20, limits.maxSessionList),
        1,
        limits.maxSessionList,
      );
      const now = Date.now();
      const since = parseTimeBound(optionalString(args.since), now);
      const until = parseTimeBound(optionalString(args.until), now);
      const rawCursor = optionalString(args.cursor);
      let resume: SessionsCursor | undefined;
      if (rawCursor) {
        const decoded = decodeSessionsCursor(rawCursor);
        if (!decoded.ok) return writeError(decoded.error);
        resume = decoded.value;
      }

      ctx.metadata({
        title: search
          ? `Listing ${scope} sessions matching "${search}"`
          : `Listing ${scope} sessions`,
      });

      // The children branch ignores `scope`, so the global-disabled early
      // return does not apply to it (its own scope policy is decision 2's
      // sameProject withholding for explicit foreign parents).
      if (scope === "global" && !global && !parentID) {
        return writeError("Global scope disabled via plugin option: global: false");
      }

      // Build the enrichment lookups once (card by id, child count by root).
      let allCards: Card[] | undefined;
      let cardById: Map<string, Card> | undefined;
      let childCountByRoot: Map<string, number> | undefined;
      if (enrichment) {
        allCards = enrichment.cards();
        cardById = new Map(allCards.map((card) => [card.sessionId, card]));
        childCountByRoot = new Map();
        for (const card of allCards) {
          if (card.rootId && card.rootId !== card.sessionId) {
            childCountByRoot.set(card.rootId, (childCountByRoot.get(card.rootId) ?? 0) + 1);
          }
        }
      }

      const hasTimeFilter = since != null || until != null;
      const passesTime = (updated: number): boolean => {
        if (since != null && updated < since) return false;
        if (until != null && updated > until) return false;
        return true;
      };

      /** Live-listing marker, applied at the call sites of the two live paths
       *  (the children branch and the staleness fallback) — never inside
       *  `enrich()`, which also serves the ordinary card-backed listings that
       *  must stay byte-identical. A row with no card, or a card not distilled
       *  to content, gets `distilled: false`; full-card rows omit the field. */
      const markUndistilled = (item: SessionItem): SessionItem => {
        const card = cardById?.get(item.id);
        return card && card.distillState === "full" ? item : { ...item, distilled: false };
      };

      /** Attach card-derived enrichment to a base item (digest, files, tools,
       *  family). Backward compatible: only optional fields are ever added. */
      const enrich = (item: SessionItem): SessionItem => {
        const card = cardById?.get(item.id);
        if (!card) return item;
        const files = card.files.slice(0, MAX_FILES);
        const tools = card.tools.slice(0, MAX_TOOLS);
        const childCount = childCountByRoot?.get(item.id) ?? 0;
        // Prefer the LLM summary (Path B) over the mechanical summary head.
        const digest = (card.nlSummary || card.summaryHead).slice(0, SESSION_DIGEST_CHARS);
        return {
          ...item,
          ...(digest && { digest }),
          ...(files.length > 0 && { files }),
          ...(tools.length > 0 && { tools }),
          ...(card.rootId === item.id &&
            childCount > 0 && { family: { rootId: item.id, childCount } }),
        };
      };

      /** A card as a listed session, for the paths that list from cards. */
      const cardItem = (card: Card): SessionItem => ({
        id: card.sessionId,
        title: card.title,
        directory: card.directory,
        time: { created: card.timeCreated, updated: card.timeUpdated },
        archived: card.timeArchived != null,
      });

      try {
        // ── Unreadable history source: serve from the card index ──
        // v2 with opencode.db unavailable: no listing can be read live, but a
        // card store from an earlier run still knows the sessions. Without
        // cards there is nothing to list.
        if (source.unavailable !== undefined) {
          const unavailable = unavailableHistoryError(source.unavailable);
          if (!allCards || allCards.length === 0) return writeError(unavailable);
          const currentSessionID = optionalString(ctx.sessionID);
          const resolvedParent =
            parentID && parentID.toLowerCase() === "current" ? currentSessionID : parentID;
          if (parentID && !resolvedParent) {
            return writeError(
              'parentID:"current" requires a current session, but none is available',
            );
          }
          const searchLower = search?.toLowerCase();
          const callerDir = normalizeDir(optionalString(ctx.directory));
          const inScope = (card: Card): boolean => {
            if (resolvedParent) {
              if (card.parentId !== resolvedParent) return false;
              return global || resolvedParent === currentSessionID
                ? true
                : sameProject(card.directory, callerDir);
            }
            return scope === "global" ? true : sameProject(card.directory, callerDir);
          };
          const selected = allCards
            .filter(
              (card) =>
                !isSummarizerTitle(card.title) &&
                passesTime(card.timeUpdated) &&
                inScope(card) &&
                (!searchLower || card.title.toLowerCase().includes(searchLower)),
            )
            .sort(
              (a, b) => b.timeUpdated - a.timeUpdated || a.sessionId.localeCompare(b.sessionId),
            );
          const fields: ListingFields = {
            scope: resolvedParent ? "children" : scope,
            ...(resolvedParent && { parentID: resolvedParent, childCount: selected.length }),
            note: `${unavailable}. This listing comes from the card index, which may lag the live history.`,
          };
          return respond(withIndexing(fields), selected.map(cardItem), {
            cursor: resume,
            limit,
            decorate: enrich,
          });
        }

        // ── Children branch: live parent/child lookup, index-free ──
        // Recovers subagent sessions (cancelled or in-flight) that the card
        // index has not caught up to. Ignores `scope`; direct children only.
        if (parentID) {
          const currentSessionID = optionalString(ctx.sessionID);
          // Case-insensitive sugar; no collision risk (real IDs are ses_*-prefixed).
          const resolvedParent = parentID.toLowerCase() === "current" ? currentSessionID : parentID;
          if (!resolvedParent) {
            return writeError(
              'parentID:"current" requires a current session, but none is available',
            );
          }
          const result = await listAllChildren(source, resolvedParent);
          if (!result.ok) return writeError(`Failed to list children: ${result.error}`);
          const searchLower = search?.toLowerCase();
          const callerDir = normalizeDir(optionalString(ctx.directory));
          // `global: false` withholds children in foreign projects — but only
          // for explicit foreign parents. The caller's own children are exempt:
          // this session spawned them (possibly in other worktrees), so the
          // don't-leak-other-projects rationale cannot apply.
          const scopeExempt = global || resolvedParent === currentSessionID;
          let withheld = 0;
          // Defensive: a divergent server payload (non-array data without an
          // error) arrives as an empty child list, not a raw TypeError.
          const rows = result.items;
          const selected = rows
            .filter((row) => {
              // Direct children only — the output contract holds even if the
              // endpoint returns full descendants.
              if (row.parentID !== resolvedParent) return false;
              if (isSummarizerTitle(row.title)) return false;
              if (searchLower && !row.title.toLowerCase().includes(searchLower)) return false;
              if (!passesTime(row.time.updated)) return false;
              if (!scopeExempt && !sameProject(row.directory, callerDir)) {
                withheld++;
                return false;
              }
              return true;
            })
            .sort((a, b) => b.time.updated - a.time.updated || a.id.localeCompare(b.id));
          // Post-filter, across every page: the same total on each page.
          const childCount = selected.length;
          const listed = selected.map(
            (s): SessionItem => ({
              id: s.id,
              title: s.title,
              directory: s.directory,
              time: { created: s.time.created, updated: s.time.updated },
              archived: s.time.archived != null,
            }),
          );
          ctx.metadata({ title: `Found ${childCount} children of ${resolvedParent}` });
          const notes = [
            ...(withheld > 0
              ? [
                  `${withheld} child session${withheld === 1 ? "" : "s"} in other projects ${withheld === 1 ? "was" : "were"} withheld (plugin option global: false).`,
                ]
              : []),
            ...(result.truncated
              ? [
                  `This parent has more than ${result.items.length} children; only the first ${result.items.length} by session id were read, so childCount and this listing cover those alone.`,
                ]
              : []),
          ];
          const fields: ListingFields = {
            scope: "children",
            parentID: resolvedParent,
            childCount,
            ...(result.truncated && { truncated: true as const }),
            ...(notes.length > 0 && { note: notes.join(" ") }),
          };
          return respond(fields, listed, {
            cursor: resume,
            limit,
            decorate: (item) => markUndistilled(enrich(item)),
          });
        }

        // ── Card-authoritative time filtering ──
        // When a card store is available and a since/until bound is set, resolve
        // the set from the in-memory cards. session.list returns only the newest
        // `limit` rows, so post-filtering it drops older matches entirely (e.g.
        // until:"30d" would return ~nothing). The cards are the recency-complete,
        // fetch-free authority, so they select; the list call is skipped.
        // Exception: when the filter selects nothing AND the lower bound is
        // newer than the newest in-scope card, the emptiness is index lag, not
        // history — fall through to the live list with `staleFallback` set.
        let staleFallback = false;
        if (allCards && hasTimeFilter) {
          const searchLower = search?.toLowerCase();
          const callerDir = normalizeDir(optionalString(ctx.directory));
          const inScope = (card: Card): boolean =>
            scope === "global" ? true : sameProject(card.directory, callerDir);
          const selected = allCards
            .filter(
              (card) =>
                !isSummarizerTitle(card.title) &&
                passesTime(card.timeUpdated) &&
                inScope(card) &&
                (!searchLower || card.title.toLowerCase().includes(searchLower)),
            )
            .sort((a, b) => b.timeUpdated - a.timeUpdated || a.sessionId.localeCompare(b.sessionId))
            .map(cardItem);
          // Staleness watermark: newest in-scope card, counting ALL cards
          // regardless of distillState (a metadata card is sufficient coverage
          // for a metadata listing; a full-only watermark would collapse in
          // cards-lite mode and fire this on every since call). Only a lower
          // bound triggers, and an inverted window (since > until) is the
          // caller's own emptiness, not index lag.
          if (selected.length === 0 && since != null && !(until != null && since > until)) {
            let watermark = 0;
            for (const card of allCards) {
              // Summarizer workers are excluded from every listing, so a fresh
              // worker card must not raise the watermark and mask real lag.
              if (isSummarizerTitle(card.title)) continue;
              if (inScope(card) && card.timeUpdated > watermark) watermark = card.timeUpdated;
            }
            if (since > watermark) staleFallback = true;
          }
          if (!staleFallback) {
            ctx.metadata({
              title: `Found ${selected.length} ${scope} sessions${search ? ` matching "${search}"` : ""}`,
            });
            return respond(withIndexing({ scope }), selected, {
              cursor: resume,
              limit,
              decorate: enrich,
            });
          }
        }

        // ── Live listing ──
        // A time-bounded live listing (no card store, or the staleness
        // fallback) covers the newest `limit` sessions only, as its note says,
        // so it is one page. Any other live listing pages on. A listing by
        // recency cannot resume from a key, so each call reads it from the top
        // through the session after its page and every session its cursor's
        // rest covers.
        const pages = !hasTimeFilter;
        const start = resume?.shown ?? 0;
        const want = pages ? start + Math.max(limit + 1, resume?.restCount ?? 0) : limit;
        const toItem = (s: HistorySession): SessionItem => ({
          id: s.id,
          title: s.title,
          directory: s.directory,
          ...(scope === "global" && {
            project: s.project ? { name: s.project.name, worktree: s.project.worktree } : undefined,
          }),
          time: { created: s.time.created, updated: s.time.updated },
          archived: s.time.archived != null,
        });
        let listed: SessionItem[] = [];
        let more = false;
        for (let reads = 1, rows = want; ; reads++) {
          const result = await source.listSessions({ scope, search, limit: rows, strict: true });
          if (!result.ok) return writeError(`Failed to list sessions: ${result.error}`);
          listed = result.items
            .filter((s) => !isSummarizerTitle(s.title) && passesTime(s.time.updated))
            .map(toItem);
          more = pages && result.truncated;
          if (!more || listed.length >= want || reads >= LIVE_READS_MAX) break;
          // Summarizer workers left this read short of `want`: read past them.
          rows += want - listed.length;
        }
        ctx.metadata({
          title: `Found ${Math.max(0, Math.min(limit, listed.length - start))} ${scope} sessions${search ? ` matching "${search}"` : ""}`,
        });

        // The fallback consulted the newest `limit` live sessions — newest
        // `limit` MATCHING sessions when a title search narrowed the list call.
        const liveBound = `the newest ${limit}${search ? " matching" : ""} live sessions`;

        const fields: ListingFields = {
          scope: scope,
          // The two note producers below cannot co-occur: the fallback requires
          // a card store (allCards), the degraded note requires its absence.
          // The fallback note only claims index lag when the live source
          // actually produced in-window rows; an empty live check means the
          // window is genuinely quiet, and the note says so instead.
          ...(staleFallback
            ? {
                note:
                  listed.length > 0
                    ? `The card index had not caught up to this time window (its newest session predates \`since\`), so ${liveBound} were consulted instead. This listing is bounded by that window and may itself be incomplete.`
                    : `No indexed session in scope is newer than \`since\`, so ${liveBound} were checked; none fell in the window either.`,
              }
            : {}),
          // Degraded path: no card store, so the time filter could only be applied
          // within the newest-`limit` window session.list returned. Older matches
          // beyond it are not shown — say so honestly.
          ...(hasTimeFilter && !allCards
            ? {
                note: `since/until was applied within the newest ${limit} sessions only (no card store to resolve older matches).`,
              }
            : {}),
        };
        // A live listing does not depend on the card index: no indexing note.
        // On the staleness fallback, rows without a full card are marked
        // distilled:false here (never inside enrich()). Only summarizer
        // workers can keep the reads from reaching every session they need.
        return respond(fields, listed, {
          cursor: resume,
          limit,
          decorate: staleFallback ? (item) => markUndistilled(enrich(item)) : enrich,
          ...(more && { more: { short: listed.length < want } }),
        });
      } catch (e) {
        return writeError(errmsg(e));
      }
    },
  });
}
