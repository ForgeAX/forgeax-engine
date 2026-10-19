import { describe, expect, it } from 'vitest';
import { fnv1a32, fnv1aUtf16 } from '../index';

describe('FNV input encodings', () => {
  it.each([
    ['', 0x811c9dc5],
    ['a', 0xe40c292c],
    ['foobar', 0xbf9cf968],
  ])('retains the published ASCII vector %s', (text, expected) => {
    expect(fnv1a32(new TextEncoder().encode(text))).toBe(expected);
    expect(fnv1aUtf16(text)).toBe(expected);
  });
  it('keeps full words and surrogate code units distinct from bytes and code points', () => {
    expect(fnv1a32([0x12345678, 0xffffffff])).toBe(0x8cb25be8);
    expect(fnv1aUtf16('😀')).toBe(0xcb31c4b8);
    expect(fnv1aUtf16('😀')).not.toBe(fnv1a32([0x1f600]));
    expect(fnv1aUtf16('😀')).not.toBe(fnv1a32(new TextEncoder().encode('😀')));
  });
});
