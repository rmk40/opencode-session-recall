import type { V2Cleanup, V2PluginContext } from "./opencode-v2-types.js";
import { createFileSink, createLogger, type Logger } from "../log.js";
import { registry } from "./registry.js";

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
 * `setup` has no timeout) and must never throw (a throw fails activation).
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

export function setup(ctx: V2PluginContext): V2Cleanup | undefined {
  try {
    if (!isV2HostContext(ctx)) return undefined;
    if (registry().v1ServerActive === true) return undefined;
    v2Log(`v2 host detected at ${ctx.location.directory}; tools are not registered yet`);
    return undefined;
  } catch {
    // Nothing throws into the host.
    return undefined;
  }
}
