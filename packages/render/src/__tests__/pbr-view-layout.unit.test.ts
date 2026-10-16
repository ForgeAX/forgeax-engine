import { describe, expect, it } from 'vitest';
import { buildPbrViewBglEntries } from '../pbr-pipeline';

describe('PBR view bind-group layout', () => {
  it('allows capture passes to select a per-face View UBO slot', () => {
    const entries = buildPbrViewBglEntries({ storageBuffer: true });
    const binding0 = entries[0];
    expect(binding0?.binding).toBe(0);
    expect(binding0?.buffer).toEqual({ type: 'uniform', hasDynamicOffset: true });
    expect(
      entries
        .filter((entry) => entry.buffer?.hasDynamicOffset === true)
        .map((entry) => entry.binding),
    ).toEqual([0, 10]);
  });

  it('omits cloud shadow bindings on the minimum sampled-texture profile', () => {
    const entries = buildPbrViewBglEntries({
      storageBuffer: true,
      extendedLighting: false,
      projectorAvailable: false,
    });
    expect(entries.some((entry) => entry.binding === 16 || entry.binding === 17)).toBe(false);
  });
});
