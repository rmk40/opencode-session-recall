import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_ID } from "../src/build-id.js";
import { createDistiller, LEASE_TTL_MS, type Distiller } from "../src/distill.js";
import { EMBED_REPRESENTATION } from "../src/embedding-text.js";
import { createFetchGate } from "../src/fetch-gate.js";
import { createForegroundSignal, type ForegroundSignal } from "../src/foreground.js";
import { createUnavailableSource } from "../src/history/source.js";
import { V2_PLUGIN_BUILD } from "../src/host/v2-runtime.js";
import { openSqlite, type SqliteDb } from "../src/sqlite.js";
import { openReadStore, openStore, type Card, type Store } from "../src/store.js";
import {
  PROTOCOL_VERSION,
  type InitMessage,
  type MainMessage,
  type VectorRow,
  type WorkerMessage,
} from "../src/worker/protocol.js";
import type { WorkerLike } from "../src/worker/start.js";
import { TEST_LIMITS } from "./helpers.js";
import {
  insertMessage,
  insertProject,
  insertSession,
  makeV2PartsDb,
  type V2TestDb,
} from "./v2-db.js";
import {
  workerHarness,
  workerInit,
  type HandlerSide,
  type WorkerHarness,
} from "./worker-harness.js";

/**
 * The worker's side of the protocol (`runWorkerHandler`), run on the test's
 * thread through the inline harness over a real store and a real v2
 * `opencode.db`: what it accepts, how it opens and refuses the store, the
 * lease takeover it starts with, the status and revision hints it posts, how
 * it reacts to a damaged file, its vector writes, and how it stops and halts.
 */

/** Every `yieldBackgroundTo` call, with how many messages the traced handler
 *  had posted by then. */
const trace = vi.hoisted(() => ({
  calls: [] as Array<{ signal: unknown; sentBefore: number }>,
  sent: undefined as unknown[] | undefined,
}));

vi.mock("../src/yield.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/yield.js")>();
  return {
    ...actual,
    yieldBackgroundTo: (signal: ForegroundSignal | undefined) => {
      trace.calls.push({ signal, sentBefore: trace.sent?.length ?? -1 });
      actual.yieldBackgroundTo(signal);
    },
  };
});

let dir: string;
let v2: V2TestDb;
let sourcePath: string;
let storePath: string;
const harnesses: WorkerHarness[] = [];
const distillers: Distiller[] = [];
const dbs: SqliteDb[] = [];

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "recall-worker-handler-")));
  v2 = await makeV2PartsDb();
  insertProject(v2.db, { id: "prj", worktree: "/w" });
  insertSession(v2.db, {
    id: "ses_a",
    project_id: "prj",
    directory: "/w",
    time_created: 1_000,
    time_updated: 1_200,
  });
  insertMessage(v2.db, {
    id: "msg_a",
    session_id: "ses_a",
    type: "user",
    seq: 1,
    time_created: 1_100,
    data: { text: "a question about herons", time: { created: 1_100 } },
  });
  sourcePath = realpathSync(v2.path);
  storePath = join(dir, "store.db");
  trace.calls.length = 0;
  trace.sent = undefined;
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    for (const side of harness.sides) {
      side.crash();
      await side.handler.done;
    }
  }
  await Promise.all(distillers.splice(0).map((d) => d.stop()));
  for (const db of dbs.splice(0)) db.close();
  vi.restoreAllMocks();
  v2.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  read: () => T | undefined | false,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

type Sent<T extends WorkerMessage["type"]> = Extract<WorkerMessage, { type: T }>;

function sentOf<T extends WorkerMessage["type"]>(side: HandlerSide, type: T): Array<Sent<T>> {
  return side.sent.filter((m): m is Sent<T> => m.type === type);
}

function nextOf<T extends WorkerMessage["type"]>(
  side: HandlerSide,
  type: T,
  match: (message: Sent<T>) => boolean = () => true,
): Promise<Sent<T>> {
  return waitFor(() => sentOf(side, type).find(match), `a ${type} message`);
}

let nextId = 100;

function initMessage(
  o: {
    generation?: number;
    limits?: Partial<typeof TEST_LIMITS>;
    holderId?: string;
    takeOver?: string[];
    sourcePath?: string;
    foreground?: ForegroundSignal;
    idleDebounceMs?: number;
  } = {},
): InitMessage {
  return {
    v: PROTOCOL_VERSION,
    generation: o.generation ?? 1,
    type: "init",
    id: nextId++,
    deadline: Date.now() + 10_000,
    holderId: o.holderId ?? "main/w1",
    ...(o.takeOver !== undefined && { takeOver: o.takeOver }),
    ...workerInit({
      storePath,
      sourcePath: o.sourcePath ?? sourcePath,
      limits: { coldPass: false, ...o.limits },
      ...(o.foreground && { foreground: o.foreground }),
      ...(o.idleDebounceMs !== undefined && { idleDebounceMs: o.idleDebounceMs }),
    }),
  };
}

