import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DistillSignal } from "../src/distill.js";
import { createV2EventMapper, STEP_THROTTLE_MS } from "../src/history/v2-events.js";

/** opencode v2 bus events → distiller signals. */

let signals: DistillSignal[];
let mapper: ReturnType<typeof createV2EventMapper>;

beforeEach(() => {
  vi.useFakeTimers();
  signals = [];
  mapper = createV2EventMapper({ emit: (signal) => signals.push(signal), now: Date.now });
});

afterEach(() => {
  mapper.dispose();
  vi.useRealTimers();
});

const ev = (type: string, data: Record<string, unknown> = {}) => ({
  type,
  data: { sessionID: "ses_1", ...data },
});

describe("v2 event mapper", () => {
  it.each([
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
    "session.compaction.ended",
  ])("%s ends a turn", (type) => {
    mapper.map(ev(type));
    expect(signals).toEqual([{ type: "turn-ended", sessionID: "ses_1" }]);
  });

  it("maps revert, delete and fork", () => {
    mapper.map(ev("session.revert.committed", { to: "msg_1" }));
    mapper.map(ev("session.deleted"));
    mapper.map(ev("session.forked", { sessionID: "ses_fork", parentID: "ses_1" }));
    expect(signals).toEqual([
      { type: "removal", sessionID: "ses_1" },
      { type: "deleted", sessionID: "ses_1" },
      { type: "removal", sessionID: "ses_fork" },
    ]);
  });

  it("patches metadata on rename and move", () => {
    mapper.map(ev("session.renamed", { title: "New title" }));
    mapper.map(
      ev("session.moved", { location: { directory: "/workspace/b" }, projectID: "prj_b" }),
    );
    mapper.map(ev("session.moved", {}));
    expect(signals).toEqual([
      { type: "meta", sessionID: "ses_1", patch: { title: "New title" } },
      {
        type: "meta",
        sessionID: "ses_1",
        patch: { directory: "/workspace/b", projectId: "prj_b" },
      },
      { type: "meta", sessionID: "ses_1" },
    ]);
  });

  it("re-distills on archive and unarchive, which carry no archive time", () => {
    mapper.map(ev("session.archived", { time: 5_000 }));
    mapper.map(ev("session.unarchived"));
    mapper.map({ type: "session.archived", data: {} });
    expect(signals).toEqual([
      { type: "meta", sessionID: "ses_1" },
      { type: "meta", sessionID: "ses_1" },
    ]);
  });

  it("ignores other events and events without a session", () => {
    mapper.map(ev("session.text.delta", { text: "x" }));
    mapper.map({ type: "session.execution.succeeded", data: {} });
    mapper.map({ type: "server.connected" });
    expect(signals).toEqual([]);
  });

  it("throttles step.ended per session: leading, then one trailing signal", async () => {
    mapper.map(ev("session.step.ended"));
    mapper.map(ev("session.step.ended"));
    mapper.map(ev("session.step.ended"));
    mapper.map(ev("session.step.ended", { sessionID: "ses_2" }));
    expect(signals).toEqual([
      { type: "turn-ended", sessionID: "ses_1" },
      { type: "turn-ended", sessionID: "ses_2" },
    ]);
    await vi.advanceTimersByTimeAsync(STEP_THROTTLE_MS - 1);
    expect(signals).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals).toEqual([
      { type: "turn-ended", sessionID: "ses_1" },
      { type: "turn-ended", sessionID: "ses_2" },
      { type: "turn-ended", sessionID: "ses_1" },
    ]);
  });

  it("a finished turn supersedes a pending trailing step", async () => {
    mapper.map(ev("session.step.ended"));
    mapper.map(ev("session.step.ended"));
    mapper.map(ev("session.execution.succeeded"));
    await vi.advanceTimersByTimeAsync(STEP_THROTTLE_MS * 2);
    expect(signals).toEqual([
      { type: "turn-ended", sessionID: "ses_1" },
      { type: "turn-ended", sessionID: "ses_1" },
    ]);
  });

  it("emits nothing after dispose", async () => {
    mapper.map(ev("session.step.ended"));
    mapper.map(ev("session.step.ended"));
    mapper.dispose();
    await vi.advanceTimersByTimeAsync(STEP_THROTTLE_MS);
    mapper.map(ev("session.deleted"));
    expect(signals).toHaveLength(1);
  });
});
