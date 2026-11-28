import { describe, expect, it } from 'vitest';
import type { LightSnapshot } from '../../light';
import { packLights } from '../../raytracing/path-input';
import { admitIrradianceFieldLights } from '../../raytracing/renderer-irradiance-field';

describe('admitIrradianceFieldLights', () => {
  it('excludes rect-area lights, strips IES/cookie/projector modifiers, and caps to 32 brightest with directional priority', () => {
    const lights: LightSnapshot[] = [
      {
        kind: 'rect-area',
        position: [0, 2, 0],
        right: [1, 0, 0],
        up: [0, 0, 1],
        halfWidth: 1,
        halfHeight: 1,
        color: [100, 100, 100],
        invRangeSquared: 0.01,
        twoSided: false,
      },
      ...Array.from(
        { length: 40 },
        (_, i): LightSnapshot =>
          i % 2 === 0
            ? {
                kind: 'point',
                position: [i, 1, 0],
                color: [i + 1, i + 1, i + 1],
                invRangeSquared: 0.01,
                iesProfileHandle: 7,
              }
            : {
                kind: 'spot',
                position: [i, 1, 0],
                direction: [0, -1, 0],
                color: [i + 1, i + 1, i + 1],
                invRangeSquared: 0.01,
                cosInner: 0.9,
                cosOuter: 0.7,
                iesProfileHandle: 9,
                cookieHandle: 11,
                projectorSlice: 3,
              },
      ),
      {
        kind: 'directional',
        direction: [0, -1, 0],
        color: [0.5, 0.5, 0.5],
      },
    ];

    const { admitted, excludedAreaLights } = admitIrradianceFieldLights(lights);
    expect(excludedAreaLights).toBe(1);
    expect(admitted).toHaveLength(32);
    expect(admitted[0]?.kind).toBe('directional');
    // Remaining 31 slots should be the highest-intensity point/spot lights (40 down to 10).
    expect(admitted[1]?.color[0]).toBe(40);
    expect(admitted[31]?.color[0]).toBe(10);
    for (const light of admitted) {
      if (light.kind === 'point') expect(light.iesProfileHandle).toBeUndefined();
      if (light.kind === 'spot') {
        expect(light.iesProfileHandle).toBeUndefined();
        expect(light.cookieHandle).toBeUndefined();
        expect(light.projectorSlice).toBeUndefined();
      }
    }
    expect(packLights(admitted).ok).toBe(true);
  });
});
