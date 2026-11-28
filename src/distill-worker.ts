import { loadWorkerThreads } from "./node-import.js";
import { portOf, runWorkerHandler } from "./worker/handler.js";

/**
 * The distiller worker's thread entry, built to `dist/distill-worker.js`
 * beside the plugin's entry. It only connects the thread's parent port to the
 * handler (`src/worker/handler.ts`), with the generation main passed in
 * `workerData`. Loaded anywhere but in a worker thread, it does nothing.
 */

const threads = await loadWorkerThreads();
const parent = threads.parentPort;
if (parent) {
  const data = threads.workerData as { generation?: unknown } | null | undefined;
  const generation =
    typeof data?.generation === "number" && Number.isInteger(data.generation) ? data.generation : 0;
  runWorkerHandler(portOf(parent), { generation });
}
