// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=13):
//   - packages/math/src/__tests__/box3.test.ts
//   - packages/math/src/__tests__/color.test.ts
//   - packages/math/src/__tests__/euler.test.ts
//   - packages/math/src/__tests__/f32-to-f16-bytes.test.ts
//   - packages/math/src/__tests__/frustum.test.ts
//   - packages/math/src/__tests__/mat3.test.ts
//   - packages/math/src/__tests__/mat4.test.ts
//   - packages/math/src/__tests__/quat.test.ts
//   - packages/math/src/__tests__/ray.test.ts
//   - packages/math/src/__tests__/sphere.test.ts
//   - packages/math/src/__tests__/vec2.test.ts
//   - packages/math/src/__tests__/vec3.test.ts
//   - packages/math/src/__tests__/vec4.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
// import paths adjusted: ../X -> ../src/X (output is __tests__/, sources were src/__tests__/).

import { describe, expect, it } from 'vitest';
import * as box3 from '../src/box3';
import * as color from '../src/color';
import * as euler from '../src/euler';
import * as frustum from '../src/frustum';
import * as mat3 from '../src/mat3';
import * as mat4 from '../src/mat4';
import * as quat from '../src/quat';
import * as ray from '../src/ray';
import * as sphere from '../src/sphere';
import * as vec2 from '../src/vec2';
import * as vec3 from '../src/vec3';
import * as vec4 from '../src/vec4';
import { halfFloat } from '../src/index.js';
import type { EulerOrder, Mat3 as Mat3T, Mat4 as Mat4T, Vec3 as Vec3T } from '../src/types';
import {
  PERSPECTIVE_REVERSE_Z_FINITE_EXPECTED,
  PERSPECTIVE_REVERSE_Z_FINITE_INPUT,
  PERSPECTIVE_REVERSE_Z_INFINITE_EXPECTED,
  REVERSE_Z_FIXTURE_TOLERANCE,
  REVERSE_Z_PROJECTION_PROBES_FINITE,
  REVERSE_Z_PROJECTION_PROBES_INFINITE,
} from '../src/__tests__/_fixtures';

void [PERSPECTIVE_REVERSE_Z_FINITE_EXPECTED, PERSPECTIVE_REVERSE_Z_FINITE_INPUT, PERSPECTIVE_REVERSE_Z_INFINITE_EXPECTED, REVERSE_Z_FIXTURE_TOLERANCE, REVERSE_Z_PROJECTION_PROBES_FINITE, REVERSE_Z_PROJECTION_PROBES_INFINITE, box3, color, describe, euler, expect, frustum, halfFloat, it, mat3, mat4, quat, ray, sphere, vec2, vec3, vec4];
type __MergedKeep = EulerOrder | Mat3T | Mat4T | Vec3T;


{
  // --- from color.test.ts ---
// color.test.ts — color namespace unit tests (M5 / T-031 red → T-032 green)
//
// Three tiers: normal / boundary / degenerate.
//
// Implementation anchors (D-P7 / requirements §Surface color lower bound 6):
//   - create / clone: Float32Array length 4 RGBA brand
//   - srgbToLinear / linearToSrgb: IEC 61966-2-1 piecewise gamma (RGB channels only; alpha untouched)
//     - cutoff 0.04045 / 0.0031308; linear-segment slope 12.92; power-segment exponent 2.4
//     - negative values returned verbatim (preserves HDR semantics; same convention as bevy_color::gamma_function)
//   - fromHex: accepts `#RRGGBB` and `#RRGGBBAA`; RGB bytes decode to linear-sRGB
//     - illegal hex silently falls back to (0, 0, 0, 1); does not throw (D-P12 degenerate family / AC-06)
//   - toHex: emits `#RRGGBB` (when alpha=1) or `#RRGGBBAA` (when alpha<1); components clamped to [0,1]
//
// Related: requirements §AC-06 / §AC-07; plan-strategy D-P7 / D-P12 / §appendix A degenerate registry;
//          wiki/sources/2026-05-05-bevy-0-19-math-transform-color §sRGB piecewise gamma;
//          wiki/glam-rs-overview §LinearRgba.


describe('color.create', () => {
  it('returns Float32Array length 4 black/opaque by default (normal)', () => {
    const c = color.create();
    expect(c).toBeInstanceOf(Float32Array);
    expect(c.length).toBe(4);
    expect(c[0]).toBe(0);
    expect(c[1]).toBe(0);
    expect(c[2]).toBe(0);
    expect(c[3]).toBe(1);
  });

  it('accepts explicit RGBA components (boundary)', () => {
    const c = color.create(0.25, 0.5, 0.75, 0.5);
    expect(c[0]).toBe(0.25);
    expect(c[1]).toBe(0.5);
    expect(c[2]).toBe(0.75);
    expect(c[3]).toBe(0.5);
  });

  it('NaN preserved verbatim (degenerate)', () => {
    const c = color.create(Number.NaN, 0, 0, 1);
    expect(Number.isNaN(c[0])).toBe(true);
  });
});

describe('color.clone', () => {
  it('produces new Float32Array with identical values (normal)', () => {
    const a = color.create(0.1, 0.2, 0.3, 0.4);
    const b = color.clone(a);
    expect(b).not.toBe(a);
    expect(Array.from(b)).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
      Math.fround(0.4),
    ]);
  });
});

