import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AUTHORSHIP_VALUES,
  authorshipOf,
  classifyAuthorship,
  parentageOf,
  type Authorship,
  type AuthorshipInput,
} from "../src/authorship.js";

// The classifier is an ORDERED decision list, so the table below is organized
// by rule and includes the collisions the ordering exists to resolve. Every
// case is structural: part type, message role, part flags, session parentage.

describe("classifyAuthorship", () => {
  const base: AuthorshipInput = { partType: "text", role: "user", parentID: null };

  const table: Array<{ name: string; input: AuthorshipInput; expected: Authorship }> = [
    // Rule 1 — part type wins over everything, including role.
    {
      name: "rule 1: a title candidate is `title`",
      input: { partType: "title", role: "user", parentID: null },
      expected: "title",
    },
    {
      name: "rule 1 beats rule 3: a title on an assistant envelope is still `title`",
      input: { partType: "title", role: "assistant", parentID: null },
      expected: "title",
    },
    {
      name: "rule 1 beats rule 6: a title with unknown parentage is still `title`",
      input: { partType: "title", role: "user" },
      expected: "title",
    },
    // Rule 2 — the subtask/model collision. A subtask part RIDES an assistant
    // message; the question is who composed the instruction, not who carried it.
    {
      name: "rule 2 beats rule 3: a subtask on an assistant envelope is `delegated`",
      input: { partType: "subtask", role: "assistant", parentID: null },
      expected: "delegated",
    },
    {
      name: "rule 2: a subtask in a root session is `delegated`",
      input: { partType: "subtask", role: "user", parentID: null },
      expected: "delegated",
    },
    // Rule 3 — assistant, every remaining part type.
    { name: "rule 3: assistant text", input: { ...base, role: "assistant" }, expected: "model" },
    {
      name: "rule 3: assistant reasoning",
      input: { partType: "reasoning", role: "assistant", parentID: null },
      expected: "model",
    },
    {
      name: "rule 3: assistant tool",
      input: { partType: "tool", role: "assistant", parentID: null },
      expected: "model",
    },
    {
      name: "rule 3: assistant in a CHILD session is still `model` (role before parentage)",
      input: { partType: "text", role: "assistant", parentID: "ses_parent" },
      expected: "model",
    },
    {
      name: "rule 3 beats rule 4: a synthetic assistant part is `model`, not `injected`",
      input: { partType: "text", role: "assistant", synthetic: true, parentID: null },
      expected: "model",
    },
    // Rule 4 — part flags on a user envelope.
    { name: "rule 4: user + synthetic", input: { ...base, synthetic: true }, expected: "injected" },
    { name: "rule 4: user + ignored", input: { ...base, ignored: true }, expected: "injected" },
    {
      name: "rule 4: user + synthetic AND ignored together",
      input: { ...base, synthetic: true, ignored: true },
      expected: "injected",
    },
    {
      name: "rule 4 beats rule 7: a flagged part in a child session is `injected`",
      input: { partType: "text", role: "user", ignored: true, parentID: "ses_parent" },
      expected: "injected",
    },
    {
      name: "rule 4 beats rule 6: a flagged part with unknown parentage is `injected`",
      input: { partType: "text", role: "user", synthetic: true },
      expected: "injected",
    },
    // Rule 5 — a non-text part on a user envelope.
    {
      name: "rule 5: user + reasoning part",
      input: { partType: "reasoning", role: "user", parentID: null },
      expected: "injected",
    },
    {
      name: "rule 5: user + tool part",
      input: { partType: "tool", role: "user", parentID: null },
      expected: "injected",
    },
    {
      name: "rule 5 beats rule 8: a user tool part in a ROOT session is not `human`",
      input: { partType: "tool", role: "user", parentID: null },
      expected: "injected",
    },
    // Rules 6/7/8 — the parentage tri-state, which only rule 6 can express.
    {
      name: "rule 6: parentage undefined is `unknown`, never `human`",
      input: { partType: "text", role: "user" },
      expected: "unknown",
    },
    {
      name: "rule 7: a child-session user prompt is `delegated`",
      input: { ...base, parentID: "ses_parent" },
      expected: "delegated",
    },
    {
      name: "rule 8: a root-session user prompt is `human`",
      input: { ...base, parentID: null },
      expected: "human",
    },
  ];

  for (const entry of table) {
    it(entry.name, () => {
      expect(classifyAuthorship(entry.input)).toBe(entry.expected);
    });
  }

  it("distinguishes null (root) from undefined (unknown) — the tri-state is load-bearing", () => {
    expect(classifyAuthorship({ partType: "text", role: "user", parentID: null })).toBe("human");
    expect(classifyAuthorship({ partType: "text", role: "user", parentID: undefined })).toBe(
      "unknown",
    );
    // Omitting the key entirely must behave exactly like an explicit undefined:
    // that is what makes the encoding safe by omission.
    expect(classifyAuthorship({ partType: "text", role: "user" })).toBe("unknown");
  });

  it("treats a degenerate empty/whitespace parentID as unknown, never as human", () => {
    // An empty string is not trustworthy metadata, so it must not buy the
    // `human` label. This is the one place the classifier could fail OPEN.
    expect(classifyAuthorship({ partType: "text", role: "user", parentID: "" })).toBe("unknown");
    expect(classifyAuthorship({ partType: "text", role: "user", parentID: "   " })).toBe("unknown");
  });

  it("has no unclassified fallthrough for a widened role (rule 9)", () => {
    // Rule 9 is unreachable through the typed API; the cast is the point.
    const widened = {
      partType: "text",
      role: "system",
      parentID: null,
    } as unknown as AuthorshipInput;
    expect(classifyAuthorship(widened)).toBe("unknown");
  });

  it("is total: every input maps into the declared bucket list", () => {
    const partTypes = ["text", "reasoning", "tool", "subtask", "title", "file", "step-start"];
    // Includes a role outside the typed union so rule 9 is covered here too.
    const roles = ["user", "assistant", "system"] as unknown as Array<"user" | "assistant">;
    const parents = [null, undefined, "ses_parent"];
    const flags = [{}, { synthetic: true }, { ignored: true }, { synthetic: true, ignored: true }];
    for (const partType of partTypes) {
      for (const role of roles) {
        for (const parentID of parents) {
          for (const flag of flags) {
            const bucket = classifyAuthorship({ partType, role, parentID, ...flag });
            expect(AUTHORSHIP_VALUES).toContain(bucket);
          }
        }
      }
    }
  });
});

