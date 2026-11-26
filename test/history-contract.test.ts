import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Part } from "@opencode-ai/sdk/v2";
import type { HistoryMessage } from "../src/history/model.js";
import { classifyAuthorship } from "../src/authorship.js";
import { MalformedSessionError, type HistorySource } from "../src/history/source.js";
import {
  checkV2Schema,
  createV2HistorySource,
  decodeV2AscendingCursor,
  decodeV2Cursor,
  encodeV2AscendingCursor,
  encodeV2Cursor,
  openOpencodeDb,
} from "../src/history/v2.js";
import {
  makeFakeHarness,
  openV1Store,
  PROJECT_DIR,
  setStrictNoLimitMessages,
  TEST_LIMITS,
} from "./helpers.js";
import { openSqlite } from "../src/sqlite.js";
import { createDistiller } from "../src/distill.js";
import { createFetchGate } from "../src/fetch-gate.js";
import {
  insertMessage,
  insertProject,
  insertSession,
  limitSpy,
  makeV2Db,
  makeV2PartsDb,
  V2_DDL,
  violatesLimitRule,
  writeV1Corpus,
  type CorpusLayout,
  type V2TestDb,
} from "./v2-db.js";

/**
 * The HistorySource contract, run against both adapters over the same data:
 * the v1 adapter over the fake SDK clients, and the v2 adapter over a temp
 * `opencode.db` holding the same fixture written as v2 rows, with assistant
 * content inline and in opencode 2.4's `session_part` rows. Every v2 read
 * goes through a spy that fails a `session_message` or `session_part`
 * statement without `LIMIT ?`.
 */

