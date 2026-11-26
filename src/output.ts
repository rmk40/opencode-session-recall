import { formatMsg } from "./extract.js";
import type { HistoryMessage } from "./history/model.js";
import type { MessageItem, PartOutput, PartTextField } from "./types.js";

/**
 * Tool output within the host's size limits.
 *
 * OpenCode passes a tool result to the model whole only up to 2,000 lines and
 * 50 KiB of UTF-8. Past either it keeps the lines that fit and cuts at a line
 * boundary, so a one-line JSON result over the limit reaches the model as
 * "showing 0 lines of 1". The serializer here writes one valid JSON document
 * within {@link OUTPUT_BUDGET}: the header fields first (`ok`, then `trimmed`
 * and `continuation` when set, then the tool's own), then each record array
 * with one `JSON.stringify(record)` per line. When the records do not all
 * fit, it stops at the first one that does not, shows as much of that one as
 * fits (down to a field offset inside a part) and sets `trimmed: true` with a
 * `continuation`, which the tool takes back as its `cursor` to resume at that
 * exact position.
 *
 * Continuations are `rc.` followed by base64url of UTF-8 JSON carrying a
 * version (`v`) and the tool they belong to (`k`); a tool rejects another
 * tool's continuation. {@link boundResult} is the hosts' backstop for any
 * result that still exceeds what OpenCode passes through whole.
 */

// ── Budget ───────────────────────────────────────────────────────────────────

/** A size budget: UTF-8 bytes and lines, as the host counts them. */
export type OutputBudget = { bytes: number; lines: number };

/** What OpenCode passes to the model whole: at most 2,000 lines and 50 KiB
 *  (`MAX_LINES` and `MAX_BYTES` in opencode's
 *  `packages/core/src/tool-output.ts`). */
export const HOST_OUTPUT_LIMIT: OutputBudget = { bytes: 50 * 1024, lines: 2_000 };

/** What the serializer writes at most, with headroom below
 *  {@link HOST_OUTPUT_LIMIT}. */
export const OUTPUT_BUDGET: OutputBudget = { bytes: 40 * 1024, lines: 1_900 };

const utf8 = new TextEncoder();

/** UTF-8 byte length of `text`. */
export function utf8Length(text: string): number {
  return utf8.encode(text).byteLength;
}

/** UTF-8 byte length of `text` when it is at most `max`, else undefined.
 *  A string never has fewer UTF-8 bytes than UTF-16 code units, so a longer
 *  one is rejected without encoding it. */
function bytesWithin(text: string, max: number): number | undefined {
  if (text.length > max) return undefined;
  const bytes = utf8Length(text);
  return bytes <= max ? bytes : undefined;
}

/** Lines in `text` as the host counts them: split on `\n`, with a trailing
 *  newline ending the last line rather than starting another. */
