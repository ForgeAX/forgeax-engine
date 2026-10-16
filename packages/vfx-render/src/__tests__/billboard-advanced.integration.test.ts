import { describe, expect, it } from 'vitest';
import { resolveBillboardAdvancedState } from '../feature/gpu-particle-feature.js';

const renderer = {
  kind: 'billboard',
  material: 'vfx',
  textureSheet: { columns: 4, rows: 2, frameRate: 12, frameCount: 8 },
  pivot: [0.2, 0.8],
  softParticle: { fadeDistance: 0.5 },
  sorting: 'view-depth',
} as const;

describe('billboard advanced executable inputs', () => {
  it('selects a bounded frame and changes the GPU-facing state', () => {
    const state = resolveBillboardAdvancedState(renderer, {
      age: 0.31,
      lifetime: 1,
      particleDepth: 0.8,
      sceneDepth: 0.2,
      depthAvailable: true,
    });

    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.value.frameIndex).toBe(3);
      expect(state.value.pivot).toEqual([0.2, 0.8]);
      expect(state.value.softParticleFade).toBeGreaterThan(0);
      expect(state.value.sortingKey).toBe(0.8);
    }
  });

  it('fails closed when soft particles have no depth provider', () => {
    const state = resolveBillboardAdvancedState(renderer, {
      age: 0.1,
      lifetime: 1,
      particleDepth: 0.8,
      sceneDepth: 0.2,
      depthAvailable: false,
    });

    expect(state).toMatchObject({
      ok: false,
      error: { code: 'vfx-renderer-depth-missing' },
    });
  });
});
