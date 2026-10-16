// texel-decode.test.ts — host-side decode of uncompressed color formats to RGBA8.

import { decodeToRgba8, halfToFloat } from '@forgeax/engine-rhi-debug';
import { describe, expect, it } from 'vitest';

/** Pack a Float32Array into a little-endian byte view. */
function f32Bytes(values: number[]): Uint8Array {
  const f = new Float32Array(values);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

/** Pack u16 half-float bit patterns into a little-endian byte view. */
function u16Bytes(values: number[]): Uint8Array {
  const u = new Uint16Array(values);
  return new Uint8Array(u.buffer, u.byteOffset, u.byteLength);
}

describe('halfToFloat', () => {
  it('decodes canonical f16 bit patterns', () => {
    expect(halfToFloat(0x0000)).toBe(0); // +0
    expect(halfToFloat(0x3c00)).toBeCloseTo(1, 5); // 1.0
    expect(halfToFloat(0x4000)).toBeCloseTo(2, 5); // 2.0
    expect(halfToFloat(0x3800)).toBeCloseTo(0.5, 5); // 0.5
    expect(halfToFloat(0xbc00)).toBeCloseTo(-1, 5); // -1.0
    expect(halfToFloat(0x7c00)).toBe(Number.POSITIVE_INFINITY); // +Inf
  });
});

describe('decodeToRgba8 — float formats clamp to [0,1]', () => {
  it('rgba16float: >1 saturates to 255, fractional scales, 0 stays 0', () => {
    // {2.0, 0.5, 0.0, 1.0} as f16 patterns.
    const bytes = u16Bytes([0x4000, 0x3800, 0x0000, 0x3c00]);
    const out = decodeToRgba8(bytes, 'rgba16float', 1, 1);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out[0]).toBe(255); // 2.0 clamped to 1 -> 255
    expect(out[1]).toBe(128); // 0.5 -> ~128
    expect(out[2]).toBe(0); // 0.0
    expect(out[3]).toBe(255); // 1.0 alpha
  });

  it('rgba32float: clamp <0 -> 0 and >1 -> 255', () => {
    const bytes = f32Bytes([-0.5, 0.25, 5.0, 1.0]);
    const out = decodeToRgba8(bytes, 'rgba32float', 1, 1);
    if (!out) throw new Error('decode failed');
    expect(out[0]).toBe(0); // -0.5 clamped
    expect(out[1]).toBe(64); // 0.25 -> ~64
    expect(out[2]).toBe(255); // 5.0 clamped
    expect(out[3]).toBe(255);
  });

  it('r32float single channel replicates to grayscale R=G=B, A=255', () => {
    const bytes = f32Bytes([0.5]);
    const out = decodeToRgba8(bytes, 'r32float', 1, 1);
    if (!out) throw new Error('decode failed');
    expect(out[0]).toBe(128);
    expect(out[1]).toBe(128);
    expect(out[2]).toBe(128);
    expect(out[3]).toBe(255);
  });
});

