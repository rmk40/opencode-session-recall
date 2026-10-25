import {
  OpenCode,
  type OpenCodeClient,
  type SessionInfo,
  type SessionMessageInfo,
} from "@opencode/client";
import { Service } from "@opencode/client/service";
import type { OpencodeClient, Session, Message, Part } from "@opencode-ai/sdk/v2";
import { loadOs, loadPath, loadProcess } from "./node-import.js";

export type ServerOptions = { url: string; headers?: Record<string, string> };

/** Keep the retrieval engine's normalized records independent of the host API.
 * The old SDK is used for types only; every request here uses the V2 client. */
export function normalizeSession(session: SessionInfo): Session {
  return {
    ...session,
    title: session.title ?? "",
    directory: session.location.directory,
    slug: session.id,
    version: "2",
  } as Session;
}

export function normalizeMessage(message: SessionMessageInfo, sessionID: string) {
  const base = { id: message.id, sessionID, time: message.time };
  const partBase = { messageID: message.id, sessionID };
  let parts: Part[] = [];
  if (message.type === "assistant") {
    parts = message.content.map((content, index) => {
      const common = {
        ...partBase,
        id: content.type === "tool" ? content.id : `${message.id}_${index}`,
      };
      if (content.type !== "tool") return { ...common, ...content } as Part;
      const state = content.state;
      const output =
        "content" in state
          ? (state.content
              ?.map((item) => (item.type === "text" ? item.text : item.uri))
              .join("\n") ?? "")
          : "";
      return {
        ...common,
        type: "tool",
        callID: content.id,
        tool: content.name,
        state: {
          ...state,
          status: state.status === "streaming" ? "pending" : state.status,
          ...("error" in state ? { error: state.error.message } : {}),
          output,
          title: content.name,
          time: { start: content.time.ran ?? content.time.created, end: content.time.completed },
        },
      } as Part;
    });
  } else if (message.type === "compaction") {
    parts = [
      {
        ...partBase,
        id: `${message.id}_boundary`,
        type: "compaction",
        auto: message.reason === "auto",
      },
    ];
    if (message.status === "completed")
      parts.push({
        ...partBase,
        id: `${message.id}_summary`,
        type: "text",
        text: message.summary,
        synthetic: true,
      });
  } else if ("text" in message) {
    parts = [
      {
        ...partBase,
        id: `${message.id}_text`,
        type: "text",
        text: message.text,
        synthetic: message.type !== "user",
      },
    ];
  } else if (message.type === "shell") {
    parts = [
      {
        ...partBase,
        id: `${message.id}_shell`,
        type: "tool",
        tool: "shell",
        callID: message.shellID,
        state: {
          status: "completed",
          input: { command: message.command },
          output: message.output?.output ?? "",
          title: "shell",
          metadata: {},
          time: {
            start: message.time.created,
            end: message.time.completed ?? message.time.created,
          },
        },
      },
    ];
  }
  const info = {
    ...base,
    role: message.type === "assistant" || message.type === "compaction" ? "assistant" : "user",
    ...(message.type === "compaction" ? { summary: true } : {}),
    ...(message.type === "assistant"
      ? {
          agent: message.agent,
          modelID: message.model.id,
          providerID: message.model.providerID,
          cost: message.cost ?? 0,
          tokens: message.tokens,
        }
      : {}),
  } as Message;
  return { info, parts };
}

/** Lazy discovery avoids starting/replacing a service during plugin setup. */
export function connect(
  version: string,
  server?: ServerOptions,
  channel?: string,
): () => Promise<OpenCodeClient> {
  let client: OpenCodeClient | undefined;
  return async () => {
    if (client) return client;
    if (server) return (client = OpenCode.make({ baseUrl: server.url, headers: server.headers }));
    // The source CLI uses service-local.json; release channels share service.json.
    const file =
      channel && !["latest", "dev", "beta", "next"].includes(channel)
        ? await (async () => {
            const [os, path, process] = await Promise.all([loadOs(), loadPath(), loadProcess()]);
            return path.join(
              process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
              "opencode",
              `service-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`,
            );
          })()
        : undefined;
    const endpoint = await Service.discover({ version, ...(file ? { file } : {}) });
    if (!endpoint)
      throw new Error(
        "Recall: no matching background service; set plugin options.server for an explicit/standalone server",
      );
    return (client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }));
  };
}

export function historyClient(
  getClient: () => Promise<OpenCodeClient>,
  directory?: string,
): OpencodeClient {
  async function list(params: { search?: string; limit?: number; parentID?: string } = {}) {
    const client = await getClient();
    const data: Session[] = [];
    const limit = params.limit ?? 100;
    let cursor: string | undefined;
    do {
      const page = await client.session.list({
        ...params,
        directory,
        limit: Math.min(100, limit - data.length),
        cursor,
        order: "desc",
      });
      data.push(...page.data.map(normalizeSession));
      cursor = page.cursor.next ?? undefined;
    } while (cursor && data.length < limit);
    return { data };
  }
  const session = {
    list,
    get: async (input: { sessionID: string }) => {
      try {
        return { data: normalizeSession(await (await getClient()).session.get(input)) };
      } catch (error) {
        // The distiller distinguishes absence from a transient metadata error.
        return { error };
      }
    },
    children: (input: { sessionID: string }) => list({ parentID: input.sessionID, limit: 10000 }),
    messages: async (input: { sessionID: string; limit: number; before?: string }) => {
      if (!Number.isFinite(input.limit) || input.limit < 1)
        throw new Error("Recall requires a bounded message limit");
      const page = await (
        await getClient()
      ).message.list({
        sessionID: input.sessionID,
        limit: input.limit,
        cursor: input.before,
        order: "desc",
      });
      return {
        data: page.data.map((message) => normalizeMessage(message, input.sessionID)),
        response: {
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "x-next-cursor" ? (page.cursor.next ?? null) : null,
          },
        },
      };
    },
    message: async (input: { sessionID: string; messageID: string }) => ({
      data: normalizeMessage(await (await getClient()).session.message.get(input), input.sessionID),
    }),
    create: async (input: { title?: string }) => ({
      data: normalizeSession(
        await (
          await getClient()
        ).session.create({
          title: input.title,
          location: directory ? { directory } : undefined,
          permissions: [{ action: "*", resource: "*", effect: "deny" }],
        }),
      ),
    }),
    delete: async (input: { sessionID: string }) => ({
      data: await (await getClient()).session.remove(input),
    }),
    abort: async (input: { sessionID: string }) => ({
      data: await (await getClient()).session.interrupt({ ...input, resume: false }),
    }),
    prompt: async (input: {
      sessionID: string;
      model: { providerID: string; modelID: string };
      agent?: string;
      system?: string;
      parts: Array<{ type: string; text?: string }>;
    }) => {
      const client = await getClient();
      if (input.agent)
        await client.session.switchAgent({ sessionID: input.sessionID, agent: input.agent });
      await client.session.switchModel({
        sessionID: input.sessionID,
        model: { providerID: input.model.providerID, id: input.model.modelID },
      });
      const result = await client.session.generate({
        sessionID: input.sessionID,
        prompt: [input.system, ...input.parts.map((part) => part.text ?? "")]
          .filter(Boolean)
          .join("\n\n"),
      });
      return { data: { parts: [{ type: "text", text: result.text }] } };
    },
  };
  // This is the one compatibility boundary for the engine's older record types.
  // No legacy SDK client or HTTP transport is constructed.
  return { session, experimental: { session: { list } } } as unknown as OpencodeClient;
}
