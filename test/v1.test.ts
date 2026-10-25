import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk";
import plugin from "../src/opencode-session-recall.js";
import { TOOLS } from "../src/types.js";
import { makeContext } from "./helpers.js";

vi.mock("@opencode/plugin", () => {
  throw new Error("V1 must not load the V2 plugin API");
});

const active: Hooks[] = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((hooks) => hooks.dispose?.()));
  vi.restoreAllMocks();
});

function fixture(headers: HeadersInit = { authorization: "Bearer fixture" }) {
  const calls: Request[] = [];
  const session = {
    id: "ses_v1",
    title: "V1 history needle",
    directory: "/fixture",
    projectID: "project",
    time: { created: 1, updated: 2 },
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/message")) {
      expect(url.searchParams.has("limit")).toBe(true);
      return Response.json([
        {
          info: { id: "msg_v1", sessionID: session.id, role: "user", time: { created: 1 } },
          parts: [
            {
              id: "part_v1",
              messageID: "msg_v1",
              sessionID: session.id,
              type: "text",
              text: "V1 message needle",
            },
          ],
        },
      ]);
    }
    if (url.pathname === "/session/ses_v1") return Response.json(session);
    return Response.json([session]);
  };
  const input = {
    client: createOpencodeClient({ baseUrl: "http://fixture.invalid", fetch, headers }),
    directory: "/fixture",
    worktree: "/fixture",
    project: {},
    serverUrl: new URL("http://fixture.invalid"),
  } as unknown as PluginInput;
  return { input, calls };
}

describe("dual-host entrypoint in V1", () => {
  it("exports one V1 object entrypoint alongside V2 setup", () => {
    expect(plugin.id).toBe("opencode-session-recall");
    expect(plugin.server).toBeTypeOf("function");
    expect(plugin.setup).toBeTypeOf("function");
  });

  it.each(["record", "headers"])(
    "preserves supplied transport/auth and removes global directory scoping (%s)",
    async (kind) => {
      const fixtureHeaders = {
        authorization: "Bearer fixture",
        "X-OpenCode-Directory": "/fixture",
      };
      const test = fixture(kind === "headers" ? new Headers(fixtureHeaders) : fixtureHeaders);
      const hooks = await plugin.server(test.input, {
        mode: "ephemeral",
        coldPass: false,
        nudge: false,
      });
      active.push(hooks);
      expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([...TOOLS].sort());
      const tool = hooks.tool!.recall_sessions!;
      const local = JSON.parse(
        String(
          await tool.execute(
            { scope: "project", limit: 5 },
            makeContext({ sessionID: "ses_v1" }).ctx,
          ),
        ),
      );
      expect(local.ok).toBe(true);
      expect(local.sessions[0].title).toBe("V1 history needle");
      const global = JSON.parse(
        String(
          await tool.execute(
            { scope: "global", limit: 5 },
            makeContext({ sessionID: "ses_v1" }).ctx,
          ),
        ),
      );
      expect(global.ok).toBe(true);
      const localRequest = test.calls.find(
        (request) => new URL(request.url).pathname === "/session",
      );
      const globalRequest = test.calls.find(
        (request) => new URL(request.url).pathname === "/experimental/session",
      );
      expect(new URL(localRequest!.url).searchParams.get("directory")).toBe("/fixture");
      expect(globalRequest?.headers.has("x-opencode-directory")).toBe(false);
      expect(new URL(globalRequest!.url).searchParams.has("directory")).toBe(false);
      expect(
        test.calls.every((request) => request.headers.get("authorization") === "Bearer fixture"),
      ).toBe(true);
      const messages = JSON.parse(
        String(
          await hooks.tool!.recall_messages!.execute(
            { sessionID: "ses_v1", limit: 2 },
            makeContext({ sessionID: "ses_v1" }).ctx,
          ),
        ),
      );
      expect(messages.ok).toBe(true);
      expect(JSON.stringify(messages)).toContain("V1 message needle");
    },
  );

  it("retains V1 primary-tools opt-out, nudge, hook registration and cleanup", async () => {
    const test = fixture();
    const hooks = await plugin.server(test.input, {
      mode: "ephemeral",
      coldPass: false,
      autoRecall: true,
    });
    active.push(hooks);
    expect(hooks["experimental.chat.system.transform"]).toBeTypeOf("function");
    expect(hooks["chat.message"]).toBeTypeOf("function");
    const config: Config = { experimental: { primary_tools: ["existing", "recall"] } };
    await hooks.config?.(config);
    expect(config.experimental?.primary_tools).toEqual(["existing", ...TOOLS]);
    await hooks.config?.(config);
    expect(new Set(config.experimental?.primary_tools).size).toBe(
      config.experimental?.primary_tools?.length,
    );
    await hooks.dispose?.();
    const result = JSON.parse(
      String(
        await hooks.tool!.recall_sessions!.execute({}, makeContext({ sessionID: "ses_v1" }).ctx),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("disposed");
    const disabled = await plugin.server(test.input, {
      mode: "ephemeral",
      coldPass: false,
      primary: false,
    });
    active.push(disabled);
    expect(disabled.config).toBeUndefined();
  });

  it("fails clearly when V1's transport accessor is unavailable", async () => {
    const test = fixture();
    await expect(plugin.server({ ...test.input, client: {} } as PluginInput)).rejects.toThrow(
      "V1 SDK transport unavailable",
    );
  });

  it("forces the V1 cache selection even if options contain the V2-only marker", async () => {
    const runtime = await import("../src/runtime.js");
    const create = vi.spyOn(runtime, "createRuntime").mockResolvedValue({});
    const hooks = await plugin.server(fixture().input, { hostV2: true, primary: false });
    active.push(hooks);
    expect(create.mock.calls[0]?.[2]).toMatchObject({ hostV2: false });
  });
});
