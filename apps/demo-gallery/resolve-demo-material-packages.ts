import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { DemoPluginProfile } from './demo-plugin-profile.js';
import { galleryLog } from './gallery-debug.js';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Mirror forgeaxShader material-pack acceptance without throwing. */
export function isShaderMaterialPackagePath(packagePath: string): boolean {
  try {
    const raw = readFileSync(packagePath, 'utf8');
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const pack = value as { schemaVersion?: unknown; kind?: unknown; assets?: unknown };
    if (pack.schemaVersion !== '1.0.0' && pack.schemaVersion !== '2.0.0') return false;
    if (pack.kind !== 'internal-text-package' || !Array.isArray(pack.assets)) return false;
    if (pack.assets.length !== 1) return false;
    const asset = pack.assets[0] as {
      guid?: unknown;
      kind?: unknown;
      sourceKey?: unknown;
      refs?: unknown;
      payload?: unknown;
    };
    if (typeof asset.guid !== 'string' || !GUID_RE.test(asset.guid)) return false;
    if (asset.kind !== 'material') return false;
    if (typeof asset.sourceKey !== 'string' || asset.sourceKey.length === 0) return false;
    if (!Array.isArray(asset.refs)) return false;
    if (typeof asset.payload !== 'object' || asset.payload === null || Array.isArray(asset.payload)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

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
