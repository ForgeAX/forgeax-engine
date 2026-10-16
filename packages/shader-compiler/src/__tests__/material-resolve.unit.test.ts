import type { AssetGuid, MaterialAsset, MaterialPass } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { resolveMaterialAsset } from '../material/resolve.js';

const guid = (value: string) => value as unknown as AssetGuid;

const pass = (name: string, module: string): MaterialPass => ({
  name,
  program: { module, vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
});

const root: MaterialAsset = {
  kind: 'material',
  passes: [pass('Forward', 'game::root'), pass('Shadow', 'game::shadow')],
  parameters: [
    { name: 'baseColor', type: 'color' },
    { name: 'roughness', type: 'f32' },
    { name: 'optionalTexture', type: 'texture', optional: true },
  ],
  values: { baseColor: [1, 1, 1, 1], roughness: 0.5 },
};

describe('MaterialAsset inheritance resolution', () => {
  it('walks root-first and inherits the root pass contract without compiling parents', () => {
    let compileCount = 0;
    const result = resolveMaterialAsset(
      'leaf',
      {
        root,
        mid: {
          kind: 'material',
          parent: guid('root'),
          values: { baseColor: [0.5, 0.5, 0.5, 1], optionalTexture: null },
        },
        leaf: {
          kind: 'material',
          parent: guid('mid'),
          values: { roughness: 0.25 },
        },
      },
      () => {
        compileCount += 1;
      },
    );

    expect(result.ok).toBe(true);
    expect(compileCount).toBe(0);
    if (result.ok) {
      expect(result.value.chain).toEqual(['root', 'mid', 'leaf']);
      expect(result.value.asset.values).toEqual({ baseColor: [0.5, 0.5, 0.5, 1], roughness: 0.25 });
      expect(result.value.asset.passes?.map(({ name }) => name)).toEqual(['Forward', 'Shadow']);
      expect(result.value.asset.passes?.[0]?.program.module).toBe('game::root');
    }
  });

  it('treats null as an optional clear and keeps the inherited pass contract atomic', () => {
    const result = resolveMaterialAsset('leaf', {
      root,
      leaf: {
        kind: 'material',
        parent: guid('root'),
        values: { optionalTexture: null },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.asset.values).toEqual({ baseColor: [1, 1, 1, 1], roughness: 0.5 });
      expect(result.value.asset.passes).toEqual([
        pass('Forward', 'game::root'),
        pass('Shadow', 'game::shadow'),
      ]);
    }
  });

  it('rejects unknown values, type mismatches, missing parents, and cycles', () => {
    const unknown = resolveMaterialAsset('leaf', {
      root,
      leaf: { kind: 'material', parent: guid('root'), values: { missing: 1 } },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('material-value-unknown');

    const mismatch = resolveMaterialAsset('leaf', {
      root,
      leaf: { kind: 'material', parent: guid('root'), values: { roughness: true } },
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe('material-value-type-mismatch');

    const missing = resolveMaterialAsset('leaf', {
      leaf: { kind: 'material', parent: guid('missing') },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('material-parent-not-found');

    const cycle = resolveMaterialAsset('a', {
      a: { kind: 'material', parent: guid('b') },
      b: { kind: 'material', parent: guid('a') },
    });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.error.code).toBe('material-circular-inheritance');
  });
});
