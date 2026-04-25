import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin";
import type { OpencodeClient, Session, GlobalSession, Part, Message } from "@opencode-ai/sdk/v2";
import {
  errmsg,
  optionalString,
  type ExpandedResult,
  type MessageItem,
  type PartOutput,
  type SearchResult,
  type SearchOutput,
  type ErrorOutput,
  type Limits,
  type MatchMode,
  type DegradeKind,
  type GroupMode,
} from "./types.js";
import { searchable, snippet, pruned, matches, formatMsg } from "./extract.js";
import { parseQuery } from "./query.js";
import { buildCandidates, populateNormalized, DEFAULT_BUDGETS } from "./candidates.js";
import { prefilter } from "./prefilter.js";
import { fuseSearch, type FuseHit } from "./fuse.js";
import { rank, rankDegraded, type RankedResult } from "./rank.js";
import { smartSnippet } from "./snippet.js";

/** Post-fetch time budget for the entire ranking pipeline (ms) */
const TIME_BUDGET_MS = 2000;

/** Pre-Fuse.js early-exit threshold (ms). Skip Fuse if prefilter alone takes this long. */
const PREFUSE_BUDGET_MS = 1500;

/** Max literal results to collect when grouping by session.
 *  Must be high enough to get representative hits from many sessions,
 *  but bounded to prevent unbounded memory growth on broad queries. */
const MAX_GROUPED_LITERAL_RESULTS = 1000;

const MAX_EXPANDED_RESULTS = 3;
const MAX_EXPANDED_CONTEXT_MESSAGES = 30;
const MAX_EXPANDED_TOTAL_TEXT_CHARS = 30_000;
const MAX_EXPANDED_FIELD_CHARS = 4_000;
const DIRECTORY_FILTER_LIST_LIMIT = 5000;
const EXPANSION_TRUNCATED = "\n[truncated by recall expansion]";

type ExpandMode = "none" | "context" | "message";
type ExpansionBudget = { remaining: number };

// ── Types ────────────────────────────────────────────────────────────

type MsgWithParts = {
  info: Message;
  parts: Array<Part>;
};

type SessionMetaInternal = { id: string; title: string; directory: string };

function meta(s: Session | GlobalSession): SessionMetaInternal {
  return { id: s.id, title: s.title, directory: s.directory };
}

function positiveTimestampOrUndefined(value: number | undefined): number | undefined {
  return value != null && value > 0 ? value : undefined;
}

function parseRelativeTimestamp(
  label: string,
  value: string | undefined,
  now = Date.now(),
): number | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;

  const match = /^(\d+)([hdw])$/.exec(raw);
  if (!match) {
    throw new Error(`${label} must be a positive duration like 2h, 7d, or 3w`);
  }

  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`${label} must be a positive duration like 2h, 7d, or 3w`);
  }

  const unit = match[2];
  const hours = unit === "h" ? amount : unit === "d" ? amount * 24 : amount * 24 * 7;
  return now - hours * 60 * 60 * 1000;
}

function normalizeDirectoryPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function directoryMatches(directory: string, target: string): boolean {
  const dir = normalizeDirectoryPath(directory);
  const filter = normalizeDirectoryPath(target);
  if (filter === "/") return dir === "/" || dir.startsWith("/");
  return dir === filter || dir.startsWith(`${filter}/`);
}

function partEligible(part: Part, type: string, toolName: string | undefined): boolean {
  if (toolName) return part.type === "tool" && part.tool === toolName;
  return type === "all" || part.type === type;
}

function listLimitForDirectoryFilter(argsLimit: number, configuredLimit: number): number {
  // A finite maxSessions is a hard plugin safety cap; broaden only within it.
  if (Number.isFinite(configuredLimit)) return configuredLimit;
  return Math.max(argsLimit, DIRECTORY_FILTER_LIST_LIMIT);
}

