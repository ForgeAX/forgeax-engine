import { type Point2, resolveCurveSpec } from '@forgeax/engine-modeling';

/**
 * The C-100 S2 draft body outlines C-106 is fit to (meters, Y up, nose +Z, wheelbase center
 * on the origin), frozen on 2026-10-22 when C-100 moved to the measured blueprint (S6a): the
 * author-traced side, plan and section keys, the part splits and the wheels of that draft.
 */
const L = 4.947;
const W = 2.033;
const H = 1.16;
const HALF_BASE = 2.779 / 2;
const NOSE = HALF_BASE + 1.095;
const TAIL = NOSE - L;
const FLOOR = 0.12;
const FIT_TOLERANCE = 0.004;
const tire = (width: number, aspect: number, rim: number) => rim * 0.0254 + 2 * width * aspect;

type Key = readonly [number, number];

function trace(keys: readonly Key[], box: readonly [number, number, number, number]): [number, number][] {
  const traced = resolveCurveSpec({ kind: 'spline', points: keys }, { closed: true, tolerance: 0.0005 });
  if (!traced.ok) throw traced.error;
  const [u0, v0, u1, v1] = traced.value.bounds;
  return traced.value.points.map((p) => [box[0] + ((p[0] - u0) * (box[2] - box[0])) / (u1 - u0), box[1] + ((p[1] - v0) * (box[3] - box[1])) / (v1 - v0)]);
}

const mirrored = (half: readonly Key[]): Key[] =>
  [...half, ...[...half].reverse().map(([x, y]): Key => [-x, y])].filter((p, i, all) => i === 0 || p[0] !== all[i - 1]?.[0] || p[1] !== all[i - 1]?.[1]);

const SIDE_KEYS: readonly Key[] = (
  [
    [NOSE - 0.04, FLOOR + 0.03], [NOSE, 0.3], [NOSE - 0.1, 0.46], [NOSE - 0.75, 0.6], [1.1, 0.72], [0.6, 0.98], [0.15, H], [-0.5, H - 0.02],
    [-1.2, 1.02], [-1.9, 0.97], [TAIL + 0.08, 0.92], [TAIL, 0.62], [TAIL + 0.06, 0.3], [-2.1125, FLOOR + 0.06], [-HALF_BASE, FLOOR], [HALF_BASE, FLOOR],
  ] as const
).map(([z, y]): Key => [-z, y]);
const TOP_KEYS: readonly Key[] = mirrored(
  ([[0, NOSE], [0.55, NOSE - 0.04], [0.88, NOSE - 0.4], [W / 2, HALF_BASE + 0.1], [0.95, 0.4], [0.94, -0.4], [W / 2, -HALF_BASE], [0.95, TAIL + 0.25], [0.7, TAIL + 0.02], [0, TAIL]] as const).map(([x, z]): Key => [x, -z]),
);
const FRONT_KEYS: readonly Key[] = mirrored([[0, FLOOR], [0.88, FLOOR], [W / 2, 0.45], [W / 2 - 0.03, 0.82], [0.8, 0.92], [0.58, H - 0.03], [0, H]] as const);

/** A trace reduced to a few smooth keys within FIT_TOLERANCE. */
function fitted(points: [number, number][]): readonly Point2[] {
  const r = resolveCurveSpec({ kind: 'fit', points }, { closed: true, tolerance: FIT_TOLERANCE });
  if (!r.ok) throw r.error;
  return r.value.points;
}

/** The fitted outlines: side (`right` view: u = -z, v = y), plan (`top`: u = x, v = -z) and section (`front`: u = x, v = y). */
export const OUTLINES = {
  side: fitted(trace(SIDE_KEYS, [-NOSE, FLOOR, -TAIL, H])),
  plan: fitted(trace(TOP_KEYS, [-W / 2, -NOSE, W / 2, -TAIL])),
  section: fitted(trace(FRONT_KEYS, [-W / 2, FLOOR, W / 2, H])),
} as const;

export const SPLITS = { bumper: NOSE - 0.3, cowl: 1.0, doorFront: 0.6, doorRear: -0.47, intakeRear: -0.98, deck: -0.55, tail: TAIL + 0.3, belt: 0.88 } as const;

export const WHEELS = [
  { name: 'fl', z: HALF_BASE, x: 0.85, d: tire(0.265, 0.35, 20), w: 0.265, rim: 20 * 0.0254 },
  { name: 'fr', z: HALF_BASE, x: -0.85, d: tire(0.265, 0.35, 20), w: 0.265, rim: 20 * 0.0254 },
  { name: 'rl', z: -HALF_BASE, x: 0.81, d: tire(0.345, 0.3, 21), w: 0.345, rim: 21 * 0.0254 },
  { name: 'rr', z: -HALF_BASE, x: -0.81, d: tire(0.345, 0.3, 21), w: 0.345, rim: 21 * 0.0254 },
] as const;
