import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { environmentOf } from './environment';
import type { CaptureEnvironment } from './protocol';

function runtimeFiles(root: string, relative: string, out: string[]): void {
  const entries = readdirSync(join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) runtimeFiles(root, path, out);
    else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) out.push(path);
  }
}

/** Digest (first 16 hex digits of sha256) of the runtime files under a built package directory. */
export function distDigest(root: string): string {
  const files: string[] = [];
  runtimeFiles(root, '', files);
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(root, file)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/** Which build produced a timing: the built package and the TS kernel identity. */
export function captureEnvironment(distRoot: string): CaptureEnvironment {
  return { distDigest: distDigest(distRoot), kernelSha: environmentOf().kernel };
}

const EXTENSIONS = ['', '.ts', '.mts', '.mjs', '.js', '/index.ts', '/index.mjs', '/index.js'];

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Digest (first 16 hex digits of sha256) of a job module and the relative-import closure it
 * reads: the value for `MeshJob.fingerprint`, so editing a helper module the build imports
 * misses the DDC. `entry` is a path or the `import.meta.url` of the job module. Bare
 * package imports are not followed.
 */
export function moduleDigest(entry: string): string {
  const start = entry.startsWith('file:') ? fileURLToPath(entry) : entry;
  const seen = new Map<string, string>();
  const pending = [start];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    seen.set(file, text);
    for (const [, spec] of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g)) {
      const base = join(dirname(file), spec as string);
      const found = EXTENSIONS.map((extension) => base + extension).find(isFile);
      if (found === undefined)
        throw new Error(`moduleDigest: ${spec as string} (imported by ${file}) is not a file`);
      pending.push(found);
    }
  }
  const root = dirname(start);
  const hash = createHash('sha256');
  for (const file of [...seen.keys()].sort()) {
    hash.update(`${relative(root, file).replace(/\\/g, '/')}\0${seen.get(file) as string}\0`);
  }
  return hash.digest('hex').slice(0, 16);
}
