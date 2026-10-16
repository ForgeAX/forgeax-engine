import type { EntityHandle } from '@forgeax/engine/ecs';
import {
  Collider,
  ColliderShapeValue,
  physicsPlugin,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import type { RapierPhysicsWorld3D } from '@forgeax/engine/physics-rapier3d';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnMesh, spawnSun, standard } from '../../lab/stage';
import { waitForPhysicsWorld } from './support/live';
import { vec3 } from './support/rapier3d';

const FLOAT_HEIGHTS = [2.4, 3.8, 5.2] as const;
const COLORS = [
  [0.95, 0.15, 0.15, 1],
  [0.15, 0.85, 0.25, 1],
  [0.2, 0.35, 1, 1],
] as const;

export default defineFeature({
  title: 'Rapier 3D: gravity drops a cube stack',
  catalog: '3D Rapier backend',
  kind: 'visual',
  appOptions: { plugins: [physicsPlugin('rapier-3d')] },
  summary:
    'physicsPlugin("rapier-3d") loads Rapier WASM, then three dynamic cuboids with Collider and RigidBody are simulated. The toggle flips PhysicsWorld.setGravity and teleports the cubes back into the air.',
  expect:
    'ON: red, green and blue cubes fall and stack on the grey floor. OFF: gravity is zero and the three cubes hang still, spread out high in the air.',
  async setup({ world, frames, hud }) {
    const { physics, waitedFrames } = await waitForPhysicsWorld<RapierPhysicsWorld3D>(
      world,
      frames,
    );
    if (physics === undefined)
      throw new Error('PhysicsWorld resource never appeared (Rapier 3D WASM did not load)');
    hud.status(`Rapier 3D ready after ${waitedFrames} frames`);
    spawnCamera(world, { eye: [0, 2.8, 10], target: [0, 2.4, 0] });
    spawnSun(world);
    spawnMesh(
      world,
      MESH.cube,
      standard(world, { baseColor: [0.55, 0.55, 0.58, 1], roughness: 0.9 }),
      { pos: [0, -0.05, 0], scale: [12, 0.1, 12] },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.5, 0.5, 0.5] },
      },
    );
    const cubes: EntityHandle[] = FLOAT_HEIGHTS.map((y, index) =>
      spawnMesh(
        world,
        MESH.cube,
        standard(world, { baseColor: COLORS[index] as (typeof COLORS)[number], roughness: 0.5 }),
        { pos: [index === 1 ? 0.15 : 0, y, 0] },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, mass: 1 } },
        {
          component: Collider,
          data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.5, 0.5, 0.5], restitution: 0 },
        },
      ),
    );
    const reset = (gravityY: number): void => {
      physics.setGravity(vec3(0, gravityY, 0));
      cubes.forEach((cube, index) => {
        physics.teleport(cube, vec3(index === 1 ? 0.15 : 0, FLOAT_HEIGHTS[index] ?? 3, 0));
      });
    };
    reset(-9.81);
    return {
      toggle(on) {
        reset(on ? -9.81 : 0);
      },
      checks() {
        const gravity = physics.getGravity();
        return [
          {
            name: 'four native bodies (floor + 3 cubes)',
            ok: physics.getBodyCount() === 4,
            detail: `bodies=${physics.getBodyCount()}`,
          },
          {
            name: 'every cube has a Rapier body',
            ok: cubes.every((cube) => physics.hasBody(cube)),
          },
          {
            name: 'gravity readback after toggle(true)',
            ok: Math.abs((gravity[1] ?? 0) + 9.81) < 1e-4,
            detail: `gravity=${Array.from(gravity).join(',')}`,
          },
        ];
      },
    };
  },
});
