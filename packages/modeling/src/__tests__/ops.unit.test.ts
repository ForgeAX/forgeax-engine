import { describe, expect, it } from 'vitest';
import { faceArea, meshVolume } from '../geom';
import { model } from '../model';
import { sel } from '../selectors';

describe('region operators', () => {
  it('extrude grows the volume by area x distance and reports top/side roles', () => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'body' });
    const op = m.extrude(sel.facing('+y'), { distance: 0.5, region: 'merged', label: 'lift' });
    expect(op.status).toBe('ok');
    expect(op.roles).toEqual({ top: 1, side: 4 });
    const report = m.validate();
    expect(report.pass).toBe(true);
    expect(report.closed).toBe(true);
    expect(report.faces).toBe(10);
    expect(report.volume).toBeCloseTo(1.5, 12);
    expect(m.count(sel.tag('body'))).toBe(10);
    expect(m.count(sel.createdBy('lift', 'side'))).toBe(4);
  });

  it('negative extrude digs a pocket after an inset', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.inset(sel.facing('+y'), { thickness: 0.2, region: 'merged', label: 'rim' });
    m.extrude(sel.createdBy('rim', 'inner'), { distance: -0.3, region: 'merged', label: 'pocket' });
    const report = m.validate();
    expect(report.pass).toBe(true);
    expect(report.closed).toBe(true);
    expect(report.volume).toBeCloseTo(1 - 0.6 * 0.6 * 0.3, 12);
  });

  it('merged extrude of adjacent faces shares one wall ring; perFace gives each its own', () => {
    const merged = model();
    merged.box({ size: [2, 1, 1], segments: [2, 1, 1] });
    expect(merged.extrude(sel.facing('+y'), { distance: 1, region: 'merged' }).roles).toEqual({
      top: 2,
      side: 6,
    });
    expect(merged.validate().volume).toBeCloseTo(4, 12);
    const separate = model();
    separate.box({ size: [2, 1, 1], segments: [2, 1, 1] });
    expect(separate.extrude(sel.facing('+y'), { distance: 1, region: 'perFace' }).roles).toEqual({
      top: 2,
      side: 8,
    });
    expect(separate.validate().closed).toBe(true);
  });

  it('inset keeps the faces coplanar, shrinks the inner face and keeps the volume', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const op = m.inset(sel.facing('+y'), { thickness: 0.1, region: 'merged', label: 'panel' });
    expect(op.roles).toEqual({ inner: 1, rim: 4 });
    const inner = sel.createdBy('panel', 'inner').evaluate(m.editMesh)[0] as number;
    expect(faceArea(m.editMesh, inner)).toBeCloseTo(0.64, 12);
    expect(meshVolume(m.editMesh)).toBeCloseTo(1, 12);
    expect(m.validate().pass).toBe(true);
  });

  it('inset that would invert the inner face fails, poisons the session and changes nothing afterwards', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const op = m.inset(sel.facing('+y'), { thickness: 0.6, region: 'merged' });
    expect(op.status).toBe('failed');
    expect(op.error?.code).toBe('model-degenerate');
    expect(m.extrude(sel.all(), { distance: 1, region: 'merged' }).status).toBe('skipped');
    const finished = m.finish({ key: 'x' });
    expect(!finished.ok && finished.error.code).toBe('model-degenerate');
  });

  it('mirror closes an open half and doubles the volume', () => {
    const m = model();
    m.box({ size: [1, 1, 1], center: [0.5, 0, 0] });
    m.delete(sel.facing('-x'));
    const op = m.mirror({ axis: 'x' });
    expect(op.roles).toEqual({ mirrored: 5 });
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.vertices).toBe(12);
    expect(report.volume).toBeCloseTo(2, 12);
    expect(m.count(sel.mirrored())).toBe(5);
  });

  it('mirror refuses a mesh that is closed across the plane', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const op = m.mirror({ axis: 'x' });
    expect(op.status).toBe('failed');
    expect(op.error?.code).toBe('model-precondition');
  });

  it('flip reverses orientation and weld merges coincident vertices', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.flip(sel.all());
    expect(m.validate().volume).toBeCloseTo(-1, 12);
    const w = model();
    w.polygon({
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, -1],
      ],
    });
    w.polygon({
      points: [
        [0, 0, 0],
        [1, 0, -1],
        [0, 0, -1],
      ].map(([x, y, z]) => [x as number, y as number, z as number]),
    });
    expect(w.validate().boundaryEdges).toBe(6);
    const welded = w.weld({ distance: 1e-6 });
    expect(welded.roles).toEqual({});
    expect(welded.repair).toMatchObject({ op: 'weld', changed: 2, collapsedFaces: 0 });
    expect(w.validate().boundaryEdges).toBe(4);
  });

  it('weld reports each merge by its move, largest first', () => {
    const m = model();
    const gaps = [0.001, 0.002, 0.005];
    gaps.forEach((gap, k) => {
      const x = 10 * k;
      m.polygon({
        points: [
          [x, 0, 0],
          [x + 1, 0, 0],
          [x, 1, 0],
        ],
      });
      m.polygon({
        points: [
          [x + gap, 0, 0],
          [x + 4, 5, 0],
          [x + 3, 0, -3],
        ],
      });
    });
    const op = m.weld({ distance: 0.006 });
    expect(op.status).toBe('ok');
    const repair = op.repair;
    expect(repair).toMatchObject({ op: 'weld', changed: 3, collapsedFaces: 0 });
    const sites = repair?.sites ?? [];
    expect(sites.map((s) => s.deviation)).toHaveLength(3);
    expect(sites[0]?.deviation).toBeCloseTo(0.005, 12);
    expect(sites[1]?.deviation).toBeCloseTo(0.002, 12);
    expect(sites[2]?.deviation).toBeCloseTo(0.001, 12);
    expect(sites[0]?.at).toEqual([20, 0, 0]);
    expect(m.journal[m.journal.length - 1]?.repair).toEqual(repair);
  });

  it('translate, scale and rotate move only the selected faces and reject reflection by scale', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.translate(sel.all(), [0, 1, 0]);
    m.scale(sel.all(), [2, 1, 1]);
    m.rotate(sel.all(), 'y', 90);
    expect(m.validate().volume).toBeCloseTo(2, 12);
    const bad = m.scale(sel.all(), [-1, 1, 1]);
    expect(bad.error?.code).toBe('model-invalid-argument');
  });
});
