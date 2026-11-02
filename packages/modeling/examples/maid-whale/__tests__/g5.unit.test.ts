import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { buildLowpoly, FACET_EDGE, surfaceArea } from '../lowpoly.ts';

/** Facets per square meter measured on the sheet (calibrate thresholds 12 and 8). */
const SHEET_DENSITY = [766, 3717] as const;

/** C-200 G5: triangulated parts at the sheet's facet density. */
describe('C-200 G5 low-poly faceting', () => {
  const m = buildLowpoly();

  it('triangulates every face', () => {
    expect(m.poisoned).toBeUndefined();
    const sizes = sel
      .all()
      .evaluate(m.editMesh)
      .map((f) => m.editMesh.faceVertices(f).length);
    expect(Math.max(...sizes)).toBe(3);
  });

  it('keeps every reduced part inside the measured facet density range', () => {
    for (const tag of Object.keys(FACET_EDGE)) {
      const density = m.count(sel.tag(tag)) / surfaceArea(m, sel.tag(tag));
      expect(density, tag).toBeGreaterThanOrEqual(SHEET_DENSITY[0]);
      expect(density, tag).toBeLessThanOrEqual(SHEET_DENSITY[1]);
    }
  });
}, 120_000);
