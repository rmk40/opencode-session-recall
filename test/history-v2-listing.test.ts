import { afterEach, describe, expect, it } from "vitest";
import type { HistorySession } from "../src/history/model.js";
import type { Listing } from "../src/history/source.js";
import { createV2HistorySource, openOpencodeDb } from "../src/history/v2.js";
import {
  insertProject,
  insertSession,
  limitSpy,
  makeV2PartsDb,
  type SessionInsert,
  type V2TestDb,
} from "./v2-db.js";

/**
 * v2 session listings: recency and id order, keyset paging by id with
 * `after`, `truncated` from one row past the limit, and the archived filter,
 * for both `listSessions` and `listChildren`. Every source reads through the
 * LIMIT spy.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

async function fresh(): Promise<V2TestDb> {
  const t = await makeV2PartsDb();
  cleanups.push(t.cleanup);
  insertProject(t.db, { id: "prj", worktree: "/w/app" });
  insertProject(t.db, { id: "prj2", worktree: "/w/other" });
  return t;
}

function session(t: V2TestDb, id: string, extra: Partial<SessionInsert> = {}): void {
  insertSession(t.db, {
    id,
    project_id: "prj",
    directory: "/w/app",
    time_created: 1_000,
    time_updated: 1_000,
    ...extra,
  });
}

async function open(t: V2TestDb) {
  const opened = await openOpencodeDb(t.path);
  if (!opened.ok) throw new Error(opened.reason);
  cleanups.push(() => opened.db.close());
  const spy = limitSpy(opened.db);
  return { source: createV2HistorySource(spy, { projectID: "prj" }), spy };
}

function ids(listing: Listing<HistorySession>): string[] {
  if (!listing.ok) throw new Error(listing.error);
  return listing.items.map((s) => s.id);
}

/** The listing's paging fields. */
function paging(listing: Listing<HistorySession>) {
  if (!listing.ok) throw new Error(listing.error);
  return { truncated: listing.truncated, nextCursor: listing.nextCursor };
}

