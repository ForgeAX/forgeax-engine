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
  // --- from f32-to-f16-bytes.test.ts ---
// f32ToF16Bytes unit test — TDD red phase (M1 w1).
//
// The function converts a packed float32 RGBA byte buffer (Uint8Array view over
// Float32 interleaved RGBA pixels) into the equivalent float16 RGBA byte buffer
// (IEEE 754 binary16, little-endian, half the byte length). See plan-strategy
// D-3 for extraction rationale and plan-tasks w2 for the implementation.
//
// Test coverage: normal f32 values / inf / NaN / subnormal / saturation >65504
// / zero / odd-length truncation.
//
// Related: plan-strategy §5.3 key test points; research Finding 5 (pure arithmetic).

// After w2 delivers the implementation to the barrel, this import will resolve.

describe('f32ToF16Bytes', () => {
  // --- Normal f32 values ---

  it('converts 1.0 to f16 and back (normal)', () => {
    const f32 = new Float32Array([1.0]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    // 4 bytes f32 -> 2 bytes f16
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    const half = view.getUint16(0, true);
    // 1.0 in binary16: sign=0, exp=15 (01111), mant=0 -> 0x3c00
    expect(half).toBe(0x3c00);
  });

  it('converts 0.0 to f16 (zero)', () => {
    const f32 = new Float32Array([0.0]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    expect(view.getUint16(0, true)).toBe(0x0000);
  });

  it('converts -0.0 to f16 (negative zero)', () => {
    const f32 = new Float32Array([-0.0]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // sign bit set; all other bits zero.
    expect(view.getUint16(0, true)).toBe(0x8000);
  });

  // --- Inf / NaN ---

  it('converts +Infinity to f16 +inf', () => {
    const f32 = new Float32Array([Number.POSITIVE_INFINITY]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // binary16 +inf: sign=0, exp=31, mant=0 -> 0x7c00
    expect(view.getUint16(0, true)).toBe(0x7c00);
  });

  it('converts -Infinity to f16 -inf', () => {
    const f32 = new Float32Array([Number.NEGATIVE_INFINITY]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // binary16 -inf: sign=1, exp=31, mant=0 -> 0xfc00
    expect(view.getUint16(0, true)).toBe(0xfc00);
  });

  it('propagates NaN (quiet NaN -> f16 NaN with mantissa bit)', () => {
    // f32 quiet NaN: exponent=0xff, mantissa high bit set.
    const scratch = new ArrayBuffer(4);
    const u32 = new Uint32Array(scratch);
    u32[0] = 0x7fc00000; // canonical quiet NaN
    const f32 = new Float32Array(scratch);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // NaN -> exp=31, mant=(any mant bit? 1) -> 0x200 | 0x7c00 = 0x7e00
    // But the existing code preserves one mantissa bit for NaN: (mant ? 0x200 : 0)
    // With f32 canonical NaN mant=0x400000, mant is truthy -> set 0x200 -> 0x7e00
    expect(view.getUint16(0, true)).toBe(0x7e00);
  });

  // --- Subnormal ---

  it('rounds subnormals to zero (round-to-zero for e < -10)', () => {
    // Smallest positive f32 normal: 1.1754943508222875e-38 (0x00800000)
    // Half that = subnormal with e < -10 in half precision
    const f32 = new Float32Array([5.877471754111438e-39]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // Subnormal below half precision range -> round to zero
    expect(view.getUint16(0, true)).toBe(0x0000);
  });

  // --- Saturation ---

  it('saturates values > 65504 to +inf', () => {
    const f32 = new Float32Array([100000.0]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // 100000 > 65504 (max half) -> saturate to +inf: 0x7c00
    expect(view.getUint16(0, true)).toBe(0x7c00);
  });

  it('saturates values < -65504 to -inf', () => {
    const f32 = new Float32Array([-100000.0]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // -100000 < -65504 -> saturate to -inf: 0xfc00
    expect(view.getUint16(0, true)).toBe(0xfc00);
  });

  // --- Multiple pixels (RGBA interleaved) ---

  it('produces output half the byte length of input (4 f32 -> 4 f16)', () => {
    const f32 = new Float32Array([1.0, 2.0, 3.0, 4.0]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    // 4 * 4 = 16 bytes in -> 4 * 2 = 8 bytes out
    expect(dst.length).toBe(8);
  });

  it('converts a 4-pixel RGBA buffer correctly', () => {
    const f32 = new Float32Array([1.0, 2.0, 3.0, 1.0]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(8);
    const view = new DataView(dst.buffer, dst.byteOffset, 8);
    expect(view.getUint16(0, true)).toBe(0x3c00); // 1.0
    // 2.0: sign=0, exp=16 (10000), mant=0 -> 0x4000
    expect(view.getUint16(2, true)).toBe(0x4000);
    // 3.0: 3.0 = 1.5 * 2^1, mant=0.5=0x200, exp=16 -> 0x4200
    expect(view.getUint16(4, true)).toBe(0x4200);
    expect(view.getUint16(6, true)).toBe(0x3c00); // 1.0
  });

  // --- Odd-length input (non-multiple of 4) ---

  it('handles odd-length input (truncates to largest 4-byte multiple)', () => {
    const f32 = new Float32Array([1.0, 2.0, 3.0]); // 3 floats = 12 bytes = valid as multiple of 4
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(6); // 3 * 2 = 6
  });

  it('produces zero-length output for empty input', () => {
    const src = new Uint8Array(0);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(0);
  });

  // --- Boundary: max representable normal value (w21) ---

  it('preserves the max half-precision normal value 65504 without saturation', () => {
    const f32 = new Float32Array([65504.0]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // 65504 = max half normal: sign=0, exp=30 (11110), mant=0x3ff (1023)
    // half = 0x7bff
    expect(view.getUint16(0, true)).toBe(0x7bff);
  });

  // --- Boundary: min positive normal value (w21) ---

  it('preserves the min half-precision normal value 6.1035e-5', () => {
    // Min positive half normal: 2^-14 = 0.00006103515625
    const minHalf = 6.103515625e-5;
    const f32 = new Float32Array([minHalf]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // sign=0, exp=1 (00001), mant=0 -> 0x0400
    expect(view.getUint16(0, true)).toBe(0x0400);
  });

  // --- Boundary: round-to-zero for subnormals (w21) ---

  it('rounds the largest f32 subnormal to zero in half precision', () => {
    // Largest f32 subnormal: 1.1754942106924411e-38
    // In half precision e = exp - 127 + 15 = 0 - 127 + 15 = -112, which is < -10
    // so the code branch (e < -10) sets half = sign << 15 = 0.
    const maxSubnormal = 1.1754942106924411e-38;
    const f32 = new Float32Array([maxSubnormal]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    expect(view.getUint16(0, true)).toBe(0x0000);
  });

  it('rounds the smallest positive f32 normal to zero in half precision', () => {
    // Smallest f32 normal: 1.1754943508222875e-38 (0x00800000).
    // exp=1, e = 1 - 127 + 15 = -111, which is < -10 -> rounds to zero.
    const minPositive = 1.1754943508222875e-38;
    const f32 = new Float32Array([minPositive]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    expect(view.getUint16(0, true)).toBe(0x0000);
  });
});

}