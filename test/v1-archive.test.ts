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

describe("v1 archive changes during a distill of the session", () => {
  const SID = "s-current";

  /** The fake host's session archived at `at`, or not archived, in both its
   *  listings, as session.updated reports it. */
  function setArchived(h: FakeHarness, at: number | undefined): Event {
    const i = h.globalSessions.findIndex((s) => s.id === SID);
    const info = h.globalSessions[i]!;
    const next: GlobalSession = { ...info, time: { ...info.time } };
    if (at === undefined) delete next.time.archived;
    else next.time.archived = at;
    h.globalSessions[i] = next;
    const j = h.sessions.findIndex((s) => s.id === SID);
    if (j >= 0) h.sessions[j] = { ...h.sessions[j]!, time: { ...next.time } };
    return updated(next);
  }

  /** A distiller whose next read of the session's messages after `pause()`
   *  waits until released; later reads go through. */
  function pausable(h: FakeHarness) {
    let hold: Promise<void> | undefined;
    let held = false;
    let release = (): void => {};
    const d = createDistiller({
      source: {
        ...h.source,
        messagePage: async (o) => {
          const waiting = o.sessionID === SID ? hold : undefined;
          if (waiting) {
            hold = undefined;
            held = true;
            await waiting;
          }
          return h.source.messagePage(o);
        },
      },
      store,
      gate: createFetchGate({ concurrency: 2 }),
      limits: { ...TEST_LIMITS, distillDelayMs: 0 },
      instanceId: "v1-archive-race",
      idleDebounceMs: 1,
    });
    distiller = d;
    return {
      distiller: d,
      pause(): void {
        held = false;
        hold = new Promise((resolve) => (release = resolve));
      },
      held: () => held,
      release(): void {
        hold = undefined;
        release();
      },
    };
  }

  it("reaches a card the cold pass writes after a re-distill of the session wrote first", async () => {
    const h = makeFakeHarness();
    setArchived(h, undefined);
    const p = pausable(h);
    // The cold pass discovers the session unarchived and waits on its read.
    p.pause();
    p.distiller.start();
    await waitFor(p.held);
    const archivedAt = 1_700_000_000_000;
    p.distiller.onEvent(signal(setArchived(h, archivedAt)));
    // A re-distill reads the archived metadata and writes first.
    p.distiller.onEvent({ type: "turn-ended", sessionID: SID });
    await waitFor(() => store.getCard(SID)?.timeArchived === archivedAt);
    const rev = store.cardStats().cardsRev;
    // Then the cold pass writes what it discovered, and the follow-up reads
    // the metadata again.
    p.release();
    await waitFor(() => p.distiller.status().coldPass === "done");
    await waitFor(() => store.cardStats().cardsRev > rev + 1);
    await waitFor(() => store.getCard(SID)?.timeArchived === archivedAt);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getCard(SID)?.timeArchived).toBe(archivedAt);
  });

  const signal = (event: Event) => {
    const mapped = v1EventToSignal(event);
    if (!mapped) throw new Error(`${event.type} mapped to no signal`);
    return mapped;
  };

  it.each([
    { label: "archive", from: undefined, to: 1_700_000_000_000 },
    { label: "unarchive", from: 1_700_000_000_000, to: undefined },
  ])("reaches the card that a re-distill rewrites ($label)", async ({ from, to }) => {
    const h = makeFakeHarness();
    setArchived(h, from);
    const p = pausable(h);
    p.distiller.start();
    await waitFor(() => p.distiller.status().coldPass === "done");
    expect(store.getCard(SID)?.timeArchived).toBe(from);

    // The re-distill reads the session's metadata, then waits on its read
    // while the archive state changes.
    p.pause();
    p.distiller.onEvent({ type: "turn-ended", sessionID: SID });
    await waitFor(p.held);
    const rev = store.cardStats().cardsRev;
    p.distiller.onEvent(signal(setArchived(h, to)));
    expect(store.getCard(SID)?.timeArchived).toBe(to);
    p.release();
    // The re-distill writes, then the metadata is read again.
    await waitFor(() => store.cardStats().cardsRev > rev + 1);
    await waitFor(() => store.getCard(SID)?.timeArchived === to);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getCard(SID)?.timeArchived).toBe(to);
  });

  it.each([
    { label: "archive", from: undefined, to: 1_700_000_000_000 },
    { label: "unarchive", from: 1_700_000_000_000, to: undefined },
  ])(
    "reaches a card the cold pass creates after discovering the session ($label)",
    async ({ from, to }) => {
      const h = makeFakeHarness();
      setArchived(h, from);
      const p = pausable(h);
      p.pause();
      p.distiller.start();
      await waitFor(p.held);
      expect(store.getCard(SID)).toBeUndefined();
      p.distiller.onEvent(signal(setArchived(h, to)));
      p.release();
      await waitFor(() => p.distiller.status().coldPass === "done");
      await waitFor(() => store.getCard(SID)?.timeArchived === to);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(store.getCard(SID)?.timeArchived).toBe(to);
    },
  );
});
