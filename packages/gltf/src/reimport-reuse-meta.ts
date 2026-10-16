// reimport-reuse-meta.ts - two-stage GUID matching for reimport-stable
// `<source>.meta.json` with `importer: 'gltf'` (w13).
//
// Matching algorithm (plan-strategy decision section 2.4 + bevy comparison
// wiki section 3):
//
//   For each new item produced by parseGltf in source iteration order:
//     stage 1: existing entry with same (kind, name, indexFallback)  -> reuse
//     stage 2: existing entry with same (kind, indexFallback) only   -> reuse
//     fallback: AssetGuid.random() (UUIDv7 monotonic clock)
//
// Double-name hazard: when the SAME (kind, name) pair appears more than
// once in the new items list, stage 1 cannot disambiguate. The producer
// returns a structured source-key conflict before it can mint GUIDs or
// publish output; sourceIndex remains a locator and is never promoted to
// identity.
//
// AC anchors:
//   - AC-05: byte-identical reimport when nothing changes (stage 1 reuse path)
//   - AC-06: double-name conflict returns a structured source-key error
//   - AC-13: reimport idempotency overall (no spurious GUID churn)

import { AssetGuid } from '@forgeax/engine-pack/guid';
import { err, ok, type Result } from './errors.js';
import {
  deriveGltfSourceKeys,
  type GltfSourceKeyError,
  sourceKeyForGltfOutput,
} from './source-key.js';
import { type GltfDocItemLike, subAssetKey } from './sub-asset-key.js';

export type { SubAssetKey } from './sub-asset-key.js';
export { subAssetKey };
export type GltfDocItem = GltfDocItemLike;

/** Subset of `<source>.meta.json` fields (importer=gltf arm) touched by the reuse algorithm. */
export interface GltfSubAssetEntry {
  readonly guid: string;
  readonly sourceIndex: number;
  readonly kind: string;
  readonly sourceKey?: string;
  /** Optional display name copied from the current glTF output. */
  readonly name?: string;
}

export interface GltfMetaJson {
  readonly schemaVersion: 1;
  readonly kind: 'external-asset-package';
  readonly importer: 'gltf';
  readonly source: string;
  readonly subAssets: readonly GltfSubAssetEntry[];
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
  readonly subAssets: readonly GltfSubAssetEntry[];
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

  const stage1Index = new Map<string, GltfSubAssetEntry>();
  const stage2Index = new Map<string, GltfSubAssetEntry>();
  if (existingMeta !== undefined) {
    for (const entry of existingMeta.subAssets) {
      // Source names are display metadata, not identity. Semantic sourceKey
      // remains the stage-1 identity and (kind, sourceIndex) remains the
      // stage-2 locator fallback.
      if (entry.sourceKey !== undefined) stage1Index.set(entry.sourceKey, entry);
      stage2Index.set(`${entry.kind} ${entry.sourceIndex}`, entry);
    }
  }

  const subAssets: GltfSubAssetEntry[] = [];
  for (const item of items) {
    const sourceKey = sourceKeyForGltfOutput(item);
    const indexKey = `${item.kind} ${item.sourceIndex}`;
    let reused: GltfSubAssetEntry | undefined;

    // Stage 1: semantic sourceKey match. Names are copied from the current
    // source output below, but never participate in identity matching.
    if (sourceKey !== undefined) reused = stage1Index.get(sourceKey);
    // Stage 2: (kind, indexFallback) only.
    if (reused === undefined) {
      reused = stage2Index.get(indexKey);
    }

    if (reused !== undefined) {
      subAssets.push({
        guid: reused.guid,
        sourceIndex: item.sourceIndex,
        kind: item.kind,
        ...(sourceKey === undefined ? {} : { sourceKey }),
        ...(item.name === undefined ? {} : { name: item.name }),
      });
    } else {
      const fresh = AssetGuid.random();
      subAssets.push({
        guid: AssetGuid.format(fresh),
        sourceIndex: item.sourceIndex,
        kind: item.kind,
        ...(sourceKey === undefined ? {} : { sourceKey }),
        ...(item.name === undefined ? {} : { name: item.name }),
      });
    }
  }

  return ok({ subAssets });
}
