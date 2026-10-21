import type {
  AnimationGraph,
  AssetRegistry,
  AudioClipAsset,
  ParticleEffectAsset,
  RuntimeAssetError,
  TilesetAsset,
} from '@forgeax/engine-assets-runtime';
import type { AssetHandle, Result } from '@forgeax/engine-types';
import { expectTypeOf, it } from 'vitest';

declare const assets: AssetRegistry;

it('loads a typed managed handle and reads its concrete payload through the runtime entry point', async () => {
  const graph = await assets.load('019ffa97-9000-7000-8000-000000000013', 'animation-graph');
  expectTypeOf(graph).toEqualTypeOf<Result<AssetHandle<'animation-graph'>, RuntimeAssetError>>();
  if (graph.ok) expectTypeOf(assets.read(graph.value).unwrap()).toEqualTypeOf<AnimationGraph>();
  expectTypeOf<AnimationGraph['kind']>().toEqualTypeOf<'animation-graph'>();
  expectTypeOf<TilesetAsset['kind']>().toEqualTypeOf<'tileset'>();
  expectTypeOf<AudioClipAsset['mediaType']>().toMatchTypeOf<`audio/${string}`>();
  expectTypeOf<ParticleEffectAsset['program']>().toMatchTypeOf<ParticleEffectAsset['program']>();
});

it('exports one runtime content owner from the root entry point', () => {
  expectTypeOf<AssetRegistry>().toHaveProperty('installDecoder');
  expectTypeOf<AssetRegistry>().toHaveProperty('load');
  expectTypeOf<AssetRegistry>().toHaveProperty('snapshot');
  expectTypeOf<AssetRegistry>().toHaveProperty('observe');
  expectTypeOf<AssetRegistry>().toHaveProperty('create');
  expectTypeOf<AssetRegistry>().toHaveProperty('update');
});
