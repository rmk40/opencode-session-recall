import { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode-ai/plugin";
import { z } from "zod";
import { createRuntime } from "./runtime.js";
import { connect, historyClient } from "./v2-client.js";

export default Plugin.define({
  id: "opencode-session-recall",
  async setup(ctx) {
    const server = z
      .object({ url: z.url(), headers: z.record(z.string(), z.string()).optional() })
      .optional()
      .parse(ctx.options.server);
    const controller = new AbortController();
    const getClient = connect(ctx.app.version, server, ctx.app.channel);
    const runtime = await createRuntime(
      historyClient(getClient, ctx.location.directory),
      historyClient(getClient),
      { ...ctx.options, hostV2: true },
    );

    await ctx.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(runtime.tool ?? {})) {
        editor.add({
          name,
          description: definition.description,
          input: z.toJSONSchema(z.object(definition.args), { io: "input", unrepresentable: "any" }),
          async execute(input, context) {
            const session = await ctx.session.get({ sessionID: context.sessionID });
            const legacyContext: ToolContext = {
              sessionID: context.sessionID,
              messageID: context.messageID,
              agent: context.agent,
              directory: session.location.directory,
              worktree: session.location.directory,
              abort: context.signal,
              metadata: (metadata) => {
                void context.progress(metadata);
              },
              ask: async () => {
                throw new Error(
                  "Recall tools are read-only and must not request legacy permissions",
                );
              },
            };
            const result = await definition.execute(
              input as Record<string, unknown>,
              legacyContext,
            );
            return typeof result === "string" ? { content: result } : { content: result.output };
          },
        });
      }
    });

    if (runtime["experimental.chat.system.transform"] || runtime["chat.message"]) {
      await ctx.session.hook("context", async (event) => {
        const system = event.system.filter((part) => part.type === "text").map((part) => part.text);
        const length = system.length;
        await runtime["experimental.chat.system.transform"]?.(
          { sessionID: event.sessionID, model: event.model } as never,
          { system },
        );
        for (const text of system.slice(length)) event.system.push({ type: "text", text });
        const user = [...event.messages].reverse().find((message) => message.role === "user");
        if (!user || !runtime["chat.message"]) return;
        const parts = user.content
          .filter((part) => part.type === "text")
          .map((part) => ({ type: "text", text: part.text }));
        const originalLength = parts.length;
        const output = { message: { id: "recall-context" }, parts };
        await runtime["chat.message"]({ sessionID: event.sessionID } as never, output as never);
        for (const part of output.parts.slice(originalLength))
          event.system.push({ type: "text", text: part.text });
      });
    }
    if (runtime["experimental.session.compacting"]) {
      await ctx.session.hook("compaction", async (event) => {
        const output = { context: [] as string[] };
        await runtime["experimental.session.compacting"]?.({ sessionID: event.sessionID }, output);
        for (const text of output.context) event.system.push({ type: "text", text });
      });
    }

    const events = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const data = event.data as { sessionID?: string };
          if (!data?.sessionID) continue;
          const type =
            event.type === "session.compaction.ended" ||
            event.type === "session.revert.committed" ||
            String(event.type) === "session.message.content.updated"
              ? "session.compacted"
              : event.type;
          await runtime.event?.({ event: { type, properties: data } } as never);
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("[recall] event subscription ended", error);
      }
    })();
    return async () => {
      controller.abort();
      await events;
      await runtime.dispose?.();
    };
  },
});
