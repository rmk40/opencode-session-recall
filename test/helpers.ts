import { expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin";
import type {
  AssistantMessage,
  GlobalSession,
  Message,
  OpencodeClient,
  Part,
  Session,
  UserMessage,
} from "@opencode-ai/sdk/v2";
import type { Limits } from "../src/types.js";
import { openSqlite } from "../src/sqlite.js";
import { openStore, type Store } from "../src/store.js";
import { deriveCard, type DistillSessionMeta } from "../src/distill.js";
import { createFetchGate, type FetchGate } from "../src/fetch-gate.js";
import { createCardsRuntime } from "../src/cards.js";
import { createDrill } from "../src/drill.js";
import type { SearchDeps, SemanticSearchConfig } from "../src/search.js";

export const PROJECT_DIR = "/workspace/project";
export const OTHER_DIR = "/workspace/other";
export const GHOST_DIR = "/workspace/ghostauth";

export const TEST_LIMITS: Limits = {
  concurrency: 2,
  maxSessions: Infinity,
  maxResults: 50,
  maxSessionList: 100,
  maxMessages: 50,
  maxWindow: 10,
  defaultWidth: 120,
  cacheMaxChars: 2_000_000,
  distillConcurrency: 2,
  distillDelayMs: 25,
  ftsRowsPerSession: 5000,
  inventoryTokens: 200,
  coldPass: true,
  drillSessions: 12,
  semanticSlots: 2,
  drillPageMessages: 25,
  drillCharsPerSession: 1_500_000,
  drillCharsPerQuery: 20_000_000,
  deepCharsPerQuery: 30_000_000,
};

type ApiFailure = { data: { message: string } };
type MessageBundle = { info: Message; parts: Part[] };
type MetadataCall = { title?: string; metadata?: Record<string, unknown> };

// ── Strict no-limit enforcement ─────────────────────────────────────────────
// The incident path was an unpaginated `session.messages({ sessionID })`. When
// strict mode is on, the fake client throws on any no-limit call, and the
// runTool helpers hard-fail the test if a tool swallows that into an error
// output — so a reintroduced unbounded fetch cannot regress silently. Enabled
// per suite via setStrictNoLimitMessages(true); the distiller/legacy fixtures
// that intentionally exercise the no-limit full-return path opt out by leaving
// it off.
export const UNBOUNDED_MESSAGES_ERROR = "unbounded session.messages() call without a limit";
let strictNoLimitMessages = false;
export function setStrictNoLimitMessages(value: boolean): void {
  strictNoLimitMessages = value;
}
export function strictNoLimit(): boolean {
  return strictNoLimitMessages;
}

export type FakeCalls = {
  projectList: Array<{ search?: string; limit?: number }>;
  globalList: Array<{ search?: string; limit?: number }>;
  get: Array<{ sessionID: string }>;
  messages: Array<{ sessionID: string; limit?: number; before?: string }>;
  message: Array<{ sessionID: string; messageID: string }>;
  /** One shared log for session.children on BOTH fake clients, tagged with the
   *  client it went through — so the scoped-client decision is enforced by
   *  assertion, while a client switch stays a one-line change. */
  children: Array<{ sessionID: string; client: "scoped" | "unscoped" }>;
};

export type FakeOptions = {
  projectListError?: string;
  globalListError?: string;
  messageErrors?: Record<string, string>;
  messageThrows?: Set<string>;
  noMessageData?: Set<string>;
  getThrows?: Set<string>;
  /** The UNSCOPED client's session.get throws for these ids (the scoped
   *  client's failures are `getThrows`; the search probe retries unscoped). */
  unscopedGetThrows?: Set<string>;
  messageLookupErrors?: Record<string, string>;
  noSingleMessageData?: Set<string>;
  afterMessagesCall?: (sessionID: string) => void;
  /** Opt-in session graph for session.children: parentID → child sessions.
   *  The default fixture stays graph-free. */
  children?: Record<string, Session[]>;
  /** session.children returns an SDK error with this message. */
  childrenError?: string;
  /** session.children rejects (thrown, not an error return). */
  childrenThrows?: boolean;
  /** session.children returns a divergent non-array `data` payload. */
  childrenNonArray?: boolean;
};

export type FakeHarness = {
  client: OpencodeClient;
  unscoped: OpencodeClient;
  calls: FakeCalls;
  sessions: Session[];
  globalSessions: GlobalSession[];
  messagesBySession: Record<string, MessageBundle[]>;
};

export function apiFailure(message: string): ApiFailure {
  return { data: { message } };
}

export function session(
  id: string,
  title: string,
  directory: string,
  updated: number,
  archived?: number,
  parentID?: string,
): Session {
  return {
    id,
    slug: id,
    projectID: directory === PROJECT_DIR ? "project-main" : "project-other",
    directory,
    title,
    parentID,
    version: "0.0.0-test",
    time: {
      created: updated - 1000,
      updated,
      archived,
    },
  };
}

export function globalSessionFrom(s: Session): GlobalSession {
  return {
    ...s,
    project:
      s.directory === PROJECT_DIR
        ? { id: "project-main", name: "main", worktree: PROJECT_DIR }
        : { id: "project-other", name: "other", worktree: s.directory },
  } as GlobalSession;
}

export function userMessage(id: string, sessionID: string, created: number): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "test", modelID: "test-user-model" },
  };
}

