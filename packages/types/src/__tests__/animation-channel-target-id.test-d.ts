import { describe, expectTypeOf, it } from 'vitest';
import type { AnimationChannel, AnimationChannelPod, AnimationTargetIdValue } from '../index';

describe('animation channel targetId wire', () => {
  it('exposes only the branded targetId field', () => {
    expectTypeOf<AnimationChannelPod>()
      .toHaveProperty('targetId')
      .toEqualTypeOf<AnimationTargetIdValue>();
    expectTypeOf<AnimationChannel>()
      .toHaveProperty('targetId')
      .toEqualTypeOf<AnimationTargetIdValue>();
    expectTypeOf<AnimationChannelPod>().not.toHaveProperty('targetPath');
    expectTypeOf<AnimationChannel>().not.toHaveProperty('targetPath');
  });
});
