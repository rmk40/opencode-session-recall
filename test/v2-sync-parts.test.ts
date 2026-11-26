import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DistillSync } from "../src/distill.js";
import type { ReadOnlyDb } from "../src/sqlite.js";
import { openOpencodeDb } from "../src/history/v2.js";
import {
  annotateCheckpoint,
  createV2Sync,
  inspectCheckpoint,
  RANGE_DIGEST_MAX,
  type V2SyncOptions,
} from "../src/history/v2-sync.js";
import {
  insertMessage,
  insertPart,
  insertProject,
  insertSession,
  limitSpy,
  makeV2Db,
  makeV2PartsDb,
  type V2TestDb,
} from "./v2-db.js";

/**
 * The v2 checkpoint over opencode 2.4's `session_part` rows (part state of
 * the newest row and a fingerprint of the rows ending at it), and the range
 * digests the distiller hashes. Every statement goes through the LIMIT spy,
 * which throws on a `session_message` or `session_part` statement without a
 * bound `LIMIT ?`.
 */

const PROJECT = "prj_parts";
const DIR = "/workspace/parts";
/** Far in the past: these rows are never inside a poll window. */
const T0 = 1_000_000;

const noYield = async (): Promise<void> => {};

let t: V2TestDb;
let reader: ReadOnlyDb & { statements: string[] };
const seqs = new Map<string, number>();

async function open(db: V2TestDb): Promise<void> {
  t = db;
  // A throwaway writer: no fsync per row.
  t.db.exec("PRAGMA synchronous = OFF");
  insertProject(t.db, { id: PROJECT, worktree: DIR });
  const opened = await openOpencodeDb(t.path);
  if (!opened.ok) throw new Error(opened.reason);
  reader = limitSpy(opened.db);
}

beforeEach(async () => {
  seqs.clear();
  await open(await makeV2PartsDb());
});

afterEach(() => {
  reader.close();
  t.cleanup();
});

function sync(opts: V2SyncOptions = {}): DistillSync {
  return createV2Sync(reader, { yieldBetween: noYield, ...opts });
}

function addSession(id: string): void {
  insertSession(t.db, {
    id,
    project_id: PROJECT,
    directory: DIR,
    time_created: T0,
    time_updated: T0,
  });
}

function nextSeq(sessionID: string): number {
  const n = (seqs.get(sessionID) ?? 0) + 1;
  seqs.set(sessionID, n);
  return n;
}

function addUser(sessionID: string, text: string): string {
  const seq = nextSeq(sessionID);
  const id = `msg_${sessionID}_${seq}`;
  insertMessage(t.db, {
    id,
    session_id: sessionID,
    type: "user",
    seq,
    time_created: T0 + seq,
    data: { text, time: { created: T0 + seq } },
  });
  return id;
}

/** A completed assistant row whose content is all part rows, each written at
 *  `partTimes[i]` (default: the row's own time). */
function addReply(sessionID: string, parts: unknown[], partTimes: number[] = []): string {
  const seq = nextSeq(sessionID);
  const id = `msg_${sessionID}_${seq}`;
  const at = T0 + seq;
  insertMessage(t.db, {
    id,
    session_id: sessionID,
    type: "assistant",
    seq,
    time_created: at,
    data: {
      agent: "build",
      model: { id: "m", providerID: "p" },
      content: [],
      time: { created: at, completed: at + 1 },
    },
  });
  parts.forEach((data, ordinal) => {
    insertPart(t.db, {
      message_id: id,
      session_id: sessionID,
      ordinal,
      time_created: at,
      time_updated: partTimes[ordinal] ?? at,
      data,
    });
  });
  return id;
}

const text = (value: string) => ({ type: "text", text: value });

function setPart(messageID: string, ordinal: number, data: unknown, updated: number): void {
  t.db.run(
    "UPDATE session_part SET data = ?, time_updated = ? WHERE message_id = ? AND ordinal = ?",
    [JSON.stringify(data), updated, messageID, ordinal],
  );
}

async function cursorOf(s: DistillSync, sessionID: string): Promise<string> {
  const cp = await s.checkpoint(sessionID);
  if (!cp) throw new Error(`no checkpoint for ${sessionID}`);
  return cp.cursor;
}

