import type { OpencodeClient, Message, Part } from "@opencode-ai/sdk/v2";
import { errmsg, type Limits } from "./types.js";
import {
  buildCandidates,
  buildTitleCandidate,
  candidateEligible,
  populateNormalized,
  type Candidate,
  type CandidateFilters,
} from "./candidates.js";

/**
 * Incremental in-memory corpus cache.
 *
 * OpenCode's database is the sole source of truth; this cache is a derived
 * performance layer. Each session's searchable candidates are built once per
 * session version (keyed by `time.updated`) instead of on every query, which
 * removes the per-query fetch/tokenize cost that used to force candidate
 * budgets and scan-order truncation. Correctness rules:
 *
 * - An unknown `updated` (<= 0, e.g. a failed session.get for an explicit
 *   target) means "cannot validate": the session is fetched fresh for that
 *   query and the result is NOT stored, so a stale entry can never be pinned
 *   alive by repeated metadata failures.
 * - LRU eviction (by last access) only ever evicts fully synced, unpinned
 *   sessions. Sessions belonging to an in-flight sync are pinned until that
 *   sync's caller finishes, so eviction can shrink only latency, never a
 *   running query's coverage. `release()` unpins.
 * - Concurrent syncs of the same session share one fetch.
 */

export type CorpusSessionMeta = {
  id: string;
  title: string;
  directory: string;
  updated: number;
};

type MsgWithParts = { info: Message; parts: Part[] };

export type CachedSession = {
  meta: CorpusSessionMeta;
  /** Unfiltered candidates, newest message first, normalized fields populated. */
  candidates: Candidate[];
  messageCount: number;
  charCount: number;
  lastAccess: number;
};

export type SyncedSession = {
  meta: CorpusSessionMeta;
  candidates: Candidate[];
  messageCount: number;
  /** Message load/build failed for this session this query. */
  loadError?: string;
};

export type SyncResult = {
  /** One entry per target, in target order. Failed loads have empty candidates. */
  sessions: SyncedSession[];
  loadErrors: string[];
  loadErrorCount: number;
  /** Call when the query is done with the synced sessions (unpins them). */
  release: () => void;
};

type FetchResult = { entry?: CachedSession; error?: string };

/** Cap sample size only; loadErrorCount still reports all failures. */
const MAX_LOAD_ERROR_SAMPLES = 5;

export type AssembledSession = {
  meta: CorpusSessionMeta;
  /** Eligible content candidates under this query's filters, newest first. */
  candidates: Candidate[];
  /** Bound title candidate, when title search applies and a representative exists. */
  titleCandidate?: Candidate;
  messagesSearched: number;
  partsSearched: number;
  loadError?: string;
};

/**
 * Apply a query's filters to a synced session and bind its title candidate.
 * The title candidate's representative identity is the newest eligible
 * content CANDIDATE — a deliberate refinement of the old message-based
 * findRepresentativeMessage: a session whose messages are all filtered out
 * yields no title hit (as before), a session whose newest eligible message
 * has no searchable parts binds to the newest message that does (new), and a
 * session with zero searchable parts loses its title hit entirely (new;
 * there is nothing to inspect behind such a hit anyway).
 */
export function assembleSession(
  synced: SyncedSession,
  filters: CandidateFilters,
  searchTitles: boolean,
): AssembledSession {
  const eligible =
    synced.candidates.length > 0
      ? synced.candidates.filter((candidate) => candidateEligible(candidate, filters))
      : synced.candidates;

  let titleCandidate: Candidate | undefined;
  if (searchTitles && synced.meta.title.trim()) {
    const representative = eligible[0];
    if (representative) {
      titleCandidate = buildTitleCandidate(
        { id: synced.meta.id, title: synced.meta.title, directory: synced.meta.directory },
        {
          id: representative.messageID,
          role: representative.role,
          time: { created: representative.time },
        },
      );
      if (titleCandidate) populateNormalized(titleCandidate);
    }
  }

  const messageIDs = new Set<string>();
  for (const candidate of eligible) messageIDs.add(candidate.messageID);

  return {
    meta: synced.meta,
    candidates: eligible,
    titleCandidate,
    messagesSearched: messageIDs.size,
    partsSearched: eligible.length,
    loadError: synced.loadError,
  };
}

export class CorpusCache {
  private readonly sessions = new Map<string, CachedSession>();
  private readonly inFlight = new Map<string, Promise<FetchResult>>();
  private readonly pins = new Map<string, number>();
  private totalChars = 0;
  private clock = 0;

  constructor(
    private readonly client: OpencodeClient,
    private readonly limits: Limits,
  ) {}

  stats(): { sessions: number; candidates: number; chars: number } {
    let candidates = 0;
    for (const entry of this.sessions.values()) candidates += entry.candidates.length;
    return { sessions: this.sessions.size, candidates, chars: this.totalChars };
  }

