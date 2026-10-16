// apps/bevy/easing - shared World builder + eased-motion step (SSOT for the app AND the
// dawn smoke, imported by both via Node TS type-stripping so there is no duplicate-scene
// drift; memory smoke-script-duplicate-scene-must-stay-in-sync-with-main).
//
// Reproduces the spirit of Bevy's `animation/easing_functions` example: motion driven by an
// easing curve rather than a linear ramp. Here two cubes travel the same left->right path as
// a ping-pong of normalized time `u in [0,1]`:
//   - the LINEAR cube uses u directly,
//   - the EASED cube uses easing.smoothstep(u) — slow-in / slow-out.
// So at the same moment the two cubes are at different x (except at u=0/0.5/1), visibly
// showing the ease.
//
// forgeax mapping:
//   - EaseFunction::SmoothStep -> easing.smoothstep(u) — the new easing namespace (solo round
//                                 20260713-233409). Before it, forgeax had NO easing functions,
//                                 so eased motion meant hand-rolling u*u*(3-2u) + the [0,1] clamp.
//   - a normalized animation clock -> a ping-pong of Time.elapsed (round 11's Time.elapsed).
//
// stepEasing(world, u) is a pure function of (world, u in [0,1]) so the headless smoke can
// drive it deterministically and assert the eased cube's x equals lerp(x0,x1,smoothstep(u))
// while the linear cube's x equals lerp(x0,x1,u) — proving the motion is genuinely eased.

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
import { easing, quat } from '@forgeax/engine-math';

/** Path endpoints (world X) the cubes travel between. */
export const X_START = -4;
export const X_END = 4;
/** Y positions of the two lanes. */
const Y_LINEAR = 1.2;
const Y_EASED = -1.2;

/** Discriminates the two moving cubes: mode 0 = linear, mode 1 = smoothstep-eased. */
export const Mover = defineComponent('Mover', {
  mode: { type: 'u32', default: 0 },
});

/** The x the linear cube should be at for normalized time u. */
export function linearX(u: number): number {
  return X_START + (X_END - X_START) * u;
}

/** The x the eased cube should be at for normalized time u (smoothstep-remapped). */
export function easedX(u: number): number {
  return X_START + (X_END - X_START) * easing.smoothstep(u);
}

/** Build the easing World: a linear cube (top lane) + a smoothstep-eased cube (bottom lane) + light + camera. */
export function buildEasingWorld(world: World): void {
  const linMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.5, 0.6, 0.9, 1] }),
  );
  const easeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.9, 0.6, 0.3, 1] }),
  );

  world.spawn(
    { component: Transform, data: { pos: [X_START, Y_LINEAR, 0], quat: [0, 0, 0, 1], scale: [0.7, 0.7, 0.7] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [linMat] } },
    { component: Mover, data: { mode: 0 } },
  );
  world.spawn(
    { component: Transform, data: { pos: [X_START, Y_EASED, 0], quat: [0, 0, 0, 1], scale: [0.7, 0.7, 0.7] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [easeMat] } },
    { component: Mover, data: { mode: 1 } },
  );

  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.4, -0.6, -0.6], color: [1, 1, 1], intensity: 3, castShadow: false },
  });

  const eye: [number, number, number] = [0, 0, 12];
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
 * Place both movers for normalized time `u` in [0,1]: the linear cube at linearX(u), the eased
 * cube at easedX(u) (smoothstep-remapped). Pure function of (world, u).
 */
export function stepEasing(world: World, u: number): void {
  const query = world.query({ read: [Mover], with: [Transform] }).unwrap();
  const rows: Array<{ handle: EntityHandle; mode: number; y: number }> = [];
  for (const row of query) rows.push({ handle: row.entity, mode: row.get(Mover).mode, y: 0 });
  for (const row of rows) {
    const t = world.get(row.handle, Transform);
    if (!t.ok) continue;
    const y = t.value.pos[1] ?? 0;
    const x = row.mode === 1 ? easedX(u) : linearX(u);
    world.set(row.handle, Transform, { pos: [x, y, 0] });
  }
}
