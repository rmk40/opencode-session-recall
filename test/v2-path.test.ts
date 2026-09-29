import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  opencodeDbPath,
  resolveOpencodeDbPath,
  type OpencodeDbPathInput,
} from "../src/history/v2-path.js";

const HOME = "/home/u";

function resolve(overrides: Partial<OpencodeDbPathInput> & { env?: OpencodeDbPathInput["env"] }) {
  return resolveOpencodeDbPath({ channel: "latest", env: {}, home: HOME, path, ...overrides });
}

describe("resolveOpencodeDbPath (mirrors opencode cli/src/database-path.ts)", () => {
  it.each(["latest", "dev", "beta", "next", "prod"])("channel %s uses opencode.db", (channel) => {
    expect(resolve({ channel })).toEqual({
      ok: true,
      path: "/home/u/.local/share/opencode/opencode.db",
    });
  });

  it("other channels get a sanitized per-channel file", () => {
    expect(resolve({ channel: "local" })).toEqual({
      ok: true,
      path: "/home/u/.local/share/opencode/opencode-local.db",
    });
    expect(resolve({ channel: "feat/x y+z_1.2" })).toEqual({
      ok: true,
      path: "/home/u/.local/share/opencode/opencode-feat-x-y-z_1.2.db",
    });
  });

  it("OPENCODE_DISABLE_CHANNEL_DB counts only as exactly 1 or true", () => {
    for (const value of ["1", "true"]) {
      expect(resolve({ channel: "local", env: { OPENCODE_DISABLE_CHANNEL_DB: value } })).toEqual({
        ok: true,
        path: "/home/u/.local/share/opencode/opencode.db",
      });
    }
    for (const value of ["TRUE", "yes", "0", ""]) {
      expect(resolve({ channel: "local", env: { OPENCODE_DISABLE_CHANNEL_DB: value } })).toEqual({
        ok: true,
        path: "/home/u/.local/share/opencode/opencode-local.db",
      });
    }
  });

  it("OPENCODE_DB wins over the channel and resolves against the data dir", () => {
    expect(resolve({ channel: "local", env: { OPENCODE_DB: "custom.db" } })).toEqual({
      ok: true,
      path: "/home/u/.local/share/opencode/custom.db",
    });
    expect(resolve({ env: { OPENCODE_DB: "/abs/elsewhere.db" } })).toEqual({
      ok: true,
      path: "/abs/elsewhere.db",
    });
    expect(resolve({ env: { OPENCODE_DB: "../up.db" } })).toEqual({
      ok: true,
      path: "/home/u/.local/share/up.db",
    });
  });

  it("OPENCODE_DB=:memory: is unavailable", () => {
    const out = resolve({ env: { OPENCODE_DB: ":memory:" } });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain(":memory:");
  });

  it("XDG_DATA_HOME replaces ~/.local/share; an empty one falls back", () => {
    expect(resolve({ env: { XDG_DATA_HOME: "/xdg" } })).toEqual({
      ok: true,
      path: "/xdg/opencode/opencode.db",
    });
    expect(resolve({ env: { XDG_DATA_HOME: "" } })).toEqual({
      ok: true,
      path: "/home/u/.local/share/opencode/opencode.db",
    });
  });

  it("without a data directory only an absolute OPENCODE_DB resolves", () => {
    expect(resolve({ home: undefined }).ok).toBe(false);
    expect(resolve({ home: undefined, env: { OPENCODE_DB: "/abs/x.db" } })).toEqual({
      ok: true,
      path: "/abs/x.db",
    });
  });

  it("an explicit override replaces every rule", () => {
    expect(
      resolve({ override: "/opt/db/opencode.db", env: { OPENCODE_DB: "ignored.db" } }),
    ).toEqual({ ok: true, path: "/opt/db/opencode.db" });
    expect(resolve({ override: ":memory:" }).ok).toBe(false);
    expect(resolve({ override: " " }).ok).toBe(false);
  });
});

describe("opencodeDbPath (process wrapper)", () => {
  it("reads the live environment", async () => {
    const saved = { db: process.env.OPENCODE_DB, xdg: process.env.XDG_DATA_HOME };
    try {
      process.env.OPENCODE_DB = "wrapped.db";
      process.env.XDG_DATA_HOME = "/xdg-live";
      expect(await opencodeDbPath({ channel: "prod" })).toEqual({
        ok: true,
        path: "/xdg-live/opencode/wrapped.db",
      });
    } finally {
      if (saved.db === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = saved.db;
      if (saved.xdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = saved.xdg;
    }
  });
});
