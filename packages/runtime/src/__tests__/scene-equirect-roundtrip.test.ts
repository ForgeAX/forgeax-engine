import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { SceneInstance, Skylight } from '@forgeax/engine-render';
import type { AssetHandle, EquirectAsset } from '@forgeax/engine-types';
import { expect, expectTypeOf, it } from 'vitest';
import { publishTestAssets } from './helpers/publish-runtime-assets';
import { registerSceneComponents } from './helpers/register-scene-components';
import { testAssets } from './helpers/runtime-assets';

function equirectPod(): EquirectAsset {
  return {
    kind: 'equirect',
    width: 4,
    height: 2,
    format: 'rgba16float',
    data: new Uint8Array(64),
    colorSpace: 'linear',
  };
}
const EQUIRECT = '019e4a26-3c29-7420-af5d-20f2724a16b0';
const SCENE = 'c1111111-2222-4333-8444-555566667777';

it('loads a Scene Skylight GUID reference into the exact managed equirect handle', async () => {
  const world = new World();
  registerSceneComponents(world, [Skylight]);
  const assets = testAssets(world);
  try {
    publishTestAssets(assets, [
      { guid: EQUIRECT, kind: 'equirect', payload: equirectPod() },
      {
        guid: SCENE,
        kind: 'scene',
        refs: [EQUIRECT],
        payload: {
          kind: 'scene',
          entities: {
            sky: { components: { Skylight: { equirect: EQUIRECT, intensity: 1 } } },
          },
        },
      },
    ]);
    const scene = (await assets.load(SCENE, 'scene')).unwrap();
    const image = (await assets.load(EQUIRECT, 'equirect')).unwrap();
    const root = assets.instantiate(scene, world).unwrap();
    const member = world.get(root, SceneInstance).unwrap().mapping[0];
    if (member === undefined) throw new Error('missing Skylight entity');
    expect(world.get(member as EntityHandle, Skylight).unwrap().equirect).toBe(image);
    expect(assets.read(image).unwrap()).toEqual(equirectPod());
  } finally {
    assets.dispose();
  }
});

it('accepts a typed managed Equirect handle through the Skylight spawn path', () => {
  const world = new World();
  const assets = testAssets(world);
  try {
    const image = assets.create(equirectPod()).unwrap();
    expectTypeOf(image).toEqualTypeOf<AssetHandle<'equirect'>>();
    const entity = world.spawn({ component: Skylight, data: { equirect: image } }).unwrap();
    expect(world.get(entity, Skylight).unwrap().equirect).toBe(image);
  } finally {
    assets.dispose();
  }
});
