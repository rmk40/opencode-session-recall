import { describe, expect, it } from "vitest";
import type { Event, Part } from "@opencode-ai/sdk/v2";
import { v1EventToSignal } from "../src/history/v1-events.js";
import { completedToolPart, textPart } from "./helpers.js";

const event = (type: string, properties: Record<string, unknown>): Event =>
  ({ type, properties }) as unknown as Event;

const partUpdated = (part: Part): Event => event("message.part.updated", { sessionID: "s1", part });

describe("v1EventToSignal", () => {
  it("maps session.idle to turn-ended", () => {
    expect(v1EventToSignal(event("session.idle", { sessionID: "s1" }))).toEqual({
      type: "turn-ended",
      sessionID: "s1",
    });
  });

  it.each(["session.compacted", "message.removed", "message.part.removed"])(
    "maps %s to removal",
    (type) => {
      expect(
        v1EventToSignal(event(type, { sessionID: "s1", messageID: "m", partID: "p" })),
      ).toEqual({ type: "removal", sessionID: "s1" });
    },
  );

  it("maps a part update to removal only when the part is pruned or a compaction", () => {
    const prunedTool = completedToolPart("p1", "s1", "m1", "bash", { command: "ls" }, "out", {
      compacted: 5,
    });
    const compaction = { id: "p2", sessionID: "s1", messageID: "m1", type: "compaction" } as Part;
    expect(v1EventToSignal(partUpdated(prunedTool))).toEqual({ type: "removal", sessionID: "s1" });
    expect(v1EventToSignal(partUpdated(compaction))).toEqual({ type: "removal", sessionID: "s1" });

    const liveTool = completedToolPart("p3", "s1", "m1", "bash", { command: "ls" }, "out");
    expect(v1EventToSignal(partUpdated(liveTool))).toBeNull();
    expect(v1EventToSignal(partUpdated(textPart("p4", "s1", "m1", "streaming")))).toBeNull();
  });

  it("maps session.deleted to deleted", () => {
    expect(v1EventToSignal(event("session.deleted", { sessionID: "s1", info: {} }))).toEqual({
      type: "deleted",
      sessionID: "s1",
    });
  });

  it("ignores every other event", () => {
    expect(v1EventToSignal(event("session.updated", { sessionID: "s1", info: {} }))).toBeNull();
    expect(v1EventToSignal(event("message.updated", { sessionID: "s1", info: {} }))).toBeNull();
  });
});
