import { describe, expect, it } from "vitest";
import { mergeShortlist } from "../src/search.js";

/**
 * Unit coverage for the tier-1 shortlist merge: the FTS-needle and pure-semantic
 * reserved bands, their cap==1 guard, and the invariant that adding a semantic
 * band never regresses the pre-existing lexical/FTS behavior.
 */
describe("mergeShortlist reservation", () => {
  const cards = ["c0", "c1", "c2", "c3", "c4", "c5"];

  it("reduces to the lexical shortlist when there are no reserved sources", () => {
    expect(mergeShortlist(cards, [], [], 3, 2)).toEqual(["c0", "c1", "c2"]);
    expect(mergeShortlist(cards, [], [], 6, 2)).toEqual(cards);
  });

  it("preserves the FTS-needle band unchanged when no semantic ids are given", () => {
    // 1/3 of cap=6 → 2 reserved needle slots ahead of the weakest cards.
    const merged = mergeShortlist(cards, ["f0", "f1"], [], 6, 2);
    expect(merged).toContain("f0");
    expect(merged).toContain("f1");
    expect(merged).toHaveLength(6);
    // Strong cards keep the lead; needles sit ahead of the weakest cards.
    expect(merged.slice(0, 4)).toEqual(["c0", "c1", "c2", "c3"]);
  });

  it("reserves semanticSlots for the top pure-semantic cards the blend buried", () => {
    // c5 is last by blend but top by semantics; a 2-slot reservation pulls it in.
    const merged = mergeShortlist(cards, [], ["c5", "c4"], 3, 2);
    expect(merged).toContain("c5");
    expect(merged).toHaveLength(3);
    // One strong card kept, then the two reserved semantic ids.
    expect(merged).toEqual(["c0", "c5", "c4"]);
  });

  it("honors the cap==1 guard: the single slot goes to the top card, not a reserved band", () => {
    expect(mergeShortlist(cards, ["f0"], ["c5"], 1, 2)).toEqual(["c0"]);
    // Even with only reserved sources and no cards, cap==1 still yields one id.
    expect(mergeShortlist([], ["f0"], [], 1, 2)).toEqual(["f0"]);
  });

  it("clamps the semantic band to semanticSlots and to the room left by the FTS band", () => {
    // semanticSlots=0 disables the semantic reservation entirely.
    expect(mergeShortlist(cards, [], ["c5"], 3, 0)).toEqual(["c0", "c1", "c2"]);
    // Both bands share the room beyond one strong card; the target still lands.
    const merged = mergeShortlist(cards, ["f0"], ["c5"], 3, 2);
    expect(merged).toContain("c5");
    expect(merged).toContain("f0");
    expect(merged).toHaveLength(3);
  });

  it("never lets a reserved id take two slots (dedup with the strong band)", () => {
    // c0 is both the top card and the top semantic id: it appears once.
    const merged = mergeShortlist(cards, [], ["c0", "c5"], 4, 2);
    expect(merged.filter((id) => id === "c0")).toHaveLength(1);
    expect(new Set(merged).size).toBe(merged.length);
    expect(merged).toContain("c5");
  });
});
