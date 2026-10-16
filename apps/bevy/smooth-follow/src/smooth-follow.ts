// apps/bevy/smooth-follow - shared World builder + step functions (SSOT for the app
// AND the dawn smoke, imported by both via Node TS type-stripping so there is no
// duplicate-scene drift; memory smoke-script-duplicate-scene-must-stay-in-sync-with-main).
//
// Reproduces Bevy's `smooth_follow` example (references/repos/bevy/examples/
// movement/smooth_follow.rs): a red follower sphere smoothly chases a moving blue
// target sphere via `Transform::translation.smooth_nudge(&target, decay_rate, dt)` —
// exponential-decay interpolation that is FRAME-RATE INDEPENDENT. Bevy's target
// wanders to random points; to keep the demo deterministic (so the headless smoke
// can assert exact motion), the target here follows a fixed horizontal circle
// instead of an RNG walk — the follower's smooth_nudge chase is the thing under test,
// not the target's wander.
//
// forgeax mapping:
//   - Vec3::smooth_nudge(&target, decay, dt) -> vec3.smoothDamp(out, current, target,
//                                   decay, dt) — the new frame-rate-independent damping
//                                   helper (solo round 20260713-183918). Before it, a
//                                   follow demo had to hand-write vec3.lerp(out, p,
//                                   target, rate*dt), which is frame-rate DEPENDENT
//                                   (snaps differently at 30 vs 60 fps, overshoots when
//                                   rate*dt > 1) — the footgun this round folds.
//   - target's circular path      -> stepTarget (pure function of world + elapsed time)
//   - DecayRate resource          -> DECAY_RATE constant (game tuning belongs in the app)
//   - Query<&mut Transform, With<FollowingSphere>> -> tag filter + QueryRow mutation
//   - Res<Time>                   -> world.getResource(Time).delta (auto by createApp)
//
// Like 3d-rotation / translation this is a MOTION demo: stepTarget + stepFollower are
// pure functions of (world, dt|elapsed) so the smoke drives them deterministically and
// proves the follower's distance-to-target shrinks over frames (a real chase, not a
// frozen render).

import {
  defineComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { quat, vec3 } from '@forgeax/engine-math';

/**
 * Exponential decay constant (units 1/s) for the follower's smooth_nudge chase
 * (Bevy's `DecayRate(2.0)`). Larger = the follower catches up faster; a good anchor
 * is `ln(2)/halfLife`. Stays fixed while dt varies per frame — that fixed-rate,
 * varying-dt shape is exactly what makes smoothDamp frame-rate independent.
 */
export const DECAY_RATE = 2.0;

/** Radius of the target sphere's circular path (world units). */
export const TARGET_RADIUS = 3.0;

/**
 * Angular speed of the target around its circle (rad/s). Kept well below DECAY_RATE so
 * the follower's steady-state lag is small — a fast-orbiting target would leave a large
 * permanent gap (lag ≈ radius·ω/decay), masking that the chase closes distance at all.
 */
export const TARGET_OMEGA = 0.5;

/**
 * Tag for the moving target sphere. Carries its own accumulated path time so the
 * circular position is a pure function of state (no reliance on a global clock).
 */
export const TargetSphere = defineComponent('TargetSphere', {
  elapsed: { type: 'f32', default: 0 },
});

/** Tag for the follower sphere (Bevy's `FollowingSphere`). No data — behavior is in stepFollower. */
export const FollowingSphere = defineComponent('FollowingSphere', {
  marker: { type: 'u32', default: 1 },
});

/** The target sphere's position on its circle at path-time `t` (pure — used by app, smoke, tests). */
export function targetPositionAt(t: number): [number, number, number] {
  return [Math.cos(t * TARGET_OMEGA) * TARGET_RADIUS, 0, Math.sin(t * TARGET_OMEGA) * TARGET_RADIUS];
}

/**
 * Build the smooth-follow World: a ground plane, a blue target sphere on a circular
 * path, a red follower sphere that smooth-damps toward it, a directional light, and a
 * camera looking at the origin.
 */
export function buildSmoothFollowWorld(world: World): void {
  // ── Ground plane (flat-scaled cube), dark purple like Bevy's ──────────
  const groundMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.3, 0.15, 0.3, 1] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, -2.5, 0], quat: [0, 0, 0, 1], scale: [16, 0.02, 16] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [groundMat] } },
  );

  // ── Target sphere (Bevy srgb(0.3,0.15,0.9) = blue), starts on its circle ──
  const targetMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.3, 0.15, 0.9, 1] }),
  );
  const start = targetPositionAt(0);
  world.spawn(
    { component: Transform, data: { pos: start, quat: [0, 0, 0, 1], scale: [0.6, 0.6, 0.6] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
    { component: MeshRenderer, data: { materials: [targetMat] } },
    { component: TargetSphere, data: { elapsed: 0 } },
  );

  // ── Follower sphere (Bevy srgb(0.9,0.3,0.3) = red), starts offset from target ──
  const followMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.9, 0.3, 0.3, 1] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [0.6, 0.6, 0.6] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
    { component: MeshRenderer, data: { materials: [followMat] } },
    { component: FollowingSphere, data: { marker: 1 } },
  );

  // ── Directional light (Bevy uses a PointLight; a directional light reads the same) ──
  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.4, -0.8, -0.4], color: [1, 1, 1], intensity: 3, castShadow: false },
  });

  // ── Camera at (-2, 3, 9) looking at the origin (wide enough to see the circle) ──
  const eye: [number, number, number] = [-2, 3, 9];
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