function vectorsMessage(
  o: {
    generation?: number;
    deadline?: number;
    representation?: number;
    rows?: VectorRow[];
  } = {},
): Extract<MainMessage, { type: "vectors" }> {
  return {
    v: PROTOCOL_VERSION,
    generation: o.generation ?? 1,
    type: "vectors",
    id: nextId++,
    deadline: o.deadline ?? Date.now() + 10_000,
    model: "test-model",
    representation: o.representation ?? EMBED_REPRESENTATION,
    rows: o.rows ?? [],
  };
}

function stopMessage(generation = 1, deadlineMs = 5_000): Extract<MainMessage, { type: "stop" }> {
  return {
    v: PROTOCOL_VERSION,
    generation,
    type: "stop",
    id: nextId++,
    deadline: Date.now() + deadlineMs,
  };
}

/** Start a handler of `generation` over `harness` (a fresh one by default). */
async function startSide(
  harness: WorkerHarness = workerHarness(),
  generation = 1,
): Promise<{ worker: WorkerLike; side: HandlerSide; harness: WorkerHarness }> {
  if (!harnesses.includes(harness)) harnesses.push(harness);
  const worker = await harness.start(generation);
  const side = harness.side(generation);
  if (!side) throw new Error("the harness recorded no side");
  return { worker, side, harness };
}

/** Send `message` and wait for the reply to its id. */
async function request(
  worker: WorkerLike,
  side: HandlerSide,
  message: Extract<MainMessage, { type: "vectors" }>,
): Promise<Sent<"reply">> {
  worker.postMessage(message);
  return nextOf(side, "reply", (reply) => reply.id === message.id);
}

/** Open the store as this host would, run `seed` on it, and close it. */
async function seedStore(
  seed: (store: Store, db: SqliteDb) => void,
  identity: Parameters<typeof openStore>[1] = { host: "opencode-v2", source: sourcePath },
): Promise<void> {
  const db = await openSqlite(storePath);
  if (!db) throw new Error("no sqlite");
  const opened = openStore(db, identity);
  if (!opened.ok) throw new Error(opened.reason);
  seed(opened.store, db);
  db.close();
}

/** The lease row as a connection of the test's own reads it. */
async function leaseRow(): Promise<{ holder: string; heartbeat: number } | undefined> {
  const db = await openSqlite(storePath);
  if (!db) throw new Error("no sqlite");
  try {
    const row = db.get("SELECT value FROM meta WHERE key = 'distill_lease'");
    return row
      ? (JSON.parse(String(row.value)) as { holder: string; heartbeat: number })
      : undefined;
  } finally {
    db.close();
  }
}

async function setMeta(key: string, value: string): Promise<void> {
  const db = await openSqlite(storePath);
  if (!db) throw new Error("no sqlite");
  try {
    db.run("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)", [key, value]);
  } finally {
    db.close();
  }
}

