import { isAbsolute, resolve } from 'node:path';
import { isShaderMaterialPackagePath } from '@forgeax/engine-vite-plugin-shader';
import type { DemoPluginProfile } from './demo-plugin-profile.js';
import { galleryLog } from './gallery-debug.js';

function normalizePackagePaths(paths: readonly string[], consumerRoot: string): string[] {
  return [
    ...new Set(
      paths.map((packagePath) =>
        isAbsolute(packagePath) ? resolve(packagePath) : resolve(consumerRoot, packagePath),
      ),
    ),
  ].sort();
}

/**
 * Prefer the demo's forgeaxShader({ materialPackages }) capture (matches standalone dev).
 * Fall back to catalog scan paths, keeping only packs forgeaxShader can load.
 */
export function resolveDemoMaterialPackages(
  profile: DemoPluginProfile | undefined,
  scanned: readonly string[],
): string[] {
  const consumerRoot = profile?.consumerRoot ?? process.cwd();
  const declared = profile?.shader?.materialPackages;
  const candidates =
    declared !== undefined && declared.length > 0
      ? normalizePackagePaths(declared, consumerRoot)
      : [...scanned];

  const accepted: string[] = [];
  for (const packagePath of candidates) {
    if (isShaderMaterialPackagePath(packagePath)) {
      accepted.push(packagePath);
      continue;
    }
    galleryLog('skip non-shader material pack for gallery shader plugin', { packagePath });
  }
  return accepted;
}
