import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { EDGE_SEAM, EDGE_SHARP } from '../mesh';
import { type Model, model } from '../model';
import { sel } from '../selectors';
import { SPIKE_CASES } from './boolean-cases';
import { expectContract, faceSizes, sharpEdges } from './contract';

const topFront = sel.facing('+y').toEdges('touching').and(sel.facing('+z').toEdges('touching'));
const topRight = sel.facing('+y').toEdges('touching').and(sel.facing('+x').toEdges('touching'));

function cube(): Model {
  const m = model();
  m.box({ size: [1, 1, 1] });
  return m;
}

/** Distance from `p` to the axis-aligned box [-h, h]^3. */
function boxDistance(p: Tuple3, h: number): number {
  const d = p.map((c) => Math.max(Math.abs(c) - h, 0));
  return Math.hypot(...d);
}

/** Distance from `p` to the line through `a` and `b`. */
function lineDistance(p: Tuple3, a: Tuple3, b: Tuple3): number {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as Tuple3;
  const q = [p[0] - a[0], p[1] - a[1], p[2] - a[2]] as Tuple3;
  const t = (q[0] * d[0] + q[1] * d[1] + q[2] * d[2]) / Math.hypot(...d);
  return Math.sqrt(Math.max(0, q[0] ** 2 + q[1] ** 2 + q[2] ** 2 - t * t));
}

function flagged(m: Model, flag: number): number {
  const mesh = m.editMesh;
  return mesh.edges().filter((e) => ((mesh.eFlags[e] as number) & flag) !== 0).length;
}

