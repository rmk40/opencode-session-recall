import { settleWithin } from "../types.js";
import { registry } from "./registry.js";

/**
 * The v2 process runtime registry.
 *
 * opencode v2 runs one plugin instance (one `setup`) per active location, all
 * in one process, and re-evaluates a local plugin module per location and per
 * reload. The expensive, stateful half of the plugin (store, distiller, card
 * runtime, the `opencode.db` read handle) must exist once per process, not
 * once per location, so it lives in a reference-counted runtime held in the
 * `globalThis` registry, and each instance attaches to it.
 *
 * Keys and merging:
 *
 * - An instance attaches synchronously under its *sync key*: `BUILD_ID`,
 *   `mode`, and the store and source identities as spelled in the options
 *   (`default` when unset). Instances with the same key share one slot at
 *   once, before any I/O.
 * - Creation starts on `setTimeout(0)` (a macrotask, so it cannot run before
 *   the host's `await setup()` continues). It resolves the real paths first;
 *   two slots are merged into one runtime only when build, mode, real store
 *   path and real source path all match. Anything else gets its own runtime,
 *   and the store's own fences (lease, host and source stamps) decide how two
 *   runtimes on one file coexist.
 * - Before creating a runtime, creation waits for any retiring runtime on the
 *   same real store (across builds) for at most {@link RETIRE_WAIT_MS}, so a
 *   reload hands the lease over promptly. It is an optimization: on timeout
 *   the new runtime opens anyway, which is as safe as two processes sharing a
 *   store.
 * - The last detach retires the runtime: its dispose starts and the detaching
 *   instance waits for it at most {@link DETACH_WAIT_MS}; the rest continues
 *   in the background.
 *
 * Only the `retiring` map is shared across builds. Everything else is kept per
 * `BUILD_ID`, so two builds never read each other's internal structures.
 */

/** Bound on a new runtime's wait for the previous one on its store. */
export const RETIRE_WAIT_MS = 3_000;
/** Bound on an instance cleanup's wait for its runtime's dispose. */
export const DETACH_WAIT_MS = 3_000;

export type RuntimeKey = {
  buildId: string;
  mode: "persistent" | "ephemeral";
  /** The `storePath` option as coerced, or `default`; `none` in ephemeral
   *  mode (ephemeral runtimes have no store and never merge on one). */
  store: string;
  /** The `opencodeDbPath` option as coerced, or `default`. */
  source: string;
};

/** Real paths, resolved inside the deferred init. `null` means none (no
 *  store in ephemeral mode, or no resolvable source file). `sourceCanonical`
 *  is false when `source` is the path as located because it could not be
 *  canonicalized (typically: `opencode.db` does not exist yet); such a path
 *  may be read, but never stamped into a store. */
export type ResolvedIdentity = {
  store: string | null;
  source: string | null;
  sourceCanonical?: boolean;
};

/** How a runtime is built and torn down; supplied by the attaching instance
 *  (the first instance of a slot supplies the one that runs). */
export type RuntimeFactory<R> = {
  resolve(): Promise<ResolvedIdentity>;
  create(identity: ResolvedIdentity): Promise<R>;
  /** Bounded internally; must never reject. */
  dispose(runtime: R): Promise<void>;
};

export type Attachment<R> = {
  /** The runtime once created, waiting at most `timeoutMs`; undefined on a
   *  timeout, a failed creation, or after {@link detach}. */
  ready(timeoutMs: number): Promise<R | undefined>;
  /** The runtime if it is already created, without waiting. */
  current(): R | undefined;
  /** Release this instance's reference. Resolves once the runtime's dispose
   *  finished or {@link DETACH_WAIT_MS} passed. Idempotent. */
  detach(): Promise<void>;
};

type Core<R> = {
  realKey: string;
  refs: number;
  retired: boolean;
  value: Promise<R | undefined>;
  settled?: R;
  /** Runtime-shaping options of the creating instance (first writer wins). */
  shape: Record<string, unknown>;
  dispose: (runtime: R) => Promise<void>;
  store: string | null;
};

