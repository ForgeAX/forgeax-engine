// apps/collectathon -- Core assembly: an emissive glowing collectible sphere
// with a sensor Collider (plan-strategy D-1 sensor pickup, D-6 emissive->bloom).
//
// Visual: a small standard-PBR sphere with emissive [1.0,0.7,0.3] and
// emissiveIntensity 2.0 (> 1.0) so the HDR bright-pass clears the bloom
// threshold (D-6/F-06) once M5 turns bloom on. baseColor keeps the unlit-ish
// warm tint so the sphere reads as a glowing orb even before bloom.
//
// Pickup: a sphere sensor Collider slightly larger than the visual (0.35 vs the
// 0.3 mesh) so a fast player does not tunnel past without overlapping. isSensor
// means it reports overlaps without pushing the player. collisionGroups =
// CORE_GROUPS filters to PLAYER only, so a Core never registers an overlap with
// a Guardian or another Core (R-D1).
//
// The Core needs a RigidBody for Rapier to create the collider; a fixed body is
// wrong (core-spin moves it each frame and a static body would not move in the
// physics view), and a dynamic body would fall under gravity. A
// kinematic-position body is moved by writing its Transform -- exactly what
// core-spin does -- so the sensor follows the bobbing/spinning visual.

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { createSphereGeometry } from '@forgeax/engine-geometry';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';

import { CORE_GROUPS } from '../collision-groups';
import { Core } from '../components';

/** Visual sphere radius (m). */
export const CORE_VISUAL_RADIUS = 0.3;
/** Sensor radius (m) -- slightly larger than the visual to avoid tunnelling. */
export const CORE_SENSOR_RADIUS = 0.35;
/** Resting height of a Core above the ground (the bob oscillates around this). */
export const CORE_BASE_Y = 1.0;

/**
 * Core spawn positions in the level XZ plane (kept inside [-12,12] so Cores do
 * not overlap the boundary walls at +/-15). This array is the SSOT for the level
 * Core count: main.ts derives GameProgress.total from CORE_POSITIONS.length, so
 * there is no second hand-maintained count to keep in sync (Derive principle).
 */
export const CORE_POSITIONS: ReadonlyArray<{ readonly x: number; readonly z: number }> = [
  { x: -10, z: -10 },
  { x: 0, z: -11 },
  { x: 10, z: -10 },
  { x: -11, z: 0 },
  { x: -5, z: 4 },
  { x: 5, z: 4 },
  { x: 11, z: 0 },
  { x: -8, z: 9 },
  { x: 0, z: 6 },
  { x: 8, z: 9 },
  { x: -3, z: -5 },
  { x: 3, z: -5 },
];

/**
 * Spawn one Core at a planar position. Returns the Core entity so main.ts can
 * mark it state-scoped (despawnOnExit).
 */
export function spawnCore(
  world: World,
  position: { readonly x: number; readonly z: number },
): EntityHandle {
  const sphereRes = createSphereGeometry(CORE_VISUAL_RADIUS, 16, 12);
  if (!sphereRes.ok) {
    throw new Error(`collectathon: createSphereGeometry failed: ${sphereRes.error.code}`);
  }
  const coreMesh = world.allocSharedRef('MeshAsset', sphereRes.value);
  const coreMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [1.0, 0.8, 0.3, 1.0],
      emissive: [1.0, 0.7, 0.3],
      emissiveIntensity: 2.0,
      roughness: 0.4,
      metallic: 0,
    }),
  );
  return world
    .spawn(
      { component: Transform, data: { pos: [position.x, CORE_BASE_Y, position.z] } },
      { component: MeshFilter, data: { assetHandle: coreMesh } },
      { component: MeshRenderer, data: { materials: [coreMat] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
      {
        component: Collider,
        data: {
          shape: ColliderShapeValue.sphere,
          radius: CORE_SENSOR_RADIUS,
          isSensor: true,
          collisionGroups: CORE_GROUPS,
        },
      },
      { component: Core, data: {} },
    )
    .unwrap();
}
