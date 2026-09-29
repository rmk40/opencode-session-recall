import type {
  V2Cleanup,
  V2PluginContext,
  V2Registration,
  V2SessionContextEvent,
  V2ToolContext,
  V2ToolResult,
} from "./opencode-v2-types.js";
import { createFileSink, createLogger, type FileSink, type Logger } from "../log.js";
import { parseOptions, type ResolvedOptions } from "../options.js";
import { errmsg, settleWithin, TOOLS, type ErrorOutput } from "../types.js";
import { NUDGE_BASE_TEXT, NUDGE_SENTINEL } from "../hooks/system-nudge.js";
import { v2ToolContext } from "./tool-io.js";
import {
  buildToolSet,
  startingToolSet,
  v2ToolInfo,
  type ToolName,
  type ToolSet,
} from "./v2-tools.js";
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
 * runtime itself is built on a later macrotask. The only thing `setup` awaits
 * is the host's own (in-memory) tool and hook registration, bounded.
 *
 * What an instance registers:
 *
 * - the five tools, direct (`codemode: false`), each `execute` catching
 *   everything so a failure is always a normal `{ content }` result;
 * - `primary` (default on): a `context` hook removes our tools from requests
 *   of child sessions (`parentID` set) and `execute` refuses there too;
 * - `nudge` (default on): the same `context` hook adds the nudge once per
 *   request, without v1's subagent-recovery clause;
 * - `autoRecall`, `compactionRecall` and `summaries` are not available on v2
 *   yet: enabling one logs a line and changes nothing.
 */

/** How long a tool call waits for a starting runtime. */
export const TOOL_READY_WAIT_MS = 2_000;
/** Bound on awaiting the host's registrations inside `setup`. */
const REGISTRATION_WAIT_MS = 2_000;
/** Parent-lookup cache size (a session's parent never changes). */
const PARENT_CACHE_SIZE = 512;

/** The error a child session gets from our tools under `primary`. */
export const PRIMARY_ONLY_ERROR =
  "recall tools are available to primary agents only (plugin option primary: true)";

/** The v2 log: a file sink (v2 discards plugin console output), opt-in via
 *  `RECALL_DEBUG=1`. Created lazily so a v1 process never builds one. */
let v2Sink: FileSink | undefined;
let v2Logger: Logger | undefined;
function v2LogSink(): FileSink {
  v2Sink ??= createFileSink({ host: "opencode-v2" });
  return v2Sink;
}
export function v2Log(message: string): void {
  v2Logger ??= createLogger(v2LogSink());
  v2Logger(message);
}
/** Test hook: route the v2 log through `sink` (undefined restores the file). */
export function setV2LogSinkForTests(sink: FileSink | undefined): void {
  v2Sink = sink;
  v2Logger = undefined;
}
/** One deadline for an instance cleanup: the runtime detach and the log
 *  flush run concurrently under it. */
export const CLEANUP_WAIT_MS = 3_000;

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
  /** Whether `sessionID` is a child session (true), a root (false), or
   *  unknown (undefined: the lookup failed, which fails open). */
  isChild(sessionID: string): Promise<boolean | undefined>;
};

const instances = new WeakMap<object, V2Instance>();

/** Test hook: the instance `setup` created for a context. */
export function instanceOf(ctx: object): V2Instance | undefined {
  return instances.get(ctx);
}

/** Backoff between event re-subscriptions after the stream fails or ends
 *  (the last value repeats). Mutable for tests. */
export const eventResubscribe = { delaysMs: [1_000, 5_000, 30_000] };

/** Resolve after `ms`, or at once when `signal` aborts. */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Pump the host's event stream into the runtime until aborted. Events that
 * arrive before the runtime exists are dropped: the poll covers them. A stream
 * that fails or ends while the instance is live is re-subscribed after a
 * backoff ({@link eventResubscribe}), with one log line when it drops and one
 * when events flow again. Events are only a latency hint, so a gap costs
 * freshness until the next poll, never correctness.
 */
