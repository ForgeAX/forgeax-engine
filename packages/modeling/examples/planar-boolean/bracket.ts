import type { Result } from '@forgeax/engine-types';
import { booleanSolids } from '../../src/brep/boolean.ts';
import { box, extrude } from '../../src/brep/build.ts';
import { measure } from '../../src/brep/measure.ts';
import { makeFrame } from '../../src/brep/surfaces.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { ModelingError } from '../../src/errors.ts';

type P3 = readonly [number, number, number];

function must<T>(result: Result<T, ModelingError>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

/** Axis-aligned box given by its centre. */
export function block(size: [number, number, number], centre: [number, number, number]): Shape {
  return must(box({ size, frame: makeFrame(centre, [0, 0, 1], [1, 0, 0]), tol: 1e-8 }));
}

const GUSSET_TRIANGLE = [
  [-1.9, 0.8],
  [0.4, 0.8],
  [-1.9, 2.4],
] as const;

/** Triangular rib in the y-z plane, extruded along +x from x = 1.6 for 0.4. */
export function gusset(): Shape {
  return must(
    extrude({
      profile: GUSSET_TRIANGLE,
      depth: 0.4,
      frame: makeFrame([1.6, 0, 0], [1, 0, 0], [0, 1, 0]),
      tol: 1e-8,
    }),
  );
}

export interface BracketStep {
  readonly name: string;
  readonly op: 'union' | 'difference';
  readonly tool: Shape;
  /** Analytic membership of the tool, the independent oracle for the grid volume. */
  readonly contains: (p: P3) => boolean;
}

function inBox(size: P3, centre: P3): (p: P3) => boolean {
  return (p) =>
    Math.abs(p[0] - centre[0]) < size[0] / 2 &&
    Math.abs(p[1] - centre[1]) < size[1] / 2 &&
    Math.abs(p[2] - centre[2]) < size[2] / 2;
}

function inGusset(p: P3): boolean {
  if (p[0] <= 1.6 || p[0] >= 2.0) return false;
  const [a, b, c] = GUSSET_TRIANGLE;
  const side = (u: readonly [number, number], v: readonly [number, number]): number =>
    (v[0] - u[0]) * (p[2] - u[1]) - (v[1] - u[1]) * (p[1] - u[0]);
  const s = [side(a, b), side(b, c), side(c, a)];
  return s.every((x) => x > 0) || s.every((x) => x < 0);
}

export const BASE = {
  size: [6, 4, 2] as [number, number, number],
  centre: [0, 0, 0] as [number, number, number],
};

/**
 * Plate, back wall, a blind groove open to the +y edge, an edge boss, a gusset rib, then a pocket
 * in the boss top. The pocket is last because a non-convex operand with a holed face is refused.
 */
export const BRACKET_STEPS: readonly BracketStep[] = [
  {
    name: 'wall',
    op: 'union',
    tool: block([5.6, 0.8, 3.8], [0.1, -2.0, 0.7]),
    contains: inBox([5.6, 0.8, 3.8], [0.1, -2.0, 0.7]),
  },
  {
    name: 'groove',
    op: 'difference',
    tool: block([0.8, 4.4, 1.2], [-1, 0.8, 0.8]),
    contains: inBox([0.8, 4.4, 1.2], [-1, 0.8, 0.8]),
  },
  {
    name: 'boss',
    op: 'union',
    tool: block([1.2, 1.2, 1.5], [1.5, 2, 1.05]),
    contains: inBox([1.2, 1.2, 1.5], [1.5, 2, 1.05]),
  },
  { name: 'gusset', op: 'union', tool: gusset(), contains: inGusset },
  {
    name: 'pocket',
    op: 'difference',
    tool: block([0.5, 0.5, 1], [1.5, 2, 1.8]),
    contains: inBox([0.5, 0.5, 1], [1.5, 2, 1.8]),
  },
];

/**
 * The same parts in a different order: the pocket is cut right after the boss, so the boss top is a
 * holed face and the groove and gusset booleans take that holed result as an operand.
 */
export const HOLED_BRACKET_STEPS: readonly BracketStep[] = [
  {
    name: 'wall',
    op: 'union',
    tool: block([5.6, 0.8, 3.8], [0.1, -2.0, 0.7]),
    contains: inBox([5.6, 0.8, 3.8], [0.1, -2.0, 0.7]),
  },
  {
    name: 'boss',
    op: 'union',
    tool: block([1.2, 1.2, 1.5], [1.5, 2, 1.05]),
    contains: inBox([1.2, 1.2, 1.5], [1.5, 2, 1.05]),
  },
  {
    name: 'pocket',
    op: 'difference',
    tool: block([0.5, 0.5, 1], [1.5, 2, 1.8]),
    contains: inBox([0.5, 0.5, 1], [1.5, 2, 1.8]),
  },
  {
    name: 'groove',
    op: 'difference',
    tool: block([0.8, 4.4, 1.2], [-1, 0.8, 0.8]),
    contains: inBox([0.8, 4.4, 1.2], [-1, 0.8, 0.8]),
  },
  { name: 'gusset', op: 'union', tool: gusset(), contains: inGusset },
];

export interface BracketStage {
  readonly name: string;
  readonly shape: Shape;
  readonly faces: number;
  readonly volume: number;
  readonly gridVolume: number;
}

/** Midpoint-grid volume of the CSG predicate over the bracket's bounding box. */
function gridVolume(inside: (p: P3) => boolean): number {
  const lo: P3 = [-3, -2.4, -1.2];
  const hi: P3 = [3, 2.6, 2.6];
  const n = 150;
  const step = [(hi[0] - lo[0]) / n, (hi[1] - lo[1]) / n, (hi[2] - lo[2]) / n] as const;
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) {
        const p: P3 = [
          lo[0] + (i + 0.5) * step[0],
          lo[1] + (j + 0.5) * step[1],
          lo[2] + (k + 0.5) * step[2],
        ];
        if (inside(p)) count += 1;
      }
    }
  }
  return count * step[0] * step[1] * step[2];
}

/** Build the bracket one boolean at a time, each result feeding the next operation. */
export function buildBracket(steps: readonly BracketStep[] = BRACKET_STEPS): BracketStage[] {
  const baseShape = block(BASE.size, BASE.centre);
  const inBase = inBox(BASE.size, BASE.centre);
  let current = baseShape;
  const applied: BracketStep[] = [];
  const stages: BracketStage[] = [
    {
      name: 'plate',
      shape: current,
      faces: current.faces.length,
      volume: must(measure(current)).volume,
      gridVolume: gridVolume(inBase),
    },
  ];
  for (const step of steps) {
    current = must(booleanSolids(current, step.tool, step.op));
    applied.push(step);
    const inside = (p: P3): boolean => {
      let value = inBase(p);
      for (const s of applied)
        value = s.op === 'union' ? value || s.contains(p) : value && !s.contains(p);
      return value;
    };
    stages.push({
      name: step.name,
      shape: current,
      faces: current.faces.length,
      volume: must(measure(current)).volume,
      gridVolume: gridVolume(inside),
    });
  }
  return stages;
}
