import type { Point2, Tuple3 } from '@forgeax/engine-modeling';
import { INTAKE, SPLITS } from './s2-body.ts';
import { BODY_TAIL, fasciaEnd, lifted, NOSE, T, tForY } from './s3-rough.ts';
import { type Anchor, cross3, dot3, hull2, scale3, sub3, unit3 } from './s6c-kit.ts';

/**
 * Case C-100 stage S6a (code name mech-gt): where the S6c detail parts sit on the S6a body.
 * Every anchor derives from the body surface S(z, t), so it moves with the surface. Left-side
 * keys only for paired details: the S6c assembly mirrors them onto the right side.
 */

/** Openings [z0, z1] x [t0, t1] of the body surface: S6a cuts them from its panels, the S6c cavities fill them. */
export const LAMPS = {
  headlight: { z: [NOSE - 0.26, NOSE - 0.08], t: [0.36, 0.48] },
  /** 6 cm ahead of the panel ends, clear of the tail cut-back. */
  taillight: { z: [BODY_TAIL + 0.06, SPLITS.tail - 0.04], t: [0.6, 0.7] },
  /** Ends 2.5 cm short of the bumper panel's front edge, so the opening stays inside the panel. */
  frontIntake: { z: [NOSE - 0.2, NOSE - 0.075], t: [0.08, 0.3] },
} as const;

/** The anchor frame on the body surface at (z, t), `lift` meters off it, X along `along`. */
function onSurface(part: string, z: number, t: number, lift: number, along: Tuple3): Anchor {
  const origin = lifted(z, t, 1, lift);
  const normal = unit3(sub3(lifted(z, t, 1, lift + 0.01), origin));
  return { part, origin, normal, tangent: along };
}

/** A patch region [z0, z1] x [t0, t1] of the surface as an outline in the anchor's frame (`[x, z]`). */
function outlineIn(a: Anchor, z0: number, z1: number, t0: number, t1: number, n = 6): Point2[] {
  const y = unit3(a.normal);
  const x = unit3(sub3(a.tangent, scale3(y, dot3(a.tangent, y))));
  const zAxis = cross3(x, y);
  const pts: Tuple3[] = [];
  for (let i = 0; i < n; i++) pts.push(lifted(z0 + ((z1 - z0) * i) / n, t0, 1, 0));
  for (let i = 0; i < n; i++) pts.push(lifted(z1, t0 + ((t1 - t0) * i) / n, 1, 0));
  for (let i = 0; i < n; i++) pts.push(lifted(z1 - ((z1 - z0) * i) / n, t1, 1, 0));
  for (let i = 0; i < n; i++) pts.push(lifted(z0, t1 - ((t1 - t0) * i) / n, 1, 0));
  return hull2(pts.map((p): Point2 => {
    const d = sub3(p, a.origin);
    return [dot3(d, x), dot3(d, zAxis)];
  }));
}

const FORWARD: Tuple3 = [0, 0, 1];
const ACROSS: Tuple3 = [1, 0, 0];

/** The side-intake wedge (S2 side view) in the anchor frame at its center. */
function intakeAnchor(): Anchor {
  const zc = INTAKE.reduce((s, p) => s + p[0], 0) / INTAKE.length;
  const yc = INTAKE.reduce((s, p) => s + p[1], 0) / INTAKE.length;
  const a = onSurface('side-intake-l', zc, tForY(zc, yc), 0.002, FORWARD);
  const y = unit3(a.normal);
  const x = unit3(sub3(a.tangent, scale3(y, dot3(a.tangent, y))));
  const zAxis = cross3(x, y);
  const outline = INTAKE.map(([z, h]): Point2 => {
    const d = sub3(lifted(z, tForY(z, h), 1, 0), a.origin);
    return [dot3(d, x), dot3(d, zAxis)];
  });
  return { ...a, outline };
}

function region(part: string, z: readonly [number, number], t: readonly [number, number], lift: number, along: Tuple3): Anchor {
  const a = onSurface(part, (z[0] + z[1]) / 2, (t[0] + t[1]) / 2, lift, along);
  return { ...a, outline: outlineIn(a, z[0], z[1], t[0], t[1]) };
}

/** Exterior anchors, left side (and centered ones). */
function anchors(): Record<string, Anchor> {
  const end = fasciaEnd('rear');
  const r0 = lifted(SPLITS.tail, 0, 1, 0);
  const r1 = lifted(BODY_TAIL, 0, 1, 0);
  const flow = unit3(sub3([0, r1[1], r1[2]], [0, r0[1], r0[2]]));
  const down = cross3(flow, ACROSS);
  return {
    /** At the door's front top corner with a level stalk, where the blueprint's front view has the mirror (y 0.80-0.93). */
    'mirror-l': { ...onSurface('door-l-outer', SPLITS.doorFront - 0.04, T.belt - 0.02, 0.001, FORWARD), normal: [1, 0.05, 0] },
    'door-handle-l': onSurface('door-l-outer', SPLITS.doorRear + 0.22, 0.3, 0.0, FORWARD),
    /** Scissor hinge inside the A-pillar base: axis across the car, the arm running back to the door. */
    'door-hinge-l': { part: 'door-l-inner', origin: [0.6, 0.72, SPLITS.doorFront], normal: [0, 0, -1], tangent: ACROSS },
    'wiper-pivot-l': onSurface('windshield', SPLITS.cowl - 0.1, 0.9, 0.006, [-1, 0, 0]),
    'wiper-pivot-c': onSurface('windshield', SPLITS.cowl - 0.04, 0.995, 0.006, [-1, 0, 0]),
    'headlight-cavity-l': region('headlight-l', LAMPS.headlight.z, LAMPS.headlight.t, 0.0, FORWARD),
    'taillight-cavity-l': region('diffuser-center', LAMPS.taillight.z, LAMPS.taillight.t, 0.0, FORWARD),
    'front-intake-l': region('bumper-corner-l', LAMPS.frontIntake.z, LAMPS.frontIntake.t, 0.004, FORWARD),
    'side-intake-l': intakeAnchor(),
    /** On the rear face of the fascia, centered in its height. */
    exhaust: { part: 'diffuser-center', origin: [0, (end.y[0] + end.y[1]) / 2, end.z - 0.001], normal: [0, 0, -1], tangent: ACROSS },
    'tow-front': onSurface('bumper-corner-l', NOSE - 0.06, 0.16, 0.0005, FORWARD),
    /** On the rear face of the left fascia piece, lower half. */
    'tow-rear': { part: 'diffuser-l', origin: [0.33, end.y[0] + 0.25 * (end.y[1] - end.y[0]), end.z - 0.0005], normal: [0, 0, -1], tangent: ACROSS },
    'diffuser-fins': { part: 'diffuser-center', origin: [0, (r0[1] + r1[1]) / 2 - 0.001, (r0[2] + r1[2]) / 2], normal: down, tangent: ACROSS },
  };
}

export const S6A_ANCHORS: Readonly<Record<string, Anchor>> = anchors();
