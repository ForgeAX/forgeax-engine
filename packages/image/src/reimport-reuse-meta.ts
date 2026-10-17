import { AssetGuid } from '@forgeax/engine-pack/guid';
import { deriveImageSourceKey } from './source-key.js';
import type { ExternalAssetPackage, ExternalSubAsset } from './to-asset-pack.js';

/** Persisted identity for the image producer's single texture output. */
export interface ExistingSubAsset extends ExternalSubAsset {
  readonly sourceKey?: string;
}

export interface ExistingExternalAssetPackage
  extends Omit<ExternalAssetPackage, 'importSettings' | 'subAssets'> {
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
