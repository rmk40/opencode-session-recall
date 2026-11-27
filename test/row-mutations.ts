import type { Row, SqlValue, SqliteDb } from "../src/sqlite.js";

/**
 * One statement that wrote a slim-index row (`part_text`) or its FTS entry
 * (`part_fts`): whether it added, updated or removed it, and the rowid it
 * wrote, or `session` for a statement that names no single row (one over
 * every row of a session, say).
 */
export type RowMutation = {
  table: "part_text" | "part_fts";
  op: "add" | "update" | "remove";
  id: number | "session";
};

/** What a statement over one row did, and to which rowid. */
function mutationOf(
  sql: string,
  params: SqlValue[] | undefined,
  inserted: number,
): Omit<RowMutation, "table"> {
  const flat = sql.replace(/\s+/g, " ").trim();
  if (/^INSERT INTO part_text\b/.test(flat)) return { op: "add", id: inserted };
  // An FTS insert or 'delete' command names its rowid first.
  if (/^INSERT INTO part_fts\(rowid,/.test(flat)) return { op: "add", id: Number(params?.[0]) };
  if (/^INSERT INTO part_fts\(part_fts, rowid,.*VALUES\('delete'/.test(flat)) {
    return { op: "remove", id: Number(params?.[0]) };
  }
  if (/^UPDATE part_text\b.* WHERE id=\?$/.test(flat)) {
    return { op: "update", id: Number(params?.at(-1)) };
  }
  if (/^DELETE FROM part_text WHERE id=\?$/.test(flat)) {
    return { op: "remove", id: Number(params?.[0]) };
  }
  return { op: /^DELETE/.test(flat) ? "remove" : "update", id: "session" };
}

/**
 * Wrap a store connection so that, while recording, every statement that
 * writes `part_text` or `part_fts` is listed with the row it wrote. Reads are
 * not listed.
 */
export function recordRowMutations(inner: SqliteDb): {
  db: SqliteDb;
  mutations: RowMutation[];
  record(on: boolean): void;
} {
  const mutations: RowMutation[] = [];
  let recording = false;
  return {
    mutations,
    record(on) {
      recording = on;
      if (on) mutations.length = 0;
    },
    db: {
      ...inner,
      run(sql, params) {
        const result = inner.run(sql, params);
        if (recording) {
          const table = /\bpart_fts\b/.test(sql)
            ? "part_fts"
            : /\bpart_text\b/.test(sql)
              ? "part_text"
              : undefined;
          if (table) mutations.push({ table, ...mutationOf(sql, params, result.lastInsertRowid) });
        }
        return result;
      },
    },
  };
}

/** A session's slim-index rows keyed by part id, each with its rowid. */
export function rowsByPart(db: SqliteDb, sessionId: string): Map<string, Row> {
  return new Map(
    db
      .all(
        `SELECT id, part_id, message_id, prev_message_id, next_message_id, class, time_created, raw, norm
         FROM part_text WHERE session_id = ?`,
        [sessionId],
      )
      .map((row) => [String(row.part_id), row]),
  );
}

/**
 * The part ids whose rows a write changed, from the rows before and after
 * it: added, removed, or holding a different value in any of `columns`
 * (every column but the rowid by default; `raw` and `norm` for the rows the
 * FTS index holds).
 */
export function changedParts(
  before: Map<string, Row>,
  after: Map<string, Row>,
  columns?: readonly string[],
): string[] {
  const same = (a: Row, b: Row): boolean =>
    (columns ?? Object.keys(a).filter((key) => key !== "id")).every((key) => a[key] === b[key]);
  const changed = new Set<string>();
  for (const [part, row] of before) {
    const now = after.get(part);
    if (!now || !same(row, now)) changed.add(part);
  }
  for (const part of after.keys()) if (!before.has(part)) changed.add(part);
  return [...changed].sort();
}

/**
 * The part ids of the rows `mutations` wrote in `table`: a removed row's
 * read through the rows before the write, an added or updated one's through
 * the rows after it. `session` when a statement named no single row.
 */
export function touchedParts(
  mutations: RowMutation[],
  table: RowMutation["table"],
  before: Map<string, Row>,
  after: Map<string, Row>,
): string[] | "session" {
  const partOf = (rows: Map<string, Row>): Map<number, string> =>
    new Map([...rows].map(([part, row]) => [Number(row.id), part]));
  const removed = partOf(before);
  const written = partOf(after);
  const touched = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.table !== table) continue;
    if (mutation.id === "session") return "session";
    const rows = mutation.op === "remove" ? removed : written;
    touched.add(rows.get(mutation.id) ?? `rowid ${mutation.id}`);
  }
  return [...touched].sort();
}
