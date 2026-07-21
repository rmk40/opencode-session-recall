import type { CandidateEmbedder } from "../../src/corpus.js";

/**
 * Deterministic, model-free stand-in for the semantic embedder, for the DEFAULT
 * gate — no ~30MB model download and no model variance, so it can pin the Path A
 * plumbing (reserved-slot quota, zero-hit rescue, diagnostics) end-to-end.
 *
 * It maps text into a fixed concept space by substring triggers: each concept
 * axis fires when any of its trigger substrings is present, and the vector is
 * L2-normalized (a text with no concept returns undefined, matching the real
 * embedder's "no in-vocabulary tokens" contract). The paraphrase QUERIES and the
 * identifier-soup TARGET reach the same concepts through DIFFERENT surface words
 * (the target uses nonsense synonyms) — the exact vocabulary bridge real
 * embeddings provide — while DISTRACTORS, which share only generic non-trigger
 * words with the queries, get no concept signal at all. So the target is the
 * unique semantic hit while remaining lexically invisible to the queries.
 */

/** [axis, trigger substrings]. Query-side words and the target's nonsense
 *  synonyms map to the SAME axis; the distractors' generic words map to none. */
const CONCEPTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["terminal", ["pty", "pseudo", "quaxel"]],
  ["harness", ["harness", "floremel"]],
  ["interactive", ["interact", "plaxin"]],
  ["addon", ["addon", "add-on", "morbex"]],
];

export function makeConceptEmbedder(): CandidateEmbedder {
  return {
    ready: true,
    embed(text: string): Float32Array | undefined {
      const lower = text.toLowerCase();
      const vec = new Float32Array(CONCEPTS.length);
      let nonzero = false;
      for (let i = 0; i < CONCEPTS.length; i++) {
        if (CONCEPTS[i]![1].some((trigger) => lower.includes(trigger))) {
          vec[i] = 1;
          nonzero = true;
        }
      }
      if (!nonzero) return undefined;
      let norm = 0;
      for (const value of vec) norm += value * value;
      norm = Math.sqrt(norm);
      for (let i = 0; i < vec.length; i++) vec[i]! /= norm;
      return vec;
    },
  };
}
