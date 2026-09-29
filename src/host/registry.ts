/**
 * The process-wide plugin registry, shared through `globalThis`.
 *
 * opencode re-evaluates a local plugin module per location and per reload
 * (v2), and v1.18+ evaluates it once but calls both `server()` and `setup()`.
 * Module-level state is therefore not shared between those calls; this object
 * is. The key carries a version (`@1`): any build of this plugin may find an
 * object written by another build, so every field is optional and read
 * defensively, and a future incompatible layout takes a new key.
 */

export const REGISTRY_KEY = Symbol.for("opencode-session-recall/registry@1");

export type Registry = {
  /** Set by the v1 entry before anything else: a v2-shaped `setup()` call in
   *  the same process is then the v1.18 external-plugin layer, not a v2 host.
   *  A second check only; the capability probe in `host/v2.ts` is the gate. */
  v1ServerActive?: boolean;
  /** Owned by `host/runtime.ts`. */
  runtimes?: unknown;
};

/** The shared registry, created on first use. */
export function registry(): Registry {
  const scope = globalThis as unknown as Record<symbol, unknown>;
  const existing = scope[REGISTRY_KEY];
  if (existing && typeof existing === "object") return existing as Registry;
  const created: Registry = {};
  scope[REGISTRY_KEY] = created;
  return created;
}
