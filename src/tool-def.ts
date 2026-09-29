import { z } from "zod";
import type { ToolContext, ToolResult } from "./host/opencode-v1-types.js";

/**
 * Local drop-in for `tool()` from `@opencode-ai/plugin`: an identity function
 * that types a tool definition, with `tool.schema` exposing zod. Built on this
 * package's own `zod` dependency so the bundle imports no host package at
 * runtime.
 */
export function tool<Args extends z.ZodRawShape>(input: {
  description: string;
  args: Args;
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>;
}): {
  description: string;
  args: Args;
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>;
} {
  return input;
}
tool.schema = z;
