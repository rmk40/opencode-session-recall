import { describe, expect, it } from "vitest";
import { distance } from "fastest-levenshtein";
import { bm25Search, type Bm25Hit, type Bm25Mode } from "../src/bm25.js";
import {
  buildCandidates,
  MAX_CHARS_PER_CANDIDATE,
  populateNormalized,
  type Candidate,
} from "../src/candidates.js";
import { tokenize } from "../src/normalize.js";
import { parseQuery } from "../src/query.js";
import { mergeShortlistHits, rerankDrilled } from "../src/rerank.js";
import { assistantMessage, completedToolPart } from "./helpers.js";

// Candidates with no directory, session title, tool name or digest, dated
// long ago: only the primary field is searched and every structural
// multiplier but the matched-terms ones is 1, so a hit's score is its BM25+
// score relative to the top hit's.
function plain(partID: string, rawText: string, over: Partial<Candidate> = {}): Candidate {
  const candidate: Candidate = {
    sessionID: "s",
    sessionTitle: "",
    directory: "",
    messageID: `m-${partID}`,
    role: "assistant",
    time: 1,
    partID,
    partType: "text",
    isPruned: false,
    rawText,
    fieldTexts: [{ field: "text", text: rawText }],
    tokens: tokenize(rawText),
    ...over,
  };
  populateNormalized(candidate);
  return candidate;
}

const scoreOf = (hits: Bm25Hit[], partID: string): number => {
  const hit = hits.find((h) => h.candidate.partID === partID);
  if (!hit) throw new Error(`no hit for ${partID}`);
  return hit.score;
};

/** BM25+ inverse document frequency. */
const idf = (docFreq: number, docCount: number): number =>
  Math.log(1 + (docCount - docFreq + 0.5) / (docFreq + 0.5));

describe("BM25+ pool statistics", () => {
  it("counts every candidate of the pool, holder or not, and each term's holders", () => {
    // Every text has two distinct tokens, so each field length equals the
    // average and a single match scores its idf times a constant: the ratio
    // of two hits is the ratio of their terms' idf.
    const holders = [plain("a", "alpha kiwi"), plain("b", "beta plum"), plain("c", "beta fig")];
    const fillers = Array.from({ length: 10 }, (_, i) => plain(`f${i}`, "kiwi plum"));
    const query = parseQuery("alpha beta");
    for (const pool of [holders, [...holders, ...fillers]]) {
      const hits = bm25Search(pool, query, "smart", false);
      expect(hits.map((h) => h.candidate.partID).sort()).toEqual(["a", "b", "c"]);
      expect(scoreOf(hits, "a")).toBe(1);
      expect(scoreOf(hits, "b")).toBeCloseTo(idf(2, pool.length) / idf(1, pool.length), 12);
      expect(scoreOf(hits, "c")).toBe(scoreOf(hits, "b"));
    }
  });

  it("measures a field's length in distinct tokens", () => {
    const hits = bm25Search(
      [
        plain("repeated", "alpha kiwi kiwi kiwi"),
        plain("once", "alpha kiwi"),
        plain("longer", "alpha kiwi plum fig"),
      ],
      parseQuery("alpha"),
      "smart",
      false,
    );
    // "repeated" has two distinct tokens, as "once" does; "longer" has four.
    expect(scoreOf(hits, "repeated")).toBe(scoreOf(hits, "once"));
    expect(scoreOf(hits, "longer")).toBeLessThan(scoreOf(hits, "once"));
  });

  it("multiplies a candidate's score by the number of query terms it reaches", () => {
    // alpha and beta each sit in two of the three texts, so a match on either
    // scores the same. "ab" sums two matches and doubles the sum: four times
    // a single match, then the all-tokens multiplier.
    const hits = bm25Search(
      [plain("a", "alpha kiwi"), plain("ab", "alpha beta"), plain("b", "beta plum")],
      parseQuery("alpha beta"),
      "smart",
      false,
    );
    expect(scoreOf(hits, "ab")).toBeCloseTo(1.1, 12);
    expect(scoreOf(hits, "a")).toBeCloseTo(0.25, 12);
    expect(scoreOf(hits, "b")).toBeCloseTo(0.25, 12);
  });
});

describe("BM25+ term reach", () => {
  /** Whether `term` reaches a candidate holding only `token`, checking that
   *  the hit reports the term as matched when it does. */
  function reaches(term: string, token: string, mode: Bm25Mode): boolean {
    const hits = bm25Search([plain("p", token)], parseQuery(term), mode, false);
    if (hits.length === 0) return false;
    expect(hits[0]!.matchedTerms, `${term} → ${token} (${mode})`).toEqual([term]);
    return true;
  }

  it("reaches exact tokens, prefixes for terms over three characters and the mode's edits", () => {
    const rows: Array<[term: string, token: string, smart: boolean, fuzzy: boolean]> = [
      ["app", "app", true, true],
      // Three characters: no prefix and no edits.
      ["app", "apps", false, false],
      ["app", "apt", false, false],
      // Four characters: prefix, and one edit in either mode.
      ["depl", "deployment", true, true],
      ["depl", "dupl", true, true],
      ["depl", "dull", false, false],
      // A prefix match starts at the token's start.
      ["ploy", "deploy", false, false],
      // Five and six characters: one edit in smart mode, two in fuzzy mode.
      ["cache", "caxhy", false, true],
      ["deploy", "redeploy", false, true],
    ];
    for (const [term, token, smart, fuzzy] of rows) {
      expect(reaches(term, token, "smart"), `${term} → ${token} (smart)`).toBe(smart);
      expect(reaches(term, token, "fuzzy"), `${term} → ${token} (fuzzy)`).toBe(fuzzy);
    }
  });

  it("caps a long term's edits at six in either mode", () => {
    // 35 characters: a fraction of the length would allow 7 edits in smart
    // mode and 11 in fuzzy mode. Each "0" is one edit: the term holds none.
    const term = "abcdefghijklmnopqrstuvwxyzabcdefghi";
    const edited = (count: number): string =>
      [...term].map((ch, i) => (i % 5 === 0 && i / 5 < count ? "0" : ch)).join("");
    const six = edited(6);
    const seven = edited(7);
    expect([distance(term, six), distance(term, seven)]).toEqual([6, 7]);
    for (const mode of ["smart", "fuzzy"] as const) {
      expect(reaches(term, six, mode), mode).toBe(true);
      expect(reaches(term, seven, mode), mode).toBe(false);
    }
  });
});

