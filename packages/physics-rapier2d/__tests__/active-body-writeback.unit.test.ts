import type { World as EcsWorld } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
import { createRapier2DPhysicsWorld, registerPhysicsSystems2D } from '../src/rapier-physics-world-2d';
import { loadRapier2D } from '../src/wasm-loader';

const SETTLE_TICKS = 180;

async function loadOrSkip() {
  const RAPIER = await loadRapier2D();
  if ('code' in RAPIER) {
    expect(RAPIER.code).toBe('wasm-load-failed');
    return undefined;
  }
  return RAPIER;
}

function prepareWorld(): World {
  const world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  return world;
}

function tick(world: World, count = 1): void {
  for (let index = 0; index < count; index += 1) world.update(1 / 60).unwrap();
}

function spawnDynamic(world: World, pos: readonly [number, number, number], gravityScale: number) {
  return (
    world.spawn(
      { component: Transform as never, data: { pos } },
      { component: RigidBody as never, data: { type: RigidBodyTypeValue.dynamic, gravityScale } },
      {
        component: Collider as never,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.5, 0.5, 0.5] },
      },
    ) as { unwrap(): unknown }
  ).unwrap() as number;
}

function transformPos(world: World, entity: number): readonly number[] {
  const value = world.get(entity as never, Transform as never).unwrap() as unknown as { pos: ArrayLike<number> };
  return Array.from(value.pos);
}

function countTransformWrites(world: EcsWorld) {
  const spy = vi.spyOn(world, 'set');
  return {
    stop: () => {
      const count = spy.mock.calls.filter(
        (call) => (call[1] as { name?: string }).name === Transform.name,
      ).length;
      spy.mockRestore();
      return count;
    },
  };
}

describe('active-body 2D physics writeback', () => {
  it('writes back only awake dynamic bodies, independent of the sleeping population', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier2DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    registerPhysicsSystems2D(world);
    for (let index = 0; index < 64; index += 1) spawnDynamic(world, [index * 4, 0, 0], 0);
    tick(world, SETTLE_TICKS);

    const faller = spawnDynamic(world, [0, 50, 20], 1);
    tick(world);
    const writes = countTransformWrites(world);
    const results = pw.writebackDynamicBodies();
    tick(world, 3);
    const count = writes.stop();

    expect(results.map((r) => r.entity)).toEqual([faller]);
    expect(count).toBe(3);
  });

  it('does not rewrite a Transform whose dynamic body pose is unchanged', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier2DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    registerPhysicsSystems2D(world);
    const resting = spawnDynamic(world, [0, 0, 0], 0);
    tick(world, 2);

    const writes = countTransformWrites(world);
    tick(world, 5);
    expect(writes.stop()).toBe(0);
    expect(transformPos(world, resting)).toEqual([0, 0, 0]);
  });

  it('keeps a moving dynamic body writing its Transform every step', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier2DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    registerPhysicsSystems2D(world);
    const faller = spawnDynamic(world, [0, 10, 0], 1);
    tick(world, 2);

    const before = transformPos(world, faller)[1] ?? 0;
    const writes = countTransformWrites(world);
    tick(world, 4);
    expect(writes.stop()).toBe(4);
    expect(transformPos(world, faller)[1]).toBeLessThan(before);
  });

  it('restores the Rapier pose over an ECS write to a sleeping dynamic body', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier2DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    registerPhysicsSystems2D(world);
    const sleeper = spawnDynamic(world, [3, 0, 0], 0);
    tick(world, SETTLE_TICKS);
    expect(pw.writebackDynamicBodies()).toEqual([]);

    world.set(sleeper as never, Transform as never, { pos: [50, 0, 0] }).unwrap();
    tick(world, 2);

    expect(transformPos(world, sleeper)).toEqual([3, 0, 0]);
  });
});