function firstHandleWith(world: World, comp: typeof TargetSphere | typeof FollowingSphere): EntityHandle | null {
  const query = world.query({ with: [Transform, comp] }).unwrap();
  for (const row of query) return row.entity;
  return null;
}

/**
 * Advance the target sphere along its circular path by one frame of `dt` seconds
 * (Bevy's `move_target`, simplified to a deterministic circle instead of an RNG walk).
 */
export function stepTarget(world: World, dt: number): void {
  const handle = firstHandleWith(world, TargetSphere);
  if (handle === null) return;
  const t = world.get(handle, Transform);
  const ts = world.get(handle, TargetSphere);
  if (!t.ok || !ts.ok) return;
  const elapsed = (ts.value.elapsed ?? 0) + dt;
  world.set(handle, TargetSphere, { elapsed });
  world.set(handle, Transform, { pos: targetPositionAt(elapsed) });
}

/**
 * Smoothly nudge the follower toward the current target position (Bevy's `move_follower`:
 * `following.translation.smooth_nudge(&target.translation, decay_rate, dt)`). This is the
 * whole point of the demo — a direct transcription onto `vec3.smoothDamp`.
 */
export function stepFollower(world: World, dt: number): void {
  const targetHandle = firstHandleWith(world, TargetSphere);
  const followHandle = firstHandleWith(world, FollowingSphere);
  if (targetHandle === null || followHandle === null) return;
  const target = world.get(targetHandle, Transform);
  const follow = world.get(followHandle, Transform);
  if (!target.ok || !follow.ok) return;

  const next = vec3.create();
  // following.translation.smooth_nudge(&target.translation, decay_rate, dt)
  vec3.smoothDamp(next, follow.value.pos, target.value.pos, DECAY_RATE, dt);
  world.set(followHandle, Transform, { pos: [next[0] ?? 0, next[1] ?? 0, next[2] ?? 0] });
}

/** Current squared distance between follower and target — the smoke's convergence probe. */
export function followerDistanceSq(world: World): number {
  const targetHandle = firstHandleWith(world, TargetSphere);
  const followHandle = firstHandleWith(world, FollowingSphere);
  if (targetHandle === null || followHandle === null) return Number.NaN;
  const target = world.get(targetHandle, Transform);
  const follow = world.get(followHandle, Transform);
  if (!target.ok || !follow.ok) return Number.NaN;
  const a = follow.value.pos;
  const b = target.value.pos;
  const dx = (a[0] ?? 0) - (b[0] ?? 0);
  const dy = (a[1] ?? 0) - (b[1] ?? 0);
  const dz = (a[2] ?? 0) - (b[2] ?? 0);
  return dx * dx + dy * dy + dz * dz;
}
