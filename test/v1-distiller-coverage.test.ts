import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hooks, PluginInput } from "../src/host/opencode-v1-types.js";
import { makeContext, PROJECT_DIR } from "./helpers.js";

/**
 * Where the v1 host reports its distiller running: always on its own thread,
 * since its history reads go through the host's in-process SDK transport.
 * `coverage.history` holds that and nothing else on v1, which reads no
 * opencode.db of its own.
 */

const emptyClient = vi.hoisted(() => () => ({
  session: {
    list: async () => ({ data: [] }),
    messages: async () => ({ data: [] }),
  },
  experimental: { session: { list: async () => ({ data: [] }) } },
}));

vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencodeClient: (options: unknown) => ({ ...(options as object), ...emptyClient() }),
}));

const plugin = await import("../src/opencode-session-recall.js");
const active: Hooks[] = [];

afterEach(async () => {
  await Promise.all(active.splice(0).map((hooks) => hooks.dispose?.()));
});

describe("the v1 host's distiller coverage", () => {
  it("reports the distiller inline, alone in coverage.history", async () => {
    const input = {
      client: { _client: { getConfig: () => ({ fetch: vi.fn() }) } },
      directory: PROJECT_DIR,
      worktree: PROJECT_DIR,
      project: {},
      serverUrl: new URL("http://localhost"),
      $: {},
    } as unknown as PluginInput;
    const hooks = await plugin.default.server(input, { storePath: ":memory:", coldPass: false });
    active.push(hooks);
    const recall = hooks.tool?.recall;
    if (!recall) throw new Error("no recall tool");
    const out = JSON.parse(
      (await recall.execute({ query: "anything", scope: "global" }, makeContext().ctx)) as string,
    ) as { ok: boolean; coverage?: { history?: unknown } };
    expect(out.coverage?.history).toEqual({ distiller: "inline" });
  });
});
