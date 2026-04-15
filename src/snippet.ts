import type { ParsedQuery } from "./query.js";

interface TokenPosition {
  token: string;
  position: number;
}

/**
 * Add ellipsis prefix/suffix based on window boundaries.
 */
function frame(
  text: string,
  start: number,
  end: number,
  fullLength: number,
): string {
  let result = text;
  if (start > 0) result = "..." + result;
  if (end < fullLength) result = result + "...";
  return result;
}

/**
 * Return the first `width` characters with optional trailing ellipsis.
 */
function headSlice(rawText: string, width: number): string {
  if (rawText.length <= width) return rawText;
  return rawText.slice(0, width) + "...";
}

/**
 * Clamp a snippet window to valid bounds and extract the framed text.
 */
function extractWindow(
  rawText: string,
  idealStart: number,
  width: number,
): string {
  const start = Math.max(0, Math.min(idealStart, rawText.length - width));
  const end = Math.min(rawText.length, start + width);
  return frame(rawText.slice(start, end), start, end, rawText.length);
}

/**
 * Find all occurrences of `needle` (case-insensitive) in `haystack`.
 */
function findAllPositions(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  const lowerHaystack = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  if (lowerNeedle.length === 0) return positions;

  let idx = 0;
  while (idx <= lowerHaystack.length - lowerNeedle.length) {
    const found = lowerHaystack.indexOf(lowerNeedle, idx);
    if (found === -1) break;
    positions.push(found);
    idx = found + 1;
  }
  return positions;
}

/**
 * Select the best snippet window from raw text based on query token density.
 * For smart/fuzzy mode: finds the window with the most query token matches.
 * Falls back to centering on the first token match if no dense window found.
 */
export function smartSnippet(
  rawText: string,
  query: ParsedQuery,
  width: number = 200,
): string {
  if (rawText.length === 0) return "";
  if (rawText.length <= width) return rawText;

  // Collect all token positions
  const allPositions: TokenPosition[] = [];

  for (const token of query.tokens) {
    const positions = findAllPositions(rawText, token);
    for (const position of positions) {
      allPositions.push({ token, position });
    }
  }

  // Also search for phrases as whole strings
  for (const phrase of query.phrases) {
    const positions = findAllPositions(rawText, phrase);
    for (const position of positions) {
      allPositions.push({ token: phrase, position });
    }
  }

  if (allPositions.length === 0) {
    return headSlice(rawText, width);
  }

  // Sort by position
  allPositions.sort((a, b) => a.position - b.position);

  // Sliding window: for each token position as a potential start,
  // count distinct tokens within [start, start + width]
  let bestStart = allPositions[0]!.position;
  let bestDistinct = 0;
  let bestSpread = Infinity;

  for (const { position: windowStart } of allPositions) {
    const seen = new Set<string>();
    let minPos = Infinity;
    let maxPos = -Infinity;

    for (const { token, position } of allPositions) {
      if (position >= windowStart && position <= windowStart + width) {
        seen.add(token);
        minPos = Math.min(minPos, position);
        maxPos = Math.max(maxPos, position);
      }
    }

    const distinct = seen.size;
    const spread = maxPos - minPos;

    if (
      distinct > bestDistinct ||
      (distinct === bestDistinct && spread < bestSpread)
    ) {
      bestDistinct = distinct;
      bestSpread = spread;
      bestStart = windowStart;
    }
  }

  // Center the window around the midpoint of matched tokens within the best window
  const tokensInWindow: number[] = [];
  for (const { position } of allPositions) {
    if (position >= bestStart && position <= bestStart + width) {
      tokensInWindow.push(position);
    }
  }

  if (tokensInWindow.length > 0) {
    const minPos = tokensInWindow[0]!;
    const maxPos = tokensInWindow[tokensInWindow.length - 1]!;
    const midpoint = Math.floor((minPos + maxPos) / 2);
    const idealStart = midpoint - Math.floor(width / 2);
    return extractWindow(rawText, idealStart, width);
  }

  return extractWindow(rawText, bestStart, width);
}
