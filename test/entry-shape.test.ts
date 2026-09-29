import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Schema } from "effect";
import entry from "../src/opencode-session-recall.js";
import { isV2HostContext } from "../src/host/v2.js";
import { REGISTRY_KEY, registry } from "../src/host/registry.js";

/**
 * The one default export must load on both hosts.
 */

/**
 * Verbatim copy of opencode v2's plugin module schema
 * (`packages/core/src/plugin/module.ts:60-73` at `96f23508be`), the decode the
 * v2 loader runs on every plugin module. Only the `Schema.declare` type
 * parameters are dropped (they name v2-internal types).
 */
const Module = Schema.Struct({
  default: Schema.Union([
    Schema.Struct({
      id: Schema.String,
      effect: Schema.declare((input): input is unknown => typeof input === "function"),
    }),
    Schema.Struct({
      id: Schema.String,
      setup: Schema.declare((input): input is unknown => typeof input === "function"),
    }),
  ]),
});

/**
 * opencode v1's `readV1Plugin` (`packages/opencode/src/plugin/shared.ts:272-304`
 * on `origin/dev`), reduced to the server-kind rules: the default export must
 * be an object; `server`/`tui`, when present, must be functions and not both;
 * a server plugin needs `server`. Extra keys such as `setup` are ignored.
 */
function readV1Plugin(mod: Record<string, unknown>, spec: string): Record<string, unknown> {
  const value = mod.default;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Plugin ${spec} must default export an object with server()`);
  }
  const record = value as Record<string, unknown>;
  const server = "server" in record ? record.server : undefined;
  const tui = "tui" in record ? record.tui : undefined;
  if (server !== undefined && typeof server !== "function") {
    throw new TypeError(`Plugin ${spec} has invalid server export`);
  }
  if (tui !== undefined && typeof tui !== "function") {
    throw new TypeError(`Plugin ${spec} has invalid tui export`);
  }
  if (server !== undefined && tui !== undefined) {
    throw new TypeError(`Plugin ${spec} must default export either server() or tui(), not both`);
  }
  if (server === undefined) {
    throw new TypeError(`Plugin ${spec} must default export an object with server()`);
  }
  return record;
}

/** A context function that records any call, so a test can prove none ran. */
function spy(): ReturnType<typeof vi.fn> {
  return vi.fn(() => {
    throw new Error("setup must not call into this context");
  });
}

/**
 * The literal partial context opencode v1.18's external-plugin layer passes to
 * `setup` (`packages/core/src/plugin/promise.ts:45-88` on `origin/dev`):
 * `options, agent, aisdk, catalog, command, integration, plugin, reference,
 * skill`, and no `session`, `tool`, `event` or `location`.
 */
function v118PartialContext() {
  const calls = {
    agentTransform: spy(),
    agentReload: spy(),
    sdk: spy(),
    language: spy(),
    catalogTransform: spy(),
    catalogReload: spy(),
    commandTransform: spy(),
    commandReload: spy(),
    integrationTransform: spy(),
    integrationReload: spy(),
    active: spy(),
    resolve: spy(),
    add: spy(),
    remove: spy(),
    referenceTransform: spy(),
    referenceReload: spy(),
    skillTransform: spy(),
    skillReload: spy(),
  };
  const context = {
    options: {},
    agent: { transform: calls.agentTransform, reload: calls.agentReload },
    aisdk: { sdk: calls.sdk, language: calls.language },
    catalog: { transform: calls.catalogTransform, reload: calls.catalogReload },
    command: { transform: calls.commandTransform, reload: calls.commandReload },
    integration: {
      transform: calls.integrationTransform,
      reload: calls.integrationReload,
      connection: { active: calls.active, resolve: calls.resolve },
    },
    plugin: { add: calls.add, remove: calls.remove },
    reference: { transform: calls.referenceTransform, reload: calls.referenceReload },
    skill: { transform: calls.skillTransform, reload: calls.skillReload },
  };
  return { context, calls };
}

describe("dual default export", () => {
  afterEach(() => {
    delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
  });

  it("decodes under opencode v2's Module schema as a setup plugin", () => {
    const decoded = Effect.runSync(Schema.decodeUnknownEffect(Module)({ default: entry }));
    expect(decoded.default.id).toBe("opencode-session-recall");
    expect("setup" in decoded.default && typeof decoded.default.setup).toBe("function");
  });

  it("passes opencode v1's readV1Plugin rules as a server plugin", () => {
    const value = readV1Plugin({ default: entry }, "opencode-session-recall");
    expect(value.id).toBe("opencode-session-recall");
    expect(typeof value.server).toBe("function");
  });

  it("stays inert when replayed with the literal v1.18 partial context", async () => {
    const { context, calls } = v118PartialContext();
    const result = await Promise.resolve(
      entry.setup(context as unknown as Parameters<typeof entry.setup>[0]),
    );
    expect(result).toBeUndefined();
    for (const fn of Object.values(calls)) expect(fn).not.toHaveBeenCalled();
    // Touched nothing process-wide either.
    expect((globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]).toBeUndefined();
  });

  it("never throws out of setup, even for a hostile context", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    expect(() =>
      entry.setup(hostile as unknown as Parameters<typeof entry.setup>[0]),
    ).not.toThrow();
    expect(entry.setup(undefined as unknown as Parameters<typeof entry.setup>[0])).toBeUndefined();
  });
});

describe("v2 capability probe", () => {
  const full = () => ({
    session: { hook: () => {} },
    tool: { transform: () => {} },
    event: { subscribe: () => {} },
    location: { directory: "/workspace/project" },
  });

  it("accepts a context with every domain it needs", () => {
    expect(isV2HostContext(full())).toBe(true);
  });

  it.each([
    ["session.hook", (c: ReturnType<typeof full>) => ({ ...c, session: {} })],
    ["tool.transform", (c: ReturnType<typeof full>) => ({ ...c, tool: {} })],
    ["event.subscribe", (c: ReturnType<typeof full>) => ({ ...c, event: {} })],
    ["location.directory", (c: ReturnType<typeof full>) => ({ ...c, location: {} })],
  ])("rejects a context without %s", (_name, strip) => {
    expect(isV2HostContext(strip(full()))).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isV2HostContext(undefined)).toBe(false);
    expect(isV2HostContext(null)).toBe(false);
    expect(isV2HostContext("ctx")).toBe(false);
  });

  it("shares one registry object across calls", () => {
    const first = registry();
    first.v1ServerActive = true;
    expect(registry()).toBe(first);
    expect(registry().v1ServerActive).toBe(true);
  });
});
