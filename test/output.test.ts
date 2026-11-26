import { describe, expect, it } from "vitest";
import {
  boundResult,
  fitPart,
  resumePart,
  section,
  writeOutput,
  type Fitted,
  type OutputBudget,
  type OutputStop,
} from "../src/output.js";
import type { PartOutput } from "../src/types.js";

/**
 * The output serializer and the hosts' backstop as functions: the budget each
 * output keeps, its layout, where it stops and the errors it falls back to.
 * The tools' round trips through continuations live in
 * `output-tools.test.ts`.
 */

const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");
const linesOf = (text: string): number => text.split("\n").length;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Every record of `records` is a line of `text` of its own (a trailing
 *  comma aside). */
function expectRecordLines(text: string, records: readonly unknown[]): void {
  const lines = new Set(text.split("\n").map((line) => line.replace(/,$/, "")));
  for (const record of records) expect(lines.has(JSON.stringify(record))).toBe(true);
}

// ── boundResult ──────────────────────────────────────────────────────────────

describe("boundResult", () => {
  it("passes a result within OpenCode's limits through unchanged, up to exactly 50 KiB and 2,000 lines", () => {
    const atBytes = "a".repeat(50 * 1024);
    const atLines = Array.from({ length: 2_000 }, () => "x").join("\n");
    const ordinary = JSON.stringify({ ok: true, text: "€😀 small" });
    for (const text of [atBytes, atLines, ordinary]) expect(boundResult(text)).toBe(text);
  });

  it("withholds a result over 50 KiB of UTF-8, counting bytes rather than characters", () => {
    // 17,067 three-byte characters: 51,201 bytes in far fewer characters.
    const multibyte = "€".repeat(17_067);
    expect(multibyte.length).toBeLessThan(50 * 1024);
    for (const text of ["a".repeat(50 * 1024 + 1), multibyte]) {
      const bounded = boundResult(text);
      expect(JSON.parse(bounded)).toEqual({ ok: false, trimmed: true, error: expect.any(String) });
      expect(bytesOf(bounded)).toBeLessThan(1_024);
      expect(linesOf(bounded)).toBe(1);
    }
  });

  it("withholds a result over 2,000 lines however few bytes it has", () => {
    const text = Array.from({ length: 2_001 }, () => "x").join("\n");
    expect(JSON.parse(boundResult(text))).toEqual({
      ok: false,
      trimmed: true,
      error: expect.any(String),
    });
  });
});

// ── writeOutput ──────────────────────────────────────────────────────────────

type Item = { id: number; text: string };
const items = (count: number, size: number): Item[] =>
  Array.from({ length: count }, (_, id) => ({ id, text: `${id}`.padEnd(size, "x") }));

/** The largest leading piece of `item` whose JSON fits `bytes`: its text cut
 *  at the longest prefix that fits, the rest starting at that offset. */
function fitItem(item: Item, bytes: number): Fitted<Item, number> | undefined {
  for (let n = item.text.length - 1; n > 0; n--) {
    const piece = { ...item, text: item.text.slice(0, n) };
    if (bytesOf(JSON.stringify(piece)) <= bytes) return { record: piece, rest: n };
  }
  return undefined;
}

/** A head that records every stop it is given and continues at it. */
function stopHead<P>() {
  const stops: Array<OutputStop<P> | undefined> = [];
  const head = (stop: OutputStop<P> | undefined, shown: Readonly<Record<string, number>>) => {
    stops.push(stop);
    return {
      ...(stop && { continuation: `at:${stop.section}:${stop.index}:${String(stop.rest)}` }),
      fields: { shown: { ...shown } },
    };
  };
  return { stops, head };
}

