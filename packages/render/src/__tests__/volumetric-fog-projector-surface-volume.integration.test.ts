import { describe, expect, it } from 'vitest';

describe('surface and volume projector tuple', () => {
  it('rejects mismatched revision and accepts the same tuple', () => {
    const surface = { guid: 'g', generation: 2, revision: 7 };
    const volume = { guid: 'g', generation: 2, revision: 7 };
    const drifted = { guid: 'g', generation: 2, revision: 8 };
    expect(volume).toEqual(surface);
    expect(drifted).not.toEqual(surface);
  });
});
