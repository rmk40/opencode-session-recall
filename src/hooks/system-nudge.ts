import type { Hooks } from "@opencode-ai/plugin";

/**
 * R1a — system-prompt nudge.
 *
 * Tool descriptions alone do not reliably make a model call `recall`. This hook
 * injects one short instruction into the system prompt so the model proactively
 * searches prior history when the user references past work.
 *
 * Wired on `experimental.chat.system.transform`, whose `output.system` is a
 * string[] that hooks push onto (verified against opencode core:
 * session/llm/request.ts). Injection is idempotent — the same system array may
 * be assembled more than once per session, so we guard on a sentinel.
 */

/** Sentinel substring used to detect an already-injected nudge. */
export const NUDGE_SENTINEL = "[recall-nudge]";

/** Kept short on purpose: it is paid on every request. */
export const NUDGE_TEXT = `${NUDGE_SENTINEL} You have recall tools that search this and prior opencode sessions. When the user refers to earlier work, a previous session, a past decision, or uses vague back-references ("that bug", "same as before", "what did we decide", "like last time"), call recall before answering or re-deriving — the answer may already exist in history.`;

export function systemNudge(): NonNullable<Hooks["experimental.chat.system.transform"]> {
  return async (_input, output) => {
    // Defensive: opencode runs hooks via Effect.promise, where a thrown error
    // becomes an unrecoverable defect that kills the turn. This runs on every
    // request, so it must never throw — guard the array and entry types.
    try {
      if (!Array.isArray(output.system)) return;
      if (
        output.system.some((entry) => typeof entry === "string" && entry.includes(NUDGE_SENTINEL))
      )
        return;
      output.system.push(NUDGE_TEXT);
    } catch {
      // Never disrupt prompt assembly.
    }
  };
}
