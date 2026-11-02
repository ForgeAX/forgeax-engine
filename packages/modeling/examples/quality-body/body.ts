import {
  type Model,
  model,
  type NurbsCurve,
  type NurbsSurface,
  nurbs,
  type Tuple3,
} from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-114: a car-like body corner (hood, fender and door with a waist crease), built
 * the right way and the wrong way. x runs along the car, y up, z outward; the
 * centerline is z = 0.
 *
 * Right: a feature-line network first (shoulder, waist and sill lines, few control
 * points, fair), panels lofted between the lines (<= 8 x 6 control points), the two
 * creases held by small rolling-ball blends, exported along the isoparms as quads.
 * Wrong: the same shape traced as noisy samples on a uniform grid and interpolated into
 * one dense patch, the way the first F1 body was made: the creases are smeared across
 * grid cells and the noise ripples the highlights.
 */
export const BODY = {
  length: 1.2,
  /** Shoulder crease: hood meets fender. */
  shoulder: { z: 0.42, y: 0.5, rise: 0.03 },
  /** Waist crease: fender meets door. */
  waist: { z: 0.47, y: 0.3, rise: 0.012 },
  sill: { z: 0.44, y: 0 },
  crown: 0.06,
  /** Blend radii (meters) and continuity of the two creases. */
  shoulderBlend: 0.005,
  waistBlend: 0.003,
  /** Wrong way: trace noise (meters) and the dense interpolation grid. */
  noise: 0.0004,
  grid: [24, 18] as [number, number],
  /** Fitted way: fairing of the panel fits. */
  fitFair: { rate: 1e-6 } as { readonly bend?: number; readonly rate?: number },
  /** Degree and control points of the panel fits along the car. */
  fitAlong: [3, 4] as readonly [number, number],
} as const;

const STATIONS = [0, 0.25, 0.5, 0.75, 1];

/** A longitudinal line through `at(t)` (t from 0 to 1 along x), fit with 4 control points. */
function line(at: (t: number) => Tuple3): NurbsCurve {
  const fit = nurbs.approximate(
    STATIONS.map((t) => at(t)),
    { controlPoints: 4, degree: 3 },
  );
  if (!fit.ok) throw fit.error;
  return fit.value;
}

const bump = (t: number) => 4 * t * (1 - t);

/** The feature-line network and the in-between lines the panels loft through. */
export function network() {
  const L = BODY.length;
  const { shoulder: s, waist: w, sill, crown } = BODY;
  const shoulder = line((t) => [L * t, s.y + s.rise * bump(t), s.z]);
  const waist = line((t) => [L * t, w.y + w.rise * bump(t), w.z]);
  const sillLine = line((t) => [L * t, sill.y, sill.z]);
  const center = line((t) => [L * t, s.y + s.rise * bump(t) + crown, 0]);
  const hoodMid = line((t) => [L * t, s.y + s.rise * bump(t) + crown * 0.62, s.z * 0.55]);
  const fenderMid = line((t) => [L * t, (s.y + w.y) / 2 + 0.01 * bump(t), s.z + 0.04]);
  const doorMid = line((t) => [L * t, w.y / 2, w.z - 0.01]);
  return { shoulder, waist, sill: sillLine, center, hoodMid, fenderMid, doorMid };
}

/** Lofts run along x and down the section, so their normals face inward: patches flip. */
function loft(curves: readonly NurbsCurve[]): NurbsSurface {
  const s = nurbs.loft(curves, { degree: 2 });
  if (!s.ok) throw s.error;
  return s.value;
}

/**
 * The hood mid line, optionally zig-zagging by `ripple` meters through 8 interpolated
 * points: a sparse net can still be crumpled.
 */
function hoodMid(ripple: number): NurbsCurve {
  if (ripple === 0) return network().hoodMid;
  const L = BODY.length;
  const { shoulder: s, crown } = BODY;
  const fit = nurbs.interpolate(
    Array.from({ length: 8 }, (_, k): Tuple3 => {
      const t = k / 7;
      const zig = k > 0 && k < 7 ? ripple * (k % 2 === 1 ? 1 : -1) : 0;
      return [L * t, s.y + s.rise * bump(t) + crown * 0.62 + zig, s.z * 0.55];
    }),
  );
  if (!fit.ok) throw fit.error;
  return fit.value;
}

