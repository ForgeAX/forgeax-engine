import { Buffer } from 'node:buffer';
import { expect, it, vi } from 'vitest';
import { encodeBase64 } from '../base64';

it.each([
  0,
  1,
  2,
  3,
  255,
  8193,
  32769,
  1024 * 1024,
])('encodes the selected %i-byte view identically with host and portable codecs', (length) => {
  const storage = Uint8Array.from({ length: length + 9 }, (_, i) => (i * 71) & 255);
  const bytes = storage.subarray(3, length + 3);
  const expected = Buffer.from(bytes).toString('base64');
  expect(encodeBase64(bytes)).toBe(expected);
  Object.defineProperty(bytes, 'toBase64', { value: undefined });
  vi.stubGlobal('Buffer', undefined);
  vi.stubGlobal('btoa', undefined);
  try {
    expect(encodeBase64(bytes)).toBe(expected);
  } finally {
    vi.unstubAllGlobals();
  }
});
