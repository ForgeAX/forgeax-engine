import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { sel } from '../selectors';
import { expectContract, exported, faceSizes, sharpEdges, triangleSet } from './contract';

const flat = () => sel.edges.dihedral('<', 1);

describe('dissolve', () => {
  it('merges faces across interior edges and keeps corner values', () => {
    const m = model();
    m.plane({ width: 2, height: 1, widthSegments: 2 });
    m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
    expect(m.dissolve(flat()).roles).toEqual({ dissolvedEdges: 1, merged: 1 });
    expect(faceSizes(m.editMesh)).toEqual({ 6: 1 });
    const out = m.toMesh();
    expect(out.ok && out.value.report.triangles).toBe(4);
  });

  it('undoes a loop cut and unions the merged tags', () => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'body' });
    m.loopCut(sel.edges.parallel('y'), { cuts: 1 });
    m.tag(sel.inBox([-1, 0, -1], [1, 1, 1]), 'upper');
    const op = m.dissolve(flat());
    expect(op.roles).toEqual({ dissolvedEdges: 4, merged: 4 });
    expect(faceSizes(m.editMesh)).toEqual({ 4: 2, 6: 4 });
    expect(m.count(sel.tag('upper'))).toBe(5);
    expect(m.validate().volume).toBeCloseTo(1, 12);
    expectContract(m);
  });

  it('reports unselected interior edges that the merge removes', () => {
    const m = model();
    m.plane({ width: 2, height: 2, widthSegments: 2, heightSegments: 2 });
    m.markSharp(sel.edges.all().minus(sel.edges.meshBoundary()));
    expect(sharpEdges(m.editMesh)).toBe(4);
    const left = sel.inBox([-1.1, -1.1, -1], [0, 1.1, 1]).toEdges('contained');
    const inner = sel.edges.all().minus(sel.edges.meshBoundary());
    const op = m.dissolve(inner.and(sel.edges.parallel('y').or(sel.edges.parallel('x').and(left))));
    expect(op.roles).toEqual({ dissolvedEdges: 3, merged: 1 });
    expect(op.diagnostics?.[0]?.detail).toEqual({ edges: 1, sharp: 1 });
    expect(sharpEdges(m.editMesh)).toBe(0);
    expectContract(m);
  });

  it('rejects holes, mixed materials and selections without interior edges', () => {
    const ring = model();
    ring.box({ size: [1, 1, 1] });
    expect(ring.dissolve(sel.edges.parallel('y')).error?.code).toBe('model-precondition');
    const mixed = model();
    mixed.box({ size: [1, 1, 1] });
    mixed.assign(sel.facing('+y'), 'red');
    expect(mixed.dissolve(sel.edges.all()).error?.code).toBe('model-invalid-argument');
    const open = model();
    open.plane({ width: 1, height: 1 });
    expect(open.dissolve(sel.edges.meshBoundary()).error?.code).toBe('model-op-no-effect');
  });
});

describe('split', () => {
  it('opens a closed loop of edges into two boundaries with intent kept', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.markSharp(sel.edges.dihedral('>', 40));
    const op = m.split(sel.facing('+y').boundary());
    expect(op.roles).toEqual({ splitVertices: 4 });
    const report = m.validate();
    expect([report.faces, report.vertices, report.boundaryEdges]).toEqual([6, 12, 8]);
    expect(sharpEdges(m.editMesh)).toBe(16);
  });

  it('opens a slit from the boundary and reports edges that cannot open', () => {
    const slit = model();
    slit.plane({ width: 2, height: 2, widthSegments: 2, heightSegments: 2 });
    const op = slit.split(
      sel.inBox([0, 0, -1], [1, 1, 1]).boundary().and(sel.edges.parallel('y')).and(flat()),
    );
    expect(op.roles).toEqual({ splitVertices: 1 });
    expect(op.diagnostics).toBeUndefined();
    expect(slit.validate().boundaryEdges).toBe(10);

    const inner = model();
    inner.plane({ width: 3, height: 3, widthSegments: 3, heightSegments: 3 });
    const center = sel.inBox([-0.6, -0.6, -1], [0.6, 0.6, 1]);
    expect(inner.split(center.boundary().and(sel.edges.parallel('x'))).error?.code).toBe(
      'model-op-no-effect',
    );
    const loop = model();
    loop.plane({ width: 3, height: 3, widthSegments: 3, heightSegments: 3 });
    expect(loop.split(center.boundary()).roles).toEqual({ splitVertices: 4 });
  });
});

