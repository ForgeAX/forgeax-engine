import {
  type DesignedContact,
  type FaceSelector,
  type LoopSpec,
  type Model,
  model,
  type Point2,
  type PosePath,
  type Rig,
  type RigSpec,
  recipes,
  rig,
  sel,
  type Tuple3,
} from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { BOW1, BOW2, G1, G2, HOOD, M1, M2, SKIN, TARGET } from './hood-data.ts';

/**
 * Case C-116: the hood-l two-position four-bar as a closed
 * mechanism. The hood rides the coupler M1-M2 of two gooseneck links about the ground pivots
 * G1 and G2; a hydraulic cylinder pivoted on the bay at C0 pushes link 2 at K. The rig keys
 * only the cylinder's extension: `rig.solve` closes both loops (M2 and K) at every pose.
 * Every pivot is a `recipes.pinJoint` (H11/c11, double shear), its clevis turned so the lug
 * swings symmetrically about it. Model space: x along the car (car z), y up, z across (car x
 * minus 0.5), so the mechanism plane is z = 0 and the cylinder runs beside it at z = 0.06.
 */
export interface HoodParameters {
  /** Pin diameter at every pivot (meters). */
  readonly pin: number;
  /** Link bar width in the mechanism plane and thickness across it (meters). */
  readonly bar: readonly [number, number];
  /** Planes (z) of link 2 and of the cylinder; link 1 runs in z = 0. */
  readonly link2Plane: number;
  readonly cylinderPlane: number;
  /** Where the hood starts across the car (z); it runs `width` inboard from there. */
  readonly hoodEdge: number;
  /** Hood width across the car at this mechanism (meters). */
  readonly width: number;
}

/**
 * The layout as drawn: one side view, so every link, the cylinder and the hood share
 * the mechanism plane (the cylinder 6 cm beside it), the hood centred over it.
 */
export const HOOD_FIRST: HoodParameters = {
  pin: 0.016,
  bar: [0.03, 0.016],
  link2Plane: 0,
  cylinderPlane: 0.06,
  hoodEdge: -0.25,
  width: 0.5,
};

/**
 * The layout the scan forced: link 2 and the cylinder in their own planes outboard of link 1,
 * the hood's inner frame starting 3 cm inboard of the mechanism.
 */
export const HOOD_DEFAULTS: HoodParameters = {
  ...HOOD_FIRST,
  link2Plane: -0.035,
  cylinderPlane: -0.085,
  hoodEdge: 0.03,
};

/** Cylinder pivot on the bay and its attachment on link 2 (from a sweep for the best transmission angle). */
export const C0: Point2 = [1.95, 0.425];
const K_ALONG = 0.16;
const K_ACROSS = 0.06;

export const LINK2_ANGLE = Math.atan2(M2[1] - G2[1], M2[0] - G2[0]);
export const K: Point2 = [
  G2[0] + K_ALONG * Math.cos(LINK2_ANGLE) - K_ACROSS * Math.sin(LINK2_ANGLE),
  G2[1] + K_ALONG * Math.sin(LINK2_ANGLE) + K_ACROSS * Math.cos(LINK2_ANGLE),
];
const CYLINDER_LENGTH = Math.hypot(K[0] - C0[0], K[1] - C0[1]);
export const CYLINDER_AXIS: Tuple3 = [(K[0] - C0[0]) / CYLINDER_LENGTH, (K[1] - C0[1]) / CYLINDER_LENGTH, 0];
/** Link 2's turn when the hood has translated to its target (radians). */
const LINK2_TURN =
  Math.atan2(M2[1] + TARGET[1] - G2[1], M2[0] + TARGET[0] - G2[0]) - LINK2_ANGLE;
const K_END: Point2 = [
  G2[0] + (K[0] - G2[0]) * Math.cos(LINK2_TURN) - (K[1] - G2[1]) * Math.sin(LINK2_TURN),
  G2[1] + (K[0] - G2[0]) * Math.sin(LINK2_TURN) + (K[1] - G2[1]) * Math.cos(LINK2_TURN),
];
/** Rod stroke from the car form to the hood's target position (meters). */
export const STROKE = Math.hypot(K_END[0] - C0[0], K_END[1] - C0[1]) - CYLINDER_LENGTH;

const at = (p: Point2, z = 0): Tuple3 => [p[0], p[1], z];

