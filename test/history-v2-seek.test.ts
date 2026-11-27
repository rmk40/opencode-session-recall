import { afterEach, describe, expect, it } from "vitest";
import { createV2HistorySource, openOpencodeDb } from "../src/history/v2.js";
import type { HistorySource } from "../src/history/source.js";
import { makeFakeHarness } from "./helpers.js";
import {
  insertMessage,
  insertProject,
  insertSession,
  limitSpy,
  makeV2PartsDb,
  writeFork,
  type V2TestDb,
} from "./v2-db.js";

/**
 * `seekPage`: where a newest-first walk bounded above starts. Every source
 * reads through the LIMIT spy, which throws on a `session_message` or
 * `session_part` statement without a bound `LIMIT ?`.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const noYield = async (): Promise<void> => {};

async function fresh(): Promise<V2TestDb> {
  const t = await makeV2PartsDb();
  cleanups.push(t.cleanup);
  insertProject(t.db, { id: "prj", worktree: "/w/app" });
  return t;
}

function session(t: V2TestDb, id: string, created = 0): void {
  insertSession(t.db, {
    id,
    project_id: "prj",
    directory: "/w/app",
    time_created: created,
    time_updated: created,
  });
}

/** A user row with `seq` and `created`; its id is `${sessionID}-${seq}`. */
function row(t: V2TestDb, sessionID: string, seq: number, created: number): string {
  const id = `${sessionID}-${seq}`;
  insertMessage(t.db, {
    id,
    session_id: sessionID,
    type: "user",
    seq,
    time_created: created,
    data: { text: `row ${seq}`, time: { created } },
  });
  return id;
}

async function open(t: V2TestDb) {
  const opened = await openOpencodeDb(t.path);
  if (!opened.ok) throw new Error(opened.reason);
  cleanups.push(() => opened.db.close());
  const spy = limitSpy(opened.db);
  return { source: createV2HistorySource(spy, { yieldBetween: noYield }), spy };
}

/** The ids of the first page a walk from the seek reads, newest first. */
async function firstPage(source: HistorySource, sessionID: string, until: number, limit = 3) {
  const sought = await source.seekPage!({ sessionID, until });
  if (!sought.ok) throw new Error(sought.error ?? sought.reason);
  if (sought.value === null) return null;
  const page = await source.messagePage({ sessionID, limit, before: sought.value });
  return page.items.map((m) => m.info.id);
}

