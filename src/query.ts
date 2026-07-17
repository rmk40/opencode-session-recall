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
  /** Code-like compound tokens preserved verbatim (tokenization splits them):
   *  snake/kebab/dotted/path compounds, camelCase, and SCREAMING_CASE. These
   *  are the exact anchors (GHOSTAUTH_LIVE_TUI, launchTerminal, deploy.yaml)
   *  a caller would otherwise have to already know to find literally. */
  codeTokens: string[];
};

const QUOTED_PHRASE_RE = /"([^"]*)"/g;

// Known boundaries of this heuristic, accepted deliberately: ordinary
// hyphenated English ("well-known"), decimals ("3.141"), and bare acronyms
// ("JSON", "HTTP") count as code tokens (they are plausible exact anchors and
// the boost is mild); mixed acronym camelCase ("parseJSONResponse") matches
// only its lowercase-led prefix.
const CODE_TOKEN_RE =
  /[A-Za-z0-9]+(?:[_./-][A-Za-z0-9]+)+|[a-z]+(?:[A-Z][a-z0-9]+)+|[A-Z]{2,}[A-Z0-9_]*/g;
const MIN_CODE_TOKEN_LENGTH = 4;

function extractCodeTokens(raw: string): string[] {
  const matches = raw.match(CODE_TOKEN_RE) ?? [];
  return [...new Set(matches.filter((token) => token.length >= MIN_CODE_TOKEN_LENGTH))];
}

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
    codeTokens: extractCodeTokens(raw),
  };
}
