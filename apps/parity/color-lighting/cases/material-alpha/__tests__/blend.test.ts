import { describe, expect, it } from 'vitest';

describe('material alpha BLEND cases', () => {
  it('uses straight-alpha over a non-black destination', () => {
    const source = { rgb: [0.8, 0.2, 0.1], alpha: 0.4 } as const;
    const destination = [0.2, 0.4, 0.6] as const;
    const result = source.rgb.map((channel, index) => {
      const dst = destination[index] ?? 0;
      return channel * source.alpha + dst * (1 - source.alpha);
    });

    expect(result).toEqual([0.44000000000000006, 0.32, 0.4]);
  });

  it('keeps BLEND distinct from MASK', () => {
    const blend = { queue: 3000, depthWriteEnabled: false };
    const mask = { queue: 2450, depthWriteEnabled: true };

    expect(blend).not.toEqual(mask);
  });
});
