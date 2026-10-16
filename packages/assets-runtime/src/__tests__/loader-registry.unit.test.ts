// @forgeax/engine-assets-runtime -- LoaderRegistry coverage (fix issue #709).
// register/get/registeredKinds with fail-fast duplicate ownership semantics.

import type { Loader } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { LoaderRegistry } from '../loader-registry';
import { createDefaultLoaderRegistry } from '../wire-default-loaders';

function loader(kind: string): Loader<unknown> {
  return { kind, load: async () => ({ ok: true, value: undefined }) } as unknown as Loader<unknown>;
}

describe('LoaderRegistry', () => {
  it('registers and looks up a loader by kind', () => {
    const reg = new LoaderRegistry();
    const mesh = loader('mesh');
    const dispose = reg.register(mesh);
    expect(reg.get('mesh')).toBe(mesh);
    dispose();
    expect(reg.get('mesh')).toBeUndefined();
    dispose();
  });

  it('get returns undefined for an unregistered kind', () => {
    expect(new LoaderRegistry().get('nope')).toBeUndefined();
  });

  it('registeredKinds returns the kinds in insertion order', () => {
    const reg = new LoaderRegistry();
    reg.register(loader('mesh'));
    reg.register(loader('material'));
    reg.register(loader('scene'));
    expect(reg.registeredKinds()).toEqual(['mesh', 'material', 'scene']);
  });

  it('rejects duplicate kinds instead of silently replacing the owner', () => {
    const reg = new LoaderRegistry();
    reg.register(loader('mesh'));
    const second = loader('mesh');
    expect(() => reg.register(second)).toThrow(/duplicate loader kind/);
    expect(reg.get('mesh')).not.toBe(second);
    expect(reg.registeredKinds()).toEqual(['mesh']);
  });

  it('throws TypeError when kind is an empty string', () => {
    expect(() => new LoaderRegistry().register(loader(''))).toThrow(TypeError);
  });

  it('throws TypeError when load is not a function', () => {
    const bad = { kind: 'mesh', load: 123 } as unknown as Loader<unknown>;
    expect(() => new LoaderRegistry().register(bad)).toThrow(TypeError);
  });

  it('does not treat a catalog row as a loader input', async () => {
    const reg = new LoaderRegistry();
    reg.registerPackLoader({
      kind: 'mesh',
      load: async (input) => ({ ok: true, value: input.payload }),
    });
    const result = await reg.loadPack(
      {
        guid: 'mesh-guid',
        kind: 'mesh',
        payload: { vertices: [] },
        refs: [],
        artifacts: {},
      },
      {} as never,
    );
    expect(result.ok).toBe(true);
  });

  it('wires every ordinary Asset kind into the default loader registry', () => {
    const expectedKinds = [
      'mesh',
      'material',
      'scene',
      'texture',
      'equirect',
      'sampler',
      'font',
      'render-pipeline',
      'tileset',
      'terrain',
      'navigation-mesh',
      'video',
      'skeleton',
      'skin',
      'animation-clip',
      'animation-graph',
      'audio',
      'particle-effect',
      'ies-profile',
      'plugin',
    ];
    const registry = createDefaultLoaderRegistry();
    expect(
      registry
        .registeredKinds()
        .filter((kind) => kind !== 'ui')
        .sort(),
    ).toEqual(expectedKinds.sort());
    expect(registry.get('ui')).toBeDefined();
  });
});
