import {
  type DesignedContact,
  type Model,
  model,
  path,
  type Point2,
  sel,
  type Tuple3,
} from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-104: the left front double-wishbone corner of the C-100 car (meters, Y up,
 * +X outboard, +Z forward, hub center 0.33 m above the ground plane). Upper and
 * lower A-arms are tubes swept along bent polylines with rubber bushings arrayed
 * along their pivot axis; the upright is lofted through sections with different
 * vertex counts; the coil-over spring is a helix sweep around the damper; the tie
 * rod is a straight sweep with a hexagonal adjuster and a lofted rack boot; the hub
 * is revolved and its wheel studs arrayed radially. Each part is its own session,
 * appended into the assembly. Straight-line code: tools map every journal entry
 * back to the call on its source line.
 */
export interface SuspensionParameters {
  /** Tube radius of the upper arm; the lower arm is 1.3 times thicker (meters). */
  readonly armRadius: number;
  /** Active coils of the spring. */
  readonly springTurns: number;
  /** Spring wire radius (meters). */
  readonly wire: number;
  /** Radius of the corner bends of both arms (meters). */
  readonly bend: number;
}

export const SUSPENSION_DEFAULTS: SuspensionParameters = {
  armRadius: 0.012,
  springTurns: 6,
  wire: 0.0055,
  bend: 0.035,
};

/** Thicker arms, more coils of thinner wire, wider bends: the stability variant. */
export const SUSPENSION_VARIANT: SuspensionParameters = {
  armRadius: 0.015,
  springTurns: 8,
  wire: 0.0042,
  bend: 0.05,
};

/**
 * The corner as an assembly: parts designed to sit in each other, by label, with the
 * embedding each accepts (meters, about 1.25 x the deepest measured over the declared
 * parameter corners). Arm ends are embedded in their bushings and the brace in the arm,
 * the damper sits in its perch and the rod in its mount, the hub carries its studs and
 * the tie rod runs through the boot (a 0.15 mm fit). Pass them as
 * `validate({ contacts: SUSPENSION_JOINTS })`; any other contact stays a crossing.
 */
export const SUSPENSION_JOINTS: readonly DesignedContact[] = [
  { parts: ['lower-arm', 'lower-bush'], tolerance: 0.02 },
  { parts: ['lower-arm', 'lower-bushes'], tolerance: 0.02 },
  { parts: ['lower-arm', 'lower-brace'], tolerance: 0.018 },
  { parts: ['upper-arm', 'upper-bush'], tolerance: 0.015 },
  { parts: ['upper-arm', 'upper-bushes'], tolerance: 0.015 },
  { parts: ['boot', 'tie-rod'], tolerance: 0.001 },
  { parts: ['adjuster', 'tie-rod'], tolerance: 0.007 },
  { parts: ['damper-rod', 'perches'], tolerance: 0.006 },
  { parts: ['damper-rod', 'top-mount'], tolerance: 0.013 },
  { parts: ['damper', 'perch'], tolerance: 0.023 },
  { parts: ['steer-arm', 'tie-ball'], tolerance: 0.007 },
  { parts: ['steer-arm', 'upright'], tolerance: 0.025 },
  { parts: ['lower-ball', 'upright'], tolerance: 0.002 },
  { parts: ['hub', 'upright'], tolerance: 0.003 },
  { parts: ['hub', 'stud'], tolerance: 0.003 },
  { parts: ['hub', 'studs'], tolerance: 0.003 },
];

/** Swept and lofted regions: each is a closed, self-intersection-free solid on its own. */
export const SWEPT = ['upper-arm', 'lower-arm', 'lower-brace', 'upright', 'steer-arm', 'spring', 'boot', 'tie-rod', 'adjuster'];

/** The faces of one label, alone in a fresh session. */
export function isolated(m: Model, label: string): Model {
  const part = model();
  part.append(m.snapshot());
  part.delete(sel.all().minus(sel.createdBy(label)));
  return part;
}

