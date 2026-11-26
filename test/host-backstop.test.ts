import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import entry from "../src/opencode-session-recall.js";
import { instanceOf } from "../src/host/v2.js";
import { REGISTRY_KEY } from "../src/host/registry.js";
import { resetRuntimeRegistryForTests } from "../src/host/runtime.js";
import type { V2Cleanup } from "../src/host/opencode-v2-types.js";
import type { PluginInput, ToolResult } from "../src/host/opencode-v1-types.js";
import { makeContext, PROJECT_DIR } from "./helpers.js";
import { insertProject, insertSession, makeV2Db, type V2TestDb } from "./v2-db.js";
import { fakeV2Host } from "./v2-host.js";

/**
 * The hosts' backstop: whatever a tool returns, OpenCode receives it only
 * when it is within what OpenCode passes to the model whole (50 KiB and
 * 2,000 lines); anything larger becomes a small JSON error with `trimmed`.
 * The tools keep their own results within a smaller budget, so a stub tool
 * stands in for a future code path that does not.
 */

const createOpencodeClient = vi.hoisted(() => vi.fn((options: unknown) => options));
vi.mock("@opencode-ai/sdk/v2", () => ({ createOpencodeClient }));

/** What the stubbed `recall_get` returns, or the error it rejects with. */
const stub = vi.hoisted(() => ({ result: "" as unknown, throws: undefined as Error | undefined }));
vi.mock("../src/get.js", () => ({
  get: () => ({
    description: "Stubbed recall_get.",
    args: {},
    execute: async () => {
      if (stub.throws) throw stub.throws;
      return stub.result;
    },
  }),
}));

const SMALL = JSON.stringify({ ok: true, text: "€😀 within the limits" });
/** 60,000 bytes in 20,000 characters. */
const OVER_BYTES = JSON.stringify({ ok: true, text: "€".repeat(20_000) });
/** 2,001 lines in about 4 KB. */
const OVER_LINES = Array.from({ length: 2_001 }, () => "x").join("\n");

function expectWithheld(text: unknown): void {
  expect(typeof text).toBe("string");
  expect(JSON.parse(text as string)).toEqual({
    ok: false,
    trimmed: true,
    error: expect.any(String),
  });
  expect(Buffer.byteLength(text as string, "utf8")).toBeLessThan(1_024);
}

afterEach(() => {
  stub.throws = undefined;
  resetRuntimeRegistryForTests();
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
});

describe("v1 host backstop", () => {
  const input = {
    client: { _client: { getConfig: () => ({ fetch: vi.fn() }) } },
    directory: PROJECT_DIR,
    worktree: PROJECT_DIR,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: {},
  } as unknown as PluginInput;

  async function run(result: unknown): Promise<ToolResult> {
    const hooks = await entry.server(input, { storePath: ":memory:", coldPass: false });
    try {
      stub.result = result;
      return await hooks.tool!.recall_get!.execute({}, makeContext().ctx);
    } finally {
      await hooks.dispose?.();
    }
  }

  it("passes a result within the limits through unchanged and withholds one over either", async () => {
    expect(await run(SMALL)).toBe(SMALL);
    expectWithheld(await run(OVER_BYTES));
    expectWithheld(await run(OVER_LINES));
  });

  it("bounds a structured result's output and keeps its other fields", async () => {
    const small = { title: "T", output: SMALL, metadata: { n: 1 } };
    expect(await run(small)).toEqual(small);
    const over = (await run({ title: "T", output: OVER_BYTES, metadata: { n: 1 } })) as {
      output: string;
    };
    expect(over).toMatchObject({ title: "T", metadata: { n: 1 } });
    expectWithheld(over.output);
  });
});

describe("v2 host backstop", () => {
  let v2db: V2TestDb;
  let dir: string;
  let cleanup: V2Cleanup | undefined;

  beforeEach(async () => {
    v2db = await makeV2Db();
    insertProject(v2db.db, { id: "prj_test", worktree: PROJECT_DIR });
    insertSession(v2db.db, {
      id: "ses_a",
      project_id: "prj_test",
      directory: PROJECT_DIR,
      time_created: 1_000,
      time_updated: 2_000,
    });
    dir = mkdtempSync(join(tmpdir(), "recall-backstop-"));
  });

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    v2db.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  async function started(): Promise<ReturnType<typeof fakeV2Host>> {
    const h = fakeV2Host({
      options: { opencodeDbPath: v2db.path, storePath: join(dir, "store.db"), coldPass: false },
    });
    const registered = await entry.setup(h.ctx);
    if (!registered) throw new Error("setup stayed inert");
    cleanup = registered;
    if (!(await instanceOf(h.ctx)?.attachment.ready(5_000))) throw new Error("no runtime");
    return h;
  }

  it("passes a result within the limits through unchanged and withholds one over either", async () => {
    const h = await started();
    const run = async (result: unknown): Promise<unknown> => {
      stub.result = result;
      return (await h.runTool("recall_get", {}, { sessionID: "ses_a" })).content;
    };
    expect(await run(SMALL)).toBe(SMALL);
    expectWithheld(await run(OVER_BYTES));
    expectWithheld(await run(OVER_LINES));
    // A structured result is serialized, then bounded as a whole.
    expectWithheld(await run({ title: "T", output: OVER_BYTES }));
  });

  it("withholds the error result it makes from a tool that rejects with an oversized message", async () => {
    const h = await started();
    stub.throws = new Error(`failed: ${"€".repeat(20_000)}`);
    expectWithheld((await h.runTool("recall_get", {}, { sessionID: "ses_a" })).content);
  });
});
