import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Part } from "@opencode-ai/sdk/v2";
import type { HistoryMessage } from "../src/history/model.js";
import type { HistorySource } from "../src/history/source.js";
import { createV2HistorySource, openOpencodeDb } from "../src/history/v2.js";
import { classifyAuthorship, type Authorship } from "../src/authorship.js";
import { evidenceClassFor, pruned, searchableFields } from "../src/extract.js";
import { deriveCard, distillFields } from "../src/distill.js";
import {
  insertMessage,
  insertProject,
  insertSession,
  limitSpy,
  makeV2Db,
  type SessionInsert,
  type V2TestDb,
} from "./v2-db.js";

/**
 * Faithfulness fixture: real `opencode.db` rows from this
 * machine, content replaced with synthetic text of the same shape
 * (`test/fixtures/v2-faithfulness.json`, see its `_note`). The parity eval
 * proves the projector agrees with its own inverse; this proves it reads what
 * opencode actually writes. Every expectation below was labeled by hand from
 * the fixture's structure.
 */

type Fixture = {
  projects: Array<{ id: string; worktree: string; name: string | null }>;
  sessions: SessionInsert[];
  messages: Array<{
    id: string;
    session_id: string;
    type: string;
    seq: number;
    time_created: number;
    time_updated: number;
    data: Record<string, unknown>;
  }>;
};

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/v2-faithfulness.json", import.meta.url)), "utf8"),
) as Fixture;

let t: V2TestDb;
let source: HistorySource;
let close: () => void = () => {};

beforeAll(async () => {
  t = await makeV2Db();
  for (const p of FIXTURE.projects) insertProject(t.db, p);
  for (const s of FIXTURE.sessions) insertSession(t.db, s);
  for (const m of FIXTURE.messages) insertMessage(t.db, m);
  const opened = await openOpencodeDb(t.path);
  if (!opened.ok) throw new Error(opened.reason);
  source = createV2HistorySource(limitSpy(opened.db), { projectID: "prj_f1" });
  close = () => opened.db.close();
});
afterAll(() => {
  close();
  t.cleanup();
});

/** Every message of a session, oldest first, through small pages. */
async function all(sessionID: string): Promise<HistoryMessage[]> {
  const out: HistoryMessage[] = [];
  let before: string | undefined;
  do {
    const page = await source.messagePage({ sessionID, limit: 7, before, strict: true });
    out.push(...page.items);
    before = page.nextCursor ?? undefined;
  } while (before);
  return out.reverse();
}

/** `seq role [suffix:type[/tool/status[/pruned]]]` per message. */
function signature(messages: HistoryMessage[]): string[] {
  return messages.map((m) => {
    const parts = m.parts.map((p) => {
      const suffix = p.id.slice(m.info.id.length);
      if (p.type !== "tool") return `${suffix}:${p.type}`;
      return `${suffix}:tool/${p.tool}/${p.state.status}${pruned(p) ? "/pruned" : ""}`;
    });
    return `${m.info.seq} ${m.info.role} [${parts.join(" ")}]`;
  });
}

function authorship(m: HistoryMessage, part: Part, parentID: string | null): Authorship {
  return classifyAuthorship({
    partType: part.type,
    role: m.info.role,
    synthetic: part.type === "text" ? part.synthetic : undefined,
    parentID,
  });
}

const read = (i: number) => `:${i}:tool/read/completed/pruned`;

