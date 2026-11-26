import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDistiller,
  deriveCard,
  type DeriveCardInput,
  type Distiller,
  type DistillerOptions,
  type DistillSignal,
  type DistillSync,
} from "../src/distill.js";
import { createFetchGate } from "../src/fetch-gate.js";
import type { HistoryMessage } from "../src/history/model.js";
import type { HistorySource } from "../src/history/source.js";
import { createV2HistorySource, openOpencodeDb } from "../src/history/v2.js";
import { V2_PROJECTOR_GEN } from "../src/history/v2-project.js";
import { createV2Sync, inspectCheckpoint, type V2SyncOptions } from "../src/history/v2-sync.js";
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
  /** The running reply, if any: its id, row `seq`, part rows so far, the
   *  ordinals of those that make one slim-index row (so rewriting one as
   *  text keeps the row count), and user rows queued after it. */
  running?: { id: string; seq: number; parts: number; single: number[]; queued: number };
};

/** Whether a part makes exactly one slim-index row: text, reasoning, or an
 *  edit call (its JSON input). A bash call makes two (command and input). */
const singleRow = (data: Record<string, unknown>): boolean =>
  data.type !== "tool" || data.name === "edit";

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
    wrapSync?: (inner: DistillSync) => DistillSync;
    wrapSource?: (inner: HistorySource) => HistorySource;
  } = {},
): Distiller {
  const { syncOptions, logs, wrapSync, wrapSource, ...rest } = o;
  const sync = createV2Sync(reader, {
    // No poll: each step signals the distillers itself.
    pollIntervalMs: 1e9,
    sessionScanEveryMs: 1e12,
    reconcileEveryMs: 1e12,
    yieldBetween: noYield,
    ...syncOptions,
  });
  const source = createV2HistorySource(reader, { yieldBetween: noYield });
  const distiller = createDistiller({
    source: wrapSource ? wrapSource(source) : source,
    store,
    gate: createFetchGate({ concurrency: 2 }),
    limits: { ...TEST_LIMITS, coldPass: false, distillDelayMs: 0, distillConcurrency: 1 },
    instanceId: `tail-${Math.random()}`,
    sync: wrapSync ? wrapSync(sync) : sync,
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
  const single: number[] = [];
  for (let ordinal = 0; ordinal < parts; ordinal++) {
    const data = part(rand, running);
    if (singleRow(data)) single.push(ordinal);
    insertPart(v2db.db, {
      message_id: id,
      session_id: m.sessionID,
      ordinal,
      time_created: T0 + seq,
      time_updated: running ? Date.now() + ++tick : T0 + seq,
      data,
    });
  }
  if (running) m.running = { id, seq, parts, single, queued: 0 };
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

/**
 * The ops a step may take. `growing` keeps to those under which an append
 * of the same messages is defined: the session only grows, no row behind a
 * boundary changes, a rewritten part keeps its row count, and a running tail
 * stays short (at most four parts and two queued user rows).
 */
function ops(m: Model, rand: () => number, growing = false): Op[] {
  const r = m.running;
  const out: Op[] =
    growing && r && r.queued >= 2
      ? []
      : [
          {
            name: "user",
            tailOnly: r !== undefined,
            run: () => {
              addUser(m, rand);
              if (r) r.queued++;
            },
          },
        ];
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
  if (!growing || r.parts < 4) {
    out.push({
      name: "grow",
      tailOnly: true,
      run: () => {
        const data = part(rand, true);
        if (singleRow(data)) r.single.push(r.parts);
        insertPart(v2db.db, {
          message_id: r.id,
          session_id: m.sessionID,
          ordinal: r.parts++,
          time_created: T0 + r.seq,
          time_updated: Date.now() + ++tick,
          data,
        });
      },
    });
  }
  const rewritable = growing ? r.single : Array.from({ length: r.parts }, (_, i) => i);
  if (rewritable.length > 0) {
    out.push({
      name: "rewrite tail",
      tailOnly: true,
      run: () => {
        const ordinal = rewritable[Math.floor(rand() * rewritable.length)]!;
        if (!r.single.includes(ordinal)) r.single.push(ordinal);
        v2db.db.run(
          "UPDATE session_part SET type = 'text', data = ?, time_updated = ? WHERE message_id = ? AND ordinal = ?",
          [
            JSON.stringify({ type: "text", text: text(rand, 5) }),
            Date.now() + ++tick,
            r.id,
            ordinal,
          ],
        );
      },
    });
  }
  out.push(
    { name: "settle", tailOnly: true, run: () => settleRunning(m) },
    {
      name: "step",
      tailOnly: true,
      run: () => {
        settleRunning(m);
        addReply(m, rand, true, 1);
      },
    },
  );
  if (growing) return out;
  out.push(
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

/** Every message of a session, read in pages with no row cap. */
async function allMessages(source: HistorySource, sessionID: string): Promise<HistoryMessage[]> {
  const out: HistoryMessage[] = [];
  let before: string | undefined;
  do {
    const page = await source.messagePage({ sessionID, limit: 50, before });
    out.push(...page.items);
    before = page.nextCursor ?? undefined;
  } while (before);
  return out;
}

/** A checkpoint without the row floor its write recorded. */
function withoutFloor(cursor: string | null | undefined): unknown {
  const value = JSON.parse(cursor ?? "null") as Record<string, unknown> | null;
  if (value) delete value.floor;
  return value;
}

describe("tail re-reads over random streaming sequences past the row cap", () => {
  it("store what an append of the same messages stores, and the rows a capped full read stores", async () => {
    const CAP = 16;
    const limits = {
      ...TEST_LIMITS,
      coldPass: false,
      distillDelayMs: 0,
      distillConcurrency: 1,
      ftsRowsPerSession: CAP,
    };
    const tail = await openTestStore("tail");
    const full = await openTestStore("full");
    const tailCalls: string[] = [];
    const fullCalls: string[] = [];
    // Appends between turns: on these sequences every write after a
    // session's first is an append or a tail write.
    const tailDistiller = startDistiller(recording(tail.store, tailCalls), {
      limits,
      appendThresholdParts: 0,
      pageMessages: 3,
    });
    const fullDistiller = startDistiller(recording(full.store, fullCalls), {
      limits,
      pageMessages: 2,
    });
    const source = createV2HistorySource(reader, { yieldBetween: noYield });

    const SEQUENCES = 8;
    const STEPS = 16;
    let evicting = 0;
    for (let s = 0; s < SEQUENCES; s++) {
      const rand = random(5_000 + s);
      const m: Model = { sessionID: `ses_cap_${s}`, seq: 0 };
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
        const last = step === STEPS - 1;
        const choices = ops(m, rand, true).filter(
          (op) => !last || op.name === (m.running ? "settle" : "user"),
        );
        const op = choices[Math.floor(rand() * choices.length)]!;
        op.run();

        const tailWrites = tailCalls.length;
        const fullWrites = fullCalls.length;
        tailDistiller.onEvent({ type: "turn-ended", sessionID: m.sessionID });
        fullDistiller.onEvent({ type: "removal", sessionID: m.sessionID });
        await waitFor(() => tailCalls.length > tailWrites && fullCalls.length > fullWrites);
        await new Promise((resolve) => setTimeout(resolve, 2));
        const how = tailCalls.at(-1)!;
        const where = `sequence ${s}, step ${step} (${op.name}), written by ${how}`;
        if (step > 0) expect(["appendSessionParts", "replaceSessionTail"], where).toContain(how);

        // The append oracle: the whole session's messages, with the row cap.
        const card = tail.store.getCard(m.sessionID);
        const boundary = inspectCheckpoint(card?.distillCursor)?.boundary;
        const messages = await allMessages(source, m.sessionID);
        const input: DeriveCardInput = {
          session: {
            id: m.sessionID,
            parentId: null,
            title: "",
            slug: "",
            directory: "",
            projectId: "",
            agent: null,
            model: null,
            timeCreated: 0,
            timeUpdated: 0,
          },
          messages,
          parentById: new Map([[m.sessionID, null]]),
          caps: { ftsRowsPerSession: CAP },
          ...(boundary !== undefined && { settledThrough: boundary }),
        };
        const oracle = deriveCard(input);
        const content = (c: Card | undefined) => ({
          partCount: c?.partCount,
          retainedChars: c?.retainedChars,
          summaryHead: c?.summaryHead,
          outcomeHead: c?.outcomeHead,
          inventory: c?.inventory,
          files: c?.files,
          tools: c?.tools,
          errors: c?.errors,
          distilledThrough: c?.distilledThrough,
        });
        expect(content(card), where).toEqual(content(oracle.card));
        expect(card?.settledBase, where).toEqual(oracle.settledBase);
        // Rows, pointers included, as the append stores them.
        const rows = storedRows(tail.db, m.sessionID);
        expect(rows, where).toEqual(
          oracle.rows.map((row) => ({
            part_id: row.partId,
            message_id: row.messageId,
            prev_message_id: row.prevMessageId,
            next_message_id: row.nextMessageId,
            class: row.class,
            time_created: row.timeCreated,
            raw: row.raw,
            norm: row.norm,
          })),
        );
        // The same rows, in the same order, as a capped full read keeps.
        const text = (db: SqliteDb) =>
          db
            .all("SELECT part_id, raw FROM part_text WHERE session_id = ? ORDER BY id", [
              m.sessionID,
            ])
            .map((row) => [row.part_id, row.raw]);
        expect(text(tail.db), where).toEqual(text(full.db));
        // The checkpoint a full read stamps, but for the floor: an append's is
        // the message that owns the oldest row left once rows were evicted.
        expect(withoutFloor(card?.distillCursor), where).toEqual(
          withoutFloor(full.store.getCard(m.sessionID)?.distillCursor),
        );
        const produced = deriveCard({ ...input, caps: { ftsRowsPerSession: 1e9 } }).rows.length;
        const owner = messages.find((msg) => msg.info.id === oracle.rows[0]?.messageId);
        const floor = produced > CAP ? owner?.info.seq : undefined;
        if (produced > CAP) evicting++;
        expect(inspectCheckpoint(card?.distillCursor)?.floor, where).toBe(floor);
      }
    }
    expect(evicting).toBeGreaterThan(SEQUENCES);

    await tailDistiller.stop();
    const logs: string[] = [];
    startDistiller(tail.store, { logs, limits, syncOptions: { pollIntervalMs: 5 } });
    await waitFor(() => logs.some((line) => /range check sweep 1 done/.test(line)), 20_000);
    expect(logs.filter((line) => line.includes("re-indexing"))).toEqual([]);
    expect(logs.find((line) => /range check sweep 1 done/.test(line))).toMatch(/, 0 changed$/);
  }, 120_000);
});

// ── Races and skips ──────────────────────────────────────────────────────────

/** A session of a user row, a settled reply (the boundary) and a running
 *  reply, each part row one word. */
function streamingSession(sessionID: string, extra: { time_archived?: number } = {}): Model {
  const rand = random(42);
  const m: Model = { sessionID, seq: 0 };
  insertSession(v2db.db, {
    id: sessionID,
    project_id: PROJECT,
    directory: DIR,
    title: `Title ${sessionID}`,
    time_created: T0,
    time_updated: T0,
    ...extra,
  });
  addUser(m, rand);
  addReply(m, rand, false, 1);
  addReply(m, rand, true, 1);
  return m;
}

/** Signal one re-distill and wait for the card write it makes. */
async function redistilled(d: Distiller, calls: string[], sessionID: string): Promise<string> {
  const from = calls.length;
  d.onEvent({ type: "turn-ended", sessionID });
  await waitFor(() => calls.length > from);
  await new Promise((resolve) => setTimeout(resolve, 5));
  return calls.at(-1)!;
}

const found = (store: Store, word: string): string[] =>
  store.ftsSearch({ strong: [word], weak: [] }).map((hit) => hit.sessionId);

describe("tail re-reads and the rows behind the boundary", () => {
  it("read in full when a part behind the boundary changes right after the compare that chose the tail", async () => {
    const tail = await openTestStore("tail");
    const calls: string[] = [];
    let race: (() => void) | undefined;
    const d = startDistiller(recording(tail.store, calls), {
      wrapSync: (inner) => ({
        ...inner,
        compare: async (sessionID, stored) => {
          const change = await inner.compare(sessionID, stored);
          const run = race;
          if (run && change === "tail") {
            race = undefined;
            run();
          }
          return change;
        },
      }),
    });
    const m = streamingSession("ses_race");
    expect(await redistilled(d, calls, m.sessionID)).toBe("replaceSessionParts");
    expect(tail.store.getCard(m.sessionID)?.settledBase?.seq).toBe(2);

    // The running reply grows, and the boundary's own part is rewritten
    // between the compare and the tail read's first checkpoint.
    const r = m.running!;
    insertPart(v2db.db, {
      message_id: r.id,
      session_id: m.sessionID,
      ordinal: r.parts++,
      time_created: T0 + r.seq,
      time_updated: Date.now() + ++tick,
      data: { type: "text", text: "yankeegrown" },
    });
    race = () =>
      v2db.db.run(
        "UPDATE session_part SET type = 'text', data = ?, time_updated = ? WHERE message_id = ? AND ordinal = 0",
        [JSON.stringify({ type: "text", text: "zuluraced" }), T0 + 200_000, `msg_${m.sessionID}_2`],
      );
    expect(await redistilled(d, calls, m.sessionID)).toBe("replaceSessionParts");
    expect(race).toBeUndefined();
    expect(found(tail.store, "zuluraced")).toEqual([m.sessionID]);
    expect(found(tail.store, "yankeegrown")).toEqual([m.sessionID]);
  });

  it("read and write nothing while nothing past the boundary changes", async () => {
    const tail = await openTestStore("tail");
    const calls: string[] = [];
    let checkpoints = 0;
    let pages = 0;
    const d = startDistiller(recording(tail.store, calls), {
      wrapSync: (inner) => ({
        ...inner,
        checkpoint: async (sessionID) => {
          checkpoints++;
          return inner.checkpoint(sessionID);
        },
      }),
      wrapSource: (inner) => ({
        ...inner,
        messagePage: async (o) => {
          pages++;
          return inner.messagePage(o);
        },
      }),
    });
    const m = streamingSession("ses_quiet");
    expect(await redistilled(d, calls, m.sessionID)).toBe("replaceSessionParts");
    const card = tail.store.getCard(m.sessionID);
    const read = { checkpoints, pages };
    d.onEvent({ type: "turn-ended", sessionID: m.sessionID });
    await waitFor(() => checkpoints > read.checkpoints);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect({ calls: calls.length, pages }).toEqual({ calls: 1, pages: read.pages });
    expect(tail.store.getCard(m.sessionID)).toEqual(card);

    // A change past the boundary is read again.
    v2db.db.run(
      "UPDATE session_part SET type = 'text', data = ?, time_updated = ? WHERE message_id = ? AND ordinal = 0",
      [JSON.stringify({ type: "text", text: "xraylater" }), Date.now() + ++tick, m.running!.id],
    );
    expect(await redistilled(d, calls, m.sessionID)).toBe("replaceSessionTail");
    expect(found(tail.store, "xraylater")).toEqual([m.sessionID]);
  });
});

describe("v2 metadata patched while a distill of the session is in progress", () => {
  it.each([
    { label: "archive", from: undefined, to: T0 + 9_000 },
    { label: "unarchive", from: T0 + 8_000, to: undefined },
  ])("survives the distill's write ($label)", async ({ from, to }) => {
    const store = (await openTestStore("meta")).store;
    const calls: string[] = [];
    let hold: Promise<void> | undefined;
    let held = false;
    const d = startDistiller(recording(store, calls), {
      wrapSource: (inner) => ({
        ...inner,
        messagePage: async (o) => {
          if (hold) {
            held = true;
            await hold;
          }
          return inner.messagePage(o);
        },
      }),
    });
    const m = streamingSession("ses_meta", from === undefined ? {} : { time_archived: from });
    settleRunning(m);
    await redistilled(d, calls, m.sessionID);
    expect(store.getCard(m.sessionID)?.timeArchived).toBe(from);

    // A new row makes the next distill read; it reads the session's metadata
    // first, then waits on its read while the session is archived or not.
    addUser(m, random(7));
    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    const writes = calls.length;
    d.onEvent({ type: "turn-ended", sessionID: m.sessionID });
    await waitFor(() => held);
    hold = undefined;
    v2db.db.run("UPDATE session_v2 SET time_archived = ?, time_updated = ? WHERE id = ?", [
      to ?? null,
      T0 + 10_000,
      m.sessionID,
    ]);
    // The patch the session scan sends.
    d.onEvent({
      type: "meta",
      sessionID: m.sessionID,
      patch: { title: `Title ${m.sessionID}`, timeArchived: to ?? null },
    });
    expect(store.getCard(m.sessionID)?.timeArchived).toBe(to);
    release();
    await waitFor(() => calls.length > writes);
    await waitFor(() => store.getCard(m.sessionID)?.timeArchived === to);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getCard(m.sessionID)?.timeArchived).toBe(to);
  });

  /** A source whose next read of `sessionID`'s messages after `pause()`
   *  waits until released, and whose next lookup fails after `failNext()`. */
  function gatedSource(sessionID: string) {
    let hold: Promise<void> | undefined;
    let held = false;
    let release = (): void => {};
    let fail = false;
    return {
      wrap: (inner: HistorySource): HistorySource => ({
        ...inner,
        messagePage: async (o) => {
          const waiting = o.sessionID === sessionID ? hold : undefined;
          if (waiting) {
            hold = undefined;
            held = true;
            await waiting;
          }
          return inner.messagePage(o);
        },
        getSession: async (id, o) => {
          if (fail && id === sessionID) {
            fail = false;
            throw new Error("lookup failed for now");
          }
          return inner.getSession(id, o);
        },
      }),
      pause(): void {
        held = false;
        hold = new Promise((resolve) => (release = resolve));
      },
      held: () => held,
      release: () => release(),
      failNext(): void {
        fail = true;
      },
    };
  }

  const archive = (m: Model, at: number): DistillSignal => {
    v2db.db.run("UPDATE session_v2 SET time_archived = ?, time_updated = ? WHERE id = ?", [
      at,
      T0 + 10_000,
      m.sessionID,
    ]);
    return {
      type: "meta",
      sessionID: m.sessionID,
      patch: { title: `Title ${m.sessionID}`, timeArchived: at },
    };
  };

  it("survives a cold pass that writes the session after a re-distill of it did", async () => {
    const store = (await openTestStore("meta")).store;
    const calls: string[] = [];
    const m = streamingSession("ses_cold");
    settleRunning(m);
    const gate = gatedSource(m.sessionID);
    const listing = createV2HistorySource(reader, { yieldBetween: noYield });
    // The cold pass discovers the session unarchived and waits on its read.
    gate.pause();
    const d = startDistiller(recording(store, calls), {
      limits: { ...TEST_LIMITS, coldPass: true, distillDelayMs: 0, distillConcurrency: 1 },
      discover: async () => {
        const listed = await listing.listSessions({
          scope: "global",
          limit: 100,
          archived: "include",
        });
        if (!listed.ok) throw new Error(listed.error);
        return listed.items;
      },
      wrapSource: gate.wrap,
    });
    await waitFor(gate.held);
    const at = T0 + 9_000;
    d.onEvent(archive(m, at));
    // A re-distill reads the archived metadata and writes first.
    d.onEvent({ type: "turn-ended", sessionID: m.sessionID });
    await waitFor(() => store.getCard(m.sessionID)?.timeArchived === at);
    const writes = calls.length;
    // Then the cold pass writes what it discovered, and the follow-up reads
    // the metadata again.
    gate.release();
    await waitFor(() => d.status().coldPass === "done");
    expect(calls.length).toBeGreaterThan(writes);
    await waitFor(() => store.getCard(m.sessionID)?.timeArchived === at);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getCard(m.sessionID)?.timeArchived).toBe(at);
  });

  it("reads the metadata again after a lookup that failed", async () => {
    const store = (await openTestStore("meta")).store;
    const calls: string[] = [];
    const m = streamingSession("ses_retry");
    settleRunning(m);
    const gate = gatedSource(m.sessionID);
    const logs: string[] = [];
    const d = startDistiller(recording(store, calls), {
      wrapSource: gate.wrap,
      metaRetryMs: 10,
      logs,
    });
    await redistilled(d, calls, m.sessionID);

    addUser(m, random(7));
    gate.pause();
    const writes = calls.length;
    d.onEvent({ type: "turn-ended", sessionID: m.sessionID });
    await waitFor(gate.held);
    const at = T0 + 9_000;
    d.onEvent(archive(m, at));
    // The re-distill writes the metadata it read before the archive, and the
    // first lookup after it fails.
    gate.failNext();
    gate.release();
    await waitFor(() => calls.length > writes);
    await waitFor(() => logs.some((line) => line.includes("metadata refresh failed")));
    await waitFor(() => store.getCard(m.sessionID)?.timeArchived === at);
  });
});

describe("a tail write stopped while it waits", () => {
  it("reads nothing more from the store once the distiller stops", async () => {
    const store = (await openTestStore("dispose")).store;
    const calls: string[] = [];
    let closed = false;
    const after: string[] = [];
    let holdNext = false;
    let held = false;
    let release = (): void => {};
    const waiting = new Promise<void>((resolve) => (release = resolve));
    // Every store call once the store counts as closed is recorded; the
    // first yield after the tail write counts the stored rows waits.
    const guarded = new Proxy(recording(store, calls), {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          if (closed) after.push(String(prop));
          if (prop === "sessionRowCount") holdNext = true;
          return method.apply(target, args);
        };
      },
    });
    const d = startDistiller(guarded, {
      yieldBetween: async () => {
        if (!holdNext) return;
        holdNext = false;
        held = true;
        await waiting;
      },
    });
    const m = streamingSession("ses_stop");
    expect(await redistilled(d, calls, m.sessionID)).toBe("replaceSessionParts");
    const r = m.running!;
    insertPart(v2db.db, {
      message_id: r.id,
      session_id: m.sessionID,
      ordinal: r.parts++,
      time_created: T0 + r.seq,
      time_updated: Date.now() + ++tick,
      data: { type: "text", text: "whiskeygrown" },
    });
    d.onEvent({ type: "turn-ended", sessionID: m.sessionID });
    await waitFor(() => held);
    const stopping = d.stop();
    closed = true;
    release();
    await stopping;
    expect(after).toEqual([]);
    expect(calls).toEqual(["replaceSessionParts"]);
  });
});