function circle(radius: number, n: number, phase = 0): Point2[] {
  return Array.from({ length: n }, (_, k) => {
    const a = ((k + phase) * 2 * Math.PI) / n;
    return [radius * Math.cos(a), radius * Math.sin(a)] as Point2;
  });
}

/** A closed section in the horizontal plane at height `y` around `[x, z]`. */
function flat(points: readonly Point2[], center: readonly [number, number], y: number): Tuple3[] {
  return points.map(([u, w]) => [center[0] + u, y, center[1] - w] as Tuple3);
}

function rect(halfX: number, halfY: number): Point2[] {
  return [
    [-halfX, -halfY],
    [halfX, -halfY],
    [halfX, halfY],
    [-halfX, halfY],
  ];
}

/** `[radius, y]` revolve loop of a hollow sleeve centered on y = 0. */
function sleeve(inner: number, outer: number, length: number): Point2[] {
  const h = length / 2;
  return [
    [inner, -h],
    [outer, -h],
    [outer, h],
    [inner, h],
    [inner, -h],
  ];
}

function lerp(a: Tuple3, b: Tuple3, t: number): Tuple3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * The corner vertex of a bent arm wrapping a ball joint: the bend's arc passes
 * `reach` inboard of the ball center on the bisector of the two legs, whatever the
 * bend radius. A vertex on the ball center would let the arc (and the tube around
 * it) slide into the ball as the bend tightens or the tube thickens.
 */
