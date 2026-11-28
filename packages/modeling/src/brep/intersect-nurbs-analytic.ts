import { ok, type Result } from '@forgeax/engine-types';
import { hypot3 } from '../dmath';
import type { ModelingError } from '../errors';
import type { IntersectionBranch, IntersectionWindow, SurfaceIntersection } from './intersect';
import { intersectFaces } from './ssi/intersect-faces';
import type { ParamBox, SsiBranch, SsiResult } from './ssi/types';
import type { Surface } from './types';
import { deepFreeze } from './types';
import type { P3 } from './vec';

type NurbsFace = Extract<Surface, { kind: 'nurbs' }>;
type AnalyticFace = Extract<Surface, { kind: 'plane' | 'cylinder' | 'sphere' | 'cone' | 'torus' }>;
type Ball = { readonly c: P3; readonly r: number };

const TWO_PI = 2 * Math.PI;

/**
 * The window ball when the caller gives one; otherwise the ball around the NURBS control net's
 * axis-aligned box. Rational weights are positive, so the surface lies inside its control hull.
 */
function coveringBall(nurbs: NurbsFace, region: IntersectionWindow | undefined): Ball {
  if (region !== undefined) return region;
  let [x0, y0, z0] = [Infinity, Infinity, Infinity];
  let [x1, y1, z1] = [-Infinity, -Infinity, -Infinity];
  for (const row of nurbs.surface.points) {
    for (const [x, y, z] of row) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      z0 = Math.min(z0, z);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      z1 = Math.max(z1, z);
    }
  }
  const c: P3 = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const r = hypot3(x1 - x0, y1 - y0, z1 - z0) / 2;
  return { c, r };
}

/**
 * Parameter box of an analytic face that covers every point of the ball. A plane's (x, y) and a
 * cylinder's axial v are bounded by |c - o| + r; the angular u is the full period. A sphere's v is
 * latitude (full range), a torus's v is the tube angle (full period), and a cone's v is the
 * axial distance (bounded like a cylinder's).
 */
function analyticBounds(s: AnalyticFace, ball: Ball): ParamBox {
  const [cx, cy, cz] = ball.c;
  const [ox, oy, oz] = s.frame.o;
  const dx = cx - ox;
  const dy = cy - oy;
  const dz = cz - oz;
  const m = Math.sqrt(dx * dx + dy * dy + dz * dz) + ball.r;
  switch (s.kind) {
    case 'plane':
      return [
        [-m, m],
        [-m, m],
      ];
    case 'sphere':
      return [
        [0, TWO_PI],
        [-Math.PI / 2, Math.PI / 2],
      ];
    case 'torus':
      return [
        [0, TWO_PI],
        [0, TWO_PI],
      ];
    case 'cylinder':
    case 'cone':
      return [
        [0, TWO_PI],
        [-m, m],
      ];
  }
}

/** Result-shape adapter: one marched SSI branch as the boolean-facing `IntersectionBranch`. */
function adapt(b: SsiBranch, nurbsIsA: boolean): IntersectionBranch {
  // intersectFaces always takes the NURBS face first, so SSI onA is its pcurve.
  const pcNurbs = { kind: 'nurbs' as const, curve: b.onA };
  const pcAnalytic = { kind: 'nurbs' as const, curve: b.onB };
  return {
    curve: { kind: 'nurbs', curve: b.curve },
    t0: 0,
    t1: 1,
    closed: b.closed,
    onA: nurbsIsA ? pcNurbs : pcAnalytic,
    onB: nurbsIsA ? pcAnalytic : pcNurbs,
    receipt: { bound: b.bound },
  };
}

/**
 * NURBS x plane or cylinder through the marched SSI route. `nurbsIsA` says which operand of the
 * public call the NURBS face is, so the pcurves land on the matching `onA` / `onB`. Without a
 * window, the trace covers the NURBS control net. Any ssi `partial` is returned as a partial with
 * its code, never as an empty success.
 */
export function nurbsAnalyticSection(
  nurbs: NurbsFace,
  analytic: AnalyticFace,
  nurbsIsA: boolean,
  o: {
    readonly region: IntersectionWindow | undefined;
    readonly tol: number;
    readonly ids: readonly [number, number];
  },
): Result<SurfaceIntersection, ModelingError> {
  const { region, tol, ids } = o;
  // A patch wholly in the plane has no sign change for the marcher to find. Its control hull is
  // the surface's hull, so every control point on the plane within tol is a coincident contact.
  if (analytic.kind === 'plane') {
    const [ox, oy, oz] = analytic.frame.o;
    const [nx, ny, nz] = analytic.frame.z;
    let gap = 0;
    for (const row of nurbs.surface.points)
      for (const [x, y, z] of row)
        gap = Math.max(gap, Math.abs((x - ox) * nx + (y - oy) * ny + (z - oz) * nz));
    if (gap <= tol)
      return ok(
        deepFreeze({
          branches: [],
          partials: [{ code: 'brep-ssi-coincident', surfaces: ids, gap }],
        }),
      );
  }
  const ball = coveringBall(nurbs, region);
  const r = intersectFaces(
    { surface: nurbs },
    { surface: analytic, bounds: analyticBounds(analytic, ball) },
    { tol },
  );
  if (!r.ok) return r;
  return ok(deepFreeze(sectionFromSsi(r.value, ids, nurbsIsA)));
}

/**
 * The public section of one SSI result whose first face is the NURBS face (`nurbsIsA` puts its
 * pcurve on `onA` of the caller's order). Any ssi `issue` is a partial with its code: tangent
 * contacts keep the tangent code and every other stop is unsupported, never dropped.
 */
export function sectionFromSsi(
  r: SsiResult,
  ids: readonly [number, number],
  nurbsIsA: boolean,
): SurfaceIntersection {
  const partials = r.issues.map((i) => ({
    code: (i.reason === 'ssi-tangent-contact' || i.reason === 'ssi-near-tangent'
      ? 'brep-ssi-tangent'
      : 'brep-ssi-unsupported') as 'brep-ssi-tangent' | 'brep-ssi-unsupported',
    surfaces: ids,
    gap: null,
    reason: i.reason,
  }));
  return { branches: r.branches.map((b) => adapt(b, nurbsIsA)), partials };
}
