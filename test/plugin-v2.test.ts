import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import entry from "../src/opencode-session-recall.js";
import {
  eventResubscribe,
  instanceOf,
  PRIMARY_ONLY_ERROR,
  setV2LogSinkForTests,
} from "../src/host/v2.js";
import { NUDGE_BASE_TEXT, NUDGE_SENTINEL, NUDGE_TEXT } from "../src/hooks/system-nudge.js";
import { unavailableHistoryError } from "../src/history/source.js";
import { STARTING_REASON } from "../src/host/v2-tools.js";
import { DETACH_WAIT_MS } from "../src/host/runtime.js";
import { TOOLS } from "../src/types.js";
import { registry, REGISTRY_KEY } from "../src/host/registry.js";
import { resetRuntimeRegistryForTests } from "../src/host/runtime.js";
import type { V2Runtime } from "../src/host/v2-runtime.js";
import type { V2Cleanup } from "../src/host/opencode-v2-types.js";
import { openSqlite } from "../src/sqlite.js";
import { insertMessage, insertProject, insertSession, makeV2Db, type V2TestDb } from "./v2-db.js";
import {
  eventStream,
  fakeV2Host,
  type EventStream,
  type FakeV2Host,
  type FakeV2HostOptions,
} from "./v2-host.js";
import type { V2Event } from "../src/host/opencode-v2-types.js";

/**
 * The v2 host entry end to end over a fake v2 context and a temp opencode.db.
 */

let v2db: V2TestDb;
let dir: string;
const cleanups: V2Cleanup[] = [];

