import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { SourceDeclarationEvidence } from '@forgeax/engine-types';
import { parsePackSourceJson } from '../pack-authoring.js';
import { declaredPackAssets, SCANNER_BLACKLIST, scan } from '../scanner.js';

/** Project root and GUID used to locate an authoritative source declaration. */
export interface SourceInventoryRequest {
  readonly projectRoot: string;
  readonly guid: string;
}

function fingerprint(meta: string, source: Uint8Array | undefined): string {
  const hash = createHash('sha256').update(meta);
  if (source !== undefined) hash.update(source);
  return hash.digest('base64');
}

function sourceFromMeta(
  metaPath: string,
  meta: {
    readonly source?: unknown;
    readonly inputFingerprint?: unknown;
    readonly importSettings?: unknown;
    readonly subAssets?: readonly { readonly guid?: unknown }[];
  },
  guid: string,
  raw: string,
): SourceDeclarationEvidence | undefined {
  if (
    !meta.subAssets?.some(
      (asset) => typeof asset.guid === 'string' && asset.guid.toLowerCase() === guid.toLowerCase(),
    )
  ) {
    return undefined;
  }
  const source =
    typeof meta.source === 'string' ? meta.source : basename(metaPath).replace(/\.meta\.json$/, '');
  const sourcePath = resolve(dirname(metaPath), source);
  const inputFingerprint =
    typeof meta.inputFingerprint === 'string' ? meta.inputFingerprint : fingerprint(raw, undefined);
  return { origin: 'sourceMeta', sourcePath, inputFingerprint };
}

async function collectDeclarationPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SCANNER_BLACKLIST.has(entry.name)) await visit(path);
        continue;
      }
      if (
        entry.isFile() &&
        (entry.name.endsWith('.meta.json') ||
          entry.name.endsWith('.pack.json') ||
          entry.name.endsWith('.pack.ts'))
      ) {
        paths.push(path);
      }
    }
  }
  await visit(root);
  return paths;
}

/** Read `.meta.json` or `.pack.json` source declarations without runtime imports. */
export async function readSourceInventory(
  request: SourceInventoryRequest,
): Promise<SourceDeclarationEvidence | undefined> {
  const result = await scan([request.projectRoot]);
  const paths = result.ok ? result.value : await collectDeclarationPaths(request.projectRoot);
  const guid = request.guid.toLowerCase();
  let authored: SourceDeclarationEvidence | undefined;
  for (const path of paths) {
    if (path.endsWith('.pack.ts')) {
      // ScriptablePack source identity is a build result, not a declaration
      // table. The source index therefore records the source only after the
      // producer publishes its materialized Pack output.
      continue;
    }
    const raw = await readFile(path, 'utf8').catch(() => undefined);
    if (raw === undefined) continue;
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(raw);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      parsed = value as Record<string, unknown>;
    } catch {
      continue;
    }
    if (path.endsWith('.pack.json')) {
      if (parsed.schemaVersion === '3.0.0') {
        const document = parsePackSourceJson(parsed);
        if (
          document.ok &&
          declaredPackAssets(document.value).some((asset) => asset.guid.toLowerCase() === guid)
        )
          authored = { origin: 'authoredPack', sourcePath: path };
      } else if (
        Array.isArray(parsed.assets) &&
        parsed.assets.some(
          (asset) =>
            asset !== null &&
            typeof asset === 'object' &&
            !Array.isArray(asset) &&
            typeof (asset as { readonly guid?: unknown }).guid === 'string' &&
            ((asset as { readonly guid: string }).guid === request.guid ||
              (asset as { readonly guid: string }).guid.toLowerCase() === guid),
        )
      ) {
        authored = { origin: 'authoredPack', sourcePath: path };
      }
      continue;
    }
    if (path.endsWith('.meta.json')) {
      const source = sourceFromMeta(
        path,
        parsed as Parameters<typeof sourceFromMeta>[1],
        request.guid,
        raw,
      );
      if (source !== undefined) return source;
    }
  }
  return authored;
}
