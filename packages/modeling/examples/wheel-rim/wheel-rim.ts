import { type FaceSelector, type Model, model, type Point2, sel, type Tuple3 } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { CAR } from '../mech-gt/proportions.ts';

/**
 * Case C-101 (a C-100 part): the cast alloy wheel rim of the car. A deep-dish face
 * disc is revolved (flat spokes recessed behind a conical lip ring, a raised hub with
 * a cap recess); its spoke windows are cut in one difference by a radial array of
 * corner-rounded window prisms (`array`), the window rims are chamfered,
 * and the lug seats, lug holes and center bore are drilled. The barrel is a revolved
 * section (inboard and outboard flanges, bead seats, drop center well) whose outboard
 * lip is rounded; the face is unioned into it and a valve-stem hole goes through the
 * well. Meters, the axle on +Y with the outboard face toward +Y and the barrel
 * centerline on y = 0. Straight-line code apart from one `for` loop over the spokes:
 * tools map every journal entry back to its source line.
 */
export interface WheelRimParameters {
  /** Bead seat diameter, the nominal rim size (meters; 20 in = 0.508). */
  readonly diameter: number;
  /** Rim width between the flanges (meters; 9.5 J = 0.2413). */
  readonly width: number;
  /** Number of spokes. */
  readonly spokes: number;
  /** Offset (ET): mounting face from the barrel centerline toward the face (meters). */
  readonly offset: number;
}

/** The C-100 front wheel: 20 in from the S1 proportion frame, 9.5 J for its 265 tire, ET 40. */
export const WHEEL_RIM_DEFAULTS: WheelRimParameters = {
  diameter: CAR.frontRimInches.value * 0.0254,
  width: 0.2413,
  spokes: 5,
  offset: 0.04,
};

/** Lug bolts on a 112 mm pitch circle. */
export const LUGS = 5;
export const PCD = 0.112;
export const LUG_HOLE = 0.0072;
const LUG_SEAT = 0.0115;
export const BORE = 0.0286;
/** Center cap recess radius and depth in the hub face. */
const CAP = 0.04;
const CAP_DEPTH = 0.004;
export const WALL = 0.006;
const FLANGE_HEIGHT = 0.0175;
export const FLANGE = 0.012;
export const WELL = 0.026;
const HUB_PAD = 0.075;
const HUB_BOSS = 0.006;
/** Spoke face depth behind the lip front, and spoke thickness. */
const LIP_DEPTH = 0.03;
const SPOKE = 0.018;
/**
 * Ring radii of the hub faces: the axis caps end inside the bore, so every hub cut
 * meets quad facets instead of one large n-gon.
 */
const HUB_RINGS = [0.02, 0.034, 0.07] as const;
export const WINDOW_IN = 0.105;
export const VALVE_HOLE = 0.0057;
/** Valve hole height: in the drop center well, between its slopes. */
export const VALVE_Y = -0.017;

/**
 * Revolve segments around the axle: the multiple of twice the spoke count nearest 64,
 * so facet edges run along every spoke and window centerline.
 */
export function segments(spokes: number): number {
  return 2 * spokes * Math.max(1, Math.round(32 / spokes));
}

/** Barrel section `[radius, y]`: tire side inboard to outboard, then the inside back. */
export function barrelProfile(p: WheelRimParameters): Point2[] {
  const r = p.diameter / 2;
  const [yi, yo] = [-p.width / 2, p.width / 2];
  const rf = r + FLANGE_HEIGHT;
  const rw = r - WELL;
  const wellIn = yi + 0.045;
  const wellOut = -0.005;
  const shoulder = 0.02;
  return [
    [rf, yi - FLANGE],
    [rf, yi],
    [r, yi],
    [r, yi + 0.025],
    [rw, wellIn],
    [rw, wellOut],
    [r, shoulder],
    [r, yo],
    [rf, yo],
    [rf, yo + FLANGE],
    [r - WALL, yo + FLANGE],
    [r - WALL, shoulder],
    [rw - WALL, wellOut],
    [rw - WALL, wellIn],
    [r - WALL, yi + 0.025],
    [r - WALL, yi - FLANGE],
    [rf, yi - FLANGE],
  ];
}

/**
 * Face disc section from the axle: hub mounting face, flat spoke back and front, a
 * steep conical ring into the barrel wall (the deep lip), the raised hub boss and its
 * center cap recess.
 */