export function assistantMessage(id: string, sessionID: string, created: number): AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created, completed: created + 10 },
    parentID: "parent",
    modelID: "test-assistant-model",
    providerID: "test",
    mode: "build",
    agent: "build",
    path: { cwd: PROJECT_DIR, root: PROJECT_DIR },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

export function textPart(id: string, sessionID: string, messageID: string, text: string): Part {
  return { id, sessionID, messageID, type: "text", text };
}

export function reasoningPart(
  id: string,
  sessionID: string,
  messageID: string,
  text: string,
): Part {
  return {
    id,
    sessionID,
    messageID,
    type: "reasoning",
    text,
    time: { start: 1 },
  };
}

export function subtaskPart(
  id: string,
  sessionID: string,
  messageID: string,
  description: string,
  prompt: string,
): Part {
  return {
    id,
    sessionID,
    messageID,
    type: "subtask",
    description,
    prompt,
    agent: "build",
  };
}

export function completedToolPart(
  id: string,
  sessionID: string,
  messageID: string,
  tool: string,
  input: Record<string, unknown>,
  output: string,
  options: { title?: string; compacted?: number } = {},
): Part {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: `${id}-call`,
    tool,
    state: {
      status: "completed",
      input,
      output,
      title: options.title ?? tool,
      metadata: {},
      time: { start: 1, end: 2, compacted: options.compacted },
    },
  };
}

export function errorToolPart(
  id: string,
  sessionID: string,
  messageID: string,
  tool: string,
  input: Record<string, unknown>,
  error: string,
): Part {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: `${id}-call`,
    tool,
    state: {
      status: "error",
      input,
      error,
      time: { start: 1, end: 2 },
    },
  };
}

export function runningToolPart(
  id: string,
  sessionID: string,
  messageID: string,
  input: Record<string, unknown>,
): Part {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: `${id}-call`,
    tool: "bash",
    state: {
      status: "running",
      input,
      title: "running bash",
      time: { start: 1 },
    },
  };
}

export function pendingToolPart(
  id: string,
  sessionID: string,
  messageID: string,
  input: Record<string, unknown>,
): Part {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: `${id}-call`,
    tool: "bash",
    state: { status: "pending", input, raw: JSON.stringify(input) },
  };
}

export function bundle(info: Message, parts: Part[]): MessageBundle {
  return { info, parts };
}

// ── Keyset pagination shim ───────────────────────────────────────────────────
// Mimics the real `session.messages` contract: newest-first pages, an opaque
// base64url cursor, and a next-page cursor delivered in the `X-Next-Cursor`
// response header (the body is the items array). The cursor encodes an index
// into the newest-first ordering — opaque to callers, decoded only here.

