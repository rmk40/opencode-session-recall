import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STALL_WORKER } from "./worker-runner.js";

/**
 * What `npm pack` publishes after a build: both entries in `dist/`, nothing
 * else but the files npm always adds, and no test entry. `npm run check:pack`
 * (`scripts/check-pack.mjs`) enforces the same, and fails on a test entry.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALWAYS = new Set(["package.json", "README.md", "LICENSE", "LICENSE.md"]);

function packedPaths(): string[] {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const [pack] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return (pack?.files ?? []).map((file) => file.path);
}

function checkPack(): { ok: boolean; output: string } {
  try {
    const output = execFileSync(process.execPath, ["scripts/check-pack.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${stdout ?? ""}${stderr ?? ""}` };
  }
}

describe("the published files", () => {
  it("hold the plugin and its worker in dist/, and no test entry", () => {
    const paths = packedPaths();
    expect(paths).toContain("dist/opencode-session-recall.js");
    expect(paths).toContain("dist/distill-worker.js");
    expect(paths.filter((path) => /stall|test/i.test(path))).toEqual([]);
    expect(paths.filter((path) => !path.startsWith("dist/") && !ALWAYS.has(path))).toEqual([]);
  }, 60_000);

  it("pass the pack check, which fails once a test entry lands in dist/", () => {
    expect(checkPack()).toMatchObject({ ok: true });
    const stray = join(ROOT, "dist", "stall-worker.js");
    copyFileSync(STALL_WORKER, stray);
    try {
      const failed = checkPack();
      expect(failed.ok).toBe(false);
      expect(failed.output).toContain("dist/stall-worker.js looks like a test entry");
      expect(failed.output).toContain("dist/stall-worker.js contains test-only code");
    } finally {
      rmSync(stray, { force: true });
    }
    expect(checkPack()).toMatchObject({ ok: true });
  }, 60_000);
});