export function lineCount(text: string): number {
  let lines = 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lines++;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/** Whether `text` is within `budget` in both bytes and lines. */
export function withinBudget(text: string, budget: OutputBudget): boolean {
  return bytesWithin(text, budget.bytes) !== undefined && lineCount(text) <= budget.lines;
}

/**
 * A tool result as a host hands it to OpenCode: `text` itself when it is
 * within `limit`, else a small JSON error with `trimmed: true`. It only
 * measures, so a result within the limit passes through unchanged.
 */
export function boundResult(text: string, limit: OutputBudget = HOST_OUTPUT_LIMIT): string {
  if (withinBudget(text, limit)) return text;
  return JSON.stringify({
    ok: false,
    trimmed: true,
    error: `opencode-session-recall: this result (${text.length} characters, ${lineCount(text)} lines) is over what OpenCode passes to the model whole (${limit.bytes} bytes, ${limit.lines} lines), so it was withheld. Ask for less: a smaller limit, window or result count.`,
  });
}

/** Longest error message an error output carries, in UTF-16 code units. */
const ERROR_MAX_CHARS = 4_000;

/** An error output, `{ ok: false, error }`, its message shortened to stay
 *  well within the budget. With `trimmed`, it also says the output was cut. */
export function writeError(error: string, o: { trimmed?: boolean } = {}): string {
  const message = error.length > ERROR_MAX_CHARS ? `${prefix(error, ERROR_MAX_CHARS)}…` : error;
  return JSON.stringify({ ok: false, ...(o.trimmed && { trimmed: true }), error: message });
}

/** The first `n` code units of `text`, one fewer when the cut would split a
 *  surrogate pair. */
function prefix(text: string, n: number): string {
  return text.slice(0, safeCut(text, n));
}

/** `n`, or `n - 1` when the code unit before `n` is a high surrogate whose
 *  pair the cut would split. */
function safeCut(text: string, n: number): number {
  if (n <= 0 || n >= text.length) return Math.max(0, Math.min(n, text.length));
  const unit = text.charCodeAt(n - 1);
  return unit >= 0xd800 && unit <= 0xdbff ? n - 1 : n;
}

// ── Serializer ───────────────────────────────────────────────────────────────

/** The shown piece of a record that did not fit whole, and where the rest of
 *  it starts. */
export type Fitted<R, P> = { record: R; rest: P };

/** One record array of an output. `fit` shows part of a record that does not
 *  fit whole: given the bytes left, it returns the largest leading piece that
 *  serializes within them, or undefined when no piece holding any content
 *  does. A section without `fit` shows a record whole or not at all. */
export type OutputSection<P> = {
  key: string;
  records: readonly unknown[];
  fit?: (index: number, bytes: number) => Fitted<unknown, P> | undefined;
};

/** A typed {@link OutputSection}. */
export function section<R, P>(
  key: string,
  records: readonly R[],
  fit?: (record: R, bytes: number) => Fitted<R, P> | undefined,
): OutputSection<P> {
  return {
    key,
    records,
    ...(fit && { fit: (index: number, bytes: number) => fit(records[index]!, bytes) }),
  };
}

/** Where an output stopped: the first record of section `section` not shown
 *  whole (`index` into the records the section was given) and, when part of
 *  it was shown, where its rest starts. */
export type OutputStop<P> = { section: string; index: number; rest?: P };

/** An output's header: the tool's own fields (written after `ok`), and the
 *  continuation, which also sets `trimmed: true`. */
export type OutputHead = { fields: Record<string, unknown>; continuation?: string };

export type OutputSpec<P> = {
  sections: ReadonlyArray<OutputSection<P>>;
  /** The header for an output that stopped at `stop` (undefined when every
   *  record is shown), with `shown` counting each section's records shown
   *  whole or in part. Called more than once, so it must not have effects.
   *  A head may set `continuation` without a stop, when the tool's own read
   *  was cut short. */
  head: (stop: OutputStop<P> | undefined, shown: Readonly<Record<string, number>>) => OutputHead;
  budget?: OutputBudget;
};

export type WrittenOutput<P> = {
  text: string;
  stop?: OutputStop<P>;
  shown: Record<string, number>;
};

/** Bytes set aside for the header's continuation (and anything else in the
 *  header that grows with the stop) while records are fitted. */
const HEAD_RESERVE = 2_048;
/** Fittings tried, each with a larger reserve, before giving up. */
const FIT_ATTEMPTS = 3;

/** Header line: the head object without its closing brace. */
function headLine(head: OutputHead, sectionCount: number): string {
  const fields: Record<string, unknown> = {
    ok: true,
    ...(head.continuation !== undefined && { trimmed: true, continuation: head.continuation }),
    ...head.fields,
  };
  const text = JSON.stringify(fields);
  return sectionCount > 0 ? `${text.slice(0, -1)},` : text;
}

function render(head: OutputHead, keys: readonly string[], rows: readonly string[][]): string {
  const lines = [headLine(head, keys.length)];
  if (keys.length === 0) return lines[0]!;
  keys.forEach((key, j) => {
    const end = j === keys.length - 1 ? "" : ",";
    const name = JSON.stringify(key);
    const records = rows[j] ?? [];
    if (records.length === 0) {
      lines.push(`${name}:[]${end}`);
      return;
    }
    lines.push(`${name}:[`);
    records.forEach((row, i) => lines.push(i < records.length - 1 ? `${row},` : row));
    lines.push(`]${end}`);
  });
  lines.push("}");
  return lines.join("\n");
}

type Planned<P> = { rows: string[][]; stop?: OutputStop<P>; shown: Record<string, number> };

/** Records in order while they fit `bytes` and `lines`, then the first that
 *  does not, in part when its section can fit it. Undefined when nothing at
 *  all is shown. */
function plan<P>(
  sections: ReadonlyArray<OutputSection<P>>,
  serialized: readonly string[][],
  bytes: number,
  lines: number,
): Planned<P> | undefined {
  const rows: string[][] = sections.map(() => []);
  const shown: Record<string, number> = {};
  for (const s of sections) shown[s.key] = 0;
  let left = bytes;
  let linesLeft = lines;
  let any = false;
  for (let j = 0; j < sections.length; j++) {
    const s = sections[j]!;
    for (let i = 0; i < s.records.length; i++) {
      // A record costs its line plus a separating comma and newline.
      const cost = linesLeft > 0 ? bytesWithin(serialized[j]![i]!, left - 2) : undefined;
      if (cost !== undefined) {
        rows[j]!.push(serialized[j]![i]!);
        shown[s.key]!++;
        left -= cost + 2;
        linesLeft--;
        any = true;
        continue;
      }
      const fitted = linesLeft > 0 && left > 2 ? s.fit?.(i, left - 2) : undefined;
      if (fitted) {
        rows[j]!.push(JSON.stringify(fitted.record));
        shown[s.key]!++;
        any = true;
      }
      if (!any) return undefined;
      return {
        rows,
        stop: { section: s.key, index: i, ...(fitted && { rest: fitted.rest }) },
        shown,
      };
    }
  }
  return { rows, shown };
}

/**
 * Serialize an output within its budget (default {@link OUTPUT_BUDGET}): the
 * header line first, then each section's records, one per line. When every
 * record fits, the output is complete and the head gets no stop. Otherwise it
 * stops at the first record that does not fit (showing the piece of it its
 * section's `fit` returns) and the head gets that stop, so it can set the
 * continuation. When not even part of the first record fits, the output is an
 * error with `trimmed: true`, naming the header and its largest field when
 * the header is what leaves no room.
 */
export function writeOutput<P>(spec: OutputSpec<P>): WrittenOutput<P> {
  const budget = spec.budget ?? OUTPUT_BUDGET;
  const keys = spec.sections.map((s) => s.key);
  const serialized = spec.sections.map((s) => s.records.map((record) => JSON.stringify(record)));
  const all: Record<string, number> = {};
  for (const s of spec.sections) all[s.key] = s.records.length;
  const wholeHead = spec.head(undefined, all);
  const whole = render(wholeHead, keys, serialized);
  if (withinBudget(whole, budget)) return { text: whole, shown: all };

  // Bytes and lines of everything but the header line and the records: each
  // section's opening and closing lines with the newlines before them, and
  // the closing brace with its own. A record is charged its comma and the
  // newline before it.
  let structure = 2;
  for (const key of keys) structure += utf8Length(`${JSON.stringify(key)}:[`) + 1 + 3;
  const fixedLines = 2 + 2 * keys.length;
  const headBytes = utf8Length(headLine(wholeHead, keys.length));
  let reserve = headBytes + HEAD_RESERVE;
  for (let attempt = 0; attempt < FIT_ATTEMPTS; attempt++) {
    const planned = plan(
      spec.sections,
      serialized,
      budget.bytes - structure - reserve,
      budget.lines - fixedLines,
    );
    if (!planned) break;
    const text = render(spec.head(planned.stop, planned.shown), keys, planned.rows);
    if (withinBudget(text, budget)) {
      return { text, ...(planned.stop && { stop: planned.stop }), shown: planned.shown };
    }
    reserve += Math.max(utf8Length(text) - budget.bytes, 0) + 256;
  }
  const none: Record<string, number> = {};
  for (const key of keys) none[key] = 0;
  // A header that leaves no room is the cause whatever the records hold.
  const cause =
    headBytes + structure + HEAD_RESERVE > budget.bytes
      ? headerTooLarge(wholeHead, headBytes, budget)
      : "the output's first record does not fit within the output budget, even in part";
  return { text: writeError(cause, { trimmed: true }), shown: none };
}

/** Why a header left no room: its size and its largest field. */
function headerTooLarge(head: OutputHead, headBytes: number, budget: OutputBudget): string {
  let largest = "";
  let largestBytes = 0;
  for (const [key, value] of Object.entries(head.fields)) {
    const bytes = utf8Length(JSON.stringify(value) ?? "");
    if (bytes > largestBytes) {
      largest = key;
      largestBytes = bytes;
    }
  }
  const field = largest ? `, ${largestBytes} of them in its "${largest}" field` : "";
  return `the output's header alone is ${headBytes} bytes${field}, which leaves no room for any record within the ${budget.bytes}-byte output budget`;
}

// ── Parts and messages ───────────────────────────────────────────────────────

/** The text fields a part is cut in, in the order an output shows them. */
export const PART_TEXT_FIELDS: readonly PartTextField[] = [
  "content",
  "title",
  "input",
  "output",
  "error",
];

function isPartTextField(value: unknown): value is PartTextField {
  return (PART_TEXT_FIELDS as readonly unknown[]).includes(value);
}

/**
 * Where shown output stops or resumes inside a message: at part `part`
 * (whole), or inside it at `offset` of text field `field`. `field` and
 * `offset` are set together or not at all.
 */
export type PartPosition = { part: string; field?: PartTextField; offset?: number };

/** Where shown output stops or resumes inside a message list: at message
 *  `message`, at its start or at `at` inside it. */
export type MessagePosition = { message: string; at?: PartPosition };

/** A field's text as offsets count it: a string as is, anything else as its
 *  JSON. */
function fieldText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

/** The text fields `part` holds, in show order. */
function presentFields(part: PartOutput): PartTextField[] {
  return PART_TEXT_FIELDS.filter((field) => part[field] !== undefined);
}

/**
 * `part` resumed at `offset` of `field`: the text fields before `field` left
 * out, `field` from `offset` on, and `resumedAt` saying so. Undefined when
 * the part has no such field or the offset is past its end.
 */
export function resumePart(
  part: PartOutput,
  field: PartTextField,
  offset: number,
): PartOutput | undefined {
  const value = part[field];
  if (value === undefined) return undefined;
  const text = fieldText(value);
  if (offset < 0 || offset > text.length) return undefined;
  const present = presentFields(part);
  const from = present.indexOf(field);
  if (offset === 0 && from === 0) return part;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(part)) {
    const index = present.indexOf(key as PartTextField);
    if (index !== -1 && index < from) continue;
    out[key] = key === field && offset > 0 ? text.slice(offset) : val;
  }
  out.resumedAt = { field, offset };
  return out as PartOutput;
}