describe('bevel: chamfer (segments 1)', () => {
  it('chamfers one box edge; each end cuts its far face (valence-3 terminator)', () => {
    const m = cube();
    const op = m.bevel(topFront, { width: 0.1, segments: 1, label: 'b' });
    expect(op.status).toBe('ok');
    expect(op.roles).toEqual({ bevel: 1 });
    expect(faceSizes(m.editMesh)).toEqual({ 4: 5, 5: 2 });
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.volume).toBeCloseTo(1 - 0.1 ** 2 / 2, 12);
    expect(
      m.count(sel.createdBy('b', 'bevel').and(sel.facing('+y', 46)).and(sel.facing('+z', 46))),
    ).toBe(1);
    expectContract(m);
  });

  it('chamfers every box edge with triangular corners and the exact chamfered volume', () => {
    const m = cube();
    const w = 0.1;
    const op = m.bevel(sel.edges.all(), { width: w, segments: 1, label: 'b' });
    expect(op.roles).toEqual({ bevel: 12, corner: 8 });
    expect(faceSizes(m.editMesh)).toEqual({ 3: 8, 4: 18 });
    // Each edge loses a w^2 / 2 prism between the corners; each corner keeps a w^3 / 6 tetrahedron.
    const expected = 1 - (12 * (1 - 2 * w) * (w * w)) / 2 - 8 * (5 / 6) * w ** 3;
    expect(m.validate().volume).toBeCloseTo(expected, 12);
    expectContract(m);
  });

  it('runs a chamfer through a valence-4 vertex when both edges of the chain are selected', () => {
    const m = cube();
    m.loopCut(topFront, { cuts: 1 });
    const op = m.bevel(topFront, { width: 0.1, segments: 1, label: 'b' });
    expect(op.roles).toEqual({ bevel: 2 });
    expect(m.validate().volume).toBeCloseTo(1 - 0.1 ** 2 / 2, 12);
    expectContract(m);
  });

  it('ends half an edge at a valence-4 vertex with an n-gon corner that tapers into the rest', () => {
    const m = cube();
    m.loopCut(topFront, { cuts: 1 });
    const op = m.bevel(topFront.and(sel.inBox([-1, -1, -1], [0.01, 1, 1]).toEdges('touching')), {
      width: 0.1,
      segments: 1,
      label: 'b',
    });
    expect(op.roles).toEqual({ bevel: 1, corner: 1 });
    expect(m.count(sel.createdBy('b', 'corner'))).toBe(1);
    expect(m.validate().closed).toBe(true);
    expectContract(m);
  });

  it('turns a corner where two selected edges meet (valence 2 at a three-edge vertex)', () => {
    const m = cube();
    const op = m.bevel(topFront.or(topRight), { width: 0.1, segments: 1, label: 'b' });
    expect(op.roles).toEqual({ bevel: 2 });
    expect(faceSizes(m.editMesh)).toEqual({ 4: 6, 5: 2 });
    expectContract(m);
  });

  it('leaves an n-gon corner where five or more bevels meet', () => {
    const m = model();
    m.cone({ radius: 1, height: 1, radialSegments: 6 });
    const apex = sel.edges.all().minus(sel.edges.perpendicular('y'));
    const op = m.bevel(apex, { width: 0.05, segments: 1, label: 'b' });
    expect(op.roles).toEqual({ bevel: 6, corner: 1 });
    const corner = m.editMesh
      .faces()
      .find((f) => m.editMesh.fRole[f] === m.editMesh.roleNames.indexOf('corner'));
    expect(m.editMesh.fLen[corner as number]).toBe(6);
    expectContract(m);
  });

  it('bevels a four-edge junction with a quad corner', () => {
    const m = model();
    m.cone({ radius: 1, height: 1, radialSegments: 4 });
    const op = m.bevel(sel.edges.all().minus(sel.edges.perpendicular('y')), {
      width: 0.05,
      segments: 1,
      label: 'b',
    });
    expect(op.roles).toEqual({ bevel: 4, corner: 1 });
    expectContract(m);
  });

  it('bevels concave edges into the material (an L section)', () => {
    const m = model();
    m.extrudePolygon({
      points: [
        [0, 0],
        [2, 0],
        [2, 1],
        [1, 1],
        [1, 2],
        [0, 2],
      ],
      depth: 1,
    });
    const before = m.validate().volume;
    m.bevel(sel.edges.concave(), { width: 0.1, segments: 1 });
    // A concave chamfer adds the w^2 / 2 prism along the unit-long inner edge.
    expect(m.validate().volume).toBeCloseTo(before + 0.1 ** 2 / 2, 12);
    expectContract(m);
  });

  it('keeps open boundary vertices on their rim (open fans)', () => {
    const m = cube();
    m.delete(sel.facing('+y'));
    const boundaryBefore = m.validate().boundaryEdges;
    const op = m.bevel(sel.edges.parallel('y'), { width: 0.1, segments: 1 });
    expect(op.status).toBe('ok');
    const report = m.validate();
    expect(report.boundaryEdges).toBe(boundaryBefore + 4);
    expect(report.issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('chamfers the rim of a hole through a plate', () => {
    const m = model();
    m.box({ size: [2, 0.2, 2] });
    m.inset(sel.facing('+y'), { thickness: 0.6, region: 'merged', label: 'top' });
    m.inset(sel.facing('-y'), { thickness: 0.6, region: 'merged', label: 'bottom' });
    m.delete(sel.createdBy('top', 'inner').or(sel.createdBy('bottom', 'inner')));
    m.bridge(sel.edges.meshBoundary(), { label: 'bore' });
    const op = m.bevel(sel.createdBy('bore').boundary(), { width: 0.05, segments: 1, label: 'b' });
    expect(op.roles).toEqual({ bevel: 8 });
    expect(m.validate().closed).toBe(true);
    expectContract(m);
  });
});

describe('bevel: round profiles (segments >= 2)', () => {
  it('rounds every box edge onto the exact rounded-box surface', () => {
    const w = 0.15;
    for (const segments of [2, 3, 4, 5]) {
      const m = cube();
      const op = m.bevel(sel.edges.all(), { width: w, segments, label: 'b' });
      expect(op.status).toBe('ok');
      const mesh = m.editMesh;
      // Every vertex, on the faces, the round strips and the spherical corners, lies w from the inner box.
      for (const v of mesh.vertices()) {
        expect(boxDistance(mesh.position(v), 0.5 - w)).toBeCloseTo(w, 9);
      }
      expect(m.count(sel.createdBy('b', 'corner'))).toBeGreaterThan(8);
      expectContract(m);
    }
  });

  it('builds patterned three-sided corners (corner grids, strips and a centre triangle for odd counts)', () => {
    const even = cube();
    even.bevel(sel.edges.all(), { width: 0.1, segments: 4, label: 'b' });
    // Each corner: three 2 x 2 grids, every quad split in two on the sphere.
    expect(even.count(sel.createdBy('b', 'corner'))).toBe(8 * 3 * 4 * 2);
    const odd = cube();
    odd.bevel(sel.edges.all(), { width: 0.1, segments: 3, label: 'b' });
    // Each corner: three 1 x 1 grids (split), three side strips and one centre triangle.
    expect(odd.count(sel.createdBy('b', 'corner'))).toBe(8 * (3 * 2 + 3 + 1));
  });

  it('builds a quad-grid patch where four rounds meet', () => {
    const m = model();
    m.cone({ radius: 1, height: 1, radialSegments: 4 });
    const op = m.bevel(sel.edges.all().minus(sel.edges.perpendicular('y')), {
      width: 0.05,
      segments: 3,
      label: 'b',
    });
    expect(op.status).toBe('ok');
    expect(m.validate().closed).toBe(true);
    expect(m.count(sel.createdBy('b', 'corner'))).toBeGreaterThanOrEqual(9);
    expectContract(m);
  });

  it('ends a round in the plane of the far face (valence-3 terminator)', () => {
    const m = cube();
    m.bevel(topFront, { width: 0.2, segments: 4, label: 'b' });
    const mesh = m.editMesh;
    for (const f of mesh.faces()) {
      if (mesh.fLabel[f] !== 0) continue;
      const points = mesh.faceVertices(f).map((v) => mesh.position(v));
      // The cut end faces x = +-0.5 stay planar with the arc points inserted.
      const xs = new Set(points.map((p) => p[0].toFixed(12)));
      const ys = new Set(points.map((p) => p[1].toFixed(12)));
      const zs = new Set(points.map((p) => p[2].toFixed(12)));
      expect(Math.min(xs.size, ys.size, zs.size)).toBe(1);
    }
    for (const v of mesh.vertices()) {
      const [, y, z] = mesh.position(v);
      if (y > 0.3 && z > 0.3) expect(Math.hypot(y - 0.3, z - 0.3)).toBeCloseTo(0.2, 9);
    }
    expectContract(m);
  });

  it('rounds a revolved rim: chains through valence-4 vertices around closed loops', () => {
    const m = model();
    m.revolve({
      points: [
        [0.3, 0],
        [1, 0],
        [1, 0.2],
        [0.8, 0.3],
        [0.8, 0.6],
        [0.3, 0.6],
        [0.3, 0],
      ],
      segments: 24,
    });
    const op = m.bevel(sel.edges.dihedral('>', 30), { width: 0.03, segments: 3, label: 'b' });
    expect(op.status).toBe('ok');
    expect(op.diagnostics).toBeUndefined();
    expectContract(m);
  });

  it('fillets concave pocket edges and rounds the convex rims of a plate', () => {
    const m = model();
    m.box({ size: [2, 0.4, 2] });
    m.inset(sel.facing('+y'), { thickness: 0.3, region: 'merged', label: 'p' });
    m.extrude(sel.createdBy('p', 'inner'), { distance: -0.2, region: 'merged', label: 'd' });
    const before = m.validate().volume;
    const op = m.bevel(sel.edges.dihedral('>', 30), { width: 0.04, segments: 3, label: 'b' });
    expect(op.status).toBe('ok');
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.volume).toBeLessThan(before);
    expectContract(m);
  });
});

describe('bevel: clamp', () => {
  it('clamps widths that would invert faces and reports the actual widths', () => {
    const m = cube();
    const op = m.bevel(sel.edges.all(), { width: 0.8, segments: 2 });
    expect(op.status).toBe('ok');
    const diagnostic = op.diagnostics?.find((d) => d.severity === 'warn');
    expect(diagnostic?.detail).toMatchObject({ requested: 0.8, clamped: 12 });
    expect((diagnostic?.detail as { minWidth: number }).minWidth).toBeCloseTo(0.49, 12);
    expect(m.validate().closed).toBe(true);
    expectContract(m);
  });

  it('clamps only the edges a thin face constrains', () => {
    const m = model();
    m.box({ size: [2, 0.1, 2] });
    const op = m.bevel(sel.edges.dihedral('>', 30), { width: 0.08, segments: 1 });
    const detail = op.diagnostics?.find((d) => d.severity === 'warn')?.detail as {
      clamped: number;
      minWidth: number;
      edges: { width: number }[];
    };
    expect(detail.clamped).toBeGreaterThan(0);
    expect(detail.minWidth).toBeLessThan(0.05);
    for (const edge of detail.edges) expect(edge.width).toBeLessThan(0.08);
    expectContract(m);
  });

  it('limits a high-valence apex so its corners use at most half of each side edge', () => {
    const m = model();
    m.cone({ radius: 0.5, height: 1, radialSegments: 48 });
    const before = m.validate().volume;
    const op = m.bevel(sel.edges.all(), { width: 0.03, segments: 1 });
    expect(op.status, op.error?.message).toBe('ok');
    expect(
      op.diagnostics?.some((d) => d.severity === 'warn' && 'clamped' in (d.detail ?? {})),
    ).toBe(true);
    const box = m.bounds(sel.all());
    if (!box.ok) throw box.error;
    // Unclamped, the apex corners ran 92 % down the sides (height 0.08, volume -78 %).
    expect(box.value.max[1] - box.value.min[1]).toBeGreaterThan(0.5);
    expect(m.validate().volume).toBeGreaterThan(before * 0.85);
    expectContract(m);
  });

  it('keeps the width where a cell diagonal splits a nearly flat corner', () => {
    // Before: the two triangles of a slightly bent cell (a curved skin) took separate slots, so
    // the corner point slid along their diagonal by its own offset line (0.65 w here) and the
    // band widened toward the corner (D15's visual gap, 6.30 mm over a 1.2 mm round).
    const m = model();
    m.box({ size: [1, 0.2, 0.3] });
    m.triangulate(sel.all());
    const mesh = m.editMesh;
    const top = mesh
      .faces()
      .filter((f) => mesh.faceVertices(f).every((v) => mesh.position(v)[1] > 0.09));
    const [a, b] = top.map((f) => mesh.faceVertices(f)) as [number[], number[]];
    const diagonal = a.filter((v) => b.includes(v));
    const lift = a.find((v) => !diagonal.includes(v)) as number;
    const p = mesh.position(lift);
    mesh.setPosition(lift, p[0], p[1] + 0.0005, p[2]);
    const rims = mesh
      .edges()
      .map((e) => mesh.edgeVertices(e))
      .filter(
        (vs) =>
          vs.every((v) => mesh.position(v)[1] > 0.09) && !vs.every((v) => diagonal.includes(v)),
      )
      .map((vs) => vs.map((v) => mesh.position(v)) as [Tuple3, Tuple3]);
    const w = 0.02;
    const op = m.bevel(sel.facing('+y', 30).toEdges('touching').and(sel.edges.dihedral('>', 30)), {
      width: w,
      segments: 1,
    });
    expect(op.status, op.error?.message).toBe('ok');
    const out = m.editMesh;
    const offRim = (q: Tuple3) => Math.min(...rims.map(([r0, r1]) => lineDistance(q, r0, r1)));
    const rail = out
      .vertices()
      .map((v) => out.position(v))
      .filter((q) => q[1] > 0.1 - w / 2 && offRim(q) > 1e-9);
    expect(rail.length).toBeGreaterThan(0);
    for (const q of rail) expect(offRim(q) / w).toBeCloseTo(1, 1);
    expectContract(m);
  });

  it('fails as degenerate when a clamp leaves no width (falsifies the clamp floor)', () => {
    const m = model();
    m.box({ size: [1, 1e-6, 1] });
    const op = m.bevel(sel.facing('+y').boundary(), { width: 0.1, segments: 1 });
    expect(op.error?.code).toBe('model-degenerate');
  });
});

describe('bevel: contract', () => {
  it('rejects boundary edges with model-precondition and leaves the mesh unchanged', () => {
    const m = cube();
    m.delete(sel.facing('+y'));
    const before = m.snapshot();
    const outcome = m.try(() => m.bevel(sel.edges.meshBoundary(), { width: 0.1, segments: 1 }));
    expect(!outcome.ok && outcome.error.code).toBe('model-precondition');
    expect(m.snapshot()).toEqual(before);
  });

  it('rejects a pinched vertex with model-precondition', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.box({ size: [1, 1, 1], center: [1, 1, 1] });
    m.weld({ distance: 1e-6 });
    const op = m.bevel(sel.inBox([-0.6, -0.6, -0.6], [0.6, 0.6, 0.6]).toEdges('contained'), {
      width: 0.1,
      segments: 1,
    });
    expect(op.error?.code).toBe('model-precondition');
  });

  it('checks its magnitudes', () => {
    for (const options of [
      { width: 0, segments: 1 },
      { width: -0.1, segments: 1 },
      { width: Number.NaN, segments: 1 },
      { width: 0.1, segments: 0 },
      { width: 0.1, segments: 1.5 },
      { width: 0.1, segments: 65 },
    ]) {
      expect(cube().bevel(sel.edges.all(), options).error?.code).toBe('model-invalid-argument');
    }
  });

  it('reports an empty selection', () => {
    expect(cube().bevel(sel.edges.concave(), { width: 0.1, segments: 1 }).error?.code).toBe(
      'model-selection-empty',
    );
  });

  it('fails with model-op-no-effect when an edge has no room at either end (falsifies the effect assertion)', () => {
    const m = model();
    m.polygon({
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [0.5, 0.01, 0],
      ],
    });
    m.polygon({
      points: [
        [1, 0, 0],
        [0, 0, 0],
        [0.5, -0.01, 0],
      ],
    });
    m.weld({ distance: 1e-9 });
    const before = m.snapshot();
    const outcome = m.try(() =>
      m.bevel(sel.edges.all().minus(sel.edges.meshBoundary()), { width: 0.1, segments: 1 }),
    );
    expect(!outcome.ok && outcome.error.code).toBe('model-op-no-effect');
    expect(m.snapshot()).toEqual(before);
  });

  it('needs `material` when the faces around a bevel use different slots', () => {
    const m = cube();
    m.assign(sel.facing('+y'), 'top');
    expect(m.bevel(sel.edges.all(), { width: 0.1, segments: 1 }).error?.code).toBe(
      'model-invalid-argument',
    );
    const named = cube();
    named.assign(sel.facing('+y'), 'top');
    const op = named.bevel(sel.edges.all(), { width: 0.1, segments: 1, material: 'trim' });
    expect(op.status).toBe('ok');
    expect(named.count(sel.material('trim'))).toBe(12 + 8);
  });

  it('gives new faces the shared tags of their neighbours, the call tag and role identity only when labelled', () => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'shell' });
    m.tag(sel.facing('+y'), 'lid');
    m.bevel(sel.edges.all(), { width: 0.1, segments: 1, tag: 'trim' });
    expect(m.count(sel.tag('trim'))).toBe(20);
    expect(m.count(sel.tag('shell'))).toBe(26);
    // Strips on the lid rim touch one lid face; no bevel face carries `lid`.
    expect(m.count(sel.tag('lid'))).toBe(1);
    expect(m.inspect().labels).toEqual([]);
  });

  it('keeps chamfers crisp where the edge was sharp and leaves rounds smooth with the seam on one rail', () => {
    const chamfer = cube();
    chamfer.markSharp(sel.edges.all());
    chamfer.markSeam(topFront);
    chamfer.bevel(topFront, { width: 0.1, segments: 1 });
    // 11 untouched edges + two rails + the strip's two end edges.
    expect(sharpEdges(chamfer.editMesh)).toBe(15);
    expect(flagged(chamfer, EDGE_SEAM)).toBe(2);
    const round = cube();
    round.markSharp(sel.edges.all());
    round.markSeam(topFront);
    round.bevel(topFront, { width: 0.1, segments: 3 });
    // 11 untouched edges + 3 + 3 end edges against the cut faces; the rails are smooth.
    expect(sharpEdges(round.editMesh)).toBe(17);
    expect(flagged(round, EDGE_SEAM)).toBe(1);
    expect(flagged(round, EDGE_SHARP)).toBe(17);
  });

  it('interpolates the corner values of cut faces exactly (box projection is linear)', () => {
    const m = cube();
    m.uv.project({ mode: 'box', scale: 1 });
    const op = m.bevel(sel.edges.all(), { width: 0.1, segments: 2, label: 'b' });
    expect(op.diagnostics?.some((d) => d.message.includes('no corner values'))).toBe(true);
    const mesh = m.editMesh;
    const reprojected = model();
    reprojected.append(m.snapshot());
    reprojected.uv.project({ mode: 'box', scale: 1, faces: sel.createdBy('b').not() });
    const other = reprojected.editMesh;
    const key = (p: Tuple3) => p.map((x) => x.toFixed(9)).join(',');
    const expected = new Map<string, string>();
    for (const f of other.faces()) {
      if (other.fLabel[f] !== 0) continue;
      for (const h of other.faceHalves(f)) {
        const uv = other.corner('uv0', h) as Float32Array;
        expected.set(
          `${key(other.position(other.hVert[h] as number))}|${key(other.position(other.hVert[other.hNext[h] as number] as number))}`,
          Array.from(uv, (x) => x.toFixed(4)).join(','),
        );
      }
    }
    let checked = 0;
    for (const f of mesh.faces()) {
      if (mesh.fLabel[f] !== 0) continue;
      for (const h of mesh.faceHalves(f)) {
        const uv = mesh.corner('uv0', h) as Float32Array;
        const k = `${key(mesh.position(mesh.hVert[h] as number))}|${key(mesh.position(mesh.hVert[mesh.hNext[h] as number] as number))}`;
        expect(Array.from(uv, (x) => x.toFixed(4)).join(',')).toBe(expected.get(k));
        checked++;
      }
    }
    expect(checked).toBe(24);
  });

  it('is deterministic', () => {
    const build = () => {
      const m = cube();
      m.loopCut(topFront, { cuts: 2 });
      m.bevel(sel.edges.dihedral('>', 30), { width: 0.07, segments: 3 });
      return m.snapshot();
    };
    expect(build()).toEqual(build());
  });

  it('skips after an earlier failure and journals bevel as a producing operation', () => {
    const m = cube();
    m.bevel(sel.edges.concave(), { width: 0.1, segments: 1 });
    const skipped = m.bevel(sel.edges.all(), { width: 0.1, segments: 1 });
    expect(skipped.status).toBe('skipped');
    expect(m.journal.map((entry) => entry.status)).toEqual(['ok', 'failed', 'skipped']);
  });
});

