// Trimmed and NURBS faces that exercise the constrained (u, v) tessellation. Each model is one face
// (or one closed solid) whose trim loops are polygons in parameter space. Every trim edge carries
// a 3D curve fitted through the surface along its (u, v) segment, so the loops lie on the surface
// and the sheets are exact to the fit tolerance. Sheets are open, so they are not `finish()`ed:
// `validate` would report their free boundary as edge-use issues.

import { type LoopEdge, ShapeAssembler } from '../../src/brep/assembler';
import { surfacePoint } from '../../src/brep/surfaces';
import type { Frame, Shape, Surface } from '../../src/brep/types';
import { cross3, type P2, type P3 } from '../../src/brep/vec';
import type { Tuple3 } from '../../src/geom';
import {
  interpolate,
  interpolateGrid,
  type NurbsSurface,
  surfacePoint as nurbsPoint,
} from '../../src/nurbs';

type At = (u: number, v: number) => P3;

const TAU = 2 * Math.PI;

/** A circle polygon (counter-clockwise) of `n` points. */
export function circle(cx: number, cy: number, r: number, n: number): P2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (TAU * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as P2;
  });
}

/** A slot: two half circles of radius r joined by straight sides, centres at (x0, y) and (x1, y). */
export function slot(x0: number, x1: number, y: number, r: number, n: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / n;
    out.push([x1 + r * Math.cos(a), y + r * Math.sin(a)]);
  }
  for (let i = 0; i <= n; i++) {
    const a = Math.PI / 2 + (Math.PI * i) / n;
    out.push([x0 + r * Math.cos(a), y + r * Math.sin(a)]);
  }
  return out;
}

/** The fitted 3D edge over the straight (u, v) segment a -> b, and its parameter-space trim. */
function fittedEdge(asm: ShapeAssembler, at: At, a: P2, b: P2): LoopEdge {
  const n = 24;
  const pts: Tuple3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = at(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
    pts.push([p[0], p[1], p[2]]);
  }
  const fit = interpolate(pts, { degree: 3, parametrization: 'uniform' });
  if (!fit.ok) throw new Error(JSON.stringify(fit.error));
  const curve = asm.curve({ kind: 'nurbs', curve: fit.value });
  return {
    edge: asm.edge(curve, 0, 1),
    pcurve: {
      kind: 'nurbs',
      curve: {
        degree: 1,
        points: [
          [a[0], a[1], 0],
          [b[0], b[1], 0],
        ],
        knots: [0, 0, 1, 1],
      },
    },
  };
}

