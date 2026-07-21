/**
 * Brute-force cosine similarity over embedding vectors.
 *
 * All embeddings produced by the semantic layer are L2-normalized, so cosine
 * similarity reduces to a plain dot product. This module is pure and Node-free
 * (no dynamic imports, no I/O) so it is unit-testable in isolation and cheap to
 * run over the whole candidate pool — at this scale an approximate-nearest-
 * neighbor index would add complexity without a latency win.
 */

export type ScoredCandidate = { index: number; vec: Float32Array };
export type SimilarityHit = { index: number; score: number };

/**
 * Cosine similarity of two L2-normalized vectors, i.e. their dot product.
 * Uses the shorter length when the vectors differ (a defensive guard; callers
 * pass same-dimension vectors from one model). Vectors that are NOT normalized
 * yield a raw dot product, not a true cosine — the semantic layer only ever
 * feeds normalized vectors here.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}

/**
 * The `k` candidates most similar to `queryVec`, highest score first. Ties
 * break by candidate index so the ordering is deterministic. A non-positive
 * `k` returns an empty list.
 */
export function topK(
  queryVec: Float32Array,
  candidates: ScoredCandidate[],
  k: number,
): SimilarityHit[] {
  if (k <= 0) return [];
  const scored: SimilarityHit[] = candidates.map((candidate) => ({
    index: candidate.index,
    score: cosineSimilarity(queryVec, candidate.vec),
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, k);
}
