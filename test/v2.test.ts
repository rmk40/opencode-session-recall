import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCode, type SessionInfo, type SessionMessageInfo } from "@opencode/client";
import plugin from "../src/opencode-session-recall.js";
import { connect, historyClient, normalizeMessage, normalizeSession } from "../src/v2-client.js";
import { Service } from "@opencode/client/service";
import { fetchMessagePage } from "../src/distill.js";
import { searchableFields } from "../src/extract.js";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { homedir } from "node:os";

vi.mock("@opencode-ai/sdk/v2", () => {
  throw new Error("V2 must not load the legacy SDK transport");
});

const info: SessionInfo = {
  id: "ses_v2",
  projectID: "project",
  title: "V2 pagination needle",
  location: { directory: "C:/project" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
};
const user: SessionMessageInfo = {
  id: "msg_user",
  type: "user",
  text: "Human requirement needle",
  time: { created: 1 },
};
const assistant: SessionMessageInfo = {
  id: "msg_assistant",
  type: "assistant",
  agent: "build",
  model: { providerID: "test", id: "model" },
  time: { created: 2 },
  content: [
    { type: "reasoning", text: "reasoning needle" },
    {
      type: "tool",
      id: "call_1",
      name: "shell",
      time: { created: 2, completed: 3 },
      state: {
        status: "completed",
        input: { command: "echo needle" },
        content: [{ type: "text", text: "output needle" }],
      },
    },
  ],
};

type Context = Parameters<typeof plugin.setup>[0];
type Editor = Parameters<Parameters<Context["tool"]["transform"]>[0]>[0];
type Definition = Parameters<Editor["add"]>[0];

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

describe("V2 history boundary", () => {
  it.each(["local", "custom/channel"])(
    "discovers the host's %s channel registration",
    async (channel) => {
      const discover = vi.spyOn(Service, "discover").mockResolvedValue(undefined);
      const ensure = vi.spyOn(Service, "ensure");
      const getClient = connect("2.0.26", undefined, channel);
      expect(discover).not.toHaveBeenCalled();
      await expect(getClient()).rejects.toThrow("options.server");
      expect(discover).toHaveBeenCalledWith({
        version: "2.0.26",
        file: path.join(
          process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"),
          "opencode",
          `service-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`,
        ),
      });
      expect(ensure).not.toHaveBeenCalled();
    },
  );

  it.each(["latest", "dev", "beta", "next"])(
    "keeps default discovery for the %s channel",
    async (channel) => {
      const discover = vi.spyOn(Service, "discover").mockResolvedValue(undefined);
      await expect(connect("2.0.26", undefined, channel)()).rejects.toThrow("options.server");
      expect(discover).toHaveBeenCalledWith({ version: "2.0.26" });
    },
  );

  it("discovers lazily without starting or replacing the background service", async () => {
    const discover = vi.spyOn(Service, "discover").mockResolvedValue(undefined);
    const ensure = vi.spyOn(Service, "ensure");
    const getClient = connect("2.0.26");
    expect(discover).not.toHaveBeenCalled();
    await expect(getClient()).rejects.toThrow("options.server");
    expect(discover).toHaveBeenCalledWith({ version: "2.0.26" });
    expect(ensure).not.toHaveBeenCalled();
  });
  it("maps session location and preserves human, reasoning and tool evidence", () => {
    expect(normalizeSession(info).directory).toBe("C:/project");
    expect(normalizeMessage(user, info.id).parts[0]).toMatchObject({
      type: "text",
      text: user.text,
      synthetic: false,
    });
    const result = normalizeMessage(assistant, info.id);
    expect(result.info.role).toBe("assistant");
    expect(result.parts.flatMap(searchableFields).map((field) => field.text)).toEqual(
      expect.arrayContaining(["reasoning needle", "output needle", "echo needle"]),
    );
    expect(result.parts[1]?.id).toBe("call_1");
  });

  it("keeps host-injected text distinct from human text and preserves compaction summaries", () => {
    expect(
      normalizeMessage(
        { id: "msg_injected", type: "synthetic", text: "injected needle", time: { created: 1 } },
        info.id,
      ).parts[0],
    ).toMatchObject({ synthetic: true });
    const compacted = normalizeMessage(
      {
        id: "msg_compaction",
        type: "compaction",
        status: "completed",
        reason: "auto",
        time: { created: 1 },
        summary: "summary needle",
        recent: "msg_user",
      },
      info.id,
    );
    expect(compacted.info).toMatchObject({ role: "assistant", summary: true });
    expect(compacted.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "compaction" }),
        expect.objectContaining({ text: "summary needle" }),
      ]),
    );
  });

  it("uses V2 JSON cursors with bounded newest-first message requests", async () => {
    const calls: URL[] = [];
    const client = OpenCode.make({
      baseUrl: "http://test",
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        calls.push(url);
        return Response.json(
          url.searchParams.has("cursor")
            ? { data: [user], cursor: {} }
            : { data: [assistant], cursor: { next: "older-page" } },
        );
      },
    });
    const adapter = historyClient(async () => client);
    const first = await fetchMessagePage(adapter, { sessionID: info.id, limit: 1 });
    expect(first.nextCursor).toBe("older-page");
    const second = await fetchMessagePage(adapter, {
      sessionID: info.id,
      limit: 1,
      before: first.nextCursor!,
    });
    expect(second.items[0]?.info.id).toBe("msg_user");
    expect(second.nextCursor).toBeNull();
    expect(calls[0]?.pathname).toBe("/api/session/ses_v2/message");
    expect(calls[0]?.searchParams.get("order")).toBe("desc");
    expect(calls[1]?.searchParams.get("cursor")).toBe("older-page");
    expect(calls.every((url) => url.searchParams.get("limit") === "1")).toBe(true);
    await expect(adapter.session.messages({ sessionID: info.id } as never)).rejects.toThrow(
      "bounded",
    );
  });

  it("paginates discovery and applies directory scope only to project listings", async () => {
    const calls: URL[] = [];
    const client = OpenCode.make({
      baseUrl: "http://test",
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        calls.push(url);
        return Response.json({
          data: [info],
          cursor: url.searchParams.has("cursor") ? {} : { next: "next" },
        });
      },
    });
    await historyClient(async () => client, "C:/project").session.list({ limit: 2 });
    await historyClient(async () => client).experimental.session.list({ limit: 1 });
    expect(calls[0]?.searchParams.get("directory")).toBe("C:/project");
    expect(calls[1]?.searchParams.get("cursor")).toBe("next");
    expect(calls[2]?.searchParams.has("directory")).toBe(false);
  });

  it("uses deny-all workers and transient generation for opt-in summaries", async () => {
    const calls: Array<{ url: URL; body?: unknown }> = [];
    const client = OpenCode.make({
      baseUrl: "http://test",
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        calls.push({
          url,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        if (url.pathname === "/api/session") return Response.json({ data: info });
        if (url.pathname.endsWith("/generate"))
          return Response.json({ data: { text: "summary result" } });
        if (url.pathname.endsWith("/interrupt")) return Response.json({ interrupted: true });
        return new Response(null, { status: 204 });
      },
    });
    const adapter = historyClient(async () => client, "C:/project");
    await adapter.session.create({ title: "[recall-summarizer] test" });
    const result = await adapter.session.prompt({
      sessionID: info.id,
      model: { providerID: "test", modelID: "model" },
      system: "Summarize cards",
      parts: [{ type: "text", text: "card text" }],
    });
    await adapter.session.abort({ sessionID: info.id });
    expect(calls[0]?.body).toMatchObject({
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
    });
    expect(calls.find((call) => call.url.pathname.endsWith("/model"))?.body).toEqual({
      model: { providerID: "test", id: "model" },
    });
    expect(calls.find((call) => call.url.pathname.endsWith("/generate"))?.body).toEqual({
      prompt: "Summarize cards\n\ncard text",
    });
    expect(calls.at(-1)?.url.searchParams.get("resume")).toBe("false");
    expect(result.data).toEqual({ parts: [{ type: "text", text: "summary result" }] });
  });

  it("loads the V2 definition and executes registered tools through a real HTTP client", async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      const url = new URL(req.url!, "http://test");
      if (url.pathname === "/api/session/ses_v2") res.end(JSON.stringify({ data: info }));
      else if (url.pathname === "/api/session")
        res.end(JSON.stringify({ data: [info, { ...info, id: "ses_prior" }], cursor: {} }));
      else if (url.pathname === "/api/session/ses_v2/message/msg_user")
        res.end(JSON.stringify({ data: user }));
      else if (url.pathname === "/api/session/ses_v2/message")
        res.end(JSON.stringify({ data: [assistant, user], cursor: {} }));
      else {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: "not found" }));
      }
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    const definitions = new Map<string, Definition>();
    const hook = vi.fn<(name: string, callback: unknown) => Promise<unknown>>(async () => ({
      dispose: async () => {},
    }));
    let unsubscribed = false;
    const cleanup = await plugin.setup({
      app: { version: "2.0.26" },
      location: { directory: "C:/project" },
      options: {
        mode: "ephemeral",
        coldPass: false,
        autoRecall: true,
        compactionRecall: true,
        server: { url: `http://127.0.0.1:${address.port}` },
      },
      tool: {
        transform: async (transform: (editor: Editor) => void) => {
          transform({
            add: (definition: Definition) => definitions.set(definition.name, definition),
          } as unknown as Editor);
        },
      },
      session: { get: async () => info, hook },
      event: {
        async *subscribe({ signal }: { signal: AbortSignal }) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          unsubscribed = true;
          yield* [];
        },
      },
    } as unknown as Context);
    try {
      expect(plugin.server).toBeTypeOf("function");
      expect(definitions.size).toBe(5);
      expect(definitions.get("recall")?.input).toMatchObject({
        type: "object",
        required: ["query"],
      });
      const context = {
        sessionID: info.id,
        messageID: "msg_call",
        agent: "build",
        signal: new AbortController().signal,
        progress: async () => {},
      };
      for (const [name, input] of [
        ["recall_sessions", {}],
        ["recall_messages", {}],
        ["recall_get", { sessionID: info.id, messageID: "msg_user" }],
        ["recall_context", { sessionID: info.id, messageID: "msg_user" }],
        ["recall", { query: "needle", scope: "session" }],
      ] as const) {
        const result = await definitions.get(name)!.execute(input, context as never);
        expect(typeof result.content).toBe("string");
        expect(JSON.parse(result.content as string), `${name}: ${result.content}`).toMatchObject({
          ok: true,
        });
      }
      expect(hook.mock.calls.map((call) => call[0])).toEqual(["context", "compaction"]);
      const contextHook = hook.mock.calls.find((call) => call[0] === "context")?.[1] as (
        event: unknown,
      ) => Promise<void>;
      const event = {
        sessionID: info.id,
        model: assistant.model,
        system: [] as Array<{ type: string; text: string }>,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What did we decide last time about pagination needle?" },
            ],
          },
        ],
      };
      await contextHook(event);
      expect(event.system.some((part) => part.text.includes("[recall-nudge]"))).toBe(true);
      expect(event.system.some((part) => part.text.includes("<recall-auto>"))).toBe(true);
      expect(event.messages[0]?.content).toHaveLength(1);
      expect(requests.some((url) => url.includes("/message?limit="))).toBe(true);
      expect(requests.every((url) => url.startsWith("/api/"))).toBe(true);
    } finally {
      await cleanup?.();
    }
    expect(unsubscribed).toBe(true);
  }, 15_000);
});
