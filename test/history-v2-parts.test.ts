import { afterEach, describe, expect, it } from "vitest";
import type { Part } from "@opencode-ai/sdk/v2";
import type { HistoryMessage } from "../src/history/model.js";
import {
  createHistoryDriftState,
  createUnavailableSource,
  emptyReadCounts,
  MalformedSessionError,
  type HistoryReadCounts,
  type HistorySource,
  type MessagePage,
} from "../src/history/source.js";
import {
  checkV2Schema,
  createV2HistorySource,
  cutNote,
  openOpencodeDb,
  oversizedNote,
  type V2SourceOptions,
} from "../src/history/v2.js";
import {
  assistantMessage,
  bundle,
  completedToolPart,
  errorToolPart,
  makeFakeHarness,
  pendingToolPart,
  PROJECT_DIR,
  reasoningPart,
  runningToolPart,
  session as v1Session,
  textPart,
  userMessage,
} from "./helpers.js";
import {
  insertMessage,
  insertPart,
  insertProject,
  insertSession,
  limitSpy,
  makeV2Db,
  makeV2PartsDb,
  V2_BASE_MIGRATION,
  V2_DDL,
  V2_PART_DDL,
  V2_PARTS_MIGRATION,
  violatesLimitRule,
  writeFork,
  writeV1Corpus,
  type V2TestDb,
} from "./v2-db.js";

/**
 * The v2 source over opencode 2.4's `session_part` rows: the merge of part
 * rows and inline content, the page byte and part-row budget, cut messages
 * and their continuation, placeholders, drift counts, forks and the schema
 * probe. Every source reads through the LIMIT spy, which throws on a
 * `session_message` or `session_part` statement without `LIMIT ?`.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const noYield = async (): Promise<void> => {};
const encoder = new TextEncoder();
/** Encoded UTF-8 bytes of a stored `data` value. */
const bytesOf = (data: unknown): number =>
  encoder.encode(typeof data === "string" ? data : JSON.stringify(data)).length;

type Item = Record<string, unknown>;
const txt = (text: string): Item => ({ type: "text", text });

const partText = (part: Part | undefined): string | undefined =>
  part?.type === "text" || part?.type === "reasoning" ? part.text : undefined;

/** Counts with only the named fields set. */
const counts = (set: Partial<HistoryReadCounts>): HistoryReadCounts => ({
  ...emptyReadCounts(),
  ...set,
});

// ── Fixture writers ──────────────────────────────────────────────────────────

type Fixture = {
  t: V2TestDb;
  session(id: string, extra?: Partial<Parameters<typeof insertSession>[1]>): void;
  user(sessionID: string, text: string, o?: { time?: number; id?: string }): string;
  /**
   * An assistant row with `parts` written as part rows (at `ordinals`, by
   * default 0, 1, ...; a string is written raw, with its `types` entry as the
   * type column) and `inline` as its `data.content`.
   */
  assistant(
    sessionID: string,
    o?: {
      parts?: unknown[];
      ordinals?: number[];
      types?: Array<string | undefined>;
      inline?: unknown[];
      completed?: boolean;
      extra?: Item;
      time?: number;
      id?: string;
    },
  ): string;
  /** Encoded bytes of a message row's data and of its part rows by ordinal. */
  sizes: Map<string, { envelope: number; parts: Map<number, number> }>;
};

let seq = 0;

/** Writers over a fresh database. Seqs restart per database, so two
 *  databases written the same way hold the same rows. */
function fixture(t: V2TestDb): Fixture {
  seq = 0;
  insertProject(t.db, { id: "prj", worktree: "/w/app" });
  const sizes: Fixture["sizes"] = new Map();
  return {
    t,
    sizes,
    session(id, extra = {}) {
      insertSession(t.db, {
        id,
        project_id: "prj",
        directory: "/w/app",
        time_created: 1_000,
        time_updated: 1_000,
        ...extra,
      });
    },
    user(sessionID, text, o = {}) {
      const n = ++seq;
      const id = o.id ?? `msg_${sessionID}_${n}`;
      const data = { text, time: { created: 0 } };
      insertMessage(t.db, {
        id,
        session_id: sessionID,
        type: "user",
        seq: n,
        time_created: o.time ?? 2_000 + n,
        data,
      });
      sizes.set(id, { envelope: bytesOf(data), parts: new Map() });
      return id;
    },
    assistant(sessionID, o = {}) {
      const n = ++seq;
      const id = o.id ?? `msg_${sessionID}_${n}`;
      const time = o.time ?? 2_000 + n;
      const data = {
        agent: "build",
        model: { id: "m-1", providerID: "p-1" },
        content: o.inline ?? [],
        time: { created: 0, ...(o.completed === false ? {} : { completed: 1 }) },
        ...o.extra,
      };
      insertMessage(t.db, {
        id,
        session_id: sessionID,
        type: "assistant",
        seq: n,
        time_created: time,
        data,
      });
      const parts = new Map<number, number>();
      (o.parts ?? []).forEach((item, i) => {
        const ordinal = o.ordinals?.[i] ?? i;
        const type = o.types?.[i];
        insertPart(t.db, {
          message_id: id,
          session_id: sessionID,
          ordinal,
          time_created: time,
          data: item,
          ...(type !== undefined ? { type } : {}),
        });
        parts.set(ordinal, bytesOf(item));
      });
      sizes.set(id, { envelope: bytesOf(data), parts });
      return id;
    },
  };
}

async function partsFixture(): Promise<Fixture> {
  const t = await makeV2PartsDb();
  cleanups.push(t.cleanup);
  return fixture(t);
}

/** Open a written database through the production path, behind the LIMIT spy. */
async function open(t: V2TestDb, opts: V2SourceOptions = {}) {
  const opened = await openOpencodeDb(t.path);
  if (!opened.ok) throw new Error(opened.reason);
  cleanups.push(() => opened.db.close());
  const spy = limitSpy(opened.db);
  const source = createV2HistorySource(spy, { yieldBetween: noYield, ...opts });
  return { source, spy, schema: opened.schema };
}

