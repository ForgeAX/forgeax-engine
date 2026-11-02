import { describe, expect, it } from 'vitest';
import { fillBoundaryLoops, nonplanarCaps, traceBoundaryLoops } from '../connect';
import type { PlaneCutOptions } from '../cut';
import { model } from '../model';
import { sel } from '../selectors';
import { bounds, expectContract, faceSizes, sharpEdges } from './contract';

function uShape() {
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
    label: 'u',
  });
  return m;
}

describe('loopCut', () => {
  it('cuts one ring around a box, keeping split-edge intent and corner values', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.markSharp(sel.edges.dihedral('>', 40));
    m.uv.project({ mode: 'box', scale: 1 });
    const op = m.loopCut(sel.edges.parallel('y'), { cuts: 2 });
    expect(op.roles).toEqual({ rings: 1, crossed: 4 });
    const report = m.validate();
    expect([report.faces, report.closed]).toEqual([14, true]);
    expect(report.volume).toBeCloseTo(1, 12);
    expect(sharpEdges(m.editMesh)).toBe(20);
    const interpolated = m.toMesh();
    if (!interpolated.ok) throw interpolated.error;
    const reprojected = model();
    reprojected.box({ size: [1, 1, 1] });
    reprojected.markSharp(sel.edges.dihedral('>', 40));
    reprojected.loopCut(sel.edges.parallel('y'), { cuts: 2 });
    reprojected.uv.project({ mode: 'box', scale: 1 });
    const expected = reprojected.toMesh();
    if (!expected.ok) throw expected.error;
    expect(interpolated.value.report).toEqual(expected.value.report);
    const uv = Array.from(interpolated.value.mesh.attributes.uv as Float32Array);
    const want = Array.from(expected.value.mesh.attributes.uv as Float32Array);
    expect(uv.map((x) => Math.round(x * 1e5))).toEqual(want.map((x) => Math.round(x * 1e5)));
  });

  it('crosses even-sided n-gon caps through their opposite edge', () => {
    const m = model();
    m.cylinder({ radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 8 });
    // Turn the octagons so two rim edges per cap run along X.
    m.rotate(sel.all(), 'y', 22.5);
    const op = m.loopCut(sel.edges.parallel('x').and(sel.edges.dihedral('>', 45)), { cuts: 1 });
    expect(op.roles).toEqual({ rings: 1, crossed: 4 });
    expect(faceSizes(m.editMesh)).toEqual({ 4: 10, 6: 4 });
    expect(m.validate().closed).toBe(true);
    expectContract(m);
  });

  it('ends a ring at odd-sided faces, which only gain the new vertex', () => {
    const m = model();
    m.cone({ radius: 1, height: 1, radialSegments: 8 });
    m.rotate(sel.all(), 'y', 22.5);
    const op = m.loopCut(sel.edges.parallel('x').and(sel.edges.dihedral('>', 30)), { cuts: 1 });
    expect(op.roles).toEqual({ rings: 1, crossed: 1 });
    expect(faceSizes(m.editMesh)).toEqual({ 3: 6, 4: 2, 6: 2 });
    expectContract(m);
  });

  it('requires at least one cut', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    expect(m.loopCut(sel.edges.parallel('y'), { cuts: 0 }).error?.code).toBe(
      'model-invalid-argument',
    );
  });
});

