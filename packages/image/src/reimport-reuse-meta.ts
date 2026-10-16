import { AssetGuid } from '@forgeax/engine-pack/guid';
import { deriveImageSourceKey } from './source-key.js';

/** Persisted identity for the image producer's single texture output. */
export interface ExistingSubAsset {
  readonly guid: string;
  readonly sourceIndex: number;
  readonly kind: string;
  readonly name?: string;
  readonly sourceKey?: string;
}

export interface ExistingExternalAssetPackage {
  readonly schemaVersion: string;
  readonly kind: 'external-asset-package';
  readonly importer: 'image';
  readonly source: string;
  readonly importSettings: Readonly<Record<string, unknown>>;
  readonly subAssets: readonly ExistingSubAsset[];
}

export type EmittedSubAsset = ExistingSubAsset;

/** Preserve the first matching source identity or unnamed legacy texture locator. */
export function reimportReuseMeta(
  existing: ExistingExternalAssetPackage | undefined,
): readonly EmittedSubAsset[] {
  const sourceKey = deriveImageSourceKey('texture');
  const reused = existing?.subAssets.find(
    (candidate) =>
      (sourceKey !== undefined && candidate.sourceKey === sourceKey) ||
      (candidate.kind === 'texture' && candidate.sourceIndex === 0 && candidate.name === undefined),
  );
  return [
    {
      guid: reused?.guid ?? AssetGuid.format(AssetGuid.random()),
      sourceIndex: 0,
      kind: 'texture',
      ...(sourceKey === undefined ? {} : { sourceKey }),
    },
  ];
}