/** Every page of a session, newest first. */
async function pages(
  source: HistorySource,
  sessionID: string,
  limit: number,
  strict = false,
): Promise<MessagePage[]> {
  const out: MessagePage[] = [];
  let before: string | undefined;
  do {
    const page = await source.messagePage({ sessionID, limit, before, strict });
    out.push(page);
    before = page.nextCursor ?? undefined;
    if (out.length > 500) throw new Error("page walk did not terminate");
  } while (before !== undefined);
  return out;
}

async function point(
  source: HistorySource,
  sessionID: string,
  messageID: string,
  partOrdinal?: number,
): Promise<HistoryMessage> {
  const got = await source.getMessage(
    sessionID,
    messageID,
    partOrdinal === undefined ? undefined : { partOrdinal },
  );
  if (!got.ok) throw new Error(`${got.reason}: ${got.error ?? ""}`);
  return got.value;
}

/**
 * A message read through `getMessage` continuations from `first` until a read
 * is no longer partial. `parts` drops each partial read's closing note.
 */
async function complete(source: HistorySource, sessionID: string, first: HistoryMessage) {
  const reads = [first];
  let current = first;
  while (current.partial) {
    current = await point(source, sessionID, current.info.id, current.partial.nextOrdinal);
    reads.push(current);
    if (reads.length > 200) throw new Error("continuation did not terminate");
  }
  const parts = reads.flatMap((m) => (m.partial ? m.parts.slice(0, -1) : m.parts));
  return { parts, reads };
}

/** Part id suffixes after `${messageId}:`. */
const suffixes = (m: HistoryMessage): string[] =>
  m.parts.map((p) => p.id.slice(m.info.id.length + 1));

// ── Layouts ──────────────────────────────────────────────────────────────────

describe("v2 source: assistant content layouts", () => {
  const sid = "ses_layout";

  function corpus() {
    const s = v1Session(sid, "Layouts", PROJECT_DIR, 90_000);
    const at = (n: number) => 10_000 + n * 1_000;
    const synthetic: Part = {
      id: "p3s",
      sessionID: sid,
      messageID: "m3",
      type: "text",
      text: "injected context",
      synthetic: true,
    };
    const messages = [
      bundle(userMessage("m1", sid, at(1)), [textPart("p1", sid, "m1", "first prompt")]),
      bundle(assistantMessage("m2", sid, at(2)), [
        reasoningPart("p2a", sid, "m2", "thinking about the parser"),
        textPart("p2b", sid, "m2", "Running the tests now: é€ü"),
        completedToolPart("p2c", sid, "m2", "bash", { command: "npm test" }, "12 passed"),
        errorToolPart("p2d", sid, "m2", "read", { path: "missing.ts" }, "file not found"),
      ]),
      bundle(userMessage("m3", sid, at(3)), [
        textPart("p3", sid, "m3", "second prompt"),
        synthetic,
      ]),
      bundle(assistantMessage("m4", sid, at(4)), [textPart("p4", sid, "m4", "short reply")]),
      bundle(assistantMessage("m5", sid, at(5)), [
        runningToolPart("p5a", sid, "m5", { command: "npm run build" }),
        pendingToolPart("p5b", sid, "m5", { command: "npm run lint" }),
        textPart("p5c", sid, "m5", "waiting on both"),
      ]),
      bundle(assistantMessage("m6", sid, at(6)), []),
    ];
    return { sessions: [s], messages: { [sid]: messages } };
  }

  /** Every page (at several limits) and every point read of the corpus. */
  async function readAll(make: () => Promise<V2TestDb>, layout: "inline" | "parts" | "mixed") {
    const t = await make();
    cleanups.push(t.cleanup);
    const c = corpus();
    writeV1Corpus(t.db, c.sessions, c.messages, layout);
    const { source } = await open(t);
    const walks: Record<number, MessagePage[]> = {};
    for (const limit of [1, 2, 50]) walks[limit] = await pages(source, sid, limit);
    const ids = walks[50]!.flatMap((p) => p.items.map((m) => m.info.id));
    const points = [];
    for (const id of ids) points.push(await point(source, sid, id));
    const hasTable = t.db.get("SELECT 1 AS n FROM sqlite_master WHERE name = 'session_part'");
    const partRows = hasTable ? Number(t.db.get("SELECT count(*) AS n FROM session_part")?.n) : 0;
    return { walks, points, partRows };
  }

  it("projects inline, part-row and mixed layouts identically, in pages and point reads", async () => {
    const before = await readAll(() => makeV2Db(), "inline");
    const reads = {
      inline: await readAll(makeV2PartsDb, "inline"),
      parts: await readAll(makeV2PartsDb, "parts"),
      mixed: await readAll(makeV2PartsDb, "mixed"),
    };
    // The part layouts really put content in part rows: m2 4, m4 1, m5 3
    // items; mixed keeps the trailing half of m2 and m5 inline.
    expect([
      before.partRows,
      reads.inline.partRows,
      reads.parts.partRows,
      reads.mixed.partRows,
    ]).toEqual([0, 0, 8, 5]);
    for (const [layout, read] of Object.entries(reads)) {
      expect(read.walks, layout).toEqual(before.walks);
      expect(read.points, layout).toEqual(before.points);
    }

    const all = before.walks[50]!.flatMap((p) => p.items);
    const byId = new Map(all.map((m) => [m.info.id, m]));
    // Part ids are positions in the merged list.
    expect(suffixes(byId.get("m2")!)).toEqual(["0", "1", "2", "3"]);
    expect(suffixes(byId.get("m5")!)).toEqual(["0", "1", "2"]);
    expect(byId.get("m6")!.parts).toEqual([]);
    expect(partText(byId.get("m2")!.parts[1])).toBe("Running the tests now: é€ü");
    // Nothing to report: no page carries counts.
    for (const read of [before, ...Object.values(reads)]) {
      for (const page of Object.values(read.walks).flat())
        expect(page).not.toHaveProperty("counts");
    }
  });

  it("keeps every part id when inline content moves into part rows after the existing ordinals", async () => {
    const f = await partsFixture();
    f.session("ses_move");
    const inline = [txt("inline one"), { type: "reasoning", text: "inline two" }];
    const id = f.assistant("ses_move", {
      parts: [txt("row zero"), txt("row five")],
      ordinals: [0, 5],
      inline,
    });
    const { source } = await open(f.t);
    const before = await point(source, "ses_move", id);
    expect(suffixes(before)).toEqual(["0", "1", "2", "3"]);

    // opencode's lazy move: inline items become part rows after the highest
    // ordinal, and the row's content empties.
    inline.forEach((item, i) => {
      insertPart(f.t.db, {
        message_id: id,
        session_id: "ses_move",
        ordinal: 6 + i,
        time_created: 1,
        data: item,
      });
    });
    const row = f.t.db.get("SELECT data FROM session_message WHERE id = ?", [id]);
    const data = JSON.parse(String(row?.data)) as Item;
    f.t.db.run("UPDATE session_message SET data = ? WHERE id = ?", [
      JSON.stringify({ ...data, content: [] }),
      id,
    ]);
    expect(await point(source, "ses_move", id)).toEqual(before);
    const [page] = await pages(source, "ses_move", 5);
    expect(page!.items[0]).toEqual(before);
  });

  it("takes the part row's type column over the type its data names", async () => {
    const f = await partsFixture();
    f.session("ses_type");
    const id = f.assistant("ses_type", {
      parts: [
        { type: "text", text: "a thought" },
        { type: "patch", text: "shown as text" },
        { type: "text", text: "never shown" },
      ],
      types: ["reasoning", "text", "patch"],
    });
    const { source } = await open(f.t);
    const [page] = await pages(source, "ses_type", 10);
    const m = page!.items[0]!;
    expect(m.info.id).toBe(id);
    expect(m.parts.map((p) => [p.type, partText(p)])).toEqual([
      ["reasoning", "a thought"],
      ["text", "shown as text"],
    ]);
    expect(page!.counts).toEqual(counts({ unknownPartTypes: 1 }));
  });
});

