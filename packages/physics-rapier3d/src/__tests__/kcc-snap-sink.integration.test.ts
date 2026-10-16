import { createWorldContext, FixedUpdate, World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import type { PhysicsWorld } from '@forgeax/engine-physics';
import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import type { SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { registerPhysicsSystems } from '../physics-sync.js';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

const HALF_HEIGHT = 0.55;
const RADIUS = 0.38;
const OFFSET = 0.03;
const ORIGIN = HALF_HEIGHT + RADIUS + OFFSET;
type Box = [number, number, number, number, number, number];

async function slide(
  boxes: Box[],
  pos: [number, number, number],
  delta: [number, number, number],
  frames = 1,
) {
  const entities: Record<string, SceneEntity> = {
    character: {
      components: {
        Transform: { pos },
        RigidBody: { type: RigidBodyTypeValue.kinematic },
        Collider: {
          shape: ColliderShapeValue.capsule,
          radius: RADIUS,
          halfHeight: HALF_HEIGHT,
          friction: 0.7,
          restitution: 0,
        },
        CharacterController: {
          offset: OFFSET,
          maxSlopeClimbDeg: 52,
          minSlopeSlideDeg: 55,
          autoStepMaxHeight: 0.5,
          autoStepMinWidth: 0.2,
          snapToGroundDist: 0.24,
        },
      },
    },
  };
  boxes.forEach(([x0, y0, z0, x1, y1, z1], i) => {
    entities[`b${i}`] = {
      components: {
        Transform: { pos: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2] },
        RigidBody: { type: RigidBodyTypeValue.static },
        Collider: {
          shape: ColliderShapeValue.cuboid,
          halfExtents: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2],
          friction: 0.86,
          restitution: 0,
        },
      },
    };
  });
  const world = new World();
  const ctx = await createWorldContext(world);
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const physics = createRapier3DPhysicsWorld(await loadRapier3D());
  world.insertResource('PhysicsWorld', physics);
  registerPhysicsSystems(world);
  const scene: SceneAsset = { kind: 'scene', entities };
  let entity = 0;
  for (const [key, value] of Object.entries(scene.entities)) {
    const tokens = { Transform, RigidBody, Collider, CharacterController };
    const components = Object.entries(value.components ?? {}).map(([name, data]) => ({
      component: tokens[name as keyof typeof tokens],
      data,
    }));
    const handle = world.spawn(...(components as never[])).unwrap();
    if (key === 'character') entity = handle;
  }
  let phase = 0;
  world.addSystem(FixedUpdate, {
    name: 'snap-walk',
    after: ['physicsSyncBackend'],
    before: ['physicsStepSimulation'],
    queries: [],
    fn: () => {
      const pw = world.getResource<PhysicsWorld>('PhysicsWorld') as PhysicsWorld & {
        entityMap: Map<number, { bodyHandle: number }>;
        raw: {
          bodies: {
            get(h: number): {
              setTranslation(p: { x: number; y: number; z: number }, wake: boolean): void;
              setNextKinematicTranslation(p: { x: number; y: number; z: number }): void;
            };
          };
          propagateModifiedBodyPositionsToColliders(): void;
        };
      };
      if (!pw.hasBody(entity)) return;
      phase++;
      // The first step builds the query pipeline. Place the body once that has happened, then solve.
      if (phase === 1) return;
      if (phase === 2) {
        const record = pw.entityMap.get(entity);
        if (!record) throw new Error('expected character body');
        const body = pw.raw.bodies.get(record.bodyHandle);
        const at = { x: pos[0], y: pos[1], z: pos[2] };
        body.setTranslation(at, true);
        body.setNextKinematicTranslation(at);
        pw.raw.propagateModifiedBodyPositionsToColliders();
      }
      pw.moveAndSlide(entity, vec3.create(delta[0], delta[1], delta[2]));
    },
  });
  const feet: number[] = [];
  world.update(1 / 60).unwrap();
  for (let i = 0; i < frames; i++) {
    world.update(1 / 60).unwrap();
    feet.push((world.get(entity as never, Transform).unwrap().pos[1] ?? Number.NaN) - ORIGIN);
  }
  const end = [...world.get(entity as never, Transform).unwrap().pos] as [number, number, number];
  const grounded = world.get(entity as never, CharacterController).unwrap().grounded === true;
  await ctx.fiber.dispose();
  world.despawnAll().unwrap();
  physics.dispose();
  return { end, feet, grounded };
}

it('does not snap a resting capsule into a large cuboid', async () => {
  // Continuous walking reaches this exact pose on the 24×1×24 m ground box. Unpatched Rapier
  // snap-to-ground then drops the capsule 0.181 m into the solid and reports grounded.
  const pose: [number, number, number] = [
    394.6746826171875, 1.4601020812988281, -5.328402996063232,
  ];
  const delta: [number, number, number] = [0, -0.0047222222201526165, 0.09166666865348816];
  const ground: Box = [387.5, -0.5, -12.5, 411.5, 0.5, 11.5];
  const run = await slide([ground], pose, delta);
  expect(run.feet[0]).toBeCloseTo(0.5, 2);
  expect(run.end[2] - pose[2]).toBeGreaterThan(0.05);
  expect(run.grounded).toBe(true);
});

it('still snaps down onto a lower step', async () => {
  const upper: Box = [-2, -0.5, -1, 2, 0.5, 8];
  const lower: Box = [-2, -0.7, -8, 2, 0.3, -1];
  const delta: [number, number, number] = [0, -0.0047222222201526165, -0.09166666865348816];
  const run = await slide([upper, lower], [0, 0.5 + ORIGIN, 0.5], delta, 40);
  expect(Math.min(...run.feet)).toBeGreaterThan(0.25);
  expect(Math.min(...run.feet)).toBeLessThan(0.4);
  expect(run.grounded).toBe(true);
});