type Adapter = {
  source: HistorySource;
  /** Chronological message ids per session, as the adapter stores them. */
  ids: Record<string, string[]>;
  cleanup: () => void;
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function chronoIds(bundles: HistoryMessage[]): string[] {
  return bundles.map((b) => b.info.id);
}

async function v1Adapter(): Promise<Adapter> {
  // The v1 leg's counterpart of the v2 LIMIT spy: the fake client throws on
  // any session.messages call without a limit.
  setStrictNoLimitMessages(true);
  const h = makeFakeHarness();
  const ids = Object.fromEntries(
    Object.entries(h.messagesBySession).map(([id, bundles]) => [id, chronoIds(bundles)]),
  );
  return { source: h.source, ids, cleanup: () => setStrictNoLimitMessages(false) };
}

/** Open a written test db through the production read-only path and wrap it
 *  in the LIMIT spy. */
async function openV2(t: V2TestDb, projectID?: string) {
  const opened = await openOpencodeDb(t.path);
  if (!opened.ok) throw new Error(opened.reason);
  const spy = limitSpy(opened.db);
  const source = createV2HistorySource(spy, projectID === undefined ? {} : { projectID });
  return { source, spy, close: () => opened.db.close() };
}

async function v2Adapter(layout: CorpusLayout = "inline"): Promise<Adapter> {
  const h = makeFakeHarness();
  const t = layout === "inline" ? await makeV2Db() : await makeV2PartsDb();
  writeV1Corpus(t.db, h.globalSessions, h.messagesBySession, layout);
  const { source, close } = await openV2(t, "project-main");
  const ids = Object.fromEntries(
    Object.entries(h.messagesBySession).map(([id, bundles]) => [id, chronoIds(bundles)]),
  );
  return {
    source,
    ids,
    cleanup: () => {
      close();
      t.cleanup();
    },
  };
}

async function walk(source: HistorySource, sessionID: string, limit: number) {
  const seen: string[] = [];
  let before: string | undefined;
  let pages = 0;
  do {
    const page = await source.messagePage({ sessionID, limit, before });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    seen.push(...page.items.map((m) => m.info.id));
    before = page.nextCursor ?? undefined;
    if (before !== undefined) expect(before).toMatch(/^[\x21-\x7e]+$/);
    if (++pages > 100) throw new Error("cursor walk did not terminate");
  } while (before !== undefined);
  return { seen, pages };
}

/** Every message of a session through `messagePageAscending`, oldest first. */
async function walkOldest(source: HistorySource, sessionID: string, limit: number) {
  const items: HistoryMessage[] = [];
  let after: string | undefined;
  let pages = 0;
  do {
    const page = await source.messagePageAscending!({ sessionID, limit, after });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    items.push(...page.items);
    after = page.nextCursor ?? undefined;
    if (after !== undefined) expect(after).toMatch(/^[A-Za-z0-9_-]+$/);
    if (++pages > 100) throw new Error("oldest-first walk did not terminate");
  } while (after !== undefined);
  return { items, seen: items.map((m) => m.info.id), pages };
}

describe.each([
  ["v1 adapter (fake SDK clients)", v1Adapter],
  ["v2 adapter (opencode.db)", () => v2Adapter()],
  ["v2 adapter (opencode.db, content in session_part rows)", () => v2Adapter("parts")],
])("HistorySource contract: %s", (_name, make) => {
  async function adapter(): Promise<Adapter> {
    const a = await make();
    cleanups.push(a.cleanup);
    return a;
  }

  it("pages newest first", async () => {
    const { source, ids } = await adapter();
    const page = await source.messagePage({ sessionID: "s-current", limit: 50 });
    expect(page.items.map((m) => m.info.id)).toEqual([...ids["s-current"]!].reverse());
    expect(page.nextCursor).toBeNull();
  });

  it("a cursor walk covers every message exactly once, in order", async () => {
    const { source, ids } = await adapter();
    for (const limit of [1, 2, 4]) {
      const { seen, pages } = await walk(source, "s-current", limit);
      expect(seen).toEqual([...ids["s-current"]!].reverse());
      expect(pages).toBe(Math.ceil(ids["s-current"]!.length / limit));
    }
  });

  it("detects the end on an exact fit and an overshoot", async () => {
    const { source, ids } = await adapter();
    const count = ids["s-project-2"]!.length;
    expect((await source.messagePage({ sessionID: "s-project-2", limit: count })).nextCursor).toBe(
      null,
    );
    const short = await source.messagePage({ sessionID: "s-project-2", limit: count - 1 });
    expect(short.nextCursor).not.toBeNull();
    const rest = await source.messagePage({
      sessionID: "s-project-2",
      limit: count,
      before: short.nextCursor!,
    });
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
  });

  it("pages oldest first on v2 only, reading each message as the newest-first page does", async () => {
    const { source, ids } = await adapter();
    if (source.kind === "v1-http") {
      expect(source.messagePageAscending).toBeUndefined();
      return;
    }
    const newest = await source.messagePage({ sessionID: "s-current", limit: 50 });
    const count = ids["s-current"]!.length;
    for (const limit of [1, 2, 4, 50]) {
      const { items, pages } = await walkOldest(source, "s-current", limit);
      expect(
        items.map((m) => m.info.id),
        String(limit),
      ).toEqual(ids["s-current"]);
      expect(items, String(limit)).toEqual([...newest.items].reverse());
      expect(pages, String(limit)).toBe(Math.ceil(count / limit));
    }
  });

  it("rejects a garbled cursor instead of restarting", async () => {
    const { source } = await adapter();
    for (const before of ["!!not-a-cursor!!", "bm9wZQ", "%%%"]) {
      await expect(
        source.messagePage({ sessionID: "s-current", limit: 2, before }),
      ).rejects.toThrow();
    }
  });

  it("rejects a missing or non-positive limit before reading", async () => {
    const { source } = await adapter();
    for (const limit of [0, -1, 1.5, Number.NaN, undefined]) {
      await expect(
        source.messagePage({ sessionID: "s-current", limit: limit as number }),
      ).rejects.toThrow(/limit/);
    }
  });

  it("rejects a page of an unknown session", async () => {
    const { source } = await adapter();
    await expect(source.messagePage({ sessionID: "s-nope", limit: 5 })).rejects.toThrow();
  });

  it("answers point lookups by kind", async () => {
    const { source, ids } = await adapter();
    const found = await source.getSession("s-current", { scope: "global" });
    expect(found.ok && found.value.title).toBe("Current Debugging Session");
    const missing = await source.getSession("s-nope", { scope: "global" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("s-nope");

    const firstId = ids["s-current"]![0]!;
    const message = await source.getMessage("s-current", firstId);
    expect(message.ok && message.value.info.id).toBe(firstId);
    const noMessage = await source.getMessage("s-current", "m-nope");
    expect(noMessage.ok).toBe(false);

    expect(await source.listChildren("s-current")).toEqual({
      ok: true,
      items: [],
      truncated: false,
    });
  });

  it("lists project sessions newest first and global sessions across projects", async () => {
    const { source } = await adapter();
    const project = await source.listSessions({ scope: "project", limit: 10 });
    expect(project.ok && project.items.map((s) => s.id)).toEqual(["s-current", "s-project-2"]);
    const limited = await source.listSessions({ scope: "project", limit: 1 });
    expect(limited.ok && limited.items.map((s) => s.id)).toEqual(["s-current"]);
    const global = await source.listSessions({ scope: "global", limit: 10 });
    if (!global.ok) throw new Error(global.error);
    const ids = global.items.map((s) => s.id);
    expect(ids.indexOf("s-other")).toBeLessThan(ids.indexOf("s-current"));
    expect(global.items.find((s) => s.id === "s-other")?.project?.worktree).toBe(
      "/workspace/other",
    );
    const search = await source.listSessions({ scope: "global", limit: 10, search: "walkthrough" });
    expect(search.ok && search.items.map((s) => s.id)).toEqual(["s-other"]);
  });
});

// ── v2-only behavior ─────────────────────────────────────────────────────────

describe("v2 history source", () => {
  async function fresh(): Promise<V2TestDb> {
    const t = await makeV2Db();
    cleanups.push(t.cleanup);
    insertProject(t.db, { id: "prj", worktree: "/w/app" });
    return t;
  }

  async function open(t: V2TestDb, projectID?: string) {
    const opened = await openV2(t, projectID);
    cleanups.push(opened.close);
    return opened;
  }

  function session(
    t: V2TestDb,
    id: string,
    extra: Partial<Parameters<typeof insertSession>[1]> = {},
  ) {
    insertSession(t.db, {
      id,
      project_id: "prj",
      directory: "/w/app",
      time_created: 1_000,
      time_updated: 1_000,
      ...extra,
    });
  }

  let nextSeq = 0;
  function message(t: V2TestDb, sessionID: string, type: string, data: unknown, time = 2_000) {
    const seq = ++nextSeq;
    const id = `msg_${sessionID}_${seq}`;
    insertMessage(t.db, { id, session_id: sessionID, type, seq, time_created: time + seq, data });
    return id;
  }

  const text = (t: string) => ({ text: t, time: { created: 0 } });
  const reply = (t: string) => ({
    agent: "build",
    model: { id: "m-1", providerID: "p-1" },
    content: [{ type: "text", text: t }],
    time: { created: 0 },
  });

  it("excludes rows a fork copied from its parent (opencode stats rule)", async () => {
    const t = await fresh();
    session(t, "ses_parent");
    session(t, "ses_fork", { fork_session_id: "ses_parent", time_created: 5_000 });
    // Copied rows keep the parent's (older) time_created.
    const copied = message(t, "ses_fork", "user", text("copied prompt"), 2_000);
    message(t, "ses_fork", "assistant", reply("copied reply"), 2_000);
    const own = message(t, "ses_fork", "user", text("fork prompt"), 6_000);
    const { source } = await open(t);
    const page = await source.messagePage({ sessionID: "ses_fork", limit: 10 });
    expect(page.items.map((m) => m.info.id)).toEqual([own]);
    expect((await source.getMessage("ses_fork", copied)).ok).toBe(false);
    expect((await source.getMessage("ses_fork", own)).ok).toBe(true);
  });

  it("skips non-content and unknown types in SQL, so idle rows never end a page early", async () => {
    const t = await fresh();
    session(t, "ses_a");
    const content: string[] = [];
    for (let i = 0; i < 4; i++) {
      content.push(message(t, "ses_a", "user", text(`prompt ${i}`)));
      message(t, "ses_a", "system", { text: "tools changed", time: { created: 0 } });
      message(t, "ses_a", "compaction", {
        status: "running",
        reason: "auto",
        summary: "",
        recent: "",
      });
      message(t, "ses_a", "future-type", { anything: true });
    }
    for (let i = 0; i < 30; i++)
      message(t, "ses_a", "idle", { outcome: "succeeded", time: { created: 0 } });
    const { source } = await open(t);
    const first = await source.messagePage({ sessionID: "ses_a", limit: 2 });
    expect(first.items.map((m) => m.info.id)).toEqual([content[3], content[2]]);
    expect(first.nextCursor).not.toBeNull();
    const { seen } = await walk(source, "ses_a", 3);
    expect(seen).toEqual([...content].reverse());
  });

  it("projects unparseable rows as placeholders, or rejects them under strict", async () => {
    const t = await fresh();
    session(t, "ses_b");
    const good = message(t, "ses_b", "user", text("fine"));
    const badReply = message(t, "ses_b", "assistant", "{not json");
    const badCompaction = message(t, "ses_b", "compaction", "{also not json");
    const { source } = await open(t);
    const page = await source.messagePage({ sessionID: "ses_b", limit: 10 });
    expect(page.items.map((m) => m.info.id)).toEqual([badCompaction, badReply, good]);
    expect(page.items.map((m) => m.info.role)).toEqual(["assistant", "assistant", "user"]);
    expect(partText(page.items[1])).toBe("[unavailable: data is not valid JSON]");
    await expect(
      source.messagePage({ sessionID: "ses_b", limit: 10, strict: true }),
    ).rejects.toBeInstanceOf(MalformedSessionError);
  });

  /** A LIMIT-spied source with a small byte ceiling and a scriptable yield. */
  async function capped(t: V2TestDb, onYield?: (call: number) => void) {
    const opened = await openOpencodeDb(t.path);
    if (!opened.ok) throw new Error(opened.reason);
    cleanups.push(() => opened.db.close());
    const yields = { calls: 0 };
    const source = createV2HistorySource(limitSpy(opened.db), {
      pageByteCeiling: 1_500,
      yieldBetween: async () => {
        yields.calls++;
        onYield?.(yields.calls);
      },
    });
    return { source, yields };
  }

  const partText = (m: HistoryMessage | undefined) =>
    m?.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

  it("caps a page by summed data bytes", async () => {
    const t = await fresh();
    session(t, "ses_c");
    const ids = [
      message(t, "ses_c", "user", text("a".repeat(600))),
      message(t, "ses_c", "user", text("b".repeat(600))),
      message(t, "ses_c", "user", text("c".repeat(1_000))),
    ];
    const { source } = await capped(t);
    const first = await source.messagePage({ sessionID: "ses_c", limit: 10 });
    expect(first.items.map((m) => m.info.id)).toEqual([ids[2]]);
    const second = await source.messagePage({
      sessionID: "ses_c",
      limit: 10,
      before: first.nextCursor!,
    });
    expect(second.items.map((m) => m.info.id)).toEqual([ids[1], ids[0]]);
    expect(second.nextCursor).toBeNull();
  });

  it("measures multibyte text in encoded bytes, not characters", async () => {
    const t = await fresh();
    session(t, "ses_mb");
    // ~530 characters but ~1,030 bytes each: two fit by characters, not bytes.
    const older = message(t, "ses_mb", "user", text("é".repeat(500)));
    const newer = message(t, "ses_mb", "user", text("é".repeat(500)));
    // ~630 characters, ~1,830 bytes: over the ceiling on its own.
    const wide = message(t, "ses_mb", "user", text("€".repeat(600)));
    const { source } = await capped(t);
    const first = await source.messagePage({ sessionID: "ses_mb", limit: 10 });
    expect(first.items.map((m) => m.info.id)).toEqual([wide, newer]);
    expect(partText(first.items[0])).toMatch(
      /^\[unavailable: \d+-byte row over the 1500-byte cap\]$/,
    );
    expect(partText(first.items[1])).toBe("é".repeat(500));
    const second = await source.messagePage({
      sessionID: "ses_mb",
      limit: 10,
      before: first.nextCursor!,
    });
    expect(second.items.map((m) => m.info.id)).toEqual([older]);
  });

  it("falls back to a CAST byte count on SQLite without octet_length", async () => {
    const t = await fresh();
    session(t, "ses_old");
    const older = message(t, "ses_old", "user", text("é".repeat(500)));
    const newer = message(t, "ses_old", "user", text("é".repeat(500)));
    const opened = await openOpencodeDb(t.path);
    if (!opened.ok) throw new Error(opened.reason);
    cleanups.push(() => opened.db.close());
    const spied = limitSpy(opened.db);
    const noOctet = (sql: string): void => {
      if (/octet_length/.test(sql)) throw new Error("no such function: octet_length");
    };
    const oldSqlite: typeof spied = {
      ...spied,
      get: (sql, params) => (noOctet(sql), spied.get(sql, params)),
      all: (sql, params) => (noOctet(sql), spied.all(sql, params)),
    };
    const source = createV2HistorySource(oldSqlite, { pageByteCeiling: 1_500 });
    const first = await source.messagePage({ sessionID: "ses_old", limit: 10 });
    expect(first.items.map((m) => m.info.id)).toEqual([newer]);
    expect(spied.statements.some((sql) => sql.includes("CAST(data AS BLOB)"))).toBe(true);
    const second = await source.messagePage({
      sessionID: "ses_old",
      limit: 10,
      before: first.nextCursor!,
    });
    expect(second.items.map((m) => m.info.id)).toEqual([older]);
  });

  it("projects a row over the ceiling as a placeholder instead of loading it", async () => {
    const t = await fresh();
    session(t, "ses_big");
    const before = message(t, "ses_big", "user", text("small before"));
    const huge = message(t, "ses_big", "assistant", reply("z".repeat(5_000)));
    const after = message(t, "ses_big", "user", text("small after"));
    const { source } = await capped(t);

    // Strict (the distiller) does not reject it, and paging moves past it.
    const page = await source.messagePage({ sessionID: "ses_big", limit: 10, strict: true });
    expect(page.items.map((m) => m.info.id)).toEqual([after, huge, before]);
    expect(page.nextCursor).toBeNull();
    const placeholder = page.items[1]!;
    expect(placeholder.info.role).toBe("assistant");
    expect(partText(placeholder)).toMatch(/^\[unavailable: \d+-byte row over the 1500-byte cap\]$/);
    expect(partText(placeholder)).not.toContain("zzz");

    const lookup = await source.getMessage("ses_big", huge);
    expect(lookup.ok && partText(lookup.value)).toBe(partText(placeholder));
  });

  /** A source with a counting yield (and default ceiling) over the LIMIT spy,
   *  optionally wrapping the spy so a hook runs after each `all`. */
  async function counted(t: V2TestDb, afterAll?: (sql: string) => void) {
    const opened = await openOpencodeDb(t.path);
    if (!opened.ok) throw new Error(opened.reason);
    cleanups.push(() => opened.db.close());
    const spy = limitSpy(opened.db);
    const db: typeof spy = afterAll
      ? {
          ...spy,
          all: (sql, params) => {
            const rows = spy.all(sql, params);
            afterAll(sql);
            return rows;
          },
        }
      : spy;
    const yields = { calls: 0 };
    const source = createV2HistorySource(db, {
      yieldBetween: async () => {
        yields.calls++;
      },
    });
    return { source, spy, yields };
  }

  it("resumes from the oldest returned row when a row turns eligible mid-page", async () => {
    const t = await fresh();
    session(t, "ses_race");
    const u1 = message(t, "ses_race", "user", text("one"));
    const u2 = message(t, "ses_race", "user", text("two"));
    const pending = message(t, "ses_race", "compaction", {
      status: "running",
      reason: "auto",
      summary: "",
      recent: "",
    });
    const u3 = message(t, "ses_race", "user", text("three"));
    const u4 = message(t, "ses_race", "user", text("four"));
    let completed = false;
    // Right after the first page's size read (which skips the running
    // compaction), the compaction completes, so the body read's LIMIT drops
    // the planned oldest row (u2).
    const { source } = await counted(t, (sql) => {
      if (completed || !/AS bytes FROM session_message/.test(sql)) return;
      completed = true;
      t.db.run("UPDATE session_message SET data = ? WHERE id = ?", [
        JSON.stringify({ status: "completed", reason: "auto", summary: "done", recent: "" }),
        pending,
      ]);
    });
    const { seen } = await walk(source, "ses_race", 3);
    expect(completed).toBe(true);
    expect(seen).toEqual([u4, u3, pending, u2, u1]);
  });

  it("walks past a page of undecodable rows instead of ending early", async () => {
    const t = await fresh();
    session(t, "ses_bad");
    const good = message(t, "ses_bad", "user", text("still reachable"));
    const bad = [
      message(t, "ses_bad", "assistant", "{x"),
      message(t, "ses_bad", "assistant", "{y"),
    ];
    const { source } = await open(t);
    const first = await source.messagePage({ sessionID: "ses_bad", limit: 2 });
    expect(first.items.map((m) => m.info.id)).toEqual([bad[1], bad[0]]);
    expect(first.nextCursor).not.toBeNull();
    const { seen } = await walk(source, "ses_bad", 2);
    expect(seen).toEqual([bad[1], bad[0], good]);
  });

  it("pages a session deleted after its first read as empty, and rejects it on a fresh source", async () => {
    const t = await fresh();
    session(t, "ses_gone");
    message(t, "ses_gone", "user", text("one"));
    message(t, "ses_gone", "user", text("two"));
    const { source } = await open(t);
    const first = await source.messagePage({ sessionID: "ses_gone", limit: 1 });
    expect(first.items).toHaveLength(1);
    t.db.run("DELETE FROM session_message WHERE session_id = ?", ["ses_gone"]);
    t.db.run("DELETE FROM session_v2 WHERE id = ?", ["ses_gone"]);
    // Remembered fork binds, no rows left: an empty last page.
    expect(
      await source.messagePage({ sessionID: "ses_gone", limit: 1, before: first.nextCursor! }),
    ).toEqual({ items: [], nextCursor: null });
    // A source that never read it rejects, as before any read.
    const { source: fresher } = await open(t);
    await expect(fresher.messagePage({ sessionID: "ses_gone", limit: 1 })).rejects.toThrow(
      "Session not found: ses_gone",
    );
  });

  it("remembers fork fields per session and reads a message without yielding first", async () => {
    const t = await fresh();
    session(t, "ses_memo");
    const reply1 = message(t, "ses_memo", "assistant", reply("r1"));
    message(t, "ses_memo", "assistant", reply("r2"));
    const { source, spy, yields } = await counted(t);
    await source.messagePage({ sessionID: "ses_memo", limit: 1 });
    await source.messagePage({ sessionID: "ses_memo", limit: 1 });
    const forkReads = spy.statements.filter((sql) => /SELECT fork_session_id/.test(sql));
    expect(forkReads).toHaveLength(1);

    yields.calls = 0;
    const got = await source.getMessage("ses_memo", reply1);
    expect(got.ok).toBe(true);
    // An assistant row needs no attribution reads, so nothing yields.
    expect(yields.calls).toBe(0);
  });

  it("yields while decoding and projecting a long page", async () => {
    const t = await fresh();
    session(t, "ses_long");
    for (let i = 0; i < 60; i++) message(t, "ses_long", "assistant", reply(`r${i}`));
    const { source, yields } = await counted(t);
    const page = await source.messagePage({ sessionID: "ses_long", limit: 60 });
    expect(page.items).toHaveLength(60);
    // Two statement yields, plus two while decoding and two while projecting
    // (after rows 25 and 50 of each loop).
    expect(yields.calls).toBe(6);
  });

  it("keeps a placeholder's role and authorship for synthetic, skill and shell rows", async () => {
    const t = await fresh();
    session(t, "ses_auth");
    const big = "b".repeat(5_000);
    const synthetic = message(t, "ses_auth", "synthetic", text(big));
    const skill = message(t, "ses_auth", "skill", { skill: "sk", name: "n", text: big });
    const shell = message(t, "ses_auth", "shell", {
      command: "cat huge.log",
      status: "exited",
      exit: 0,
      output: { output: big },
    });
    const { source } = await capped(t);
    const page = await source.messagePage({ sessionID: "ses_auth", limit: 10 });
    expect(page.items.map((m) => m.info.id)).toEqual([shell, skill, synthetic]);
    const [shellPart, skillPart, syntheticPart] = page.items.map((m) => m.parts[0]!);
    const authorship = (part: Part) =>
      classifyAuthorship({
        partType: part.type,
        role: "user",
        synthetic: part.type === "text" ? part.synthetic : undefined,
        parentID: null,
      });
    expect(syntheticPart).toMatchObject({ type: "text", synthetic: true });
    expect(skillPart).toMatchObject({
      type: "tool",
      tool: "skill",
      state: { status: "completed" },
    });
    expect(shellPart).toMatchObject({
      type: "tool",
      tool: "shell",
      state: { status: "completed", input: {} },
    });
    for (const part of [syntheticPart!, skillPart!, shellPart!]) {
      expect(authorship(part)).toBe("injected");
    }
    expect(JSON.stringify(page.items)).not.toContain("bbbb");
  });

  it("lets the distiller card a session past an oversized row, indexing the placeholder", async () => {
    const t = await fresh();
    session(t, "ses_dist");
    // The first user row and the last reply are placeholders: neither may
    // become the card's summary or outcome head.
    message(t, "ses_dist", "user", text("p".repeat(5_000)));
    message(t, "ses_dist", "user", text("tiny prompt about widgets"));
    message(t, "ses_dist", "assistant", reply("real answer about gears"));
    message(t, "ses_dist", "assistant", reply("q".repeat(5_000)));
    const { source } = await capped(t);
    const dir = mkdtempSync(join(tmpdir(), "recall-v2-distill-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const storeDb = await openSqlite(join(dir, "store.db"));
    const store = storeDb && openV1Store(storeDb);
    if (!storeDb || !store) throw new Error("store open failed");
    cleanups.push(() => storeDb.close());
    const listed = await source.listSessions({ scope: "global", limit: 10 });
    const distiller = createDistiller({
      source,
      store,
      gate: createFetchGate({ concurrency: 2 }),
      limits: TEST_LIMITS,
      instanceId: "v2-oversized",
      discover: async () => (listed.ok ? listed.items : []),
    });
    distiller.start();
    const start = Date.now();
    while (distiller.status().coldPass !== "done") {
      if (Date.now() - start > 5_000) throw new Error(JSON.stringify(distiller.status()));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await distiller.stop();

    expect(distiller.status().quarantinedCount).toBe(0);
    expect(store.getCard("ses_dist")?.distillState).toBe("full");
    const hit = (term: string) => [
      ...new Set(store.ftsSearch({ strong: [term], weak: [] }).map((h) => h.sessionId)),
    ];
    expect(hit("widgets")).toEqual(["ses_dist"]);
    expect(hit("unavailable")).toEqual(["ses_dist"]);
    expect(store.getCard("ses_dist")).toMatchObject({
      summaryHead: "tiny prompt about widgets",
      outcomeHead: "real answer about gears",
    });
  });

  it("re-checks a row's size when it grows between the size read and the body read", async () => {
    const t = await fresh();
    session(t, "ses_grow");
    const growing = message(t, "ses_grow", "assistant", reply("short"));
    const { source, yields } = await capped(t, (call) => {
      // Call 1 precedes the size read, call 2 the body read.
      if (call === 2) {
        t.db.run("UPDATE session_message SET data = ? WHERE id = ?", [
          JSON.stringify(reply("y".repeat(5_000))),
          growing,
        ]);
      }
    });
    yields.calls = 0;
    const page = await source.messagePage({ sessionID: "ses_grow", limit: 10 });
    expect(page.items.map((m) => m.info.id)).toEqual([growing]);
    expect(partText(page.items[0])).toMatch(/^\[unavailable: /);
  });

  it("enforces the page budget on sizes grown after the plan", async () => {
    const t = await fresh();
    session(t, "ses_sum");
    // ~430 bytes each: all three fit the 1,500-byte plan.
    const ids = [0, 1, 2].map((i) => message(t, "ses_sum", "user", text(`${i}`.repeat(400))));
    let grown = false;
    const { source } = await capped(t, (call) => {
      // After the first page's size read, each row grows to ~1,030 bytes:
      // still under the ceiling alone, but any two together pass it.
      if (call !== 2 || grown) return;
      grown = true;
      for (const [i, id] of ids.entries()) {
        t.db.run("UPDATE session_message SET data = ? WHERE id = ?", [
          JSON.stringify(text(`${i}`.repeat(1_000))),
          id,
        ]);
      }
    });
    const first = await source.messagePage({ sessionID: "ses_sum", limit: 10 });
    expect(grown).toBe(true);
    expect(first.items.map((m) => m.info.id)).toEqual([ids[2]]);
    expect(partText(first.items[0])).toBe("2".repeat(1_000));
    expect(first.nextCursor).not.toBeNull();
    const { seen } = await walk(source, "ses_sum", 10);
    expect(seen).toEqual([...ids].reverse());
  });

  /** A session with non-default fallbacks, one user row, then one assistant
   *  row with its own identity whose reply is `replyText`. */
  async function attributed(replyText: string) {
    const t = await fresh();
    session(t, "ses_id", {
      agent: "sess-agent",
      model: JSON.stringify({ id: "sess-model", providerID: "sp" }),
    });
    const user = message(t, "ses_id", "user", text("question"));
    const assistant = message(t, "ses_id", "assistant", {
      ...reply(replyText),
      agent: "review",
      model: { id: "m-own", providerID: "po", variant: "high" },
    });
    const { source } = await capped(t);
    return { source, user, assistant };
  }

  it("attributes a user row from the next assistant when it is under the ceiling", async () => {
    const { source, user, assistant } = await attributed("short answer");
    const page = await source.messagePage({ sessionID: "ses_id", limit: 10 });
    expect(page.items.map((m) => m.info.id)).toEqual([assistant, user]);
    const own = { agent: "review", model: { modelID: "m-own", providerID: "po", variant: "high" } };
    expect(page.items[1]!.info).toMatchObject(own);
    // getMessage reads no assistant on its page, so it takes the lookup path.
    const point = await source.getMessage("ses_id", user);
    expect(point.ok && point.value.info).toMatchObject(own);
  });

  it("falls back to the session for an oversized assistant, on pages and in point reads", async () => {
    // Its identity would need SQLite to parse the whole row; neither path reads it.
    const { source, user, assistant } = await attributed("w".repeat(5_000));
    const page = await source.messagePage({ sessionID: "ses_id", limit: 10 });
    expect(page.items.map((m) => m.info.id)).toEqual([assistant, user]);
    const fallback = { agent: "sess-agent", model: { modelID: "sess-model", providerID: "sp" } };
    expect(page.items[1]!.info).toMatchObject(fallback);
    expect(page.items[0]!.info).toMatchObject({
      agent: "sess-agent",
      modelID: "sess-model",
      providerID: "sp",
    });
    expect(partText(page.items[0])).toMatch(/^\[unavailable: /);

    const point = await source.getMessage("ses_id", user);
    expect(point.ok && point.value.info).toMatchObject(fallback);
    const bigPoint = await source.getMessage("ses_id", assistant);
    expect(bigPoint.ok && bigPoint.value.info).toMatchObject({
      agent: "sess-agent",
      modelID: "sess-model",
    });
  });

  it("treats oversized non-content rows as absent in point reads, like pages", async () => {
    const t = await fresh();
    session(t, "ses_nc");
    const kept = message(t, "ses_nc", "user", text("visible"));
    const hidden = [
      message(t, "ses_nc", "system", { text: "s".repeat(5_000), time: { created: 0 } }),
      message(t, "ses_nc", "idle", { outcome: "x".repeat(5_000), time: { created: 0 } }),
      message(t, "ses_nc", "compaction", {
        status: "running",
        reason: "auto",
        summary: "c".repeat(5_000),
        recent: "",
      }),
    ];
    const { source } = await capped(t);
    const { seen } = await walk(source, "ses_nc", 10);
    expect(seen).toEqual([kept]);
    for (const id of hidden) {
      expect(await source.getMessage("ses_nc", id), id).toEqual({
        ok: false,
        reason: "not-found",
        error: `Message not found: ${id}`,
      });
    }
  });

  it("orders sessions by max(time_updated, time_idle) with NULL idle, id breaking ties", async () => {
    const t = await fresh();
    session(t, "ses_a", { time_updated: 100, time_idle: null });
    session(t, "ses_b", { time_updated: 50, time_idle: 200 });
    session(t, "ses_c", { time_updated: 150, time_idle: 120 });
    session(t, "ses_d", { time_updated: 100, time_idle: null });
    const { source } = await open(t, "prj");
    const listed = await source.listSessions({ scope: "project", limit: 10 });
    expect(listed.ok && listed.items.map((s) => [s.id, s.time.updated])).toEqual([
      ["ses_b", 200],
      ["ses_c", 150],
      ["ses_d", 100],
      ["ses_a", 100],
    ]);
    // LIMIT applies after the normalized order.
    const top = await source.listSessions({ scope: "project", limit: 1 });
    expect(top.ok && top.items.map((s) => s.id)).toEqual(["ses_b"]);
  });

  it("filters project scope by project id and hides archived sessions globally", async () => {
    const t = await fresh();
    insertProject(t.db, { id: "prj2", worktree: "/w/other", name: "Other" });
    session(t, "ses_here");
    session(t, "ses_archived", { time_archived: 9 });
    insertSession(t.db, {
      id: "ses_there",
      project_id: "prj2",
      directory: "/w/other",
      time_created: 1,
      time_updated: 2,
    });
    const { source } = await open(t, "prj");
    const project = await source.listSessions({ scope: "project", limit: 10 });
    expect(project.ok && project.items.map((s) => s.id).sort()).toEqual([
      "ses_archived",
      "ses_here",
    ]);
    const global = await source.listSessions({ scope: "global", limit: 10 });
    expect(global.ok && global.items.map((s) => s.id).sort()).toEqual(["ses_here", "ses_there"]);
    expect(global.ok && global.items.find((s) => s.id === "ses_there")?.project?.name).toBe(
      "Other",
    );
  });

  it("matches title search literally, escaping LIKE wildcards", async () => {
    const t = await fresh();
    session(t, "ses_1", { title: "100% done" });
    session(t, "ses_2", { title: "100 percent" });
    session(t, "ses_3", { title: "a_b" });
    session(t, "ses_4", { title: "axb" });
    session(t, "ses_5", { title: "back\\slash" });
    const { source } = await open(t);
    const ids = async (search: string) => {
      const out = await source.listSessions({ scope: "global", limit: 10, search });
      return out.ok ? out.items.map((s) => s.id) : [];
    };
    expect(await ids("100%")).toEqual(["ses_1"]);
    expect(await ids("a_b")).toEqual(["ses_3"]);
    expect(await ids("k\\s")).toEqual(["ses_5"]);
    expect((await ids("DONE")).length).toBe(1);
  });

  it("rejects a missing or non-positive listing limit before reading", async () => {
    const t = await fresh();
    session(t, "ses_l");
    const { source, spy } = await open(t, "prj");
    const before = spy.statements.length;
    for (const scope of ["project", "global"] as const) {
      for (const limit of [0, -1, 1.5, Number.NaN, undefined]) {
        await expect(
          source.listSessions({ scope, limit: limit as number }),
          `${scope} ${String(limit)}`,
        ).rejects.toThrow(/session list limit must be a positive integer/);
      }
    }
    expect(spy.statements.length).toBe(before);
  });

  it("a facade without a project id rejects project scope but serves the rest", async () => {
    const t = await fresh();
    session(t, "ses_g");
    const { source } = await open(t);
    await expect(source.listSessions({ scope: "project", limit: 5 })).rejects.toThrow(
      /scope "project" is unavailable/,
    );
    expect((await source.listSessions({ scope: "global", limit: 5 })).ok).toBe(true);
    // Lookups do not depend on scope (scopedLookup is false).
    expect(source.scopedLookup).toBe(false);
    expect((await source.getSession("ses_g", { scope: "project" })).ok).toBe(true);
  });

  it("lists children by parent id and reports unknown lookups as not-found", async () => {
    const t = await fresh();
    session(t, "ses_root");
    session(t, "ses_kid", { parent_id: "ses_root", time_updated: 3_000 });
    const { source } = await open(t);
    const kids = await source.listChildren("ses_root");
    expect(kids.ok && kids.items.map((s) => [s.id, s.parentID])).toEqual([["ses_kid", "ses_root"]]);
    expect(await source.getSession("ses_x", { scope: "global" })).toEqual({
      ok: false,
      reason: "not-found",
      error: "Session not found: ses_x",
    });
    expect(await source.getMessage("ses_x", "msg_1")).toEqual({
      ok: false,
      reason: "not-found",
      error: "Session not found: ses_x",
    });
    const idle = message(t, "ses_root", "idle", { outcome: "succeeded", time: { created: 0 } });
    expect(await source.getMessage("ses_root", idle)).toEqual({
      ok: false,
      reason: "not-found",
      error: `Message not found: ${idle}`,
    });
    // An undecodable row reads as its placeholder, the same as on a page.
    const bad = message(t, "ses_root", "user", "{bad");
    const lookup = await source.getMessage("ses_root", bad);
    expect(lookup.ok && partText(lookup.value)).toMatch(/not valid JSON/);
  });

  it("attributes user rows: switch, else next assistant (even on a newer page), else session", async () => {
    const t = await fresh();
    session(t, "ses_u", {
      agent: "sess-agent",
      model: JSON.stringify({ id: "sess-model", providerID: "sp" }),
    });
    const lone = message(t, "ses_u", "user", text("before any reply"));
    message(t, "ses_u", "agent-switched", { agent: "review", time: { created: 0 } });
    const switched = message(t, "ses_u", "user", text("after switch"));
    message(t, "ses_u", "assistant", {
      ...reply("r"),
      agent: "build",
      model: { id: "m-next", providerID: "pn" },
    });
    const { source } = await open(t);
    // limit 1 from the switched user row: its assistant lives on a newer page.
    const newest = await source.messagePage({ sessionID: "ses_u", limit: 1 });
    const page = await source.messagePage({
      sessionID: "ses_u",
      limit: 1,
      before: newest.nextCursor!,
    });
    expect(page.items[0]!.info).toMatchObject({
      id: switched,
      agent: "review",
      model: { modelID: "m-next", providerID: "pn" },
    });
    const first = await source.getMessage("ses_u", lone);
    expect(first.ok && first.value.info).toMatchObject({
      agent: "build",
      model: { modelID: "m-next" },
    });
    // No assistant after and no switch before: the session's own values.
    const t2 = await fresh();
    insertSession(t2.db, {
      id: "ses_v",
      project_id: "prj",
      directory: "/w",
      time_created: 1,
      time_updated: 1,
      agent: "sess-agent",
      model: JSON.stringify({ id: "sess-model", providerID: "sp" }),
    });
    const only = message(t2, "ses_v", "user", text("alone"));
    const { source: s2 } = await open(t2);
    const alone = await s2.getMessage("ses_v", only);
    expect(alone.ok && alone.value.info).toMatchObject({
      agent: "sess-agent",
      model: { modelID: "sess-model", providerID: "sp" },
    });
  });

  it("attributes each user from its own predecessor switches, whatever the page holds", async () => {
    const t = await fresh();
    session(t, "ses_w", { agent: "sess-agent" });
    const model = (id: string) => ({ model: { id, providerID: "p" }, time: { created: 0 } });
    message(t, "ses_w", "agent-switched", { agent: "alpha", time: { created: 0 } });
    // A run of model switches longer than one range read, before U1: the
    // agent switch must not be crowded out by another type.
    for (let i = 0; i < 70; i++) message(t, "ses_w", "model-switched", model(`m${i}`));
    const u1 = message(t, "ses_w", "user", text("first prompt"));
    // More than 64 agent switches between the two users on one page.
    for (let i = 0; i < 70; i++) {
      message(t, "ses_w", "agent-switched", { agent: `beta${i}`, time: { created: 0 } });
      // One model switch in the range: read by the (untruncated) range query.
      if (i === 35) message(t, "ses_w", "model-switched", model("m-mid"));
    }
    const u2 = message(t, "ses_w", "user", text("second prompt"));
    const { source } = await open(t);

    const page = await source.messagePage({ sessionID: "ses_w", limit: 10 });
    expect(page.items.map((m) => m.info.id)).toEqual([u2, u1]);
    const [second, first] = page.items;
    expect(first!.info).toMatchObject({ agent: "alpha", model: { modelID: "m69" } });
    expect(second!.info).toMatchObject({ agent: "beta69", model: { modelID: "m-mid" } });

    const alone = await source.getMessage("ses_w", u1);
    expect(alone.ok && alone.value.info).toMatchObject({
      agent: "alpha",
      model: { modelID: "m69" },
    });
    const both = await source.getMessage("ses_w", u2);
    expect(both.ok && both.value.info).toMatchObject({
      agent: "beta69",
      model: { modelID: "m-mid" },
    });
  });

  it("skips a switch row whose data is not a JSON object", async () => {
    const t = await fresh();
    session(t, "ses_sw", { agent: "sess-agent" });
    message(t, "ses_sw", "agent-switched", { agent: "alpha", time: { created: 0 } });
    // Valid JSON, but not an object: it must not hide the switch before it.
    message(t, "ses_sw", "agent-switched", "[1, 2]");
    const u = message(t, "ses_sw", "user", text("prompt"));
    const { source } = await open(t);
    const page = await source.messagePage({ sessionID: "ses_sw", limit: 5 });
    expect(page.items[0]?.info).toMatchObject({ id: u, agent: "alpha" });
    const point = await source.getMessage("ses_sw", u);
    expect(point.ok && point.value.info).toMatchObject({ agent: "alpha" });
  });

  it("retries below a planned range that became ineligible between the two reads", async () => {
    const t = await fresh();
    session(t, "ses_retry");
    const older = message(t, "ses_retry", "user", text("older prompt"));
    const done = { status: "completed", reason: "auto", summary: "s", recent: "" };
    const c1 = message(t, "ses_retry", "compaction", done);
    const c2 = message(t, "ses_retry", "compaction", done);
    let flipped = false;
    // After the first size read plans [c2, c1], both compactions become
    // running again, so the body read finds nothing in the planned range.
    const { source } = await counted(t, (sql) => {
      if (flipped || !/AS bytes FROM session_message/.test(sql)) return;
      flipped = true;
      for (const id of [c1, c2]) {
        t.db.run("UPDATE session_message SET data = ? WHERE id = ?", [
          JSON.stringify({ ...done, status: "running" }),
          id,
        ]);
      }
    });
    const page = await source.messagePage({ sessionID: "ses_retry", limit: 2 });
    expect(flipped).toBe(true);
    expect(page.items.map((m) => m.info.id)).toEqual([older]);
    expect(page.nextCursor).toBeNull();
  });

  describe("oldest first", () => {
    it("skips non-content rows and ends on the last content row", async () => {
      const t = await fresh();
      session(t, "ses_asc");
      const content: string[] = [];
      for (let i = 0; i < 5; i++) {
        message(t, "ses_asc", "system", { text: "tools changed", time: { created: 0 } });
        content.push(
          i % 2 === 0
            ? message(t, "ses_asc", "user", text(`prompt ${i}`))
            : message(t, "ses_asc", "assistant", reply(`reply ${i}`)),
        );
        message(t, "ses_asc", "compaction", { status: "running", reason: "auto", summary: "" });
      }
      for (let i = 0; i < 10; i++) {
        message(t, "ses_asc", "idle", { outcome: "succeeded", time: { created: 0 } });
      }
      const { source } = await open(t);
      for (const limit of [1, 2, 5]) {
        const { seen, pages } = await walkOldest(source, "ses_asc", limit);
        expect(seen, String(limit)).toEqual(content);
        expect(pages, String(limit)).toBe(Math.ceil(content.length / limit));
      }
    });

    it("pages an empty session as one empty page, and rejects a bad limit or an unknown session", async () => {
      const t = await fresh();
      session(t, "ses_none");
      const { source } = await open(t);
      expect(await source.messagePageAscending!({ sessionID: "ses_none", limit: 5 })).toEqual({
        items: [],
        nextCursor: null,
      });
      for (const limit of [0, -1, 1.5, Number.NaN, undefined]) {
        await expect(
          source.messagePageAscending!({ sessionID: "ses_none", limit: limit as number }),
        ).rejects.toThrow(/limit/);
      }
      await expect(source.messagePageAscending!({ sessionID: "s-nope", limit: 5 })).rejects.toThrow(
        "Session not found: s-nope",
      );
    });

    it("refuses a newest-first cursor, and messagePage refuses an oldest-first one", async () => {
      const t = await fresh();
      session(t, "ses_cur");
      const ids = [0, 1, 2].map((i) => message(t, "ses_cur", "user", text(`${i}`)));
      const { source } = await open(t);
      const newest = await source.messagePage({ sessionID: "ses_cur", limit: 1 });
      const oldest = await source.messagePageAscending!({ sessionID: "ses_cur", limit: 1 });
      expect(newest.items.map((m) => m.info.id)).toEqual([ids[2]]);
      expect(oldest.items.map((m) => m.info.id)).toEqual([ids[0]]);
      await expect(
        source.messagePageAscending!({ sessionID: "ses_cur", limit: 1, after: newest.nextCursor! }),
      ).rejects.toThrow(/Invalid message cursor/);
      await expect(
        source.messagePage({ sessionID: "ses_cur", limit: 1, before: oldest.nextCursor! }),
      ).rejects.toThrow(/Invalid message cursor/);
      for (const after of ["!!not-a-cursor!!", "bm9wZQ", "%%%"]) {
        await expect(
          source.messagePageAscending!({ sessionID: "ses_cur", limit: 1, after }),
        ).rejects.toThrow(/Invalid message cursor/);
      }
    });

    it("excludes rows a fork copied from its parent", async () => {
      const t = await fresh();
      session(t, "ses_parent");
      session(t, "ses_fork", { fork_session_id: "ses_parent", time_created: 5_000 });
      message(t, "ses_fork", "user", text("copied prompt"), 2_000);
      message(t, "ses_fork", "assistant", reply("copied reply"), 2_000);
      const own = [
        message(t, "ses_fork", "user", text("fork prompt"), 6_000),
        message(t, "ses_fork", "assistant", reply("fork reply"), 6_000),
      ];
      const { source } = await open(t);
      expect((await walkOldest(source, "ses_fork", 1)).seen).toEqual(own);
    });

    it("resumes from the newest returned row when a row turns eligible mid-page", async () => {
      const t = await fresh();
      session(t, "ses_race_asc");
      const u1 = message(t, "ses_race_asc", "user", text("one"));
      const u2 = message(t, "ses_race_asc", "user", text("two"));
      const pending = message(t, "ses_race_asc", "compaction", {
        status: "running",
        reason: "auto",
        summary: "",
        recent: "",
      });
      const u3 = message(t, "ses_race_asc", "user", text("three"));
      const u4 = message(t, "ses_race_asc", "user", text("four"));
      let completed = false;
      // The first size read plans every content row as one last page; then
      // the compaction completes, so the body read's LIMIT stops a row short
      // of the planned newest row (u4), which must lead a further page.
      const { source } = await counted(t, (sql) => {
        if (completed || !/AS bytes FROM session_message/.test(sql)) return;
        completed = true;
        t.db.run("UPDATE session_message SET data = ? WHERE id = ?", [
          JSON.stringify({ status: "completed", reason: "auto", summary: "done", recent: "" }),
          pending,
        ]);
      });
      const { seen, pages } = await walkOldest(source, "ses_race_asc", 4);
      expect(completed).toBe(true);
      expect(seen).toEqual([u1, u2, pending, u3, u4]);
      expect(pages).toBe(2);
    });

    it("continues past a planned range that became ineligible between the two reads", async () => {
      const t = await fresh();
      session(t, "ses_retry_asc");
      const done = { status: "completed", reason: "auto", summary: "s", recent: "" };
      const c1 = message(t, "ses_retry_asc", "compaction", done);
      const c2 = message(t, "ses_retry_asc", "compaction", done);
      const newer = message(t, "ses_retry_asc", "user", text("newer prompt"));
      let flipped = false;
      // After the first size read plans [c1, c2], both compactions become
      // running again, so the body read finds nothing in the planned range.
      const { source } = await counted(t, (sql) => {
        if (flipped || !/AS bytes FROM session_message/.test(sql)) return;
        flipped = true;
        for (const id of [c1, c2]) {
          t.db.run("UPDATE session_message SET data = ? WHERE id = ?", [
            JSON.stringify({ ...done, status: "running" }),
            id,
          ]);
        }
      });
      const page = await source.messagePageAscending!({ sessionID: "ses_retry_asc", limit: 2 });
      expect(flipped).toBe(true);
      expect(page.items.map((m) => m.info.id)).toEqual([newer]);
      expect(page.nextCursor).toBeNull();
    });

    it("caps a page by summed data bytes, a row over the ceiling costing it nothing", async () => {
      const t = await fresh();
      session(t, "ses_cap_asc");
      const ids = [
        message(t, "ses_cap_asc", "user", text("a".repeat(600))),
        message(t, "ses_cap_asc", "user", text("b".repeat(600))),
        message(t, "ses_cap_asc", "user", text("c".repeat(1_000))),
        message(t, "ses_cap_asc", "assistant", reply("z".repeat(5_000))),
        message(t, "ses_cap_asc", "user", text("d".repeat(300))),
      ];
      const { source } = await capped(t);
      const first = await source.messagePageAscending!({ sessionID: "ses_cap_asc", limit: 10 });
      expect(first.items.map((m) => m.info.id)).toEqual([ids[0], ids[1]]);
      const second = await source.messagePageAscending!({
        sessionID: "ses_cap_asc",
        limit: 10,
        after: first.nextCursor!,
      });
      expect(second.items.map((m) => m.info.id)).toEqual([ids[2], ids[3], ids[4]]);
      expect(second.nextCursor).toBeNull();
      expect(partText(second.items[1])).toMatch(
        /^\[unavailable: \d+-byte row over the 1500-byte cap\]$/,
      );
    });
  });

  it("round-trips its opaque cursor and rejects foreign ones", () => {
    expect(decodeV2Cursor(encodeV2Cursor(42))).toBe(42);
    // The encoder and decoder agree on the full safe-integer range.
    expect(decodeV2Cursor(encodeV2Cursor(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => encodeV2Cursor(bad), String(bad)).toThrow(/non-negative safe integer/);
    }
    // 16 digits but past MAX_SAFE_INTEGER: well-formed, still rejected.
    const unsafe = btoa("v2:9999999999999999")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(unsafe).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(() => decodeV2Cursor(unsafe)).toThrow(/Invalid message cursor/);
    expect(encodeV2Cursor(7)).toMatch(/^[A-Za-z0-9_-]+$/);
    for (const bad of ["", "MTI", "djI6", "djI6LTE", "djI6eA", "a b"]) {
      expect(() => decodeV2Cursor(bad), bad).toThrow(/Invalid message cursor/);
    }
  });

  it("round-trips its oldest-first cursor and keeps it apart from the newest-first one", () => {
    for (const seq of [0, 42, Number.MAX_SAFE_INTEGER]) {
      expect(decodeV2AscendingCursor(encodeV2AscendingCursor(seq))).toBe(seq);
      expect(() => decodeV2Cursor(encodeV2AscendingCursor(seq)), String(seq)).toThrow(
        /Invalid message cursor/,
      );
      expect(() => decodeV2AscendingCursor(encodeV2Cursor(seq)), String(seq)).toThrow(
        /Invalid message cursor/,
      );
    }
    expect(encodeV2AscendingCursor(7)).toMatch(/^[A-Za-z0-9_-]+$/);
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => encodeV2AscendingCursor(bad), String(bad)).toThrow(/non-negative safe integer/);
    }
    const raw = (text: string) =>
      btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const bad of [raw("v2a:"), raw("v2a:-1"), raw("v2a:x"), raw("v2a:9999999999999999")]) {
      expect(() => decodeV2AscendingCursor(bad), bad).toThrow(/Invalid message cursor/);
    }
  });

  it("binds LIMIT on every session_message statement it runs", async () => {
    const h = makeFakeHarness();
    const t = await makeV2Db();
    cleanups.push(t.cleanup);
    writeV1Corpus(t.db, h.globalSessions, h.messagesBySession);
    const { source, spy } = await open(t, "project-main");
    await walk(source, "s-current", 2);
    await walkOldest(source, "s-current", 2);
    await source.getMessage("s-current", "m-current-1");
    await source.listSessions({ scope: "project", limit: 5 });
    await source.listChildren("s-current");
    const reads = spy.statements.filter((sql) => /session_message/.test(sql));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((sql) => !violatesLimitRule(sql))).toBe(true);
    // Guard the guard: an unbounded read fails.
    expect(() => spy.all("SELECT * FROM session_message WHERE session_id = ?", ["x"])).toThrow(
      /without LIMIT/,
    );
    expect(() =>
      spy.all("SELECT * FROM session_message WHERE session_id = ? LIMIT ?", ["x", 0]),
    ).toThrow(/positive integer/);
  });

  it("projects the harness fixture into the read model the core expects", async () => {
    const h = makeFakeHarness();
    const t = await makeV2Db();
    cleanups.push(t.cleanup);
    writeV1Corpus(t.db, h.globalSessions, h.messagesBySession);
    const { source } = await open(t, "project-main");
    const page = await source.messagePage({ sessionID: "s-current", limit: 50 });
    const byId = new Map(page.items.map((m) => [m.info.id, m]));
    // The compacted bash output became the cleared marker and projects pruned.
    const compacted = byId.get("m-current-3")!.parts[0]!;
    expect(compacted).toMatchObject({ type: "tool", state: { status: "completed", output: "" } });
    expect(byId.get("m-current-1")!.info).toMatchObject({ role: "user", seq: 1 });
    const found = await source.getSession("s-current", { scope: "project" });
    expect(found.ok && found.value.directory).toBe(PROJECT_DIR);
  });
});

// ── Unavailable sources ──────────────────────────────────────────────────────

describe("openOpencodeDb: unavailable sources", () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-v2-unavail-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reports a missing file", async () => {
    const out = await openOpencodeDb(join(dir, "absent.db"));
    expect(out.ok).toBe(false);
  });

  it("rejects :memory: by name", async () => {
    const out = await openOpencodeDb(":memory:");
    expect(out).toEqual({ ok: false, reason: expect.stringContaining(":memory:") });
  });

  it("reports a garbage file", async () => {
    const path = join(dir, "garbage.db");
    writeFileSync(path, "definitely not sqlite ".repeat(300));
    expect((await openOpencodeDb(path)).ok).toBe(false);
  });

  it("reports a missing column by name", async () => {
    const t = await makeV2Db(V2_DDL.replace(", `time_idle` integer", ""));
    cleanups.push(t.cleanup);
    const out = await openOpencodeDb(t.path);
    expect(out).toEqual({ ok: false, reason: "opencode.db schema lacks session_v2.time_idle" });
  });

  it("reports a database without the tables", async () => {
    const t = await makeV2Db(
      "CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);",
    );
    cleanups.push(t.cleanup);
    const out = await openOpencodeDb(t.path);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("session_message.seq");
  });

  it("records the newest migration id without judging it", async () => {
    const t = await makeV2Db();
    cleanups.push(t.cleanup);
    t.db.run("INSERT INTO migration (id, time_completed) VALUES (?, 1)", ["29990101000000_future"]);
    const out = await openOpencodeDb(t.path);
    if (!out.ok) throw new Error(out.reason);
    cleanups.push(() => out.db.close());
    expect(out.migration).toBe("29990101000000_future");
    expect(checkV2Schema(out.db)).toEqual({
      ok: true,
      migration: "29990101000000_future",
      migrationTested: false,
      parts: false,
      missingOptional: [],
      unknownTables: [],
    });
  });
});
