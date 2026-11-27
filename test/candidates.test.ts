import { describe, expect, it } from "vitest";
import type { Part } from "@opencode-ai/sdk/v2";
import {
  buildCandidates,
  buildTitleCandidate,
  MAX_CHARS_PER_CANDIDATE,
  populateNormalized,
  type Candidate,
} from "../src/candidates.js";
import { normalize, tokenize, tokenizeAll, tokenText } from "../src/normalize.js";
import {
  assistantMessage,
  completedToolPart,
  subtaskPart,
  textPart,
  userMessage,
} from "./helpers.js";

// Texts that stress tokenization: separators, camelCase, Unicode case
// mappings, whitespace that is not a plain space (tab, CR, NBSP, line and
// paragraph separators, ideographic space, BOM, Ogham space, em space), runs
// of separators and text with no token at all.
const TEXTS = [
  "plain words here",
  "  leading and trailing  ",
  "rateLimit getHTTPResponse XMLParser",
  "src/hooks/auto-recall.ts deploy.yaml GHOSTAUTH_LIVE_TUI opencode-multikey",
  "tabs\tnew\nlines\r\nand\u00a0nbsp\u2028line\u2029para\u3000ideo\ufeffbom\u1680ogham\u2003em",
  "İstanbul ΑΣ straße café naïve",
  "a__b--c//d..e",
  "...",
];

describe("token helpers", () => {
  it("lowercases and splits at separators and camelCase, keeping whitespace as is", () => {
    expect(tokenText("rateLimit/foo_bar.BAZ-qux")).toBe("rate limit foo bar baz qux");
    expect(tokenText(" a__b\t")).toBe(" a  b\t");
    expect(tokenizeAll("getHTTPResponse rate_limit\u00a0İstanbul rate")).toEqual([
      "get",
      "httpresponse",
      "rate",
      "limit",
      "i\u0307stanbul",
      "rate",
    ]);
    expect(tokenizeAll("...")).toEqual([]);
    expect(normalize("\u2028 rate-limit\u3000rateLimit.foo\ufeff")).toBe(
      "rate limit rate limit foo",
    );
  });

  it("normalizes text to its tokens, the whitespace runs of tokenText, joined by single spaces", () => {
    for (const text of TEXTS) {
      const tokens = tokenizeAll(text);
      expect(normalize(text), JSON.stringify(text)).toBe(tokens.join(" "));
      expect(tokenText(text).split(/\s+/).filter(Boolean)).toEqual(tokens);
    }
  });
});

const SESSION = { id: "s", title: "", directory: "" };

/** Every searchable shape: one text part per sample text, a subtask with an
 *  empty description, and a tool part with output, title, command and cwd. */
function sampleCandidates(): Candidate[] {
  const user = userMessage("u", "s", 1);
  const assistant = assistantMessage("a", "s", 2);
  const parts: Part[] = TEXTS.map((text, i) => textPart(`t${i}`, "s", "u", text));
  parts.push(subtaskPart("sub", "s", "u", "", "spawn the ghostAuth worker"));
  return buildCandidates(
    [
      { info: user, parts },
      {
        info: assistant,
        parts: [
          completedToolPart(
            "k",
            "s",
            "a",
            "bash",
            { command: "npm run deploy:prod", cwd: "/work/opencode-session_recall" },
            "Deployed workerName\u00a0OK",
            { title: "Deploy run" },
          ),
        ],
      },
    ],
    SESSION,
  ).candidates;
}

describe("candidate build", () => {
  it("sets the primary text to the normalized raw text and its terms to the distinct tokens", () => {
    const candidates = sampleCandidates();
    expect(candidates).toHaveLength(TEXTS.length + 2);
    for (const candidate of candidates) {
      const label = candidate.partID;
      expect(candidate.primaryText, label).toBe(normalize(candidate.rawText));
      expect(candidate.tokens, label).toEqual(tokenize(candidate.rawText));
      expect(candidate.primaryTerms, label).toBe(candidate.tokens);
    }
  });

  it("marks the raw text complete while the joined fields fit the cap", () => {
    // A subtask joins its description and prompt with a blank line.
    const build = (promptLength: number): Candidate =>
      buildCandidates(
        [
          {
            info: userMessage("u", "s", 1),
            parts: [subtaskPart("p", "s", "u", "alpha", "x".repeat(promptLength))],
          },
        ],
        SESSION,
      ).candidates[0]!;
    const fits = MAX_CHARS_PER_CANDIDATE - "alpha\n\n".length;

    const whole = build(fits);
    expect(whole.rawComplete).toBe(true);
    expect(whole.rawText).toBe(`alpha\n\n${"x".repeat(fits)}`);

    const cut = build(fits + 1);
    expect(cut.rawComplete).toBe(false);
    expect(cut.rawText).toBe(whole.rawText);
    expect(cut.primaryText).toBe(normalize(whole.rawText));
  });

  it("keeps the built primary fields when normalizing and computes them otherwise", () => {
    // Newest message first: the tool part's candidate.
    const built = sampleCandidates()[0]!;
    const { primaryText, primaryTerms } = built;
    populateNormalized(built);
    expect(built.primaryText).toBe(primaryText);
    expect(built.primaryTerms).toBe(primaryTerms);
    expect(built.primaryTerms).toBe(built.tokens);

    const rawText = "Deployed workerName\u00a0OK  deployed";
    const byHand: Candidate = { ...built, rawText, tokens: tokenize(rawText) };
    delete byHand.primaryText;
    delete byHand.primaryTerms;
    delete byHand.rawComplete;
    populateNormalized(byHand);
    expect(byHand.primaryText).toBe("deployed worker name ok deployed");
    expect(byHand.primaryTerms).toEqual(["deployed", "worker", "name", "ok"]);

    const title = buildTitleCandidate(
      { id: "s", title: "Deploy run", directory: "" },
      { id: "u", role: "user", time: { created: 1 } },
    )!;
    populateNormalized(title);
    expect([title.primaryText, title.primaryTerms]).toEqual(["", []]);
    expect(title.titleText).toBe("deploy run");
  });

  it("normalizes every label correctly past the number of labels it remembers", () => {
    const labelled = (i: number): Candidate => {
      const candidate = sampleCandidates()[0]!;
      candidate.directory = `/work/projectNumber${i}/sub_dir-${i}`;
      candidate.sessionTitle = `Fix rateLimit ${i}`;
      candidate.toolName = `mcp__srv${i}__runTool`;
      populateNormalized(candidate);
      return candidate;
    };
    const expectNormalized = (i: number): void => {
      const candidate = labelled(i);
      expect(candidate.secondaryText).toBe(normalize(candidate.directory));
      expect(candidate.titleText).toBe(normalize(candidate.sessionTitle));
      expect(candidate.hintText).toBe(normalize(candidate.toolName!));
    };
    // Three labels each, so well past 1,024 distinct labels; then the first
    // ones again.
    for (let i = 0; i < 1_200; i++) expectNormalized(i);
    for (let i = 0; i < 50; i++) expectNormalized(i);
    expect(labelled(7).secondaryText).toBe("work project number7 sub dir 7");
  });
});
