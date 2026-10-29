import { expect, it, vi } from 'vitest';
import { decompressZstd } from '../zstd.js';

const native = vi.hoisted(() => ({
  load: vi.fn(async () => {
    throw new Error('WASM unavailable on this host');
  }),
}));
vi.mock('@hpcc-js/wasm-zstd', () => ({ Zstd: native }));

it('uses the existing JS decoder after native init failure, including concurrent callers', async () => {
  const frame = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x20, 3, 25, 0, 0, 11, 22, 33);
  const expected = { ok: true, value: Uint8Array.of(11, 22, 33) };
  expect(await Promise.all(Array.from({ length: 5 }, () => decompressZstd(frame)))).toEqual(
    Array.from({ length: 5 }, () => expected),
  );
  expect(native.load).toHaveBeenCalledTimes(1);
  const invalid = await decompressZstd(Uint8Array.of(0, 1, 2));
  expect(invalid.ok).toBe(false);
  if (invalid.ok) throw new Error('invalid frame accepted');
  expect(invalid.error.code).toBe('decompression-failed');
  expect(await decompressZstd(frame)).toEqual(expected);
});
