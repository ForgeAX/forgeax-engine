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

const INPUT_DT = 1 / 60;
const FROZEN = { bodyMotion: 'frozen' } as const;

async function fixture(dt = INPUT_DT) {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const world = new World({
    time: { fixedDeltaSeconds: dt, maxStepsPerUpdate: 1, maxDeltaSeconds: 0.2 },
  });
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
    half: [number, number, number],
    type = RigidBodyTypeValue.static,
    rotation: [number, number, number, number] = [0, 0, 0, 1],
  ) =>
    world
      .spawn(
        { component: Transform, data: { pos: position, quat: rotation } },
        { component: RigidBody, data: { type, gravityScale: 0, mass: 1 } },
        {
          component: Collider,
          data: {
            shape: ColliderShapeValue.cuboid,
            halfExtents: half,
            collisionGroups: 0x00010004,
          },
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
            radius: 0.32,
            halfHeight: 0.58,
            collisionGroups: 0x00040001,
          },
        },
        {
          component: CharacterController,
          data: { offset: 0.01, autoStepMaxHeight: stairs ? 0.3 : 0, snapToGroundDist: 0.3 },
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
    step: () => world.update(dt).unwrap(),
    dispose() {
      release();
      scene();
      physics.dispose();
    },
  };
}

it.each([
  INPUT_DT,
  0.05,
])('budgets one input across one or eight live sweeps at World dt %s', async (worldDt) => {
  for (const count of [1, 8]) {
    const f = await fixture(worldDt);
    try {
      const { world, physics, movement } = f;
      const platform = f.box([0, 0.5, 0], [20, 0.5, 20], RigidBodyTypeValue.kinematic),
        actor = f.character([-3, 1.91, 0]);
      f.step();
      movement.moveAndSlide(actor, vec3.create(0, -0.01, 0), FROZEN);
      world.set(platform, Transform, { pos: [2 * worldDt, 0.5, 0] }).unwrap();
      f.step();
      const support = physics.getBodyMotion(platform).unwrap(),
        tick = world.getResource(FixedTime).tick,
        timestep = physics.raw.timestep;
      expect(support.linearVelocity[0]).toBeCloseTo(2, 5);
      const total: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < count; i++) {
        const part = movement.moveAndSlide(actor, vec3.create(0, 0, 0.1 / count), {
          bodyMotion: 'live',
          deltaTime: INPUT_DT / count,
        });
        for (const axis of [0, 1, 2] as const) total[axis] += part[axis] ?? 0;
        expect(physics.raw.timestep).toBe(timestep);
      }
      // biome-ignore lint/suspicious/noConsole: Preserve measured Native values in test evidence.
      console.info(
        'producer-support-budget',
        JSON.stringify({ worldDt, inputDt: INPUT_DT, count, total }),
      );
      expect(total[0]).toBeCloseTo(2 * INPUT_DT, 5);
      expect(total[2]).toBeCloseTo(0.1, 5);
      // Extra geometric correction legs spend no additional support time.
      for (const desired of [
        vec3.create(0, 0.05, 0),
        vec3.create(0, 0, 0.01),
        vec3.create(0, -0.05, 0),
      ])
        expect(movement.moveAndSlide(actor, desired, FROZEN)[0]).toBeCloseTo(0, 10);
      expect(world.get(actor, CharacterController).unwrap().grounded).toBe(true);
      // Omitting producer time still consumes the original World interval.
      expect(movement.moveAndSlide(actor, vec3.create())[0]).toBeCloseTo(2 * worldDt, 5);
      expect(
        movement.moveAndSlide(actor, vec3.create(), { applyImpulsesToDynamicBodies: false })[0],
      ).toBeCloseTo(2 * worldDt, 5);
      expect(physics.getBodyMotion(platform).unwrap()).toEqual(support);
      expect(world.getResource(FixedTime).tick).toBe(tick);
      expect(physics.raw.timestep).toBe(timestep);
    } finally {
      f.dispose();
    }
  }
});

it.each([
  'stairs',
  'slope',
] as const)('preserves static %s geometry, snap and grounding with producer time', async (terrain) => {
  const f = await fixture(0.05),
    control = await fixture();
  try {
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
    const actor = f.character([terrain === 'stairs' ? -2 : 0, 1.11, 0], terrain === 'stairs'),
      other = control.character([terrain === 'stairs' ? -2 : 0, 1.11, 0], terrain === 'stairs');
    f.step();
    control.step();
    f.movement.moveAndSlide(actor, vec3.create(0, -0.4, 0));
    control.movement.moveAndSlide(other, vec3.create(0, -0.4, 0));
    const start = f.physics.getBodyMotion(actor).unwrap();
    let highest = start.position[1];
    for (let i = 0; i < (terrain === 'stairs' ? 120 : 20); i++) {
      const desired = vec3.create(
        terrain === 'stairs' ? 0.05 : 0.08,
        terrain === 'stairs' ? -0.02 : 0,
        0,
      );
      expect([...f.movement.moveAndSlide(actor, desired, { deltaTime: INPUT_DT })]).toEqual([
        ...control.movement.moveAndSlide(other, desired),
      ]);
      expect(f.world.get(actor, CharacterController).unwrap().grounded).toBe(
        control.world.get(other, CharacterController).unwrap().grounded,
      );
      highest = Math.max(highest, f.physics.getBodyMotion(actor).unwrap().position[1]);
    }
    const end = f.physics.getBodyMotion(actor).unwrap();
    if (terrain === 'stairs') {
      expect(highest).toBeGreaterThan(start.position[1] + 0.15);
      expect(end.position[0]).toBeGreaterThan(2);
      expect(end.position[0]).toBeLessThan(3.1);
      expect(end.position[1]).toBeCloseTo(start.position[1], 3);
      expect(f.world.get(actor, CharacterController).unwrap().grounded).toBe(true);
    } else {
      expect(end.position[0]).toBeGreaterThan(1);
      expect(end.position[1]).toBeLessThan(start.position[1] - 0.1);
    }
  } finally {
    control.dispose();
    f.dispose();
  }
});

