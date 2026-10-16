import { compressZstd } from '@forgeax/engine-codec/encode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _setZstdImporter, decompressZstd } from '../zstd.js';

/**
 * zstd lazy-init singleton test (w5).
 *
 * Validates that the decompressZstd implementation:
 * 1. Does NOT trigger the fzstd importer until the first decompress call (AC-12 zero-cost).
 * 2. Loads the decompressor exactly once even under concurrent first callers.
 * 3. Retries on init failure (does NOT permanently cache the failure).
 *
 * Observe the injected importer directly; production maintains only its lazy promise.
 */

/** Generate deterministic test bytes. */
function makeBytes(size: number): Uint8Array {
  const arr = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    arr[i] = (i * 37 + 13) & 0xff;
  }
  return arr;
}

afterEach(() => {
  // Restore the real fzstd importer + reset the singleton so tests do not leak state.
  _setZstdImporter();
});

describe('zstd deferred-init singleton (w5)', () => {
  it('AC-12 zero-cost: importer is not invoked until the first decompress call', () => {
    const importer = vi.fn(() => Promise.resolve((bytes: Uint8Array) => bytes));
    _setZstdImporter(importer);
    expect(typeof decompressZstd).toBe('function');
    // Importing / referencing the function must not have loaded the decompressor.
    expect(importer).not.toHaveBeenCalled();
  });

  it('first call to decompressZstd triggers init exactly once and decompresses correctly', async () => {
    const realFzstd = await import('fzstd');
    const importer = vi.fn(() => Promise.resolve(realFzstd.decompress));
    _setZstdImporter(importer);
    const input = makeBytes(256);
    const comp = await compressZstd(input);
    if (!comp.ok) throw new Error('compress failed for test setup');

    const result = await decompressZstd(comp.value);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('decompress failed');
    expect(result.value).toEqual(input);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('N concurrent first calls share a single init (importer invoked once) (AC-12)', async () => {
    // Inject a slow importer so all 5 calls race while init is still in-flight.
    const realFzstd = await import('fzstd');
    const importer = vi.fn(
      () =>
        new Promise<typeof realFzstd.decompress>((resolve) => {
          setTimeout(() => resolve(realFzstd.decompress), 10);
        }),
    );
    _setZstdImporter(importer);

    const input = makeBytes(256);
    const comp = await compressZstd(input);
    if (!comp.ok) throw new Error('compress failed for test setup');

    const results = await Promise.all(Array.from({ length: 5 }, () => decompressZstd(comp.value)));

    // The importer must have been invoked exactly once despite 5 concurrent callers.
    expect(importer).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('decompress failed');
      expect(r.value).toEqual(input);
    }
  });

  it('init failure returns codec-init-failed and the next call retries (not permanently cached)', async () => {
    let attempts = 0;
    const realFzstd = await import('fzstd');
    _setZstdImporter(() => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(new Error('simulated fzstd load failure'));
      }
      return Promise.resolve(realFzstd.decompress);
    });

    const input = makeBytes(128);
    const comp = await compressZstd(input);
    if (!comp.ok) throw new Error('compress failed for test setup');

    // First call: importer rejects -> codec-init-failed, cached failure cleared.
    const failed = await decompressZstd(comp.value);
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error('expected first call to fail');
    expect(failed.error.code).toBe('codec-init-failed');

    // Second call: importer retried (not permanently cached) -> succeeds.
    const retried = await decompressZstd(comp.value);
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error('retry decompress failed');
    expect(retried.value).toEqual(input);
    expect(attempts).toBe(2);
  });
});
