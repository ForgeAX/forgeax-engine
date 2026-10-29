import { describe, expect, it } from 'vitest';
import { projectedHeightForCandidate } from '../gpu-driven/batch-topology';
import { selectLod } from '../scene/visibility/lod-selector';
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
      const level = (projectedHeight: number) =>
        selectLod({
          levels: [{ screenCoverage: 0.3 }, { screenCoverage: 0.08 }],
          projectedHeight,
          previousLevel: 0,
          hysteresis: 0.08,
          ready: [true, true, true],
          historyValid: false,
        }).level;
      expect(level(baseline)).toBe(0);
      expect(level(shifted)).toBe(0);
    }
  });
});