/** `part` showing its text fields before `present[upTo]` whole, `shown` as
 *  that field's text, none after it, and `cutAt`. */
function cutPart(
  part: PartOutput,
  present: readonly PartTextField[],
  upTo: number,
  shown: string,
  cutAt: NonNullable<PartOutput["cutAt"]>,
): PartOutput {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(part)) {
    const index = present.indexOf(key as PartTextField);
    if (index > upTo) continue;
    out[key] = index === upTo ? shown : val;
  }
  out.cutAt = cutAt;
  return out as PartOutput;
}

/**
 * The largest leading piece of `part` that serializes within `bytes`: its
 * text fields in show order, the first that does not fit cut at the longest
 * prefix that does, with `cutAt` naming the cut. `rest` is where the rest
 * starts, as an offset into the field's whole text (counting from before a
 * `resumedAt` offset). Undefined when no piece holding any content fits.
 */
export function fitPart(
  part: PartOutput,
  bytes: number,
): Fitted<PartOutput, PartPosition> | undefined {
  const present = presentFields(part);
  const resumed = part.resumedAt;
  let best: Fitted<PartOutput, PartPosition> | undefined;
  for (let i = 0; i < present.length; i++) {
    const field = present[i]!;
    const text = fieldText(part[field]);
    const start = resumed?.field === field ? resumed.offset : 0;
    const length = start + text.length;
    // The piece with this field empty, its cut offset at the widest value it
    // can take, prices everything but the field's own text.
    const shell = cutPart(part, present, i, "", { field, offset: length, length });
    const base = bytesWithin(JSON.stringify(shell), bytes);
    if (base === undefined) break;
    // Longest prefix whose JSON string fits beside the shell (whose empty
    // string already paid for the quotes).
    let lo = 0;
    let hi = Math.min(text.length, bytes - base);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const cost = bytesWithin(JSON.stringify(text.slice(0, mid)), bytes - base + 2);
      if (cost !== undefined) lo = mid;
      else hi = mid - 1;
    }
    const n = safeCut(text, lo);
    if (i > 0 || n > 0) {
      best = {
        record: cutPart(part, present, i, text.slice(0, n), {
          field,
          offset: start + n,
          length,
        }),
        rest: { part: part.id, field, offset: start + n },
      };
    }
    // A field shown whole moves on to the next one.
    if (n < text.length || i === present.length - 1) break;
  }
  return best;
}

