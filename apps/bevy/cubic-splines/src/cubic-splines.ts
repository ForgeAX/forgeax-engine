// apps/bevy/cubic-splines - shared World builder + curve sampler (SSOT for the app
// AND the dawn smoke, imported by both via Node TS type-stripping so there is no
// duplicate-scene drift; memory smoke-script-duplicate-scene-must-stay-in-sync-with-main).
//
// Reproduces Bevy's `cubic_splines` example (references/repos/bevy/examples/math/
// cubic_splines.rs): a smooth curve passing through a set of control points, built via
// `CubicCardinalSpline::new_catmull_rom(points).to_curve()` and drawn as a dense polyline.
//
// forgeax mapping:
//   - CubicCardinalSpline::new_catmull_rom(pts).to_curve().position(t)
//                                   -> vec3.catmullRom(out, p0, p1, p2, p3, t) — the new
//                                   Catmull-Rom sampler (solo round 20260713-203432). Before
//                                   it, a demo needing a smooth path had to hand-roll the cubic
//                                   coefficient matrix. Sampling the whole curve = loop the
//                                   segments with a sliding 4-point window.
//   - draw_curve gizmo polyline    -> a "beads on the curve" bake: a small sphere at each
//                                   sampled point (forgeax has no immediate line gizmo wired in
//                                   this demo path; beads reuse the proven sphere render path
//                                   and make the curve shape readable + smoke-assertable). The
//                                   4 control points get larger, distinctly-colored spheres so
//                                   the eye + the smoke can confirm the curve passes through them.
//
// This is a STATIC demo (the curve is baked once), so the smoke is structural + shape-assertive
// (curve beads render, pass through the control points, and bend smoothly) — no per-frame motion.

import type { World } from '@forgeax/engine-ecs';
import { HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { quat, vec3 } from '@forgeax/engine-math';

/** The control points the curve passes through (a wavy path in the XY plane, z=0). */
export const CONTROL_POINTS: ReadonlyArray<readonly [number, number, number]> = [
  [-6, -2, 0],
  [-2, 3, 0],
  [2, -3, 0],
  [6, 2, 0],
];

/** Samples per curve segment — density of the bead polyline. */
export const SAMPLES_PER_SEGMENT = 16;

/**
 * Sample the Catmull-Rom curve through CONTROL_POINTS into a flat list of points.
 * For each interior segment [p_i, p_i+1] the neighbor points p_i-1 / p_i+2 set the
 * tangents; the endpoints duplicate the boundary control points (clamped ends), so the
 * curve starts exactly at the first control point and ends exactly at the last.
 * Pure function — used by the app bake, the smoke assertion, and testable in isolation.
 */
export function sampleCurve(
  points: ReadonlyArray<readonly [number, number, number]>,
  perSegment: number,
): Array<[number, number, number]> {
  const n = points.length;
  const out: Array<[number, number, number]> = [];
  const tmp = vec3.create();
  const at = (i: number): readonly [number, number, number] =>
    points[Math.max(0, Math.min(n - 1, i))] as readonly [number, number, number];
  for (let seg = 0; seg < n - 1; seg++) {
    const p0 = at(seg - 1);
    const p1 = at(seg);
    const p2 = at(seg + 1);
    const p3 = at(seg + 2);
    // Include t=0..(perSegment-1)/perSegment per segment; append the very last point after.
    for (let s = 0; s < perSegment; s++) {
      const t = s / perSegment;
      vec3.catmullRom(tmp, p0, p1, p2, p3, t);
      out.push([tmp[0] ?? 0, tmp[1] ?? 0, tmp[2] ?? 0]);
    }
  }
  const last = points[n - 1] as readonly [number, number, number];
  out.push([last[0], last[1], last[2]]);
  return out;
}

/**
 * Build the cubic-splines World: a bead per curve sample (small blue spheres) + a larger
 * distinctly-colored sphere at each control point + a directional light + a camera looking
 * at the curve plane.
 */
export function buildCubicSplinesWorld(world: World): void {
  const beadMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.3, 0.6, 1.0, 1] }),
  );
  const ctrlMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [1.0, 0.7, 0.15, 1], emissive: [0.5, 0.3, 0.05] }),
  );

  // Curve beads.
  const samples = sampleCurve(CONTROL_POINTS, SAMPLES_PER_SEGMENT);
  for (const [x, y, z] of samples) {
    world.spawn(
      { component: Transform, data: { pos: [x, y, z], quat: [0, 0, 0, 1], scale: [0.12, 0.12, 0.12] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
      { component: MeshRenderer, data: { materials: [beadMat] } },
    );
  }

  // Control-point markers (larger, orange).
  for (const [x, y, z] of CONTROL_POINTS) {
    world.spawn(
      { component: Transform, data: { pos: [x, y, z], quat: [0, 0, 0, 1], scale: [0.4, 0.4, 0.4] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
      { component: MeshRenderer, data: { materials: [ctrlMat] } },
    );
  }

  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.3, -0.5, -0.8], color: [1, 1, 1], intensity: 3, castShadow: false },
  });

  // Camera in front of the XY curve plane, looking at the origin.
  const eye: [number, number, number] = [0, 0, 16];
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
