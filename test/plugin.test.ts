import { beforeEach, describe, expect, it, vi } from "vitest";
import { tool, type PluginInput, type ToolDefinition } from "@opencode-ai/plugin";
import { TOOLS } from "../src/types.js";
import { PROJECT_DIR } from "./helpers.js";

const createOpencodeClient = vi.hoisted(() => vi.fn((options: unknown) => options));

vi.mock("@opencode-ai/sdk/v2", () => ({ createOpencodeClient }));

const plugin = await import("../src/opencode-session-recall.js");

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

    const hooks = await plugin.default.server(
      ctx({ baseUrl: "http://server", fetch, headers }),
      {},
    );

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

  it("deduplicates primary tools and honors primary:false", async () => {
    const hooks = await plugin.default.server(ctx({ fetch: vi.fn() }), {});
    const config = {
      experimental: { primary_tools: ["existing_tool", "recall"] },
    };
    await hooks.config?.(config);
    expect(config.experimental.primary_tools).toEqual(["existing_tool", ...TOOLS]);

    const withoutPrimary = await plugin.default.server(ctx({ fetch: vi.fn() }), {
      primary: false,
    });
    expect(withoutPrimary.config).toBeUndefined();
  });

  it("keeps LLM-facing tool instructions compact", async () => {
    const hooks = await plugin.default.server(ctx({ fetch: vi.fn() }), {});
    const definitions = Object.values(hooks.tool ?? {});
    const totalChars = definitions.reduce(
      (total, definition) => total + llmFacingChars(definition),
      0,
    );

    expect(totalChars).toBeLessThan(9_000);
    expect(llmFacingChars(mustTool(hooks.tool?.recall))).toBeLessThan(5_000);
  });

  it("clamps plugin limits into LLM-facing schemas", async () => {
    const hooks = await plugin.default.server(ctx({ fetch: vi.fn() }), {
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
    expect(() => recallArgs.parse({ query: "rate", sessions: 2 })).not.toThrow();
    expect(() => recallArgs.parse({ query: "rate", sessions: 3 })).toThrow();
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
    await expect(
      plugin.default.server({ client: {} } as unknown as PluginInput, {}),
    ).rejects.toThrow("SDK internals changed");

    await expect(plugin.default.server(ctx({}), {})).rejects.toThrow(
      "SDK client has no custom fetch",
    );
  });
});
