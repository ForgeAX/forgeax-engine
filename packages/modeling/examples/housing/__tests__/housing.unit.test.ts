import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { buildHousing, HOUSING_DEFAULTS } from '../housing';

describe('C-012 thin-walled housing', () => {
  it('builds a closed, clean housing whose shell keeps exact walls', () => {
    const m = buildHousing();
    expect(m.poisoned).toBeUndefined();
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    const shell = m.journal.find((e) => e.op === 'shell');
    expect(shell?.roles).toEqual({ inner: 106, rim: 50 });
    expect(shell?.diagnostics).toBeUndefined();
    expect(m.journal.every((e) => e.diagnostics === undefined)).toBe(true);
    const walls = m.validate({ minThickness: HOUSING_DEFAULTS.wall * 0.99 }).issues;
    const thin = walls.find((i) => i.code === 'thin-wall');
    expect(thin?.detail.thinnest).toBeGreaterThan(0.0007);
  });

  it('keeps author selections across wall and vent parameters', () => {
    const base = buildHousing();
    const variant = buildHousing({ wall: 0.003, vents: 8 });
    expect(base.count(sel.createdBy('screw', 'top'))).toBe(4);
    expect(variant.count(sel.createdBy('screw', 'top'))).toBe(4);
    expect(base.count(sel.createdBy('vent', 'rim'))).toBe(20);
    expect(variant.count(sel.createdBy('vent', 'rim'))).toBe(32);
    expect(variant.count(sel.createdBy('rib', 'top'))).toBe(1);
    const floor = variant.bounds(sel.createdBy('rib', 'top'));
    if (!floor.ok) throw floor.error;
    expect(floor.value.min[1]).toBeCloseTo(0.003 + 0.008, 12);
  });

  it('records one step per source line and is deterministic', () => {
    const recording = recordingSessions();
    buildHousing(HOUSING_DEFAULTS, recording.session);
    expect(attachSourceLines(recording.steps, new URL('../housing.ts', import.meta.url).pathname)).toHaveLength(24);
    expect(buildHousing().snapshot()).toEqual(buildHousing().snapshot());
  });
});
