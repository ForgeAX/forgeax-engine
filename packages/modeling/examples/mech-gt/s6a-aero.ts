import { type Model, model, type Point2, sel, type Tuple3 } from '@forgeax/engine-modeling';
import { BODY_NOSE, BODY_TAIL, bodyPoint, NOSE, planHalf } from './s3-rough.ts';

/**
 * Case C-100 stage S6a (code name mech-gt): the aero parts. The active rear wing lies flush
 * on the rear deck in car form (its slide lifts it in the open phase); the front splitter is
 * a carbon blade under the nose, ahead of the S6c underbody floor.
 */

/** Rear wing: chord over z, 4 mm off the deck, spanning the deck where t >= T_MIN. */
export const WING = { z: [BODY_TAIL + 0.02, BODY_TAIL + 0.2], gap: 0.004, thickness: 0.014, trailing: 0.002, tMin: 0.74, stations: 24, chordPoints: 16 } as const;

/** The deck height at (x, z): the body surface point at station z whose |x| matches, searched over t in [0.5, 1]. */
function deckY(x: number, z: number): number {
  let lo = 0.5;
  let hi = 1;
  // |x| falls from the shoulder (t = 0.5) to the centerline (t = 1).
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (bodyPoint(z, mid, 1)[0] > Math.abs(x)) lo = mid;
    else hi = mid;
  }
  return bodyPoint(z, (lo + hi) / 2, 1)[1];
}

/** NACA four-digit half-thickness shape, 1 at its maximum (s = 0 leading edge, 1 trailing). */
const naca = (s: number) => 2.969 * Math.sqrt(s) - 1.26 * s - 3.516 * s * s + 2.843 * s ** 3 - 1.015 * s ** 4;

export function rearWing(): Model {
  const [zTe, zLe] = WING.z;
  const span = Math.min(...[0, 0.5, 1].map((f) => bodyPoint(zTe + (zLe - zTe) * f, WING.tMin, 1)[0]));
  const peak = Math.max(...Array.from({ length: 101 }, (_, k) => naca(k / 100)));
  const profiles: Tuple3[][] = [];
  for (let i = 0; i <= WING.stations; i++) {
    const x = -span + (2 * span * i) / WING.stations;
    const n = WING.chordPoints;
    // Leading edge forward (+z): s runs from the leading edge to the trailing edge.
    const s = Array.from({ length: n + 1 }, (_, k) => (1 - Math.cos((Math.PI * k) / n)) / 2);
    const z = s.map((v) => zLe - (zLe - zTe) * v);
    const base = z.map((zz) => deckY(x, zz) + WING.gap);
    const lower = z.map((zz, k): Tuple3 => [x, base[k] as number, zz]);
    const upper = z.map((zz, k): Tuple3 => [x, (base[k] as number) + Math.max(WING.trailing, (WING.thickness * naca(s[k] as number)) / peak), zz]);
    // Closed section: the lower surface from the leading to the blunt trailing edge, then the
    // upper surface back (its leading-edge point is the lower one's).
    profiles.push([...lower, ...upper.slice(1).reverse()]);
  }
  const m = model();
  m.loft({ profiles, match: 'index', label: 'rear-wing', tag: 'part:rear-wing', material: 'carbon' });
  return m;
}

/** Front splitter: a carbon blade under the nose, 8 mm thick, 12 mm wider than the plan. */
export const SPLITTER = { from: NOSE - 0.32, to: BODY_NOSE + 0.04, overhang: 0.012, thickness: 0.008, clearance: 0.003, step: 0.01 } as const;

export function frontSplitter(): Model {
  const zs: number[] = [];
  for (let z = SPLITTER.from; z < SPLITTER.to - SPLITTER.step / 2; z += SPLITTER.step) zs.push(z);
  zs.push(SPLITTER.to);
  const top = Math.min(...zs.map((z) => bodyPoint(z, 0, 1)[1])) - SPLITTER.clearance;
  const half = zs.map((z) => planHalf(z) + SPLITTER.overhang);
  const outline: Point2[] = [...zs.map((z, k): Point2 => [half[k] as number, z]), ...zs.map((z, k): Point2 => [-(half[k] as number), z]).reverse()];
  const m = model();
  // Drawn in XY as (x, z) and extruded along +Z; turning +90 about X lays it flat with its top at y = 0.
  m.extrudePolygon({ points: outline, depth: SPLITTER.thickness, label: 'front-splitter', tag: 'part:bumper-center', material: 'carbon' });
  m.rotate(sel.all(), 'x', 90);
  m.translate(sel.all(), [0, top, 0]);
  return m;
}
