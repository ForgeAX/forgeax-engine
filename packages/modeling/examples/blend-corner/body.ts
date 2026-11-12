import {
  type FeatureLine,
  type Model,
  model,
  type NurbsCurve,
  type NurbsSurface,
  type SurfaceBlend,
  type SurfacePatch,
  type Tuple3,
} from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import fixture from './tail-fixture.json' with { type: 'json' };

/**
 * Case C-120: blend run-outs and setback corners at the T-tail of the mech-gt car.
 *
 * The patches are the left calf plate of the S4 v3 tail (examples/mech-gt/ends-theme.ts on
 * feat/f1-s4v3, exported to tail-fixture.json with its commit): the flank (rocker to knee),
 * the upper (knee to the deck edge) and the calf's deck strip. The knee is a crease between
 * flank and upper that ends at the tail shut, where the plate stops ahead of the heel: the
 * T-tail corner. x is outward (left side), y up, z forward (the tail is at -z).
 *
 * Steps: the patches as built (sharp knee); a whole-edge 12 mm G2 knee roll, whose open
 * end stands at the shut; the same roll run out to zero at the T-tail corner; and a setback
 * corner where three 12 mm G2 rolls meet. The corner's faces are planes at the calf's
 * tail-top corner, sized and oriented from the fixture: a setback corner (`corners`) needs face isoparms
 * orthogonal to the blended edges (within 1 degree) and the calf's own shut sections meet
 * the knee 35 to 38 degrees off that, so the real faces are not used there.
 */
export const C120 = {
  /** Knee roll radius (m) and the run-out stations (t = 1 is the T-tail end of the knee). */
  roll: 0.012,
  runOut: [
    [0, 0.012],
    [0.7, 0.012],
    [1, 0],
  ] as [number, number][],
  /** Corner: roll radius, setback (m). */
  cornerRoll: 0.012,
  setback: 0.006,
  /** At 0.5 mm the last centimetres of the run-out tessellate onto one row, smearing the zebra over a cell. */
  chord: 0.0002,
  weld: 5e-5,
} as const;

/** The fixture's provenance: mech-gt branch, commit and export. */
export const SOURCE = fixture.source;

type Fixture = { degreeU: number; degreeV: number; knotsU: number[]; knotsV: number[]; points: number[][][] };
type FixtureCurve = { degree: number; knots: number[]; points: number[][] };
const surfaceOf = (s: Fixture): NurbsSurface => ({
  degreeU: s.degreeU,
  degreeV: s.degreeV,
  knotsU: s.knotsU,
  knotsV: s.knotsV,
  points: s.points.map((row) => row.map((p) => [p[0], p[1], p[2]] as Tuple3)),
});
const curveOf = (c: FixtureCurve): NurbsCurve => ({
  degree: c.degree,
  knots: c.knots,
  points: c.points.map((p) => [p[0], p[1], p[2]] as Tuple3),
});

/** The calf plate as built on mech-gt: flank and upper share the knee, upper and deck the edge. */
export function tailPatches(): SurfacePatch[] {
  return [
    { name: 'flank', surface: surfaceOf(fixture.flank) },
    { name: 'upper', surface: surfaceOf(fixture.upper) },
    { name: 'deck', surface: surfaceOf(fixture.deck.surface), flip: fixture.deck.flip },
  ];
}

/** The plate's G0 feature lines, as mech-gt declares them. */
export function tailLines(): { knee: FeatureLine; edge: FeatureLine } {
  return {
    knee: { name: 'knee-line', curve: curveOf(fixture.calf.knee), continuity: 'G0' },
    edge: { name: 'edge-line', curve: curveOf(fixture.calf.edge), continuity: 'G0' },
  };
}

/** The T-tail corner: where the knee meets the shut (flank u1 v1). */
export function tailCorner(): Tuple3 {
  return surfaceOf(fixture.flank).points.at(-1)?.at(-1) as Tuple3;
}

const sub = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Tuple3, k: number): Tuple3 => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: Tuple3) => scale(a, 1 / Math.hypot(...a));
const cross = (a: Tuple3, b: Tuple3): Tuple3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * The corner's frame at the calf's tail-top corner (upper u1 v1): `forward` along the edge
 * line's chord, `down` the shut (upper's tail end, made orthogonal), `inward` across the
 * deck; and the extents (m): the edge chord, the deck end and the shut height.
 */