/** Joint table and loops: everything `rig.solve` needs, without geometry. */
export function hoodSpec(parameters: HoodParameters = HOOD_DEFAULTS): RigSpec {
  const zc = parameters.cylinderPlane;
  const loops: LoopSpec[] = [
    { name: 'm2', a: 'link2', b: 'hood', kind: 'pin', at: at(M2, parameters.link2Plane), axis: 'z' },
    { name: 'k', a: 'link2', b: 'rod', kind: 'pin', at: at(K, zc), axis: 'z' },
  ];
  return {
    joints: [
      { name: 'body', parent: null, position: [0, 0, 0] },
      { name: 'link1', parent: 'body', position: at(G1), kind: 'revolute', axis: 'z' },
      { name: 'hood', parent: 'link1', position: at(M1), kind: 'revolute', axis: 'z' },
      { name: 'link2', parent: 'body', position: at(G2), kind: 'revolute', axis: 'z' },
      { name: 'barrel', parent: 'body', position: at(C0, zc), kind: 'revolute', axis: 'z' },
      {
        name: 'rod',
        parent: 'barrel',
        position: at(C0, zc),
        kind: 'prismatic',
        axis: CYLINDER_AXIS,
        limits: [0, STROKE],
      },
    ],
    loops,
  };
}

/** The transformation: the cylinder extends its whole stroke; the loops do the rest. */
export function hoodPath(): PosePath {
  return {
    keys: [
      { u: 0, pose: { rod: 0 } },
      { u: 1, pose: { rod: STROKE } },
    ],
    interpolation: 'smooth',
  };
}

/** Quadratic Bezier from a to b with control point c. */
function bezier(a: Point2, c: Point2, b: Point2, n: number): Point2[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const s = 1 - t;
    return [s * s * a[0] + 2 * s * t * c[0] + t * t * b[0], s * s * a[1] + 2 * s * t * c[1] + t * t * b[1]];
  });
}

/** A link frame point (origin g, x toward m) in model space. */
function linkPoint(g: Point2, m: Point2, q: Point2): Point2 {
  const a = Math.atan2(m[1] - g[1], m[0] - g[0]);
  return [g[0] + q[0] * Math.cos(a) - q[1] * Math.sin(a), g[1] + q[0] * Math.sin(a) + q[1] * Math.cos(a)];
}

/** Gooseneck centre line, trimmed `trim` from each pivot where the lugs take over. */
function gooseneck(g: Point2, m: Point2, bow: Point2, trim: number): Point2[] {
  const line = bezier(g, linkPoint(g, m, bow), m, 48);
  return line.filter(
    (p) => Math.hypot(p[0] - g[0], p[1] - g[1]) >= trim && Math.hypot(p[0] - m[0], p[1] - m[1]) >= trim,
  );
}

/** Pivots: where each pin joint sits, which body carries its lug and which its clevis. */
export interface Pivot {
  readonly name: string;
  readonly at: Point2;
  readonly z: number;
  readonly lug: string;
  readonly host: string;
  /** Rest direction of the lug body (radians). */
  readonly lugAngle: number;
  /** Lug rotation relative to the host over the path (degrees), for centring the clevis. */
  readonly swing: readonly [number, number];
}

/** Joint value (degrees) of every revolute joint along the path, solved by the rig. */
export function solvedAngles(samples = 41): Record<string, number>[] {
  const r = rig(model(), hoodSpec());
  return Array.from({ length: samples }, (_, i) => {
    const s = r.sample(hoodPath(), i / (samples - 1));
    if (!s.ok) throw s.error;
    const solved = r.solve(s.value);
    if (!solved.ok) throw solved.error;
    return solved.value.pose as Record<string, number>;
  });
}

