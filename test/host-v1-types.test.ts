import { describe, expectTypeOf, it } from "vitest";
import type {
  Hooks as RealHooks,
  PluginInput as RealPluginInput,
  ToolContext as RealToolContext,
  ToolDefinition as RealToolDefinition,
  ToolResult as RealToolResult,
} from "@opencode-ai/plugin";
import type {
  Hooks,
  PluginInput,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../src/host/opencode-v1-types.js";

/**
 * Conformance of the vendored v1 plugin types (src/host/opencode-v1-types.ts)
 * against the real `@opencode-ai/plugin` (a devDependency). These are
 * compile-time assertions: `npm run test:typecheck` enforces them, and the
 * vitest run only proves the file loads.
 *
 * Our `Hooks` deliberately vendors a subset, so its keys must be a subset of
 * the real keys (a rename upstream fails here) and each hook we register must
 * be assignable to the real hook, so the host can call it with its inputs.
 *
 * Exempt: `ToolDefinition.args` and the first parameter of `execute`. Both are
 * typed over zod, and the vendored types use this package's `zod` while the
 * real ones use the copy nested under `@opencode-ai/plugin`; the two versions'
 * types are not mutually assignable, so comparing them would test zod, not the
 * host contract. The rest of the tool shape is compared.
 */

type Hook<H, K extends keyof H> = NonNullable<H[K]>;

describe("vendored v1 plugin types", () => {
  it("vendors only hook keys the real Hooks declares", () => {
    expectTypeOf<keyof Hooks>().toExtend<keyof RealHooks>();
  });

  it("registers hooks the host can call", () => {
    expectTypeOf<Hook<Hooks, "event">>().toExtend<Hook<RealHooks, "event">>();
    expectTypeOf<Hook<Hooks, "config">>().toExtend<Hook<RealHooks, "config">>();
    expectTypeOf<Hook<Hooks, "dispose">>().toExtend<Hook<RealHooks, "dispose">>();
    expectTypeOf<Hook<Hooks, "chat.message">>().toExtend<Hook<RealHooks, "chat.message">>();
    expectTypeOf<Hook<Hooks, "experimental.chat.system.transform">>().toExtend<
      Hook<RealHooks, "experimental.chat.system.transform">
    >();
    expectTypeOf<Hook<Hooks, "experimental.session.compacting">>().toExtend<
      Hook<RealHooks, "experimental.session.compacting">
    >();
  });

  it("registers tools whose non-zod shape matches the real ToolDefinition", () => {
    // The `tool` hook is a record of definitions; compare one definition.
    type Ours = Hook<Hooks, "tool">[string];
    type Real = Hook<RealHooks, "tool">[string];
    expectTypeOf<Ours>().toEqualTypeOf<ToolDefinition>();
    expectTypeOf<Real>().toEqualTypeOf<RealToolDefinition>();
    expectTypeOf<Omit<Ours, "args" | "execute">>().toEqualTypeOf<Omit<Real, "args" | "execute">>();
    // The host passes its context to execute and awaits its result.
    expectTypeOf<RealToolContext>().toExtend<Parameters<Ours["execute"]>[1]>();
    expectTypeOf<ReturnType<Ours["execute"]>>().toExtend<ReturnType<Real["execute"]>>();
  });

  it("accepts the host's richer context and input", () => {
    expectTypeOf<RealToolContext>().toExtend<ToolContext>();
    expectTypeOf<RealPluginInput>().toExtend<PluginInput>();
  });

  it("returns the same ToolResult", () => {
    // Mutual assignability, not toEqualTypeOf: the real type spells metadata
    // values `any`, the vendored one `unknown` (src/ bans `any`), and
    // expect-type tells the two apart. Every other member is identical.
    expectTypeOf<ToolResult>().toExtend<RealToolResult>();
    expectTypeOf<RealToolResult>().toExtend<ToolResult>();
  });
});