type Slot<R> = {
  key: string;
  refs: number;
  /** Resolves to the core this slot attached to (undefined if init failed). */
  core: Promise<Core<R> | undefined>;
  resolved?: Core<R>;
  /** Shapes of the instances attached before the core was known. */
  pendingShapes: Array<{ shape: Record<string, unknown>; log: (message: string) => void }>;
};

type BuildState = {
  slots: Map<string, Slot<unknown>>;
  cores: Map<string, Core<unknown>>;
};

type RuntimeRegistry = {
  /** Cross-build: real store path → the dispose of the runtime retiring on
   *  it. Every build reads and writes only this map. */
  retiring: Map<string, Promise<void>>;
  builds: Map<string, BuildState>;
};

function runtimeRegistry(): RuntimeRegistry {
  const reg = registry();
  const existing = reg.runtimes as Partial<RuntimeRegistry> | undefined;
  if (existing && existing.retiring instanceof Map && existing.builds instanceof Map) {
    return existing as RuntimeRegistry;
  }
  const created: RuntimeRegistry = { retiring: new Map(), builds: new Map() };
  reg.runtimes = created;
  return created;
}

function buildState(buildId: string): BuildState {
  const reg = runtimeRegistry();
  let state = reg.builds.get(buildId);
  if (!state) {
    state = { slots: new Map(), cores: new Map() };
    reg.builds.set(buildId, state);
  }
  return state;
}

export function syncKeyOf(key: RuntimeKey): string {
  return JSON.stringify([key.buildId, key.mode, key.store, key.source]);
}

function realKeyOf(key: RuntimeKey, identity: ResolvedIdentity): string {
  return JSON.stringify([key.buildId, key.mode, identity.store, identity.source]);
}

/** Names of the runtime-shaping options whose values differ. */
export function differingKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
}

