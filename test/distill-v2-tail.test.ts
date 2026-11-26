import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDistiller, type Distiller, type DistillerOptions } from "../src/distill.js";
import { createFetchGate } from "../src/fetch-gate.js";
import { createV2HistorySource, openOpencodeDb } from "../src/history/v2.js";
import { V2_PROJECTOR_GEN } from "../src/history/v2-project.js";
import { createV2Sync, type V2SyncOptions } from "../src/history/v2-sync.js";
import { openSqlite, type ReadOnlyDb, type SqliteDb } from "../src/sqlite.js";
import { openStore, type Card, type Store } from "../src/store.js";
import { TEST_LIMITS } from "./helpers.js";
import {
  insertMessage,
  insertPart,
  insertProject,
  insertSession,
  limitSpy,
  makeV2PartsDb,
  type V2TestDb,
} from "./v2-db.js";

/**
 * Re-reading only a running tail stores what a full read stores. Random
 * streaming sequences run against a real opencode 2.4-shaped database: a
 * distiller signalled as the poll signals it (which reads a running tail
 * from its boundary) and a distiller forced to read in full each keep their
 * own store, and after every step the two stores must hold the same card
 * (checkpoint and settled base included) and the same slim-index rows.
 */

const PROJECT = "prj_tail";
const DIR = "/workspace/tail";
/** Settled rows are written at these times, far in the past. */
const T0 = 1_000_000;
const noYield = async (): Promise<void> => {};

/** Deterministic random numbers (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "parseWidget",
  "launchTerminal",
  "MAX_RETRY",
  "src/widget.ts",
  "npm run build",
  "deploy prod",
  "fixture",
  "regression",
];

type Model = {
  sessionID: string;
  seq: number;
  /** The running reply, if any: its id, row `seq` and part rows so far. */
  running?: { id: string; seq: number; parts: number };
};

const WRITES = new Set([
  "replaceSessionParts",
  "appendSessionParts",
  "replaceSessionTail",
  "refreshCardMeta",
]);

/** `store` with every card write's method name recorded in `calls`. */
function recording(store: Store, calls: string[]): Store {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      if (typeof prop === "string" && WRITES.has(prop)) {
        return (...args: unknown[]) => {
          calls.push(prop);
          return method.apply(target, args);
        };
      }
      return method.bind(target);
    },
  });
}

let v2db: V2TestDb;
let reader: ReadOnlyDb & { statements: string[] };
let dir: string;
const dbs: SqliteDb[] = [];
const distillers: Distiller[] = [];
/** Strictly increasing times for rows that change, so every change moves
 *  the row's or part's `time_updated`. */
let tick = 0;

beforeEach(async () => {
  tick = 0;
  v2db = await makeV2PartsDb();
  v2db.db.exec("PRAGMA synchronous = OFF");
  insertProject(v2db.db, { id: PROJECT, worktree: DIR });
  const opened = await openOpencodeDb(v2db.path);
  if (!opened.ok) throw new Error(opened.reason);
  reader = limitSpy(opened.db);
  dir = mkdtempSync(join(tmpdir(), "recall-v2-tail-"));
});

