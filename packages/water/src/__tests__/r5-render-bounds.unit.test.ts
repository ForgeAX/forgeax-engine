import { describe, expect, it } from 'vitest';
import { waterBodyRenderBounds } from '../body-geometry.js';
import type { WaterBodyAsset } from '../contracts.js';
import { validateWaterAsset } from '../validate.js';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const affine = [1, 0.5, 0, 0, 0, 2, 0, 0, 0, -0.25, 1, 0, 0, 10, 0, 1];
const mesh = [0, 1, 0, 4, 2, 4, 0, 2, 4];
const body = (type: WaterBodyAsset['type']): WaterBodyAsset => ({
  kind: 'water-body',
  type,
  baseHeightM: 1,
  maxWaveHeightM: 3.25,
  overlapPriority: 0,
  ...(type === 'lake' || type === 'river' ? { maxWaveHeightOffsetM: 0.75 } : {}),
  channelDepthM: 4,
  oceanExtentM: [20, 40],
  oceanCenterM: [2, 3],
  surfaceMaterialGuid: '00000000-0000-7000-8000-000000000001',
  flags: { affectsWaterInfo: false, affectsWaterMesh: true, affectsLandscape: false },
  collision: { type: 'none', enabled: false },
  queryFootprint: [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ],
  spline: {
    closed: true,
    points: [
      [0, 1, 0],
      [4, 2, 0],
      [4, 2, 4],
      [0, 1, 4],
    ].map((positionM, inputKey) => ({
      inputKey,
      positionM: positionM as [number, number, number],
      arriveTangentM: [0, 0, 0],
      leaveTangentM: [0, 0, 0],
      up: [0, 1, 0],
      rollAngle: 0,
      angleUnit: 'degrees',
      widthM: 1,
      depthM: 1.5,
      velocityMPerSec: 0,
      audioIntensity: 0,
    })),
  },
});
const close = (actual: readonly number[] | undefined, expected: readonly number[]) => {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    expect(actual?.[index]).toBeCloseTo(value, 8);
  });
};

describe('UE component, raster and capture height authorities', () => {
  it('keeps the Lake channel and component offset separate from its one total wave envelope', () => {
    const bounds = requiredFixtureValue(waterBodyRenderBounds(body('lake'), identity));
    close(bounds.componentYM, [-3, 2.75]);
    close(bounds.rasterYM, [-3, 6]);
    close(bounds.captureYM, [-6.26, 6.01]);
    const moved = requiredFixtureValue(waterBodyRenderBounds(body('lake'), affine));
    close(moved.componentYM, [3, 17.5]);
    close(moved.rasterYM, [3, 20.75]);
    close(moved.captureYM, [-0.26, 20.76]);
  });

  it('uses static River mesh bounds for capture but per-vertex height plus waves for raster', () => {
    const bounds = requiredFixtureValue(waterBodyRenderBounds(body('river'), affine, [mesh]));
    close(bounds.componentYM, [3, 17.5]);
    close(bounds.rasterYM, [7.75, 19.25]);
    close(bounds.captureYM, [-0.26, 20.76]);
  });

  it('keeps Ocean channel half-height and Custom static mesh bounds in their own branches', () => {
    const scaled = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 7, 10, -8, 1];
    const ocean = requiredFixtureValue(
      waterBodyRenderBounds({ ...body('ocean'), heightOffsetM: 0.75 }, scaled),
    );
    close(ocean.componentYM, [1, 25]);
    close(ocean.rasterYM, [1, 28.25]);
    close(ocean.captureYM, [-2.26, 28.26]);
    const custom = requiredFixtureValue(waterBodyRenderBounds(body('custom'), affine, [mesh]));
    close(custom.componentYM, [11, 16]);
    close(custom.rasterYM, [11, 19.25]);
    close(custom.captureYM, [7.74, 19.26]);
  });

  it('admits existing omitted zero defaults and rejects an offset outside the total envelope', () => {
    const {
      maxWaveHeightOffsetM: _offset,
      channelDepthM: _depth,
      oceanCenterM: _center,
      oceanExtentM: _extent,
      ...legacy
    } = body('lake');
    expect(validateWaterAsset(legacy).ok).toBe(true);
    close(waterBodyRenderBounds(legacy, identity)?.componentYM, [1, 2]);
    expect(validateWaterAsset({ ...legacy, maxWaveHeightOffsetM: 4 }).ok).toBe(false);
    expect(validateWaterAsset({ ...legacy, channelDepthM: -1 }).ok).toBe(false);
    expect(validateWaterAsset({ ...legacy, type: 'custom', maxWaveHeightOffsetM: 0.75 }).ok).toBe(
      false,
    );
  });
});
