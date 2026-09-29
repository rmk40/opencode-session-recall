import { server } from "./host/v1.js";
import { setup } from "./host/v2.js";

/**
 * One default export for both opencode hosts:
 *
 * - v1 (`@opencode-ai/plugin` 1.3.4+) reads `id` and calls `server(ctx,
 *   options)`; it ignores `setup`.
 * - v2 (`@opencode/plugin` 2.0.x) decodes `{ id, setup }` and ignores
 *   `server`.
 *
 * v1.18+ additionally calls `setup` with a partial context; `setup` detects
 * that and stays inert (see `host/v2.ts`).
 */
export default {
  id: "opencode-session-recall",
  server,
  setup,
};