function wrapping(ball: Tuple3, front: Tuple3, rear: Tuple3, reach: number, radius: number): Tuple3 {
  const unit = (from: Tuple3, to: Tuple3): Tuple3 => {
    const n = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    return [(to[0] - from[0]) / n, (to[1] - from[1]) / n, (to[2] - from[2]) / n];
  };
  let v = ball;
  for (let i = 0; i < 24; i++) {
    const a = unit(v, front);
    const b = unit(v, rear);
    const u = unit([0, 0, 0], [a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
    const half = Math.acos(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / 2;
    const s = reach - radius * (1 / Math.sin(half) - 1);
    v = [ball[0] + u[0] * s, ball[1] + u[1] * s, ball[2] + u[2] * s];
  }
  return v;
}

/** Upper arm: front and rear pivots on the chassis, ball joint at the upright. */
const UF: Tuple3 = [0.22, 0.47, 0.17];
const UR: Tuple3 = [0.22, 0.47, -0.17];
const UB: Tuple3 = [0.49, 0.5, 0];
const UPPER_BALL = 0.018;
/** Lower arm. */
const LF: Tuple3 = [0.16, 0.2, 0.24];
const LR: Tuple3 = [0.16, 0.2, -0.2];
const LB: Tuple3 = [0.53, 0.17, 0];
const LOWER_BALL = 0.021;
/**
 * Gap between each ball and the surface of its arm's bend (meters): the clearance the
 * default parameters already had, held for every bend radius and tube radius.
 */
const UPPER_GAP = 0.001;
const LOWER_GAP = 0.007;
/** Coil-over length, leaning inboard from its lower eye toward the top mount. */
const COIL_LENGTH = 0.46;
const LEAN = (Math.atan2(0.05, 0.46) * 180) / Math.PI;
/** Tie rod from the rack to the steering arm, behind the axle. */
const TIE_IN: Tuple3 = [0.19, 0.27, -0.15];
const TIE_OUT: Tuple3 = [0.475, 0.265, -0.15];
const HUB: Tuple3 = [0.555, 0.33, 0];

export function buildSuspension(
  p: SuspensionParameters = SUSPENSION_DEFAULTS,
  session: SessionFactory = () => model(),
): Model {
  const lowerRadius = p.armRadius * 1.3;
  const upperCorner = wrapping(UB, UF, UR, UPPER_BALL + p.armRadius + UPPER_GAP, p.bend);
  const lowerCorner = wrapping(LB, LF, LR, LOWER_BALL + lowerRadius + LOWER_GAP, p.bend * 1.3);
  // The cross brace carrying the coil-over eye crosses both lower legs at x = 0.40.
  const braceT = (0.4 - LF[0]) / (lowerCorner[0] - LF[0]);
  const BF = lerp(LF, lowerCorner, braceT);
  const BR = lerp(LR, lowerCorner, braceT);
  const EYE: Tuple3 = [0.4, BF[1], 0];
  const pitch = (0.42 - 0.108 - 2 * p.wire) / p.springTurns;

  // Upper wishbone: one tube bent around the ball joint, sleeves at both pivots.
  const up = session('upper');
  up.sweep({ profile: circle(p.armRadius, 12), path: path.polyline([UF, upperCorner, UR], { radius: p.bend, segments: 8 }), label: 'upper-arm', tag: 'swept', material: 'steel' });
  up.revolve({ points: sleeve(0.01, 0.022, 0.05), segments: 16, label: 'upper-bush', material: 'rubber' });
  up.rotate(sel.createdBy('upper-bush'), 'x', 90);
  up.translate(sel.createdBy('upper-bush'), UF);
  up.array(sel.createdBy('upper-bush'), { linear: { count: 2, offset: [0, 0, UR[2] - UF[2]] }, label: 'upper-bushes' });
  up.sphere({ radius: UPPER_BALL, widthSegments: 12, heightSegments: 8, center: UB, label: 'upper-ball', material: 'steel' });

  // Lower wishbone: thicker bent tube, a brace for the coil-over eye, larger sleeves.
  const low = session('lower');
  low.sweep({ profile: circle(lowerRadius, 12), path: path.polyline([LF, lowerCorner, LR], { radius: p.bend * 1.3, segments: 8 }), label: 'lower-arm', tag: 'swept', material: 'steel' });
  low.sweep({ profile: circle(0.009, 10), path: [BF, BR], label: 'lower-brace', tag: 'swept', material: 'steel' });
  low.revolve({ points: sleeve(0.012, 0.028, 0.06), segments: 16, label: 'lower-bush', material: 'rubber' });
  low.rotate(sel.createdBy('lower-bush'), 'x', 90);
  low.translate(sel.createdBy('lower-bush'), LF);
  low.array(sel.createdBy('lower-bush'), { linear: { count: 2, offset: [0, 0, LR[2] - LF[2]] }, label: 'lower-bushes' });
  low.sphere({ radius: LOWER_BALL, widthSegments: 12, heightSegments: 8, center: LB, label: 'lower-ball', material: 'steel' });

  // Upright: lofted from a rectangular foot through an octagonal spindle boss and a
  // hexagonal neck to a small rectangular head; the steering arm sweeps rearward.
  const k = session('knuckle');
  k.loft({ profiles: [flat(rect(0.024, 0.022), [0.53, 0], 0.19), flat(circle(0.048, 8, 0.5), [0.511, 0], 0.33), flat(circle(0.028, 6), [0.498, 0], 0.42), flat(rect(0.018, 0.016), [0.49, 0], 0.48)], segments: 3, label: 'upright', tag: 'swept', material: 'alu' });
  k.sweep({ profile: rect(0.012, 0.008), path: path.catmullRom([[0.52, 0.27, -0.02], [0.51, 0.268, -0.09], [0.49, 0.265, -0.15]], 6), scale: [1, 0.65], label: 'steer-arm', tag: 'swept', material: 'alu' });

  // Hub: revolved bearing housing and flange turned onto +X, a brake disc, five studs.
  const hub = session('hub');
  hub.revolve({ points: [[0, 0], [0.042, 0], [0.042, 0.02], [0.075, 0.02], [0.075, 0.032], [0.03, 0.032], [0.03, 0.06], [0, 0.06]], segments: 24, label: 'hub', material: 'hub' });
  hub.revolve({ points: sleeve(0.09, 0.15, 0.012), segments: 32, label: 'disc', material: 'disc' });
  hub.translate(sel.createdBy('disc'), [0, 0.011, 0]);
  hub.rotate(sel.all(), 'z', -90);
  hub.translate(sel.all(), HUB);
  hub.cylinder({ radiusTop: 0.006, radiusBottom: 0.006, height: 0.03, radialSegments: 8, label: 'stud', material: 'hub' });
  hub.rotate(sel.createdBy('stud'), 'z', -90);
  hub.translate(sel.createdBy('stud'), [HUB[0] + 0.045, HUB[1] + 0.05, 0]);
  hub.array(sel.createdBy('stud'), { radial: { count: 5, axis: 'x', center: HUB }, label: 'studs' });

  // Coil-over, built upright at the origin: damper body and rod, eye sleeve, perches,
  // and the spring swept along a helix between the perches; then leaned and placed.
  const co = session('coilover');
  co.cylinder({ radiusTop: 0.022, radiusBottom: 0.022, height: 0.262, radialSegments: 16, center: [0, 0.149, 0], label: 'damper', material: 'damper' });
  co.cylinder({ radiusTop: 0.008, radiusBottom: 0.008, height: 0.17, radialSegments: 10, center: [0, 0.365, 0], label: 'damper-rod', material: 'steel' });
  co.revolve({ points: sleeve(0.0095, 0.018, 0.03), segments: 12, label: 'eye', material: 'rubber' });
  co.rotate(sel.createdBy('eye'), 'x', 90);
  co.cylinder({ radiusTop: 0.044, radiusBottom: 0.044, height: 0.008, radialSegments: 20, center: [0, 0.104, 0], label: 'perch', material: 'damper' });
  co.array(sel.createdBy('perch'), { linear: { count: 2, offset: [0, 0.42 - 0.104 + 0.004, 0] }, label: 'perches' });
  co.cylinder({ radiusTop: 0.032, radiusBottom: 0.032, height: 0.02, radialSegments: 16, center: [0, COIL_LENGTH - 0.01, 0], label: 'top-mount', material: 'rubber' });
  co.sweep({ profile: circle(p.wire, 8), path: path.helix({ radius: 0.036, pitch, turns: p.springTurns, segments: 20, center: [0, 0.108 + p.wire, 0] }), label: 'spring', tag: 'swept', material: 'spring' });
  co.rotate(sel.all(), 'z', LEAN);
  co.translate(sel.all(), EYE);

  // Tie rod: rack boot lofted through alternating rings, the rod, a hexagonal
  // adjuster (sharp corners) and the outer ball joint on the steering arm.
  const tie = session('tierod');
  tie.loft({ profiles: [0, 1, 2, 3, 4, 5, 6].map((i) => circle(i % 2 === 0 ? 0.022 : 0.03, 16).map(([u, w]) => [0.1 + i * 0.015, TIE_IN[1] + u, TIE_IN[2] + w] as Tuple3)), segments: 2, label: 'boot', tag: 'swept', material: 'rubber' });
  tie.sweep({ profile: circle(0.009, 10), path: [[0.19, TIE_IN[1], TIE_IN[2]], TIE_OUT], label: 'tie-rod', tag: 'swept', material: 'steel' });
  tie.sweep({ profile: circle(0.014, 6, 0.5), path: [lerp(TIE_IN, TIE_OUT, (0.3 - TIE_IN[0]) / (TIE_OUT[0] - TIE_IN[0])), lerp(TIE_IN, TIE_OUT, (0.35 - TIE_IN[0]) / (TIE_OUT[0] - TIE_IN[0]))], label: 'adjuster', tag: 'swept', material: 'steel' });
  tie.sphere({ radius: 0.015, widthSegments: 12, heightSegments: 8, center: [0.49, 0.265, -0.15], label: 'tie-ball', material: 'steel' });

  // Assembly: parts keep their labels, roles and material slots; swept faces keep
  // their arc-length UVs, primitives get a box projection; creases stay crisp.
  const s = session('suspension');
  s.append(up);
  s.append(low);
  s.append(k);
  s.append(hub);
  s.append(co);
  s.append(tie);
  s.markSharp(sel.edges.dihedral('>', 50));
  s.uv.project({ mode: 'box', scale: 0.1, faces: sel.all().minus(sel.tag('swept')) });
  return s;
}