// ── Page budget ──────────────────────────────────────────────────────────────

describe("v2 source: one byte ceiling and part-row cap per page", () => {
  it("charges a message its part bytes, so a page splits as it would inline", async () => {
    for (const layout of ["parts", "inline"] as const) {
      const f = await partsFixture();
      f.session("ses_pb");
      // ~95-byte envelope plus two ~525-byte items: ~1,150 bytes either way.
      const items = [txt("a".repeat(500)), txt("b".repeat(500))];
      const reply =
        layout === "parts"
          ? f.assistant("ses_pb", { parts: items })
          : f.assistant("ses_pb", { inline: items });
      // ~430 bytes: fits beside the reply's envelope, not beside its content.
      const prompt = f.user("ses_pb", "c".repeat(400));
      const { source } = await open(f.t, { pageByteCeiling: 1_500 });
      const walk = await pages(source, "ses_pb", 10);
      expect(
        walk.map((p) => p.items.map((m) => m.info.id)),
        layout,
      ).toEqual([[prompt], [reply]]);
      expect(walk[1]!.items[0]!.partial, layout).toBeUndefined();
      expect(walk[1]!.items[0]!.parts.map(partText), layout).toEqual([
        "a".repeat(500),
        "b".repeat(500),
      ]);
    }
  });

  it("measures part text in encoded bytes, not characters", async () => {
    const f = await partsFixture();
    f.session("ses_mb");
    // ~530 characters but ~1,025 bytes per part: two messages fit by
    // characters and not by bytes.
    const older = f.assistant("ses_mb", { parts: [txt("é".repeat(500))] });
    const newer = f.assistant("ses_mb", { parts: [txt("é".repeat(500))] });
    const { source } = await open(f.t, { pageByteCeiling: 1_500 });
    const walk = await pages(source, "ses_mb", 10);
    expect(walk.map((p) => p.items.map((m) => m.info.id))).toEqual([[newer], [older]]);
    expect(partText(walk[0]!.items[0]!.parts[0])).toBe("é".repeat(500));
  });

  it("falls back to a CAST byte count for part rows on SQLite without octet_length", async () => {
    const f = await partsFixture();
    f.session("ses_cast");
    const older = f.assistant("ses_cast", { parts: [txt("é".repeat(500))] });
    const newer = f.assistant("ses_cast", { parts: [txt("é".repeat(500))] });
    const opened = await openOpencodeDb(f.t.path);
    if (!opened.ok) throw new Error(opened.reason);
    cleanups.push(() => opened.db.close());
    const spied = limitSpy(opened.db);
    const noOctet = (sql: string): void => {
      if (/octet_length/.test(sql)) throw new Error("no such function: octet_length");
    };
    const oldSqlite: typeof spied = {
      ...spied,
      get: (sql, params) => (noOctet(sql), spied.get(sql, params)),
      all: (sql, params) => (noOctet(sql), spied.all(sql, params)),
    };
    const source = createV2HistorySource(oldSqlite, {
      pageByteCeiling: 1_500,
      yieldBetween: noYield,
    });
    const walk = await pages(source, "ses_cast", 10);
    expect(walk.map((p) => p.items.map((m) => m.info.id))).toEqual([[newer], [older]]);
    expect(spied.statements.some((sql) => sql.includes("CAST(p.data AS BLOB)"))).toBe(true);
  });

  it("caps the part rows a page loads, and a message without parts costs none", async () => {
    const f = await partsFixture();
    f.session("ses_rows");
    const older = f.assistant("ses_rows", { parts: [txt("o1"), txt("o2")] });
    const prompt = f.user("ses_rows", "between");
    const newer = f.assistant("ses_rows", { parts: [txt("n1"), txt("n2")] });
    const { source } = await open(f.t, { pagePartRows: 3 });
    const walk = await pages(source, "ses_rows", 10);
    expect(walk.map((p) => p.items.map((m) => m.info.id))).toEqual([[newer, prompt], [older]]);
    expect(walk.every((p) => p.items.every((m) => m.partial === undefined))).toBe(true);
  });

  it("projects a part row over the ceiling as a placeholder that costs the page nothing", async () => {
    const f = await partsFixture();
    f.session("ses_big");
    const prompt = f.user("ses_big", "small prompt");
    const big = txt("z".repeat(2_000));
    const reply = f.assistant("ses_big", { parts: [txt("before"), big, txt("after")] });
    const { source } = await open(f.t, { pageByteCeiling: 1_500 });

    // Strict (the distiller) does not reject it either.
    for (const strict of [false, true]) {
      const page = await source.messagePage({ sessionID: "ses_big", limit: 10, strict });
      expect(page.items.map((m) => m.info.id)).toEqual([reply, prompt]);
      const m = page.items[0]!;
      expect(m.partial).toBeUndefined();
      expect(suffixes(m)).toEqual(["0", "1", "2"]);
      expect(m.parts.map(partText)).toEqual([
        "before",
        oversizedNote(bytesOf(big), 1_500),
        "after",
      ]);
      expect(page.counts).toEqual(counts({ oversizedParts: 1 }));
      expect(JSON.stringify(page)).not.toContain("zzzz");
    }
    expect((await point(source, "ses_big", reply)).parts.map(partText)).toEqual([
      "before",
      oversizedNote(bytesOf(big), 1_500),
      "after",
    ]);
  });

  it("re-checks part sizes in the part read: a later message that grew leads the next page", async () => {
    const f = await partsFixture();
    f.session("ses_grow");
    const older = f.assistant("ses_grow", { parts: [txt("b".repeat(300))] });
    const newer = f.assistant("ses_grow", { parts: [txt("a".repeat(300))] });
    const opened = await openOpencodeDb(f.t.path);
    if (!opened.ok) throw new Error(opened.reason);
    cleanups.push(() => opened.db.close());
    const spy = limitSpy(opened.db);
    let grown = false;
    // Right after the first part statement of the first page (its size plan,
    // under which both messages fit), the older message's part grows so the
    // two no longer fit together.
    const db: typeof spy = {
      ...spy,
      all: (sql, params) => {
        const rows = spy.all(sql, params);
        if (!grown && /\bsession_part\b/.test(sql)) {
          grown = true;
          f.t.db.run("UPDATE session_part SET data = ? WHERE message_id = ? AND ordinal = 0", [
            JSON.stringify(txt("g".repeat(1_000))),
            older,
          ]);
        }
        return rows;
      },
    };
    const source = createV2HistorySource(db, { pageByteCeiling: 1_500, yieldBetween: noYield });
    const walk = await pages(source, "ses_grow", 10);
    expect(grown).toBe(true);
    expect(walk.map((p) => p.items.map((m) => m.info.id))).toEqual([[newer], [older]]);
    expect(walk[0]).not.toHaveProperty("counts");
    expect(walk[1]!.items[0]!.partial).toBeUndefined();
    expect(partText(walk[1]!.items[0]!.parts[0])).toBe("g".repeat(1_000));
  });

  it("reads the parts of a page longer than one part statement covers", async () => {
    const f = await partsFixture();
    f.session("ses_wide");
    f.t.db.exec("BEGIN");
    const ids: string[] = [];
    for (let i = 0; i < 600; i++) {
      ids.push(
        f.assistant("ses_wide", {
          parts: [txt(`reply ${i}`)],
          id: `msg_wide_${String(i).padStart(4, "0")}`,
        }),
      );
    }
    f.t.db.exec("COMMIT");
    const { source } = await open(f.t);
    const page = await source.messagePage({ sessionID: "ses_wide", limit: 600 });
    expect(page.items.map((m) => m.info.id)).toEqual([...ids].reverse());
    expect(page.nextCursor).toBeNull();
    for (const m of page.items) {
      const i = Number(m.info.id.slice("msg_wide_".length));
      expect(m.parts.map(partText), m.info.id).toEqual([`reply ${i}`]);
    }
  });

  it("keeps every page within the ceiling and the cap, and every message readable whole", async () => {
    const f = await partsFixture();
    f.session("ses_any");
    const sizes = [40, 120, 260, 300, 90, 210, 300, 30];
    let k = 0;
    const filler = (n: number) => txt(`${"x".repeat(n - 30)}é`);
    for (let i = 0; i < 14; i++) {
      if (i % 3 === 0) {
        f.user("ses_any", `prompt ${i} ${"p".repeat(sizes[i % sizes.length]!)}`);
        continue;
      }
      const count = (i * 7) % 6;
      const parts = Array.from({ length: count }, () => filler(sizes[k++ % sizes.length]!));
      const inline = i % 4 === 1 ? [txt(`inline tail ${i}`)] : [];
      f.assistant("ses_any", { parts, inline });
    }
    const all = [...f.sizes.keys()].reverse();
    const whole = await open(f.t);
    const seen = { partial: 0, continuations: 0, shared: 0 };

    for (const ceiling of [700, 1_000, 2_000, 50_000]) {
      for (const cap of [2, 3, 2_000]) {
        for (const limit of [1, 3, 50]) {
          const label = `ceiling ${ceiling} cap ${cap} limit ${limit}`;
          const { source } = await open(f.t, { pageByteCeiling: ceiling, pagePartRows: cap });
          const walk = await pages(source, "ses_any", limit);
          expect(
            walk.flatMap((p) => p.items.map((m) => m.info.id)),
            label,
          ).toEqual(all);

          /** Bytes and part rows a read of `m` loaded. */
          const loaded = (m: HistoryMessage) => {
            const own = f.sizes.get(m.info.id)!;
            const ordinals = [...own.parts.keys()].sort((a, b) => a - b);
            let bytes = own.envelope;
            let rows = 0;
            for (const suffix of suffixes(m)) {
              const pos = Number(suffix);
              if (!Number.isInteger(pos) || pos >= ordinals.length) continue;
              bytes += own.parts.get(ordinals[pos]!)!;
              rows++;
            }
            return { bytes, rows };
          };
          for (const page of walk) {
            const sum = page.items
              .map(loaded)
              .reduce((acc, x) => ({ bytes: acc.bytes + x.bytes, rows: acc.rows + x.rows }), {
                bytes: 0,
                rows: 0,
              });
            expect(sum.bytes, label).toBeLessThanOrEqual(ceiling);
            expect(sum.rows, label).toBeLessThanOrEqual(cap);
            // Only a page's first message is ever cut, and it then ends the page.
            page.items.forEach((m, i) => {
              if (m.partial) expect([i, page.items.length], label).toEqual([0, 1]);
            });
            if (page.items.length > 1) seen.shared++;
          }
          for (const m of walk.flatMap((p) => p.items)) {
            const { parts, reads } = await complete(source, "ses_any", m);
            if (m.partial) seen.partial++;
            if (reads.length > 2) seen.continuations++;
            for (const read of reads) {
              expect(loaded(read).bytes, label).toBeLessThanOrEqual(ceiling);
              expect(loaded(read).rows, label).toBeLessThanOrEqual(cap);
            }
            expect(parts, `${label} ${m.info.id}`).toEqual(
              (await point(whole.source, "ses_any", m.info.id)).parts,
            );
          }
        }
      }
    }
    // The grid reaches cut messages, chains of continuations and shared pages.
    expect(seen.partial).toBeGreaterThan(0);
    expect(seen.continuations).toBeGreaterThan(0);
    expect(seen.shared).toBeGreaterThan(0);
  });
});