describe('bisect and planeCut', () => {
  it('bisect splits crossing faces and keeps both sides closed', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const op = m.bisect({ point: [0, 0.1, 0], normal: [0, 1, 0] });
    expect(op.roles).toEqual({ splitEdges: 4, splitFaces: 4 });
    const report = m.validate();
    expect([report.faces, report.closed]).toEqual([10, true]);
    expect(report.volume).toBeCloseTo(1, 12);
    expectContract(m);
  });

  it('bisect fails without effect and rejects a zero normal', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    expect(m.bisect({ point: [0, 5, 0], normal: [0, 1, 0] }).error?.code).toBe(
      'model-op-no-effect',
    );
    const z = model();
    z.box({ size: [1, 1, 1] });
    expect(z.bisect({ point: [0, 0, 0], normal: [0, 0, 0] }).error?.code).toBe(
      'model-invalid-argument',
    );
  });

  it('planeCut keeps one side open by default and caps it with fillHoles', () => {
    const open = model();
    open.sphere({ radius: 1, widthSegments: 8, heightSegments: 4 });
    const op = open.planeCut({ point: [0, 0, 0], normal: [0, 1, 0], keep: 'negative' });
    expect(op.roles).toEqual({ removed: 16 });
    expect(open.validate().boundaryEdges).toBe(8);
    expect(bounds(open.editMesh)[4]).toBeCloseTo(0, 12);

    const capped = model();
    capped.sphere({ radius: 1, widthSegments: 8, heightSegments: 5 });
    const cut = capped.planeCut({
      point: [0, 0, 0],
      normal: [0, 1, 0],
      keep: 'negative',
      fillHoles: true,
      label: 'cut',
    });
    expect(cut.roles.cap).toBe(1);
    const report = capped.validate();
    expect(report.closed).toBe(true);
    expect(capped.count(sel.createdBy('cut', 'cap').and(sel.facing('+y', 1)))).toBe(1);
    expect(sharpEdges(capped.editMesh)).toBe(8);
    expectContract(capped);
  });

  it('planeCut and fillHoles share one non-planar cap measure', () => {
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
    mesh.setPosition(corner as number, 0.5, 0.51, 0.5);
    const loops = traceBoundaryLoops(
      mesh,
      mesh.edges().filter((e) => mesh.isBoundaryEdge(e)),
    );
    expect(loops.ok).toBe(true);
    if (!loops.ok) return;
    const filled = fillBoundaryLoops(
      mesh,
      loops.value,
      { label: 0, material: 0, tag: -1 },
      undefined,
    );
    expect(filled.ok).toBe(true);
    if (!filled.ok) return;
    expect(filled.value.counts).toEqual({ cap: 1 });
    expect(filled.value.caps).toHaveLength(1);
    expect(filled.value.caps[0]?.deviation).toBeCloseTo(0.0025, 5);
    expect(nonplanarCaps(filled.value.caps, 1e-5)).toBe(1);
    expect(nonplanarCaps(filled.value.caps, 1e-3)).toBe(0);
  });

  it('planeCut splits a concave face at all four crossings', () => {
    const m = uShape();
    const op = m.planeCut({
      point: [0, 1.5, 0],
      normal: [0, 1, 0],
      keep: 'negative',
      fillHoles: true,
    });
    expect(op.roles.cap).toBe(2);
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.volume).toBeCloseTo(4, 12);
    expect(bounds(m.editMesh)[4]).toBe(1.5);
    expectContract(m);
  });

  it('planeCut fails without effect when nothing lies on the removed side', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    expect(m.planeCut({ point: [0, 5, 0], normal: [0, 1, 0], keep: 'negative' }).error?.code).toBe(
      'model-op-no-effect',
    );
  });

  it('loopCut fails without effect when no ring crosses a face', () => {
    const m = model();
    m.polygon({
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
    });
    const op = m.loopCut(sel.edges.parallel('x'), { cuts: 1 });
    expect(op.error?.code).toBe('model-op-no-effect');
    expect(m.validate().faces).toBe(1);
  });

  it('planeCut caps a rim with several slots when material is given', () => {
    const ambiguous = model();
    ambiguous.box({ size: [1, 1, 1] });
    ambiguous.assign(sel.facing('+x', 1), 'red');
    const cut: PlaneCutOptions = {
      point: [0, 0, 0],
      normal: [0, 1, 0],
      keep: 'positive',
      fillHoles: true,
    };
    expect(ambiguous.planeCut(cut).error?.code).toBe('model-invalid-argument');
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.assign(sel.facing('+x', 1), 'red');
    const op = m.planeCut({ ...cut, material: 'red', label: 'cut' });
    expect(op.status).toBe('ok');
    expect(m.count(sel.createdBy('cut', 'cap').and(sel.material('red')))).toBe(1);
    expect(m.validate().closed).toBe(true);
    expectContract(m);
  });
});
