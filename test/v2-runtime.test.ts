import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v2RuntimeFactory, type V2Runtime, type V2RuntimeOptions } from "../src/host/v2-runtime.js";
import { openSqlite } from "../src/sqlite.js";
import { openStore } from "../src/store.js";
import { makeV2Db, type V2TestDb } from "./v2-db.js";
import { TEST_LIMITS } from "./helpers.js";

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
