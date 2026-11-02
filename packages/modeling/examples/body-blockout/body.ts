import {
  type Drawing,
  type Model,
  model,
  resolveCurveSpec,
  sel,
} from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { CAR, FRONT_TIRE_DIAMETER, REAR_TIRE_DIAMETER } from '../mech-gt/proportions.ts';

/**
 * Case C-105 (F1 S2 preview, code name mech-gt): the car body blocked out from three
 * views. The board holds the public dimensions and three outlines the author traced
 * as dense samples (side profile, plan, front section); the build fits a contour to
 * each trace within FIT_TOLERANCE, intersects the three view prisms, cuts the wheel
 * arches and adds the wheels. Meters, Y up, nose toward +Z, wheelbase center on the
 * origin, ground at y = 0 (the C-100 S1 frame).
 */
const L = CAR.length.value;
const W = CAR.width.value;
const H = CAR.height.value;
const HALF_BASE = CAR.wheelbase.value / 2;
const NOSE = HALF_BASE + CAR.frontOverhang.value;
const TAIL = NOSE - L;
const FLOOR = CAR.groundClearance.value;

/** Fit tolerance of the contours against the traced outlines. */
export const FIT_TOLERANCE = 0.004;

type Key = readonly [number, number];

/**
 * Dense trace through hand-placed key points (a closed centripetal spline sampled to
 * 0.5 mm), scaled onto its public envelope `[minU, minV, maxU, maxV]` so spline
 * overshoot never moves a published dimension.
 */
function trace(keys: readonly Key[], box: readonly [number, number, number, number]): [number, number][] {
  const traced = resolveCurveSpec({ kind: 'spline', points: keys }, { closed: true, tolerance: 0.0005 });
  if (!traced.ok) throw traced.error;
  const [u0, v0, u1, v1] = traced.value.bounds;
  return traced.value.points.map((p) => [
    box[0] + ((p[0] - u0) * (box[2] - box[0])) / (u1 - u0),
    box[1] + ((p[1] - v0) * (box[3] - box[1])) / (v1 - v0),
  ]);
}

const mirrored = (half: readonly Key[]): Key[] => [
  ...half,
  ...[...half].reverse().map(([x, y]): Key => [-x, y]),
];

/** Side profile in the `right` view: u = -z (the nose on the left), v = y. */
const SIDE_KEYS: readonly Key[] = (
  [
    [NOSE - 0.06, FLOOR + 0.06],
    [NOSE, 0.34],
    [NOSE - 0.12, 0.52],
    [NOSE - 0.9, 0.66],
    [0.95, 0.8],
    [0.28, H],
    [-0.55, H - 0.01],
    [-1.35, 1.0],
    [TAIL + 0.35, 0.93],
    [TAIL, 0.9],
    [TAIL + 0.02, 0.45],
    [TAIL + 0.22, FLOOR + 0.04],
    [-HALF_BASE, FLOOR],
    [HALF_BASE, FLOOR],
  ] as const
).map(([z, y]): Key => [-z, y]);

/** Plan in the `top` view: u = x, v = -z; the haunches carry the full width over the axles. */
const TOP_KEYS: readonly Key[] = mirrored(
  (
    [
      [0, NOSE],
      [0.62, NOSE - 0.06],
      [0.9, NOSE - 0.45],
      [W / 2, HALF_BASE],
      [0.93, 0.25],
      [W / 2, -HALF_BASE],
      [0.92, TAIL + 0.15],
      [0, TAIL],
    ] as const
  ).map(([x, z]): Key => [x, -z]),
).filter((p, i, all) => i === 0 || p[0] !== all[i - 1]?.[0] || p[1] !== all[i - 1]?.[1]);

/** Front section in the `front` view: u = x, v = y; tumblehome narrows the greenhouse. */
const FRONT_KEYS: readonly Key[] = mirrored(
  [
    [0, FLOOR],
    [0.9, FLOOR],
    [W / 2, 0.5],
    [W / 2 - 0.05, 0.8],
    [0.78, 0.9],
    [0.6, H - 0.02],
    [0, H],
  ] as const,
).filter((p, i, all) => i === 0 || p[0] !== all[i - 1]?.[0] || p[1] !== all[i - 1]?.[1]);

const SIDE_TRACE = trace(SIDE_KEYS, [-NOSE, FLOOR, -TAIL, H]);
const TOP_TRACE = trace(TOP_KEYS, [-W / 2, -NOSE, W / 2, -TAIL]);
const FRONT_TRACE = trace(FRONT_KEYS, [-W / 2, FLOOR, W / 2, H]);

const point = (id: string, view: string, at: [number, number]) => ({ id, view, role: 'package', kind: 'point', at }) as const;
/** A trace reduced to a few smooth keys within FIT_TOLERANCE: one of the hull's three-view contours. */
const fitted = (id: string, view: string, points: [number, number][]) =>
  ({ id, view, role: 'silhouette', kind: 'curve', closed: true, curve: { kind: 'fit', points }, tolerance: FIT_TOLERANCE }) as const;

