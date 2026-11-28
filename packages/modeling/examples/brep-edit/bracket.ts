import { extrude } from '../../src/brep/build.ts';
import { holeLoops, removeHole, simplify, splitFace } from '../../src/brep/edit.ts';
import { measure } from '../../src/brep/measure.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { P2 } from '../../src/brep/vec.ts';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const THICKNESS = 8;

/** An L-shaped angle plate. (30, 0) and (0, 30) are collinear, so each long side starts as two coplanar faces. */
const OUTLINE: P2[] = [
  [0, 0],
  [30, 0],
  [60, 0],
  [60, 18],
  [18, 18],
  [18, 60],
  [0, 60],
  [0, 30],
];

function octagon(cx: number, cy: number, r: number): P2[] {
  return Array.from({ length: 8 }, (_, k): P2 => {
    const a = ((k + 0.5) * Math.PI) / 4;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

/** A vertical slot: two semicircular ends of `sides` segments joined by straight sides. */
function slot(cx: number, y0: number, y1: number, r: number, sides = 6): P2[] {
  const ring: P2[] = [];
  for (let k = 0; k <= sides; k++) {
    const a = (k * Math.PI) / sides;
    ring.push([cx + r * Math.cos(a), y1 + r * Math.sin(a)]);
  }
  for (let k = 0; k <= sides; k++) {
    const a = Math.PI + (k * Math.PI) / sides;
    ring.push([cx + r * Math.cos(a), y0 + r * Math.sin(a)]);
  }
  return ring;
}

const CORNER_HOLE = octagon(9, 9, 3.5);
const FOOT_HOLE = octagon(38, 9, 4);
const SPARE_HOLE = octagon(52, 9, 4);
const SLOT = slot(9, 30, 50, 3);

export interface Bracket {
  readonly raw: Shape;
  readonly filled: Shape;
  readonly split: Shape;
  readonly simplified: Shape;
  /** Volume of the simplified shape, measured. */
  readonly volume: number;
  /** Volume of the raw plate by the shoelace area of its outlines times the thickness. */
  readonly expectedVolume: number;
  /** Faces of raw, filled, split, simplified. */
  readonly faceCounts: readonly number[];
}

function shoelace(ring: readonly P2[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i] as P2;
    const q = ring[(i + 1) % ring.length] as P2;
    s += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(s) / 2;
}

/** Plate area minus the holes that remain after the edits (the foot hole is filled). */
function expectedPlateVolume(holes: readonly (readonly P2[])[]): number {
  return (shoelace(OUTLINE) - holes.reduce((a, h) => a + shoelace(h), 0)) * THICKNESS;
}

function faceByLabel(shape: Shape, label: string): number {
  const at = shape.faces.findIndex((f) => f.label === label);
  if (at < 0) throw new Error(`face ${label} missing`);
  return at;
}

/** The cap face and hole loop whose hole is centred nearest `(x, y)`. */
function holeAt(shape: Shape, x: number, y: number): { face: number; loop: number } {
  const cap = faceByLabel(shape, 'extrude.top');
  let best: { face: number; loop: number } | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const loop of holeLoops(shape, cap)) {
    let sx = 0;
    let sy = 0;
    const coedges = (shape.loops[loop] as { coedges: readonly number[] }).coedges;
    for (const c of coedges) {
      const co = shape.coedges[c] as { edge: number; reversed: boolean };
      const e = shape.edges[co.edge] as { v0: number; v1: number };
      const p = (shape.vertices[co.reversed ? e.v1 : e.v0] as { p: readonly number[] }).p;
      sx += p[0] as number;
      sy += p[1] as number;
    }
    const d = Math.abs(sx / coedges.length - x) + Math.abs(sy / coedges.length - y);
    if (d < bestDistance) {
      bestDistance = d;
      best = { face: cap, loop };
    }
  }
  if (best === undefined) throw new Error('no hole on the cap');
  return best;
}

/**
 * An L angle plate with three mounting holes and a slot, edited four ways: remove one hole, split an end face,
 * then simplify (re-merges the split and the two collinear long sides). There is no cylindrical boss: that needs
 * the boolean union, which is not part of this edit slice.
 */
export function buildBracket(): Bracket {
  const raw = must(
    extrude({
      profile: OUTLINE,
      holes: [CORNER_HOLE, FOOT_HOLE, SPARE_HOLE, SLOT],
      depth: THICKNESS,
    }),
  );
  const target = holeAt(raw, 38, 9);
  const filled = must(removeHole(raw, target.face, target.loop)).shape;
  const end = faceByLabel(filled, 'extrude.side2');
  const cut = must(splitFace(filled, end, { axis: 'u', at: 9 }));
  const simplified = must(simplify(cut.shape)).shape;
  return {
    raw,
    filled,
    split: cut.shape,
    simplified,
    volume: must(measure(simplified)).volume,
    expectedVolume: expectedPlateVolume([CORNER_HOLE, SPARE_HOLE, SLOT]),
    faceCounts: [
      raw.faces.length,
      filled.faces.length,
      cut.shape.faces.length,
      simplified.faces.length,
    ],
  };
}
