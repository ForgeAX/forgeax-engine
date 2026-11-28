import { err, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { type LoopEdge, ShapeAssembler } from './assembler';
import type { ToleranceOptions } from './tolerance';
import { brepError, type Frame, type Shape } from './types';
import { cross3, dist3, dot3, HALF_PI, madd3, type P3, scale3, sub3, unit3 } from './vec';

export interface FilletBoxOptions extends ToleranceOptions {
  /** Full edge lengths along the world x, y and z. */
  readonly size: P3;
  /** Radius of every edge fillet and vertex sphere; the box is centred on the origin. */
  readonly radius: number;
  readonly label?: string;
}

/**
 * A box with all twelve edges filleted by one radius. Built directly from its closed-form pieces:
 * six inset planes, twelve quarter cylinders (one per edge) and eight octant spheres (one per
 * corner, pole at the corner's +-axis tangent point). Volume and area follow the Steiner formulas
 * of the inner box `L = size - 2 r` Minkowski-summed with a ball of radius `r`.
 */
export function filletBox(options: FilletBoxOptions): Result<Shape, ModelingError> {
  const { size, radius: r } = options;
  const bad = (why: string, ids?: Record<string, unknown>) =>
    err(brepError('brep-bad-argument', why, ids));
  if (!Array.isArray(size) || size.length !== 3) return bad('size is [x, y, z]');
  if (!size.every((s) => Number.isFinite(s) && s > 0)) {
    return bad('size components are finite and greater than 0');
  }
  if (!(Number.isFinite(r) && r > 0)) return bad('radius is a finite number greater than 0');
  const H: P3 = [size[0] / 2, size[1] / 2, size[2] / 2];
  if (H.some((h) => !(r < h))) {
    return bad('radius below half of every size component', { reason: 'radius-too-large' });
  }
  const I: P3 = [H[0] - r, H[1] - r, H[2] - r];
  const diag = Math.sqrt(size[0] * size[0] + size[1] * size[1] + size[2] * size[2]);
  const made = ShapeAssembler.create(diag, options);
  if (!made.ok) return made;
  const asm = made.value;
  const label = options.label ?? 'filleted-box';
  const comp = (v: P3, i: number): number => v[i] as number;
  const axis = (k: number): P3 => AXES[k] as P3;
  const AXES: P3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  const lines = new Map<string, number>();
  const line = (a: P3, b: P3): LoopEdge => {
    const va = asm.vertex(a);
    const vb = asm.vertex(b);
    const key = va < vb ? `${va}:${vb}` : `${vb}:${va}`;
    let edge = lines.get(key);
    if (edge === undefined) {
      const curve = asm.curve({ kind: 'line', o: a, d: unit3(sub3(b, a)) });
      edge = asm.edge(curve, 0, dist3(a, b));
      lines.set(key, edge);
    }
    return { edge };
  };

  // Quarter circle of radius r about `center` from `pa` to `pb`; shared by the cylinder and the
  // sphere that meet along it, so the key is the vertex pair.
  const arcs = new Map<string, number>();
  const arc = (center: P3, pa: P3, pb: P3): LoopEdge => {
    const va = asm.vertex(pa);
    const vb = asm.vertex(pb);
    const key = va < vb ? `${va}:${vb}` : `${vb}:${va}`;
    let edge = arcs.get(key);
    if (edge === undefined) {
      const sa = sub3(pa, center);
      const sb = sub3(pb, center);
      const normal = unit3(cross3(sa, sb));
      const x = unit3(sa);
      const frame: Frame = { o: center, x, y: cross3(normal, x), z: normal };
      const curve = asm.curve({ kind: 'circle', frame, radius: r });
      edge = asm.edge(curve, 0, HALF_PI);
      arcs.set(key, edge);
    }
    return { edge };
  };

  const faces: number[] = [];

  // Six planes: rectangles of half extents I on the two tangent axes, at distance H on the normal.
  for (let k = 0; k < 3; k++) {
    const i = (k + 1) % 3;
    const j = (k + 2) % 3;
    for (const s of [1, -1]) {
      const center = scale3(axis(k), s * comp(H, k));
      const x = axis(i);
      const z = scale3(axis(k), s);
      const y = cross3(z, x);
      const pt = (a: number, b: number): P3 =>
        madd3(madd3(center, x, a * comp(I, i)), y, b * comp(I, j));
      const corners = [pt(-1, -1), pt(1, -1), pt(1, 1), pt(-1, 1)];
      const surface = asm.surface({ kind: 'plane', frame: { o: center, x, y, z } });
      const loop = corners.map((p, n) => line(p, corners[(n + 1) % 4] as P3));
      const l = asm.loop(surface, loop, true);
      if (!l.ok) return l;
      faces.push(asm.face(surface, [l.value], false, `${label}.p${k}${s > 0 ? '+' : '-'}`));
    }
  }

  // Twelve edge quarter cylinders, one per edge, spanning the box edge length 2 I along its axis.
  for (let k = 0; k < 3; k++) {
    const i = (k + 1) % 3;
    const j = (k + 2) % 3;
    for (const si of [1, -1]) {
      for (const sj of [1, -1]) {
        const o = madd3(scale3(axis(i), si * comp(I, i)), axis(j), sj * comp(I, j));
        const x2 = scale3(axis(i), si);
        const y2 = scale3(axis(j), sj);
        const z = cross3(x2, y2);
        const surface = asm.surface({
          kind: 'cylinder',
          frame: { o, x: x2, y: y2, z },
          radius: r,
        });
        const ax = axis(k);
        const pt = (theta: 'a' | 'b', sk: number): P3 => {
          const d = theta === 'a' ? x2 : y2;
          return madd3(madd3(o, d, r), ax, sk * comp(I, k));
        };
        const centerTop = madd3(o, ax, comp(I, k));
        const centerBot = madd3(o, ax, -comp(I, k));
        const seamA = line(pt('a', -1), pt('a', 1));
        const topArc = arc(centerTop, pt('a', 1), pt('b', 1));
        const seamB = line(pt('b', 1), pt('b', -1));
        const botArc = arc(centerBot, pt('b', -1), pt('a', -1));
        const l = asm.loop(surface, [seamA, topArc, seamB, botArc], true);
        if (!l.ok) return l;
        faces.push(asm.face(surface, [l.value], false, `${label}.e${k}${si}${sj}`));
      }
    }
  }

  // Eight octant spheres. Frame pole = the corner's +-z tangent point C; A and B are the x and y
  // tangent points and sit on the equator. The octant is a rectangle in (u, v) with the pole edge.
  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      for (const sz of [1, -1]) {
        const c: P3 = [sx * comp(I, 0), sy * comp(I, 1), sz * comp(I, 2)];
        const A = madd3(c, axis(0), sx * r);
        const B = madd3(c, axis(1), sy * r);
        const C = madd3(c, axis(2), sz * r);
        const z = scale3(axis(2), sz);
        const x = scale3(axis(0), sx);
        const y = cross3(z, x);
        const surface = asm.surface({ kind: 'sphere', frame: { o: c, x, y, z }, radius: r });
        const uB = dot3(sub3(B, c), y) > 0 ? 1 : -1;
        const pole = asm.degenerateEdge(asm.vertex(C));
        const ab = arc(c, A, B);
        const bc = arc(c, B, C);
        const ca = arc(c, C, A);
        const span: [number, number] = [-HALF_PI, 0];
        const loop: LoopEdge[] =
          uB > 0 ? [ab, bc, { edge: pole, span }, ca] : [ca, { edge: pole, span }, bc, ab];
        const l = asm.loop(surface, loop, true);
        if (!l.ok) return l;
        faces.push(asm.face(surface, [l.value], false, `${label}.c${sx}${sy}${sz}`));
      }
    }
  }
  asm.shell(faces);
  return asm.finish();
}
