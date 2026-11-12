import { FixedTime, World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  type PhysicsWorld,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { registerPhysicsSystems } from '../physics-sync.js';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

async function fixture() {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const world = new World();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const physics = createRapier3DPhysicsWorld(rapier),
    movement: PhysicsWorld = physics;
  world.insertResource('PhysicsWorld', physics);
  const scene = registerPropagateTransforms(world),
    release = registerPhysicsSystems(world);
  const box = (pos: [number, number, number], half: [number, number, number], dynamic = false) =>
    world
      .spawn(
        { component: Transform, data: { pos } },
        {
          component: RigidBody,
          data: {
            type: dynamic ? RigidBodyTypeValue.dynamic : RigidBodyTypeValue.static,
            gravityScale: 0,
          },
        },
        { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents: half } },
      )
      .unwrap();
  box([0, -0.5, 0], [5, 0.5, 5]);
  box([1, 1.75, 0], [1, 0.5, 1]);
  const neighbor = box([4, 0.5, 3], [0.2, 0.2, 0.2], true);
  const character = world
    .spawn(
      { component: Transform, data: { pos: [-1, 0.91, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.6 },
      },
      { component: CharacterController, data: { autoStepMaxHeight: 0, snapToGroundDist: 0 } },
    )
    .unwrap();
  world.update(1 / 60).unwrap();
  return {
    world,
    physics,
    movement,
    character,
    neighbor,
    dispose() {
      release();
      scene();
      physics.dispose();
    },
  };
}

it('synchronizes actual same-tick capsule height and grounded without stepping or synchronizing another body', async () => {
  const f = await fixture();
  try {
    const { world, movement, physics, character, neighbor } = f;
    const neighborBefore = physics.getBodyMotion(neighbor).unwrap(),
      tick = world.getResource(FixedTime).tick;
    // A pending edit on another body must stay pending; this API owns one actor.
    world.set(neighbor, Collider, { halfExtents: [1, 1, 1] }).unwrap();
    world.set(character, Collider, { halfHeight: 0.275 }).unwrap();
    const state = { position: vec3.create(-1, 0.585, 0), grounded: true };
    movement.synchronizeCharacter(character, state);
    const aboveCrouchedHead = physics.raycast(
      vec3.create(-1, 1.35, -0.8),
      vec3.create(0, 0, 1),
      1.6,
    );
    expect(aboveCrouchedHead?.entity).not.toBe(character);
    expect(world.get(character, CharacterController).unwrap().grounded).toBe(true);
    expect(physics.raycast(vec3.create(4.8, 0.5, 2), vec3.create(0, 0, 1), 2)).toBeUndefined();
    expect(physics.getBodyMotion(neighbor).unwrap()).toEqual(neighborBefore);
    expect(world.getResource(FixedTime).tick).toBe(tick);
    movement.moveAndSlide(character, vec3.create(3, -0.01, 0), {
      applyImpulsesToDynamicBodies: false,
    });
    expect(world.get(character, Transform).unwrap().pos[0]).toBeGreaterThan(1.5);
    world.set(character, Collider, { halfHeight: 0.6 }).unwrap();
    movement.synchronizeCharacter(character, {
      position: vec3.create(-1, 0.91, 0),
      grounded: false,
    });
    expect(physics.raycast(vec3.create(-1, 1.35, -0.8), vec3.create(0, 0, 1), 1.6)?.entity).toBe(
      character,
    );
    movement.moveAndSlide(character, vec3.create(3, -0.01, 0), {
      applyImpulsesToDynamicBodies: false,
    });
    expect(world.get(character, Transform).unwrap().pos[0]).toBeLessThan(0);
    expect(world.getResource(FixedTime).tick).toBe(tick);
    world.update(1 / 60).unwrap();
    // Normal synchronization must still consume the other body's pending edit.
    expect(physics.raycast(vec3.create(4.8, 0.5, 2), vec3.create(0, 0, 1), 2)?.entity).toBe(
      neighbor,
    );
  } finally {
    f.dispose();
  }
});

it('validates the handoff before mutation and does not push a dynamic neighbor during reconstruction sweeps', async () => {
  const f = await fixture();
  try {
    const { world, movement, physics, character, neighbor } = f;
    const initial = physics.getBodyMotion(character).unwrap();
    expect(() =>
      movement.synchronizeCharacter(character, {
        position: vec3.create(Number.NaN, 0, 0),
        grounded: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-body-config' }));
    expect(physics.getBodyMotion(character).unwrap()).toEqual(initial);
    expect(() =>
      movement.synchronizeCharacter(neighbor, { position: vec3.create(), grounded: false }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-body-config' }));
    const state = physics.getBodyMotion(neighbor).unwrap();
    physics.setBodyMotion(neighbor, { ...state, position: [-0.3, 0.91, 0] }).unwrap();
    const before = physics.getBodyMotion(neighbor).unwrap(),
      tick = world.getResource(FixedTime).tick;
    movement.synchronizeCharacter(character, {
      position: vec3.create(-1, 0.91, 0),
      grounded: false,
    });
    expect(world.get(character, CharacterController).unwrap().grounded).toBe(false);
    expect(physics.getBodyMotion(neighbor).unwrap()).toEqual(before);
    const move = movement.moveAndSlide(character, vec3.create(1, 0, 0), {
      applyImpulsesToDynamicBodies: false,
    });
    expect(move[0]).toBeGreaterThan(0);
    // The narrow crate allows a lateral slide; it must still obstruct the
    // requested full metre without receiving a reconstruction impulse.
    expect(move[0]).toBeLessThan(1);
    expect(physics.getBodyMotion(neighbor).unwrap()).toEqual(before);
    expect(world.getResource(FixedTime).tick).toBe(tick);
  } finally {
    f.dispose();
  }
});
