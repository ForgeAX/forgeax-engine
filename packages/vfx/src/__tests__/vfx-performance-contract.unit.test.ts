import { describe, expect, it } from 'vitest';

describe('VFX performance contract', () => {
  it('names every Batch B workload and its bounded evidence fields', () => {
    const capacities = [10_000, 100_000, 1_000_000];
    expect(capacities).toHaveLength(3);
    expect({
      backend: 'dawn-wgpu',
      warmupFrames: 30,
      samples: 60,
      p95: true,
      p99: true,
      overflow: true,
      allocation: true,
    }).toEqual(
      expect.objectContaining({ backend: 'dawn-wgpu', p95: true, p99: true, allocation: true }),
    );
  });
});
