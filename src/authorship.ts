/**
 * Who composed a piece of transcript text.
 *
 * `role: "user"` is a transport fact, not an authorship fact: in a subagent
 * session the "user" is the orchestrating agent, a host can inject synthetic
 * user-role text, and a TUI plugin can render status blocks into a user
 * message. Measured over one real corpus, only about half the user-role text
 * parts were typed by a person. This module answers the different question —
 * "who wrote this?" — from structure alone (part type, message role, part
 * flags, session parentage). No content sniffing, no wording heuristics, no
 * I/O.
 */

/** The authorship buckets. Every classifiable input maps to exactly one. */
export const AUTHORSHIP_VALUES = [
  "human",
  "delegated",
  "injected",
  "model",
  "title",
  "unknown",
] as const;

export type Authorship = (typeof AUTHORSHIP_VALUES)[number];

/** Per-bucket counts (e.g. how many candidates an authorship pass dropped). */
export type AuthorshipCounts = Partial<Record<Authorship, number>>;

/** The three parentage states a session can be in, as {@link parentageOf} reads them. */
export type Parentage = "root" | "child" | "unknown";

/**
 * THE single interpretation of a raw `parentID` value. Both the classifier and
 * the selection tier (`CardFilters.rootOnly`, the FTS admission check) go
 * through this, so they cannot drift: if one of them read `""` as a child while
 * the other read it as a root, a `""` session would be dropped from the
 * shortlist while its parts still classified `human` — breaking the
 * no-result-loss invariant the selection restriction rests on.
 *
 * The mapping:
 *
 * - non-empty string → `child` (the session has a parent, so its "user" is an
 *   orchestrating agent);
 * - `null` → `root` (metadata WAS obtained and said the session is a root);
 * - `undefined`, or the key omitted → `unknown` (no metadata available);
 * - empty or whitespace-only string → `unknown`, NOT `root`. A degenerate value
 *   is not trustworthy metadata, and every ambiguity in this module resolves
 *   away from claiming a human author.
 *
 * The encoding is safe by omission: a construction site that forgets the key
 * yields `undefined` → `unknown` → withheld from `authorship: "human"`. A
 * missed site degrades (withholds results, warns) rather than lying.
 */
export function parentageOf(parentID: string | null | undefined): Parentage {
  if (parentID === undefined) return "unknown";
  if (parentID === null) return "root";
  // This is the single interpretation the whole feature routes through, and
  // upstream data is not trusted anywhere else in this codebase either: a
  // non-string that slipped past the types is unreadable, not a root.
  if (typeof parentID !== "string") return "unknown";
  return parentID.trim().length > 0 ? "child" : "unknown";
}

/** The structural facts the classifier reads. `parentID` is interpreted by
 *  {@link parentageOf}; see there for the tri-state and its failure direction. */
export type AuthorshipInput = {
  partType: string;
  role: "user" | "assistant";
  /** Host/tool-injected part (SDK `TextPart.synthetic`). */
  synthetic?: boolean;
  /** Host rendering hint — TUI status blocks (SDK `TextPart.ignored`). */
  ignored?: boolean;
  parentID?: string | null;
};

/**
 * The ordered decision list. Total by construction, and the ORDER is
 * load-bearing: part type decides before role, and role decides before
 * parentage.
 *
 * ```
 * 1. partType === "title"                        → "title"
 * 2. partType === "subtask"                      → "delegated"
 * 3. role === "assistant"                        → "model"
 * 4. role === "user" && (synthetic || ignored)   → "injected"
 * 5. role === "user" && partType !== "text"      → "injected"
 * 6. role === "user" && parentage === unknown    → "unknown"
 * 7. role === "user" && parentage === child      → "delegated"
 * 8. role === "user" && parentage === root       → "human"
 * 9. fallback                                    → "unknown"
 * ```
 *
 * Rule 9 is unreachable through the typed API (`role` is a two-value union) and
 * exists so a widened or malformed value cannot fall out of the function
 * unclassified.
 *
 * Rule 1 exists because a title candidate is a synthetic search candidate built
 * from session metadata, not a transcript part. It is named `title` rather than
 * `generated` deliberately: the structural classifier knows the candidate is a
 * title, not who produced the string (titles can be user-edited).
 *
 * Rules 2 and 3 resolve the subtask/model collision explicitly. A `subtask`
 * part rides an ASSISTANT message and is still `delegated`, because the
 * question the filter answers is "who composed this instruction", not "which
 * envelope carried it".
 *
 * Rule 4 before rule 5 keeps a flagged non-text part attributable to the flag
 * rather than to its type; both land in `injected`, so the ordering is about
 * intent, not outcome.
 */
export function classifyAuthorship(input: AuthorshipInput): Authorship {
  if (input.partType === "title") return "title";
  if (input.partType === "subtask") return "delegated";
  if (input.role === "assistant") return "model";
  if (input.role === "user") {
    if (input.synthetic === true || input.ignored === true) return "injected";
    if (input.partType !== "text") return "injected";
    const parentage = parentageOf(input.parentID);
    if (parentage === "unknown") return "unknown";
    if (parentage === "child") return "delegated";
    return "human";
  }
  return "unknown";
}

/** The candidate-shaped surface {@link authorshipOf} reads. Structural only. */
export type AuthorshipCandidate = {
  partType: string;
  role: "user" | "assistant";
  synthetic?: boolean;
  ignored?: boolean;
  /** Tri-state parentage of the candidate's SESSION (see {@link AuthorshipInput}). */
  sessionParentID?: string | null;
};

/** Classify a search candidate. Thin adapter over {@link classifyAuthorship}. */
export function authorshipOf(candidate: AuthorshipCandidate): Authorship {
  return classifyAuthorship({
    partType: candidate.partType,
    role: candidate.role,
    synthetic: candidate.synthetic,
    ignored: candidate.ignored,
    parentID: candidate.sessionParentID,
  });
}
