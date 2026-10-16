import { describe, expectTypeOf, it } from 'vitest';
import type { AssetTagMap, Handle, ParticleEffectAsset, TagOf } from '../index';

describe('particle-effect asset closure', () => {
  it('maps the asset kind to the shared handle target', () => {
    expectTypeOf<AssetTagMap['particle-effect']>().toEqualTypeOf<'ParticleEffectAsset'>();
    expectTypeOf<TagOf<ParticleEffectAsset>>().toEqualTypeOf<'ParticleEffectAsset'>();
    expectTypeOf<Handle<'ParticleEffectAsset', 'shared'>>().toExtend<number>();
  });
});
