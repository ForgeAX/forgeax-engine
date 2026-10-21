import { meshAssetContribution } from '@forgeax/engine-geometry';
import type { BuiltinAssetKind } from '@forgeax/engine-types';
import {
  materialContribution,
  samplerContribution,
} from '../../../../render/src/assets/asset-decoders';
import { defineAssetKind } from '../../asset-kind';
import type { AssetRegistry } from '../../asset-registry';
import { pluginAssetDecoder } from '../../loaders/plugin';

export const runtimePackDecoders = [
  meshAssetContribution,
  materialContribution,
  samplerContribution,
  { kind: defineAssetKind('plugin'), consumer: 'Plugin', decoder: pluginAssetDecoder },
];

/** Assertions borrow the ordinary accepted payload after explicit source admission. */
export async function loadFixtureAsset<K extends BuiltinAssetKind>(
  assets: AssetRegistry,
  guid: string,
  kind: K,
) {
  const loaded = await assets.load(guid, kind);
  return loaded.ok ? assets.read(loaded.value) : loaded;
}
