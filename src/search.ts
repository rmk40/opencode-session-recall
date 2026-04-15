import {
  tool,
  type ToolDefinition,
  type ToolContext,
} from "@opencode-ai/plugin";
import type {
  OpencodeClient,
  Session,
  GlobalSession,
  Part,
} from "@opencode-ai/sdk/v2";
import {
  errmsg,
  type SearchResult,
  type SearchOutput,
  type ErrorOutput,
  type Limits,
  type MatchMode,
  type DegradeKind,
} from "./types.js";
import { searchable, snippet, pruned, matches } from "./extract.js";
import { parseQuery } from "./query.js";
import {
  buildCandidates,
  populateNormalized,
  DEFAULT_BUDGETS,
  type SessionMeta,
  type MsgInfo,
} from "./candidates.js";
import { prefilter } from "./prefilter.js";
import { fuseSearch, type FuseHit } from "./fuse.js";
import { rank, rankDegraded, type RankedResult } from "./rank.js";
import { smartSnippet } from "./snippet.js";

// ── Promoted scopes for smart/fuzzy mode ─────────────────────────────

/** Scopes where smart/fuzzy is allowed. Expand as benchmarked. */
const PROMOTED_SCOPES = new Set(["session"]);

/** Post-fetch time budget for the entire ranking pipeline (ms) */
const TIME_BUDGET_MS = 2000;

/** Pre-Fuse.js early-exit threshold (ms). Skip Fuse if prefilter alone takes this long. */
const PREFUSE_BUDGET_MS = 1500;

// ── Types ────────────────────────────────────────────────────────────

type MsgWithParts = {
  info: MsgInfo;
  parts: Array<Part>;
};

type SessionMetaInternal = { id: string; title: string; directory: string };

function meta(s: Session | GlobalSession): SessionMetaInternal {
  return { id: s.id, title: s.title, directory: s.directory };
}

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