describe("writeOutput", () => {
  it("writes a complete output as valid JSON: ok first, the header, then one record per line", () => {
    const records = items(5, 40);
    const { head } = stopHead<number>();
    const written = writeOutput({ sections: [section<Item, number>("items", records)], head });
    const parsed = JSON.parse(written.text) as Record<string, unknown>;
    expect(parsed).toEqual({ ok: true, shown: { items: 5 }, items: records });
    expect(Object.keys(parsed)).toEqual(["ok", "shown", "items"]);
    expect(written.stop).toBeUndefined();
    expectRecordLines(written.text, records);
  });

  it("stops at the line budget, before the first record that does not fit, and says where", () => {
    const records = items(40, 10);
    const budget: OutputBudget = { bytes: 100_000, lines: 15 };
    const { head } = stopHead<number>();
    const written = writeOutput({
      sections: [section<Item, number>("items", records, fitItem)],
      head,
      budget,
    });
    expect(linesOf(written.text)).toBeLessThanOrEqual(15);
    const parsed = JSON.parse(written.text) as Record<string, unknown> & { items: Item[] };
    const stop = written.stop!;
    expect(stop).toMatchObject({ section: "items" });
    expect(stop.index).toBeGreaterThan(0);
    // A line cut never cuts a record: the shown records are whole.
    expect(stop.rest).toBeUndefined();
    expect(parsed.items).toEqual(records.slice(0, stop.index));
    expect(Object.keys(parsed).slice(0, 3)).toEqual(["ok", "trimmed", "continuation"]);
    expect(parsed).toMatchObject({
      trimmed: true,
      continuation: `at:items:${stop.index}:undefined`,
    });
    expect(written.text.split("\n")[0]).toContain('"continuation":"at:items:');
  });

  it("shows the first record that does not fit in part when its section can fit it", () => {
    const records = items(30, 1_000);
    const budget: OutputBudget = { bytes: 9_000, lines: 1_900 };
    const { head } = stopHead<number>();
    const written = writeOutput({
      sections: [section<Item, number>("items", records, fitItem)],
      head,
      budget,
    });
    expect(bytesOf(written.text)).toBeLessThanOrEqual(9_000);
    const parsed = JSON.parse(written.text) as { items: Item[]; continuation: string };
    const stop = written.stop!;
    expect(stop.rest).toBeGreaterThan(0);
    // The records before the stop are whole; the stopped one shows up to its rest.
    expect(parsed.items.slice(0, -1)).toEqual(records.slice(0, stop.index));
    expect(parsed.items.at(-1)).toEqual({
      ...records[stop.index]!,
      text: records[stop.index]!.text.slice(0, stop.rest),
    });
    expect(parsed.continuation).toBe(`at:items:${stop.index}:${stop.rest}`);
    expectRecordLines(written.text, parsed.items);
  });

  it("shows records whole or not at all in a section that cannot fit one in part", () => {
    const records = items(30, 1_000);
    const budget: OutputBudget = { bytes: 9_000, lines: 1_900 };
    const { head } = stopHead<number>();
    const written = writeOutput({
      sections: [section<Item, number>("items", records)],
      head,
      budget,
    });
    const parsed = JSON.parse(written.text) as { items: Item[] };
    expect(written.stop?.rest).toBeUndefined();
    expect(parsed.items).toEqual(records.slice(0, written.stop!.index));
    expect(bytesOf(written.text)).toBeLessThanOrEqual(9_000);
  });

  it("finishes one record array before it starts the next", () => {
    const first = items(3, 100);
    const second = items(30, 1_000);
    const budget: OutputBudget = { bytes: 9_000, lines: 1_900 };
    const { head } = stopHead<number>();
    const written = writeOutput({
      sections: [
        section<Item, number>("first", first),
        section<Item, number>("second", second, fitItem),
      ],
      head,
      budget,
    });
    const parsed = JSON.parse(written.text) as Record<string, unknown> & { second: Item[] };
    expect(Object.keys(parsed)).toEqual([
      "ok",
      "trimmed",
      "continuation",
      "shown",
      "first",
      "second",
    ]);
    expect(parsed.first).toEqual(first);
    expect(written.stop).toMatchObject({ section: "second" });
    expect(parsed.shown).toEqual({ first: 3, second: parsed.second.length });
  });

  it("is an error with trimmed when not even part of the first record fits", () => {
    const huge = [{ id: 0, text: "x".repeat(20_000) }];
    const budget: OutputBudget = { bytes: 9_000, lines: 1_900 };
    for (const fit of [undefined, () => undefined]) {
      const { head } = stopHead<number>();
      const written = writeOutput({
        sections: [section<Item, number>("items", huge, fit)],
        head,
        budget,
      });
      expect(JSON.parse(written.text)).toEqual({
        ok: false,
        trimmed: true,
        error: expect.any(String),
      });
      expect(written.shown).toEqual({ items: 0 });
      expect(bytesOf(written.text)).toBeLessThanOrEqual(9_000);
    }
  });
});

// ── fitPart and resumePart ───────────────────────────────────────────────────

describe("fitPart", () => {
  /** Walk `part` piece by piece within `bytes`, resuming each time where the
   *  last piece stopped. Returns the `content` text the pieces showed. */
  function walkContent(part: PartOutput, bytes: number): string {
    let shown = "";
    let current = part;
    for (let pieces = 0; pieces < 10_000; pieces++) {
      if (bytesOf(JSON.stringify(current)) <= bytes) return shown + current.content!;
      const fitted = fitPart(current, bytes);
      if (!fitted) throw new Error(`nothing of the part fits ${bytes} bytes`);
      const text = fitted.record.content!;
      expect(bytesOf(JSON.stringify(fitted.record))).toBeLessThanOrEqual(bytes);
      expect(text).not.toMatch(LONE_SURROGATE);
      expect(fitted.rest).toEqual({
        part: "p",
        field: "content",
        offset: shown.length + text.length,
      });
      expect(fitted.record.cutAt).toEqual({
        field: "content",
        offset: shown.length + text.length,
        length: part.content!.length,
      });
      shown += text;
      current = resumePart(part, "content", fitted.rest.offset!)!;
    }
    throw new Error("the walk did not end");
  }

  it("never splits a surrogate pair at a cut, whatever the byte budget", () => {
    // Every other code unit is a high surrogate, so about half of all budgets
    // put the longest prefix's end between the two halves of a pair; the
    // odd-length prefix shifts every pair by one code unit.
    for (const content of ["😀".repeat(200), `a${"😀".repeat(200)}`, "€😀é".repeat(100)]) {
      const part: PartOutput = { id: "p", type: "text", pruned: false, content };
      for (let bytes = 200; bytes <= 330; bytes++) {
        expect(walkContent(part, bytes), `budget ${bytes}`).toBe(content);
      }
    }
  });
});
