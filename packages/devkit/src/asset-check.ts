import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  createMaterialPackCooker,
  createTextureGeneratorPackCooker,
} from '@forgeax/engine-shader-compiler';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine-vfx-compiler';
import { createDefaultCloudCookers } from './cloud-cookers.js';

/** One authored asset that the real cookers rejected. */
export interface AssetCheckFailure {
  readonly pack: string;
  readonly key: string;
  readonly kind: string;
  readonly message: string;
}

export interface AssetCheckReport {
  /** Supported build-only rows cooked successfully by the real producers. */
  readonly checked: number;
  /** Authored `*.pack.ts` sources are evaluated by build only; they are listed, not cooked. */
  readonly skipped: readonly string[];
  readonly failures: readonly AssetCheckFailure[];
}

const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.forgeax']);

async function listPackFiles(root: string, out: string[], skipped: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) await listPackFiles(path, out, skipped);
    } else if (entry.name.endsWith('.pack.json')) out.push(path);
    else if (entry.name.endsWith('.pack.ts')) skipped.push(path);
  }
}

/** Stable UUID-shaped identity; a dry cook needs a valid guid, not the published one. */
function dryGuid(packageId: string, key: string): string {
  const hex = createHash('sha256').update(`${packageId}\0${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface CheckedAssetRow {
  readonly kind:
    | 'material'
    | 'particle-effect'
    | 'texture-generator'
    | 'cloud-material'
    | 'cloud-material-instance';
  readonly payload?: unknown;
  readonly refs?: unknown;
}

/** Select the authored source kinds whose domain producers this check can execute. */
function isCheckedAssetRow(value: unknown): value is CheckedAssetRow {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'material':
    case 'particle-effect':
    case 'texture-generator':
    case 'cloud-material':
    case 'cloud-material-instance':
      return true;
    default:
      return false;
  }
}

function describeDetail(detail: unknown): string[] {
  if (!isRecord(detail)) return [];
  const facts = Object.entries(detail)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .map(([name, value]) => `${name}=${String(value)}`);
  const nested = describeDetail(detail.cause ?? detail.causeDetail);
  return [...facts, ...nested];
}

function messageOf(cause: unknown): string {
  if (isRecord(cause)) {
    const parts = [cause.code, cause.expected, cause.hint, cause.message].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    );
    const facts = describeDetail(cause.detail ?? cause.cause);
    if (parts.length > 0 || facts.length > 0)
      return [...new Set(parts), ...(facts.length > 0 ? [`(${facts.join(', ')})`] : [])].join(': ');
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Offline dry cook of supported `*.pack.json` rows under `assetRoots`. It runs
 * the same domain cookers a build uses, so a wrong parameter type, a bad value form, a
 * missing shader module or an invalid `.vfx.wgsl` fails in seconds instead of
 * after a full dev start. Nothing is written.
 */
export async function checkProjectAssets(
  projectRoot: string,
  assetRoots: readonly string[],
): Promise<AssetCheckReport> {
  const roots = assetRoots
    .map((root) => resolve(projectRoot, root))
    .filter((root) => existsSync(root));
  const packs: string[] = [];
  const skipped: string[] = [];
  for (const root of roots) await listPackFiles(root, packs, skipped);
  // Cookers scan their roots on creation; build them only for a row that needs one.
  let material: ReturnType<typeof createMaterialPackCooker> | undefined;
  let generator: ReturnType<typeof createTextureGeneratorPackCooker> | undefined;
  let particle: ReturnType<typeof createParticleCodeNativeCookerFromRoots> | undefined;
  const clouds = createDefaultCloudCookers();
  const failures: AssetCheckFailure[] = [];
  let checked = 0;
  for (const path of packs.sort()) {
    const name = relative(projectRoot, path);
    let document: unknown;
    try {
      document = JSON.parse(await readFile(path, 'utf8'));
    } catch (cause) {
      failures.push({ pack: name, key: '', kind: 'pack', message: messageOf(cause) });
      continue;
    }
    if (!isRecord(document) || !isRecord(document.assets)) continue;
    const packageId = typeof document.packageId === 'string' ? document.packageId : name;
    for (const [key, row] of Object.entries(document.assets)) {
      if (!isCheckedAssetRow(row)) continue;
      const guid = dryGuid(packageId, key);
      try {
        if (row.kind === 'material') {
          material ??= createMaterialPackCooker(roots);
          await material.cook({
            guid,
            source: row.payload,
            sourceKey: key,
            sourcePath: path,
            refs: Array.isArray(row.refs) ? row.refs : [],
          });
        } else if (row.kind === 'texture-generator') {
          generator ??= createTextureGeneratorPackCooker(roots);
          await generator.cook({ guid, source: row.payload });
        } else if (row.kind === 'particle-effect') {
          particle ??= createParticleCodeNativeCookerFromRoots(roots);
          await particle.cook({ guid, source: row.payload });
        } else {
          const cloud = clouds.find((cooker) => cooker.key === row.kind);
          if (cloud === undefined) throw new Error('Missing cloud cooker');
          await cloud.cook({ guid, source: row.payload, sourcePath: path });
        }
        checked += 1;
      } catch (cause) {
        failures.push({ pack: name, key, kind: String(row.kind), message: messageOf(cause) });
      }
    }
  }
  return { checked, skipped: skipped.map((path) => relative(projectRoot, path)).sort(), failures };
}