describe("v2 seekPage", () => {
  it("names the page that starts at the newest message created at or before the bound", async () => {
    const t = await fresh();
    session(t, "ses_a");
    for (let seq = 1; seq <= 10; seq++) row(t, "ses_a", seq, seq * 1_000);
    const { source, spy } = await open(t);

    expect(await firstPage(source, "ses_a", 5_500)).toEqual(["ses_a-5", "ses_a-4", "ses_a-3"]);
    // A message created exactly at the bound starts the walk.
    expect(await firstPage(source, "ses_a", 7_000)).toEqual(["ses_a-7", "ses_a-6", "ses_a-5"]);

    // Two bounded statements per seek, neither reading a row's data.
    spy.statements.length = 0;
    await source.seekPage!({ sessionID: "ses_a", until: 5_500 });
    const reads = spy.statements.filter((sql) => /\bsession_message\b/.test(sql));
    expect(reads).toHaveLength(2);
    for (const sql of reads) expect(sql).not.toMatch(/\bdata\b/);
  });

  it("starts at the newest page when no message is newer than the one it finds", async () => {
    const t = await fresh();
    session(t, "ses_a");
    for (let seq = 1; seq <= 4; seq++) row(t, "ses_a", seq, seq * 1_000);
    const { source } = await open(t);
    expect(await source.seekPage!({ sessionID: "ses_a", until: 4_000 })).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("answers null when nothing was created at or before the bound", async () => {
    const t = await fresh();
    session(t, "ses_a");
    row(t, "ses_a", 1, 1_000);
    session(t, "ses_empty");
    const { source } = await open(t);
    expect(await source.seekPage!({ sessionID: "ses_a", until: 999 })).toEqual({
      ok: true,
      value: null,
    });
    expect(await source.seekPage!({ sessionID: "ses_empty", until: 5_000 })).toEqual({
      ok: true,
      value: null,
    });
  });

  it("keeps a row whose creation time a retried step moved later on the walk's side", async () => {
    // opencode moves a retried assistant's time_created to the step's start,
    // so seq 4 reads as newer than seq 5, which was written before the retry.
    const t = await fresh();
    session(t, "ses_a");
    row(t, "ses_a", 1, 1_000);
    row(t, "ses_a", 2, 2_000);
    row(t, "ses_a", 3, 3_000);
    row(t, "ses_a", 4, 4_800);
    row(t, "ses_a", 5, 4_200);
    row(t, "ses_a", 6, 6_000);
    const { source } = await open(t);
    expect(await firstPage(source, "ses_a", 4_900)).toEqual(["ses_a-5", "ses_a-4", "ses_a-3"]);
  });

  it("leaves out a fork's copies of its parent's rows, as its pages do", async () => {
    const t = await fresh();
    session(t, "ses_parent");
    for (let seq = 1; seq <= 3; seq++) row(t, "ses_parent", seq, seq * 1_000);
    writeFork(t.db, {
      parentID: "ses_parent",
      forkID: "ses_fork",
      created: 10_000,
      style: "parts",
    });
    row(t, "ses_fork", 4, 11_000);
    row(t, "ses_fork", 5, 12_000);
    const { source } = await open(t);
    // Only copies predate 10,000, and no page holds them.
    expect(await source.seekPage!({ sessionID: "ses_fork", until: 9_000 })).toEqual({
      ok: true,
      value: null,
    });
    expect(await firstPage(source, "ses_fork", 11_500)).toEqual(["ses_fork-4"]);
  });

  it("answers an error without reading for a bound that is not a number", async () => {
    const t = await fresh();
    session(t, "ses_a");
    row(t, "ses_a", 1, 1_000);
    const { source, spy } = await open(t);
    spy.statements.length = 0;
    for (const until of [Number.NaN, "5000" as unknown as number]) {
      expect(await source.seekPage!({ sessionID: "ses_a", until })).toMatchObject({
        ok: false,
        reason: "error",
      });
    }
    expect(spy.statements).toEqual([]);
  });

  it("calls an injected yield before each statement it runs", async () => {
    const t = await fresh();
    session(t, "ses_a");
    for (let seq = 1; seq <= 4; seq++) row(t, "ses_a", seq, seq * 1_000);
    const opened = await openOpencodeDb(t.path);
    if (!opened.ok) throw new Error(opened.reason);
    cleanups.push(() => opened.db.close());
    const spy = limitSpy(opened.db);
    let yields = 0;
    const source = createV2HistorySource(spy, {
      yieldBetween: async () => {
        yields++;
      },
    });
    // Later rows, the newest row, and nothing at or before the bound.
    const counts: Array<{ yields: number; reads: number }> = [];
    for (const until of [2_500, 4_000, 500]) {
      yields = 0;
      spy.statements.length = 0;
      await source.seekPage!({ sessionID: "ses_a", until });
      const reads = spy.statements.filter((sql) => /\bsession_message\b/.test(sql)).length;
      counts.push({ yields, reads });
    }
    expect(counts).toEqual([
      { yields: 2, reads: 2 },
      { yields: 2, reads: 2 },
      { yields: 1, reads: 1 },
    ]);
  });

  it("answers not-found for a session the database does not hold", async () => {
    const t = await fresh();
    const { source } = await open(t);
    expect(await source.seekPage!({ sessionID: "ses_gone", until: 1_000 })).toMatchObject({
      ok: false,
      reason: "not-found",
    });
  });
});

describe("v1 seekPage", () => {
  it("answers unsupported", async () => {
    const { source } = makeFakeHarness();
    expect(await source.seekPage!({ sessionID: "ses_a", until: 1_000 })).toMatchObject({
      ok: false,
      reason: "unsupported",
    });
  });
});
