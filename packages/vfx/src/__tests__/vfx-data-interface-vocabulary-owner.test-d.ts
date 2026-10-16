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
      'camera' | 'scene-depth' | 'noise' | 'scene-sdf' | 'force-fields'
    >();
    expectTypeOf<VfxDataInterfaceBindingType>().toEqualTypeOf<
      'uniform' | 'sampled-depth' | 'sampled-float' | 'read-only-storage'
    >();
    expectTypeOf<VfxDataInterfaceToken>().toEqualTypeOf<
      'vfx:camera' | 'vfx:scene-depth' | 'vfx:noise' | 'vfx:scene-sdf' | 'vfx:force-fields'
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
  });
});
