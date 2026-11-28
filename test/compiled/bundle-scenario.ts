import { pathToFileURL } from "node:url";
import { fakeV2Host } from "../v2-host.js";

/**
 * Loads the plugin from a built entry the way an opencode v2 host does and
 * runs it over a scratch store and `opencode.db`, in a process of its own:
 * under Node or Bun, from the repository's `server.js` shim or from an
 * installed package. It searches until a needle that only the distilled
 * history holds is found, then prints one JSON line for the check
 * (`bundle.check.ts`) to assert on.
 *
 * Arguments: the entry file, the store path, the `opencode.db` path, the
 * needle and the session id that holds it. Built into `test-dist/` by
 * `npm run build:test-worker`, so it imports nothing of the plugin's sources:
 * the plugin under test is the built entry alone.
 */

type Plugin = { setup(ctx: unknown): Promise<(() => Promise<void>) | undefined> };

type SearchJson = {
  results?: Array<{ sessionID?: string }>;
  coverage?: {
    history?: { distiller?: string };
    cards?: { degraded?: boolean; full?: number };
  };
};

const SEARCH_FOR_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const [entry, storePath, opencodeDbPath, needle, sessionID] = process.argv.slice(2);
  if (!entry || !storePath || !opencodeDbPath || !needle || !sessionID) {
    throw new Error("usage: bundle-scenario <entry> <store> <opencode.db> <needle> <session id>");
  }
  const plugin = ((await import(pathToFileURL(entry).href)) as { default: Plugin }).default;
  const host = fakeV2Host({
    directory: "/w",
    projectID: "prj",
    options: { storePath, opencodeDbPath, coldPass: true },
  });
  const cleanup = await plugin.setup(host.ctx);
  if (!cleanup) throw new Error("setup stayed inert");

  const started = Date.now();
  let last: SearchJson = {};
  let found = false;
  while (Date.now() - started < SEARCH_FOR_MS) {
    const result = await host.runTool("recall", { query: needle, scope: "global" });
    last = JSON.parse(String(result.content)) as SearchJson;
    found = last.results?.some((r) => r.sessionID === sessionID) === true;
    // The drill reads opencode.db itself, so a hit alone proves nothing of
    // the store: its cards must be loaded and distilled in full.
    const cards = last.coverage?.cards;
    if (found && cards?.degraded === false && (cards.full ?? 0) > 0) break;
    await sleep(200);
  }
  await cleanup();
  console.log(
    JSON.stringify({
      distiller: last.coverage?.history?.distiller,
      degraded: last.coverage?.cards?.degraded,
      fullCards: last.coverage?.cards?.full,
      found,
      elapsedMs: Date.now() - started,
    }),
  );
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  },
);
