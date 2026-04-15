/** Split camelCase/PascalCase at lowercase→uppercase boundaries */
export function splitCamelCase(text: string): string {
  // e.g., rateLimit → rate Limit, getHTTPResponse → getHTTP Response
  // Note: pure-uppercase runs like XMLParser are NOT split (no lowercase→uppercase boundary)
  return text.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** Stage 1: extract lightweight tokens from raw text for prefiltering */
export function tokenize(text: string): string[] {
  const separated = text.replace(/[_\-/.]/g, " ");
  const camelSplit = splitCamelCase(separated);
  const lowered = camelSplit.toLowerCase();
  const tokens = lowered.split(/\s+/).filter((t) => t.length > 0);
  return [...new Set(tokens)];
}

/** Stage 2: produce a fully normalized string for Fuse.js weighted fields */
export function normalize(text: string): string {
  const separated = text.replace(/[_\-/.]/g, " ");
  const camelSplit = splitCamelCase(separated);
  const lowered = camelSplit.toLowerCase();
  return lowered.replace(/\s+/g, " ").trim();
}
