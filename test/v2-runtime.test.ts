import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  V2_PLUGIN_BUILD,
  v2RuntimeFactory,
  type V2Runtime,
  type V2RuntimeOptions,
} from "../src/host/v2-runtime.js";
import { V2_PROJECTOR_GEN } from "../src/history/v2-project.js";
import { openSqlite } from "../src/sqlite.js";
import { openStore, pluginBuild } from "../src/store.js";
import { search } from "../src/search.js";
import { emptyReadCounts } from "../src/history/source.js";
import type { SearchOutput } from "../src/types.js";
import {
  V2_PARTS_MIGRATION,
  insertMessage,
  insertPart,
  insertProject,
  insertSession,
  makeV2Db,
  makeV2PartsDb,
  type V2TestDb,
} from "./v2-db.js";
import { TEST_LIMITS, makeContext, toolResultText } from "./helpers.js";

/**
 * The v2 runtime's store and source identity, through the registry factory
 * (resolve, then create) exactly as the deferred init runs it.
 */

let dir: string;
const runtimes: V2Runtime[] = [];
const dbs: V2TestDb[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recall-v2-runtime-"));
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const db of dbs.splice(0)) db.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function options(over: Partial<V2RuntimeOptions>): V2RuntimeOptions {
  return {
    ephemeral: false,
    storePath: join(dir, "store.db"),
    opencodeDbPath: undefined,
    semantic: undefined,
    limits: { ...TEST_LIMITS, coldPass: false },
    summaries: false,
    ...over,
  };
}

async function run(opts: V2RuntimeOptions): Promise<{ runtime: V2Runtime; logs: string[] }> {
  const logs: string[] = [];
  const factory = v2RuntimeFactory({ options: opts, channel: "latest", log: (m) => logs.push(m) });
  const runtime = await factory.create(await factory.resolve());
  runtimes.push(runtime);
  return { runtime, logs };
}

async function storeMeta(path: string): Promise<Record<string, unknown>> {
  const db = await openSqlite(path);
  try {
    return Object.fromEntries(
      (db?.all("SELECT key, value FROM meta") ?? []).map((row) => [row.key, row.value]),
    );
  } finally {
    db?.close();
  }
}

describe("v2 runtime source canonicalization", () => {
  it("opens no store until opencode.db exists, then stamps its canonical path", async () => {
    const storePath = join(dir, "store.db");
    // The configured path goes through a symlinked directory, so the located
    // spelling and the canonical one differ.
    const realDir = join(dir, "data");
    const linkDir = join(dir, "link");
    const v2 = await makeV2Db();
    dbs.push(v2);
    symlinkSync(realDir, linkDir);
    const configured = join(linkDir, "opencode.db");

    // First run: opencode.db does not exist yet, so its path cannot be
    // canonicalized. No store is opened, so nothing is stamped.
    const first = await run(options({ storePath, opencodeDbPath: configured }));
    expect(first.runtime.store).toBeNull();
    expect(first.logs.some((line) => line.includes("could not be canonicalized"))).toBe(true);
    expect(existsSync(storePath)).toBe(false);
    await first.runtime.dispose();

    // Second run: the database now exists behind the symlink.
    const { mkdirSync, copyFileSync } = await import("node:fs");
    mkdirSync(realDir);
    v2.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    copyFileSync(v2.path, join(realDir, "opencode.db"));
    const second = await run(options({ storePath, opencodeDbPath: configured }));
    expect(second.runtime.store).not.toBeNull();
    expect((await storeMeta(storePath)).source_db).toBe(realpathSync(join(realDir, "opencode.db")));
  });

  it("degrades to cards-lite with one log line on a store stamped for another source", async () => {
    const v2 = await makeV2Db();
    dbs.push(v2);
    const storePath = join(dir, "store.db");
    const seed = await openSqlite(storePath);
    if (!seed) throw new Error("no sqlite");
    const seeded = openStore(seed, { host: "opencode-v2", source: "/elsewhere/opencode.db" });
    if (!seeded.ok) throw new Error(seeded.reason);
    seed.close();

    const { runtime, logs } = await run(options({ storePath, opencodeDbPath: v2.path }));
    expect(runtime.store).toBeNull();
    expect(runtime.unavailable).toBeUndefined();
    expect(logs.filter((line) => line.startsWith("store refused (source-mismatch)"))).toHaveLength(
      1,
    );
    expect(runtime.cards.coverage().degraded).toBe(true);
    expect((await storeMeta(storePath)).source_db).toBe("/elsewhere/opencode.db");
  });
});

