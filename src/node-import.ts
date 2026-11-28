/**
 * Shared Node builtin loaders.
 *
 * `src/` has no `@types/node` (see AGENTS.md), so the only way to reach
 * `fs`/`path`/`os`/`worker_threads` is a dynamic `import()` behind a variable specifier — the
 * explicit `: string` annotation widens the specifier so `tsc` never tries to
 * resolve (and fail on) the builtin's missing type declarations. The
 * dynamic-import result is cast through `unknown` to a minimal structural type
 * declaring only the surface we use.
 *
 * `FsLike` is the superset of everything the callers touch: `store.ts` uses
 * `promises.mkdir` and `promises.stat`, the semantic embedder uses the
 * read/write/rename/stat surface too, and the debug log file sink (`log.ts`)
 * adds `appendFile`, and the v2 host's identity resolution adds `realpath`.
 * One shared shape satisfies all of them.
 */

export type FsLike = {
  promises: {
    mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    stat(path: string): Promise<{ size: number }>;
    appendFile(path: string, data: string): Promise<void>;
    realpath(path: string): Promise<string>;
  };
};
export type PathLike = {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
};
export type OsLike = { homedir(): string };

/** One end of a `node:worker_threads` message channel, as the worker code
 *  uses it: Node's `MessagePort`, and Bun's, which implements the same
 *  surface. */
export type ThreadPortLike = {
  postMessage(value: unknown, transferList?: readonly ArrayBuffer[]): void;
  on(event: "message", listener: (value: unknown) => void): unknown;
  off(event: "message", listener: (value: unknown) => void): unknown;
  close(): void;
  unref?(): void;
};

/** A `node:worker_threads` `Worker`, as the worker controller uses it. */
export type ThreadLike = {
  postMessage(value: unknown, transferList?: readonly ArrayBuffer[]): void;
  on(event: "message", listener: (value: unknown) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<unknown>;
  unref?(): void;
};

/** The `node:worker_threads` surface the worker code uses. */
export type WorkerThreadsLike = {
  Worker: new (url: URL, options?: { workerData?: unknown }) => ThreadLike;
  MessageChannel: new () => { port1: ThreadPortLike; port2: ThreadPortLike };
  parentPort: ThreadPortLike | null;
  workerData: unknown;
};

const NODE_FS: string = "node:fs";
const NODE_PATH: string = "node:path";
const NODE_OS: string = "node:os";
const NODE_WORKER_THREADS: string = "node:worker_threads";

export async function loadFs(): Promise<FsLike> {
  return (await import(NODE_FS)) as unknown as FsLike;
}
export async function loadPath(): Promise<PathLike> {
  return (await import(NODE_PATH)) as unknown as PathLike;
}
export async function loadOs(): Promise<OsLike> {
  return (await import(NODE_OS)) as unknown as OsLike;
}
/** `node:worker_threads`, which Node has and Bun implements: the one way to
 *  start a thread from code that runs on both. */
export async function loadWorkerThreads(): Promise<WorkerThreadsLike> {
  return (await import(NODE_WORKER_THREADS)) as unknown as WorkerThreadsLike;
}
