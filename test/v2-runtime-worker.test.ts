import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INDEX_STARTING_REASON,
  STORE_IN_MEMORY_REASON,
  v2RuntimeFactory,
  type V2Runtime,
  type V2RuntimeInputs,
  type V2RuntimeOptions,
} from "../src/host/v2-runtime.js";
import { search } from "../src/search.js";
import { openSqlite, SqliteBusyError, type ReadOnlyDb, type SqliteDb } from "../src/sqlite.js";
import {
  openStore,
  type Card,
  type ReadStore,
  type Store,
  type StoreIdentity,
} from "../src/store.js";
import type { SearchOutput } from "../src/types.js";
import type { WorkerStarter } from "../src/worker/start.js";
import entry from "../src/opencode-session-recall.js";
import { instanceOf } from "../src/host/v2.js";
import { REGISTRY_KEY } from "../src/host/registry.js";
import { resetRuntimeRegistryForTests } from "../src/host/runtime.js";
import type { V2Cleanup } from "../src/host/opencode-v2-types.js";
import { fakeV2Host, type FakeV2Host } from "./v2-host.js";
import { TEST_LIMITS, makeContext, toolResultText } from "./helpers.js";
import {
  insertMessage,
  insertProject,
  insertSession,
  makeV2PartsDb,
  type V2TestDb,
} from "./v2-db.js";
import {
  readerStatements,
  workerHarness,
  type HandlerSide,
  type WorkerHarness,
} from "./worker-harness.js";

/**
 * The v2 runtime's wiring of the distiller worker, through the registry
 * factory as the deferred init runs it, with the inline harness as the
 * worker starter: when the distiller runs in a worker and when on this
 * thread, the card-only fallback, the tier served while the worker starts,
 * the reads main's store connection makes, the move to this thread after the
 * worker fails, what recall reports, dispose, and the lease passing between
 * writers of both kinds on one store.
 */

/** What `sqliteThreadSafety` reports: the real library's answer by default. */
const threadSafety = vi.hoisted(() => ({ value: "real" as number | undefined | "real" }));
/** Writable opens of `path`: each one sets `entered`, waits for `hold` and,
 *  with `fail`, returns no connection. */
const storeOpens = vi.hoisted(() => ({
  path: undefined as string | undefined,
  hold: undefined as Promise<void> | undefined,
  entered: false,
  fail: false,
}));

vi.mock("../src/sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sqlite.js")>();
  return {
    ...actual,
    sqliteThreadSafety: async () =>
      threadSafety.value === "real" ? actual.sqliteThreadSafety() : threadSafety.value,
    openSqlite: async (path: string) => {
      if (storeOpens.path !== undefined && path === storeOpens.path) {
        storeOpens.entered = true;
        if (storeOpens.hold) await storeOpens.hold;
        if (storeOpens.fail) return null;
      }
      return actual.openSqlite(path);
    },
  };
});

/** A discovery hold: the next session discovery waits for it, once. */
const discovery = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined }));

vi.mock("../src/history/v2-discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/history/v2-discovery.js")>();
  return {
    ...actual,
    discoverSessions: async (...args: Parameters<typeof actual.discoverSessions>) => {
      const hold = discovery.hold;
      discovery.hold = undefined;
      if (hold) await hold;
      return actual.discoverSessions(...args);
    },
  };
});

let dir: string;
let v2: V2TestDb;
let storePath: string;
const runtimes: V2Runtime[] = [];
const held: SqliteDb[] = [];