  /**
   * Ensure every target session is present at its current version and return
   * the synced entries in target order. Fetches only changed/missing/unknown
   * sessions, batched by `limits.concurrency`. The caller MUST call the
   * returned `release()` when done (typically in a finally block) so the
   * synced sessions become evictable again.
   */
  async sync(targets: CorpusSessionMeta[], abort?: AbortSignal): Promise<SyncResult> {
    const loadErrors: string[] = [];
    let loadErrorCount = 0;
    const recordError = (message: string): void => {
      loadErrorCount++;
      if (loadErrors.length < MAX_LOAD_ERROR_SAMPLES) loadErrors.push(message);
    };

    for (const target of targets) this.pin(target.id);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      for (const target of targets) this.unpin(target.id);
      this.evict();
    };

    try {
      const resolved = new Map<string, SyncedSession>();
      for (let i = 0; i < targets.length; i += this.limits.concurrency) {
        if (abort?.aborted) break;
        const batch = targets.slice(i, i + this.limits.concurrency);
        await Promise.all(
          batch.map(async (target) => {
            const synced = await this.syncOne(target);
            if (synced.loadError) recordError(`${target.id}: ${synced.loadError}`);
            resolved.set(target.id, synced);
          }),
        );
      }

      const sessions = targets.map(
        (target) =>
          resolved.get(target.id) ?? {
            meta: target,
            candidates: [],
            messageCount: 0,
          },
      );
      this.evict();
      return { sessions, loadErrors, loadErrorCount, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private async syncOne(target: CorpusSessionMeta): Promise<SyncedSession> {
    const knownVersion = target.updated > 0;
    if (knownVersion) {
      const existing = this.sessions.get(target.id);
      if (existing && existing.meta.updated === target.updated) {
        existing.lastAccess = ++this.clock;
        return {
          meta: existing.meta,
          candidates: existing.candidates,
          messageCount: existing.messageCount,
        };
      }
    }

    // Dedupe key includes the version: two concurrent syncs that saw
    // different `updated` values for the same session must not share a fetch,
    // or the shared entry would be stored under the older version label and
    // the newer caller's version check silently skipped. Same-version callers
    // still share one fetch.
    const inFlightKey = `${target.id}:${target.updated}`;
    let pending = this.inFlight.get(inFlightKey);
    if (!pending) {
      pending = this.fetch(target).finally(() => this.inFlight.delete(inFlightKey));
      this.inFlight.set(inFlightKey, pending);
    }
    const result = await pending;
    if (result.entry) {
      return {
        meta: result.entry.meta,
        candidates: result.entry.candidates,
        messageCount: result.entry.messageCount,
      };
    }
    return {
      meta: target,
      candidates: [],
      messageCount: 0,
      loadError: result.error ?? "unknown load failure",
    };
  }

  private async fetch(target: CorpusSessionMeta): Promise<FetchResult> {
    try {
      const resp = await this.client.session.messages({ sessionID: target.id });
      if (resp.error) return { error: errmsg(resp.error) };
      if (!resp.data) return { error: "no messages returned" };

      const messages = resp.data as MsgWithParts[];
      const { candidates, charsUsed } = buildCandidates(messages, {
        id: target.id,
        title: target.title,
        directory: target.directory,
      });
      for (const candidate of candidates) populateNormalized(candidate);

      const entry: CachedSession = {
        meta: { ...target },
        candidates,
        messageCount: messages.length,
        charCount: charsUsed,
        lastAccess: ++this.clock,
      };

      // Unknown version: usable for this query, never stored — a stale key of
      // 0 must not shadow future syncs or survive as unevictable state.
      if (!(target.updated > 0)) return { entry };

      const previous = this.sessions.get(target.id);
      if (previous) this.totalChars -= previous.charCount;
      this.sessions.set(target.id, entry);
      this.totalChars += entry.charCount;
      return { entry };
    } catch (error) {
      return { error: errmsg(error) };
    }
  }

  private pin(id: string): void {
    this.pins.set(id, (this.pins.get(id) ?? 0) + 1);
  }

  private unpin(id: string): void {
    const count = this.pins.get(id);
    if (count == null) return;
    if (count <= 1) this.pins.delete(id);
    else this.pins.set(id, count - 1);
  }

  private evict(): void {
    if (this.totalChars <= this.limits.cacheMaxChars) return;
    const byAge = [...this.sessions.values()].sort((a, b) => a.lastAccess - b.lastAccess);
    for (const entry of byAge) {
      if (this.totalChars <= this.limits.cacheMaxChars) return;
      if ((this.pins.get(entry.meta.id) ?? 0) > 0) continue;
      this.sessions.delete(entry.meta.id);
      this.totalChars -= entry.charCount;
    }
  }
}
