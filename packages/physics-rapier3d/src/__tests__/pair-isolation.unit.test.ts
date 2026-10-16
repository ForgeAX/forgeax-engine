import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  CharacterController,
  Collider,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { createRapier3DPhysicsWorld, loadRapier3D } from '@forgeax/engine-physics-rapier3d';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { unpackSlot } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import type { RigidBody as NativeBody, World as NativeWorld } from '../../pkg/rapier.mjs';

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}

async function fixture(sensor = false) {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const definitions = [
    { pos: [0.8, 0.5, 0], type: RigidBodyTypeValue.kinematic, half: [0.5, 0.5, 0.5], sensor },
    { pos: [0, 0.5, 0], type: RigidBodyTypeValue.dynamic, half: [0.5, 0.5, 0.5] },
    { pos: [0, -0.25, 0], type: RigidBodyTypeValue.static, half: [5, 0.25, 5] },
    { pos: [0, 0.5, 0.8], type: RigidBodyTypeValue.static, half: [0.5, 0.5, 0.5] },
    { pos: [-0.8, 0.5, 0], type: RigidBodyTypeValue.kinematic, half: [0.5, 0.5, 0.5] },
  ];
  const entities = definitions.map((d) =>
    world
      .spawn(
        { component: Transform, data: { pos: d.pos } },
        { component: RigidBody, data: { type: d.type, gravityScale: 0 } },
        {
          component: Collider,
          data: { halfExtents: d.half, isSensor: d.sensor ?? false, collisionGroups: 0x0001ffff },
        },
      )
      .unwrap(),
  );
  const physics = createRapier3DPhysicsWorld(rapier);
  physics.setGravity(vec3.create(0, 0, 0));
  physics._syncFromEcs(world, Transform, GlobalTransform);
  const raw = physics.raw as NativeWorld;
  const body = (index: number): NativeBody => {
    let found: NativeBody | undefined;
    raw.forEachRigidBody((b) => {
      if (b.userData === entities[index]) found = b;
    });
    if (found === undefined) throw new Error('missing native body');
    return found;
  };
  const reset = () => {
    definitions.forEach((d, i) => {
      const b = body(i);
      b.setTranslation({ x: d.pos[0] ?? 0, y: d.pos[1] ?? 0, z: d.pos[2] ?? 0 }, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    });
    raw.propagateModifiedBodyPositionsToColliders();
  };
  const contact = (a: number, b: number) => {
    let points = 0,
      solver = 0;
    for (let i = 0; i < body(a).numColliders(); i++)
      for (let j = 0; j < body(b).numColliders(); j++) {
        raw.contactPair(body(a).collider(i), body(b).collider(j), (m) => {
          points += m.numContacts();
          solver += m.numSolverContacts();
        });
      }
    return {
      points,
      solver,
      intersection: raw.intersectionPair(body(a).collider(0), body(b).collider(0)),
    };
  };
  const sample = () => {
    reset();
    physics.step(1 / 60);
    return contact(0, 1);
  };
  const acquire = (reverse = false) =>
    physics
      .acquirePairIsolation({
        worldIdentity: world,
        entityA: defined(entities[reverse ? 1 : 0]),
        entityB: defined(entities[reverse ? 0 : 1]),
      })
      .unwrap();
  return {
    entity: (index: number) => defined(entities[index]),
    world,
    physics,
    raw,
    rapier,
    body,
    entities,
    definitions,
    reset,
    contact,
    sample,
    acquire,
  };
}

describe('real Rapier exact pair isolation', () => {
  it('uses native defaults without leases and restores JavaScript filters only for active isolation', async () => {
    const f = await fixture();
    const step = vi.spyOn(f.raw, 'step');
    try {
      expect(f.sample().solver).toBeGreaterThan(0);
      expect(step.mock.calls.at(-1)?.[1]).toBeUndefined();
      const lease = f.acquire();
      expect(f.sample().points).toBe(0);
      expect(step.mock.calls.at(-1)?.[1]).toMatchObject({
        filterContactPair: expect.any(Function),
        filterIntersectionPair: expect.any(Function),
      });
      lease.release().unwrap();
      expect(f.sample().solver).toBeGreaterThan(0);
      expect(step.mock.calls.at(-1)?.[1]).toBeUndefined();
    } finally {
      step.mockRestore();
      f.physics.dispose();
    }
  });
  it.each([
    false,
    true,
  ])('preserves other contacts through either release order (reverse=%s)', async (reverse) => {
    const f = await fixture();
    try {
      expect(f.sample().solver).toBeGreaterThan(0);
      const first = f.acquire(),
        second = f.acquire(true);
      f.physics.setKinematicPosition(f.entity(0), { x: 0.8, y: 0.5, z: 0 });
      expect(f.sample().points).toBe(0);
      for (const other of [2, 3, 4]) expect(f.contact(1, other).solver).toBeGreaterThan(0);
      (reverse ? second : first).release().unwrap();
      expect(f.sample().points).toBe(0);
      (reverse ? first : second).release().unwrap();
      first.release().unwrap();
      second.release().unwrap();
      expect(f.sample().solver).toBeGreaterThan(0);
      expect(f.body(1).collider(0).collisionGroups()).toBe(0x0001ffff);
    } finally {
      f.physics.dispose();
    }
  });
  it('filters warm sensor intersections and restores a sleeping body without pose resets', async () => {
    const f = await fixture(true);
    try {
      expect(f.sample().intersection).toBe(true);
      f.body(1).sleep();
      expect(f.body(1).isSleeping()).toBe(true);
      const lease = f.acquire();
      f.physics.step(1 / 60);
      expect(f.contact(0, 1).intersection).toBe(false);
      f.body(1).sleep();
      lease.release().unwrap();
      f.physics.step(1 / 60);
      expect(f.contact(0, 1).intersection).toBe(true);
    } finally {
      f.physics.dispose();
    }
  });

  it('refreshes warm sleeping solid contact policy without moving the bodies manually', async () => {
    const f = await fixture();
    try {
      expect(f.sample().solver).toBeGreaterThan(0);
      f.body(1).sleep();
      const lease = f.acquire();
      f.physics.step(1 / 60);
      expect(f.contact(0, 1).points).toBe(0);
      f.body(1).sleep();
      lease.release().unwrap();
      f.physics.step(1 / 60);
      expect(f.contact(0, 1).solver).toBeGreaterThan(0);
    } finally {
      f.physics.dispose();
    }
  });

  it('KCC ignores the held wall while keeping the second wall and the ground', async () => {
    const f = await fixture();
    try {
      const player = f.entity(0);
      f.world
        .addComponent(player, {
          component: CharacterController,
          data: { autoStepMaxHeight: 0, snapToGroundDist: 0 },
        })
        .unwrap();
      f.physics.setMoveContext(f.world, Transform);
      for (const [index, x] of [
        [0, 0],
        [1, 1.5],
        [3, 3.5],
        [4, -10],
      ] as const) {
        f.body(index).setTranslation({ x, y: 0.5, z: 0 }, true);
        f.body(index).setNextKinematicTranslation({ x, y: 0.5, z: 0 });
      }
      f.raw.propagateModifiedBodyPositionsToColliders();
      f.physics.step(1 / 60);
      const baseline = defined(f.physics.moveAndSlide(player, vec3.create(5, 0, 0))[0]);
      f.body(0).setTranslation({ x: 0, y: 0.5, z: 0 }, true);
      f.body(0).setNextKinematicTranslation({ x: 0, y: 0.5, z: 0 });
      f.raw.propagateModifiedBodyPositionsToColliders();
      const lease = f.acquire();
      const isolated = defined(f.physics.moveAndSlide(player, vec3.create(5, 0, 0))[0]);
      expect(baseline).toBeLessThan(1);
      expect(isolated).toBeGreaterThan(2);
      expect(isolated).toBeLessThan(3);
      lease.release().unwrap();
    } finally {
      f.physics.dispose();
    }
  });

  it('covers derived multi-collider replacements and sensors on the same body incarnation', async () => {
    const f = await fixture();
    try {
      const lease = f.acquire();
      const replace = (revision: number) => {
        const candidate = f.physics
          .prepareDerivedShapeCandidate({
            entity: f.entity(1),
            worldIdentity: f.world,
            sourceKey: 'held',
            revision,
            shapes: [0, 1].map((index) => ({
              id: `shape-${index}`,
              revision,
              kind: 'convex-compound' as const,
              pieces: [boxPoints([0, 0, 0], [1, 1, 1])],
              origin: [0, 0, index * 0.1] as const,
              isSensor: index === 1,
            })),
          })
          .unwrap();
        f.physics.admitDerivedShapeCandidate(candidate).unwrap();
      };
      replace(1);
      f.sample();
      expect(f.body(1).numColliders()).toBeGreaterThan(1);
      expect(f.contact(0, 1).points).toBe(0);
      for (let index = 0; index < f.body(1).numColliders(); index++) {
        expect(f.raw.intersectionPair(f.body(0).collider(0), f.body(1).collider(index))).toBe(
          false,
        );
      }
      replace(2);
      expect(f.sample().points).toBe(0);
      lease.release().unwrap();
      expect(f.sample().solver).toBeGreaterThan(0);
      const sensors = Array.from({ length: f.body(1).numColliders() }, (_, i) =>
        f.body(1).collider(i),
      ).filter((c) => c.isSensor());
      expect(sensors.some((c) => f.raw.intersectionPair(f.body(0).collider(0), c))).toBe(true);
    } finally {
      f.physics.dispose();
    }
  });

  it('rejects wrong Worlds, invalid generations, absent and disabled bodies without changing isolation', async () => {
    const f = await fixture();
    try {
      const input = { worldIdentity: f.world, entityA: f.entity(0), entityB: f.entity(1) };
      const lease = f.acquire();
      expect(
        f.physics.acquirePairIsolation({ ...input, worldIdentity: new World() }),
      ).toMatchObject({ ok: false, error: { code: 'pair-isolation-world-mismatch' } });
      for (const entityA of [
        -1,
        NaN,
        0.5,
        2 ** 32 + input.entityA,
        Number.MAX_SAFE_INTEGER,
        input.entityB,
      ]) {
        expect(f.physics.acquirePairIsolation({ ...input, entityA })).toMatchObject({
          ok: false,
          error: { code: 'pair-isolation-entity-invalid' },
        });
      }
      const missing = f.world.spawn().unwrap();
      expect(f.physics.acquirePairIsolation({ ...input, entityA: missing })).toMatchObject({
        ok: false,
        error: { code: 'pair-isolation-body-unavailable' },
      });
      f.body(1).setEnabled(false);
      expect(f.physics.acquirePairIsolation(input)).toMatchObject({
        ok: false,
        error: { code: 'pair-isolation-body-unavailable' },
      });
      f.body(1).setEnabled(true);
      expect(f.sample().points).toBe(0);
      lease.release().unwrap();
      expect(f.sample().solver).toBeGreaterThan(0);
    } finally {
      f.physics.dispose();
    }
  });

  it('retired leases cannot release a rebuilt body or a reused entity index', async () => {
    const f = await fixture();
    try {
      const old = f.acquire();
      const oldHandle = f.body(1).handle;
      f.physics.removeEntity(f.entity(1));
      f.physics.clearEcsContext(f.world);
      f.physics._syncFromEcs(f.world, Transform, GlobalTransform);
      const fresh = f.acquire();
      old.release().unwrap();
      expect(f.sample().points).toBe(0);
      // Native handles are generation-bearing floats; the allocator reuses the slot.
      const nativeSlot = (handle: number) => {
        const bytes = new DataView(new ArrayBuffer(8));
        bytes.setFloat64(0, handle, true);
        return bytes.getUint32(0, true);
      };
      expect(nativeSlot(f.body(1).handle)).toBe(nativeSlot(oldHandle));
      expect(f.body(1).handle).not.toBe(oldHandle);
      fresh.release().unwrap();
      const staleEntity = f.entity(1);
      const stale = f.acquire();
      f.world.despawn(staleEntity).unwrap();
      f.physics._syncFromEcs(f.world, Transform, GlobalTransform);
      const replacement = f.world
        .spawn(
          { component: Transform, data: { pos: [0, 0.5, 0] } },
          { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, gravityScale: 0 } },
          { component: Collider, data: { halfExtents: [0.5, 0.5, 0.5] } },
        )
        .unwrap();
      expect(unpackSlot(replacement)).toBe(unpackSlot(staleEntity));
      expect(replacement).not.toBe(staleEntity);
      f.entities[1] = replacement;
      f.physics._syncFromEcs(f.world, Transform, GlobalTransform);
      expect(
        f.physics.acquirePairIsolation({
          worldIdentity: f.world,
          entityA: f.entity(0),
          entityB: staleEntity,
        }),
      ).toMatchObject({ ok: false, error: { code: 'pair-isolation-entity-invalid' } });
      const current = f.acquire();
      stale.release().unwrap();
      expect(f.sample().points).toBe(0);
      current.release().unwrap();
      expect(f.sample().solver).toBeGreaterThan(0);
    } finally {
      f.physics.dispose();
    }
  });

  it('bounds duplicate leases at 512 and recovers every slot after release and detach', async () => {
    const f = await fixture();
    try {
      const leases = Array.from({ length: 512 }, (_, i) => f.acquire(i % 2 === 0));
      expect(
        f.physics.acquirePairIsolation({
          worldIdentity: f.world,
          entityA: f.entity(0),
          entityB: f.entity(1),
        }),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'pair-isolation-budget-exceeded',
          detail: { reason: 'leases', used: 512, limit: 512 },
        },
      });
      expect(f.sample().points).toBe(0);
      for (const lease of leases) lease.release().unwrap();
      expect(f.sample().solver).toBeGreaterThan(0);
      const old = Array.from({ length: 512 }, () => f.acquire());
      f.physics.clearEcsContext(f.world);
      f.physics.setMoveContext(f.world, Transform);
      const fresh = f.acquire();
      for (const lease of old) lease.release().unwrap();
      expect(f.sample().points).toBe(0);
      fresh.release().unwrap();
      expect(f.sample().solver).toBeGreaterThan(0);
    } finally {
      f.physics.dispose();
    }
  });

  it('dispose invalidates outstanding leases and refuses subsequent acquire', async () => {
    const f = await fixture();
    const lease = f.acquire();
    f.physics.dispose();
    lease.release().unwrap();
    lease.release().unwrap();
    expect(
      f.physics.acquirePairIsolation({
        worldIdentity: f.world,
        entityA: f.entity(0),
        entityB: f.entity(1),
      }),
    ).toMatchObject({ ok: false, error: { code: 'pair-isolation-backend-unavailable' } });
  });

  it('bounds distinct pairs at 128 and rejects pair 129 without disturbing native policy', async () => {
    const f = await fixture();
    try {
      const others = Array.from({ length: 128 }, (_, index) =>
        f.world
          .spawn(
            { component: Transform, data: { pos: [20 + index * 3, 0, 0] } },
            { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
            { component: Collider, data: {} },
          )
          .unwrap(),
      );
      f.physics._syncFromEcs(f.world, Transform, GlobalTransform);
      const leases = [
        f.acquire(),
        ...others
          .slice(0, 127)
          .map((entityB) =>
            f.physics
              .acquirePairIsolation({ worldIdentity: f.world, entityA: f.entity(0), entityB })
              .unwrap(),
          ),
      ];
      expect(
        f.physics.acquirePairIsolation({
          worldIdentity: f.world,
          entityA: f.entity(0),
          entityB: defined(others[127]),
        }),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'pair-isolation-budget-exceeded',
          detail: { reason: 'pairs', used: 128, limit: 128 },
        },
      });
      expect(f.sample().points).toBe(0);
      for (const lease of leases) lease.release().unwrap();
      expect(f.sample().solver).toBeGreaterThan(0);
      const next = f.acquire();
      expect(f.sample().points).toBe(0);
      next.release().unwrap();
    } finally {
      f.physics.dispose();
    }
  });

  it('refuses lease mutations inside native step and the paired geometry callback', async () => {
    const f = await fixture();
    try {
      const lease = f.acquire();
      const input = { worldIdentity: f.world, entityA: f.entity(0), entityB: f.entity(1) };
      const checkBusy = () => {
        expect(f.physics.acquirePairIsolation(input)).toMatchObject({
          ok: false,
          error: { code: 'pair-isolation-busy' },
        });
        expect(lease.release()).toMatchObject({
          ok: false,
          error: { code: 'pair-isolation-busy' },
        });
      };
      const originalStep = f.raw.step.bind(f.raw);
      f.raw.step = (...args) => {
        checkBusy();
        originalStep(...args);
      };
      expect(f.sample().points).toBe(0);
      f.raw.step = originalStep;
      const candidate = f.physics
        .prepareDerivedShapeCandidate({
          entity: f.entity(1),
          sourceKey: 'held',
          revision: 1,
          worldIdentity: f.world,
          shapes: [
            {
              kind: 'convex-compound',
              id: 'shape',
              revision: 1,
              pieces: [boxPoints([0, 0, 0], [1, 1, 1])],
            },
          ],
        })
        .unwrap();
      f.physics
        .admitDerivedShapeCandidate(candidate, () => {
          checkBusy();
          return f.world.set(f.entity(1), Transform, { pos: [0, 0.5, 0] });
        })
        .unwrap();
      expect(f.sample().points).toBe(0);
      lease.release().unwrap();
      expect(f.sample().solver).toBeGreaterThan(0);
    } finally {
      f.physics.dispose();
    }
  });

  it('a partially failed native cache refresh requires rebuild instead of ordinary rejection', async () => {
    const f = await fixture();
    try {
      expect(f.sample().solver).toBeGreaterThan(0);
      const lease = f.acquire();
      const collider = f.body(1).collider(0);
      const original = collider.setTranslation.bind(collider);
      collider.setTranslation = (position) => {
        original(position);
        throw new Error('failure after real native collider mutation');
      };
      expect(() => f.physics.step(1 / 60)).toThrow('derived-backend-failed');
      expect(f.physics.getDerivedRecoveryState()).toBe('rebuild-required');
      expect(
        f.physics.acquirePairIsolation({
          worldIdentity: f.world,
          entityA: f.entity(0),
          entityB: f.entity(1),
        }),
      ).toMatchObject({ ok: false, error: { code: 'pair-isolation-backend-unavailable' } });
      lease.release().unwrap();
      collider.setTranslation = original;
    } finally {
      f.physics.dispose();
    }
  });

  it('World replacement retires leases and refuses old bodies with colliding entity numbers', async () => {
    const f = await fixture();
    try {
      const old = f.acquire();
      const other = new World();
      other.components.register(Transform).unwrap();
      other.components.register(GlobalTransform).unwrap();
      registerPhysicsComponents(other);
      const a = other.spawn().unwrap(),
        b = other.spawn().unwrap();
      expect(a).toBe(f.entities[0]);
      expect(b).toBe(f.entities[1]);
      f.physics.setMoveContext(other, Transform);
      expect(
        f.physics.acquirePairIsolation({ worldIdentity: other, entityA: a, entityB: b }),
      ).toMatchObject({ ok: false, error: { code: 'pair-isolation-body-unavailable' } });
      old.release().unwrap();
      f.physics.setMoveContext(f.world, Transform);
      const current = f.acquire();
      old.release().unwrap();
      expect(f.sample().points).toBe(0);
      current.release().unwrap();
      expect(f.sample().solver).toBeGreaterThan(0);
    } finally {
      f.physics.dispose();
    }
  });

  it('authored collider replacement retains isolation and final release preserves the latest groups', async () => {
    const f = await fixture();
    try {
      const lease = f.acquire();
      expect(f.sample().points).toBe(0);
      const originalHandle = f.body(1).collider(0).handle;
      f.world.set(f.entity(1), Collider, { halfExtents: [0.6, 0.5, 0.5] }).unwrap();
      f.physics._syncFromEcs(f.world, Transform, GlobalTransform);
      expect(f.body(1).collider(0).handle).not.toBe(originalHandle);
      expect(f.sample().points).toBe(0);
      expect(f.contact(1, 2).solver).toBeGreaterThan(0);
      f.world.set(f.entity(1), Collider, { collisionGroups: 0 }).unwrap();
      f.physics._syncFromEcs(f.world, Transform, GlobalTransform);
      lease.release().unwrap();
      expect(f.sample().points).toBe(0);
      expect(f.body(1).collider(0).collisionGroups()).toBe(0);
      f.world.set(f.entity(1), Collider, { collisionGroups: 0x0001ffff }).unwrap();
      f.physics._syncFromEcs(f.world, Transform, GlobalTransform);
      expect(f.sample().solver).toBeGreaterThan(0);
    } finally {
      f.physics.dispose();
    }
  });
});

