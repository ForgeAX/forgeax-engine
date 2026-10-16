import { describe, expect, it } from 'vitest';
import type { AssetGuid } from '../../index.js';
import {
  assertMaterialAsset,
  type MaterialAsset,
  projectMaterialParameterSchema,
} from '../asset.js';
import { resolveMaterialAsset } from '../resolve.js';
import { deriveStandardLayerPlan } from '../standard-layer-plan.js';
import { selectMaterialStaticContract } from '../static-switches.js';

const rootId = '00000000-0000-0000-0000-000000000000';
const parent = new Uint8Array(16) as AssetGuid;
const root: MaterialAsset = {
  kind: 'material',
  passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
  parameters: [
    { name: 'baseColor', type: 'color' },
    { name: 'clearcoat', type: 'f32', default: 0 },
    { name: 'clearcoatRoughness', type: 'f32', default: 0 },
    { name: 'clearcoatTexture', type: 'texture' },
    { name: 'baseColorTexture', type: 'texture' },
  ],
  staticSwitches: { clearcoat: true },
  values: {
    baseColor: [1, 1, 1, 1],
    clearcoat: 0,
    clearcoatTexture: 'coat-map',
    baseColorTexture: 'base-map',
  },
};

describe('material static switches', () => {
  it('removes alpha clipping only after an explicit author choice', () => {
    const asset: MaterialAsset = {
      ...root,
      parameters: [{ name: 'alphaCutoff', type: 'f32', default: 0 }],
      values: { alphaCutoff: 0.5 },
      staticSwitches: { alphaClipping: false },
    };
    assertMaterialAsset(asset);
    const selected = selectMaterialStaticContract(asset);
    expect(selected.parameters).toEqual([]);
    expect(selected.values).toEqual({});
    expect(asset.values?.alphaCutoff).toBe(0.5);
    expect(selectMaterialStaticContract({ ...asset, staticSwitches: {} }).parameters).toEqual(
      asset.parameters,
    );
  });

  it('omitted physical switches prune zero and nonzero authored weights without mutating sources', () => {
    for (const weight of [0, 1]) {
      const asset = { ...root, values: { ...root.values, clearcoat: weight } };
      delete asset.staticSwitches;
      const selected = selectMaterialStaticContract(asset);
      expect(selected.parameters?.map((parameter) => parameter.name)).not.toContain('clearcoat');
      expect(selected.parameters?.map((parameter) => parameter.name)).not.toContain(
        'clearcoatTexture',
      );
      expect(selected.values).not.toHaveProperty('clearcoat');
      expect(asset.values.clearcoat).toBe(weight);
      expect(selected.staticSwitches?.clearcoat).toBe(false);
    }
  });

  it('prunes stock map dependencies but preserves custom Surface declarations', () => {
    const parameters = [
      'metallicChannel',
      'normalScale',
      'bumpScale',
      'displacementScale',
      'occlusionStrength',
    ].map((name) => ({ name, type: 'f32' as const }));
    const stock = { ...root, parameters, values: {}, staticSwitches: {} };
    expect(selectMaterialStaticContract(stock).parameters).toEqual([]);
    const custom = { ...stock, surface: { module: 'project::custom', model: 'standard' as const } };
    expect(selectMaterialStaticContract(custom).parameters).toEqual(parameters);
  });

  it('inherits and overrides choices without changing the parent author contract', () => {
    const child: MaterialAsset = {
      kind: 'material',
      parent,
      staticSwitches: { clearcoat: false, textures: false },
    };
    assertMaterialAsset(child);
    const resolved = resolveMaterialAsset('child', { [rootId]: root, child }).unwrap().asset;
    expect(resolved.staticSwitches).toEqual({ clearcoat: false, textures: false });
    const selected = selectMaterialStaticContract(resolved);
    expect(selected.parameters?.map((p) => p.name)).toEqual(['baseColor']);
    expect(selected.values).toEqual({ baseColor: [1, 1, 1, 1] });
    expect(resolved.parameters).toEqual(root.parameters);
    expect(resolved.values?.clearcoatTexture).toBe('coat-map');
    expect(root.staticSwitches).toEqual({ clearcoat: true });
  });

  it('selects a layer from declarations even when its runtime weight is zero', () => {
    const enabled = selectMaterialStaticContract(root);
    expect(deriveStandardLayerPlan(enabled.parameters ?? []).mode).toBe('physical');
    const disabled = selectMaterialStaticContract({
      ...root,
      staticSwitches: { clearcoat: false },
    });
    expect(deriveStandardLayerPlan(disabled.parameters ?? []).mode).toBe('base-only');
    expect(enabled.values?.clearcoat).toBe(0);
  });

  it('uses the same projection for the ABI and removes every texture view dimension', () => {
    const parameters = [
      { name: 'baseColor', type: 'color' as const },
      ...(
        ['texture', 'texture_2d_array', 'texture_3d', 'texture_cube', 'texture_external'] as const
      ).map((type, index) => ({ name: `map${index}`, type })),
    ];
    expect(
      projectMaterialParameterSchema(parameters, 'test', 'cook', { textures: false }).unwrap(),
    ).toEqual([{ name: 'baseColor', type: 'color' }]);
    expect(
      projectMaterialParameterSchema(parameters, 'test', 'runtime', { textures: true }).unwrap(),
    ).toHaveLength(6);
  });

  it.each([
    { unknown: false },
    { clearcoat: 0 },
    [],
    'false',
  ])('rejects invalid author choices: %j', (staticSwitches) => {
    expect(() => assertMaterialAsset({ ...root, staticSwitches })).toThrow();
  });

  it('preserves base IOR when disabling transmission and removes the extension', () => {
    const parameters = [
      { name: 'ior', type: 'f32' as const },
      { name: 'transmission', type: 'f32' as const },
      { name: 'thicknessTexture', type: 'texture' as const },
    ];
    expect(
      projectMaterialParameterSchema(parameters, 'test', 'cook', { transmission: false }).unwrap(),
    ).toEqual([{ name: 'ior', type: 'f32' }]);
  });
});

it('allows a child to re-enable a disabled parent feature without losing its declarations', () => {
  const disabledRoot = { ...root, staticSwitches: { clearcoat: false } };
  const child: MaterialAsset = { kind: 'material', parent, staticSwitches: { clearcoat: true } };
  const resolved = resolveMaterialAsset('child', { [rootId]: disabledRoot, child }).unwrap().asset;
  const selected = selectMaterialStaticContract(resolved);
  expect(selected.parameters?.map((parameter) => parameter.name)).toContain('clearcoat');
  expect(selected.values?.clearcoatTexture).toBe('coat-map');
  expect(deriveStandardLayerPlan(selected.parameters ?? [], selected.passes).mode).toBe('physical');
});
