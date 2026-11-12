import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
