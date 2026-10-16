import { describe, expect, it } from 'vitest';
import { selectGpuLodLane } from '../gpu-driven/view-gpu';

describe('GPU LOD unsupported fallback', () => {
  it('reports the existing CPU direct lane without introducing another visibility owner', () => {
    expect(selectGpuLodLane({ compute: false, storageBuffer: false, indirectDrawing: false })).toBe(
      'cpu',
    );
  });
});
