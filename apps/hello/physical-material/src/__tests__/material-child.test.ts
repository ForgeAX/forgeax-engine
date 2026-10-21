import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { Materials, materialContribution } from '@forgeax/engine-render';
import { materialGuidText, materialValuesToLinearRuntime, resolveMaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { physicalMaterialChild, physicalMaterialRoots } from '../material-contract';

describe('physical material children', () => {
  it('rejects uncooked static roots before runtime admission', () => {
    const assets = new AssetRegistry({ shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }) });
    assets.installDecoder(materialContribution.kind, materialContribution.decoder);
    for (const root of physicalMaterialRoots) {
      expect(assets.create(root.material)).toMatchObject({ok: false, error: {code: 'material-specialization-not-cooked'}});
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
