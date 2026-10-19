import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { ImportSubAsset } from '@forgeax/engine-types';
import { type AssetError, ok, type Result } from '@forgeax/engine-types';
import { formatFailure } from './errors.js';
import { meshSourceKey, parseMeshSource } from './importer.js';

/** Source admission creates/reuses authored identities; the Importer only consumes them. */
export async function importMeshFile(
  path: string,
  dryRun = false,
): Promise<
  Result<
    {
      source: string;
      metaPath: string;
      subAssets: readonly (ImportSubAsset & { readonly sourceKey: string })[];
    },
    AssetError
  >
> {
  const format = extname(path).slice(1).toLowerCase();
  if (format !== 'obj' && format !== 'stl' && format !== 'svg')
    return formatFailure('source', 'expected OBJ, STL or SVG');
  try {
    const metaPath = `${path}.meta.json`;
    let existing:
      | {
          importer?: string;
          source?: string;
          subAssets?: (ImportSubAsset & { readonly sourceKey: string })[];
          importSettings?: Record<string, unknown>;
        }
      | undefined;
    try {
      existing = JSON.parse(await readFile(metaPath, 'utf8'));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
        return formatFailure('meta', 'existing sidecar is unreadable');
    }
    if (
      existing !== undefined &&
      (existing.importer !== format ||
        existing.source !== basename(path) ||
        !Array.isArray(existing.subAssets))
    )
      return formatFailure('meta', 'existing sidecar belongs to a different source or importer');
    const declarations = existing?.subAssets ?? [];
    if (
      declarations.some(
        (entry) =>
          !['mesh', 'material', 'texture'].includes(entry.kind) ||
          typeof entry.sourceKey !== 'string' ||
          !AssetGuid.parse(entry.guid).ok,
      ) ||
      new Set(declarations.map((entry) => entry.guid)).size !== declarations.length ||
      new Set(declarations.map((entry) => entry.sourceKey)).size !== declarations.length
    )
      return formatFailure(
        'meta',
        'existing sidecar requires unique valid mesh GUIDs and sourceKeys',
      );
    const bytes = await readFile(path);
    const parsed = await parseMeshSource(
      format,
      bytes,
      async (uri) => readFile(resolve(dirname(path), uri)),
      typeof existing?.importSettings?.curveSegments === 'number'
        ? existing.importSettings.curveSegments
        : 24,
    );
    if (!parsed.ok) return parsed;
    const { meshes, materials, textures } = parsed.value;
    const rows = [
      ...meshes.map((mesh) => ({ sourceKey: meshSourceKey(mesh), kind: 'mesh' })),
      ...materials.map((material) => ({ sourceKey: material.sourceKey, kind: 'material' })),
      ...textures.map((texture) => ({ sourceKey: texture.sourceKey, kind: 'texture' })),
    ];
    const keys = rows.map((row) => row.sourceKey);
    if (new Set(keys).size !== keys.length)
      return formatFailure('sourceKey', 'duplicate object names; give each object a unique name');
    const previous = new Map(existing?.subAssets?.map((entry) => [entry.sourceKey, entry]));
    const subAssets = rows.map(({ sourceKey, kind }, sourceIndex) => ({
      guid: previous.get(sourceKey)?.guid ?? AssetGuid.format(AssetGuid.random()),
      kind,
      sourceKey,
      sourceIndex,
    }));
    if (!dryRun)
      await writeFile(
        metaPath,
        `${JSON.stringify({ ...existing, schemaVersion: 1, kind: 'external-asset-package', importer: format, source: basename(path), subAssets, importSettings: existing?.importSettings ?? {} }, null, 2)}\n`,
      );
    return ok({ source: path, metaPath, subAssets });
  } catch (cause) {
    return formatFailure('source', cause instanceof Error ? cause.message : String(cause));
  }
}
