import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import entry from "../src/opencode-session-recall.js";
import { instanceOf } from "../src/host/v2.js";
import { REGISTRY_KEY } from "../src/host/registry.js";
import { resetRuntimeRegistryForTests } from "../src/host/runtime.js";
import type { V2Cleanup } from "../src/host/opencode-v2-types.js";
import type { V2Runtime } from "../src/host/v2-runtime.js";
import {
  insertMessage,
  insertProject,
  insertSession,
  makeV2PartsDb,
  type V2TestDb,
} from "./v2-db.js";
import { fakeV2Host, type FakeV2Host } from "./v2-host.js";

/**
 * Time-bounded searches over subagents that ran long past the window, end to
 * end through the v2 host over a temp opencode.db. An orchestrator searches
 * its last few hours; the subagents it started in that window kept working
 * for a day after it, and each holds the needle only in a message inside
 * the window. Their later history is long enough that a walk from each
 * session's newest message would stop on the anchor or the session budget
 * before reaching it.
 *
 * The runtime opens opencode.db through `openOpencodeDb`, which is wrapped
 * here so that the history reader and the sync both read through the LIMIT
 * spy. A violation would surface only as a load error inside the runtime, so
 * the spy's throws are recorded and checked after each test.
 */

const limits = vi.hoisted(() => ({ historyReads: 0, violations: [] as string[] }));

vi.mock("../src/history/v2.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/history/v2.js")>();
  const { limitSpy } = await import("./v2-db.js");
  return {
    ...actual,
    openOpencodeDb: async (path: string) => {
      const opened = await actual.openOpencodeDb(path);
      if (!opened.ok) return opened;
      const spy = limitSpy(opened.db);
      const checked = <T>(sql: string, run: () => T): T => {
        if (/\bsession_(message|part)\b/.test(sql)) limits.historyReads++;
        try {
          return run();
        } catch (error) {
          limits.violations.push(error instanceof Error ? error.message : String(error));
          throw error;
        }
      };
      return {
        ...opened,
        db: {
          get: (sql: string, params?: unknown[]) =>
            checked(sql, () => spy.get(sql, params as Parameters<typeof spy.get>[1])),
          all: (sql: string, params?: unknown[]) =>
            checked(sql, () => spy.all(sql, params as Parameters<typeof spy.all>[1])),
          close: () => spy.close(),
        },
      };
    },
  };
});

const HOUR = 3_600_000;
/** The orchestrator's start. */
const T = 1_795_050_000_000;
/** The searched window: from one hour after the orchestrator's start to four
 *  hours after it. */
const AFTER = T + HOUR;
const BEFORE = T + 4 * HOUR;
/** Messages each subagent wrote after the window. */
const LATER = 120;
/** Each test distills the database from scratch before it searches, which
 *  takes well under a second on an idle machine and much longer on a loaded
 *  one. */
const COLD_PASS_WAIT_MS = 25_000;
const TEST_TIMEOUT_MS = 30_000;

let v2db: V2TestDb;
let dir: string;
const cleanups: V2Cleanup[] = [];

const user = (created: number, text: string) => ({ text, time: { created } });
const reply = (created: number, content: unknown[]) => ({
  agent: "build",
  model: { id: "m-1", providerID: "p-1" },
  content,
  time: { created, completed: created + 1_000 },
});
const shell = (id: string, command: string, output: string) => ({
  type: "tool",
  id,
  name: "bash",
  state: {
    status: "completed",
    input: { command },
    content: [{ type: "text", text: output }],
    metadata: {},
  },
  time: { created: 0, completed: 1 },
});

/** A subagent of the orchestrator, created inside the window and updated a
 *  day later, whose first two messages fall inside the window and whose
 *  {@link LATER} other messages come after it. */
function subagent(
  id: string,
  o: { title: string; created: number; prompt: string; work: unknown[] },
): void {
  const updated = T + 28 * HOUR;
  insertSession(v2db.db, {
    id,
    project_id: "prj_test",
    parent_id: "ses_root",
    directory: "/workspace/project",
    title: o.title,
    time_created: o.created,
    time_updated: updated,
  });
  insertMessage(v2db.db, {
    id: `${id}_m1`,
    session_id: id,
    type: "user",
    seq: 1,
    time_created: o.created,
    data: user(o.created, o.prompt),
  });
  insertMessage(v2db.db, {
    id: `${id}_m2`,
    session_id: id,
    type: "assistant",
    seq: 2,
    time_created: o.created + 5 * 60_000,
    data: reply(o.created + 5 * 60_000, o.work),
  });
  const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(20);
  for (let i = 0; i < LATER; i++) {
    const created = T + 5 * HOUR + i * 10 * 60_000;
    insertMessage(v2db.db, {
      id: `${id}_later${i}`,
      session_id: id,
      type: i % 2 === 0 ? "user" : "assistant",
      seq: 3 + i,
      time_created: created,
      data:
        i % 2 === 0
          ? user(created, `Refine migration batch ${i}: ${filler}`)
          : reply(created, [{ type: "text", text: `Batch ${i} refined. ${filler}` }]),
    });
  }
}

