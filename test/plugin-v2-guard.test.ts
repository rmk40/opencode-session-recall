import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY_KEY } from "../src/host/registry.js";
import { resetRuntimeRegistryForTests } from "../src/host/runtime.js";
import { makeV2Db, type V2TestDb } from "./v2-db.js";
import { fakeV2Host } from "./v2-host.js";

/**
 * A throw inside setup after the runtime attachment must release it: the
 * runtime is never built (nothing opens the store) and setup still returns a
 * cleanup instead of rejecting.
 */

const failing = vi.hoisted(() => ({ startingToolSet: false }));

vi.mock("../src/host/v2-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/host/v2-tools.js")>();
  return {
    ...actual,
    startingToolSet: (...args: Parameters<typeof actual.startingToolSet>) => {
      if (failing.startingToolSet) throw new Error("tool set exploded");
      return actual.startingToolSet(...args);
    },
  };
});

const { default: entry } = await import("../src/opencode-session-recall.js");

let v2db: V2TestDb | undefined;
let dir: string | undefined;

afterEach(() => {
  failing.startingToolSet = false;
  resetRuntimeRegistryForTests();
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
  v2db?.cleanup();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("v2 setup failure after attaching", () => {
  it("detaches, builds no runtime, and returns a no-op cleanup", async () => {
    v2db = await makeV2Db();
    dir = mkdtempSync(join(tmpdir(), "recall-v2-guard-"));
    const storePath = join(dir, "store.db");
    const h = fakeV2Host({
      options: { opencodeDbPath: v2db.path, storePath, coldPass: false },
    });
    failing.startingToolSet = true;
    const cleanup = await entry.setup(h.ctx);
    expect(typeof cleanup).toBe("function");
    await cleanup?.();
    // Give the deferred init every chance to run: with the attachment
    // leaked, it would build the runtime and create the store file.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(storePath)).toBe(false);
    expect(h.transformCalls).toBe(0);
  });
});
