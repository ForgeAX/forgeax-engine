import {
  type Drawing,
  type DrawingItem,
  type FaceSelector,
  type Model,
  model,
  sel,
  type Tuple3,
} from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { CAR, CAR_STATIONS, FRONT_TIRE_DIAMETER, fitX, fitY, fitZ, REAR_TIRE_DIAMETER } from './proportions.ts';
import { featureLines, planHalfWidth, sectionHalfWidth, sideOutline } from './reference.ts';

/**
 * Case C-100 stage S2 (code name mech-gt): the car body block from three views, on the
 * S1 frame (meters, Y up, nose +Z, wheelbase center on the origin, ground y = 0). The
 * board holds the S1 public dimensions and the three outlines measured from the public
 * blueprint (criterion 9, `reference.ts`); the hull
 * is their three-view intersection. Bisect planes at the part boundaries split it into
 * the large faces of the `parts.json` body parts, booleans open the wheel arches, the
 * side intakes ahead of the rear wheels and the front intakes, and the cabin gets its
 * glass. Every body face carries exactly one part tag, so S3 refines parts, not a hull.
 */
const L = CAR.length.value;
const W = CAR.width.value;
const H = CAR.height.value;
const HALF_BASE = CAR.wheelbase.value / 2;
const NOSE = HALF_BASE + CAR.frontOverhang.value;
const TAIL = NOSE - L;
export const FLOOR = CAR.groundClearance.value;

/** Fit tolerance of the contours against the traced outlines. */
export const FIT_TOLERANCE = 0.004;

/**
 * The body outlines are the public blueprint's (criterion 9; `reference.ts`), placed on the
 * S1 car: the side silhouette above the ground clearance, and the mirror-free plan and
 * section half-widths, sampled every centimeter.
 */
export const ON_CAR = { stations: CAR_STATIONS, width: W, height: H } as const;
const STEP = 0.01;
/** The plan and section outlines reach this far past the side outline's nose, tail, floor and roof, so only one view bounds each. */
const OVER = 0.01;
/**
 * The section outline runs this much wider than measured, so the plan alone bounds the
 * widest band: where both views reach the same width their prisms meet tangentially and
 * the intersection leaves slivers (or fails) as the proportions move.
 */
export const SECTION_MARGIN = 0.01;

/** Side profile, `right` view (u = -z, v = y). */
/** Outline points closer than MIN_EDGE to the last kept one go: the floor clip lands next to sampled points. */
const MIN_EDGE = 0.004;
const SIDE_TRACE: [number, number][] = sideOutline(ON_CAR, FLOOR)
  .map(([z, y]): [number, number] => [-z, y])
  .reduce<[number, number][]>((kept, p) => {
    const last = kept.at(-1);
    if (last === undefined || Math.hypot(p[0] - last[0], p[1] - last[1]) >= MIN_EDGE) kept.push(p);
    return kept;
  }, []);

/** Plan, `top` view (u = x, v = -z): mirror-free half-width along the car, both sides. */
const TOP_TRACE: [number, number][] = (() => {
  const n = Math.round((NOSE - TAIL) / STEP);
  const half = Array.from({ length: n - 1 }, (_, k) => TAIL + ((NOSE - TAIL) * (k + 1)) / n).map((z): [number, number] => [planHalfWidth(ON_CAR, z), -z]);
  return [[0, -TAIL + OVER], ...half, [0, -NOSE - OVER], ...[...half].reverse().map(([x, v]): [number, number] => [-x, v])];
})();

/** Section, `front` view (u = x, v = y): mirror-free half-width over the height, both sides. */
const FRONT_TRACE: [number, number][] = (() => {
  const n = Math.round((H - FLOOR) / STEP);
  const half = Array.from({ length: n - 1 }, (_, k) => FLOOR + ((H - FLOOR) * (k + 1)) / n).map((y): [number, number] => [sectionHalfWidth(ON_CAR, y) + SECTION_MARGIN, y]);
  const base = sectionHalfWidth(ON_CAR, FLOOR + STEP) + SECTION_MARGIN;
  return [[-base, FLOOR - OVER], [base, FLOOR - OVER], ...half, [0, H + OVER], ...[...half].reverse().map(([x, y]): [number, number] => [-x, y])];
})();