export function hoodPivots(parameters: HoodParameters = HOOD_DEFAULTS): Pivot[] {
  const trim = 1.5 * parameters.pin + parameters.pin;
  const l1 = gooseneck(G1, M1, BOW1, trim);
  const l2 = gooseneck(G2, M2, BOW2, trim);
  const toward = (from: Point2, to: Point2) => Math.atan2(to[1] - from[1], to[0] - from[0]);
  const angles = solvedAngles();
  const range = (f: (a: Record<string, number>) => number): [number, number] => {
    const v = angles.map(f);
    return [Math.min(...v), Math.max(...v)];
  };
  const zc = parameters.cylinderPlane;
  const z2 = parameters.link2Plane;
  return [
    { name: 'g1', at: G1, z: 0, lug: 'link1', host: 'body', lugAngle: toward(G1, l1[0] as Point2), swing: range((a) => a.link1 ?? 0) },
    { name: 'm1', at: M1, z: 0, lug: 'link1', host: 'hood', lugAngle: toward(M1, l1[l1.length - 1] as Point2), swing: range((a) => -(a.hood ?? 0)) },
    { name: 'g2', at: G2, z: z2, lug: 'link2', host: 'body', lugAngle: toward(G2, l2[0] as Point2), swing: range((a) => a.link2 ?? 0) },
    {
      name: 'm2',
      at: M2,
      z: z2,
      lug: 'link2',
      host: 'hood',
      lugAngle: toward(M2, l2[l2.length - 1] as Point2),
      swing: range((a) => (a.link2 ?? 0) - (a.link1 ?? 0) - (a.hood ?? 0)),
    },
    { name: 'c0', at: C0, z: zc, lug: 'barrel', host: 'body', lugAngle: toward(C0, K), swing: range((a) => a.barrel ?? 0) },
    { name: 'k', at: K, z: zc, lug: 'rod', host: 'link2', lugAngle: toward(K, C0), swing: range((a) => (a.barrel ?? 0) - (a.link2 ?? 0)) },
  ];
}

/** Rigid bindings: part name, joint and faces. */
export interface Binding {
  readonly part: string;
  readonly joint: string;
  readonly faces: FaceSelector;
}

const PIN_PARTS = ['clevis', 'lug', 'pin', 'washer', 'ring'] as const;

export function hoodBindings(): Binding[] {
  const out: Binding[] = [
    { part: 'skin', joint: 'body', faces: sel.createdBy('skin') },
    { part: 'hood', joint: 'hood', faces: sel.createdBy('hood') },
    { part: 'link1', joint: 'link1', faces: sel.createdBy('link1') },
    { part: 'link2', joint: 'link2', faces: sel.createdBy('link2') },
    { part: 'barrel', joint: 'barrel', faces: sel.createdBy('barrel') },
    { part: 'rod', joint: 'rod', faces: sel.createdBy('rod') },
  ];
  for (const p of hoodPivots()) {
    for (const piece of PIN_PARTS) {
      out.push({ part: `${p.name}-${piece}`, joint: piece === 'lug' ? p.lug : p.host, faces: sel.createdBy(`${p.name}-${piece}`) });
    }
  }
  return out;
}

/** Designed contacts: each joint's own fits, and lugs and clevises seated on their bodies. */
export function hoodContacts(): DesignedContact[] {
  const out: DesignedContact[] = [];
  for (const p of hoodPivots()) {
    for (let i = 0; i < PIN_PARTS.length; i++) {
      for (let j = i + 1; j < PIN_PARTS.length; j++) {
        out.push({ parts: [`${p.name}-${PIN_PARTS[i]}`, `${p.name}-${PIN_PARTS[j]}`], kind: 'fit' });
      }
    }
    out.push({ parts: [`${p.name}-lug`, p.lug], tolerance: 0.02 });
    if (p.host === 'hood') out.push({ parts: [`${p.name}-clevis`, 'hood'], tolerance: 0.02 });
    if (p.host === 'link2') out.push({ parts: [`${p.name}-clevis`, 'link2'], tolerance: 0.02 });
  }
  out.push({ parts: ['barrel', 'rod'], kind: 'fit' });
  return out;
}

/**
 * Build the mechanism at rest (car form): skin, hood, gooseneck links, cylinder and six pin
 * joints. Recorded steps are: skin and hood, links, cylinder, then one step per pin joint.
 */