export function faceProfile(p: WheelRimParameters): Point2[] {
  const r = p.diameter / 2;
  const yo = p.width / 2;
  const joint = r - WALL / 2;
  const outer = windowOuter(p);
  const spoke = spokePlane(p);
  const hub = spoke.front + HUB_BOSS;
  return [
    [0, p.offset],
    [HUB_RINGS[0], p.offset],
    [HUB_RINGS[1], p.offset],
    [HUB_RINGS[2], p.offset],
    [HUB_PAD, p.offset],
    [HUB_PAD + 0.01, p.offset + 0.012],
    [WINDOW_IN - 0.006, spoke.back],
    [outer + 0.01, spoke.back],
    [joint, yo - 0.03],
    [joint, yo + FLANGE - 0.008],
    [r - WALL - 0.004, yo + FLANGE - 0.008],
    [outer + 0.014, spoke.front],
    [0.092, spoke.front],
    [0.085, hub],
    [HUB_RINGS[2], hub],
    [CAP, hub],
    [CAP, hub - CAP_DEPTH],
    [HUB_RINGS[0], hub - CAP_DEPTH],
    [0, hub - CAP_DEPTH],
  ];
}

/**
 * Heights of the flat spoke face and back: a fixed depth behind the lip front, so the
 * hub between them and the mounting face grows with width and shrinks with offset.
 */
export function spokePlane(p: WheelRimParameters): { readonly front: number; readonly back: number } {
  const front = p.width / 2 + FLANGE - LIP_DEPTH;
  return { front, back: front - SPOKE };
}

/** Outer radius of the spoke windows: the spoke plane ends there and the lip cone begins. */
export function windowOuter(p: WheelRimParameters): number {
  return p.diameter / 2 - WALL - 0.03;
}

/**
 * The window between spoke 0 (+Z) and spoke 1, as an extrudePolygon outline: after
 * the -90 degree turn about X, outline `[x, y]` lands on world `(x, -y)` in XZ.
 */
export function windowOutline(p: WheelRimParameters): Point2[] {
  const step = (2 * Math.PI) / p.spokes;
  const outer = windowOuter(p);
  const atHub = Math.min(0.05, 0.5 * step * WINDOW_IN);
  const atRim = Math.min(0.034, 0.25 * step * outer);
  const halfWidth = (r: number) => (atHub + ((atRim - atHub) * (r - WINDOW_IN)) / (outer - WINDOW_IN)) / 2;
  const at = (r: number, angle: number): Point2 => [r * Math.sin(angle), -r * Math.cos(angle)];
  const points: Point2[] = [];
  const arc = (r: number, from: number, to: number, n: number) => {
    for (let i = 0; i <= n; i++) points.push(at(r, from + ((to - from) * i) / n));
  };
  const side = (r: number) => Math.asin(halfWidth(r) / r);
  arc(WINDOW_IN, side(WINDOW_IN), step - side(WINDOW_IN), 3);
  arc(outer, step - side(outer), side(outer), 7);
  return points;
}

/** Faces between the window centerlines either side of the spoke at `angle` (degrees). */
export function spokeSector(angle: number, step: number): FaceSelector {
  const normal = (a: number, sign: number): Tuple3 => {
    const t = (a * Math.PI) / 180;
    return [sign * Math.cos(t), 0, -sign * Math.sin(t)];
  };
  const from = normal(angle - step / 2, 1);
  const to = normal(angle + step / 2, -1);
  const slack = (n: Tuple3): Tuple3 => [-n[0] * 1e-6, 0, -n[2] * 1e-6];
  return sel.side(slack(from), from).and(sel.side(slack(to), to));
}