beforeEach(async () => {
  threadSafety.value = "real";
  discovery.hold = undefined;
  Object.assign(storeOpens, { path: undefined, hold: undefined, entered: false, fail: false });
  dir = realpathSync(mkdtempSync(join(tmpdir(), "recall-v2-worker-")));
  storePath = join(dir, "store.db");
  v2 = await makeV2PartsDb();
  insertProject(v2.db, { id: "prj", worktree: "/w" });
  insertSession(v2.db, {
    id: "ses_a",
    project_id: "prj",
    directory: "/w",
    title: "Heron pipeline",
    time_created: 1_000,
    time_updated: 1_200,
  });
  insertMessage(v2.db, {
    id: "msg_a",
    session_id: "ses_a",
    type: "user",
    seq: 1,
    time_created: 1_100,
    data: { text: "where does the zephyrine cache live", time: { created: 1_100 } },
  });
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const db of held.splice(0)) db.close();
  vi.restoreAllMocks();
  v2.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(pred: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function options(over: Partial<V2RuntimeOptions> = {}): V2RuntimeOptions {
  return {
    ephemeral: false,
    storePath,
    opencodeDbPath: v2.path,
    semantic: undefined,
    limits: { ...TEST_LIMITS, coldPass: true },
    summaries: false,
    ...over,
  };
}

async function create(
  o: {
    options?: Partial<V2RuntimeOptions>;
    worker?: V2RuntimeInputs["worker"];
    wrapReader?: V2RuntimeInputs["wrapReader"];
    sync?: V2RuntimeInputs["sync"];
  } = {},
): Promise<{ runtime: V2Runtime; logs: string[] }> {
  const logs: string[] = [];
  const factory = v2RuntimeFactory({
    options: options(o.options),
    channel: "latest",
    log: (line) => logs.push(line),
    idleDebounceMs: 5,
    ...(o.worker !== undefined && { worker: o.worker }),
    ...(o.wrapReader && { wrapReader: o.wrapReader }),
    ...(o.sync && { sync: o.sync }),
  });
  const runtime = await factory.create(await factory.resolve());
  runtimes.push(runtime);
  return { runtime, logs };
}

async function dispose(runtime: V2Runtime): Promise<void> {
  runtimes.splice(runtimes.indexOf(runtime), 1);
  await runtime.dispose();
}

async function recall(runtime: V2Runtime, query: string): Promise<SearchOutput> {
  const tool = search(runtime.sourceFor("prj"), true, runtime.options.limits, runtime.deps);
  const text = toolResultText(
    await tool.execute({ query, scope: "global" } as never, makeContext().ctx),
  );
  return JSON.parse(text) as SearchOutput;
}

/** Whether `store` can write: the reader holds the read methods alone. */
const writable = (store: ReadStore | null): boolean =>
  typeof (store as Partial<Store> | null)?.upsertCard === "function";

async function leaseHolder(): Promise<string | undefined> {
  const db = await openSqlite(storePath);
  if (!db) throw new Error("no sqlite");
  try {
    const row = db.get("SELECT value FROM meta WHERE key = 'distill_lease'");
    return row ? (JSON.parse(String(row.value)) as { holder: string }).holder : undefined;
  } finally {
    db.close();
  }
}

/** Open the store as `identity`, run `seed`, and keep the connection open
 *  (with its WAL files) when `keep` is set, else close it. */
async function seedStore(
  identity: StoreIdentity,
  o: { keep?: boolean; seed?: (store: Store, db: SqliteDb) => void } = {},
): Promise<SqliteDb> {
  const db = await openSqlite(storePath);
  if (!db) throw new Error("no sqlite");
  const opened = openStore(db, identity);
  if (!opened.ok) throw new Error(opened.reason);
  o.seed?.(opened.store, db);
  opened.store.cardCounters();
  if (o.keep) held.push(db);
  else db.close();
  return db;
}

function makeCard(sessionId: string, title: string): Card {
  return {
    sessionId,
    parentId: null,
    rootId: sessionId,
    title,
    slug: sessionId,
    directory: "/w",
    projectId: "prj",
    agent: null,
    model: null,
    timeCreated: 1000,
    timeUpdated: 2000,
    partCount: 1,
    retainedChars: 1,
    summaryHead: "",
    outcomeHead: "",
    inventory: "",
    files: [],
    tools: [],
    errors: [],
    familyRollup: [],
    distillState: "full",
    distilledThrough: "m1",
    embedding: null,
    embeddingGen: null,
    nlSummary: "",
    summaryHash: "",
  };
}

/** A starter over `harness` that runs `after` on each new side. */
function startingWith(harness: WorkerHarness, after: (side: HandlerSide) => void): WorkerStarter {
  return async (generation) => {
    const worker = await harness.start(generation);
    const side = harness.side(generation);
    if (side) after(side);
    return worker;
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("where the distiller runs", () => {
  it("runs it in a worker over a store, a canonical opencode.db and a thread-safe SQLite", async () => {
    const harness = workerHarness();
    const { runtime } = await create({ worker: { start: harness.start } });
    expect(harness.sides).toHaveLength(1);
    expect(runtime.store).not.toBeNull();
    expect(writable(runtime.store)).toBe(false);
    await waitFor(() => runtime.distiller.status().leaseHeld, "the worker's lease");
    expect(await leaseHolder()).toMatch(/\/w1$/);

    await waitFor(() => runtime.store?.getCard("ses_a") !== undefined, "the card");
    const out = await recall(runtime, "zephyrine");
    expect(out.coverage?.history?.distiller).toBe("worker");
    expect(out.results.some((r) => r.sessionID === "ses_a")).toBe(true);
  }, 30_000);

  it("runs it in a worker when SQLite does not say how thread-safe it is", async () => {
    threadSafety.value = undefined;
    const harness = workerHarness();
    const { runtime } = await create({ worker: { start: harness.start } });
    expect(harness.sides).toHaveLength(1);
    expect(runtime.deps.distiller?.()).toBe("worker");
  });

  it.each([
    ["the worker is turned off", false as const, "real" as const],
    ["sqlite is not thread-safe", undefined, 0],
  ])(
    "runs it on this thread, labelled %s",
    async (label, worker, safety) => {
      threadSafety.value = safety;
      const harness = workerHarness();
      const { runtime } = await create({ worker: worker ?? { start: harness.start } });
      expect(harness.sides).toHaveLength(0);
      expect(writable(runtime.store)).toBe(true);
      expect(runtime.deps.distiller?.()).toBe(`inline: ${label}`);
      await waitFor(() => runtime.distiller.status().leaseHeld, "the lease");
      const holder = await leaseHolder();
      expect(holder).toBeTruthy();
      expect(holder).not.toMatch(/\/w\d+$/);
      const out = await recall(runtime, "zephyrine");
      expect(out.coverage?.history?.distiller).toBe(`inline: ${label}`);
    },
    30_000,
  );

  it("runs it on this thread for an in-memory store, starting no worker", async () => {
    const harness = workerHarness();
    const { runtime, logs } = await create({
      options: { storePath: ":memory:" },
      worker: { start: harness.start },
    });
    expect(harness.sides).toHaveLength(0);
    expect(writable(runtime.store)).toBe(true);
    expect(runtime.deps.distiller?.()).toBe(`inline: ${STORE_IN_MEMORY_REASON}`);
    await waitFor(() => runtime.store?.getCard("ses_a") !== undefined, "the card");
    expect(logs.filter((line) => /worker generation \d+ failed/.test(line))).toEqual([]);
  }, 30_000);

  it("opens a store without a distiller or a label when opencode.db does not open", async () => {
    const notADb = join(dir, "opencode.db");
    writeFileSync(notADb, "this is not a database");
    const harness = workerHarness();
    const { runtime } = await create({
      options: { opencodeDbPath: notADb },
      worker: { start: harness.start },
    });
    expect(runtime.unavailable).toBeDefined();
    expect(harness.sides).toHaveLength(0);
    expect(writable(runtime.store)).toBe(true);
    expect(runtime.deps.distiller?.()).toBeUndefined();
    expect(runtime.distiller.status().leaseHeld).toBe(false);
  });

  it("starts no worker without a store", async () => {
    const harness = workerHarness();
    const { runtime } = await create({
      options: { ephemeral: true },
      worker: { start: harness.start },
    });
    expect(runtime.store).toBeNull();
    expect(harness.sides).toHaveLength(0);
  });
});

describe("the card-only fallback", () => {
  /** A source path that cannot be canonicalized: it does not exist, in a
   *  directory that does. The store is stamped with its logical spelling. */
  const missingSource = (): string => join(dir, "opencode.db");
  const stampedFor = (): StoreIdentity => ({ host: "opencode-v2", source: missingSource() });

  async function fallback(): Promise<{
    runtime: V2Runtime;
    logs: string[];
    harness: WorkerHarness;
  }> {
    const harness = workerHarness();
    const made = await create({
      options: { opencodeDbPath: missingSource() },
      worker: { start: harness.start },
    });
    return { ...made, harness };
  }

  it("serves cards through a reader, with no writer, when a connection holds the store open", async () => {
    await seedStore(stampedFor(), {
      keep: true,
      seed: (store) => store.replaceSessionParts("ses_x", [], makeCard("ses_x", "Kestrel notes")),
    });
    const { runtime, logs, harness } = await fallback();
    expect(harness.sides).toHaveLength(0);
    expect(runtime.store?.getCard("ses_x")?.title).toBe("Kestrel notes");
    expect(writable(runtime.store)).toBe(false);
    expect(runtime.cards.get("ses_x")).toBeDefined();
    expect(logs.some((l) => l.includes("serving cards from the store stamped for"))).toBe(true);
  });

  it("opens the store writable for its existing layout when no connection holds it open", async () => {
    await seedStore(stampedFor(), {
      seed: (store) => store.replaceSessionParts("ses_x", [], makeCard("ses_x", "Kestrel notes")),
    });
    const { runtime, harness } = await fallback();
    expect(harness.sides).toHaveLength(0);
    expect(writable(runtime.store)).toBe(true);
    expect(runtime.store?.getCard("ses_x")?.title).toBe("Kestrel notes");
    expect(runtime.distiller.status().leaseHeld).toBe(false);
  });

  const unmatched: Array<[string, () => Promise<unknown>]> = [
    ["stamped for the v1 host", () => seedStore({ host: "opencode-v1" }, { keep: true })],
    [
      "stamped for another file",
      () => seedStore({ host: "opencode-v2", source: "/elsewhere/opencode.db" }, { keep: true }),
    ],
    ["missing", async () => undefined],
  ];
  it.each(unmatched)("serves no store when the store is %s", async (_label, seed) => {
    await seed();
    const { runtime, logs, harness } = await fallback();
    expect(runtime.store).toBeNull();
    expect(harness.sides).toHaveLength(0);
    expect(
      logs.some((l) => l.endsWith("could not be canonicalized; running degraded without a store")),
    ).toBe(true);
  });

  it("logs any other refusal of the stamped store and serves no store", async () => {
    const db = await seedStore(stampedFor(), { keep: true });
    db.run("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
    const { runtime, logs, harness } = await fallback();
    expect(runtime.store).toBeNull();
    expect(harness.sides).toHaveLength(0);
    expect(logs.some((l) => l.includes("(the store stamped for it was refused: newer)"))).toBe(
      true,
    );
  });

  it("creates no store file when there is none", async () => {
    await fallback();
    expect(existsSync(storePath)).toBe(false);
  });
});

describe("while the worker starts", () => {
  it("serves the degraded tier saying the index is starting, then the store's cards in place", async () => {
    const harness = workerHarness();
    const { runtime } = await create({
      worker: { start: startingWith(harness, (side) => side.delay(6_000, ["store"])) },
    });
    // Created after its 2.5 s wait, with the store result still held back.
    expect(runtime.store).toBeNull();
    expect(runtime.deps.cardsDegradedReason).toBe(INDEX_STARTING_REASON);
    const before = runtime.revision();

    // One background discovery fills the tier with metadata cards.
    await waitFor(() => runtime.cards.list({}).length > 0, "the discovered cards");
    const starting = await recall(runtime, "heron");
    expect(starting.coverage?.cards).toMatchObject({
      degraded: true,
      reason: INDEX_STARTING_REASON,
    });
    expect(starting.results.some((r) => r.sessionID === "ses_a")).toBe(true);
    expect(starting.warnings).toContain(
      `Cards are metadata-only (${INDEX_STARTING_REASON}); content search is degraded.`,
    );

    await waitFor(() => runtime.revision() > before && runtime.store !== null, "the store");
    expect(runtime.deps.cardsDegradedReason).toBeUndefined();
    await waitFor(() => runtime.store?.getCard("ses_a") !== undefined, "the card");
    const open = await recall(runtime, "zephyrine");
    expect(open.coverage?.cards?.degraded).toBe(false);
    expect(open.coverage?.cards).not.toHaveProperty("reason");
    expect(open.results.some((r) => r.sessionID === "ses_a")).toBe(true);
  }, 40_000);

  it("drops a degraded-tier discovery that ends after the store's card runtime was installed", async () => {
    let release!: () => void;
    discovery.hold = new Promise<void>((resolve) => (release = resolve));
    const harness = workerHarness();
    const { runtime } = await create({
      // No cold pass, so the degraded tier's discovery is the only one.
      options: { limits: { ...TEST_LIMITS, coldPass: false } },
      worker: { start: startingWith(harness, (side) => side.delay(3_000, ["store"])) },
    });
    expect(runtime.store).toBeNull();
    // The discovery started at the 2.5 s mark is held until the store opened.
    await waitFor(() => runtime.store !== null, "the store");
    const installed = runtime.cards;
    const invalidate = vi.spyOn(installed, "invalidate");
    release();
    await sleep(300);
    expect(invalidate).not.toHaveBeenCalled();
    expect(runtime.cards).toBe(installed);
  }, 40_000);
});

describe("main's store connection", () => {
  it("runs nothing but reads, while the worker distills and recall searches", async () => {
    const recorder = readerStatements();
    const { runtime } = await create({
      worker: { start: workerHarness().start },
      wrapReader: recorder.wrap,
    });
    await waitFor(() => runtime.store?.getCard("ses_a") !== undefined, "the card");
    const out = await recall(runtime, "zephyrine");
    expect(out.results.some((r) => r.sessionID === "ses_a")).toBe(true);
    await recall(runtime, "ses_a heron pipeline");
    expect(recorder.statements.length).toBeGreaterThan(0);
    expect(recorder.nonReads()).toEqual([]);
  }, 30_000);
});

describe("card counter reads on main's reader", () => {
  /** A reader wrapper whose counter read finds a lock while `busy` is set. */
  function busyCounters(): { wrap: (db: ReadOnlyDb) => ReadOnlyDb; busy: boolean; hits: number } {
    const state = {
      busy: false,
      hits: 0,
      wrap: (db: ReadOnlyDb): ReadOnlyDb => ({
        get: (sql, params) => {
          if (state.busy && sql.includes("AS cards_stamped")) {
            state.hits++;
            throw new SqliteBusyError("SQLITE_BUSY", new Error("database is locked"));
          }
          return db.get(sql, params);
        },
        all: (sql, params) => db.all(sql, params),
        close: () => db.close(),
      }),
    };
    return state;
  }

  it("read as unchanged when a refresh finds a lock, serving the cards loaded before", async () => {
    const counters = busyCounters();
    const { runtime } = await create({
      worker: { start: workerHarness().start },
      wrapReader: counters.wrap,
    });
    await waitFor(() => runtime.cards.get("ses_a") !== undefined, "the card");
    // Past the refresh interval, the next accessor reads the counters again.
    await sleep(5_200);
    counters.busy = true;
    expect(runtime.cards.list({}).map((card) => card.sessionId)).toContain("ses_a");
    expect(counters.hits).toBe(1);
  }, 30_000);

  it("throw a lock on the first counter read to the caller", async () => {
    const counters = busyCounters();
    const { runtime } = await create({
      options: { limits: { ...TEST_LIMITS, coldPass: false } },
      worker: { start: workerHarness().start },
      wrapReader: counters.wrap,
    });
    expect(runtime.store).not.toBeNull();
    counters.busy = true;
    expect(() => runtime.cards.list({})).toThrow(SqliteBusyError);
    expect(counters.hits).toBe(1);
  }, 30_000);
});

describe("while the worker runs", () => {
  it("hands host events to the worker's distiller", async () => {
    const { runtime } = await create({ worker: { start: workerHarness().start } });
    await waitFor(() => runtime.store?.getCard("ses_a") !== undefined, "the card");
    // A pass still running reads the session's metadata again once it ends,
    // so the database says what the event says, as the host's does. The
    // polls that would find the change unprompted run every 30 s and more.
    await waitFor(() => runtime.distiller.status().coldPass === "done", "the cold pass");
    v2.db.run("UPDATE session_v2 SET title = ? WHERE id = ?", ["Osprey pipeline", "ses_a"]);
    runtime.onEvent({
      id: "evt_rename",
      type: "session.renamed",
      data: { sessionID: "ses_a", title: "Osprey pipeline" },
    } as never);
    await waitFor(() => runtime.store?.getCard("ses_a")?.title === "Osprey pipeline", "the rename");
  }, 30_000);

  it("keeps main's reader through a replacement generation", async () => {
    const harness = workerHarness();
    const recorder = readerStatements();
    let opens = 0;
    const { runtime } = await create({
      worker: { start: harness.start },
      wrapReader: (db) => {
        opens++;
        return recorder.wrap(db);
      },
    });
    await waitFor(() => runtime.distiller.status().leaseHeld, "the worker's lease");
    const reader = runtime.store;
    const revision = runtime.revision();
    harness.side(1)?.crash();
    await waitFor(() => harness.sides.length === 2, "the replacement");
    await waitFor(
      () => harness.side(2)?.sent.some((m) => m.type === "status") === true,
      "the replacement's status",
    );
    await waitFor(() => runtime.distiller.status().leaseHeld, "the replacement's lease");
    expect(runtime.deps.distiller?.()).toBe("worker");
    expect(opens).toBe(1);
    expect(recorder.closes).toBe(0);
    expect(runtime.store).toBe(reader);
    expect(runtime.revision()).toBe(revision);
  }, 30_000);
});

describe("after the worker fails", () => {
  it("runs the distiller on this thread, taking over the last worker's lease at once", async () => {
    const harness = workerHarness();
    const recorder = readerStatements();
    const { runtime, logs } = await create({
      worker: { start: harness.start, maxFailures: 1 },
      wrapReader: recorder.wrap,
    });
    await waitFor(() => runtime.distiller.status().leaseHeld, "the worker's lease");
    const workerHolder = await leaseHolder();
    expect(workerHolder).toMatch(/\/w1$/);
    const before = runtime.revision();

    harness.side(1)?.crash();
    await waitFor(() => writable(runtime.store), "the writable store");
    expect(runtime.deps.distiller?.()).toBe("inline: the worker exited unexpectedly");
    expect(runtime.revision()).toBeGreaterThan(before);
    // The lease is live (TTL 30 s): only a takeover gets it this soon.
    await waitFor(() => runtime.distiller.status().leaseHeld, "the lease on this thread");
    expect(await leaseHolder()).toBe(workerHolder?.replace(/\/w1$/, ""));
    expect(harness.sides).toHaveLength(1);
    expect(logs).toContain(
      "the distiller runs on the main thread (the worker exited unexpectedly)",
    );
    // The reader closes once nothing reads through it.
    await waitFor(() => recorder.closes === 1, "the reader's close");

    const out = await recall(runtime, "zephyrine");
    expect(out.coverage?.history?.distiller).toBe("inline: the worker exited unexpectedly");
    expect(out.results.some((r) => r.sessionID === "ses_a")).toBe(true);
  }, 30_000);

  it("hands the distiller on this thread every signal queued before it and during its store's open", async () => {
    insertSession(v2.db, {
      id: "ses_b",
      project_id: "prj",
      directory: "/w",
      title: "Gannet pipeline",
      time_created: 1_000,
      time_updated: 1_300,
    });
    insertMessage(v2.db, {
      id: "msg_b",
      session_id: "ses_b",
      type: "user",
      seq: 1,
      time_created: 1_100,
      data: { text: "a gannet question", time: { created: 1_100 } },
    });
    const harness = workerHarness();
    const { runtime } = await create({
      worker: { start: harness.start, maxFailures: 1 },
      // No poll in the test's span: only the signals can change the cards.
      sync: { pollIntervalMs: 600_000 },
    });
    await waitFor(() => runtime.distiller.status().coldPass === "done", "the worker's cold pass");
    await waitFor(() => runtime.store?.getCard("ses_b") !== undefined, "the card of ses_b");
    // The cold pass on this thread waits, so it reconciles nothing meanwhile.
    let releaseDiscovery!: () => void;
    discovery.hold = new Promise<void>((resolve) => (releaseDiscovery = resolve));
    let releaseOpen!: () => void;
    storeOpens.hold = new Promise<void>((resolve) => (releaseOpen = resolve));
    storeOpens.path = storePath;

    harness.side(1)?.crash();
    // Queued in the controller while the failed generation's thread ends.
    runtime.onEvent({
      id: "evt_delete",
      type: "session.deleted",
      data: { sessionID: "ses_b" },
    } as never);
    await waitFor(() => storeOpens.entered, "the store's open on this thread");
    // Arrives while the store opens on this thread.
    runtime.onEvent({
      id: "evt_rename",
      type: "session.renamed",
      data: { sessionID: "ses_a", title: "Osprey pipeline" },
    } as never);
    releaseOpen();
    await waitFor(() => writable(runtime.store), "the writable store");
    await waitFor(() => runtime.distiller.status().leaseHeld, "the lease on this thread");
    expect(runtime.store?.getCard("ses_b")).toBeUndefined();
    expect(runtime.store?.getCard("ses_a")?.title).toBe("Osprey pipeline");
    releaseDiscovery();
  }, 30_000);

  it("reports indexing stopped when the store does not open on this thread, keeping the reader's cards", async () => {
    const harness = workerHarness();
    const { runtime, logs } = await create({ worker: { start: harness.start, maxFailures: 1 } });
    await waitFor(() => runtime.store?.getCard("ses_a") !== undefined, "the card");
    const reader = runtime.store;
    storeOpens.path = storePath;
    storeOpens.fail = true;

    harness.side(1)?.crash();
    const reason = "the store did not open on the main thread either (SQLite is unavailable)";
    await waitFor(() => runtime.deps.distiller?.() === `stopped: ${reason}`, "the stop");
    expect(logs).toContain(
      "the distiller could not run on the main thread either (SQLite is unavailable); serving the cards already stored",
    );
    expect(runtime.store).toBe(reader);
    const out = await recall(runtime, "zephyrine");
    expect(out.coverage?.history?.distiller).toBe(`stopped: ${reason}`);
    expect(out.results.some((r) => r.sessionID === "ses_a")).toBe(true);
    expect(
      out.warnings?.some((w) => w.startsWith(`New sessions are not being indexed: ${reason}.`)),
    ).toBe(true);
  }, 30_000);

  it("closes the reader only once the tool calls reading through it have settled", async () => {
    const harness = workerHarness();
    const recorder = readerStatements();
    const { runtime } = await create({
      worker: { start: harness.start, maxFailures: 1 },
      wrapReader: recorder.wrap,
    });
    await waitFor(() => runtime.distiller.status().leaseHeld, "the worker's lease");
    let release!: () => void;
    void runtime.track(new Promise<void>((resolve) => (release = resolve)));

    harness.side(1)?.crash();
    await waitFor(() => writable(runtime.store), "the writable store");
    // Past the bound a caller waits.
    await sleep(3_000);
    expect(recorder.closes).toBe(0);
    release();
    await waitFor(() => recorder.closes === 1, "the reader's close");
  }, 30_000);
});

describe("when indexing stops", () => {
  it("reports a store the worker refused as stopped, serves cards-lite and says how to fix it", async () => {
    await seedStore({ host: "opencode-v2", source: "/elsewhere/opencode.db" });
    const harness = workerHarness();
    const { runtime, logs } = await create({ worker: { start: harness.start } });
    expect(runtime.deps.distiller?.()).toBe("stopped: source-mismatch");
    expect(runtime.store).toBeNull();
    expect(logs).toContain(`store refused (source-mismatch): ${storePath}; running degraded`);
    await waitFor(() => runtime.cards.list({}).length > 0, "the discovered cards");

    const out = await recall(runtime, "heron");
    expect(out.coverage?.history?.distiller).toBe("stopped: source-mismatch");
    expect(out.coverage?.cards?.degraded).toBe(true);
    expect(out.results.some((r) => r.sessionID === "ses_a")).toBe(true);
    expect(out.warnings).toContain(
      `New sessions are not being indexed: source-mismatch. Indexing resumes after OpenCode restarts; if it does not, quit every OpenCode process and delete ${storePath} (it rebuilds), or set a separate storePath.`,
    );
    await sleep(200);
    expect(harness.sides).toHaveLength(1);
  }, 30_000);

  it("keeps serving the reader's cards when the worker reports the store damaged", async () => {
    let damaged = false;
    const harness = workerHarness({
      openStoreDb: async (path) => {
        const db = await openSqlite(path);
        if (!db) return null;
        const guard = (): void => {
          if (damaged) {
            throw Object.assign(new Error("database disk image is malformed"), {
              code: "ERR_SQLITE_ERROR",
              errcode: 11,
            });
          }
        };
        return {
          ...db,
          get: (sql, params) => {
            guard();
            return db.get(sql, params);
          },
          all: (sql, params) => {
            guard();
            return db.all(sql, params);
          },
          run: (sql, params) => {
            guard();
            return db.run(sql, params);
          },
        };
      },
    });
    const { runtime } = await create({ worker: { start: harness.start } });
    await waitFor(() => runtime.store?.getCard("ses_a") !== undefined, "the card");
    const reader = runtime.store;
    damaged = true;
    await waitFor(
      () => runtime.deps.distiller?.()?.startsWith("stopped: ") === true,
      "indexing to stop",
    );
    const reason = "the store file is damaged: database disk image is malformed";
    expect(runtime.deps.distiller?.()).toBe(`stopped: ${reason}`);
    expect(runtime.store).toBe(reader);

    const out = await recall(runtime, "zephyrine");
    expect(out.coverage?.cards?.degraded).toBe(false);
    expect(out.results.some((r) => r.sessionID === "ses_a")).toBe(true);
    expect(
      out.warnings?.some((w) => w.startsWith(`New sessions are not being indexed: ${reason}.`)),
    ).toBe(true);
  }, 30_000);
});

describe("dispose", () => {
  it("stops the worker and closes the reader before ending its thread, writing nothing after stopped", async () => {
    let side: HandlerSide | undefined;
    const afterStopped: string[] = [];
    const harness = workerHarness({
      openStoreDb: async (path) => {
        const db = await openSqlite(path);
        if (!db) return null;
        const note = (what: string): void => {
          if (side?.sent.some((m) => m.type === "stopped")) afterStopped.push(what);
        };
        return {
          exec: (sql) => {
            note(sql);
            db.exec(sql);
          },
          run: (sql, params) => {
            note(sql);
            return db.run(sql, params);
          },
          get: (sql, params) => {
            note(sql);
            return db.get(sql, params);
          },
          all: (sql, params) => {
            note(sql);
            return db.all(sql, params);
          },
          tx: (fn) => {
            note("tx");
            return db.tx(fn);
          },
          close: () => db.close(),
        };
      },
    });
    const recorder = readerStatements();
    let atReaderClose: { stopped: boolean; ended: boolean } | undefined;
    recorder.onClose = () => {
      atReaderClose = {
        stopped: side?.sent.some((m) => m.type === "stopped") === true,
        ended: side?.ended === true,
      };
    };
    const { runtime } = await create({
      worker: { start: startingWith(harness, (s) => (side = s)) },
      wrapReader: recorder.wrap,
    });
    await waitFor(() => runtime.distiller.status().leaseHeld, "the worker's lease");

    await dispose(runtime);
    expect(side?.received.some((m) => m.type === "stop")).toBe(true);
    expect(atReaderClose).toEqual({ stopped: true, ended: false });
    expect(recorder.closes).toBe(1);
    expect(side?.ended).toBe(true);
    expect(await leaseHolder()).toBe("");
    await sleep(300);
    expect(afterStopped).toEqual([]);
  }, 30_000);

  it("lets the next runtime on the store start its worker only once the last thread has ended", async () => {
    // A starter whose threads report their exit only when released.
    const first = workerHarness();
    const held: Array<() => void> = [];
    let holding = true;
    const holdExits: WorkerStarter = async (generation) => {
      const worker = await first.start(generation);
      return {
        ...worker,
        onExit: (listener) =>
          worker.onExit(() => {
            if (holding) held.push(listener);
            else listener();
          }),
      };
    };
    const { runtime: old } = await create({ worker: { start: holdExits } });
    await waitFor(() => old.distiller.status().leaseHeld, "the first worker's lease");
    runtimes.splice(runtimes.indexOf(old), 1);
    const disposing = old.dispose();
    await waitFor(() => first.side(1)?.ended === true, "the first worker's end");

    const second = workerHarness();
    const { runtime: next, logs } = await create({ worker: { start: second.start } });
    await sleep(500);
    expect(second.sides).toHaveLength(0);
    expect(next.deps.distiller?.()).toBe(
      "worker: waiting (an earlier worker on this store has not ended)",
    );
    expect(logs).toContain(
      "waiting for an earlier worker thread on this store to end before starting one",
    );

    holding = false;
    for (const listener of held.splice(0)) listener();
    await disposing;
    await waitFor(() => second.sides.length === 1, "the second worker");
    await waitFor(() => next.distiller.status().leaseHeld, "the second worker's lease");
    expect(next.deps.distiller?.()).toBe("worker");
  }, 40_000);

  it("returns within its bound and closes the reader once a tool call that outlived it settles", async () => {
    const recorder = readerStatements();
    const { runtime, logs } = await create({
      worker: { start: workerHarness().start },
      wrapReader: recorder.wrap,
    });
    await waitFor(() => runtime.distiller.status().leaseHeld, "the worker's lease");
    let release!: () => void;
    void runtime.track(new Promise<void>((resolve) => (release = resolve)));

    await dispose(runtime);
    expect(logs.some((line) => line.includes("outlived the 2500ms bound"))).toBe(true);
    expect(recorder.closes).toBe(0);
    release();
    await waitFor(() => recorder.closes === 1, "the reader's close");
  }, 30_000);

  it("leaves no worker, interval or pending timer behind across a reload", async () => {
    const live = new Set<unknown>();
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const longTimeouts = new Map<unknown, number>();
    let longCreated = 0;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      fn: () => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const handle = realSetInterval(fn, ms, ...args);
      live.add(handle);
      return handle;
    }) as typeof setInterval);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(((handle: unknown) => {
      live.delete(handle);
      realClearInterval(handle as Parameters<typeof clearInterval>[0]);
    }) as typeof clearInterval);
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: (...a: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const box: { handle?: unknown } = {};
      const wrapped = (...a: unknown[]): void => {
        longTimeouts.delete(box.handle);
        fn(...a);
      };
      const handle = realSetTimeout(wrapped, ms, ...args);
      box.handle = handle;
      if ((ms ?? 0) >= 1_000) {
        longTimeouts.set(handle, ms ?? 0);
        longCreated++;
      }
      return handle;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle: unknown) => {
      longTimeouts.delete(handle);
      realClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
    }) as typeof clearTimeout);

    // A reload: the runtime is disposed and another takes its store, while
    // the process lives on.
    const harness = workerHarness();
    for (let round = 0; round < 2; round++) {
      longCreated = 0;
      const { runtime } = await create({ worker: { start: harness.start } });
      await waitFor(() => runtime.distiller.status().leaseHeld, "the worker's lease");
      await waitFor(() => runtime.store?.getCard("ses_a") !== undefined, "the card");
      await recall(runtime, "zephyrine");
      // The worker's status timer, the watchdog and the distiller's
      // heartbeat, among others, run while it lives.
      expect(live.size).toBeGreaterThan(0);
      expect(longCreated).toBeGreaterThan(0);
      await dispose(runtime);
      await realSleep(realSetTimeout, 300);
      expect([...live]).toEqual([]);
      expect([...longTimeouts.values()]).toEqual([]);
      expect(harness.sides.every((s) => s.ended)).toBe(true);
    }
    expect(harness.sides).toHaveLength(2);
    vi.restoreAllMocks();
  }, 40_000);
});