it('checks native adjacency instead of a compound collider Cartesian product', async () => {
  const f = await fixture();
  try {
    for (const index of [0, 4]) {
      const candidate = f.physics
        .prepareDerivedShapeCandidate({
          entity: f.entity(index),
          sourceKey: `adjacency-${index}`,
          revision: 1,
          bodyType: 'kinematic',
          shapes: Array.from({ length: 32 }, (_, part) => ({
            id: `part-${part}`,
            revision: 1,
            kind: 'convex-compound' as const,
            pieces: [boxPoints([0, 0, 0], [0.1, 0.1, 0.1])],
            origin: [0, 0, (index === 0 ? 1 : -1) * (100 + part)] as const,
          })),
        })
        .unwrap();
      f.physics.admitDerivedShapeCandidate(candidate).unwrap();
    }
    f.sample();
    expect(f.body(0).numColliders()).toBe(33);
    expect(f.body(4).numColliders()).toBe(33);
    const contact = vi.spyOn(f.raw, 'contactPair');
    const owner = f.physics as unknown as { bodiesShareCollision(a: number, b: number): boolean };
    expect(owner.bodiesShareCollision(f.entity(0), f.entity(4))).toBe(false);
    expect(contact).not.toHaveBeenCalled();
  } finally {
    f.physics.dispose();
  }
});
