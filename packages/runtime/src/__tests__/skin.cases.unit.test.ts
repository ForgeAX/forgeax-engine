import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { expect, it } from 'vitest';

it('binds Skin beside render components to the World asset owner', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const inverseBindMatrices = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const skeleton = assets.create({ kind: 'skeleton', jointCount: 1, inverseBindMatrices }).unwrap();
  const joint = world.spawn({ component: Transform, data: {} }).unwrap();
  const mesh = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: {} },
      { component: Skin, data: { skeleton, joints: [joint] } },
    )
    .unwrap();
  expect(Skin.fields.skeleton.type).toBe('asset<skeleton>');
  expect(Skin.fields.joints.type).toBe('array<entity>');
  expect(world.get(entity, Skin).unwrap().skeleton).toBe(skeleton);
  expect([...world.get(entity, Skin).unwrap().joints]).toEqual([joint]);
  assets.release(skeleton).unwrap();
  expect(assets.read(skeleton).ok).toBe(true);
  world.despawn(entity).unwrap();
  expect(assets.read(skeleton).ok).toBe(false);
});

it('rejects unavailable and foreign Skeleton identities at the binding boundary', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const other = new AssetRegistry();
  const skeleton = other
    .create({ kind: 'skeleton', jointCount: 0, inverseBindMatrices: new Float32Array() })
    .unwrap();
  expect(world.spawn({ component: Skin, data: { skeleton, joints: [] } })).toMatchObject({
    ok: false,
    error: { code: 'asset-reference-invalid' },
  });
  expect(world.inspect().entityCount).toBe(0);
  assets.dispose();
  other.dispose();
});