function encodeCursor(index: number): string {
  return Buffer.from(String(index)).toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

/** Slice one newest-first page from a chronological (oldest-first) bundle list. */
export function paginateBundles(
  all: MessageBundle[],
  limit: number,
  before?: string,
): { items: MessageBundle[]; nextCursor: string | null } {
  const newestFirst = [...all].reverse();
  const start = decodeCursor(before);
  const items = newestFirst.slice(start, start + limit);
  const nextIndex = start + limit;
  return { items, nextCursor: nextIndex < newestFirst.length ? encodeCursor(nextIndex) : null };
}

/** A fields-style messages response carrying the next cursor in a real `Headers`
 *  object (so `Headers.get` is genuinely case-insensitive). */
export function messagesResponse(
  items: MessageBundle[],
  nextCursor: string | null,
): { data: MessageBundle[]; response: { headers: Headers } } {
  const headers = new Headers();
  if (nextCursor) headers.set("X-Next-Cursor", nextCursor);
  return { data: items, response: { headers } };
}

export function makeFixture(now = Date.now()): {
  sessions: Session[];
  globalSessions: GlobalSession[];
  messagesBySession: Record<string, MessageBundle[]>;
} {
  const current = session("s-current", "Current Debugging Session", PROJECT_DIR, now - 1_000);
  const projectTwo = session(
    "s-project-2",
    "Checkout Cache Investigation",
    PROJECT_DIR,
    now - 2_000,
    now - 500,
  );
  const other = session("s-other", "Actualyze Walkthrough", OTHER_DIR, now - 500);

  const currentMessages = [
    bundle(userMessage("m-current-1", current.id, now - 90_000), [
      textPart(
        "p-current-1",
        current.id,
        "m-current-1",
        "Original requirement: implement rate-limit middleware for checkout. C++ parser support matters.",
      ),
    ]),
    bundle(assistantMessage("m-current-2", current.id, now - 80_000), [
      reasoningPart(
        "p-current-2",
        current.id,
        "m-current-2",
        "Inspect rateLimitCache before writing tests for checkout behavior.",
      ),
    ]),
    bundle(assistantMessage("m-current-3", current.id, now - 70_000), [
      completedToolPart(
        "p-current-3",
        current.id,
        "m-current-3",
        "bash",
        { command: "npm test" },
        "Error: Unauthorized while loading session messages",
        { title: "Run test suite", compacted: now - 65_000 },
      ),
    ]),
    bundle(assistantMessage("m-current-4", current.id, now - 60_000), [
      completedToolPart(
        "p-current-4",
        current.id,
        "m-current-4",
        "recall",
        { query: "unique self noise" },
        "unique-self-recall-result should never appear in recall results",
      ),
    ]),
    bundle(assistantMessage("m-current-5", current.id, now - 50_000), [
      subtaskPart(
        "p-current-5",
        current.id,
        "m-current-5",
        "Investigate migrations",
        "Check pending database migration cleanup",
      ),
    ]),
    bundle(assistantMessage("m-current-6", current.id, now - 40_000), [
      runningToolPart("p-current-6", current.id, "m-current-6", {
        command: "pnpm migrate status",
      }),
    ]),
  ];

  const projectTwoMessages = [
    bundle(userMessage("m-project-1", projectTwo.id, now - 85_000), [
      textPart(
        "p-project-1",
        projectTwo.id,
        "m-project-1",
        "Please debug rateLimit cache behavior in checkout.",
      ),
    ]),
    bundle(assistantMessage("m-project-2", projectTwo.id, now - 30_000), [
      errorToolPart(
        "p-project-2",
        projectTwo.id,
        "m-project-2",
        "bash",
        { path: "cache" },
        "permission denied when reading checkout cache",
      ),
    ]),
    bundle(assistantMessage("m-project-3", projectTwo.id, now - 20_000), [
      pendingToolPart("p-project-3", projectTwo.id, "m-project-3", {
        query: "pending migration",
      }),
    ]),
  ];

  const otherMessages = [
    bundle(userMessage("m-other-1", other.id, now - 75_000), [
      textPart("p-other-1", other.id, "m-other-1", "Plan walkthrough pages for demo.actualyze.ai."),
    ]),
    bundle(assistantMessage("m-other-2", other.id, now - 65_000), [
      textPart(
        "p-other-2",
        other.id,
        "m-other-2",
        "Use website content pages for the Actualyze walkthrough.",
      ),
    ]),
  ];

  const sessions = [current, projectTwo];
  const globalSessions = [other, current, projectTwo].map(globalSessionFrom);
  const messagesBySession = {
    [current.id]: currentMessages,
    [projectTwo.id]: projectTwoMessages,
    [other.id]: otherMessages,
  };

  return { sessions, globalSessions, messagesBySession };
}

function filtered<T extends Session | GlobalSession>(
  sessions: T[],
  search: string | undefined,
  limit: number | undefined,
): T[] {
  const matching = search
    ? sessions.filter((s) => s.title.toLowerCase().includes(search.toLowerCase()))
    : sessions;
  // Mimic the opencode server: an omitted limit defaults to 100 rows.
  return matching.slice(0, limit ?? 100);
}

export function makeFakeHarness(options: FakeOptions = {}): FakeHarness {
  const fixture = makeFixture();
  const calls: FakeCalls = {
    projectList: [],
    globalList: [],
    get: [],
    messages: [],
    message: [],
    children: [],
  };

  const childrenFake = (tag: "scoped" | "unscoped") => {
    return async ({ sessionID }: { sessionID: string }) => {
      calls.children.push({ sessionID, client: tag });
      if (options.childrenThrows) throw new Error(`children failed: ${sessionID}`);
      if (options.childrenError) return { error: apiFailure(options.childrenError) };
      if (options.childrenNonArray) return { data: { unexpected: true } as unknown as Session[] };
      return { data: options.children?.[sessionID] ?? [] };
    };
  };

  const client = {
    session: {
      list: async (params?: { search?: string; limit?: number }) => {
        calls.projectList.push({
          search: params?.search,
          limit: params?.limit,
        });
        if (options.projectListError) return { error: apiFailure(options.projectListError) };
        return {
          data: filtered(fixture.sessions, params?.search, params?.limit),
        };
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        calls.get.push({ sessionID });
        if (options.getThrows?.has(sessionID)) throw new Error(`get failed: ${sessionID}`);
        const found = fixture.globalSessions.find((s) => s.id === sessionID);
        return found ? { data: found } : { error: apiFailure(`Session not found: ${sessionID}`) };
      },
      messages: async (params: { sessionID: string; limit?: number; before?: string }) => {
        const { sessionID, limit, before } = params;
        calls.messages.push({ sessionID, limit, before });
        options.afterMessagesCall?.(sessionID);
        if (options.messageThrows?.has(sessionID)) throw new Error(`thrown messages: ${sessionID}`);
        if (options.messageErrors?.[sessionID]) {
          return { error: apiFailure(options.messageErrors[sessionID]) };
        }
        if (options.noMessageData?.has(sessionID)) return {};
        const data = fixture.messagesBySession[sessionID];
        if (!data) return { error: apiFailure(`Unauthorized`) };
        // Paginated path only when a limit is present (the distiller/
        // fetchMessagePage contract). A no-limit call is the incident path:
        // under strict mode it throws so a regressed unbounded fetch fails the
        // test; otherwise it keeps the legacy full-return the older fixtures use.
        if (limit != null) {
          const { items, nextCursor } = paginateBundles(data, limit, before);
          return messagesResponse(items, nextCursor);
        }
        if (strictNoLimitMessages) throw new Error(UNBOUNDED_MESSAGES_ERROR);
        return { data };
      },
      message: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
        calls.message.push({ sessionID, messageID });
        const key = `${sessionID}:${messageID}`;
        if (options.messageLookupErrors?.[key]) {
          return { error: apiFailure(options.messageLookupErrors[key]) };
        }
        if (options.noSingleMessageData?.has(key)) return {};
        const found = fixture.messagesBySession[sessionID]?.find((m) => m.info.id === messageID);
        return found ? { data: found } : { error: apiFailure(`Message not found: ${messageID}`) };
      },
      children: childrenFake("scoped"),
    },
  };

  const unscoped = {
    experimental: {
      session: {
        list: async (params?: { search?: string; limit?: number }) => {
          calls.globalList.push({
            search: params?.search,
            limit: params?.limit,
          });
          if (options.globalListError) return { error: apiFailure(options.globalListError) };
          return {
            data: filtered(fixture.globalSessions, params?.search, params?.limit),
          };
        },
      },
    },
    session: {
      children: childrenFake("unscoped"),
      // The unscoped client sees ALL sessions (global list), matching the real
      // server: a cross-project id a scoped get 404s on still resolves here.
      get: async ({ sessionID }: { sessionID: string }) => {
        calls.get.push({ sessionID });
        if (options.unscopedGetThrows?.has(sessionID)) {
          throw new Error(`unscoped get failed: ${sessionID}`);
        }
        const found = fixture.globalSessions.find((s) => s.id === sessionID);
        return found ? { data: found } : { error: apiFailure(`Session not found: ${sessionID}`) };
      },
    },
  };

  return {
    client: client as unknown as OpencodeClient,
    unscoped: unscoped as unknown as OpencodeClient,
    calls,
    ...fixture,
  };
}

