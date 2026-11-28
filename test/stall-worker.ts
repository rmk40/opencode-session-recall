import { parentPort, workerData } from "node:worker_threads";
import { openSqlite, type SqliteDb } from "../src/sqlite.js";
import { portOf, runWorkerHandler } from "../src/worker/handler.js";
import type { ThreadPortLike } from "../src/node-import.js";

/**
 * A test-only worker entry: the production handler over a store handle that
 * stalls the thread inside an open write transaction, for the checks that
 * need a worker blocked in SQLite. Built to `test-dist/stall-worker.js` by
 * `npm run build:test-worker`, outside the published `dist/`.
 *
 * `workerData.stall` is `{ ms, afterTx }`: the `afterTx`-th write
 * transaction the handler opens (default 1, the fence's) holds the thread
 * for `ms` with `Atomics.wait`, after its statements and before its COMMIT.
 * Without it the entry behaves as `dist/distill-worker.js`.
 */

const data = workerData as { generation?: unknown; stall?: { ms?: unknown; afterTx?: unknown } };
const stallMs = typeof data?.stall?.ms === "number" ? data.stall.ms : undefined;
const stallAt = typeof data?.stall?.afterTx === "number" ? data.stall.afterTx : 1;
const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
let transactions = 0;

async function openStalling(path: string): Promise<SqliteDb | null> {
  const db = await openSqlite(path);
  if (!db || stallMs === undefined) return db;
  return {
    ...db,
    tx<T>(fn: () => T): T {
      return db.tx(() => {
        const result = fn();
        transactions++;
        if (transactions === stallAt) Atomics.wait(cell, 0, 0, stallMs);
        return result;
      });
    },
  };
}

if (parentPort) {
  runWorkerHandler(portOf(parentPort as unknown as ThreadPortLike), {
    generation: typeof data?.generation === "number" ? data.generation : 0,
    openStoreDb: openStalling,
  });
}