function truncateExpandedText(
  value: string | undefined,
  budget: ExpansionBudget,
): string | undefined {
  if (value == null) return undefined;
  if (budget.remaining <= 0) return undefined;

  const allowed = Math.min(MAX_EXPANDED_FIELD_CHARS, budget.remaining);
  if (value.length <= allowed) {
    budget.remaining -= value.length;
    return value;
  }

  if (allowed <= EXPANSION_TRUNCATED.length) return undefined;

  const sliceLength = allowed - EXPANSION_TRUNCATED.length;
  budget.remaining -= allowed;
  return `${value.slice(0, sliceLength)}${EXPANSION_TRUNCATED}`;
}

function truncateExpandedPart(part: PartOutput, budget: ExpansionBudget): PartOutput {
  return {
    ...part,
    content: truncateExpandedText(part.content, budget),
    output: truncateExpandedText(part.output, budget),
    error: truncateExpandedText(part.error, budget),
  };
}

function formatExpandedMsg(msg: MsgWithParts, budget: ExpansionBudget): MessageItem {
  const item = formatMsg(msg);
  return {
    ...item,
    parts: item.parts.map((part) => truncateExpandedPart(part, budget)),
  };
}

/** Cap sample size only; loadErrorCount still reports all failures. */
const MAX_LOAD_ERROR_SAMPLES = 5;

// ── Literal scan (preserved from original) ──────────────────────────

function scan(
  messages: MsgWithParts[],
  session: SessionMetaInternal,
  query: string,
  type: string,
  role: string,
  limit: number,
  before?: number,
  after?: number,
  width?: number,
  toolName?: string,
): { results: SearchResult[]; total: number } {
  const results: SearchResult[] = [];
  let total = 0;

  for (const msg of messages) {
    if (results.length >= limit) break;
    const ts = msg.info.time.created;
    if (before != null && ts >= before) continue;
    if (after != null && ts <= after) continue;
    if (role !== "all" && msg.info.role !== role) continue;

    for (const part of msg.parts) {
      if (results.length >= limit) break;
      if (!partEligible(part, type, toolName)) continue;

      const texts = searchable(part);
      let matched = false;

      for (const text of texts) {
        if (!matches(text, query)) continue;
        total++;
        if (matched) continue;
        matched = true;

        if (results.length < limit) {
          results.push({
            sessionID: session.id,
            sessionTitle: session.title,
            directory: session.directory,
            messageID: msg.info.id,
            role: msg.info.role,
            time: msg.info.time.created,
            partID: part.id,
            partType: part.type,
            pruned: pruned(part),
            snippet: snippet(text, query, width),
            toolName: part.type === "tool" ? part.tool : undefined,
          });
        }
      }
    }
  }
  return { results, total };
}

// ── Smart/fuzzy scan ─────────────────────────────────────────────────

