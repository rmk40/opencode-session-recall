import { describe, expect, it } from "vitest";
import { capFamilySlots, familyDiversity, familyDrillSlots } from "../src/search.js";
import type { SearchResult } from "../src/types.js";
import { PROJECT_DIR } from "./helpers.js";

/**
 * The family diversity passes over recall's ordered results and its drill
 * shortlist. `family` always names the current session's relatives (never the
 * current session itself); `delegated` says which results are prompts an
 * orchestrating session wrote.
 */

/** A result `id` of session `sessionID`; `title` makes it a session-title hit. */
function result(sessionID: string, id: string, opts: { title?: boolean } = {}): SearchResult {
  return {
    sessionID,
    sessionTitle: sessionID,
    directory: PROJECT_DIR,
    messageID: `m-${id}`,
    role: "user",
    time: 1_000,
    partID: id,
    partType: opts.title ? "title" : "text",
    pruned: false,
    snippet: id,
    ...(opts.title && { source: "title" as const }),
  };
}

const partIDs = (results: SearchResult[]): string[] => results.map((r) => r.partID);

/** A `delegated` predicate true for the named part ids. */
const delegatedParts =
  (...ids: string[]) =>
  (r: SearchResult): boolean =>
    ids.includes(r.partID);
const nothingDelegated = (): boolean => false;

describe("familyDiversity", () => {
  describe("when there is nothing to reorder against", () => {
    it("returns the results as given when the family is empty", () => {
      const results = [result("f1", "a"), result("f1", "b"), result("f1", "c"), result("o1", "d")];
      expect(familyDiversity(results, new Set(), delegatedParts("a"))).toBe(results);
    });

    it("moves nothing when every result comes from the family", () => {
      const results = ["a", "b", "c", "d", "e", "f"].map((id) => result("f1", id));
      const out = familyDiversity(results, new Set(["f1"]), delegatedParts("a", "b"));
      expect(partIDs(out)).toEqual(["a", "b", "c", "d", "e", "f"]);
    });
  });

  describe("a relative whose best evidence is a delegated prompt", () => {
    it("moves just below the best result from outside the family, keeping its order", () => {
      const results = [
        result("fa", "fa-1"),
        result("fa", "fa-2"),
        result("o1", "o1-1"),
        result("o2", "o2-1"),
      ];
      const out = familyDiversity(results, new Set(["fa"]), delegatedParts("fa-1"));
      expect(partIDs(out)).toEqual(["o1-1", "fa-1", "fa-2", "o2-1"]);
    });

    it("moves only that relative, not the others ranked above the best outside result", () => {
      const results = [
        result("fa", "fa-1"),
        result("fb", "fb-1"),
        result("o1", "o1-1"),
        result("o2", "o2-1"),
      ];
      const out = familyDiversity(results, new Set(["fa", "fb"]), delegatedParts("fa-1"));
      expect(partIDs(out)).toEqual(["fb-1", "o1-1", "fa-1", "o2-1"]);
    });

    it("leaves its results below the best outside result where they are", () => {
      const results = [
        result("fa", "fa-1"),
        result("o1", "o1-1"),
        result("o2", "o2-1"),
        result("fa", "fa-2"),
      ];
      const out = familyDiversity(results, new Set(["fa"]), delegatedParts("fa-1"));
      expect(partIDs(out)).toEqual(["o1-1", "fa-1", "o2-1", "fa-2"]);
    });

    it("is judged on its first result that is not a title hit", () => {
      const titleFirst = [
        result("fa", "fa-title", { title: true }),
        result("fa", "fa-prompt"),
        result("o1", "o1-1"),
      ];
      const demoted = familyDiversity(titleFirst, new Set(["fa"]), delegatedParts("fa-prompt"));
      // The title hit moves with the rest of the session.
      expect(partIDs(demoted)).toEqual(["o1-1", "fa-title", "fa-prompt"]);

      const replyFirst = [
        result("fa", "fa-reply"),
        result("fa", "fa-prompt"),
        result("o1", "o1-1"),
      ];
      const kept = familyDiversity(replyFirst, new Set(["fa"]), delegatedParts("fa-prompt"));
      expect(partIDs(kept)).toEqual(["fa-reply", "fa-prompt", "o1-1"]);
    });

    it("stays put when only title hits of it rank above the best outside result", () => {
      const results = [
        result("fa", "fa-title", { title: true }),
        result("o1", "o1-1"),
        result("fa", "fa-prompt"),
      ];
      const out = familyDiversity(results, new Set(["fa"]), delegatedParts("fa-prompt"));
      expect(partIDs(out)).toEqual(["fa-title", "o1-1", "fa-prompt"]);
    });

    it("stays put when a result from outside the family already leads", () => {
      const results = [result("o1", "o1-1"), result("fa", "fa-prompt"), result("o2", "o2-1")];
      const out = familyDiversity(results, new Set(["fa"]), delegatedParts("fa-prompt", "o1-1"));
      expect(partIDs(out)).toEqual(["o1-1", "fa-prompt", "o2-1"]);
    });
  });

  describe("the family's share of the first five results", () => {
    const family = new Set(["fa", "fb", "fc", "fd"]);

    it("leaves two family results in the first five alone", () => {
      const results = [
        result("fa", "f1"),
        result("fb", "f2"),
        result("o1", "o1"),
        result("o2", "o2"),
        result("o3", "o3"),
        result("fc", "f3"),
      ];
      expect(partIDs(familyDiversity(results, family, nothingDelegated))).toEqual([
        "f1",
        "f2",
        "o1",
        "o2",
        "o3",
        "f3",
      ]);
    });

    it("moves a third family result behind the fifth place while other results remain", () => {
      // Two results of one relative count as two: the share is of results.
      const results = [
        result("fa", "f1"),
        result("fa", "f2"),
        result("fb", "f3"),
        result("o1", "o1"),
        result("o2", "o2"),
        result("o3", "o3"),
        result("o4", "o4"),
      ];
      expect(partIDs(familyDiversity(results, family, nothingDelegated))).toEqual([
        "f1",
        "f2",
        "o1",
        "o2",
        "o3",
        "f3",
        "o4",
      ]);
    });

    it("counts the window over the results it keeps, not the positions it read", () => {
      const results = [
        result("o1", "o1"),
        result("fa", "f1"),
        result("o2", "o2"),
        result("fb", "f2"),
        result("fc", "f3"),
        result("o3", "o3"),
        result("o4", "o4"),
      ];
      expect(partIDs(familyDiversity(results, family, nothingDelegated))).toEqual([
        "o1",
        "f1",
        "o2",
        "f2",
        "o3",
        "f3",
        "o4",
      ]);
    });

    it("lets the held family results fill the places no other result is left for", () => {
      const results = [
        result("fa", "f1"),
        result("fb", "f2"),
        result("fc", "f3"),
        result("fd", "f4"),
        result("o1", "o1"),
      ];
      expect(partIDs(familyDiversity(results, family, nothingDelegated))).toEqual([
        "f1",
        "f2",
        "o1",
        "f3",
        "f4",
      ]);
    });

    it("applies after the delegated-prompt move", () => {
      const results = [
        result("fa", "fa-prompt"),
        result("fb", "f2"),
        result("fc", "f3"),
        result("fd", "f4"),
        result("o1", "o1"),
        result("o2", "o2"),
        result("o3", "o3"),
        result("o4", "o4"),
      ];
      const out = familyDiversity(results, family, delegatedParts("fa-prompt"));
      // fa-prompt first moves below o1; then f4 and fa-prompt are the family
      // results past the share of two.
      expect(partIDs(out)).toEqual(["f2", "f3", "o1", "o2", "o3", "f4", "fa-prompt", "o4"]);
    });
  });
});

