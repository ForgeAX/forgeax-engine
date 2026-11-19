import { describe, expectTypeOf, it } from 'vitest';
import type {
  VfxDataInterfaceBindingType,
  VfxDataInterfaceKind,
  VfxDataInterfaceProvider,
  VfxDataInterfaceResource,
  VfxDataInterfaceToken,
} from '../index.js';

describe('VFX Data Interface vocabulary owner', () => {
  it('preserves the exact kinds, binding types, and tokens', () => {
    expectTypeOf<VfxDataInterfaceKind>().toEqualTypeOf<
      | 'gpu-events'
      | 'water-displacement'
      | 'water-hull'
      | 'water-config'
      | 'camera'
      | 'scene-depth'
      | 'noise'
      | 'scene-sdf'
      | 'force-fields'
      | 'water-surface'
    >();
    expectTypeOf<VfxDataInterfaceBindingType>().toEqualTypeOf<
      | 'read-write-storage'
      | 'sampled-float-array'
      | 'uniform'
      | 'sampled-depth'
      | 'sampled-float'
      | 'read-only-storage'
      | 'sampled-float-pair'
    >();
    expectTypeOf<VfxDataInterfaceToken>().toEqualTypeOf<
      | 'vfx:gpu-events'
      | 'vfx:water-displacement'
      | 'vfx:water-hull'
      | 'vfx:water-config'
      | 'vfx:camera'
      | 'vfx:scene-depth'
      | 'vfx:noise'
      | 'vfx:scene-sdf'
      | 'vfx:force-fields'
      | 'vfx:water-surface'
    >();
  });

  it('keeps the resource vocabulary closed', () => {
    expectTypeOf<NonNullable<VfxDataInterfaceResource['resource']>['kind']>().toEqualTypeOf<
      'buffer' | 'texture-view' | 'sampler' | 'feature-texture-reference' | 'uniform-data'
    >();
  });

  it('narrows provider binding types from the selected kind', () => {
    expectTypeOf<
      VfxDataInterfaceProvider<'gpu-events'>['bindingType']
    >().toEqualTypeOf<'read-write-storage'>();
    expectTypeOf<
      VfxDataInterfaceProvider<'water-displacement'>['bindingType']
    >().toEqualTypeOf<'sampled-float-array'>();
    expectTypeOf<
      VfxDataInterfaceProvider<'water-hull'>['bindingType']
    >().toEqualTypeOf<'sampled-float'>();
    expectTypeOf<
      VfxDataInterfaceProvider<'water-config'>['bindingType']
    >().toEqualTypeOf<'uniform'>();
    expectTypeOf<VfxDataInterfaceProvider<'camera'>['bindingType']>().toEqualTypeOf<'uniform'>();
    expectTypeOf<
      VfxDataInterfaceProvider<'scene-depth'>['bindingType']
    >().toEqualTypeOf<'sampled-depth'>();
    expectTypeOf<
      VfxDataInterfaceProvider<'noise'>['bindingType']
    >().toEqualTypeOf<'sampled-float'>();
    expectTypeOf<
      VfxDataInterfaceProvider<'water-surface'>['bindingType']
    >().toEqualTypeOf<'sampled-float-pair'>();
    expectTypeOf<
      VfxDataInterfaceProvider<'water-surface'>['token']
    >().toEqualTypeOf<'vfx:water-surface'>();
  });
});
