import type { OpencodeClient, Part, PermissionRuleset, Session } from "@opencode-ai/sdk/v2";
import type { Card, Store } from "./store.js";
import { SUMMARY_REV_KEY } from "./store.js";
import type { FetchGate } from "./fetch-gate.js";
import { errmsg, settleWithin } from "./types.js";
import { tokenizeAll } from "./normalize.js";
import { SUMMARIZER_SENTINEL, isSummarizerTitle } from "./extract.js";

/**
 * Path B: LLM-written card summaries via a worker-session summarizer.
 *
 * No completion endpoint exists in the SDK or server, so the only way to invoke a
 * model is `session.prompt`. This creates a throwaway worker session per batch
 * (title sentinel {@link SUMMARIZER_SENTINEL}, excluded everywhere it matters),
 * renders ~15 cards as an opaque-keyed JSON array with a strict-JSON system
 * prompt and all tools disabled, and maps the reply back positionally. Opt-in and
 * off by default: it spends the user's tokens.
 *
 * All summary work (cold pass and idle-debounce re-summaries) funnels into ONE
 * serialized drain queue: at most one prompt runs at a time, a per-session
 * single-flight guard prevents double-summarizing, a shared per-pass prompt
 * budget and a consecutive-failure latch bound the spend across both paths, a
 * content-hash gate (folding in the prompt-template version {@link SUMMARY_REV})
 * skips unchanged cards, and a per-prompt timeout aborts a stuck generation.
 * Lease-holder only: the distiller drives it after the cold pass and on the
 * re-distill idle path, both while holding the lease.
 */

/** Prompt-template version. Bump when the rendering or system prompt changes so
 *  every card re-summarizes once (the content hash folds this in). */
export const SUMMARY_REV = "v1";

/** Longest summary persisted; a runaway reply is truncated, not rejected. */
const SUMMARY_MAX_CHARS = 400;
const DEFAULT_BATCH_SIZE = 15;
const DEFAULT_MAX_PROMPTS_PER_PASS = 200;
const DEFAULT_POLITENESS_MS = 250;
const DEFAULT_PROMPT_TIMEOUT_MS = 60_000;
/** Disposal may detach a stuck SDK request after this bound. The request itself
 *  cannot be cancelled by the SDK; lease/title guards make its late settlement
 *  incapable of touching SQLite or another instance's worker. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_DEBOUNCE_MS = 3_000;
/** Abort a drain after this many prompts fail in a row: a misconfigured model
 *  must not burn the whole per-pass budget. Latches until the next cold pass. */
const MAX_CONSECUTIVE_FAILURES = 3;
const INVENTORY_TOKENS = 24;
const FILES_SHOWN = 6;
const TOOLS_SHOWN = 8;
const ERRORS_SHOWN = 3;

/** Disable every tool on the worker prompt. The `tools` map is deprecated but
 *  honored; `"*"` is a best-effort disable-all key (unknown keys are ignored, so
 *  it is safe even if the server does not special-case it). See the enforceability
 *  note where this is passed. */
const DISABLE_ALL_TOOLS: Record<string, boolean> = { "*": false };

/** Deny-all permission ruleset for the worker session, so a tool call the model
 *  attempts despite the disabled map is refused by the permission layer. Applied
 *  best-effort at create time with a graceful fallback (see createWorker). */
const DENY_ALL_PERMISSION: PermissionRuleset = [{ permission: "*", pattern: "**", action: "deny" }];

const SYSTEM_PROMPT =
  "You summarize past coding sessions for a search index. The user message is a JSON " +
  'array of session objects, each with an opaque "key" and mechanical fields. For every ' +
  "object, write 2 to 3 plain factual sentences about what that session did and how it " +
  "ended, using ONLY the fields given (never speculate, never call tools). Output ONLY a " +
  'JSON array of {"key": string, "summary": string}, one element per input object, echoing ' +
  "each input key exactly. No prose, no markdown fences, no keys other than key and summary.";

