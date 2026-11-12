import { model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { recordingSessions } from '../../case/record';
import { buildCreaseNeck, CREASE_NECK } from '../body';

/**
 * Case C-126 gate: the half-sharp rim keeps the mirror symmetry of the limit snap and
 * lies between the smooth and the fully sharp surface.
 */
describe('C-126 crease neck', () => {
  it('records at least three steps and builds a valid solid', () => {
    const recording = recordingSessions();
    const m = buildCreaseNeck(CREASE_NECK, recording.session);
    expect(recording.steps.length).toBeGreaterThanOrEqual(3);
    expect(m.validate({ minThickness: 0.002 }).pass).toBe(true);
    expect(recording.steps.map((s) => s.entry.op)).toContain('markCrease');
    expect(recording.steps.map((s) => s.entry.op)).toContain('snapToLimit');
  });

  it('keeps the snapped cage mirror-symmetric about x = 0', () => {
    const mesh = buildCreaseNeck().editMesh;
    const points = mesh.vertices().map((v) => mesh.position(v));
    let pairs = 0;
    for (const q of points) {
      const gap = Math.min(...points.map((o) => Math.hypot(o[0] + q[0], o[1] - q[1], o[2] - q[2])));
      expect(gap).toBeLessThan(1e-15);
      if (q[0] !== 0) pairs++;
    }
    expect(pairs).toBeGreaterThan(0);
  });

  it('puts the rim extent between the smooth and the fully sharp surface', () => {
    const top = (sharpness: number | 'smooth'): number => {
      const m = model();
      m.box({ size: [...CREASE_NECK.size] });
      m.subdivide(undefined, { levels: 1, scheme: 'simple' });
      m.scale(sel.facing('+y'), [CREASE_NECK.taper, 1, CREASE_NECK.taper]);
      if (sharpness !== 'smooth') m.markCrease(sel.facing('+y').boundary(), sharpness);
      m.subdivide(undefined, { levels: 1 });
      m.snapToLimit(sel.all());
      const mesh = m.editMesh;
      return mesh.vertices().reduce((sum, v) => sum + mesh.position(v)[1] ** 2 + mesh.position(v)[0] ** 2, 0);
    };
    const smooth = top('smooth');
    const half = top(CREASE_NECK.sharpness);
    const full = top(Infinity);
    expect(half).toBeGreaterThan(smooth);
    expect(half).toBeLessThan(full);
  });
});
