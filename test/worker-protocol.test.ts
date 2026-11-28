import { describe, expect, it } from "vitest";
import type { DistillSignal } from "../src/distill.js";
import {
  createEventOutbox,
  isMainMessage,
  isWorkerMessage,
  OUTBOX_SESSIONS,
  PROTOCOL_VERSION,
  transferableBuffers,
  type VectorRow,
} from "../src/worker/protocol.js";

/**
 * The worker protocol's pure parts: the message guards each side applies to
 * what it receives, which vector buffers a write transfers, and main's event
 * outbox, which coalesces signals per session and bounds what it holds.
 */

const MAIN_TYPES = ["init", "events", "vectors", "stop"] as const;
const WORKER_TYPES = [
  "ready",
  "store",
  "status",
  "waiting",
  "ack",
  "log",
  "fatal",
  "reply",
  "stopped",
] as const;

describe("message guards", () => {
  it.each(MAIN_TYPES)("accepts a main %s message only as a main message", (type) => {
    const message = { v: PROTOCOL_VERSION, generation: 3, type };
    expect(isMainMessage(message)).toBe(true);
    expect(isWorkerMessage(message)).toBe(false);
  });

  it.each(WORKER_TYPES)("accepts a worker %s message only as a worker message", (type) => {
    const message = { v: PROTOCOL_VERSION, generation: 3, type };
    expect(isWorkerMessage(message)).toBe(true);
    expect(isMainMessage(message)).toBe(false);
  });

  it.each([
    ["another protocol version", { v: PROTOCOL_VERSION + 1, generation: 1, type: "init" }],
    ["no protocol version", { generation: 1, type: "init" }],
    ["a fractional generation", { v: PROTOCOL_VERSION, generation: 1.5, type: "init" }],
    ["a generation given as a string", { v: PROTOCOL_VERSION, generation: "1", type: "init" }],
    ["no generation", { v: PROTOCOL_VERSION, type: "init" }],
    ["an unknown type", { v: PROTOCOL_VERSION, generation: 1, type: "launch" }],
    ["no type", { v: PROTOCOL_VERSION, generation: 1 }],
    ["null", null],
    ["a string", "init"],
  ])("rejects %s on both sides", (_label, value) => {
    expect(isMainMessage(value)).toBe(false);
    expect(isWorkerMessage(value)).toBe(false);
  });
});

describe("transferableBuffers", () => {
  const row = (embedding: Uint8Array, sessionId = "s"): VectorRow => ({
    sessionId,
    embedding,
    expectedSummaryHash: "",
  });

  it("transfers each embedding that is a whole buffer of its own, in row order", () => {
    const a = new Uint8Array(8);
    const b = new Uint8Array(16);
    expect(transferableBuffers([row(a, "a"), row(b, "b")])).toEqual([a.buffer, b.buffer]);
    const transfer = transferableBuffers([row(a, "a"), row(b, "b")]);
    expect(transfer[0]).toBe(a.buffer);
    expect(transfer[1]).toBe(b.buffer);
  });

  it("copies an embedding that views only part of its buffer", () => {
    const buffer = new ArrayBuffer(32);
    expect(transferableBuffers([row(new Uint8Array(buffer, 8, 8))])).toEqual([]);
    expect(transferableBuffers([row(new Uint8Array(buffer, 0, 16))])).toEqual([]);
  });

  it("copies every embedding over a buffer that two rows share, even whole views", () => {
    const shared = new Uint8Array(8);
    const own = new Uint8Array(8);
    const transfer = transferableBuffers([row(shared, "a"), row(own, "b"), row(shared, "c")]);
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBe(own.buffer);
  });

  it("never transfers a shared memory buffer", () => {
    const embedding = new Uint8Array(new SharedArrayBuffer(8));
    expect(transferableBuffers([row(embedding)])).toEqual([]);
  });
});

