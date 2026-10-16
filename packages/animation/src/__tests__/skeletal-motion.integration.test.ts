import {
  createWorldContext,
  type EntityHandle,
  FixedTime,
  FixedUpdate,
  World,
} from '@forgeax/engine-ecs';
import {
  Collider,
  ColliderShapeValue,
  ManagedPhysicsError,
  type PhysicsWorld,
  physicsPlugin,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { startNativePlugin } from '@forgeax/engine-plugin';
import { ChildOf, GlobalTransform, Name, scenePlugin, Transform } from '@forgeax/engine-scene';
import { type AnimationTargetIdValue, err } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  AnimatedBy,
  AnimationPlayer,
  AnimationRootMotion,
  AnimationTargetId,
  animationPlugin,
  bindAnimationTargets,
  createIKSolver,
  createSkeletonRetargeter,
  defineAnimationMask,
} from '../index';
import {
  bindSkeletalMotion,
  CAPTURE_SKELETAL_MOTION_BASE,
  type SkeletalMotionDefinition,
  type SpringBoneChain,
  skeletalMotionPlugin,
  skeletalMotionWriterEntities,
} from '../skeletal-motion';

async function fixture(physical = false, installMotion = true) {
  const world = new World({ time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4 } });
  const context = await createWorldContext(world, [
    scenePlugin(),
    animationPlugin(undefined, { cadence: 'fixed' }),
    ...(physical ? [physicsPlugin('rapier-3d')] : []),
    ...(installMotion ? [skeletalMotionPlugin({ physics: physical })] : []),
  ]);
  const parent = world
    .spawn({
      component: Transform,
      data: { pos: [3, 4, 0], quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [2, 2, 2] },
    })
    .unwrap();
  const player = world
    .spawn(
      { component: Transform, data: {} },
      { component: Name, data: { value: 'character' } },
      { component: AnimationPlayer, data: {} },
      { component: ChildOf, data: { parent } },
    )
    .unwrap();
  const joints: EntityHandle[] = [];
  for (let i = 0; i < 3; i++)
    joints.push(
      world
        .spawn(
          { component: Transform, data: { pos: [i === 0 ? 0 : 1, 0, 0] } },
          { component: Name, data: { value: `joint${i}` } },
          {
            component: ChildOf,
            data: { parent: i === 0 ? player : (joints[i - 1] as EntityHandle) },
          },
        )
        .unwrap(),
    );
  bindAnimationTargets(world, player, joints).unwrap();
  const ids = joints.map(
    (joint) => world.get(joint, AnimationTargetId).unwrap().value as AnimationTargetIdValue,
  );
  const spring: SkeletalMotionDefinition = {
    springs: [
      {
        targets: ids,
        stiffness: 20,
        damping: 5,
        gravity: [0, 0, -9.81],
        radius: 0.03,
        maxAngle: Math.PI / 2,
      },
    ],
  };
  const rig: SkeletalMotionDefinition = {
    physical: {
      bones: ids.slice(0, 2).map((target) => ({
        target,
        offset: [0.5, 0, 0],
        rotation: [0, 0, 0, 1],
        mass: 1,
        shape: { kind: 'capsule', radius: 0.1, halfHeight: 0.3 },
      })),
      joints: [
        {
          bodyA: 0,
          bodyB: 1,
          anchorA: [0.5, 0, 0],
          anchorB: [-0.5, 0, 0],
          axisA: [0, 0, 1],
          axisB: [0, 0, 1],
          limits: [-1, 1],
        },
      ],
    },
  };
  return { world, context, parent, player, joints, ids, spring, rig };
}

