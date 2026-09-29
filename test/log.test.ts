import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleSink, createFileSink, createLogger } from "../src/log.js";

const dirs: string[] = [];
function freshPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "recall-log-"));
  dirs.push(dir);
  return join(dir, "recall.log");
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);

describe("createLogger", () => {
  it("prefixes every message with [recall]", () => {
    const lines: string[] = [];
    createLogger((line) => lines.push(line))("hello");
    expect(lines).toEqual(["[recall] hello"]);
  });

  it("never lets a throwing sink escape", () => {
    const log = createLogger(() => {
      throw new Error("sink exploded");
    });
    expect(() => log("x")).not.toThrow();
  });

  it("writes to console.log through the console sink", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    createLogger(consoleSink)("lease acquired");
    expect(spy).toHaveBeenCalledWith("[recall] lease acquired");
  });
});

describe("createFileSink", () => {
  it("writes nothing when disabled", async () => {
    const path = freshPath();
    const sink = createFileSink({ host: "opencode-v2", enabled: false, path });
    sink("[recall] ignored");
    await sink.flush();
    expect(existsSync(path)).toBe(false);
  });

  it("is enabled only by RECALL_DEBUG=1 when not configured", async () => {
    const off = freshPath();
    vi.stubEnv("RECALL_DEBUG", "true");
    const disabled = createFileSink({ host: "opencode-v2", path: off });
    disabled("[recall] ignored");
    await disabled.flush();
    expect(existsSync(off)).toBe(false);

    const on = freshPath();
    vi.stubEnv("RECALL_DEBUG", "1");
    const enabled = createFileSink({ host: "opencode-v2", path: on });
    enabled("[recall] kept");
    await enabled.flush();
    expect(readFileSync(on, "utf8")).toContain("[recall] kept");
  });

  it("appends whole lines with time, pid and host, in call order", async () => {
    const path = freshPath();
    const sink = createFileSink({ host: "opencode-v2", enabled: true, path, now: () => T0 });
    sink("[recall] first");
    sink("[recall] second");
    await sink.flush();
    expect(readFileSync(path, "utf8")).toBe(
      `2026-09-28T12:00:00.000Z pid=${process.pid} opencode-v2 [recall] first\n` +
        `2026-09-28T12:00:00.000Z pid=${process.pid} opencode-v2 [recall] second\n`,
    );
  });

  it("rotates to <path>.1 before an append would pass the size cap", async () => {
    const path = freshPath();
    const line = (n: number) => `[recall] line-${n}`;
    const lineBytes = Buffer.byteLength(
      `2026-09-28T12:00:00.000Z pid=${process.pid} h ${line(1)}\n`,
    );
    // Room for exactly two lines.
    const sink = createFileSink({
      host: "h",
      enabled: true,
      path,
      maxBytes: 2 * lineBytes + 1,
      now: () => T0,
    });
    for (let n = 1; n <= 3; n++) sink(line(n));
    await sink.flush();
    const rotated = readFileSync(`${path}.1`, "utf8");
    const current = readFileSync(path, "utf8");
    expect(rotated).toContain("line-1");
    expect(rotated).toContain("line-2");
    expect(rotated).not.toContain("line-3");
    expect(current).toContain("line-3");
    expect(current.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("drops lines it cannot write without throwing", async () => {
    const path = join(freshPath(), "missing-dir", "recall.log");
    const sink = createFileSink({ host: "h", enabled: true, path });
    expect(() => sink("[recall] nowhere")).not.toThrow();
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });
});
