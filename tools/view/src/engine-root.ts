import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** The exact-version Engine installation this View package depends on. */
export function installedEngineRoot(packageRoot?: string): string | undefined {
  try {
    return dirname(createRequire(packageRoot === undefined ? import.meta.url : join(packageRoot, 'package.json')).resolve('@forgeax/engine/package.json'));
  } catch {
    return undefined;
  }
}

/** Presentation version follows the Engine used by this View installation. */
export function installedEngineVersion(packageRoot?: string): string | undefined {
  const root = installedEngineRoot(packageRoot);
  if (root === undefined) return undefined;
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return typeof manifest.version === 'string' ? manifest.version : undefined;
}
