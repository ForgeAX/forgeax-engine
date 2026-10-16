import { expect, it } from 'vitest';
import {
  reflectionFormulaError,
  reflectionTexelCoordinate,
} from '../../apps/hello/ssr/scripts/inspect-ssr-tape.mjs';

it('accounts for the captured HDR attachment conversion without hiding wrong composition', () => {
  // Object fixture, work 36, pixel (518,850), green channel. The unrounded
  // error is 0.03096, larger than the old 0.005 arithmetic tolerance.
  const expected = 46.93720761354871;
  expect(reflectionFormulaError(expected, 46.90625)).toBe(0);
  expect(reflectionFormulaError(expected, 46.9375)).toBe(0);
  expect(reflectionFormulaError(expected, 46.875)).toBeGreaterThan(0.005);
  expect(reflectionFormulaError(expected, 46.96875)).toBeGreaterThan(0.005);
  expect(reflectionFormulaError(1, 1.02)).toBeGreaterThan(0.005);
  expect(reflectionFormulaError(-expected, -46.90625)).toBe(0);
  expect(reflectionFormulaError(2 ** -25, 0)).toBe(0);
  expect(reflectionFormulaError(2 ** -25, 2 ** -24)).toBe(0);
  expect(reflectionFormulaError(0, 0)).toBe(0);
  expect(() => reflectionFormulaError(Number.NaN, 0)).toThrow();
});

it('accounts for f32 reciprocal UV evaluation before the FP16 output conversion', () => {
  // Recorded work 34, pixel (390,638). The diagnostic compute invocation
  // returns this coordinate and sum from the same captured input textures.
  expect(reflectionTexelCoordinate(390, 768, 384, true)).toBe(195.00001525878906);
  expect(reflectionTexelCoordinate(390, 768, 384, false)).toBe(195);
  const reference = 15.148440708157434;
  const gpuSum = 15.148287773132324;
  expect(reflectionFormulaError(reference, 15.140625)).toBeGreaterThan(0.005);
  expect(reflectionFormulaError(reference, 15.140625, gpuSum)).toBe(0);
  // The next unsupported FP16 value and an actual wrong reflection stay red.
  expect(reflectionFormulaError(reference, 15.1328125, gpuSum)).toBeGreaterThan(0.005);
  expect(reflectionFormulaError(reference, 15.171875, gpuSum)).toBeGreaterThan(0.005);
});
