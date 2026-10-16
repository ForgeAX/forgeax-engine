import { createRequire } from 'node:module';
import { _setZstdEncoderImporter, compressZstd } from '@forgeax/engine-codec/encode';
import { afterEach, describe, expect, it, vi } from 'vitest';

function makeBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    bytes[i] = (i * 37 + 13) & 0xff;
  }
  return bytes;
}

function hasZstdMagic(bytes: Uint8Array): boolean {
  return bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
}

afterEach(() => {
  _setZstdEncoderImporter();
});

describe('zstd encoder deferred-init singleton', () => {
  it('does not initialize until the first compression', () => {
    const importer = vi.fn(() => createRequire(import.meta.url)('@bokuweb/zstd-wasm'));
    _setZstdEncoderImporter(importer);
    expect(importer).not.toHaveBeenCalled();
  });

  it('shares one WASM init across concurrent first compressions', async () => {
    const importer = vi.fn(() => createRequire(import.meta.url)('@bokuweb/zstd-wasm'));
    _setZstdEncoderImporter(importer);
    const input = makeBytes(65536);
    const results = await Promise.all(Array.from({ length: 8 }, () => compressZstd(input)));

    expect(importer).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('zstd compression failed');
      expect(hasZstdMagic(result.value)).toBe(true);
      expect(result.value.some((byte) => byte !== 0)).toBe(true);
    }
  });

  it('clears a failed init so the next compression retries', async () => {
    let attempts = 0;
    _setZstdEncoderImporter(() => ({
      init: async () => {
        attempts++;
        if (attempts === 1) throw new Error('simulated zstd init failure');
      },
      compress: () => new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]),
    }));

    const first = await compressZstd(makeBytes(8));
    expect(first.ok).toBe(false);
    expect(attempts).toBe(1);

    const second = await compressZstd(makeBytes(8));
    expect(second.ok).toBe(true);
    expect(attempts).toBe(2);
  });
});
