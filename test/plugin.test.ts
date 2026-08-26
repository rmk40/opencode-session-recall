import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tool, type Hooks, type PluginInput, type ToolDefinition } from "@opencode-ai/plugin";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "../src/types.js";
import { openSqlite } from "../src/sqlite.js";
import { openStore } from "../src/store.js";
import { bundle, PROJECT_DIR, textPart, userMessage } from "./helpers.js";

const createOpencodeClient = vi.hoisted(() => vi.fn((options: unknown) => options));
const sqliteLifecycle = vi.hoisted(() => ({ closes: 0, postCloseCalls: 0 }));

vi.mock("@opencode-ai/sdk/v2", () => ({ createOpencodeClient }));

vi.mock("../src/sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sqlite.js")>();
  return {
    ...actual,
    openSqlite: async (...args: Parameters<typeof actual.openSqlite>) => {
      const db = await actual.openSqlite(...args);
      if (!db) return db;
      let closed = false;
      return new Proxy(db, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          if (property === "close") {
            return () => {
              sqliteLifecycle.closes++;
              closed = true;
              return value.call(target);
            };
          }
          return (...methodArgs: unknown[]) => {
            if (closed) sqliteLifecycle.postCloseCalls++;
            return value.apply(target, methodArgs);
          };
        },
      });
    },
  };
});

// Mock the semantic embedder so the wiring test never downloads a model or
// touches the network: init resolves immediately and the model stays unready.
vi.mock("../src/semantic/embedder.js", () => ({
  SemanticEmbedder: class {
    ready = false;
    initError: string | undefined = "mocked: init not run";
    constructor(public model: string) {}
    async init(): Promise<void> {}
    embed(): Float32Array | undefined {
      return undefined;
    }
  },
}));

const plugin = await import("../src/opencode-session-recall.js");
const activeHooks: Hooks[] = [];

// Every entry call opens a card store and (with coldPass) starts a background
// distiller. Default tests use an in-memory store with the cold pass off so they
// exercise only wiring, with no filesystem side effect or leaked timers.
async function server(input: PluginInput, opts: Record<string, unknown> = {}) {
  const hooks = await plugin.default.server(input, {
    storePath: ":memory:",
    coldPass: false,
    ...opts,
  });
  activeHooks.push(hooks);
  return hooks;
}

function mustTool(definition: ToolDefinition | undefined): ToolDefinition {
  if (!definition) throw new Error("missing tool definition");
  return definition;
}

function schemaDescription(value: unknown): string {
  if (!value || typeof value !== "object" || !("description" in value)) return "";
  const description = (value as { description?: unknown }).description;
  return typeof description === "string" ? description : "";
}

function llmFacingChars(definition: ToolDefinition): number {
  return (
    definition.description.length +
    Object.values(definition.args).reduce((total, arg) => total + schemaDescription(arg).length, 0)
  );
}

function ctx(config: {
  baseUrl?: string;
  fetch?: unknown;
  headers?: Record<string, string>;
}): PluginInput {
  return {
    client: { _client: { getConfig: () => config } },
    directory: PROJECT_DIR,
    worktree: PROJECT_DIR,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: {},
  } as unknown as PluginInput;
}