// ── Fake worker-session prompt surface (Path B summarizer) ──────────────────
// A minimal client exposing session.create/list/prompt/delete/abort for
// summarizer tests: it tracks the worker sessions it creates, records every
// prompt (with the tools map it was disabled by), and returns a scripted reply.

export type SummaryPromptCall = {
  sessionID: string;
  model?: { providerID: string; modelID: string };
  system?: string;
  agent?: string;
  tools?: Record<string, boolean>;
  /** The batch text sent as the single text part. */
  text: string;
};

/** A scripted reply: `text` is the model's raw reply body (optionally delayed
 *  past the summarizer's timeout via `delayMs`), `error` returns an SDK error,
 *  `throw` makes the call reject. */
export type SummaryPromptResult =
  | { text: string; delayMs?: number }
  | { error: string }
  | { throw: true };

export type SummarizerClient = {
  client: OpencodeClient;
  calls: {
    creates: Array<{ title?: string; permission?: unknown }>;
    deletes: string[];
    aborts: string[];
    lists: number;
    prompts: SummaryPromptCall[];
  };
  /** The sentinel-titled worker sessions currently alive (for orphan tests). */
  liveWorkers: () => Session[];
  /** Seed a pre-existing worker session (e.g. a crash orphan). */
  seedWorker: (id: string, title: string) => void;
};

