/**
 * Test-side opencode v2 database builder: a temp `opencode.db` created from the
 * vendored DDL (`test/fixtures/opencode-v2-schema.sql`), raw row writers, an
 * inverse projector that writes v1-shaped fixture bundles as v2 rows, and a
 * spy that fails any `session_message` statement without `LIMIT ?`.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GlobalSession, Part, Session } from "@opencode-ai/sdk/v2";
import { openSqlite, type SqlValue, type SqliteDb } from "../src/sqlite.js";
import { compareMessages, type HistoryMessage } from "../src/history/model.js";
import { CLEARED_TOOL_OUTPUT } from "../src/history/v2-project.js";

export const V2_DDL = readFileSync(
  fileURLToPath(new URL("./fixtures/opencode-v2-schema.sql", import.meta.url)),
  "utf8",
);

export type V2TestDb = {
  /** Read-write writer connection (tests only; the source opens read-only). */
  db: SqliteDb;
  path: string;
  cleanup: () => void;
};

/** A fresh file database with the v2 schema and one applied migration row. */
export async function makeV2Db(ddl = V2_DDL): Promise<V2TestDb> {
  const dir = mkdtempSync(join(tmpdir(), "recall-v2db-"));
  const path = join(dir, "opencode.db");
  const db = await openSqlite(path);
  if (!db) throw new Error("openSqlite returned null");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(ddl);
  db.run("INSERT INTO migration (id, time_completed) VALUES (?, ?)", [
    "20260923013825_project_time_active",
    1,
  ]);
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

// ── Inverse projector: v1-shaped bundles → v2 rows ───────────────────────────

type AnySession = Session | GlobalSession;

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
 */
export function writeV1Corpus(
  db: SqliteDb,
  sessions: AnySession[],
  messagesBySession: Record<string, HistoryMessage[]>,
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
      insertMessage(db, {
        ...common,
        id: info.id,
        type: "assistant",
        seq: ++seq,
        data: {
          agent: info.agent,
          model: { id: info.modelID, providerID: info.providerID },
          content: msg.parts.map(assistantItem).filter((item) => item !== undefined),
          time: {
            created,
            ...(info.time.completed !== undefined ? { completed: info.time.completed } : {}),
          },
        },
      });
    }
  }
}

// ── LIMIT spy ────────────────────────────────────────────────────────────────

/** Whether a statement reads `session_message` without a bound LIMIT. */
export function violatesLimitRule(sql: string): boolean {
  return /\bsession_message\b/i.test(sql) && !/\bLIMIT\s+\?\s*$/i.test(sql.trim());
}

/**
 * Wrap a connection so any `session_message` statement that does not end in
 * `LIMIT ?` with a positive integer bound throws.
 * `statements` records every statement for assertions.
 */
export function limitSpy(inner: SqliteDb): SqliteDb & { statements: string[] } {
  const statements: string[] = [];
  const check = (sql: string, params: SqlValue[] = []): void => {
    statements.push(sql);
    if (!/\bsession_message\b/i.test(sql)) return;
    if (violatesLimitRule(sql)) throw new Error(`session_message query without LIMIT ?: ${sql}`);
    const bound = params[params.length - 1];
    if (typeof bound !== "number" || !Number.isInteger(bound) || bound < 1) {
      throw new Error(`session_message LIMIT bound is not a positive integer: ${String(bound)}`);
    }
  };
  return {
    statements,
    exec: (sql) => {
      check(sql);
      inner.exec(sql);
    },
    run: (sql, params) => {
      check(sql, params);
      return inner.run(sql, params);
    },
    get: (sql, params) => {
      check(sql, params);
      return inner.get(sql, params);
    },
    all: (sql, params) => {
      check(sql, params);
      return inner.all(sql, params);
    },
    tx: (fn) => inner.tx(fn),
    close: () => inner.close(),
  };
}
