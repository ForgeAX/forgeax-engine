import { Time, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { Terrain, terrainHeight } from '@forgeax/engine-terrain';
import type { TerrainAsset } from '@forgeax/engine-types';

/** A real terrain-dependent gameplay writer; readiness gates movement, not the frame clock. */
export function installTerrainWalker(
  world: World,
  subjects: { terrain: EntityHandle; walker: EntityHandle },
  gate: { blocked: boolean },
) {
  const token = world.scheduleToken('Update'),
    name = 'terrain-walker';
  world
    .addSystem(token, {
      name,
      queries: [],
      fn() {
        const intent = world.getResource<{ speed: number; updates: number }>('TerrainWalker');
        if (gate.blocked || intent.speed === 0) return;
        const component = world.get(subjects.terrain, Terrain).unwrap();
        const root = world.sharedRefs
          .resolve<'TerrainAsset', TerrainAsset>(component.asset)
          .unwrap();
        const origin = world.get(subjects.terrain, GlobalTransform).unwrap().world;
        const pos = world.get(subjects.walker, Transform).unwrap().pos;
        const x = Math.max(
          2,
          Math.min(
            (root.columns - 1) * root.spacing - 2,
            (pos[0] ?? 0) - (origin[12] ?? 0) + intent.speed * world.getResource(Time).delta,
          ),
        );
        const z = (pos[2] ?? 0) - (origin[14] ?? 0),
          height = terrainHeight(root, x, z);
        if (height === undefined) return;
        world
          .set(subjects.walker, Transform, {
            pos: [x + (origin[12] ?? 0), height + (origin[13] ?? 0) + 1, z + (origin[14] ?? 0)],
          })
          .unwrap();
        intent.updates++;
      },
    })
    .unwrap();
  return () => {
    world.removeSystem(token, name).unwrap();
  };
}
