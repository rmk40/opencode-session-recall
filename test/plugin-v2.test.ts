import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import entry from "../src/opencode-session-recall.js";
import { instanceOf } from "../src/host/v2.js";
import { registry, REGISTRY_KEY } from "../src/host/registry.js";
import { resetRuntimeRegistryForTests } from "../src/host/runtime.js";
import type { V2Runtime } from "../src/host/v2-runtime.js";
import type { V2Cleanup } from "../src/host/opencode-v2-types.js";
import { openSqlite } from "../src/sqlite.js";
import { insertProject, insertSession, makeV2Db, type V2TestDb } from "./v2-db.js";
import { fakeV2Host, type FakeV2Host, type FakeV2HostOptions } from "./v2-host.js";

/**
 * The v2 host entry end to end over a fake v2 context and a temp opencode.db.
 */

let v2db: V2TestDb;
let dir: string;
const cleanups: V2Cleanup[] = [];

beforeEach(async () => {
  resetRuntimeRegistryForTests();
  v2db = await makeV2Db();
  insertProject(v2db.db, { id: "prj_test", worktree: "/workspace/project" });
  insertSession(v2db.db, {
    id: "ses_a",
    project_id: "prj_test",
    directory: "/workspace/project",
    time_created: 1_000,
    time_updated: 2_000,
  });
  dir = mkdtempSync(join(tmpdir(), "recall-v2-plugin-"));
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  resetRuntimeRegistryForTests();
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
  v2db.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function host(opts: FakeV2HostOptions = {}): FakeV2Host {
  return fakeV2Host({
    ...opts,
    options: {
      opencodeDbPath: v2db.path,
      storePath: join(dir, "store.db"),
      coldPass: false,
      ...opts.options,
    },
  });
}

function setup(h: FakeV2Host): V2Cleanup {
  const cleanup = entry.setup(h.ctx);
  if (!cleanup) throw new Error("setup stayed inert");
  cleanups.push(cleanup);
  return cleanup;
}

async function runtimeOf(h: FakeV2Host): Promise<V2Runtime> {
  const instance = instanceOf(h.ctx);
  const runtime = await instance?.attachment.ready(5_000);
  if (!runtime) throw new Error("runtime never became ready");
  return runtime;
}

describe("v2 setup", () => {
  it("returns a cleanup synchronously and builds the runtime on a later macrotask", async () => {
    const h = host();
    const cleanup = entry.setup(h.ctx);
    expect(typeof cleanup).toBe("function");
    if (cleanup) cleanups.push(cleanup);
    expect(instanceOf(h.ctx)?.attachment.current()).toBeUndefined();
    const runtime = await runtimeOf(h);
    expect(runtime.unavailable).toBeUndefined();
    expect(runtime.store).not.toBeNull();
  });

  it("opens the store with the v2 identity, stamped with the real opencode.db path", async () => {
    const h = host();
    setup(h);
    await runtimeOf(h);
    const db = await openSqlite(join(dir, "store.db"));
    try {
      const meta = Object.fromEntries(
        (db?.all("SELECT key, value FROM meta") ?? []).map((row) => [row.key, row.value]),
      );
      expect(meta.store_host).toBe("opencode-v2");
      expect(meta.source_db).toBe(realpathSync(v2db.path));
    } finally {
      db?.close();
    }
  });

  it("shares one runtime between locations and disposes it with the last cleanup", async () => {
    const a = host({ directory: "/workspace/project" });
    const b = host({ directory: "/workspace/other", projectID: "prj_other" });
    const cleanupA = setup(a);
    const cleanupB = setup(b);
    const runtime = await runtimeOf(a);
    expect(await runtimeOf(b)).toBe(runtime);
    // Each location reads through its own project-bound facade.
    expect(runtime.sourceFor("prj_test")).not.toBe(runtime.sourceFor("prj_other"));

    await cleanupA();
    expect(instanceOf(b.ctx)?.attachment.current()).toBe(runtime);
    await cleanupB();
    expect(instanceOf(b.ctx)?.attachment.current()).toBeUndefined();
    // Idempotent.
    await cleanupA();
  });

  it("runs unavailable when opencode.db is missing: no distiller, reads fail with the reason", async () => {
    const h = host({
      options: { opencodeDbPath: join(dir, "missing.db"), coldPass: true },
    });
    setup(h);
    const runtime = await runtimeOf(h);
    expect(runtime.unavailable).toBeDefined();
    expect(runtime.distiller.status().leaseHeld).toBe(false);
    const listing = await runtime
      .sourceFor("prj_test")
      .listSessions({ scope: "project", limit: 5 });
    expect(listing.ok).toBe(false);
  });

  it("stays inert when the v1 server already runs in this process", () => {
    registry().v1ServerActive = true;
    const h = host();
    expect(entry.setup(h.ctx)).toBeUndefined();
    expect(instanceOf(h.ctx)).toBeUndefined();
  });

  it("keeps an ephemeral instance on its own runtime without a store", async () => {
    const persistent = host();
    const ephemeral = host({ options: { mode: "ephemeral" } });
    setup(persistent);
    setup(ephemeral);
    const p = await runtimeOf(persistent);
    const e = await runtimeOf(ephemeral);
    expect(e).not.toBe(p);
    expect(e.store).toBeNull();
    expect(e.deps.mode).toBe("ephemeral");
  });
});
