// apps/collectathon -- Portal assembly: the level exit, inactive until every
// Core is collected (plan-strategy D-1 sensor arrival, AC-16 win path).
//
// The Portal spawns INACTIVE: a dim, low-emissive cylinder ring. portal-activate
// (m3-8) flips PortalState.active once score === total and swaps the material to
// a bright emissive glow. While inactive, player arrival is ignored (boundary
// case: an inactive Portal has no response).
//
// Arrival is detected by a sensor Collider (isSensor) filtered to PLAYER only
// (PORTAL_GROUPS) -- the player parent's CollidingEntities lists the Portal when
// overlapping, and portal-activate gates the Win on PortalState.active so a
// pre-completion walk-through does nothing.
//
// A kinematic body carries the sensor (same rationale as Core: a sensor needs a
// body, and the Portal does not fall or get pushed).

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { createCylinderGeometry } from '@forgeax/engine-geometry';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';

import { PORTAL_GROUPS } from '../collision-groups';
import { Portal, PortalState } from '../components';

/** Portal cylinder radius (m). */
export const PORTAL_RADIUS = 1.2;
/** Portal cylinder height (m). */
export const PORTAL_HEIGHT = 3;
/** Sensor radius (m) for arrival detection -- generous so walking in counts. */
const PORTAL_SENSOR_RADIUS = 1.4;

/** Inactive material: dim, barely-emissive cold ring (reads as "locked"). */
export function inactivePortalMaterial(): MaterialAsset {
  return Materials.standard({
    baseColor: [0.2, 0.25, 0.35, 1],
    emissive: [0.05, 0.08, 0.12],
    emissiveIntensity: 0.3,
    roughness: 0.6,
    metallic: 0.2,
  });
}

/** Active material: bright emissive glow (> 1.0 intensity -> drives bloom). */
export function activePortalMaterial(): MaterialAsset {
  return Materials.standard({
    baseColor: [0.4, 0.8, 1.0, 1],
    emissive: [0.3, 0.7, 1.0],
    emissiveIntensity: 2.5,
    roughness: 0.3,
    metallic: 0.1,
  });
}

/**
 * Spawn the Portal at a planar position (resting on the ground). Returns the
 * Portal entity so main.ts marks it state-scoped and portal-activate can target
 * it. Spawns INACTIVE (PortalState.active = false, dim material).
 */
export function spawnPortal(
  world: World,
  position: { readonly x: number; readonly z: number },
): EntityHandle {
  const cylRes = createCylinderGeometry(PORTAL_RADIUS, PORTAL_RADIUS, PORTAL_HEIGHT, 24, 1);
  if (!cylRes.ok) {
    throw new Error(`collectathon: createCylinderGeometry failed: ${cylRes.error.code}`);
  }
  const portalMesh = world.allocSharedRef('MeshAsset', cylRes.value);
  const portalMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    inactivePortalMaterial(),
  );
  return world
    .spawn(
      {
        component: Transform,
        data: { pos: [position.x, PORTAL_HEIGHT / 2, position.z] },
      },
      { component: MeshFilter, data: { assetHandle: portalMesh } },
      { component: MeshRenderer, data: { materials: [portalMat] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
      {
        component: Collider,
        data: {
          shape: ColliderShapeValue.sphere,
          radius: PORTAL_SENSOR_RADIUS,
          isSensor: true,
          collisionGroups: PORTAL_GROUPS,
        },
      },
      { component: Portal, data: {} },
      { component: PortalState, data: { active: false } },
    )
    .unwrap();
}