function makeCard(sessionId: string): Card {
  return {
    sessionId,
    parentId: null,
    rootId: sessionId,
    title: "",
    slug: sessionId,
    directory: "",
    projectId: "",
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

const vectorRow = (sessionId: string): VectorRow => ({
  sessionId,
  embedding: new Uint8Array([1, 2, 3, 4]),
  expectedSummaryHash: "",
});

/** A store opener that records every call the handler's connection takes,
 *  with how many messages the traced side had posted by then. */
function recordingOpener(o: { fail?: () => unknown } = {}): {
  open: (path: string) => Promise<SqliteDb | null>;
  calls: Array<{ method: string; sql: string; sentBefore: number }>;
  closes: number[];
} {
  const calls: Array<{ method: string; sql: string; sentBefore: number }> = [];
  const closes: number[] = [];
  const at = (): number => trace.sent?.length ?? -1;
  return {
    calls,
    closes,
    open: async (path) => {
      const db = await openSqlite(path);
      if (!db) return null;
      const guard = (method: string, sql = ""): void => {
        calls.push({ method, sql, sentBefore: at() });
        const error = o.fail?.();
        if (error) throw error;
      };
      return {
        exec: (sql) => {
          guard("exec", sql);
          db.exec(sql);
        },
        run: (sql, params) => {
          guard("run", sql);
          return db.run(sql, params);
        },
        get: (sql, params) => {
          guard("get", sql);
          return db.get(sql, params);
        },
        all: (sql, params) => {
          guard("all", sql);
          return db.all(sql, params);
        },
        tx: (fn) => {
          guard("tx");
          return db.tx(fn);
        },
        close: () => {
          closes.push(at());
          db.close();
        },
      };
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("start and init", () => {
  it("posts ready with this build's id as soon as it runs, and nothing else before init", async () => {
    const { side } = await startSide();
    expect(side.sent).toEqual([
      { v: PROTOCOL_VERSION, generation: 1, type: "ready", buildId: BUILD_ID },
    ]);
    await sleep(300);
    expect(side.sent).toHaveLength(1);
  });

  it("accepts only the first init", async () => {
    const opener = recordingOpener();
    const { worker, side } = await startSide(workerHarness({ openStoreDb: opener.open }));
    const first = initMessage();
    worker.postMessage(first);
    worker.postMessage(initMessage());
    await nextOf(side, "store");
    // Messages are handled in order: once this reply is back, the second
    // init has been seen too.
    expect((await request(worker, side, vectorsMessage())).outcome).toBe("committed");
    expect(sentOf(side, "store")).toEqual([
      { v: PROTOCOL_VERSION, generation: 1, type: "store", id: first.id, ok: true },
    ]);
    expect(opener.closes).toEqual([]);
  });

  it("answers an init of another protocol version with a fatal crash and still takes a valid one", async () => {
    const { worker, side } = await startSide();
    worker.postMessage({ ...initMessage(), v: PROTOCOL_VERSION + 1 } as never);
    // A message of another version that is not an init is dropped quietly.
    worker.postMessage({ ...stopMessage(), v: PROTOCOL_VERSION + 1 } as never);
    const fatal = await nextOf(side, "fatal");
    expect(fatal).toMatchObject({ kind: "crash", reason: "protocol version mismatch" });
    worker.postMessage(initMessage());
    expect(await nextOf(side, "store")).toMatchObject({ ok: true });
    expect(sentOf(side, "fatal")).toHaveLength(1);
  });

  it("ignores every message of another generation", async () => {
    const { worker, side } = await startSide();
    // Were it handled, this init's foreign build id would end in a fatal.
    worker.postMessage({ ...initMessage({ generation: 2 }), buildId: "another-build" });
    worker.postMessage(initMessage());
    await nextOf(side, "store");
    worker.postMessage(stopMessage(2));
    const foreign = vectorsMessage({ generation: 2 });
    worker.postMessage(foreign);
    // Handled in order: by this reply, both foreign messages were seen.
    expect((await request(worker, side, vectorsMessage())).outcome).toBe("committed");
    expect(sentOf(side, "reply").map((reply) => reply.id)).not.toContain(foreign.id);
    expect(sentOf(side, "stopped")).toEqual([]);
    expect(sentOf(side, "fatal")).toEqual([]);
  });

  it.each([
    ["buildId", { buildId: "another-build" }],
    ["build", { build: "schema0.gen0.proj0.opencode-v2" }],
    ["representation", { representation: EMBED_REPRESENTATION + 1 }],
    ["projectorGen", { projectorGen: 999 }],
  ] as const)(
    "refuses an init whose %s differs from its own with a fatal crash, opening nothing",
    async (key, override) => {
      const opener = recordingOpener();
      const { worker, side } = await startSide(workerHarness({ openStoreDb: opener.open }));
      worker.postMessage({ ...initMessage(), ...override });
      const fatal = await nextOf(side, "fatal");
      expect(fatal.kind).toBe("crash");
      expect(fatal.reason.startsWith(`build mismatch: main has ${key} `)).toBe(true);
      await sleep(100);
      expect(opener.calls).toEqual([]);
      expect(sentOf(side, "store")).toEqual([]);
    },
  );
});

describe("opening the store", () => {
  it("reports an opencode.db that does not open as a fatal crash, before opening the store", async () => {
    const opener = recordingOpener();
    const { worker, side } = await startSide(workerHarness({ openStoreDb: opener.open }));
    worker.postMessage(initMessage({ sourcePath: join(dir, "missing", "opencode.db") }));
    const fatal = await nextOf(side, "fatal");
    expect(fatal.kind).toBe("crash");
    expect(fatal.reason.startsWith("opencode history unavailable: ")).toBe(true);
    expect(opener.calls).toEqual([]);
  });

  it("waits for a store whose write lock another connection holds, announcing each wait, and opens it once the lock is free", async () => {
    let locked = 2;
    const busy = (): Error =>
      Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
    const { worker, side } = await startSide(
      workerHarness({
        lockRetryMs: { first: 20, max: 30 },
        openStoreDb: async (path) => {
          const db = await openSqlite(path);
          if (!db) return db;
          return {
            ...db,
            tx<T>(fn: () => T): T {
              if (locked > 0) {
                locked--;
                throw busy();
              }
              return db.tx(fn);
            },
          };
        },
      }),
    );
    worker.postMessage(initMessage());
    const store = await nextOf(side, "store");
    expect(store.ok).toBe(true);
    expect(
      sentOf(side, "waiting").map(({ attempt, retryInMs, reason }) => ({
        attempt,
        retryInMs,
        reason,
      })),
    ).toEqual([
      { attempt: 1, retryInMs: 20, reason: "another process holds the store's write lock" },
      { attempt: 2, retryInMs: 30, reason: "another process holds the store's write lock" },
    ]);
    expect(sentOf(side, "fatal")).toEqual([]);
  });

  it("stops at once while it waits for the store lock, posting stopped and no store result", async () => {
    const { worker, side } = await startSide(
      workerHarness({
        lockRetryMs: { first: 60_000, max: 60_000 },
        openStoreDb: async (path) => {
          const db = await openSqlite(path);
          if (!db) return db;
          return {
            ...db,
            tx<T>(): T {
              throw Object.assign(new Error("database is locked"), {
                code: "ERR_SQLITE_ERROR",
                errcode: 5,
              });
            },
          };
        },
      }),
    );
    worker.postMessage(initMessage());
    await nextOf(side, "waiting");
    worker.postMessage({
      v: PROTOCOL_VERSION,
      generation: 1,
      type: "stop",
      id: 99,
      deadline: Date.now() + 2_000,
    });
    expect(await nextOf(side, "stopped")).toMatchObject({ id: 99 });
    await sleep(50);
    expect(sentOf(side, "store")).toEqual([]);
  });

  it("reports a store connection SQLite cannot open as a fatal crash", async () => {
    const { worker, side } = await startSide(workerHarness({ openStoreDb: async () => null }));
    worker.postMessage(initMessage());
    expect(await nextOf(side, "fatal")).toMatchObject({
      kind: "crash",
      reason: "SQLite could not open the store",
    });
    expect(sentOf(side, "store")).toEqual([]);
  });

  it.each([
    [
      "source-mismatch",
      () => seedStore(() => {}, { host: "opencode-v2", source: "/elsewhere/opencode.db" }),
    ],
    ["host-mismatch", () => seedStore(() => {}, { host: "opencode-v1" })],
    [
      "newer",
      () =>
        seedStore((_store, db) =>
          db.run("UPDATE meta SET value = '999' WHERE key = 'schema_version'"),
        ),
    ],
    [
      "error",
      async () => {
        // A meta table of another shape: the fence's first read throws.
        const db = await openSqlite(storePath);
        if (!db) throw new Error("no sqlite");
        db.exec("CREATE TABLE meta (x INTEGER)");
        db.close();
      },
    ],
  ] as const)(
    "reports a %s refusal as a store result, not a fatal, and closes the connection",
    async (reason, seed) => {
      await seed();
      const opener = recordingOpener();
      const { worker, side } = await startSide(workerHarness({ openStoreDb: opener.open }));
      worker.postMessage(initMessage({ limits: { coldPass: true } }));
      const store = await nextOf(side, "store");
      expect(store).toMatchObject({ ok: false, reason });
      expect(opener.closes).toHaveLength(1);
      await sleep(300);
      expect(sentOf(side, "fatal")).toEqual([]);
      expect(sentOf(side, "status")).toEqual([]);
    },
  );

  it("leaves a new store's WAL files in place before it reports the store open, so a reader opens at once", async () => {
    const { worker, side } = await startSide();
    worker.postMessage(initMessage());
    expect(await nextOf(side, "store")).toMatchObject({ ok: true });
    const reader = await openReadStore(storePath, { host: "opencode-v2", source: sourcePath });
    expect(reader.ok).toBe(true);
    if (reader.ok) reader.close();
  });

  it("gives this thread's background yields to the foreground signal from init", async () => {
    const foreground = createForegroundSignal();
    const { worker, side } = await startSide();
    worker.postMessage(initMessage({ foreground }));
    await nextOf(side, "store");
    const given = trace.calls.at(-1)?.signal as ForegroundSignal | undefined;
    expect(given).toBeDefined();
    // The handler's signal counts what main's does: they share one buffer.
    await foreground.run(async () => {
      expect(given?.count()).toBe(1);
    });
    expect(given?.count()).toBe(0);
  });
});

describe("the first lease acquire", () => {
  async function seedLease(holder: string): Promise<void> {
    await seedStore((store) => {
      expect(store.acquireLease(holder, LEASE_TTL_MS, V2_PLUGIN_BUILD, EMBED_REPRESENTATION)).toBe(
        true,
      );
    });
  }

  it("takes over the live lease of the predecessor init names", async () => {
    await seedLease("main/w1");
    const { worker, side } = await startSide();
    worker.postMessage(
      initMessage({ holderId: "main/w2", takeOver: ["main/w1"], limits: { coldPass: true } }),
    );
    await nextOf(side, "store");
    const status = await nextOf(side, "status");
    expect(status.status.holderId).toBe("main/w2");
    expect(status.status.distill.leaseHeld).toBe(true);
    expect((await leaseRow())?.holder).toBe("main/w2");
  });

  it("leaves a live lease alone without a takeOver", async () => {
    await seedLease("main/w1");
    const { worker, side } = await startSide();
    worker.postMessage(initMessage({ holderId: "main/w2", limits: { coldPass: true } }));
    const status = await nextOf(side, "status");
    expect(status.status.distill.leaseHeld).toBe(false);
    expect((await leaseRow())?.holder).toBe("main/w1");
  });

  it("starts no distiller, and so takes no lease, without a cold pass", async () => {
    const { worker, side } = await startSide();
    worker.postMessage(initMessage({ limits: { coldPass: false } }));
    const status = await nextOf(side, "status");
    expect(status.status.distill.leaseHeld).toBe(false);
    expect(await leaseRow()).toBeUndefined();
  });

  it("posts a status at once when a later acquire takes the lease, whatever its clock's rate limit", async () => {
    await seedLease("rival");
    // The handler's clock never moves: only a status posted at once passes
    // its rate limit after the first.
    const { worker, side } = await startSide(
      workerHarness({ now: () => 1_000_000, leaseRetryMs: 20 }),
    );
    worker.postMessage(initMessage({ holderId: "main/w2", limits: { coldPass: true } }));
    const first = await nextOf(side, "status");
    expect(first.status.distill.leaseHeld).toBe(false);

    const db = await openSqlite(storePath);
    if (!db) throw new Error("no sqlite");
    dbs.push(db);
    db.run("UPDATE meta SET value=? WHERE key='distill_lease'", [
      JSON.stringify({ holder: "", heartbeat: 0, ttl: LEASE_TTL_MS, build: "", gen: 0 }),
    ]);
    const held = await nextOf(side, "status", (m) => m.status.distill.leaseHeld);
    expect(held.status.holderId).toBe("main/w2");
  });

  it("never takes the predecessor's lease over on a later acquire", async () => {
    const db = await openSqlite(storePath);
    if (!db) throw new Error("no sqlite");
    dbs.push(db);
    const opened = openStore(db, { host: "opencode-v2", source: sourcePath });
    if (!opened.ok) throw new Error(opened.reason);
    const store = opened.store;
    const take = (holder: string): boolean =>
      store.acquireLease(holder, LEASE_TTL_MS, V2_PLUGIN_BUILD, EMBED_REPRESENTATION);
    expect(take("rival")).toBe(true);

    const distiller = createDistiller({
      source: createUnavailableSource("v2-sqlite", "not read here"),
      store,
      gate: createFetchGate({ concurrency: 1 }),
      limits: { ...TEST_LIMITS, coldPass: false },
      instanceId: "main/w2",
      takeOverLease: "main/w1",
      leaseRetryMs: 20,
    });
    distillers.push(distiller);
    distiller.start();
    expect(distiller.status().leaseHeld).toBe(false);

    // The named predecessor holds it now, live: the retries leave it alone.
    expect(store.releaseLease("rival")).toBe(true);
    expect(take("main/w1")).toBe(true);
    await sleep(300);
    expect(distiller.status().leaseHeld).toBe(false);
    expect(store.leaseStatus()?.holder).toBe("main/w1");

    // Released, it is acquired as any free lease is.
    expect(store.releaseLease("main/w1")).toBe(true);
    await waitFor(() => distiller.status().leaseHeld, "the lease");
    expect(store.leaseStatus()?.holder).toBe("main/w2");
  });
});

describe("status", () => {
  it("posts a status right after the store, then on change at most once a second by its clock", async () => {
    let clock = 1_000_000;
    const { worker, side } = await startSide(workerHarness({ now: () => clock }));
    worker.postMessage(initMessage());
    await nextOf(side, "store");
    const first = await nextOf(side, "status");
    expect(side.sent.indexOf(first)).toBe(side.sent.findIndex((m) => m.type === "store") + 1);
    expect(first.status.discoveryTruncated).toBe(false);

    // A change within the second waits for the second to pass.
    await setMeta("discovery_truncated", "1");
    await sleep(700);
    expect(sentOf(side, "status")).toHaveLength(1);
    clock += 1_000;
    await waitFor(() => sentOf(side, "status").length === 2, "the second status");
    expect(sentOf(side, "status")[1]?.status.discoveryTruncated).toBe(true);

    await setMeta("discovery_truncated", "0");
    clock += 999;
    await sleep(700);
    expect(sentOf(side, "status")).toHaveLength(2);
    clock += 1;
    await waitFor(() => sentOf(side, "status").length === 3, "the third status");
    expect(sentOf(side, "status")[2]?.status.discoveryTruncated).toBe(false);

    // Nothing changed: nothing is posted, however long it has been.
    clock += 10_000;
    await sleep(700);
    expect(sentOf(side, "status")).toHaveLength(3);
  }, 20_000);

  it("reports the longest store call since the last status, which alone posts nothing", async () => {
    let clock = 1_000_000;
    // Store transactions look 5 s long to the handler's timing while `slow`.
    let slow = false;
    let offset = 0;
    const realNow = performance.now.bind(performance);
    vi.spyOn(performance, "now").mockImplementation(() => realNow() + offset);
    const harness = workerHarness({
      now: () => clock,
      openStoreDb: async (path) => {
        const db = await openSqlite(path);
        if (!db) return null;
        return {
          ...db,
          tx: (fn) => {
            if (slow) offset += 5_000;
            return db.tx(fn);
          },
        };
      },
    });
    const { worker, side } = await startSide(harness);
    worker.postMessage(initMessage());
    await nextOf(side, "status");

    clock += 1_000;
    slow = true;
    expect((await request(worker, side, vectorsMessage())).outcome).toBe("committed");
    slow = false;
    await sleep(700);
    expect(sentOf(side, "status")).toHaveLength(1);

    await setMeta("discovery_truncated", "1");
    await waitFor(() => sentOf(side, "status").length === 2, "the second status");
    expect(sentOf(side, "status")[1]?.status.longestStoreCallMs).toBeGreaterThanOrEqual(5_000);

    clock += 1_000;
    await setMeta("discovery_truncated", "0");
    await waitFor(() => sentOf(side, "status").length === 3, "the third status");
    expect(sentOf(side, "status")[2]?.status.longestStoreCallMs).toBeLessThan(5_000);
  }, 20_000);
});

describe("a damaged store file", () => {
  const corrupt = (): Error =>
    Object.assign(new Error("database disk image is malformed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 11,
    });

  it("posts fatal store once and makes no further call on the connection", async () => {
    let damaged = false;
    const opener = recordingOpener({ fail: () => (damaged ? corrupt() : undefined) });
    const { worker, side } = await startSide(workerHarness({ openStoreDb: opener.open }));
    trace.sent = side.sent;
    worker.postMessage(initMessage());
    await nextOf(side, "store");
    await nextOf(side, "status");

    damaged = true;
    // Whichever store call meets the damage first (this write, or the
    // status check) severs the store.
    expect((await request(worker, side, vectorsMessage())).outcome).toBe("failed");
    const fatal = await nextOf(side, "fatal");
    expect(fatal.kind).toBe("store");
    expect(fatal.reason).toBe("the store file is damaged: database disk image is malformed");
    damaged = false;
    const callsAtFatal = opener.calls.length;

    expect(await request(worker, side, vectorsMessage())).toMatchObject({
      outcome: "failed",
      reason: "the store is not open",
    });
    const statuses = sentOf(side, "status").length;
    await sleep(700);
    worker.postMessage(stopMessage());
    await nextOf(side, "stopped");
    expect(sentOf(side, "fatal")).toHaveLength(1);
    expect(sentOf(side, "status")).toHaveLength(statuses);
    // Not even the stop's checkpoint: only the close.
    expect(opener.calls.slice(callsAtFatal)).toEqual([]);
    expect(opener.closes).toHaveLength(1);
  }, 15_000);
});

describe("vector writes", () => {
  it("fail before the store is open", async () => {
    const { worker, side } = await startSide();
    expect(await request(worker, side, vectorsMessage())).toMatchObject({
      outcome: "failed",
      reason: "the store is not open",
    });
  });

  it("are refused past their deadline without touching the store", async () => {
    const { worker, side } = await startSide();
    worker.postMessage(initMessage());
    await nextOf(side, "store");
    expect(await request(worker, side, vectorsMessage({ deadline: Date.now() - 1 }))).toMatchObject(
      { outcome: "refused", reason: "the deadline passed before the write ran" },
    );
    // Nothing was written: the next write is the store's first.
    expect(await request(worker, side, vectorsMessage())).toMatchObject({
      outcome: "committed",
      revision: 1,
    });
  });

  it("commit with the store's new vectors revision", async () => {
    await seedStore((store) => store.replaceSessionParts("ses_x", [], makeCard("ses_x")));
    const { worker, side } = await startSide();
    worker.postMessage(initMessage());
    await nextOf(side, "store");
    expect(await request(worker, side, vectorsMessage({ rows: [vectorRow("ses_x")] }))).toEqual({
      v: PROTOCOL_VERSION,
      generation: 1,
      type: "reply",
      id: expect.any(Number) as number,
      outcome: "committed",
      revision: 1,
    });
    expect(await request(worker, side, vectorsMessage())).toMatchObject({ revision: 2 });
  });

  it("fail with the driver's message when the write throws, and the store stays open", async () => {
    await seedStore((store) => store.replaceSessionParts("ses_x", [], makeCard("ses_x")));
    const { worker, side } = await startSide();
    worker.postMessage(initMessage());
    await nextOf(side, "store");
    const bad: VectorRow = {
      sessionId: "ses_x",
      embedding: { not: "bytes" } as unknown as Uint8Array,
      expectedSummaryHash: "",
    };
    const reply = await request(worker, side, vectorsMessage({ rows: [bad] }));
    expect(reply.outcome).toBe("failed");
    expect(reply.reason).toBeTruthy();
    expect(reply.reason).not.toBe("the store is not open");
    expect(sentOf(side, "fatal")).toEqual([]);
    expect((await request(worker, side, vectorsMessage())).outcome).toBe("committed");
  });

  it("fail once a stop has arrived", async () => {
    const { worker, side } = await startSide();
    worker.postMessage(initMessage());
    await nextOf(side, "store");
    worker.postMessage(stopMessage());
    expect(await request(worker, side, vectorsMessage())).toMatchObject({
      outcome: "failed",
      reason: "the store is not open",
    });
    await nextOf(side, "stopped");
  });
});

describe("events", () => {
  it("hands each well-formed signal to the distiller, skips the rest and acknowledges each batch", async () => {
    const { worker, side } = await startSide();
    worker.postMessage(initMessage({ limits: { coldPass: true }, idleDebounceMs: 5 }));
    const status = await nextOf(side, "status");
    expect(status.status.distill.leaseHeld).toBe(true);
    const db = await openSqlite(storePath);
    if (!db) throw new Error("no sqlite");
    dbs.push(db);
    const carded = (id: string): boolean =>
      db.get("SELECT session_id FROM card WHERE session_id = ?", [id]) !== undefined;
    // The cold pass listed its sessions before it wrote this card: a session
    // added now is found only through a signal (the polls run every 30 s).
    await waitFor(() => carded("ses_a"), "the card of ses_a");

    insertSession(v2.db, {
      id: "ses_b",
      project_id: "prj",
      directory: "/w",
      time_created: 5_000,
      time_updated: 5_200,
    });
    insertMessage(v2.db, {
      id: "msg_b",
      session_id: "ses_b",
      type: "user",
      seq: 1,
      time_created: 5_100,
      data: { text: "a question about cranes", time: { created: 5_100 } },
    });
    const events = (batch: number, signals: unknown): MainMessage =>
      ({ v: PROTOCOL_VERSION, generation: 1, type: "events", batch, signals }) as MainMessage;
    worker.postMessage(events(1, "not a list"));
    worker.postMessage(
      events(2, [
        null,
        7,
        { type: "turn-ended" },
        { type: "turn-ended", sessionID: 42 },
        { type: "launched", sessionID: "ses_b" },
        { type: "turn-ended", sessionID: "ses_b" },
      ]),
    );
    await waitFor(() => carded("ses_b"), "the card of ses_b");
    expect(sentOf(side, "fatal")).toEqual([]);
    // Each batch is acknowledged once it was handled, a malformed one too.
    expect(sentOf(side, "ack").map((ack) => ack.batch)).toEqual([1, 2]);
  }, 15_000);

  it("acknowledges no batch whose dispatch threw, and reports the crash", async () => {
    // Every deletion of a card fails, as a write the disk refuses does.
    const harness = workerHarness({
      openStoreDb: async (path) => {
        const db = await openSqlite(path);
        if (!db) return null;
        return {
          ...db,
          run: (sql, params) => {
            if (/^DELETE FROM card\b/.test(sql.trim())) throw new Error("disk I/O error");
            return db.run(sql, params);
          },
        };
      },
    });
    const { worker, side } = await startSide(harness);
    worker.postMessage(initMessage({ limits: { coldPass: true }, idleDebounceMs: 5 }));
    const status = await nextOf(side, "status");
    expect(status.status.distill.leaseHeld).toBe(true);
    worker.postMessage({
      v: PROTOCOL_VERSION,
      generation: 1,
      type: "events",
      batch: 7,
      signals: [{ type: "deleted", sessionID: "ses_a" }],
    } as MainMessage);
    const fatal = await nextOf(side, "fatal");
    expect(fatal.kind).toBe("crash");
    expect(sentOf(side, "ack")).toEqual([]);
  }, 15_000);
});

describe("stop", () => {
  it("releases the lease, checkpoints and closes before it posts stopped, and writes nothing after", async () => {
    const opener = recordingOpener();
    const { worker, side } = await startSide(workerHarness({ openStoreDb: opener.open }));
    trace.sent = side.sent;
    worker.postMessage(initMessage({ limits: { coldPass: true } }));
    const status = await nextOf(side, "status");
    expect(status.status.distill.leaseHeld).toBe(true);

    const stop = stopMessage();
    worker.postMessage(stop);
    const stopped = await nextOf(side, "stopped");
    expect(stopped.id).toBe(stop.id);
    await side.handler.done;
    const stoppedAt = side.sent.indexOf(stopped);

    const release = opener.calls.findIndex((c) =>
      c.sql.includes("UPDATE meta SET value=? WHERE key=? AND json_extract(value,'$.holder')=?"),
    );
    // The distiller checkpoints as it goes; the stop's own is the last.
    const checkpoint = opener.calls.findLastIndex((c) => c.sql.includes("wal_checkpoint(PASSIVE)"));
    expect(release).toBeGreaterThanOrEqual(0);
    expect(checkpoint).toBeGreaterThan(release);
    expect(opener.closes).toEqual([stoppedAt]);
    // yieldBackgroundTo(undefined) after the close, before stopped.
    const cleared = trace.calls.at(-1);
    expect(cleared?.signal).toBeUndefined();
    expect(cleared?.sentBefore).toBe(stoppedAt);

    expect((await leaseRow())?.holder).toBe("");
    await sleep(500);
    expect(opener.calls.every((c) => c.sentBefore <= stoppedAt)).toBe(true);
    expect(side.sent.slice(stoppedAt + 1)).toEqual([]);
  }, 15_000);
});

describe("log lines", () => {
  it("posts at most 200 a second, each cut to 2,000 characters, and counts the rest on the next", async () => {
    let clock = 1_000_000;
    // The fence's and the lease's transactions commit; every later write
    // fails, and each failed re-distill logs a line.
    let transactions = 0;
    const harness = workerHarness({
      now: () => clock,
      openStoreDb: async (path) => {
        const db = await openSqlite(path);
        if (!db) return null;
        return {
          ...db,
          tx: (fn) => {
            if (++transactions > 2) throw new Error("disk I/O error");
            return db.tx(fn);
          },
        };
      },
    });
    const long = `ses_${"x".repeat(2_500)}`;
    const ids = [long, ...Array.from({ length: 230 }, (_, i) => `ses_n${i}`)];
    v2.db.tx(() => {
      for (const [i, id] of ids.entries()) {
        insertSession(v2.db, {
          id,
          project_id: "prj",
          directory: "/w",
          time_created: 10_000 + i,
          time_updated: 10_000 + i,
        });
        insertMessage(v2.db, {
          id: `msg_${i}`,
          session_id: id,
          type: "user",
          seq: 1,
          time_created: 10_000 + i,
          data: { text: "hello", time: { created: 10_000 + i } },
        });
      }
    });
    const { worker, side } = await startSide(harness);
    worker.postMessage(
      initMessage({ limits: { coldPass: true, distillDelayMs: 0 }, idleDebounceMs: 5 }),
    );
    const status = await nextOf(side, "status");
    expect(status.status.distill.leaseHeld).toBe(true);
    const signals = ids.map((sessionID) => ({ type: "turn-ended", sessionID }));
    worker.postMessage({ v: PROTOCOL_VERSION, generation: 1, type: "events", signals } as never);

    const failedLine = (line: string): boolean => line.includes("re-distill failed");
    await waitFor(() => sentOf(side, "log").length >= 200, "200 log lines");
    // Give the rest of the failures time to run and be counted.
    await sleep(1_500);
    const logs = sentOf(side, "log");
    expect(logs).toHaveLength(200);
    expect(logs.every((log) => log.line.length <= 2_000 && log.dropped === undefined)).toBe(true);
    // The long session's line, cut inside its id.
    const cut = logs.find((log) => log.line.includes(`session ${long.slice(0, 100)}`))?.line ?? "";
    expect(cut).toHaveLength(2_000);
    const from = cut.indexOf("session ");
    expect(`session ${long} re-distill failed`.startsWith(cut.slice(from))).toBe(true);
    expect(logs.filter((log) => failedLine(log.line)).length).toBeGreaterThan(100);

    // The next second's first line carries what the last one dropped.
    clock += 1_000;
    insertMessage(v2.db, {
      id: "msg_late",
      session_id: "ses_n0",
      type: "user",
      seq: 2,
      time_created: 20_000,
      data: { text: "again", time: { created: 20_000 } },
    });
    worker.postMessage({
      v: PROTOCOL_VERSION,
      generation: 1,
      type: "events",
      signals: [{ type: "turn-ended", sessionID: "ses_n0" }],
    } as never);
    await waitFor(() => sentOf(side, "log").length > 200, "the next line");
    const next = sentOf(side, "log")[200];
    expect(next?.dropped).toBeGreaterThanOrEqual(ids.length - 200);
    expect(sentOf(side, "fatal")).toEqual([]);
  }, 30_000);
});

describe("halt", () => {
  it("posts nothing more, keeps the lease with its holder and closes the store", async () => {
    let clock = 1_000_000;
    const opener = recordingOpener();
    const { worker, side } = await startSide(
      workerHarness({ openStoreDb: opener.open, now: () => clock }),
    );
    trace.sent = side.sent;
    worker.postMessage(initMessage({ limits: { coldPass: true } }));
    const status = await nextOf(side, "status");
    expect(status.status.distill.leaseHeld).toBe(true);
    expect((await leaseRow())?.holder).toBe("main/w1");

    const posted = side.sent.length;
    const calls = opener.calls.length;
    side.handler.halt();
    await side.handler.done;
    expect(opener.closes).toHaveLength(1);
    expect(trace.calls.at(-1)?.signal).toBeUndefined();

    clock += 10_000;
    await sleep(700);
    expect(side.sent).toHaveLength(posted);
    expect(opener.calls).toHaveLength(calls);
    expect((await leaseRow())?.holder).toBe("main/w1");
  }, 15_000);
});
