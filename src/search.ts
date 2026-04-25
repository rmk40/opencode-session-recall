import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin";
import type { OpencodeClient, Session, GlobalSession, Part } from "@opencode-ai/sdk/v2";
import {
  errmsg,
  optionalString,
  type SearchResult,
  type SearchOutput,
  type ErrorOutput,
  type Limits,
  type MatchMode,
  type DegradeKind,
  type GroupMode,
} from "./types.js";
import { searchable, snippet, pruned, matches } from "./extract.js";
import { parseQuery } from "./query.js";
import {
  buildCandidates,
  populateNormalized,
  DEFAULT_BUDGETS,
  type MsgInfo,
} from "./candidates.js";
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

// ── Types ────────────────────────────────────────────────────────────

type MsgWithParts = {
  info: MsgInfo;
  parts: Array<Part>;
};

type SessionMetaInternal = { id: string; title: string; directory: string };

function meta(s: Session | GlobalSession): SessionMetaInternal {
  return { id: s.id, title: s.title, directory: s.directory };
}

function positiveTimestampOrUndefined(value: number | undefined): number | undefined {
  return value != null && value > 0 ? value : undefined;
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
      if (type !== "all" && part.type !== type) continue;

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

// ── Main export ──────────────────────────────────────────────────────

export function search(
  client: OpencodeClient,
  unscoped: OpencodeClient,
  global: boolean,
  limits: Limits,
): ToolDefinition {
  return tool({
    description: `Search your conversation history in the opencode database. This is the primary discovery tool — use it before recall_sessions, which only searches titles. Before debugging an issue or implementing a feature, check whether prior sessions already tackled it — the history shows whether an approach succeeded or was abandoned. If you have access to a memory system, add useful findings to memory so they're available directly next time without searching history.

Supports three matching strategies via the \`match\` parameter:
- "literal" (default): case-insensitive substring matching. Works across all scopes. Fast and predictable.
- "smart": fuzzy ranked search using Fuse.js. Handles typos, separator differences (rate-limit vs rateLimit), and ranks results by relevance. Works across all scopes.
- "fuzzy": looser fuzzy search with a higher match threshold. Works across all scopes.

When using smart or fuzzy, results include a relevance \`score\` (0-1, higher is better) and \`matchedTerms\`. Add \`explain: true\` for detailed scoring breakdowns via \`matchReasons\`. If smart/fuzzy finds no matches, it automatically falls back to literal search.

Use \`group: "session"\` to collapse results by session — returns one entry per session with the best-scoring hit as representative (or most recent for literal), plus a \`hitCount\` showing how many part-level hits that session had. Useful for cross-project discovery: "which sessions are about this topic?"

Searches globally by default — this is fast and finds results across all projects. Results are ordered by session recency (newest first) for literal, or by relevance score for smart/fuzzy. Try multiple query terms before concluding no prior work exists. Use role "user" to find original requirements.

Scope costs: all scopes scan up to \`sessions\` sessions (default 1000). "session" scans 1. Reduce \`sessions\` for faster searches if needed.

Returns { ok, results: [{ sessionID, messageID, role, time, partID, partType, pruned, snippet, toolName? }], scanned, total, truncated }. If some sessions could not be loaded, the response includes loadErrorCount and loadErrors so transport failures are not confused with no matches. Each result includes a pruned flag — if true, the content was compacted from your context window and recall_get will return the original full output. Check truncated to know if more matches exist beyond your results limit.

This tool's own outputs are excluded from search results to prevent recursive noise; use recall_get or recall_context to retrieve any message directly.`,
    args: {
      query: tool.schema
        .string()
        .min(1)
        .describe("Text to search for (case-insensitive substring match)"),
      scope: tool.schema
        .enum(["session", "project", "global"])
        .default("global")
        .describe(
          "global = all projects (default), project = current project, session = current only. Searching broadly is fast.",
        ),
      match: tool.schema
        .enum(["literal", "smart", "fuzzy"])
        .default("literal")
        .describe(
          'Matching strategy: "literal" = exact substring (default), "smart" = fuzzy ranked search, "fuzzy" = looser fuzzy search. All work across all scopes.',
        ),
      explain: tool.schema
        .boolean()
        .default(false)
        .describe("Return scoring metadata for debugging. Adds matchReasons to each result."),
      group: tool.schema
        .enum(["part", "session"])
        .default("part")
        .describe(
          '"part" (default) = one result per matching part. "session" = collapse by session, returning one entry per session with best-scoring (smart/fuzzy) or most-recent (literal) hit and a hitCount.',
        ),
      sessionID: tool.schema
        .string()
        .optional()
        .describe("Search a specific session (overrides scope)"),
      type: tool.schema
        .enum(["text", "tool", "reasoning", "all"])
        .default("all")
        .describe("Filter by part type"),
      role: tool.schema
        .enum(["user", "assistant", "all"])
        .default("all")
        .describe("Filter by message role"),
      sessions: tool.schema
        .number()
        .min(1)
        .max(limits.maxSessions)
        .default(Math.min(1000, limits.maxSessions))
        .describe(
          "Max sessions to scan. Default 1000 covers deep history. Reduce for faster searches if needed.",
        ),
      results: tool.schema
        .number()
        .min(1)
        .max(limits.maxResults)
        .default(Math.min(10, limits.maxResults))
        .describe("Max results to return. Check truncated in response for more."),
      title: tool.schema
        .string()
        .optional()
        .describe(
          "Filter sessions by title before scanning (rarely useful — titles are usually auto-generated)",
        ),
      before: tool.schema
        .number()
        .optional()
        .describe("Only match messages before this timestamp (ms epoch)"),
      after: tool.schema
        .number()
        .optional()
        .describe("Only match messages after this timestamp (ms epoch)"),
      width: tool.schema
        .number()
        .min(50)
        .max(Math.max(limits.defaultWidth, 1000))
        .default(limits.defaultWidth)
        .describe(
          "Characters of context around each match in the returned snippet. Only a snippet is returned — use recall_get for full content.",
        ),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      const matchMode: MatchMode = args.match;
      const sessionID = optionalString(args.sessionID);
      const title = optionalString(args.title);
      const before = positiveTimestampOrUndefined(args.before);
      const after = positiveTimestampOrUndefined(args.after);

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
            limit: args.sessions,
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
            limit: args.sessions,
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
          return JSON.stringify(includeLoadErrors(out));
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
            return JSON.stringify(includeLoadErrors(out));
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
        return JSON.stringify(includeLoadErrors(out));
      } catch (e) {
        const err: ErrorOutput = { ok: false, error: errmsg(e) };
        return JSON.stringify(err);
      }
    },
  });
}