export function makeSummarizerClient(
  respond: (call: SummaryPromptCall, index: number) => SummaryPromptResult,
): SummarizerClient {
  const workers = new Map<string, Session>();
  let seq = 0;
  const calls: SummarizerClient["calls"] = {
    creates: [],
    deletes: [],
    aborts: [],
    lists: 0,
    prompts: [],
  };

  const client = {
    session: {
      list: async (params?: { search?: string; limit?: number }) => {
        calls.lists++;
        const search = params?.search?.toLowerCase();
        return {
          data: [...workers.values()].filter(
            (s) => !search || s.title.toLowerCase().includes(search),
          ),
        };
      },
      create: async (params?: { title?: string; permission?: unknown }) => {
        calls.creates.push({ title: params?.title, permission: params?.permission });
        const id = `worker-${++seq}`;
        const created = session(id, params?.title ?? "", PROJECT_DIR, 1_000 + seq);
        workers.set(id, created);
        return { data: created };
      },
      delete: async ({ sessionID }: { sessionID: string }) => {
        calls.deletes.push(sessionID);
        workers.delete(sessionID);
        return { data: true };
      },
      abort: async ({ sessionID }: { sessionID: string }) => {
        calls.aborts.push(sessionID);
        return { data: true };
      },
      prompt: async (params: {
        sessionID: string;
        model?: { providerID: string; modelID: string };
        system?: string;
        agent?: string;
        tools?: Record<string, boolean>;
        parts?: Array<{ type: string; text?: string }>;
      }) => {
        const text = (params.parts ?? [])
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("");
        const call: SummaryPromptCall = {
          sessionID: params.sessionID,
          model: params.model,
          system: params.system,
          agent: params.agent,
          tools: params.tools,
          text,
        };
        calls.prompts.push(call);
        const result = respond(call, calls.prompts.length - 1);
        if ("throw" in result) throw new Error("prompt threw");
        if ("error" in result) return { error: apiFailure(result.error) };
        if (result.delayMs) await new Promise((r) => setTimeout(r, result.delayMs));
        return { data: { info: {}, parts: [{ type: "text", text: result.text }] } };
      },
    },
  };

  return {
    client: client as unknown as OpencodeClient,
    calls,
    liveWorkers: () => [...workers.values()],
    seedWorker: (id, title) => {
      workers.set(id, session(id, title, PROJECT_DIR, 500));
    },
  };
}

