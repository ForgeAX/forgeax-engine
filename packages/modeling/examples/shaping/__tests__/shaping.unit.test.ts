import { draft, type Model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import {
  buildGradientPlate,
  buildHood,
  buildInsert,
  buildMixedCorner,
  coreWalls,
  draftColors,
  hoodNets,
  SHAPING,
} from '../shaping';
import { roughness } from '../../quality-body/views';

function closed(m: Model): number {
  expect(m.poisoned).toBeUndefined();
  const report = m.validate();
  expect(report.closed).toBe(true);
  expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
  return report.volume;
}

describe('shaping example', () => {
  it('bevels the saw plate with a width gradient in one call', () => {
    const m = buildGradientPlate();
    const op = m.journal.at(-1);
    expect(op?.status).toBe('ok');
    const { teeth, pitch, body, tooth, depth } = SHAPING.plate;
    const full = (teeth * pitch * body + (teeth * pitch * tooth) / 2) * depth;
    expect(closed(m)).toBeLessThan(full);
    // The flat top of the first tooth tip is narrower than that of the last.
    const tipWidth = (k: number) => {
      const x = (k + 0.5) * pitch;
      const top = sel.inBox([x - pitch / 4, body + tooth * 0.5, -1], [x + pitch / 4, 1, 1]);
      const b = m.bounds(top.and(sel.createdBy('saw')));
      if (!b.ok) throw b.error;
      return b.value.max[0] - b.value.min[0];
    };
    expect(tipWidth(0)).toBeLessThan(tipWidth(teeth - 1));
  });

  it('builds a closed three-width corner', () => {
    const m = buildMixedCorner();
    expect(closed(m)).toBeLessThan(0.4 ** 3);
    expect(m.count(sel.createdBy('corner', 'corner'))).toBeGreaterThan(0);
  });

  it('drafts the insert core walls: critical before, safe at 90 - angle after', () => {
    const before = buildInsert();
    const v0 = closed(before);
    const walls0 = draft(before, { direction: [0, 1, 0], faces: coreWalls });
    if (!walls0.ok) throw walls0.error;
    expect(walls0.value.critical.length).toBe(walls0.value.faces.length);
    const after = buildInsert(undefined, { drafted: true });
    expect(closed(after)).toBeLessThan(v0);
    const walls = draft(after, { direction: [0, 1, 0], faces: coreWalls });
    if (!walls.ok) throw walls.error;
    expect(walls.value.faces.length).toBe(12);
    for (const f of walls.value.faces) expect(f.angle).toBeCloseTo(90 - SHAPING.insert.angle, 9);
    expect(draftColors(after).triangles).toBeGreaterThan(0);
  });

  it('fairs the rippled hood without moving its boundary', () => {
    const { rippled, faired } = hoodNets();
    const last = rippled.points.length - 1;
    expect(faired.points[0]).toEqual(rippled.points[0]);
    expect(faired.points[last]).toEqual(rippled.points[last]);
    expect(faired.points).not.toEqual(rippled.points);
    const [before, after] = [false, true].map((faired) => roughness(buildHood(undefined, { faired })));
    expect(after as number).toBeLessThan((before as number) / 5);
  });
});