describe("the v2 host's tool calls", () => {
  const cleanups: V2Cleanup[] = [];

  beforeEach(() => {
    resetRuntimeRegistryForTests();
  });

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    resetRuntimeRegistryForTests();
    delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
  });

  async function attach(): Promise<{ host: FakeV2Host; runtime: V2Runtime }> {
    const host = fakeV2Host({
      projectID: "prj",
      directory: "/w",
      options: { opencodeDbPath: v2.path, storePath, coldPass: true },
    });
    const cleanup = await entry.setup(host.ctx);
    if (!cleanup) throw new Error("setup stayed inert");
    cleanups.push(cleanup);
    const runtime = await instanceOf(host.ctx)?.attachment.ready(10_000);
    if (!runtime) throw new Error("the runtime never became ready");
    return { host, runtime };
  }

  async function call(host: FakeV2Host, input: unknown): Promise<SearchOutput> {
    const result = await host.runTool("recall", input, { sessionID: "ses_other" });
    return JSON.parse(result.content as string) as SearchOutput;
  }

  it("counts each tool call in the foreground signal while it runs", async () => {
    const { host, runtime } = await attach();
    const seen: number[] = [];
    const track = runtime.track;
    (runtime as { track: V2Runtime["track"] }).track = (operation) => {
      seen.push(runtime.foreground.count());
      return track(operation);
    };
    for (let i = 0; i < 3; i++) {
      expect((await call(host, { query: "zephyrine", scope: "global" })).ok).toBe(true);
      expect(runtime.foreground.count()).toBe(0);
    }
    expect(seen).toHaveLength(3);
    for (const count of seen) expect(count).toBeGreaterThanOrEqual(1);
    // A call that fails still leaves the count where it was.
    await host.runTool("recall_get", {}, { sessionID: "ses_other" });
    expect(seen).toHaveLength(4);
    expect(runtime.foreground.count()).toBe(0);
  }, 30_000);

  it("rebuilds its tools when the runtime's revision changes, and only then", async () => {
    const { host, runtime } = await attach();
    expect((await call(host, { query: "zephyrine" })).coverage?.history?.distiller).toBe("worker");

    const deps = runtime.deps;
    Object.defineProperty(runtime, "deps", {
      configurable: true,
      get: () => ({ ...deps, distiller: () => "replaced" }),
    });
    expect((await call(host, { query: "zephyrine" })).coverage?.history?.distiller).toBe("worker");

    const revision = runtime.revision;
    (runtime as { revision: () => number }).revision = () => revision() + 1;
    expect((await call(host, { query: "zephyrine" })).coverage?.history?.distiller).toBe(
      "replaced",
    );
  }, 30_000);
});