/** smartScan returns ALL ranked results (caller handles slicing/grouping). */
function smartScan(
  allMessages: Array<{
    session: SessionMetaInternal;
    messages: MsgWithParts[];
  }>,
  query: string,
  type: string,
  role: string,
  explain: boolean,
  mode: "smart" | "fuzzy",
  before?: number,
  after?: number,
  width?: number,
  toolName?: string,
): {
  results: SearchResult[];
  total: number;
  degradeKind: DegradeKind;
  matchMode: MatchMode;
} {
  const pq = parseQuery(query);
  const startTime = performance.now();

  // ── 1. Build candidates across all sessions ───────────────────────
  const allCandidates: Array<ReturnType<typeof buildCandidates>["candidates"][number]> = [];
  let totalCharsUsed = 0;
  let anyBudgetHit = false;

  for (const { session, messages } of allMessages) {
    const { candidates, charsUsed, budgetHit } = buildCandidates(
      messages,
      session,
      {
        ...DEFAULT_BUDGETS,
        maxCharsTotal: DEFAULT_BUDGETS.maxCharsTotal - totalCharsUsed,
      },
      type,
      role,
      before,
      after,
      toolName,
    );

    allCandidates.push(...candidates);
    totalCharsUsed += charsUsed;
    if (budgetHit) anyBudgetHit = true;

    // Enforce global candidate cap
    if (allCandidates.length >= DEFAULT_BUDGETS.maxCandidatesTotal) {
      allCandidates.length = DEFAULT_BUDGETS.maxCandidatesTotal;
      anyBudgetHit = true;
      break;
    }
  }

  // ── 2. Prefilter ──────────────────────────────────────────────────
  let filtered = prefilter(allCandidates, pq);

  // Keep highest prefilter scores if over total cap
  if (filtered.length > DEFAULT_BUDGETS.maxCandidatesTotal) {
    filtered.sort((a, b) => b.prefilterScore - a.prefilterScore);
    filtered = filtered.slice(0, DEFAULT_BUDGETS.maxCandidatesTotal);
    anyBudgetHit = true;
  }

  const prefuseTime = performance.now() - startTime;

  // ── 3. Check time budget (pre-Fuse early exit) ────────────────────
  if (prefuseTime > PREFUSE_BUDGET_MS) {
    // Time-budget degradation: skip Fuse.js, return prefilter-ranked
    const ranked = rankDegraded(filtered, pq, explain);
    const results = rankedToSearchResults(ranked, mode, explain, pq, width);
    return {
      results,
      total: results.length,
      degradeKind: "time",
      matchMode: mode,
    };
  }

  // ── 4. Populate stage-2 normalization for survivors ───────────────
  for (const { candidate } of filtered) {
    populateNormalized(candidate);
  }

  const fuseCandidates = filtered.map((f) => f.candidate);

  // ── 5. Run Fuse.js (no limit — we need accurate total count) ────
  const hits: FuseHit[] = fuseSearch(fuseCandidates, pq, mode);

  const totalTime = performance.now() - startTime;

  // ── 6. Rank ───────────────────────────────────────────────────────
  const ranked = rank(hits, pq, explain);
  const allResults = rankedToSearchResults(ranked, mode, explain, pq, width);

  // Check if total pipeline exceeded budget
  if (totalTime > TIME_BUDGET_MS) {
    return {
      results: allResults,
      total: allResults.length,
      degradeKind: "time",
      matchMode: mode,
    };
  }

  return {
    results: allResults,
    total: allResults.length,
    degradeKind: anyBudgetHit ? "budget" : "none",
    matchMode: mode,
  };
}

// ── Convert ranked results to SearchResult[] ─────────────────────────

function rankedToSearchResults(
  ranked: RankedResult[],
  mode: MatchMode,
  explain: boolean,
  query: ReturnType<typeof parseQuery>,
  width: number | undefined,
): SearchResult[] {
  return ranked.map((r) => {
    const c = r.candidate;

    // Always use smartSnippet which operates on raw text positions.
    // Fuse.js match ranges reference normalized fields and can't be
    // used directly against rawText without position mapping.
    const snip = smartSnippet(c.rawText, query, width);

    const result: SearchResult = {
      sessionID: c.sessionID,
      sessionTitle: c.sessionTitle,
      directory: c.directory,
      messageID: c.messageID,
      role: c.role,
      time: c.time,
      partID: c.partID,
      partType: c.partType,
      pruned: c.isPruned,
      snippet: snip,
      toolName: c.toolName,
      score: r.score,
      matchMode: mode,
      matchedTerms: r.matchedTerms,
    };

    if (explain && r.matchReasons.length > 0) {
      result.matchReasons = r.matchReasons;
    }

    return result;
  });
}

// ── Group results by session ─────────────────────────────────────────

function groupBySession(results: SearchResult[]): SearchResult[] {
  const groups = new Map<string, { best: SearchResult; count: number }>();

  for (const r of results) {
    const existing = groups.get(r.sessionID);
    if (!existing) {
      groups.set(r.sessionID, { best: r, count: 1 });
    } else {
      existing.count++;
      // Pick best representative:
      // - Smart/fuzzy: highest score wins
      // - Literal (no score): most recent time wins
      if (r.score != null && existing.best.score != null) {
        if (r.score > existing.best.score) {
          existing.best = r;
        }
      } else if (r.time > existing.best.time) {
        existing.best = r;
      }
    }
  }

  return [...groups.values()].map(({ best, count }) => ({
    ...best,
    hitCount: count,
  }));
}