/** The design drawing: public facts, estimates and the author's three traces. No images. */
export const BOARD: Drawing = {
  name: 'mech-gt car body',
  sources: [
    { title: 'C-100 S1 proportions (public dimensions, ISO tire sizes)', note: 'examples/mech-gt/proportions.ts' },
  ],
  views: [
    { id: 'side', ortho: 'right' },
    { id: 'plan', ortho: 'top' },
    { id: 'front', ortho: 'front' },
  ],
  items: [
    fitted('profile', 'side', SIDE_TRACE),
    fitted('plan outline', 'plan', TOP_TRACE),
    fitted('section', 'front', FRONT_TRACE),
    point('nose', 'side', [-NOSE, 0]),
    point('tail', 'side', [-TAIL, 0]),
    point('front axle', 'side', [-HALF_BASE, -0.12]),
    point('rear axle', 'side', [HALF_BASE, -0.12]),
    point('roof', 'front', [-W / 2 - 0.15, H]),
    point('left side', 'plan', [-W / 2, -NOSE - 0.1]),
    point('right side', 'plan', [W / 2, -NOSE - 0.1]),
    { id: 'length', view: 'side', role: 'package', kind: 'dimension', measure: 'distance', refs: ['nose', 'tail'], value: L, basis: 'public' },
    { id: 'wheelbase', view: 'side', role: 'package', kind: 'dimension', measure: 'distance', refs: ['front axle', 'rear axle'], value: CAR.wheelbase.value, basis: 'public' },
    { id: 'height', view: 'front', role: 'package', kind: 'dimension', measure: 'dy', refs: ['roof'], value: H, basis: 'public' },
    { id: 'width', view: 'plan', role: 'package', kind: 'dimension', measure: 'distance', refs: ['left side', 'right side'], value: W, basis: 'public' },
    { id: 'ground clearance', view: 'side', role: 'package', kind: 'dimension', measure: 'dy', refs: [], value: FLOOR, basis: 'estimate' },
  ],
};

/** Wheel centers and tire sizes from the S1 frame. */
export const WHEELS = [
  { name: 'fl', z: HALF_BASE, x: CAR.frontTrack.value / 2, d: FRONT_TIRE_DIAMETER, w: CAR.frontTireWidth.value },
  { name: 'fr', z: HALF_BASE, x: -CAR.frontTrack.value / 2, d: FRONT_TIRE_DIAMETER, w: CAR.frontTireWidth.value },
  { name: 'rl', z: -HALF_BASE, x: CAR.rearTrack.value / 2, d: REAR_TIRE_DIAMETER, w: CAR.rearTireWidth.value },
  { name: 'rr', z: -HALF_BASE, x: -CAR.rearTrack.value / 2, d: REAR_TIRE_DIAMETER, w: CAR.rearTireWidth.value },
] as const;

/** Clearance between a tire and its arch. */
const ARCH_GAP = 0.035;

/** A cylinder along X: built along +Y, turned onto X, then moved to `center`. */
function axleCylinder(
  m: Model,
  tag: string,
  radius: number,
  length: number,
  center: readonly [number, number, number],
  options: { readonly label?: string; readonly material?: string },
): void {
  m.cylinder({ radiusTop: radius, radiusBottom: radius, height: length, radialSegments: 32, tag, ...options });
  m.rotate(sel.tag(tag), 'z', 90);
  m.translate(sel.tag(tag), [center[0], center[1], center[2]]);
}

export function buildBody(session: SessionFactory = () => model()): Model {
  const m = session('body');
  m.drawing(BOARD);
  m.threeView(BOARD, ['profile', 'plan outline', 'section'], { label: 'hull', material: 'paint' });
  m.checkpoint('hull');
  // Wheel arches: a short cylinder per wheel, from inside the track out through the side.
  for (const wheel of WHEELS) {
    const inner = Math.abs(wheel.x) - wheel.w / 2 - ARCH_GAP;
    const length = W / 2 + 0.1 - inner;
    const x = Math.sign(wheel.x) * (inner + length / 2);
    axleCylinder(m, `arch-${wheel.name}`, wheel.d / 2 + ARCH_GAP, length, [x, wheel.d / 2, wheel.z], {
      material: 'trim',
    });
    m.difference(sel.tag(`arch-${wheel.name}`), { label: `arch-${wheel.name}`, material: 'trim' });
  }
  m.checkpoint('arches');
  // Greenhouse: the hull faces above the beltline between the A and C pillars become glass.
  m.assign(sel.material('paint').and(sel.inBox([-W, 0.9, -1.2], [W, H + 0.1, 0.85], { by: 'centroid' })), 'glass');
  for (const wheel of WHEELS) {
    axleCylinder(m, `wheel-${wheel.name}`, wheel.d / 2, wheel.w, [wheel.x, wheel.d / 2, wheel.z], {
      label: `wheel-${wheel.name}`,
      material: 'tire',
    });
  }
  m.markSharp(sel.edges.dihedral('>', 50));
  m.uv.project({ mode: 'box', scale: 1 });
  return m;
}
