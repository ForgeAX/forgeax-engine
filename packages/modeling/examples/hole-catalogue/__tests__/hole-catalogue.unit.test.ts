import { definePackageId, executePackBuild } from '@forgeax/engine-pack/source';
import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { buildHoleCatalogue, HOLE_CATALOGUE_DEFAULTS } from '../hole-catalogue';
import pack from '../hole-catalogue.pack';

describe('SC-L3 hole catalogue', () => {
  it('cuts all four kinds through and blind and validates', { timeout: 300000 }, () => {
    const m = buildHoleCatalogue();
    expect(m.poisoned).toBeUndefined();
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    for (const kind of ['simple', 'counterbore', 'countersink', 'tapped']) {
      expect(m.count(sel.createdBy(`through-${kind}`)), `through-${kind}`).toBeGreaterThan(0);
      expect(m.count(sel.createdBy(`blind-${kind}`)), `blind-${kind}`).toBeGreaterThan(0);
    }
    expect(m.count(sel.createdBy('lower-hole', 'hole-thread'))).toBeGreaterThan(0);
  });

  it('records one step per source line and is deterministic', { timeout: 300000 }, () => {
    const recording = recordingSessions();
    buildHoleCatalogue(HOLE_CATALOGUE_DEFAULTS, recording.session);
    const steps = attachSourceLines(recording.steps, new URL('../hole-catalogue.ts', import.meta.url).pathname);
    expect(steps.length).toBeGreaterThanOrEqual(10);
    expect(steps.every((s) => s.entry.status === 'ok')).toBe(true);
    expect(buildHoleCatalogue().snapshot()).toEqual(buildHoleCatalogue().snapshot());
  });

  it('is an ordinary Pack build with a mesh/hole-catalogue output', { timeout: 300000 }, async () => {
    const result = await executePackBuild(pack, {
      packageId: definePackageId('01900000-0000-7000-8000-00000005c003'),
      readByGuid: async () => {
        throw new Error('the catalogue reads no other asset');
      },
      values: { ...HOLE_CATALOGUE_DEFAULTS },
    });
    expect(result.ok ? Object.keys(result.value) : JSON.stringify(result.error).slice(0, 600)).toEqual(['mesh/hole-catalogue']);
  });
});
