import { expect, it } from 'vitest';
import { loadRapier3D } from '../wasm-loader.js';

async function pushColliders(
  first: 'voxels' | 'cuboid',
  second: 'voxels' | 'cuboid',
  gridOriginX = 0,
  separation = 0.24,
  sphericalCharacter = false,
) {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const world = new rapier.World({ x: 0, y: 0, z: 0 });
  try {
    const cells: number[] = [];
    for (let x = -2; x < 2; x++) {
      for (let y = -3; y < 3; y++) {
        for (let z = -1; z < 1; z++) cells.push(x + gridOriginX, y, z);
      }
    }
    const bodies = [first, second].map((kind, index) => {
      const body = world.createRigidBody(
        rapier.RigidBodyDesc.dynamic().setTranslation(0, 0, index === 0 ? -separation : separation),
      );
      const shape =
        kind === 'voxels'
          ? rapier.ColliderDesc.voxels(new Int32Array(cells), { x: 0.2, y: 0.2, z: 0.2 })
          : rapier.ColliderDesc.cuboid(0.4, 0.6, 0.2);
      world.createCollider(shape.setTranslation(-gridOriginX * 0.2, 0, 0), body);
      return body;
    });
    const character = world.createRigidBody(
      rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(-1, 0, 0),
    );
    const collider = world.createCollider(
      sphericalCharacter ? rapier.ColliderDesc.ball(0.3) : rapier.ColliderDesc.capsule(0.5, 0.3),
      character,
    );
    const controller = world.createCharacterController(0.01);
    controller.setApplyImpulsesToDynamicBodies(true);
    controller.disableAutostep();
    controller.disableSnapToGround();
    world.step();

    controller.computeColliderMovement(
      collider,
      { x: 0.6, y: 0, z: 0 },
      rapier.QueryFilterFlags.EXCLUDE_SENSORS,
    );

    return {
      bodies: bodies.map((body) => ({ linear: body.linvel(), angular: body.angvel() })),
      movement: controller.computedMovement(),
    };
  } finally {
    world.free();
  }
}

it.each([
  ['voxels', 'voxels'],
  ['cuboid', 'voxels'],
  ['voxels', 'cuboid'],
] as const)('pushes both adjacent dynamic colliders (%s, %s)', async (first, second) => {
  const result = await pushColliders(first, second);
  for (const body of result.bodies) {
    expect(body.linear.x).toBeGreaterThan(0);
    expect(Object.values(body.linear).every(Number.isFinite)).toBe(true);
    expect(Object.values(body.angular).every(Number.isFinite)).toBe(true);
  }
  expect(result.movement.x).toBeGreaterThan(0);
  expect(result.movement.x).toBeLessThan(0.6);
  expect(Object.values(result.movement).every(Number.isFinite)).toBe(true);
});

it('preserves impulses when a voxel grid origin is offset inside its collider', async () => {
  // A sphere has one contact per surface, avoiding capsule endpoint ordering
  // differences when testing only the contact frame transformation.
  const centered = await pushColliders('voxels', 'voxels', 0, 0.24, true);
  const offset = await pushColliders('voxels', 'voxels', 5, 0.24, true);
  for (const [index, body] of centered.bodies.entries()) {
    expect(body.linear.x).toBeGreaterThan(0);
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(offset.bodies[index]?.linear[axis]).toBeCloseTo(body.linear[axis], 3);
      expect(offset.bodies[index]?.angular[axis]).toBeCloseTo(body.angular[axis], 3);
    }
  }
});

it('retains the original panic reproduction with empty voxel manifolds', async () => {
  const result = await pushColliders('voxels', 'voxels', 0, 0.25);
  expect(result.movement.x).toBeGreaterThan(0);
  expect(result.movement.x).toBeLessThan(0.6);
  expect(Object.values(result.movement).every(Number.isFinite)).toBe(true);
  for (const body of result.bodies) {
    expect(Object.values(body.linear).every(Number.isFinite)).toBe(true);
    expect(Object.values(body.angular).every(Number.isFinite)).toBe(true);
  }
});
