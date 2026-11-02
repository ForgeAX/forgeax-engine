import { describe, expect, it } from 'vitest';
import { EDGE_SHARP } from '../mesh';
import { type Model, model } from '../model';
import { sel } from '../selectors';
import { bounds, expectContract } from './contract';

function cube(size = 1): Model {
  const m = model();
  m.box({ size: [size, size, size], tag: 'body' });
  return m;
}

function warnings(report: { diagnostics?: readonly { message: string }[] }): string[] {
  return (report.diagnostics ?? []).map((d) => d.message);
}

describe('shell', () => {
  it('hollows a closed box inward with exact walls and nested inner faces', () => {
    const m = cube();
    const op = m.shell(sel.all(), { thickness: 0.1, label: 'wall' });
    expect(op.status).toBe('ok');
    expect(op.roles).toEqual({ inner: 6 });
    expect(op.diagnostics).toBeUndefined();
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.volume).toBeCloseTo(1 - 0.8 ** 3, 12);
    expect(bounds(m.editMesh)).toEqual([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]);
    expect(m.count(sel.createdBy('wall', 'inner').and(sel.tag('body')))).toBe(6);
    const named = model();
    named.box({ size: [1, 1, 1], label: 'cube' });
    named.shell(sel.all(), { thickness: 0.1, direction: 'out', label: 'wall' });
    expect(named.count(sel.createdBy('cube', 'face'))).toBe(6);
    expect(named.count(sel.createdBy('wall', 'inner'))).toBe(6);
    expectContract(m);
  });

  it('opens faces into rimmed openings and marks the rim borders sharp', () => {
    const m = cube();
    const op = m.shell(sel.all(), {
      thickness: 0.05,
      open: sel.facing('+y'),
      label: 'wall',
    });
    expect(op.roles).toEqual({ inner: 5, rim: 4 });
    expect(op.diagnostics).toBeUndefined();
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.volume).toBeCloseTo(1 - 0.9 * 0.9 * 0.95, 12);
    const rim = m.bounds(sel.createdBy('wall', 'rim'));
    if (!rim.ok) throw rim.error;
    expect(rim.value.min[1]).toBeCloseTo(0.5, 12);
    const mesh = m.editMesh;
    const sharp = m.editMesh.edges().filter((e) => ((mesh.eFlags[e] as number) & EDGE_SHARP) !== 0);
    expect(sharp).toHaveLength(8);
    expect(m.journal.at(-1)?.args).toMatchObject({ open: 'facing(+y, 1)' });
    expectContract(m);
  });

  it("grows outward or both ways and keeps an open sheet's thickness", () => {
    const out = cube();
    expect(out.shell(sel.all(), { thickness: 0.1, direction: 'out' }).roles).toEqual({
      inner: 6,
    });
    expect(bounds(out.editMesh)).toEqual(
      [-0.6, -0.6, -0.6, 0.6, 0.6, 0.6].map((x) => expect.closeTo(x, 12)),
    );
    expect(out.validate().volume).toBeCloseTo(1.2 ** 3 - 1, 12);
    const sheet = model();
    sheet.plane({ width: 2, height: 1, widthSegments: 2 });
    const op = sheet.shell(sel.all(), { thickness: 0.2, direction: 'both', label: 'slab' });
    expect(op.roles).toEqual({ inner: 2, rim: 6 });
    expect(sheet.validate().volume).toBeCloseTo(2 * 1 * 0.2, 12);
    expect(bounds(sheet.editMesh)[2]).toBeCloseTo(-0.1, 12);
    expectContract(sheet);
  });

  it('keeps corner values on the inner copy and inherits tags and materials', () => {
    const m = cube();
    m.uv.project({ mode: 'box', scale: 1 });
    m.assign(sel.facing('+x'), 'metal');
    m.shell(sel.all(), { thickness: 0.1, open: sel.facing('-y') });
    expect(m.count(sel.material('metal'))).toBe(3);
    expect(m.count(sel.tag('body'))).toBe(m.editMesh.faceCount);
    const inner = m.editMesh
      .faces()
      .filter((f) =>
        m.editMesh.faceHalves(f).every((h) => m.editMesh.corner('uv0', h) !== undefined),
      );
    expect(inner).toHaveLength(10);
    const out = m.toMesh();
    expect(out.ok ? undefined : out.error.code).toBe('model-precondition');
    m.uv.project({ mode: 'box', scale: 1 });
    expect(m.toMesh().ok).toBe(true);
  });

  it('shells curved parts within tolerance (angle-weighted pseudo-normals)', () => {
    const m = model();
    m.sphere({ radius: 1, widthSegments: 24, heightSegments: 12 });
    const op = m.shell(sel.all(), { thickness: 0.05, label: 'skin' });
    expect(warnings(op)).toEqual([]);
    const report = m.validate();
    expect(report.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    const tube = model();
    tube.cylinder({
      radiusTop: 0.5,
      radiusBottom: 0.5,
      height: 1,
      radialSegments: 16,
      openEnded: true,
    });
    expect(warnings(tube.shell(sel.all(), { thickness: 0.04, direction: 'out' }))).toEqual([]);
    expect(tube.validate().closed).toBe(true);
  });

  it('limits growth toward a static neighbour by the full gap', () => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'a' });
    m.box({ size: [1, 1, 1], center: [1.1, 0.3, 0.3], tag: 'b' });
    const op = m.shell(sel.tag('a'), { thickness: 0.2, direction: 'out' });
    expect(op.error?.detail).toMatchObject({ limitedBy: 'clearance' });
    expect(op.error?.detail?.maxThickness).toBeCloseTo(0.1, 9);
  });

  it('fails as a precondition when walls would meet, and clamps on request', () => {
    const m = cube();
    const op = m.shell(sel.all(), { thickness: 0.6 });
    expect(op.error?.code).toBe('model-precondition');
    expect(op.error?.detail).toMatchObject({ limitedBy: 'clearance', thickness: 0.6 });
    expect(op.error?.detail?.maxThickness).toBeCloseTo(0.5, 9);
    const clamped = cube();
    const done = clamped.shell(sel.all(), { thickness: 0.6, clamp: true });
    expect(done.status).toBe('ok');
    expect(done.diagnostics?.[0]?.detail).toMatchObject({ applied: expect.closeTo(0.475, 9) });
    expect(clamped.validate().volume).toBeCloseTo(1 - 0.05 ** 3, 9);
    expectContract(clamped);
  });

  it('fails as a precondition when a small face would collapse', () => {
    const m = model();
    m.extrudePolygon({
      points: [
        [0, 0],
        [1, 0],
        [1, 0.45],
        [0.98, 0.5],
        [1, 0.55],
        [1, 1],
        [0, 1],
      ],
      depth: 1,
    });
    const op = m.shell(sel.all(), { thickness: 0.4, direction: 'out' });
    expect(op.error?.code).toBe('model-precondition');
    expect(op.error?.detail).toMatchObject({ limitedBy: 'collapse' });
    const max = op.error?.detail?.maxThickness as number;
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThan(0.4);
    const fits = model();
    fits.extrudePolygon({
      points: [
        [0, 0],
        [1, 0],
        [1, 0.45],
        [0.98, 0.5],
        [1, 0.55],
        [1, 1],
        [0, 1],
      ],
      depth: 1,
    });
    expect(fits.shell(sel.all(), { thickness: max * 0.9, direction: 'out' }).status).toBe('ok');
  });

  it('rejects partial parts, stray openings and bad magnitudes without changes', () => {
    const m = cube();
    const before = m.snapshot();
    const partial = m.shell(sel.facing('+y'), { thickness: 0.1 });
    expect(partial.error?.code).toBe('model-precondition');
    expect(partial.error?.detail?.count).toBe(4);
    for (const options of [
      { thickness: 0 },
      { thickness: Number.NaN },
      { thickness: 0.1, direction: 'sideways' as never },
    ]) {
      const n = cube();
      expect(n.shell(sel.all(), options).error?.code).toBe('model-invalid-argument');
    }
    const stray = model();
    stray.box({ size: [1, 1, 1] });
    stray.box({ size: [1, 1, 1], center: [3, 0, 0], tag: 'other' });
    expect(
      stray.shell(sel.tag('other'), { thickness: 0.1, open: sel.facing('+y') }).error?.code,
    ).toBe('model-invalid-argument');
    const all = cube();
    expect(all.shell(sel.all(), { thickness: 0.1, open: sel.all() }).error?.code).toBe(
      'model-invalid-argument',
    );
    const empty = cube();
    expect(empty.shell(sel.all(), { thickness: 0.1, open: sel.tag('missing') }).error?.code).toBe(
      'model-selection-empty',
    );
    const untouched = cube();
    expect(untouched.snapshot()).toEqual(before);
  });

  it('falsifies the thickness assertion: miter-clamped acute corners warn', () => {
    const m = model();
    m.extrudePolygon({
      points: [
        [0, 0],
        [1, 0.04],
        [0, 0.08],
      ],
      depth: 0.5,
    });
    const op = m.shell(sel.all(), { thickness: 0.01, direction: 'out' });
    expect(op.status).toBe('ok');
    const messages = warnings(op);
    expect(messages.some((s) => s.includes('miter limit'))).toBe(true);
    expect(messages.some((s) => s.includes('differ from thickness'))).toBe(true);
  });

  it('fails and rolls back when walls grow into a neighbour (review S-3)', () => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'a' });
    m.box({ size: [1, 0.5, 0.5], center: [1.01, 0, 0], tag: 'b' });
    const before = m.snapshot();
    const op = m.shell(sel.tag('a'), { thickness: 0.05, direction: 'out' });
    expect(op.status).toBe('failed');
    expect(op.error?.code).toBe('model-degenerate');
    expect(op.error?.expected).toMatch(/no shell wall crosses/);
    expect((op.error?.detail as { at: unknown[] }).at.length).toBeGreaterThan(0);
    expect(m.snapshot()).toEqual(before);
  });

  it('keeps crossings with an already overlapping part a warning, not a new neighbour (review S-3)', () => {
    const build = (neighbour: boolean) => {
      const m = model();
      m.box({ size: [1, 1, 1], tag: 'a' });
      m.box({ size: [0.5, 0.5, 0.5], center: [0, 0.6, 0], tag: 'b' });
      if (neighbour) m.box({ size: [1, 0.5, 0.5], center: [1.01, 0, 0], tag: 'c' });
      return { m, op: m.shell(sel.tag('a'), { thickness: 0.05, direction: 'out' }) };
    };
    const overlapping = build(false).op;
    expect(overlapping.status).toBe('ok');
    expect(overlapping.diagnostics?.some((d) => /self-intersects/.test(d.message))).toBe(true);
    const crowded = build(true).op;
    expect(crowded.status).toBe('failed');
    expect(crowded.error?.code).toBe('model-degenerate');
  });

  it('a layer whose walls cross a neighbour fails and rolls back (review S-3)', () => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'a' });
    m.box({ size: [1, 0.5, 0.5], center: [1.03, 0, 0], tag: 'b' });
    const before = m.snapshot();
    const op = m.layer(sel.tag('a').and(sel.facing('+x')), { offset: 0.01, thickness: 0.05 });
    expect(op.status).toBe('failed');
    expect(op.error?.code).toBe('model-degenerate');
    expect(m.snapshot()).toEqual(before);
  });

  it('is deterministic and history independent', () => {
    const build = () => {
      const m = model();
      m.cylinder({ radiusTop: 0.4, radiusBottom: 0.5, height: 1, radialSegments: 12 });
      m.shell(sel.all(), { thickness: 0.03, open: sel.facing('+y'), label: 'cup' });
      return m.snapshot();
    };
    expect(build()).toEqual(build());
  });
});
