import type { CardVectorWriter, CardVectorWriteResult, CardVectorWriteRow } from "../src/cards.js";
import type { Store } from "../src/store.js";

/** One write the fake writer was handed and has not answered yet. */
export type PendingVectorWrite = {
  model: string;
  gen: number;
  rows: CardVectorWriteRow[];
  /** Answer the write with `result`. */
  ack(result: CardVectorWriteResult): void;
  /** Write the rows through the store the writer was made with, now, and
   *  answer with what the store reported. Throws without a store. */
  commit(): CardVectorWriteResult;
  /** Answer the write as failed. */
  fail(error?: string): void;
  /** Answer the write as refused. */
  refuse(reason?: string): void;
  /** Reject the write's promise, as a writer that throws would. */
  reject(error: unknown): void;
};

export type FakeVectorWriter = {
  /** The writer to hand a card source as `writeEmbeddings`. */
  write: CardVectorWriter;
  /** Writes handed to it and not answered yet, oldest first. */
  pending: PendingVectorWrite[];
  /** Every write handed to it, answered or not, oldest first. */
  calls: Array<{ model: string; gen: number; rows: CardVectorWriteRow[] }>;
  /** The oldest pending write; throws when there is none. */
  next(): PendingVectorWrite;
  /** Commit every pending write in order, including writes issued while it
   *  runs, waiting a turn between them so the runtime issues the next one.
   *  Returns how many it committed. */
  drain(): Promise<number>;
};

/**
 * A {@link CardVectorWriter} whose acknowledgements the test gives: each call
 * returns a promise that stays pending until the test answers it, as a writer
 * that posts each write to another thread does. With `store`, `commit()`
 * writes through `store.writeCardEmbeddings` at the moment the test calls it,
 * so a test can place the commit and the acknowledgement apart.
 */
export function fakeVectorWriter(store?: Pick<Store, "writeCardEmbeddings">): FakeVectorWriter {
  const pending: PendingVectorWrite[] = [];
  const calls: FakeVectorWriter["calls"] = [];
  const write: CardVectorWriter = (model, gen, rows) => {
    calls.push({ model, gen, rows });
    return new Promise<CardVectorWriteResult>((resolve, rejectPromise) => {
      const entry: PendingVectorWrite = {
        model,
        gen,
        rows,
        ack(result) {
          const i = pending.indexOf(entry);
          if (i >= 0) pending.splice(i, 1);
          resolve(result);
        },
        commit() {
          if (!store) throw new Error("fakeVectorWriter: commit() needs a store");
          const written = store.writeCardEmbeddings(model, gen, rows);
          const result: CardVectorWriteResult = written.committed
            ? { status: "committed", revision: written.revision }
            : { status: "refused", reason: "lower generation" };
          entry.ack(result);
          return result;
        },
        fail(error = "failed") {
          entry.ack({ status: "failed", error });
        },
        refuse(reason = "refused") {
          entry.ack({ status: "refused", reason });
        },
        reject(error) {
          const i = pending.indexOf(entry);
          if (i >= 0) pending.splice(i, 1);
          rejectPromise(error);
        },
      };
      pending.push(entry);
    });
  };
  const next = (): PendingVectorWrite => {
    const first = pending[0];
    if (!first) throw new Error("fakeVectorWriter: no pending write");
    return first;
  };
  const drain = async (): Promise<number> => {
    let committed = 0;
    for (let idle = 0; idle < 3; ) {
      const first = pending[0];
      if (!first) {
        idle++;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        continue;
      }
      idle = 0;
      first.commit();
      committed++;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return committed;
  };
  return { write, pending, calls, next, drain };
}
