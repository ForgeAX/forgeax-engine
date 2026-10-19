import { isAbsolute, relative, sep } from 'node:path';

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

/** Reuse the same comparison key for unordered path lists. */
export function filesystemPathListKey(paths: Iterable<string>): string {
  return JSON.stringify([...paths].map(filesystemPathKey).sort());
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
