import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../compute/sha256';

const reference = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function pattern(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

describe('sha256', () => {
  it('matches node:crypto for every length across the padding boundaries', () => {
    for (let n = 0; n <= 300; n++) expect(sha256(pattern(n, n))).toBe(reference(pattern(n, n)));
  });

  it('matches node:crypto on larger inputs and on subarray views', () => {
    for (const n of [4096, 65_537, 1_000_003]) {
      const bytes = pattern(n, 7);
      expect(sha256(bytes)).toBe(reference(bytes));
    }
    const backing = pattern(1000, 3);
    const view = backing.subarray(13, 713);
    expect(sha256(view)).toBe(reference(view));
  });

  it('does not modify its input and is repeatable', () => {
    const bytes = pattern(130, 1);
    const copy = bytes.slice();
    const first = sha256(bytes);
    expect(sha256(bytes)).toBe(first);
    expect(bytes).toEqual(copy);
  });
});
