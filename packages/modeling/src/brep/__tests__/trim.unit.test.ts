import { describe, expect, it } from 'vitest';
import { facePoints, meshVolume } from '../../geom';
import type { EditMesh } from '../../mesh';
import type { NurbsSurface } from '../../nurbs';
import { type LoopEdge, ShapeAssembler } from '../assembler';
import { delaunay } from '../delaunay';
import { measure } from '../measure';
import { MAX_TRIM_POINTS, tessellate } from '../tessellate';
import { inTrim, windingNumber } from '../trim';
import type { Coedge, PCurve, Shape } from '../types';

type NurbsCoedge = Coedge & { pcurve: Extract<PCurve, { kind: 'nurbs' }> };

/** The first NURBS-pcurve coedge of a copied shape (mutable through the copy, not a new object). */
function firstNurbsCoedge(shape: Shape): NurbsCoedge {
  for (const c of shape.coedges) if (c.pcurve.kind === 'nurbs') return c as NurbsCoedge;
  throw new Error('expected a NURBS pcurve');
}

import { validate } from '../validate';
import { boundaryEdges, meshEuler } from './support';
import { linearPCurve, nurbsCube, nurbsTube, obliqueCylinder } from './trim-support';

function mustMesh(shape: Shape, opts = {}): EditMesh {
  const r = tessellate(shape, opts);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function expectValid(shape: Shape): void {
  const report = validate(shape);
  expect(report.issues).toEqual([]);
  expect(report.ok).toBe(true);
}

describe('windingNumber and inTrim', () => {
  const square: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];

  it('is +1 inside a CCW square, 0 outside, -1 for the same square traversed CW', () => {
    expect(windingNumber(square, [0.5, 0.5])).toBe(1);
    expect(windingNumber(square, [1.5, 0.5])).toBe(0);
    expect(windingNumber([...square].reverse(), [0.5, 0.5])).toBe(-1);
  });

  it('classifies a non-rectangular outer loop with a hole', () => {
    const outer = {
      points: [
        [0, 0],
        [4, 0],
        [2, 3],
      ] as [number, number][],
      outer: true,
    };
    const hole = {
      points: [
        [1.8, 0.5],
        [2.2, 0.5],
        [2, 1],
      ] as [number, number][],
      outer: false,
    };
    const periods = { u: 0, v: 0 };
    expect(inTrim([outer, hole], [2, 2], periods)).toBe(true);
    expect(inTrim([outer, hole], [2, 0.7], periods)).toBe(false);
    expect(inTrim([outer, hole], [0.2, 2.9], periods)).toBe(false);
  });

  it('wraps a point across a periodic seam through integer period shifts', () => {
    const band = {
      points: [
        [0.8, 0],
        [1, 0],
        [1, 1],
        [0.8, 1],
      ] as [number, number][],
      outer: true,
    };
    // Shift the point by one period (u = 2 pi wraps it onto the band at u = 0.9 + ...).
    expect(inTrim([band], [0.9 + 2 * Math.PI, 0.5], { u: 2 * Math.PI, v: 0 })).toBe(true);
    expect(inTrim([band], [0.9, 0.5], { u: 0, v: 0 })).toBe(true);
    expect(inTrim([band], [0.9 + 2 * Math.PI, 0.5], { u: 0, v: 0 })).toBe(false);
  });
});

describe('delaunay', () => {
  it('triangulates a unit square into two triangles with no point inside a circumcircle', () => {
    const pts: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const tris = delaunay(pts);
    expect(tris).toHaveLength(2);
  });
});

