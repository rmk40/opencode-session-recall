/**
 * The build identity of this bundle: a `tsup` `define` constant set once per
 * `npm run compile` (see `tsup.config.ts`). Re-evaluations of the same build
 * share one v2 runtime; a rebuilt plugin gets fresh code and a fresh runtime.
 * Unbundled code (tests, `tsc` output) sees `"dev"`.
 */
declare const __RECALL_BUILD_ID__: string | undefined;

export const BUILD_ID: string =
  typeof __RECALL_BUILD_ID__ === "string" && __RECALL_BUILD_ID__ !== ""
    ? __RECALL_BUILD_ID__
    : "dev";