export function makeContext(
  overrides: Partial<Omit<ToolContext, "abort" | "metadata" | "ask">> & {
    aborted?: boolean;
  } = {},
): { ctx: ToolContext; metadata: MetadataCall[]; controller: AbortController } {
  const controller = new AbortController();
  if (overrides.aborted) controller.abort();
  const metadata: MetadataCall[] = [];

  const ctx: ToolContext = {
    sessionID: "s-current",
    messageID: "m-current-1",
    agent: "build",
    directory: PROJECT_DIR,
    worktree: PROJECT_DIR,
    abort: controller.signal,
    metadata: (input) => metadata.push(input),
    ask: async () => undefined,
    ...overrides,
  };

  return { ctx, metadata, controller };
}

// ── Card-store seeding for the tier-1/tier-2 recall pipeline ────────────────
// Unit tests drive the live `recall` tool over a distilled card store. Seeding
// via `deriveCard` (the distiller's pure card builder) instead of the async
// cold-pass scheduler keeps each test synchronous and deterministic while
// producing byte-identical cards + FTS rows.

function toDistillMeta(s: Session | GlobalSession): DistillSessionMeta {
  return {
    id: s.id,
    parentId: s.parentID ?? null,
    title: s.title ?? "",
    slug: s.slug ?? "",
    directory: s.directory ?? "",
    projectId: s.projectID ?? "",
    agent: null,
    model: null,
    timeCreated: s.time.created,
    timeUpdated: s.time.updated,
  };
}

/** Seed a store from a fixture's sessions + messages (every session the search
 *  path can reach), the way a completed cold pass would leave it. Unions the
 *  project (`sessions`) and global (`globalSessions`) rows by id so tests that
 *  push to either list are picked up; the richer global row wins on conflict. */
export function seedStore(
  store: Store,
  fixture: {
    sessions?: (Session | GlobalSession)[];
    globalSessions: GlobalSession[];
    messagesBySession: Record<string, { info: Message; parts: Part[] }[]>;
  },
  limits: Limits = TEST_LIMITS,
): void {
  const byId = new Map<string, Session | GlobalSession>();
  for (const s of fixture.sessions ?? []) byId.set(s.id, s);
  for (const s of fixture.globalSessions) byId.set(s.id, s);
  const all = [...byId.values()];
  const parentById = new Map<string, string | null>(
    all.map((s) => [s.id, s.parentID ?? null] as const),
  );
  const caps = {
    ftsRowsPerSession: limits.ftsRowsPerSession,
    inventoryTokens: limits.inventoryTokens,
  };
  for (const s of all) {
    const { card, rows } = deriveCard({
      session: toDistillMeta(s),
      messages: fixture.messagesBySession[s.id] ?? [],
      parentById,
      caps,
    });
    store.replaceSessionParts(s.id, rows, card);
  }
  store.setMeta("cards_rev", "1");
}

