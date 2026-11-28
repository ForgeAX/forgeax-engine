import { type HealResult, heal } from '../../src/brep/heal.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { P3 } from '../../src/brep/vec.ts';
import {
  displaceVertex,
  duplicateVertex,
  edgeNear,
  must,
  shiftEdgeCurve,
  sliverEdge,
  sliverFace,
  unsewEdge,
  vertexAt,
} from './damage.ts';
import { buildHousing, buildPlate, buildStandoff } from './parts.ts';

export interface HealCase {
  readonly name: string;
  /** What was done to the part, one line per damage. */
  readonly damage: readonly string[];
  readonly clean: Shape;
  readonly damaged: Shape;
  /** Number of damage sites a repair is expected to remove (the rest must stay reported). */
  readonly unrepairable: number;
}

function faceByLabel(shape: Shape, label: string): number {
  const i = shape.faces.findIndex((f) => f.label === label);
  if (i < 0) throw new Error(`no face ${label}`);
  return i;
}

function edgeAtMid(shape: Shape, p: P3): number {
  const i = edgeNear(shape, p);
  if (i < 0) throw new Error('no edge');
  return i;
}

/** The bracket with four kinds of damage at four different corners. */
export function damagedBracket(): HealCase {
  const clean = buildPlate();
  // sliver face first (an edit needs an editable shape), then raw damage by position
  let s = sliverFace(clean, faceByLabel(clean, 'extrude.side2'), 0.003);
  s = duplicateVertex(s, vertexAt(s, [60, 18, 8]), [
    edgeAtMid(s, [60, 9, 8]),
    edgeAtMid(s, [39, 18, 8]),
  ]);
  s = displaceVertex(s, vertexAt(s, [18, 60, 8]), [0, 0.002, 0.002]);
  s = unsewEdge(s, edgeAtMid(s, [0, 45, 8]));
  return {
    name: 'bracket',
    damage: [
      'sliver face 0.003 wide cut off an end face',
      'duplicate vertex (60,18,8) shared by two edges',
      'vertex (18,60,8) moved 0.0028 off its edges',
      'edge (0,45,8) unsewn: own vertices, one face still uses the copy',
    ],
    clean,
    damaged: s,
    unrepairable: 0,
  };
}

export function damagedHousing(): HealCase {
  const clean = buildHousing();
  let s = sliverEdge(clean, edgeAtMid(clean, [40, 0, 18]), 0.003);
  s = shiftEdgeCurve(s, edgeAtMid(s, [80 - 3, 25, 18]), [0.002, 0, 0]);
  s = duplicateVertex(s, vertexAt(s, [20, 14, 0]), [edgeAtMid(s, [40, 14, 0])]);
  s = unsewEdge(s, edgeAtMid(s, [60, 25, 9]));
  return {
    name: 'housing',
    damage: [
      'sliver edge 0.003 long split off the front rim',
      'edge on the right flank moved 0.002 off its faces',
      'duplicate vertex at the window corner (20,14,0)',
      'window-corner edge unsewn',
    ],
    clean,
    damaged: s,
    unrepairable: 0,
  };
}

export function damagedStandoff(): HealCase {
  const clean = buildStandoff();
  let s = displaceVertex(clean, vertexAt(clean, [6, 0, 10]), [0.002, 0, 0]);
  s = unsewEdge(s, edgeAtMid(s, [6, 0, 0]));
  return {
    name: 'standoff',
    damage: ['top seam vertex moved 0.002 off the rim', 'cylinder seam unsewn'],
    clean,
    damaged: s,
    unrepairable: 0,
  };
}

/** A gap larger than the shape's tolerance budget: heal must report it, not hide it. */
export function tooWide(): HealCase {
  const clean = buildHousing();
  const s = shiftEdgeCurve(clean, edgeAtMid(clean, [40, 0, 18]), [0.05, 0, 0]);
  return {
    name: 'housing-too-wide',
    damage: ['front rim edge (40,0,18) moved 0.05 off its faces, over maxTol (0.0096)'],
    clean,
    damaged: s,
    unrepairable: 1,
  };
}

export function allCases(): HealCase[] {
  return [damagedBracket(), damagedHousing(), damagedStandoff(), tooWide()];
}

export function healed(c: HealCase): HealResult {
  return must(heal(c.damaged));
}