describe("BM25+ candidates past the per-candidate cap", () => {
  // A bash call whose output passes the cap: the raw text is cut inside the
  // output, so "omega", at the output's end, in the title and in the command,
  // is not in it.
  function toolCandidate(output: string): Candidate {
    const part = completedToolPart("p", "s", "m", "bash", { command: "omega deploy" }, output, {
      title: "run omega",
    });
    const { candidates } = buildCandidates(
      [{ info: assistantMessage("m", "s", 1), parts: [part] }],
      {
        id: "s",
        title: "",
        directory: "",
      },
    );
    const candidate = candidates[0]!;
    populateNormalized(candidate);
    return candidate;
  }
  const cut = toolCandidate(`alpha ${"padding ".repeat(MAX_CHARS_PER_CANDIDATE / 8)}omega`);
  const whole = toolCandidate("alpha padding omega");

  it("scores and reports matched terms from the cut raw text only", () => {
    expect(cut.rawComplete).toBe(false);
    expect(bm25Search([cut], parseQuery("omega"), "smart", false)).toEqual([]);
    const [hit] = bm25Search([cut], parseQuery("alpha omega"), "smart", false);
    expect(hit?.matchedTerms).toEqual(["alpha"]);
    const [twin] = bm25Search([whole], parseQuery("alpha omega"), "smart", false);
    expect(twin?.matchedTerms).toEqual(["alpha", "omega"]);
  });

  it("reports every field whose whole text holds a reaching token", () => {
    // The "toolName" field holds the call's title.
    const [hit] = bm25Search([cut], parseQuery("alpha omega"), "smart", false);
    expect(hit?.matchedFields).toEqual(["stdout", "toolName", "command"]);
    // Without the cut, the fields come from the candidate's own tokens.
    expect(whole.rawComplete).toBe(true);
    const [twin] = bm25Search([whole], parseQuery("alpha omega"), "smart", false);
    expect(twin?.matchedFields).toEqual(["stdout", "toolName", "command"]);
    const [alphaOnly] = bm25Search([whole], parseQuery("alpha"), "smart", false);
    expect(alphaOnly?.matchedFields).toEqual(["stdout"]);
  });
});

describe("BM25+ hand-built candidates", () => {
  it("tokenizes a primary text set without its distinct terms", () => {
    const query = parseQuery("alpha beta");
    const project = (hits: Bm25Hit[]) =>
      hits.map((h) => [h.candidate.partID, h.score, h.matchedTerms, h.matchedFields]);
    const others = [plain("y", "alpha kiwi"), plain("f1", "kiwi plum"), plain("f2", "plum fig")];
    const normalized = [plain("x", "Alpha beta ALPHA"), ...others];
    // The same "x", its primary text normalized but its distinct terms unset.
    const withoutTerms = [{ ...normalized[0]!, primaryTerms: undefined }, ...others];
    const expected = project(bm25Search(normalized, query, "smart", false));
    expect(expected.map(([partID]) => partID)).toEqual(["x", "y"]);
    expect(project(bm25Search(withoutTerms, query, "smart", false))).toEqual(expected);
  });
});

describe("drilled rerank", () => {
  it("runs the deep pass over the deep sessions' pools unless every drilled pool is deep", () => {
    const s1 = [
      plain("s1-a", "alpha beta notes", { sessionID: "s1" }),
      plain("s1-b", "alpha kiwi", { sessionID: "s1" }),
    ];
    const s2 = [
      plain("s2-a", "beta plum", { sessionID: "s2" }),
      plain("s2-b", "alpha alpha fig", { sessionID: "s2" }),
    ];
    const pools = [
      { target: { sessionId: "s1" }, candidates: s1 },
      { target: { sessionId: "s2" }, candidates: s2 },
    ];
    const query = parseQuery("alpha beta");
    const project = (hits: Bm25Hit[]) =>
      hits.map((h) => [h.candidate.partID, h.score, h.matchReasons]);
    const broad = bm25Search([...s1, ...s2], query, "smart", true);
    const s1Deep = project(mergeShortlistHits(broad, bm25Search(s1, query, "smart", true), true));
    const allDeep = project(mergeShortlistHits(broad, broad, true));
    expect(s1Deep).not.toEqual(allDeep);

    // As many deep sessions as pools, one of them not drilled: only s1's pool is deep.
    const sameSize = rerankDrilled(pools, new Set(["s1", "s-undrilled"]), query, "smart", true);
    expect(project(sameSize)).toEqual(s1Deep);
    // Deep sessions beyond the drilled ones: every pool is deep.
    const superset = new Set(["s1", "s2", "s-undrilled"]);
    expect(project(rerankDrilled(pools, superset, query, "smart", true))).toEqual(allDeep);
  });
});
