import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type TestContext,
} from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  insertMessage,
  insertProject,
  insertSession,
  makeV2PartsDb,
  type V2TestDb,
} from "../v2-db.js";
import { BUNDLE_SCENARIO, REPO_ROOT } from "./worker-runner.js";

/**
 * The plugin as it ships: the bundled main entry, loaded the way a host
 * loads it, in a process of its own under Node and, where `bun` is on PATH,
 * under Bun: without it the checks under Bun are skipped with a note, or fail
 * when `RECALL_REQUIRE_BUN=1` is set. Once from the repository through its
 * `server.js` shim, and once
 * from the tarball `npm pack` makes, installed into a scratch project's
 * `node_modules`. Each run starts the production thread starter, so the
 * bundle must find `distill-worker.js` from whichever chunk it lands in and
 * both threads must carry the same `BUILD_ID`; a run passes only when the
 * distiller ran in the worker and a session was distilled into the store.
 */

const run = promisify(execFile);

const NEEDLE = "quillwort";
const SESSION = "ses_bundle";

/** `bun`'s path when it runs, else undefined. */
function findBun(): string | undefined {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return "bun";
  } catch {
    return undefined;
  }
}

const bun = findBun();
const runtimes: Array<[name: string, program: string | undefined]> = [
  ["Node", process.execPath],
  ["Bun", bun],
];

/** With `RECALL_REQUIRE_BUN=1` a missing Bun fails the checks under Bun
 *  instead of skipping them, as a machine that must check Bun wants. */
const REQUIRE_BUN = process.env.RECALL_REQUIRE_BUN === "1";
const BUN_MISSING =
  "bun is not on PATH, so the bundled plugin was not checked under Bun (set RECALL_REQUIRE_BUN=1 to fail instead)";

/** `program`, or for a missing Bun a visible skip (a failure under
 *  {@link REQUIRE_BUN}). */
function programOr(program: string | undefined, context: TestContext): string {
  if (program) return program;
  if (REQUIRE_BUN) throw new Error("RECALL_REQUIRE_BUN=1 is set, but bun is not on PATH");
  console.warn(BUN_MISSING);
  context.skip(BUN_MISSING);
  throw new Error(BUN_MISSING);
}

let packed: string;
let installed: string;

beforeAll(async () => {
  if (!bun)
    console.warn(REQUIRE_BUN ? "bun is not on PATH, and RECALL_REQUIRE_BUN=1 is set" : BUN_MISSING);
  packed = mkdtempSync(join(tmpdir(), "recall-bundle-pack-"));
  const { stdout } = await run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packed],
    { cwd: REPO_ROOT },
  );
  const [pack] = JSON.parse(stdout) as Array<{ filename: string }>;
  if (!pack) throw new Error("npm pack made no tarball");
  // A scratch project that installs the tarball as a user's would; its
  // dependencies come from npm's cache when it holds them.
  const project = join(packed, "project");
  mkdirSync(project);
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "scratch", private: true, type: "module" }),
  );
  await run(
    "npm",
    [
      "install",
      join(packed, pack.filename),
      "--prefer-offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--legacy-peer-deps",
    ],
    { cwd: project },
  );
  // A module in the project that names the package, so the package resolves
  // through its exports map as a host's import does.
  installed = join(project, "load-plugin.mjs");
  writeFileSync(installed, 'export { default } from "opencode-session-recall";\n');
}, 300_000);

afterAll(() => {
  if (packed) rmSync(packed, { recursive: true, force: true });
});

let dir: string;
let v2: V2TestDb;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "recall-bundle-")));
  v2 = await makeV2PartsDb();
  insertProject(v2.db, { id: "prj", worktree: "/w" });
  insertSession(v2.db, {
    id: SESSION,
    project_id: "prj",
    directory: "/w",
    title: "Bundle check",
    time_created: 1_000,
    time_updated: 1_200,
  });
  insertMessage(v2.db, {
    id: "msg_bundle",
    session_id: SESSION,
    type: "user",
    seq: 1,
    time_created: 1_100,
    data: { text: `where does the ${NEEDLE} cache live`, time: { created: 1_100 } },
  });
});

afterEach(() => {
  v2.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

type Outcome = {
  distiller?: string;
  degraded?: boolean;
  fullCards?: number;
  found?: boolean;
  error?: string;
};

async function scenario(program: string, entry: string): Promise<Outcome> {
  const { stdout } = await run(
    program,
    [BUNDLE_SCENARIO, entry, join(dir, "store.db"), v2.path, NEEDLE, SESSION],
    { cwd: dir, timeout: 120_000 },
  ).catch((error: { stdout?: string; stderr?: string }) => {
    throw new Error(`the scenario failed: ${error.stdout ?? ""}${error.stderr ?? ""}`);
  });
  const line = stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as Outcome;
}

describe.each(runtimes)("the bundled plugin under %s", (_name, program) => {
  it("runs the distiller in a worker thread and distills a session, loaded through the repository's server.js", async (context) => {
    const outcome = await scenario(programOr(program, context), join(REPO_ROOT, "server.js"));
    expect(outcome).toMatchObject({ distiller: "worker", degraded: false, found: true });
    expect(outcome.fullCards).toBeGreaterThan(0);
  }, 150_000);

  it("runs the distiller in a worker thread and distills a session, installed from its packed tarball", async (context) => {
    const outcome = await scenario(programOr(program, context), installed);
    expect(outcome).toMatchObject({ distiller: "worker", degraded: false, found: true });
    expect(outcome.fullCards).toBeGreaterThan(0);
  }, 150_000);
});