export function panels(ripple = 0) {
  const n = network();
  return {
    hood: loft([n.center, hoodMid(ripple), n.shoulder]),
    fender: loft([n.shoulder, n.fenderMid, n.waist]),
    door: loft([n.waist, n.doorMid, n.sill]),
    lines: n,
  };
}

/** A rounded rectangle outline in view meters (corner radius `r`, 6 segments per corner). */
function slot(x0: number, y0: number, x1: number, y1: number, r: number): [number, number][] {
  const out: [number, number][] = [];
  const corners: [number, number, number][] = [
    [x1 - r, y0 + r, -90],
    [x1 - r, y1 - r, 0],
    [x0 + r, y1 - r, 90],
    [x0 + r, y0 + r, 180],
  ];
  for (const [cx, cy, start] of corners)
    for (let k = 0; k <= 6; k++) {
      const a = ((start + (90 * k) / 6) * Math.PI) / 180;
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  return out;
}

/**
 * Openings seen from the side (front view, x along the car, y up): a door-handle slot
 * and a window-style cut in the fender, both with 4 mm corners.
 */
export const OPENINGS = {
  handle: slot(0.74, 0.16, 0.88, 0.19, 0.004),
  window: slot(0.25, 0.36, 0.55, 0.44, 0.004),
};

/**
 * `blends: false` leaves the raw creases (the fillet tool card's before); `openings: true`
 * cuts the door-handle slot and the fender window (trim faces tagged `trim`).
 */
export function buildRight(
  session: SessionFactory = () => model(),
  options: {
    readonly blends?: boolean;
    readonly openings?: boolean;
    readonly ripple?: number;
    /** Ring of quads along the openings (meters, default 4 mm; 0 for none). */
    readonly trimRing?: number;
    /** Panels fitted to the noisy trace between the feature lines instead of lofted. */
    readonly fitted?: boolean;
  } = {},
): Model {
  const body = session('right');
  const { hood, fender, door, lines } =
    options.fitted === true ? fittedPanels() : panels(options.ripple ?? 0);
  // The feature-line table: each crease is a designed break held by a blend.
  body.featureLine({ name: 'shoulder', curve: lines.shoulder, continuity: 'G0' });
  body.featureLine({ name: 'waist', curve: lines.waist, continuity: 'G0' });
  body.featureLine({ name: 'sill', curve: lines.sill });
  body.surface({
    patches: [
      { name: 'hood', surface: hood, flip: true },
      {
        name: 'fender',
        surface: fender,
        flip: true,
        ...(options.openings === true ? { trims: [{ view: 'front' as const, region: OPENINGS.window }] } : {}),
      },
      {
        name: 'door',
        surface: door,
        flip: true,
        ...(options.openings === true ? { trims: [{ view: 'front' as const, region: OPENINGS.handle }] } : {}),
      },
    ],
    blends:
      options.blends === false
        ? []
        : [
            { between: ['hood', 'fender'], radius: BODY.shoulderBlend, continuity: 'G2', name: 'shoulder-blend' },
            { between: ['fender', 'door'], radius: BODY.waistBlend, continuity: 'G2', name: 'waist-blend' },
          ],
    chord: 0.0005,
    nonPlanar: 'keep',
    spacing: 'even',
    ...(options.openings === true ? { trimRing: options.trimRing ?? 0.004 } : {}),
    tag: 'body',
  });
  body.uv.project({ mode: 'box', scale: 1 });
  return body;
}

/** The right body's shape as a height field over (t along x, s down the section). */
function sample(t: number, s: number): Tuple3 {
  const { hood, fender, door } = panels();
  const at = (surface: NurbsSurface, v: number) => {
    const [[u0, u1], [v0, v1]] = nurbs.surfaceDomain(surface);
    return nurbs.surfacePoint(surface, u0 + (u1 - u0) * t, v0 + (v1 - v0) * v);
  };
  if (s < 1 / 3) return at(hood, s * 3);
  if (s < 2 / 3) return at(fender, s * 3 - 1);
  return at(door, Math.min(1, s * 3 - 2));
}

/** A blueprint trace of the right body: dense samples with a small deterministic error. */
export function trace(): Tuple3[][] {
  const [nx, ns] = BODY.grid;
  return Array.from({ length: nx }, (_, i) =>
    Array.from({ length: ns }, (_, j): Tuple3 => {
      const p = sample(i / (nx - 1), j / (ns - 1));
      const e = BODY.noise * Math.sin(i * 2.3 + j * 1.7) * Math.cos(i * 0.7 - j * 2.9);
      return [p[0], p[1] + e, p[2] + e];
    }),
  );
}

/** Wrong: the trace interpolated into one dense patch (the first F1 body's method). */
export function buildWrong(session: SessionFactory = () => model()): Model {
  const wrong = session('wrong');
  const dense = nurbs.grid(trace());
  if (!dense.ok) throw dense.error;
  const lines = network();
  wrong.featureLine({ name: 'shoulder', curve: lines.shoulder, continuity: 'G0' });
  wrong.featureLine({ name: 'waist', curve: lines.waist, continuity: 'G0' });
  wrong.featureLine({ name: 'sill', curve: lines.sill });
  wrong.surface({ patches: [{ name: 'body', surface: dense.value, flip: true }], chord: 0.0005, tag: 'body' });
  wrong.uv.project({ mode: 'box', scale: 1 });
  return wrong;
}

/**
 * Fitted panels: each panel is the trace rows between its two feature lines,
 * least-squares fit to a 4 x 5 net (one cubic span along the car, as the lines are)
 * with the lines as fixed boundaries and the curvature-rate fairing term, so the trace
 * noise does not reach the surface and the panels meet at the creases as the lofts do.
 * Bending fairing would flatten the crown and push curvature to the fixed edges; more
 * control points along the car let the noise ripple the near-straight door isoparms.
 */
export function fittedPanels(
  fair: { readonly bend?: number; readonly rate?: number } = BODY.fitFair,
  across: readonly [number, number] = [3, 5],
  lengthwise: readonly [number, number] = BODY.fitAlong,
) {
  const n = network();
  const rows = trace();
  const [nx] = BODY.grid;
  const along = (curve: NurbsCurve) =>
    Array.from({ length: nx }, (_, i) => nurbs.point(curve, i / (nx - 1)));
  const errors: number[] = [];
  const fit = (from: NurbsCurve, to: NurbsCurve, j0: number, j1: number): NurbsSurface => {
    const a = along(from);
    const b = along(to);
    const grid = rows.map((row, i) => [a[i] as Tuple3, ...row.slice(j0, j1), b[i] as Tuple3]);
    const out = nurbs.fitSurface(grid, {
      degree: [lengthwise[0], across[0]],
      net: [lengthwise[1], across[1]],
      boundaries: { v0: from, v1: to },
      fair,
    });
    if (!out.ok) throw out.error;
    errors.push(out.value.max);
    return out.value.surface;
  };
  // Trace columns j cover s = j / 17: hood s < 1/3, fender to 2/3, door after.
  const hood = fit(n.center, n.shoulder, 1, 6);
  const fender = fit(n.shoulder, n.waist, 6, 12);
  const door = fit(n.waist, n.sill, 12, 17);
  /** `errors`: largest distance from a trace point to its panel, per panel (m). */
  return { hood, fender, door, lines: n, errors };
}

/** The trace as one 8 x 6 patch: the fit cannot hold two creases (a patch-layout error). */
export function fittedSingle(): NurbsSurface {
  const fit = nurbs.fitSurface(trace(), { degree: [5, 5], net: [8, 6] });
  if (!fit.ok) throw fit.error;
  return fit.value.surface;
}
