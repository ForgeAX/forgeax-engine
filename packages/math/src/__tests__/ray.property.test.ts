// ray.property.test.ts — fast-check round-trip property (feat-20260617-host-engine-contract-and-video-cutscene M2 w7)
//
// world -> screen -> world round-trip on a realistic view-projection (lookAt + perspective):
//   screenToRay(worldToScreen(v)) yields a Ray that passes through v, for v inside the frustum.
//
// On-screen domain only: screenToRay clamps off-screen pixel coords back to the viewport edge
// (research Finding 6 / R-5), so off-screen points do not round-trip. We sample world points
// roughly inside the frustum the VP below describes, and assert onScreen before checking.
//
// EPS_MAT4_MUL3 = 1e-3 (two w-divides + a matrix invert; borrowed from mat4.property.test.ts:214-253).
// >= 100 samples (default numRuns).
//
// Related: requirements AC-02; plan-strategy §5.2 (R-5: arbitrary restricted to on-screen domain);
//          research Finding 6 (screenToRay clamps screen coords).

import { fc, test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import * as mat4 from '../mat4';
import * as ray from '../ray';
import type { Mat4, Vec2, Vec3 } from '../types';
import * as vec2 from '../vec2';
import { EPS_MAT4_MUL3 } from './_arbs';

const NUM_RUNS = Number.parseInt(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.PROPERTY_NUM_RUNS ?? '100',
  10,
);

const CANVAS_W = 800;
const CANVAS_H = 600;
const FOV = Math.PI / 3;
const ASPECT = CANVAS_W / CANVAS_H;
const NEAR = 0.1;
const FAR = 100;

/** Build the reference forward-looking view-projection (camera at origin, looking down -z). */
function makeVP(): Mat4 {
  const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
  const proj = mat4.perspective(mat4.create(), FOV, ASPECT, NEAR, FAR);
  return mat4.multiply(mat4.create(), proj, view);
}

/** Distance from point p to the line defined by the ray (origin o, unit direction d). */
function pointToRayDistance(p: Vec3, r: ray.Ray): number {
  const ox = r[0] as number;
  const oy = r[1] as number;
  const oz = r[2] as number;
  const dx = r[3] as number;
  const dy = r[4] as number;
  const dz = r[5] as number;
  const wx = (p[0] as number) - ox;
  const wy = (p[1] as number) - oy;
  const wz = (p[2] as number) - oz;
  // perpendicular component = w - (w·d) d  (d is unit length)
  const t = wx * dx + wy * dy + wz * dz;
  const px = wx - t * dx;
  const py = wy - t * dy;
  const pz = wz - t * dz;
  return Math.sqrt(px * px + py * py + pz * pz);
}

describe('ray world->screen->world round-trip (AC-02)', () => {
  test.prop(
    {
      // World points roughly inside the frustum the VP above describes (in front of camera).
      v: fc
        .tuple(
          fc.float({ min: -2, max: 2, noNaN: true }),
          fc.float({ min: -2, max: 2, noNaN: true }),
          fc.float({ min: -8, max: -2, noNaN: true }),
        )
        .map(([x, y, z]) => Float32Array.of(x, y, z) as Vec3),
    },
    { numRuns: NUM_RUNS },
  )('on-screen point lies on screenToRay(worldToScreen(v))', ({ v }) => {
    const VP = makeVP();

    const px = vec2.create() as Vec2;
    const { onScreen, behind } = ray.worldToScreen(px, v, VP, CANVAS_W, CANVAS_H);

    // Restrict the property to the on-screen domain: off-screen pixels are clamped by
    // screenToRay and would not round-trip (R-5).
    if (behind || !onScreen) return true;

    const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), FOV, ASPECT, NEAR, FAR);
    const r = ray.screenToRay(
      ray.create(),
      px[0] as number,
      px[1] as number,
      CANVAS_W,
      CANVAS_H,
      view,
      proj,
      'perspective',
    );

    // v must lie on the recovered ray within the chained-mul tolerance.
    return pointToRayDistance(v, r) < EPS_MAT4_MUL3;
  });
});

void fc;
void expect;
