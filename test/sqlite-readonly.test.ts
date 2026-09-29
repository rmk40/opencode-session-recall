import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite, openSqliteReadOnly } from "../src/sqlite.js";

const dir = mkdtempSync(join(tmpdir(), "recall-ro-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function seeded(name: string): Promise<string> {
  const path = join(dir, name);
  const db = await openSqlite(path);
  if (!db) throw new Error("openSqlite returned null");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  db.run("INSERT INTO t (v) VALUES (?)", ["kept"]);
  db.close();
  return path;
}

describe("openSqliteReadOnly", () => {
  it("opens an existing database for reads and refuses writes", async () => {
    const path = await seeded("ok.db");
    const opened = await openSqliteReadOnly(path);
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.db.get("SELECT v FROM t")).toEqual({ v: "kept" });
    expect(() => opened.db.run("INSERT INTO t (v) VALUES ('x')")).toThrow();
    expect(() => opened.db.exec("CREATE TABLE u (x)")).toThrow();
    expect(opened.db.get("PRAGMA query_only")).toEqual({ query_only: 1 });
    opened.db.close();
  });

  it("reports a missing file as unavailable without creating it", async () => {
    const path = join(dir, "missing.db");
    const opened = await openSqliteReadOnly(path);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.reason).toContain(path);
    // Read-only never creates the file.
    expect((await openSqliteReadOnly(path)).ok).toBe(false);
  });

  it("reports a non-database file on the probe", async () => {
    const path = join(dir, "garbage.db");
    writeFileSync(path, "this is not a sqlite database, just some bytes ".repeat(200));
    const opened = await openSqliteReadOnly(path);
    expect(opened).toMatchObject({ ok: false });
    if (!opened.ok) expect(opened.reason).toMatch(/cannot (open|read)/);
  });

  it("rejects :memory: and an empty path by name", async () => {
    expect(await openSqliteReadOnly(":memory:")).toEqual({
      ok: false,
      reason: "in-memory database (:memory:) has no file to read",
    });
    expect(await openSqliteReadOnly("  ")).toEqual({ ok: false, reason: "empty database path" });
  });
});
