import { FixedTime, FixedUpdate, World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import {
  GlobalTransform,
  PROPAGATE_TRANSFORMS_FIXED_SYSTEM,
  readPresentationWorldMatrix,
  registerPropagateTransforms,
  Transform,
} from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { registerPhysicsSystems } from '../physics-sync.js';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

it('retains fixed-step support through reversals, jump and support retirement', async () => {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const physics = createRapier3DPhysicsWorld(rapier);
  world.insertResource('PhysicsWorld', physics);
  const releaseScene = registerPropagateTransforms(world);
  const releasePhysics = registerPhysicsSystems(world);
  const support = world
    .spawn(
      { component: Transform, data: {} },
      { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [3, 0.25, 3] },
      },
    )
    .unwrap();
  const character = world
    .spawn(
      { component: Transform, data: { pos: [0, 1.06, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.5 },
      },
      { component: CharacterController, data: {} },
    )
    .unwrap();
  let tick = 0;
  let verticalVelocity = 0;
  let retired = false;
  let jumpQueued = false;
  world
    .addSystem(FixedUpdate, {
      name: 'test-support-motion',
      before: [PROPAGATE_TRANSFORMS_FIXED_SYSTEM],
      queries: [],
      fn() {
        tick++;
        if (retired) {
          return;
        }
        const x = 0.6 * Math.sin(tick / 60);
        const y = 0.1 * Math.sin(tick / 90);
        world.set(support, Transform, { pos: [x, y, 0] }).unwrap();
      },
    })
    .unwrap();
  world
    .addSystem(FixedUpdate, {
      name: 'test-character-motion',
      after: ['physicsSyncBackend'],
      before: ['physicsStepSimulation'],
      queries: [],
      fn() {
        if (!physics.hasBody(character)) return;
        const dt = world.getResource(FixedTime).delta;
        if (jumpQueued) {
          verticalVelocity = 4;
          jumpQueued = false;
        } else if (world.get(character, CharacterController).unwrap().grounded)
          verticalVelocity = 0;
        verticalVelocity -= 9.81 * dt;
        physics.moveAndSlide(character, vec3.create(0, verticalVelocity * dt, 0));
      },
    })
    .unwrap();
  let contactOffset: number | undefined;
  let presentationLagObserved = false;
  try {
    for (let frame = 0; frame < 1800; frame++) {
      // No tick, one tick and catch-up ticks share the same simulation owner.
      world.update([1 / 120, 1 / 60, 1 / 40][frame % 3] ?? 1 / 60).unwrap();
      if (tick < 20) continue;
      const player = world.get(character, Transform).unwrap().pos;
      const platform = world.get(support, Transform).unwrap().pos;
      contactOffset ??= (player[0] ?? 0) - (platform[0] ?? 0);
      expect(Math.abs((player[0] ?? 0) - (platform[0] ?? 0) - contactOffset)).toBeLessThan(0.025);
      expect(Math.abs((player[1] ?? 0) - (platform[1] ?? 0) - 1.06)).toBeLessThan(0.015);

      const shownPlayer = readPresentationWorldMatrix(world, character);
      const shownSupport = readPresentationWorldMatrix(world, support);
      if (shownPlayer === undefined || shownSupport === undefined)
        throw new Error('Missing presentation pose');
      presentationLagObserved ||= Math.abs((shownSupport[12] ?? 0) - (platform[0] ?? 0)) > 1e-5;
      expect(
        Math.abs((shownPlayer[12] ?? 0) - (shownSupport[12] ?? 0) - contactOffset),
      ).toBeLessThan(0.025);
    }
    const standing = world.get(character, Transform).unwrap().pos[1] ?? 0;
    expect(presentationLagObserved).toBe(true);
    jumpQueued = true;
    for (let frame = 0; frame < 5; frame++) world.update(1 / 60).unwrap();
    expect(world.get(character, Transform).unwrap().pos[1]).toBeGreaterThan(standing + 0.2);
    expect(world.get(character, CharacterController).unwrap().grounded).toBe(false);
    const airborneX = world.get(character, Transform).unwrap().pos[0] ?? 0;
    for (let frame = 0; frame < 10; frame++) world.update(1 / 60).unwrap();
    expect(world.get(character, Transform).unwrap().pos[0]).toBeCloseTo(airborneX, 3);
    for (let frame = 0; frame < 70; frame++) world.update(1 / 60).unwrap();
    expect(world.get(character, CharacterController).unwrap().grounded).toBe(true);
    const before = world.get(character, Transform).unwrap().pos[1] ?? 0;
    world.despawn(support).unwrap();
    retired = true;
    for (let frame = 0; frame < 60; frame++) world.update(1 / 60).unwrap();
    expect(physics.hasBody(support)).toBe(false);
    expect(world.get(character, Transform).unwrap().pos[1]).toBeLessThan(before - 0.1);
    expect(world.get(character, CharacterController).unwrap().grounded).toBe(false);
  } finally {
    world.removeSystem(FixedUpdate, 'test-character-motion').unwrap();
    world.removeSystem(FixedUpdate, 'test-support-motion').unwrap();
    releasePhysics();
    releaseScene();
    physics.dispose();
  }
}, 20_000);
