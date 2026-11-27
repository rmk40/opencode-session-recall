import { expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "../src/tool-def.js";
import type { ToolContext, ToolDefinition } from "../src/host/opencode-v1-types.js";
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
import { openSqlite, type SqliteDb } from "../src/sqlite.js";
import {
  openReadStore,
  openStore,
  type OpenReadStoreResult,
  type ReadStoreOptions,
  type Store,
  type StoreIdentity,
  type StoreOptions,
} from "../src/store.js";
import { deriveCard, type DistillSessionMeta } from "../src/distill.js";
import { createFetchGate, type FetchGate } from "../src/fetch-gate.js";
import {
  createCardsRuntime,
  cardsLiteFromSessions,
  inlineVectorWriter,
  storeCardSource,
} from "../src/cards.js";
import { createDrill } from "../src/drill.js";
import type { SearchDeps, SemanticSearchConfig } from "../src/search.js";
import type { HistorySource } from "../src/history/source.js";
import { createV1HistorySource } from "../src/history/v1.js";

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

/** Open a store as the v1 host, mapping any refusal to `null` (the shape the
 *  v1 entry degrades on). Tests of the refusal reasons call `openStore`. */
export function openV1Store(db: SqliteDb, opts?: StoreOptions): Store | null {
  const opened = openStore(db, { host: "opencode-v1" }, opts);
  return opened.ok ? opened.store : null;
}

/** A scratch store with its writer open and a read-only connection beside it
 *  ({@link openScratchReader}). */
export type ScratchReader = {
  /** The store file. */
  path: string;
  /** The writer: the store as `openStore` opened it, and its connection. */
  writer: Store;
  writerDb: SqliteDb;
  /** The {@link openReadStore} result over the same file. */
  opened: OpenReadStoreResult;
  /** Close the reader (when it opened), then the writer, and delete the
   *  directory. */
  cleanup: () => void;
};

/**
 * Create a store in a new temporary directory, open it for writing as
 * `identity` (default the v1 host) and keep that connection open, then run
 * one read on it, which creates the `-wal` and `-shm` files, and open a
 * reader on it with {@link openReadStore}. `seed` runs on the writer before
 * the reader opens. The caller MUST invoke `cleanup()`.
 */
export async function openScratchReader(
  opts: {
    identity?: StoreIdentity;
    /** The identity the reader opens as (default `identity`). */
    readerIdentity?: StoreIdentity;
    seed?: (writer: Store, db: SqliteDb) => void;
    readOptions?: ReadStoreOptions;
  } = {},
): Promise<ScratchReader> {
  const identity = opts.identity ?? { host: "opencode-v1" };
  const dir = mkdtempSync(join(tmpdir(), "recall-reader-"));
  const path = join(dir, "store.db");
  const writerDb = await openSqlite(path);
  if (!writerDb) throw new Error("openSqlite returned null in test helper");
  const writerOpened = openStore(writerDb, identity);
  if (!writerOpened.ok) throw new Error(`openStore refused: ${writerOpened.reason}`);
  opts.seed?.(writerOpened.store, writerDb);
  // SQLite creates the -wal and -shm files at a connection's first statement
  // in WAL mode, and openStore switches a new store to WAL as its last step.
  writerOpened.store.cardCounters();
  const opened = await openReadStore(path, opts.readerIdentity ?? identity, opts.readOptions);
  return {
    path,
    writer: writerOpened.store,
    writerDb,
    opened,
    cleanup: () => {
      if (opened.ok) opened.close();
      writerDb.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** One store file as {@link storeFileState} saw it: size and a SHA-256 of
 *  its bytes, or `"absent"`. */
export type FileState = { size: number; sha256: string } | "absent";

/**
 * The size and content hash of a store file and its `-wal` and `-shm` files,
 * read by a child process. Reading them in this process would open and close
 * descriptors on the store file, and closing any descriptor of a file drops
 * every POSIX lock this process holds on it, a SQLite connection's included,
 * which would let another process's closing connection checkpoint and delete
 * the WAL under a reader that is still open.
 */
export function storeFileState(path: string): { db: FileState; wal: FileState; shm: FileState } {
  const script = `
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const state = (p) => {
  try {
    const bytes = readFileSync(p);
    return { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
};
const p = process.argv[1];
process.stdout.write(JSON.stringify({ db: state(p), wal: state(p + "-wal"), shm: state(p + "-shm") }));
`;
  const out = execFileSync(process.execPath, ["-e", script, path], { encoding: "utf8" });
  return JSON.parse(out) as { db: FileState; wal: FileState; shm: FileState };
}

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
  /** Both session listings (project and global) succeed with this raw `data`
   *  body instead of the fixture rows (divergent-payload tests). */
  listBody?: unknown;
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
  /** Sessions and messages to serve instead of the fixture's. */
  corpus?: { sessions: Session[]; messagesBySession: Record<string, MessageBundle[]> };
  /** Awaited by session.messages before it answers, as a server's reply
   *  would make the caller wait for I/O. */
  beforeMessages?: () => Promise<void>;
};

export type FakeHarness = {
  client: OpencodeClient;
  unscoped: OpencodeClient;
  /** The v1 history source over the two fake clients (so `calls` still
   *  records every host read). */
  source: HistorySource;
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

/** A v2 Code Mode `execute` part whose metadata records the tools it called
 *  (`state.metadata.toolCalls`, opencode v2 `core/src/codemode/tool.ts`). */
export function executeToolPart(
  id: string,
  sessionID: string,
  messageID: string,
  calledTools: string[],
  output: string,
): Part {
  const part = completedToolPart(id, sessionID, messageID, "execute", { code: "run()" }, output);
  if (part.type === "tool" && part.state.status === "completed") {
    part.state.metadata = {
      toolCalls: calledTools.map((tool) => ({ tool, status: "completed" })),
    };
  }
  return part;
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

/** Decode a fake cursor. A cursor that does not decode rejects rather than
 *  restarting at 0, as the real v1 server's does: the `messages` handler in
 *  opencode's `packages/opencode/src/server/routes/instance/httpapi/handlers/
 *  session.ts` (origin/dev 7945de2) answers 400 BadRequest when
 *  `MessageV2.cursor.decode` throws. The real cursor is a base64url JSON
 *  keyset position, so a well-formed one pages from that position; this
 *  shim's cursor is an index, and an out-of-range one yields an empty page. */
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const decoded = /^[A-Za-z0-9_-]+$/.test(cursor)
    ? Buffer.from(cursor, "base64url").toString("utf8")
    : "";
  if (!/^\d+$/.test(decoded)) throw new Error(`Invalid message cursor: ${cursor}`);
  return Number(decoded);
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
  // Diverges from the real v1 server on purpose (existing tests rely on it):
  // the real global listing (`listGlobal`, opencode session.ts) hides archived
  // sessions, but this fixture's global list includes the archived
  // `projectTwo`. The v2 source follows the real server.
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
  const fixture = options.corpus
    ? { ...options.corpus, globalSessions: options.corpus.sessions.map(globalSessionFrom) }
    : makeFixture();
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
        if ("listBody" in options) return { data: options.listBody as Session[] };
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
        await options.beforeMessages?.();
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
          if ("listBody" in options) return { data: options.listBody as GlobalSession[] };
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

  const scopedClient = client as unknown as OpencodeClient;
  const unscopedClient = unscoped as unknown as OpencodeClient;
  return {
    client: scopedClient,
    unscoped: unscopedClient,
    source: createV1HistorySource({ scoped: scopedClient, unscoped: unscopedClient }),
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
type StoreFixture = {
  sessions?: (Session | GlobalSession)[];
  globalSessions: GlobalSession[];
  messagesBySession: Record<string, { info: Message; parts: Part[] }[]>;
};

/** Derive the card and rows of each session in `ids` (every fixture session
 *  when omitted) from the fixture's current messages and replace them in
 *  the store, as the distiller does. */
function distillFixture(
  store: Store,
  fixture: StoreFixture,
  limits: Limits,
  ids?: readonly string[],
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
    if (ids && !ids.includes(s.id)) continue;
    const { card, rows } = deriveCard({
      session: toDistillMeta(s),
      messages: fixture.messagesBySession[s.id] ?? [],
      parentById,
      caps,
    });
    store.replaceSessionParts(s.id, rows, card);
  }
}

export function seedStore(store: Store, fixture: StoreFixture, limits: Limits = TEST_LIMITS): void {
  distillFixture(store, fixture, limits);
  store.setMeta("cards_rev", "1");
}

/** Re-index one seeded session from the fixture's current messages, as the
 *  distiller does after its history changed: the store gives the card a new
 *  `writeRev`, while the session's `time.updated` stays whatever the fixture
 *  says. */
export function reindexSession(
  store: Store,
  fixture: StoreFixture,
  sessionID: string,
  limits: Limits = TEST_LIMITS,
): void {
  distillFixture(store, fixture, limits, [sessionID]);
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
    /** The search's and the drill's yield point. */
    yieldPoint?: () => Promise<void>;
  } = {},
): Promise<{ deps: SearchDeps; store: Store; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "recall-deps-"));
  const db = await openSqlite(join(dir, "store.db"));
  if (!db) throw new Error("openSqlite returned null in test helper");
  const store = openV1Store(db);
  if (!store) throw new Error("openStore returned null in test helper");
  seedStore(store, fixture, limits);

  const gate = opts.gate ?? createFetchGate({ concurrency: limits.concurrency });
  const cards = createCardsRuntime({
    source: storeCardSource(store, inlineVectorWriter(store)),
    embedder: opts.semantic?.embedder,
    semanticWeight: opts.semantic?.weight,
    now: opts.cardsNow,
    refreshIntervalMs: opts.cardsRefreshIntervalMs,
  });
  const drill = createDrill({
    source: fixture.source,
    gate,
    limits,
    now: opts.now,
    deepWallClockMs: opts.deepWallClockMs,
    yieldPoint: opts.yieldPoint,
  });
  return {
    deps: { gate, store, cards, drill, yieldPoint: opts.yieldPoint },
    store,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Build store-null `recall` deps over the fixture's cards-lite source — the
 *  sibling of {@link makeRecallDeps}, which is unconditionally store-backed
 *  (it throws when SQLite fails) and deliberately stays that way. Used by the
 *  ephemeral search/coverage/scope tests (pass `mode: "ephemeral"`) and by the
 *  driver-missing degraded regression pins (omit `mode`). Nothing touches
 *  disk, so there is no cleanup. */
export function makeStoreNullDeps(
  fixture: FakeHarness,
  limits: Limits = TEST_LIMITS,
  opts: {
    /** Set to build CONFIGURED ephemeral deps; omit for the accidental
     *  driver-missing degraded path (store null, no mode). */
    mode?: "ephemeral";
    /** Ephemeral refresh trigger hook (fire-and-forget at query entry). */
    maybeRefresh?: () => void;
    gate?: FetchGate;
    now?: () => number;
    deepWallClockMs?: number;
    cardsNow?: () => number;
    cardsRefreshIntervalMs?: number;
  } = {},
): { deps: SearchDeps } {
  const gate = opts.gate ?? createFetchGate({ concurrency: limits.concurrency });
  const liteCards = cardsLiteFromSessions(fixture.globalSessions);
  const cards = createCardsRuntime({
    source: { getCards: () => liteCards, revision: () => undefined, degraded: true },
    now: opts.cardsNow,
    refreshIntervalMs: opts.cardsRefreshIntervalMs,
  });
  const drill = createDrill({
    source: fixture.source,
    gate,
    limits,
    now: opts.now,
    deepWallClockMs: opts.deepWallClockMs,
  });
  return {
    deps: {
      gate,
      store: null,
      cards,
      drill,
      ...(opts.mode && { mode: opts.mode }),
      ...(opts.maybeRefresh && { maybeRefresh: opts.maybeRefresh }),
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