describe('bevel: postconditions on boolean results', () => {
  const diskWithHoles = () => {
    const c = SPIKE_CASES.find((x) => x.name.startsWith('radial disk holes x7 R0.126 n8'));
    if (c === undefined) throw new Error('spike case missing');
    return c.build(() => {}).model;
  };

  it('clamps instead of folding a narrow strip face between holes', () => {
    const m = diskWithHoles();
    const r = m.bevel(sel.edges.dihedral('>', 30), { width: 0.0015, segments: 2 });
    expect(r.status, r.error?.message).toBe('ok');
    const clamp = r.diagnostics?.find(
      (d) => d.severity === 'warn' && 'clamped' in (d.detail ?? {}),
    );
    expect(clamp?.message).toMatch(/clamped below width 0.0015/);
    expectContract(m);
    const crossed = m
      .validate()
      .issues.some((i) => i.code === 'self-intersection' && i.detail.certainty === 'confirmed');
    expect(crossed).toBe(false);
  });

  it('keeps a narrower bevel of the same part valid', () => {
    const m = diskWithHoles();
    const r = m.bevel(sel.edges.dihedral('>', 30), { width: 0.0005, segments: 2 });
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  // C-101 spoke windows: a short wall face of a window corner fillet clamps its vertical
  // edges far below the rim edges, and the round profiles of the two rims meeting there cross
  // at any common scale; evening out the widths resolves it without halving to the tolerance.
  it.each([
    ['radial-windows x6 R0.20800000000000002 share0.51 corner0.31', 3, 0.0009],
    ['radial-windows x12 R0.2425 share0.59 corner0.28', 2, 1e-5],
  ])(
    'rounds every crease of the spoke windows %s (segments %i)',
    {
      timeout: 120000,
    },
    (name, segments, least) => {
      const c = SPIKE_CASES.find((x) => x.name === name);
      if (c === undefined) throw new Error('spike case missing');
      const m = c.build(() => {}).model;
      const selected = m.count(sel.edges.dihedral('>', 30));
      const r = m.bevel(sel.edges.dihedral('>', 30), { width: 0.0072, segments, label: 'b' });
      expect(r.status, r.error?.message).toBe('ok');
      expect(r.roles.bevel).toBeGreaterThanOrEqual(selected * segments);
      const issues = m.validate().issues;
      expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(
        issues.some((i) => i.code === 'self-intersection' && i.detail.certainty === 'confirmed'),
      ).toBe(false);
      const clamp = r.diagnostics?.find(
        (d) => d.severity === 'warn' && 'clamped' in (d.detail ?? {}),
      );
      expect((clamp?.detail as { minWidth: number }).minWidth).toBeGreaterThan(least);
    },
  );

  it('clamps the rims of revolved spoke holes until no bevel face crosses another', () => {
    const m = model();
    m.revolve({
      points: [
        [0.3, -0.05],
        [0.4, -0.05],
        [0.4, 0.05],
        [0.3, 0.05],
        [0.3, -0.05],
      ],
      segments: 48,
      label: 'rim',
    });
    const tools = model();
    for (let i = 0; i < 5; i++) {
      tools.cylinder({
        radiusTop: 0.03,
        radiusBottom: 0.03,
        height: 0.4,
        radialSegments: 12,
        label: `s${i}`,
      });
      tools.rotate(sel.createdBy(`s${i}`), 'z', 90);
      tools.translate(sel.createdBy(`s${i}`), [0.35, 0, 0]);
      tools.rotate(sel.createdBy(`s${i}`), 'y', 72 * i + 7);
    }
    expect(m.difference(tools, { label: 'spoke' }).status).toBe('ok');
    const r = m.bevel(sel.createdBy('spoke', 'cutB').boundary(), { width: 0.008, segments: 2 });
    const crossed = m
      .validate()
      .issues.some((i) => i.code === 'self-intersection' && i.detail.certainty === 'confirmed');
    const warned = r.diagnostics?.some(
      (d) => d.severity === 'warn' && d.message.startsWith('the bevel self-intersects'),
    );
    expect(r.status, r.error?.message).toBe('ok');
    expect(crossed).toBe(false);
    expect(warned).toBe(false);
    expect(r.diagnostics?.some((d) => d.severity === 'warn' && 'clamped' in (d.detail ?? {}))).toBe(
      true,
    );
  });
});

describe('bevel: a crossing the halving cannot resolve fails (review V-1)', () => {
  // A separate block sits 1e-7 m off the inner corner of an L; any bevel of the concave
  // edge reaches it, so the halving runs out of rounds with the crossing still there.
  const build = () => {
    const m = model({ tolerance: 1e-9 });
    m.extrudePolygon({
      points: [
        [0, 0],
        [1, 0],
        [1, 0.3],
        [0.3, 0.3],
        [0.3, 1],
        [0, 1],
      ],
      depth: 0.5,
      label: 'L',
    });
    m.box({ size: [0.2, 0.2, 0.5], center: [0.4 + 1e-7, 0.4 + 1e-7, 0.25], label: 'block' });
    return m;
  };

  it('rolls back with model-degenerate and the crossing locations instead of committing ok', () => {
    const m = build();
    const before = m.snapshot();
    const r = m.bevel(sel.edges.concave(), { width: 0.05, segments: 1 });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-degenerate');
    expect(r.error?.expected).toMatch(/no bevel face crosses/);
    expect((r.error?.detail?.at as unknown[]).length).toBeGreaterThan(0);
    expect(m.snapshot()).toEqual(before);
  });

  it('still bevels the same edge once the block is out of reach', () => {
    const m = build();
    m.translate(sel.createdBy('block'), [0.1, 0.1, 0]);
    const r = m.bevel(sel.edges.concave(), { width: 0.05, segments: 1 });
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().issues.some((i) => i.code === 'self-intersection')).toBe(false);
  });
});
