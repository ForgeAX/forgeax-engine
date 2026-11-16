import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  Collider,
  ColliderShapeValue,
  type ColliderSnapshot,
  RigidBody,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
import type { RigidBody as NativeRigidBody } from '../../pkg/rapier.mjs';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

const pose = () => ({
  position: { x: 2, y: 3, z: 4 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: { x: 2, y: 3, z: 4 },
});
const body = (type = 1) => ({
  type,
  mass: 0,
  linearDamping: 0,
  angularDamping: 0,
  gravityScale: 0,
  ccdEnabled: 0,
});
const collider = (shape: number = ColliderShapeValue.cuboid): ColliderSnapshot => ({
  shape,
  mesh: 0,
  halfExtents: [0.5, 0.25, 1],
  radius: 0.5,
  halfHeight: 0.75,
  friction: 0,
  restitution: 0,
  density: 1,
  isSensor: false,
  collisionGroups: 0x0001_0002,
  solverGroups: 0xffff_ffff,
});
async function fixture() {
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  const physics = createRapier3DPhysicsWorld(module);
  physics.setGravity(vec3.create());
  return physics;
}

describe('accepted native collider primitive snapshots', () => {
  it('projects current convex bounds without decoding unused native triangle indices', async () => {
    const physics = await fixture();
    const module = await loadRapier3D();
    if ('code' in module) throw module;
    try {
      physics.ensureBody(1, pose(), body(0), undefined);
      let nativeBody: NativeRigidBody | undefined;
      physics.raw.forEachRigidBody((candidate: NativeRigidBody) => {
        nativeBody = candidate;
      });
      const vertices = new Float32Array([
        -1, -2, -3, 1, -2, -3, -1, 2, -3, 1, 2, -3, -1, -2, 3, 1, -2, 3, -1, 2, 3, 0.75, 1.5, 2.5,
      ]);
      const descriptor = module.ColliderDesc.convexHull(vertices);
      if (descriptor === null) throw new Error('fixture requires an accepted convex hull');
      const native = physics.raw.createCollider(descriptor, nativeBody);
      const geometryReads = vi.spyOn(native, 'shape', 'get');
      const cacheClears = vi.spyOn(native, 'clearShapeCache');
      const indices = vi.spyOn(physics.raw.colliders.raw, 'coIndices');
      for (const border of [0, 0.25]) {
        const replacement =
          border === 0
            ? module.ColliderDesc.convexHull(vertices)
            : module.ColliderDesc.roundConvexHull(vertices, border);
        if (replacement === null) throw new Error('fixture requires a replacement convex hull');
        native.setShape(replacement.shape);
        const first = physics.getCommittedColliderPrimitives(1).unwrap();
        expect(first).toMatchObject({
          rawAggregateCount: 1,
          elements: [
            {
              positionM: [2, 3, 4],
              shape: {
                kind: 'box',
                representation: 'bounds',
                halfExtentsM: [1 + border, 2 + border, 3 + border],
              },
            },
          ],
        });
        if (border > 0) {
          native.setRoundRadius(0.5);
          expect(physics.getCommittedColliderPrimitives(1).unwrap().elements[0]?.shape).toEqual({
            kind: 'box',
            representation: 'bounds',
            halfExtentsM: [1.5, 2.5, 3.5],
          });
        }
        expect(first.elements[0]?.shape).toEqual({
          kind: 'box',
          representation: 'bounds',
          halfExtentsM: [1 + border, 2 + border, 3 + border],
        });
      }
      expect(geometryReads).not.toHaveBeenCalled();
      expect(cacheClears).not.toHaveBeenCalled();
      expect(indices).not.toHaveBeenCalled();
      expect(physics.getCommittedColliderPrimitives(1, 0).unwrap()).toMatchObject({
        rawAggregateCount: 1,
        elements: [],
      });
    } finally {
      vi.restoreAllMocks();
      physics.dispose();
    }
  });

  it('excludes complex surfaces before decoding native geometry and observes later primitive edits', async () => {
    const physics = await fixture();
    const module = await loadRapier3D();
    if ('code' in module) throw module;
    try {
      physics.ensureBody(1, pose(), body(0), undefined);
      let nativeBody: NativeRigidBody | undefined;
      physics.raw.forEachRigidBody((candidate: NativeRigidBody) => {
        nativeBody = candidate;
      });
      const mesh = module.ColliderDesc.trimesh(
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
        new Uint32Array([0, 1, 2]),
      );
      const native = physics.raw.createCollider(mesh, nativeBody);
      const geometryReads = vi.spyOn(native, 'shape', 'get');
      const cacheClears = vi.spyOn(native, 'clearShapeCache');
      const complex = physics.getCommittedColliderPrimitives(1).unwrap();
      expect(complex).toMatchObject({ rawAggregateCount: 0, elements: [] });
      expect(
        physics
          .intersectsCommittedBodyObb({
            entity: 1,
            generation: complex.generation,
            completedStep: complex.completedStep,
            positionM: [2, 3, 4],
            rotation: [0, 0, 0, 1],
            fullExtentsM: [2, 0, 2],
            emptyAggregateLocalBounds: { centerM: [0, 0, 0], halfExtentsM: [1, 1, 1] },
          })
          .unwrap(),
      ).toBe(true);
      expect(geometryReads).not.toHaveBeenCalled();
      expect(cacheClears).not.toHaveBeenCalled();

      native.setShape(new module.Ball(1.5));
      const first = physics.getCommittedColliderPrimitives(1).unwrap();
      expect(first).toMatchObject({
        rawAggregateCount: 1,
        elements: [{ shape: { kind: 'sphere', radiusM: 1.5 } }],
      });
      expect(geometryReads).toHaveBeenCalledTimes(1);
      expect(cacheClears).toHaveBeenCalledTimes(1);
      native.setRadius(2.5);
      expect(physics.getCommittedColliderPrimitives(1).unwrap()).toMatchObject({
        rawAggregateCount: 1,
        elements: [{ shape: { kind: 'sphere', radiusM: 2.5 } }],
      });
      expect(first.elements[0]?.shape).toEqual({ kind: 'sphere', radiusM: 1.5 });
      expect(geometryReads).toHaveBeenCalledTimes(2);
      expect(cacheClears).toHaveBeenCalledTimes(2);

      geometryReads.mockClear();
      cacheClears.mockClear();
      expect(physics.getCommittedColliderPrimitives(1, 0).unwrap()).toMatchObject({
        rawAggregateCount: 1,
        elements: [],
      });
      native.setShape(mesh.shape);
      expect(physics.getCommittedColliderPrimitives(1).unwrap()).toMatchObject({
        rawAggregateCount: 0,
        elements: [],
      });
      expect(geometryReads).not.toHaveBeenCalled();
      expect(cacheClears).not.toHaveBeenCalled();

      const compound = (count: number) =>
        module.ColliderDesc.compound(
          Array.from({ length: count }, (_, index) => new module.Ball(index + 1)),
          Array.from({ length: count }, (_, index) => ({ x: index, y: 0, z: 0 })),
          Array.from({ length: count }, () => ({ x: 0, y: 0, z: 0, w: 1 })),
        ).shape;
      native.setShape(compound(2));
      const two = physics.getCommittedColliderPrimitives(1).unwrap();
      expect(two).toMatchObject({
        rawAggregateCount: 2,
        elements: [
          { elementIndex: 0, positionM: [2, 3, 4], shape: { radiusM: 1 } },
          { elementIndex: 1, positionM: [3, 3, 4], shape: { radiusM: 2 } },
        ],
      });
      native.setShape(compound(1));
      expect(physics.getCommittedColliderPrimitives(1).unwrap()).toMatchObject({
        rawAggregateCount: 1,
        elements: [{ elementIndex: 0, shape: { radiusM: 1 } }],
      });
      expect(two.elements).toHaveLength(2);
    } finally {
      vi.restoreAllMocks();
      physics.dispose();
    }
  });

  it('identifies only live new authored bodies awaiting native synchronization as retryable', async () => {
    const physics = await fixture();
    const world = new World();
    world.components.register(Transform).unwrap();
    world.components.register(GlobalTransform).unwrap();
    registerPhysicsComponents(world);
    const spawn = () =>
      world
        .spawn(
          { component: Transform, data: {} },
          { component: RigidBody, data: {} },
          { component: Collider, data: { shape: ColliderShapeValue.sphere } },
        )
        .unwrap();
    try {
      physics._syncFromEcs(world, Transform, GlobalTransform);
      const entity = spawn();
      expect(physics.getCommittedColliderPrimitives(entity)).toMatchObject({
        ok: false,
        error: { code: 'fixed-body-missing', detail: { entity, recovery: 'await-native-sync' } },
      });
      physics._syncFromEcs(world, Transform, GlobalTransform);
      expect(physics.getCommittedColliderPrimitives(entity).ok).toBe(true);
      physics.removeEntity(entity);
      const retired = physics.getCommittedColliderPrimitives(entity);
      expect(retired).toMatchObject({ ok: false, error: { code: 'fixed-body-missing' } });
      if (!retired.ok) expect(retired.error.detail.recovery).toBeUndefined();
      world.despawn(entity).unwrap();
      const replacement = spawn();
      expect(replacement).not.toBe(entity);
      const oldGeneration = physics.getCommittedColliderPrimitives(entity);
      if (oldGeneration.ok) throw new Error('A retired entity generation cannot be accepted');
      expect(oldGeneration.error.detail.recovery).toBeUndefined();
      expect(physics.getCommittedColliderPrimitives(replacement)).toMatchObject({
        ok: false,
        error: { detail: { recovery: 'await-native-sync' } },
      });
      world.despawn(replacement).unwrap();
      const aborted = physics.getCommittedColliderPrimitives(replacement);
      if (aborted.ok) throw new Error('An aborted authored body cannot be accepted');
      expect(aborted.error.detail.recovery).toBeUndefined();
      const missingPose = world.spawn({ component: RigidBody, data: {} }).unwrap();
      const malformed = physics.getCommittedColliderPrimitives(missingPose);
      if (malformed.ok) throw new Error('An unsynchronizable authored body cannot be accepted');
      expect(malformed.error.detail.recovery).toBeUndefined();
    } finally {
      physics.dispose();
    }
  });

  it('marks explicit pose discontinuities without changing native identity or ordinary integration', async () => {
    const physics = await fixture();
    try {
      physics.ensureBody(1, pose(), body(), collider());
      const initial = physics.getCommittedColliderPrimitives(1).unwrap();
      expect(initial).toMatchObject({ motionDiscontinuity: 0 });
      physics
        .setBodyMotion(1, {
          position: [2, 3, 4],
          rotation: [0, 0, 0, 1],
          linearVelocity: [6, 0, 0],
          angularVelocity: [0, 0.5, 0],
        })
        .unwrap();
      const launch = physics.getCommittedColliderPrimitives(1).unwrap();
      expect(launch).toMatchObject({ generation: initial.generation, motionDiscontinuity: 1 });
      for (let step = 0; step < 4; step++) physics.step(1 / 60);
      const sailed = physics.getCommittedColliderPrimitives(1).unwrap();
      expect(sailed).toMatchObject({ generation: initial.generation, motionDiscontinuity: 1 });
      expect(sailed.positionM[0]).toBeCloseTo(2.4, 5);
      expect(sailed.rotation[1]).toBeGreaterThan(0);
      physics.teleport(1, vec3.create(20, 3, -6));
      const teleported = physics.getCommittedColliderPrimitives(1).unwrap();
      expect(teleported).toMatchObject({ generation: initial.generation, motionDiscontinuity: 2 });
      expect(teleported.elements[0]?.colliderId).toBe(initial.elements[0]?.colliderId);
      expect(initial).toMatchObject({ motionDiscontinuity: 0, positionM: [2, 3, 4] });
      expect(
        physics.setBodyMotion(1, {
          position: [Number.NaN, 0, 0],
          rotation: [0, 0, 0, 1],
          linearVelocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
        }),
      ).toMatchObject({ ok: false });
      expect(physics.getCommittedColliderPrimitives(1).unwrap()).toMatchObject({
        motionDiscontinuity: 2,
      });
    } finally {
      physics.dispose();
    }
  });

  it('reads scaled native shapes and bilateral groups, with explicit cylinder/cone bounds', async () => {
    const physics = await fixture();
    try {
      for (const [index, shape] of [
        ColliderShapeValue.cuboid,
        ColliderShapeValue.sphere,
        ColliderShapeValue.capsule,
        ColliderShapeValue.cylinder,
        ColliderShapeValue.cone,
      ].entries())
        physics.ensureBody(index + 1, pose(), body(0), collider(shape));
      expect(physics.getCommittedColliderPrimitives(1, 0x0002_0001).unwrap()).toMatchObject({
        scale: [2, 3, 4],
        positionM: [2, 3, 4],
        elements: [
          {
            collisionGroups: 0x0001_0002,
            shape: { kind: 'box', halfExtentsM: [1, 0.75, 4], representation: 'native' },
          },
        ],
      });
      expect(physics.getCommittedColliderPrimitives(1, 0x0001_0001).unwrap().elements).toEqual([]);
      expect(physics.getCommittedColliderPrimitives(1, -1)).toMatchObject({
        ok: false,
        error: { code: 'fixed-input-invalid' },
      });
      expect(physics.getCommittedColliderPrimitives(2).unwrap().elements[0]?.shape).toEqual({
        kind: 'sphere',
        radiusM: 2,
      });
      expect(physics.getCommittedColliderPrimitives(3).unwrap().elements[0]?.shape).toEqual({
        kind: 'capsule',
        radiusM: 2,
        halfHeightM: 2.25,
      });
      for (const entity of [4, 5])
        expect(physics.getCommittedColliderPrimitives(entity).unwrap().elements[0]?.shape).toEqual({
          kind: 'box',
          halfExtentsM: [2, 2.25, 2],
          representation: 'bounds',
        });
    } finally {
      physics.dispose();
    }
  });

  it('keeps retained snapshots detached through accepted motion, resize and entity generation reuse', async () => {
    const physics = await fixture();
    try {
      physics.ensureBody(1, pose(), body(), collider());
      const first = physics.getCommittedColliderPrimitives(1).unwrap();
      const rotation = [0, Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)] as const;
      physics
        .setBodyMotion(1, {
          position: [5, 6, 7],
          rotation,
          linearVelocity: [1, 2, 3],
          angularVelocity: [0, 4, 0],
        })
        .unwrap();
      physics.step(1 / 60);
      const moved = physics.getCommittedColliderPrimitives(1).unwrap();
      expect(moved.completedStep).toBe(1);
      expect(moved.linearVelocityMps).toEqual([1, 2, 3]);
      expect(moved.angularVelocityRadps).toEqual([0, 4, 0]);
      expect(moved.elements[0]?.positionM[0]).toBeCloseTo(5 + 1 / 60, 5);
      expect(moved.elements[0]?.rotation[1]).toBeGreaterThan(0.5);
      expect(first.positionM).toEqual([2, 3, 4]);
      expect(first.elements[0]?.positionM).toEqual([2, 3, 4]);
      expect(first.elements[0]?.shape).toEqual({
        kind: 'box',
        halfExtentsM: [1, 0.75, 4],
        representation: 'native',
      });
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.elements[0]?.shape)).toBe(true);
      physics.removeEntity(1);
      expect(physics.getCommittedColliderPrimitives(1)).toMatchObject({
        ok: false,
        error: { code: 'fixed-body-missing' },
      });
      physics.ensureBody(1, { ...pose(), scale: { x: 1, y: 1, z: 1 } }, body(0), collider());
      const replacement = physics.getCommittedColliderPrimitives(1).unwrap();
      expect(replacement.generation).not.toBe(first.generation);
      expect(replacement.elements[0]?.colliderId).not.toBe(first.elements[0]?.colliderId);
      physics.syncAuthoredPose(1, { ...pose(), scale: { x: 5, y: 6, z: 7 } }, collider(), 'static');
      expect(physics.getCommittedColliderPrimitives(1).unwrap()).toMatchObject({
        scale: [5, 6, 7],
        elements: [{ shape: { halfExtentsM: [2.5, 1.5, 7] } }],
      });
      expect(replacement.scale).toEqual([1, 1, 1]);
    } finally {
      physics.dispose();
    }
  });

  it('does not expose queued kinematic author poses before their native fixed step', async () => {
    const physics = await fixture();
    try {
      physics.ensureBody(1, pose(), body(2), collider());
      physics.syncAuthoredPose(
        1,
        { ...pose(), position: { x: 9, y: 3, z: 4 } },
        collider(),
        'kinematic',
      );
      expect(physics.getCommittedColliderPrimitives(1).unwrap().positionM).toEqual([2, 3, 4]);
      physics.step(1 / 60);
      expect(physics.getCommittedColliderPrimitives(1).unwrap()).toMatchObject({
        completedStep: 1,
        positionM: [9, 3, 4],
      });
    } finally {
      physics.dispose();
    }
  });

  it('selects the whole accepted body with an exact native zero-thickness OBB', async () => {
    const physics = await fixture();
    const module = await loadRapier3D();
    if ('code' in module) throw module;
    try {
      physics.ensureBody(1, pose(), body(0), collider());
      let nativeBody: NativeRigidBody | undefined;
      physics.raw.forEachRigidBody((candidate: NativeRigidBody) => {
        nativeBody = candidate;
      });
      physics.raw.createCollider(
        module.ColliderDesc.ball(0.5).setTranslation(20, 0, 0),
        nativeBody,
      );
      const accepted = physics.getCommittedColliderPrimitives(1).unwrap();
      const query = {
        entity: 1,
        generation: accepted.generation,
        completedStep: accepted.completedStep,
        positionM: [2, 3, 4] as const,
        rotation: [0, 0, 0, 1] as const,
        fullExtentsM: [4, 0, 4] as const,
      };
      expect(accepted.rawAggregateCount).toBe(2);
      expect(accepted.elements).toHaveLength(2);
      expect(physics.intersectsCommittedBodyObb(query).unwrap()).toBe(true);
      expect(physics.intersectsCommittedBodyObb({ ...query, positionM: [2, 4, 4] }).unwrap()).toBe(
        false,
      );
      expect(
        physics.intersectsCommittedBodyObb({ ...query, positionM: [2, 3.75, 4] }).unwrap(),
      ).toBe(true);
      expect(
        physics
          .intersectsCommittedBodyObb({
            ...query,
            positionM: [4.5, 3, 4],
            fullExtentsM: [4, 0, 0.2],
          })
          .unwrap(),
      ).toBe(true);
      expect(
        physics
          .intersectsCommittedBodyObb({
            ...query,
            positionM: [4.5, 3, 4],
            fullExtentsM: [4, 0, 0.2],
            rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
          })
          .unwrap(),
      ).toBe(false);
      expect(
        physics.intersectsCommittedBodyObb({ ...query, generation: accepted.generation + 1 }),
      ).toMatchObject({ ok: false, error: { code: 'fixed-generation-stale' } });
      physics.step(1 / 60);
      expect(physics.intersectsCommittedBodyObb(query)).toMatchObject({
        ok: false,
        error: { code: 'fixed-step-stale' },
      });
    } finally {
      physics.dispose();
    }
  });

  it('counts raw accepted aggregate geometry before disabled and group filters', async () => {
    const physics = await fixture();
    try {
      physics.ensureBody(1, pose(), body(0), collider());
      const filtered = physics.getCommittedColliderPrimitives(1, 0x0001_0001).unwrap();
      expect(filtered).toMatchObject({ rawAggregateCount: 1, elements: [] });
      physics.raw.forEachCollider((native: { setEnabled(value: boolean): void }) =>
        native.setEnabled(false),
      );
      const disabled = physics.getCommittedColliderPrimitives(1).unwrap();
      expect(disabled).toMatchObject({ rawAggregateCount: 1, elements: [] });
      expect(
        physics
          .intersectsCommittedBodyObb({
            entity: 1,
            generation: disabled.generation,
            completedStep: disabled.completedStep,
            positionM: [2, 3, 4],
            rotation: [0, 0, 0, 1],
            fullExtentsM: [4, 0, 4],
            emptyAggregateLocalBounds: { centerM: [0, 0, 0], halfExtentsM: [100, 100, 100] },
          })
          .unwrap(),
      ).toBe(false);
    } finally {
      physics.dispose();
    }
  });

  it('retains compound primitive order and native child poses without counting complex surfaces', async () => {
    const physics = await fixture();
    const module = await loadRapier3D();
    if ('code' in module) throw module;
    try {
      physics.ensureBody(1, pose(), body(0), undefined);
      let nativeBody: NativeRigidBody | undefined;
      physics.raw.forEachRigidBody((candidate: NativeRigidBody) => {
        nativeBody = candidate;
      });
      physics.raw.createCollider(
        module.ColliderDesc.compound(
          [new module.Ball(0.5), new module.Cuboid(1, 2, 3)],
          [
            { x: 1, y: 0, z: 0 },
            { x: 0, y: 0, z: 5 },
          ],
          [
            { x: 0, y: 0, z: 0, w: 1 },
            { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
          ],
        ),
        nativeBody,
      );
      physics.raw.createCollider(
        module.ColliderDesc.trimesh(
          new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
          new Uint32Array([0, 1, 2]),
        ),
        nativeBody,
      );
      const snapshot = physics.getCommittedColliderPrimitives(1).unwrap();
      expect(snapshot.rawAggregateCount).toBe(2);
      expect(snapshot.elements).toMatchObject([
        { elementIndex: 0, positionM: [3, 3, 4], shape: { kind: 'sphere', radiusM: 0.5 } },
        { elementIndex: 1, positionM: [2, 3, 9], shape: { kind: 'box', halfExtentsM: [1, 2, 3] } },
      ]);
      expect(snapshot.elements[0]?.colliderId).toBe(snapshot.elements[1]?.colliderId);
      expect(snapshot.elements[1]?.rotation[1]).toBeCloseTo(Math.SQRT1_2, 6);
    } finally {
      physics.dispose();
    }
  });

  it('uses accepted scaled local bounds only for an originally empty aggregate', async () => {
    const physics = await fixture();
    try {
      physics.ensureBody(1, pose(), body(0), undefined);
      const first = physics.getCommittedColliderPrimitives(1).unwrap();
      expect(first).toMatchObject({ rawAggregateCount: 0, scale: [2, 3, 4], elements: [] });
      const query = {
        entity: 1,
        generation: first.generation,
        completedStep: first.completedStep,
        positionM: [2, 3.7, 4] as const,
        rotation: [0, 0, 0, 1] as const,
        fullExtentsM: [4, 0, 4] as const,
        emptyAggregateLocalBounds: {
          centerM: [0, 0, 0] as const,
          halfExtentsM: [0.5, 0.25, 1] as const,
        },
      };
      expect(physics.intersectsCommittedBodyObb(query).unwrap()).toBe(true);
      expect(
        physics
          .intersectsCommittedBodyObb({ ...query, emptyAggregateLocalBounds: undefined })
          .unwrap(),
      ).toBe(false);
      physics.syncAuthoredPose(1, { ...pose(), scale: { x: 1, y: 1, z: 1 } }, undefined, 'static');
      expect(physics.getCommittedColliderPrimitives(1).unwrap().scale).toEqual([1, 1, 1]);
      expect(physics.intersectsCommittedBodyObb(query).unwrap()).toBe(false);
      expect(first.scale).toEqual([2, 3, 4]);
      expect(
        physics.intersectsCommittedBodyObb({ ...query, fullExtentsM: [4, -1, 4] }),
      ).toMatchObject({ ok: false, error: { code: 'fixed-input-invalid' } });
    } finally {
      physics.dispose();
    }
  });
});
