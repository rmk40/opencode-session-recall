import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachRuntime,
  createIdDedupe,
  DETACH_WAIT_MS,
  differingKeys,
  resetRuntimeRegistryForTests,
  RETIRE_WAIT_MS,
  type ResolvedIdentity,
  type RuntimeFactory,
  type RuntimeKey,
} from "../src/host/runtime.js";
import { registry } from "../src/host/registry.js";

type Fake = { id: number; identity: ResolvedIdentity };

type FactoryControl = {
  factory: RuntimeFactory<Fake>;
  created: Fake[];
  disposed: Fake[];
  /** Resolve pending create()s (when `holdCreate` is set). */
  releaseCreate: () => void;
  /** Resolve pending dispose()s (when `holdDispose` is set). */
  releaseDispose: () => void;
};

let nextId = 0;

function makeFactory(
  identity: ResolvedIdentity,
  opts: { holdCreate?: boolean; holdDispose?: boolean; log?: string[] } = {},
): FactoryControl {
  const created: Fake[] = [];
  const disposed: Fake[] = [];
  const createWaiters: Array<() => void> = [];
  const disposeWaiters: Array<() => void> = [];
  const factory: RuntimeFactory<Fake> = {
    resolve: async () => identity,
    create: async (resolved) => {
      if (opts.holdCreate) await new Promise<void>((resolve) => createWaiters.push(resolve));
      const fake = { id: ++nextId, identity: resolved };
      created.push(fake);
      opts.log?.push(`create ${fake.id}`);
      return fake;
    },
    dispose: async (fake) => {
      opts.log?.push(`dispose-start ${fake.id}`);
      if (opts.holdDispose) await new Promise<void>((resolve) => disposeWaiters.push(resolve));
      disposed.push(fake);
      opts.log?.push(`dispose-end ${fake.id}`);
    },
  };
  return {
    factory,
    created,
    disposed,
    releaseCreate: () => createWaiters.splice(0).forEach((fn) => fn()),
    releaseDispose: () => disposeWaiters.splice(0).forEach((fn) => fn()),
  };
}

const key = (over: Partial<RuntimeKey> = {}): RuntimeKey => ({
  buildId: "build-a",
  mode: "persistent",
  store: "default",
  source: "default",
  ...over,
});

const identity: ResolvedIdentity = { store: "/cache/store.db", source: "/data/opencode.db" };

beforeEach(() => {
  vi.useFakeTimers();
  resetRuntimeRegistryForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetRuntimeRegistryForTests();
});

