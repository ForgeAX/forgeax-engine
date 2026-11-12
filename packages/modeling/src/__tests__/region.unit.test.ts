import { describe, expect, it } from 'vitest';
import { dot, faceCentroid, faceNormal } from '../geom';
import { model } from '../model';
import { sel } from '../selectors';
import { bounds, expectContract, sharpEdges } from './contract';

function gappedTube(options: { tag?: string } = {}) {
  const m = model();
  m.cylinder({
    radiusTop: 1,
    radiusBottom: 1,
    height: 3,
    radialSegments: 8,
    heightSegments: 3,
    ...(options.tag === undefined ? {} : { tag: options.tag }),
  });
  m.delete(sel.inBox([-2, -0.5, -2], [2, 0.5, 2]));
  return m;
}

describe('extrudeRegion family', () => {
  it('perIsland extrudes each connected group along its own normal', () => {
    const merged = model();
    merged.box({ size: [1, 1, 1] });
    const bad = merged.extrude(sel.facing('+x').or(sel.facing('-x')), {
      distance: 1,
      region: 'merged',
    });
    expect(bad.error?.code).toBe('model-degenerate');
    const m = model();
    m.box({ size: [1, 1, 1] });
    const op = m.extrude(sel.facing('+x').or(sel.facing('-x')), {
      distance: 1,
      region: 'perIsland',
    });
    expect(op.roles).toEqual({ top: 2, side: 8 });
    expect(m.validate().volume).toBeCloseTo(3, 12);
    expectContract(m);
  });

  it('extrude keeps sharp intent on both strip boundaries and leaves rungs smooth', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.markSharp(sel.edges.dihedral('>', 40));
    m.extrude(sel.facing('+y'), { distance: 1, region: 'merged' });
    expect(sharpEdges(m.editMesh)).toBe(16);
  });

  it('offset moves every face plane by distance, including closed regions', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const op = m.offset(sel.all(), { distance: 0.1, region: 'merged' });
    expect(op.roles).toEqual({ top: 6 });
    expect(op.diagnostics).toBeUndefined();
    expect(m.validate().volume).toBeCloseTo(1.2 ** 3, 12);
    const top = model();
    top.box({ size: [1, 1, 1] });
    expect(top.offset(sel.facing('+y'), { distance: 0.5, region: 'merged' }).roles).toEqual({
      top: 1,
      side: 4,
    });
    expect(top.validate().volume).toBeCloseTo(1.5, 12);
    expectContract(top);
  });

  it('offset moves every capped-cylinder face plane by exactly distance', () => {
    const m = model();
    m.cylinder({ radiusTop: 1, radiusBottom: 1, height: 2, radialSegments: 8 });
    const apothem = Math.cos(Math.PI / 8);
    const op = m.offset(sel.all(), { distance: 0.1, region: 'merged' });
    expect(op.diagnostics).toBeUndefined();
    const sides = m.editMesh;
    let checked = 0;
    for (const f of sides.faces()) {
      const n = faceNormal(sides, f);
      const c = faceCentroid(sides, f);
      const expected = Math.abs(n[1]) > 0.5 ? 1.1 : apothem + 0.1;
      expect(dot(c, n)).toBeCloseTo(expected, 12);
      checked++;
    }
    expect(checked).toBe(10);
    expectContract(m);
  });

  it('offset reports faces its miter limit kept short of distance', () => {
    const m = model();
    m.cone({ radius: 0.2, height: 4, radialSegments: 16 });
    const op = m.offset(sel.all(), { distance: 0.05, region: 'merged' });
    expect(op.status).toBe('ok');
    expect(op.diagnostics?.[0]?.severity).toBe('warn');
    expect(op.diagnostics?.[0]?.detail?.faces).toBe(16);
  });

  it('offset requires a non-zero distance', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    expect(m.offset(sel.all(), { distance: 0, region: 'merged' }).error?.code).toBe(
      'model-invalid-argument',
    );
  });
});

describe('duplicate and disconnect', () => {
  it('duplicate copies faces as an island with tags and the copy role', () => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'body' });
    expect(m.duplicate(sel.facing('+y'), { label: 'lid' }).roles).toEqual({ copy: 1 });
    m.translate(sel.createdBy('lid', 'copy'), [0, 1, 0]);
    expect(m.count(sel.tag('body'))).toBe(7);
    expect(bounds(m.editMesh)[4]).toBe(1.5);
    const report = m.validate();
    expect(report.faces).toBe(7);
    expect(report.boundaryEdges).toBe(4);
    expectContract(m);
  });

  it('disconnect splits shared vertices in place and fails when already separate', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.markSharp(sel.edges.dihedral('>', 40));
    const op = m.disconnect(sel.facing('+y'));
    expect(op.roles).toEqual({ disconnected: 1, splitVertices: 4 });
    const report = m.validate();
    expect([report.faces, report.vertices, report.boundaryEdges]).toEqual([6, 12, 8]);
    expect(sharpEdges(m.editMesh)).toBe(16);
    expect(m.disconnect(sel.facing('+y')).error?.code).toBe('model-op-no-effect');
  });
});