describe('color.srgbToLinear', () => {
  it('preserves 0 and 1 endpoints (boundary)', () => {
    const out = color.create();
    color.srgbToLinear(out, color.create(0, 0, 0, 1));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(1); // alpha untouched

    color.srgbToLinear(out, color.create(1, 1, 1, 1));
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBeCloseTo(1, 5);
    expect(out[2]).toBeCloseTo(1, 5);
  });

  it('linear segment for v ≤ 0.04045 (boundary)', () => {
    // v=0.04 → 0.04 / 12.92 ≈ 0.003095975
    const out = color.create();
    color.srgbToLinear(out, color.create(0.04, 0.04, 0.04, 1));
    expect(out[0]).toBeCloseTo(0.04 / 12.92, 6);
  });

  it('power segment for v > 0.04045 (normal)', () => {
    // v=0.5 → ((0.5 + 0.055) / 1.055)^2.4 ≈ 0.21404114
    const out = color.create();
    color.srgbToLinear(out, color.create(0.5, 0.5, 0.5, 1));
    expect(out[0]).toBeCloseTo(((0.5 + 0.055) / 1.055) ** 2.4, 5);
  });

  it('does not touch alpha channel (boundary)', () => {
    const out = color.create();
    color.srgbToLinear(out, color.create(0.5, 0.5, 0.5, 0.42));
    expect(out[3]).toBe(Math.fround(0.42));
  });

  it('NaN propagates (degenerate)', () => {
    const out = color.create();
    color.srgbToLinear(out, color.create(Number.NaN, 0, 0, 1));
    expect(Number.isNaN(out[0])).toBe(true);
  });

  it('negative values returned verbatim (degenerate, HDR-friendly)', () => {
    const out = color.create();
    color.srgbToLinear(out, color.create(-0.1, 0, 0, 1));
    expect(out[0]).toBe(Math.fround(-0.1));
  });
});

describe('color.linearToSrgb', () => {
  it('preserves 0 and 1 endpoints (boundary)', () => {
    const out = color.create();
    color.linearToSrgb(out, color.create(0, 0, 0, 1));
    expect(out[0]).toBe(0);
    color.linearToSrgb(out, color.create(1, 1, 1, 1));
    expect(out[0]).toBeCloseTo(1, 5);
  });

  it('roundtrip srgbToLinear ∘ linearToSrgb ≈ identity in mid-range (normal)', () => {
    const tmp = color.create();
    const back = color.create();
    const src = color.create(0.5, 0.3, 0.8, 0.7);
    color.srgbToLinear(tmp, src);
    color.linearToSrgb(back, tmp);
    expect(back[0]).toBeCloseTo(0.5, 4);
    expect(back[1]).toBeCloseTo(0.3, 4);
    expect(back[2]).toBeCloseTo(0.8, 4);
    expect(back[3]).toBeCloseTo(0.7, 5); // alpha unchanged
  });

  it('linear segment for v ≤ 0.0031308 (boundary)', () => {
    // v=0.003 → 0.003 * 12.92 ≈ 0.03876
    const out = color.create();
    color.linearToSrgb(out, color.create(0.003, 0.003, 0.003, 1));
    expect(out[0]).toBeCloseTo(0.003 * 12.92, 5);
  });
});

