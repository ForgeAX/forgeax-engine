import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { HIGH, LOW } from '../kit';
import { GROUPS } from '../mech';
import { buildGroup, COVER_TOLERANCE, coverageReference } from '../pipeline';

const group = (name: string) => GROUPS.find((g) => g.name === name)!;
const SPACING = 0.03;
const cover = (name: string, surface = coverageReference(group(name)), tolerance = COVER_TOLERANCE, low = buildGroup(group(name), LOW)) => {
  const r = low.validate({ watertight: { reference: { surface, tolerance, spacing: SPACING } } });
  const uncovered = r.issues.filter((i) => i.severity === 'error' && (i.detail as { check?: string }).check === 'uncovered');
  return { coverage: r.watertight!.coverage!, uncovered };
};

// B22-1b: the low form covers its detail source to within the measured tolerance once the
// recessed openings (texture-only by design) are excluded. Measured on every group at 20-30 mm
// spacing: max 40.0 mm (shin bolt), interior p95 5-16 mm; head 16.7 mm, foot 37.3 mm.
describe('C-410 sci-fi mech: the low form covers the detail source', () => {
  it('covers head and foot within the tolerance, with p95 well inside it', { timeout: 240000 }, () => {
    for (const name of ['head', 'foot']) {
      const { coverage, uncovered } = cover(name);
      expect(uncovered).toEqual([]);
      expect(coverage.uncovered).toBe(0);
      expect(coverage.interior.max).toBeLessThanOrEqual(COVER_TOLERANCE);
      expect(coverage.interior.p95).toBeLessThan(0.017);
    }
  });

  it('falsifiers: vents left in the reference, a missing low plate, a 15 mm tolerance', { timeout: 240000 }, () => {
    const vents = cover('foot', buildGroup(group('foot'), HIGH));
    expect(vents.coverage.uncovered).toBeGreaterThan(0.01);

    const low = buildGroup(group('foot'), LOW);
    low.delete(sel.tag('plate').and(sel.facing('+y', 30)).connected('any'));
    expect(cover('foot', undefined, COVER_TOLERANCE, low).uncovered.length).toBeGreaterThan(0);

    expect(cover('head', undefined, 0.015).uncovered.length).toBeGreaterThan(0);
  });
});
