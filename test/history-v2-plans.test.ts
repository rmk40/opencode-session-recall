import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createV2HistorySource,
  encodeV2Cursor,
  openOpencodeDb,
  type V2SchemaInfo,
} from "../src/history/v2.js";
import { createV2Sync } from "../src/history/v2-sync.js";
import type { PollMeta } from "../src/distill.js";
import type { ReadOnlyDb, Row, SqlValue } from "../src/sqlite.js";
import {
  insertMessage,
  insertPart,
  insertProject,
  insertSession,
  makeV2PartsDb,
  type V2TestDb,
} from "./v2-db.js";

/**
 * Query plans of every `session_message` and `session_part` statement the v2
 * history reader and sync run over a long session. A join, or a statement
 * that walks rows it then filters, must reach those tables by more than the
 * session id: through the session id and a seq, an id or a message id. A
 * lookup by `session_id=?` alone inside a join walks every row of the
 * session for each row it is matched against, so its cost grows with the
 * session rather than the page.
 *
 * The planner's choice can depend on automatic indexes and on table
 * statistics, so each statement is planned with automatic indexes on and
 * off, and again after `ANALYZE`.
 */

/** Messages of the long session: enough that a walk of it would show. */
const ROWS = 3_000;

let t: V2TestDb;
let reader: ReadOnlyDb;
let schema: V2SchemaInfo;

beforeAll(async () => {
  t = await makeV2PartsDb();
  t.db.exec("PRAGMA synchronous = OFF");
  insertProject(t.db, { id: "prj", worktree: "/w" });
  const at = Date.now() - 60_000;
  for (const id of ["ses_long", "ses_other"]) {
    insertSession(t.db, {
      id,
      project_id: "prj",
      directory: "/w",
      time_created: at - ROWS,
      time_updated: at,
    });
  }
  t.db.tx(() => {
    for (let seq = 1; seq <= ROWS; seq++) {
      const id = `msg_${String(seq).padStart(6, "0")}`;
      const created = at - ROWS + seq;
      if (seq % 2 === 1) {
        insertMessage(t.db, {
          id,
          session_id: "ses_long",
          type: "user",
          seq,
          time_created: created,
          data: { text: `question ${seq}`, time: { created } },
        });
        continue;
      }
      insertMessage(t.db, {
        id,
        session_id: "ses_long",
        type: "assistant",
        seq,
        time_created: created,
        data: {
          agent: "build",
          model: { id: "m", providerID: "p" },
          content: [],
          time: { created, completed: created + 1 },
        },
      });
      for (let ordinal = 0; ordinal < 3; ordinal++) {
        insertPart(t.db, {
          message_id: id,
          session_id: "ses_long",
          ordinal,
          time_created: created,
          data: { type: "text", text: `answer ${seq} part ${ordinal}` },
        });
      }
    }
    for (let seq = 1; seq <= 20; seq++) {
      insertMessage(t.db, {
        id: `msg_other_${seq}`,
        session_id: "ses_other",
        type: "user",
        seq,
        time_created: at + seq,
        data: { text: `other ${seq}`, time: { created: at + seq } },
      });
    }
  });
  const opened = await openOpencodeDb(t.path);
  if (!opened.ok) throw new Error(opened.reason);
  reader = opened.db;
  schema = opened.schema;
});

afterAll(() => {
  reader?.close();
  t?.cleanup();
});

type Statement = { sql: string; params: SqlValue[] };

/** A reader that records each history statement it runs. */
function recording(): { db: ReadOnlyDb; statements: Statement[] } {
  const statements: Statement[] = [];
  const note = (sql: string, params: SqlValue[] = []): void => {
    if (/\bsession_(message|part)\b/.test(sql)) statements.push({ sql, params });
  };
  return {
    statements,
    db: {
      get: (sql, params) => {
        note(sql, params);
        return reader.get(sql, params);
      },
      all: (sql, params) => {
        note(sql, params);
        return reader.all(sql, params);
      },
      close: () => {},
    },
  };
}

/** Every history statement the reader and the sync run over the long
 *  session: pages either way and from deep inside it, a cut message and its
 *  continuation, point reads, seeks, floors, checkpoints, range digests and
 *  a poll. */