describe('append', () => {
  it('copies another session with names merged and the operand unchanged', () => {
    const part = model();
    part.cylinder({
      radiusTop: 0.1,
      radiusBottom: 0.1,
      height: 0.5,
      radialSegments: 6,
      label: 'pin',
      tag: 'metal',
    });
    part.assign(sel.createdBy('pin', 'top'), 'chrome');
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'body' });
    expect(m.append(part, { translate: [0, 1, 0] }).roles).toEqual({ part: 8 });
    expect(part.editMesh.faceCount).toBe(8);
    expect(m.count(sel.tag('metal'))).toBe(8);
    expect(m.count(sel.tag('body'))).toBe(6);
    expect(m.count(sel.createdBy('pin', 'top').and(sel.material('chrome')))).toBe(1);
    expect(bounds(m.editMesh)[4]).toBe(1.25);
    const fromSnapshot = model();
    fromSnapshot.box({ size: [1, 1, 1], tag: 'body' });
    fromSnapshot.append(part.snapshot(), { translate: [0, 1, 0] });
    expect(fromSnapshot.snapshot()).toEqual(m.snapshot());
    expectContract(m);

    const labeled = model();
    labeled.append(part, { label: 'bolt' });
    expect(labeled.count(sel.createdBy('bolt', 'part'))).toBe(8);
    expect(labeled.inspect().labels.map((l) => l.label)).toEqual(['bolt']);
  });

  it('rejects itself and poisoned operands', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    expect(m.append(m).error?.code).toBe('model-invalid-argument');
    const broken = model();
    broken.box({ size: [1, 0, 1] });
    const other = model();
    const op = other.append(broken);
    expect(op.error?.code).toBe('model-precondition');
    expect(op.error?.detail?.cause).toBe('model-invalid-argument');
  });
});

describe('bridge', () => {
  it('closes the gap between two facing boundary loops with inherited tags', () => {
    const m = gappedTube({ tag: 'body' });
    expect(m.validate().boundaryEdges).toBe(16);
    const op = m.bridge(sel.edges.meshBoundary(), { segments: 2, label: 'patch' });
    expect(op.roles).toEqual({ side: 16 });
    expect(op.diagnostics ?? []).toEqual([]);
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.volume).toBeCloseTo((8 / 2) * Math.sin((2 * Math.PI) / 8) * 3, 10);
    expect(m.count(sel.createdBy('patch', 'side').and(sel.tag('body')))).toBe(16);
    expectContract(m);
  });

  it('asks for a material when the loops border different slots', () => {
    const m = gappedTube();
    m.assign(sel.inBox([-2, -2, -2], [2, -0.5, 2]), 'red');
    expect(m.bridge(sel.edges.meshBoundary()).error?.code).toBe('model-invalid-argument');
    const ok = gappedTube();
    ok.assign(sel.inBox([-2, -2, -2], [2, -0.5, 2]), 'red');
    ok.bridge(sel.edges.meshBoundary(), { material: 'red', label: 'patch' });
    expect(ok.count(sel.createdBy('patch', 'side').and(sel.material('red')))).toBe(8);
  });

  it('rejects interior edges and more than two loops; unequal loops split the shorter one', () => {
    const closed = model();
    closed.box({ size: [1, 1, 1] });
    expect(closed.bridge(sel.edges.all()).error?.code).toBe('model-precondition');
    const four = model();
    four.cylinder({ radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 8, openEnded: true });
    four.cylinder({
      radiusTop: 1,
      radiusBottom: 1,
      height: 1,
      radialSegments: 8,
      openEnded: true,
      center: [0, 3, 0],
    });
    expect(four.bridge(sel.edges.meshBoundary()).error?.detail?.loops).toBe(4);
    const unequal = model();
    unequal.cone({ radius: 1, height: 1, radialSegments: 8, openEnded: true });
    unequal.cone({ radius: 1, height: 1, radialSegments: 6, openEnded: true, center: [0, 3, 0] });
    unequal.rotate(sel.inBox([-2, 2, -2], [2, 4, 2]), 'x', 180, [0, 3, 0]);
    const joined = unequal.bridge(sel.edges.meshBoundary());
    expect(joined.status).toBe('ok');
    expect(joined.roles).toEqual({ side: 8 });
    expect(joined.diagnostics?.[0]?.detail).toMatchObject({ counts: [6, 8], inserted: 2 });
    const report = unequal.validate();
    expect(report.closed).toBe(true);
    const errors = report.issues.filter((i) => i.severity === 'error');
    expect(errors.map((i) => i.code)).toEqual(['mesh-inverted']);
    unequal.flip(sel.all());
    expect(unequal.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});
