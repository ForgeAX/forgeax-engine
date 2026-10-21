import { describe, expect, it } from 'vitest';
import { findPublishedKernel, requirePublishedKernel } from '../../raytracing/published-kernel';

describe('published GI kernel selection', () => {
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
      'expected one published gatherField kernel',
    );
  });

  it('matches the emitted entry spelling without admitting prefix collisions', () => {
    const entries = [{ wgsl: 'fn placeRasterProbesOther() {}' }];
    expect(findPublishedKernel(entries, 'placeRasterProbes')).toBeUndefined();
    expect(findPublishedKernel(entries.values(), 'placeRasterProbesOther')).toBe(entries[0]?.wgsl);
  });
});
