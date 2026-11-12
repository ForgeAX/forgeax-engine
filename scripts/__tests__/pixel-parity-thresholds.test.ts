import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { inferPreEvalStage, readParityThresholds } from '../bench/pixel-parity.mjs';

const fixture = resolve(import.meta.dirname, '../../apps/parity/urp-vs-hdrp');

test('capture-hook startup timeout is a readback failure after Chromium launched', () => {
  expect(inferPreEvalStage('page.waitForFunction: Timeout 30000ms exceeded.')).toBe(
    'pixel-readback',
  );
  expect(inferPreEvalStage('pixel-readback: page.evaluate: Target page has been closed')).toBe(
    'pixel-readback',
  );
  expect(
    inferPreEvalStage('browserType.launch: Target page, context or browser has been closed'),
  ).toBe('chromium-launch');
});

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