// The searches only read opencode.db, so every test shares one copy; each
// gets its own store.
beforeAll(async () => {
  v2db = await makeV2PartsDb();
  v2db.db.exec("BEGIN");
  insertProject(v2db.db, { id: "prj_test", worktree: "/workspace/project" });
  insertSession(v2db.db, {
    id: "ses_root",
    project_id: "prj_test",
    directory: "/workspace/project",
    title: "Atlas orchestration",
    time_created: T,
    time_updated: T + 30 * HOUR,
  });
  insertMessage(v2db.db, {
    id: "ses_root_m1",
    session_id: "ses_root",
    type: "user",
    seq: 1,
    time_created: T + 60_000,
    data: user(T + 60_000, "Coordinate the console work across subagents"),
  });
  // The needle in an assistant's text, which the slim index also holds.
  subagent("ses_paths", {
    title: "Console routes",
    created: T + 2 * HOUR,
    prompt: "Wire the console routes",
    work: [{ type: "text", text: "Created service-accounts/detail-pages.tsx with the table" }],
  });
  // The needle only in a tool output, which only the drill reads; the card
  // ranks on the title.
  subagent("ses_viewer", {
    title: "Account viewer screen",
    created: T + 90 * 60_000,
    prompt: "Build the screen for browsing a single customer",
    work: [shell("call_v1", "pnpm test", "PASS src/routes/account-viewer.test.tsx (4 tests)")],
  });
  // The needle only in a tool output, for a deep sweep of the project.
  subagent("ses_owns", {
    title: "Ownership checks",
    created: T + 150 * 60_000,
    prompt: "Check who may edit shared projects",
    work: [
      shell("call_o1", "pnpm vitest run perms", "ownsNone returned false for a shared project"),
    ],
  });
  v2db.db.exec("COMMIT");
});

afterAll(() => v2db.cleanup());

beforeEach(() => {
  resetRuntimeRegistryForTests();
  limits.historyReads = 0;
  limits.violations.length = 0;
  dir = mkdtempSync(join(tmpdir(), "recall-window-"));
});

/** The runtime read opencode.db's history tables, and only through
 *  statements the LIMIT spy accepts. */
function expectBoundedReads(): void {
  expect(limits.historyReads).toBeGreaterThan(0);
  expect(limits.violations).toEqual([]);
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  resetRuntimeRegistryForTests();
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
  rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<{ h: FakeV2Host; runtime: V2Runtime }> {
  const h = fakeV2Host({
    options: {
      opencodeDbPath: v2db.path,
      storePath: join(dir, "store.db"),
      coldPass: true,
      // Well under what each subagent wrote after the window.
      drillCharsPerSession: 30_000,
    },
  });
  const cleanup = await entry.setup(h.ctx);
  if (!cleanup) throw new Error("setup stayed inert");
  cleanups.push(cleanup);
  const runtime = await instanceOf(h.ctx)?.attachment.ready(5_000);
  if (!runtime) throw new Error("runtime never became ready");
  const begun = Date.now();
  while (runtime.distiller.status().coldPass !== "done") {
    if (Date.now() - begun > COLD_PASS_WAIT_MS) throw new Error("cold pass did not finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { h, runtime };
}

type Out = {
  ok: boolean;
  results: Array<{ sessionID: string; snippet: string }>;
  coverage: { sessionStops?: { sessions: Array<{ sessionID: string; fetched: number }> } };
};

async function recall(h: FakeV2Host, input: Record<string, unknown>): Promise<Out> {
  const result = await h.runTool("recall", input, { sessionID: "ses_root" });
  return JSON.parse(result.content as string) as Out;
}

const bounds = { after: new Date(AFTER).toISOString(), before: new Date(BEFORE).toISOString() };

describe("time-bounded searches over subagents that ran past the window", () => {
  it(
    "finds a needle in a subagent's text from inside the window",
    async () => {
      const { h } = await start();
      const out = await recall(h, {
        query: "service-accounts/detail-pages.tsx",
        scope: "global",
        ...bounds,
      });
      expect(out.ok).toBe(true);
      expect(out.results.map((r) => r.sessionID)).toContain("ses_paths");
      expectBoundedReads();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "finds a needle in a subagent's tool output, reading only from the window down",
    async () => {
      const { h } = await start();
      const out = await recall(h, { query: "account-viewer", scope: "global", ...bounds });
      expect(out.ok).toBe(true);
      expect(out.results.map((r) => r.sessionID)).toContain("ses_viewer");
      // The walk started at the window's end: none of the later messages was
      // read.
      const stops = out.coverage.sessionStops?.sessions ?? [];
      const viewer = stops.find((s) => s.sessionID === "ses_viewer");
      expect(viewer?.fetched).toBe(2);
      expectBoundedReads();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "finds a needle in a subagent's tool output with a deep sweep of the project",
    async () => {
      const { h } = await start();
      const out = await recall(h, { query: "ownsNone", deep: true, project: true, ...bounds });
      expect(out.ok).toBe(true);
      expect(out.results.map((r) => r.sessionID)).toContain("ses_owns");
      expectBoundedReads();
    },
    TEST_TIMEOUT_MS,
  );
});
