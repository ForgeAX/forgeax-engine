import type { SchemaOf, ShapeOf } from '@forgeax/engine-ecs';
import type { Handle } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import {
  createVfxEffectContract,
  ParticleEffectInstance,
  type ParticleEffectPlayer,
  type VfxEffectReflection,
} from '../index.js';
import { VFX_PARTICLE_CORE_LAYOUT } from '../particle-layout.js';

type Values = {
  readonly direction: readonly [number, number, number];
  readonly speed: number;
};

const reflection: VfxEffectReflection = {
  version: 3,
  parameters: { name: 'VfxParameters', fields: [], size: 0, alignment: 1 },
  custom: { name: 'VfxCustom', fields: [], size: 0, alignment: 1 },
  core: VFX_PARTICLE_CORE_LAYOUT,
  customLayout: { name: 'VfxCustom', fields: [], size: 0, alignment: 1, stride: 0, lanes: 0 },
  fingerprint: 'sha256:player-type',
};

describe('ParticleEffectPlayer public type shape', () => {
  it('infers typed instance patches from the public effect contract', () => {
    const contract = createVfxEffectContract<Values>(reflection);
    const instance = new ParticleEffectInstance(contract);
    instance.patch({ speed: 2, direction: [0, 1, 0] });
    // @ts-expect-error unknown authored field is rejected at the public SDK boundary
    instance.patch({ missing: 1 });
    // @ts-expect-error vector dimensions are part of the generated contract
    instance.patch({ direction: [0, 1] });
    expectTypeOf(instance).toMatchTypeOf<ParticleEffectInstance<Values>>();
  });

  it('contains only the author-intent schema fields', () => {
    expectTypeOf<keyof SchemaOf<typeof ParticleEffectPlayer>>().toEqualTypeOf<
      'effect' | 'playing' | 'seed' | 'timeScale'
    >();
    expectTypeOf<
      SchemaOf<typeof ParticleEffectPlayer>['effect']
    >().toEqualTypeOf<'shared<ParticleEffectAsset>'>();
    expectTypeOf<SchemaOf<typeof ParticleEffectPlayer>['playing']>().toEqualTypeOf<'bool'>();
    expectTypeOf<SchemaOf<typeof ParticleEffectPlayer>['seed']>().toEqualTypeOf<'u32'>();
    expectTypeOf<SchemaOf<typeof ParticleEffectPlayer>['timeScale']>().toEqualTypeOf<'f32'>();
  });

  it('derives the shared effect handle from the ECS schema', () => {
    type Data = ShapeOf<SchemaOf<typeof ParticleEffectPlayer>>;
    expectTypeOf<Data['effect']>().toEqualTypeOf<Handle<'ParticleEffectAsset', 'shared'>>();
    expectTypeOf<Data['playing']>().toEqualTypeOf<boolean>();
    expectTypeOf<Data['seed']>().toEqualTypeOf<number>();
    expectTypeOf<Data['timeScale']>().toEqualTypeOf<number>();
  });
});
