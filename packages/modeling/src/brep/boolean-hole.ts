import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { type LoopEdge, ShapeAssembler } from './assembler';
import { brepFail, type Shape } from './types';
import { dist3, type P3, TWO_PI } from './vec';

/**
 * E1c slice 1: a box with a coaxial cylindrical through-hole along its z axis (box minus cylinder).
 *
 * The bore radius lies strictly inside the box footprint, so the hole pierces the top and bottom
 * faces as circular inner loops and the bore wall is one full-height cylinder with two circle loops.
 * Nothing is split along a seam here; the general split/classify path is slice 2.
 */
export interface ThroughHoleOptions {
  readonly size: P3;
  readonly radius: number;
  readonly label?: string;
}

function bad(why: string): Result<never, ModelingError> {
  return brepFail('brep-bad-argument', why, {});
}

export function boxWithThroughHole(options: ThroughHoleOptions): Result<Shape, ModelingError> {
  const [sx, sy, sz] = options.size;
  const r = options.radius;
  if (!(sx > 0 && sy > 0 && sz > 0)) return bad('a box with positive size');
  if (!(r > 0)) return bad('a positive hole radius');
  const span = Math.min(sx, sy);
  if (2 * r === span)
    return brepFail('brep-ssi-tangent', 'a bore tangent to a side face is not split in slice 1', {
      radius: r,
    });
  if (!(2 * r < span)) return bad('a hole radius that fits inside the box footprint');
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const asm = ShapeAssembler.create(Math.max(sx, sy, sz), undefined);
  if (!asm.ok) return asm;
  const a = asm.value;
  const label = options.label ?? 'box-hole';
  const faces: number[] = [];
  const addFace = (
    surface: number,
    loops: readonly (readonly LoopEdge[])[],
    reversed: boolean,
    name: string,
  ): Result<number, ModelingError> => {
    const ids: number[] = [];
    for (let i = 0; i < loops.length; i++) {
      const l = a.loop(surface, loops[i] as readonly LoopEdge[], i === 0);
      if (!l.ok) return l;
      ids.push(l.value);
    }
    return ok(a.face(surface, ids, reversed, `${label}.${name}`, ''));
  };

  // Outer square loop of a z-face at height `z` (counter-clockwise seen from +z).
  const square = (z: number): LoopEdge[] => {
    const p: P3[] = [
      [-hx, -hy, z],
      [hx, -hy, z],
      [hx, hy, z],
      [-hx, hy, z],
    ];
    return p.map((_, i) => lineEdge(a, p[i] as P3, p[(i + 1) % 4] as P3));
  };
  // Circle of the bore at height `z`, as one edge starting at +x.
  const circles = new Map<number, number>();
  const circleAt = (z: number): LoopEdge => {
    const known = circles.get(z);
    if (known !== undefined) return { edge: known };
    const curve = a.curve({
      kind: 'circle',
      frame: { o: [0, 0, z], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
      radius: r,
    });
    const edge = a.edge(curve, 0, TWO_PI);
    circles.set(z, edge);
    return { edge };
  };

  // Top (+z, outward +z) and bottom (-z, outward -z) planar faces, each with the bore as an inner loop.
  for (const [z, n] of [
    [hz, 1],
    [-hz, -1],
  ] as const) {
    const surface = a.surface({
      kind: 'plane',
      frame: { o: [0, 0, z], x: [1, 0, 0], y: n > 0 ? [0, 1, 0] : [0, -1, 0], z: [0, 0, n] },
    });
    // The inner loop runs clockwise in uv (a hole), so the bore circle is traversed reversed.
    const f = addFace(surface, [square(z), [circleAt(z)]], false, n > 0 ? 'top' : 'bottom');
    if (!f.ok) return f;
    faces.push(f.value);
  }

  // The four outer side faces, each a planar rectangle between the two z-squares.
  const corners: P3[] = [
    [-hx, -hy, 0],
    [hx, -hy, 0],
    [hx, hy, 0],
    [-hx, hy, 0],
  ];
  for (let i = 0; i < 4; i++) {
    const a0 = corners[i] as P3;
    const a1 = corners[(i + 1) % 4] as P3;
    const ex = unit2(a1[0] - a0[0], a1[1] - a0[1]);
    // Outward normal of this side: the edge direction turned clockwise in the plane.
    const nrm: P3 = [ex[1], -ex[0], 0];
    const surface = a.surface({
      kind: 'plane',
      frame: { o: a0, x: [ex[0], ex[1], 0], y: [0, 0, 1], z: nrm },
    });
    const z0 = -hz;
    const z1 = hz;
    const loop: LoopEdge[] = [
      lineEdge(a, [a0[0], a0[1], z0], [a1[0], a1[1], z0]),
      lineEdge(a, [a1[0], a1[1], z0], [a1[0], a1[1], z1]),
      lineEdge(a, [a1[0], a1[1], z1], [a0[0], a0[1], z1]),
      lineEdge(a, [a0[0], a0[1], z1], [a0[0], a0[1], z0]),
    ];
    const f = addFace(surface, [loop], false, `side${i}`);
    if (!f.ok) return f;
    faces.push(f.value);
  }

  // Bore wall: the cylinder's inward-facing side between the two bore circles.
  // The wall is one periodic face: its seam is a straight line used once up and once down, as in revolve.
  const wall = a.surface({
    kind: 'cylinder',
    frame: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
    radius: r,
  });
  const seam = lineEdge(a, [r, 0, -hz], [r, 0, hz]);
  const wallLoop: LoopEdge[] = [circleAt(-hz), seam, circleAt(hz), seam];
  const bore = addFace(wall, [wallLoop], true, 'bore');
  if (!bore.ok) return bore;
  faces.push(bore.value);

  a.shell(faces);
  return a.finish();
}

function unit2(x: number, y: number): [number, number] {
  const l = dist3([x, y, 0], [0, 0, 0]);
  return [x / l, y / l];
}

/** The straight edge between two points, shared by every face that asks for the same vertex pair. */
function lineEdge(a: ShapeAssembler, p: P3, q: P3): LoopEdge {
  const va = a.vertex(p);
  const vb = a.vertex(q);
  const key = va < vb ? `${va}:${vb}` : `${vb}:${va}`;
  const known = lines.get(a)?.get(key);
  if (known !== undefined) return { edge: known };
  const len = dist3(p, q);
  const d: P3 = [(q[0] - p[0]) / len, (q[1] - p[1]) / len, (q[2] - p[2]) / len];
  const curve = a.curve({ kind: 'line', o: p, d });
  const edge = a.edge(curve, 0, len);
  let m = lines.get(a);
  if (m === undefined) {
    m = new Map();
    lines.set(a, m);
  }
  m.set(key, edge);
  return { edge };
}

const lines = new WeakMap<ShapeAssembler, Map<string, number>>();
