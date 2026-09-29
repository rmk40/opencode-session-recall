import { z } from "zod";
import type { ToolDefinition } from "./opencode-v1-types.js";
import type { V2ToolInfo } from "./opencode-v2-types.js";
import { sessions, type SessionEnrichment } from "../sessions.js";
import { search, type SearchDeps } from "../search.js";
import { get } from "../get.js";
import { context } from "../context.js";
import { messages } from "../messages.js";
import { createFetchGate, type FetchGate } from "../fetch-gate.js";
import { createCardsRuntime, type CardsRuntime } from "../cards.js";
import { createDrill } from "../drill.js";
import { createUnavailableSource, type HistorySource } from "../history/source.js";
import { TOOLS, type Limits } from "../types.js";

/**
 * The five tools as the v2 host registers them.
 *
 * The tool modules are shared with v1; this module only assembles them over a
 * v2 runtime (or over a stand-in while the runtime is still starting) and
 * converts each into a v2 tool definition.
 */

export type ToolName = (typeof TOOLS)[number];
export type ToolSet = Record<ToolName, ToolDefinition>;

export type ToolSetInputs = {
  source: HistorySource;
  gate: FetchGate;
  limits: Limits;
  /** The instance's `global` option. */
  global: boolean;
  deps: SearchDeps;
  enrichment: SessionEnrichment | undefined;
};

export function buildToolSet(o: ToolSetInputs): ToolSet {
  return {
    recall: search(o.source, o.global, o.limits, o.deps),
    recall_get: get(o.source, o.gate),
    recall_sessions: sessions(o.source, o.global, o.limits, o.enrichment),
    recall_context: context(o.source, o.gate, o.limits),
    recall_messages: messages(o.source, o.gate, o.limits),
  };
}

/** The error a tool reports while the runtime is not ready (tools wait up to
 *  2 s, then answer from the degraded path). */
export const STARTING_REASON = "the recall runtime is still starting; try again shortly";

/** One empty, degraded card runtime shared by every instance's starting
 *  tools: it holds no state, reads nothing and never refreshes, so sharing it
 *  needs no per-instance dispose. */
let sharedStartingCards: CardsRuntime | undefined;
function startingCards(): CardsRuntime {
  sharedStartingCards ??= createCardsRuntime({
    source: { getCards: () => [], revision: () => undefined, degraded: true },
  });
  return sharedStartingCards;
}

/**
 * The tools over a stand-in that reads nothing: registered descriptions and
 * schemas come from here (the runtime is built after `setup` returns), and a
 * call that finds no runtime within the wait answers through it.
 */
export function startingToolSet(o: {
  limits: Limits;
  global: boolean;
  ephemeral: boolean;
}): ToolSet {
  const gate = createFetchGate({ concurrency: 1 });
  const source = createUnavailableSource("v2-sqlite", STARTING_REASON);
  const cards = startingCards();
  const drill = createDrill({ source, gate, limits: o.limits });
  return buildToolSet({
    source,
    gate,
    limits: o.limits,
    global: o.global,
    deps: { gate, store: null, cards, drill, ...(o.ephemeral && { mode: "ephemeral" as const }) },
    enrichment: undefined,
  });
}

/** One tool as a v2 definition: a direct (non-Code-Mode) tool whose input is
 *  the tool's own zod shape. */
export function v2ToolInfo(
  name: ToolName,
  definition: ToolDefinition,
  execute: V2ToolInfo["execute"],
): V2ToolInfo {
  return {
    name,
    description: definition.description,
    input: z.object(definition.args),
    execute,
    options: { codemode: false },
  };
}