describe("plugin entry", () => {
  beforeEach(() => {
    createOpencodeClient.mockClear();
    sqliteLifecycle.closes = 0;
    sqliteLifecycle.postCloseCalls = 0;
  });

  afterEach(async () => {
    await Promise.all(activeHooks.splice(0).map((hooks) => hooks.dispose?.()));
  });

  it("registers all tools and strips project scoping only from the unscoped client", async () => {
    const fetch = vi.fn();
    const headers = {
      "x-opencode-directory": PROJECT_DIR,
      authorization: "Bearer test",
    };

    const hooks = await server(ctx({ baseUrl: "http://server", fetch, headers }), {});

    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([...TOOLS].sort());
    expect(createOpencodeClient).toHaveBeenNthCalledWith(1, {
      baseUrl: "http://server",
      fetch,
      headers,
      directory: PROJECT_DIR,
    });
    expect(createOpencodeClient).toHaveBeenNthCalledWith(2, {
      baseUrl: "http://server",
      fetch,
      headers: { authorization: "Bearer test" },
    });
  });

  it("registers the system nudge by default and omits opt-in hooks", async () => {
    const hooks = await server(ctx({ fetch: vi.fn() }), {});
    expect(hooks["experimental.chat.system.transform"]).toBeDefined();
    expect(hooks["chat.message"]).toBeUndefined();
    expect(hooks["experimental.session.compacting"]).toBeUndefined();
  });

  it("omits the nudge when nudge:false and enables opt-in hooks when requested", async () => {
    const off = await server(ctx({ fetch: vi.fn() }), { nudge: false });
    expect(off["experimental.chat.system.transform"]).toBeUndefined();

    const on = await server(ctx({ fetch: vi.fn() }), {
      autoRecall: true,
      compactionRecall: true,
    });
    expect(on["chat.message"]).toBeDefined();
    expect(on["experimental.session.compacting"]).toBeDefined();
  });

  it("distiller cold pass discovers and distills visible history at init", async () => {
    // prewarm is now a no-op; the distiller cold pass (coldPass, default on) is
    // what discovers the session list and fetches each session's messages.
    const listGlobal = vi.fn(async () => ({
      data: [{ id: "s1", title: "T", directory: PROJECT_DIR, time: { created: 1, updated: 2 } }],
    }));
    const messages = vi.fn(async () => ({ data: [] }));
    createOpencodeClient
      .mockImplementationOnce((options: unknown) => ({
        ...(options as object),
        session: { messages, list: vi.fn(async () => ({ data: [] })) },
      }))
      .mockImplementationOnce((options: unknown) => ({
        ...(options as object),
        experimental: { session: { list: listGlobal } },
      }));

    await server(ctx({ fetch: vi.fn() }), { coldPass: true });
    await vi.waitFor(() => expect(listGlobal).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(messages).toHaveBeenCalledWith(expect.objectContaining({ sessionID: "s1" })),
    );
  });

  it("wires the semantic layer and swallows a failed init (no network)", async () => {
    const hooks = await server(ctx({ fetch: vi.fn() }), {
      semantic: true,
      autoRecall: true,
      compactionRecall: true,
    });
    // All tools register and both search-running hooks are present, proving the
    // semantic option threads through construction even when the model never
    // becomes ready.
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([...TOOLS].sort());
    expect(hooks["chat.message"]).toBeDefined();
    expect(hooks["experimental.session.compacting"]).toBeDefined();
  });

  it("deduplicates primary tools and honors primary:false", async () => {
    const hooks = await server(ctx({ fetch: vi.fn() }), {});
    const config = {
      experimental: { primary_tools: ["existing_tool", "recall"] },
    };
    await hooks.config?.(config);
    expect(config.experimental.primary_tools).toEqual(["existing_tool", ...TOOLS]);

    const withoutPrimary = await server(ctx({ fetch: vi.fn() }), {
      primary: false,
    });
    expect(withoutPrimary.config).toBeUndefined();
  });

  it("keeps LLM-facing tool instructions compact", async () => {
    const hooks = await server(ctx({ fetch: vi.fn() }), {});
    const definitions = Object.values(hooks.tool ?? {});
    const totalChars = definitions.reduce(
      (total, definition) => total + llmFacingChars(definition),
      0,
    );

    // Raised from 9,000/5,000 with the retrieval-efficiency plan (a decision,
    // not drift): the recall description now carries the exclusion default,
    // the prior-workflow recipe, and the new parameters.
    expect(totalChars).toBeLessThan(11_000);
    expect(llmFacingChars(mustTool(hooks.tool?.recall))).toBeLessThan(6_500);
  });

  it("clamps plugin limits into LLM-facing schemas", async () => {
    const hooks = await server(ctx({ fetch: vi.fn() }), {
      maxResults: 2.9,
      maxSessions: 2.9,
      maxMessages: 3.2,
      maxWindow: 1.8,
      maxSessionList: 4.1,
    });

    const recallArgs = tool.schema.object(mustTool(hooks.tool?.recall).args);
    expect(recallArgs.parse({ query: "rate" }).sessions).toBeUndefined();
    expect(() => recallArgs.parse({ query: "rate", results: 2 })).not.toThrow();
    expect(() => recallArgs.parse({ query: "rate", results: 3 })).toThrow();
    expect(() => recallArgs.parse({ query: "rate", sessionLimit: 2 })).not.toThrow();
    expect(() => recallArgs.parse({ query: "rate", sessionLimit: 3 })).toThrow();
    expect(recallArgs.parse({ query: "rate" }).window).toBe(1);
    expect(() => recallArgs.parse({ query: "rate", window: 1 })).not.toThrow();
    expect(() => recallArgs.parse({ query: "rate", window: 2 })).not.toThrow();
    expect(() => recallArgs.parse({ query: "rate", window: "auto" })).not.toThrow();
    expect(() => recallArgs.parse({ query: "rate", expandResults: 3 })).not.toThrow();
    expect(() => recallArgs.parse({ query: "rate", expandResults: 4 })).not.toThrow();

    const messagesArgs = tool.schema.object(mustTool(hooks.tool?.recall_messages).args);
    expect(() => messagesArgs.parse({ limit: 3 })).not.toThrow();
    expect(() => messagesArgs.parse({ limit: 4 })).toThrow();

    const contextArgs = tool.schema.object(mustTool(hooks.tool?.recall_context).args);
    expect(() => contextArgs.parse({ sessionID: "s", messageID: "m", window: 1 })).not.toThrow();
    expect(() => contextArgs.parse({ sessionID: "s", messageID: "m", window: 2 })).toThrow();
    expect(() => contextArgs.parse({ sessionID: "s", messageID: "m", before: 2 })).toThrow();
    expect(() => contextArgs.parse({ sessionID: "s", messageID: "m", after: 2 })).toThrow();

    const sessionsArgs = tool.schema.object(mustTool(hooks.tool?.recall_sessions).args);
    expect(() => sessionsArgs.parse({ limit: 4 })).not.toThrow();
    expect(() => sessionsArgs.parse({ limit: 5 })).toThrow();
  });

  it("waits for an in-flight cold-pass fetch before closing SQLite", async () => {
    let resolveMessages: ((value: { data: [] }) => void) | undefined;
    const messages = vi.fn(
      () =>
        new Promise<{ data: [] }>((resolve) => {
          resolveMessages = resolve;
        }),
    );
    createOpencodeClient
      .mockImplementationOnce((options: unknown) => ({
        ...(options as object),
        session: { messages, list: vi.fn(async () => ({ data: [] })) },
      }))
      .mockImplementationOnce((options: unknown) => ({
        ...(options as object),
        experimental: {
          session: {
            list: vi.fn(async () => ({
              data: [
                {
                  id: "s1",
                  title: "T",
                  directory: PROJECT_DIR,
                  time: { created: 1, updated: 2 },
                },
              ],
            })),
          },
        },
      }));
    const hooks = await server(ctx({ fetch: vi.fn() }), { coldPass: true });
    await vi.waitFor(() => expect(messages).toHaveBeenCalled());

    let disposed = false;
    const stopping = hooks.dispose?.().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(sqliteLifecycle.closes).toBe(0);

    resolveMessages?.({ data: [] });
    await stopping;
    expect(sqliteLifecycle.closes).toBe(1);
    expect(sqliteLifecycle.postCloseCalls).toBe(0);
  });

  it("dispose completes within its bound when an SDK request never settles", async () => {
    // The host awaits dispose as a shutdown finalizer with no timeout of its
    // own; a never-settling in-flight fetch must not hang shutdown forever.
    // The timeout still closes SQLite: every write path is stopped/finalized-
    // guarded, so the detached fetch can never reach the store.
    vi.useFakeTimers();
    try {
      const messages = vi.fn(() => new Promise<never>(() => {}));
      createOpencodeClient
        .mockImplementationOnce((options: unknown) => ({
          ...(options as object),
          session: { messages, list: vi.fn(async () => ({ data: [] })) },
        }))
        .mockImplementationOnce((options: unknown) => ({
          ...(options as object),
          experimental: {
            session: {
              list: vi.fn(async () => ({
                data: [
                  {
                    id: "s1",
                    title: "T",
                    directory: PROJECT_DIR,
                    time: { created: 1, updated: 2 },
                  },
                ],
              })),
            },
          },
        }));
      const hooks = await server(ctx({ fetch: vi.fn() }), { coldPass: true });
      for (let i = 0; i < 100 && messages.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
      expect(messages).toHaveBeenCalled();

      let disposed = false;
      const stopping = hooks.dispose?.().then(() => {
        disposed = true;
      });
      await Promise.resolve();
      expect(disposed).toBe(false);

      // Total dispose stays under ~20s worst case even though the SDK request
      // never settles; SQLite is still closed exactly once, with no post-close
      // access from the detached fetch.
      await vi.advanceTimersByTimeAsync(20_000);
      await stopping;
      expect(disposed).toBe(true);
      expect(sqliteLifecycle.closes).toBe(1);
      expect(sqliteLifecycle.postCloseCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes idempotently and rejects tools without touching SQLite afterwards", async () => {
    const hooks = await server(ctx({ fetch: vi.fn() }), {});

    const first = hooks.dispose?.();
    const second = hooks.dispose?.();
    expect(second).toBe(first);
    await first;
    expect(sqliteLifecycle.closes).toBe(1);

    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: "s" } },
    } as never);
    // Disposed-tool calls return the codebase's JSON error-output shape, not a
    // rejection (every other failure path resolves `{ ok:false, error }`).
    const out = await mustTool(hooks.tool?.recall_sessions).execute({}, {} as never);
    expect(JSON.parse(out as string)).toEqual({
      ok: false,
      error: "opencode-session-recall: plugin has been disposed",
    });
    expect(sqliteLifecycle.closes).toBe(1);
    expect(sqliteLifecycle.postCloseCalls).toBe(0);
  });

  it("cancels scheduler timers before closing SQLite", async () => {
    vi.useFakeTimers();
    try {
      createOpencodeClient
        .mockImplementationOnce((options: unknown) => ({
          ...(options as object),
          session: { messages: vi.fn(async () => ({ data: [] })) },
        }))
        .mockImplementationOnce((options: unknown) => ({
          ...(options as object),
          experimental: { session: { list: vi.fn(async () => ({ data: [] })) } },
        }));
      const hooks = await server(ctx({ fetch: vi.fn() }), { coldPass: true });

      await hooks.dispose?.();
      expect(sqliteLifecycle.closes).toBe(1);
      await vi.advanceTimersByTimeAsync(20_000);

      expect(sqliteLifecycle.closes).toBe(1);
      expect(sqliteLifecycle.postCloseCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the distill lease until active summarizer cleanup finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-plugin-handoff-"));
    const storePath = join(dir, "recall.sqlite");
    let resolvePrompt: ((value: unknown) => void) | undefined;
    const prompt = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    const deleteWorker = vi.fn(async () => ({ data: true }));
    const messages = vi.fn(async () => ({
      data: [
        bundle(userMessage("m1", "s1", 1), [
          textPart("p1", "s1", "m1", "Summarize this lease handoff session."),
        ]),
      ],
    }));
    createOpencodeClient
      .mockImplementationOnce((options: unknown) => ({
        ...(options as object),
        session: {
          messages,
          list: vi.fn(async () => ({ data: [] })),
          create: vi.fn(async () => ({ data: { id: "worker-1" } })),
          prompt,
          delete: deleteWorker,
          abort: vi.fn(async () => ({ data: true })),
        },
      }))
      .mockImplementationOnce((options: unknown) => ({
        ...(options as object),
        experimental: {
          session: {
            list: vi.fn(async () => ({
              data: [
                {
                  id: "s1",
                  title: "Lease handoff",
                  directory: PROJECT_DIR,
                  time: { created: 1, updated: 2 },
                },
              ],
            })),
          },
        },
      }));

    let rivalDb: Awaited<ReturnType<typeof openSqlite>> = null;
    try {
      const hooks = await server(ctx({ fetch: vi.fn() }), {
        storePath,
        coldPass: true,
        summaries: { enabled: true, model: "test/cheap" },
      });
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());

      const stopping = hooks.dispose?.();
      await Promise.resolve();
      rivalDb = await openSqlite(storePath);
      if (!rivalDb) throw new Error("failed to open rival store");
      const rival = openStore(rivalDb);
      if (!rival) throw new Error("failed to initialize rival store");
      expect(rival.acquireLease("rival", 60_000, "test", 1)).toBe(false);

      resolvePrompt?.({ data: { info: {}, parts: [{ type: "text", text: "[]" }] } });
      await stopping;
      expect(deleteWorker).toHaveBeenCalledWith({ sessionID: "worker-1" });
      expect(rival.acquireLease("rival", 60_000, "test", 1)).toBe(true);
    } finally {
      rivalDb?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("quiesces immediately but renews the lease only until blocked cleanup times out", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const dir = mkdtempSync(join(tmpdir(), "recall-plugin-bounded-cleanup-"));
    const storePath = join(dir, "recall.db");
    let resolveDelete: ((value: { data: true }) => void) | undefined;
    try {
      const coldSession = {
        id: "s1",
        title: "Cold session",
        slug: "cold-session",
        directory: PROJECT_DIR,
        projectID: "p",
        time: { created: 1000, updated: 2000 },
      };
      const getSession = vi.fn(async () => ({ data: coldSession }));
      const messages = vi.fn(async () => ({
        data: [
          bundle(userMessage("m1", "s1", 1100), [
            textPart("p1", "s1", "m1", "bounded cleanup source"),
          ]),
        ],
      }));
      const deleteWorker = vi.fn(
        () =>
          new Promise<{ data: true }>((resolve) => {
            resolveDelete = resolve;
          }),
      );
      const scopedClient = {
        session: {
          get: getSession,
          messages,
          list: vi.fn(async () => ({ data: [] })),
          create: vi.fn(async () => ({ data: { id: "blocked-worker" } })),
          prompt: vi.fn(async () => ({
            data: {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "[]" }],
            },
          })),
          delete: deleteWorker,
          abort: vi.fn(async () => ({ data: true })),
        },
      };
      const discover = vi.fn(async () => ({ data: [coldSession] }));
      const unscopedClient = { experimental: { session: { list: discover } } };
      createOpencodeClient.mockReturnValueOnce(scopedClient).mockReturnValueOnce(unscopedClient);

      const hooks = await server(ctx({ fetch: vi.fn() }), {
        storePath,
        coldPass: true,
        summaries: { enabled: true, model: "test/cheap" },
      });
      for (let i = 0; i < 100 && deleteWorker.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
      expect(deleteWorker).toHaveBeenCalledWith({ sessionID: "blocked-worker" });

      // Queue incremental work immediately before disposal. Quiescence must
      // cancel it synchronously even though summarizer cleanup is still blocked.
      await hooks.event?.({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      } as Parameters<NonNullable<Hooks["event"]>>[0]);
      let disposed = false;
      const stopping = hooks.dispose?.().then(() => {
        disposed = true;
      });
      expect(stopping).toBeDefined();

      const rivalDb = await openSqlite(storePath);
      if (!rivalDb) throw new Error("openSqlite returned null for rival");
      const rival = openStore(rivalDb);
      if (!rival) throw new Error("openStore returned null for rival");
      const initialLease = rival.leaseStatus();
      expect(initialLease).toBeDefined();
      expect(rival.acquireLease("rival", 60_000, "test", 1)).toBe(false);

      await vi.advanceTimersByTimeAsync(10_000);
      const renewedLease = rival.leaseStatus();
      expect(renewedLease?.heartbeat).toBeGreaterThan(initialLease?.heartbeat ?? 0);
      expect(disposed).toBe(false);
      expect(rival.acquireLease("rival", 60_000, "test", 1)).toBe(false);
      expect(discover).toHaveBeenCalledTimes(1);
      expect(messages).toHaveBeenCalledTimes(1);
      expect(getSession).not.toHaveBeenCalled();

      // Summarizer shutdown is bounded. Once its timeout expires, distiller
      // finalization releases the lease and disposal closes the old DB.
      await vi.advanceTimersByTimeAsync(5_001);
      await stopping;
      expect(disposed).toBe(true);
      expect(rival.acquireLease("rival", 60_000, "test", 1)).toBe(true);
      expect(discover).toHaveBeenCalledTimes(1);
      expect(messages).toHaveBeenCalledTimes(1);
      expect(getSession).not.toHaveBeenCalled();
      expect(sqliteLifecycle.postCloseCalls).toBe(0);

      // The SDK promise itself cannot be cancelled. Its late settlement only
      // releases the fetch-gate permit and cannot touch SQLite or another worker.
      resolveDelete?.({ data: true });
      await Promise.resolve();
      expect(sqliteLifecycle.postCloseCalls).toBe(0);
      rivalDb.close();
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails clearly if SDK internals needed for transport extraction change", async () => {
    await expect(server({ client: {} } as unknown as PluginInput, {})).rejects.toThrow(
      "SDK internals changed",
    );

    await expect(server(ctx({}), {})).rejects.toThrow("SDK client has no custom fetch");
  });
});