function ringEdges(asm: ShapeAssembler, at: At, ring: readonly P2[]): LoopEdge[] {
  return ring.map((p, i) => fittedEdge(asm, at, p, ring[(i + 1) % ring.length] as P2));
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }, what: string): T {
  if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r.error)}`);
  return r.value;
}

/** An open NURBS sheet over the rectangle [0, w] x [0, h] in (u, v), trimmed by `outer` and `holes`. */
export function nurbsSheet(
  surface: NurbsSurface,
  diag: number,
  outer: readonly P2[],
  holes: readonly (readonly P2[])[],
): Shape {
  const asm = must(ShapeAssembler.create(diag), 'tolerance');
  const s = asm.surface({ kind: 'nurbs', surface });
  const at: At = (u, v) => nurbsPoint(surface, u, v) as P3;
  const loops = [
    must(asm.loop(s, ringEdges(asm, at, outer), true), 'outer loop'),
    ...holes.map((h) => must(asm.loop(s, ringEdges(asm, at, h), false), 'hole loop')),
  ];
  asm.shell([asm.face(s, loops, false, 'sheet')]);
  return openShape(asm);
}

/** The assembled arrays without the closed-solid validation (see the file header). */
function openShape(asm: ShapeAssembler): Shape {
  const priv = asm as unknown as Shape;
  return {
    tol: priv.tol,
    maxTol: priv.maxTol,
    vertices: priv.vertices,
    curves: priv.curves,
    surfaces: priv.surfaces,
    edges: priv.edges,
    coedges: priv.coedges,
    loops: priv.loops,
    faces: priv.faces,
    shells: priv.shells,
  } as Shape;
}

/** A flat plate (planar NURBS, bilinear) of size w x h with round, slotted and pattern holes. */
export function holedPlate(): { shape: Shape; area: number } {
  const w = 100;
  const h = 60;
  const flat: NurbsSurface = {
    degreeU: 1,
    degreeV: 1,
    points: [
      [
        [0, 0, 0],
        [0, h, 0],
      ],
      [
        [w, 0, 0],
        [w, h, 0],
      ],
    ],
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
  const toUv = (p: P2): P2 => [p[0] / w, p[1] / h];
  const corner = (cx: number, cy: number, r: number, from: number): P2[] =>
    Array.from({ length: 6 }, (_, i) => {
      const a = from + (Math.PI / 2) * (i / 5);
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as P2;
    });
  const outlineXY: P2[] = [
    ...corner(w - 8, 8, 8, -Math.PI / 2),
    ...corner(w - 8, h - 8, 8, 0),
    ...corner(8, h - 8, 8, Math.PI / 2),
    ...corner(8, 8, 8, Math.PI),
  ];
  const holesXY: P2[][] = [circle(24, 30, 9, 64), slot(46, 62, 30, 5, 16)];
  for (const x of [72, 84, 96]) for (const y of [18, 42]) holesXY.push(circle(x, y, 3, 24));
  const area = polygonArea(outlineXY) - holesXY.reduce((s, ring) => s + polygonArea(ring), 0);
  const asm = must(ShapeAssembler.create(w + h), 'tolerance');
  const s = asm.surface({ kind: 'nurbs', surface: flat });
  const at: At = (u, v) => nurbsPoint(flat, u, v) as P3;
  const loops = [
    must(asm.loop(s, ringEdges(asm, at, outlineXY.map(toUv)), true), 'plate outline'),
    ...holesXY.map((h2) =>
      must(asm.loop(s, ringEdges(asm, at, h2.map(toUv)), false), 'plate hole'),
    ),
  ];
  asm.shell([asm.face(s, loops, false, 'plate')]);
  return { shape: openShape(asm), area };
}

export function polygonArea(poly: readonly P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as P2;
    const q = poly[(i + 1) % poly.length] as P2;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** A bicubic NURBS patch over [0, 1]^2: a rippled dome, trimmed by an elliptic outline with one hole. */
export function wavyPatch(): Shape {
  const n = 9;
  const rows: Tuple3[][] = [];
  for (let i = 0; i < n; i++) {
    const row: Tuple3[] = [];
    for (let j = 0; j < n; j++) {
      const u = i / (n - 1);
      const v = j / (n - 1);
      const z =
        9 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v) +
        2 * Math.cos(TAU * u) * Math.sin(TAU * v);
      row.push([100 * u, 60 * v, z]);
    }
    rows.push(row);
  }
  const grid = must(
    interpolateGrid(rows, { parametrization: 'uniform', degreeU: 3, degreeV: 3 }),
    'patch',
  );
  const outer = Array.from({ length: 48 }, (_, i) => {
    const a = (TAU * i) / 48;
    return [0.5 + 0.44 * Math.cos(a), 0.5 + 0.42 * Math.sin(a)] as P2;
  });
  return nurbsSheet(grid, 130, outer, [circle(0.5, 0.5, 0.13, 40)]);
}

/** A cylinder of radius r cut by the plane z = alpha + beta x: an elliptic trimmed cap. */
export function obliqueCylinder(alpha: number, beta: number, r: number): Shape {
  const asm = must(ShapeAssembler.create(2 * (alpha + Math.abs(beta) * r + r)), 'tolerance');
  const id: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const a = Math.hypot(1, beta);
  const top: Frame = {
    o: [0, 0, alpha],
    x: [1 / a, 0, beta / a],
    y: [0, 1, 0],
    z: cross3([1 / a, 0, beta / a], [0, 1, 0]),
  };
  const cyl = asm.surface({ kind: 'cylinder', frame: id, radius: r });
  const bottom = asm.edge(asm.curve({ kind: 'circle', frame: id, radius: r }), 0, TAU);
  const seam = asm.edge(
    asm.curve({ kind: 'line', o: [r, 0, 0], d: [0, 0, alpha + beta * r] }),
    0,
    1,
  );
  const cut = asm.edge(asm.curve({ kind: 'ellipse', frame: top, a: r * a, b: r }), 0, TAU);
  const sideLoop = must(
    asm.loop(
      cyl,
      [
        { edge: bottom },
        { edge: seam },
        { edge: cut, pcurve: sampledLine((t) => [t, alpha + beta * r * Math.cos(t)]) },
        { edge: seam },
      ],
      true,
    ),
    'side loop',
  );
  const bottomPlane = asm.surface({ kind: 'plane', frame: id });
  const bottomLoop = must(asm.loop(bottomPlane, [{ edge: bottom }], true), 'bottom loop');
  const topPlane = asm.surface({ kind: 'plane', frame: top });
  const topLoop = must(
    asm.loop(
      topPlane,
      [{ edge: cut, pcurve: sampledLine((t) => [r * a * Math.cos(t), r * Math.sin(t)]) }],
      true,
    ),
    'top loop',
  );
  asm.shell([
    asm.face(cyl, [sideLoop], false, 'side'),
    asm.face(bottomPlane, [bottomLoop], true, 'bottom'),
    asm.face(topPlane, [topLoop], false, 'top'),
  ]);
  return must(asm.finish(), 'cylinder');
}

/** A pcurve through `sample(t)` over [0, TAU], fitted uniformly (the ellipse trim is not a line). */
function sampledLine(sample: (t: number) => P2): NonNullable<LoopEdge['pcurve']> {
  const pts: Tuple3[] = [];
  const n = 128;
  for (let i = 0; i <= n; i++) {
    const [u, v] = sample((TAU * i) / n);
    pts.push([u, v, 0]);
  }
  const fit = must(interpolate(pts, { parametrization: 'uniform' }), 'pcurve');
  return {
    kind: 'nurbs',
    curve: { degree: fit.degree, points: fit.points, knots: fit.knots.map((k) => TAU * k) },
  };
}

/**
 * A spherical cap of radius R about +z, from latitude v0 to the pole, with one hole. The cap loop
 * is the latitude circle, a meridian seam used twice, and the degenerate pole edge.
 */
export function sphereCapWithHole(radius: number, v0: number): { shape: Shape; capArea: number } {
  const asm = must(ShapeAssembler.create(2 * radius), 'tolerance');
  const f: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const surface: Surface = { kind: 'sphere', frame: f, radius };
  const s = asm.surface(surface);
  const at: At = (u, v) => surfacePoint(surface, u, v);
  const latitude = asm.edge(
    asm.curve({
      kind: 'circle',
      frame: { o: [0, 0, radius * Math.sin(v0)], x: f.x, y: f.y, z: f.z },
      radius: radius * Math.cos(v0),
    }),
    0,
    TAU,
  );
  const meridian = asm.edge(
    asm.curve({
      kind: 'circle',
      frame: { o: f.o, x: f.x, y: f.z, z: cross3(f.x, f.z) },
      radius,
    }),
    v0,
    Math.PI / 2,
  );
  const north = asm.degenerateEdge(asm.vertex([0, 0, radius]));
  const outer = must(
    asm.loop(
      s,
      [
        { edge: latitude },
        { edge: meridian },
        { edge: north, span: [-TAU, 0] },
        { edge: meridian },
      ],
      true,
    ),
    'cap loop',
  );
  const hole = circle(3.0, 0.95, 0.22, 32).map((p) => p as P2);
  const holeLoop = must(asm.loop(s, ringEdges(asm, at, hole), false), 'cap hole');
  asm.shell([asm.face(s, [outer, holeLoop], false, 'cap')]);
  return { shape: openShape(asm), capArea: TAU * radius * radius * (1 - Math.sin(v0)) };
}