/** The JSON array of `items`' serializations: how many fit `bytes` whole. */
function wholeFit(serialized: readonly string[], bytes: number): { count: number; used: number } {
  let used = 2;
  let count = 0;
  for (const text of serialized) {
    const sep = count > 0 ? 1 : 0;
    const cost = bytesWithin(text, bytes - used - sep);
    if (cost === undefined) break;
    used += sep + cost;
    count++;
  }
  return { count, used };
}

/**
 * The leading parts of `parts` whose JSON array fits `bytes`, the first part
 * not shown whole cut inside it when any of it fits. `rest` is where the rest
 * starts, unset when every part is shown whole. Undefined when not even a
 * piece of the first part fits.
 */
export function fitPartList(
  parts: readonly PartOutput[],
  bytes: number,
): { parts: PartOutput[]; rest?: PartPosition } | undefined {
  const { count, used } = wholeFit(
    parts.map((part) => JSON.stringify(part)),
    bytes,
  );
  if (count === parts.length) return { parts: [...parts] };
  const shown = parts.slice(0, count);
  const next = parts[count]!;
  const cut = fitPart(next, bytes - used - (count > 0 ? 1 : 0));
  if (cut) return { parts: [...shown, cut.record], rest: cut.rest };
  return count > 0 ? { parts: shown, rest: { part: next.id } } : undefined;
}

