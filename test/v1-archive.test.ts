import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, GlobalSession } from "@opencode-ai/sdk/v2";
import { createDistiller, type Distiller } from "../src/distill.js";
import { createFetchGate } from "../src/fetch-gate.js";
import { v1EventToSignal } from "../src/history/v1-events.js";
import { sessions as sessionsTool } from "../src/sessions.js";
import { openSqlite, type SqliteDb } from "../src/sqlite.js";
import type { Store } from "../src/store.js";
import { makeFakeHarness, openV1Store, runTool, TEST_LIMITS, type FakeHarness } from "./helpers.js";

/**
 * On the v1 host an archive or unarchive arrives as `session.updated` with no
 * new messages; the card's archive time follows it, so recall_sessions
 * listings served from the cards report it.
 */

let dir: string;
let db: SqliteDb;
let store: Store;
let distiller: Distiller | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "recall-v1-archive-"));
  const opened = await openSqlite(join(dir, "store.db"));
  if (!opened) throw new Error("no sqlite");
  db = opened;
  const s = openV1Store(db);
  if (!s) throw new Error("no store");
  store = s;
});

afterEach(async () => {
  await distiller?.stop();
  distiller = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}

const updated = (info: GlobalSession): Event =>
  ({ type: "session.updated", properties: { sessionID: info.id, info } }) as unknown as Event;

type Listing = { ok: boolean; sessions: Array<{ id: string; archived: boolean }> };

async function listedArchived(h: FakeHarness, id: string): Promise<boolean | undefined> {
  const tool = sessionsTool(h.source, true, TEST_LIMITS, { cards: () => store.allCards() });
  const out = await runTool<Listing>(tool, { scope: "global", since: "7d" });
  expect(out.ok).toBe(true);
  return out.sessions.find((s) => s.id === id)?.archived;
}

describe("v1 archive changes", () => {
  it("reach the card from session.updated alone and change what recall_sessions reports", async () => {
    const h = makeFakeHarness();
    distiller = createDistiller({
      source: h.source,
      store,
      gate: createFetchGate({ concurrency: 2 }),
      limits: { ...TEST_LIMITS, distillDelayMs: 0 },
      instanceId: "v1-archive",
    });
    distiller.start();
    await waitFor(() => distiller?.status().coldPass === "done");
    const info = h.globalSessions.find((s) => s.id === "s-current");
    if (!info) throw new Error("fixture has no s-current");
    const before = store.getCard("s-current");
    expect(before?.distillState).toBe("full");
    expect(await listedArchived(h, "s-current")).toBe(false);

    const archivedAt = Date.now();
    const archive = v1EventToSignal(
      updated({ ...info, time: { ...info.time, archived: archivedAt } }),
    );
    if (!archive) throw new Error("session.updated mapped to no signal");
    const rev = store.cardStats().cardsRev;
    distiller.onEvent(archive);
    // Only the archive time changed, with one revision.
    expect(store.getCard("s-current")).toEqual({
      ...before,
      timeArchived: archivedAt,
      writeRev: rev + 1,
    });
    expect(await listedArchived(h, "s-current")).toBe(true);

    // An update that changes nothing else writes nothing.
    distiller.onEvent(archive);
    expect(store.cardStats().cardsRev).toBe(rev + 1);

    const unarchive = v1EventToSignal(updated(info));
    if (!unarchive) throw new Error("session.updated mapped to no signal");
    distiller.onEvent(unarchive);
    expect(store.getCard("s-current")?.timeArchived).toBeUndefined();
    expect(store.cardStats().cardsRev).toBe(rev + 2);
    expect(await listedArchived(h, "s-current")).toBe(false);
  });
});