describe('managed skeletal motion through World schedules', () => {
  it.each([
    'rebound',
    'missing',
  ] as const)('fails a live binding when its writer ownership is %s', async (change) => {
    const f = await fixture();
    try {
      const binding = bindSkeletalMotion(f.world, f.player, f.spring).unwrap();
      for (let i = 0; i < 60; i++) f.world.update(1 / 60).unwrap();
      expect(binding.status).toBe('active');
      const writer = f.joints[0] as EntityHandle;
      if (change === 'rebound') f.world.set(writer, AnimatedBy, { player: f.parent }).unwrap();
      else f.world.removeComponent(writer, AnimatedBy).unwrap();

      f.world.update(1 / 60).unwrap();

      expect(binding.status).toBe('failed');
      expect(binding.failure?.code).toBe(
        change === 'rebound' ? 'animation-motion-stale' : 'animation-motion-failed',
      );
      expect(binding.writerEntities).toEqual([]);
      expect(skeletalMotionWriterEntities(f.world)).toEqual([]);
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it('observes current Scene writers without treating hierarchy and tail inputs as writers', async () => {
    expect(skeletalMotionWriterEntities(new World())).toEqual([]);
    const f = await fixture();
    try {
      expect(skeletalMotionWriterEntities(f.world)).toEqual([]);
      const binding = bindSkeletalMotion(f.world, f.player, f.spring).unwrap();
      const writers = f.joints.slice(0, -1);
      expect(binding.writerEntities).toEqual(writers);
      expect(skeletalMotionWriterEntities(f.world)).toEqual(writers);
      expect(binding.writerEntities).not.toContain(f.parent);
      expect(binding.writerEntities).not.toContain(f.joints.at(-1));
      binding.setSpringWeight(0, 0).unwrap();
      expect(skeletalMotionWriterEntities(f.world)).toEqual(writers);
      (binding.writerEntities as EntityHandle[]).length = 0;
      (skeletalMotionWriterEntities(f.world) as EntityHandle[]).length = 0;
      expect(skeletalMotionWriterEntities(f.world)).toEqual(writers);
      binding.dispose();
      expect(binding.writerEntities).toEqual([]);
      expect(skeletalMotionWriterEntities(f.world)).toEqual([]);
      const replacement = bindSkeletalMotion(f.world, f.player, f.spring).unwrap();
      expect(skeletalMotionWriterEntities(f.world)).toEqual(writers);
      replacement.dispose();
      const withCollisionInput = bindSkeletalMotion(f.world, f.player, {
        springs: [
          {
            ...(f.spring.springs?.[0] as SpringBoneChain),
            targets: f.ids.slice(0, 2),
            collisions: [
              { target: f.ids[2] as AnimationTargetIdValue, center: [0, 0, 0], radius: 0.1 },
            ],
          },
        ],
      }).unwrap();
      expect(withCollisionInput.writerEntities).toEqual(f.joints.slice(0, 1));
      expect(skeletalMotionWriterEntities(f.world)).toEqual(f.joints.slice(0, 1));
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it('observes physical bone writers separately from managed body entities and other Worlds', async () => {
    const f = await fixture(true);
    const other = await fixture();
    try {
      const binding = bindSkeletalMotion(f.world, f.player, f.rig).unwrap();
      expect(binding.writerEntities).toEqual(f.joints.slice(0, 2));
      expect(skeletalMotionWriterEntities(f.world)).toEqual(binding.writerEntities);
      expect(binding.bodyEntities).toHaveLength(2);
      for (const body of binding.bodyEntities) expect(binding.writerEntities).not.toContain(body);
      expect(skeletalMotionWriterEntities(other.world)).toEqual([]);
      binding.setPhysicsWeight(0).unwrap();
      expect(skeletalMotionWriterEntities(f.world)).toEqual(f.joints.slice(0, 2));
      await f.context.fiber.dispose();
      expect(binding.writerEntities).toEqual([]);
      expect(skeletalMotionWriterEntities(f.world)).toEqual([]);
    } finally {
      await f.context.fiber.dispose();
      await other.context.fiber.dispose();
    }
  });

  it('adopts a saved replacement configuration with new native mass and retired old handles', async () => {
    const f = await fixture(true);
    try {
      const physical = f.rig.physical;
      if (!physical) throw new Error('fixture physical rig missing');
      const original = bindSkeletalMotion(f.world, f.player, f.rig).unwrap();
      const targets = physical.bones.map((bone) => bone.target);
      original.simulate(targets).unwrap();
      f.world.update(1 / 60).unwrap();
      const physics = f.world.getResource<PhysicsWorld>('PhysicsWorld');
      const readMotion = physics.getBodyMotion,
        impulse = physics.applyBodyImpulse;
      const oldBody = original.bodyEntities[0];
      if (!readMotion || !impulse || oldBody === undefined)
        throw new Error('native motion unavailable');
      const oldVelocity = readMotion.call(physics, oldBody).unwrap().linearVelocity[2];
      impulse.call(physics, oldBody, [0, 0, 1]).unwrap();
      const originalResponse =
        readMotion.call(physics, oldBody).unwrap().linearVelocity[2] - oldVelocity;
      expect(originalResponse).toBeCloseTo(1, 4);
      const saved = JSON.stringify({
        physical: {
          ...physical,
          bones: physical.bones.map((bone) => ({ ...bone, mass: bone.mass * 2 })),
        },
      });
      original.dispose();
      f.world.update(1 / 60).unwrap();
      expect(physics.getBodyCount()).toBe(0);
      expect(physics.getJointCount?.()).toBe(0);
      expect(readMotion.call(physics, oldBody).ok).toBe(false);
      expect(original.simulate(targets).ok).toBe(false);
      const replacement = bindSkeletalMotion(
        f.world,
        f.player,
        JSON.parse(saved) as SkeletalMotionDefinition,
      ).unwrap();
      replacement.simulate(targets).unwrap();
      f.world.update(1 / 60).unwrap();
      expect(replacement.status).toBe('active');
      expect(physics.getBodyCount()).toBe(2);
      expect(physics.getJointCount?.()).toBe(1);
      const newBody = replacement.bodyEntities[0];
      if (newBody === undefined) throw new Error('replacement native body missing');
      expect(newBody).not.toBe(oldBody);
      const newVelocity = readMotion.call(physics, newBody).unwrap().linearVelocity[2];
      impulse.call(physics, newBody, [0, 0, 1]).unwrap();
      expect(
        readMotion.call(physics, newBody).unwrap().linearVelocity[2] - newVelocity,
      ).toBeCloseTo(originalResponse / 2, 4);
      replacement.dispose();
      f.world.update(1 / 60).unwrap();
      expect(physics.getBodyCount()).toBe(0);
      expect(physics.getJointCount?.()).toBe(0);
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it('dissipates a finite spring disturbance after the root stops moving', async () => {
    const f = await fixture();
    try {
      const chain = f.spring.springs?.[0];
      if (!chain) throw new Error('fixture spring chain missing');
      const binding = bindSkeletalMotion(f.world, f.player, {
        springs: [{ ...chain, gravity: [0, 0, 0] }],
      }).unwrap();
      f.world.update(1 / 60).unwrap();
      f.world.set(f.parent, Transform, { pos: [3, 4, 0.5] }).unwrap();
      let previous = [3, 8, 0];
      const rest = [3, 8, 0.5];
      const energy: number[] = [];
      for (let tick = 0; tick < 600; tick++) {
        f.world.update(1 / 60).unwrap();
        const matrix = f.world.get(f.joints[2] as EntityHandle, GlobalTransform).unwrap().world;
        const position = [matrix[12] as number, matrix[13] as number, matrix[14] as number];
        const speedSquared = position.reduce(
          (sum, v, i) => sum + ((v - (previous[i] as number)) * 60) ** 2,
          0,
        );
        const displacementSquared = position.reduce(
          (sum, v, i) => sum + (v - (rest[i] as number)) ** 2,
          0,
        );
        energy.push(0.5 * speedSquared + 10 * displacementSquared);
        previous = position;
        expect(binding.failure).toBeUndefined();
        const evidence = binding.springEvidence[0];
        if (!evidence) throw new Error('spring evidence missing');
        expect(evidence.lengthError).toBeLessThan(1e-4);
      }
      expect(energy.every(Number.isFinite)).toBe(true);
      expect(Math.max(...energy.slice(-60))).toBeLessThan(Math.max(...energy.slice(0, 60)) * 0.001);
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it('hands off actual animated body-offset linear and shortest-arc angular velocity once', async () => {
    const f = await fixture(true);
    try {
      const clip = f.world.allocSharedRef('AnimationClip', {
        kind: 'animation-clip',
        duration: 1,
        channels: [
          {
            targetId: f.ids[0] as AnimationTargetIdValue,
            property: 'translation',
            sampler: {
              interpolation: 'LINEAR',
              input: new Float32Array([0, 1]),
              output: new Float32Array([0, 0, 0, 1, 0, 0]),
            },
          },
          {
            targetId: f.ids[0] as AnimationTargetIdValue,
            property: 'rotation',
            sampler: {
              interpolation: 'LINEAR',
              input: new Float32Array([0, 1]),
              output: new Float32Array([0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2]),
            },
          },
        ],
      });
      f.world
        .set(f.player, AnimationPlayer, { clips: [clip], times: [0], weights: [1], speeds: [1] })
        .unwrap();
      const binding = bindSkeletalMotion(f.world, f.player, f.rig).unwrap();
      for (let i = 0; i < 3; i++) f.world.update(1 / 60).unwrap();
      const physics = f.world.getResource<PhysicsWorld>('PhysicsWorld');
      const readMotion = physics.getBodyMotion?.bind(physics);
      if (!readMotion) throw new Error('managed body motion capability missing');
      const previous = readMotion(binding.bodyEntities[0] as EntityHandle).unwrap();
      const set = physics.setBodyMotion;
      if (!set) throw new Error('managed body motion capability missing');
      const writes: Parameters<NonNullable<PhysicsWorld['setBodyMotion']>>[] = [];
      physics.setBodyMotion = (...args) => {
        writes.push(args);
        return set.apply(physics, args);
      };
      binding.simulate([f.ids[0] as AnimationTargetIdValue]).unwrap();
      f.world.update(1 / 60).unwrap();
      const handoff = writes.find(([entity]) => entity === binding.bodyEntities[0])?.[1];
      expect(handoff).toBeDefined();
      if (!handoff) throw new Error('native handoff not observed');
      const velocity = handoff.position.map(
        (position, index) => (position - (previous.position[index] as number)) * 60,
      );
      for (let i = 0; i < 3; i++)
        expect(handoff.linearVelocity[i]).toBeCloseTo(velocity[i] as number, 3);
      expect(handoff.angularVelocity[0]).toBeCloseTo(0, 4);
      expect(handoff.angularVelocity[1]).toBeCloseTo(0, 4);
      expect(handoff.angularVelocity[2]).toBeCloseTo(Math.PI / 2, 3);
      writes.length = 0;
      binding.setPhysicsWeight(0.5).unwrap();
      f.world.update(1 / 60).unwrap();
      expect(writes).toHaveLength(0);
      binding.reset();
      f.world.update(1 / 60).unwrap();
      const reset = writes.find(([entity]) => entity === binding.bodyEntities[0])?.[1];
      expect(reset?.linearVelocity).toEqual([0, 0, 0]);
      expect(reset?.angularVelocity).toEqual([0, 0, 0]);
      physics.setBodyMotion = set;
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it('shares authored target identities across independent rigs in one real Physics World', async () => {
    const f = await fixture(true);
    try {
      const parent = f.world
        .spawn({
          component: Transform,
          data: {
            pos: [-3, 2, 1],
            quat: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
            scale: [0.5, 0.5, 0.5],
          },
        })
        .unwrap();
      const player = f.world
        .spawn(
          { component: Transform, data: {} },
          { component: Name, data: { value: 'character' } },
          { component: AnimationPlayer, data: {} },
          { component: ChildOf, data: { parent } },
        )
        .unwrap();
      const joints: EntityHandle[] = [];
      for (let i = 0; i < 3; i++)
        joints.push(
          f.world
            .spawn(
              { component: Transform, data: { pos: [i === 0 ? 0 : 1, 0, 0] } },
              { component: Name, data: { value: `joint${i}` } },
              {
                component: ChildOf,
                data: { parent: i === 0 ? player : (joints[i - 1] as EntityHandle) },
              },
            )
            .unwrap(),
        );
      bindAnimationTargets(f.world, player, joints).unwrap();
      expect(joints.map((entity) => f.world.get(entity, AnimationTargetId).unwrap().value)).toEqual(
        f.ids,
      );
      const first = bindSkeletalMotion(f.world, f.player, f.rig).unwrap(),
        second = bindSkeletalMotion(f.world, player, f.rig).unwrap();
      first.simulate(f.ids.slice(0, 2)).unwrap();
      for (let i = 0; i < 60; i++) f.world.update(1 / 60).unwrap();
      expect(first.failure).toBeUndefined();
      expect(second.failure).toBeUndefined();
      expect([...f.world.get(joints[0] as EntityHandle, Transform).unwrap().pos]).toEqual([
        0, 0, 0,
      ]);
      const secondWorld = f.world.get(joints[0] as EntityHandle, GlobalTransform).unwrap().world;
      expect([...secondWorld.slice(12, 15)]).toEqual([-3, 2, 1]);
      expect(
        f.world.get(f.joints[0] as EntityHandle, GlobalTransform).unwrap().world[13],
      ).toBeLessThan(3);
      first.dispose();
      f.world.update(1 / 60).unwrap();
      const physics = f.world.getResource<PhysicsWorld>('PhysicsWorld');
      expect(physics.getBodyCount()).toBe(2);
      expect(physics.getJointCount?.()).toBe(1);
      second.dispose();
      f.world.update(1 / 60).unwrap();
      expect(physics.getBodyCount()).toBe(0);
      expect(physics.getJointCount?.()).toBe(0);
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it('keeps a collision-constrained hair cone through a physical parent landing', async () => {
    const f = await fixture(true);
    try {
      const hair: EntityHandle[] = [];
      for (let i = 0; i < 6; i++)
        hair.push(
          f.world
            .spawn(
              { component: Transform, data: { pos: i === 0 ? [0.4, 0, 0] : [0, 0, -0.25] } },
              { component: Name, data: { value: `limited-hair${i}` } },
              {
                component: ChildOf,
                data: {
                  parent: i === 0 ? (f.joints[0] as EntityHandle) : (hair[i - 1] as EntityHandle),
                },
              },
            )
            .unwrap(),
        );
      bindAnimationTargets(f.world, f.player, [...f.joints, ...hair]).unwrap();
      const targets = hair.map(
        (e) => f.world.get(e, AnimationTargetId).unwrap().value as AnimationTargetIdValue,
      );
      f.world
        .spawn(
          { component: Transform, data: { pos: [0, -0.25, 0] } },
          { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
          {
            component: Collider,
            data: { shape: ColliderShapeValue.cuboid, halfExtents: [20, 0.25, 20] },
          },
        )
        .unwrap();
      const physical = f.rig.physical;
      if (!physical) throw new Error('fixture physical rig missing');
      const binding = bindSkeletalMotion(f.world, f.player, {
        physical: {
          ...physical,
          bones: physical.bones.map((b) => ({ ...b, additionalSolverIterations: 16 })),
        },
        springs: [
          {
            targets,
            stiffness: 45,
            damping: 7,
            gravity: [0, -9.81, 0],
            radius: 0.04,
            maxAngle: 1.8,
            iterations: 12,
            collisions: [
              { target: f.ids[1] as AnimationTargetIdValue, center: [0, 0, 0], radius: 0.26 },
            ],
          },
        ],
      }).unwrap();
      binding.simulate(f.ids.slice(0, 2)).unwrap();
      for (let tick = 0; tick < 600; tick++) {
        f.world.update(1 / 60).unwrap();
        expect(binding.failure).toBeUndefined();
        for (const entity of hair.slice(0, -1)) {
          const q = f.world.get(entity, Transform).unwrap().quat;
          // Independent local forward (-Z) cone oracle; base hair rotation is identity.
          const angle = Math.acos(
            Math.max(-1, Math.min(1, 1 - 2 * ((q[0] as number) ** 2 + (q[1] as number) ** 2))),
          );
          expect(angle).toBeLessThanOrEqual(1.8 + 1e-4);
        }
      }
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it('retains backend failure recovery and rejects controls on the retired binding', async () => {
    const f = await fixture(true);
    try {
      const physics = f.world.getResource<PhysicsWorld>('PhysicsWorld');
      const create = physics.createManagedJoints;
      if (!create) throw new Error('ordinary joint capability missing');
      physics.createManagedJoints = () =>
        err(
          new ManagedPhysicsError('managed-physics-failed', {
            reason: 'injected native group creation failure with confirmed rollback',
            recovery: 'old-state-retained',
          }),
        );
      const binding = bindSkeletalMotion(f.world, f.player, f.rig).unwrap();
      f.world.update(1 / 60).unwrap();
      expect(binding.status).toBe('failed');
      expect(binding.failure?.code).toBe('animation-motion-failed');
      if (binding.failure?.code === 'animation-motion-failed') {
        expect(binding.failure.detail.recovery).toBe('rebind');
        expect(binding.failure.detail.cause).toBe('managed-physics-failed');
      }
      expect(binding.simulate(f.ids.slice(0, 2)).ok).toBe(false);
      expect(binding.setPhysicsWeight(0.5).ok).toBe(false);
      expect(physics.getJointCount?.()).toBe(0);
      f.world.update(1 / 60).unwrap(); // Ordinary Physics sync removes despawned body entities.
      expect(physics.getBodyCount()).toBe(0);
      physics.createManagedJoints = create;
      const replacement = bindSkeletalMotion(f.world, f.player, f.rig).unwrap();
      f.world.update(1 / 60).unwrap();
      expect(replacement.status).toBe('active');
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it('holds on render-only ticks, preserves lengths and resets to authored base', async () => {
    const f = await fixture();
    try {
      const binding = bindSkeletalMotion(
        f.world,
        f.player,
        JSON.parse(JSON.stringify(f.spring)),
      ).unwrap();
      f.world.update(1 / 240).unwrap();
      expect(binding.fixedSteps).toBe(0);
      for (let i = 0; i < 120; i++) f.world.update(1 / 60).unwrap();
      expect(binding.failure).toBeUndefined();
      expect(binding.status).toBe('active');
      expect(
        Math.hypot(
          ...f.world
            .get(f.joints[0] as EntityHandle, Transform)
            .unwrap()
            .quat.slice(0, 3),
        ),
      ).toBeGreaterThan(0.01);
      expect(binding.fixedSteps).toBe(f.world.getResource(FixedTime).tick);
      expect(binding.springEvidence[0]?.lengthError).toBeLessThan(1e-5);
      for (let i = 1; i < f.joints.length; i++) {
        const a = f.world.get(f.joints[i - 1] as EntityHandle, GlobalTransform).unwrap().world;
        const b = f.world.get(f.joints[i] as EntityHandle, GlobalTransform).unwrap().world;
        expect(
          Math.hypot(
            (b[12] as number) - (a[12] as number),
            (b[13] as number) - (a[13] as number),
            (b[14] as number) - (a[14] as number),
          ),
        ).toBeCloseTo(2, 4);
      }
      const before = [...f.world.get(f.joints[0] as EntityHandle, Transform).unwrap().quat];
      f.world.update(0).unwrap();
      expect([...f.world.get(f.joints[0] as EntityHandle, Transform).unwrap().quat]).toEqual(
        before,
      );
      binding.setSpringWeight(0, 0).unwrap();
      f.world.update(1 / 60).unwrap();
      expect([...f.world.get(f.joints[0] as EntityHandle, Transform).unwrap().quat]).toEqual([
        0, 0, 0, 1,
      ]);
      f.world.set(f.parent, Transform, { pos: [10, 20, 0] }).unwrap();
      binding.reset();
      binding.setSpringWeight(0, 1).unwrap();
      f.world.update(1 / 60).unwrap();
      expect([...f.world.get(f.joints[0] as EntityHandle, Transform).unwrap().quat]).toEqual([
        0, 0, 0, 1,
      ]);
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it('rejects writer conflict and invalid scale before partial pose writes, retires stale binding', async () => {
    const f = await fixture();
    try {
      expect(bindSkeletalMotion(f.world, f.player, { ...f.spring, ...f.rig }).ok).toBe(false);
      const binding = bindSkeletalMotion(f.world, f.player, f.spring).unwrap();
      f.world.set(f.parent, Transform, { scale: [1, 2, 1] }).unwrap();
      const before = [...f.world.get(f.joints[0] as EntityHandle, Transform).unwrap().quat];
      f.world.update(1 / 60).unwrap();
      expect(binding.status).toBe('failed');
      expect(binding.failure).toBeDefined();
      expect([...f.world.get(f.joints[0] as EntityHandle, Transform).unwrap().quat]).toEqual(
        before,
      );
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it('separates a supported sphere contact at the authored endpoint without stretching the bone', async () => {
    const f = await fixture();
    try {
      const collider = f.world
        .spawn(
          { component: Transform, data: {} },
          { component: Name, data: { value: 'head-contact' } },
          { component: ChildOf, data: { parent: f.player } },
        )
        .unwrap();
      bindAnimationTargets(f.world, f.player, [...f.joints, collider]).unwrap();
      const colliderId = f.world.get(collider, AnimationTargetId).unwrap()
        .value as AnimationTargetIdValue;
      const chain = f.spring.springs?.[0] as SpringBoneChain;
      const binding = bindSkeletalMotion(f.world, f.player, {
        springs: [
          {
            ...chain,
            targets: f.ids.slice(0, 2),
            stiffness: 0,
            gravity: [0, 0, 0],
            collisions: [{ target: colliderId, center: [0.95, 0, 0], radius: 0.25 }],
            iterations: 16,
          },
        ],
      }).unwrap();
      f.world.update(1 / 60).unwrap();
      expect(binding.failure).toBeUndefined();
      expect(binding.springEvidence[0]?.lengthError).toBeLessThan(1e-5);
      expect(binding.springEvidence[0]?.penetration).toBeLessThan(1e-4);
      const root = f.world.get(f.joints[0] as EntityHandle, GlobalTransform).unwrap().world;
      const tail = f.world.get(f.joints[1] as EntityHandle, GlobalTransform).unwrap().world;
      // Independent committed-pose oracle: fixed external parent puts sphere at (3,5.9,0).
      expect(
        Math.hypot((tail[12] as number) - 3, (tail[13] as number) - 5.9, tail[14] as number),
      ).toBeGreaterThanOrEqual(0.56 - 1e-4);
      expect(
        Math.hypot(
          (tail[12] as number) - (root[12] as number),
          (tail[13] as number) - (root[13] as number),
          (tail[14] as number) - (root[14] as number),
        ),
      ).toBeCloseTo(2, 4);
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it('retires all managed resources on reparent and allows a fresh configuration binding', async () => {
    const f = await fixture(true);
    try {
      const binding = bindSkeletalMotion(f.world, f.player, f.rig).unwrap();
      f.world.update(1 / 60).unwrap();
      const physics = f.world.getResource<PhysicsWorld>('PhysicsWorld');
      expect(physics.getJointCount?.()).toBe(1);
      f.world.set(f.joints[1] as EntityHandle, ChildOf, { parent: f.player }).unwrap();
      f.world.update(1 / 60).unwrap();
      expect(binding.status).toBe('failed');
      expect(binding.writerEntities).toEqual([]);
      expect(skeletalMotionWriterEntities(f.world)).toEqual([]);
      expect(physics.getJointCount?.()).toBe(0);
      expect(physics.getBodyCount()).toBe(0);
      f.world
        .set(f.joints[1] as EntityHandle, ChildOf, { parent: f.joints[0] as EntityHandle })
        .unwrap();
      const replacement = bindSkeletalMotion(
        f.world,
        f.player,
        JSON.parse(JSON.stringify(f.rig)),
      ).unwrap();
      f.world.update(1 / 60).unwrap();
      expect(replacement.status).toBe('active');
      expect(physics.getBodyCount()).toBe(2);
      f.world.despawn(f.player).unwrap();
      f.world.update(1 / 60).unwrap();
      expect(replacement.status).toBe('disposed');
      expect(physics.getJointCount?.()).toBe(0);
      expect(physics.getBodyCount()).toBe(0);
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it('holds zero stiffness without input and bounds catch-up to the World policy', async () => {
    const f = await fixture();
    try {
      const binding = bindSkeletalMotion(f.world, f.player, {
        springs: [
          { ...(f.spring.springs?.[0] as SpringBoneChain), stiffness: 0, gravity: [0, 0, 0] },
        ],
      }).unwrap();
      for (let i = 0; i < 120; i++) f.world.update(1 / 60).unwrap();
      expect([...f.world.get(f.joints[0] as EntityHandle, Transform).unwrap().quat]).toEqual([
        0, 0, 0, 1,
      ]);
      const before = binding.fixedSteps;
      f.world.update(1).unwrap();
      expect(binding.fixedSteps - before).toBe(4);
      expect(binding.failure).toBeUndefined();
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it('captures a masked retarget pose before spring composition without a second player clock', async () => {
    const f = await fixture();
    try {
      const sourcePlayer = f.world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 3] } },
          { component: AnimationPlayer, data: {} },
          { component: Name, data: { value: 'source-player' } },
          { component: ChildOf, data: { parent: f.parent } },
        )
        .unwrap();
      const source: EntityHandle[] = [];
      for (let i = 0; i < 3; i++)
        source.push(
          f.world
            .spawn(
              { component: Transform, data: { pos: [i === 0 ? 0 : 1, 0, 0] } },
              { component: Name, data: { value: `source${i}` } },
              {
                component: ChildOf,
                data: { parent: i === 0 ? sourcePlayer : (source[i - 1] as EntityHandle) },
              },
            )
            .unwrap(),
        );
      bindAnimationTargets(f.world, sourcePlayer, source).unwrap();
      const sourceIds = source.map(
        (entity) => f.world.get(entity, AnimationTargetId).unwrap().value as AnimationTargetIdValue,
      );
      const retarget = createSkeletonRetargeter(f.world, {
        pairs: source.map((entity, i) => ({ source: entity, target: f.joints[i] as EntityHandle })),
        rootTranslationScale: 1,
      }).unwrap();
      const mask = f.world.allocSharedRef(
        'AnimationMask',
        defineAnimationMask(
          [{ targetId: sourceIds[0] as AnimationTargetIdValue, weight: 0 }],
          1,
        ).unwrap(),
      );
      const clip = f.world.allocSharedRef('AnimationClip', {
        kind: 'animation-clip',
        duration: 1,
        channels: [
          {
            targetId: sourceIds[0] as AnimationTargetIdValue,
            property: 'translation',
            sampler: {
              interpolation: 'LINEAR',
              input: new Float32Array([0, 1]),
              output: new Float32Array([0, 0, 0, 0, 1, 0]),
            },
          },
          {
            targetId: sourceIds[1] as AnimationTargetIdValue,
            property: 'rotation',
            sampler: {
              interpolation: 'LINEAR',
              input: new Float32Array([0, 1]),
              output: new Float32Array([0, 0, 0, 1, 0, 0, Math.sin(0.3), Math.cos(0.3)]),
            },
          },
        ],
      });
      f.world
        .set(sourcePlayer, AnimationPlayer, {
          clips: [clip],
          times: [0],
          speeds: [1],
          weights: [1],
          masks: [mask],
        })
        .unwrap();
      f.world
        .addSystem(FixedUpdate, {
          name: 'motion-test-retarget',
          queries: [],
          after: ['advanceAnimationPlayer'],
          before: [CAPTURE_SKELETAL_MOTION_BASE],
          fn: () => retarget.retarget().unwrap(),
        })
        .unwrap();
      const binding = bindSkeletalMotion(f.world, f.player, f.spring).unwrap();
      binding.setSpringWeight(0, 0).unwrap();
      for (let i = 0; i < 30; i++) f.world.update(1 / 60).unwrap();
      const root = f.world.get(f.joints[0] as EntityHandle, Transform).unwrap(),
        middle = f.world.get(f.joints[1] as EntityHandle, Transform).unwrap();
      expect([...root.pos]).toEqual([0, 0, 0]);
      expect(middle.quat[2]).toBeCloseTo(Math.sin(0.15), 5);
      expect(middle.quat[3]).toBeCloseTo(Math.cos(0.15), 5);
      expect(f.world.get(sourcePlayer, AnimationPlayer).unwrap().times[0]).toBeCloseTo(0.5, 5);
      const before = [...middle.quat];
      f.world.update(0).unwrap();
      expect([...f.world.get(f.joints[1] as EntityHandle, Transform).unwrap().quat]).toEqual(
        before,
      );
      expect(binding.failure).toBeUndefined();
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it('samples game IK before the motion base and preserves one root-motion accumulator', async () => {
    const f = await fixture();
    try {
      const rootId = f.ids[0] as AnimationTargetIdValue;
      const clip = f.world.allocSharedRef('AnimationClip', {
        kind: 'animation-clip',
        duration: 1,
        channels: [
          {
            targetId: rootId,
            property: 'translation',
            sampler: {
              interpolation: 'LINEAR',
              input: new Float32Array([0, 1]),
              output: new Float32Array([0, 0, 0, 1, 0, 0]),
            },
          },
        ],
      });
      f.world
        .set(f.player, AnimationPlayer, { clips: [clip], times: [0], speeds: [1], weights: [1] })
        .unwrap();
      f.world
        .addComponent(f.player, { component: AnimationRootMotion, data: { targetId: rootId } })
        .unwrap();
      const solver = createIKSolver(f.world, {
        joints: f.joints,
        maxIterations: 64,
        tolerance: 1e-4,
      }).unwrap();
      f.world
        .addSystem(FixedUpdate, {
          name: 'motion-test-ik',
          queries: [],
          after: ['advanceAnimationPlayer'],
          before: [CAPTURE_SKELETAL_MOTION_BASE],
          fn: () => {
            solver.solve([3, 7, -1]).unwrap();
          },
        })
        .unwrap();
      const binding = bindSkeletalMotion(f.world, f.player, f.spring).unwrap();
      binding.setSpringWeight(0, 0).unwrap();
      for (let i = 0; i < 6; i++) f.world.update(1 / 60).unwrap();
      const tip = f.world.get(f.joints[2] as EntityHandle, GlobalTransform).unwrap().world;
      expect(
        Math.hypot((tip[12] as number) - 3, (tip[13] as number) - 7, (tip[14] as number) + 1),
      ).toBeLessThan(0.002);
      expect(
        f.world.get(f.player, AnimationRootMotion).unwrap().accumulatedPosition[0],
      ).toBeCloseTo(0.1, 5);
      f.world.update(0).unwrap();
      expect(
        f.world.get(f.player, AnimationRootMotion).unwrap().accumulatedPosition[0],
      ).toBeCloseTo(0.1, 5);
      expect(binding.failure).toBeUndefined();
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it('rejects a physical spring tail and unrepresentable scaled body mass before any allocation', async () => {
    const f = await fixture(true);
    try {
      const physics = f.world.getResource<PhysicsWorld>('PhysicsWorld');
      const bone = f.rig.physical?.bones[0];
      if (!bone) throw new Error('fixture bone missing');
      expect(
        bindSkeletalMotion(f.world, f.player, {
          ...f.spring,
          physical: {
            bones: [{ ...bone, target: f.ids[2] as AnimationTargetIdValue }],
            joints: [],
          },
        }).ok,
      ).toBe(false);
      const count = f.world.inspect().entityCount;
      expect(
        bindSkeletalMotion(f.world, f.player, {
          physical: { bones: [{ ...bone, shape: { kind: 'sphere', radius: 1e-30 } }], joints: [] },
        }).ok,
      ).toBe(false);
      expect(f.world.inspect().entityCount).toBe(count);
      expect(physics.getBodyCount()).toBe(0);
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it('waits for the native Physics service and cancelled pending ownership cannot revive', async () => {
    const f = await fixture(false, false);
    try {
      const pending = f.context.plugin(skeletalMotionPlugin({ physics: true }));
      expect(bindSkeletalMotion(f.world, f.player, f.rig).ok).toBe(false);
      expect(f.world.hasResource('SkeletalMotion')).toBe(false);
      await pending.dispose();
      (await startNativePlugin(f.context, physicsPlugin('rapier-3d'))).unwrap();
      expect(f.world.hasResource('SkeletalMotion')).toBe(false);
      (await startNativePlugin(f.context, skeletalMotionPlugin({ physics: true }))).unwrap();
      const binding = bindSkeletalMotion(f.world, f.player, f.rig).unwrap();
      f.world.update(1 / 60).unwrap();
      expect(binding.status).toBe('active');
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it('uses real Rapier, separates visual blend from body simulation and cleans every joint/body', async () => {
    const f = await fixture(true);
    try {
      const binding = bindSkeletalMotion(f.world, f.player, f.rig).unwrap();
      binding.simulate(f.ids.slice(0, 2)).unwrap();
      f.world.update(1 / 60).unwrap();
      expect(binding.failure).toBeUndefined();
      const physics = f.world.getResource<PhysicsWorld>('PhysicsWorld');
      expect(physics.getJointCount?.()).toBe(1);
      const bodies = binding.bodyEntities;
      const start = physics.getBodyMotion?.(bodies[0] as number).unwrap().position[1] as number;
      binding.setPhysicsWeight(0).unwrap();
      for (let i = 0; i < 30; i++) f.world.update(1 / 60).unwrap();
      expect(binding.failure).toBeUndefined();
      expect(physics.getBodyMotion?.(bodies[0] as number).unwrap().position[1]).toBeLessThan(
        start - 0.5,
      );
      expect([...f.world.get(f.joints[0] as EntityHandle, Transform).unwrap().pos]).toEqual([
        0, 0, 0,
      ]);
      binding.setPhysicsWeight(1).unwrap();
      f.world.update(1 / 60).unwrap();
      const motion = physics.getBodyMotion?.(bodies[0] as number).unwrap();
      const bone = f.world.get(f.joints[0] as EntityHandle, GlobalTransform).unwrap().world;
      // Independent body-local offset oracle, including the external parent and scale.
      expect((bone[12] as number) + 0.5 * (bone[0] as number)).toBeCloseTo(
        motion?.position[0] as number,
        4,
      );
      expect((bone[13] as number) + 0.5 * (bone[1] as number)).toBeCloseTo(
        motion?.position[1] as number,
        4,
      );
      binding.simulate([f.ids[1] as AnimationTargetIdValue]).unwrap();
      f.world.update(1 / 60).unwrap();
      expect(binding.failure).toBeUndefined();
      expect(physics.getJointCount?.()).toBe(1);
      binding.simulate([]).unwrap();
      f.world.update(1 / 60).unwrap();
      expect([...f.world.get(f.joints[0] as EntityHandle, Transform).unwrap().pos]).toEqual([
        0, 0, 0,
      ]);
      binding.dispose();
      f.world.update(1 / 60).unwrap();
      expect(physics.getJointCount?.()).toBe(0);
      expect(physics.getBodyCount()).toBe(0);
    } finally {
      await f.context.fiber.dispose();
    }
  });
  it('composes physical torso and spring hair on one current pose, including partial-parent conversion', async () => {
    const f = await fixture(true);
    try {
      const hair: EntityHandle[] = [];
      for (let i = 0; i < 3; i++)
        hair.push(
          f.world
            .spawn(
              { component: Transform, data: { pos: [0, i === 0 ? 0.25 : 0.5, 0] } },
              { component: Name, data: { value: `hair${i}` } },
              {
                component: ChildOf,
                data: {
                  parent: i === 0 ? (f.joints[0] as EntityHandle) : (hair[i - 1] as EntityHandle),
                },
              },
            )
            .unwrap(),
        );
      bindAnimationTargets(f.world, f.player, [...f.joints, ...hair]).unwrap();
      const hairIds = hair.map(
        (entity) => f.world.get(entity, AnimationTargetId).unwrap().value as AnimationTargetIdValue,
      );
      const binding = bindSkeletalMotion(f.world, f.player, {
        ...f.rig,
        springs: [{ ...(f.spring.springs?.[0] as SpringBoneChain), targets: hairIds }],
      }).unwrap();
      binding.simulate(f.ids.slice(0, 2)).unwrap();
      for (let i = 0; i < 30; i++) f.world.update(1 / 60).unwrap();
      expect(binding.failure).toBeUndefined();
      expect(binding.springEvidence[0]?.lengthError).toBeLessThan(1e-5);
      const root = f.world.get(f.joints[0] as EntityHandle, GlobalTransform).unwrap().world;
      const h = f.world.get(hair[0] as EntityHandle, GlobalTransform).unwrap().world;
      expect(h[12]).toBeCloseTo((root[12] as number) + 0.25 * (root[4] as number), 4);
      expect(h[13]).toBeCloseTo((root[13] as number) + 0.25 * (root[5] as number), 4);
      binding.simulate([f.ids[1] as AnimationTargetIdValue]).unwrap();
      f.world.update(1 / 60).unwrap();
      const getBodyMotion = f.world.getResource<PhysicsWorld>('PhysicsWorld').getBodyMotion;
      if (getBodyMotion === undefined) throw new Error('Rapier motion capability missing');
      const physics = f.world.getResource<PhysicsWorld>('PhysicsWorld');
      const body = getBodyMotion.call(physics, binding.bodyEntities[1] as number).unwrap();
      const child = f.world.get(f.joints[1] as EntityHandle, GlobalTransform).unwrap().world;
      expect((child[12] as number) + 0.5 * (child[0] as number)).toBeCloseTo(body.position[0], 4);
      expect((child[13] as number) + 0.5 * (child[1] as number)).toBeCloseTo(body.position[1], 4);
    } finally {
      await f.context.fiber.dispose();
    }
  });

  it.each([
    30, 60, 120,
  ])('runs exactly the same fixed simulation for a second at %i presentation Hz', async (hz) => {
    const f = await fixture();
    try {
      const binding = bindSkeletalMotion(f.world, f.player, f.spring).unwrap();
      for (let i = 0; i < hz; i++) f.world.update(1 / hz).unwrap();
      expect(binding.failure).toBeUndefined();
      expect(binding.fixedSteps).toBe(60);
      const q = f.world.get(f.joints[0] as EntityHandle, Transform).unwrap().quat;
      const reference = await fixture();
      try {
        bindSkeletalMotion(reference.world, reference.player, reference.spring).unwrap();
        for (let i = 0; i < 60; i++) reference.world.update(1 / 60).unwrap();
        expect([...q]).toEqual([
          ...reference.world.get(reference.joints[0] as EntityHandle, Transform).unwrap().quat,
        ]);
      } finally {
        await reference.context.fiber.dispose();
      }
    } finally {
      await f.context.fiber.dispose();
    }
  });
});