describe("the event outbox", () => {
  const turnEnded = (sessionID: string): DistillSignal => ({ type: "turn-ended", sessionID });
  const removal = (sessionID: string): DistillSignal => ({ type: "removal", sessionID });
  const deleted = (sessionID: string): DistillSignal => ({ type: "deleted", sessionID });
  const meta = (
    sessionID: string,
    patch?: Extract<DistillSignal, { type: "meta" }>["patch"],
  ): DistillSignal => ({ type: "meta", sessionID, ...(patch && { patch }) });

  describe("coalescing", () => {
    it("keeps only the deletion of a deleted session, whatever came before or after", () => {
      const outbox = createEventOutbox();
      outbox.add(meta("s1", { title: "renamed" }));
      outbox.add(turnEnded("s1"));
      outbox.add(removal("s1"));
      outbox.add(deleted("s1"));
      outbox.add(turnEnded("s1"));
      outbox.add(meta("s1", { title: "after" }));
      expect(outbox.drain()).toEqual([deleted("s1")]);
    });

    it("merges metadata patches field by field, the later value winning", () => {
      const outbox = createEventOutbox();
      outbox.add(meta("s1", { title: "first", directory: "/a" }));
      outbox.add(meta("s1", { title: "second", timeArchived: 5 }));
      expect(outbox.drain()).toEqual([
        meta("s1", { title: "second", directory: "/a", timeArchived: 5 }),
      ]);
    });

    it("turns turn ends into one re-check, and patchless metadata changes into one patchless meta that stands for it", () => {
      const outbox = createEventOutbox();
      outbox.add(turnEnded("s1"));
      outbox.add(turnEnded("s1"));
      outbox.add(turnEnded("s2"));
      outbox.add(meta("s2"));
      outbox.add(meta("s2", { title: "t" }));
      outbox.add(meta("s2"));
      outbox.add(turnEnded("s2"));
      expect(outbox.drain()).toEqual([turnEnded("s1"), meta("s2", { title: "t" }), meta("s2")]);
    });

    it("drains to signals that, added again, coalesce to the same outbox", () => {
      const outbox = createEventOutbox();
      outbox.add(meta("s1", { title: "t" }));
      outbox.add(meta("s1"));
      outbox.add(removal("s1"));
      outbox.add(turnEnded("s2"));
      outbox.add(deleted("s3"));
      const drained = outbox.drain();
      for (const signal of drained) outbox.add(signal);
      expect(outbox.drain()).toEqual(drained);
    });

    it("keeps a removal, draining a session's patch, removal and re-check in that order", () => {
      const outbox = createEventOutbox();
      outbox.add(turnEnded("s1"));
      outbox.add(removal("s1"));
      outbox.add(meta("s1", { title: "t" }));
      outbox.add(removal("s1"));
      expect(outbox.drain()).toEqual([meta("s1", { title: "t" }), removal("s1"), turnEnded("s1")]);
    });

    it("drains sessions in the order each first arrived and empties itself", () => {
      const outbox = createEventOutbox();
      outbox.add(turnEnded("s2"));
      outbox.add(deleted("s1"));
      outbox.add(turnEnded("s3"));
      outbox.add(meta("s2", { title: "t" }));
      expect(outbox.size()).toBe(3);
      expect(outbox.drain().map((s) => s.sessionID)).toEqual(["s2", "s2", "s1", "s3"]);
      expect(outbox.size()).toBe(0);
      expect(outbox.drain()).toEqual([]);
    });

    it("drains with a limit only whole sessions that fit, the first one always", () => {
      const outbox = createEventOutbox();
      outbox.add(meta("s1", { title: "t" }));
      outbox.add(removal("s1"));
      outbox.add(turnEnded("s1"));
      outbox.add(turnEnded("s2"));
      outbox.add(meta("s3", { title: "u" }));
      outbox.add(turnEnded("s3"));
      expect(outbox.drain(2)).toEqual([meta("s1", { title: "t" }), removal("s1"), turnEnded("s1")]);
      expect(outbox.drain(2)).toEqual([turnEnded("s2")]);
      expect(outbox.size()).toBe(1);
      expect(outbox.drain(2)).toEqual([meta("s3", { title: "u" }), turnEnded("s3")]);
      expect(outbox.size()).toBe(0);
    });

    it("frees the bytes of the sessions a limited drain took", () => {
      // Each re-check costs its id's length plus 32 bytes: three fit in 100.
      const outbox = createEventOutbox({ bytes: 100 });
      outbox.add(turnEnded("a"));
      outbox.add(turnEnded("b"));
      outbox.add(turnEnded("c"));
      expect(outbox.drain(1)).toEqual([turnEnded("a")]);
      outbox.add(turnEnded("d"));
      expect(outbox.dropped()).toBe(0);
      expect(outbox.drain().map((s) => s.sessionID)).toEqual(["b", "c", "d"]);
    });
  });

  describe("bounds", () => {
    it("evicts the oldest session holding no deletion or patch when a new session arrives at the session bound", () => {
      const outbox = createEventOutbox({ sessions: 4 });
      outbox.add(meta("patched", { title: "t" }));
      outbox.add(deleted("gone"));
      outbox.add(removal("removed"));
      outbox.add(turnEnded("ended"));
      outbox.add(turnEnded("new"));
      expect(outbox.dropped()).toBe(1);
      expect(outbox.drain().map((s) => s.sessionID)).toEqual(["patched", "gone", "ended", "new"]);
    });

    it("drops and counts a new session's signal when every session holds a deletion or a patch", () => {
      const outbox = createEventOutbox({ sessions: 2 });
      outbox.add(meta("patched", { title: "t" }));
      outbox.add(deleted("gone"));
      outbox.add(deleted("new"));
      outbox.add(turnEnded("newer"));
      expect(outbox.dropped()).toBe(2);
      // A session already held still takes its signals at the bound.
      outbox.add(turnEnded("patched"));
      expect(outbox.drain()).toEqual([
        meta("patched", { title: "t" }),
        turnEnded("patched"),
        deleted("gone"),
      ]);
    });

    it("evicts at the byte bound as at the session bound", () => {
      // Each re-check costs its id's length plus 32 bytes: three fit in 100.
      const outbox = createEventOutbox({ bytes: 100 });
      outbox.add(turnEnded("a"));
      outbox.add(turnEnded("b"));
      outbox.add(turnEnded("c"));
      expect(outbox.dropped()).toBe(0);
      outbox.add(turnEnded("d"));
      expect(outbox.dropped()).toBe(1);
      expect(outbox.drain().map((s) => s.sessionID)).toEqual(["b", "c", "d"]);
    });

    it("counts a new session's patch toward the byte bound", () => {
      const outbox = createEventOutbox({ bytes: 100 });
      outbox.add(meta("a", { title: "x".repeat(10) }));
      outbox.add(turnEnded("b"));
      // The patch made "a" cost more than a re-check: "c" no longer fits
      // beside both, and "a" holds a patch, so "b" goes.
      outbox.add(turnEnded("c"));
      expect(outbox.dropped()).toBe(1);
      expect(outbox.drain().map((s) => s.sessionID)).toEqual(["a", "c"]);
    });

    it("keeps a metadata change whose merged patch passes the byte bound as a patchless meta", () => {
      const outbox = createEventOutbox({ bytes: 200 });
      outbox.add(turnEnded("a"));
      outbox.add(meta("a", { title: "short" }));
      outbox.add(meta("a", { title: "x".repeat(300) }));
      // A later patch that fits still goes out, beside the re-read.
      outbox.add(meta("a", { directory: "/d" }));
      outbox.add(turnEnded("b"));
      expect(outbox.dropped()).toBe(0);
      expect(outbox.drain()).toEqual([meta("a", { directory: "/d" }), meta("a"), turnEnded("b")]);
    });

    it("keeps a new session's patch larger than the byte bound as a patchless meta", () => {
      const outbox = createEventOutbox({ bytes: 100 });
      outbox.add(turnEnded("b"));
      outbox.add(meta("a", { title: "x".repeat(200) }));
      expect(outbox.dropped()).toBe(0);
      expect(outbox.drain()).toEqual([turnEnded("b"), meta("a")]);
    });

    it("evicts no session that holds a patchless metadata change", () => {
      // Each entry costs its id's length plus 32 bytes: three fit in 100.
      const outbox = createEventOutbox({ bytes: 100 });
      outbox.add(meta("a"));
      outbox.add(turnEnded("b"));
      outbox.add(turnEnded("c"));
      outbox.add(turnEnded("d"));
      expect(outbox.dropped()).toBe(1);
      expect(outbox.drain()).toEqual([meta("a"), turnEnded("c"), turnEnded("d")]);
    });

    it("frees the bytes of a patch a deletion replaced", () => {
      const outbox = createEventOutbox({ bytes: 120 });
      outbox.add(meta("a", { title: "x".repeat(40) }));
      outbox.add(deleted("a"));
      outbox.add(turnEnded("b"));
      outbox.add(turnEnded("c"));
      expect(outbox.dropped()).toBe(0);
      expect(outbox.drain().map((s) => s.sessionID)).toEqual(["a", "b", "c"]);
    });

    it("holds at most OUTBOX_SESSIONS sessions by default", () => {
      const outbox = createEventOutbox();
      for (let i = 0; i <= OUTBOX_SESSIONS; i++) outbox.add(turnEnded(`s${i}`));
      expect(outbox.size()).toBe(OUTBOX_SESSIONS);
      expect(outbox.dropped()).toBe(1);
      const drained = outbox.drain();
      expect(drained[0]?.sessionID).toBe("s1");
      expect(drained.at(-1)?.sessionID).toBe(`s${OUTBOX_SESSIONS}`);
    });
  });
});
