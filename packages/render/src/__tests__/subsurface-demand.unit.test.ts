import { vec3 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import type { MaterialSnapshot } from '../render-system-extract';
import { subsurfaceDemand, subsurfaceTopology } from '../subsurface/demand';
import { subsurfaceSelection } from './subsurface-selection.fixture';

const material = (radius: number[] = [9, 6, 3], weight = 1): MaterialSnapshot => ({
  passes: [],
  baseColor: vec3.create(1, 0.6, 0.4),
  metallic: 0,
  roughness: 0.5,
  surfaceModel: 'standard',
  deferredPass: true,
  paramSnapshot: { subsurfaceRadius: radius, subsurfaceWeight: weight },
});
describe('subsurface publication admission', () => {
  it('derives demand from the published values and restores zero/no-SSS', () => {
    expect(subsurfaceDemand(subsurfaceSelection([]).demand)).toBe(false);
    expect(
      subsurfaceDemand(subsurfaceSelection([material([0, 0, 0]), material([9, 6, 3], 0)]).demand),
    ).toBe(false);
    expect(subsurfaceDemand(subsurfaceSelection([material()]).demand)).toBe(true);
    expect(
      subsurfaceDemand(
        subsurfaceSelection([material([0.001, 0.001, 0.001]), material([9, 6, 3], 0.0001)]).demand,
      ),
    ).toBe(false);
    expect(
      subsurfaceDemand(subsurfaceSelection([JSON.parse(JSON.stringify(material()))]).demand),
    ).toBe(true);
  });
  it('counts RGB profiles independently of weight, bounded to sixteen', () => {
    const roster = Array.from({ length: 16 }, (_, i) => material([i / 2 + 1, 3, 2]));
    expect(subsurfaceDemand(subsurfaceSelection(roster).demand)).toBe(true);
    expect(
      subsurfaceDemand(subsurfaceSelection([...roster, material([1, 3, 2], 0.5)]).demand),
    ).toBe(true);
    expect(() =>
      subsurfaceDemand(subsurfaceSelection([...roster, material([12, 3, 2])]).demand),
    ).toThrow('at most 16');
  });
  it.each([
    { radius: [NaN, 1, 1] },
    { radius: [-1, 1, 1] },
    { radius: [13, 1, 1] },
    { radius: [1, 1] },
  ])('refuses invalid published radius $radius', ({ radius }) => {
    expect(() => subsurfaceDemand(subsurfaceSelection([material(radius)]).demand)).toThrow(
      'subsurfaceRadius',
    );
  });
  it.each([NaN, -0.1, 1.1])('refuses invalid published weight %s', (weight) => {
    expect(() =>
      subsurfaceDemand(subsurfaceSelection([material([3, 2, 1], weight)]).demand),
    ).toThrow('subsurfaceRadius');
  });
  it('refuses opaque roster changes rather than silently rendering a Forward/translucent SSS material', () => {
    expect(() =>
      subsurfaceDemand(subsurfaceSelection([{ ...material(), deferredPass: false }]).demand),
    ).toThrow('opaque Deferred');
    expect(() =>
      subsurfaceDemand(
        subsurfaceSelection([{ ...material(), renderState: { depthWriteEnabled: false } }]).demand,
      ),
    ).toThrow('opaque Deferred');
  });
  it('refuses positive demand from custom or medium surfaces while preserving their zero-demand behavior', () => {
    for (const surfaceModel of [undefined, 'single-layer-medium'] as const) {
      const unsupported = { ...material(), surfaceModel };
      expect(() => subsurfaceDemand(subsurfaceSelection([unsupported]).demand)).toThrow(
        'opaque Deferred Standard',
      );
      expect(
        subsurfaceDemand(
          subsurfaceSelection([
            {
              ...unsupported,
              paramSnapshot: {
                subsurfaceRadius: [9, 6, 3],
                subsurfaceWeight: 0,
              },
            },
          ]).demand,
        ),
      ).toBe(false);
    }
  });
});

describe('subsurface view topology admission', () => {
  it('bypasses unsupported view/device gates only when the published demand is zero', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    expect(
      subsurfaceTopology(
        subsurfaceSelection([material([0, 0, 0])]).demand,
        undefined,
        device,
        true,
      ),
    ).toBeUndefined();
    expect(
      subsurfaceTopology(
        subsurfaceSelection([material([9, 6, 3], 0)]).demand,
        undefined,
        device,
        true,
      ),
    ).toBeUndefined();
    expect(() =>
      subsurfaceTopology(subsurfaceSelection([material()]).demand, undefined, device, false),
    ).toThrow('single-sample Deferred');
    expect(() =>
      subsurfaceTopology(
        subsurfaceSelection([material()]).demand,
        DEFAULT_STANDARD_PROFILE,
        device,
        false,
      ),
    ).toThrow('single-sample Deferred');
    const deferred = { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' as const };
    expect(() =>
      subsurfaceTopology(subsurfaceSelection([material()]).demand, deferred, device, true),
    ).toThrow('single-sample Deferred');
    // Null is a real structural backend; absent numeric limits/features must
    // reject active diffusion rather than qualify physical GPU support.
    expect(() =>
      subsurfaceTopology(subsurfaceSelection([material()]).demand, deferred, device, false),
    ).toThrow('32768-byte workgroup storage');
  });
});
