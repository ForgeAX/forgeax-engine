import { err, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { type LoopEdge, ShapeAssembler } from './assembler';
import type { ToleranceOptions } from './tolerance';
import { brepError, type Frame, type Shape } from './types';
import { cross3, dist3, type P2, type P3, sub3, unit3 } from './vec';

export interface TubOptions extends ToleranceOptions {
  /** Outer rectangle as [xmin, ymin, xmax, ymax] in the world xy plane. */
  readonly outer: readonly [number, number, number, number];
  /** Outer height from z = 0 to z = height; the top is open. */
  readonly height: number;
  /** Wall thickness per side: [xmin, ymin, xmax, ymax] inward offsets. A zero side is not allowed. */
  readonly walls: readonly [number, number, number, number];
  /** Floor thickness measured up from z = 0. */
  readonly floor: number;
  readonly label?: string;
}

/**
 * A rectangular open-top tub with an independent thickness on each of its four walls. The outer
 * box is the usual solid; the cavity is the outer rectangle inset by each wall and reaches up
 * from the floor to the top. Built from planes only: the outer box (6 faces), the cavity's four
 * inner walls and floor (reversed), and the rim as one planar annulus at the top. No boolean.
 *
 * Volume is the outer box minus the cavity box, V = X Y H - (X - w_l - w_r)(Y - w_b - w_t)(H - f).
 */
export function tub(options: TubOptions): Result<Shape, ModelingError> {
  const bad = (why: string, ids?: Record<string, unknown>) =>
    err(brepError('brep-bad-argument', why, ids));
  const { outer, height: H, walls, floor: f } = options;
  if (!(Number.isFinite(H) && H > 0)) return bad('height is a finite number greater than 0');
  if (!(Number.isFinite(f) && f > 0 && f < H)) return bad('floor in (0, height)');
  if (!outer.every((v) => Number.isFinite(v))) return bad('outer rectangle is finite');
  const [x0, y0, x1, y1] = outer;
  if (!(x1 > x0 && y1 > y0)) return bad('outer rectangle with positive extent');
  if (!walls.every((w) => Number.isFinite(w) && w > 0)) {
    return bad('every wall thickness is a finite number greater than 0');
  }
  const [wl, wb, wr, wt] = walls;
  if (!(x1 - x0 > wl + wr && y1 - y0 > wb + wt)) {
    return bad('walls leave a cavity');
  }

  const ix0 = x0 + wl;
  const iy0 = y0 + wb;
  const ix1 = x1 - wr;
  const iy1 = y1 - wt;
  const made = ShapeAssembler.create(
    Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0) + H * H),
    options,
  );
  if (!made.ok) return made;
  const asm = made.value;
  const label = options.label ?? 'tub';

  const lines = new Map<string, number>();
  const line = (a: P3, b: P3): LoopEdge => {
    const va = asm.vertex(a);
    const vb = asm.vertex(b);
    const key = va < vb ? `${va}:${vb}` : `${vb}:${va}`;
    let found = lines.get(key);
    if (found === undefined) {
      found = asm.edge(asm.curve({ kind: 'line', o: a, d: unit3(sub3(b, a)) }), 0, dist3(a, b));
      lines.set(key, found);
    }
    return { edge: found };
  };

  // A planar face with a given outward normal; its loop is reordered CCW about that normal.
  const faces: number[] = [];
  const failures: (ModelingError | undefined)[] = [];
  const planar = (pts: P3[], normal: P3, name: string): void => {
    const o = pts[0] as P3;
    const x = unit3(sub3(pts[1] as P3, o));
    const z = unit3(normal);
    const y = cross3(z, x);
    const coords = pts.map((p): P2 => {
      const v = sub3(p, o);
      return [v[0] * x[0] + v[1] * x[1] + v[2] * x[2], v[0] * y[0] + v[1] * y[1] + v[2] * y[2]];
    });
    let area = 0;
    for (let i = 0; i < coords.length; i++) {
      const p = coords[i] as P2;
      const q = coords[(i + 1) % coords.length] as P2;
      area += p[0] * q[1] - q[0] * p[1];
    }
    const loopPts = area > 0 ? pts : [...pts].reverse();
    const frame: Frame = { o, x, y, z };
    const surface = asm.surface({ kind: 'plane', frame });
    const loop = loopPts.map((p, k) => line(p, loopPts[(k + 1) % loopPts.length] as P3));
    const l = asm.loop(surface, loop, true);
    if (!l.ok) {
      failures.push(l.error);
      return;
    }
    faces.push(asm.face(surface, [l.value], false, name));
  };

  const z0 = 0;
  const z1 = H;
  // Outer box: bottom, top, four sides. Corners in CCW order of the xy rectangle.
  const outerCorners = (z: number): P3[] => [
    [x0, y0, z],
    [x1, y0, z],
    [x1, y1, z],
    [x0, y1, z],
  ];
  planar(outerCorners(z0), [0, 0, -1], `${label}.outer-bottom`);
  const sides: [P3, P3, P3, P3][] = [
    [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y0, z1],
      [x0, y0, z1],
    ],
    [
      [x1, y0, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [x1, y0, z1],
    ],
    [
      [x1, y1, z0],
      [x0, y1, z0],
      [x0, y1, z1],
      [x1, y1, z1],
    ],
    [
      [x0, y1, z0],
      [x0, y0, z0],
      [x0, y0, z1],
      [x0, y1, z1],
    ],
  ];
  const sideNames = ['outer-south', 'outer-east', 'outer-north', 'outer-west'];
  sides.forEach((quad, i) => {
    const [a, b] = quad;
    const normal = cross3(sub3(b, a), [0, 0, 1]);
    planar([...quad], normal, `${label}.${sideNames[i]}`);
  });

  // Cavity walls face into the cavity (reversed normals) and the floor faces up.
  const fz = f;
  planar(
    [
      [ix0, iy0, fz],
      [ix1, iy0, fz],
      [ix1, iy1, fz],
      [ix0, iy1, fz],
    ],
    [0, 0, 1],
    `${label}.floor`,
  );
  const cavitySides: [P3, P3, P3, P3][] = [
    [
      [ix0, iy0, fz],
      [ix1, iy0, fz],
      [ix1, iy0, z1],
      [ix0, iy0, z1],
    ],
    [
      [ix1, iy0, fz],
      [ix1, iy1, fz],
      [ix1, iy1, z1],
      [ix1, iy0, z1],
    ],
    [
      [ix1, iy1, fz],
      [ix0, iy1, fz],
      [ix0, iy1, z1],
      [ix1, iy1, z1],
    ],
    [
      [ix0, iy1, fz],
      [ix0, iy0, fz],
      [ix0, iy0, z1],
      [ix0, iy1, z1],
    ],
  ];
  cavitySides.forEach((quad, i) => {
    const [a, b] = quad;
    const normal = cross3([0, 0, 1], sub3(b, a));
    planar([...quad], normal, `${label}.cavity-${sideNames[i]}`);
  });

  // Rim: the top annulus between the outer and cavity rectangles.
  const topOuter: LoopEdge[] = [];
  const topInner: LoopEdge[] = [];
  const oc = outerCorners(z1);
  const ic: P3[] = [
    [ix0, iy0, z1],
    [ix1, iy0, z1],
    [ix1, iy1, z1],
    [ix0, iy1, z1],
  ];
  for (let i = 0; i < 4; i++) {
    topOuter.push(line(oc[i] as P3, oc[(i + 1) % 4] as P3));
    topInner.push(line(ic[(i + 3) % 4] as P3, ic[i] as P3));
  }
  const rimSurface = asm.surface({
    kind: 'plane',
    frame: { o: [x0, y0, z1], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
  });
  const rimLoop = asm.loop(rimSurface, topOuter, true);
  const rimHole = asm.loop(rimSurface, topInner, false);
  if (!rimLoop.ok) failures.push(rimLoop.error);
  else if (!rimHole.ok) failures.push(rimHole.error);
  else faces.push(asm.face(rimSurface, [rimLoop.value, rimHole.value], false, `${label}.rim`));

  const first = failures.find((e) => e !== undefined);
  if (first !== undefined) return err(first);
  asm.shell(faces);
  return asm.finish();
}