it.each([
  true,
  false,
])('retains explicit live dynamic impulse policy %s with producer time', async (impulses) => {
  const f = await fixture(0.05);
  try {
    const actor = f.character([-1, 0, 0]),
      crate = f.box([0, 0, 0], [0.4, 0.4, 0.4], RigidBodyTypeValue.dynamic);
    f.step();
    const before = f.physics.getBodyMotion(crate).unwrap();
    f.movement.moveAndSlide(actor, vec3.create(1, 0, 0), {
      deltaTime: INPUT_DT,
      applyImpulsesToDynamicBodies: impulses,
    });
    if (impulses)
      expect(f.physics.getBodyMotion(crate).unwrap().linearVelocity[0]).toBeGreaterThan(0);
    else expect(f.physics.getBodyMotion(crate).unwrap()).toEqual(before);
    expect(f.physics.raw.timestep).toBeCloseTo(0.05, 6);
  } finally {
    f.dispose();
  }
});

it('restores producer time on success and exception while rejecting synchronous native reentry', async () => {
  const f = await fixture(0.05);
  try {
    const actor = f.character([0, 1, 0]);
    f.step();
    const timestep = f.physics.raw.timestep,
      before = f.physics.getBodyMotion(actor).unwrap(),
      failure = new Error('producer-time compute failure');
    const compute = vi
      .spyOn(f.rapier.KinematicCharacterController.prototype, 'computeColliderMovement')
      .mockImplementationOnce(() => {
        expect(f.physics.raw.timestep).toBeCloseTo(INPUT_DT / 8, 8);
        expect(() => f.physics.step(INPUT_DT)).toThrow(/cannot reenter native execution/);
        expect(() => f.movement.moveAndSlide(actor, vec3.create())).toThrow(
          /cannot reenter native execution/,
        );
        throw failure;
      });
    try {
      expect(() =>
        f.movement.moveAndSlide(actor, vec3.create(1, 0, 0), { deltaTime: INPUT_DT / 8 }),
      ).toThrow(failure);
    } finally {
      compute.mockRestore();
    }
    expect(f.physics.raw.timestep).toBe(timestep);
    expect(f.physics.getBodyMotion(actor).unwrap()).toEqual(before);
    expect([
      ...f.movement.moveAndSlide(actor, vec3.create(0.2, 0, 0), { deltaTime: INPUT_DT }),
    ]).toEqual([...vec3.create(0.2, 0, 0)]);
    expect(f.physics.raw.timestep).toBe(timestep);
    const getter = vi.spyOn(f.physics.raw, 'timestep', 'get');
    try {
      f.movement.moveAndSlide(actor, vec3.create());
      expect(getter).not.toHaveBeenCalled();
    } finally {
      getter.mockRestore();
    }
  } finally {
    f.dispose();
  }
});

it('rejects invalid producer times and frozen custom times before native character preparation', async () => {
  const f = await fixture();
  try {
    const actor = f.character([0, 1, 0]);
    f.step();
    const before = f.physics.getBodyMotion(actor).unwrap(),
      timestep = f.physics.raw.timestep;
    const compute = vi.spyOn(
        f.rapier.KinematicCharacterController.prototype,
        'computeColliderMovement',
      ),
      tune = vi.spyOn(f.rapier.KinematicCharacterController.prototype, 'setSlideEnabled');
    try {
      for (const options of [
        { deltaTime: 0 },
        { deltaTime: -1 },
        { deltaTime: NaN },
        { deltaTime: Infinity },
        { deltaTime: '0.1' },
        { deltaTime: null },
        { bodyMotion: 'frozen', deltaTime: 0 },
        { bodyMotion: 'frozen', deltaTime: INPUT_DT },
        { bodyMotion: 'frozen', deltaTime: NaN },
      ])
        expect(() =>
          Reflect.apply(f.movement.moveAndSlide, f.physics, [actor, vec3.create(1, 0, 0), options]),
        ).toThrowError(expect.objectContaining({ code: 'invalid-body-config' }));
      expect(compute).not.toHaveBeenCalled();
      expect(tune).not.toHaveBeenCalled();
      expect(f.physics.getBodyMotion(actor).unwrap()).toEqual(before);
      expect(f.physics.raw.timestep).toBe(timestep);
    } finally {
      compute.mockRestore();
      tune.mockRestore();
    }
  } finally {
    f.dispose();
  }
});
