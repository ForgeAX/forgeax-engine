import { randomUUID } from 'node:crypto';
import { access, open, readdir, rename, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

interface FilesystemPathApi {
  readonly sep: string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
}

const nativePath: FilesystemPathApi = { isAbsolute, relative, sep };

/** Normalize only separators for native paths and Vite IDs; preserve case and path identity. */
export function filesystemPathKey(path: string): string {
  return path.replaceAll('\\', '/');
}

/** Root fences use native path rules; comparison keys grant no directory authority. */
export function filesystemPathRelative(
  root: string,
  candidate: string,
  allowRoot = true,
  pathApi: FilesystemPathApi = nativePath,
): string | undefined {
  const local = pathApi.relative(root, candidate);
  if (local === '') return allowRoot ? local : undefined;
  if (local === '..' || local.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(local))
    return undefined;
  return local;
}

export function isFilesystemPathWithin(
  root: string,
  candidate: string,
  allowRoot = true,
  pathApi: FilesystemPathApi = nativePath,
): boolean {
  return filesystemPathRelative(root, candidate, allowRoot, pathApi) !== undefined;
}

export function filesystemPathSegments(
  path: string,
  pathApi: Pick<FilesystemPathApi, 'sep'> = nativePath,
): string[] {
  return path.split(pathApi.sep);
}

/** An existence hint only; callers that own a path still verify it when opening. */
export function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export function isMissingPathError(cause: unknown): boolean {
  return cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT';
}

/** The caller owns the parent directory; only complete bytes replace the target. */
export async function writeFileAtomic(
  path: string,
  bytes: string | Uint8Array,
  {
    mode,
    syncFile = false,
    signal,
  }: { mode?: number; syncFile?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  signal?.throwIfAborted();
  const staged = `${path}.${randomUUID()}.tmp`;
  const file = await open(staged, 'wx', mode);
  try {
    try {
      await file.writeFile(bytes, { signal });
      if (syncFile) await file.sync();
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    await rename(staged, path);
  } catch (cause) {
    try {
      await rm(staged, { force: true });
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'File publication and staging cleanup failed', {
        cause,
      });
    }
    throw cause;
  }
}

/** A symlink to a directory keeps the same destination semantics as readdir. */
export async function directoryOccupancy(path: string): Promise<'absent' | 'empty' | 'occupied'> {
  try {
    return (await readdir(path)).length === 0 ? 'empty' : 'occupied';
  } catch (cause) {
    if (!isMissingPathError(cause)) throw cause;
    return 'absent';
  }
}

/** Publish into a vacant destination and track entries to roll back a failed install. */
export async function publishPreparedDirectory<T>(
  prepared: string,
  destination: string,
  expected: 'absent' | 'empty',
  activate: () => Promise<T>,
  activationOutputs: readonly string[] = [],
): Promise<T> {
  if ((await directoryOccupancy(destination)) !== expected)
    throw new Error(`Directory changed before publication: ${destination}`);
  const moved: string[] = [];
  let adopted = false;
  let activating = false;
  try {
    if (expected === 'absent') {
      await rename(prepared, destination);
      adopted = true;
    } else {
      for (const name of await readdir(prepared)) {
        await rename(resolve(prepared, name), resolve(destination, name));
        moved.push(name);
      }
      await rm(prepared, { recursive: true });
    }
    activating = true;
    return await activate();
  } catch (cause) {
    const paths = adopted
      ? [destination]
      : [...new Set([...moved, ...(activating ? activationOutputs : [])])].map((name) =>
          resolve(destination, name),
        );
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
    throw cause;
  }
}
