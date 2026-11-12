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
import { expect, it, vi } from 'vitest';
import { registerPhysicsSystems } from '../physics-sync.js';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

const DT = 1 / 60;
const FROZEN = { bodyMotion: 'frozen' } as const;

async function fixture() {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const world = new World({ time: { fixedDeltaSeconds: DT, maxStepsPerUpdate: 1 } });
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const physics = createRapier3DPhysicsWorld(rapier),
    movement: PhysicsWorld = physics;
  world.insertResource('PhysicsWorld', physics);
  const scene = registerPropagateTransforms(world),
    release = registerPhysicsSystems(world);
  const box = (
    position: [number, number, number],
    halfExtents: [number, number, number],
    type: number = RigidBodyTypeValue.static,
    rotation: [number, number, number, number] = [0, 0, 0, 1],
  ) =>
    world
      .spawn(
        { component: Transform, data: { pos: position, quat: rotation } },
        { component: RigidBody, data: { type, gravityScale: 0, mass: 1 } },
        {
          component: Collider,
          data: { shape: ColliderShapeValue.cuboid, halfExtents, collisionGroups: 0x0001_0004 },
        },
      )
      .unwrap();
  const character = (position: [number, number, number], stairs = false) =>
    world
      .spawn(
        { component: Transform, data: { pos: position } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
        {
          component: Collider,
          data: {
            shape: ColliderShapeValue.capsule,
            radius: 0.3,
            halfHeight: 0.6,
            collisionGroups: 0x0004_0001,
          },
        },
        {
          component: CharacterController,
          data: { autoStepMaxHeight: stairs ? 0.3 : 0, snapToGroundDist: 0.3 },
        },
      )
      .unwrap();
  return {
    world,
    physics,
    movement,
    rapier,
    box,
    character,
    step: () => world.update(DT).unwrap(),
    dispose() {
      release();
      scene();
      physics.dispose();
    },
  };
}

it.each([
  'translation',
  'rotation',
] as const)('ignores %s support velocity across eight frozen calls without changing live policies or the fixed clock', async (mode) => {
  const f = await fixture();
  try {
    const { world, physics, movement } = f;
    const platform = f.box([0, 0.5, 0], [20, 0.5, 20], RigidBodyTypeValue.kinematic);
    const actor = f.character([-3, 1.91, 0]);
    f.step();
    movement.moveAndSlide(actor, vec3.create(0, -0.01, 0));
    expect(world.get(actor, CharacterController).unwrap().grounded).toBe(true);
    if (mode === 'translation') world.set(platform, Transform, { pos: [0.1, 0.5, 0] }).unwrap();
    else
      world
        .set(platform, Transform, { quat: [0, Math.sin(0.025 / 2), 0, Math.cos(0.025 / 2)] })
        .unwrap();
    f.step();
    const support = physics.getBodyMotion(platform).unwrap(),
      tick = world.getResource(FixedTime).tick,
      timestep = physics.raw.timestep;
    expect(
      Math.hypot(...(mode === 'translation' ? support.linearVelocity : support.angularVelocity)),
    ).toBeGreaterThan(1);
    const frozen = [];
    for (let i = 0; i < 8; i++)
      frozen.push(Array.from(movement.moveAndSlide(actor, vec3.create(), FROZEN)));
    const defaultLive = movement.moveAndSlide(actor, vec3.create());
    const impulseOnly = movement.moveAndSlide(actor, vec3.create(), {
      applyImpulsesToDynamicBodies: false,
    });
    const explicitLive = movement.moveAndSlide(actor, vec3.create(), { bodyMotion: 'live' });
    expect(Math.hypot(...defaultLive)).toBeGreaterThan(0.04);
    expect(Math.hypot(...impulseOnly)).toBeGreaterThan(0.04);
    expect(Math.hypot(...explicitLive)).toBeGreaterThan(0.04);
    expect(physics.getBodyMotion(platform).unwrap()).toEqual(support);
    expect(world.getResource(FixedTime).tick).toBe(tick);
    expect(physics.raw.timestep).toBe(timestep);
    for (const delta of frozen) expect(Math.hypot(...delta)).toBeLessThan(0.0001);
    expect(world.get(actor, CharacterController).unwrap().grounded).toBe(true);
  } finally {
    f.dispose();
  }
});

it.each([
  'stairs',
  'slope',
] as const)('retains current static %s collision response, snap and grounding', async (terrain) => {
  const f = await fixture(),
    control = await fixture();
  try {
    const { world, movement, physics } = f;
    for (const owner of [f, control]) {
      if (terrain === 'stairs') {
        owner.box([0, -0.5, 0], [10, 0.5, 4]);
        owner.box([0, 0.1, 0], [0.5, 0.1, 4]);
        owner.box([3.5, 1, 0], [0.2, 1, 4]);
      } else {
        const angle = -Math.PI / 18;
        owner.box([0, -0.5, 0], [10, 0.5, 4], RigidBodyTypeValue.static, [
          0,
          0,
          Math.sin(angle / 2),
          Math.cos(angle / 2),
        ]);
      }
    }
    const live = control.character([terrain === 'stairs' ? -2 : 0, 1.11, 0], terrain === 'stairs');
    const replay = f.character([terrain === 'stairs' ? -2 : 0, 1.11, 0], terrain === 'stairs');
    f.step();
    control.step();
    control.movement.moveAndSlide(live, vec3.create(0, -0.4, 0));
    movement.moveAndSlide(replay, vec3.create(0, -0.4, 0));
    const start = physics.getBodyMotion(replay).unwrap(),
      tick = world.getResource(FixedTime).tick;
    let highest = start.position[1];
    for (let i = 0; i < (terrain === 'stairs' ? 120 : 20); i++) {
      const desired = vec3.create(
        terrain === 'stairs' ? 0.05 : 0.08,
        terrain === 'stairs' ? -0.02 : 0,
        0,
      );
      const ordinary = control.movement.moveAndSlide(live, desired),
        frozen = movement.moveAndSlide(replay, desired, FROZEN);
      expect([...frozen]).toEqual([...ordinary]);
      expect(world.get(replay, CharacterController).unwrap().grounded).toBe(
        control.world.get(live, CharacterController).unwrap().grounded,
      );
      highest = Math.max(highest, physics.getBodyMotion(replay).unwrap().position[1]);
    }
    const end = physics.getBodyMotion(replay).unwrap();

    if (terrain === 'stairs') {
      expect(highest).toBeGreaterThan(start.position[1] + 0.15);
      expect(end.position[0]).toBeGreaterThan(2);
      expect(end.position[0]).toBeLessThan(3.1);
      expect(end.position[1]).toBeCloseTo(start.position[1], 3);
      expect(world.get(replay, CharacterController).unwrap().grounded).toBe(true);
    } else {
      expect(end.position[0]).toBeGreaterThan(1);
      expect(end.position[1]).toBeLessThan(start.position[1] - 0.1);
    }
    expect(world.getResource(FixedTime).tick).toBe(tick);
  } finally {
    control.dispose();
    f.dispose();
  }
});

it('forces frozen impulses off while preserving the cached controller default on its next live call', async () => {
  const f = await fixture();
  try {
    const actor = f.character([-1, 0, 0]),
      crate = f.box([0, 0, 0], [0.4, 0.4, 0.4], RigidBodyTypeValue.dynamic);
    f.step();
    const before = f.physics.getBodyMotion(crate).unwrap();
    const delta = f.movement.moveAndSlide(actor, vec3.create(1, 0, 0), FROZEN);
    expect(delta[0]).toBeGreaterThan(0);
    expect(delta[0]).toBeLessThan(1);
    expect(f.physics.getBodyMotion(crate).unwrap()).toEqual(before);
    f.movement.moveAndSlide(actor, vec3.create(0.3, 0, 0));
    expect(f.physics.getBodyMotion(crate).unwrap().linearVelocity[0]).toBeGreaterThan(0);
  } finally {
    f.dispose();
  }
});

it('restores the exact timestep after a native exception and refuses native reentry during the frozen window', async () => {
  const f = await fixture();
  try {
    const actor = f.character([0, 1, 0]);
    f.step();
    const timestep = f.physics.raw.timestep,
      before = f.physics.getBodyMotion(actor).unwrap();
    const failure = new Error('injected character compute failure');
    const compute = vi
      .spyOn(f.rapier.KinematicCharacterController.prototype, 'computeColliderMovement')
      .mockImplementationOnce(() => {
        expect(f.physics.raw.timestep).toBe(0);
        expect(() => f.physics.step(DT)).toThrow(/cannot reenter native execution/);
        expect(() => f.physics.raycast(vec3.create(), vec3.create(1, 0, 0), 1)).toThrow(
          /cannot reenter native execution/,
        );
        throw failure;
      });
    try {
      expect(() => f.movement.moveAndSlide(actor, vec3.create(1, 0, 0), FROZEN)).toThrow(failure);
    } finally {
      compute.mockRestore();
    }
    expect(f.physics.raw.timestep).toBe(timestep);
    expect(f.physics.getBodyMotion(actor).unwrap()).toEqual(before);
    expect([...f.movement.moveAndSlide(actor, vec3.create(0.2, 0, 0))]).toEqual([
      ...vec3.create(0.2, 0, 0),
    ]);
    expect(f.physics.raw.timestep).toBe(timestep);
  } finally {
    f.dispose();
  }
});

it('rejects unknown modes and frozen impulses before entering native computation or changing the actor', async () => {
  const f = await fixture();
  try {
    const actor = f.character([0, 1, 0]);
    f.step();
    const before = f.physics.getBodyMotion(actor).unwrap(),
      timestep = f.physics.raw.timestep;
    const compute = vi.spyOn(
      f.rapier.KinematicCharacterController.prototype,
      'computeColliderMovement',
    );
    try {
      for (const options of [
        { bodyMotion: 'unknown' },
        { bodyMotion: 'frozen', applyImpulsesToDynamicBodies: true },
      ]) {
        expect(() =>
          Reflect.apply(f.movement.moveAndSlide, f.physics, [actor, vec3.create(1, 0, 0), options]),
        ).toThrowError(expect.objectContaining({ code: 'invalid-body-config' }));
      }
      expect(compute).not.toHaveBeenCalled();
      expect(f.physics.getBodyMotion(actor).unwrap()).toEqual(before);
      expect(f.physics.raw.timestep).toBe(timestep);
    } finally {
      compute.mockRestore();
    }
  } finally {
    f.dispose();
  }
});