export function buildHood(parameters: HoodParameters = HOOD_DEFAULTS, session: SessionFactory = () => model()): Model {
  const m = session('hood');
  // Windshield and roof skin as a 4 mm plate under the top line.
  const skin: Point2[] = [...SKIN.map(([x, y]) => [x, y - 0.004] as Point2), ...[...SKIN].reverse()];
  // The roof and windshield run across the whole car, past the mechanism planes.
  m.extrudePolygon({ points: skin, depth: parameters.width + 0.2, label: 'skin' });
  m.translate(sel.createdBy('skin'), [0, 0, Math.min(parameters.hoodEdge, -0.2)]);
  m.extrudePolygon({ points: [...HOOD].reverse(), depth: parameters.width, label: 'hood' });
  m.translate(sel.createdBy('hood'), [0, 0, parameters.hoodEdge]);
  const [w, t] = parameters.bar;
  const trim = 2.5 * parameters.pin;
  const section: Point2[] = [
    [-w / 2, -t / 2],
    [w / 2, -t / 2],
    [w / 2, t / 2],
    [-w / 2, t / 2],
  ];
  const link = (g: Point2, mm: Point2, bow: Point2, z: number) => ({
    profile: section,
    path: gooseneck(g, mm, bow, trim).map(([x, y]) => [x, y, z] as Tuple3),
    frame: 'up' as const,
    up: [0, 0, 1] as Tuple3,
  });
  m.sweep({ ...link(G1, M1, BOW1, 0), label: 'link1' });
  m.sweep({ ...link(G2, M2, BOW2, parameters.link2Plane), label: 'link2' });
  // Cylinder: a tube from C0 and a rod back from K, sliding with a running clearance.
  const zc = parameters.cylinderPlane;
  // The eyes (pin-joint lugs, 3.5 pin diameters long) sit 2 mm into the tube and rod ends,
  // so neither slices through the other.
  const eye = 3.5 * parameters.pin - 0.002;
  const barrelLength = CYLINDER_LENGTH * 0.62;
  const rodLength = CYLINDER_LENGTH - 2 * eye - 0.03;
  const turn = (Math.atan2(CYLINDER_AXIS[1], CYLINDER_AXIS[0]) * 180) / Math.PI - 90;
  const cylinder = model();
  cylinder.revolve({
    points: [
      [0.0135, eye],
      [0.024, eye],
      [0.024, eye + barrelLength],
      [0.0135, eye + barrelLength],
      [0.0135, eye],
    ],
    segments: 32,
    label: 'barrel',
  });
  cylinder.revolve({
    points: [
      [0, CYLINDER_LENGTH - eye - rodLength],
      [0.012, CYLINDER_LENGTH - eye - rodLength],
      [0.012, CYLINDER_LENGTH - eye],
      [0, CYLINDER_LENGTH - eye],
    ],
    segments: 32,
    label: 'rod',
  });
  cylinder.rotate(sel.all(), 'z', turn);
  m.append(cylinder.snapshot(), { translate: [C0[0], C0[1], zc] });
  for (const p of hoodPivots(parameters)) {
    const joint = recipes.pinJoint({ d: parameters.pin, name: p.name });
    if (!joint.ok) throw joint.error;
    const piece = model();
    piece.append(joint.value.model.snapshot());
    piece.rotate(sel.all(), 'x', 90);
    // The clevis points away from the middle of the lug's swing, so the lug turns symmetrically.
    const middle = (p.swing[0] + p.swing[1]) / 2;
    const lugTurn = (p.lugAngle * 180) / Math.PI;
    const host = sel.all().minus(sel.createdBy(`${p.name}-lug`));
    piece.rotate(host, 'z', lugTurn + middle);
    piece.rotate(sel.createdBy(`${p.name}-lug`), 'z', lugTurn);
    m.append(piece.snapshot(), { translate: [p.at[0], p.at[1], p.z] });
  }
  m.uv.project({ mode: 'box', scale: 0.5 });
  return m;
}

/** The mechanism rig: bindings in order, then the loops from `hoodSpec`. */
export function hoodRig(m: Model, parameters: HoodParameters = HOOD_DEFAULTS): Rig {
  const r = rig(m, hoodSpec(parameters));
  for (const b of hoodBindings()) r.bindRigid(b.faces, b.joint, { part: b.part });
  return r;
}

/** Transmission angle at K between the cylinder and link 2's arm (degrees, 90 is ideal). */
export function transmission(angles: Record<string, number>): number {
  const arm = LINK2_ANGLE + Math.atan2(K_ACROSS, K_ALONG) + ((angles.link2 ?? 0) * Math.PI) / 180;
  const cyl = Math.atan2(CYLINDER_AXIS[1], CYLINDER_AXIS[0]) + ((angles.barrel ?? 0) * Math.PI) / 180;
  const mu = Math.abs(((((cyl - arm) * 180) / Math.PI) % 180 + 180) % 180);
  return Math.min(mu, 180 - mu);
}