function realSleep(set: typeof setTimeout, ms: number): Promise<void> {
  return new Promise((resolve) => set(resolve, ms));
}

describe("the lease between writers on one store", () => {
  it("passes between main-thread distillers and a worker generation in both directions", async () => {
    // A main-thread writer, as an older build or a runtime without the worker
    // runs, holds the lease first.
    const first = await create({ worker: false });
    await waitFor(() => first.runtime.distiller.status().leaseHeld, "the first writer's lease");
    const firstHolder = await leaseHolder();
    expect(firstHolder).not.toMatch(/\/w\d+$/);

    // A worker generation beside it takes nothing: its takeOver names no one.
    const workerHarnessA = workerHarness();
    const contender = await create({ worker: { start: workerHarnessA.start } });
    await waitFor(() => contender.runtime.distiller.status().lease !== undefined, "a status");
    expect(contender.runtime.distiller.status().leaseHeld).toBe(false);
    expect(await leaseHolder()).toBe(firstHolder);
    await dispose(contender.runtime);
    expect(await leaseHolder()).toBe(firstHolder);

    // Released on stop, it goes to the next worker generation.
    await dispose(first.runtime);
    expect(await leaseHolder()).toBe("");
    const worker = await create({ worker: { start: workerHarness().start } });
    await waitFor(() => worker.runtime.distiller.status().leaseHeld, "the worker's lease");
    const workerHolder = await leaseHolder();
    expect(workerHolder).toMatch(/\/w1$/);

    // A second main-thread writer beside the worker takes nothing either.
    const second = await create({ worker: false });
    await sleep(300);
    expect(second.runtime.distiller.status().leaseHeld).toBe(false);
    expect(await leaseHolder()).toBe(workerHolder);
    await dispose(second.runtime);
    expect(await leaseHolder()).toBe(workerHolder);

    // Released by the worker's stop, it goes back to a main-thread writer.
    await dispose(worker.runtime);
    expect(await leaseHolder()).toBe("");
    const third = await create({ worker: false });
    await waitFor(() => third.runtime.distiller.status().leaseHeld, "the third writer's lease");
    const thirdHolder = await leaseHolder();
    expect(thirdHolder).not.toMatch(/\/w\d+$/);
    expect(thirdHolder).not.toBe(firstHolder);
    await dispose(third.runtime);
    expect(await leaseHolder()).toBe("");
  }, 60_000);
});