describe("familyDrillSlots", () => {
  it.each([
    { cap: 0, slots: 2 },
    { cap: 1, slots: 2 },
    { cap: 6, slots: 2 },
    { cap: 8, slots: 2 },
    { cap: 9, slots: 3 },
    { cap: 12, slots: 4 },
  ])("gives the family $slots slots of a shortlist of $cap", ({ cap, slots }) => {
    expect(familyDrillSlots(cap)).toBe(slots);
  });
});

describe("capFamilySlots", () => {
  const family = new Set(["f1", "f2", "f3", "f4"]);

  it("returns the shortlist as given when the family is within the cap", () => {
    const shortlist = ["f1", "o1", "f2", "o2"];
    expect(capFamilySlots(shortlist, ["f1", "o1", "f2", "o2", "o3"], family, 2)).toBe(shortlist);
  });

  it("gives the slots past the cap to the next ranked sessions from outside the family", () => {
    const shortlist = ["f1", "o1", "f2", "f3"];
    // f4 is ranked but in the family, and o1 is shortlisted already: both are
    // passed over for o2.
    const ranked = ["f1", "o1", "f2", "f3", "f4", "o2", "o3"];
    expect(capFamilySlots(shortlist, ranked, family, 2)).toEqual(["f1", "o1", "f2", "o2"]);
  });

  it("gives a capped family session its slot back when no other session is left", () => {
    expect(
      capFamilySlots(["f1", "f2", "f3", "f4"], ["f1", "f2", "f3", "f4", "o1"], family, 2),
    ).toEqual(["f1", "f2", "o1", "f3"]);
    expect(capFamilySlots(["f1", "f2", "f3"], ["f1", "f2", "f3"], family, 2)).toEqual([
      "f1",
      "f2",
      "f3",
    ]);
  });
});
