import type { ModelingError } from '../../errors';
import { interpolate, type NurbsCurve, type NurbsSurface } from '../../nurbs';
import { type LoopEdge, ShapeAssembler } from '../assembler';
import type { Frame, PCurve, Shape } from '../types';
import { cross3, type P3 } from '../vec';

type Tup3 = [number, number, number];
const asTuple = (p: P3): Tup3 => [p[0], p[1], p[2]];

type P2 = readonly [number, number];

const TAU = 2 * Math.PI;
const ID: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

function must<T>(r: { ok: true; value: T } | { ok: false; error: ModelingError }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** A pcurve through `sample(t)` at n+1 uniform parameters, rescaled so its domain is [t0, t1]. */
export function sampledPCurve(sample: (t: number) => P2, t0: number, t1: number, n = 128): PCurve {
  const pts: Tup3[] = [];
  for (let i = 0; i <= n; i++) {
    const [u, v] = sample(t0 + ((t1 - t0) * i) / n);
    pts.push([u, v, 0]);
  }
  const fit = must(interpolate(pts.map(asTuple), { parametrization: 'uniform' }));
  const span = t1 - t0;
  return {
    kind: 'nurbs',
    curve: {
      degree: fit.degree,
      points: fit.points,
      knots: fit.knots.map((k) => t0 + k * span),
    },
  };
}

/** The straight parameter-space segment a to b over the edge parameter [0, 1]. */
export function linearPCurve(a: P2, b: P2): PCurve {
  return {
    kind: 'nurbs',
    curve: {
      degree: 1,
      points: [
        [a[0], a[1], 0],
        [b[0], b[1], 0],
      ],
      knots: [0, 0, 1, 1],
    },
  };
}

/**
 * A closed solid: a cylinder cut by the plane z = alpha + beta x. The side's trim is bounded by
 * the bottom circle, a seam line and the plane-cut ellipse, which is a sinusoid in (u, v): not a
 * rectangle. Volume is pi alpha for alpha > |beta|.
 */
export function obliqueCylinder(alpha: number, beta: number, radius = 1): Shape {
  const asm = must(ShapeAssembler.create(2 * (alpha + Math.abs(beta) * radius + radius)));
  const a = Math.hypot(1, beta);
  const top: Frame = {
    o: [0, 0, alpha],
    x: [1 / a, 0, beta / a],
    y: [0, 1, 0],
    z: cross3([1 / a, 0, beta / a], [0, 1, 0]),
  };
  const cyl = asm.surface({ kind: 'cylinder', frame: ID, radius });
  const bottom = asm.edge(asm.curve({ kind: 'circle', frame: ID, radius }), 0, TAU);
  const seam = asm.edge(
    asm.curve({
      kind: 'line',
      o: [radius, 0, 0],
      d: [0, 0, alpha + beta * radius],
    }),
    0,
    1,
  );
  const cut = asm.edge(
    asm.curve({ kind: 'ellipse', frame: top, a: radius * a, b: radius }),
    0,
    TAU,
  );
  const cutOnSide = sampledPCurve((t) => [t, alpha + beta * radius * Math.cos(t)], 0, TAU);
  const cutOnTop = sampledPCurve((t) => [radius * a * Math.cos(t), radius * Math.sin(t)], 0, TAU);
  const sideLoop = must(
    asm.loop(
      cyl,
      [{ edge: bottom }, { edge: seam }, { edge: cut, pcurve: cutOnSide }, { edge: seam }],
      true,
    ),
  );
  const bottomPlane = asm.surface({ kind: 'plane', frame: ID });
  const bottomLoop = must(asm.loop(bottomPlane, [{ edge: bottom }], true));
  const topPlane = asm.surface({ kind: 'plane', frame: top });
  const topLoop = must(asm.loop(topPlane, [{ edge: cut, pcurve: cutOnTop }], true));
  const faces = [
    asm.face(cyl, [sideLoop], false, 'side'),
    // Outward is -z, the frame normal is +z.
    asm.face(bottomPlane, [bottomLoop], true, 'bottom'),
    asm.face(topPlane, [topLoop], false, 'top'),
  ];
  asm.shell(faces);
  return must(asm.finish());
}

/**
 * A closed solid of six bilinear NURBS patches: an axis-aligned box of side `size`, every face a
 * degree-(1, 1) surface whose corners are the box corners. Each edge is a line shared by two faces.
 */
export function nurbsCube(size: number): Shape {
  const asm = must(ShapeAssembler.create(2 * size + 1));
  const corner = (x: number, y: number, z: number): Tup3 => [x * size, y * size, z * size];
  // Each face lists its corners at (u, v) = (0, 0), (1, 0), (0, 1), (1, 1).
  const faces: [number, number, number][][] = [
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
    [
      [0, 0, 1],
      [1, 0, 1],
      [0, 1, 1],
      [1, 1, 1],
    ],
    [
      [0, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0, 1, 1],
    ],
    [
      [1, 0, 0],
      [1, 1, 0],
      [1, 0, 1],
      [1, 1, 1],
    ],
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 0, 1],
      [1, 0, 1],
    ],
    [
      [0, 1, 0],
      [1, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
    ],
  ];
  const vertexOf = new Map<string, number>();
  const edgeOf = new Map<string, number>();
  const edgeFor = (a: [number, number, number], b: [number, number, number]): number => {
    const key = [JSON.stringify(a), JSON.stringify(b)].sort().join('|');
    const found = edgeOf.get(key);
    if (found !== undefined) return found;
    const pa = corner(...a);
    const pb = corner(...b);
    for (const [k, p] of [
      [JSON.stringify(a), pa],
      [JSON.stringify(b), pb],
    ] as const) {
      if (!vertexOf.has(k)) vertexOf.set(k, asm.vertex(p));
    }
    const curve = asm.curve({
      kind: 'line',
      o: pa,
      d: [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]],
    });
    const id = asm.edge(curve, 0, 1);
    edgeOf.set(key, id);
    return id;
  };
  const shellFaces: number[] = [];
  for (const grid of faces) {
    const [c00, c10, c01, c11] = grid as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ];
    const p = (c: [number, number, number]): Tup3 => corner(...c);
    const surface: NurbsSurface = {
      degreeU: 1,
      degreeV: 1,
      points: [
        [p(c00), p(c01)],
        [p(c10), p(c11)],
      ],
      knotsU: [0, 0, 1, 1],
      knotsV: [0, 0, 1, 1],
    };
    const s = asm.surface({ kind: 'nurbs', surface });
    // Parameter-space image of a corner on this face.
    const uv = (c: [number, number, number]): P2 => {
      if (JSON.stringify(c) === JSON.stringify(c00)) return [0, 0];
      if (JSON.stringify(c) === JSON.stringify(c10)) return [1, 0];
      if (JSON.stringify(c) === JSON.stringify(c01)) return [0, 1];
      return [1, 1];
    };
    const sides: [[number, number, number], [number, number, number]][] = [
      [c00, c10],
      [c10, c11],
      [c01, c11],
      [c00, c01],
    ];
    const edges: LoopEdge[] = sides.map(([a, b]) => ({
      edge: edgeFor(a, b),
      pcurve: linearPCurve(uv(a), uv(b)),
    }));
    // Normal du x dv at the centre; a face whose normal points inward is reversed.
    const sub = (x: P3, y: P3): P3 => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
    const add = (x: P3, y: P3): P3 => [x[0] + y[0], x[1] + y[1], x[2] + y[2]];
    const du = add(sub(p(c10), p(c00)), sub(p(c11), p(c01)));
    const dv = add(sub(p(c01), p(c00)), sub(p(c11), p(c10)));
    const n = cross3(du, dv);
    const centre: P3 = [size / 2, size / 2, size / 2];
    const outward: P3 = [
      add(p(c00), p(c11))[0] / 2 - centre[0],
      add(p(c00), p(c11))[1] / 2 - centre[1],
      add(p(c00), p(c11))[2] / 2 - centre[2],
    ];
    const reversed = n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0;
    const loop = must(asm.loop(s, edges, true));
    shellFaces.push(asm.face(s, [loop], reversed, 'patch'));
  }
  asm.shell(shellFaces);
  return must(asm.finish());
}