describe("v2 faithfulness fixture", () => {
  it("projects the migrated root: cleared outputs, empty prompt, synthetic, error, compaction", async () => {
    expect(signature(await all("ses_f1"))).toEqual([
      "0 user [:t:text]",
      `1 assistant [:0:text ${read(1)}]`,
      `2 assistant [${[0, 1, 2, 3, 4, 5].map(read).join(" ")}]`,
      `3 assistant [:0:text ${read(1)}]`,
      `4 assistant [${[0, 1, 2, 3, 4, 5, 6, 7].map(read).join(" ")}]`,
      "60 user [:t:text]",
      "61 assistant [:0:text :1:tool/custom_tool_1/completed/pruned]",
      // A migrated ignored-only prompt: empty text, no part.
      "62 user []",
      `63 assistant [:0:text ${read(1)} :2:tool/custom_tool_2/completed/pruned :3:tool/custom_tool_3/completed/pruned]`,
      "207 assistant [:0:tool/bash/completed]",
      "208 assistant [:0:text]",
      "209 user [:0:text]",
      "210 assistant [:0:tool/bash/completed]",
      "211 user [:t:text]",
      "263 user [:t:text]",
      "264 assistant [:0:tool/todowrite/completed]",
      "265 assistant [:0:tool/edit/error]",
      "266 assistant [:0:tool/read/completed]",
      "495 user [:t:text]",
      "496 assistant []",
      "497 assistant [:c:compaction :s:text]",
      "498 user [:t:text]",
      "499 assistant [:0:text :1:tool/read/completed :2:tool/grep/completed]",
      // The migration's system notice (seq 1006) is not content.
      "1005 assistant [:0:text :1:tool/question/error]",
    ]);
  });

  it("keeps the cleared marker out of every index and flattens tool errors", async () => {
    const messages = await all("ses_f1");
    const text = JSON.stringify(messages.flatMap((m) => m.parts.flatMap(searchableFields)));
    expect(text).not.toContain("[Old tool result content cleared]");
    const error = messages.find((m) => m.info.seq === 265)!.parts[0]!;
    expect(error).toMatchObject({ state: { status: "error", error: "Synthetic error 54." } });
    const compaction = messages.find((m) => m.info.seq === 497)!;
    expect(compaction.parts[0]).toMatchObject({ type: "compaction", auto: false });
    expect(compaction.info).toMatchObject({ role: "assistant", summary: true });
    // User rows always carry an agent/model object (formatMsg reads modelID).
    for (const m of messages.filter((x) => x.info.role === "user")) {
      expect(m.info.role === "user" && typeof m.info.model.modelID).toBe("string");
    }
  });

  it("classifies authorship by v2 type and parentage", async () => {
    const root = await all("ses_f1");
    const bySeq = (seq: number) => root.find((m) => m.info.seq === seq)!;
    expect(authorship(bySeq(0), bySeq(0).parts[0]!, null)).toBe("human");
    expect(authorship(bySeq(209), bySeq(209).parts[0]!, null)).toBe("injected");
    expect(authorship(bySeq(497), bySeq(497).parts[1]!, null)).toBe("model");
    expect(authorship(bySeq(207), bySeq(207).parts[0]!, null)).toBe("model");

    const child = await all("ses_f2");
    expect(signature(child)).toEqual(["0 user [:t:text]", "1 assistant [:0:text]"]);
    expect(authorship(child[0]!, child[0]!.parts[0]!, "ses_f1")).toBe("delegated");
    const childSession = await source.getSession("ses_f2", { scope: "project" });
    expect(childSession.ok && childSession.value.parentID).toBe("ses_f1");
  });

  it("projects the native v2 child: v2 tool names, sparse seq, idle excluded", async () => {
    const messages = await all("ses_f3");
    expect(signature(messages)).toEqual([
      "4 user [:t:text]",
      "5 assistant [:0:tool/shell/completed]",
      "12 assistant [:0:tool/shell/completed]",
      "19 assistant [:0:tool/read/completed]",
      "26 assistant [:0:tool/read/completed :1:tool/shell/completed :2:tool/grep/completed :3:tool/skill/completed]",
      "45 assistant [:0:reasoning :1:tool/read/completed]",
      "54 assistant [:0:reasoning :1:tool/grep/completed]",
      "63 assistant [:0:tool/shell/completed]",
      "70 assistant [:0:reasoning :1:tool/shell/completed]",
      "79 assistant [:0:text]",
    ]);
    const prompt = messages[0]!;
    expect(authorship(prompt, prompt.parts[0]!, "ses_f4")).toBe("delegated");

    // Native v2 tool inputs: shell `command` is extracted like bash; skill
    // carries `id` and stays reference material.
    const shell = messages[1]!.parts[0]!;
    expect(distillFields(shell).some((f) => f.field === "command" && !f.text.startsWith("{"))).toBe(
      true,
    );
    const skill = messages.find((m) => m.info.seq === 26)!.parts[3]!;
    expect(skill.type === "tool" && Object.keys(skill.state.input)).toEqual(["id"]);
    expect(evidenceClassFor("tool", "skill", ["stdout"])).toBe("skill-definition");
    expect(distillFields(skill).every((f) => !f.text.startsWith("{"))).toBe(true);

    // The card's summary head drops the v2 subagent prefix.
    const card = deriveCard({
      session: {
        id: "ses_f3",
        parentId: "ses_f4",
        title: "",
        slug: "",
        directory: "/work/project-a",
        projectId: "prj_f1",
        agent: null,
        model: null,
        timeCreated: 0,
        timeUpdated: 0,
      },
      messages,
      parentById: new Map([["ses_f3", "ses_f4"]]),
    }).card;
    expect(card.summaryHead).toBe("Synthetic prompt 117.");
    expect(card.tools).toContain("shell");
  });

  it("orders the native session by normalized recency", async () => {
    const listed = await source.listSessions({ scope: "project", limit: 10 });
    if (!listed.ok) throw new Error(listed.error);
    const native = listed.items.find((s) => s.id === "ses_f3")!;
    const row = FIXTURE.sessions.find((s) => s.id === "ses_f3")!;
    expect(native.time.updated).toBe(Math.max(row.time_updated, row.time_idle ?? 0));
    expect(native.project?.name).toBe("project-a");
  });
});