describe('orient', () => {
  it('flips inside-out closed components only', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.sphere({ radius: 0.5, widthSegments: 8, heightSegments: 4, center: [3, 0, 0] });
    m.flip(sel.inBox([2, -1, -1], [4, 1, 1]));
    m.plane({ width: 1, height: 1, center: [0, 3, 0] });
    expect(m.orient(sel.all()).roles).toEqual({ flipped: 32, openComponents: 1 });
    expect(m.validate().issues.some((issue) => issue.code === 'mesh-inverted')).toBe(false);
    expect(m.orient(sel.all()).roles).toEqual({ flipped: 0, openComponents: 1 });
  });
});

describe('triangulate', () => {
  it('produces exactly the triangles export would', () => {
    const m = model();
    m.extrudePolygon({
      points: [
        [0, 0],
        [3, 0],
        [3, 2],
        [2, 2],
        [2, 1],
        [1, 1],
        [1, 2],
        [0, 2],
      ],
      depth: 1,
      tag: 'u',
    });
    m.uv.project({ mode: 'box', scale: 1 });
    const before = triangleSet(exported(m));
    const op = m.triangulate(sel.all());
    expect(op.roles).toEqual({ triangulated: 10, triangles: 28 });
    expect(faceSizes(m.editMesh)).toEqual({ 3: 28 });
    expect(m.count(sel.tag('u'))).toBe(28);
    expect(triangleSet(exported(m))).toEqual(before);
    expect(m.triangulate(sel.all()).error?.code).toBe('model-op-no-effect');
  });

  it('rejects a self-overlapping face, as export does', () => {
    const m = model();
    m.polygon({
      points: [
        [8, 6, 0],
        [4, 7, 0],
        [3, 5, 0],
        [7, 4, 0],
        [3, 6, 0],
        [7, 7, 0],
      ],
    });
    expect(m.triangulate(sel.all()).error?.code).toBe('model-degenerate');
  });
});

describe('fillHoles', () => {
  it('caps the selected opening with a sharp-rimmed n-gon', () => {
    const m = model();
    m.box({ size: [1, 1, 1], segments: [1, 2, 1] });
    m.delete(sel.facing('+y').or(sel.facing('-y')));
    const top = sel.inBox([-1, 0, -1], [1, 1, 1]).toEdges('touching').and(sel.edges.meshBoundary());
    const op = m.fillHoles(top, { label: 'lid' });
    expect(op.roles).toEqual({ cap: 1 });
    expect(op.repair).toMatchObject({
      op: 'fillHoles',
      changed: 1,
      largestLoop: 4,
      nonplanar: 0,
    });
    expect(op.repair?.sites[0]?.deviation).toBeLessThan(1e-9);
    expect(op.diagnostics).toBeUndefined();
    expect(m.count(sel.createdBy('lid', 'cap').and(sel.facing('+y')))).toBe(1);
    expect(m.validate().boundaryEdges).toBe(4);
    m.fillHoles(sel.edges.meshBoundary());
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.volume).toBeCloseTo(1, 12);
    expect(sharpEdges(m.editMesh)).toBe(8);
    expectContract(m);
  });

  it('reports a non-planar cap with its Newell deviation', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.delete(sel.facing('+y'));
    const mesh = m.editMesh;
    const corner = mesh
      .vertices()
      .find(
        (v) =>
          mesh.position(v)[0] === 0.5 && mesh.position(v)[1] === 0.5 && mesh.position(v)[2] === 0.5,
      );
    expect(corner).toBeDefined();
    mesh.setPosition(corner as number, 0.5, 0.51, 0.5);
    const op = m.fillHoles(sel.edges.meshBoundary());
    expect(op.status, op.error?.message).toBe('ok');
    expect(op.roles).toEqual({ cap: 1 });
    expect(op.repair).toMatchObject({ op: 'fillHoles', changed: 1, largestLoop: 4, nonplanar: 1 });
    expect(op.repair?.sites[0]?.deviation).toBeCloseTo(0.0025, 5);
    expect(op.repair?.sites[0]?.at[1]).toBeCloseTo(0.5025, 12);
    expect(op.diagnostics).toBeUndefined();
  });

  it('requires boundary edges and an unambiguous material', () => {
    const closed = model();
    closed.box({ size: [1, 1, 1] });
    expect(closed.fillHoles(sel.edges.all()).error?.code).toBe('model-precondition');
    const mixed = model();
    mixed.box({ size: [1, 1, 1] });
    mixed.assign(sel.facing('+x'), 'red');
    mixed.delete(sel.facing('+y'));
    expect(mixed.fillHoles(sel.edges.meshBoundary()).error?.code).toBe('model-invalid-argument');
    const chosen = model();
    chosen.box({ size: [1, 1, 1] });
    chosen.assign(sel.facing('+x'), 'red');
    chosen.delete(sel.facing('+y'));
    chosen.fillHoles(sel.edges.meshBoundary(), { material: 'red' });
    expect(chosen.count(sel.material('red'))).toBe(2);
  });
});