// ── Cut messages ─────────────────────────────────────────────────────────────

describe("v2 source: a first message over the page", () => {
  it("cuts by bytes, ends the page with it and continues it through getMessage", async () => {
    const f = await partsFixture();
    f.session("ses_cut");
    const earlier = f.user("ses_cut", "earlier prompt");
    // A ~95-byte envelope and six ~405-byte parts: three fit 1,500 bytes.
    const items = Array.from({ length: 6 }, (_, i) => txt(`${i}`.repeat(380)));
    const long = f.assistant("ses_cut", { parts: items });
    const restBytes = items.slice(3).reduce((sum, item) => sum + bytesOf(item), 0);
    const { source } = await open(f.t, { pageByteCeiling: 1_500 });
    const whole = await open(f.t);

    for (const strict of [false, true]) {
      const first = await source.messagePage({ sessionID: "ses_cut", limit: 10, strict });
      expect(first.items.map((m) => m.info.id)).toEqual([long]);
      expect(first.nextCursor).not.toBeNull();
      expect(first.counts).toEqual(counts({ partialMessages: 1 }));
      const m = first.items[0]!;
      expect(m.partial).toEqual({ nextOrdinal: 3, omittedParts: 3, omittedBytes: restBytes });
      expect(suffixes(m).slice(0, -1)).toEqual(["0", "1", "2"]);
      expect(m.parts.at(-1)).toMatchObject({ type: "text", text: cutNote(3, restBytes, 3) });
      const second = await source.messagePage({
        sessionID: "ses_cut",
        limit: 10,
        before: first.nextCursor!,
        strict,
      });
      expect(second.items.map((x) => x.info.id)).toEqual([earlier]);
      expect(second.nextCursor).toBeNull();
    }

    // A point read is cut at the same place; the continuation is whole.
    const lookup = await point(source, "ses_cut", long);
    expect(lookup.partial).toEqual({ nextOrdinal: 3, omittedParts: 3, omittedBytes: restBytes });
    const rest = await point(source, "ses_cut", long, 3);
    expect(rest.partial).toBeUndefined();
    expect(suffixes(rest)).toEqual(["3", "4", "5"]);
    const { parts } = await complete(source, "ses_cut", lookup);
    expect(parts).toEqual((await point(whole.source, "ses_cut", long)).parts);
  });

  it("cuts by part rows, names ordinals rather than positions and keeps inline content for last", async () => {
    const f = await partsFixture();
    f.session("ses_cap");
    const ordinals = [0, 10, 20, 30, 40];
    const items = ordinals.map((o) => txt(`part at ${o}`));
    const long = f.assistant("ses_cap", {
      parts: items,
      ordinals,
      inline: [txt("tail a"), txt("tail b")],
    });
    const bytes = (from: number) =>
      items.filter((_, i) => ordinals[i]! >= from).reduce((sum, item) => sum + bytesOf(item), 0);
    const { source } = await open(f.t, { pagePartRows: 2 });
    const whole = await open(f.t);

    const [page] = await pages(source, "ses_cap", 10);
    const first = page!.items[0]!;
    // Three part rows and both inline items are left out.
    expect(first.partial).toEqual({ nextOrdinal: 20, omittedParts: 5, omittedBytes: bytes(20) });
    expect(suffixes(first).slice(0, -1)).toEqual(["0", "1"]);
    expect(partText(first.parts.at(-1))).toBe(cutNote(5, bytes(20), 20));

    const second = await point(source, "ses_cap", long, 20);
    expect(second.partial).toEqual({ nextOrdinal: 40, omittedParts: 3, omittedBytes: bytes(40) });
    expect(suffixes(second).slice(0, -1)).toEqual(["2", "3"]);

    const third = await point(source, "ses_cap", long, 40);
    expect(third.partial).toBeUndefined();
    expect(suffixes(third)).toEqual(["4", "5", "6"]);
    expect(third.parts.map(partText)).toEqual(["part at 40", "tail a", "tail b"]);

    const { parts, reads } = await complete(source, "ses_cap", first);
    expect(reads).toHaveLength(3);
    expect(parts).toEqual((await point(whole.source, "ses_cap", long)).parts);

    // Past the last part row only inline content is left, at its positions.
    const tail = await point(source, "ses_cap", long, 41);
    expect(suffixes(tail)).toEqual(["5", "6"]);
    expect(tail.partial).toBeUndefined();
  });

  it("moves past a first part the envelope leaves no room for, as a placeholder", async () => {
    const f = await partsFixture();
    f.session("ses_room");
    const first = txt("f".repeat(800));
    const long = f.assistant("ses_room", {
      parts: [first, txt("small")],
      // A ~1,000-byte envelope leaves ~500 bytes of the ceiling for parts.
      extra: { padding: "e".repeat(900) },
    });
    const envelope = f.sizes.get(long)!.envelope;
    const { source } = await open(f.t, { pageByteCeiling: 1_500 });
    const [page] = await pages(source, "ses_room", 10);
    const m = page!.items[0]!;
    expect(m.partial).toEqual({
      nextOrdinal: 1,
      omittedParts: 1,
      omittedBytes: bytesOf(txt("small")),
    });
    expect(partText(m.parts[0])).toBe(oversizedNote(bytesOf(first), 1_500 - envelope));
    expect(page!.counts).toEqual(counts({ oversizedParts: 1, partialMessages: 1 }));
    const { parts } = await complete(source, "ses_room", m);
    expect(parts.map(partText)).toEqual([oversizedNote(bytesOf(first), 1_500 - envelope), "small"]);
  });

  it("rejects a part ordinal that is not an integer", async () => {
    const f = await partsFixture();
    f.session("ses_ord");
    const id = f.assistant("ses_ord", { parts: [txt("one")] });
    const { source } = await open(f.t);
    for (const partOrdinal of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await source.getMessage("ses_ord", id, { partOrdinal })).toMatchObject({
        ok: false,
        reason: "error",
      });
    }
  });
});

