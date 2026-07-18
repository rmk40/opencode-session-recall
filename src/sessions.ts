import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import {
  errmsg,
  optionalString,
  coerceEnum,
  coerceInt,
  type SessionItem,
  type SessionsOutput,
  type ErrorOutput,
  type Limits,
} from "./types.js";
import type { Card } from "./store.js";

/** Card-backed enrichment for the sessions browser: a snapshot of all cards the
 *  distiller has built. `session.list` stays the authoritative listing; when a
 *  card exists for a listed session it contributes a richer digest, its top
 *  files/tools, and a family rollup for roots — all from a point lookup, never a
 *  fetch. Undefined in degraded mode (no store), where listings stay bare. */
export type SessionEnrichment = {
  cards(): Card[];
};

const SESSION_DIGEST_CHARS = 160;
const MAX_FILES = 5;
const MAX_TOOLS = 5;

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

export function sessions(
  client: OpencodeClient,
  unscoped: OpencodeClient,
  global: boolean,
  limits: Limits,
  enrichment?: SessionEnrichment,
): ToolDefinition {
  return tool({
    description: `List session metadata: titles, directories, timestamps, archival state, plus (when a distilled card exists) a content digest, top files/tools, and a family rollup for roots. Use only for recent-session browsing, finding a session ID/title/timeframe, or recency checks. Not content search; for topical discovery use recall.`,
    args: {
      scope: tool.schema
        .enum(["project", "global"])
        .default("project")
        .describe("project=current project, global=all projects"),
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
        .describe("Max sessions returned"),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      const search = optionalString(args.search);
      // Defensive: live MCP host can bypass Zod defaults.
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

      ctx.metadata({
        title: search
          ? `Listing ${scope} sessions matching "${search}"`
          : `Listing ${scope} sessions`,
      });

      if (scope === "global" && !global) {
        const err: ErrorOutput = {
          ok: false,
          error: "Global scope disabled via plugin option: global: false",
        };
        return JSON.stringify(err);
      }

      // Build the enrichment lookups once (card by id, child count by root).
      let cardById: Map<string, Card> | undefined;
      let childCountByRoot: Map<string, number> | undefined;
      if (enrichment) {
        const cards = enrichment.cards();
        cardById = new Map(cards.map((card) => [card.sessionId, card]));
        childCountByRoot = new Map();
        for (const card of cards) {
          if (card.rootId && card.rootId !== card.sessionId) {
            childCountByRoot.set(card.rootId, (childCountByRoot.get(card.rootId) ?? 0) + 1);
          }
        }
      }

      const passesTime = (updated: number): boolean => {
        if (since != null && updated < since) return false;
        if (until != null && updated > until) return false;
        return true;
      };

      /** Attach card-derived enrichment to a base item (digest, files, tools,
       *  family). Backward compatible: only optional fields are ever added. */
      const enrich = (item: SessionItem): SessionItem => {
        const card = cardById?.get(item.id);
        if (!card) return item;
        const files = card.files.slice(0, MAX_FILES);
        const tools = card.tools.slice(0, MAX_TOOLS);
        const childCount = childCountByRoot?.get(item.id) ?? 0;
        return {
          ...item,
          ...(card.summaryHead && { digest: card.summaryHead.slice(0, SESSION_DIGEST_CHARS) }),
          ...(files.length > 0 && { files }),
          ...(tools.length > 0 && { tools }),
          ...(card.rootId === item.id &&
            childCount > 0 && { family: { rootId: item.id, childCount } }),
        };
      };

      try {
        const items: SessionItem[] = [];

        if (scope === "global") {
          const result = await unscoped.experimental.session.list({ search, limit });
          if (result.error) {
            const err: ErrorOutput = {
              ok: false,
              error: `Failed to list sessions: ${errmsg(result.error)}`,
            };
            return JSON.stringify(err);
          }
          if (result.data) {
            for (const s of result.data) {
              if (!passesTime(s.time.updated)) continue;
              items.push(
                enrich({
                  id: s.id,
                  title: s.title,
                  directory: s.directory,
                  project: s.project
                    ? { name: s.project.name, worktree: s.project.worktree }
                    : undefined,
                  time: { created: s.time.created, updated: s.time.updated },
                  archived: s.time.archived != null,
                }),
              );
            }
          }
        } else {
          const result = await client.session.list({ search, limit });
          if (result.error) {
            const err: ErrorOutput = {
              ok: false,
              error: `Failed to list sessions: ${errmsg(result.error)}`,
            };
            return JSON.stringify(err);
          }
          if (result.data) {
            for (const s of result.data) {
              if (!passesTime(s.time.updated)) continue;
              items.push(
                enrich({
                  id: s.id,
                  title: s.title,
                  directory: s.directory,
                  time: { created: s.time.created, updated: s.time.updated },
                  archived: s.time.archived != null,
                }),
              );
            }
          }
        }

        ctx.metadata({
          title: `Found ${items.length} ${scope} sessions${search ? ` matching "${search}"` : ""}`,
        });

        const out: SessionsOutput = {
          ok: true,
          sessions: items,
          returned: items.length,
          scope: scope,
        };
        return JSON.stringify(out);
      } catch (e) {
        const err: ErrorOutput = { ok: false, error: errmsg(e) };
        return JSON.stringify(err);
      }
    },
  });
}