describe('color.fromHex', () => {
  it('parses #RRGGBB (normal)', () => {
    const out = color.create();
    color.fromHex(out, '#FF8040');
    expect(out[0]).toBeCloseTo(255 / 255, 5);
    expect(out[1]).toBeCloseTo(((128 / 255 + 0.055) / 1.055) ** 2.4, 5);
    expect(out[2]).toBeCloseTo(((64 / 255 + 0.055) / 1.055) ** 2.4, 5);
    expect(out[3]).toBe(1); // default alpha=1
  });

  it('parses #RRGGBBAA (boundary)', () => {
    const out = color.create();
    color.fromHex(out, '#FF80407F');
    expect(out[0]).toBeCloseTo(255 / 255, 5);
    expect(out[1]).toBeCloseTo(((128 / 255 + 0.055) / 1.055) ** 2.4, 5);
    expect(out[2]).toBeCloseTo(((64 / 255 + 0.055) / 1.055) ** 2.4, 5);
    expect(out[3]).toBeCloseTo(127 / 255, 5);
  });

  it('lower-case hex digits accepted (boundary)', () => {
    const out = color.create();
    color.fromHex(out, '#ff8040');
    expect(out[0]).toBeCloseTo(255 / 255, 5);
    expect(out[1]).toBeCloseTo(((128 / 255 + 0.055) / 1.055) ** 2.4, 5);
  });

  it('decodes the CSS-compatible #808080 midpoint to linear-sRGB', () => {
    const out = color.create();
    color.fromHex(out, '#808080');
    expect(out[0]).toBeCloseTo(0.2158605, 6);
    expect(out[1]).toBeCloseTo(0.2158605, 6);
    expect(out[2]).toBeCloseTo(0.2158605, 6);
  });

  it('rejects #RGB short form → silent (0,0,0,1) (degenerate, D-P7)', () => {
    const out = color.create(0.5, 0.5, 0.5, 0.5); // pre-poisoned
    color.fromHex(out, '#F84');
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(1);
  });

  it('rejects bad hex chars → silent (0,0,0,1) (degenerate)', () => {
    const out = color.create();
    color.fromHex(out, '#GGGGGG');
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(1);
  });

  it('rejects missing # prefix → silent (0,0,0,1) (degenerate)', () => {
    const out = color.create();
    color.fromHex(out, 'FF8040');
    expect(out[0]).toBe(0);
  });

  it('does not throw on null/undefined-like inputs (degenerate)', () => {
    const out = color.create();
    expect(() => color.fromHex(out, '')).not.toThrow();
    expect(out[3]).toBe(1);
  });
});

describe('color.toHex', () => {
  it('emits #RRGGBB when alpha=1 (normal)', () => {
    const c = color.create();
    color.srgbToLinear(c, color.create(1, 128 / 255, 64 / 255, 1));
    expect(color.toHex(c)).toBe('#ff8040');
  });

  it('emits #RRGGBBAA when alpha<1 (boundary)', () => {
    const c = color.create();
    color.srgbToLinear(c, color.create(1, 128 / 255, 64 / 255, 127 / 255));
    expect(color.toHex(c)).toBe('#ff80407f');
  });

  it('clamps out-of-range to [0, 255] (degenerate)', () => {
    const c = color.create(2, -1, 0.5, 1);
    expect(color.toHex(c)).toBe('#ff00bc');
  });
});

describe('color.fromCss', () => {
  it('accepts full/short hex and named CSS colors at the deterministic boundary', () => {
    const named = color.create();
    const fullHex = color.create();
    const shortHex = color.create();
    const rgb = color.create();
    color.fromCss(named, 'red');
    color.fromCss(fullHex, '#808080');
    color.fromCss(shortHex, '#f84');
    color.fromCss(rgb, 'rgb(255 0 0 / 50%)');
    expect(Array.from(named)).toEqual([1, 0, 0, 1]);
    expect(Array.from(fullHex)).toEqual([
      Math.fround(0.21586050011389926),
      Math.fround(0.21586050011389926),
      Math.fround(0.21586050011389926),
      1,
    ]);
    expect(shortHex[0]).toBeCloseTo(1, 6);
    expect(shortHex[1]).toBeCloseTo(((136 / 255 + 0.055) / 1.055) ** 2.4, 6);
    expect(shortHex[2]).toBeCloseTo(((68 / 255 + 0.055) / 1.055) ** 2.4, 6);
    expect(shortHex[3]).toBe(1);
    expect(Array.from(rgb)).toEqual([1, 0, 0, 0.5]);
  });

  it('accepts comma-separated rgb/hsl and unit-bearing hue', () => {
    const rgb = color.create();
    const hsl = color.create();
    color.fromCss(rgb, 'rgba(255 0 0/50%)');
    color.fromCss(hsl, 'hsla(0.5turn, 100%, 50%, 25%)');
    expect(Array.from(rgb)).toEqual([1, 0, 0, 0.5]);
    expect(Array.from(hsl)).toEqual([0, 1, 1, 0.25]);
  });

  it('keeps malformed CSS and trailing numeric garbage on the black fallback', () => {
    const hsl = color.create();
    const invalid = color.create(1, 1, 1, 0);
    color.fromCss(hsl, 'hsl(120 100% 50%)');
    color.fromCss(invalid, 'not-a-color');
    expect(Array.from(hsl)).toEqual([0, 1, 0, 1]);
    expect(Array.from(invalid)).toEqual([0, 0, 0, 1]);

    for (const source of [
      '#12',
      '#12345',
      'rgb(255oops 0 0)',
      'rgb(255 0 0 0.5)',
      'rgb(255 0 0 / 0.5 / 0.25)',
      'hsl(120 100% 50% trailing)',
      'currentColor',
    ]) {
      const out = color.create(1, 1, 1, 0);
      color.fromCss(out, source);
      expect(Array.from(out), source).toEqual([0, 0, 0, 1]);
    }
  });
});

}
