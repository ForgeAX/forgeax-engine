// Reimport preserves GUIDs by semantic sourceKey, then by (kind, sourceIndex).
// Validate the complete output set before minting any new identity.

import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { ImportSubAsset } from '@forgeax/engine-types';
import { err, ok, type Result } from './errors.js';
import { deriveGltfSourceKeys, type GltfSourceKeyError } from './source-key.js';
import { type GltfDocItem, subAssetKey } from './sub-asset-key.js';

export type { GltfDocItem, SubAssetKey } from './sub-asset-key.js';
export { subAssetKey };

export interface GltfMetaJson {
  readonly schemaVersion: 1;
  readonly kind: 'external-asset-package';
  readonly importer: 'gltf';
  readonly source: string;
  readonly subAssets: readonly ImportSubAsset[];
  readonly sourceOverrides?:
    | Readonly<Record<string, Readonly<Record<string, unknown>>>>
    | undefined;
  readonly sourceOverrideDescriptors?: readonly import('@forgeax/engine-types').SourceOverrideDescriptor[];
  readonly importSettings: {
    readonly defaultSceneIndex: number;
    readonly standardMaterialGuid?: string;
    readonly downscaleMaxDimension?: number;
    readonly diagnostics: {
      readonly nodeNames: readonly string[];
      readonly unsupportedExtensions: readonly string[];
      readonly matrixTrsCoexistNodes: readonly number[];
    };
  };
}

export interface ReimportReuseValue {
  readonly subAssets: readonly ImportSubAsset[];
}

export type ReimportReuseResult = Result<ReimportReuseValue, GltfSourceKeyError>;

/**
 * Apply the two-stage reuse algorithm to a freshly parsed item list.
 * Returns the new `subAssets[]` array (preserving item order), or a
 * structured source-key conflict before any output is published.
 *
 * Pure function: no fs / network / global state. `AssetGuid.random()` is
 * the only entropy source; deterministic in absence of new items.
 */
export function reimportReuseMeta(
  items: readonly GltfDocItem[],
  existingMeta: GltfMetaJson | undefined,
): ReimportReuseResult {
  const sourceKeys = deriveGltfSourceKeys(items);
  if (!sourceKeys.ok) return err(sourceKeys.error);

  const stage1Index = new Map<string, ImportSubAsset>();
  const stage2Index = new Map<string, ImportSubAsset>();
  if (existingMeta !== undefined) {
    for (const entry of existingMeta.subAssets) {
      // Source names are display metadata, not identity. Semantic sourceKey
      // remains the stage-1 identity and (kind, sourceIndex) remains the
      // stage-2 locator fallback.
      if (entry.sourceKey !== undefined) stage1Index.set(entry.sourceKey, entry);
      stage2Index.set(`${entry.kind} ${entry.sourceIndex}`, entry);
    }
  }

  const subAssets: ImportSubAsset[] = [];
  for (const item of sourceKeys.items) {
    const reused =
      stage1Index.get(item.sourceKey) ?? stage2Index.get(`${item.kind} ${item.sourceIndex}`);
    subAssets.push({
      guid: reused?.guid ?? AssetGuid.format(AssetGuid.random()),
      sourceIndex: item.sourceIndex,
      kind: item.kind,
      sourceKey: item.sourceKey,
      ...(item.name === undefined ? {} : { name: item.name }),
    });
  }

  return ok({ subAssets });
}