describe("v2 checkpoint part state", () => {
  it("records the newest row's part count and newest part time", async () => {
    addSession("ses_a");
    addUser("ses_a", "question");
    const reply = addReply("ses_a", [text("one"), text("two")], [T0 + 50, T0 + 70]);
    const cursor = await cursorOf(sync(), "ses_a");
    expect(JSON.parse(cursor)).toMatchObject({
      v: 2,
      seq: 2,
      msgId: reply,
      parts: 2,
      partsUpdated: T0 + 70,
      unsettled: null,
      fp: expect.any(String),
    });
    expect(inspectCheckpoint(cursor)).toEqual({ version: 2, seq: 2, settled: true });
  });

  it("reads a part-only change on the newest message as a rewrite", async () => {
    addSession("ses_a");
    addUser("ses_a", "question");
    const reply = addReply("ses_a", [text("draft answer")]);
    const s = sync();
    const cursor = await cursorOf(s, "ses_a");
    expect(await s.compare("ses_a", cursor)).toBe("fresh");

    // opencode writes the part row and leaves the message row as it was.
    setPart(reply, 0, text("final answer"), T0 + 500);
    expect(await s.compare("ses_a", cursor)).toBe("rewritten");
  });

  it("reads one more part row on the newest message as a rewrite, even at the same time", async () => {
    addSession("ses_a");
    const reply = addReply("ses_a", [text("first")], [T0 + 40]);
    const s = sync();
    const cursor = await cursorOf(s, "ses_a");
    insertPart(t.db, {
      message_id: reply,
      session_id: "ses_a",
      ordinal: 1,
      time_created: T0 + 40,
      time_updated: T0 + 40,
      data: text("second"),
    });
    expect(await s.compare("ses_a", cursor)).toBe("rewritten");
  });

  it("reads a change one row behind the newest, to the row or to its parts, as a rewrite", async () => {
    addSession("ses_a");
    addUser("ses_a", "question");
    const reply = addReply("ses_a", [text("answer")]);
    addUser("ses_a", "follow-up");
    const s = sync();

    const beforePart = await cursorOf(s, "ses_a");
    setPart(reply, 0, text("answer, revised"), T0 + 900);
    expect(await s.compare("ses_a", beforePart)).toBe("rewritten");

    const beforeRow = await cursorOf(s, "ses_a");
    t.db.run("UPDATE session_message SET time_updated = ? WHERE id = ?", [T0 + 901, reply]);
    expect(await s.compare("ses_a", beforeRow)).toBe("rewritten");
  });

  it("reads rows appended after the checkpoint as growth, part rows included", async () => {
    addSession("ses_a");
    addUser("ses_a", "question");
    const s = sync();
    const cursor = await cursorOf(s, "ses_a");
    const reply = addReply("ses_a", [text("streamed")]);
    expect(await s.compare("ses_a", cursor)).toBe("grown");
    // More parts on the appended row are still past the checkpoint.
    insertPart(t.db, {
      message_id: reply,
      session_id: "ses_a",
      ordinal: 1,
      time_created: T0 + 800,
      data: text("more"),
    });
    setPart(reply, 0, text("streamed, edited"), T0 + 801);
    expect(await s.compare("ses_a", cursor)).toBe("grown");
  });

  it("reads a version 1 checkpoint as a rewrite even when the tail is unchanged", async () => {
    addSession("ses_a");
    addUser("ses_a", "question");
    addReply("ses_a", [text("answer")]);
    const s = sync();
    const current = JSON.parse(await cursorOf(s, "ses_a")) as Record<string, unknown>;
    const v1 = JSON.stringify({
      v: 1,
      seq: current.seq,
      msgId: current.msgId,
      msgUpdated: current.msgUpdated,
      sessKey: current.sessKey,
      unsettled: null,
    });
    expect(await s.compare("ses_a", v1)).toBe("rewritten");
  });

  it("fingerprints only the rows ending at the checkpoint that it is set to cover", async () => {
    addSession("ses_a");
    const old = addReply("ses_a", [text("oldest")]);
    addUser("ses_a", "two");
    const covered = addReply("ses_a", [text("third")]);
    addUser("ses_a", "four");
    const s = sync({ fingerprintRows: 2 });

    const cursor = await cursorOf(s, "ses_a");
    // Three rows behind the newest: outside a two-row fingerprint.
    setPart(old, 0, text("oldest, rewritten"), T0 + 700);
    expect(await s.compare("ses_a", cursor)).toBe("fresh");
    // One row behind: inside it.
    setPart(covered, 0, text("third, rewritten"), T0 + 701);
    expect(await s.compare("ses_a", cursor)).toBe("rewritten");
  });

  it("works on a database without session_part, where no row has parts", async () => {
    reader.close();
    t.cleanup();
    seqs.clear();
    await open(await makeV2Db());
    addSession("ses_a");
    addUser("ses_a", "question");
    const s = sync();
    const cursor = await cursorOf(s, "ses_a");
    expect(JSON.parse(cursor)).toMatchObject({ v: 2, parts: 0, partsUpdated: 0 });
    expect(await s.compare("ses_a", cursor)).toBe("fresh");
    expect(await s.rangeDigest!("ses_a", -1, 10)).toEqual([
      { seq: 1, id: "msg_ses_a_1", timeUpdated: T0 + 1, parts: 0, partsUpdated: 0, partTypes: [] },
    ]);
    expect(await s.withParts!(["ses_a"])).toEqual(new Set());
    expect(reader.statements.some((sql) => /\bsession_part\b/.test(sql))).toBe(false);
  });
});