async function workload(): Promise<Statement[]> {
  const { db, statements } = recording();
  const source = createV2HistorySource(db, { schema, yieldBetween: async () => {} });
  const sync = createV2Sync(db, { schema, yieldBetween: async () => {} });
  await source.messagePage({ sessionID: "ses_long", limit: 50 });
  await source.messagePageAscending!({ sessionID: "ses_long", limit: 50 });
  await source.messagePage({
    sessionID: "ses_long",
    limit: 50,
    before: encodeV2Cursor(ROWS / 2),
  });
  // A part row cap of 2 cuts the first assistant after two of its three
  // part rows; the continuation reads the third.
  const cutting = createV2HistorySource(db, {
    schema,
    pagePartRows: 2,
    yieldBetween: async () => {},
  });
  const cut = await cutting.messagePage({ sessionID: "ses_long", limit: 5 });
  const partial = cut.items.find((m) => m.partial);
  if (!partial) throw new Error("the workload's page was not cut");
  await cutting.getMessage("ses_long", partial.info.id, {
    partOrdinal: partial.partial!.nextOrdinal,
  });
  await source.getMessage("ses_long", `msg_${String(ROWS / 2).padStart(6, "0")}`);
  const middle = Date.now() - 60_000 - ROWS / 2;
  await source.seekPage!({ sessionID: "ses_long", until: middle });
  await source.seqFloor!({ sessionID: "ses_long", after: middle, before: middle + 100 });
  const checkpoint = await sync.checkpoint("ses_long");
  await sync.compare("ses_long", checkpoint?.cursor);
  await sync.rangeDigest!("ses_long", ROWS / 2, 500);
  await sync.withParts!(["ses_long", "ses_other"]);
  await sync.seqOf!("ses_long", `msg_${String(ROWS / 2).padStart(6, "0")}`);
  const values = new Map<string, string>();
  const meta: PollMeta = { get: (key) => values.get(key), set: (k, v) => void values.set(k, v) };
  await sync.poll(meta);
  return statements;
}

/** The plan's accesses to `session_message` and `session_part` that a long
 *  session makes slow, as `detail` lines. */
function slowAccesses(db: ReadOnlyDb, statement: Statement): string[] {
  const plan = db.all(`EXPLAIN QUERY PLAN ${statement.sql}`, statement.params) as Row[];
  const details = plan.map((row) => String(row.detail));
  const names = new Set(["session_message", "session_part"]);
  for (const [, , alias] of statement.sql.matchAll(
    /\b(session_message|session_part)\s+(?:AS\s+)?([a-z]\w*)\b/gi,
  )) {
    if (!/^(WHERE|JOIN|ON|LEFT|CROSS|INNER|ORDER|GROUP|LIMIT|USING|AND)$/i.test(alias!)) {
      names.add(alias!);
    }
  }
  const accesses = details.filter((d) => /^(SCAN|SEARCH) /.test(d));
  const joined = accesses.length > 1;
  return accesses.filter((detail) => {
    const name = /^(?:SCAN|SEARCH) (\S+)/.exec(detail)![1]!;
    if (!names.has(name)) return false;
    if (detail.startsWith("SCAN ")) return true;
    // An EXISTS subquery stops at its first row.
    if (detail.startsWith(`SEARCH ${name} EXISTS `)) return false;
    return joined && /\(session_id=\?\)$/.test(detail);
  });
}

describe("v2 history query plans over a long session", () => {
  it("reaches session_message and session_part by more than the session id in every join, and never scans them", async () => {
    const statements = await workload();
    expect(statements.length).toBeGreaterThan(20);
    const found: string[] = [];
    const check = (label: string, db: ReadOnlyDb): void => {
      for (const statement of statements) {
        for (const detail of slowAccesses(db, statement)) {
          found.push(`${label}: ${detail} in ${statement.sql.replace(/\s+/g, " ").slice(0, 80)}`);
        }
      }
    };
    check("with automatic indexes", reader);
    reader.get("PRAGMA automatic_index = OFF");
    try {
      check("without automatic indexes", reader);
    } finally {
      reader.get("PRAGMA automatic_index = ON");
    }
    // Statistics load with the schema, so a connection opened after ANALYZE
    // plans with them.
    t.db.exec("ANALYZE");
    const analyzed = await openOpencodeDb(t.path);
    if (!analyzed.ok) throw new Error(analyzed.reason);
    try {
      check("after ANALYZE", analyzed.db);
    } finally {
      analyzed.db.close();
    }
    expect(found).toEqual([]);
  });
});
