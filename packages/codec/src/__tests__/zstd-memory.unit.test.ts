import assert from 'node:assert/strict';
import { Zstd } from '@hpcc-js/wasm-zstd';
import { afterEach, expect, it } from 'vitest';
import { _setZstdImporter, decompressZstd } from '../zstd.js';

function repeatedFrame(): Uint8Array {
  // Known 20 MiB content, a 1 MiB window, and 160 full-sized RLE blocks.
  const header = [0x28, 0xb5, 0x2f, 0xfd, 0x80, 0x50, 0, 0, 0x40, 1];
  for (let block = 0; block < 160; block++) {
    header.push(block === 159 ? 3 : 2, 0, 0x10, 37);
  }
  return Uint8Array.from(header);
}

afterEach(() => {
  _setZstdImporter();
  Zstd.unload();
});

it('decodes content larger than the native arena without allocating its full output there', async () => {
  Zstd.unload();
  const decoder = await Zstd.load();
  const native = decoder as unknown as {
    _mainModule: { _module: { HEAPU8: Uint8Array } };
  };
  const initial = native._mainModule._module.HEAPU8.byteLength;
  expect(initial).toBeLessThan(20 * 1024 * 1024);
  const decoded = await decompressZstd(repeatedFrame());
  assert.equal(decoded.ok, true);
  if (!decoded.ok) throw new Error('expected the complete RLE frame');
  assert.deepEqual(decoded.value, new Uint8Array(20 * 1024 * 1024).fill(37));
  expect(native._mainModule._module.HEAPU8.byteLength).toBe(initial);
});