function expandSearchResults(
  results: SearchResult[],
  loaded: Array<{ session: SessionMetaInternal; messages: MsgWithParts[] }>,
  mode: ExpandMode,
  expandResults: number,
  window: number,
): ExpandedResult[] | undefined {
  if (mode === "none") return undefined;

  const bySession = new Map(loaded.map((entry) => [entry.session.id, entry.messages]));
  const expanded: ExpandedResult[] = [];
  const budget: ExpansionBudget = { remaining: MAX_EXPANDED_TOTAL_TEXT_CHARS };
  const count = Math.min(expandResults, results.length);

  for (let resultIndex = 0; resultIndex < count; resultIndex++) {
    const result = results[resultIndex]!;
    const messages = bySession.get(result.sessionID);
    if (!messages) continue;

    const messageIndex = messages.findIndex((msg) => msg.info.id === result.messageID);
    if (messageIndex === -1) continue;

    if (mode === "message") {
      expanded.push({
        resultIndex,
        sessionID: result.sessionID,
        messageID: result.messageID,
        mode,
        message: formatExpandedMsg(messages[messageIndex]!, budget),
      });
      continue;
    }

    const start = Math.max(0, messageIndex - window);
    const end = Math.min(messages.length, messageIndex + window + 1);
    const slice = messages.slice(start, end);
    const items: MessageItem[] = slice.map((msg) => {
      const item = formatExpandedMsg(msg, budget);
      return { ...item, center: msg.info.id === result.messageID };
    });

    expanded.push({
      resultIndex,
      sessionID: result.sessionID,
      messageID: result.messageID,
      mode,
      messages: items,
      hasMoreBefore: start > 0,
      hasMoreAfter: end < messages.length,
    });
  }

  return expanded;
}

// ── Main export ──────────────────────────────────────────────────────