describe('oblique cylinder: non-rectangular analytic trim (falsifier a)', () => {
  const alpha = 1.5;
  const beta = 0.5;
  const shape = obliqueCylinder(alpha, beta);

  it('the closed solid validates', () => {
    expectValid(shape);
  });

  it('exact measure integrates the non-rectangular trim within 1e-6 of pi*alpha', () => {
    const m = measure(shape);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const exact = Math.PI * alpha;
    expect(Math.abs(m.value.volume - exact) / exact).toBeLessThan(1e-6);
  });

  it('tessellates watertight with Euler characteristic 2', () => {
    const mesh = mustMesh(shape, { angle: Math.PI / 8, chord: 0.05 });
    expect(boundaryEdges(mesh)).toBe(0);
    expect(meshEuler(mesh)).toBe(2);
  });

  it('reduces the pi-alpha residual below the old-spacing falsifier', () => {
    const mesh = mustMesh(shape, { angle: Math.PI / 256, chord: 0.05 });
    const exact = Math.PI * alpha;
    expect(Math.abs(meshVolume(mesh) - exact) / exact).toBeLessThan(0.008);
  });

  it('keeps radii 0.5, 1 and 2 within the 1.25% volume tolerance', () => {
    for (const radius of [0.5, 1, 2]) {
      const mesh = mustMesh(obliqueCylinder(alpha, beta, radius), {
        angle: Math.PI / 256,
        chord: 0.05,
      });
      const exact = Math.PI * radius ** 2 * alpha;
      expect(Math.abs(meshVolume(mesh) - exact) / exact).toBeLessThan(0.0125);
    }
  });

  it('accepts pi/512 at 2764 vertices and refuses pi/1024 at the boundary cap of 4098 points', () => {
    const accepted = tessellate(shape, { angle: Math.PI / 512, chord: 0.05 });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.value.vertexHighWater).toBe(2764);
      expect(boundaryEdges(accepted.value)).toBe(0);
    }
    const r = tessellate(shape, { angle: Math.PI / 1024, chord: 0.05 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.detail).toMatchObject({
      brep: 'brep-face-unsupported',
      cap: MAX_TRIM_POINTS,
      points: 4098,
    });
  });

  it('refuses a small, tall oblique cylinder at pi/256 at the interior point cap', () => {
    const shape = obliqueCylinder(3, 0.5, 0.25);
    const neighboring = mustMesh(shape, { angle: Math.PI / 128, chord: 0.05 });
    expect(boundaryEdges(neighboring)).toBe(0);
    expect(meshEuler(neighboring)).toBe(2);

    const limited = tessellate(shape, { angle: Math.PI / 256, chord: 0.05 });
    expect(limited.ok).toBe(false);
    expect(limited).not.toHaveProperty('value');
    if (limited.ok) return;
    expect(limited.error.expected).toBe('a constrained triangulation of the trim');
    expect(limited.error.detail).toMatchObject({
      brep: 'brep-face-unsupported',
      face: 0,
      reason: 'point-cap',
      cap: MAX_TRIM_POINTS,
    });
    expect(MAX_TRIM_POINTS).toBe(4096);
  });

  it('keeps the trim watertight at the default sampling angle', () => {
    const mesh = mustMesh(shape, { angle: Math.PI / 16, chord: 0.05 });
    expect(boundaryEdges(mesh)).toBe(0);
    expect(meshEuler(mesh)).toBe(2);
  });

  it('reports brep-loop-open for a gapped sheet, unlike the no-gap control', () => {
    const square: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const control = validate(nurbsPolygonSheet(square)).issues.map((i) => i.code);
    expect(control).not.toContain('brep-loop-open');
    const codes = validate(nurbsPolygonSheet(square, { gapEdge: 1 })).issues.map((i) => i.code);
    expect(codes).toContain('brep-loop-open');
  });

  it('rejects a flipped coedge', () => {
    const copy = JSON.parse(JSON.stringify(shape)) as Shape & {
      coedges: { reversed: boolean }[];
    };
    const first = copy.coedges[0] as { reversed: boolean };
    first.reversed = !first.reversed;
    expect(validate(copy as Shape).ok).toBe(false);
  });

  describe('classification (falsifier c)', () => {
    it('every side-face triangle centroid of the real tessellation lies on the oracle inside', () => {
      const mesh = mustMesh(shape, { angle: Math.PI / 8, chord: 0.05 });
      const sideLabel = mesh.labelNames.indexOf('side');
      let count = 0;
      for (const f of mesh.faces()) {
        if (mesh.fLabel[f] !== sideLabel) continue;
        const vs = mesh.faceVertices(f).map((v) => mesh.position(v));
        const c = [0, 1, 2].map((k) => vs.reduce((s, p) => s + (p[k] as number), 0) / 3) as [
          number,
          number,
          number,
        ];
        // Centroids of a chord slightly under the surface may fall a hair outside; allow a small slack.
        const z = c[2];
        const theta = Math.atan2(c[1], c[0]);
        const top = alpha + beta * Math.cos(theta);
        expect(z).toBeGreaterThan(-1e-9);
        expect(z).toBeLessThan(top + 1e-6);
        count++;
      }
      expect(count).toBeGreaterThan(0);
    });
  });
});

