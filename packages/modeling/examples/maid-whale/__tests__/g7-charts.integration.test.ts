import { describe, expect, it } from 'vitest';
import { buildG7 } from '../g7-face-job.ts';
import { DECAL_RECTS, decalChartCheck, decalFootprints, exportWithFaces } from '../g7-measure.ts';

/**
 * C-200 G7 decal charts on the real figure: the face and apron-front slots project to one
 * seamless uv1 chart each, with no fold or overlap, and cover every decal footprint. The chin
 * and jaw underside curl back under the face, so a face slot that admits them folds.
 */
describe('C-200 G7 decal charts', () => {
  it('keeps the face and apron charts seamless, fold-free and covering', { timeout: 900000 }, () => {
    const { m } = buildG7();
    const exported = exportWithFaces(m, { normals: { mode: 'flat' } });
    const footprints = decalFootprints();
    for (const slot of ['face', 'apron-front'] as const) {
      const r = decalChartCheck(exported, slot, DECAL_RECTS[slot], footprints[slot]);
      expect({ slot, components: r.components, seams: r.seamVertices, folds: r.folds, overlap: r.overlapCells }).toEqual({ slot, components: 1, seams: 0, folds: 0, overlap: 0 });
      expect(r.layers.filter((l) => l.samples === 0 || l.uncovered > 0).map((l) => l.name), slot).toEqual([]);
    }
  });
});