// The `injected` rule reads `TextPart.ignored`, which is a HOST flag: the SDK
// declares it optional, so "declared" is not evidence it is ever populated. The
// fixture below was captured from a live SDK response and is the standing proof
// that it crosses the boundary — if the flag ever stops being sent, this pin is
// where the classifier's premise should be re-examined.
describe("SDK `ignored` flag (step-0 spike pin)", () => {
  it("is populated on a real SDK text part and classifies as `injected`", () => {
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("./fixtures/sdk-ignored-part.json", import.meta.url)),
        "utf8",
      ),
    ) as { part: { type: string; ignored?: boolean; synthetic?: boolean } };

    expect(fixture.part.type).toBe("text");
    expect(fixture.part.ignored).toBe(true);
    expect(
      classifyAuthorship({
        partType: fixture.part.type,
        role: "user",
        ignored: fixture.part.ignored,
        synthetic: fixture.part.synthetic,
        // Root session — the observed population is TUI status blocks rendered
        // into root sessions, which without the flag would classify `human`.
        parentID: null,
      }),
    ).toBe("injected");
  });
});

describe("parentageOf: the one interpretation the classifier and selection share", () => {
  const cases: Array<[string | null | undefined, "root" | "child" | "unknown"]> = [
    ["ses_parent", "child"],
    [null, "root"],
    [undefined, "unknown"],
    ["", "unknown"],
    ["   ", "unknown"],
  ];

  for (const [value, expected] of cases) {
    it(`maps ${JSON.stringify(value)} to ${expected}`, () => {
      expect(parentageOf(value)).toBe(expected);
    });
  }

  it("keeps the classifier and the root-only card filter in agreement", () => {
    // The drift this guards: if selection read "" as a child while the
    // classifier read it as a root, a "" session would be dropped from the
    // shortlist while its parts still classified `human` — losing results the
    // filter promised to return. Both sides go through parentageOf, so the
    // agreement is structural; this asserts it for every parentage value.
    for (const [value] of cases) {
      const bucket = classifyAuthorship({ partType: "text", role: "user", parentID: value });
      const droppedBySelection = parentageOf(value) === "child";
      // A session selection drops must be one whose parts can never be human,
      // and a session whose parts can be human must never be dropped.
      expect(droppedBySelection).toBe(bucket === "delegated");
      if (droppedBySelection) expect(bucket).not.toBe("human");
    }
  });
});

describe("authorshipOf (candidate adapter)", () => {
  it("maps a candidate's sessionParentID through the tri-state", () => {
    expect(authorshipOf({ partType: "text", role: "user", sessionParentID: null })).toBe("human");
    expect(authorshipOf({ partType: "text", role: "user", sessionParentID: "ses_parent" })).toBe(
      "delegated",
    );
    // Key omitted: a candidate whose session parentage was never plumbed must
    // fail CLOSED (withheld from authorship:"human"), not claim to be human.
    expect(authorshipOf({ partType: "text", role: "user" })).toBe("unknown");
  });

  it("reads the part flags", () => {
    expect(
      authorshipOf({ partType: "text", role: "user", sessionParentID: null, ignored: true }),
    ).toBe("injected");
    expect(
      authorshipOf({ partType: "text", role: "user", sessionParentID: null, synthetic: true }),
    ).toBe("injected");
  });
});
