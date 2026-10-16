import type { App } from '@forgeax/engine-app';
import { createSphereGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { Terrain, terrainHeight } from '@forgeax/engine-terrain';
import { terrainGuid } from './identity.ts';
export async function buildTerrainWorld(
  app: Pick<App, 'assets' | 'world'>,
  rootGuid = terrainGuid,
) {
  const assets = app.assets;
  if (assets === undefined) throw new Error('terrain requires the App-owned AssetRegistry');
  const asset = (await assets.loadByGuid(rootGuid)).unwrap();
  if (asset.kind !== 'terrain') throw new Error('Terrain GUID resolved to another kind');
  const terrainHandle = app.world.sharedRefs.acquire('TerrainAsset', asset);
  const terrainResult = app.world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Terrain, data: { asset: terrainHandle, lod0Diameter: 0.35 } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
  );
  app.world.sharedRefs.release(terrainHandle).unwrap();
  const terrain = terrainResult.unwrap();
  const eye: [number, number, number] = [65, 55, 145];
  const camera = app.world
    .spawn(
      {
        component: Transform,
        data: {
          pos: eye,
          quat: quat.fromLookAt(quat.create(), eye, [62, 0, 56], [0, 1, 0]),
          scale: [1, 1, 1],
        },
      },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 3, aspect: 16 / 9, near: 0.1, far: 500 }),
          antialias: 0,
        },
      },
    )
    .unwrap();
  app.world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0.4, -0.8, -0.3],
        color: [1, 0.94, 0.84],
        intensity: 3,
        castShadow: true,
        mapSize: 1024,
      },
    })
    .unwrap();
  const mesh = app.world.sharedRefs.acquire('MeshAsset', createSphereGeometry(1, 16, 12).unwrap());
  const material = app.world.sharedRefs.acquire(
    'MaterialAsset',
    Materials.unlit([1, 0.3, 0.025, 1]),
  );
  const walkerResult = app.world.spawn(
    { component: Transform, data: { pos: [30, (terrainHeight(asset, 30, 62) ?? 0) + 1, 62] } },
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [material] } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
    { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 1 } },
  );
  app.world.sharedRefs.release(mesh).unwrap();
  app.world.sharedRefs.release(material).unwrap();
  const walker = walkerResult.unwrap();
  app.world.insertResource('TerrainWalker', { entity: walker, speed: 0, updates: 0 });
  return { terrain, camera, walker };
}
