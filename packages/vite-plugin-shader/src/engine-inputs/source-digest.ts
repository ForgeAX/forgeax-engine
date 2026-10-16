import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';

/** Records which engine WGSL sources produced a packaged shader profile. */
export const PACKAGED_SOURCE_RECORD = 'source.json';

export interface PackagedSourceRecord {
  readonly shaderSourceDigest: string;
}

function collectWgsl(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectWgsl(path, files);
    else if (entry.isFile() && entry.name.endsWith('.wgsl')) files.push(path);
  }
}

/**
 * SHA-256 over Engine and package-owned WGSL plus their program declarations.
 * Paths stay relative so producer and consumer checkouts agree. `undefined`
 * when `root` holds no WGSL, i.e. there is no source to compare against.
 */
export function engineShaderSourceDigest(root: string): string | undefined {
  const files: string[] = [];
  try {
    collectWgsl(root, files);
  } catch {
    return undefined;
  }
  if (files.length === 0) return undefined;
  const hash = createHash('sha256');
  const rows = files.map((path) => [relative(root, path).split(sep).join('/'), path] as const);
  rows.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [name, path] of rows) {
    hash.update(name).update('\0').update(readFileSync(path)).update('\0');
  }
  // The shared profile also publishes package-owned VFX programs. Their
  // declarations and WGSL are inputs even when the common View is unchanged.
  try {
    let manifestPath: string;
    try {
      manifestPath = createRequire(join(root, 'package.json')).resolve(
        '@forgeax/engine-vfx-render/package.json',
      );
    } catch {
      manifestPath = createRequire(import.meta.url).resolve(
        '@forgeax/engine-vfx-render/package.json',
      );
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    hash.update(JSON.stringify(manifest.forgeax?.materialPrograms ?? {})).update('\0');
    const packageRoot = join(dirname(manifestPath), 'src', 'shaders');
    const packageFiles: string[] = [];
    collectWgsl(packageRoot, packageFiles);
    for (const path of packageFiles.sort()) {
      hash
        .update(`vfx-render/${relative(packageRoot, path).split(sep).join('/')}`)
        .update('\0')
        .update(readFileSync(path))
        .update('\0');
    }
  } catch {
    // A shader-only consumer has no package-owned VFX entries.
  }
  return hash.digest('hex');
}
