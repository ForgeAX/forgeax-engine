import { expect, it } from 'vitest';
import { temporalSupport } from './screen-probe-temporal-support.fixture';

it('accumulates only same-kind geometry-qualified estimator history with bounded current weight', () => {
  const result = temporalSupport();
  expect(result.meta.slice(2)).toEqual([4, 2]);
  expect(result.value.slice(0, 3)).toEqual([3.5, 7, 10.5]);
  expect(result.confidence).toBe(0.5);
});

it('retains current-only forensic behavior and rejects a malformed current estimate', () => {
  const currentOnly = temporalSupport({ flags: 24 });
  expect(currentOnly.value).toEqual([2, 4, 6, 2.5]);
  expect(currentOnly.meta).toEqual([0, 0, 0, 0]);
  const currentOnlyMissing = temporalSupport({ flags: 24, current: [0, 0, 0, 0] });
  expect(currentOnlyMissing.value).toEqual([0, 0, 0, 0]);
  expect(currentOnlyMissing.meta).toEqual([0, 0, 0, 0]);
  for (const current of [
    [0, 0, 0, -1],
    [NaN, 1, 1, 2.5],
    [-1, 1, 1, 2.5],
  ] as const) {
    const result = temporalSupport({ current });
    expect(result.value).toEqual([0, 0, 0, 0]);
    expect(result.meta).toEqual([0, 0, 0, 0]);
  }
});

it('gives a missing current sample less weight only when the receiver has valid history', () => {
  const missing = [0, 0, 0, 0] as const;
  const retained = temporalSupport({ current: missing, previous: [4, 8, 12, 2.5] });
  expect(retained.value[0]).toBeCloseTo(4 * (1 - 1 / 13), 6);
  expect(retained.confidence).toBe(0.5);
  expect(retained.meta.slice(2)).toEqual([4, 2]);
  for (const rejected of [
    { depth: 0 },
    { normalMatches: false },
    { storedDistance: 1.03 },
    { historyUv: [-0.1, 0.5] as const },
    { kind: 1 },
    { frames: 0 },
  ]) {
    const result = temporalSupport({ ...rejected, current: missing });
    expect(result.value).toEqual(missing);
    expect(result.meta).toEqual(missing);
  }
});

it('rejects old strict history, invalid estimates, disocclusion, and depth or normal disagreement', () => {
  for (const control of [
    { kind: 1 },
    { previous: [4, 8, 12, 1] as const },
    { storedDistance: 1.03 },
    { storedDistance: NaN },
    { normalMatches: false },
    { historyUv: [-0.1, 0.5] as const },
  ]) {
    const result = temporalSupport(control);
    expect(result.value).toEqual([2, 4, 6, 2.5]);
    expect(result.meta.slice(2)).toEqual([1, 2]);
  }
});

it('weights history by confidence and never lets the accumulation cap remove the current contribution', () => {
  const result = temporalSupport({ current: [2, 4, 6, 2.9], previous: [4, 8, 12, 2.1], frames: 9 });
  expect(result.meta.slice(2)).toEqual([10, 2]);
  expect(result.value[0]).toBeCloseTo(3, 6);
  expect(result.confidence).toBeCloseTo(0.9, 6);
  const lowCurrent = temporalSupport({ current: [0, 0, 0, 2.01], frames: 63, maxFrames: 8 });
  expect(lowCurrent.meta.slice(2)).toEqual([8, 2]);
  expect(lowCurrent.value[0]).toBeCloseTo(3.5, 6);
});

it('keeps the strict path in its own metadata domain and refuses an estimator as strict history', () => {
  const result = temporalSupport({
    flags: 2,
    current: [2, 4, 6, 1],
    previous: [4, 8, 12, 2.5],
    kind: 2,
  });
  expect(result.value).toEqual([2, 4, 6, 1]);
  expect(result.meta.slice(2)).toEqual([1, 1]);
});
it('keeps a lighting step responsive after reaching the cap and fades during consecutive misses', () => {
  let previous: readonly [number, number, number, number] = [0, 0, 0, 3];
  for (let frame = 0; frame < 8; frame++) {
    const result = temporalSupport({ current: [1, 1, 1, 3], previous, frames: 8, maxFrames: 8 });
    expect(result.meta.slice(2)).toEqual([8, 2]);
    previous = result.value;
  }
  expect(previous[0]).toBeCloseTo(1 - (7 / 8) ** 8, 6);
  const missed = temporalSupport({ current: [0, 0, 0, 0], previous, frames: 8, maxFrames: 8 });
  expect(missed.value[0]).toBeCloseTo(previous[0] * (1 - 1 / 29), 6);
  const missedAgain = temporalSupport({
    current: [0, 0, 0, 0],
    previous: missed.value,
    frames: 8,
    maxFrames: 8,
  });
  expect(missedAgain.value[0]).toBeCloseTo(missed.value[0] * (1 - 1 / 29), 6);
});

it('rejects invalid current geometry before any history read or current-only publication', () => {
  for (const flags of [24, 26])
    for (const geometry of [
      { validReceiver: false },
      { depth: 0 },
      { depth: NaN },
      { depth: Infinity },
      { position: [NaN, 0, 0] as const },
      { position: [0, Infinity, 0] as const },
      { normal: [0, NaN, 1] as const },
      { normal: [0, 0, 0] as const },
    ]) {
      const result = temporalSupport({ ...geometry, flags });
      expect(result.value).toEqual([0, 0, 0, 0]);
      expect(result.meta).toEqual([0, 0, 0, 0]);
    }
});

it('never raises this frame confidence from an older more complete estimate', () => {
  const current: readonly [number, number, number, number] = [0, 0, 0, 2.01];
  const result = temporalSupport({ current, previous: [10, 10, 10, 3], frames: 9 });
  expect(result.value[0]).toBeGreaterThan(0);
  expect(result.value[3]).toBe(current[3]);
  expect(result.value[3]).not.toBe(1);
  expect(result.meta[3]).toBe(2);
});
