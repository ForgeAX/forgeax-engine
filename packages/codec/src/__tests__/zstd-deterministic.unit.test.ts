import { compressZstd } from '@forgeax/engine-codec/encode';
import { describe, expect, it } from 'vitest';

/** Generate deterministic f32-ish bytes (vertex-like float data). */
function makeF32Data(elementCount: number): Uint8Array {
  const floats = new Float32Array(elementCount);
  for (let i = 0; i < elementCount; i++) {
    floats[i] = Math.sin(i * 0.1) * 10.0 + (i % 100) * 0.01;
  }
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

describe('zstd encode deterministic (w3)', () => {
  it('5x compress same input produces byte-identical output (AC-07)', async () => {
    const input = makeF32Data(4096); // 16384 bytes of f32 vertex-like data
    const results: Uint8Array[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await compressZstd(input);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(`compress failed at iteration ${i}`);
      results.push(r.value);
    }
    // All 5 outputs must be byte-identical
    const first = results[0];
    if (!first) throw new Error('unreachable: results[0] exists after 5 pushes');
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toEqual(first);
    }
  });

  it('different inputs produce different compressed output (discriminability)', async () => {
    const inputA = makeF32Data(4096);
    const inputB = makeF32Data(4097); // different data
    const rA = await compressZstd(inputA);
    const rB = await compressZstd(inputB);
    expect(rA.ok).toBe(true);
    expect(rB.ok).toBe(true);
    if (!rA.ok || !rB.ok) throw new Error('compress failed');
    expect(rA.value).not.toEqual(rB.value);
  });

  it('compressed output is smaller than input for f32 array data (compression sanity)', async () => {
    const input = makeF32Data(8192); // 32768 bytes
    const r = await compressZstd(input);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('compress failed');
    expect(r.value.length).toBeLessThan(input.length);
  });
});