// ── Malformed parts and drift ────────────────────────────────────────────────

describe("v2 source: malformed parts and drift counts", () => {
  it("projects a malformed part as a placeholder, or rejects the page under strict", async () => {
    const f = await partsFixture();
    f.session("ses_bad");
    const id = f.assistant("ses_bad", {
      parts: [txt("fine"), "{not json", "[1, 2]"],
      types: [undefined, "text", "text"],
    });
    const { source } = await open(f.t);
    const expected = [
      "fine",
      "[unavailable: data is not valid JSON]",
      "[unavailable: data is not an object]",
    ];

    const page = await source.messagePage({ sessionID: "ses_bad", limit: 10 });
    expect(page.items[0]!.parts.map(partText)).toEqual(expected);
    expect(page.counts).toEqual(counts({ malformedParts: 2 }));
    const strict = source.messagePage({ sessionID: "ses_bad", limit: 10, strict: true });
    await expect(strict).rejects.toBeInstanceOf(MalformedSessionError);
    await expect(strict).rejects.toThrow(`message ${id} part 1`);
    expect((await point(source, "ses_bad", id)).parts.map(partText)).toEqual(expected);
  });

  it("counts part rows of an unknown type, which keep their position as the same item inline does", async () => {
    const f = await partsFixture();
    f.session("ses_unk");
    const patch = { type: "patch", files: ["a.ts"] };
    const items = [txt("kept"), patch, txt("after")];
    const inline = f.assistant("ses_unk", { inline: items });
    const parted = f.assistant("ses_unk", { parts: items });
    const { source } = await open(f.t);
    const page = await source.messagePage({ sessionID: "ses_unk", limit: 10 });
    const [fromParts, fromInline] = page.items;
    expect([fromParts!.info.id, fromInline!.info.id]).toEqual([parted, inline]);
    expect(suffixes(fromParts!)).toEqual(["0", "2"]);
    expect(suffixes(fromInline!)).toEqual(["0", "2"]);
    // Only part rows are counted.
    expect(page.counts).toEqual(counts({ unknownPartTypes: 1 }));
    expect(source.history!().unknownPartTypeNames).toEqual(["patch"]);
  });

  it("counts a completed reply that projects nothing although it has part rows", async () => {
    const f = await partsFixture();
    f.session("ses_empty");
    const unknown = [{ type: "step-start" }];
    f.assistant("ses_empty", { parts: unknown });
    // Still streaming: an empty projection is expected there.
    f.assistant("ses_empty", { parts: unknown, completed: false });
    // Completed without part rows: nothing was lost.
    f.assistant("ses_empty", {});
    const { source } = await open(f.t);
    const page = await source.messagePage({ sessionID: "ses_empty", limit: 10 });
    expect(page.items.map((m) => m.parts)).toEqual([[], [], []]);
    expect(page.counts).toEqual(counts({ emptyWithParts: 1, unknownPartTypes: 2 }));
  });

  it("counts part rows attached to a user message and leaves the message as it is", async () => {
    const f = await partsFixture();
    f.session("ses_stray");
    const prompt = f.user("ses_stray", "a prompt");
    for (const ordinal of [0, 1]) {
      insertPart(f.t.db, {
        message_id: prompt,
        session_id: "ses_stray",
        ordinal,
        time_created: 1,
        data: txt(`stray ${ordinal}`),
      });
    }
    const { source } = await open(f.t);
    const page = await source.messagePage({ sessionID: "ses_stray", limit: 10 });
    expect(page.items[0]!.parts.map((p) => [p.id, partText(p)])).toEqual([
      [`${prompt}:t`, "a prompt"],
    ]);
    expect(page.counts).toEqual(counts({ strayParts: 2 }));
  });

  it("adds every read into one drift state per database handle, shared by its facades", async () => {
    const f = await partsFixture();
    f.session("ses_drift");
    const unknown = f.assistant("ses_drift", { parts: [txt("ok"), { type: "patch" }] });
    f.assistant("ses_drift", { parts: ["{bad"], types: ["text"] });
    const opened = await openOpencodeDb(f.t.path);
    if (!opened.ok) throw new Error(opened.reason);
    cleanups.push(() => opened.db.close());
    const spy = limitSpy(opened.db);
    const global = createV2HistorySource(spy, { yieldBetween: noYield });
    const project = createV2HistorySource(spy, { projectID: "prj", yieldBetween: noYield });

    expect(global.history!()).toEqual({
      capabilities: { parts: true },
      migration: { newest: V2_PARTS_MIGRATION, tested: true },
      unknownTables: [],
      missingColumns: [],
      unknownPartTypeNames: [],
      reads: 0,
      counts: emptyReadCounts(),
    });
    await global.messagePage({ sessionID: "ses_drift", limit: 1 });
    await project.getMessage("ses_drift", unknown);
    const drift = project.history!();
    expect(drift).toEqual(global.history!());
    expect(drift).toMatchObject({
      reads: 2,
      unknownPartTypeNames: ["patch"],
      counts: counts({ unknownPartTypes: 1, malformedParts: 1 }),
    });

    // A source given its own state records there and nowhere else.
    const state = createHistoryDriftState({
      capabilities: { parts: true },
      migration: { newest: null, tested: false },
      unknownTables: [],
      missingColumns: [],
    });
    const own = createV2HistorySource(spy, { drift: state, yieldBetween: noYield });
    await own.getMessage("ses_drift", unknown);
    expect(state.snapshot().reads).toBe(1);
    expect(own.history!()).toEqual(state.snapshot());
    expect(global.history!().reads).toBe(2);

    // Another handle on the same file starts from nothing.
    const other = await open(f.t);
    expect(other.source.history!().reads).toBe(0);
  });

  it("keeps a bounded, sorted set of unknown part type names and hands out copies", () => {
    const state = createHistoryDriftState({
      capabilities: { parts: true },
      migration: { newest: null, tested: false },
      unknownTables: [],
      missingColumns: [],
    });
    const names = Array.from({ length: 40 }, (_, i) => `type-${String(39 - i).padStart(2, "0")}`);
    state.record(counts({ unknownPartTypes: 40 }), names);
    state.record(counts({ strayParts: 2 }), ["type-39"]);
    const snapshot = state.snapshot();
    expect(snapshot.unknownPartTypeNames.length).toBeLessThan(40);
    expect(snapshot.unknownPartTypeNames).toEqual([...snapshot.unknownPartTypeNames].sort());
    expect(snapshot.counts).toEqual(counts({ unknownPartTypes: 40, strayParts: 2 }));
    expect(snapshot.reads).toBe(2);
    snapshot.counts.strayParts = 99;
    snapshot.unknownPartTypeNames.push("mutated");
    expect(state.snapshot().counts.strayParts).toBe(2);
    expect(state.snapshot().unknownPartTypeNames).not.toContain("mutated");
  });

  it("is absent on v1 and unavailable sources", () => {
    expect(makeFakeHarness().source.history).toBeUndefined();
    expect(createUnavailableSource("v2-sqlite", "no database").history).toBeUndefined();
  });
});

