import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Part } from "@opencode-ai/sdk/v2";
import type { HistoryMessage } from "../src/history/model.js";
import type { HistorySource, MessagePage } from "../src/history/source.js";
import {
  createV2HistorySource,
  encodeV2AscendingCursor,
  encodeV2Cursor,
  openOpencodeDb,
} from "../src/history/v2.js";
import type { ReadOnlyDb } from "../src/sqlite.js";
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
 * Pages of a long v2 session read far from either end: whole walks newest
 * first and oldest first, single pages from a cursor in the middle, and
 * messages there cut by the part-row cap and continued. Every expectation
 * comes from how the fixture wrote each message, and every statement goes
 * through the LIMIT spy, which throws on a `session_message` or
 * `session_part` statement that does not end in a bound `LIMIT ?`.
 */

/** Messages in the long session. */
const ROWS = 2_400;
const SID = "ses_long";
/** A second session whose rows share the long session's seqs and times. */
const SIDE = "ses_side";
/** An assistant of the long session with one more part row, filed under
 *  {@link SIDE}: it is no part of the long session's message. */
const STRAY = 1_202;

const idOf = (seq: number): string => `msg_${String(seq).padStart(5, "0")}`;
const seqOf = (m: HistoryMessage): number => Number(m.info.id.slice("msg_".length));

/** User rows on odd seqs. An assistant on a multiple of 6 has two part rows
 *  and its third item inline; every other assistant has three part rows. */
const isUser = (seq: number): boolean => seq % 2 === 1;
const isMixed = (seq: number): boolean => seq % 6 === 0;

/** The texts message `seq` reads as, in order. */
function expected(seq: number): string[] {
  if (isUser(seq)) return [`question ${seq}`];
  return [0, 1, 2].map((k) => `answer ${seq} part ${k}`);
}

const textOf = (part: Part): string | undefined => (part.type === "text" ? part.text : undefined);

const noYield = async (): Promise<void> => {};

let t: V2TestDb;
let db: ReadOnlyDb & { statements: string[] };
let source: HistorySource;
/** A reader whose part-row cap cuts every three-part assistant after two. */
let capped: HistorySource;

beforeAll(async () => {
  t = await makeV2PartsDb();
  insertProject(t.db, { id: "prj", worktree: "/w" });
  const at = 1_000_000;
  t.db.tx(() => {
    for (const id of [SID, SIDE]) {
      insertSession(t.db, {
        id,
        project_id: "prj",
        directory: "/w",
        time_created: at,
        time_updated: at + ROWS,
      });
    }
    const write = (sessionID: string, id: string, seq: number, label: string) => {
      const created = at + seq;
      if (isUser(seq)) {
        insertMessage(t.db, {
          id,
          session_id: sessionID,
          type: "user",
          seq,
          time_created: created,
          data: { text: `question ${label}`, time: { created } },
        });
        return;
      }
      const items = [0, 1, 2].map((k) => ({ type: "text", text: `answer ${label} part ${k}` }));
      const asParts = isMixed(seq) ? 2 : 3;
      insertMessage(t.db, {
        id,
        session_id: sessionID,
        type: "assistant",
        seq,
        time_created: created,
        data: {
          agent: "build",
          model: { id: "m", providerID: "p" },
          content: items.slice(asParts),
          time: { created, completed: created + 1 },
        },
      });
      items.slice(0, asParts).forEach((data, ordinal) => {
        insertPart(t.db, {
          message_id: id,
          session_id: sessionID,
          ordinal,
          time_created: created,
          data,
        });
      });
    };
    for (let seq = 1; seq <= ROWS; seq++) {
      write(SID, idOf(seq), seq, String(seq));
      if (seq <= 300) write(SIDE, `side_${seq}`, seq, `side ${seq}`);
    }
    insertPart(t.db, {
      message_id: idOf(STRAY),
      session_id: SIDE,
      ordinal: 3,
      time_created: at + STRAY,
      data: { type: "text", text: "filed under another session" },
    });
  });
  const opened = await openOpencodeDb(t.path);
  if (!opened.ok) throw new Error(opened.reason);
  db = limitSpy(opened.db);
  source = createV2HistorySource(db, { yieldBetween: noYield });
  capped = createV2HistorySource(db, { yieldBetween: noYield, pagePartRows: 2 });
});

afterAll(() => {
  db?.close();
  t?.cleanup();
});

/** Seqs from `from` to `to`, either way, inclusive. */
function range(from: number, to: number): number[] {
  const step = from <= to ? 1 : -1;
  return Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => from + i * step);
}

type Order = "newest" | "oldest";

/** One page of the long session in `order` from past `cursor` (its first
 *  page without one). */
function pageOf(
  reader: HistorySource,
  order: Order,
  limit: number,
  cursor?: string,
): Promise<MessagePage> {
  return order === "oldest"
    ? reader.messagePageAscending!({ sessionID: SID, limit, after: cursor })
    : reader.messagePage({ sessionID: SID, limit, before: cursor });
}

