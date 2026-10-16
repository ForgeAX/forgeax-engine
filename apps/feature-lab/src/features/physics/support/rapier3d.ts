import { type EntityHandle, World } from '@forgeax/engine/ecs';
import { type Vec3, vec3 as v3 } from '@forgeax/engine/math';
import { registerPhysicsComponents } from '@forgeax/engine/physics';
import {
  createRapier3DPhysicsWorld,
  loadRapier3D,
  type RapierPhysicsWorld3D,
  registerPhysicsSystems,
} from '@forgeax/engine/physics-rapier3d';
import { GlobalTransform, Transform } from '@forgeax/engine/scene';

export type Vec3Tuple = [number, number, number];

type SpawnEntry = { readonly component: unknown; readonly data?: unknown };

export interface PhysicsHarness3D {
  readonly world: World;
  readonly physics: RapierPhysicsWorld3D;
  /** Advances `count` fixed physics steps (two 1/60 s updates each, as the backend tests do). */
  tick(count?: number): void;
  spawn(...components: readonly SpawnEntry[]): EntityHandle;
  pos(entity: EntityHandle): Vec3Tuple;
  dispose(): void;
}

/** A plain ECS World wired exactly like `physicsPlugin('rapier-3d')`, without an App. */
export async function createPhysicsHarness3D(): Promise<PhysicsHarness3D | string> {
  const rapier = await loadRapier3D();
  if ('code' in rapier) return `loadRapier3D failed: ${String(rapier.code)}`;
  const world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const physics = createRapier3DPhysicsWorld(rapier);
  world.insertResource('PhysicsWorld', physics);
  const unregister = registerPhysicsSystems(world);
  return {
    world,
    physics,
    tick(count = 1) {
      for (let index = 0; index < count; index += 1) {
        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();
      }
    },
    spawn(...components) {
      return world.spawn(...(components as never[])).unwrap() as EntityHandle;
    },
    pos(entity) {
      return positionOf(world, entity);
    },
    dispose() {
      unregister();
      world.removeResource('PhysicsWorld');
      physics.dispose();
    },
  };
}

export function positionOf(world: World, entity: EntityHandle): Vec3Tuple {
  const read = world.get(entity, Transform);
  if (!read.ok) return [Number.NaN, Number.NaN, Number.NaN];
  const pos = (read.value as unknown as { pos: ArrayLike<number> }).pos;
  return [pos[0] ?? Number.NaN, pos[1] ?? Number.NaN, pos[2] ?? Number.NaN];
}

export function vec3(x: number, y: number, z: number): Vec3 {
  return v3.create(x, y, z);
}
