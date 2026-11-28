/* global process, console */
/**
 * Checks what `npm pack` would publish: only `dist/` (plus the files npm
 * always adds), both entries present, and no test-only worker code in it.
 * Run by `npm run check:pack` after `npm run compile`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ALWAYS = new Set(["package.json", "README.md", "LICENSE", "LICENSE.md"]);
const REQUIRED = ["dist/opencode-session-recall.js", "dist/distill-worker.js"];
/** Code only the test entries hold: the stall entry's wait and its name. */
const TEST_ONLY = ["Atomics.wait", "stall-worker", "openStalling"];

const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
});
const [pack] = JSON.parse(out);
const paths = pack.files.map((file) => file.path);
const problems = [];

for (const path of paths) {
  if (!path.startsWith("dist/") && !ALWAYS.has(path)) problems.push(`${path} is not in dist/`);
  if (path.startsWith("dist/") && /stall|test/i.test(path)) {
    problems.push(`${path} looks like a test entry`);
  }
}
for (const path of REQUIRED) {
  if (!paths.includes(path)) problems.push(`${path} is missing`);
}
for (const path of paths.filter((p) => p.endsWith(".js"))) {
  const text = readFileSync(join(process.cwd(), path), "utf8");
  for (const marker of TEST_ONLY) {
    if (text.includes(marker)) problems.push(`${path} contains test-only code (${marker})`);
  }
}

if (problems.length > 0) {
  console.error(`npm pack would publish what it must not:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`npm pack lists ${paths.length} files, all as expected`);
