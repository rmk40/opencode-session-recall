import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compareMessages, type HistoryMessage } from "../src/history/model.js";
import { assistantMessage, bundle, userMessage } from "./helpers.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
/** The one file allowed to order messages by time. */
const COMPARATOR_FILE = "history/model.ts";

/** A subtraction on a `time.created` operand: the shape of a hand-rolled
 *  chronological comparator (`a.info.time.created - b.info.time.created`). */
const TIME_CREATED_SUBTRACTION = /\btime\.created\s*-\s*[\w.]|[\w.)]\s*-\s*[\w.]*\btime\.created\b/;

/** The argument text of every `.sort(` / `.toSorted(` call, balanced on parens. */
function sortArguments(source: string): string[] {
  const out: string[] = [];
  const opener = /\.(?:sort|toSorted)\(/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    out.push(source.slice(start, i - 1));
  }
  return out;
}

/** Whether a source file orders messages by `time.created` itself. */
function sortsMessagesByTime(source: string): boolean {
  if (TIME_CREATED_SUBTRACTION.test(source)) return true;
  return sortArguments(source).some((args) => /\btime\.created\b/.test(args));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(dir, file));
}

describe("message ordering", () => {
  it("orders by time.created, then id", () => {
    const early = bundle(userMessage("m-b", "s", 100), []);
    const tieLow = bundle(assistantMessage("m-a", "s", 200), []);
    const tieHigh = bundle(assistantMessage("m-c", "s", 200), []);
    const sorted: HistoryMessage[] = [tieHigh, early, tieLow].sort(compareMessages);
    expect(sorted.map((m) => m.info.id)).toEqual(["m-b", "m-a", "m-c"]);
  });

  it("detects a hand-rolled chronological comparator", () => {
    // Guards the guard: the check below is vacuous if these stop matching.
    expect(
      sortsMessagesByTime(
        "xs.sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id))",
      ),
    ).toBe(true);
    expect(
      sortsMessagesByTime("xs.sort((a, b) => cmp(a.info.time.created, b.info.time.created))"),
    ).toBe(true);
    // Session, card, and hit sorts are not message sorts.
    expect(sortsMessagesByTime("xs.sort((a, b) => b.time.updated - a.time.updated)")).toBe(false);
    expect(sortsMessagesByTime("xs.sort((a, b) => b.timeUpdated - a.timeUpdated)")).toBe(false);
    expect(sortsMessagesByTime("xs.sort((a, b) => b.time - a.time)")).toBe(false);
    expect(sortsMessagesByTime("const row = { timeCreated: msg.info.time.created };")).toBe(false);
  });

  it("routes every message sort in src/ through compareMessages", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => relative(SRC, file) !== COMPARATOR_FILE)
      .filter((file) => sortsMessagesByTime(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