describe("runtime registry", () => {
  it("creates nothing synchronously and one runtime for instances sharing a key", async () => {
    const control = makeFactory(identity);
    const a = attachRuntime(key(), control.factory, {}, () => {});
    const b = attachRuntime(key(), control.factory, {}, () => {});
    expect(control.created).toHaveLength(0); // deferred to a macrotask
    await vi.advanceTimersByTimeAsync(0);
    expect(control.created).toHaveLength(1);
    expect(a.current()).toBe(control.created[0]);
    expect(b.current()).toBe(control.created[0]);

    await a.detach();
    expect(control.disposed).toHaveLength(0); // b still holds it
    await b.detach();
    expect(control.disposed).toEqual(control.created);
  });

  it("merges two option spellings of one store path and logs differing shaping options", async () => {
    const control = makeFactory(identity);
    const logs: string[] = [];
    const a = attachRuntime(
      key({ store: "~/x/store.db" }),
      control.factory,
      { coldPass: true },
      () => {},
    );
    const b = attachRuntime(
      key({ store: "/home/u/x/store.db" }),
      control.factory,
      { coldPass: false },
      (line) => logs.push(line),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(control.created).toHaveLength(1);
    expect(await b.ready(10)).toBe(control.created[0]);
    expect(logs).toEqual([
      "options coldPass differ from the runtime this instance shares; using the runtime's values",
    ]);
    await a.detach();
    await b.detach();
    expect(control.disposed).toHaveLength(1);
  });

  it("keeps runtimes apart when the real source differs", async () => {
    const one = makeFactory(identity);
    const two = makeFactory({ ...identity, source: "/data/other.db" });
    const a = attachRuntime(key({ source: "a" }), one.factory, {}, () => {});
    const b = attachRuntime(key({ source: "b" }), two.factory, {}, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(one.created).toHaveLength(1);
    expect(two.created).toHaveLength(1);
    expect(a.current()).not.toBe(b.current());
    await Promise.all([a.detach(), b.detach()]);
  });

  it("never merges an ephemeral instance into a persistent runtime", async () => {
    const persistent = makeFactory(identity);
    const ephemeral = makeFactory({ store: null, source: identity.source });
    const a = attachRuntime(key(), persistent.factory, {}, () => {});
    const b = attachRuntime(
      key({ mode: "ephemeral", store: "none" }),
      ephemeral.factory,
      {},
      () => {},
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(persistent.created).toHaveLength(1);
    expect(ephemeral.created).toHaveLength(1);
    await Promise.all([a.detach(), b.detach()]);
  });

  it("creates nothing when every instance detaches before the deferred init", async () => {
    const control = makeFactory(identity);
    const a = attachRuntime(key(), control.factory, {}, () => {});
    await a.detach();
    await vi.advanceTimersByTimeAsync(10);
    expect(control.created).toHaveLength(0);
    expect(await a.ready(10)).toBeUndefined();
  });

  it("answers ready() with undefined when creation outlasts the wait", async () => {
    const control = makeFactory(identity, { holdCreate: true });
    const a = attachRuntime(key(), control.factory, {}, () => {});
    const pending = a.ready(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toBeUndefined();
    control.releaseCreate();
    await vi.advanceTimersByTimeAsync(0);
    expect(await a.ready(10)).toBe(control.created[0]);
    await a.detach();
  });

  it("bounds an instance's detach when the runtime dispose never settles", async () => {
    const control = makeFactory(identity, { holdDispose: true });
    const a = attachRuntime(key(), control.factory, {}, () => {});
    await vi.advanceTimersByTimeAsync(0);
    let done = false;
    const detaching = a.detach().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(DETACH_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await detaching;
    expect(done).toBe(true);
    expect(control.disposed).toHaveLength(0); // still running, detached
    control.releaseDispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(control.disposed).toHaveLength(1);
  });

  it("a reload waits for the old build's runtime on the same store before creating", async () => {
    const log: string[] = [];
    const old = makeFactory(identity, { holdDispose: true, log });
    const fresh = makeFactory(identity, { log });
    const a = attachRuntime(key({ buildId: "old" }), old.factory, {}, () => {});
    await vi.advanceTimersByTimeAsync(0);
    // Reload: the old cleanup runs first, then the new setup.
    void a.detach();
    const b = attachRuntime(key({ buildId: "new" }), fresh.factory, {}, () => {});
    await vi.advanceTimersByTimeAsync(100);
    expect(fresh.created).toHaveLength(0); // waiting on the old dispose
    old.releaseDispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(fresh.created).toHaveLength(1);
    expect(log.map((line) => line.split(" ")[0])).toEqual([
      "create",
      "dispose-start",
      "dispose-end",
      "create",
    ]);
    await b.detach();
  });

  it("opens anyway when the previous runtime's retirement outlasts the bound", async () => {
    const old = makeFactory(identity, { holdDispose: true });
    const fresh = makeFactory(identity);
    const a = attachRuntime(key({ buildId: "old" }), old.factory, {}, () => {});
    await vi.advanceTimersByTimeAsync(0);
    void a.detach();
    const b = attachRuntime(key({ buildId: "new" }), fresh.factory, {}, () => {});
    await vi.advanceTimersByTimeAsync(RETIRE_WAIT_MS - 10);
    expect(fresh.created).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(fresh.created).toHaveLength(1);
    expect(old.disposed).toHaveLength(0); // never finished; the new one did not care
    await b.detach();
    old.releaseDispose();
  });

  it("a new build coexists with an old one another location still holds", async () => {
    const old = makeFactory(identity);
    const fresh = makeFactory(identity);
    const keep = attachRuntime(key({ buildId: "old" }), old.factory, {}, () => {});
    const b = attachRuntime(key({ buildId: "new" }), fresh.factory, {}, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(old.created).toHaveLength(1);
    expect(fresh.created).toHaveLength(1);
    await b.detach();
    expect(old.disposed).toHaveLength(0);
    await keep.detach();
    expect(old.disposed).toHaveLength(1);
  });

  it("survives interleaved attach and detach across two locations", async () => {
    const control = makeFactory(identity);
    const a = attachRuntime(key(), control.factory, {}, () => {});
    await vi.advanceTimersByTimeAsync(0);
    const b = attachRuntime(key(), control.factory, {}, () => {});
    await a.detach();
    expect(control.disposed).toHaveLength(0);
    expect(b.current()).toBe(control.created[0]);
    await b.detach();
    expect(control.disposed).toHaveLength(1);
    // A later location starts a fresh runtime.
    const c = attachRuntime(key(), control.factory, {}, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(control.created).toHaveLength(2);
    expect(c.current()).toBe(control.created[1]);
    await c.detach();
    // Detach is idempotent.
    await c.detach();
    expect(control.disposed).toHaveLength(2);
  });
});

describe("runtime registry, cross-build state", () => {
  it("ignores a non-thenable another build left in the retiring map", async () => {
    const control = makeFactory(identity);
    // Put something that is not a promise where a retiring dispose would be.
    const a = attachRuntime(key(), control.factory, {}, () => {});
    await vi.advanceTimersByTimeAsync(0);
    await a.detach();
    const runtimes = registry().runtimes as { retiring: Map<string, unknown> };
    runtimes.retiring.set(identity.store!, { stale: true });
    const b = attachRuntime(key({ buildId: "build-b" }), control.factory, {}, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(control.created).toHaveLength(2);
    expect(b.current()).toBe(control.created[1]);
    await b.detach();
  });

  it("creates nothing when the only instance detaches while paths resolve", async () => {
    let finishResolve!: (identity: ResolvedIdentity) => void;
    const control = makeFactory(identity);
    const factory: RuntimeFactory<Fake> = {
      ...control.factory,
      resolve: () => new Promise((resolve) => (finishResolve = resolve)),
    };
    const a = attachRuntime(key(), factory, {}, () => {});
    await vi.advanceTimersByTimeAsync(0); // resolve() is now pending
    await a.detach();
    finishResolve(identity);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.created).toHaveLength(0);
    expect(a.current()).toBeUndefined();
    expect(await a.ready(10)).toBeUndefined();
  });
});

describe("event id dedupe", () => {
  it("passes each id once and forgets the oldest past its size", () => {
    const fresh = createIdDedupe(2);
    expect(fresh("a")).toBe(true);
    expect(fresh("a")).toBe(false);
    expect(fresh("b")).toBe(true);
    expect(fresh("c")).toBe(true); // evicts "a"
    expect(fresh("a")).toBe(true);
    expect(fresh("c")).toBe(false);
  });
});

describe("differingKeys", () => {
  it("compares values structurally", () => {
    expect(differingKeys({ a: 1, b: { x: 1 } }, { a: 1, b: { x: 1 } })).toEqual([]);
    expect(differingKeys({ a: 1 }, { a: 2, c: true })).toEqual(["a", "c"]);
  });
});
