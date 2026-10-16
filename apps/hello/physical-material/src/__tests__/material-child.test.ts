import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { Materials } from '@forgeax/engine-render';
import { materialGuidText, materialValuesToLinearRuntime, resolveMaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { physicalMaterialChild, physicalMaterialRoots } from '../material-contract';

describe('physical material Catalog children', () => {
  it('admits complete root defaults through the real Catalog validator', () => {
    const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
    for (const root of physicalMaterialRoots) {
      expect(assets.catalog(root.parent, root.material).ok).toBe(true);
      const { values, ...incomplete } = root.material;
      expect(values).toBeDefined();
      expect(assets.catalog(root.parent, incomplete)).toMatchObject({ ok: false, error: { code: 'asset-invalid-value' } });
    }
  });
  it.each(physicalMaterialRoots)('retains $module static selection and parameter ABI through the parent', (root) => {
    const authored = Materials.standard({
      baseColor: [0.8, 0.2, 0.1, 1], metallic: 0, roughness: 0.42,
      clearcoat: 0, clearcoatRoughness: 0.18,
    });
    const child = physicalMaterialChild(authored, root.module);
    const resolved = resolveMaterialAsset('child', { child, [root.guid]: root.material }).unwrap().asset;
    expect(materialGuidText(child.parent!)).toBe(root.guid);
    expect(child.passes).toBeUndefined();
    expect(child.parameters).toBeUndefined();
    expect(child.staticSwitches).toBeUndefined();
    expect(resolved.staticSwitches).toEqual(root.material.staticSwitches);
    expect(resolved.parameters).toEqual(root.material.parameters);
    expect(materialValuesToLinearRuntime(resolved.values, resolved.parameters ?? [], resolved.colorSpace).baseColor)
      .toEqual(materialValuesToLinearRuntime(authored.values, authored.parameters ?? [], authored.colorSpace).baseColor);
    expect(resolved.values).toMatchObject({ clearcoat: 0, clearcoatRoughness: 0.18, roughness: 0.42 });
    const independent = { ...child, values: { ...child.values } };
    expect(resolveMaterialAsset('copy', { copy: independent, [root.guid]: root.material }).unwrap().asset).toEqual(resolved);
  });

  it('retains each textured channel in its actual root layout', () => {
    for (const [suffix, field] of [
      ['factor-r', 'clearcoatTexture'],
      ['roughness-g', 'clearcoatRoughnessTexture'],
      ['normal-rg', 'clearcoatNormalTexture'],
    ]) {
      for (const root of physicalMaterialRoots.filter((root) => root.module.endsWith(suffix!))) {
        const child = physicalMaterialChild({ kind: 'material', passes: root.material.passes!, values: { [field!]: 1042 } }, root.module);
        const resolved = resolveMaterialAsset('child', { child, [root.guid]: root.material }).unwrap().asset;
        expect(resolved.values?.[field!]).toBe(1042);
        expect(resolved.parameters?.find((parameter) => parameter.name === field)?.type).toBe('texture');
      }
    }
  });
});
