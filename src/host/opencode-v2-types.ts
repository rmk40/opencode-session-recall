/**
 * Vendored structural types for the opencode v2 server plugin host (the
 * promise API of `@opencode/plugin`).
 *
 * Why vendored: `@opencode/plugin` pulls `effect` and the `@opencode/schema`
 * workspace packages, none of which this plugin should depend on at runtime or
 * reference from its emitted `.d.ts`. The host calls `setup(context)` with
 * plain objects and functions, so the contract is structural and only the
 * subset `src/` touches is copied here. Checked against opencode `v2` at
 * commit `96f23508be` (`@opencode/plugin@2.0.18`):
 *
 * - `packages/plugin/src/promise/{plugin,session,tool,event,registration}.ts`
 * - `packages/schema/src/{tool,location}.ts`
 * - `packages/core/src/plugin/host.ts` (the `session.get` and `event`
 *   bindings)
 *
 * `test/host-v2-types.test.ts` asserts the real types stay assignable to these
 * (the host passes the richer real objects in) and that our plugin and tool
 * definitions stay assignable to the real ones. Re-verify whenever the pinned
 * devDependency moves.
 */

// ── Registration primitives (promise/registration.ts) ────────────────────────

export interface V2Registration {
  readonly dispose: () => Promise<void>;
}

/** Register an editor callback; the host replays it on every rebuild. */
export type V2Transform<Draft> = (callback: (draft: Draft) => void) => Promise<V2Registration>;

/** `Hooks`/`ModelHooks` without the provider-scoping option (unused here). */
export type V2Hooks<Spec> = <Name extends keyof Spec>(
  name: Name,
  callback: (input: Spec[Name]) => Promise<void> | void,
) => Promise<V2Registration>;

// ── App and location (plugin/src/app.ts, schema/src/location.ts) ─────────────

export interface V2App {
  readonly name: string;
  readonly version: string;
  /** The build channel (`OPENCODE_CHANNEL`); picks the database filename. */
  readonly channel: string;
}

export interface V2Location {
  /** The instance's directory; equal to the calling session's directory. */
  readonly directory: string;
  readonly project: {
    /** The opencode project id (`session_v2.project_id`). */
    readonly id: string;
    readonly directory: string;
    readonly canonical: string;
  };
}

// ── Tools (promise/tool.ts, schema/src/tool.ts) ──────────────────────────────

export interface V2ToolContext {
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  /** The tool call id. */
  readonly id: string;
  readonly signal: AbortSignal;
  readonly progress: (update: Readonly<Record<string, unknown>>) => Promise<void>;
}

export interface V2ToolResult {
  /** Reaches the model verbatim. */
  readonly content?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** `Tool.Options`, the branch this plugin uses: a direct (non-Code-Mode)
 *  tool sets `codemode: false`. */
export interface V2ToolOptions {
  readonly codemode: false;
}

/** Standard Schema v1 (`@standard-schema/spec`), which zod 4 schemas
 *  implement. */
export type V2StandardResult =
  | { readonly value: unknown; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> };

export interface V2StandardSchema {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => V2StandardResult | Promise<V2StandardResult>;
  };
}

export interface V2ToolInfo {
  readonly name: string;
  readonly description: string;
  /** A zod 4 schema; the host validates input against it and applies its
   *  defaults before `execute` (defensive coercion stays: `ctx.tool.list()`
   *  callers bypass validation). */
  readonly input: V2StandardSchema;
  readonly execute: (input: unknown, context: V2ToolContext) => Promise<V2ToolResult>;
  readonly options?: V2ToolOptions;
}

export interface V2ToolEditor {
  add(tool: V2ToolInfo): void;
  remove(id: string): void;
}

export interface V2ToolDomain {
  readonly transform: V2Transform<V2ToolEditor>;
}

// ── Sessions (promise/session.ts) ────────────────────────────────────────────

/** `LLM.SystemPart`. */
export interface V2SystemPart {
  readonly type: "text";
  readonly text: string;
}

/** The `context` hook event: every primary model request of the agent loop.
 *  Edits are not persisted. */
export interface V2SessionContextEvent {
  readonly sessionID: string;
  readonly agent: string;
  system: V2SystemPart[];
  /** Deleting a key removes that tool from this request. */
  tools: Record<string, unknown>;
}

export interface V2SessionHooksSpec {
  readonly context: V2SessionContextEvent;
}

/** The fields of `session.get`'s result this plugin reads. A root session
 *  carries no `parentID` key. */
export interface V2SessionInfo {
  readonly id: string;
  readonly parentID?: string;
}

export interface V2SessionDomain {
  readonly hook: V2Hooks<V2SessionHooksSpec>;
  readonly get: (input: { sessionID: string }) => Promise<V2SessionInfo>;
}

// ── Events (promise/event.ts, protocol/src/groups/event.ts) ──────────────────

/** One bus event, encoded. Session events carry `data.sessionID`. */
export interface V2Event {
  readonly id: string;
  readonly type: string;
  readonly data?: unknown;
}

export interface V2EventDomain {
  readonly subscribe: (options?: { readonly signal?: AbortSignal }) => AsyncIterable<V2Event>;
}

// ── Plugin (promise/plugin.ts) ───────────────────────────────────────────────

/** The subset of the promise-API `Context` this plugin reads. */
export interface V2PluginContext {
  readonly app: V2App;
  readonly location: V2Location;
  /** Raw plugin config JSON (`Readonly<Record<string, any>>` upstream). */
  readonly options: Readonly<Record<string, unknown>>;
  readonly event: V2EventDomain;
  readonly session: V2SessionDomain;
  readonly tool: V2ToolDomain;
}

export type V2Cleanup = () => Promise<void> | void;

export interface V2Plugin {
  readonly id: string;
  readonly setup: (context: V2PluginContext) => Promise<V2Cleanup | void> | V2Cleanup | void;
}
