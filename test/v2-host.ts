/**
 * A fake opencode v2 plugin context for driving `setup()` in tests: it
 * captures `tool.transform` editor calls and `session.hook` callbacks so tests
 * can invoke them, exposes an event stream tests push into, and records
 * `session.get` calls.
 */
import type {
  V2Event,
  V2PluginContext,
  V2Registration,
  V2SessionContextEvent,
  V2SessionInfo,
  V2ToolContext,
  V2ToolEditor,
  V2ToolInfo,
  V2ToolResult,
} from "../src/host/opencode-v2-types.js";

/** An async iterable tests push events into; `end()` finishes it. */
export type EventStream = AsyncIterable<V2Event> & {
  push(event: V2Event): void;
  end(): void;
  /** How many subscribers are currently iterating. */
  readonly active: number;
};

export function eventStream(): EventStream {
  const listeners = new Set<(event: V2Event | null) => void>();
  return {
    push(event) {
      for (const listener of listeners) listener(event);
    },
    end() {
      for (const listener of listeners) listener(null);
    },
    get active() {
      return listeners.size;
    },
    [Symbol.asyncIterator]() {
      const queue: Array<V2Event | null> = [];
      let wake: (() => void) | undefined;
      const listener = (event: V2Event | null): void => {
        queue.push(event);
        wake?.();
      };
      listeners.add(listener);
      return {
        async next(): Promise<IteratorResult<V2Event>> {
          while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
          const event = queue.shift();
          if (event === null || event === undefined) {
            listeners.delete(listener);
            return { done: true, value: undefined };
          }
          return { done: false, value: event };
        },
        async return(): Promise<IteratorResult<V2Event>> {
          listeners.delete(listener);
          return { done: true, value: undefined };
        },
      };
    },
  };
}

export type FakeV2Host = {
  ctx: V2PluginContext;
  /** Every tool added through `tool.transform`, by name (last add wins). */
  tools: Map<string, V2ToolInfo>;
  /** Tool names removed through the editor. */
  removed: string[];
  transformCalls: number;
  /** Registered hook callbacks by hook name. */
  hooks: Map<string, Array<(input: unknown) => Promise<void> | void>>;
  events: EventStream;
  sessionGets: string[];
  /** Replay the transform callbacks against a fresh editor. */
  rebuildTools(): void;
  /** Run a registered tool the way the host does. */
  runTool(name: string, input: unknown, context?: Partial<V2ToolContext>): Promise<V2ToolResult>;
  /** Run every `context` hook over an event and return it. */
  runContext(
    event: Partial<V2SessionContextEvent> & { sessionID: string },
  ): Promise<V2SessionContextEvent>;
};

export type FakeV2HostOptions = {
  directory?: string;
  projectID?: string;
  options?: Record<string, unknown>;
  channel?: string;
  /** Resolve `session.get`; default: a root session. */
  sessionGet?: (sessionID: string) => Promise<V2SessionInfo>;
  events?: EventStream;
};

const registration = (): Promise<V2Registration> =>
  Promise.resolve({ dispose: () => Promise.resolve() });

export function fakeV2Host(opts: FakeV2HostOptions = {}): FakeV2Host {
  const directory = opts.directory ?? "/workspace/project";
  const tools = new Map<string, V2ToolInfo>();
  const removed: string[] = [];
  const hooks = new Map<string, Array<(input: unknown) => Promise<void> | void>>();
  const transforms: Array<(editor: V2ToolEditor) => void> = [];
  const events = opts.events ?? eventStream();
  const sessionGets: string[] = [];
  let transformCalls = 0;

  const editor: V2ToolEditor = {
    add: (tool) => {
      tools.set(tool.name, tool);
    },
    remove: (id) => {
      removed.push(id);
      tools.delete(id);
    },
  };

  const ctx: V2PluginContext = {
    app: { name: "opencode", version: "2.0.18", channel: opts.channel ?? "latest" },
    location: {
      directory,
      project: {
        id: opts.projectID ?? "prj_test",
        directory,
        canonical: directory,
      },
    },
    options: opts.options ?? {},
    event: { subscribe: () => events },
    session: {
      hook: (name, callback) => {
        const list = hooks.get(name as string) ?? [];
        list.push(callback as (input: unknown) => Promise<void> | void);
        hooks.set(name as string, list);
        return registration();
      },
      get: async ({ sessionID }) => {
        sessionGets.push(sessionID);
        return opts.sessionGet ? opts.sessionGet(sessionID) : { id: sessionID };
      },
    },
    tool: {
      transform: (callback) => {
        transformCalls++;
        transforms.push(callback);
        callback(editor);
        return registration();
      },
    },
  };

  const host: FakeV2Host = {
    ctx,
    tools,
    removed,
    get transformCalls() {
      return transformCalls;
    },
    hooks,
    events,
    sessionGets,
    rebuildTools() {
      tools.clear();
      for (const transform of transforms) transform(editor);
    },
    async runTool(name, input, context = {}) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`no tool ${name}`);
      return tool.execute(input, {
        sessionID: "ses_current",
        agent: "build",
        messageID: "msg_current",
        id: "call_1",
        signal: new AbortController().signal,
        progress: async () => {},
        ...context,
      });
    },
    async runContext(partial) {
      const event: V2SessionContextEvent = {
        agent: "build",
        system: [],
        tools: Object.fromEntries([...tools.keys()].map((name) => [name, {}])),
        ...partial,
      };
      for (const callback of hooks.get("context") ?? []) await callback(event);
      return event;
    },
  };
  return host;
}
