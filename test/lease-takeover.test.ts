import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite, type SqliteDb } from "../src/sqlite.js";
import { MAX_TAKEOVER_HOLDERS, takeOverHolders, type Store } from "../src/store.js";
import { openV1Store } from "./helpers.js";

/**
 * Taking over the distill lease from a named predecessor whose heartbeat has
 * not expired, as a process does for a worker it knows has stopped.
 */

const TTL = 30_000;
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function freshPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "recall-lease-"));
  dirs.push(dir);
  return join(dir, "store.db");
}

async function connect(path: string, now: () => number): Promise<{ db: SqliteDb; store: Store }> {
  const db = await openSqlite(path);
  if (!db) throw new Error("openSqlite returned null");
  const store = openV1Store(db, { now });
  if (!store) throw new Error("openStore refused");
  return { db, store };
}

describe("distill lease takeover", () => {
  it("takes a live lease from the holder it names, which can then no longer renew it", async () => {
    let clock = 1_000_000;
    const { db, store } = await connect(freshPath(), () => clock);
    expect(store.acquireLease("A", TTL, "buildA", 4)).toBe(true);
    clock += 1_000;
    // Still live: a plain acquire is refused.
    expect(store.acquireLease("B", TTL, "buildB", 5)).toBe(false);
    expect(store.acquireLease("B", TTL, "buildB", 5, { takeOver: "A" })).toBe(true);
    expect(store.leaseStatus()).toEqual({
      holder: "B",
      build: "buildB",
      gen: 5,
      heartbeat: clock,
      ttl: TTL,
    });
    expect(store.heartbeatLease("A")).toBe(false);
    expect(store.heartbeatLease("B")).toBe(true);
    db.close();
  });

  it("never takes a live lease held by a holder it does not name", async () => {
    let clock = 1_000_000;
    const { db, store } = await connect(freshPath(), () => clock);
    expect(store.acquireLease("A", TTL, "buildA", 4)).toBe(true);
    clock += 1_000;
    expect(store.acquireLease("B", TTL, "buildB", 4, { takeOver: "Z" })).toBe(false);
    expect(store.leaseStatus()).toMatchObject({ holder: "A", build: "buildA" });
    db.close();
  });

  it("lets only the first of two takeovers naming the same holder succeed, across connections", async () => {
    let clock = 1_000_000;
    const path = freshPath();
    const one = await connect(path, () => clock);
    const two = await connect(path, () => clock);
    expect(one.store.acquireLease("A", TTL, "buildA", 4)).toBe(true);
    clock += 1_000;
    expect(two.store.acquireLease("B", TTL, "buildB", 4, { takeOver: "A" })).toBe(true);
    expect(one.store.acquireLease("C", TTL, "buildC", 4, { takeOver: "A" })).toBe(false);
    expect(one.store.leaseStatus()?.holder).toBe("B");
    one.db.close();
    two.db.close();
  });

  it("takes a live lease from any holder of the set it names", async () => {
    let clock = 1_000_000;
    const { db, store } = await connect(freshPath(), () => clock);
    expect(store.acquireLease("w2", TTL, "build", 4)).toBe(true);
    clock += 1_000;
    expect(store.acquireLease("w4", TTL, "build", 4, { takeOver: ["w1", "w2", "w3"] })).toBe(true);
    expect(store.leaseStatus()?.holder).toBe("w4");
    db.close();
  });

  it("never takes a live lease from a holder outside the set it names", async () => {
    let clock = 1_000_000;
    const { db, store } = await connect(freshPath(), () => clock);
    expect(store.acquireLease("other", TTL, "build", 4)).toBe(true);
    clock += 1_000;
    expect(store.acquireLease("w4", TTL, "build", 4, { takeOver: ["w1", "w2", "w3"] })).toBe(false);
    expect(store.leaseStatus()?.holder).toBe("other");
    db.close();
  });

  it("names at most the last four holders of a longer set, and ignores empty ids", async () => {
    let clock = 1_000_000;
    const { db, store } = await connect(freshPath(), () => clock);
    expect(store.acquireLease("w1", TTL, "build", 4)).toBe(true);
    clock += 1_000;
    // w1 is the fifth from the end: past the bound.
    const named = ["w1", "w2", "", "w3", "w4", "w5"];
    expect(store.acquireLease("w6", TTL, "build", 4, { takeOver: named })).toBe(false);
    expect(takeOverHolders(named)).toEqual(["w2", "w3", "w4", "w5"]);
    expect(takeOverHolders(["a", "b", "a"])).toEqual(["b", "a"]);
    expect(MAX_TAKEOVER_HOLDERS).toBe(4);
    db.close();
  });

  it("still takes an expired lease and renews its own, whatever holder it names", async () => {
    let clock = 1_000_000;
    const { db, store } = await connect(freshPath(), () => clock);
    expect(store.acquireLease("A", TTL, "buildA", 4)).toBe(true);
    clock += TTL + 1;
    expect(store.acquireLease("B", TTL, "buildB", 4, { takeOver: "Z" })).toBe(true);
    clock += 1_000;
    expect(store.acquireLease("B", TTL, "buildB", 4, { takeOver: "Z" })).toBe(true);
    expect(store.leaseStatus()).toMatchObject({ holder: "B", heartbeat: clock });
    db.close();
  });
});