/**
 * The largest leading piece of `item` that serializes within `bytes`: its
 * message envelope with the parts {@link fitPartList} fits. `rest` is where
 * the rest of the message starts. Undefined when no part content fits.
 */
export function fitMessage(
  item: MessageItem,
  bytes: number,
): Fitted<MessageItem, PartPosition> | undefined {
  const shell = bytesWithin(JSON.stringify({ ...item, parts: [] }), bytes);
  if (shell === undefined) return undefined;
  const fitted = fitPartList(item.parts, bytes - shell + 2);
  if (!fitted?.rest) return undefined;
  return { record: { ...item, parts: fitted.parts }, rest: fitted.rest };
}

/**
 * The leading messages of `items` whose JSON array fits `bytes`, the first
 * message not shown whole cut inside it when any of it fits; for a message
 * list nested in a record. `rest` is where the rest starts, unset when every
 * message is shown whole. Undefined when not even a piece of the first
 * message fits.
 */
export function fitMessageList(
  items: readonly MessageItem[],
  bytes: number,
): { items: MessageItem[]; rest?: MessagePosition } | undefined {
  const { count, used } = wholeFit(
    items.map((item) => JSON.stringify(item)),
    bytes,
  );
  if (count === items.length) return { items: [...items] };
  const shown = items.slice(0, count);
  const next = items[count]!;
  const cut = fitMessage(next, bytes - used - (count > 0 ? 1 : 0));
  if (cut)
    return { items: [...shown, cut.record], rest: { message: next.message.id, at: cut.rest } };
  return count > 0 ? { items: shown, rest: { message: next.message.id } } : undefined;
}

/** `parts` resumed at `at`: from part `at.part` on, that part resumed inside
 *  it when `at` names a field. Undefined when the part or its field is gone. */
