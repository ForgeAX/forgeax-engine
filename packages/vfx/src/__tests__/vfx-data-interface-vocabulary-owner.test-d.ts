import { describe, expectTypeOf, it } from 'vitest';
import type {
  VfxDataInterfaceBindingType,
  VfxDataInterfaceKind,
  VfxDataInterfaceProvider,
  VfxDataInterfaceToken,
} from '../index.js';

describe('VFX Data Interface vocabulary owner', () => {
  it('preserves the exact kinds, binding types, and tokens', () => {
    expectTypeOf<VfxDataInterfaceKind>().toEqualTypeOf<
      'camera' | 'scene-depth' | 'noise' | 'scene-sdf' | 'force-fields' | 'water-surface'
    >();
    expectTypeOf<VfxDataInterfaceBindingType>().toEqualTypeOf<
      'uniform' | 'sampled-depth' | 'sampled-float' | 'read-only-storage' | 'sampled-float-pair'
    >();
    expectTypeOf<VfxDataInterfaceToken>().toEqualTypeOf<
      | 'vfx:camera'
      | 'vfx:scene-depth'
      | 'vfx:noise'
      | 'vfx:scene-sdf'
      | 'vfx:force-fields'
      | 'vfx:water-surface'
    >();
  });

  it('narrows provider binding types from the selected kind', () => {
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
