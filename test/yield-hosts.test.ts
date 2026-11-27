import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "../src/host/opencode-v1-types.js";
import { v2RuntimeFactory, type V2Runtime } from "../src/host/v2-runtime.js";
import { search } from "../src/search.js";
import { openSqlite } from "../src/sqlite.js";
import type { SearchOutput } from "../src/types.js";
import {
  bundle,
  makeContext,
  PROJECT_DIR,
  TEST_LIMITS,
  textPart,
  toolResultText,
  userMessage,
} from "./helpers.js";
import {
  insertMessage,
  insertPart,
  insertProject,
  insertSession,
  makeV2PartsDb,
  type V2TestDb,
} from "./v2-db.js";

/**
 * Which of the process's two yield points each host hands its work: the
 * distiller's upkeep yields in the background, and a search's reads and card
 * build in the foreground, so a search waiting at the same time goes first.
 * The two points stand in for the event loop here: each counts its calls and
 * resolves at once.
 */

const yields = vi.hoisted(() => ({ foreground: 0, background: 0 }));
const createOpencodeClient = vi.hoisted(() => vi.fn((options: unknown) => options));

vi.mock("../src/yield.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/yield.js")>();
  return {
    ...actual,
    yieldOnBudget: async (): Promise<void> => {
      yields.foreground++;
    },
    yieldInBackground: async (): Promise<void> => {
      yields.background++;
    },
  };
});

// The v1 host's opencode clients, which the v1 test fakes.
vi.mock("@opencode-ai/sdk/v2", () => ({ createOpencodeClient }));

const reset = (): void => {
  yields.foreground = 0;
  yields.background = 0;
};

async function until(pred: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > 20_000) throw new Error(`${what} never happened`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recall-yield-hosts-"));
  reset();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("v2 runtime yield points", () => {
  const runtimes: V2Runtime[] = [];
  const dbs: V2TestDb[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
    for (const db of dbs.splice(0)) db.cleanup();
  });

  /** Project `prj` with three sessions, each a prompt and an answer in a
   *  part row that mention "zephyr". */
  function seed(t: V2TestDb): void {
    t.db.tx(() => {
      insertProject(t.db, { id: "prj", worktree: "/w" });
      for (let i = 1; i <= 3; i++) {
        const sid = `ses_${i}`;
        const at = i * 1_000;
        insertSession(t.db, {
          id: sid,
          project_id: "prj",
          directory: "/w",
          time_created: at,
          time_updated: at + 200,
        });
        insertMessage(t.db, {
          id: `${sid}_u`,
          session_id: sid,
          type: "user",
          seq: 1,
          time_created: at + 100,
          data: { text: `please look at zephyr ${i}`, time: { created: at + 100 } },
        });
        insertMessage(t.db, {
          id: `${sid}_a`,
          session_id: sid,
          type: "assistant",
          seq: 2,
          time_created: at + 150,
          data: {
            agent: "build",
            model: { id: "m", providerID: "p" },
            content: [],
            time: { created: at + 150, completed: at + 151 },
          },
        });
        insertPart(t.db, {
          message_id: `${sid}_a`,
          session_id: sid,
          ordinal: 0,
          time_created: at + 150,
          data: { type: "text", text: `zephyr answer ${i}` },
        });
      }
      // Empty sessions enough to take discovery past its first page.
      for (let i = 0; i < 2_000; i++) {
        insertSession(t.db, {
          id: `ses_empty_${String(i).padStart(4, "0")}`,
          project_id: "prj",
          directory: "/w",
          time_created: 100,
          time_updated: 100,
        });
      }
    });
  }

  /** A runtime over a seeded database once its cold pass, repair sweep and
   *  polls have run. */
  async function settled(): Promise<V2Runtime> {
    const t = await makeV2PartsDb();
    dbs.push(t);
    seed(t);
    const factory = v2RuntimeFactory({
      options: {
        ephemeral: false,
        storePath: join(dir, "store.db"),
        opencodeDbPath: t.path,
        semantic: undefined,
        limits: { ...TEST_LIMITS, coldPass: true },
        summaries: false,
      },
      channel: "latest",
      log: () => {},
      sync: { pollIntervalMs: 20 },
      idleDebounceMs: 5,
    });
    const runtime = await factory.create(await factory.resolve());
    runtimes.push(runtime);
    await until(
      () =>
        runtime.store?.getCard("ses_3") !== undefined &&
        runtime.repair()?.sweep?.running === false &&
        runtime.distiller.indexing() === undefined,
      "the cold pass",
    );
    // Let a few polls run as well.
    await new Promise((resolve) => setTimeout(resolve, 60));
    return runtime;
  }

  it("yields the distiller's cold pass, its reads, polls and discovery in the background only", async () => {
    await settled();
    expect(yields.background).toBeGreaterThan(0);
    expect(yields.foreground).toBe(0);
  }, 30_000);

  it("yields a search's card build and reads, and the facades the tools and the drill read through, in the foreground only", async () => {
    const runtime = await settled();
    await runtime.distiller.stop();
    reset();
    const tool = search(runtime.sourceFor("prj"), true, runtime.options.limits, runtime.deps);
    const out = JSON.parse(
      toolResultText(await tool.execute({ query: "zephyr" } as never, makeContext().ctx)),
    ) as SearchOutput;
    expect(out.results.map((r) => r.sessionID)).toContain("ses_1");
    expect(yields.foreground).toBeGreaterThan(0);
    expect(yields.background).toBe(0);

    for (const facade of [runtime.globalSource, runtime.sourceFor("prj")]) {
      reset();
      const page = await facade.messagePage({ sessionID: "ses_2", limit: 5 });
      expect(page.items).toHaveLength(2);
      expect(yields.foreground).toBeGreaterThan(0);
      expect(yields.background).toBe(0);
    }
  }, 30_000);
});

