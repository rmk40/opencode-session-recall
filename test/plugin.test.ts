import { beforeEach, describe, expect, it, vi } from "vitest";
import { tool, type PluginInput, type ToolDefinition } from "@opencode-ai/plugin";
import { TOOLS } from "../src/types.js";
import { PROJECT_DIR } from "./helpers.js";

const createOpencodeClient = vi.hoisted(() => vi.fn((options: unknown) => options));

vi.mock("@opencode-ai/sdk/v2", () => ({ createOpencodeClient }));

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

// Every entry call opens a card store and (with coldPass) starts a background
// distiller. Default tests use an in-memory store with the cold pass off so they
// exercise only wiring, with no filesystem side effect or leaked timers.
function server(input: PluginInput, opts: Record<string, unknown> = {}) {
  return plugin.default.server(input, { storePath: ":memory:", coldPass: false, ...opts });
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

  it("fails clearly if SDK internals needed for transport extraction change", async () => {
    await expect(server({ client: {} } as unknown as PluginInput, {})).rejects.toThrow(
      "SDK internals changed",
    );

    await expect(server(ctx({}), {})).rejects.toThrow("SDK client has no custom fetch");
  });
});
