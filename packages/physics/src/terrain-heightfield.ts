import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';

import { Disabled, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { createStateProjection } from '@forgeax/engine-ecs/projection';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { Terrain, terrainTranslationValid } from '@forgeax/engine-terrain';
import type { TerrainAsset, TerrainError } from '@forgeax/engine-types';
import { RigidBody, RigidBodyTypeValue } from './components.js';

export interface TerrainColliderOwner {
  /** Actual entity admission/rebinding; the backend owns shared asset geometry. */
  replace(entity: EntityHandle, asset: number): void;
  remove(entity: EntityHandle): void;
}

/** Lifecycle/pose work is driven only by the existing ECS mutation projection. */
export function createTerrainHeightfieldSync(
  world: World,
  owner: TerrainColliderOwner,
): () => void {
  const projection = createStateProjection(
    world,
    [Terrain, RigidBody, Transform, GlobalTransform, Disabled],
    [Terrain],
  );
  const accepted = new Map<number, EntityHandle>();
  const createQuery = () =>
    world.query({ read: [Terrain, RigidBody, Transform, GlobalTransform] }).unwrap();
  let query: ReturnType<typeof createQuery> | undefined;
  return () => {
    const registered =
      world.components.resolve('Terrain') !== undefined &&
      world.components.resolve('Transform') !== undefined &&
      world.components.resolve('GlobalTransform') !== undefined;
    if (registered && query === undefined) query = createQuery();
    const batch = projection.read();
    for (const index of batch.indices) {
      const entity = projection.entity(index);
      const previous = accepted.get(index);
      const row = entity === undefined || !registered ? undefined : query?.at(entity);
      if (previous !== undefined && (previous !== entity || row === undefined)) {
        owner.remove(previous);
        accepted.delete(index);
      }
      if (row === undefined) continue;
      const fail = (field: string, expected: string): never => {
        throw {
          code: 'terrain-pose-unsupported',
          expected,
          hint: 'use a fixed Terrain with a static RigidBody and supported pose',
          detail: { field },
        } satisfies TerrainError;
      };
      if (row.get(RigidBody).type !== RigidBodyTypeValue.static)
        fail('RigidBody', 'static terrain physics');
      const handle = row.get(Terrain).asset;
      const asset = runtimeAssets(world.assets).resolveAsset<TerrainAsset>(handle).unwrap();
      if (asset.kind !== 'terrain') fail('asset', 'a loaded TerrainAsset');
      if (!terrainTranslationValid(asset, row.get(GlobalTransform).world))
        fail('Transform', 'finite world bounds, identity rotation and unit scale');
      owner.replace(row.entity, Number(handle));
      accepted.set(index, row.entity);
    }
    batch.accept();
  };
}
