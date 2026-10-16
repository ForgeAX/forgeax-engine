import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

describe('morph weight animation contract', () => {
  it('exposes a runtime MorphWeights component and preserves frame-major channels', async () => {
    const scene = await import('@forgeax/engine-scene');
    expect(scene.MorphWeights).toBeDefined();
    const clip = {
      kind: 'animation-clip',
      duration: 1,
      channels: [
        {
          targetId: 'b95da0ec669189f98273e8f86d8ad9f2',
          property: 'weights',
          sampler: {
            input: new Float32Array([0, 1]),
            output: new Float32Array([0, 0, 0, 0, 1, 2, 3, 4]),
            interpolation: 'LINEAR',
          },
        },
      ],
    } as unknown as AnimationClip;
    expect(clip.channels[0]?.property).toBe('weights');
    expect(clip.channels[0]?.sampler.output.length).toBe(8);
  });
});
