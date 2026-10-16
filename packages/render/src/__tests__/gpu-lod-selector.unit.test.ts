import { describe, expect, it } from 'vitest';
import { GPU_DRIVEN_VIEW_WGSL, selectGpuLodLane } from '../gpu-driven/view-gpu';

describe('GPU LOD selector lane', () => {
  it('contains the same absolute threshold and readiness inputs as the CPU reference', () => {
    expect(GPU_DRIVEN_VIEW_WGSL).toContain('screenCoverage');
    expect(GPU_DRIVEN_VIEW_WGSL).toContain('hysteresis');
    expect(GPU_DRIVEN_VIEW_WGSL).toContain('ready');
    expect(GPU_DRIVEN_VIEW_WGSL).toContain('selectLodLevel');
  });

  it('keeps GPU-driven candidates without authored bounds conservatively visible', () => {
    expect(GPU_DRIVEN_VIEW_WGSL).toContain('if ((primitive.flags & 5u) != 5u) { return false; }');
    expect(GPU_DRIVEN_VIEW_WGSL).toContain('if ((primitive.flags & 2u) == 0u) { return true; }');
  });

  it('selects the GPU lane only when all required storage capabilities exist', () => {
    expect(selectGpuLodLane({ compute: true, storageBuffer: true, indirectDrawing: true })).toBe(
      'gpu',
    );
    expect(selectGpuLodLane({ compute: false, storageBuffer: true, indirectDrawing: true })).toBe(
      'cpu',
    );
    expect(selectGpuLodLane({ compute: true, storageBuffer: false, indirectDrawing: true })).toBe(
      'cpu',
    );
  });
});
