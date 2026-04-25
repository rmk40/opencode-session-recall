import { expect } from "vitest";
import {
  tool,
  type ToolContext,
  type ToolDefinition,
} from "@opencode-ai/plugin";
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

export const PROJECT_DIR = "/workspace/project";
export const OTHER_DIR = "/workspace/other";

export const TEST_LIMITS: Limits = {
  concurrency: 2,
  maxSessions: Infinity,
  maxResults: 50,
  maxSessionList: 100,
  maxMessages: 50,
  maxWindow: 10,
  defaultWidth: 120,
};

type ApiFailure = { data: { message: string } };
type MessageBundle = { info: Message; parts: Part[] };
type MetadataCall = { title?: string; metadata?: Record<string, unknown> };

export type FakeCalls = {
  projectList: Array<{ search?: string; limit?: number }>;
  globalList: Array<{ search?: string; limit?: number }>;
  get: Array<{ sessionID: string }>;
  messages: Array<{ sessionID: string }>;
  message: Array<{ sessionID: string; messageID: string }>;
};

export type FakeOptions = {
  projectListError?: string;
  globalListError?: string;
  messageErrors?: Record<string, string>;
  messageThrows?: Set<string>;
  noMessageData?: Set<string>;
  getThrows?: Set<string>;
  messageLookupErrors?: Record<string, string>;
  noSingleMessageData?: Set<string>;
  afterMessagesCall?: (sessionID: string) => void;
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
): Session {
  return {
    id,
    slug: id,
    projectID: directory === PROJECT_DIR ? "project-main" : "project-other",
    directory,
    title,
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
        : { id: "project-other", name: "other", worktree: OTHER_DIR },
  } as GlobalSession;
}

export function userMessage(
  id: string,
  sessionID: string,
  created: number,
): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "test", modelID: "test-user-model" },
  };
}

export function assistantMessage(
  id: string,
  sessionID: string,
  created: number,
): AssistantMessage {
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

export function textPart(
  id: string,
  sessionID: string,
  messageID: string,
  text: string,
): Part {
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

export function makeFixture(now = Date.now()): {
  sessions: Session[];
  globalSessions: GlobalSession[];
  messagesBySession: Record<string, MessageBundle[]>;
} {
  const current = session(
    "s-current",
    "Current Debugging Session",
    PROJECT_DIR,
    now - 1_000,
  );
  const projectTwo = session(
    "s-project-2",
    "Checkout Cache Investigation",
    PROJECT_DIR,
    now - 2_000,
    now - 500,
  );
  const other = session(
    "s-other",
    "Actualyze Walkthrough",
    OTHER_DIR,
    now - 500,
  );

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
      textPart(
        "p-other-1",
        other.id,
        "m-other-1",
        "Plan walkthrough pages for demo.actualyze.ai.",
      ),
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
    ? sessions.filter((s) =>
        s.title.toLowerCase().includes(search.toLowerCase()),
      )
    : sessions;
  return matching.slice(0, limit);
}

export function makeFakeHarness(options: FakeOptions = {}): FakeHarness {
  const fixture = makeFixture();
  const calls: FakeCalls = {
    projectList: [],
    globalList: [],
    get: [],
    messages: [],
    message: [],
  };

  const client = {
    session: {
      list: async (params?: { search?: string; limit?: number }) => {
        calls.projectList.push({
          search: params?.search,
          limit: params?.limit,
        });
        if (options.projectListError)
          return { error: apiFailure(options.projectListError) };
        return {
          data: filtered(fixture.sessions, params?.search, params?.limit),
        };
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        calls.get.push({ sessionID });
        if (options.getThrows?.has(sessionID))
          throw new Error(`get failed: ${sessionID}`);
        const found = fixture.globalSessions.find((s) => s.id === sessionID);
        return found
          ? { data: found }
          : { error: apiFailure(`Session not found: ${sessionID}`) };
      },
      messages: async ({ sessionID }: { sessionID: string }) => {
        calls.messages.push({ sessionID });
        options.afterMessagesCall?.(sessionID);
        if (options.messageThrows?.has(sessionID))
          throw new Error(`thrown messages: ${sessionID}`);
        if (options.messageErrors?.[sessionID]) {
          return { error: apiFailure(options.messageErrors[sessionID]) };
        }
        if (options.noMessageData?.has(sessionID)) return {};
        const data = fixture.messagesBySession[sessionID];
        return data ? { data } : { error: apiFailure(`Unauthorized`) };
      },
      message: async ({
        sessionID,
        messageID,
      }: {
        sessionID: string;
        messageID: string;
      }) => {
        calls.message.push({ sessionID, messageID });
        const key = `${sessionID}:${messageID}`;
        if (options.messageLookupErrors?.[key]) {
          return { error: apiFailure(options.messageLookupErrors[key]) };
        }
        if (options.noSingleMessageData?.has(key)) return {};
        const found = fixture.messagesBySession[sessionID]?.find(
          (m) => m.info.id === messageID,
        );
        return found
          ? { data: found }
          : { error: apiFailure(`Message not found: ${messageID}`) };
      },
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
          if (options.globalListError)
            return { error: apiFailure(options.globalListError) };
          return {
            data: filtered(
              fixture.globalSessions,
              params?.search,
              params?.limit,
            ),
          };
        },
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

export async function runTool<T extends { ok: boolean }>(
  definition: ToolDefinition,
  rawArgs: Record<string, unknown>,
  ctx = makeContext().ctx,
): Promise<T> {
  const parsedArgs = tool.schema.object(definition.args).parse(rawArgs);
  const raw = await definition.execute(parsedArgs, ctx);
  const parsed = JSON.parse(raw) as T;
  expect(parsed).toHaveProperty("ok");
  return parsed;
}
