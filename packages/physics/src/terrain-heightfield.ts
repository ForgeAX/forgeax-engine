import { Disabled, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import {
  Terrain,
  terrainHeightfield,
  terrainTranslationValid,
  validateTerrain,
} from '@forgeax/engine-terrain';
import type { Asset, TerrainError } from '@forgeax/engine-types';
import { RIGID_BODY_TYPE_STATIC, RigidBody } from './components.js';
import type { PhysicsWorld } from './physics-world.js';

/** Called inside the existing 3D sync phase, after bodies exist and before the fixed step. */
export function syncTerrainHeightfields(
  world: World,
  physics: PhysicsWorld,
  committedEntities: Iterable<number>,
): void {
  const poseRegistered =
    world.components.resolve('Transform') !== undefined &&
    world.components.resolve('GlobalTransform') !== undefined;
  const terrainRegistered = world.components.resolve('Terrain') !== undefined;
  const prepare = physics.prepareDerivedShapeCandidate?.bind(physics),
    admit = physics.admitDerivedShapeCandidate?.bind(physics),
    publication = physics.getDerivedPublication?.bind(physics);
  if (prepare === undefined || admit === undefined || publication === undefined)
    throw {
      code: 'terrain-query-unavailable',
      expected: 'a 3D PhysicsWorld with derived heightfield admission',
      hint: 'enable the 3D physics backend',
      detail: { field: 'PhysicsWorld' },
    } satisfies TerrainError;
  // A component removal is a real collider replacement, not just a query omission.
  for (const entity of committedEntities) {
    const committed = publication(entity);
    const sourceKey = committed?.shapeIds.find((id) => id.startsWith('terrain:'));
    if (
      sourceKey !== undefined &&
      committed !== undefined &&
      (!terrainRegistered ||
        !poseRegistered ||
        !world.hasComponent(entity as EntityHandle, Transform) ||
        !world.hasComponent(entity as EntityHandle, GlobalTransform) ||
        !world.hasComponent(entity as EntityHandle, Terrain) ||
        !world.hasComponent(entity as EntityHandle, RigidBody) ||
        world.hasComponent(entity as EntityHandle, Disabled))
    ) {
      const candidate = prepare({
        entity,
        sourceKey,
        revision: committed.revision + 1,
        bodyType: 'static',
        shapes: [],
      }).unwrap();
      admit(candidate).unwrap();
    }
  }
  if (!terrainRegistered || !poseRegistered) return;
  const query = world.query({ read: [Terrain, RigidBody, Transform, GlobalTransform] }).unwrap();
  for (const row of query) {
    const component = row.get(Terrain),
      body = row.get(RigidBody);
    const fail = (field: string, expected: string): never => {
      throw {
        code: 'terrain-pose-unsupported',
        expected,
        hint: 'use a fixed Terrain with a static RigidBody and supported pose',
        detail: { field },
      } satisfies TerrainError;
    };
    if (body.type !== RIGID_BODY_TYPE_STATIC) fail('RigidBody', 'static terrain physics');
    const matrix = row.get(GlobalTransform).world;
    const sourceKey = `terrain:${Number(component.asset)}`;
    const asset = world.sharedRefs.resolve<'TerrainAsset', Asset>(component.asset).unwrap();
    if (asset.kind !== 'terrain') fail('asset', 'a loaded TerrainAsset');
    if (asset.kind !== 'terrain') continue;
    if (!terrainTranslationValid(asset, matrix))
      fail(
        'Transform',
        'finite GPU world bounds, translation with exact identity rotation and unit scale',
      );
    if (publication(row.entity)?.shapeIds.includes(sourceKey)) continue;
    validateTerrain(asset).unwrap();
    const shape = terrainHeightfield(asset),
      revision = (publication(row.entity)?.revision ?? 0) + 1;
    const candidate = prepare({
      entity: row.entity,
      sourceKey,
      revision,
      bodyType: 'static',
      shapes: [
        {
          kind: 'heightfield',
          id: sourceKey,
          revision,
          rows: shape.rows,
          columns: shape.columns,
          heights: shape.heights,
          scale: shape.scale,
          origin: shape.origin,
        },
      ],
    }).unwrap();
    admit(candidate).unwrap();
  }
}
