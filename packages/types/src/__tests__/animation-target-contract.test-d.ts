import { describe, expectTypeOf, it } from 'vitest';
import type { AnimationTargetIdValue } from '../index';

describe('AnimationTargetIdValue type-only contract', () => {
  it('is a string brand', () => {
    expectTypeOf<AnimationTargetIdValue>().toExtend<string>();
    expectTypeOf<string>().not.toExtend<AnimationTargetIdValue>();
  });

  it('does not expose runtime target-id helpers from types', () => {
    type TypesModule = typeof import('../index');
    expectTypeOf<TypesModule>().not.toHaveProperty('deriveAnimationTargetId');
    expectTypeOf<TypesModule>().not.toHaveProperty('isAnimationTargetId');
  });
});