/** The S1 proportion frame drawn into each view: envelope rectangles, wheel circles and footprints. */
const rect = (u0: number, v0: number, u1: number, v1: number): [number, number][] => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
const loop = (id: string, view: string, role: 'package' | 'construction', points: [number, number][]): DrawingItem => ({ id, view, role, kind: 'curve', closed: true, curve: { kind: 'polyline', points } });
const S1_FRAME: DrawingItem[] = [
  loop('S1 envelope (side)', 'side', 'package', rect(-NOSE, 0, -TAIL, H)),
  { id: 'S1 front wheel', view: 'side', role: 'package', kind: 'curve', closed: true, curve: { kind: 'arc', center: [-HALF_BASE, FRONT_TIRE_DIAMETER / 2], radius: FRONT_TIRE_DIAMETER / 2, from: 0, to: 2 * Math.PI } },
  { id: 'S1 rear wheel', view: 'side', role: 'package', kind: 'curve', closed: true, curve: { kind: 'arc', center: [HALF_BASE, REAR_TIRE_DIAMETER / 2], radius: REAR_TIRE_DIAMETER / 2, from: 0, to: 2 * Math.PI } },
  loop('S1 envelope (plan)', 'plan', 'package', rect(-W / 2, -NOSE, W / 2, -TAIL)),
  ...[1, -1].flatMap((sign) => [
    loop(`S1 front tire ${sign > 0 ? 'l' : 'r'}`, 'plan', 'package', rect(sign * CAR.frontTrack.value / 2 - CAR.frontTireWidth.value / 2, -HALF_BASE - FRONT_TIRE_DIAMETER / 2, sign * CAR.frontTrack.value / 2 + CAR.frontTireWidth.value / 2, -HALF_BASE + FRONT_TIRE_DIAMETER / 2)),
    loop(`S1 rear tire ${sign > 0 ? 'l' : 'r'}`, 'plan', 'package', rect(sign * CAR.rearTrack.value / 2 - CAR.rearTireWidth.value / 2, HALF_BASE - REAR_TIRE_DIAMETER / 2, sign * CAR.rearTrack.value / 2 + CAR.rearTireWidth.value / 2, HALF_BASE + REAR_TIRE_DIAMETER / 2)),
  ]),
  loop('S1 envelope (front)', 'front', 'package', rect(-W / 2, 0, W / 2, H)),
];

const point = (id: string, view: string, at: [number, number]): DrawingItem => ({ id, view, role: 'package', kind: 'point', at });
const fitted = (id: string, view: string, points: [number, number][]): DrawingItem => ({ id, view, role: 'silhouette', kind: 'curve', closed: true, curve: { kind: 'fit', points }, tolerance: FIT_TOLERANCE });

/** The side-intake opening in the side view, `[z, y]`: the blueprint's outline on the car (criterion 9). */
export const INTAKE: readonly (readonly [number, number])[] = (() => {
  const line = featureLines('sideIntake', ON_CAR)[0] ?? [];
  // The drawn outline closes on itself: drop the end that doubles back onto the start.
  const first = line[0] as readonly [number, number];
  let last = line.length - 1;
  while (last > 0 && Math.hypot((line[last] as readonly number[])[0] as number - first[0], ((line[last] as readonly number[])[1] as number) - first[1]) < 0.04) last--;
  // Points closer than 1 cm to the last kept one go: the drawing's dense corners.
  const kept: (readonly [number, number])[] = [];
  for (const q of line.slice(0, last + 1)) {
    const prev = kept.at(-1);
    if (prev === undefined || Math.hypot(q[0] - prev[0], q[1] - prev[1]) >= 0.01) kept.push([q[0], q[1]]);
  }
  return kept;
})();