// ── Forks ────────────────────────────────────────────────────────────────────

describe("v2 source: forks", () => {
  /** A parent with part-row and mixed replies, forked in `style`, then one
   *  turn in the fork. Ids are fixed so both styles can be compared. */
  async function forked(style: "parts" | "inline") {
    const f = await partsFixture();
    f.session("ses_parent");
    f.user("ses_parent", "parent prompt", { id: "p_u1" });
    f.assistant("ses_parent", {
      id: "p_a1",
      parts: [txt("parent answer"), { type: "reasoning", text: "parent thought" }],
    });
    f.assistant("ses_parent", {
      id: "p_a2",
      parts: [txt("mixed head")],
      inline: [txt("mixed tail")],
    });
    const { source } = await open(f.t);
    const parentBefore = await pages(source, "ses_parent", 2);
    const copied = writeFork(f.t.db, {
      parentID: "ses_parent",
      forkID: "ses_fork",
      created: 9_000,
      style,
    });
    f.user("ses_fork", "fork prompt", { id: "f_u1", time: 9_100 });
    f.assistant("ses_fork", { id: "f_a1", parts: [txt("fork answer")], time: 9_200 });
    return {
      source,
      copied,
      parentBefore,
      parentAfter: await pages(source, "ses_parent", 2),
      fork: await pages(source, "ses_fork", 10),
    };
  }

  it("reads a 2.4.1 fork and a 2.2.5 inline fork the same, leaving the parent as it was", async () => {
    const parts = await forked("parts");
    const inline = await forked("inline");
    for (const read of [parts, inline]) {
      expect(read.parentAfter).toEqual(read.parentBefore);
      // Copied rows predate the fork and are the parent's history, not the fork's.
      expect(read.fork.flatMap((p) => p.items.map((m) => m.info.id))).toEqual(["f_a1", "f_u1"]);
      expect(read.fork[0]!.items[0]!.parts.map(partText)).toEqual(["fork answer"]);
      expect(read.fork[0]).not.toHaveProperty("counts");
      for (const id of read.copied) {
        expect((await read.source.getMessage("ses_fork", id)).ok, id).toBe(false);
      }
    }
    expect(parts.copied).toEqual(inline.copied);
    expect(parts.fork).toEqual(inline.fork);
    expect(parts.parentAfter).toEqual(inline.parentAfter);
    expect(
      parts.parentAfter
        .flatMap((p) => p.items)
        .find((m) => m.info.id === "p_a2")!
        .parts.map(partText),
    ).toEqual(["mixed head", "mixed tail"]);
  });
});