export function buildWheelRim(
  p: WheelRimParameters = WHEEL_RIM_DEFAULTS,
  session: SessionFactory = () => model(),
): Model {
  const step = 360 / p.spokes;
  const n = segments(p.spokes);
  const r = p.diameter / 2;
  const yo = p.width / 2;
  const spoke = spokePlane(p);
  const hubFront = spoke.front + HUB_BOSS;
  const spokeFront = sel.inBox([-1, spoke.front - 1e-6, -1], [1, spoke.front + 1e-6, 1]);
  const lip = sel.inBox([-1, yo + FLANGE - 1e-6, -1], [1, yo + FLANGE + 1e-6, 1]);
  const flangeTop = sel.createdBy('barrel').and(sel.facing('+y', 89).not()).and(sel.facing('-y', 89).not());

  // Face: the disc revolved from the hub, the deep lip ring running into the barrel wall.
  const d = session('face');
  d.revolve({ points: faceProfile(p), segments: n, label: 'disc', tag: 'face', material: 'painted' });
  // The flat spoke face comes as n facets: merge each spoke's share (window centerline to
  // window centerline) into one n-gon, so the window cut and its chamfer meet whole faces.
  for (let k = 0; k < p.spokes; k++) {
    d.cleanup.planar(spokeSector(k * step, step).and(spokeFront));
  }
  d.checkpoint('disc');

  // Spoke windows: one prism with rounded corners, arrayed around the axle, cut in one
  // difference; the window rims on the spoke face are then chamfered.
  const cut = session('windows');
  cut.extrudePolygon({ points: windowOutline(p), depth: yo + FLANGE + 0.02 - (p.offset + 0.004), label: 'window' });
  cut.rotate(sel.all(), 'x', -90);
  cut.translate(sel.all(), [0, p.offset + 0.004, 0]);
  cut.bevel(sel.edges.parallel('y').and(sel.edges.dihedral('>', 30)), { width: 0.008, segments: 4, label: 'window-corner' });
  cut.array(sel.all(), { radial: { count: p.spokes, axis: 'y' }, label: 'window-array' });
  d.difference(cut, { label: 'windows', tag: 'windows', material: 'painted' });
  d.bevel(sel.createdBy('windows', 'cutB').boundary().and(sel.facing('+y').toEdges('touching')), { width: 0.003, segments: 1, label: 'window-chamfer' });
  d.checkpoint('spokes');

  // Hub: five lug pockets (20 mm of hub left under them) and through holes, then the
  // center bore. Every drill turns half a facet about its own axis so no tool edge
  // lies on a facet edge.
  const seats = session('seats');
  seats.cylinder({ radiusTop: LUG_SEAT, radiusBottom: LUG_SEAT, height: hubFront - p.offset - 0.012, radialSegments: 24, center: [0, (hubFront + p.offset) / 2 + 0.014, PCD / 2], label: 'seat' });
  seats.rotate(sel.all(), 'y', 180 / 24, [0, 0, PCD / 2]);
  const lugs = session('lugs');
  lugs.cylinder({ radiusTop: LUG_HOLE, radiusBottom: LUG_HOLE, height: hubFront - p.offset + 0.02, radialSegments: 24, center: [0, (hubFront + p.offset) / 2, PCD / 2], label: 'bit' });
  lugs.rotate(sel.all(), 'y', 180 / 24, [0, 0, PCD / 2]);
  seats.array(sel.all(), { radial: { count: LUGS, axis: 'y' }, label: 'seat-array' });
  lugs.array(sel.all(), { radial: { count: LUGS, axis: 'y' }, label: 'lug-array' });
  d.difference(seats, { label: 'lug-seats', tag: 'hub', material: 'bore' });
  d.difference(lugs, { label: 'lugs', tag: 'hub', material: 'bore' });
  const bore = session('bore');
  bore.cylinder({ radiusTop: BORE, radiusBottom: BORE, height: hubFront - p.offset + 0.02, radialSegments: 48, center: [0, (hubFront + p.offset) / 2, 0], label: 'bit' });
  bore.rotate(sel.all(), 'y', 180 / 48);
  d.difference(bore, { label: 'bore', tag: 'hub', material: 'bore' });
  d.checkpoint('hub');

  // Barrel: the rim section revolved about the axle, the outboard lip rounded, and the
  // finished face unioned in (unlabeled, so the face keeps its window and hub roles).
  const m = session('rim');
  m.revolve({ points: barrelProfile(p), segments: n, label: 'barrel', tag: 'barrel', material: 'barrel' });
  m.bevel(lip.toEdges('touching').and(flangeTop.toEdges('touching')), { width: 0.003, segments: 3, label: 'lip-round' });
  m.checkpoint('barrel');
  m.union(d);
  m.checkpoint('assembled');

  // Valve stem: a radial hole through the drop center well, centred in the first window.
  const valve = session('valve');
  valve.cylinder({ radiusTop: VALVE_HOLE, radiusBottom: VALVE_HOLE, height: 0.04, radialSegments: 16, label: 'stem' });
  valve.rotate(sel.all(), 'y', 180 / 16);
  valve.rotate(sel.all(), 'x', 90);
  valve.translate(sel.all(), [0, VALVE_Y, r - WELL]);
  valve.rotate(sel.all(), 'y', step / 2);
  m.difference(valve, { label: 'valve', tag: 'valve', material: 'bore' });

  // Finish: crisp creases and a machined lip; cylindrical UVs about the axle.
  m.markSharp(sel.edges.dihedral('>', 35));
  m.assign(lip.or(sel.createdBy('lip-round')), 'machined');
  m.uv.project({ mode: 'cylinder', axis: 'y', scale: 0.1 });
  return m;
}
