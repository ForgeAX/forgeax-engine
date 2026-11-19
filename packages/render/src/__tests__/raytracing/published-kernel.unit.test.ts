import { describe, expect, it } from 'vitest';
import { findPublishedKernel, requirePublishedKernel } from '../../raytracing/published-kernel';

describe('published GI kernel selection', () => {
  it('rejects an old reader before loading its source and admits the current producer contract', () => {
    const old = {
      get wgsl(): string {
        throw new Error('old source must not load');
      },
    };
    expect(() => requirePublishedKernel([old], 'gatherField', 'standard-gbuffer/2')).toThrow(
      /standard-gbuffer\/2/,
    );
    const current = {
      wgsl: 'fn gatherField() {}',
      programContract: {
        schemaVersion: 'shader-program-contract/1',
        gbuffer: 'standard-gbuffer/2',
      } as const,
    };
    expect(requirePublishedKernel([old, current], 'gatherField', 'standard-gbuffer/2')).toBe(
      current.wgsl,
    );
    expect(
      findPublishedKernel([current, current], 'gatherField', 'standard-gbuffer/2'),
    ).toBeUndefined();
  });
  it('selects each entry from a shared module inventory', () => {
    const entries = [
      { wgsl: 'fn gatherField() {} fn fs_ray_diffuse() {}' },
      { wgsl: 'fn generateRasterRays() {}' },
    ];
    expect(requirePublishedKernel(entries, 'gatherField')).toBe(entries[0]?.wgsl);
    expect(requirePublishedKernel(entries, 'fs_ray_diffuse')).toBe(entries[0]?.wgsl);
    expect(requirePublishedKernel(entries, 'generateRasterRays')).toBe(entries[1]?.wgsl);
  });

  it('rejects absent and ambiguous publications instead of selecting an arbitrary module', () => {
    const entries = [{ wgsl: 'fn gatherField() {}' }, { wgsl: 'fn gatherField() {}' }];
    expect(findPublishedKernel(entries, 'gatherField')).toBeUndefined();
    expect(findPublishedKernel(entries, 'gatherBakedField')).toBeUndefined();
    expect(() => requirePublishedKernel(entries, 'gatherField')).toThrow(
      'one published gatherField kernel',
    );
  });

  it('matches the emitted entry spelling without admitting prefix collisions', () => {
    const entries = [{ wgsl: 'fn placeRasterProbesOther() {}' }];
    expect(findPublishedKernel(entries, 'placeRasterProbes')).toBeUndefined();
    expect(findPublishedKernel(entries.values(), 'placeRasterProbesOther')).toBe(entries[0]?.wgsl);
  });
});
