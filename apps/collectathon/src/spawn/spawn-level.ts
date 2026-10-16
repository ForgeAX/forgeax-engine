// apps/collectathon -- procedural level geometry (plan-strategy D-2, risk P-07).
//
// The level is built in code (not a scene.pack.json) because every piece here
// carries ECS behavior (a Collider the KCC resolves against). Pure decoration
// with no behavior would go through scene.pack.json (D-2) -- that lands in M5
// polish, not here.
//
// Pieces:
//   (1) ground   -- 30x30 visible plane + a thin cuboid Collider so the KCC
//                   capsule rests on a solid floor (M2 ground was visual-only).
//   (2) 4 walls  -- invisible cuboid Colliders ringing the 30x30 area so the
//                   player cannot walk off the platform and fall (P-07, memory
//                   verify-visual-offplatform-fall). No MeshRenderer -> the
//                   walls render nothing; they are physics-only boundaries.
//
// standard PBR needs a light already spawned (D-7) -- main.ts spawns the
// DirectionalLight before calling spawnLevel.

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';

import { LEVEL_GROUPS } from '../collision-groups';

/** Half-extent of the square level (30m x 30m -> half 15m). */
export const LEVEL_HALF = 15;
/** Wall height (m): tall enough that a jumping player cannot clear it (P-07). */
export const WALL_HEIGHT = 4;
/** Wall thickness (m): thin slab; placed flush at each edge. */
const WALL_HALF_THICK = 0.25;
/**
 * Ground collider half-thickness (m). A thick slab (top still at y=0 via the
 * centered offset) rather than a razor-thin one: a thin floor under a KCC capsule
 * resting in exact contact makes Rapier's computeColliderMovement refuse planar
 * movement while grounded (the shape-cast clips the slab edge). Matches the
 * apps/hello/character ground (halfExtents[1] 0.5) which moves correctly grounded.
 */
const GROUND_HALF_THICK = 0.5;

// createPlaneGeometry produces an XY plane facing +Z (Three.js r184 convention),
// so the visible ground must be rotated -90 deg about X to lie flat in the XZ
// plane (normal +Y). Without this the "ground" stands as a vertical wall at z=0
// that occludes the whole scene (the canonical floor idiom, mirrors
// apps/learn-render/5.advanced-lighting/3.3.csm).
const FLOOR_QUAT_X = Math.sin(-Math.PI / 4);
const FLOOR_QUAT_W = Math.cos(-Math.PI / 4);

/**
 * Spawn the level geometry and return all created entities so main.ts can mark
 * them state-scoped (despawnOnExit). The first entity is the visible ground; the
 * rest are the four invisible boundary walls.
 */
export function spawnLevel(world: World): EntityHandle[] {
  const entities: EntityHandle[] = [];
  entities.push(spawnGroundVisual(world));
  entities.push(spawnGroundCollider(world));
  for (const wall of spawnWalls(world)) entities.push(wall);
  return entities;
}

// The visible ground and its physics collider are SEPARATE entities because the
// plane mesh must be rotated to lie flat (createPlaneGeometry is an XY plane,
// FLOOR_QUAT_*) while the cuboid collider must stay axis-aligned -- applying the
// -90 deg rotation to a (15, 0.5, 15) cuboid would stand it up as a vertical
// slab and break the KCC floor contact.

function spawnGroundVisual(world: World): EntityHandle {
  // Visible 30x30 plane laid flat in the XZ plane (rotated -90 deg about X so the
  // +Z-facing plane mesh becomes a +Y-facing floor at y=0).
  const planeRes = createPlaneGeometry(LEVEL_HALF * 2, LEVEL_HALF * 2);
  if (!planeRes.ok) {
    throw new Error(`collectathon: createPlaneGeometry failed: ${planeRes.error.code}`);
  }
  const groundMesh = world.allocSharedRef('MeshAsset', planeRes.value);
  const groundMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.28, 0.3, 0.34, 1], roughness: 0.9, metallic: 0 }),
  );
  return world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 0, 0], quat: [FLOOR_QUAT_X, 0, 0, FLOOR_QUAT_W] },
      },
      { component: MeshFilter, data: { assetHandle: groundMesh } },
      { component: MeshRenderer, data: { materials: [groundMat] } },
    )
    .unwrap();
}

function spawnGroundCollider(world: World): EntityHandle {
  // Solid floor Collider: a thin axis-aligned cuboid whose top face sits at y=0.
  // Center at -GROUND_HALF_THICK so top = center + halfY = 0; the KCC capsule
  // (center at PLAYER_SPAWN_Y above 0) rests cleanly on it. No MeshRenderer --
  // the visual is the separate rotated plane above.
  return world
    .spawn(
      { component: Transform, data: { pos: [0, -GROUND_HALF_THICK, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      {
        component: Collider,
        data: {
          shape: ColliderShapeValue.cuboid,
          halfExtents: [LEVEL_HALF, GROUND_HALF_THICK, LEVEL_HALF],
          collisionGroups: LEVEL_GROUPS,
        },
      },
    )
    .unwrap();
}

function spawnWalls(world: World): EntityHandle[] {
  // Four invisible cuboid colliders flush with each edge of the 30x30 area.
  // walls have no MeshFilter/MeshRenderer -- they are physics-only boundaries.
  const edge = LEVEL_HALF + WALL_HALF_THICK; // wall center just outside the floor
  const wallY = WALL_HEIGHT / 2; // wall base at y=0, top at WALL_HEIGHT
  // Each spec: position + the cuboid half-extents spanning that edge.
  const specs: ReadonlyArray<{
    pos: { x: number; y: number; z: number };
    half: { x: number; y: number; z: number };
  }> = [
    // +Z and -Z walls run along X (full width), thin in Z.
    {
      pos: { x: 0, y: wallY, z: edge },
      half: { x: LEVEL_HALF, y: WALL_HEIGHT / 2, z: WALL_HALF_THICK },
    },
    {
      pos: { x: 0, y: wallY, z: -edge },
      half: { x: LEVEL_HALF, y: WALL_HEIGHT / 2, z: WALL_HALF_THICK },
    },
    // +X and -X walls run along Z (full depth), thin in X.
    {
      pos: { x: edge, y: wallY, z: 0 },
      half: { x: WALL_HALF_THICK, y: WALL_HEIGHT / 2, z: LEVEL_HALF },
    },
    {
      pos: { x: -edge, y: wallY, z: 0 },
      half: { x: WALL_HALF_THICK, y: WALL_HEIGHT / 2, z: LEVEL_HALF },
    },
  ];
  return specs.map((s) =>
    world
      .spawn(
        { component: Transform, data: { pos: [s.pos.x, s.pos.y, s.pos.z] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
        {
          component: Collider,
          data: {
            shape: ColliderShapeValue.cuboid,
            halfExtents: [s.half.x, s.half.y, s.half.z],
            collisionGroups: LEVEL_GROUPS,
          },
        },
      )
      .unwrap(),
  );
}
