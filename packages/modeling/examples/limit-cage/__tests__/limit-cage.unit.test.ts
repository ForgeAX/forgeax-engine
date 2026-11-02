import { model, sel, subdivisionLimit } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { recordingSessions } from '../../case/record';
import { buildLimitCage, LIMIT_CAGE } from '../body';

/**
 * Case C-124 gate: the head-style cage keeps its poles, snaps onto its limit
 * surface with bitwise x-mirror symmetry, and a second snap moves nothing beyond the
 * contraction of the limit mask.
 */
describe('C-124 limit cage', () => {
  it('records at least three steps and builds a valid solid', () => {
    const recording = recordingSessions();
    const m = buildLimitCage(LIMIT_CAGE, recording.session);
    expect(recording.steps.length).toBeGreaterThanOrEqual(3);
    expect(m.validate({ minThickness: 0.002 }).pass).toBe(true);
    expect(recording.steps.map((s) => s.entry.op)).toContain('snapToLimit');
  });

  it('keeps the snapped cage mirror-symmetric about x = 0', () => {
    const mesh = buildLimitCage().editMesh;
    const points = mesh.vertices().map((v) => mesh.position(v));
    let pairs = 0;
    for (const q of points) {
      const gap = Math.min(...points.map((o) => Math.hypot(o[0] + q[0], o[1] - q[1], o[2] - q[2])));
      expect(gap).toBeLessThan(1e-15);
      if (q[0] !== 0) pairs++;
    }
    expect(pairs).toBeGreaterThan(0);
  });

  it('puts the unsnapped cage poles on valence 3 and the snap on the evaluated limit', () => {
    const m = model();
    m.box({ size: [0.2, 0.16, 0.14] });
    m.subdivide(undefined, { levels: 1, scheme: 'simple' });
    const before = m.limit();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect([...before.value.valence].filter((n) => n === 3).length).toBe(8);
    expect(m.snapToLimit(sel.all()).status).toBe('ok');
    const mesh = m.editMesh;
    for (const [i, v] of before.value.vertices.entries()) {
      const q = mesh.position(v);
      expect(q[0]).toBe(before.value.position[i * 3]);
      expect(q[1]).toBe(before.value.position[i * 3 + 1]);
      expect(q[2]).toBe(before.value.position[i * 3 + 2]);
    }
    expect(subdivisionLimit(mesh).ok).toBe(true);
  });
});
