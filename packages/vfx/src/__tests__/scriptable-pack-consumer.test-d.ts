import type { Handle, ParticleEffectAsset } from '@forgeax/engine-types';
import { expectTypeOf, it } from 'vitest';

it('keeps the loaded particle program and World handle boundary typed', () => {
  expectTypeOf<ParticleEffectAsset['program']>().toMatchTypeOf<ParticleEffectAsset['program']>();
  expectTypeOf<Handle<'ParticleEffectAsset', 'shared'>>().toEqualTypeOf<
    Handle<'ParticleEffectAsset', 'shared'>
  >();
});