const CX = [1, 1, 0, -1, -1, -1, 0, 1, 1];
const CY = [0, 1, 1, 1, 0, -1, -1, -1, 0];
const W = [1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1];
const KU = [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1];

function rationalCircle(z: number): NurbsCurve {
  return {
    degree: 2,
    points: CX.map((x, i): Tup3 => [x, CY[i] as number, z]),
    weights: W,
    knots: KU,
  };
}

/**
 * A closed solid of a rational NURBS tube of radius 1 and the given height, closed by two planar
 * discs whose boundaries are the same rational circles. The tube's seam is one line used twice,
 * each use with its own parameter-space image (u = 1 and u = 0).
 */
export function nurbsTube(height: number): Shape {
  const asm = must(ShapeAssembler.create(2 * (height + 2)));
  const surface: NurbsSurface = {
    degreeU: 2,
    degreeV: 1,
    points: CX.map((x, i): Tup3[] => [
      [x, CY[i] as number, 0],
      [x, CY[i] as number, height],
    ]),
    weights: W.map((w) => [w, w]),
    knotsU: KU,
    knotsV: [0, 0, 1, 1],
  };
  const tube = asm.surface({ kind: 'nurbs', surface });
  const bottom = asm.edge(asm.curve({ kind: 'nurbs', curve: rationalCircle(0) }), 0, 1);
  const top = asm.edge(asm.curve({ kind: 'nurbs', curve: rationalCircle(height) }), 0, 1);
  const seam = asm.edge(asm.curve({ kind: 'line', o: [1, 0, 0], d: [0, 0, height] }), 0, 1);
  const sideLoop = must(
    asm.loop(
      tube,
      [
        { edge: bottom, pcurve: linearPCurve([0, 0], [1, 0]) },
        { edge: seam, pcurve: linearPCurve([1, 0], [1, 1]) },
        { edge: top, pcurve: linearPCurve([0, 1], [1, 1]) },
        { edge: seam, pcurve: linearPCurve([0, 0], [0, 1]) },
      ],
      true,
    ),
  );
  const planeUv: PCurve = { kind: 'nurbs', curve: rationalCircle(0) };
  const bottomPlane = asm.surface({ kind: 'plane', frame: ID });
  const bottomLoop = must(asm.loop(bottomPlane, [{ edge: bottom, pcurve: planeUv }], true));
  const topFrame: Frame = {
    o: [0, 0, height],
    x: [1, 0, 0],
    y: [0, 1, 0],
    z: [0, 0, 1],
  };
  const topPlane = asm.surface({ kind: 'plane', frame: topFrame });
  const topLoop = must(asm.loop(topPlane, [{ edge: top, pcurve: planeUv }], true));
  asm.shell([
    asm.face(tube, [sideLoop], false, 'tube'),
    asm.face(bottomPlane, [bottomLoop], true, 'bottom'),
    asm.face(topPlane, [topLoop], false, 'top'),
  ]);
  return must(asm.finish());
}
