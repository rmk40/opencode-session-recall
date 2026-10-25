import { z } from "zod";
import type { Hooks as LegacyHooks, ToolContext, ToolResult } from "@opencode-ai/plugin";
export type { ToolContext } from "@opencode-ai/plugin";
export type ToolDefinition = ReturnType<typeof tool>;
export type Hooks = Omit<LegacyHooks, "tool"> & { tool?: Record<string, ToolDefinition> };

// Internal engine definition, not a host plugin API. V2 registration converts
// these Zod argument descriptions to JSON Schema in the entrypoint.
export function tool<Args extends z.ZodRawShape>(definition: {
  description: string;
  args: Args;
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>;
}) {
  return definition;
}
tool.schema = z;
