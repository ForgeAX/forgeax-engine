// apps/bevy/parenting - shared World builder + rotate step (SSOT for the app
// AND the dawn smoke, imported by both via Node TS type-stripping).
//
// Reproduces Bevy's `parenting` example (references/repos/bevy/examples/
// 3d/parenting.rs): a parent cube with a Rotator component spins about X;
// a child cube at a local offset (0,0,3) orbits via the ChildOf hierarchy.
// forgeax mapping:
//   - Rotator                     -> user-defined component
//   - transform.rotate_x(angle)   -> quat.rotateAxis(t.quat, t.quat, [1,0,0], angle)
//   - children![child]            -> ChildOf { parent: rootEntity }
//   - propagateTransforms         -> auto-registered by createApp
//
// The motion front door (createApp + auto-Time.delta + world.addSystem) is reused
// from the 3d-rotation demo (solo round 20260713-164916).

import {
  defineComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { quat } from '@forgeax/engine-math';

/** Rotations per second for the parent cube (Bevy's 3.0 rad/s). */
export const SPIN_SPEED = 3.0;

/** The world X axis the parent spins about. */
const X_AXIS = [1, 0, 0] as const;

/**
 * Per-entity rotation rate, in radians per second.
 */
export const Rotator = defineComponent('Rotator', {
  speed: { type: 'f32', default: SPIN_SPEED },
});

/**
 * Build the parenting World: parent cube + child cube + light + camera.
 * The child carries ChildOf pointing at the parent, so propagateTransforms
 * derives its world position as parent.world × child.local each frame.
 */
export function buildParentingWorld(world: World): void {
  const cubeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.8, 0.7, 0.6, 1] }),
  );

  // ── Parent cube, 2×2×2 at (0,0,1), spins about X ─────────────────────
  const parent = world.spawn(
    { component: Transform, data: { pos: [0, 0, 1], quat: [0, 0, 0, 1], scale: [2, 2, 2] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMat] } },
    { component: Rotator, data: { speed: SPIN_SPEED } },
  ).unwrap();

  // ── Child cube, 2×2×2 at local (0,0,3) — orbits parent ───────────────
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [2, 2, 2] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMat] } },
    { component: ChildOf, data: { parent } },
  );

  // ── Directional light ─────────────────────────────────────────────────
  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.5, -0.7, -0.5], color: [1, 1, 1], intensity: 3, castShadow: false },
  });

  // ── Camera at (5,10,10) looking at origin (Bevy's setup) ──────────────
  const eye: [number, number, number] = [5, 10, 10];
  world.spawn(
    {
      component: Transform,
      data: {
        pos: eye,
        quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]),
        scale: [1, 1, 1],
      },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );
}

/**
 * Advance every Rotator entity's orientation by one frame of `dt` seconds.
 * Spins around the X axis (Bevy's `transform.rotate_x(3.0 * dt)`).
 */
export function stepRotate(world: World, dt: number): void {
  const query = world.query({ read: [Rotator], with: [Transform] }).unwrap();
  const targets: Array<{ handle: EntityHandle; angle: number }> = [];
  for (const row of query) targets.push({ handle: row.entity, angle: row.get(Rotator).speed * dt });
  for (const { handle, angle } of targets) {
    const cur = world.get(handle, Transform);
    if (!cur.ok) continue;
    const next = quat.rotateAxis(quat.create(), cur.value.quat, X_AXIS, angle);
    world.set(handle, Transform, {
      quat: [next[0] ?? 0, next[1] ?? 0, next[2] ?? 0, next[3] ?? 1],
    });
  }
}
