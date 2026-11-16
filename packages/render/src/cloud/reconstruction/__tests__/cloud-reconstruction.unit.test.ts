import { expect, it } from 'vitest';
import {
  bilateralCloudUpsample,
  composeCloudTransport,
  selectCloudDepthTransport,
} from '../composition';
import { type CloudReconstructionInput, selectCloudReconstructionSample } from '../reconstruction';

const current = {
  far: [1, 2, 3, 0.8],
  near: [0.2, 0.3, 0.4, 0.9],
  depthMeters: [5000, 10000, 10000, 10000],
} as const;
const history = { ...current, far: [4, 6, 8, 0.7], near: [1, 1, 1, 0.9] } as const;
const input: CloudReconstructionInput = {
  current,
  history,
  historyUv: [0.5, 0.5],
  pixel: [1, 0],
  pixelOffset: [0, 0],
  currentExposure: 2,
  historyExposure: 1,
  minimumReprojectionDistanceMeters: 1000,
  disableDisocclusionDistanceMeters: 100000,
};

it('rescales history RGB without changing T or meter depth', () => {
  const result = selectCloudReconstructionSample(input);
  expect(result.reason).toBe('history');
  expect(result.sample.far).toEqual([8, 12, 16, 0.7]);
  expect(result.sample.depthMeters).toEqual(history.depthMeters);
});

it('uses the current sample at the traced phase and rejects outside reprojection', () => {
  expect(selectCloudReconstructionSample({ ...input, pixel: [0, 0] })).toEqual({
    sample: current,
    reason: 'phase',
  });
  expect(selectCloudReconstructionSample({ ...input, historyUv: [0, 0.5] }).reason).toBe('outside');
});

it('rejects disocclusion and min-depth discontinuities in meters', () => {
  expect(
    selectCloudReconstructionSample({
      ...input,
      history: { ...history, depthMeters: [5000, 13000, 10000, 10000] },
    }).reason,
  ).toBe('depth');
  expect(
    selectCloudReconstructionSample({
      ...input,
      history: { ...history, depthMeters: [5000, 10000, 8000, 10000] },
    }).reason,
  ).toBe('depth');
  expect(
    selectCloudReconstructionSample({
      ...input,
      current: { ...current, depthMeters: [5000, 100, 100, 10000] },
    }).reason,
  ).toBe('depth');
});

it('selects the near transport at foreground depth and far at background depth', () => {
  const sample = { ...current, depthMeters: [5, 10000, 10, 10000] } as const;
  expect(selectCloudDepthTransport(sample, 10)).toBe(current.near);
  expect(selectCloudDepthTransport(sample, 10000)).toBe(current.far);
  expect(bilateralCloudUpsample([sample], 10, [1])).toEqual(current.near);
});

it('retains near cloud in front of a surface even when the far representative lies behind it', () => {
  const crossing = {
    far: [1, 1, 1, 0.5],
    near: [0.25, 0.25, 0.25, 0.9],
    depthMeters: [80, 100, 50, 100],
  } as const;
  expect(bilateralCloudUpsample([crossing], 50, [1])).toEqual(crossing.near);
  expect(bilateralCloudUpsample([crossing], 10, [1])).toEqual([0, 0, 0, 1]);
});

it('composes already fogged cloud exactly once and preserves the no-cloud background', () => {
  expect(composeCloudTransport([2, 4, 6], [0, 0, 0, 1])).toEqual([2, 4, 6]);
  expect(composeCloudTransport([2, 4, 6], [1.5, 2, 2.5, 0.5])).toEqual([2.5, 4, 5.5]);
});

it('rejects cloud behind every candidate and uses bilinear far only on smooth depth', () => {
  expect(bilateralCloudUpsample([current], 10, [1])).toEqual([0, 0, 0, 1]);
  const result = bilateralCloudUpsample([current, history], 10000, [0.25, 0.75]);
  for (const [i, expected] of [3.25, 5, 6.75, 0.725].entries())
    expect(result[i]).toBeCloseTo(expected, 12);
});