describe("v2 session listings", () => {
  it("lists in id order, resumes after a cursor and reports truncated from one extra row", async () => {
    const t = await fresh();
    // Recency rises with the id, so recency order is the reverse of id order.
    ["ses_a", "ses_b", "ses_c", "ses_d", "ses_e"].forEach((id, i) =>
      session(t, id, { time_updated: 1_000 + i * 1_000 }),
    );
    const { source } = await open(t);

    const first = await source.listSessions({ scope: "global", limit: 2, order: "id" });
    expect(ids(first)).toEqual(["ses_a", "ses_b"]);
    expect(paging(first)).toEqual({ truncated: true, nextCursor: "ses_b" });
    const second = await source.listSessions({
      scope: "project",
      limit: 2,
      order: "id",
      after: "ses_b",
    });
    expect(ids(second)).toEqual(["ses_c", "ses_d"]);
    expect(paging(second)).toEqual({ truncated: true, nextCursor: "ses_d" });
    const last = await source.listSessions({
      scope: "global",
      limit: 2,
      order: "id",
      after: "ses_d",
    });
    expect(ids(last)).toEqual(["ses_e"]);
    expect(last).toMatchObject({ truncated: false });
    expect(last).not.toHaveProperty("nextCursor");

    // An exact fit is not truncated.
    const exact = await source.listSessions({ scope: "global", limit: 5, order: "id" });
    expect(paging(exact)).toEqual({ truncated: false, nextCursor: undefined });
    expect(exact).not.toHaveProperty("nextCursor");

    // Recency order (the default) reports truncated without a cursor.
    const recent = await source.listSessions({ scope: "global", limit: 2 });
    expect(ids(recent)).toEqual(["ses_e", "ses_d"]);
    expect(recent).toMatchObject({ truncated: true });
    expect(recent).not.toHaveProperty("nextCursor");
    const all = await source.listSessions({ scope: "global", limit: 5 });
    expect(paging(all)).toEqual({ truncated: false, nextCursor: undefined });
  });

  it("filters an id walk by title search", async () => {
    const t = await fresh();
    session(t, "ses_1", { title: "alpha one" });
    session(t, "ses_2", { title: "beta" });
    session(t, "ses_3", { title: "alpha two" });
    const { source } = await open(t);
    const first = await source.listSessions({
      scope: "global",
      limit: 1,
      order: "id",
      search: "alpha",
    });
    expect(ids(first)).toEqual(["ses_1"]);
    expect(paging(first)).toEqual({ truncated: true, nextCursor: "ses_1" });
    const rest = await source.listSessions({
      scope: "global",
      limit: 1,
      order: "id",
      search: "alpha",
      after: "ses_1",
    });
    expect(ids(rest)).toEqual(["ses_3"]);
    expect(paging(rest)).toEqual({ truncated: false, nextCursor: undefined });
  });

  it("never skips or repeats a session updated during an id walk", async () => {
    const t = await fresh();
    const all = ["ses_a", "ses_b", "ses_c", "ses_d", "ses_e"];
    all.forEach((id, i) => session(t, id, { time_updated: 1_000 + i }));
    const { source } = await open(t);
    const seen: string[] = [];
    let after: string | undefined;
    let page = 0;
    do {
      const listing = await source.listSessions({ scope: "global", limit: 2, order: "id", after });
      seen.push(...ids(listing));
      after = listing.ok ? listing.nextCursor : undefined;
      if (page++ === 0) {
        // One listed and one not yet listed session become the most recent.
        for (const id of ["ses_a", "ses_e"]) {
          t.db.run("UPDATE session_v2 SET time_updated = ? WHERE id = ?", [99_999, id]);
        }
      }
    } while (after !== undefined);
    expect(seen).toEqual(all);
  });

  it("rejects a cursor without id order, or one that is not a string, before reading", async () => {
    const t = await fresh();
    session(t, "ses_a");
    const { source, spy } = await open(t);
    const before = spy.statements.length;
    const rejected = [
      await source.listSessions({ scope: "global", limit: 2, after: "ses_a" }),
      await source.listSessions({ scope: "global", limit: 2, order: "recent", after: "ses_a" }),
      await source.listSessions({
        scope: "global",
        limit: 2,
        order: "id",
        after: 5 as unknown as string,
      }),
      await source.listChildren("ses_a", { after: "ses_a" }),
    ];
    for (const listing of rejected) expect(listing).toMatchObject({ ok: false });
    expect(rejected.map((l) => (l.ok ? "" : l.error))).toEqual([
      expect.stringMatching(/order "id"/),
      expect.stringMatching(/order "id"/),
      expect.stringMatching(/string/),
      expect.stringMatching(/order "id"/),
    ]);
    expect(spy.statements.length).toBe(before);
  });

  it("hides archived sessions globally and keeps them in project listings by default, either way on request", async () => {
    const t = await fresh();
    session(t, "ses_live");
    session(t, "ses_arch", { time_archived: 5 });
    session(t, "ses_far", { project_id: "prj2", directory: "/w/other", time_archived: 6 });
    const { source } = await open(t);
    const list = async (scope: "global" | "project", archived?: "include" | "exclude") =>
      ids(
        await source.listSessions({
          scope,
          limit: 10,
          order: "id",
          ...(archived ? { archived } : {}),
        }),
      );
    expect(await list("global")).toEqual(["ses_live"]);
    expect(await list("global", "include")).toEqual(["ses_arch", "ses_far", "ses_live"]);
    expect(await list("global", "exclude")).toEqual(["ses_live"]);
    expect(await list("project")).toEqual(["ses_arch", "ses_live"]);
    expect(await list("project", "include")).toEqual(["ses_arch", "ses_live"]);
    expect(await list("project", "exclude")).toEqual(["ses_live"]);
  });

  it("lists children with archived ones by default, in recency or id order", async () => {
    const t = await fresh();
    session(t, "ses_root");
    session(t, "ses_k1", { parent_id: "ses_root", time_updated: 2_000, time_archived: 7 });
    session(t, "ses_k2", { parent_id: "ses_root", time_updated: 1_500 });
    session(t, "ses_k3", { parent_id: "ses_root", time_updated: 3_000 });
    session(t, "ses_other", { time_updated: 9_000 });
    const { source } = await open(t);

    const recent = await source.listChildren("ses_root");
    expect(ids(recent)).toEqual(["ses_k3", "ses_k1", "ses_k2"]);
    expect(paging(recent)).toEqual({ truncated: false, nextCursor: undefined });
    expect(ids(await source.listChildren("ses_root", { archived: "exclude" }))).toEqual([
      "ses_k3",
      "ses_k2",
    ]);
    expect(ids(await source.listChildren("ses_root", { archived: "include" }))).toHaveLength(3);

    const first = await source.listChildren("ses_root", { limit: 2, order: "id" });
    expect(ids(first)).toEqual(["ses_k1", "ses_k2"]);
    expect(paging(first)).toEqual({ truncated: true, nextCursor: "ses_k2" });
    const rest = await source.listChildren("ses_root", { limit: 2, order: "id", after: "ses_k2" });
    expect(ids(rest)).toEqual(["ses_k3"]);
    expect(paging(rest)).toEqual({ truncated: false, nextCursor: undefined });

    await expect(source.listChildren("ses_root", { limit: 0 })).rejects.toThrow(/positive integer/);
  });

  it("reports more than 1,000 children as truncated and lists every one through an id walk", async () => {
    const t = await fresh();
    session(t, "ses_root");
    t.db.exec("BEGIN");
    const kids: string[] = [];
    for (let i = 0; i < 1_005; i++) {
      const id = `ses_kid_${String(i).padStart(4, "0")}`;
      kids.push(id);
      session(t, id, { parent_id: "ses_root", time_updated: 1_000 + ((i * 37) % 1_005) });
    }
    t.db.exec("COMMIT");
    const { source } = await open(t);

    const page = await source.listChildren("ses_root");
    expect(ids(page)).toHaveLength(1_000);
    expect(page).toMatchObject({ truncated: true });

    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const listing = await source.listChildren("ses_root", { limit: 400, order: "id", after });
      seen.push(...ids(listing));
      after = listing.ok ? listing.nextCursor : undefined;
      pages++;
    } while (after !== undefined);
    expect(pages).toBe(3);
    expect(seen).toEqual(kids);
  });
});
