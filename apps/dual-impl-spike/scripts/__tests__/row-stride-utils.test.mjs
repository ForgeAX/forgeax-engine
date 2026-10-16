// apps/dual-impl-spike/scripts/__tests__/row-stride-utils.test.mjs
//
// Unit test for padRowStride / unpadRowStride / alignedBytesPerRow /
// bytesEqual (M6 / w17; plan-strategy §4.3 AC-19 + R-1 helper isolation).
// Runs under `pnpm test:unit` via the root vitest `unit` project (no GPU
// binding required; pure data-transform helpers).

import { describe, expect, it } from 'vitest';
import {
  alignedBytesPerRow,
  bytesEqual,
  padRowStride,
  unpadRowStride,
  WEBGPU_COPY_BYTES_PER_ROW_ALIGNMENT,
} from '../row-stride-utils.mjs';

describe('row-stride-utils', () => {
  it('alignedBytesPerRow rounds up to 256 multiple', () => {
    expect(WEBGPU_COPY_BYTES_PER_ROW_ALIGNMENT).toBe(256);
    expect(alignedBytesPerRow(4, 4)).toBe(256);
    expect(alignedBytesPerRow(64, 4)).toBe(256);
    expect(alignedBytesPerRow(65, 4)).toBe(512);
    expect(alignedBytesPerRow(1, 1)).toBe(256);
  });

  it('alignedBytesPerRow rejects non-positive args', () => {
    expect(() => alignedBytesPerRow(0, 4)).toThrow(/width must be positive/);
    expect(() => alignedBytesPerRow(4, 0)).toThrow(/bytesPerPixel must be positive/);
    expect(() => alignedBytesPerRow(4.5, 4)).toThrow(/width must be positive integer/);
  });

  it('padRowStride 4x4 RGBA8 produces 256*4 padded buffer with tight rows intact', () => {
    const width = 4;
    const height = 4;
    const bpp = 4;
    const tight = new Uint8Array(width * height * bpp);
    for (let i = 0; i < tight.length; i++) tight[i] = i & 0xff;
    const { padded, bytesPerRow } = padRowStride(tight, width, height, bpp);
    expect(bytesPerRow).toBe(256);
    expect(padded.byteLength).toBe(256 * 4);
    for (let r = 0; r < height; r++) {
      for (let col = 0; col < width * bpp; col++) {
        expect(padded[r * bytesPerRow + col]).toBe(tight[r * width * bpp + col]);
      }
      for (let col = width * bpp; col < bytesPerRow; col++) {
        expect(padded[r * bytesPerRow + col]).toBe(0);
      }
    }
  });

  it('padRowStride rejects tight buffer of wrong length', () => {
    const tight = new Uint8Array(10);
    expect(() => padRowStride(tight, 4, 4, 4)).toThrow(/tight length/);
  });

  it('unpadRowStride is inverse of padRowStride for 4x4 RGBA8', () => {
    const width = 4;
    const height = 4;
    const bpp = 4;
    const tight = new Uint8Array(width * height * bpp);
    for (let i = 0; i < tight.length; i++) tight[i] = (i * 7 + 3) & 0xff;
    const { padded, bytesPerRow } = padRowStride(tight, width, height, bpp);
    const roundTrip = unpadRowStride(padded, width, height, bpp, bytesPerRow);
    expect(roundTrip.byteLength).toBe(tight.byteLength);
    for (let i = 0; i < tight.length; i++) {
      expect(roundTrip[i]).toBe(tight[i]);
    }
  });

  it('unpadRowStride rejects unaligned bytesPerRow', () => {
    const padded = new Uint8Array(400);
    expect(() => unpadRowStride(padded, 4, 4, 4, 100)).toThrow(/must be positive multiple/);
  });

  it('unpadRowStride rejects bytesPerRow < width*bpp', () => {
    const padded = new Uint8Array(256 * 4);
    expect(() => unpadRowStride(padded, 128, 4, 4, 256)).toThrow(/bytesPerRow.*<.*tightRow/);
  });

  it('bytesEqual reports equality on matching buffers', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(bytesEqual(a, b)).toEqual({ equal: true });
  });

  it('bytesEqual reports first byte diff with index', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 9, 4]);
    const r = bytesEqual(a, b);
    expect(r.equal).toBe(false);
    expect(r.reason).toBe('byte-mismatch');
    expect(r.firstDiffIndex).toBe(2);
    expect(r.a).toBe(3);
    expect(r.b).toBe(9);
  });

  it('bytesEqual reports length mismatch', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2]);
    const r = bytesEqual(a, b);
    expect(r.equal).toBe(false);
    expect(r.reason).toBe('length-mismatch');
    expect(r.aLength).toBe(3);
    expect(r.bLength).toBe(2);
  });
});