/** The design drawing: S1 public facts, estimates and the three traces. No images. */
export const BOARD: Drawing = {
  name: 'mech-gt S2 body',
  sources: [
    { title: 'C-100 S1 proportion frame (public dimensions, ISO tire sizes)', note: 'examples/mech-gt/proportions.ts' },
    { title: 'Public three-view blueprint, measured (criterion 9)', note: 'examples/mech-gt/reference/blueprint.json; the drawing is not stored' },
  ],
  views: [
    { id: 'side', ortho: 'right' },
    { id: 'side-right', ortho: 'left' },
    { id: 'plan', ortho: 'top' },
    { id: 'front', ortho: 'front' },
  ],
  items: [
    // The measured blueprint traces, fitted within FIT_TOLERANCE: the hull's three-view contours.
    fitted('profile', 'side', SIDE_TRACE),
    fitted('plan outline', 'plan', TOP_TRACE),
    fitted('section', 'front', FRONT_TRACE),
    ...S1_FRAME,
    point('nose', 'side', [-NOSE, 0]),
    point('tail', 'side', [-TAIL, 0]),
    point('front axle', 'side', [-HALF_BASE, 0]),
    point('rear axle', 'side', [HALF_BASE, 0]),
    point('roof', 'front', [-W / 2 - 0.15, H]),
    point('left side', 'plan', [-W / 2, -NOSE - 0.12]),
    point('right side', 'plan', [W / 2, -NOSE - 0.12]),
    { id: 'length', view: 'side', role: 'package', kind: 'dimension', measure: 'distance', refs: ['nose', 'tail'], value: L, basis: 'public' },
    { id: 'wheelbase', view: 'side', role: 'package', kind: 'dimension', measure: 'distance', refs: ['front axle', 'rear axle'], value: CAR.wheelbase.value, basis: 'public' },
    { id: 'height', view: 'front', role: 'package', kind: 'dimension', measure: 'dy', refs: ['roof'], value: H, basis: 'public' },
    { id: 'width', view: 'plan', role: 'package', kind: 'dimension', measure: 'distance', refs: ['left side', 'right side'], value: W, basis: 'public' },
    { id: 'front overhang (blueprint)', view: 'side', role: 'package', kind: 'dimension', measure: 'dx', refs: [], value: CAR.frontOverhang.value, basis: 'blueprint' },
    { id: 'ground clearance (blueprint)', view: 'side', role: 'package', kind: 'dimension', measure: 'dy', refs: [], value: FLOOR, basis: 'blueprint' },
    // Opening tools: the side intakes (the blueprint outline, both sides) and the two front intakes in the bumper corners.
    loop('intake-l', 'side', 'construction', INTAKE.map(([z, y]): [number, number] => [-z, y])),
    loop('intake-r', 'side-right', 'construction', INTAKE.map(([z, y]): [number, number] => [z, y])),
    ...([1, -1] as const).map((sign) =>
      loop(sign > 0 ? 'front-intake-l' : 'front-intake-r', 'front', 'construction', [[sign * fitX(0.42), fitY(0.2)], [sign * fitX(0.82), fitY(0.2)], [sign * fitX(0.78), fitY(0.36)], [sign * fitX(0.46), fitY(0.36)]]),
    ),
  ],
};


export const WHEELS = [
  { name: 'fl', z: HALF_BASE, x: CAR.frontTrack.value / 2, d: FRONT_TIRE_DIAMETER, w: CAR.frontTireWidth.value, rim: CAR.frontRimInches.value * 0.0254 },
  { name: 'fr', z: HALF_BASE, x: -CAR.frontTrack.value / 2, d: FRONT_TIRE_DIAMETER, w: CAR.frontTireWidth.value, rim: CAR.frontRimInches.value * 0.0254 },
  { name: 'rl', z: -HALF_BASE, x: CAR.rearTrack.value / 2, d: REAR_TIRE_DIAMETER, w: CAR.rearTireWidth.value, rim: CAR.rearRimInches.value * 0.0254 },
  { name: 'rr', z: -HALF_BASE, x: -CAR.rearTrack.value / 2, d: REAR_TIRE_DIAMETER, w: CAR.rearTireWidth.value, rim: CAR.rearRimInches.value * 0.0254 },
] as const;

const ARCH_GAP = 0.035;

/** Part boundaries along the car (z) and the beltline (y) where the hull is bisected (nominal stations through `fit`). */
export const SPLITS = { bumper: NOSE - 0.3, cowl: fitZ(1.0), doorFront: fitZ(0.6), doorRear: fitZ(-0.47), intakeRear: fitZ(-0.98), deck: fitZ(-0.55), tail: TAIL + 0.3, belt: fitY(0.88) } as const;

/** The large body faces in assignment order: each takes the faces no earlier one took. */
export const BODY_PARTS = [
  'front-bumper',
  'rear-diffuser',
  'monocoque',
  'windshield',
  'roof',
  'hood',
  'engine-cover',
  'front-fender-l',
  'front-fender-r',
  'door-l',
  'door-r',
  'side-intake-l',
  'side-intake-r',
  'rear-fender-l',
  'rear-fender-r',
] as const;

