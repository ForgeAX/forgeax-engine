import { describe, expect, it } from 'vitest';
import { GuidString } from '../schema.js';

describe('GuidString', () => {
  it('accepts UUID values used by scene assets', () => {
    expect(GuidString.safeParse('d953a1db-483a-4b7d-8b71-b8f144488c48').success).toBe(true);
    expect(GuidString.safeParse('15acc839-d847-527c-8284-bfb36d7c50de').success).toBe(true);
    expect(GuidString.safeParse('7B4D43D4-5B19-5903-8966-F89671D21565').success).toBe(false);
  });

  it('rejects malformed or non-UUID strings', () => {
    for (const value of ['', 'not-a-guid', 'rogue-encampment']) {
      expect(GuidString.safeParse(value).success).toBe(false);
    }
  });
});
