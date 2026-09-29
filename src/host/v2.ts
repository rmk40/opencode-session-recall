import type { V2Cleanup, V2PluginContext } from "./opencode-v2-types.js";
import { createFileSink, createLogger, type Logger } from "../log.js";
import { parseOptions } from "../options.js";
import { errmsg } from "../types.js";
import { BUILD_ID } from "../build-id.js";
import { registry } from "./registry.js";
import { attachRuntime, type Attachment, type RuntimeKey } from "./runtime.js";
import {
  runtimeShape,
  v2RuntimeFactory,
  type V2Runtime,
  type V2RuntimeOptions,
} from "./v2-runtime.js";

/**
 * The v2 host entry (`@opencode/plugin` 2.0.x): `setup(ctx)`.
 *
 * opencode v1.18+ also calls `setup()` on any `{ id, setup }` default export,
 * through its bundled external-plugin layer, with a partial context (no
 * `session`, `tool`, `event` or `location`) and with errors swallowed. So
 * `setup` first runs a capability probe and touches nothing unless the context
 * is a real v2 host. The probe is the gate: v1.18 starts that layer
 * concurrently with the classic loader, so `setup` can in principle run before
 * `server()` marks the registry. `v1ServerActive` is a second check only.
 *
 * `setup` must return fast (prompt admission waits for plugin activation and
 * `setup` has no timeout) and must never throw (a throw fails activation). It
 * attaches to the process runtime synchronously (see `runtime.ts`); the
 * runtime itself is built on a later macrotask.
 */

/** The v2 log: a file sink (v2 discards plugin console output), opt-in via
 *  `RECALL_DEBUG=1`. Created lazily so a v1 process never builds one. */
let v2Logger: Logger | undefined;
export function v2Log(message: string): void {
  v2Logger ??= createLogger(createFileSink({ host: "opencode-v2" }));
  v2Logger(message);
}

function isFunction(value: unknown): boolean {
  return typeof value === "function";
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Whether `ctx` is a v2 host context: `session.hook`, `tool.transform` and
 * `event.subscribe` are functions and `location.directory` is a string. The
 * v1.18 partial context has none of those domains.
 */
export function isV2HostContext(ctx: unknown): ctx is V2PluginContext {
  try {
    return (
      isFunction(field(field(ctx, "session"), "hook")) &&
      isFunction(field(field(ctx, "tool"), "transform")) &&
      isFunction(field(field(ctx, "event"), "subscribe")) &&
      typeof field(field(ctx, "location"), "directory") === "string"
    );
  } catch {
    // A throwing getter is not a host we understand.
    return false;
  }
}

/** One location's plugin instance (test-visible through {@link instanceOf}). */
export type V2Instance = {
  readonly attachment: Attachment<V2Runtime>;
  disposed: boolean;
};

const instances = new WeakMap<object, V2Instance>();

/** Test hook: the instance `setup` created for a context. */
export function instanceOf(ctx: object): V2Instance | undefined {
  return instances.get(ctx);
}

/** Pump the host's event stream into the runtime until aborted. Events that
 *  arrive before the runtime exists are dropped: the poll covers them. */
function pumpEvents(ctx: V2PluginContext, instance: V2Instance, signal: AbortSignal): void {
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal })) {
        if (instance.disposed || signal.aborted) break;
        try {
          instance.attachment.current()?.onEvent(event);
        } catch (error) {
          v2Log(`event handling failed: ${errmsg(error)}`);
        }
      }
    } catch (error) {
      if (!signal.aborted) v2Log(`event stream ended: ${errmsg(error)}`);
    }
  })();
}

function start(ctx: V2PluginContext): V2Cleanup {
  const parsed = parseOptions(ctx.options);
  for (const warning of parsed.warnings) v2Log(warning);

  const options: V2RuntimeOptions = {
    ephemeral: parsed.ephemeral,
    storePath: parsed.storePath,
    opencodeDbPath: parsed.opencodeDbPath,
    semantic: parsed.semantic,
    limits: parsed.limits,
    summaries: parsed.summaries !== undefined,
  };
  const key: RuntimeKey = {
    buildId: BUILD_ID,
    mode: parsed.ephemeral ? "ephemeral" : "persistent",
    store: parsed.ephemeral ? "none" : (parsed.storePath ?? "default"),
    source: parsed.opencodeDbPath ?? "default",
  };
  const channel = typeof ctx.app?.channel === "string" ? ctx.app.channel : "latest";
  const attachment = attachRuntime(
    key,
    v2RuntimeFactory({ options, channel, log: v2Log }),
    runtimeShape(options),
    v2Log,
  );
  const instance: V2Instance = { attachment, disposed: false };
  instances.set(ctx, instance);

  const events = new AbortController();
  pumpEvents(ctx, instance, events.signal);

  return async () => {
    try {
      if (instance.disposed) return;
      instance.disposed = true;
      events.abort();
      // Bounded (runtime.ts): never holds a location reload for long.
      await attachment.detach();
    } catch (error) {
      v2Log(`cleanup failed: ${errmsg(error)}`);
    }
  };
}

export function setup(ctx: V2PluginContext): V2Cleanup | undefined {
  try {
    if (!isV2HostContext(ctx)) return undefined;
    if (registry().v1ServerActive === true) return undefined;
    return start(ctx);
  } catch (error) {
    // Nothing throws into the host.
    try {
      v2Log(`setup failed: ${errmsg(error)}`);
    } catch {
      // Logging is best-effort.
    }
    return undefined;
  }
}
