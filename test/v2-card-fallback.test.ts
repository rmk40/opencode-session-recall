import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetRuntimeRegistryForTests } from "../src/host/runtime.js";
import { REGISTRY_KEY } from "../src/host/registry.js";
import type { V2Cleanup } from "../src/host/opencode-v2-types.js";
import { openSqlite } from "../src/sqlite.js";
import { openStore } from "../src/store.js";
import { insertMessage, insertProject, insertSession, makeV2Db, type V2TestDb } from "./v2-db.js";
import { fakeV2Host, type FakeV2Host } from "./v2-host.js";

/**
 * The v2 card-only fallback when opencode.db cannot be canonicalized: it is
 * missing, or Bun's realpath refuses it (EACCES on a mode-000 file, which
 * Node resolves, so the refusal is injected here). An existing store stamped
 * for the same file still answers from its cards; nothing is stamped or
 * distilled.
 */

/** Paths whose realpath throws EACCES, as Bun's does for a mode-000 file. */
const denied = new Set<string>();

vi.mock("../src/node-import.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/node-import.js")>();
  return {
    ...actual,
    loadFs: async () => {
      const fs = await actual.loadFs();
      return {
        ...fs,
        promises: {
          ...fs.promises,
          realpath: async (path: string) => {
            if (denied.has(path)) {
              throw Object.assign(new Error(`EACCES: permission denied, realpath '${path}'`), {
                code: "EACCES",
              });
            }
            return fs.promises.realpath(path);
          },
        },
      };
    },
  };
});

const { default: entry } = await import("../src/opencode-session-recall.js");
const { instanceOf, setV2LogSinkForTests } = await import("../src/host/v2.js");

type Json = Record<string, unknown>;

let v2db: V2TestDb;
let dir: string;
let storePath: string;
const cleanups: V2Cleanup[] = [];

