import { World } from '@forgeax/engine-ecs';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { resolveAnimationAsset } from '../resolve-animation-asset';

describe('animation handle failures', () => {
  it('rejects an empty durable GUID at the consumer boundary', () => {
    const result = resolveAnimationAsset<AnimationClip>(
      new World(),
      '',
      'animation-clip',
      () => undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('animation-asset-not-found');
  });
});
