import type { AssetCompression, ImageMeta } from '@forgeax/engine-types';

/**
 * External-asset-package envelope shape mirroring the
 * `packages/pack/schema/meta.schema.json` $defs/ExternalAssetPackage.
 * Consumed by `forgeax asset import` (unified CLI entry) +
 * the image importer in M2 build-time path. The internal-text-package
 * variant ($defs/InternalTextPackage) is owned by the gltf-loader feat.
 */
export interface ExternalAssetPackage {
  readonly schemaVersion: string;
  readonly kind: 'external-asset-package';
  readonly importer: 'image';
  readonly source: string;
  readonly importSettings: ImageImportSettings;
  readonly subAssets: readonly ExternalSubAsset[];
}

/**
 * Free-form image importer settings persisted into `*.meta.json` (importer: 'image')
 * `importSettings`. Matches `ImageMeta` POD field-for-field (charter P5
 * single SSOT) but the open Record shape allows future minor adds (cubemap
 * face / array layer / custom colorSpace) without breaking existing meta
 * files (plan-strategy R5).
 */
export interface ImageImportSettings extends Readonly<Record<string, unknown>> {
  readonly colorSpace: ImageMeta['colorSpace'];
  readonly mipmap: ImageMeta['mipmap'];
  readonly addressMode: ImageMeta['addressMode'];
  readonly filterMode: ImageMeta['filterMode'];
  readonly downscaleMaxDimension?: number;
  /**
   * Explicit per-asset compression override (AC-01: importSettings carries
   * compression intent). When omitted, the build-time compression strategy
   * table decides by artifact kind (mesh -> zstd, texture -> none). When set,
   * this value wins over the default table for this asset.
   */
  readonly compression?: AssetCompression;
}

export interface ExternalSubAsset {
  readonly guid: string;
  readonly sourceIndex: number;
  readonly kind: string;
  readonly name?: string;
}

/**
 * Pure function that translates an ImageMeta POD into
 * an external-asset-package envelope ready to be JSON-stringified into a
 * `*.meta.json` sidecar with importer: 'image' (plan-strategy section 3.2 sequence A; AC-13
 * disk schema reuse).
 *
 * The single sub-asset emitted carries:
 *  - `guid` -- copied verbatim from `meta.guid` (the producer guarantees
 *    the GUID is freshly minted or reused via `reimportReuseMeta`)
 *  - `sourceIndex: 0` (single-sub-asset shape; cubemap / array reserved
 *    for future feat)
 *  - `kind: 'texture'` (closed literal for image-importer emit)
 *
 * Two consecutive calls with identical inputs produce JSON.stringify
 * byte-equal output (AC-16 idempotent reimport).
 */
export function toAssetPack(meta: ImageMeta): ExternalAssetPackage {
  return {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    source: '',
    importSettings: {
      colorSpace: meta.colorSpace,
      mipmap: meta.mipmap,
      addressMode: meta.addressMode,
      filterMode: meta.filterMode,
      ...(meta.downscaleMaxDimension !== undefined
        ? { downscaleMaxDimension: meta.downscaleMaxDimension }
        : {}),
    },
    subAssets: [
      {
        guid: meta.guid,
        sourceIndex: 0,
        kind: 'texture',
      },
    ],
  };
}