export type SummariesConfig = {
  providerID: string;
  modelID: string;
  /** Optional opencode agent name to prompt as. This is the only server-ENFORCED
   *  way to block tool use: tool materialization is driven by the agent's
   *  permission ruleset, so pointing this at an agent defined with deny-all
   *  permissions guarantees the worker cannot act. Unset = the default agent
   *  (tools then rely only on the best-effort disable map below). */
  agent?: string;
  /** Hard cap on prompts per drain (safety valve). */
  maxPromptsPerPass?: number;
};

/** Parse a `"providerID/modelID"` string into its parts, splitting on the FIRST
 *  slash so a modelID containing slashes survives. Returns undefined for
 *  anything without a non-empty provider and model: the caller never guesses. */
export function parseModelId(model: string): { providerID: string; modelID: string } | undefined {
  const trimmed = model.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) return undefined;
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
}

export type SummarizerDeps = {
  client: OpencodeClient;
  store: Store;
  gate: FetchGate;
  config: SummariesConfig;
  /** Unique to this plugin instance; embedded in worker titles and used to keep
   *  normal cleanup scoped to workers this instance created. */
  ownerToken: string;
  /** Only the distill-lease holder writes; checked before every persisted write. */
  leaseHeld: () => boolean;
  log?: (message: string) => void;
  now?: () => number;
  // ── Test affordances (default to the constants above) ──
  rev?: string;
  batchSize?: number;
  politenessMs?: number;
  promptTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  idleDebounceMs?: number;
};

export type Summarizer = {
  /** Enqueue every card that needs a summary (newest-first) and drain, bounded by
   *  the shared per-pass budget. Safe to call repeatedly (the hash gate skips). */
  runColdPass(): Promise<void>;
  /** Debounced incremental re-summarize of one session (the idle-debounce path);
   *  the drain skips it when the content hash is unchanged. */
  queue(sessionId: string): void;
  /** Stop accepting work and settle the active serialized drain. */
  stop(): Promise<void>;
  status(): { summarized: number; lastError?: string };
};

type Timer = ReturnType<typeof setTimeout>;

export function summarizerWorkerTitle(ownerToken: string): string {
  return `${SUMMARIZER_SENTINEL} owner=${ownerToken}`;
}

// ── Text helpers ─────────────────────────────────────────────────────────────

