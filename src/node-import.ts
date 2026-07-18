/**
 * Shared Node builtin loaders.
 *
 * `src/` has no `@types/node` (see AGENTS.md), so the only way to reach
 * `fs`/`path`/`os` is a dynamic `import()` behind a variable specifier — the
 * explicit `: string` annotation widens the specifier so `tsc` never tries to
 * resolve (and fail on) the builtin's missing type declarations. The
 * dynamic-import result is cast through `unknown` to a minimal structural type
 * declaring only the surface we use.
 *
 * `FsLike` is the superset of everything the callers touch: {@link defaultStorePath}
 * in `store.ts` uses only `promises.mkdir`, while the semantic embedder uses the
 * read/write/rename/stat surface too. One shared shape satisfies both.
 */

export type FsLike = {
  promises: {
    mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    stat(path: string): Promise<{ size: number }>;
  };
};
export type PathLike = { join(...parts: string[]): string };
export type OsLike = { homedir(): string };

const NODE_FS: string = "node:fs";
const NODE_PATH: string = "node:path";
const NODE_OS: string = "node:os";

export async function loadFs(): Promise<FsLike> {
  return (await import(NODE_FS)) as unknown as FsLike;
}
export async function loadPath(): Promise<PathLike> {
  return (await import(NODE_PATH)) as unknown as PathLike;
}
export async function loadOs(): Promise<OsLike> {
  return (await import(NODE_OS)) as unknown as OsLike;
}
