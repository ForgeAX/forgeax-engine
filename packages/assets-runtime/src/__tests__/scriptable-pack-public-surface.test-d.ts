import type {
  AnimationGraph,
  AssetRegistry,
  AssetRegistryResolver,
  AudioClipAsset,
  ParticleEffectAsset,
  RuntimeAssetRegistry,
  TilesetAsset,
} from '@forgeax/engine-assets-runtime';
import { expectTypeOf, it } from 'vitest';

it('exports concrete loadByGuid payload types from the runtime entry point', () => {
  expectTypeOf<AssetRegistry>().toHaveProperty('loadByGuid');
  expectTypeOf<AnimationGraph['kind']>().toEqualTypeOf<'animation-graph'>();
  expectTypeOf<TilesetAsset['kind']>().toEqualTypeOf<'tileset'>();
  expectTypeOf<AudioClipAsset['mediaType']>().toMatchTypeOf<`audio/${string}`>();
  expectTypeOf<ParticleEffectAsset['program']>().toMatchTypeOf<ParticleEffectAsset['program']>();
});

it('exports the five-action runtime registry and its resolver from the root entry point', () => {
  expectTypeOf<RuntimeAssetRegistry>().toHaveProperty('installDecoder');
  expectTypeOf<RuntimeAssetRegistry>().toHaveProperty('load');
  expectTypeOf<RuntimeAssetRegistry>().toHaveProperty('snapshot');
  expectTypeOf<RuntimeAssetRegistry>().toHaveProperty('subscribe');
  expectTypeOf<AssetRegistryResolver>().toHaveProperty('lookup');
  expectTypeOf<AssetRegistryResolver>().toHaveProperty('guidOf');
});
