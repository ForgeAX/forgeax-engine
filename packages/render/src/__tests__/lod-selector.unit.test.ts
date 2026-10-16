import { describe, expect, it } from 'vitest';
import {
  type LodSelectorInput,
  projectedHeight,
  selectLod,
} from '../scene/visibility/lod-selector';

const levels = [{ screenCoverage: 0.5 }, { screenCoverage: 0.2 }, { screenCoverage: 0.08 }];

const input = (overrides: Partial<LodSelectorInput> = {}): LodSelectorInput => ({
  levels,
  projectedHeight: 0.3,
  previousLevel: 0,
  hysteresis: 0.1,
  ready: [true, true, true, true],
  historyValid: true,
  ...overrides,
});

describe('LOD projected-height selector', () => {
  it('uses perspective depth and scale without allocating a camera-specific state table', () => {
    expect(
      projectedHeight({ radius: 1, depth: 10, projection: 'perspective', fov: Math.PI / 2 }),
    ).toBeCloseTo(0.2);
    expect(
      projectedHeight({ radius: 1, depth: 10, projection: 'orthographic', orthoHeight: 10 }),
    ).toBeCloseTo(0.2);
  });

  it('selects across multiple levels from absolute coverage in one frame', () => {
    expect(selectLod(input({ projectedHeight: 0.6 })).level).toBe(0);
    expect(selectLod(input({ projectedHeight: 0.3 })).level).toBe(1);
    expect(selectLod(input({ projectedHeight: 0.05 })).level).toBe(3);
  });

  it('drops history on a new view epoch and selects from current coverage', () => {
    expect(
      selectLod(input({ projectedHeight: 0.05, previousLevel: 0, historyValid: false })).level,
    ).toBe(3);
  });

  it('uses hysteresis at a boundary and still permits a multi-level jump', () => {
    expect(selectLod(input({ projectedHeight: 0.46, previousLevel: 0 })).level).toBe(0);
    expect(selectLod(input({ projectedHeight: 0.39, previousLevel: 0 })).level).toBe(1);
    expect(selectLod(input({ projectedHeight: 0.05, previousLevel: 0 })).level).toBe(3);
  });

  it('uses the adjacent threshold when a prior level crosses multiple boundaries', () => {
    expect(selectLod(input({ projectedHeight: 0.19, previousLevel: 1 })).level).toBe(1);
    expect(selectLod(input({ projectedHeight: 0.17, previousLevel: 1 })).level).toBe(2);
    expect(selectLod(input({ projectedHeight: 0.21, previousLevel: 2 })).level).toBe(2);
    expect(selectLod(input({ projectedHeight: 0.23, previousLevel: 2 })).level).toBe(1);
  });

  it('falls back toward LOD0 when the selected detail is not resident', () => {
    expect(
      selectLod(input({ projectedHeight: 0.05, ready: [true, false, false, false] })).level,
    ).toBe(0);
    expect(
      selectLod(input({ projectedHeight: 0.05, ready: [true, false, false, true] })).level,
    ).toBe(3);
  });

  it('returns LOD0 for invalid projection inputs', () => {
    expect(selectLod(input({ projectedHeight: Number.NaN })).level).toBe(0);
    expect(selectLod(input({ projectedHeight: -1 })).level).toBe(0);
  });
});