function pumpEvents(ctx: V2PluginContext, instance: V2Instance, signal: AbortSignal): void {
  const live = (): boolean => !instance.disposed && !signal.aborted;
  void (async () => {
    let failures = 0;
    while (live()) {
      let reason = "ended";
      try {
        for await (const event of ctx.event.subscribe({ signal })) {
          if (!live()) return;
          if (failures > 0) {
            v2Log("event stream resumed");
            failures = 0;
          }
          try {
            instance.attachment.current()?.onEvent(event);
          } catch (error) {
            v2Log(`event handling failed: ${errmsg(error)}`);
          }
        }
      } catch (error) {
        reason = `failed: ${errmsg(error)}`;
      }
      if (!live()) return;
      const delays = eventResubscribe.delaysMs;
      const delay = delays[Math.min(failures, delays.length - 1)] ?? 30_000;
      failures++;
      v2Log(`event stream ${reason}; resubscribing in ${delay}ms`);
      await sleepUnlessAborted(delay, signal);
    }
  })();
}

/** A small insertion-ordered LRU. */
function lru<K, V>(size: number) {
  const map = new Map<K, V>();
  return {
    get(key: K): V | undefined {
      const value = map.get(key);
      if (value !== undefined) {
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },
    set(key: K, value: V): void {
      map.delete(key);
      map.set(key, value);
      if (map.size > size) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    },
  };
}

function errorContent(error: string): V2ToolResult {
  const out: ErrorOutput = { ok: false, error };
  return { content: JSON.stringify(out) };
}

async function start(ctx: V2PluginContext): Promise<V2Cleanup> {
  const parsed = parseOptions(ctx.options);
  for (const warning of parsed.warnings) v2Log(warning);
  if (parsed.autoRecall)
    v2Log("autoRecall is not available on opencode v2 yet; the option is ignored");
  if (parsed.compactionRecall) {
    v2Log("compactionRecall is not available on opencode v2 yet; the option is ignored");
  }

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
  let channel = "latest";
  if (typeof ctx.app?.channel === "string") channel = ctx.app.channel;
  else if (registry().channelFallbackLogged !== true) {
    // On the registry, not the module: v2 re-evaluates this module per
    // location and reload, so module state would log once per location.
    registry().channelFallbackLogged = true;
    v2Log('ctx.app.channel is missing; assuming "latest" to locate opencode.db');
  }
  const attachment = attachRuntime(
    key,
    v2RuntimeFactory({ options, channel, log: v2Log }),
    runtimeShape(options),
    v2Log,
  );

  // Everything after the attach runs guarded: a throw anywhere below must
  // release the attachment, or the runtime would be built and never disposed.
  const events = new AbortController();
  try {
    return await wire(ctx, parsed, attachment, events);
  } catch (error) {
    v2Log(`setup failed after attaching: ${errmsg(error)}`);
    const instance = instances.get(ctx);
    if (instance) instance.disposed = true;
    events.abort();
    await attachment.detach();
    return async () => {};
  }
}

/** Register one instance's hooks, tools and event pump over its attachment. */
async function wire(
  ctx: V2PluginContext,
  parsed: ResolvedOptions,
  attachment: Attachment<V2Runtime>,
  events: AbortController,
): Promise<V2Cleanup> {
  // ── Parent lookups (primary) ──
  const parents = lru<string, string | null>(PARENT_CACHE_SIZE);
  const isChild = async (sessionID: string): Promise<boolean | undefined> => {
    const cached = parents.get(sessionID);
    if (cached !== undefined) return cached !== null;
    let parent: string | null | undefined;
    try {
      // The v2 history source (a primary-key read) when the runtime is up...
      parent = await attachment.current()?.parentOf(sessionID);
    } catch {
      parent = undefined;
    }
    if (parent === undefined) {
      // ...else the host. A failure fails open: tools stay visible, as on v1
      // when the host ignores primary_tools.
      try {
        const info = await ctx.session.get({ sessionID });
        parent = typeof info?.parentID === "string" && info.parentID !== "" ? info.parentID : null;
      } catch {
        return undefined;
      }
    }
    parents.set(sessionID, parent);
    return parent !== null;
  };

  const instance: V2Instance = { attachment, disposed: false, isChild };
  instances.set(ctx, instance);

  pumpEvents(ctx, instance, events.signal);

  // ── Tools ──
  // The registered descriptions and schemas come from this instance's own
  // options. `mode` is part of the runtime key, so it always matches the
  // runtime; limits are first-writer-wins, so an instance joining a runtime
  // with other limits advertises its own values while executing with the
  // runtime's (its differing keys are logged once when it attaches).
  const starting = startingToolSet({
    limits: parsed.limits,
    global: parsed.global,
    ephemeral: parsed.ephemeral,
  });
  let live: { runtime: V2Runtime; tools: ToolSet } | undefined;
  const liveTools = (runtime: V2Runtime): ToolSet => {
    if (live?.runtime !== runtime) {
      live = {
        runtime,
        tools: buildToolSet({
          source: runtime.sourceFor(ctx.location.project.id),
          gate: runtime.gate,
          limits: runtime.options.limits,
          global: parsed.global,
          deps: runtime.deps,
          enrichment: runtime.enrichment,
        }),
      };
    }
    return live.tools;
  };

  const execute = async (
    name: ToolName,
    input: unknown,
    context: V2ToolContext,
  ): Promise<V2ToolResult> => {
    try {
      if (instance.disposed)
        return errorContent("opencode-session-recall: plugin has been disposed");
      if (parsed.primary && (await isChild(context.sessionID)) === true) {
        return errorContent(PRIMARY_ONLY_ERROR);
      }
      const runtime = await attachment.ready(TOOL_READY_WAIT_MS);
      if (instance.disposed)
        return errorContent("opencode-session-recall: plugin has been disposed");
      const toolContext = v2ToolContext(context, ctx.location);
      // The host validated `input` against the zod schema; the tools still
      // coerce defensively (ctx.tool.list() callers bypass validation).
      const args = (input ?? {}) as Parameters<ToolSet[ToolName]["execute"]>[0];
      const result = runtime
        ? await runtime.track(liveTools(runtime)[name].execute(args, toolContext))
        : await starting[name].execute(args, toolContext);
      return { content: typeof result === "string" ? result : JSON.stringify(result) };
    } catch (error) {
      return errorContent(errmsg(error));
    }
  };

  const cleanup: V2Cleanup = async () => {
    try {
      if (instance.disposed) return;
      instance.disposed = true;
      events.abort();
      // The runtime detach (itself bounded, runtime.ts) and flushing queued
      // debug-log lines (RECALL_DEBUG) run together under one deadline, so a
      // location reload waits at most CLEANUP_WAIT_MS however either behaves.
      await settleWithin(
        Promise.allSettled([attachment.detach(), v2LogSink().flush()]),
        CLEANUP_WAIT_MS,
      );
    } catch (error) {
      v2Log(`cleanup failed: ${errmsg(error)}`);
    }
  };

  // Registration must not leak the attachment: whatever fails here, setup
  // still returns the cleanup that releases it.
  try {
    const registrations: Array<Promise<V2Registration>> = [];
    registrations.push(
      ctx.tool.transform((editor) => {
        for (const name of TOOLS) {
          editor.add(
            v2ToolInfo(name, starting[name], (input, context) => execute(name, input, context)),
          );
        }
      }),
    );

    // ── Hooks: primary-only visibility and the nudge ──
    if (parsed.primary || parsed.nudge) {
      registrations.push(
        ctx.session.hook("context", async (event: V2SessionContextEvent) => {
          try {
            if (instance.disposed) return;
            if (parsed.primary && (await isChild(event.sessionID)) === true) {
              for (const name of TOOLS) delete event.tools[name];
              return; // no tools, so no nudge
            }
            if (parsed.nudge && Array.isArray(event.system)) {
              const present = event.system.some(
                (part) => typeof part?.text === "string" && part.text.includes(NUDGE_SENTINEL),
              );
              if (!present) event.system.push({ type: "text", text: NUDGE_BASE_TEXT });
            }
          } catch {
            // A throwing context hook fails the turn; never let one escape.
          }
        }),
      );
    }

    const settled = await settleWithin(Promise.allSettled(registrations), REGISTRATION_WAIT_MS);
    if (settled.timedOut) v2Log("host registration did not settle within its bound; continuing");
    else {
      for (const result of settled.value) {
        if (result.status === "rejected") v2Log(`registration failed: ${errmsg(result.reason)}`);
      }
    }
  } catch (error) {
    v2Log(`registration failed: ${errmsg(error)}`);
  }
  return cleanup;
}

function logSetupFailure(error: unknown): undefined {
  try {
    v2Log(`setup failed: ${errmsg(error)}`);
  } catch {
    // Logging is best-effort.
  }
  return undefined;
}

/**
 * The v2 `setup`. Synchronously `undefined` (inert) unless the context is a
 * v2 host; otherwise a promise of the cleanup that never rejects.
 */
export function setup(ctx: V2PluginContext): Promise<V2Cleanup | undefined> | undefined {
  try {
    if (!isV2HostContext(ctx)) return undefined;
    if (registry().v1ServerActive === true) return undefined;
    // Nothing throws into the host.
    return start(ctx).catch(logSetupFailure);
  } catch (error) {
    return logSetupFailure(error);
  }
}
