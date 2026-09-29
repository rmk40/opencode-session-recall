import { defineConfig } from "tsup";

/**
 * Only the build-time constants live here; the entry, format and externals
 * stay on the `compile` script's command line. `__RECALL_BUILD_ID__` changes
 * on every build (see src/build-id.ts), so a reloaded, rebuilt plugin never
 * attaches to a runtime created by older code in the same process.
 */
const buildId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export default defineConfig({
  define: { __RECALL_BUILD_ID__: JSON.stringify(buildId) },
});