/** Build the live `recall` deps over a seeded temp-file card store. Async only
 *  because opening SQLite is (dynamic import); the seed itself is synchronous.
 *  The caller MUST invoke `cleanup()` (closes and deletes the store). */
export async function makeRecallDeps(
  fixture: FakeHarness,
  limits: Limits = TEST_LIMITS,
  opts: {
    semantic?: SemanticSearchConfig;
    /** Inject the deep sweep's clock + wall-clock budget for time-stop tests. */
    now?: () => number;
    deepWallClockMs?: number;
    /** Inject a (spy) gate to assert fetches route through it. */
    gate?: FetchGate;
    /** Inject the cards runtime's clock + refresh interval (stale-snapshot
     *  tests: freeze the clock so the facade deterministically keeps serving
     *  its loaded snapshot regardless of wall time). */
    cardsNow?: () => number;
    cardsRefreshIntervalMs?: number;
  } = {},
): Promise<{ deps: SearchDeps; store: Store; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "recall-deps-"));
  const db = await openSqlite(join(dir, "store.db"));
  if (!db) throw new Error("openSqlite returned null in test helper");
  const store = openStore(db);
  if (!store) throw new Error("openStore returned null in test helper");
  seedStore(store, fixture, limits);

  const gate = opts.gate ?? createFetchGate({ concurrency: limits.concurrency });
  const cards = createCardsRuntime({
    source: { getCards: () => store.allCards(), revision: () => store.getMeta("cards_rev") },
    embedder: opts.semantic?.embedder,
    semanticWeight: opts.semantic?.weight,
    now: opts.cardsNow,
    refreshIntervalMs: opts.cardsRefreshIntervalMs,
  });
  const drill = createDrill({
    client: fixture.client,
    gate,
    limits,
    now: opts.now,
    deepWallClockMs: opts.deepWallClockMs,
  });
  return {
    deps: { gate, store, cards, drill },
    store,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Hard-fail if a tool swallowed a strict no-limit throw into an error output. */
function guardUnbounded(parsed: { ok: boolean; error?: unknown }): void {
  if (
    parsed.ok === false &&
    typeof parsed.error === "string" &&
    parsed.error.includes(UNBOUNDED_MESSAGES_ERROR)
  ) {
    throw new Error(`strict mode: a tool made an ${UNBOUNDED_MESSAGES_ERROR}`);
  }
}

/** Narrow a ToolResult to the JSON string every tool in this plugin returns.
 *  (Since @opencode-ai/plugin 1.18 `execute` may also return a structured
 *  object; this codebase never does.) */
export function toolResultText(raw: unknown): string {
  if (typeof raw !== "string") throw new Error(`tool returned a non-string result: ${typeof raw}`);
  return raw;
}

export async function runTool<T extends { ok: boolean }>(
  definition: ToolDefinition,
  rawArgs: Record<string, unknown>,
  ctx = makeContext().ctx,
): Promise<T> {
  const parsedArgs = tool.schema.object(definition.args).parse(rawArgs);
  const raw = await definition.execute(parsedArgs, ctx);
  const parsed = JSON.parse(toolResultText(raw)) as T;
  expect(parsed).toHaveProperty("ok");
  guardUnbounded(parsed as { ok: boolean; error?: unknown });
  return parsed;
}

/**
 * Run a tool without applying Zod defaults, simulating the live MCP host which
 * forwards raw caller args. Used to assert the plugin's defensive defaults.
 */
export async function runToolRaw<T extends { ok: boolean }>(
  definition: ToolDefinition,
  rawArgs: Record<string, unknown>,
  ctx = makeContext().ctx,
): Promise<T> {
  const raw = await definition.execute(rawArgs as Parameters<typeof definition.execute>[0], ctx);
  const parsed = JSON.parse(toolResultText(raw)) as T;
  expect(parsed).toHaveProperty("ok");
  guardUnbounded(parsed as { ok: boolean; error?: unknown });
  return parsed;
}
