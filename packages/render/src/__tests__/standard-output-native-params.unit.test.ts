import { expect, it } from 'vitest';
import { applyStandardWhiteBalance } from '../pipeline/standard-output/color-transform';
import { createStandardOutputV2ParameterWriter } from '../pipeline/standard-output/native-params';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';

const policy = { bloomIntensity: 0, sharpen: 0.3, finishInGrade: false };

function input() {
  const camera = makeZeroCameraFallbackSnapshot();
  return {
    ...camera,
    exposure: 0.75,
    whitePoint: 3,
    tonemap: 'aces-filmic' as typeof camera.tonemap,
    temporal: { sampleTimeSeconds: 12.5 },
  };
}

it('packs native camera values without a legacy uniform conversion or camera mutation', () => {
  const write = createStandardOutputV2ParameterWriter(policy),
    args = input(),
    before = { ...args };
  const bytes = write(args, 1, 0.8, true),
    floats = new Float32Array(bytes.buffer),
    words = new Uint32Array(bytes.buffer);
  expect(bytes.byteLength).toBe(160);
  expect(Array.from(floats.slice(0, 16))).toEqual([
    1, 0.75, 3, 4, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
  ]);
  expect(Array.from(words.slice(36))).toEqual([1, 0, 1, 0]);
  expect(floats[34]).toBeCloseTo(0.3);
  expect(floats[35]).toBe(12.5);
  expect(args).toEqual(before);
  const saved = bytes.slice();
  expect(write(args, 1, 0.8, true)).toBe(bytes);
  expect(bytes).toEqual(saved);
  const other = createStandardOutputV2ParameterWriter(policy)(args, 1, 0.8, true);
  expect(other.buffer).not.toBe(bytes.buffer);
});

it('projects continuous white balance as the existing linear transform without source variants', () => {
  const write = createStandardOutputV2ParameterWriter(policy),
    args = input();
  const color = [0.18, 0.07, 0.31] as const;
  for (const [temperature, tint] of [
    [4200, 0.1],
    [9000, -0.2],
    [6504, 0],
  ]) {
    if (temperature === undefined || tint === undefined)
      throw Error('Missing fixture white balance');
    const bytes = write({ ...args, output: { temperature, tint } }, 1, 0.8, true);
    const rows = new Float32Array(bytes.buffer),
      expected = applyStandardWhiteBalance(color, temperature, tint);
    for (let row = 0; row < 3; row++) {
      const value = color.reduce(
        (sum, component, column) => sum + component * (rows[4 + row * 4 + column] ?? 0),
        0,
      );
      expect(value).toBeCloseTo(expected[row] ?? NaN, 6);
    }
  }
});

it('observes changed native camera values and the negotiated output gamut', () => {
  const write = createStandardOutputV2ParameterWriter(policy),
    args = input(),
    camera = { ...args },
    bytes = write(camera, 1, 0.8, true);
  camera.exposure = 1.25;
  camera.whitePoint = 2;
  camera.tonemap = 'linear';
  expect(write(camera, 0, 0.8, true)).toBe(bytes);
  expect(Array.from(new Float32Array(bytes.buffer).slice(0, 4))).toEqual([1, 1.25, 2, 2]);
  expect(new Uint32Array(bytes.buffer)[36]).toBe(0);
});

it('retains the last upload scratch when native camera admission fails', () => {
  const write = createStandardOutputV2ParameterWriter(policy),
    args = input(),
    bytes = write(args, 1, 0.8, true),
    before = bytes.slice();
  const camera = { ...args };
  Reflect.set(camera, 'tonemap', 'invalid');
  expect(() =>
    write({ ...camera, output: { temperature: 4200, tint: 0.2 } }, 1, 0.8, true),
  ).toThrow(/camera-tonemap-invalid/);
  expect(bytes).toEqual(before);
  expect(write(args, 1, 0.8, true)).toEqual(before);
});

it('observes continuous lens controls on a reused snapshot and restores neutral fringe', () => {
  const write = createStandardOutputV2ParameterWriter(policy),
    args = input();
  const lens = {
    vignetteIntensity: 0.4,
    vignetteRadius: 0.2,
    vignetteSoftness: 0.7,
    vignetteColor: [0.1, 0.2, 0.3],
    chromaticAberration: 0.4,
    chromaticAberrationStartOffset: 0.25,
    grainIntensity: 0.02,
    grainSize: 2,
  };
  const bytes = write({ ...args, lensEffects: lens }, 1, 0.8, true),
    values = new Float32Array(bytes.buffer);
  const offset = 0.004 / 0.75;
  expect(values[16]).toBeCloseTo(offset * 0.007 * (611.3 - 464.3), 7);
  expect(values[17]).toBeCloseTo(offset * 0.007 * (549.1 - 464.3), 7);
  expect(values[32]).toBeCloseTo(0.02);
  expect(values[33]).toBe(2);
  lens.chromaticAberration = 0;
  expect(write({ ...args, lensEffects: lens }, 1, 0.8, true)).toBe(bytes);
  expect(values[16]).toBe(0);
  expect(values[17]).toBe(0);
  expect(values[24]).toBeCloseTo(0.4);
});

it('applies fringe and lens finish with a preweighted glare contribution in linear Grade', () => {
  const base = input(),
    lens = {
      vignetteIntensity: 0.3,
      vignetteRadius: 0.5,
      vignetteSoftness: 0.5,
      vignetteColor: [0, 0, 0] as const,
      grainIntensity: 0.02,
      grainSize: 1,
      chromaticAberration: 0.1,
      chromaticAberrationStartOffset: 0.35,
    };
  const write = createStandardOutputV2ParameterWriter({
    ...policy,
    linearGrade: true,
    bloomIntensity: 1,
  });
  const bytes = write({ ...base, lensEffects: lens }, 1, 0.8, true);
  const values = new Float32Array(bytes.buffer);
  expect(new Uint32Array(bytes.buffer)[37]).toBe(1);
  expect(values[16]).toBeGreaterThan(0);
  expect(values[17]).toBeGreaterThan(0);
  expect(values[20]).toBe(1);
  expect(values[24]).toBeCloseTo(0.3);
  expect(values[32]).toBeCloseTo(0.02);
});
