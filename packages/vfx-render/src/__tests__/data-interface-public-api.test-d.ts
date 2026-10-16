import { ok, type Result } from '@forgeax/engine-types';
import type {
  VfxDataInterfaceError,
  VfxDataInterfaceRequirement,
  VfxDataInterfaceResolution,
} from '@forgeax/engine-vfx';
import { describe, expectTypeOf, it } from 'vitest';
import {
  createCameraProvider,
  createSceneDepthProvider,
  createVfxDataInterfaceRegistry,
  type VfxDataInterfaceProvider,
  type VfxDataInterfaceRegistry,
} from '../index.js';

describe('VFX Data Interface public types', () => {
  it('keeps factories and readiness on the public provider protocol', () => {
    const camera = createCameraProvider({ available: () => true });
    const depth = createSceneDepthProvider({ available: () => true });
    const registry = createVfxDataInterfaceRegistry([camera, depth]);
    const requirements: VfxDataInterfaceRequirement[] = [
      {
        token: 'vfx:scene-depth',
        kind: 'scene-depth',
        binding: 9,
        bindingType: 'sampled-depth',
        lifetime: 'generation',
      },
    ];
    const result = registry.resolve(requirements, 4);

    expectTypeOf(camera).toMatchTypeOf<VfxDataInterfaceProvider>();
    expectTypeOf(depth).toMatchTypeOf<VfxDataInterfaceProvider>();
    expectTypeOf(registry).toMatchTypeOf<VfxDataInterfaceRegistry>();
    expectTypeOf(result).toEqualTypeOf<Result<VfxDataInterfaceResolution, VfxDataInterfaceError>>();
    expectTypeOf(registry.snapshot?.result).toEqualTypeOf<
      Result<VfxDataInterfaceResolution, VfxDataInterfaceError> | undefined
    >();
  });

  it('rejects a provider with binding metadata outside its reflected kind', () => {
    const invalid: VfxDataInterfaceProvider<'scene-depth'> = {
      id: 'invalid',
      token: 'vfx:scene-depth',
      kind: 'scene-depth',
      // @ts-expect-error Scene depth is sampled-depth, not uniform.
      bindingType: 'uniform',
      provide: () =>
        ok({
          token: 'vfx:scene-depth',
          kind: 'scene-depth',
          bindingType: 'sampled-depth',
          generation: 1,
          resource: { kind: 'texture-view', value: {} },
        }),
    };
    expectTypeOf(invalid).toMatchTypeOf<VfxDataInterfaceProvider>();
  });
});