beforeEach(async () => {
  resetRuntimeRegistryForTests();
  v2db = await makeV2Db();
  insertProject(v2db.db, { id: "prj_test", worktree: "/workspace/project" });
  insertSession(v2db.db, {
    id: "ses_a",
    project_id: "prj_test",
    directory: "/workspace/project",
    time_created: 1_000,
    time_updated: 2_000,
  });
  insertSession(v2db.db, {
    id: "ses_child",
    project_id: "prj_test",
    parent_id: "ses_a",
    directory: "/workspace/project",
    title: "Subagent run",
    time_created: 1_500,
    time_updated: 2_500,
  });
  insertMessage(v2db.db, {
    id: "msg_a1",
    session_id: "ses_a",
    type: "user",
    seq: 1,
    time_created: 1_100,
    data: { text: "orchidneedle design question", time: { created: 1_100 } },
  });
  dir = mkdtempSync(join(tmpdir(), "recall-v2-plugin-"));
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  resetRuntimeRegistryForTests();
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
  v2db.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function host(opts: FakeV2HostOptions = {}): FakeV2Host {
  return fakeV2Host({
    ...opts,
    options: {
      opencodeDbPath: v2db.path,
      storePath: join(dir, "store.db"),
      coldPass: false,
      ...opts.options,
    },
  });
}

async function setup(h: FakeV2Host): Promise<V2Cleanup> {
  const cleanup = await entry.setup(h.ctx);
  if (!cleanup) throw new Error("setup stayed inert");
  cleanups.push(cleanup);
  return cleanup;
}

async function runtimeOf(h: FakeV2Host): Promise<V2Runtime> {
  const instance = instanceOf(h.ctx);
  const runtime = await instance?.attachment.ready(5_000);
  if (!runtime) throw new Error("runtime never became ready");
  return runtime;
}

describe("v2 setup", () => {
  it("attaches synchronously and builds the runtime on a later macrotask", async () => {
    const h = host();
    const pending = entry.setup(h.ctx);
    // Attached and registered before setup's promise even settles.
    expect(instanceOf(h.ctx)).toBeDefined();
    expect(h.transformCalls).toBe(1);
    expect(instanceOf(h.ctx)?.attachment.current()).toBeUndefined();
    const cleanup = await pending;
    expect(typeof cleanup).toBe("function");
    if (cleanup) cleanups.push(cleanup);
    const runtime = await runtimeOf(h);
    expect(runtime.unavailable).toBeUndefined();
    expect(runtime.store).not.toBeNull();
  });

  it("opens the store with the v2 identity, stamped with the real opencode.db path", async () => {
    const h = host();
    await setup(h);
    await runtimeOf(h);
    const db = await openSqlite(join(dir, "store.db"));
    try {
      const meta = Object.fromEntries(
        (db?.all("SELECT key, value FROM meta") ?? []).map((row) => [row.key, row.value]),
      );
      expect(meta.store_host).toBe("opencode-v2");
      expect(meta.source_db).toBe(realpathSync(v2db.path));
    } finally {
      db?.close();
    }
  });

  it("shares one runtime between locations and disposes it with the last cleanup", async () => {
    const a = host({ directory: "/workspace/project" });
    const b = host({ directory: "/workspace/other", projectID: "prj_other" });
    const cleanupA = await setup(a);
    const cleanupB = await setup(b);
    const runtime = await runtimeOf(a);
    expect(await runtimeOf(b)).toBe(runtime);
    // Each location reads through its own project-bound facade.
    expect(runtime.sourceFor("prj_test")).not.toBe(runtime.sourceFor("prj_other"));

    await cleanupA();
    expect(instanceOf(b.ctx)?.attachment.current()).toBe(runtime);
    await cleanupB();
    expect(instanceOf(b.ctx)?.attachment.current()).toBeUndefined();
    // Idempotent.
    await cleanupA();
  });

  it("runs unavailable when opencode.db is missing: no distiller, reads fail with the reason", async () => {
    const h = host({
      options: { opencodeDbPath: join(dir, "missing.db"), coldPass: true },
    });
    await setup(h);
    const runtime = await runtimeOf(h);
    expect(runtime.unavailable).toBeDefined();
    expect(runtime.distiller.status().leaseHeld).toBe(false);
    const listing = await runtime
      .sourceFor("prj_test")
      .listSessions({ scope: "project", limit: 5 });
    expect(listing.ok).toBe(false);
  });

  it("stays inert when the v1 server already runs in this process", () => {
    registry().v1ServerActive = true;
    const h = host();
    expect(entry.setup(h.ctx)).toBeUndefined();
    expect(instanceOf(h.ctx)).toBeUndefined();
  });

  it("keeps an ephemeral instance on its own runtime without a store", async () => {
    const persistent = host();
    const ephemeral = host({ options: { mode: "ephemeral" } });
    await setup(persistent);
    await setup(ephemeral);
    const p = await runtimeOf(persistent);
    const e = await runtimeOf(ephemeral);
    expect(e).not.toBe(p);
    expect(e.store).toBeNull();
    expect(e.deps.mode).toBe("ephemeral");
  });

  it("forwards each bus event to the distiller once, however many locations deliver it", async () => {
    const a = host();
    const b = host({ directory: "/workspace/other", projectID: "prj_other" });
    await setup(a);
    await setup(b);
    const runtime = await runtimeOf(a);
    const onEvent = vi.spyOn(runtime.distiller, "onEvent");
    const renamed = {
      id: "evt_1",
      type: "session.renamed",
      data: { sessionID: "ses_a", title: "Renamed" },
    };
    // Delivery is global today: both locations see the same event.
    a.events.push(renamed);
    b.events.push(renamed);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      type: "meta",
      sessionID: "ses_a",
      patch: { title: "Renamed" },
    });
    a.events.push({ ...renamed, id: "evt_2" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it("re-subscribes with backoff after the event stream fails mid-stream", async () => {
    eventResubscribe.delaysMs = [5, 5, 5];
    try {
      const inner = eventStream();
      let subscriptions = 0;
      // The first subscription delivers one event, then fails; later ones work.
      const flaky: EventStream = Object.assign(Object.create(inner) as EventStream, {
        subscribe(signal?: AbortSignal): AsyncIterable<V2Event> {
          const base = inner.subscribe(signal);
          if (++subscriptions > 1) return base;
          return {
            [Symbol.asyncIterator]() {
              const it = base[Symbol.asyncIterator]();
              let delivered = 0;
              return {
                async next(): Promise<IteratorResult<V2Event>> {
                  if (delivered > 0) {
                    await it.return?.();
                    throw new Error("stream broke");
                  }
                  delivered++;
                  return it.next();
                },
                return: () => it.return?.() ?? Promise.resolve({ done: true, value: undefined }),
              };
            },
          };
        },
      });
      const h = host({ events: flaky });
      await setup(h);
      const runtime = await runtimeOf(h);
      const onEvent = vi.spyOn(runtime, "onEvent");
      const renamed = (id: string) => ({
        id,
        type: "session.renamed",
        data: { sessionID: "ses_a", title: id },
      });
      inner.push(renamed("evt_before"));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(subscriptions).toBe(2);
      inner.push(renamed("evt_after"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(onEvent.mock.calls.map(([event]) => event.id)).toEqual(["evt_before", "evt_after"]);
    } finally {
      eventResubscribe.delaysMs = [1_000, 5_000, 30_000];
    }
  });

  it("logs once per process when ctx.app.channel is missing, and flushes the log on cleanup", async () => {
    const lines: string[] = [];
    const flush = vi.fn(async () => {});
    setV2LogSinkForTests(Object.assign((line: string) => void lines.push(line), { flush }));
    try {
      const a = host();
      const b = host({ directory: "/workspace/other", projectID: "prj_other" });
      for (const h of [a, b]) (h.ctx as { app?: unknown }).app = {};
      const cleanupA = await setup(a);
      await setup(b);
      const fallback = lines.filter((line) => line.includes("ctx.app.channel is missing"));
      expect(fallback).toHaveLength(1);
      await cleanupA();
      expect(flush).toHaveBeenCalled();
    } finally {
      setV2LogSinkForTests(undefined);
    }
  });

  it("stops reading events after cleanup", async () => {
    const h = host();
    const cleanup = await setup(h);
    await runtimeOf(h);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.events.active).toBe(1);
    await cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.events.active).toBe(0);
  });
});

type Json = Record<string, unknown> & { ok: boolean };

async function call(
  h: FakeV2Host,
  name: string,
  input: unknown,
  sessionID = "ses_a",
): Promise<Json> {
  const result = await h.runTool(name, input, { sessionID });
  expect(typeof result.content).toBe("string");
  return JSON.parse(result.content as string) as Json;
}

describe("v2 tools and hooks", () => {
  it("registers the five tools once, direct (codemode false), with zod input schemas", async () => {
    const h = host();
    await setup(h);
    expect(h.transformCalls).toBe(1);
    expect([...h.tools.keys()].sort()).toEqual([...TOOLS].sort());
    for (const tool of h.tools.values()) {
      expect(tool.options).toEqual({ codemode: false });
      expect(tool.description.length).toBeGreaterThan(20);
      expect(typeof tool.input["~standard"].validate).toBe("function");
    }
    // The schema carries the tool's defaults (the host applies them).
    const parsed = await h.tools.get("recall_sessions")?.input["~standard"].validate({});
    expect(parsed).toMatchObject({ value: { scope: "project" } });
  });

  it("re-adds the same five working tools when the host replays its transforms", async () => {
    const h = host();
    await setup(h);
    await runtimeOf(h);
    const first = new Map(h.tools);
    h.rebuildTools();
    expect([...h.tools.keys()].sort()).toEqual([...TOOLS].sort());
    for (const [name, tool] of h.tools) {
      expect(tool.description).toBe(first.get(name)?.description);
      expect(tool.options).toEqual({ codemode: false });
    }
    const out = await call(h, "recall_sessions", { scope: "project" });
    expect(out.ok).toBe(true);
    expect((out.sessions as Array<{ id: string }>).map((s) => s.id)).toContain("ses_a");
  });

  it("answers from opencode.db through the instance's project facade", async () => {
    const h = host();
    await setup(h);
    await runtimeOf(h);
    const listed = await call(h, "recall_sessions", { scope: "project", limit: 10 });
    expect(listed.ok).toBe(true);
    expect((listed.sessions as Array<{ id: string }>).map((s) => s.id).sort()).toEqual([
      "ses_a",
      "ses_child",
    ]);
    const message = await call(h, "recall_get", { sessionID: "ses_a", messageID: "msg_a1" });
    expect(message.ok).toBe(true);
    const window = await call(h, "recall_messages", { sessionID: "ses_a" });
    expect(window.ok).toBe(true);
    // A missing required arg is a normal error result, never a throw.
    const missing = await call(h, "recall_get", {});
    expect(missing).toEqual({ ok: false, error: "sessionID and messageID are required" });
  });

  it("degrades a call that finds no runtime within the wait", async () => {
    const h = host();
    await setup(h);
    const instance = instanceOf(h.ctx);
    if (!instance) throw new Error("no instance");
    vi.spyOn(instance.attachment, "ready").mockResolvedValue(undefined);
    expect(await call(h, "recall_get", { sessionID: "ses_a", messageID: "msg_a1" })).toEqual({
      ok: false,
      error: unavailableHistoryError(STARTING_REASON),
    });
    const recall = await call(h, "recall", { query: "orchidneedle" });
    expect(recall.ok).toBe(true);
    expect((recall.coverage as { source?: unknown }).source).toMatchObject({ available: false });
  });

  it("answers every tool with the unavailable reason when opencode.db is missing", async () => {
    const h = host({ options: { opencodeDbPath: join(dir, "missing.db") } });
    await setup(h);
    const runtime = await runtimeOf(h);
    const error = unavailableHistoryError(runtime.unavailable ?? "");
    for (const [name, input] of [
      ["recall_get", { sessionID: "ses_a", messageID: "msg_a1" }],
      ["recall_context", { sessionID: "ses_a", messageID: "msg_a1" }],
      ["recall_messages", { sessionID: "ses_a" }],
      ["recall_sessions", { scope: "project" }],
    ] as const) {
      expect(await call(h, name, input)).toEqual({ ok: false, error });
    }
    const recall = await call(h, "recall", { query: "orchidneedle" });
    expect(recall).toMatchObject({ ok: true, results: [] });
  });

  it("adds the nudge once per request, without the v1 subagent clause", async () => {
    const h = host();
    await setup(h);
    const event = await h.runContext({ sessionID: "ses_a" });
    expect(event.system).toEqual([{ type: "text", text: NUDGE_BASE_TEXT }]);
    expect(NUDGE_BASE_TEXT).not.toContain("task_id");
    expect(NUDGE_TEXT.startsWith(NUDGE_BASE_TEXT)).toBe(true);
    // Idempotent on the same request.
    for (const callback of h.hooks.get("context") ?? []) await callback(event);
    expect(event.system.filter((p) => p.text.includes(NUDGE_SENTINEL))).toHaveLength(1);
    expect(Object.keys(event.tools).sort()).toEqual([...TOOLS].sort());
  });

  it("registers no context hook with nudge and primary off, and no hook for deferred features", async () => {
    const h = host({
      options: { nudge: false, primary: false, autoRecall: true, compactionRecall: true },
    });
    await setup(h);
    expect([...h.hooks.keys()]).toEqual([]);
    expect(h.tools.size).toBe(5);
  });

  it("primary: hides and refuses the tools for a child session, via the v2 source", async () => {
    const h = host();
    await setup(h);
    await runtimeOf(h);
    const event = await h.runContext({ sessionID: "ses_child" });
    for (const name of TOOLS) expect(event.tools[name]).toBeUndefined();
    expect(event.system).toEqual([]); // no tools, no nudge
    expect(await call(h, "recall_sessions", {}, "ses_child")).toEqual({
      ok: false,
      error: PRIMARY_ONLY_ERROR,
    });
    // The v2 source answered; the host was never asked.
    expect(h.sessionGets).toEqual([]);
  });

  it("primary: falls back to session.get, caches the answer, and fails open", async () => {
    let fail = true;
    const h = host({
      options: { opencodeDbPath: join(dir, "missing.db") },
      sessionGet: async (sessionID) => {
        if (fail) throw new Error("host unavailable");
        return sessionID === "ses_x" ? { id: sessionID, parentID: "ses_a" } : { id: sessionID };
      },
    });
    await setup(h);
    await runtimeOf(h);
    // Lookup failure: tools stay visible.
    const open = await h.runContext({ sessionID: "ses_x" });
    expect(Object.keys(open.tools)).toHaveLength(5);
    // Not cached: the next request asks again and now sees a child.
    fail = false;
    const hidden = await h.runContext({ sessionID: "ses_x" });
    expect(Object.keys(hidden.tools)).toHaveLength(0);
    await h.runContext({ sessionID: "ses_x" });
    expect(h.sessionGets).toEqual(["ses_x", "ses_x"]);
  });

  it("primary:false leaves child sessions their tools", async () => {
    const h = host({ options: { primary: false } });
    await setup(h);
    await runtimeOf(h);
    const event = await h.runContext({ sessionID: "ses_child" });
    expect(Object.keys(event.tools)).toHaveLength(5);
    const out = await call(h, "recall_sessions", {}, "ses_child");
    expect(out.ok).toBe(true);
  });

  it("global:false keeps queries to the instance's project; the distiller still sees every project", async () => {
    const h = host({ options: { global: false } });
    await setup(h);
    await runtimeOf(h);
    expect(await call(h, "recall_sessions", { scope: "global" })).toEqual({
      ok: false,
      error: "Global scope disabled via plugin option: global: false",
    });
    const project = await call(h, "recall_sessions", { scope: "project" });
    expect(project.ok).toBe(true);
  });

  it("persistent mode distills opencode.db and recall finds content through the cards", async () => {
    const h = host({ options: { coldPass: true } });
    await setup(h);
    const runtime = await runtimeOf(h);
    await waitUntil(() => runtime.distiller.status().coldPass === "done");
    expect(runtime.store?.getCard("ses_a")?.distillState).toBe("full");
    const out = await call(h, "recall", { query: "orchidneedle", scope: "global" }, "ses_new");
    expect(out.ok).toBe(true);
    expect((out.coverage as { cards: { full: number } }).cards.full).toBe(2);
    expect((out.results as Array<{ sessionID: string }>)[0]?.sessionID).toBe("ses_a");
  });

  it("ephemeral mode serves cards-lite from session_v2 and drills content live", async () => {
    const h = host({ options: { mode: "ephemeral" } });
    await setup(h);
    const runtime = await runtimeOf(h);
    expect(runtime.store).toBeNull();
    await waitUntil(() => runtime.cards.coverage().totalCards === 2);
    // Called from another session: recall excludes the caller's own family.
    const out = await call(h, "recall", { query: "orchidneedle", scope: "project" }, "ses_new");
    expect(out.ok).toBe(true);
    expect((out.coverage as { mode?: string }).mode).toBe("ephemeral");
    expect((out.results as Array<{ sessionID: string }>).map((r) => r.sessionID)).toContain(
      "ses_a",
    );
  });

  it("is inert after cleanup: tools report disposal and hooks do nothing", async () => {
    const h = host();
    const cleanup = await setup(h);
    await runtimeOf(h);
    await cleanup();
    expect(await call(h, "recall_sessions", {})).toEqual({
      ok: false,
      error: "opencode-session-recall: plugin has been disposed",
    });
    const event = await h.runContext({ sessionID: "ses_child" });
    expect(event.system).toEqual([]);
    expect(Object.keys(event.tools)).toHaveLength(5);
  });

  it("bounds cleanup when the runtime's dispose hangs", async () => {
    const h = host();
    const cleanup = await setup(h);
    const runtime = await runtimeOf(h);
    vi.spyOn(runtime, "dispose").mockReturnValue(new Promise<void>(() => {}));
    vi.useFakeTimers();
    try {
      let done = false;
      const pending = Promise.resolve(cleanup()).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(DETACH_WAIT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reload with a new build hands the distill lease to the new runtime", async () => {
    const global = globalThis as unknown as { __RECALL_BUILD_ID__?: string };
    try {
      global.__RECALL_BUILD_ID__ = "build-old";
      vi.resetModules();
      const oldEntry = (await import("../src/opencode-session-recall.js")).default;
      const oldHooks = await import("../src/host/v2.js");
      const a = host({ options: { coldPass: true } });
      const cleanupA = await oldEntry.setup(a.ctx);
      const oldRuntime = await oldHooks.instanceOf(a.ctx)?.attachment.ready(5_000);
      await waitUntil(() => oldRuntime?.distiller.status().leaseHeld === true);

      // Reload: the old cleanup runs, then the new build's setup.
      await cleanupA?.();
      global.__RECALL_BUILD_ID__ = "build-new";
      vi.resetModules();
      const newEntry = (await import("../src/opencode-session-recall.js")).default;
      const newHooks = await import("../src/host/v2.js");
      const b = host({ options: { coldPass: true } });
      const cleanupB = await newEntry.setup(b.ctx);
      if (cleanupB) cleanups.push(cleanupB);
      const newRuntime = await newHooks.instanceOf(b.ctx)?.attachment.ready(5_000);
      expect(newRuntime).toBeDefined();
      expect(newRuntime).not.toBe(oldRuntime);
      // The old runtime released the lease on retirement (its store is
      // closed now), so the new one takes it at once, not after the TTL.
      await waitUntil(() => newRuntime?.distiller.status().leaseHeld === true, 2_000);
    } finally {
      delete global.__RECALL_BUILD_ID__;
      vi.resetModules();
    }
  });
});

async function waitUntil(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
