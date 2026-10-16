import { describe, expect, it } from 'vitest';
import { decodeTape, encodeTape } from '../protocol/codec';
import type { Tape } from '../protocol/types';

const tape: Tape = {
  header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
  bootstrap: [],
  events: [],
  blobs: [],
};

function encodedTape(): Uint8Array {
  const result = encodeTape(tape);
  if (!result.ok) throw new Error('fixture encoding failed');
  return result.value;
}

describe('v7 tape rejection boundary', () => {
  it.each([
    ['truncated', (bytes: Uint8Array) => bytes.slice(0, bytes.length - 1)],
    ['bad magic', (bytes: Uint8Array) => new Uint8Array([0, ...bytes.slice(1)])],
    [
      'bad digest',
      (bytes: Uint8Array) => {
        const copy = bytes.slice();
        copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0xff;
        return copy;
      },
    ],
  ])('%s fails with a structured tape error before replay', (_name, mutate) => {
    const result = decodeTape(mutate(encodedTape()));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('tape-invalid');
    expect(result.error.expected).toContain('v7');
    expect(result.error.hint.length).toBeGreaterThan(0);
  });

  it('rejects missing event fields and lifecycle violations', () => {
    const invalid = new TextEncoder().encode(JSON.stringify({ formatVersion: 7 }));
    const result = decodeTape(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('tape-invalid');
  });
});