afterEach(async () => {
  await Promise.all(distillers.splice(0).map((d) => d.stop()));
  for (const db of dbs.splice(0)) db.close();
  reader.close();
  v2db.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

async function openTestStore(name: string): Promise<{ db: SqliteDb; store: Store }> {
  const db = await openSqlite(join(dir, `${name}.db`));
  if (!db) throw new Error("no sqlite");
  dbs.push(db);
  const result = openStore(db, { host: "opencode-v2", source: v2db.path });
  if (!result.ok) throw new Error(result.reason);
  return { db, store: result.store };
}

function startDistiller(
  store: Store,
  o: Omit<Partial<DistillerOptions>, "sync"> & {
    syncOptions?: V2SyncOptions;
    logs?: string[];
  } = {},
): Distiller {
  const { syncOptions, logs, ...rest } = o;
  const distiller = createDistiller({
    source: createV2HistorySource(reader, { yieldBetween: noYield }),
    store,
    gate: createFetchGate({ concurrency: 2 }),
    limits: { ...TEST_LIMITS, coldPass: false, distillDelayMs: 0, distillConcurrency: 1 },
    instanceId: `tail-${Math.random()}`,
    sync: createV2Sync(reader, {
      // No poll: each step signals the distillers itself.
      pollIntervalMs: 1e9,
      sessionScanEveryMs: 1e12,
      reconcileEveryMs: 1e12,
      yieldBetween: noYield,
      ...syncOptions,
    }),
    projectorGen: V2_PROJECTOR_GEN,
    idleDebounceMs: 1,
    yieldBetween: noYield,
    ...(logs && { log: (message: string) => logs.push(message) }),
    ...rest,
  });
  distillers.push(distiller);
  distiller.start();
  return distiller;
}

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// ── opencode.db writers ──────────────────────────────────────────────────────

function text(rand: () => number, n = 3): string {
  return Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" ");
}

/** A part as opencode 2.4 stores it: text, reasoning, or a bash or edit tool
 *  call that completed or failed (a running reply's calls are running). */
function part(rand: () => number, running: boolean): Record<string, unknown> {
  const pick = rand();
  if (pick < 0.4) return { type: "text", text: text(rand) };
  if (pick < 0.55) return { type: "reasoning", text: text(rand) };
  const id = `call_${++tick}`;
  if (pick < 0.7) {
    return {
      type: "tool",
      id,
      name: "edit",
      state: running
        ? { status: "running", input: { filePath: `src/${text(rand, 1)}.ts` } }
        : { status: "completed", input: { filePath: `src/${text(rand, 1)}.ts` }, content: [] },
    };
  }
  if (pick < 0.85 && !running) {
    return {
      type: "tool",
      id,
      name: "bash",
      state: { status: "error", input: { command: text(rand, 2) }, error: `ECONNRESET ${tick}` },
    };
  }
  return {
    type: "tool",
    id,
    name: "bash",
    state: running
      ? { status: "running", input: { command: text(rand, 2) } }
      : {
          status: "completed",
          input: { command: text(rand, 2) },
          content: [{ type: "text", text: text(rand) }],
        },
  };
}

function replyData(seq: number, completed: boolean): Record<string, unknown> {
  const at = T0 + seq;
  return {
    agent: "build",
    model: { id: "m", providerID: "p" },
    content: [],
    time: completed ? { created: at, completed: at + 1 } : { created: at },
  };
}

function addUser(m: Model, rand: () => number): void {
  const seq = ++m.seq;
  insertMessage(v2db.db, {
    id: `msg_${m.sessionID}_${seq}`,
    session_id: m.sessionID,
    type: "user",
    seq,
    time_created: T0 + seq,
    data: { text: text(rand, 4), time: { created: T0 + seq } },
  });
}

/** A reply with `parts` part rows, settled or still running (a running row
 *  is updated now, so it does not count as abandoned). */
function addReply(m: Model, rand: () => number, running: boolean, parts = 2): void {
  const seq = ++m.seq;
  const id = `msg_${m.sessionID}_${seq}`;
  insertMessage(v2db.db, {
    id,
    session_id: m.sessionID,
    type: "assistant",
    seq,
    time_created: T0 + seq,
    time_updated: running ? Date.now() + ++tick : T0 + seq,
    data: replyData(seq, !running),
  });
  for (let ordinal = 0; ordinal < parts; ordinal++) {
    insertPart(v2db.db, {
      message_id: id,
      session_id: m.sessionID,
      ordinal,
      time_created: T0 + seq,
      time_updated: running ? Date.now() + ++tick : T0 + seq,
      data: part(rand, running),
    });
  }
  if (running) m.running = { id, seq, parts };
}

function settleRunning(m: Model): void {
  const r = m.running!;
  v2db.db.run("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?", [
    JSON.stringify(replyData(r.seq, true)),
    Date.now() + ++tick,
    r.id,
  ]);
  m.running = undefined;
}

/** The ops a step picks from, each applicable to the session as it is. */
type Op = { name: string; tailOnly: boolean; run: () => void };

function ops(m: Model, rand: () => number): Op[] {
  const out: Op[] = [
    { name: "user", tailOnly: m.running !== undefined, run: () => addUser(m, rand) },
  ];
  const r = m.running;
  if (!r) {
    out.push({
      name: "turn",
      tailOnly: false,
      run: () => {
        addUser(m, rand);
        addReply(m, rand, true, 1 + Math.floor(rand() * 2));
      },
    });
    out.push({ name: "reply", tailOnly: false, run: () => addReply(m, rand, true) });
    return out;
  }
  out.push(
    {
      name: "grow",
      tailOnly: true,
      run: () => {
        insertPart(v2db.db, {
          message_id: r.id,
          session_id: m.sessionID,
          ordinal: r.parts++,
          time_created: T0 + r.seq,
          time_updated: Date.now() + ++tick,
          data: part(rand, true),
        });
      },
    },
    {
      name: "rewrite tail",
      tailOnly: true,
      run: () => {
        v2db.db.run(
          "UPDATE session_part SET type = 'text', data = ?, time_updated = ? WHERE message_id = ? AND ordinal = ?",
          [
            JSON.stringify({ type: "text", text: text(rand, 5) }),
            Date.now() + ++tick,
            r.id,
            Math.floor(rand() * r.parts),
          ],
        );
      },
    },
    { name: "settle", tailOnly: true, run: () => settleRunning(m) },
    {
      name: "step",
      tailOnly: true,
      run: () => {
        settleRunning(m);
        addReply(m, rand, true, 1);
      },
    },
    {
      name: "revert tail",
      tailOnly: true,
      run: () => {
        v2db.db.run("DELETE FROM session_part WHERE message_id = ?", [r.id]);
        v2db.db.run("DELETE FROM session_message WHERE id = ?", [r.id]);
        m.running = undefined;
      },
    },
    {
      // The newest row below the running reply (the boundary), or the one
      // below it: inside the boundary's fingerprint either way.
      name: "rewrite behind the boundary",
      tailOnly: false,
      run: () => {
        const behind = v2db.db.all(
          "SELECT id, type FROM session_message WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT 2",
          [m.sessionID, r.seq],
        );
        const row = behind[Math.floor(rand() * behind.length)]!;
        if (row.type === "user") {
          v2db.db.run("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?", [
            JSON.stringify({ text: text(rand, 4), time: { created: T0 } }),
            T0 + 100_000 + ++tick,
            row.id as string,
          ]);
        } else {
          v2db.db.run(
            "UPDATE session_part SET type = 'text', data = ?, time_updated = ? WHERE message_id = ? AND ordinal = 0",
            [
              JSON.stringify({ type: "text", text: text(rand, 5) }),
              T0 + 100_000 + ++tick,
              row.id as string,
            ],
          );
        }
      },
    },
  );
  return out;
}

// ── The property ─────────────────────────────────────────────────────────────

const storedRows = (db: SqliteDb, sessionID: string): unknown[] =>
  db.all(
    `SELECT part_id, message_id, prev_message_id, next_message_id, class, time_created, raw, norm
     FROM part_text WHERE session_id = ? ORDER BY id`,
    [sessionID],
  );

/** A card as both stores must hold it: the revision each store allocated
 *  differs. */
function comparable(card: Card | undefined): Partial<Card> | undefined {
  if (!card) return undefined;
  const copy: Partial<Card> = { ...card };
  delete copy.writeRev;
  return copy;
}

/** The part ids each store's index finds for every word. */
function ftsView(store: Store): string[][] {
  return WORDS.map((word) =>
    store
      .ftsSearch({ strong: [word], weak: [], limit: 10_000 })
      .map((hit) => hit.partId)
      .sort(),
  );
}

describe.each([
  { label: "full writes between turns", appendThresholdParts: undefined, pageMessages: 2 },
  { label: "appends between turns", appendThresholdParts: 0, pageMessages: 3 },
])("tail re-reads over random streaming sequences ($label)", (config) => {
  it("store the card and rows a full read of the same rows stores", async () => {
    const tail = await openTestStore("tail");
    const full = await openTestStore("full");
    const tailCalls: string[] = [];
    const fullCalls: string[] = [];
    const tailDistiller = startDistiller(recording(tail.store, tailCalls), {
      pageMessages: config.pageMessages,
      ...(config.appendThresholdParts !== undefined && {
        appendThresholdParts: config.appendThresholdParts,
      }),
    });
    const fullDistiller = startDistiller(recording(full.store, fullCalls));

    const SEQUENCES = 12;
    const STEPS = 12;
    const tally = new Map<string, number>();
    for (let s = 0; s < SEQUENCES; s++) {
      const rand = random(1_000 + s);
      const m: Model = { sessionID: `ses_${s}`, seq: 0 };
      insertSession(v2db.db, {
        id: m.sessionID,
        project_id: PROJECT,
        directory: DIR,
        title: `Session ${s}`,
        time_created: T0,
        time_updated: T0,
      });
      addUser(m, rand);
      for (let step = 0; step < STEPS; step++) {
        // The last step leaves the session settled: it settles a running
        // reply, or adds a user message.
        const last = step === STEPS - 1;
        const choices = ops(m, rand).filter(
          (op) => !last || op.name === (m.running ? "settle" : "user"),
        );
        const op = choices[Math.floor(rand() * choices.length)]!;
        const base = tail.store.getCard(m.sessionID)?.settledBase;
        op.run();

        const tailWrites = tailCalls.length;
        const fullWrites = fullCalls.length;
        tailDistiller.onEvent({ type: "turn-ended", sessionID: m.sessionID });
        fullDistiller.onEvent({ type: "removal", sessionID: m.sessionID });
        await waitFor(() => tailCalls.length > tailWrites && fullCalls.length > fullWrites);
        // The rest of each re-distill runs without reading anything.
        await new Promise((resolve) => setTimeout(resolve, 2));
        const how = tailCalls.at(-1)!;
        const where = `sequence ${s}, step ${step} (${op.name}), written by ${how}`;
        tally.set(how, (tally.get(how) ?? 0) + 1);

        expect(tailCalls.length, where).toBe(tailWrites + 1);
        expect(fullCalls.at(-1), where).toBe("replaceSessionParts");
        if (base && op.tailOnly) expect(how, where).toBe("replaceSessionTail");
        if (base && !op.tailOnly && op.name !== "user") {
          expect(how, where).toBe("replaceSessionParts");
        }
        expect(comparable(tail.store.getCard(m.sessionID)), where).toEqual(
          comparable(full.store.getCard(m.sessionID)),
        );
        expect(storedRows(tail.db, m.sessionID), where).toEqual(storedRows(full.db, m.sessionID));
        expect(ftsView(tail.store), where).toEqual(ftsView(full.store));
      }
    }
    // Both kinds of tail write ran: one over a tail still running, one that
    // settled it.
    expect(tally.get("replaceSessionTail") ?? 0).toBeGreaterThan(SEQUENCES);
    if (config.appendThresholdParts === 0) {
      expect(tally.get("appendSessionParts") ?? 0).toBeGreaterThan(0);
    }

    // Every session ended settled with hashes for all of its rows: the range
    // check walks them all and finds nothing to re-index.
    await tailDistiller.stop();
    const logs: string[] = [];
    startDistiller(tail.store, { logs, syncOptions: { pollIntervalMs: 5 } });
    await waitFor(() => logs.some((line) => /range check sweep 1 done/.test(line)), 20_000);
    expect(logs.filter((line) => line.includes("re-indexing"))).toEqual([]);
    expect(logs.find((line) => /range check sweep 1 done/.test(line))).toMatch(/, 0 changed$/);
  }, 120_000);
});
