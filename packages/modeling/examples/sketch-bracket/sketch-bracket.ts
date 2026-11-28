import { type Model, model, type SketchConstraint, type SketchCurve, type SketchSolution, type SketchSpec, sketch } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case sketch-bracket: a mounting bracket stated as constraints instead of coordinates. The
 * outline is a trapezoid (horizontal base, perpendicular right edge, parallel top, a slanted
 * left edge at `slantDegrees`), cut by a stadium slot (two arcs, two tangent flats) and a
 * round bore. `sketch.solve` turns the rough hand-drawn start points into the exact profile;
 * `extrudePolygon` makes the part. Changing a parameter changes the constraints only.
 */
export interface BracketParameters {
  /** Base edge length (meters). */
  readonly length: number;
  /** Right edge length (meters). */
  readonly height: number;
  /** Angle between the base and the slanted left edge, degrees. */
  readonly slantDegrees: number;
  /** Slot center distance (meters). */
  readonly slotSpan: number;
  /** Slot end radius (meters). */
  readonly slotRadius: number;
  /** Bore radius (meters). */
  readonly boreRadius: number;
  /** Plate thickness (meters). */
  readonly thickness: number;
}

export const BRACKET_DEFAULTS: BracketParameters = {
  length: 0.12,
  height: 0.06,
  slantDegrees: 70,
  slotSpan: 0.028,
  slotRadius: 0.006,
  boreRadius: 0.008,
  thickness: 0.01,
};

const SLOT_AT: [number, number] = [0.03, 0.03];
const BORE_AT: [number, number] = [0.088, 0.03];

export const BRACKET_CURVES: Readonly<Record<string, SketchCurve>> = {
  base: { kind: 'line', a: 'a', b: 'b' },
  right: { kind: 'line', a: 'b', b: 'c' },
  top: { kind: 'line', a: 'c', b: 'd' },
  slant: { kind: 'line', a: 'a', b: 'd' },
  slotBottom: { kind: 'line', a: 's1', b: 's2' },
  slotRight: { kind: 'arc', center: 'k2', from: 's2', to: 's3' },
  slotTop: { kind: 'line', a: 's3', b: 's4' },
  slotLeft: { kind: 'arc', center: 'k1', from: 's4', to: 's1' },
  bore: { kind: 'arc', center: 'h', from: 'hr', to: 'hr' },
};

/** The rough hand-drawn start: every point is a few millimeters from where it ends up. */
export const BRACKET_ROUGH: Readonly<Record<string, [number, number]>> = {
  a: [-0.004, 0.003],
  b: [0.126, -0.004],
  c: [0.118, 0.071],
  d: [0.021, 0.058],
  k1: [0.034, 0.027],
  k2: [0.056, 0.034],
  s1: [0.031, 0.021],
  s2: [0.061, 0.023],
  s3: [0.058, 0.04],
  s4: [0.029, 0.036],
  h: [0.085, 0.033],
  hr: [0.094, 0.031],
};

export function bracketConstraints(p: BracketParameters): SketchConstraint[] {
  return [
    { kind: 'fix', point: 'a', at: [0, 0] },
    { kind: 'horizontal', line: 'base' },
    { kind: 'distance', a: 'a', b: 'b', value: p.length },
    { kind: 'perpendicular', a: 'base', b: 'right' },
    { kind: 'distance', a: 'b', b: 'c', value: p.height },
    { kind: 'parallel', a: 'base', b: 'top' },
    { kind: 'angle', a: 'base', b: 'slant', degrees: p.slantDegrees },
    { kind: 'fix', point: 'k1', at: SLOT_AT },
    { kind: 'horizontal', line: 'slotBottom' },
    { kind: 'distance', a: 'k1', b: 'k2', value: p.slotSpan },
    { kind: 'radius', arc: 'slotLeft', value: p.slotRadius },
    { kind: 'equal', a: 'slotLeft', b: 'slotRight' },
    { kind: 'tangent', line: 'slotBottom', arc: 'slotLeft' },
    { kind: 'tangent', line: 'slotBottom', arc: 'slotRight' },
    { kind: 'tangent', line: 'slotTop', arc: 'slotLeft' },
    { kind: 'tangent', line: 'slotTop', arc: 'slotRight' },
    { kind: 'fix', point: 'h', at: BORE_AT },
    { kind: 'radius', arc: 'bore', value: p.boreRadius },
  ];
}

export function bracketSpec(p: BracketParameters = BRACKET_DEFAULTS): SketchSpec {
  return { points: BRACKET_ROUGH, curves: BRACKET_CURVES, constraints: bracketConstraints(p) };
}

export const ARC_TOLERANCE = 2e-5;

export function solveBracket(p: BracketParameters = BRACKET_DEFAULTS): SketchSolution {
  const solved = sketch.solve(bracketSpec(p), { arcTolerance: ARC_TOLERANCE });
  if (!solved.ok) throw solved.error;
  return solved.value;
}

export function buildBracket(
  p: BracketParameters = BRACKET_DEFAULTS,
  session: SessionFactory = () => model(),
): Model {
  const shape = solveBracket(p).region[0];
  if (shape === undefined) throw new Error('the bracket sketch has no outline');
  const m = session('bracket');
  m.extrudePolygon({
    points: shape.outer,
    ...(shape.holes === undefined ? {} : { holes: shape.holes }),
    depth: p.thickness,
    label: 'plate',
    tag: 'bracket',
  });
  m.uv.project({ mode: 'box', scale: 0.1 });
  return m;
}