export function resumeParts(
  parts: readonly PartOutput[],
  at: PartPosition,
): PartOutput[] | undefined {
  const index = parts.findIndex((part) => part.id === at.part);
  if (index === -1) return undefined;
  const first =
    at.field !== undefined ? resumePart(parts[index]!, at.field, at.offset ?? 0) : parts[index];
  if (!first) return undefined;
  return [first, ...parts.slice(index + 1)];
}

/** `item` resumed at `at` (see {@link resumeParts}). */
export function resumeMessage(item: MessageItem, at: PartPosition): MessageItem | undefined {
  const parts = resumeParts(item.parts, at);
  return parts ? { ...item, parts } : undefined;
}

/** `items` resumed at `at`: from message `at.message` on, that message
 *  resumed inside it when `at.at` is set. Undefined when it is gone. */
export function resumeMessageList(
  items: readonly MessageItem[],
  at: MessagePosition,
): MessageItem[] | undefined {
  const index = items.findIndex((item) => item.message.id === at.message);
  if (index === -1) return undefined;
  const first = at.at ? resumeMessage(items[index]!, at.at) : items[index];
  if (!first) return undefined;
  return [first, ...items.slice(index + 1)];
}

/** A history message as tool output: {@link formatMsg}, plus `partial` with
 *  the `recall_get` cursor that reads the rest when a read cut it short. */
export function messageItem(message: HistoryMessage): MessageItem {
  const item = formatMsg(message);
  const partial = message.partial;
  if (!partial) return item;
  return {
    ...item,
    partial: {
      omittedParts: partial.omittedParts,
      omittedBytes: partial.omittedBytes,
      cursor: encodeGetCursor({ message: message.info.id, ordinal: partial.nextOrdinal }),
    },
  };
}

// ── Continuations ────────────────────────────────────────────────────────────

export type Decoded<T> = { ok: true; value: T } | { ok: false; error: string };

const TOKEN_PREFIX = "rc.";
const TOKEN_VERSION = 1;

type TokenValue = string | number | null | undefined;

/** Whether `cursor` is a continuation this plugin wrote (as opposed to a
 *  history source's own page cursor). */
export function isContinuation(cursor: string): boolean {
  return cursor.startsWith(TOKEN_PREFIX);
}

function toBase64url(text: string): string {
  let binary = "";
  for (const byte of utf8.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): string {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** A continuation for tool `tool` carrying `fields` (undefined ones left
 *  out). */
export function encodeContinuation(tool: string, fields: Record<string, TokenValue>): string {
  const payload: Record<string, unknown> = { v: TOKEN_VERSION, k: tool };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) payload[key] = value;
  }
  return `${TOKEN_PREFIX}${toBase64url(JSON.stringify(payload))}`;
}

/** The fields of a continuation for tool `tool`. Never throws: anything that
 *  is not one, or belongs to another tool, is an error. */
