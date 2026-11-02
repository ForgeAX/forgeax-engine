import { describe, expect, it } from 'vitest';
import { diffMeshes, type MeshDiff } from '../diff';
import { model } from '../model';
import { sel } from '../selectors';

function diff(a: Parameters<typeof diffMeshes>[0], b: Parameters<typeof diffMeshes>[1]): MeshDiff {
  const out = diffMeshes(a, b);
  if (!out.ok) throw out.error;
  return out.value;
}

function crate(height: number) {
  const m = model();
  m.box({ size: [1, height, 1], tag: 'shell' });
  m.inset(sel.facing('+y'), { thickness: 0.1, region: 'merged', label: 'panel' });
  return m;
}

describe('diffMeshes', () => {
  it('reports 160k removed faces without overflowing the call stack (C-410 lowpoly probe)', {
    timeout: 60000,
  }, () => {
    const a = model();
    a.plane({ width: 1, height: 1, widthSegments: 400, heightSegments: 400 });
    const b = model();
    b.box({ size: [1, 1, 1] });
    const d = diff(a.editMesh, b.editMesh);
    expect(d.faces.removed).toBeGreaterThan(150000);
    expect(d.differences).toHaveLength(64);
    expect(d.differencesTotal).toBeGreaterThanOrEqual(d.faces.removed);
  });

  it('reports nothing for equal states, regardless of edit history', () => {
    const a = model();
    a.box({ size: [1, 1, 1] });
    const b = model();
    b.box({ size: [1, 1, 1] });
    b.translate(sel.all(), [1, 0, 0]);
    b.translate(sel.all(), [-1, 0, 0]);
    const d = diff(a.editMesh, b.snapshot());
    expect(d.identical).toBe(true);
    expect(d.differences).toEqual([]);
    expect(d.faces).toEqual({ unchanged: 6, moved: 0, added: 0, removed: 0 });
    expect(d.hausdorff.max).toBe(0);
  });

  it('a parameter change moves faces by provenance and changes volume and bounds', () => {
    const d = diff(crate(1).editMesh, crate(2).editMesh);
    expect(d.identical).toBe(false);
    expect(d.counts.faces).toEqual({ a: 10, b: 10, delta: 0 });
    expect(d.volume.delta).toBeCloseTo(1, 12);
    expect(d.bounds.frame).toEqual([-0.5, -1, -0.5, 0.5, 1, 0.5]);
    expect(d.hausdorff.max).toBeCloseTo(0.5, 12);
    const panel = d.provenance.find((p) => p.label === 'panel' && p.role === 'inner');
    expect(panel).toMatchObject({ a: 1, b: 1, moved: 1, unchanged: 0 });
    const bottom = d.provenance.find((p) => p.label === '' && p.role === '');
    expect(bottom).toMatchObject({ a: 5, b: 5, moved: 5 });
    const moved = d.differences.find(
      (x) => x.reason === 'face-moved' && x.elementA?.role === 'inner',
    );
    expect(moved?.detail).toMatchObject({ label: 'panel', distance: 0.5, normalDot: 1 });
    expect(d.differences.map((x) => x.reason)).toContain('volume');
    expect(d.differences.map((x) => x.reason)).toContain('bounds');
  });

  it('counts added and removed faces, tags and materials on a known edit', () => {
    const a = crate(1);
    const b = crate(1);
    b.extrude(sel.createdBy('panel', 'inner'), {
      distance: -0.05,
      region: 'merged',
      label: 'well',
    });
    b.assign(sel.createdBy('well', 'top'), 'glow');
    b.tag(sel.createdBy('well'), 'recess');
    const d = diff(a.editMesh, b.editMesh);
    expect(d.counts.faces.delta).toBe(4);
    expect(d.faces).toEqual({ unchanged: 9, moved: 0, added: 5, removed: 1 });
    expect(d.provenance.find((p) => p.label === 'well' && p.role === 'side')).toMatchObject({
      a: 0,
      b: 4,
      added: 4,
    });
    expect(d.tags.find((t) => t.tag === 'recess')).toEqual({ tag: 'recess', a: 0, b: 5, delta: 5 });
    expect(d.materials.find((m) => m.material === 'glow')).toEqual({
      material: 'glow',
      a: 0,
      b: 1,
      delta: 1,
    });
    expect(d.volume.delta).toBeCloseTo(-0.8 * 0.8 * 0.05, 12);
    const removed = d.differences.find((x) => x.reason === 'face-removed');
    expect(removed?.elementA).toMatchObject({ label: 'panel', role: 'inner' });
  });

  it('reports topology changes, open boundaries and bounded lists', () => {
    const a = model();
    a.box({ size: [1, 1, 1] });
    const b = model();
    b.box({ size: [1, 1, 1] });
    b.delete(sel.facing('+y'));
    const d = diff(a.editMesh, b.editMesh);
    expect(d.closed).toEqual({ a: true, b: false });
    expect(d.counts.boundaryEdges).toEqual({ a: 0, b: 4, delta: 4 });
    expect(d.differences.map((x) => x.reason)).toEqual(
      expect.arrayContaining(['count', 'closed', 'face-removed']),
    );
    const s = model();
    s.sphere({ radius: 1, widthSegments: 32, heightSegments: 16 });
    const t = model();
    t.sphere({ radius: 1.1, widthSegments: 32, heightSegments: 16 });
    const bounded = diffMeshes(s.editMesh, t.editMesh, { limit: 5, work: 1000 });
    if (!bounded.ok) throw bounded.error;
    expect(bounded.value.differences).toHaveLength(5);
    expect(bounded.value.differencesTotal).toBeGreaterThan(500);
    expect(bounded.value.hausdorff.sampled).toBe(true);
    expect(bounded.value.hausdorff.max).toBeGreaterThan(0.05);
  });

  it('compares checkpoints of one session and rejects malformed snapshots', () => {
    const m = crate(1);
    const before = m.snapshot();
    m.shell(sel.all(), { thickness: 0.05, open: sel.createdBy('panel', 'inner'), label: 'wall' });
    const d = diff(before, m.snapshot());
    expect(d.provenance.find((p) => p.label === 'wall' && p.role === 'inner')?.b).toBe(9);
    expect(d.volume.delta).toBeLessThan(0);
    const bad = diffMeshes(new Uint8Array(8), before);
    expect(bad.ok).toBe(false);
  });

  it('is deterministic', () => {
    const run = () => JSON.stringify(diff(crate(1).editMesh, crate(1.5).editMesh));
    expect(run()).toBe(run());
  });
});