describe("v2 runtime repair wiring", () => {
  it("discovers archived sessions and stamps cards and the lease with the projector generation", async () => {
    const v2 = await makeV2PartsDb();
    dbs.push(v2);
    insertProject(v2.db, { id: "prj", worktree: "/w" });
    const session = (id: string, archived: number | null) =>
      insertSession(v2.db, {
        id,
        project_id: "prj",
        directory: "/w",
        time_created: 1_000,
        time_updated: 1_000,
        time_archived: archived,
      });
    session("ses_live", null);
    session("ses_arch", 1_500);
    insertMessage(v2.db, {
      id: "msg_1",
      session_id: "ses_arch",
      type: "assistant",
      seq: 1,
      time_created: 1_100,
      data: {
        agent: "build",
        model: { id: "m", providerID: "p" },
        content: [],
        time: { created: 1_100, completed: 1_101 },
      },
    });
    insertPart(v2.db, {
      message_id: "msg_1",
      session_id: "ses_arch",
      ordinal: 0,
      time_created: 1_100,
      data: { type: "text", text: "archived answer" },
    });

    const factory = v2RuntimeFactory({
      options: options({ opencodeDbPath: v2.path, limits: { ...TEST_LIMITS, coldPass: true } }),
      channel: "latest",
      log: () => {},
      sync: { pollIntervalMs: 20 },
      idleDebounceMs: 5,
    });
    const runtime = await factory.create(await factory.resolve());
    runtimes.push(runtime);
    const store = runtime.store!;
    const start = Date.now();
    while (runtime.repair()?.sweep?.running !== false) {
      if (Date.now() - start > 5_000) throw new Error("the repair sweep never finished");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(store.getCard("ses_arch")).toMatchObject({
      projectorGen: V2_PROJECTOR_GEN,
      timeArchived: 1_500,
    });
    expect(store.getCard("ses_live")).toMatchObject({ projectorGen: V2_PROJECTOR_GEN });
    expect(V2_PLUGIN_BUILD).toBe(pluginBuild("opencode-v2", V2_PROJECTOR_GEN));
    expect(store.leaseStatus()?.build).toBe(V2_PLUGIN_BUILD);
    expect(runtime.repair()?.sweep).toMatchObject({ gen: V2_PROJECTOR_GEN, pending: 0 });
    // One drift state over every facade: the distiller's reads show in it.
    const drift = runtime.history();
    expect(drift?.capabilities.parts).toBe(true);
    expect(drift?.reads).toBeGreaterThan(0);
    expect(runtime.sourceFor("prj").history?.()).toEqual(runtime.history());
  });

  it("reports no drift or repair state without opencode.db", async () => {
    const { runtime } = await run(options({ opencodeDbPath: join(dir, "missing.db") }));
    expect(runtime.history()).toBeUndefined();
    expect(runtime.repair()).toBeUndefined();
  });
});

describe("v2 runtime recall coverage", () => {
  /** Project `prj` with session `ses_a`: a user prompt and an assistant answer
   *  in a part row, both mentioning "zephyr". */
  function seed(db: V2TestDb["db"]): void {
    insertProject(db, { id: "prj", worktree: "/w" });
    insertSession(db, {
      id: "ses_a",
      project_id: "prj",
      directory: "/w",
      time_created: 1_000,
      time_updated: 1_200,
    });
    insertMessage(db, {
      id: "msg_u",
      session_id: "ses_a",
      type: "user",
      seq: 1,
      time_created: 1_100,
      data: { text: "please look at zephyr", time: { created: 1_100 } },
    });
    insertMessage(db, {
      id: "msg_a",
      session_id: "ses_a",
      type: "assistant",
      seq: 2,
      time_created: 1_150,
      data: {
        agent: "build",
        model: { id: "m", providerID: "p" },
        content: [],
        time: { created: 1_150, completed: 1_151 },
      },
    });
    insertPart(db, {
      message_id: "msg_a",
      session_id: "ses_a",
      ordinal: 0,
      time_created: 1_150,
      data: { type: "text", text: "zephyr answer" },
    });
  }

  /** A runtime over `v2` once its cold pass and repair sweep have finished. */
  async function settled(v2: V2TestDb): Promise<V2Runtime> {
    const factory = v2RuntimeFactory({
      options: options({ opencodeDbPath: v2.path, limits: { ...TEST_LIMITS, coldPass: true } }),
      channel: "latest",
      log: () => {},
      sync: { pollIntervalMs: 20 },
      idleDebounceMs: 5,
    });
    const runtime = await factory.create(await factory.resolve());
    runtimes.push(runtime);
    const start = Date.now();
    while (
      runtime.repair()?.sweep?.running !== false ||
      runtime.distiller.indexing() !== undefined
    ) {
      if (Date.now() - start > 10_000) throw new Error("the cold pass never finished");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return runtime;
  }

  async function recallOn(runtime: V2Runtime): Promise<SearchOutput> {
    const tool = search(runtime.sourceFor("prj"), true, runtime.options.limits, runtime.deps);
    const text = toolResultText(
      await tool.execute({ query: "zephyr" } as never, makeContext().ctx),
    );
    return JSON.parse(text) as SearchOutput;
  }

  it("reports a database it reads in full in coverage.history, and warns of nothing", async () => {
    const v2 = await makeV2PartsDb();
    dbs.push(v2);
    seed(v2.db);
    const out = await recallOn(await settled(v2));

    expect(out.ok).toBe(true);
    expect(out.results.some((r) => r.sessionID === "ses_a")).toBe(true);
    expect(out.coverage?.history).toMatchObject({
      capabilities: { parts: true },
      migration: { newest: V2_PARTS_MIGRATION, tested: true },
      unknownTables: [],
      counts: emptyReadCounts(),
      repair: { pending: 0, repairPending: 0, running: false },
    });
    expect(out.coverage?.history).not.toHaveProperty("missingColumns");
    expect(out.coverage?.history).not.toHaveProperty("unknownPartTypeNames");
    expect(out.coverage?.history?.reads).toBeGreaterThan(0);
    expect(out.coverage?.limitedBy ?? []).not.toContain("providerLimit");
    expect(out.warnings).toBeUndefined();
  }, 30_000);

  it("warns when the database has tables and part types this build does not know", async () => {
    const v2 = await makeV2PartsDb();
    dbs.push(v2);
    seed(v2.db);
    v2.db.exec("CREATE TABLE session_future (id TEXT PRIMARY KEY)");
    insertPart(v2.db, {
      message_id: "msg_a",
      session_id: "ses_a",
      ordinal: 1,
      time_created: 1_150,
      data: { type: "hologram", text: "zephyr light" },
    });
    const out = await recallOn(await settled(v2));

    expect(out.ok).toBe(true);
    expect(out.coverage?.history).toMatchObject({
      unknownTables: ["session_future"],
      unknownPartTypeNames: ["hologram"],
    });
    const drift = out.warnings?.filter((w) =>
      /differs from what this plugin version reads/.test(w),
    );
    expect(drift).toHaveLength(1);
    expect(drift![0]).toContain("unknown tables session_future");
    expect(drift![0]).toMatch(/parts? of unknown types \(hologram\)/);
  }, 30_000);
});

describe("v2 runtime store canonicalization", () => {
  function resolveWith(storePath: string, opencodeDbPath: string) {
    return v2RuntimeFactory({
      options: options({ storePath, opencodeDbPath }),
      channel: "latest",
      log: () => {},
    }).resolve();
  }

  it("resolves a symlinked store file to its target, so both spellings share a runtime", async () => {
    const v2 = await makeV2Db();
    dbs.push(v2);
    const real = join(dir, "real-store.db");
    const seed = await openSqlite(real);
    seed?.close();
    const link = join(dir, "linked-store.db");
    symlinkSync(real, link);

    const viaReal = await resolveWith(real, v2.path);
    const viaLink = await resolveWith(link, v2.path);
    expect(viaLink.store).toBe(realpathSync(real));
    expect(viaLink).toEqual(viaReal);
  });

  it("resolves a store file that does not exist yet through its real directory", async () => {
    const v2 = await makeV2Db();
    dbs.push(v2);
    const realDir = join(dir, "cache");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(realDir);
    symlinkSync(realDir, join(dir, "cache-link"));
    const identity = await resolveWith(join(dir, "cache-link", "store.db"), v2.path);
    expect(identity.store).toBe(join(realpathSync(realDir), "store.db"));
  });
});
