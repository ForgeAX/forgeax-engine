import { describe, expect, it } from 'vitest';
import { decodeTape } from '../protocol/codec';

describe('v7 tape version boundary', () => {
  it.each([2, 3, 4, 5, 6])('rejects legacy version %s without conversion', (version) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ formatVersion: version }));
    const result = decodeTape(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('tape-version-unsupported');
    expect(result.error.hint).toContain('source revision');
  });
});