/** Pages from `cursor` on in `order` until `until` holds, or the session ends. */
async function walk(
  reader: HistorySource,
  order: Order,
  limit: number,
  cursor?: string,
  until: (seen: HistoryMessage[]) => boolean = () => false,
): Promise<MessagePage[]> {
  const pages: MessagePage[] = [];
  const seen: HistoryMessage[] = [];
  let next = cursor;
  do {
    const page = await pageOf(reader, order, limit, next);
    pages.push(page);
    seen.push(...page.items);
    next = page.nextCursor ?? undefined;
    if (pages.length > ROWS) throw new Error("page walk did not terminate");
  } while (next !== undefined && !until(seen));
  return pages;
}

/** The texts of a message read through `getMessage` continuations until a
 *  read is no longer partial, each partial read's closing note left out. */
async function completeTexts(reader: HistorySource, first: HistoryMessage): Promise<string[]> {
  const texts: string[] = [];
  let current = first;
  for (let reads = 1; ; reads++) {
    const parts = current.partial ? current.parts.slice(0, -1) : current.parts;
    texts.push(...parts.map((p) => textOf(p) ?? `<${p.type}>`));
    if (!current.partial) return texts;
    if (reads > 20) throw new Error("continuation did not terminate");
    const got = await reader.getMessage(SID, current.info.id, {
      partOrdinal: current.partial.nextOrdinal,
    });
    if (!got.ok) throw new Error(`${got.reason}: ${got.error ?? ""}`);
    current = got.value;
  }
}

describe("v2 source: pages of a long session", () => {
  it("walks the whole session newest first and oldest first, each message once with its parts", async () => {
    for (const order of ["newest", "oldest"] as const) {
      const messages = (await walk(source, order, 97)).flatMap((page) => page.items);
      const seqs = order === "newest" ? range(ROWS, 1) : range(1, ROWS);
      expect(
        messages.map((m) => m.info.id),
        order,
      ).toEqual(seqs.map(idOf));
      for (const m of messages) {
        expect(m.partial, m.info.id).toBeUndefined();
        expect(m.parts.map(textOf), m.info.id).toEqual(expected(seqOf(m)));
      }
    }
    // The part reads went through the spy too.
    expect(db.statements.some((sql) => /\bsession_part\b/.test(sql))).toBe(true);
  });

  it("reads the page just past a cursor deep in the session, in either order", async () => {
    const down = await pageOf(source, "newest", 50, encodeV2Cursor(1_201));
    expect(down.items.map((m) => m.info.id)).toEqual(range(1_200, 1_151).map(idOf));
    expect(down.nextCursor).toBe(encodeV2Cursor(1_151));
    const up = await pageOf(source, "oldest", 50, encodeV2AscendingCursor(1_200));
    expect(up.items.map((m) => m.info.id)).toEqual(range(1_201, 1_250).map(idOf));
    expect(up.nextCursor).toBe(encodeV2AscendingCursor(1_250));
    for (const m of [...down.items, ...up.items]) {
      expect(m.parts.map(textOf), m.info.id).toEqual(expected(seqOf(m)));
    }
    // A cursor next to either end leaves a short last page.
    const bottom = await pageOf(source, "newest", 50, encodeV2Cursor(3));
    expect(bottom.items.map((m) => m.info.id)).toEqual([idOf(2), idOf(1)]);
    expect(bottom.nextCursor).toBeNull();
    const top = await pageOf(source, "oldest", 50, encodeV2AscendingCursor(ROWS - 1));
    expect(top.items.map((m) => m.info.id)).toEqual([idOf(ROWS)]);
    expect(top.nextCursor).toBeNull();
  });

  it("cuts messages deep in the session at the part-row cap and continues each to its last part", async () => {
    const starts = {
      newest: { cursor: encodeV2Cursor(STRAY + 1), seqs: range(STRAY, STRAY - 23) },
      oldest: { cursor: encodeV2AscendingCursor(STRAY - 2), seqs: range(STRAY - 1, STRAY + 22) },
    };
    for (const order of ["newest", "oldest"] as const) {
      const { cursor, seqs } = starts[order];
      const pages = await walk(capped, order, 10, cursor, (seen) => seen.length >= seqs.length);
      const messages = pages.flatMap((page) => page.items).slice(0, seqs.length);
      expect(
        messages.map((m) => m.info.id),
        order,
      ).toEqual(seqs.map(idOf));
      let partial = 0;
      for (const page of pages) {
        // Only a page's first message is cut, and it then ends the page.
        page.items.forEach((m, i) => {
          if (m.partial) expect([order, i, page.items.length]).toEqual([order, 0, 1]);
        });
      }
      for (const m of messages) {
        const seq = seqOf(m);
        if (m.partial) {
          partial++;
          // Two part rows read; the third, and nothing filed under the other
          // session, is left for the continuation.
          expect(m.partial, m.info.id).toEqual(
            expect.objectContaining({ nextOrdinal: 2, omittedParts: 1 }),
          );
          expect(isUser(seq) || isMixed(seq), m.info.id).toBe(false);
        }
        expect(await completeTexts(capped, m), m.info.id).toEqual(expected(seq));
      }
      // Every three-part assistant in the stretch was cut.
      expect(partial, order).toBe(seqs.filter((s) => !isUser(s) && !isMixed(s)).length);
    }
  });
});
