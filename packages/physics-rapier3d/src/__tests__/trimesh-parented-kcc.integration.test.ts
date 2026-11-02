// A Three port spawned an imported trimesh (the city's bounds collider) as a
// static body with its baked node TRS, then parented it under a root at
// y = -20 with `world.addChild(root, collider, ChildOf, {})`, and dropped a
// kinematic CharacterController near it. The player fell forever. Two causes:
// addChild ignored its parent argument when `data` omitted `parent` (fixed in
// ECS; gated in relationship-index.test.ts), and the bounds mesh has walls
// only, with no floor under the spawn point (Three takes its floor from
// separate ground probes). These gates pin the physics side of that sequence:
// the trimesh follows the parent's world pose even when the first sync ran
// before transform propagation, it grounds the capsule and ends where the
// parented pose puts it, and over a footprint the mesh does not cover a
// downward raycast reports the missing floor.
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { buildMeshCollision, createBoxGeometry } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { createRapier3DPhysicsWorld, loadRapier3D } from '@forgeax/engine-physics-rapier3d';
import {
  ChildOf,
  Children,
  GlobalTransform,
  propagateTransforms,
  Transform,
} from '@forgeax/engine-scene';
import { expect, test } from 'vitest';

const RADIUS = 0.55;
const HALF_HEIGHT = 0.35;
const OFFSET = 0.03;
const GRAVITY = 9.81;
const DT = 1 / 60;

async function fixture() {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const world = new World({ assets: new AssetRegistry() });
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  world.components.register(ChildOf).unwrap();
  world.components.register(Children).unwrap();
  registerPhysicsComponents(world);
  const physics = createRapier3DPhysicsWorld(rapier);
  // The runtime plugin binds this in registerPhysicsSystems.
  physics.setMoveContext(world, Transform);
  // Root at y = -20, like the port's `colider-root`.
  const root = world.spawn({ component: Transform, data: { pos: [0, -20, 0] } }).unwrap();
  // A 10 x 1 x 10 slab authored in the child's local space; the child sits at
  // local y = 15 under a 90 degree X rotation, so the slab is a horizontal
  // floor whose top lands at world y = -5 + 0.5 = -4.5 only when the parent's
  // pose is applied (unparented it would sit at y = +15.5).
  const slab = createBoxGeometry(10, 10, 1).unwrap();
  const mesh = runtimeAssetRegistry(world.assets)
    .create({ ...slab, collision: buildMeshCollision(slab).unwrap() })
    .unwrap();
  const s = Math.SQRT1_2;
  const floor = world
    .spawn(
      { component: Transform, data: { pos: [0, 15, 0], quat: [s, 0, 0, s] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      { component: Collider, data: { shape: ColliderShapeValue.trimesh, mesh } },
    )
    .unwrap();
  world.addChild(root, floor, ChildOf, {}).unwrap();
  return { world, physics, floor };
}

function spawnPlayer(world: World, pos: [number, number, number]) {
  return world
    .spawn(
      { component: Transform, data: { pos } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
      {
        component: Collider,
        data: {
          shape: ColliderShapeValue.capsule,
          radius: RADIUS,
          halfHeight: HALF_HEIGHT,
          friction: 0,
          restitution: 0,
        },
      },
      {
        component: CharacterController,
        data: {
          offset: OFFSET,
          maxSlopeClimbDeg: 48,
          minSlopeSlideDeg: 55,
          autoStepMaxHeight: 0.32,
          autoStepMinWidth: 0.15,
          snapToGroundDist: 0.3,
        },
      },
    )
    .unwrap();
}

function fall(
  world: World,
  physics: ReturnType<typeof createRapier3DPhysicsWorld>,
  player: number,
  frames: number,
  forward = 0,
) {
  let vy = 0;
  for (let frame = 0; frame < frames; frame++) {
    propagateTransforms(world).unwrap();
    physics._syncFromEcs(world, Transform, GlobalTransform);
    vy -= GRAVITY * DT;
    const desired = vec3.create(forward * DT, vy * DT, 0);
    const moved = physics.moveAndSlide(player, desired);
    if (Math.abs((moved[1] ?? 0) - (desired[1] ?? 0)) > 1e-4 && (desired[1] ?? 0) < 0) vy = 0;
    physics.step(DT);
  }
  return world.get(player as never, Transform).unwrap().pos;
}

test('trimesh parented after spawn follows the parent pose even if the first sync preceded propagation', async () => {
  const { world, physics, floor } = await fixture();
  const player = spawnPlayer(world, [0, -2, 0]);
  try {
    // The physics sync may run before Scene propagates the new ChildOf edge.
    physics._syncFromEcs(world, Transform, GlobalTransform);
    expect(physics.hasBody(floor)).toBe(true);
    const pos = fall(world, physics, player, 180);
    const top = -4.5;
    expect(pos[1]).toBeGreaterThan(top + RADIUS + HALF_HEIGHT - 0.05);
    expect(pos[1]).toBeLessThan(top + RADIUS + HALF_HEIGHT + OFFSET + 0.1);
    expect(world.get(player as never, CharacterController).unwrap().grounded).toBe(true);
    const hit = physics.raycast(vec3.create(3, 0, 3), vec3.create(0, -1, 0), 20);
    expect(hit?.point[1]).toBeCloseTo(top, 3);
  } finally {
    physics.dispose();
  }
});

test('trimesh floor ends where the parented pose puts it', async () => {
  const { world, physics } = await fixture();
  // Stand on the slab, then walk +X off its 5 m half-extent edge.
  const player = spawnPlayer(world, [0, -3.5, 0]);
  try {
    const pos = fall(world, physics, player, 240, 3);
    // Walked past the edge and kept falling: proves the slab ends where the
    // parented pose puts it, not at an unparented or stale position.
    expect(pos[0]).toBeGreaterThan(5);
    expect(pos[1]).toBeLessThan(-6);
  } finally {
    physics.dispose();
  }
});

test('a capsule outside the trimesh footprint falls, and a downward raycast reports the missing floor', async () => {
  const { world, physics } = await fixture();
  const player = spawnPlayer(world, [30, -2, 0]);
  try {
    propagateTransforms(world).unwrap();
    physics._syncFromEcs(world, Transform, GlobalTransform);
    physics.step(DT);
    expect(physics.raycast(vec3.create(30, -3.5, 0), vec3.create(0, -1, 0), 1000)).toBeUndefined();
    const pos = fall(world, physics, player, 120);
    expect(pos[1]).toBeLessThan(-20);
    expect(world.get(player as never, CharacterController).unwrap().grounded).toBe(false);
  } finally {
    physics.dispose();
  }
});