function noteShape<R>(
  core: Core<R>,
  shape: Record<string, unknown>,
  log: (message: string) => void,
): void {
  const differing = differingKeys(core.shape, shape);
  if (differing.length > 0) {
    log(
      `options ${differing.join(", ")} differ from the runtime this instance shares; using the runtime's values`,
    );
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Run `fn` on the next macrotask. */
function nextMacrotask(fn: () => void): void {
  setTimeout(fn, 0);
}

function retire<R>(state: BuildState, core: Core<R>): Promise<void> {
  core.retired = true;
  if (state.cores.get(core.realKey) === (core as Core<unknown>)) state.cores.delete(core.realKey);
  for (const [key, slot] of state.slots) {
    if (slot.resolved === (core as Core<unknown>)) state.slots.delete(key);
  }
  const disposal = core.value
    .then((runtime) => (runtime ? core.dispose(runtime) : undefined))
    .catch(() => {
      // dispose never rejects by contract; a stray rejection is not ours to surface.
    });
  if (core.store !== null) {
    const retiring = runtimeRegistry().retiring;
    const store = core.store;
    retiring.set(store, disposal);
    void disposal.then(() => {
      if (retiring.get(store) === disposal) retiring.delete(store);
    });
  }
  return disposal;
}

/**
 * Attach an instance. Synchronous: the returned attachment is usable at once
 * and creation (if this is the first instance of its slot) starts on the next
 * macrotask. `shape` holds the instance's runtime-shaping options; an
 * instance that joins a runtime with different values logs the differing keys
 * once and runs with the runtime's values.
 */
export function attachRuntime<R>(
  key: RuntimeKey,
  factory: RuntimeFactory<R>,
  shape: Record<string, unknown>,
  log: (message: string) => void,
): Attachment<R> {
  const state = buildState(key.buildId);
  const syncKey = syncKeyOf(key);
  let slot = state.slots.get(syncKey) as Slot<R> | undefined;
  if (!slot) {
    let settle!: (core: Core<R> | undefined) => void;
    const created: Slot<R> = {
      key: syncKey,
      refs: 0,
      core: new Promise((resolve) => (settle = resolve)),
      pendingShapes: [],
    };
    slot = created;
    state.slots.set(syncKey, created as Slot<unknown>);
    nextMacrotask(() => {
      void initSlot(state, key, created, factory, shape).then(settle, () => settle(undefined));
    });
  }
  const own = slot;
  own.refs++;
  if (own.resolved) {
    own.resolved.refs++;
    noteShape(own.resolved, shape, log);
  } else {
    own.pendingShapes.push({ shape, log });
  }

  let detached = false;
  let detachPromise: Promise<void> | undefined;

  const coreNow = (): Core<R> | undefined =>
    own.resolved && !own.resolved.retired ? own.resolved : undefined;

  return {
    async ready(timeoutMs) {
      if (detached) return undefined;
      const wait = own.core.then((core) => (core && !core.retired ? core.value : undefined));
      const result = await settleWithin(wait, Math.max(0, timeoutMs));
      if (detached || result.timedOut) return undefined;
      return result.value;
    },
    current() {
      return detached ? undefined : coreNow()?.settled;
    },
    detach() {
      if (detachPromise) return detachPromise;
      detached = true;
      own.refs--;
      let disposal: Promise<void> | undefined;
      if (own.resolved) {
        own.resolved.refs--;
        if (own.resolved.refs <= 0 && !own.resolved.retired) {
          disposal = retire(state, own.resolved);
        }
      }
      if (own.refs <= 0 && state.slots.get(syncKey) === (own as Slot<unknown>)) {
        state.slots.delete(syncKey);
      }
      detachPromise = disposal
        ? settleWithin(disposal, DETACH_WAIT_MS).then(() => undefined)
        : Promise.resolve();
      return detachPromise;
    },
  };
}

async function initSlot<R>(
  state: BuildState,
  key: RuntimeKey,
  slot: Slot<R>,
  factory: RuntimeFactory<R>,
  shape: Record<string, unknown>,
): Promise<Core<R> | undefined> {
  // Every instance detached before creation began: nothing to build.
  if (slot.refs <= 0) return undefined;
  const identity = await factory.resolve();
  // Every instance detached while the paths resolved: still nothing to build.
  if (slot.refs <= 0) return undefined;
  const realKey = realKeyOf(key, identity);
  let core = state.cores.get(realKey) as Core<R> | undefined;
  if (!core || core.retired) {
    const created: Core<R> = {
      realKey,
      refs: 0,
      retired: false,
      shape,
      store: identity.store,
      dispose: factory.dispose,
      value: Promise.resolve(undefined),
    };
    created.value = (async () => {
      if (identity.store !== null) {
        // The retiring map is shared across builds, so validate what another
        // build left there before awaiting it: only a thenable is waited on.
        const previous: unknown = runtimeRegistry().retiring.get(identity.store);
        if (isThenable(previous)) await settleWithin(Promise.resolve(previous), RETIRE_WAIT_MS);
      }
      const runtime = await factory.create(identity);
      created.settled = runtime;
      return runtime;
    })().catch(() => undefined);
    core = created;
    state.cores.set(realKey, created as Core<unknown>);
  }
  core.refs += slot.refs;
  slot.resolved = core;
  for (const pending of slot.pendingShapes.splice(0)) noteShape(core, pending.shape, pending.log);
  // Defensive: a core left with no references is retired, never kept.
  if (core.refs <= 0 && !core.retired) void retire(state, core);
  return core;
}

// ── Event dedupe ─────────────────────────────────────────────────────────────

/** Default size of the event-id dedupe window. */
export const EVENT_DEDUPE_SIZE = 4_096;

/**
 * A bounded set of recently seen ids (insertion-ordered eviction). With v2's
 * currently global event delivery, N active locations deliver each event N
 * times; a missed dedupe only costs a redundant, debounced re-distill.
 */
export function createIdDedupe(size = EVENT_DEDUPE_SIZE): (id: string) => boolean {
  const seen = new Set<string>();
  return (id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > size) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  };
}

/** Test-only: forget every runtime and retirement in this process. */
export function resetRuntimeRegistryForTests(): void {
  registry().runtimes = undefined;
}
