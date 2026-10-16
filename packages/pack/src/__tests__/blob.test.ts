import { describe, expect, it, vi } from 'vitest';
import { decodePackBlob, encodePackBlob, validatePackBlob } from '../blob.js';

describe('portable Pack binary transport', () => {
  it('uses the host byte codec without a per-byte JavaScript expansion', () => {
    const bytes = new Uint8Array([17, 0, 128, 255, 23]).subarray(1, 4);
    Object.defineProperty(bytes, 'toBase64', { value: undefined });
    const fallback = vi.spyOn(globalThis, 'btoa').mockImplementation(() => {
      throw new Error('large binary publication must use the available host codec');
    });
    try {
      expect(encodePackBlob(bytes)).toBe('AID/');
    } finally {
      fallback.mockRestore();
    }
  });
  it.each([
    0,
    1,
    2,
    3,
    32769,
    1024 * 1024,
  ])('roundtrips %i bytes including a selected subview', (length) => {
    const storage = new Uint8Array(length + 7);
    for (let i = 0; i < storage.length; i++) storage[i] = i & 255;
    const bytes = storage.subarray(3, length + 3);
    const encoded = encodePackBlob(bytes);
    expect(encoded.length).toBe(Math.ceil(length / 3) * 4);
    expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
    expect(
      Buffer.compare(
        Buffer.from(decodePackBlob(JSON.parse(JSON.stringify(encoded)))),
        Buffer.from(bytes),
      ),
    ).toBe(0);
  });
  it.each([
    'A',
    'A===',
    '!!!!',
    'AA=A',
    'AB==',
    'AAB=',
    'AAAA\n',
    [256],
    [-1],
    [NaN],
    new Array(1),
    {},
  ])('rejects malformed or ambiguous input %j', (input) => {
    expect(() => validatePackBlob(input)).toThrow();
  });
  it('reads existing numeric publications and owns decoded storage', () => {
    const old = [0, 128, 255];
    const bytes = decodePackBlob(old);
    old[0] = 42;
    expect([...bytes]).toEqual([0, 128, 255]);
  });
  it('supports hosts without native typed-array base64 methods', () => {
    const prototype = Uint8Array.prototype as Uint8Array & { toBase64?: () => string };
    const typedArrayConstructor = Uint8Array as typeof Uint8Array & {
      fromBase64?: (value: string) => Uint8Array;
    };
    const to = prototype.toBase64
      ? vi.spyOn(prototype, 'toBase64').mockImplementation(() => {
          throw new Error('must use fallback');
        })
      : undefined;
    // Define local shadow properties; restore descriptors without changing the realm contract.
    const bytes = new Uint8Array([0, 128, 255]);
    Object.defineProperty(bytes, 'toBase64', { value: undefined });
    const descriptor = Object.getOwnPropertyDescriptor(typedArrayConstructor, 'fromBase64');
    Object.defineProperty(typedArrayConstructor, 'fromBase64', {
      value: undefined,
      configurable: true,
    });
    const bufferDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
    Object.defineProperty(globalThis, 'Buffer', { value: undefined, configurable: true });
    try {
      expect(encodePackBlob(bytes)).toBe('AID/');
      expect([...decodePackBlob('AID/')]).toEqual([...bytes]);
    } finally {
      if (descriptor) Object.defineProperty(typedArrayConstructor, 'fromBase64', descriptor);
      else delete typedArrayConstructor.fromBase64;
      to?.mockRestore();
      if (bufferDescriptor) Object.defineProperty(globalThis, 'Buffer', bufferDescriptor);
      else Reflect.deleteProperty(globalThis, 'Buffer');
    }
  });
});
