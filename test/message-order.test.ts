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

/**
 * Whether a source file orders messages by `time.created` itself.
 *
 * A text heuristic, not a parse: it catches the shapes a comparator is
 * normally written in (a `time.created` subtraction anywhere, or `time.created`
 * inside `.sort(`/`.toSorted(` arguments). It misses a comparator defined
 * elsewhere and passed by name, a destructured field (`({ created }) =>`), a
 * bracket access (`time["created"]`), or ordering done without sort (a manual
 * insertion, a heap). Treat a pass as "no obvious hand-rolled sort", and route
 * any new message ordering through `compareMessages` regardless.
 */
function sortsMessagesByTime(source: string): boolean {
  if (TIME_CREATED_SUBTRACTION.test(source)) return true;
  return sortArguments(source).some((args) => /\btime\.created\b/.test(args));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(dir, file));
}

/** A part-less message carrying a v2 `seq`. */
function seqd(info: HistoryMessage["info"], seq: number): HistoryMessage {
  return { info: { ...info, seq }, parts: [] };
}

describe("message ordering", () => {
  it("orders by time.created, then id", () => {
    const early = bundle(userMessage("m-b", "s", 100), []);
    const tieLow = bundle(assistantMessage("m-a", "s", 200), []);
    const tieHigh = bundle(assistantMessage("m-c", "s", 200), []);
    const sorted: HistoryMessage[] = [tieHigh, early, tieLow].sort(compareMessages);
    expect(sorted.map((m) => m.info.id)).toEqual(["m-b", "m-a", "m-c"]);
  });

  it("orders by seq when both messages carry it, even against time", () => {
    // A v2 retry rewrites the assistant's time.created past its successor.
    const retried = seqd(assistantMessage("m-a", "s", 900), 2);
    const next = seqd(userMessage("m-b", "s", 500), 3);
    const first = seqd(userMessage("m-z", "s", 100), 1);
    const sorted = [next, retried, first].sort(compareMessages);
    expect(sorted.map((m) => m.info.id)).toEqual(["m-z", "m-a", "m-b"]);
  });

  it("falls back to time, then id, when only one message carries seq", () => {
    const withSeq = seqd(userMessage("m-b", "s", 200), 1);
    const without = bundle(userMessage("m-a", "s", 100), []);
    expect([withSeq, without].sort(compareMessages).map((m) => m.info.id)).toEqual(["m-a", "m-b"]);
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
