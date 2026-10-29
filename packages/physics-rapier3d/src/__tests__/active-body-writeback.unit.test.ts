import { Disabled, defineComponent, FixedUpdate, World } from '@forgeax/engine-ecs';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
import { PhysicsWriteback, registerPhysicsSystems } from '../physics-sync.js';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d';
import { loadRapier3D } from '../wasm-loader';

const SETTLE_TICKS = 180;

async function loadOrSkip() {
  const RAPIER = await loadRapier3D();
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
  const value = world.get(entity as never, Transform as never).unwrap() as unknown as {
    pos: ArrayLike<number>;
  };
  return Array.from(value.pos);
}

function countTransformWrites(world: World) {
  const query = world.query({ read: [Transform], changed: [Transform] }).unwrap();
  for (const _row of query) {
    /* consume earlier publications */
  }
  let count = 0;
  world
    .addSystem(FixedUpdate, {
      name: 'observe-writeback-publications',
      queries: [],
      after: [PhysicsWriteback.name],
      fn: () => {
        for (const _row of query) count++;
      },
    })
    .unwrap();
  return {
    stop: () => {
      world.removeSystem(FixedUpdate, 'observe-writeback-publications').unwrap();
      return count;
    },
  };
}

describe('active-body physics writeback', () => {
  it('keeps exact poses across table growth, disabled rows and recycled entity slots', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) throw new Error('Real Rapier is required for the writeback regression');
    const world = prepareWorld();
    const physics = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', physics);
    registerPhysicsSystems(world);
    const body = world
      .spawn({ component: Transform, data: { scale: [2, 3, 4], shear: [0.1, 0.2, 0.3] } })
      .unwrap();
    const pose = {
      entity: body,
      pos: { x: 0.1, y: 2, z: 3 },
      rotation: { x: 0, y: Math.sin(0.2), z: 0, w: Math.cos(0.2) },
    };
    const rows = vi.spyOn(physics, 'writebackDynamicBodies').mockReturnValue([pose]);
    const Marker = defineComponent('WritebackMovedTable', {});
    const lease = world.components.register(Marker).unwrap();
    try {
      tick(world);
      const initial = world.get(body, Transform).unwrap();
      const originalShear = Array.from(initial.shear);
      expect(Array.from(initial.pos)).toEqual([Math.fround(0.1), 2, 3]);
      expect(Array.from(initial.quat)).toEqual([
        0,
        Math.fround(Math.sin(0.2)),
        0,
        Math.fround(Math.cos(0.2)),
      ]);
      const unchanged = world.query({ changed: [Transform] }).unwrap();
      expect([...unchanged].map((row) => row.entity)).toEqual([body]);
      tick(world);
      expect([...unchanged]).toHaveLength(0);
      for (let i = 0; i < 1024; i++) world.spawn({ component: Transform, data: {} }).unwrap();
      pose.pos.y = 4;
      tick(world);
      expect(transformPos(world, body)).toEqual([Math.fround(0.1), 4, 3]);
      world.addComponent(body, { component: Marker, data: {} }).unwrap();
      pose.pos.y = 5;
      tick(world);
      expect(transformPos(world, body)[1]).toBe(5);
      world.addComponent(body, { component: Disabled, data: {} }).unwrap();
      pose.pos.y = 6;
      tick(world);
      expect(transformPos(world, body)[1]).toBe(6);
      expect(Array.from(world.get(body, Transform).unwrap().scale)).toEqual([2, 3, 4]);
      expect(Array.from(world.get(body, Transform).unwrap().shear)).toEqual(originalShear);
      world.removeComponent(body, Disabled).unwrap();
      pose.pos.y = 7;
      tick(world);
      expect(transformPos(world, body)[1]).toBe(7);
      world.despawn(body).unwrap();
      const replacement = world
        .spawn({ component: Transform, data: { pos: [20, 30, 40] } })
        .unwrap();
      expect(replacement).not.toBe(body);
      tick(world);
      expect(transformPos(world, replacement)).toEqual([20, 30, 40]);
    } finally {
      rows.mockRestore();
      physics.dispose();
      lease.dispose();
    }
  });

  it('publishes moving poses through one ECS numeric write without per-body set calls', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) throw new Error('Real Rapier is required for the writeback regression');
    const world = prepareWorld();
    const physics = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', physics);
    registerPhysicsSystems(world);
    const body = spawnDynamic(world, [0, 50, 0], 1);
    try {
      tick(world);
      const writes = countTransformWrites(world);
      const set = vi.spyOn(world, 'set');
      try {
        tick(world, 3);
        expect(writes.stop()).toBe(3);
        expect(transformPos(world, body)[1]).toBeLessThan(50);
        expect(set.mock.calls.filter((call) => call[1] === Transform)).toHaveLength(0);
      } finally {
        set.mockRestore();
      }
    } finally {
      physics.dispose();
    }
  });

  it('compares native poses without decoding an entire Transform component', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) throw new Error('Real Rapier is required for the writeback regression');
    const world = prepareWorld();
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    registerPhysicsSystems(world);
    const entity = spawnDynamic(world, [0, 50, 0], 1);
    try {
      tick(world);
      let decodedTransforms = 0;
      world.removeSystem(FixedUpdate, PhysicsWriteback.name).unwrap();
      world
        .addSystem(FixedUpdate, {
          ...PhysicsWriteback,
          fn: (world, ...args) => {
            const get = vi.spyOn(world, 'get');
            try {
              return PhysicsWriteback.fn(world, ...args);
            } finally {
              decodedTransforms += get.mock.calls.filter((call) => call[1] === Transform).length;
              get.mockRestore();
            }
          },
        })
        .unwrap();
      tick(world, 5);
      expect(decodedTransforms).toBe(0);
      expect(transformPos(world, entity)[1]).toBeLessThan(50);
      expect(pw.writebackDynamicBodies().find((row) => row.entity === entity)?.pos.y).toBeCloseTo(
        transformPos(world, entity)[1] as number,
        5,
      );
    } finally {
      pw.dispose();
    }
  });

  it('writes back only awake dynamic bodies, independent of the sleeping population', async () => {
    const RAPIER = await loadOrSkip();
    if (!RAPIER) return;
    const world = prepareWorld();
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    registerPhysicsSystems(world);
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
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    registerPhysicsSystems(world);
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
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    registerPhysicsSystems(world);
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
    const pw = createRapier3DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);
    registerPhysicsSystems(world);
    const sleeper = spawnDynamic(world, [3, 0, 0], 0);
    tick(world, SETTLE_TICKS);
    expect(pw.writebackDynamicBodies()).toEqual([]);

    world.set(sleeper as never, Transform as never, { pos: [50, 0, 0] }).unwrap();
    tick(world, 2);

    expect(transformPos(world, sleeper)).toEqual([3, 0, 0]);
  });
});
