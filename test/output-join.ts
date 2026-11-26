import { expect } from "vitest";
import type { MessageItem, PartOutput } from "../src/types.js";
import { UNBOUNDED_MESSAGES_ERROR } from "./helpers.js";

/**
 * Checks for tool results within OpenCode's output limits, and joiners that
 * put the pieces of consecutive trimmed results back together, failing on any
 * gap or repeat at a cut.
 */

export const BUDGET = { bytes: 40 * 1024, lines: 1_900 };
export const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const TEXT_FIELDS: readonly string[] = ["content", "title", "input", "output", "error"];

export type Out = {
  ok: boolean;
  trimmed?: boolean;
  continuation?: string;
  error?: string;
  [key: string]: unknown;
};
export type Flat = Record<string, unknown>;

/**
 * Parse a tool result and check its shape: within the budget, valid JSON,
 * `ok` first, `trimmed` and `continuation` right after it and on the first
 * line, and every record of each record array on a line of its own. The
 * record arrays are `sections`, or every top-level array when unset.
 */
export function parseBounded(text: string, sections?: readonly string[]): Out {
  const lines = text.split("\n");
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(BUDGET.bytes);
  expect(lines.length).toBeLessThanOrEqual(BUDGET.lines);
  expect(text).not.toContain(UNBOUNDED_MESSAGES_ERROR);
  const out = JSON.parse(text) as Out;
  const keys = Object.keys(out);
  expect(keys[0]).toBe("ok");
  if (out.trimmed !== undefined || out.continuation !== undefined) {
    expect(out.trimmed).toBe(true);
    if (out.ok) {
      expect(keys.slice(0, 3)).toEqual(["ok", "trimmed", "continuation"]);
      expect(lines[0]).toContain(`"continuation":${JSON.stringify(out.continuation)}`);
    }
  }
  const recordLines = new Set(lines.map((line) => line.replace(/,$/, "")));
  for (const [key, value] of Object.entries(out)) {
    if (!Array.isArray(value) || (sections && !sections.includes(key))) continue;
    for (const record of value) expect(recordLines.has(JSON.stringify(record))).toBe(true);
  }
  return out;
}

export const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const asText = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/** A part as one whole result shows it, its text fields as text (a
 *  non-string `input` as its JSON). */
export function flatPart(part: PartOutput): Flat {
  const out: Flat = {};
  for (const [key, value] of Object.entries(roundTrip(part))) {
    out[key] = TEXT_FIELDS.includes(key) ? asText(value) : value;
  }
  return out;
}

export function flatMessage(item: MessageItem): Flat {
  const { parts, ...envelope } = roundTrip(item);
  return { ...envelope, parts: parts.map(flatPart) };
}

/**
 * Parts from consecutive outputs joined back into whole parts. A piece that
 * resumes a part must start exactly where the previous piece was cut, and a
 * part that is not resumed must be new, so a gap or a repeat fails here.
 */
export class PartJoiner {
  readonly parts: Flat[] = [];
  /** Text fields some piece was cut inside. */
  readonly cutFields = new Set<string>();
  private readonly seen = new Set<string>();
  private open: { id: string; field: string; offset: number } | undefined;

  add(piece: PartOutput): void {
    const { cutAt, resumedAt, ...fields } = piece;
    let target: Flat;
    if (resumedAt) {
      expect(this.open, `part ${piece.id} resumes where it was cut`).toEqual({
        id: piece.id,
        field: resumedAt.field,
        offset: resumedAt.offset,
      });
      target = this.parts.at(-1)!;
    } else {
      expect(this.open, `part ${piece.id} starts before ${this.open?.id} ends`).toBeUndefined();
      expect(this.seen.has(piece.id), `part ${piece.id} shown twice`).toBe(false);
      this.seen.add(piece.id);
      target = {};
      this.parts.push(target);
    }
    for (const [key, value] of Object.entries(fields)) {
      if (TEXT_FIELDS.includes(key)) {
        const text = asText(value);
        expect(text).not.toMatch(LONE_SURROGATE);
        if (key === resumedAt?.field) {
          target[key] = `${target[key] as string}${text}`;
        } else {
          expect(target, `field ${key} of part ${piece.id} shown twice`).not.toHaveProperty(key);
          target[key] = text;
        }
      } else if (key in target) {
        expect(value, `${key} of part ${piece.id}`).toEqual(target[key]);
      } else {
        target[key] = value;
      }
    }
    this.open = undefined;
    if (cutAt) {
      expect((target[cutAt.field] as string).length).toBe(cutAt.offset);
      this.open = { id: piece.id, field: cutAt.field, offset: cutAt.offset };
      this.cutFields.add(cutAt.field);
    }
  }

  end(): void {
    expect(this.open, "the last part was left cut").toBeUndefined();
  }
}

/** Messages from consecutive outputs joined back into whole messages. */
export class MessageJoiner {
  private readonly entries: Array<{ id: string; envelope: Flat; parts: PartJoiner }> = [];

  add(items: readonly MessageItem[]): void {
    for (const item of items) {
      const { parts, ...envelope } = item;
      let entry = this.entries.at(-1);
      if (entry?.id === item.message.id) {
        expect(envelope).toEqual(entry.envelope);
      } else {
        entry?.parts.end();
        expect(
          this.entries.map((e) => e.id),
          `message ${item.message.id} shown twice`,
        ).not.toContain(item.message.id);
        entry = { id: item.message.id, envelope, parts: new PartJoiner() };
        this.entries.push(entry);
      }
      for (const part of parts) entry.parts.add(part);
    }
  }

  messages(): Flat[] {
    this.entries.at(-1)?.parts.end();
    return this.entries.map((e) => ({ ...e.envelope, parts: e.parts.parts }));
  }

  cutFields(): Set<string> {
    return new Set(this.entries.flatMap((e) => [...e.parts.cutFields]));
  }
}
