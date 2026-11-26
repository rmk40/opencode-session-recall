/**
 * Test-side opencode v2 database builder: a temp `opencode.db` created from the
 * vendored DDL (`test/fixtures/opencode-v2-schema.sql`, plus
 * `opencode-v2-part-schema.sql` for 2.4.1's `session_part`), raw row writers,
 * an inverse projector that writes v1-shaped fixture bundles as v2 rows in
 * each storage layout opencode has used, and a spy that fails any
 * `session_message` or `session_part` statement without `LIMIT ?`.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GlobalSession, Part, Session } from "@opencode-ai/sdk/v2";
import { openSqlite, type ReadOnlyDb, type SqlValue, type SqliteDb } from "../src/sqlite.js";
import { compareMessages, type HistoryMessage } from "../src/history/model.js";
import { CLEARED_TOOL_OUTPUT } from "../src/history/v2-project.js";

export const V2_DDL = readFileSync(
  fileURLToPath(new URL("./fixtures/opencode-v2-schema.sql", import.meta.url)),
  "utf8",
);

/** opencode 2.4.1's `session_part` table and index, applied after {@link V2_DDL}. */
export const V2_PART_DDL = readFileSync(
  fileURLToPath(new URL("./fixtures/opencode-v2-part-schema.sql", import.meta.url)),
  "utf8",
);

/** The newest migration of the 2.0.18 schema in {@link V2_DDL}. */
export const V2_BASE_MIGRATION = "20260923013825_project_time_active";
/** The newest migration of the opencode 2.4.1 database the part layouts model. */
export const V2_PARTS_MIGRATION = "20261120004954_machine-key";

export type V2TestDb = {
  /** Read-write writer connection (tests only; the source opens read-only). */
  db: SqliteDb;
  path: string;
  cleanup: () => void;
};