describe('decodeToRgba8 — unorm / bgra / packed', () => {
  it('rgba8unorm passes through verbatim', () => {
    const bytes = new Uint8Array([10, 20, 30, 40]);
    const out = decodeToRgba8(bytes, 'rgba8unorm', 1, 1);
    if (!out) throw new Error('decode failed');
    expect([out[0], out[1], out[2], out[3]]).toEqual([10, 20, 30, 40]);
  });

  it('bgra8unorm swizzles B<->R', () => {
    // memory order B,G,R,A = [10,20,30,40] -> display R=30, G=20, B=10, A=40.
    const bytes = new Uint8Array([10, 20, 30, 40]);
    const out = decodeToRgba8(bytes, 'bgra8unorm', 1, 1);
    if (!out) throw new Error('decode failed');
    expect([out[0], out[1], out[2], out[3]]).toEqual([30, 20, 10, 40]);
  });

  it('rgb10a2unorm unpacks 10/10/10/2 bit fields', () => {
    // R=1023 (max), G=0, B=512, A=3 (max). word = R | G<<10 | B<<20 | A<<30.
    const word = 1023 | (0 << 10) | (512 << 20) | (3 << 30);
    const bytes = new Uint8Array(new Uint32Array([word >>> 0]).buffer);
    const out = decodeToRgba8(bytes, 'rgb10a2unorm', 1, 1);
    if (!out) throw new Error('decode failed');
    expect(out[0]).toBe(255); // 1023/1023 -> 255
    expect(out[1]).toBe(0); // 0
    expect(out[2]).toBe(Math.round((512 / 1023) * 255)); // ~128
    expect(out[3]).toBe(255); // 3/3 -> 255
  });

  it('rg11b10ufloat unpacks to 3 channels with A=255', () => {
    // 11-bit float for 1.0 = exp 15 (0x0f << 6), mantissa 0 -> 0x3c0.
    // 10-bit float for 1.0 = exp 15 (0x0f << 5), mantissa 0 -> 0x1e0.
    const r11 = 0x0f << 6; // 1.0
    const g11 = 0x0f << 6; // 1.0
    const b10 = 0x0f << 5; // 1.0
    const word = (r11 | (g11 << 11) | (b10 << 22)) >>> 0;
    const bytes = new Uint8Array(new Uint32Array([word]).buffer);
    const out = decodeToRgba8(bytes, 'rg11b10ufloat', 1, 1);
    if (!out) throw new Error('decode failed');
    expect(out[0]).toBe(255);
    expect(out[1]).toBe(255);
    expect(out[2]).toBe(255);
    expect(out[3]).toBe(255);
  });

  it('rg8unorm fills B=0, A=255', () => {
    const bytes = new Uint8Array([100, 200]);
    const out = decodeToRgba8(bytes, 'rg8unorm', 1, 1);
    if (!out) throw new Error('decode failed');
    expect([out[0], out[1], out[2], out[3]]).toEqual([100, 200, 0, 255]);
  });
});

describe('decodeToRgba8 — uint formats stay visible', () => {
  it('r32uint clamps to 0..255 (no normalize)', () => {
    const bytes = new Uint8Array(new Uint32Array([5]).buffer);
    const out = decodeToRgba8(bytes, 'r32uint', 1, 1);
    if (!out) throw new Error('decode failed');
    expect(out[0]).toBe(5);
    expect(out[3]).toBe(255);
  });
});

describe('decodeToRgba8 — unsupported formats return null', () => {
  it('compressed bc7 -> null', () => {
    expect(decodeToRgba8(new Uint8Array(16), 'bc7-rgba-unorm', 4, 4)).toBeNull();
  });
  it('combined depth-stencil without an explicit aspect -> null', () => {
    expect(decodeToRgba8(new Uint8Array(4), 'depth24plus-stencil8', 1, 1)).toBeNull();
  });
});

describe('decodeToRgba8 — Sponza tape depth closure', () => {
  it('maps depth32float to grayscale', () => {
    const out = decodeToRgba8(f32Bytes([0.5]), 'depth32float', 1, 1, 'depth-only');
    expect(out && [...out]).toEqual([128, 128, 128, 255]);
  });

  it('maps the depth plane of depth24plus-stencil8 to grayscale', () => {
    const out = decodeToRgba8(f32Bytes([0.25]), 'depth24plus-stencil8', 1, 1, 'depth-only');
    expect(out && [...out]).toEqual([64, 64, 64, 255]);
  });

  it('maps the stencil plane of depth24plus-stencil8 to grayscale', () => {
    const out = decodeToRgba8(new Uint8Array([37]), 'depth24plus-stencil8', 1, 1, 'stencil-only');
    expect(out && [...out]).toEqual([37, 37, 37, 255]);
  });

  it.each([
    ['bgra8unorm', new Uint8Array([0, 0, 0, 255])],
    ['rg16float', u16Bytes([0, 0])],
    ['rgba16float', u16Bytes([0, 0, 0, 0x3c00])],
    ['rgba8unorm', new Uint8Array([0, 0, 0, 255])],
    ['rgba8unorm-srgb', new Uint8Array([0, 0, 0, 255])],
  ])('decodes Sponza color format %s', (format, bytes) => {
    expect(decodeToRgba8(bytes, format, 1, 1)).not.toBeNull();
  });
});