function cap(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** The mechanical fields fed to the model (and, joined, hashed for change
 *  detection). Identifiers are de-split (the inventory carries `launchTerminal`;
 *  the model sees "launch terminal") via the embedding-text tokenizer. */
function mechanicalFields(card: Card): Record<string, string> {
  const out: Record<string, string> = {};
  if (card.title.trim()) out.title = card.title.trim();
  if (card.summaryHead.trim()) out.about = card.summaryHead.trim();
  if (card.outcomeHead.trim()) out.outcome = card.outcomeHead.trim();
  const did = tokenizeAll(card.inventory).slice(0, INVENTORY_TOKENS).join(" ");
  if (did) out.did = did;
  const files = card.files.slice(0, FILES_SHOWN).map(basename).join(", ");
  if (files) out.files = files;
  const tools = card.tools.slice(0, TOOLS_SHOWN).join(", ");
  if (tools) out.tools = tools;
  const errors = card.errors.slice(0, ERRORS_SHOWN).join(" | ");
  if (errors) out.errors = errors;
  return out;
}

function mechanicalDigest(card: Card): string {
  return Object.entries(mechanicalFields(card))
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

/** 53-bit content hash (cyrb53), pure JS so `src/` stays Node-free. Used only
 *  for change detection, so a rare collision merely skips a re-summary. */
function contentHash(rev: string, card: Card): string {
  const text = `${rev} ${mechanicalDigest(card)}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return hash.toString(36);
}

/**
 * Render a batch as a JSON array of `{ key, ...fields }` with OPAQUE per-batch
 * keys (b1, b2, …). The real session id never enters the prompt, and every field
 * value is JSON-encoded, so a hostile card field cannot forge the framing or
 * re-target a sibling: the reply is mapped back only through `keyToSession`.
 */
function renderBatch(cards: Card[]): { text: string; keyToSession: Map<string, string> } {
  const keyToSession = new Map<string, string>();
  const items = cards.map((card, i) => {
    const key = `b${i + 1}`;
    keyToSession.set(key, card.sessionId);
    return { key, ...mechanicalFields(card) };
  });
  const text = `Summarize each session object in this JSON array, echoing each "key" exactly.\n\n${JSON.stringify(items)}`;
  return { text, keyToSession };
}

/** Widest `[ ... ]` span, tolerating code fences and surrounding prose. */
function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  return start !== -1 && end > start ? text.slice(start, end + 1) : null;
}

/**
 * Parse a batch reply into key -> summary, keeping only keys the batch actually
 * issued. Unknown keys (a forged/hallucinated id), duplicate keys, and empty
 * summaries are rejected; a missing key just leaves that card unsummarized.
 */
export function parseSummaryReply(text: string, validKeys: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  const json = extractJsonArray(text);
  if (!json) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const key = record.key;
    const summary = record.summary;
    if (typeof key !== "string" || !validKeys.has(key) || out.has(key)) continue;
    if (typeof summary !== "string" || !summary.trim()) continue;
    out.set(key, cap(summary.trim().replace(/\s+/g, " "), SUMMARY_MAX_CHARS));
  }
  return out;
}

/** Concatenate the text parts of an assistant reply. */
function replyText(parts: Part[]): string {
  let text = "";
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") text += part.text;
  }
  return text;
}

// ── Summarizer ───────────────────────────────────────────────────────────────

export function createSummarizer(deps: SummarizerDeps): Summarizer {
  const { client, store, gate, config, leaseHeld, ownerToken } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log;
  const rev = deps.rev ?? SUMMARY_REV;
  const batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE);
  const politenessMs = Math.max(0, deps.politenessMs ?? DEFAULT_POLITENESS_MS);
  const promptTimeoutMs = Math.max(1, deps.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS);
  const shutdownTimeoutMs = Math.max(1, deps.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
  const idleDebounceMs = Math.max(0, deps.idleDebounceMs ?? DEFAULT_IDLE_DEBOUNCE_MS);
  const maxPromptsPerPass = Math.max(1, config.maxPromptsPerPass ?? DEFAULT_MAX_PROMPTS_PER_PASS);

  const logMsg = (message: string): void => {
    if (log) log(`[recall summarize @${now()}] ${message}`);
  };
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  let stopped = false;
  let disabled = false; // failure latch (reset by a fresh cold pass)
  let consecutiveFailures = 0;
  let cleanedOrphans = false;
  let summarized = 0;
  let lastError: string | undefined;
  let permissionMode: "with" | "without" | undefined;

  const pending: string[] = [];
  const pendingSet = new Set<string>();
  const inFlight = new Set<string>();
  const attempts = new Map<string, number>();
  let drainPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | undefined;
  const debounceTimers = new Map<string, Timer>();
  const ownedWorkers = new Set<string>();
  const workerTitle = summarizerWorkerTitle(ownerToken);

  // ── Worker session lifecycle ──
  // A fresh worker per batch (create, prompt once, delete): create/delete are
  // unbilled and this keeps every batch's context clean with zero accumulation.

  async function leaseSdk<T>(label: string, operation: () => Promise<T>): Promise<T | undefined> {
    if (stopped || !leaseHeld()) return undefined;
    const result = await settleWithin(
      gate.runBackground(() => {
        // A gate permit may arrive after shutdown or an involuntary lease loss.
        if (stopped || !leaseHeld()) return Promise.resolve(undefined);
        return operation();
      }),
      shutdownTimeoutMs,
    );
    if (result.timedOut) {
      logMsg(`${label} timed out after ${shutdownTimeoutMs}ms; late SDK settlement detached`);
      return undefined;
    }
    return result.value;
  }

  /** Bounded SDK runner for destroying a worker THIS instance created. Remote
   *  worker ownership is a separate authority from the SQLite writer lease:
   *  losing the lease (or stopping) must never leak a worker we uniquely own,
   *  so this deliberately checks neither `stopped` nor `leaseHeld()` — only the
   *  caller's `ownedWorkers` membership scopes it. Returns the SDK response, or
   *  undefined on timeout, so the caller can distinguish confirmed success
   *  (`resp` without `error`) from a failed or detached request. */
  async function ownedWorkerSdk<T>(
    label: string,
    operation: () => Promise<T>,
  ): Promise<T | undefined> {
    const result = await settleWithin(gate.runBackground(operation), shutdownTimeoutMs);
    if (result.timedOut) {
      logMsg(`${label} timed out after ${shutdownTimeoutMs}ms; late SDK settlement detached`);
      return undefined;
    }
    return result.value;
  }

  async function createWorker(): Promise<string | null> {
    try {
      // Probe the deny-all permission ruleset once; if the server rejects the
      // shape, remember that and create plainly thereafter (never let a rejected
      // ruleset silently disable summaries).
      if (permissionMode !== "without") {
        const resp = await leaseSdk("worker create", () =>
          client.session.create({ title: workerTitle, permission: DENY_ALL_PERMISSION }),
        );
        if (!resp) return null;
        const created = resp.data as Session | undefined;
        if (!resp.error && created?.id) {
          permissionMode = "with";
          ownedWorkers.add(created.id);
          return created.id;
        }
        if (permissionMode === undefined) {
          permissionMode = "without";
          logMsg("worker permission ruleset rejected; relying on tool-disable + exclusion");
        }
      }
      const resp = await leaseSdk("worker create", () =>
        client.session.create({ title: workerTitle }),
      );
      if (!resp) return null;
      const created = resp.data as Session | undefined;
      if (created?.id) ownedWorkers.add(created.id);
      return created?.id ?? null;
    } catch (error) {
      lastError = errmsg(error);
      return null;
    }
  }

  async function deleteOwnedWorker(sessionID: string): Promise<void> {
    if (!ownedWorkers.has(sessionID)) return;
    try {
      // NOT lease-gated: this instance created the worker and uniquely owns it;
      // losing the SQLite writer lease mid-batch must not leak the session.
      const resp = await ownedWorkerSdk("worker delete", () =>
        client.session.delete({ sessionID }),
      );
      // Prune only on CONFIRMED success: an SDK error, rejection, or timeout
      // keeps the id owned so drainOwnedWorkers retries it at the start of the
      // next batch. (Retention only helps THIS instance — any next lease
      // holder's orphan sweep deletes by sentinel title regardless of our
      // bookkeeping.)
      if (resp && !resp.error) ownedWorkers.delete(sessionID);
    } catch {
      // Best-effort; a lingering sentinel session is excluded everywhere and
      // swept by the next holder's orphan cleanup.
    }
  }

  /** Best-effort retry of leftover owned ids (deletes that failed or timed out
   *  in earlier batches). Runs at the start of each batch, before creating the
   *  new worker. Bounded: at most a few ids, each delete already capped by
   *  settleWithin inside ownedWorkerSdk; success prunes, failure keeps the id
   *  for the next batch's drain. */
  async function drainOwnedWorkers(): Promise<void> {
    for (const sessionID of [...ownedWorkers]) {
      await deleteOwnedWorker(sessionID);
    }
  }

  async function abortOwnedWorker(sessionID: string): Promise<void> {
    if (!ownedWorkers.has(sessionID)) return;
    try {
      // NOT lease-gated, same as deleteOwnedWorker: the abort stops OUR
      // worker's spend. It does not remove the id — the delete that follows
      // owns the ownedWorkers cleanup.
      await ownedWorkerSdk("worker abort", () => client.session.abort({ sessionID }));
    } catch {
      // Best-effort.
    }
  }

  /** Delete any sentinel worker sessions left by a crashed prior holder, rather
   *  than adopting one whose accumulated context is unknown. Runs once.
   *  Accepted race: the sweep matches by sentinel title, so a fresh lease
   *  winner can delete a demoted loser's still-in-flight worker — benign, since
   *  the loser's results were lease-gated out of persistence anyway. */
  async function deleteOrphans(): Promise<void> {
    try {
      const resp = await leaseSdk("worker orphan list", () =>
        client.session.list({ search: SUMMARIZER_SENTINEL, limit: 100 }),
      );
      if (!resp || stopped || !leaseHeld()) return;
      const rows = Array.isArray(resp.data) ? (resp.data as Session[]) : [];
      for (const row of rows) {
        // Ownership can change while list/delete is in flight. Re-check after
        // every await and immediately before each destructive request.
        if (stopped || !leaseHeld()) return;
        if (isSummarizerTitle(row.title) && typeof row.id === "string" && row.id) {
          // Orphan sweeps target OTHER holders' leftovers, so they stay
          // lease-gated (unlike ownedWorkers cleanup above).
          await leaseSdk("orphan worker delete", () =>
            client.session.delete({ sessionID: row.id }),
          );
          if (stopped || !leaseHeld()) return;
        }
      }
    } catch {
      // Best-effort.
    }
  }

  /** Send one batch to a freshly created worker and return session -> summary.
   *  The prompt itself is NOT gated: a generation can take up to promptTimeoutMs,
   *  and the drain already serializes prompts, so holding a shared fetch-gate
   *  permit that long would only starve foreground recall for no concurrency
   *  benefit. Worker create/delete/list/abort stay gated (quick server fetches). */
  async function promptBatchFor(cards: Card[]): Promise<Map<string, string>> {
    // Retry any leftover owned workers from earlier batches before adding one.
    await drainOwnedWorkers();
    const workerId = await createWorker();
    if (!workerId) return new Map();
    try {
      if (stopped || !leaseHeld()) return new Map();
      const { text, keyToSession } = renderBatch(cards);
      const reply = await promptWorker(workerId, text);
      if (reply == null) return new Map();
      const byKey = parseSummaryReply(reply, new Set(keyToSession.keys()));
      const out = new Map<string, string>();
      for (const [key, summary] of byKey) {
        const sessionId = keyToSession.get(key);
        if (sessionId) out.set(sessionId, summary);
      }
      return out;
    } finally {
      // Only ids created by this owner token enter ownedWorkers; normal cleanup
      // can therefore never target another instance's worker.
      await deleteOwnedWorker(workerId);
    }
  }

  async function promptWorker(workerId: string, text: string): Promise<string | null> {
    try {
      const outcome = await settleWithin(
        client.session.prompt({
          sessionID: workerId,
          model: { providerID: config.providerID, modelID: config.modelID },
          system: SYSTEM_PROMPT,
          // Prompting as a restricted agent is the server-enforced tool block;
          // the tools map is a best-effort belt (see the constant's note).
          ...(config.agent ? { agent: config.agent } : {}),
          tools: DISABLE_ALL_TOOLS,
          parts: [{ type: "text", text }],
        }),
        promptTimeoutMs,
      );
      if (outcome.timedOut) {
        // Stop the generation so the timeout caps SPEND, not just our waiting.
        await abortOwnedWorker(workerId);
        lastError = "summary prompt timed out";
        return null;
      }
      const response = outcome.value;
      if (response.error || !response.data) {
        lastError = response.error ? errmsg(response.error) : "empty prompt response";
        return null;
      }
      const data = response.data as { parts?: Part[] };
      return replyText(Array.isArray(data.parts) ? data.parts : []);
    } catch (error) {
      lastError = errmsg(error);
      return null;
    }
  }

  // ── Queue + drain ──

  function bumpCardsRev(): void {
    const current = Number(store.getMeta("cards_rev")) || 0;
    store.setMeta("cards_rev", String(current + 1));
  }

  function cardsNeedingSummary(): Card[] {
    return store
      .allCards()
      .filter(
        (card) =>
          card.distillState === "full" &&
          !isSummarizerTitle(card.title) &&
          card.summaryHash !== contentHash(rev, card),
      )
      .sort((a, b) => b.timeUpdated - a.timeUpdated || a.sessionId.localeCompare(b.sessionId));
  }

  /** Add ids to the queue with single-flight dedupe (skip anything already queued
   *  or in flight). Does not start the drain. */
  function enqueueOnly(ids: string[]): void {
    for (const id of ids) {
      if (pendingSet.has(id) || inFlight.has(id)) continue;
      pendingSet.add(id);
      pending.push(id);
    }
  }

  function enqueue(ids: string[]): void {
    enqueueOnly(ids);
    void drain();
  }

  function drain(): Promise<void> {
    if (drainPromise) return drainPromise;
    if (disabled || stopped || !leaseHeld()) return Promise.resolve();
    drainPromise = runDrain().finally(() => {
      drainPromise = null;
    });
    return drainPromise;
  }

  async function runDrain(): Promise<void> {
    if (!cleanedOrphans) {
      cleanedOrphans = true;
      await deleteOrphans();
      if (stopped || !leaseHeld()) return;
    }
    let prompts = 0;
    while (
      pending.length > 0 &&
      prompts < maxPromptsPerPass &&
      !disabled &&
      !stopped &&
      leaseHeld()
    ) {
      const batchIds: string[] = [];
      while (batchIds.length < batchSize && pending.length > 0) {
        const id = pending.shift()!;
        pendingSet.delete(id);
        batchIds.push(id);
        inFlight.add(id);
      }
      // Re-validate against the live store: drop cards gone, not fully distilled,
      // a worker card, or already summarized at the current content (the hash
      // gate). An empty batch spends no prompt.
      const cards = batchIds
        .map((id) => store.getCard(id))
        .filter(
          (card): card is Card =>
            card != null &&
            card.distillState === "full" &&
            !isSummarizerTitle(card.title) &&
            contentHash(rev, card) !== card.summaryHash,
        );
      if (cards.length === 0) {
        for (const id of batchIds) inFlight.delete(id);
        continue;
      }

      prompts++;
      const summaries = await promptBatchFor(cards);
      if (stopped || !leaseHeld()) {
        for (const id of batchIds) inFlight.delete(id);
        break;
      }

      let wrote = 0;
      const retry: string[] = [];
      for (const card of cards) {
        const summary = summaries.get(card.sessionId);
        if (summary) {
          store.writeSummary(card.sessionId, summary, contentHash(rev, card));
          summarized++;
          wrote++;
          attempts.delete(card.sessionId);
        } else {
          const n = (attempts.get(card.sessionId) ?? 0) + 1;
          if (n <= 1) {
            attempts.set(card.sessionId, n);
            retry.push(card.sessionId); // one retry in a later batch
          } else {
            attempts.delete(card.sessionId); // give up: left empty, a later pass retries
          }
        }
      }
      for (const id of batchIds) inFlight.delete(id);
      if (retry.length > 0) enqueueOnly(retry);
      if (wrote > 0) bumpCardsRev();

      if (summaries.size === 0) {
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          disabled = true;
          logMsg("summaries disabled after repeated prompt failures");
          break;
        }
        if (politenessMs > 0) await sleep(politenessMs * consecutiveFailures);
      } else {
        consecutiveFailures = 0;
      }
      if (pending.length > 0 && politenessMs > 0) await sleep(politenessMs);
    }
  }

  return {
    async runColdPass(): Promise<void> {
      if (stopped || !leaseHeld()) return;
      // A fresh lease (process start / takeover) is a chance to recover from a
      // prior failure latch.
      disabled = false;
      consecutiveFailures = 0;
      store.setMeta(SUMMARY_REV_KEY, rev);
      const needing = cardsNeedingSummary();
      logMsg(`cold pass: ${needing.length} cards need summaries`);
      enqueueOnly(needing.map((card) => card.sessionId));
      await drain();
    },

    queue(sessionId: string): void {
      if (stopped) return;
      const existing = debounceTimers.get(sessionId);
      if (existing) clearTimeout(existing);
      debounceTimers.set(
        sessionId,
        setTimeout(() => {
          debounceTimers.delete(sessionId);
          enqueue([sessionId]);
        }, idleDebounceMs),
      );
    },

    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopped = true;
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
      pending.length = 0;
      pendingSet.clear();
      const active = drainPromise;
      stopPromise = active
        ? settleWithin(active, shutdownTimeoutMs).then((result) => {
            if (result.timedOut) {
              logMsg(
                `shutdown timed out after ${shutdownTimeoutMs}ms; late SDK work is lease-guarded and detached`,
              );
            }
          })
        : Promise.resolve();
      return stopPromise;
    },

    status() {
      return { summarized, ...(lastError !== undefined ? { lastError } : {}) };
    },
  };
}