/** A fresh file database with the v2 schema and one applied migration row. */
export async function makeV2Db(ddl = V2_DDL, migration = V2_BASE_MIGRATION): Promise<V2TestDb> {
  const dir = mkdtempSync(join(tmpdir(), "recall-v2db-"));
  const path = join(dir, "opencode.db");
  const db = await openSqlite(path);
  if (!db) throw new Error("openSqlite returned null");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(ddl);
  db.run("INSERT INTO migration (id, time_completed) VALUES (?, ?)", [migration, 1]);
  return {
    db,
    path,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A fresh opencode 2.4.1-shaped database: {@link V2_DDL} plus `session_part`. */
export function makeV2PartsDb(): Promise<V2TestDb> {
  return makeV2Db(`${V2_DDL}\n${V2_PART_DDL}`, V2_PARTS_MIGRATION);
}

export function insertProject(
  db: SqliteDb,
  p: { id: string; worktree: string; name?: string | null },
): void {
  db.run(
    `INSERT OR IGNORE INTO project (id, worktree, name, time_created, time_updated, sandboxes)
     VALUES (?, ?, ?, 0, 0, '[]')`,
    [p.id, p.worktree, p.name ?? null],
  );
}

export type SessionInsert = {
  id: string;
  project_id: string;
  directory: string;
  time_created: number;
  time_updated: number;
  parent_id?: string | null;
  fork_session_id?: string | null;
  slug?: string;
  title?: string | null;
  version?: string;
  agent?: string | null;
  model?: string | null;
  time_idle?: number | null;
  time_archived?: number | null;
};

export function insertSession(db: SqliteDb, s: SessionInsert): void {
  db.run(
    `INSERT INTO session_v2 (id, project_id, parent_id, fork_session_id, slug, directory, title,
       version, agent, model, time_created, time_updated, time_idle, time_archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.id,
      s.project_id,
      s.parent_id ?? null,
      s.fork_session_id ?? null,
      s.slug ?? s.id,
      s.directory,
      s.title === undefined ? s.id : s.title,
      s.version ?? "2.0.18",
      s.agent ?? null,
      s.model ?? null,
      s.time_created,
      s.time_updated,
      s.time_idle ?? null,
      s.time_archived ?? null,
    ],
  );
}

export type MessageInsert = {
  id: string;
  session_id: string;
  type: string;
  seq: number;
  time_created: number;
  time_updated?: number;
  /** Encoded as JSON unless already a string (lets tests write bad JSON). */
  data: unknown;
};

export function insertMessage(db: SqliteDb, m: MessageInsert): void {
  db.run(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      m.id,
      m.session_id,
      m.type,
      m.seq,
      m.time_created,
      m.time_updated ?? m.time_created,
      typeof m.data === "string" ? m.data : JSON.stringify(m.data),
    ],
  );
}

export type PartInsert = {
  message_id: string;
  session_id: string;
  ordinal: number;
  time_created: number;
  time_updated?: number;
  /** Defaults to `data.type`, as opencode writes it. */
  type?: string;
  /** Defaults to a tool item's `id`, as opencode writes it, else NULL. */
  call_id?: string | null;
  /** Encoded as JSON unless already a string (lets tests write bad JSON). */
  data: unknown;
};

/** One `session_part` row, with the columns opencode 2.4.1 derives from the
 *  item (`core/src/session/projector.ts` `writeParts`). */
export function insertPart(db: SqliteDb, p: PartInsert): void {
  const item =
    typeof p.data === "object" && p.data !== null ? (p.data as Record<string, unknown>) : {};
  const type = p.type ?? (typeof item.type === "string" ? item.type : "");
  const callID =
    p.call_id !== undefined
      ? p.call_id
      : type === "tool" && typeof item.id === "string"
        ? item.id
        : null;
  db.run(
    `INSERT INTO session_part (message_id, session_id, ordinal, type, call_id, time_created,
       time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p.message_id,
      p.session_id,
      p.ordinal,
      type,
      callID,
      p.time_created,
      p.time_updated ?? p.time_created,
      typeof p.data === "string" ? p.data : JSON.stringify(p.data),
    ],
  );
}

// ── Inverse projector: v1-shaped bundles → v2 rows ───────────────────────────

type AnySession = Session | GlobalSession;

/** Where {@link writeV1Corpus} puts assistant content items. */
export type CorpusLayout = "inline" | "parts" | "mixed";

function assistantItem(part: Part): unknown {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "reasoning":
      return { type: "reasoning", text: part.text };
    case "tool": {
      const state = part.state;
      const base = { type: "tool", id: part.callID, name: part.tool };
      switch (state.status) {
        case "pending":
          return {
            ...base,
            state: { status: "streaming", input: state.raw },
            time: { created: 0 },
          };
        case "running":
          return {
            ...base,
            state: { status: "running", input: state.input, metadata: {} },
            time: { created: state.time.start },
          };
        case "completed":
          return {
            ...base,
            state: {
              status: "completed",
              input: state.input,
              // What the v1-to-v2 migration wrote for compaction-pruned output.
              content: [
                {
                  type: "text",
                  text: state.time.compacted === undefined ? state.output : CLEARED_TOOL_OUTPUT,
                },
              ],
              metadata: state.metadata,
            },
            time: { created: state.time.start, completed: state.time.end },
          };
        case "error":
          return {
            ...base,
            state: {
              status: "error",
              input: state.input,
              error: { type: "unknown", message: state.error },
            },
            time: { created: state.time.start, completed: state.time.end },
          };
      }
      return undefined;
    }
    default:
      // Parts v2 has no content item for (subtask, patch, step markers) are
      // dropped, as the migration folds or drops them.
      return undefined;
  }
}

/**
 * Write sessions and their v1-shaped message bundles as v2 rows: one project
 * per project id, one `session_v2` row per session, and per message one row
 * in chronological order (seq from 1). A user message becomes a `user` row
 * (non-synthetic text joined) plus one `synthetic` row per synthetic text
 * part, the split the v1-to-v2 migration made; an assistant message becomes
 * an `assistant` row with one content item per convertible part. This is the
 * inverse of `src/history/v2-project.ts`, so a round trip proves
 * self-consistency, not faithfulness.
 *
 * `layout` says where an assistant row's content items go (part rows need a
 * database from {@link makeV2PartsDb}):
 *
 * - `"inline"`: all in `data.content`, as opencode wrote them before 2.4.
 * - `"parts"`: one `session_part` row each (ordinals from 0) and
 *   `data.content = []`, as 2.4.1 writes a new assistant message.
 * - `"mixed"`: the leading half (rounded up) as part rows and the rest
 *   inline, the layout 2.4.1 reads as parts by ordinal followed by inline
 *   content. Every layout reads back as the same items in the same order.
 */
export function writeV1Corpus(
  db: SqliteDb,
  sessions: AnySession[],
  messagesBySession: Record<string, HistoryMessage[]>,
  layout: CorpusLayout = "inline",
): void {
  for (const s of sessions) {
    const project = (s as GlobalSession).project;
    insertProject(db, {
      id: s.projectID,
      worktree: project?.worktree ?? s.directory,
      name: project?.name ?? null,
    });
    insertSession(db, {
      id: s.id,
      project_id: s.projectID,
      parent_id: s.parentID ?? null,
      slug: s.slug,
      directory: s.directory,
      title: s.title,
      time_created: s.time.created,
      time_updated: s.time.updated,
      time_archived: s.time.archived ?? null,
    });
    let seq = 0;
    const chrono = [...(messagesBySession[s.id] ?? [])].sort(compareMessages);
    for (const msg of chrono) {
      const created = msg.info.time.created;
      const common = { session_id: s.id, time_created: created };
      if (msg.info.role === "user") {
        const texts = msg.parts.filter((p) => p.type === "text" && p.synthetic !== true);
        insertMessage(db, {
          ...common,
          id: msg.info.id,
          type: "user",
          seq: ++seq,
          data: {
            text: texts.map((p) => (p.type === "text" ? p.text : "")).join("\n\n"),
            time: { created },
          },
        });
        msg.parts.forEach((p, i) => {
          if (p.type !== "text" || p.synthetic !== true) return;
          insertMessage(db, {
            ...common,
            id: `${msg.info.id}-syn${i}`,
            type: "synthetic",
            seq: ++seq,
            data: { text: p.text, time: { created } },
          });
        });
        continue;
      }
      const info = msg.info;
      const items = msg.parts.map(assistantItem).filter((item) => item !== undefined);
      const asParts =
        layout === "inline" ? 0 : layout === "parts" ? items.length : Math.ceil(items.length / 2);
      insertMessage(db, {
        ...common,
        id: info.id,
        type: "assistant",
        seq: ++seq,
        data: {
          agent: info.agent,
          model: { id: info.modelID, providerID: info.providerID },
          content: items.slice(asParts),
          time: {
            created,
            ...(info.time.completed !== undefined ? { completed: info.time.completed } : {}),
          },
        },
      });
      items.slice(0, asParts).forEach((item, ordinal) => {
        insertPart(db, { ...common, message_id: info.id, ordinal, data: item });
      });
    }
  }
}

/**
 * Fork `parentID` into a new session `forkID` the way opencode does: the fork
 * names its parent in `fork_session_id` and is created at `created`, and
 * every parent row is copied under the id `${forkID}_${seq}` with its seq,
 * times and type unchanged (so the copies predate the fork). `"parts"` is
 * opencode 2.4.1: rows are copied as stored and the parent's part rows are
 * copied remapped to the copies' message and session ids. `"inline"` is the
 * 2.2.5 checkout: an assistant row with part rows is copied with those parts
 * as its `data.content` (`core/src/session/history.ts` `withParts`), and no
 * part row is copied. Returns the copied message ids in seq order.
 */
export function writeFork(
  db: SqliteDb,
  o: { parentID: string; forkID: string; created: number; style: "parts" | "inline" },
): string[] {
  const parent = db.get("SELECT project_id, directory FROM session_v2 WHERE id = ?", [o.parentID]);
  if (!parent) throw new Error(`no parent session ${o.parentID}`);
  insertSession(db, {
    id: o.forkID,
    project_id: String(parent.project_id),
    directory: String(parent.directory),
    fork_session_id: o.parentID,
    time_created: o.created,
    time_updated: o.created,
  });
  const copied: string[] = [];
  const rows = db.all("SELECT * FROM session_message WHERE session_id = ? ORDER BY seq", [
    o.parentID,
  ]);
  for (const row of rows) {
    const id = `${o.forkID}_${String(row.seq)}`;
    const parts = db.all("SELECT * FROM session_part WHERE message_id = ? ORDER BY ordinal", [
      String(row.id),
    ]);
    let data = String(row.data);
    if (o.style === "inline" && row.type === "assistant" && parts.length > 0) {
      const decoded = JSON.parse(data) as Record<string, unknown>;
      if ("content" in decoded) {
        decoded.content = parts.map((part) => JSON.parse(String(part.data)) as unknown);
        data = JSON.stringify(decoded);
      }
    }
    insertMessage(db, {
      id,
      session_id: o.forkID,
      type: String(row.type),
      seq: Number(row.seq),
      time_created: Number(row.time_created),
      time_updated: Number(row.time_updated),
      data,
    });
    if (o.style === "parts") {
      for (const part of parts) {
        insertPart(db, {
          message_id: id,
          session_id: o.forkID,
          ordinal: Number(part.ordinal),
          type: String(part.type),
          call_id: part.call_id === null ? null : String(part.call_id),
          time_created: Number(part.time_created),
          time_updated: Number(part.time_updated),
          data: String(part.data),
        });
      }
    }
    copied.push(id);
  }
  return copied;
}

// ── LIMIT spy ────────────────────────────────────────────────────────────────

/** The history tables every statement must bound with `LIMIT ?`. */
const BOUNDED_TABLES = /\bsession_(message|part)\b/i;

/**
 * Whether a statement reads `session_message` or `session_part` without a
 * bound LIMIT. The pattern is anchored at the END of the statement: `LIMIT ?`
 * must be the last clause, so a LIMIT inside a subquery or CTE does not count,
 * and the bound is then the last parameter, which {@link limitSpy} checks is a
 * positive integer.
 */
export function violatesLimitRule(sql: string): boolean {
  return BOUNDED_TABLES.test(sql) && !/\bLIMIT\s+\?\s*$/i.test(sql.trim());
}

/**
 * Wrap a connection so any `session_message` or `session_part` statement that
 * does not end in `LIMIT ?` with a positive integer bound throws.
 * `statements` records every statement for assertions.
 */
export function limitSpy(inner: ReadOnlyDb): ReadOnlyDb & { statements: string[] } {
  const statements: string[] = [];
  const check = (sql: string, params: SqlValue[] = []): void => {
    statements.push(sql);
    const table = BOUNDED_TABLES.exec(sql)?.[0];
    if (table === undefined) return;
    if (violatesLimitRule(sql)) throw new Error(`${table} query without LIMIT ?: ${sql}`);
    const bound = params[params.length - 1];
    if (typeof bound !== "number" || !Number.isInteger(bound) || bound < 1) {
      throw new Error(`${table} LIMIT bound is not a positive integer: ${String(bound)}`);
    }
  };
  return {
    statements,
    get: (sql, params) => {
      check(sql, params);
      return inner.get(sql, params);
    },
    all: (sql, params) => {
      check(sql, params);
      return inner.all(sql, params);
    },
    close: () => inner.close(),
  };
}
