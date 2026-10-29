import { describe, expect, it } from 'vitest';
import { buildGpuLodRows, selectGpuLod } from '../scene/visibility/gpu-lod';

describe('GPU LOD readiness projection', () => {
  it('keeps the root ready fallback when a selected lower level is not resident', () => {
    const rows = buildGpuLodRows({
      generation: 11,
      hysteresis: 0,
      ranges: [
        { firstIndex: 0, indexCount: 36, baseVertex: 0 },
        { firstIndex: 36, indexCount: 18, baseVertex: 0 },
        { firstIndex: 54, indexCount: 6, baseVertex: 0 },
      ],
      coverages: [1, 0.5, 0.2],
      ready: [true, false, false],
    });

    expect(
      selectGpuLod(rows, { projectedHeight: 0.1, previousLevel: 0, historyValid: false }),
    ).toEqual({
      level: 0,
      confidence: 1,
    });
    expect(
      selectGpuLod(rows, { projectedHeight: 0.6, previousLevel: 0, historyValid: false }),
    ).toEqual({
      level: 0,
      confidence: 1,
    });
  });

  it('uses absolute coverage with hysteresis, not cross-level distances', () => {
    const rows = buildGpuLodRows({
      generation: 12,
      hysteresis: 0.1,
      ranges: [
        { firstIndex: 0, indexCount: 36, baseVertex: 0 },
        { firstIndex: 36, indexCount: 18, baseVertex: 0 },
        { firstIndex: 54, indexCount: 6, baseVertex: 0 },
      ],
      coverages: [1, 0.5, 0.2],
      ready: [true, true, true],
    });

    expect(
      selectGpuLod(rows, { projectedHeight: 0.49, previousLevel: 1, historyValid: true }).level,
    ).toBe(1);
    expect(
      selectGpuLod(rows, { projectedHeight: 0.1, previousLevel: 1, historyValid: true }).level,
    ).toBe(2);
  });
});
