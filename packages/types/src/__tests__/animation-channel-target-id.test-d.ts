import { describe, expectTypeOf, it } from 'vitest';
import type { AnimationChannel, AnimationTargetIdValue, AnimationTransformChannel } from '../index';

describe('animation channel targetId wire', () => {
  it('exposes only the branded targetId field', () => {
    expectTypeOf<AnimationTransformChannel>()
      .toHaveProperty('targetId')
      .toEqualTypeOf<AnimationTargetIdValue>();
    expectTypeOf<AnimationChannel>()
      .toHaveProperty('targetId')
      .toEqualTypeOf<AnimationTargetIdValue>();
    expectTypeOf<AnimationTransformChannel>().not.toHaveProperty('targetPath');
    expectTypeOf<AnimationChannel>().not.toHaveProperty('targetPath');
  });
});
