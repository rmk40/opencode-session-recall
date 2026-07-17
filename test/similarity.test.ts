import { describe, expect, it } from "vitest";
import { cosineSimilarity, topK } from "../src/semantic/similarity.js";

const vec = (...values: number[]): Float32Array => Float32Array.from(values);

describe("cosineSimilarity", () => {
  it("returns 1 for identical unit vectors", () => {
    expect(cosineSimilarity(vec(1, 0, 0), vec(1, 0, 0))).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity(vec(1, 0), vec(0, 1))).toBeCloseTo(0, 6);
  });

  it("returns -1 for opposite unit vectors", () => {
    expect(cosineSimilarity(vec(0, 1), vec(0, -1))).toBeCloseTo(-1, 6);
  });

  it("is the dot product for normalized vectors", () => {
    const a = vec(0.6, 0.8);
    const b = vec(0.8, 0.6);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.6 * 0.8 + 0.8 * 0.6, 6);
  });
});

describe("topK", () => {
  const candidates = [
    { index: 10, vec: vec(0, 1) }, // cos 0 with query
    { index: 11, vec: vec(1, 0) }, // cos 1 (identical)
    { index: 12, vec: vec(0.6, 0.8) }, // cos 0.6
    { index: 13, vec: vec(-1, 0) }, // cos -1 (opposite)
  ];
  const query = vec(1, 0);

  it("orders results by descending similarity", () => {
    const hits = topK(query, candidates, 4);
    expect(hits.map((h) => h.index)).toEqual([11, 12, 10, 13]);
    expect(hits[0]!.score).toBeCloseTo(1, 6);
    expect(hits[3]!.score).toBeCloseTo(-1, 6);
  });

  it("caps the result count at k", () => {
    const hits = topK(query, candidates, 2);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.index)).toEqual([11, 12]);
  });

  it("returns an empty list for a non-positive k", () => {
    expect(topK(query, candidates, 0)).toEqual([]);
    expect(topK(query, candidates, -3)).toEqual([]);
  });

  it("breaks score ties by candidate index", () => {
    const tied = [
      { index: 5, vec: vec(1, 0) },
      { index: 2, vec: vec(1, 0) },
    ];
    expect(topK(query, tied, 2).map((h) => h.index)).toEqual([2, 5]);
  });
});
