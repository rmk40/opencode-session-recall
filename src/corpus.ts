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
import { normalize, tokenize } from "./normalize.js";
import { toolNameMatches } from "./extract.js";
import { DIGEST_HEAD_CHARS, isDigestToken } from "./digest.js";

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

/**
 * The narrow slice of the semantic embedder the cache needs. `ready` is read
 * per fetch (never awaited): an unready embedder simply leaves candidates
 * unembedded, so searches stay lexical-only until the model warms up and the
 * session is next re-fetched (a version bump or eviction+re-fetch).
 */
export type CandidateEmbedder = {
  ready: boolean;
  embed(text: string): Float32Array | undefined;
};

type MsgWithParts = { info: Message; parts: Part[] };

export type CachedSession = {
  meta: CorpusSessionMeta;
  /** Unfiltered candidates, newest message first, normalized fields populated. */
  candidates: Candidate[];
  /** Content-derived session digest (may be empty); see buildSessionDigest. */
  digestText: string;
  /** Candidate embeddings were computed (or no embedder is configured). */
  embedded: boolean;
  messageCount: number;
  charCount: number;
  lastAccess: number;
};

export type SyncedSession = {
  meta: CorpusSessionMeta;
  candidates: Candidate[];
  digestText: string;
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

// ── Session digest ────────────────────────────────────────────────────
// The first session-level text derived from CONTENT rather than naming luck
// (fixes the misleading-title finding): the first user message's head plus
// the session's characteristic action vocabulary. Built only from statement
// and action evidence (text/subtask parts, tool command/cwd inputs) so a
// session that merely READ about a topic gets no digest credit for it.

const DIGEST_TOP_TOKENS = 8;

/**
 * Deterministic content digest for a session. Deviates deliberately from the
 * plan's "rarest by corpus document frequency" sketch: cross-session DF is
 * unstable while the cache fills incrementally, so rarity is approximated by
 * in-session frequency over stopworded statement/action tokens — stable per
 * session version, and it credits sessions for what they SAID and DID, never
 * for what they read.
 */
export function buildSessionDigest(candidates: Candidate[]): string {
  const counts = new Map<string, number>();
  let firstUserText: Candidate | undefined;

  for (const candidate of candidates) {
    const isStatement = candidate.partType === "text" || candidate.partType === "subtask";
    if (isStatement && candidate.role === "user") {
      // Candidates are newest-first; the last matching one is the earliest.
      firstUserText = candidate;
    }
    if (isStatement) {
      for (const token of candidate.tokens) {
        if (!isDigestToken(token)) continue;
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
      continue;
    }
    if (candidate.partType === "tool") {
      // Generated-reference tools (file reads, skill loads) earn no digest
      // credit: a session that merely read about a topic must not carry its
      // vocabulary as session identity.
      if (
        candidate.toolName &&
        (toolNameMatches(candidate.toolName, "read") ||
          toolNameMatches(candidate.toolName, "skill"))
      ) {
        continue;
      }
      for (const field of candidate.fieldTexts) {
        if (field.field !== "command" && field.field !== "cwd") continue;
        // toolInputTexts also files the whole JSON input under "command";
        // only true command/cwd strings describe an action.
        if (field.text.startsWith("{")) continue;
        for (const token of tokenize(field.text)) {
          if (!isDigestToken(token)) continue;
          counts.set(token, (counts.get(token) ?? 0) + 1);
        }
      }
    }
  }

  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, DIGEST_TOP_TOKENS)
    .map(([token]) => token);

  const head = firstUserText ? firstUserText.rawText.slice(0, DIGEST_HEAD_CHARS) : "";
  return [head, top.join(" ")].filter(Boolean).join(" ").trim();
}

export type AssembledSession = {
  meta: CorpusSessionMeta;
  /** Eligible content candidates under this query's filters, newest first. */
  candidates: Candidate[];
  /** Bound title candidate, when title search applies and a representative exists. */
  titleCandidate?: Candidate;
  /** Content-derived session digest (may be empty). */
  digestText: string;
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
      if (titleCandidate) {
        populateNormalized(titleCandidate);
        titleCandidate.digestText = synced.digestText ? normalize(synced.digestText) : "";
      }
    }
  }

  const messageIDs = new Set<string>();
  for (const candidate of eligible) messageIDs.add(candidate.messageID);

  return {
    meta: synced.meta,
    candidates: eligible,
    titleCandidate,
    digestText: synced.digestText,
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
    private readonly embedder?: CandidateEmbedder,
  ) {}

  /** Read-only digest lookup for already-cached sessions (no fetch, no pin).
   *  Used by recall_sessions as a best-effort browse aid. */
  peekDigest(id: string): string | undefined {
    const entry = this.sessions.get(id);
    return entry?.digestText ? entry.digestText : undefined;
  }

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
            digestText: "",
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
        this.ensureEmbeddings(existing);
        return {
          meta: existing.meta,
          candidates: existing.candidates,
          digestText: existing.digestText,
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
        digestText: result.entry.digestText,
        messageCount: result.entry.messageCount,
      };
    }
    return {
      meta: target,
      candidates: [],
      digestText: "",
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

      // Session digest: computed once per session version, stamped onto every
      // candidate as a normalized BM25 field so content-derived session
      // identity participates in ranking (and in Stage A shortlisting).
      const digestText = buildSessionDigest(candidates);
      const normalizedDigest = digestText ? normalize(digestText) : "";
      for (const candidate of candidates) candidate.digestText = normalizedDigest;

      const entry: CachedSession = {
        meta: { ...target },
        candidates,
        digestText,
        embedded: false,
        messageCount: messages.length,
        charCount: charsUsed,
        lastAccess: ++this.clock,
      };
      // Opt-in semantic layer: embed once per session version, amortized like
      // tokenization. A cold embedder leaves the entry unembedded; the
      // cache-hit path retries once the model warms (see ensureEmbeddings),
      // so a corpus filled during warmup is not permanently lexical.
      // Embeddings are deliberately NOT counted toward charCount.
      this.ensureEmbeddings(entry);

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

  /** Embed a cached entry's candidates once the embedder is ready. Runs at
   *  most once per entry (the embedded flag), so sessions cached while the
   *  model was still loading pick up embeddings on their next cache hit
   *  instead of staying lexical until eviction or a version bump. */
  private ensureEmbeddings(entry: CachedSession): void {
    if (entry.embedded) return;
    if (!this.embedder) {
      entry.embedded = true;
      return;
    }
    if (!this.embedder.ready) return;
    for (const candidate of entry.candidates) {
      candidate.embedding = this.embedder.embed(candidate.rawText);
    }
    entry.embedded = true;
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
