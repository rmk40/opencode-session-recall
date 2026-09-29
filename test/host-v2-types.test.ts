import { describe, expectTypeOf, it } from "vitest";
import type { Plugin } from "@opencode/plugin";
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { EventDomain } from "@opencode/plugin/promise/event";
import type {
  V2Event,
  V2EventDomain,
  V2PluginContext,
  V2SessionContextEvent,
  V2SessionInfo,
  V2StandardSchema,
  V2ToolContext,
  V2ToolEditor,
  V2ToolInfo,
} from "../src/host/opencode-v2-types.js";
import { z } from "zod";
import entry from "../src/opencode-session-recall.js";

/**
 * The vendored v2 types (`src/host/opencode-v2-types.ts`) against the real
 * `@opencode/plugin@2.0.18` declarations. Two directions matter:
 *
 * - what the host hands us (context, tool context, hook events, editors) must
 *   be assignable to the vendored shape, or our code reads fields the host
 *   does not provide;
 * - what we hand the host (the plugin and each tool definition) must be
 *   assignable to the real shape, or the host would reject it.
 */

type HostContext = Parameters<Plugin.Plugin["setup"]>[0];
type HostEvent = HostContext["event"]["subscribe"] extends (
  ...args: never[]
) => AsyncIterable<infer E>
  ? E
  : never;

describe("vendored v2 host types", () => {
  it("accept everything the host passes in", () => {
    expectTypeOf<HostContext>().toExtend<V2PluginContext>();
    expectTypeOf<ToolContext>().toExtend<V2ToolContext>();
    expectTypeOf<ToolEditor>().toExtend<V2ToolEditor>();
    expectTypeOf<SessionContext>().toExtend<V2SessionContextEvent>();
    expectTypeOf<EventDomain>().toExtend<V2EventDomain>();
    expectTypeOf<HostEvent>().toExtend<V2Event>();
    type HostSession = Awaited<ReturnType<HostContext["session"]["get"]>>;
    expectTypeOf<HostSession>().toExtend<V2SessionInfo>();
  });

  it("produce what the host accepts", () => {
    expectTypeOf(entry).toExtend<Plugin.Plugin>();
    expectTypeOf<V2ToolInfo>().toExtend<Info>();
    // Tool inputs are this package's zod schemas.
    expectTypeOf(z.object({ query: z.string() })).toExtend<V2StandardSchema>();
  });
});
