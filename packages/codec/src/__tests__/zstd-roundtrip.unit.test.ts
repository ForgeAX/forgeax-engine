import { decompressZstd } from '@forgeax/engine-codec';
// compressZstd comes from the encode subpath (build-time).
// In vitest context this resolves to packages/codec/src/encode/index.ts.
import { compressZstd } from '@forgeax/engine-codec/encode';
import { describe, expect, it } from 'vitest';

/** Generate deterministic test bytes of given length. */
function makeBytes(size: number): Uint8Array {
  const arr = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    arr[i] = (i * 37 + 13) & 0xff;
  }
  return arr;
}

/** Unwrap a CodecResult, throwing on error for test simplicity. */
async function unwrapZstd(result: Awaited<ReturnType<typeof decompressZstd>>): Promise<Uint8Array> {
  if (!result.ok) {
    throw new Error(`unexpected codec error: ${result.error.code} — ${result.error.detail}`);
  }
  return result.value;
}

describe('zstd round-trip (w2)', () => {
  it('round-trip byte-identical for non-empty input (1 byte)', async () => {
    const original = makeBytes(1);
    const comp = await compressZstd(original);
    expect(comp.ok).toBe(true);
    if (!comp.ok) throw new Error('compress failed');
    const decompressed = await unwrapZstd(await decompressZstd(comp.value));
    expect(decompressed).toEqual(original);
  });

  it('round-trip byte-identical for 1024 bytes', async () => {
    const original = makeBytes(1024);
    const comp = await compressZstd(original);
    expect(comp.ok).toBe(true);
    if (!comp.ok) throw new Error('compress failed');
    const decompressed = await unwrapZstd(await decompressZstd(comp.value));
    expect(decompressed).toEqual(original);
  });

  it('round-trip byte-identical for 65536 bytes', async () => {
    const original = makeBytes(65536);
    const comp = await compressZstd(original);
    expect(comp.ok).toBe(true);
    if (!comp.ok) throw new Error('compress failed');
    const decompressed = await unwrapZstd(await decompressZstd(comp.value));
    expect(decompressed).toEqual(original);
  });

  it('0-byte input round-trip returns 0-byte (E4)', async () => {
    const original = new Uint8Array(0);
    const comp = await compressZstd(original);
    expect(comp.ok).toBe(true);
    if (!comp.ok) throw new Error('compress failed');
    const decompressed = await unwrapZstd(await decompressZstd(comp.value));
    expect(decompressed.length).toBe(0);
    expect(decompressed).toEqual(original);
  });

  it('non-zstd garbage input returns decompression-failed error', async () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff]);
    const result = await decompressZstd(garbage);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected error for garbage input');
    }
    expect(result.error.code).toBe('decompression-failed');
  });

  it('FALSIFICATION: corrupt 1 byte of valid compressed output, round-trip must FAIL', async () => {
    const original = makeBytes(4096);
    const comp = await compressZstd(original);
    expect(comp.ok).toBe(true);
    if (!comp.ok) throw new Error('compress failed');
    // Corrupt byte 1 of the compressed stream
    const corrupted = new Uint8Array(comp.value);
    if (corrupted.length > 1) {
      const val = corrupted[1];
      if (val !== undefined) corrupted[1] = val ^ 0xff;
    }
    const result = await decompressZstd(corrupted);
    // Must NOT silently return original bytes — correctness requires error
    expect(result.ok).toBe(false);
  });
});