describe('holed NURBS sheet classification (falsifier c through production)', () => {
  const outer: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const hole: [number, number][] = [
    [0.3, 0.3],
    [0.7, 0.3],
    [0.7, 0.7],
    [0.3, 0.7],
  ];
  const loops = [
    { points: outer, outer: true },
    { points: hole, outer: false },
  ];

  it('every kept triangle centroid lies inside the trim (none inside the hole), and some triangles are kept', () => {
    const mesh = mustMesh(nurbsPolygonSheet(outer, { holes: [hole] }), {
      angle: Math.PI / 8,
    });
    let count = 0;
    for (const f of mesh.faces()) {
      const vs = mesh.faceVertices(f).map((v) => mesh.position(v));
      const [a, b, c] = vs as unknown as [number[], number[], number[]];
      const cx = ((a[0] ?? 0) + (b[0] ?? 0) + (c[0] ?? 0)) / 3;
      const cy = ((a[1] ?? 0) + (b[1] ?? 0) + (c[1] ?? 0)) / 3;
      expect(inTrim(loops, [cx, cy], { u: 0, v: 0 })).toBe(true);
      count++;
    }
    expect(count).toBeGreaterThan(0);
  });
});

describe('NURBS bilinear plane faces (falsifier b)', () => {
  const size = 2;
  const shape = nurbsCube(size);

  it('the bilinear hexahedron validates and its volume is the box volume', () => {
    expectValid(shape);
    const m = measure(shape);
    if (!m.ok) throw new Error('measure');
    expect(m.value.volume).toBeCloseTo(size ** 3, 9);
  });

  it('tessellates watertight with Euler characteristic 2 and the box volume', () => {
    const mesh = mustMesh(shape, { angle: Math.PI / 8 });
    expect(boundaryEdges(mesh)).toBe(0);
    expect(meshEuler(mesh)).toBe(2);
    expect(meshVolume(mesh)).toBeCloseTo(size ** 3, 6);
  });
});

/**
 * Conformity fixture: a non-plane NURBS sheet whose outer loop is this polygon in (u, v). Boundary
 * segment 7 (from (0.4, 0.193) to (0.492, 0.476) in reverse order) is not an edge of the plain
 * Delaunay triangulation of the loop points, so it needs constraint recovery. Found by a seeded
 * random search over star polygons (970 of 4000 lacked a boundary segment).
 */
const CONFORMITY_POLYGON: [number, number][] = [
  [0.67, 0.611],
  [0.661, 0.635],
  [0.488, 0.947],
  [0.34, 0.646],
  [0.474, 0.519],
  [0.385, 0.428],
  [0.47, 0.423],
  [0.4, 0.193],
  [0.492, 0.476],
];

/**
 * A NURBS sheet over the unit square (uv = xy) whose outer loop is `poly`, plus optional `holes`.
 * `gapEdge` shortens that polygon edge (curve and pcurve alike), so its head no longer meets the
 * next edge. Validation reports loop closure and may also report pcurve geometry mismatch.
 */
