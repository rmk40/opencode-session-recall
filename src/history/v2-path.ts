import { loadOs, loadPath, type PathLike } from "../node-import.js";

/**
 * Where opencode v2 keeps its database, resolved exactly the way opencode does
 * (`cli/src/database-path.ts:4-13` with the data root from
 * `util/src/global-roots.ts:5`, both in opencode v2):
 *
 * - the filename is `OPENCODE_DB` when set (any string, even empty);
 * - else `opencode.db` when the build channel is one of
 *   `latest|dev|beta|next|prod`, or `OPENCODE_DISABLE_CHANNEL_DB` is exactly
 *   `"1"` or `"true"`;
 * - else `opencode-<channel>.db`, with every character outside
 *   `[a-zA-Z0-9._-]` replaced by `-`;
 * - `:memory:` means no file at all, so the history is unavailable;
 * - anything else resolves against `<XDG_DATA_HOME or ~/.local/share>/opencode`
 *   (an absolute filename wins, as with `path.resolve`).
 *
 * An explicit override (the `opencodeDbPath` option) replaces all of it.
 */

/** Channels that share the unsuffixed `opencode.db`. */
export const SHARED_DB_CHANNELS: readonly string[] = ["latest", "dev", "beta", "next", "prod"];

export type OpencodeDbPathInput = {
  /** The host's build channel (`ctx.app.channel`, opencode's compile-time
   *  `OPENCODE_CHANNEL`). */
  channel: string;
  env: Readonly<Record<string, string | undefined>>;
  /** The user's home directory, if one is known. */
  home: string | undefined;
  path: PathLike;
  /** An explicit database path that bypasses the resolution rules. */
  override?: string;
};

export type OpencodeDbPath = { ok: true; path: string } | { ok: false; reason: string };

const MEMORY = ":memory:";
const MEMORY_REASON =
  "opencode is using an in-memory database (:memory:); there is no file to read";

/** The pure resolver: every input is explicit, so each rule is testable. */
export function resolveOpencodeDbPath(input: OpencodeDbPathInput): OpencodeDbPath {
  const { env, path } = input;
  if (input.override !== undefined) {
    if (input.override === MEMORY) return { ok: false, reason: MEMORY_REASON };
    if (input.override.trim() === "") return { ok: false, reason: "empty opencodeDbPath" };
    return { ok: true, path: path.resolve(input.override) };
  }

  const disableChannelDb =
    env.OPENCODE_DISABLE_CHANNEL_DB === "1" || env.OPENCODE_DISABLE_CHANNEL_DB === "true";
  const filename =
    env.OPENCODE_DB ??
    (SHARED_DB_CHANNELS.includes(input.channel) || disableChannelDb
      ? "opencode.db"
      : `opencode-${input.channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`);
  if (filename === MEMORY) return { ok: false, reason: MEMORY_REASON };

  // `||`, not `??`: an empty XDG_DATA_HOME falls back, as in opencode.
  const dataRoot =
    env.XDG_DATA_HOME || (input.home ? path.join(input.home, ".local", "share") : undefined);
  if (dataRoot === undefined) {
    // Only an absolute filename is resolvable without a data directory.
    if (filename.startsWith("/")) return { ok: true, path: path.resolve(filename) };
    return {
      ok: false,
      reason: "no opencode data directory (XDG_DATA_HOME is unset and there is no home directory)",
    };
  }
  return { ok: true, path: path.resolve(path.join(dataRoot, "opencode"), filename) };
}

/**
 * Resolve the database path from the running process: environment through a
 * guarded `globalThis.process`, home and path operations through the lazy
 * Node builtin loaders. Never throws.
 */
export async function opencodeDbPath(o: {
  channel: string;
  override?: string;
}): Promise<OpencodeDbPath> {
  try {
    const env =
      (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    const [os, path] = await Promise.all([loadOs(), loadPath()]);
    let home: string | undefined;
    try {
      home = os.homedir() || undefined;
    } catch {
      home = undefined;
    }
    return resolveOpencodeDbPath({ channel: o.channel, env, home, path, override: o.override });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `cannot resolve the opencode database path: ${message}` };
  }
}
