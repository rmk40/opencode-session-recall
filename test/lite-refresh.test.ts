import { describe, expect, it } from "vitest";
import { createLiteRefresh, LITE_REFRESH_WINDOW_MS } from "../src/lite-refresh.js";
import { createCardsRuntime, cardsLiteFromSessions } from "../src/cards.js";
import type { Card } from "../src/store.js";
import { createFetchGate } from "../src/fetch-gate.js";
import { autoRecall } from "../src/hooks/auto-recall.js";
import type { SearchDeps } from "../src/search.js";
import { createDrill } from "../src/drill.js";
import { makeFakeHarness, session, TEST_LIMITS } from "./helpers.js";
import { parseQuery } from "../src/query.js";

/**
 * Unit tests for the REAL ephemeral cards-lite refresh controller (not a
 * helper reimplementation): injected clock + fake list function drive the
 * controller's window/single-flight state; a real CardsRuntime over the lite
 * source proves invalidate() bypasses the runtime's refresh-interval gate.
 */

function liteCard(id: string, updated: number): Card {
  return cardsLiteFromSessions([{ id, title: `Session ${id}`, time: { updated } }])[0]!;
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeRig(opts: { initial?: Card[]; runtimeIntervalMs?: number } = {}) {
  let liteCards: Card[] = opts.initial ?? [];
  let now = 0;
  let disposed = false;
  const pending: Deferred<Card[]>[] = [];
  const listCalls: number[] = [];
  // Ordered completion log: assign MUST precede invalidate (invalidate-first
  // would let a racing card access rebuild over the stale snapshot), and
  // neither token may appear on failure or after dispose.
  const events: ("assign" | "invalidate")[] = [];
  const trackCalls: Promise<unknown>[] = [];
  const list = (): Promise<Card[]> => {
    listCalls.push(now);
    const d = deferred<Card[]>();
    pending.push(d);
    return d.promise;
  };
  const runtime = createCardsRuntime({
    source: { getCards: () => liteCards, revision: () => undefined, degraded: true },
    now: () => now,
    refreshIntervalMs: opts.runtimeIntervalMs ?? 5_000,
  });
  const runQueryCalls: number[] = [];
  const controller = createLiteRefresh({
    list,
    assign: (next) => {
      events.push("assign");
      liteCards = next;
    },
    invalidate: () => {
      events.push("invalidate");
      runtime.invalidate();
    },
    runQuery: (fn) => {
      runQueryCalls.push(now);
      return fn();
    },
    track: (operation) => {
      trackCalls.push(operation as Promise<unknown>);
      return operation;
    },
    disposed: () => disposed,
    now: () => now,
  });
  return {
    controller,
    runtime,
    listCalls,
    runQueryCalls,
    events,
    trackCalls,
    pending,
    cards: () => liteCards,
    setNow: (t: number) => {
      now = t;
    },
    dispose: () => {
      disposed = true;
    },
    rankIds: () => runtime.rank(parseQuery("session"), {}).map((hit) => hit.sessionId),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("lite-refresh controller", () => {
  it("makes a post-init session visible on the first query after the discover resolves, not the triggering query", async () => {
    const rig = makeRig();
    const init = rig.controller.initialRefresh();
    rig.pending[0]!.resolve([liteCard("s-a", 100)]);
    await init;
    expect(rig.rankIds()).toEqual(["s-a"]);

    // A new session appears server-side; the window elapses; a query triggers.
    rig.setNow(LITE_REFRESH_WINDOW_MS + 1);
    rig.controller.maybeRefresh();
    expect(rig.listCalls).toHaveLength(2);
    // The triggering query proceeds on the OLD snapshot.
    expect(rig.rankIds()).toEqual(["s-a"]);

    rig.pending[1]!.resolve([liteCard("s-a", 100), liteCard("s-b", 200)]);
    await settle();
    // First query after the discover resolves sees the new card IMMEDIATELY —
    // the clock has NOT advanced past the runtime's 5s refresh-interval gate,
    // so this pins that invalidate() really bypasses it.
    expect(rig.rankIds()).toEqual(expect.arrayContaining(["s-a", "s-b"]));

    // Exact ordering per successful attempt: assign BEFORE invalidate.
    // Reversed order would let a racing card access rebuild over the stale
    // snapshot, so this pins the sequence, not just the set of calls.
    expect(rig.events).toEqual(["assign", "invalidate", "assign", "invalidate"]);
    // Every attempt (init and refresh) registers with dispose accounting.
    expect(rig.trackCalls).toHaveLength(2);
  });

  it("single-flight: concurrent stale queries produce exactly one session.list", async () => {
    const rig = makeRig({ initial: [liteCard("s-a", 100)] });
    rig.setNow(LITE_REFRESH_WINDOW_MS + 1);
    rig.controller.maybeRefresh();
    rig.controller.maybeRefresh();
    rig.controller.maybeRefresh();
    expect(rig.listCalls).toHaveLength(1);
    rig.pending[0]!.resolve([liteCard("s-a", 100)]);
    await settle();
  });

  it("shares the single flight with the init discover", async () => {
    const rig = makeRig();
    const init = rig.controller.initialRefresh();
    // Queries racing init must not fan out a duplicate list (even though the
    // card set is empty and no attempt window has ever elapsed for them).
    rig.controller.maybeRefresh();
    rig.controller.maybeRefresh();
    expect(rig.listCalls).toHaveLength(1);
    rig.pending[0]!.resolve([liteCard("s-a", 100)]);
    await init;
  });

  it("routes refreshes through the gate's query path but not the init discover", async () => {
    const rig = makeRig();
    const init = rig.controller.initialRefresh();
    rig.pending[0]!.resolve([liteCard("s-a", 100)]);
    await init;
    expect(rig.runQueryCalls).toHaveLength(0);

    rig.setNow(LITE_REFRESH_WINDOW_MS + 1);
    rig.controller.maybeRefresh();
    expect(rig.runQueryCalls).toHaveLength(1);
    rig.pending[1]!.resolve([liteCard("s-a", 100)]);
    await settle();
  });

  it("keeps previous cards on failure and retries only after the window", async () => {
    const rig = makeRig({ initial: [liteCard("s-a", 100)] });
    rig.setNow(LITE_REFRESH_WINDOW_MS + 1);
    rig.controller.maybeRefresh();
    rig.pending[0]!.reject(new Error("network down"));
    await settle();
    expect(rig.cards().map((c) => c.sessionId)).toEqual(["s-a"]);
    // Failure neither assigns nor invalidates.
    expect(rig.events).toEqual([]);
    // But the attempt was still tracked for dispose accounting.
    expect(rig.trackCalls).toHaveLength(1);

    // Within the backoff window: no new attempt.
    rig.setNow(LITE_REFRESH_WINDOW_MS + 2);
    rig.controller.maybeRefresh();
    expect(rig.listCalls).toHaveLength(1);

    // Window elapsed since the failed attempt: retries.
    rig.setNow(2 * LITE_REFRESH_WINDOW_MS + 2);
    rig.controller.maybeRefresh();
    expect(rig.listCalls).toHaveLength(2);
    rig.pending[1]!.resolve([liteCard("s-a", 100)]);
    await settle();
  });

  it("recovers after a failed refresh: the next success assigns and is visible immediately", async () => {
    const rig = makeRig({ initial: [liteCard("s-a", 100)] });
    expect(rig.rankIds()).toEqual(["s-a"]);

    rig.setNow(LITE_REFRESH_WINDOW_MS + 1);
    rig.controller.maybeRefresh();
    rig.pending[0]!.reject(new Error("network down"));
    await settle();
    // The failure must not invalidate: the snapshot still ranks the old card.
    expect(rig.rankIds()).toEqual(["s-a"]);

    rig.setNow(2 * LITE_REFRESH_WINDOW_MS + 2);
    rig.controller.maybeRefresh();
    expect(rig.listCalls).toHaveLength(2);
    rig.pending[1]!.resolve([liteCard("s-a", 100), liteCard("s-b", 200)]);
    await settle();
    // Recovery: the post-failure success assigns AND invalidates — the new card
    // is visible on the very next access (clock unchanged since the resolve, so
    // the runtime's refresh-interval gate alone could not have rebuilt).
    expect(rig.rankIds()).toEqual(expect.arrayContaining(["s-a", "s-b"]));
  });

  it("a failed init leaves an empty set that respects the backoff, then heals at the window boundary", async () => {
    const rig = makeRig();
    const init = rig.controller.initialRefresh();
    rig.pending[0]!.reject(new Error("list unavailable at startup"));
    // The init promise resolves despite the failure (the entry file fires it
    // void; a rejection would surface as an unhandled rejection).
    await init;
    expect(rig.cards()).toEqual([]);

    // Empty card set does NOT bypass the backoff: within the window of the
    // failed init attempt, no retry.
    for (const t of [1, LITE_REFRESH_WINDOW_MS - 1]) {
      rig.setNow(t);
      rig.controller.maybeRefresh();
    }
    expect(rig.listCalls).toHaveLength(1);

    // Exactly at the window boundary the retry fires and the set heals.
    rig.setNow(LITE_REFRESH_WINDOW_MS);
    rig.controller.maybeRefresh();
    expect(rig.listCalls).toHaveLength(2);
    rig.pending[1]!.resolve([liteCard("s-a", 100)]);
    await settle();
    expect(rig.rankIds()).toEqual(["s-a"]);
  });

  it("measures the backoff window from attempt start, not settlement", async () => {
    const rig = makeRig({ initial: [liteCard("s-a", 100)] });
    rig.setNow(LITE_REFRESH_WINDOW_MS + 1);
    rig.controller.maybeRefresh();
    // The list settles much later; the window must still be anchored at the
    // attempt start (W+1), not at this settlement time.
    rig.setNow(LITE_REFRESH_WINDOW_MS + 30_000);
    rig.pending[0]!.resolve([liteCard("s-a", 100)]);
    await settle();

    rig.setNow(2 * LITE_REFRESH_WINDOW_MS);
    rig.controller.maybeRefresh();
    expect(rig.listCalls).toHaveLength(1);

    rig.setNow(2 * LITE_REFRESH_WINDOW_MS + 1);
    rig.controller.maybeRefresh();
    expect(rig.listCalls).toHaveLength(2);
    rig.pending[1]!.resolve([liteCard("s-a", 100)]);
    await settle();
  });

  it("does not hammer a genuinely empty server: at most one list per window", async () => {
    const rig = makeRig();
    const init = rig.controller.initialRefresh();
    rig.pending[0]!.resolve([]);
    await init;
    expect(rig.cards()).toEqual([]);

    // Empty card set within the window: still bounded by the backoff.
    for (const t of [1, 100, 30_000, LITE_REFRESH_WINDOW_MS - 1]) {
      rig.setNow(t);
      rig.controller.maybeRefresh();
    }
    expect(rig.listCalls).toHaveLength(1);

    rig.setNow(LITE_REFRESH_WINDOW_MS + 1);
    rig.controller.maybeRefresh();
    expect(rig.listCalls).toHaveLength(2);
    rig.pending[1]!.resolve([]);
    await settle();
  });

  it("is clean when disposed while a refresh is in flight", async () => {
    const rig = makeRig({ initial: [liteCard("s-a", 100)] });
    rig.setNow(LITE_REFRESH_WINDOW_MS + 1);
    rig.controller.maybeRefresh();
    expect(rig.listCalls).toHaveLength(1);
    rig.dispose();
    rig.pending[0]!.resolve([liteCard("s-b", 200)]);
    await settle();
    // The late settlement neither assigns nor invalidates after dispose.
    expect(rig.cards().map((c) => c.sessionId)).toEqual(["s-a"]);
    expect(rig.events).toEqual([]);
    // And a disposed controller never starts new work.
    rig.setNow(3 * LITE_REFRESH_WINDOW_MS);
    rig.controller.maybeRefresh();
    expect(rig.listCalls).toHaveLength(1);
  });

  it("contains a synchronously-throwing list as a failed attempt: previous cards kept, one-window backoff", async () => {
    const kept = [liteCard("s-a", 100)];
    let cards = kept;
    let calls = 0;
    const controller = createLiteRefresh({
      list: () => {
        calls++;
        throw new Error("sync throw before any promise");
      },
      assign: (next) => {
        cards = next;
      },
      invalidate: () => {},
      runQuery: (fn) => fn(),
      now: () => LITE_REFRESH_WINDOW_MS + 1,
    });
    controller.maybeRefresh();
    await settle();
    expect(cards).toBe(kept);
    // Backed off: within the same window no second attempt fires.
    controller.maybeRefresh();
    expect(calls).toBe(1);
  });

  it("a throwing assign does not reject initialRefresh and skips invalidate", async () => {
    const events: string[] = [];
    const controller = createLiteRefresh({
      list: async () => [liteCard("s-a", 100)],
      assign: () => {
        events.push("assign");
        throw new Error("assign exploded");
      },
      invalidate: () => events.push("invalidate"),
      runQuery: (fn) => fn(),
      now: () => 0,
    });
    await expect(controller.initialRefresh()).resolves.toBeUndefined();
    expect(events).toEqual(["assign"]);
  });

  it("a disposed controller's initialRefresh makes no list call", async () => {
    let calls = 0;
    const controller = createLiteRefresh({
      list: async () => {
        calls++;
        return [];
      },
      assign: () => {},
      invalidate: () => {},
      runQuery: (fn) => fn(),
      disposed: () => true,
      now: () => 0,
    });
    await expect(controller.initialRefresh()).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  it("autoRecall hook path triggers at most one list per window", async () => {
    const rig = makeRig({ initial: [liteCard("s-a", 100)] });
    rig.setNow(LITE_REFRESH_WINDOW_MS + 1);
    const harness = makeFakeHarness();
    const gate = createFetchGate({ concurrency: TEST_LIMITS.concurrency });
    const deps: SearchDeps = {
      gate,
      store: null,
      cards: rig.runtime,
      drill: createDrill({ client: harness.client, gate, limits: TEST_LIMITS }),
      mode: "ephemeral",
      maybeRefresh: () => rig.controller.maybeRefresh(),
    };
    const hook = autoRecall(deps);
    const fire = () =>
      hook(
        { sessionID: session("s-hook", "t", "/d", 1).id } as never,
        {
          message: { id: "m1" },
          parts: [{ type: "text", text: "same as last time, what did we decide about sessions?" }],
        } as never,
      );
    await fire();
    await fire();
    await fire();
    expect(rig.listCalls).toHaveLength(1);
    rig.pending[0]!.resolve([liteCard("s-a", 100)]);
    await settle();
  });
});
