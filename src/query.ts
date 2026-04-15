import { tokenize } from "./normalize.js";

export type ParsedQuery = {
  /** Original query string */
  raw: string;
  /** Lowercased version of the raw query */
  lower: string;
  /** Individual normalized tokens (from tokenize()) */
  tokens: string[];
  /** Quoted phrases extracted from the query (lowercased, without quotes) */
  phrases: string[];
};

const QUOTED_PHRASE_RE = /"([^"]*)"/g;

export function parseQuery(query: string): ParsedQuery {
  const raw = query;
  const lower = raw.toLowerCase();

  // 1. Extract quoted phrases and remove them from the working string
  const phrases: string[] = [];
  let remaining = raw;

  for (const match of raw.matchAll(QUOTED_PHRASE_RE)) {
    const content = match[1]?.toLowerCase().trim();
    if (content) {
      phrases.push(content);
    }
  }

  remaining = remaining.replace(QUOTED_PHRASE_RE, " ");

  // 2. Tokenize remaining text and phrase contents, then deduplicate
  const phraseTokens = phrases.flatMap((p) => tokenize(p));
  const remainingTokens = tokenize(remaining);
  const tokens = [...new Set([...phraseTokens, ...remainingTokens])];

  return {
    raw,
    lower,
    tokens,
    phrases,
  };
}