export function cornerFrame() {
  const upper = surfaceOf(fixture.upper);
  const deck = surfaceOf(fixture.deck.surface);
  const vertex = upper.points.at(-1)?.at(-1) as Tuple3;
  const edgeStart = upper.points[0]?.at(-1) as Tuple3;
  const knee = upper.points.at(-1)?.[0] as Tuple3;
  const deckEnd = deck.points.at(-1)?.[0] as Tuple3;
  const forward = unit(sub(edgeStart, vertex));
  const drop = sub(knee, vertex);
  const down = unit(sub(drop, scale(forward, dot(drop, forward))));
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    vertex,
    forward,
    down,
    inward: cross(down, forward),
    size: {
      forward: round(Math.hypot(...sub(edgeStart, vertex))),
      inward: round(Math.hypot(...sub(deckEnd, vertex))),
      down: round(Math.hypot(...drop)),
    },
  };
}

/** The corner's three planar faces (tail shut, side, deck), consistently oriented outward. */
export function cornerFaces(): SurfacePatch[] {
  const { vertex, forward, down, inward, size } = cornerFrame();
  const at = (x: number, y: number, z: number): Tuple3 => [
    vertex[0] + forward[0] * x + inward[0] * y + down[0] * z,
    vertex[1] + forward[1] * x + inward[1] * y + down[1] * z,
    vertex[2] + forward[2] * x + inward[2] * y + down[2] * z,
  ];
  const quad = (a: Tuple3, b: Tuple3, c: Tuple3, d: Tuple3): NurbsSurface => ({
    degreeU: 1,
    degreeV: 1,
    points: [
      [a, b],
      [c, d],
    ],
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
  });
  const [X, Y, Z] = [size.forward, size.inward, size.down];
  const o = at(0, 0, 0);
  return [
    { name: 'tail', surface: quad(o, at(0, Y, 0), at(0, 0, Z), at(0, Y, Z)) },
    { name: 'side', surface: quad(o, at(0, 0, Z), at(X, 0, 0), at(X, 0, Z)) },
    { name: 'deck', surface: quad(o, at(X, 0, 0), at(0, Y, 0), at(X, Y, 0)) },
  ];
}

export function cornerBlends(): SurfaceBlend[] {
  const radius = C120.cornerRoll;
  return [
    { between: ['tail', 'side'], radius, continuity: 'G2', name: 'tail-side' },
    { between: ['side', 'deck'], radius, continuity: 'G2', name: 'edge' },
    { between: ['deck', 'tail'], radius, continuity: 'G2', name: 'tail-deck' },
  ];
}

const mesh = { chord: C120.chord, weld: C120.weld, tag: 'tail' } as const;

/** (a) The calf plate as built: a sharp knee crease meeting the T-tail shut. */
export function buildSharp(session: SessionFactory = () => model()): Model {
  const sharp = session('sharp');
  const lines = tailLines();
  sharp.featureLine(lines.knee);
  sharp.featureLine(lines.edge);
  sharp.surface({ patches: tailPatches(), ...mesh });
  return sharp;
}

/** (b) A whole-edge 12 mm G2 knee roll: its open end stands at the shut (before). */
export function buildRoll(session: SessionFactory = () => model()): Model {
  const roll = session('roll');
  const lines = tailLines();
  roll.featureLine(lines.knee);
  roll.featureLine(lines.edge);
  roll.surface({
    patches: tailPatches(),
    blends: [{ between: ['flank', 'upper'], radius: C120.roll, continuity: 'G2', name: 'knee' }],
    ...mesh,
  });
  return roll;
}

/** (c) The same roll run out to zero at the T-tail corner (after). */
export function buildRunOut(session: SessionFactory = () => model()): Model {
  const runOut = session('run-out');
  const lines = tailLines();
  runOut.featureLine(lines.knee);
  runOut.featureLine(lines.edge);
  runOut.surface({
    patches: tailPatches(),
    blends: [{ between: ['flank', 'upper'], radius: C120.runOut, continuity: 'G2', name: 'knee' }],
    ...mesh,
  });
  return runOut;
}

/** (d) Three 12 mm G2 rolls meeting at the tail-top corner, closed by a setback corner. */
export function buildCorner(session: SessionFactory = () => model()): Model {
  const corner = session('corner');
  corner.surface({
    patches: cornerFaces(),
    blends: cornerBlends(),
    corners: [{ blends: ['tail-side', 'edge', 'tail-deck'], setback: C120.setback, continuity: 'G2', name: 'corner' }],
    ...mesh,
  });
  return corner;
}

/** The surfaces a session's last `surface` call recorded, by name. */
export function surfaces(m: Model): ReadonlyMap<string, NurbsSurface> {
  return new Map(m.diagnostics().surfaces.map((s) => [s.name, s.surface]));
}