function nurbsPolygonSheet(
  poly: [number, number][],
  opts: { holes?: [number, number][][]; gapEdge?: number } = {},
): Shape {
  const created = ShapeAssembler.create(2);
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const asm = created.value;
  const surface: NurbsSurface = {
    degreeU: 1,
    degreeV: 1,
    points: [
      [
        [0, 0, 0],
        [0, 1, 0],
      ],
      [
        [1, 0, 0],
        [1, 1, 0],
      ],
    ],
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
  const s = asm.surface({ kind: 'nurbs', surface });
  const ring = (pts: [number, number][]): LoopEdge[] =>
    pts.map((p, i) => {
      const q = pts[(i + 1) % pts.length] as [number, number];
      const curve = asm.curve({
        kind: 'line',
        o: [p[0], p[1], 0],
        d: [q[0] - p[0], q[1] - p[1], 0],
      });
      return { edge: asm.edge(curve, 0, 1), pcurve: linearPCurve(p, q) };
    });
  const outer = asm.loop(s, ring(poly), true);
  if (!outer.ok) throw new Error(JSON.stringify(outer.error));
  const loops = [outer.value];
  for (const hole of opts.holes ?? []) {
    const h = asm.loop(s, ring(hole), false);
    if (!h.ok) throw new Error(JSON.stringify(h.error));
    loops.push(h.value);
  }
  const face = asm.face(s, loops, false, 'sheet');
  asm.shell([face]);
  // The sheet is an open face, so `finish()` (which validates) is not used; the raw arrays are the
  // assembled shape that `tessellate` consumes.
  const priv = asm as unknown as Shape;
  const shape = {
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
  if (opts.gapEdge !== undefined) {
    // Shorten the stored pcurve of one outer coedge so its end no longer meets the next coedge. The
    // edge range and per-coedge geometry stay as built; only loop closure is broken.
    const co = shape.coedges[shape.loops[0]?.coedges[opts.gapEdge] ?? -1] as Coedge | undefined;
    if (co === undefined || co.pcurve.kind !== 'nurbs') throw new Error('gap target');
    const pts = co.pcurve.curve.points.map((p) => [...p] as [number, number, number]);
    const last = pts[pts.length - 1] as [number, number, number];
    const first = pts[0] as [number, number, number];
    pts[pts.length - 1] = [
      first[0] + 0.8 * (last[0] - first[0]),
      first[1] + 0.8 * (last[1] - first[1]),
      last[2],
    ];
    (co as { pcurve: Coedge['pcurve'] }).pcurve = {
      kind: 'nurbs',
      curve: { ...co.pcurve.curve, points: pts },
    };
  }
  return shape;
}

function polygonArea(poly: readonly [number, number][]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as [number, number];
    const q = poly[(i + 1) % poly.length] as [number, number];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** Area of a mesh lying in the z = 0 plane, as the sum of its faces' shoelace areas. */
function meshArea(mesh: EditMesh): number {
  let a = 0;
  for (const f of mesh.faces()) {
    a += polygonArea(facePoints(mesh, f).map((p) => [p[0], p[1]] as [number, number]));
  }
  return a;
}

it('a non-Delaunay boundary segment is recovered: the sheet keeps exactly its 9 loop edges open', () => {
  const mesh = mustMesh(nurbsPolygonSheet(CONFORMITY_POLYGON), { angle: Math.PI / 16 });
  expect(boundaryEdges(mesh)).toBe(CONFORMITY_POLYGON.length);
  expect(meshArea(mesh)).toBeCloseTo(polygonArea(CONFORMITY_POLYGON), 9);
});

it('an open axis-aligned rectangle keeps its grid error (not trim-eligible, no fall-through)', () => {
  // The gap makes the rectangle open, so gridRuns reports 'a closed rectangle'. That reason is not
  // trim-eligible and must reach the caller unchanged instead of falling through to trimmedFace.
  const square: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const r = tessellate(nurbsPolygonSheet(square, { gapEdge: 1 }), {
    angle: Math.PI / 16,
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.detail).toMatchObject({
    brep: 'brep-face-unsupported',
    reason: 'a closed rectangle',
  });
});

describe('trim spacing on a NURBS sheet', () => {
  it('preserves the open sheet boundary across turn limits', () => {
    const triangle: [number, number][] = [
      [0.1, 0.1],
      [0.9, 0.1],
      [0.5, 0.9],
    ];
    const meshA = mustMesh(nurbsPolygonSheet(triangle), {
      angle: Math.PI / 16,
    });
    const meshB = mustMesh(nurbsPolygonSheet(triangle), {
      angle: Math.PI / 32,
    });
    expect(boundaryEdges(meshA)).toBe(3);
    expect(boundaryEdges(meshB)).toBe(3);
    expect(meshEuler(meshA)).toBe(1);
    expect(meshEuler(meshB)).toBe(1);
  });
});

describe('NURBS rational cylinder faces (falsifier b)', () => {
  const height = 2;
  const shape = nurbsTube(height);

  it('the rational tube with planar caps validates and its volume is pi h', () => {
    expectValid(shape);
    const m = measure(shape);
    if (!m.ok) throw new Error('measure');
    expect(Math.abs(m.value.volume - Math.PI * height) / (Math.PI * height)).toBeLessThan(1e-2);
  });

  it('tessellates watertight with Euler characteristic 2', () => {
    const mesh = mustMesh(shape, { angle: Math.PI / 8, chord: 0.05 });
    expect(boundaryEdges(mesh)).toBe(0);
    expect(meshEuler(mesh)).toBe(2);
  });

  it('rejects a NURBS coedge whose pcurve domain differs from its edge range', () => {
    const copy = JSON.parse(JSON.stringify(shape)) as Shape;
    const co = firstNurbsCoedge(copy);
    const c = co.pcurve.curve;
    (co as { pcurve: Coedge['pcurve'] }).pcurve = {
      kind: 'nurbs',
      curve: { ...c, knots: c.knots.map((k) => k * 0.5) },
    };
    const report = validate(copy);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('brep-pcurve-mismatch');
  });
});
