import { AssetRegistry, defineAssetKind } from '@forgeax/engine-assets-runtime';
import type { AssetHandle } from '@forgeax/engine-types';
import { expectTypeOf, it } from 'vitest';

interface MyGameConfig {
  title: string;
  resolution: { width: number; height: number };
  players: number;
}

it('preserves the custom payload type through Registry creation and detached reads', async () => {
  const assets = new AssetRegistry();
  const kind = defineAssetKind<MyGameConfig, 'my-game-config'>('my-game-config');
  const handle = assets
    .create(kind, {
      title: 'Test',
      resolution: { width: 800, height: 600 },
      players: 2,
    })
    .unwrap();
  expectTypeOf(handle).toEqualTypeOf<AssetHandle<'my-game-config', MyGameConfig>>();
  expectTypeOf(assets.read(handle).unwrap()).toEqualTypeOf<MyGameConfig>();
  expectTypeOf(assets.copy(handle).unwrap()).toEqualTypeOf<typeof handle>();
  expectTypeOf(
    (await assets.load('019e2cc6-0c86-79da-aa76-b0984c86d45c', kind)).unwrap(),
  ).toEqualTypeOf<typeof handle>();
});