function smartScan(
  allMessages: Array<{
    session: SessionMetaInternal;
    messages: MsgWithParts[];
  }>,
  query: string,
  type: string,
  role: string,
  limit: number,
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
  const allCandidates: Array<
    ReturnType<typeof buildCandidates>["candidates"][number]
  > = [];
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

  // Keep highest prefilter scores if over per-session or total cap
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
    const results = rankedToSearchResults(
      ranked.slice(0, limit),
      mode,
      explain,
      pq,
      width,
    );
    return {
      results,
      total: filtered.length,
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
  // Always use fuseSearch. Explain mode adds matchReasons from rank(),
  // not from Fuse.js match ranges (which reference normalized fields,
  // not raw text).
  const hits: FuseHit[] = fuseSearch(fuseCandidates, pq, mode);

  const totalTime = performance.now() - startTime;

  // ── 6. Rank ───────────────────────────────────────────────────────
  const ranked = rank(hits, pq, explain);
  const fuseTotal = ranked.length;

  // Check if total pipeline exceeded budget
  if (totalTime > TIME_BUDGET_MS) {
    // Still return what we have, but mark as time-degraded
    const results = rankedToSearchResults(
      ranked.slice(0, limit),
      mode,
      explain,
      pq,
      width,
    );
    return {
      results,
      total: fuseTotal,
      degradeKind: "time",
      matchMode: mode,
    };
  }

  const results = rankedToSearchResults(
    ranked.slice(0, limit),
    mode,
    explain,
    pq,
    width,
  );

  return {
    results,
    total: fuseTotal,
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

// ── Main export ──────────────────────────────────────────────────────

export function search(
  client: OpencodeClient,
  unscoped: OpencodeClient,
  global: boolean,
  limits: Limits,
): ToolDefinition {
  return tool({
    description: `Search your conversation history in the opencode database. This is the primary discovery tool — use it before recall_sessions, which only searches titles. Before debugging an issue or implementing a feature, check whether prior sessions already tackled it — the history shows whether an approach succeeded or was abandoned. If you have access to a memory system, add useful findings to memory so they're available directly next time without searching history.

Searches text content, tool inputs/outputs, and reasoning via case-insensitive substring matching. Returns matching snippets with session/message IDs you can pass to recall_get for full content, or recall_context if you need surrounding messages.

Searches globally by default — this is fast and finds results across all projects. Results are ordered by session recency (newest first). Try multiple query terms before concluding no prior work exists. Use role "user" to find original requirements.

Scope costs: all scopes scan up to \`sessions\` sessions (default 10). "session" scans 1. "project" and "global" scan up to 10 newest. Increase \`sessions\` if nothing found.

Returns { ok, results: [{ sessionID, messageID, role, time, partID, partType, pruned, snippet, toolName? }], scanned, total, truncated }. Each result includes a pruned flag — if true, the content was compacted from your context window and recall_get will return the original full output. Check truncated to know if more matches exist beyond your results limit.

This tool's own outputs are excluded from search results to prevent recursive noise; use recall_get or recall_context to retrieve any message directly.

Use match:"smart" for fuzzy search when exact wording is uncertain — it handles typos, separator differences (rate-limit vs rateLimit), and ranks results by relevance. Currently available for scope:"session" only.`,
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
          'Matching strategy: "literal" = exact substring (default), "smart" = fuzzy ranked search (session scope only), "fuzzy" = looser fuzzy search (session scope only)',
        ),
      explain: tool.schema
        .boolean()
        .default(false)
        .describe(
          "Return scoring metadata for debugging. Adds matchReasons to each result.",
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
        .default(Math.min(10, limits.maxSessions))
        .describe(
          "Max sessions to scan. Increase if nothing found — default 10 may miss older sessions.",
        ),
      results: tool.schema
        .number()
        .min(1)
        .max(limits.maxResults)
        .default(Math.min(10, limits.maxResults))
        .describe(
          "Max results to return. Check truncated in response for more.",
        ),
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

      ctx.metadata({
        title: `Searching ${args.scope} for "${args.query}"${matchMode !== "literal" ? ` (${matchMode})` : ""}`,
      });

      // ── Scope guard for smart/fuzzy ─────────────────────────────────
      if (matchMode !== "literal") {
        const effectiveScope = args.sessionID ? "session" : args.scope;
        if (!PROMOTED_SCOPES.has(effectiveScope)) {
          const err: ErrorOutput = {
            ok: false,
            error: `match:"${matchMode}" is not yet available for scope:"${effectiveScope}". Try scope:"session" or use match:"literal" for broader searches.`,
          };
          return JSON.stringify(err);
        }
      }

      if (args.scope === "global" && !args.sessionID && !global) {
        const err: ErrorOutput = {
          ok: false,
          error: "Global scope disabled via plugin option: global: false",
        };
        return JSON.stringify(err);
      }

      try {
        let targets: SessionMetaInternal[] = [];

        if (args.sessionID) {
          let title = "";
          let directory = "";
          try {
            const sess = await client.session.get({
              sessionID: args.sessionID,
            });
            if (sess.data) {
              title = sess.data.title;
              directory = sess.data.directory;
            }
          } catch {
            // Can't get metadata, proceed anyway
          }
          targets = [{ id: args.sessionID, title, directory }];
        } else if (args.scope === "session") {
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
            search: args.title,
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
            search: args.title,
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
                return {
                  session: t,
                  messages: (resp.data ?? []) as MsgWithParts[],
                };
              } catch {
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

        // ── Route: literal or smart/fuzzy ─────────────────────────────
        if (matchMode === "literal") {
          // Original literal path
          const collected: SearchResult[] = [];
          let total = 0;
          let early = false;

          for (const { session: sess, messages: msgs } of allLoaded) {
            if (collected.length >= args.results) {
              early = true;
              break;
            }
            const remaining = args.results - collected.length;
            const result = scan(
              msgs,
              sess,
              args.query,
              args.type,
              args.role,
              remaining,
              args.before,
              args.after,
              args.width,
            );
            collected.push(...result.results);
            total += result.total;
          }

          const final = collected.slice(0, args.results);

          ctx.metadata({
            title: `Found ${final.length} result${final.length !== 1 ? "s" : ""} for "${args.query}" (${scanned} session${scanned !== 1 ? "s" : ""} searched)`,
          });

          const out: SearchOutput = {
            ok: true,
            results: final,
            scanned,
            total,
            truncated: early || total > final.length,
          };
          return JSON.stringify(out);
        }

        // ── Smart/fuzzy path ────────────────────────────────────────
        const smartResult = smartScan(
          allLoaded,
          args.query,
          args.type,
          args.role,
          args.results,
          args.explain,
          matchMode,
          args.before,
          args.after,
          args.width,
        );

        // ── Fallback to literal if smart returns nothing ────────────
        if (smartResult.results.length === 0) {
          // Try literal fallback
          const collected: SearchResult[] = [];
          let total = 0;
          let early = false;

          for (const { session: sess, messages: msgs } of allLoaded) {
            if (collected.length >= args.results) {
              early = true;
              break;
            }
            const remaining = args.results - collected.length;
            const result = scan(
              msgs,
              sess,
              args.query,
              args.type,
              args.role,
              remaining,
              args.before,
              args.after,
              args.width,
            );
            collected.push(...result.results);
            total += result.total;
          }

          const final = collected.slice(0, args.results);

          if (final.length > 0) {
            ctx.metadata({
              title: `Found ${final.length} result${final.length !== 1 ? "s" : ""} for "${args.query}" (literal fallback, ${scanned} session${scanned !== 1 ? "s" : ""})`,
            });

            const out: SearchOutput = {
              ok: true,
              results: final,
              scanned,
              total,
              truncated: early || total > final.length,
              matchMode: "literal",
              degradeKind: "fallback",
            };
            return JSON.stringify(out);
          }
        }

        // ── Return smart/fuzzy results ──────────────────────────────
        ctx.metadata({
          title: `Found ${smartResult.results.length} result${smartResult.results.length !== 1 ? "s" : ""} for "${args.query}" (${matchMode}, ${scanned} session${scanned !== 1 ? "s" : ""})`,
        });

        const out: SearchOutput = {
          ok: true,
          results: smartResult.results,
          scanned,
          total: smartResult.total,
          truncated: smartResult.total > smartResult.results.length,
          matchMode: smartResult.matchMode,
          degradeKind: smartResult.degradeKind,
        };
        return JSON.stringify(out);
      } catch (e) {
        const err: ErrorOutput = { ok: false, error: errmsg(e) };
        return JSON.stringify(err);
      }
    },
  });
}