const plugin = await import("../src/opencode-session-recall.js");

describe("v1 host yield points", () => {
  function ctx(): PluginInput {
    return {
      client: { _client: { getConfig: () => ({ fetch: vi.fn() }) } },
      directory: PROJECT_DIR,
      worktree: PROJECT_DIR,
      project: {},
      serverUrl: new URL("http://localhost"),
      $: {},
    } as unknown as PluginInput;
  }

  it("yields the distiller's cold pass in the background only", async () => {
    const sessions = [1, 2].map((i) => ({
      id: `s${i}`,
      title: `Session ${i}`,
      slug: `session-${i}`,
      directory: PROJECT_DIR,
      projectID: "p",
      time: { created: i * 1_000, updated: i * 1_000 + 500 },
    }));
    const messages = vi.fn(async (o: { sessionID: string }) => ({
      data: [
        bundle(userMessage(`${o.sessionID}-m1`, o.sessionID, 1_100), [
          textPart(`${o.sessionID}-p1`, o.sessionID, `${o.sessionID}-m1`, "zephyr question"),
        ]),
      ],
    }));
    createOpencodeClient
      .mockImplementationOnce((options: unknown) => ({
        ...(options as object),
        session: { messages, list: vi.fn(async () => ({ data: [] })) },
      }))
      .mockImplementationOnce((options: unknown) => ({
        ...(options as object),
        experimental: { session: { list: vi.fn(async () => ({ data: sessions })) } },
      }));
    const storePath = join(dir, "recall.db");
    const hooks = await plugin.default.server(ctx(), { storePath, coldPass: true });
    try {
      await until(async () => {
        const db = await openSqlite(storePath);
        try {
          return Number(db?.get("SELECT COUNT(*) AS n FROM card")?.n ?? 0) === 2;
        } catch {
          // The store's schema is not written yet.
          return false;
        } finally {
          db?.close();
        }
      }, "the cold pass");
      expect(yields.background).toBeGreaterThan(0);
      expect(yields.foreground).toBe(0);
    } finally {
      await hooks.dispose?.();
    }
  }, 30_000);
});
