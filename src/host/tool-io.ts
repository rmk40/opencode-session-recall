import type { ToolContext } from "./opencode-v1-types.js";
import type { V2Location, V2ToolContext } from "./opencode-v2-types.js";

/**
 * The tool I/O seam between the hosts. The tool modules are written against
 * the v1 `ToolContext`; the v1 host passes its own straight through. The v2
 * host has no `directory`/`worktree` on the tool context (the instance's
 * location stands in for them: its directory equals the calling session's)
 * and no title channel, so `metadata({ title })` is a no-op there, and it
 * never asks permission through a tool.
 */
export function v2ToolContext(context: V2ToolContext, location: V2Location): ToolContext {
  return {
    sessionID: context.sessionID,
    messageID: context.messageID,
    agent: context.agent,
    directory: location.directory,
    worktree: location.project.directory,
    abort: context.signal,
    metadata: () => {},
    ask: async () => {},
  };
}