export function search(
  client: OpencodeClient,
  unscoped: OpencodeClient,
  global: boolean,
  limits: Limits,
): ToolDefinition {
  return tool({
    description: `Search prior opencode conversations by message/tool-output content. Primary history-discovery tool; prefer over recall_sessions for topical discovery (titles only).

Call when history could change the approach: debugging errors, investigating behavior, non-trivial feature work in areas with likely prior history, changing architecture/config, answering "last time/before", recovering commands/root causes/decisions, or checking if an approach worked or failed. Also call before substantive work in an unfamiliar area of this project.

Skip trivial commands, simple local code/file lookup, simple edits with full context, ordinary code tasks where prior history would not change the approach, or anything not helped by past conversations.

First call: for broad discovery use match:"smart", group:"session", scope:"global" (default), 5-10 results, and short terms from error text/feature/config/file/decision. Use role:"user" for requirements/decisions. Use expand:"context" or "message" when top-hit evidence will avoid a follow-up.

If memory exists, store only durable findings: preferences, project decisions, reusable root causes, environment facts, behavior corrections, or repeatable success/failure. Do not store ephemeral details, one-off commands, transient errors, or implementation minutiae.

Modes: literal exact substring; smart ranked fuzzy; fuzzy looser. Smart/fuzzy include score/matchedTerms and fall back to literal. Results are snippets; use recall_get/context for full content. loadErrorCount/loadErrors indicate partial session-load failures.`,
    args: {
      query: tool.schema.string().min(1).describe("Search text"),
      scope: tool.schema
        .enum(["session", "project", "global"])
        .default("global")
        .describe("global=all projects, project=current project, session=current only"),
      match: tool.schema
        .enum(["literal", "smart", "fuzzy"])
        .default("literal")
        .describe("literal=exact, smart=ranked fuzzy, fuzzy=looser"),
      explain: tool.schema.boolean().default(false).describe("Include matchReasons"),
      group: tool.schema
        .enum(["part", "session"])
        .default("part")
        .describe("part=per hit, session=one per session with hitCount"),
      sessionID: tool.schema.string().optional().describe("Specific session; overrides scope"),
      type: tool.schema
        .enum(["text", "tool", "reasoning", "all"])
        .default("all")
        .describe("Part type filter"),
      role: tool.schema.enum(["user", "assistant", "all"]).default("all").describe("Role filter"),
      sessions: tool.schema
        .number()
        .min(1)
        .max(limits.maxSessions)
        .default(Math.min(1000, limits.maxSessions))
        .describe("Max sessions to scan"),
      results: tool.schema
        .number()
        .min(1)
        .max(limits.maxResults)
        .default(Math.min(10, limits.maxResults))
        .describe("Max returned results"),
      title: tool.schema.string().optional().describe("Pre-filter by session title"),
      before: tool.schema.number().optional().describe("Only messages before ms epoch"),
      after: tool.schema.number().optional().describe("Only messages after ms epoch"),
      since: tool.schema.string().min(1).optional().describe("Newer-than filter: 2h, 7d, 3w"),
      until: tool.schema.string().min(1).optional().describe("Older-than filter: 2h, 7d, 3w"),
      directory: tool.schema.string().min(1).optional().describe("Exact or descendant session dir"),
      toolName: tool.schema.string().min(1).optional().describe("Exact tool name; tool parts only"),
      expand: tool.schema
        .enum(["none", "context", "message"])
        .default("none")
        .describe("Inline none/context/message"),
      expandResults: tool.schema
        .number()
        .int()
        .min(1)
        .max(MAX_EXPANDED_RESULTS)
        .default(1)
        .describe("Expanded result count"),
      window: tool.schema
        .number()
        .int()
        .min(0)
        .max(limits.maxWindow)
        .default(Math.min(3, limits.maxWindow))
        .describe("Context messages each side"),
      width: tool.schema
        .number()
        .min(50)
        .max(Math.max(limits.defaultWidth, 1000))
        .default(limits.defaultWidth)
        .describe("Snippet context chars"),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      const matchMode: MatchMode = args.match;
      const sessionID = optionalString(args.sessionID);
      const title = optionalString(args.title);
      const directory = optionalString(args.directory);
      const toolName = optionalString(args.toolName);
      const expandMode: ExpandMode = args.expand;
      const sessionListLimit = directory
        ? listLimitForDirectoryFilter(args.sessions, limits.maxSessions)
        : args.sessions;

      const fail = (error: string): string =>
        JSON.stringify({ ok: false, error } satisfies ErrorOutput);

      if (toolName && args.type !== "all" && args.type !== "tool") {
        return fail('toolName can only be used with type:"all" or type:"tool"');
      }

      let before = positiveTimestampOrUndefined(args.before);
      let after = positiveTimestampOrUndefined(args.after);
      try {
        const now = Date.now();
        const relativeAfter = parseRelativeTimestamp("since", args.since, now);
        const relativeBefore = parseRelativeTimestamp("until", args.until, now);

        if (after != null && relativeAfter != null) {
          return fail("after and since cannot both be positive filters");
        }
        if (before != null && relativeBefore != null) {
          return fail("before and until cannot both be positive filters");
        }

        after ??= relativeAfter;
        before ??= relativeBefore;
      } catch (e) {
        return fail(errmsg(e));
      }

      if (after != null && before != null && after >= before) {
        return fail("after/since must be older than before/until; check the time window");
      }

      if (
        expandMode === "context" &&
        args.expandResults * (2 * args.window + 1) > MAX_EXPANDED_CONTEXT_MESSAGES
      ) {
        return fail(
          `expand context is capped at ${MAX_EXPANDED_CONTEXT_MESSAGES} messages; reduce expandResults or window`,
        );
      }

      ctx.metadata({
        title: `Searching ${args.scope} for "${args.query}"${matchMode !== "literal" ? ` (${matchMode})` : ""}`,
      });

      if (args.scope === "global" && !sessionID && !global) {
        const err: ErrorOutput = {
          ok: false,
          error: "Global scope disabled via plugin option: global: false",
        };
        return JSON.stringify(err);
      }

      try {
        let targets: SessionMetaInternal[] = [];

        if (sessionID) {
          let title = "";
          let directory = "";
          try {
            const sess = await client.session.get({
              sessionID,
            });
            if (sess.data) {
              title = sess.data.title;
              directory = sess.data.directory;
            }
          } catch {
            // Can't get metadata, proceed anyway
          }
          targets = [{ id: sessionID, title, directory }];
        } else if (args.scope === "session") {
          if (!ctx.sessionID) {
            const err: ErrorOutput = {
              ok: false,
              error: "No sessionID provided and no current session available",
            };
            return JSON.stringify(err);
          }

          let title = "";
          let directory = "";
          try {
            const sess = await client.session.get({ sessionID: ctx.sessionID });
            if (sess.data) {
              title = sess.data.title;
              directory = sess.data.directory;
            }
          } catch {
            // proceed without metadata
          }
          targets = [{ id: ctx.sessionID, title, directory }];
        } else if (args.scope === "project") {
          const resp = await client.session.list({
            search: title,
            limit: sessionListLimit,
          });
          if (resp.error) {
            const err: ErrorOutput = {
              ok: false,
              error: `Failed to list sessions: ${errmsg(resp.error)}`,
            };
            return JSON.stringify(err);
          }
          if (resp.data) targets = resp.data.map(meta);
        } else {
          const resp = await unscoped.experimental.session.list({
            search: title,
            limit: sessionListLimit,
          });
          if (resp.error) {
            const err: ErrorOutput = {
              ok: false,
              error: `Failed to list sessions: ${errmsg(resp.error)}`,
            };
            return JSON.stringify(err);
          }
          if (resp.data) targets = resp.data.map(meta);
        }

        if (directory) {
          targets = targets
            .filter((target) => directoryMatches(target.directory, directory))
            .slice(0, args.sessions);
        }

        // ── Load messages ─────────────────────────────────────────────
        const allLoaded: Array<{
          session: SessionMetaInternal;
          messages: MsgWithParts[];
        }> = [];
        const loadErrors: string[] = [];
        let loadErrorCount = 0;
        let scanned = 0;

        for (let i = 0; i < targets.length; i += limits.concurrency) {
          if (ctx.abort.aborted) break;

          const batch = targets.slice(i, i + limits.concurrency);

          const loaded = await Promise.all(
            batch.map(async (t) => {
              try {
                const resp = await client.session.messages({
                  sessionID: t.id,
                });
                if (resp.error) {
                  loadErrorCount++;
                  if (loadErrors.length < MAX_LOAD_ERROR_SAMPLES) {
                    loadErrors.push(`${t.id}: ${errmsg(resp.error)}`);
                  }
                  return { session: t, messages: [] as MsgWithParts[] };
                }
                if (!resp.data) {
                  loadErrorCount++;
                  if (loadErrors.length < MAX_LOAD_ERROR_SAMPLES) {
                    loadErrors.push(`${t.id}: no messages returned`);
                  }
                  return { session: t, messages: [] as MsgWithParts[] };
                }
                return {
                  session: t,
                  messages: resp.data as MsgWithParts[],
                };
              } catch (e) {
                loadErrorCount++;
                if (loadErrors.length < MAX_LOAD_ERROR_SAMPLES) {
                  loadErrors.push(`${t.id}: ${errmsg(e)}`);
                }
                return { session: t, messages: [] as MsgWithParts[] };
              }
            }),
          );

          allLoaded.push(...loaded);
          scanned += batch.length;
        }

        if (ctx.abort.aborted) {
          const err: ErrorOutput = { ok: false, error: "aborted" };
          return JSON.stringify(err);
        }

        const groupMode: GroupMode = args.group;
        const isGrouped = groupMode === "session";
        const incomplete = loadErrorCount > 0;
        const loadErrorSuffix = incomplete
          ? `, ${loadErrorCount} load error${loadErrorCount !== 1 ? "s" : ""}`
          : "";
        const includeLoadErrors = <T extends SearchOutput>(out: T): T => {
          if (!incomplete) return out;
          out.loadErrorCount = loadErrorCount;
          out.loadErrors = [...loadErrors];
          return out;
        };
        const includeExpansion = <T extends SearchOutput>(out: T, final: SearchResult[]): T => {
          const expanded = expandSearchResults(
            final,
            allLoaded,
            expandMode,
            args.expandResults,
            args.window,
          );
          if (expanded) out.expanded = expanded;
          return out;
        };

        // ── Helper: run literal scan (full or limited) ───────────────
        const literalScan = (
          scanLimit: number,
        ): { collected: SearchResult[]; total: number; early: boolean } => {
          const collected: SearchResult[] = [];
          let total = 0;
          let early = false;

          for (const { session: sess, messages: msgs } of allLoaded) {
            if (collected.length >= scanLimit) {
              early = true;
              break;
            }
            const remaining = scanLimit - collected.length;
            const result = scan(
              msgs,
              sess,
              args.query,
              args.type,
              args.role,
              remaining,
              before,
              after,
              args.width,
              toolName,
            );
            collected.push(...result.results);
            total += result.total;
          }
          return { collected, total, early };
        };

        // ── Helper: apply grouping and slicing ───────────────────────
        const applyGroupAndSlice = (
          results: SearchResult[],
          partTotal: number,
          earlyExit: boolean,
        ): { final: SearchResult[]; total: number; truncated: boolean } => {
          if (isGrouped) {
            const grouped = groupBySession(results);
            const final = grouped.slice(0, args.results);
            return {
              final,
              total: grouped.length,
              truncated: earlyExit || grouped.length > final.length,
            };
          }
          const final = results.slice(0, args.results);
          return {
            final,
            total: partTotal,
            truncated: earlyExit || partTotal > final.length,
          };
        };

        // ── Route: literal or smart/fuzzy ─────────────────────────────
        if (matchMode === "literal") {
          // When grouping by session, scan all sessions (no early exit)
          // so we get representative hits from every matching session
          const limit = isGrouped ? MAX_GROUPED_LITERAL_RESULTS : args.results;
          const { collected, total, early } = literalScan(limit);
          const { final, total: outTotal, truncated } = applyGroupAndSlice(collected, total, early);

          const unit = isGrouped ? "session" : "result";
          ctx.metadata({
            title: `Found ${final.length} ${unit}${final.length !== 1 ? "s" : ""} for "${args.query}" (${scanned} session${scanned !== 1 ? "s" : ""} searched${loadErrorSuffix})`,
          });

          const out: SearchOutput = {
            ok: true,
            results: final,
            scanned,
            total: outTotal,
            truncated,
            group: groupMode,
          };
          return JSON.stringify(includeLoadErrors(includeExpansion(out, final)));
        }

        // ── Smart/fuzzy path ────────────────────────────────────────
        const smartResult = smartScan(
          allLoaded,
          args.query,
          args.type,
          args.role,
          args.explain,
          matchMode,
          before,
          after,
          args.width,
          toolName,
        );

        // ── Fallback to literal if smart returns nothing ────────────
        if (smartResult.results.length === 0) {
          const limit = isGrouped ? MAX_GROUPED_LITERAL_RESULTS : args.results;
          const { collected, total, early } = literalScan(limit);
          const { final, total: outTotal, truncated } = applyGroupAndSlice(collected, total, early);

          if (final.length > 0) {
            const unit = isGrouped ? "session" : "result";
            ctx.metadata({
              title: `Found ${final.length} ${unit}${final.length !== 1 ? "s" : ""} for "${args.query}" (literal fallback, ${scanned} session${scanned !== 1 ? "s" : ""}${loadErrorSuffix})`,
            });

            const out: SearchOutput = {
              ok: true,
              results: final,
              scanned,
              total: outTotal,
              truncated,
              matchMode: "literal",
              degradeKind: "fallback",
              group: groupMode,
            };
            return JSON.stringify(includeLoadErrors(includeExpansion(out, final)));
          }
        }

        // ── Return smart/fuzzy results ──────────────────────────────
        const {
          final,
          total: outTotal,
          truncated,
        } = applyGroupAndSlice(smartResult.results, smartResult.total, false);

        const unit = isGrouped ? "session" : "result";
        ctx.metadata({
          title: `Found ${final.length} ${unit}${final.length !== 1 ? "s" : ""} for "${args.query}" (${matchMode}, ${scanned} session${scanned !== 1 ? "s" : ""}${loadErrorSuffix})`,
        });

        const out: SearchOutput = {
          ok: true,
          results: final,
          scanned,
          total: outTotal,
          truncated,
          matchMode: smartResult.matchMode,
          degradeKind: smartResult.degradeKind,
          group: groupMode,
        };
        return JSON.stringify(includeLoadErrors(includeExpansion(out, final)));
      } catch (e) {
        const err: ErrorOutput = { ok: false, error: errmsg(e) };
        return JSON.stringify(err);
      }
    },
  });
}