// ── Schema ───────────────────────────────────────────────────────────────────

describe("v2 schema check", () => {
  async function schemaOf(ddl: string, migration: string) {
    const t = await makeV2Db(ddl, migration);
    cleanups.push(t.cleanup);
    const opened = await openOpencodeDb(t.path);
    if (!opened.ok) throw new Error(opened.reason);
    cleanups.push(() => opened.db.close());
    return { t, opened, check: checkV2Schema(limitSpy(opened.db)) };
  }

  it("reports session_part on a 2.4.1 database, through the LIMIT spy", async () => {
    const { opened, check } = await schemaOf(`${V2_DDL}\n${V2_PART_DDL}`, V2_PARTS_MIGRATION);
    const info = {
      migration: V2_PARTS_MIGRATION,
      migrationTested: true,
      parts: true,
      missingOptional: [],
      unknownTables: [],
    };
    expect(check).toEqual({ ok: true, ...info });
    expect(opened.schema).toEqual(info);
  });

  it("opens a database without session_part and reads its inline content", async () => {
    const { t, check } = await schemaOf(V2_DDL, V2_BASE_MIGRATION);
    expect(check).toEqual({
      ok: true,
      migration: V2_BASE_MIGRATION,
      migrationTested: true,
      parts: false,
      missingOptional: [],
      unknownTables: [],
    });
    const f = fixture(t);
    f.session("ses_old");
    const id = f.assistant("ses_old", { inline: [txt("inline only")] });
    const { source } = await open(t);
    const page = await source.messagePage({ sessionID: "ses_old", limit: 5 });
    expect(page.items.map((m) => [m.info.id, m.parts.map(partText)])).toEqual([
      [id, ["inline only"]],
    ]);
    expect(source.history!().capabilities).toEqual({ parts: false });
  });

  it("turns parts off, without refusing, when session_part lacks a column", async () => {
    const ddl = V2_PART_DDL.replace(/^\s*`call_id` text,\n/m, "");
    expect(ddl).not.toContain("call_id");
    const { t, check } = await schemaOf(`${V2_DDL}\n${ddl}`, V2_PARTS_MIGRATION);
    expect(check).toMatchObject({
      ok: true,
      parts: false,
      missingOptional: ["session_part.call_id"],
    });
    const f = fixture(t);
    f.session("ses_nocall");
    const id = f.assistant("ses_nocall", { inline: [txt("inline item")] });
    t.db.run(
      `INSERT INTO session_part (message_id, session_id, ordinal, type, time_created, time_updated, data)
       VALUES (?, ?, 0, 'text', 1, 1, ?)`,
      [id, "ses_nocall", JSON.stringify(txt("part item"))],
    );
    const { source } = await open(t);
    expect((await point(source, "ses_nocall", id)).parts.map(partText)).toEqual(["inline item"]);
    expect(source.history!()).toMatchObject({
      capabilities: { parts: false },
      missingColumns: ["session_part.call_id"],
    });
  });

  it("lists unknown session tables, sorted, apart from the known ones and the search family", async () => {
    const extra = [
      "session",
      "session_share",
      "session_inbox",
      "session_search",
      "session_search_fts",
      "session_search_fts_data",
      "session_zeta",
      "session_alpha",
    ]
      .map((name) => `CREATE TABLE ${name} (id text);`)
      .join("\n");
    const { t, check } = await schemaOf(`${V2_DDL}\n${V2_PART_DDL}\n${extra}`, V2_PARTS_MIGRATION);
    expect(check).toMatchObject({
      ok: true,
      parts: true,
      unknownTables: ["session_alpha", "session_zeta"],
    });
    const { source } = await open(t);
    expect(source.history!().unknownTables).toEqual(["session_alpha", "session_zeta"]);
  });

  it("flags a newest migration outside the tested list, or none at all, without refusing", async () => {
    const future = "29991231000000_future";
    const { t, check } = await schemaOf(`${V2_DDL}\n${V2_PART_DDL}`, V2_PARTS_MIGRATION);
    expect(check).toMatchObject({ migrationTested: true });
    t.db.run("INSERT INTO migration (id, time_completed) VALUES (?, 1)", [future]);
    const later = await open(t);
    expect(later.schema).toMatchObject({ migration: future, migrationTested: false, parts: true });
    expect(later.source.history!().migration).toEqual({ newest: future, tested: false });

    t.db.run("DELETE FROM migration");
    const none = await open(t);
    expect(none.schema).toMatchObject({ migration: null, migrationTested: false });
  });
});

