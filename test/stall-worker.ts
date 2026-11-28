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
 * `workerData.stall` is `{ ms, afterTx, rows, flag }`: the `afterTx`-th
 * write transaction the handler opens (default 1, the fence's) holds the
 * thread after its statements and before its COMMIT, for `ms` with
 * `Atomics.wait`, or, with `rows`, for as long as one real SQLite statement
 * takes to count that many rows. `flag`, a `SharedArrayBuffer`, is set to 1
 * (and notified) just before the stall begins. Without `stall` the entry
 * behaves as `dist/distill-worker.js`.
 */

type Stall = { ms?: unknown; afterTx?: unknown; rows?: unknown; flag?: unknown };
const data = workerData as { generation?: unknown; stall?: Stall };
const stallMs = typeof data?.stall?.ms === "number" ? data.stall.ms : undefined;
const stallRows = typeof data?.stall?.rows === "number" ? data.stall.rows : undefined;
const stallAt = typeof data?.stall?.afterTx === "number" ? data.stall.afterTx : 1;
const flag =
  data?.stall?.flag instanceof SharedArrayBuffer ? new Int32Array(data.stall.flag) : undefined;
const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
let transactions = 0;

/** One statement that runs for a while in SQLite itself, never returning
 *  to JavaScript until it ends. */
const LONG_STATEMENT =
  "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT ?) SELECT max(x) AS m FROM c";

async function openStalling(path: string): Promise<SqliteDb | null> {
  const db = await openSqlite(path);
  if (!db || (stallMs === undefined && stallRows === undefined)) return db;
  return {
    ...db,
    tx<T>(fn: () => T): T {
      return db.tx(() => {
        const result = fn();
        transactions++;
        if (transactions === stallAt) {
          if (flag) {
            Atomics.store(flag, 0, 1);
            Atomics.notify(flag, 0);
          }
          if (stallRows !== undefined) db.get(LONG_STATEMENT, [stallRows]);
          else Atomics.wait(cell, 0, 0, stallMs);
        }
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