/** A cylinder along X: built along +Y, turned onto X, moved to `center`. */
function axleCylinder(m: Model, tag: string, radius: number, length: number, center: readonly [number, number, number], options: { readonly label?: string; readonly material?: string }): void {
  m.cylinder({ radiusTop: radius, radiusBottom: radius, height: length, radialSegments: 32, tag, ...options });
  m.rotate(sel.tag(tag), 'z', 90);
  m.translate(sel.tag(tag), [center[0], center[1], center[2]]);
}

function partSelectors(): Record<(typeof BODY_PARTS)[number], FaceSelector> {
  const s = SPLITS;
  const zone = (z0: number, z1: number, y0 = -1, y1 = 2, x0 = -2, x1 = 2) => sel.inBox([x0, y0, z0], [x1, y1, z1], { by: 'centroid' });
  const left = (z0: number, z1: number) => zone(z0, z1, -1, 2, 0, 2);
  const right = (z0: number, z1: number) => zone(z0, z1, -1, 2, -2, 0);
  return {
    'front-bumper': zone(s.bumper, 9),
    'rear-diffuser': zone(-9, s.tail),
    monocoque: sel.facing('-y', 30),
    windshield: zone(s.doorFront - 0.1, s.cowl, s.belt).and(sel.facing('+y', 75)),
    roof: zone(s.deck, s.doorFront - 0.1, s.belt).and(sel.facing('+y', 30)),
    hood: zone(s.cowl, s.bumper).and(sel.facing('+y', 50)),
    'engine-cover': zone(s.tail, s.deck).and(sel.facing('+y', 50)),
    'front-fender-l': left(s.doorFront, s.bumper),
    'front-fender-r': right(s.doorFront, s.bumper),
    'door-l': left(s.doorRear, s.doorFront),
    'door-r': right(s.doorRear, s.doorFront),
    'side-intake-l': left(s.intakeRear, s.doorRear),
    'side-intake-r': right(s.intakeRear, s.doorRear),
    'rear-fender-l': left(s.tail, s.intakeRear),
    'rear-fender-r': right(s.tail, s.intakeRear),
  };
}

const WELD = 0.002;
/** Out-of-plane deviation (meters) above which a merged face stays triangulated. */
const PLANAR = 2e-5;

/** The number of face edges shorter than `length`. */
function shortEdges(m: Model, length: number): number {
  const mesh = m.editMesh;
  let n = 0;
  for (const f of mesh.faces()) {
    const ps = mesh.faceVertices(f).map((v) => mesh.position(v));
    for (let k = 0; k < ps.length; k++) {
      const [a, b] = [ps[k] as Tuple3, ps[(k + 1) % ps.length] as Tuple3];
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < length) n++;
    }
  }
  return n;
}

