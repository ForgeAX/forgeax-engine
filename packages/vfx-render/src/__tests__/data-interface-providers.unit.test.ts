import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createVfxDataInterfaceRegistry,
  type VfxDataInterfaceProvider,
} from '../host/data-interface-providers.js';

function provider(token: VfxDataInterfaceProvider['token']): VfxDataInterfaceProvider {
  return {
    id: `${token}-provider`,
    token,
    kind: token.slice(4) as VfxDataInterfaceProvider['kind'],
    bindingType: token === 'vfx:scene-depth' ? 'sampled-depth' : 'uniform',
    provide: (generation) =>
      ok({
        token,
        kind: token.slice(4) as VfxDataInterfaceProvider['kind'],
        bindingType: token === 'vfx:scene-depth' ? 'sampled-depth' : 'uniform',
        generation,
        resource:
          token === 'vfx:scene-depth'
            ? { kind: 'texture-view', value: {} }
            : { kind: 'buffer', value: {}, size: 16, usage: 'uniform' },
      }),
  };
}

describe('VFX host Data Interface providers', () => {
  it('rejects duplicate tokens before a second provider can replace the first', () => {
    const registry = createVfxDataInterfaceRegistry();
    expect(registry.register(provider('vfx:camera'))).toMatchObject({ ok: true });
    const duplicate = registry.register(provider('vfx:camera'));
    expect(duplicate).toMatchObject({
      ok: false,
      error: {
        code: 'vfx-data-interface-duplicate',
        detail: { token: 'vfx:camera' },
      },
    });
  });

  it('projects readiness and errors by reflected token', () => {
    const registry = createVfxDataInterfaceRegistry();
    registry.register(provider('vfx:camera'));
    const result = registry.resolve(
      [
        {
          token: 'vfx:camera',
          kind: 'camera',
          binding: 8,
          bindingType: 'uniform',
          lifetime: 'generation',
        },
      ],
      11,
    );
    expect(result).toMatchObject({ ok: true, value: { readiness: 'ready', generation: 11 } });
  });
});