describe("v2 checkpoint inspect and annotate", () => {
  it("reports a version 1 checkpoint's version and tail only", () => {
    const v1 = JSON.stringify({
      v: 1,
      seq: 7,
      msgId: "m",
      msgUpdated: 1,
      sessKey: 1,
      unsettled: 4,
    });
    expect(inspectCheckpoint(v1)).toEqual({ version: 1, seq: 7, settled: false });
    // Only a version 2 checkpoint is annotated.
    expect(annotateCheckpoint(v1, { floor: 3, cut: 1 })).toBe(v1);
  });

  it("records a write's floor and cut messages, and drops them when a later write has none", async () => {
    addSession("ses_a");
    addUser("ses_a", "question");
    const cursor = await cursorOf(sync(), "ses_a");

    const annotated = annotateCheckpoint(cursor, { floor: 3, cut: 2 });
    expect(inspectCheckpoint(annotated)).toEqual({
      version: 2,
      seq: 1,
      settled: true,
      floor: 3,
      cut: 2,
    });
    // No cut messages is no `cut`; no floor clears the stored one.
    const cleared = annotateCheckpoint(annotated, { cut: 0 });
    expect(inspectCheckpoint(cleared)).toEqual({ version: 2, seq: 1, settled: true });
    expect(JSON.parse(cleared)).not.toHaveProperty("cut");
    expect(JSON.parse(cleared)).not.toHaveProperty("floor");
  });

  it("treats anything that is not a known checkpoint as none", () => {
    for (const stored of [
      null,
      undefined,
      "not json",
      "[1, 2]",
      JSON.stringify({ v: 3, seq: 1, unsettled: null }),
      // Version 2 without its fingerprint.
      JSON.stringify({ v: 2, seq: 1, unsettled: null, msgId: "m", msgUpdated: 1, sessKey: 1 }),
    ]) {
      expect(inspectCheckpoint(stored), String(stored)).toBeNull();
    }
    expect(annotateCheckpoint("not json", { floor: 1 })).toBe("not json");
  });
});

describe("v2 range digests", () => {
  it("returns the rows after a seq in order, each with its part count, newest time and types", async () => {
    addSession("ses_a");
    addUser("ses_a", "question");
    const reply = addReply(
      "ses_a",
      [
        { type: "tool", id: "call_1", name: "bash", state: { status: "running", input: {} } },
        text("answer"),
        text("more"),
      ],
      [T0 + 30, T0 + 90, T0 + 60],
    );
    addUser("ses_a", "follow-up");
    const s = sync();

    expect(await s.rangeDigest!("ses_a", 1, 10)).toEqual([
      {
        seq: 2,
        id: reply,
        timeUpdated: T0 + 2,
        parts: 3,
        partsUpdated: T0 + 90,
        partTypes: ["text", "tool"],
      },
      { seq: 3, id: "msg_ses_a_3", timeUpdated: T0 + 3, parts: 0, partsUpdated: 0, partTypes: [] },
    ]);
    expect((await s.rangeDigest!("ses_a", -1, 1)).map((row) => row.seq)).toEqual([1]);
    // A limit that is not a positive integer reads one row.
    expect((await s.rangeDigest!("ses_a", -1, 0)).map((row) => row.seq)).toEqual([1]);
    expect((await s.rangeDigest!("ses_a", -1, Number.NaN)).map((row) => row.seq)).toEqual([1]);
    expect(await s.rangeDigest!("ses_a", 3, 10)).toEqual([]);
  });

  it(`reads at most ${RANGE_DIGEST_MAX} rows whatever the limit asked`, async () => {
    addSession("ses_long");
    t.db.tx(() => {
      for (let i = 0; i < RANGE_DIGEST_MAX + 3; i++) addUser("ses_long", `row ${i}`);
    });
    const rows = await sync().rangeDigest!("ses_long", -1, 10_000);
    expect(rows).toHaveLength(RANGE_DIGEST_MAX);
    expect(rows.at(-1)?.seq).toBe(RANGE_DIGEST_MAX);
  });

  it("finds the sessions with part rows, past one statement's worth of ids", async () => {
    addSession("ses_text");
    addUser("ses_text", "no parts here");
    addSession("ses_parts");
    addReply("ses_parts", [text("a part")]);
    // The part-bearing session sits past the first chunk of ids.
    const ids = [...Array.from({ length: 500 }, (_, i) => `ses_missing_${i}`), "ses_parts"];
    const s = sync();
    expect(await s.withParts!([...ids, "ses_text"])).toEqual(new Set(["ses_parts"]));
    expect(await s.withParts!([])).toEqual(new Set());
  });
});
