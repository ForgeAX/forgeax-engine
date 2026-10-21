import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { MeshFilter, SceneInstance } from '@forgeax/engine-render';
import { expect, it } from 'vitest';
import { publishTestAssets } from './helpers/publish-runtime-assets';
import { registerSceneComponents } from './helpers/register-scene-components';
import { testAssets } from './helpers/runtime-assets';

const MESH_A = '00d274da-e863-41d8-bafe-10b97d1468d4';
const MESH_B = '95730fd2-1111-4222-8333-444455556666';
const SCENE = 'c1111111-2222-4333-8444-555566667777';

it('resolves bare GUID source edges before spawning repeated MeshFilter references', async () => {
  const world = new World();
  registerSceneComponents(world, [MeshFilter]);
  const assets = testAssets(world);
  try {
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    publishTestAssets(assets, [
      { guid: MESH_A, kind: 'mesh', payload: mesh },
      { guid: MESH_B, kind: 'mesh', payload: mesh },
      {
        guid: SCENE,
        kind: 'scene',
        refs: [MESH_A, MESH_B],
        payload: {
          kind: 'scene',
          entities: Object.fromEntries(
            Array.from({ length: 4 }, (_, i) => [
              `mesh-${i}`,
              { components: { MeshFilter: { assetHandle: i % 2 === 0 ? MESH_A : MESH_B } } },
            ]),
          ),
        },
      },
    ]);
    const scene = (await assets.load(SCENE, 'scene')).unwrap();
    const first = (await assets.load(MESH_A, 'mesh')).unwrap(),
      second = (await assets.load(MESH_B, 'mesh')).unwrap();
    const root = assets.instantiate(scene, world).unwrap();
    const mapping = world.get(root, SceneInstance).unwrap().mapping;
    const handles = Array.from(
      mapping,
      (entity) => world.get(entity as EntityHandle, MeshFilter).unwrap().assetHandle,
    );
    expect(handles).toEqual([first, second, first, second]);
    expect(first).not.toBe(second);
    expect(assets.guidOf(first)).toBe(MESH_A);
    expect(assets.guidOf(second)).toBe(MESH_B);
  } finally {
    assets.dispose();
  }
});
