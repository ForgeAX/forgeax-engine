import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { ImportSubAsset } from '@forgeax/engine-types';
import { deriveImageSourceKey } from './source-key.js';
import type { ExternalAssetPackage } from './to-asset-pack.js';

export interface ExistingExternalAssetPackage extends Omit<ExternalAssetPackage, 'importSettings'> {
  readonly importSettings: Readonly<Record<string, unknown>>;
}

/** Preserve the first matching source identity or unnamed legacy texture locator. */
export function reimportReuseMeta(
  existing: ExistingExternalAssetPackage | undefined,
): readonly ImportSubAsset[] {
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