/** Centroids of the faces whose corners leave their mean plane by more than `deviation`. */
function bentFaces(m: Model, deviation: number): Tuple3[] {
  const mesh = m.editMesh;
  const out: Tuple3[] = [];
  for (const f of mesh.faces()) {
    const ps = mesh.faceVertices(f).map((v) => mesh.position(v));
    if (ps.length < 4) continue;
    const c: Tuple3 = [0, 1, 2].map((k) => ps.reduce((s, p) => s + (p[k] as number), 0) / ps.length) as Tuple3;
    // Newell normal.
    const nrm: Tuple3 = [0, 0, 0];
    for (let k = 0; k < ps.length; k++) {
      const [a, b] = [ps[k] as Tuple3, ps[(k + 1) % ps.length] as Tuple3];
      nrm[0] += (a[1] - b[1]) * (a[2] + b[2]);
      nrm[1] += (a[2] - b[2]) * (a[0] + b[0]);
      nrm[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const len = Math.hypot(...nrm);
    if (len === 0) continue;
    if (ps.some((p) => Math.abs(((p[0] - c[0]) * nrm[0] + (p[1] - c[1]) * nrm[1] + (p[2] - c[2]) * nrm[2]) / len) > deviation)) out.push(c);
  }
  return out;
}

export function buildS2Body(session: SessionFactory = () => model()): Model {
  const m = session('body');
  m.drawing(BOARD);
  // 2 mm clearance: the dense blueprint outlines meet at shared extremes; 0.5 mm leaves slivers the baseline boolean rejects.
  m.threeView(BOARD, ['profile', 'plan outline', 'section'], { clearance: 0.002, label: 'hull', material: 'paint' });
  m.checkpoint('hull');

  // Large faces: cut the hull at the part boundaries and the beltline.
  for (const z of [SPLITS.bumper, SPLITS.cowl, SPLITS.doorFront, SPLITS.doorRear, SPLITS.deck, SPLITS.intakeRear, SPLITS.tail]) {
    m.bisect({ point: [0, 0, z], normal: [0, 0, 1] });
  }
  m.bisect({ point: [0, SPLITS.belt, 0], normal: [0, 1, 0] });
  m.checkpoint('panels');

  // Wheel arches: a cylinder per wheel from inside the track out through the side.
  for (const wheel of WHEELS) {
    const inner = Math.abs(wheel.x) - wheel.w / 2 - ARCH_GAP;
    const length = W / 2 + 0.1 - inner;
    axleCylinder(m, `arch-${wheel.name}`, wheel.d / 2 + ARCH_GAP, length, [Math.sign(wheel.x) * (inner + length / 2), wheel.d / 2, wheel.z], { material: 'trim' });
    m.difference(sel.tag(`arch-${wheel.name}`), { label: `arch-${wheel.name}`, material: 'trim' });
  }
  m.checkpoint('arches');

  // Side intakes: a wedge in the flank between the door and the rear arch, 0.14 m deep.
  for (const label of ['intake-l', 'intake-r'] as const) {
    m.extrudeContour(BOARD, label, { depth: [W / 2 - 0.14, W / 2 + 0.15], label: `${label}-tool` });
    m.difference(sel.createdBy(`${label}-tool`), { label, material: 'intake' });
  }
  // Front intakes: two openings in the bumper corners.
  for (const label of ['front-intake-l', 'front-intake-r'] as const) {
    m.extrudeContour(BOARD, label, { depth: [NOSE - 0.22, NOSE + 0.1], label: `${label}-tool` });
    m.difference(sel.createdBy(`${label}-tool`), { label, material: 'intake' });
  }
  m.checkpoint('intakes');

  // Part tags: each body face gets the first part whose region it is in; cabin glass.
  const parts = partSelectors();
  let taken: FaceSelector | undefined;
  for (const part of BODY_PARTS) {
    const free = taken === undefined ? parts[part] : parts[part].minus(taken);
    m.tag(free, part);
    taken = taken === undefined ? sel.tag(part) : taken.or(sel.tag(part));
  }
  m.assign(sel.tag('windshield'), 'glass');
  m.assign(sideGlass(), 'glass');
  m.checkpoint('parts');
  // The arch and intake cuts can cross an outline edge next to its vertex; the millimeter
  // edges they leave would cap the wall thickness the body takes. Welding them bends the
  // faces around them out of plane: triangulate, merge each part's planar regions back, and
  // leave the regions that still bend as triangles.
  if (shortEdges(m, WELD) > 0) {
    m.weld({ distance: WELD });
    m.triangulate(sel.all());
    m.cleanup.planar();
    const bent = bentFaces(m, PLANAR);
    if (bent.length > 0) m.triangulate(bent.map(([x, y, z]) => sel.inBox([x - 1e-6, y - 1e-6, z - 1e-6], [x + 1e-6, y + 1e-6, z + 1e-6], { by: 'centroid' })).reduce((a, b) => a.or(b)));
  }

  for (const wheel of WHEELS) {
    axleCylinder(m, `wheel-${wheel.name}`, wheel.d / 2, wheel.w, [wheel.x, wheel.d / 2, wheel.z], { label: `wheel-${wheel.name}`, material: 'tire' });
    m.assign(sel.createdBy(`wheel-${wheel.name}`, 'top').or(sel.createdBy(`wheel-${wheel.name}`, 'bottom')), 'rim');
  }
  m.markSharp(sel.edges.dihedral('>', 50));
  m.uv.project({ mode: 'box', scale: 1 });
  return m;
}

/** Side glass: door and roof-side faces above the beltline that are not the roof itself. */
function sideGlass(): FaceSelector {
  return sel
    .inBox([-2, SPLITS.belt, SPLITS.doorRear - 0.1], [2, 2, SPLITS.doorFront], { by: 'centroid' })
    .and(sel.tag('door-l').or(sel.tag('door-r')));
}
