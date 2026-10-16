import { ok, type Result } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  resolveVfxDataInterfaces,
  type VfxDataInterfaceError,
  type VfxDataInterfaceProvider,
  type VfxDataInterfaceRequirement,
  type VfxDataInterfaceResource,
} from '../index.js';

const camera: VfxDataInterfaceRequirement = {
  token: 'vfx:camera',
  kind: 'camera',
  binding: 8,
  bindingType: 'uniform',
  lifetime: 'generation',
};

function provider(
  resource: Omit<VfxDataInterfaceResource, 'generation'> & { readonly generation?: number },
): VfxDataInterfaceProvider {
  return {
    id: `${resource.token}-provider`,
    token: resource.token,
    kind: resource.kind,
    bindingType: resource.bindingType,
    provide: (generation) =>
      ok({
        ...resource,
        generation: resource.generation ?? generation,
      }),
  };
}

describe('VFX Data Interface contract', () => {
  it.each([
    ['missing', [], 'vfx-data-interface-missing'],
    [
      'wrong type',
      [provider({ token: 'vfx:camera', kind: 'camera', bindingType: 'sampled-depth' })],
      'vfx-data-interface-wrong-type',
    ],
    [
      'stale generation',
      [
        provider({
          token: 'vfx:camera',
          kind: 'camera',
          bindingType: 'uniform',
          generation: 2,
          resource: { kind: 'buffer', value: {}, size: 16, usage: 'uniform' },
        }),
      ],
      'vfx-data-interface-stale',
    ],
  ])('%s is a structured failure', (_name, providers, code) => {
    const result = resolveVfxDataInterfaces([camera], providers as VfxDataInterfaceProvider[], 3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(code);
      if (code === 'vfx-data-interface-stale') {
        expect(result.error.expected).toContain('generation 3');
      } else {
        expect(result.error.expected).toContain('camera');
      }
      expect(result.error.hint.length).toBeGreaterThan(0);
      expect(result.error.detail).toMatchObject({ token: 'vfx:camera' });
    }
  });

  it('returns generation-scoped readiness for a valid provider', () => {
    const result = resolveVfxDataInterfaces(
      [camera],
      [
        provider({
          token: 'vfx:camera',
          kind: 'camera',
          bindingType: 'uniform',
          resource: { kind: 'buffer', value: {}, size: 16, usage: 'uniform' },
        }),
      ],
      7,
    );
    expect(result).toMatchObject({ ok: true, value: { generation: 7, readiness: 'ready' } });
  });

  it('rejects an opaque resource whose kind cannot satisfy the reflected binding', () => {
    const result = resolveVfxDataInterfaces(
      [camera],
      [
        provider({
          token: 'vfx:camera',
          kind: 'camera',
          bindingType: 'uniform',
          resource: { kind: 'texture-view', value: {} },
        }),
      ],
      7,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('vfx-data-interface-wrong-type');
      expect(result.error.detail).toMatchObject({
        token: 'vfx:camera',
        expectedResourceKind: 'buffer',
        actualResourceKind: 'texture-view',
      });
    }
  });

  it('keeps provider failures exhaustive without parsing messages', () => {
    const result: Result<unknown, VfxDataInterfaceError> = resolveVfxDataInterfaces(
      [camera],
      [],
      1,
    );
    if (!result.ok) {
      switch (result.error.code) {
        case 'vfx-data-interface-missing':
        case 'vfx-data-interface-wrong-type':
        case 'vfx-data-interface-stale':
        case 'vfx-data-interface-duplicate':
          break;
        default: {
          const exhaustive: never = result.error.code;
          expect(exhaustive).toBeUndefined();
        }
      }
    }
  });
});