beforeEach(async () => {
  resetRuntimeRegistryForTests();
  v2db = await makeV2Db();
  insertProject(v2db.db, { id: "prj_test", worktree: "/workspace/project" });
  insertSession(v2db.db, {
    id: "ses_a",
    project_id: "prj_test",
    directory: "/workspace/project",
    title: "Heron pipeline",
    time_created: 1_000,
    time_updated: 2_000,
  });
  insertMessage(v2db.db, {
    id: "msg_a1",
    session_id: "ses_a",
    type: "user",
    seq: 1,
    time_created: 1_100,
    data: { text: "heronneedle design question", time: { created: 1_100 } },
  });
  dir = mkdtempSync(join(tmpdir(), "recall-v2-fallback-"));
  storePath = join(dir, "store.db");
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  resetRuntimeRegistryForTests();
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
  denied.clear();
  try {
    chmodSync(v2db.path, 0o644);
  } catch {
    // Removed by the test.
  }
  v2db.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function host(extra: Json = {}): FakeV2Host {
  return fakeV2Host({
    options: { opencodeDbPath: v2db.path, storePath, coldPass: false, ...extra },
  });
}

async function setup(h: FakeV2Host): Promise<V2Cleanup> {
  const cleanup = await entry.setup(h.ctx);
  if (!cleanup) throw new Error("setup stayed inert");
  cleanups.push(cleanup);
  return cleanup;
}

async function runtimeOf(h: FakeV2Host) {
  const runtime = await instanceOf(h.ctx)?.attachment.ready(5_000);
  if (!runtime) throw new Error("runtime never became ready");
  return runtime;
}

async function call(h: FakeV2Host, name: string, input: unknown): Promise<Json> {
  const result = await h.runTool(name, input, { sessionID: "ses_other" });
  return JSON.parse(result.content as string) as Json;
}

async function waitUntil(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Distill opencode.db into the store, then shut that runtime down. */
async function buildStore(): Promise<void> {
  const h = host({ coldPass: true });
  const cleanup = await setup(h);
  const runtime = await runtimeOf(h);
  await waitUntil(() => runtime.distiller.status().coldPass === "done");
  expect(runtime.store?.getCard("ses_a")?.distillState).toBe("full");
  await cleanup();
  cleanups.splice(cleanups.indexOf(cleanup), 1);
  resetRuntimeRegistryForTests();
}

async function storeMeta(): Promise<Record<string, unknown>> {
  const db = await openSqlite(storePath);
  try {
    return Object.fromEntries(
      (db?.all("SELECT key, value FROM meta") ?? []).map((row) => [row.key, row.value]),
    );
  } finally {
    db?.close();
  }
}

async function expectCardOnlyAnswers(h: FakeV2Host): Promise<void> {
  const runtime = await runtimeOf(h);
  expect(runtime.unavailable).toBeDefined();
  expect(runtime.store).not.toBeNull();
  // Opened for cards only: the distiller never starts on it.
  expect(runtime.distiller.status().leaseHeld).toBe(false);

  const recall = await call(h, "recall", { query: "heronneedle", scope: "global" });
  expect(recall.ok).toBe(true);
  const results = recall.results as Array<{ sessionID: string; partID: string }>;
  expect(results.map((r) => r.sessionID)).toContain("ses_a");
  for (const result of results) expect(result.partID).toMatch(/:card:|:title$/);
  expect((recall.coverage as { source?: unknown }).source).toMatchObject({ available: false });
  expect(
    (recall.warnings as string[]).some((w) => /Results come from the session cards only/.test(w)),
  ).toBe(true);
  // No distiller runs on a cards-only store, so there is no progress to report.
  expect(runtime.deps.indexing?.()).toBeUndefined();
  expect((recall.coverage as { cards: { indexing?: unknown } }).cards.indexing).toBeUndefined();

  const listed = await call(h, "recall_sessions", { scope: "project" });
  expect(listed.ok).toBe(true);
  expect((listed.sessions as Array<{ id: string }>).map((s) => s.id)).toEqual(["ses_a"]);
}

describe("v2 card-only fallback for a source that cannot be canonicalized", () => {
  it("serves cards from the stamped store when opencode.db is missing", async () => {
    await buildStore();
    const stamped = (await storeMeta()).source_db;
    v2db.cleanup = (
      (inner) => () =>
        inner()
    )(v2db.cleanup);
    v2db.db.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(v2db.path + suffix, { force: true });

    const h = host({ coldPass: true });
    await setup(h);
    await expectCardOnlyAnswers(h);
    // Nothing re-stamped.
    expect((await storeMeta()).source_db).toBe(stamped);
  });

  it("serves cards from the stamped store when opencode.db is unreadable", async () => {
    await buildStore();
    const stamped = (await storeMeta()).source_db;
    // Close the writer first: SQLite reuses a same-process descriptor for a
    // file whose locks another connection still holds, so the mode would
    // never be checked.
    v2db.db.close();
    // Unreadable to the reader, and refused by realpath as Bun refuses it.
    chmodSync(v2db.path, 0o000);
    denied.add(v2db.path);
    denied.add(realpathSync(v2db.path));

    const h = host({ coldPass: true });
    await setup(h);
    await expectCardOnlyAnswers(h);
    expect((await storeMeta()).source_db).toBe(stamped);
  });

  it("refuses, untouched, a matching store whose schema stamp is damaged", async () => {
    await buildStore();
    // Damage the schema stamp: the rebuilding open would drop every card.
    const raw = await openSqlite(storePath);
    if (!raw) throw new Error("no sqlite");
    raw.run("UPDATE meta SET value = 'garbage' WHERE key = 'schema_version'");
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.close();
    const before = readFileSync(storePath);
    v2db.db.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(v2db.path + suffix, { force: true });

    const lines: string[] = [];
    setV2LogSinkForTests(
      Object.assign((line: string) => void lines.push(line), { flush: async () => {} }),
    );
    try {
      const h = host();
      await setup(h);
      const runtime = await runtimeOf(h);
      expect(runtime.store).toBeNull();
      expect(
        lines.some((l) => l.includes("the store stamped for it was refused: needs-rebuild")),
      ).toBe(true);
      await cleanups.splice(0).reduce((p, c) => p.then(() => c()), Promise.resolve());
    } finally {
      setV2LogSinkForTests(undefined);
    }
    expect(existsSync(`${storePath}-wal`) ? readFileSync(`${storePath}-wal`).length : 0).toBe(0);
    expect(readFileSync(storePath).equals(before)).toBe(true);
  });

  it("degrades without a store when the store is stamped for another file", async () => {
    const seed = await openSqlite(storePath);
    if (!seed) throw new Error("no sqlite");
    const seeded = openStore(seed, { host: "opencode-v2", source: "/elsewhere/opencode.db" });
    if (!seeded.ok) throw new Error(seeded.reason);
    seed.close();
    v2db.db.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(v2db.path + suffix, { force: true });

    const h = host();
    await setup(h);
    const runtime = await runtimeOf(h);
    expect(runtime.unavailable).toBeDefined();
    expect(runtime.store).toBeNull();
    const listed = await call(h, "recall_sessions", { scope: "project" });
    expect(listed.ok).toBe(false);
    expect((await storeMeta()).source_db).toBe("/elsewhere/opencode.db");
  });
});