export function decodeContinuation(tool: string, cursor: string): Decoded<Record<string, unknown>> {
  const invalid = { ok: false as const, error: `Invalid cursor: ${cursor.slice(0, 64)}` };
  if (!isContinuation(cursor)) return invalid;
  let payload: unknown;
  try {
    payload = JSON.parse(fromBase64url(cursor.slice(TOKEN_PREFIX.length)));
  } catch {
    return invalid;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return invalid;
  const fields = payload as Record<string, unknown>;
  if (fields.v !== TOKEN_VERSION || typeof fields.k !== "string") return invalid;
  if (fields.k !== tool) {
    return { ok: false, error: `This cursor continues ${fields.k}, not ${tool}` };
  }
  return { ok: true, value: fields };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positionFields(at: PartPosition | undefined): Record<string, TokenValue> {
  return at ? { part: at.part, field: at.field, offset: at.offset } : {};
}

/** The part position in `fields`: undefined when it names none, null when
 *  what it names is malformed. */
function readPosition(fields: Record<string, unknown>): PartPosition | undefined | null {
  const { part, field, offset } = fields;
  if (part === undefined) return field === undefined && offset === undefined ? undefined : null;
  if (!nonEmptyString(part)) return null;
  if (field === undefined && offset === undefined) return { part };
  if (!isPartTextField(field) || !isOffset(offset)) return null;
  return { part, field, offset };
}

/** A message position from `anchorId` and the part fields: undefined when
 *  there is no anchor, null when malformed. */
function readMessagePosition(fields: Record<string, unknown>): MessagePosition | undefined | null {
  const at = readPosition(fields);
  const anchor = fields.anchorId;
  if (at === null) return null;
  if (anchor === undefined) return at === undefined ? undefined : null;
  if (!nonEmptyString(anchor)) return null;
  return { message: anchor, ...(at && { at }) };
}

function decodeWith<T>(
  tool: string,
  cursor: string,
  read: (fields: Record<string, unknown>) => T | null,
): Decoded<T> {
  const decoded = decodeContinuation(tool, cursor);
  if (!decoded.ok) return decoded;
  const value = read(decoded.value);
  return value === null
    ? { ok: false, error: `Invalid cursor: ${cursor.slice(0, 64)}` }
    : { ok: true, value };
}

/**
 * A `recall_get` position: the message, the part ordinal its history read
 * starts at (unset for a read from the start) and where in that read the
 * output resumes (unset for its start). Token fields: `m`, `ordinal`, `part`,
 * `field`, `offset`.
 */
export type GetCursor = { message: string; ordinal?: number; at?: PartPosition };

export function encodeGetCursor(c: GetCursor): string {
  return encodeContinuation("recall_get", {
    m: c.message,
    ordinal: c.ordinal,
    ...positionFields(c.at),
  });
}

export function decodeGetCursor(cursor: string): Decoded<GetCursor> {
  return decodeWith("recall_get", cursor, (fields) => {
    const { m: message, ordinal } = fields;
    const at = readPosition(fields);
    if (!nonEmptyString(message) || at === null) return null;
    if (ordinal !== undefined && !isOffset(ordinal)) return null;
    return {
      message,
      ...(isOffset(ordinal) && { ordinal }),
      ...(at && { at }),
    };
  });
}

/**
 * A `recall_context` position: the center message the window was read
 * around and the message (and place in it) the output resumes at. Token
 * fields: `c`, `anchorId`, `part`, `field`, `offset`.
 */
export type ContextCursor = { center: string; at: MessagePosition };

export function encodeContextCursor(c: ContextCursor): string {
  return encodeContinuation("recall_context", {
    c: c.center,
    anchorId: c.at.message,
    ...positionFields(c.at.at),
  });
}

export function decodeContextCursor(cursor: string): Decoded<ContextCursor> {
  return decodeWith("recall_context", cursor, (fields) => {
    const center = fields.c;
    const at = readMessagePosition(fields);
    if (!nonEmptyString(center) || !at) return null;
    return { center, at };
  });
}

/**
 * A `recall_messages` position: the session, the history source's cursor of
 * the page (null for the newest page) and, when the output resumes inside
 * that page rather than at its start, the message (and place in it) it
 * resumes at. Token fields: `s`, `page`, `anchorId`, `part`, `field`,
 * `offset`.
 */
export type MessagesCursor = { session: string; page: string | null; at?: MessagePosition };

export function encodeMessagesCursor(c: MessagesCursor): string {
  return encodeContinuation("recall_messages", {
    s: c.session,
    page: c.page,
    anchorId: c.at?.message,
    ...positionFields(c.at?.at),
  });
}

export function decodeMessagesCursor(cursor: string): Decoded<MessagesCursor> {
  return decodeWith("recall_messages", cursor, (fields) => {
    const session = fields.s;
    const page =
      fields.page === null ? null : nonEmptyString(fields.page) ? fields.page : undefined;
    const at = readMessagePosition(fields);
    if (!nonEmptyString(session) || page === undefined || at === null) return null;
    return { session, page, ...(at && { at }) };
  });
}

/**
 * A `recall_sessions` position in the listing it was made from: the first
 * session not shown (`anchor`), the sessions listed before it as their
 * count (`shown`) and a fingerprint of their ids in any order (`ids`), and a
 * fingerprint of the listing from the anchor on (`rest`) over the
 * `restCount` sessions the call that made it held from there. The same
 * listing resumes at the anchor only while all of these still hold, so no
 * session is skipped or shown twice. A cursor that resumes a trimmed page
 * says how many of the page's sessions are left from the anchor on
 * (`left`); one without it starts the next page. Token fields: `anchorId`,
 * `n`, `h`, `t`, `r`, `l`.
 */
export type SessionsCursor = {
  anchor: string;
  shown: number;
  ids: string;
  rest: string;
  restCount: number;
  left?: number;
};

export function encodeSessionsCursor(c: SessionsCursor): string {
  return encodeContinuation("recall_sessions", {
    anchorId: c.anchor,
    n: c.shown,
    h: c.ids,
    t: c.rest,
    r: c.restCount,
    l: c.left,
  });
}

export function decodeSessionsCursor(cursor: string): Decoded<SessionsCursor> {
  return decodeWith("recall_sessions", cursor, (fields) => {
    const { anchorId: anchor, n: shown, h: ids, t: rest, r: restCount, l: left } = fields;
    if (!nonEmptyString(anchor) || !nonEmptyString(ids) || !nonEmptyString(rest)) return null;
    if (!isOffset(shown) || !isOffset(restCount) || restCount < 1) return null;
    if (left !== undefined && (!isOffset(left) || left < 1)) return null;
    return { anchor, shown, ids, rest, restCount, ...(left !== undefined && { left }) };
  });
}

/**
 * A `recall` position. The output lists the results, then the expansions;
 * this names the first record not shown.
 *
 * - `query`: a fingerprint of the normalized arguments of the search it
 *   continues. The caller passes the same arguments with the cursor; a
 *   different fingerprint is refused.
 * - `after`/`before`: the time bounds that search resolved, reused so a
 *   relative bound (`last: "7d"`) does not move between the calls.
 * - `result`: the anchor result (the first result not shown, or for a stop
 *   inside the expansions the result the expansion belongs to), by index and
 *   identity.
 * - `shown`: a fingerprint of what the anchor depends on: the results up to
 *   and including it, plus, for a stop inside the expansions, every result
 *   and the expansions up to and including the stopped one.
 * - `expansion`: for a stop inside the expansions, the expansion's index and
 *   where in it the output resumes (unset for its start).
 *
 * The continuation re-runs the search and resumes only while the re-run
 * reproduces all of these; otherwise it is refused, so no record is ever
 * skipped or shown twice. Token fields: `q`, `after`, `before`, `ri`, `rs`,
 * `rp`, `h`, `x`, `anchorId`, `part`, `field`, `offset`.
 */
export type RecallCursor = {
  query: string;
  after?: number;
  before?: number;
  result: { index: number; sessionID: string; partID: string };
  shown: string;
  expansion?: { index: number; at?: MessagePosition };
};

export function encodeRecallCursor(c: RecallCursor): string {
  const at = c.expansion?.at;
  return encodeContinuation("recall", {
    q: c.query,
    after: c.after,
    before: c.before,
    ri: c.result.index,
    rs: c.result.sessionID,
    rp: c.result.partID,
    h: c.shown,
    x: c.expansion?.index,
    anchorId: at?.message,
    ...positionFields(at?.at),
  });
}

function isTime(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

export function decodeRecallCursor(cursor: string): Decoded<RecallCursor> {
  return decodeWith("recall", cursor, (fields) => {
    const { q: query, after, before, ri: index, rs: sessionID, rp: partID, h: shown, x } = fields;
    if (!nonEmptyString(query) || !nonEmptyString(shown)) return null;
    if (!nonEmptyString(sessionID) || !nonEmptyString(partID) || !isOffset(index)) return null;
    if (!isTime(after) || !isTime(before)) return null;
    // A position inside an expansion needs the expansion.
    const at = readMessagePosition(fields);
    if (at === null || (x === undefined ? at !== undefined : !isOffset(x))) return null;
    return {
      query,
      ...(after !== undefined && { after }),
      ...(before !== undefined && { before }),
      result: { index, sessionID, partID },
      shown,
      ...(isOffset(x) && { expansion: { index: x, ...(at && { at }) } }),
    };
  });
}