// ── Bounded reads ────────────────────────────────────────────────────────────

describe("v2 source: bounded part reads", () => {
  it("binds LIMIT on every part statement and never reads session_part inside a message statement", async () => {
    const f = await partsFixture();
    f.session("ses_lim");
    f.session("ses_kid", { parent_id: "ses_lim" });
    f.user("ses_lim", "prompt");
    const long = f.assistant("ses_lim", {
      parts: Array.from({ length: 5 }, (_, i) => txt(`${i}`.repeat(300))),
      inline: [txt("tail")],
    });
    f.assistant("ses_lim", { parts: [txt("short")] });
    const { source, spy } = await open(f.t, { pageByteCeiling: 1_000, pagePartRows: 3 });
    for (const page of await pages(source, "ses_lim", 2)) {
      for (const m of page.items) await complete(source, "ses_lim", m);
    }
    await source.getMessage("ses_lim", long);
    await source.getMessage("ses_lim", long, { partOrdinal: 2 });
    await source.listSessions({ scope: "global", limit: 1, order: "id" });
    await source.listChildren("ses_lim", { limit: 1, order: "id" });

    const parts = spy.statements.filter((sql) => /\bsession_part\b/.test(sql));
    expect(parts.length).toBeGreaterThan(0);
    expect(spy.statements.filter(violatesLimitRule)).toEqual([]);
    expect(parts.filter((sql) => /\bsession_message\b/.test(sql))).toEqual([]);
    // Guard the guard: an unbounded part read fails.
    expect(() => spy.all("SELECT * FROM session_part WHERE session_id = ?", ["x"])).toThrow(
      /session_part query without LIMIT/,
    );
  });
});
