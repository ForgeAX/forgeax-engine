import { describe, expect, it } from 'vitest';
import {
  create,
  D65_WHITE_XY,
  displayP3ToLinear,
  LINEAR_DISPLAY_P3_TO_LINEAR_SRGB,
  LINEAR_SRGB_TO_LINEAR_DISPLAY_P3,
  linearDisplayP3ToLinearSrgb,
  linearSrgbToLinearDisplayP3,
  linearToSrgb,
  RGB_PRIMARIES,
  rgbToXyzMatrix,
} from '../color';

// Independent references: IEC 61966-2-1 sRGB->XYZ (4-decimal published form)
// and the Three.js r184 / CSS Color 4 linear-sRGB -> linear-Display-P3 matrix.
const IEC_SRGB_TO_XYZ = [0.4124, 0.3576, 0.1805, 0.2126, 0.7152, 0.0722, 0.0193, 0.1192, 0.9505];
const REFERENCE_SRGB_TO_P3 = [
  0.8224621, 0.177538, 0, 0.0331941, 0.9668058, 0, 0.0170827, 0.0723974, 0.9105199,
];
const REFERENCE_P3_TO_SRGB = [
  1.2249401, -0.2249404, 0, -0.0420569, 1.0420571, 0, -0.0196376, -0.0786361, 1.0982735,
];

describe('RGB gamut SSOT derived from primaries', () => {
  it('derives the IEC sRGB -> XYZ matrix from the Rec.709 primaries', () => {
    const m = rgbToXyzMatrix(RGB_PRIMARIES.srgb);
    m.forEach((v, i) => {
      expect(v).toBeCloseTo(IEC_SRGB_TO_XYZ[i] as number, 3);
    });
  });

  it('matches the reference linear sRGB <-> Display P3 matrices', () => {
    LINEAR_SRGB_TO_LINEAR_DISPLAY_P3.forEach((v, i) => {
      expect(Math.abs(v - (REFERENCE_SRGB_TO_P3[i] as number))).toBeLessThan(2e-6);
    });
    LINEAR_DISPLAY_P3_TO_LINEAR_SRGB.forEach((v, i) => {
      expect(Math.abs(v - (REFERENCE_P3_TO_SRGB[i] as number))).toBeLessThan(2e-6);
    });
  });

  it('preserves the D65 white point (rows sum to one; white maps to white)', () => {
    for (const m of [LINEAR_SRGB_TO_LINEAR_DISPLAY_P3, LINEAR_DISPLAY_P3_TO_LINEAR_SRGB]) {
      for (let row = 0; row < 3; row += 1) {
        expect(
          Math.abs(
            (m[row * 3] as number) + (m[row * 3 + 1] as number) + (m[row * 3 + 2] as number) - 1,
          ),
        ).toBeLessThan(1e-12);
      }
    }
    for (const primaries of Object.values(RGB_PRIMARIES)) {
      const m = rgbToXyzMatrix(primaries);
      const X = m[0] + m[1] + m[2];
      const Y = m[3] + m[4] + m[5];
      const Z = m[6] + m[7] + m[8];
      expect(Y).toBeCloseTo(1, 12);
      expect(X / (X + Y + Z)).toBeCloseTo(D65_WHITE_XY[0], 12);
      expect(Y / (X + Y + Z)).toBeCloseTo(D65_WHITE_XY[1], 12);
    }
  });

  it('round-trips linear colours through both directions', () => {
    const out = create();
    for (const rgb of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0.25, 0.5, 0.75],
      [2.5, -0.1, 0.3],
    ] as const) {
      linearSrgbToLinearDisplayP3(out, create(rgb[0], rgb[1], rgb[2], 0.5));
      linearDisplayP3ToLinearSrgb(out, out);
      expect(out[0]).toBeCloseTo(rgb[0], 6);
      expect(out[1]).toBeCloseTo(rgb[1], 6);
      expect(out[2]).toBeCloseTo(rgb[2], 6);
      expect(out[3]).toBeCloseTo(0.5, 6);
    }
  });

  it('decodes P3-authored colours to out-of-sRGB linear values that re-encode exactly', () => {
    const linear = displayP3ToLinear(create(), create(1, 0, 0, 1));
    expect(linear[0]).toBeGreaterThan(1);
    expect(linear[1]).toBeLessThan(0);
    expect(linear[2]).toBeLessThan(0);
    const p3 = linearToSrgb(create(), linearSrgbToLinearDisplayP3(create(), linear));
    expect(p3[0]).toBeCloseTo(1, 5);
    expect(Math.abs(p3[1] as number)).toBeLessThan(1e-5);
    expect(Math.abs(p3[2] as number)).toBeLessThan(1e-5);
  });

  it('keeps sRGB primaries inside the P3 gamut', () => {
    for (const rgb of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] as const) {
      const p3 = linearSrgbToLinearDisplayP3(create(), create(rgb[0], rgb[1], rgb[2], 1));
      for (let i = 0; i < 3; i += 1) {
        expect(p3[i]).toBeGreaterThanOrEqual(-1e-7);
        expect(p3[i]).toBeLessThanOrEqual(1 + 1e-7);
      }
    }
  });
});
