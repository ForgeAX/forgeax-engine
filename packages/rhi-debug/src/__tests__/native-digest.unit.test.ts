import { afterEach, expect, it, vi } from 'vitest';
import { digestBytes } from '../protocol/codec';
import { digestBytesAsync } from '../protocol/digest-async';

afterEach(() => vi.unstubAllGlobals());

it('hashes the exact byte view without WebCrypto and yields during large captures', async () => {
  vi.stubGlobal('crypto', undefined);
  const data = new Uint8Array(2 * 1024 * 1024 + 9);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const bytes = data.subarray(3, data.length - 4);
  let yielded = false;
  const timer = setTimeout(() => {
    yielded = true;
  }, 0);
  try {
    expect(await digestBytesAsync(bytes)).toBe(digestBytes(bytes));
    expect(yielded).toBe(true);
  } finally {
    clearTimeout(timer);
  }
});
