// apps/bevy/3d-rotation - shared World builder + spin step (SSOT for the app
// AND the dawn smoke, imported by both via Node TS type-stripping so there is
// no duplicate-scene drift; memory smoke-script-duplicate-scene-must-stay-in-
// sync-with-main).
//
// Reproduces Bevy's `3d_rotation` example (references/repos/bevy/examples/
// transforms/3d_rotation.rs): a cube carrying a `Rotatable { speed }` component
// spins about its Y axis; an Update system reads the frame delta and calls
// `transform.rotate_y(speed * TAU * dt)`. forgeax mapping:
//   - Rotatable { speed }        -> a user-defined component (game behavior data
//                                   belongs in the app, not the engine)
//   - transform.rotate_y(angle)  -> quat.rotateAxis(t.quat, t.quat, [0,1,0], angle)
//                                   the ergonomic incremental-rotate helper (solo
//                                   round 20260713-164916) — pre-multiplies the
//                                   delta (world-space axis, Bevy rotate order)
//                                   and re-normalizes, so the per-frame loop does
//                                   NOT accumulate float drift into a skewed quat.
//   - Query<(&mut Transform, &Rotatable)> -> one row iterator over the
//                                   two components, entity handle from row.entity
//   - Res<Time>                  -> world.getResource(Time).delta (auto-provided
//                                   each frame by createApp's frame-loop)
//
// This is the loop's first MOTION demo — every prior bevy demo built a static
// world and redrew it unchanged. The spin step (stepSpin) is a pure function of
// (world, dt) so the headless smoke can drive it deterministically and prove two
// frames at different times differ (motion, not a frozen render).

import {
  defineComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { quat } from '@forgeax/engine-math';

/** A full turn (2π radians), matching Bevy's `std::f32::consts::TAU`. */
export const TAU = Math.PI * 2;

/** Rotations per second for the demo cube (Bevy's `Rotatable { speed: 0.3 }`). */
export const SPIN_SPEED = 0.3;

/** The world Y axis the cube spins about. */
const Y_AXIS = [0, 1, 0] as const;

/**
 * Per-entity spin rate, in rotations per second — mirrors Bevy's `Rotatable`
 * component. `speed * TAU` is the angular velocity in radians/second.
 * `defineComponent` registers the schema globally; `world.spawn` uses it directly.
 */
export const Rotatable = defineComponent('Rotatable', {
  speed: { type: 'f32', default: SPIN_SPEED },
});

/**
 * Build the 3d_rotation World: a spinning cube + a ground plane + a directional
 * light + a camera looking at the origin. The cube starts at identity
 * orientation; stepSpin rotates it each frame.
 */
export function buildRotationWorld(world: World): void {
  // ── Ground plane (flat-scaled cube), white PBR ────────────────────────
  const groundMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [1, 1, 1, 1] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, -1.5, 0], quat: [0, 0, 0, 1], scale: [10, 0.02, 10] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [groundMat] } },
  );

  // ── The rotating cube (Bevy Color::WHITE), at the origin ──────────────
  const cubeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.9, 0.9, 0.9, 1] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [2, 2, 2] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMat] } },
    { component: Rotatable, data: { speed: SPIN_SPEED } },
  );

  // ── Directional light aimed at the origin (Bevy DirectionalLight) ─────
  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.5, -0.7, -0.5], color: [1, 1, 1], intensity: 3, castShadow: false },
  });

  // ── Camera at (0, 10, 20) looking at the origin (Bevy's setup) ────────
  const eye: [number, number, number] = [0, 10, 20];
  world.spawn(
    {
      component: Transform,
      data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );
}

/**
 * Advance every Rotatable entity's orientation by one frame of `dt` seconds.
 *
 * This is the pure spin step — the same math whether it runs inside a
 * `world.addSystem` (the app) or a manual loop (the smoke). It reproduces Bevy's
 * `rotate_cube(Query<(&mut Transform, &Rotatable)>, Res<Time>)`:
 * `transform.rotate_y(speed * TAU * dt)`, using the ergonomic `quat.rotateAxis`
 * so the per-frame accumulation stays drift-free.
 */
export function stepSpin(world: World, dt: number): void {
  const query = world.query({ read: [Rotatable], with: [Transform] }).unwrap();
  const targets: Array<{ handle: EntityHandle; angle: number }> = [];
  for (const row of query) targets.push({ handle: row.entity, angle: row.get(Rotatable).speed * TAU * dt });
  // Read-modify-write Transform per entity (mut Transform in the Bevy query).
  for (const { handle, angle } of targets) {
    const cur = world.get(handle, Transform);
    if (!cur.ok) continue;
    const next = quat.rotateAxis(quat.create(), cur.value.quat, Y_AXIS, angle);
    world.set(handle, Transform, {
      quat: [next[0] ?? 0, next[1] ?? 0, next[2] ?? 0, next[3] ?? 1],
    });
  }
}
