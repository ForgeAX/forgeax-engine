import { describe, expect, it } from 'vitest';
import { projectedHeightForCandidate } from '../gpu-driven/batch-topology';
import { selectedLodLevel } from '../gpu-driven/production-raster-lod';
import { equivalentOriginProjectionCases } from './lod-projection-harness';

describe('ordinary mesh LOD origin invariance', () => {
  it('keeps coverage and selected LOD for equal world bounds after local translation, rotation and scale', () => {
    for (const pair of equivalentOriginProjectionCases()) {
      const height = (item: typeof pair.baseline) =>
        projectedHeightForCandidate(
          {
            snapshot: { localAabb: item.aabb, transform: { world: item.world } },
          } as Parameters<typeof projectedHeightForCandidate>[0],
          item.camera,
        );
      const baseline = height(pair.baseline);
      const shifted = height(pair.shifted);
      expect(baseline).toBeGreaterThan(0.3);
      expect(shifted).toBeCloseTo(baseline, 6);
      const lod = {
        coverages: [1, 0.3, 0.08],
        ranges: [
          { first: 0, count: 36, baseVertex: 0 },
          { first: 36, count: 36, baseVertex: 0 },
        ],
        hysteresis: 0.08,
      };
      expect(selectedLodLevel(lod, baseline)).toBe(0);
      expect(selectedLodLevel(lod, shifted)).toBe(0);
    }
  });
});
