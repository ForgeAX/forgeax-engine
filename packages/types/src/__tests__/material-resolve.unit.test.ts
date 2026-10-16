import { describe, expect, it } from 'vitest';
import type { AssetGuid } from '../index.js';
import type { MaterialAsset } from '../material/asset.js';
import { deriveStandardLayerPlan } from '../material/index.js';
import { resolveMaterialAsset } from '../material/resolve.js';

const rootGuid = new Uint8Array(16) as AssetGuid;
const rootId = '00000000-0000-0000-0000-000000000000';
const root: MaterialAsset = {
  kind: 'material',
  passes: [{ name: 'forward', program: { module: 'standard' } }],
  parameters: [
    { name: 'ironColor', type: 'color' as const },
    { name: 'clearcoat', type: 'f32' as const },
    { name: 'clearcoatRoughness', type: 'f32' as const },
  ],
  values: { ironColor: [0.4, 0.45, 0.47, 1], clearcoat: 0, clearcoatRoughness: 0 },
};

describe('Material effective root contract', () => {
  it('preserves the root parameter contract while resolving a sparse child', () => {
    const result = resolveMaterialAsset('child', {
      [rootId]: root,
      child: {
        kind: 'material',
        parent: rootGuid,
        values: { clearcoat: 0 },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.asset.parameters).toEqual(root.parameters);
      expect(result.value.asset.values).toMatchObject({ clearcoat: 0 });
      expect(deriveStandardLayerPlan(result.value.asset.parameters ?? [])).toMatchObject({
        mode: 'physical',
        layers: [{ name: 'clearcoat' }],
      });
    }
  });

  it('rejects a child value that attempts to add a new root parameter', () => {
    const result = resolveMaterialAsset('child', {
      [rootId]: root,
      child: {
        kind: 'material',
        parent: rootGuid,
        values: { unregisteredLayerFactor: 0 },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'material-value-unknown',
        detail: { parameter: 'unregisteredLayerFactor' },
      },
    });
  });

  it.each([
    ['colorSpace', { colorSpace: 'linear' }],
    ['passes', { passes: [{ name: 'forward', program: { module: 'child' } }] }],
    ['parameters', { parameters: [{ name: 'newValue', type: 'f32' }] }],
  ] as const)('rejects a parent child that carries forbidden %s', (field, extra) => {
    const result = resolveMaterialAsset('child', {
      [rootId]: root,
      // Runtime JSON can still be malformed; the loading-boundary validator
      // must retain the structured failure even though the typed authoring
      // union rejects this shape at compile time.
      child: {
        kind: 'material',
        parent: rootGuid,
        values: {},
        ...extra,
      } as unknown as MaterialAsset,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'material-child-contract-invalid',
        detail: {
          material: 'child',
          parent: rootId,
          forbidden: [field],
          action: 'remove-forbidden-fields',
        },
      },
    });
  });
});
