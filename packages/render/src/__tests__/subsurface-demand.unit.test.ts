import { vec3 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import type { MaterialSnapshot } from '../render-system-extract';
import { subsurfaceDemand, subsurfaceTopology } from '../subsurface/demand';

const material = (radius: number[] = [9, 6, 3], weight = 1): MaterialSnapshot => ({
  baseColor: vec3.create(1, 0.6, 0.4),
  metallic: 0,
  roughness: 0.5,
  surfaceModel: 'standard',
  deferredPass: true,
  paramSnapshot: { subsurfaceRadius: radius, subsurfaceWeight: weight },
});
describe('subsurface publication admission', () => {
  it('derives demand from the published values and restores zero/no-SSS', () => {
    expect(subsurfaceDemand([])).toBe(false);
    expect(subsurfaceDemand([material([0, 0, 0]), material([9, 6, 3], 0)])).toBe(false);
    expect(subsurfaceDemand([material()])).toBe(true);
    expect(subsurfaceDemand([material([0.001, 0.001, 0.001]), material([9, 6, 3], 0.0001)])).toBe(
      false,
    );
    expect(subsurfaceDemand([JSON.parse(JSON.stringify(material()))])).toBe(true);
  });
  it('counts RGB profiles independently of weight, bounded to sixteen', () => {
    const roster = Array.from({ length: 16 }, (_, i) => material([i / 2 + 1, 3, 2]));
    expect(subsurfaceDemand(roster)).toBe(true);
    expect(subsurfaceDemand([...roster, material([1, 3, 2], 0.5)])).toBe(true);
    expect(() => subsurfaceDemand([...roster, material([12, 3, 2])])).toThrow('at most 16');
  });
  it.each([
    { radius: [NaN, 1, 1] },
    { radius: [-1, 1, 1] },
    { radius: [13, 1, 1] },
    { radius: [1, 1] },
  ])('refuses invalid published radius $radius', ({ radius }) => {
    expect(() => subsurfaceDemand([material(radius)])).toThrow('subsurfaceRadius');
  });
  it.each([NaN, -0.1, 1.1])('refuses invalid published weight %s', (weight) => {
    expect(() => subsurfaceDemand([material([3, 2, 1], weight)])).toThrow('subsurfaceRadius');
  });
  it('refuses opaque roster changes rather than silently rendering a Forward/translucent SSS material', () => {
    expect(() => subsurfaceDemand([{ ...material(), deferredPass: false }])).toThrow(
      'opaque Deferred',
    );
    expect(() =>
      subsurfaceDemand([{ ...material(), renderState: { depthWriteEnabled: false } }]),
    ).toThrow('opaque Deferred');
  });
  it('refuses positive demand from custom or medium surfaces while preserving their zero-demand behavior', () => {
    for (const surfaceModel of [undefined, 'single-layer-medium'] as const) {
      const unsupported = { ...material(), surfaceModel };
      expect(() => subsurfaceDemand([unsupported])).toThrow('opaque Deferred Standard');
      expect(
        subsurfaceDemand([
          {
            ...unsupported,
            paramSnapshot: {
              subsurfaceRadius: [9, 6, 3],
              subsurfaceWeight: 0,
            },
          },
        ]),
      ).toBe(false);
    }
  });
});

describe('subsurface view topology admission', () => {
  it('bypasses unsupported view/device gates only when the published demand is zero', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    expect(subsurfaceTopology([material([0, 0, 0])], undefined, device, true)).toBeUndefined();
    expect(subsurfaceTopology([material([9, 6, 3], 0)], undefined, device, true)).toBeUndefined();
    expect(() => subsurfaceTopology([material()], undefined, device, false)).toThrow(
      'single-sample Deferred',
    );
    expect(() => subsurfaceTopology([material()], DEFAULT_STANDARD_PROFILE, device, false)).toThrow(
      'single-sample Deferred',
    );
    const deferred = { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' as const };
    expect(() => subsurfaceTopology([material()], deferred, device, true)).toThrow(
      'single-sample Deferred',
    );
    // Null is a real structural backend; absent numeric limits/features must
    // reject active diffusion rather than qualify physical GPU support.
    expect(() => subsurfaceTopology([material()], deferred, device, false)).toThrow(
      '32768-byte workgroup storage',
    );
  });
});
