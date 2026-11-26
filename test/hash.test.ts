import { describe, expect, it } from "vitest";
import { cyrb53 } from "../src/hash.js";

describe("cyrb53", () => {
  // Summary hashes already persisted in stores were produced by this same
  // function, so its output is pinned: any change to it would re-summarize
  // every card on upgrade. The expected values cover the empty string, a short
  // string, a multi-line digest-shaped string, non-ASCII text with a surrogate
  // pair (the hash reads UTF-16 code units) and a long input.
  it.each([
    ["the empty string", "", "wvjl67o803"],
    ["one character", "a", "262p94epp1d"],
    [
      "a multi-line digest",
      "v1 title: Deploy work\nsummary: the wrangler deploy step",
      "1gcd6fzw6d0",
    ],
    ["non-ASCII text", "naïve café — 日本語 😀", "22ng8etv2v4"],
    ["a long input", "x".repeat(10_000), "1zqnlm33q69"],
  ])("hashes %s to its established base-36 value", (_label, text, expected) => {
    expect(cyrb53(text)).toBe(expected);
  });
});
