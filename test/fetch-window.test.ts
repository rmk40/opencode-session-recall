import { describe, expect, it } from "vitest";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { fetchMessageWindow } from "../src/fetch-window.js";
import {
  bundle,
  messagesResponse,
  paginateBundles,
  textPart,
  userMessage,
  type FakeHarness,
} from "./helpers.js";

type MessageBundle = FakeHarness["messagesBySession"][string][number];

function fakeClient(all: MessageBundle[]): OpencodeClient {
  return {
    session: {
      messages: async (p: { sessionID: string; limit?: number; before?: string }) => {
        const { items, nextCursor } = paginateBundles(all, p.limit ?? all.length, p.before);
        return messagesResponse(items, nextCursor);
      },
    },
  } as unknown as OpencodeClient;
}

describe("fetchMessageWindow cap adherence", () => {
  it("never retains more than maxMessages with a non-dividing page size", async () => {
    // 250 messages, cap 200, page size 7 (200 % 7 !== 0). The target is the
    // OLDEST message, so paging runs newest-first straight into the cap; the
    // final clamped page must land collected on exactly 200, not overshoot.
    const all: MessageBundle[] = Array.from({ length: 250 }, (_, i) =>
      bundle(userMessage(`m-${i}`, "s", 1_000 + i), [
        textPart(`p-${i}`, "s", `m-${i}`, `context line ${i}`),
      ]),
    );

    const win = await fetchMessageWindow(fakeClient(all), {
      sessionID: "s",
      messageID: "m-0",
      before: 5,
      after: 5,
      pageMessages: 7,
      maxMessages: 200,
    });

    // The oldest target is unreachable within the cap: fetched stops at exactly
    // maxMessages (never 203, which a full non-dividing page append would give).
    expect(win.fetched).toBe(200);
    expect(win.centerIndex).toBe(-1);
    expect(win.hasMoreBefore).toBe(true);
  });

  it("stops early (well under the cap) when the target is recent", async () => {
    const all: MessageBundle[] = Array.from({ length: 250 }, (_, i) =>
      bundle(userMessage(`m-${i}`, "s", 1_000 + i), [
        textPart(`p-${i}`, "s", `m-${i}`, `context line ${i}`),
      ]),
    );

    const win = await fetchMessageWindow(fakeClient(all), {
      sessionID: "s",
      messageID: "m-249", // newest
      before: 2,
      after: 2,
      pageMessages: 7,
      maxMessages: 200,
    });

    expect(win.fetched).toBeLessThanOrEqual(7);
    expect(win.messages.some((m) => m.info.id === "m-249")).toBe(true);
  });
});
