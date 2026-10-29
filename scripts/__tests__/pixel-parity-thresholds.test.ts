import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { readParityThresholds } from '../bench/pixel-parity.mjs';

const fixture = resolve(import.meta.dirname, '../../apps/parity/urp-vs-hdrp');

test('Standard captures use the authored zero-pixel-difference limit before aggregation', () => {
  expect(readParityThresholds(fixture, {})).toEqual({ threshold: 0, perPixelThreshold: 0.001 });
});

test('diagnostic overrides leave the fixture declaration unchanged', () => {
  expect(
    readParityThresholds(fixture, {
      PIXEL_PARITY_THRESHOLD: '2',
      PIXEL_PARITY_PER_PIXEL_THRESHOLD: '0.002',
    }),
  ).toEqual({ threshold: 2, perPixelThreshold: 0.002 });
  expect(readParityThresholds(fixture, {})).toEqual({ threshold: 0, perPixelThreshold: 0.001 });
});
