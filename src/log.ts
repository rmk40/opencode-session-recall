import { loadFs, loadOs, loadPath, type FsLike } from "./node-import.js";

/**
 * Plugin logging through a host-chosen sink.
 *
 * Every log call goes through {@link createLogger}, which adds the `[recall] `
 * prefix and swallows sink failures, so logging can never throw into plugin
 * init, a hook, or a tool. The v1 host uses {@link consoleSink} (its console
 * reaches the TUI log). The v2 host discards plugin console output, so it gets
 * {@link createFileSink}: an opt-in, size-capped append-only file.
 */

/** Receives one fully formatted line (no trailing newline). */
export type LogSink = (line: string) => void;
export type Logger = (message: string) => void;

export const LOG_PREFIX = "[recall] ";

export function createLogger(sink: LogSink): Logger {
  return (message) => {
    try {
      sink(`${LOG_PREFIX}${message}`);
    } catch {
      // Logging is best-effort; never let it throw into the caller.
    }
  };
}

/** `console.log`, reached defensively: `console` is a std global, but `src/`
 *  declares no Node types. */
export const consoleSink: LogSink = (line) => {
  (globalThis as { console?: { log?: (msg: string) => void } }).console?.log?.(line);
};

type ProcessLike = { env?: Record<string, string | undefined>; pid?: number };

function hostProcess(): ProcessLike | undefined {
  return (globalThis as { process?: ProcessLike }).process;
}

/** Default size cap for the debug log file (bytes). */
export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_CACHE_SUBDIR = ".cache/opencode-session-recall";
const LOG_FILENAME = "recall.log";

export type FileSinkOptions = {
  /** Host tag written on every line (e.g. `"opencode-v2"`). */
  host: string;
  /** Whether to write at all. Default: `RECALL_DEBUG` is exactly `"1"`. */
  enabled?: boolean;
  /** Log file. Default: `~/.cache/opencode-session-recall/recall.log`. */
  path?: string;
  /** When an append would grow the file past this many bytes, the file is
   *  first rotated to `<path>.1` (replacing any older rotation). */
  maxBytes?: number;
  now?: () => number;
};

/** A file sink plus a way to wait for queued writes (shutdown and tests). */
export type FileSink = LogSink & { flush(): Promise<void> };

/**
 * An append-only file sink. Disabled (the default unless `RECALL_DEBUG=1`), it
 * is a no-op that touches nothing. Enabled, each line is written whole, as
 * `<ISO time> pid=<pid> <host> <line>`, through one serialized write chain. The
 * `node:fs` import is lazy and never awaited by the caller, so calling the sink
 * costs no I/O on the caller's path. Any file error drops that line; a failed
 * import disables the sink.
 */
export function createFileSink(options: FileSinkOptions): FileSink {
  const proc = hostProcess();
  const enabled = options.enabled ?? proc?.env?.RECALL_DEBUG === "1";
  if (!enabled) {
    const noop: LogSink = () => {};
    return Object.assign(noop, { flush: () => Promise.resolve() });
  }

  const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  const now = options.now ?? Date.now;
  const pid = proc?.pid ?? 0;
  const encoder = new TextEncoder();
  let chain: Promise<void> = Promise.resolve();
  let target: Promise<{ fs: FsLike; path: string } | null> | undefined;
  /** Bytes this process believes the file holds; re-read before rotating. */
  let size: number | undefined;

  const resolveTarget = (): Promise<{ fs: FsLike; path: string } | null> => {
    target ??= (async () => {
      try {
        const fs = await loadFs();
        if (options.path) return { fs, path: options.path };
        const [path, os] = await Promise.all([loadPath(), loadOs()]);
        const dir = path.join(os.homedir(), LOG_CACHE_SUBDIR);
        await fs.promises.mkdir(dir, { recursive: true });
        return { fs, path: path.join(dir, LOG_FILENAME) };
      } catch {
        return null;
      }
    })();
    return target;
  };

  const fileSize = async (fs: FsLike, path: string): Promise<number> => {
    try {
      return (await fs.promises.stat(path)).size;
    } catch {
      return 0; // missing file
    }
  };

  const write = async (text: string): Promise<void> => {
    const resolved = await resolveTarget();
    if (!resolved) return;
    const { fs, path } = resolved;
    const bytes = encoder.encode(text).length;
    try {
      size ??= await fileSize(fs, path);
      if (size + bytes > maxBytes) {
        // Other processes append to the same file: re-read before rotating.
        size = await fileSize(fs, path);
        if (size + bytes > maxBytes && size > 0) {
          await fs.promises.rename(path, `${path}.1`);
          size = 0;
        }
      }
      await fs.promises.appendFile(path, text);
      size += bytes;
    } catch {
      // Best-effort: drop this line.
    }
  };

  const sink = (line: string): void => {
    const text = `${new Date(now()).toISOString()} pid=${pid} ${options.host} ${line}\n`;
    chain = chain.then(() => write(text));
  };
  return Object.assign(sink, { flush: () => chain });
}
