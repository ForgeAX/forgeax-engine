import { PackageId } from '@forgeax/engine-pack/source';
import { type MaterialAsset, resolveMaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  buildWaterMaterialFamily,
  WATER_MATERIAL_FAMILY_KEYS,
  type WaterMaterialFamilyKey,
} from '../material-family.js';

function materialFamily() {
  const packageId = PackageId.parse('019fc0e7-1000-7000-8000-000000000004');
  if (!packageId.ok) throw packageId.error;
  return buildWaterMaterialFamily(packageId.value);
}

function resolvedFamily() {
  const family = materialFamily();
  const table = Object.fromEntries(
    WATER_MATERIAL_FAMILY_KEYS.map((key) => [
      family.guids[key],
      family.outputs[`material/water/${key}`],
    ]),
  );
  return Object.fromEntries(
    WATER_MATERIAL_FAMILY_KEYS.map((key) => [
      key,
      resolveMaterialAsset(family.guids[key], table).unwrap().asset,
    ]),
  ) as Readonly<Record<WaterMaterialFamilyKey, MaterialAsset>>;
}

function parameterValue(material: MaterialAsset, name: string) {
  return (
    material.values?.[name] ?? material.parameters?.find((entry) => entry.name === name)?.default
  );
}

describe('stock Water material family', () => {
  it('enables waves on the directly selected stock root and its near instance', () => {
    const packageId = PackageId.parse('019fc0e7-1000-7000-8000-000000000004');
    if (!packageId.ok) throw packageId.error;
    const family = buildWaterMaterialFamily(packageId.value);
    const root = family.outputs['material/water/root'];
    const instance = family.outputs['material/water/instance'];
    expect(root?.staticSwitches?.waterWaves).toBe(true);
    expect(instance?.staticSwitches?.waterWaves).toBe(true);
    expect(instance?.parent).toBe(family.guids.root);
  });

  it('keeps the fragment-only visual normal consumer opt-in with explicit mapping values', () => {
    const root = resolvedFamily().root;
    expect(root.staticSwitches?.waterVisualNormalDetail).toBe(false);
    expect(root.parameters?.find(({ name }) => name === 'NormalDetailTex')).toMatchObject({
      type: 'texture',
      sampleType: 'unfilterable-float',
    });
    expect(parameterValue(root, 'WPOWaveScale')).toBe(1);
    expect(parameterValue(root, 'BakedWaterSimSize')).toBe(256);
  });

  it('preserves the native effective source and vertex-mapping matrix through inheritance', () => {
    const resolved = resolvedFamily();
    const expected = {
      root: [true, true, false, false, true, false],
      instance: [true, true, false, false, true, false],
      river: [false, true, false, false, true, false],
      lake: [true, true, false, false, true, false],
      ocean: [true, true, false, false, true, true],
      custom: [true, false, true, true, false, false],
      'river-to-lake': [false, true, false, false, true, false],
      'river-to-ocean': [false, true, false, false, true, true],
      'river-lod': [false, false, false, false, false, false],
      'lake-lod': [true, false, false, false, false, false],
      'ocean-lod': [true, false, false, false, false, true],
      'custom-lod': [true, false, true, true, false, false],
      far: [false, false, true, true, false, false],
      hlod: [false, false, true, true, false, false],
    } satisfies Partial<Record<WaterMaterialFamilyKey, readonly boolean[]>>;
    for (const [key, row] of Object.entries(expected)) {
      const switches = resolved[key as WaterMaterialFamilyKey].staticSwitches;
      expect(
        [
          switches?.waterWaves,
          switches?.waterInfo,
          switches?.waterFixedHeight,
          switches?.waterFixedDepth,
          switches?.waterVertexMapping,
          switches?.waterOceanFoam,
        ],
        key,
      ).toEqual(row);
      expect(switches?.waterBakedSimulation, key).toBe(false);
      expect(switches?.waterFixedVelocity, key).toBe(false);
      expect(switches?.waterDynamicBoundsClip, key).toBe(
        !['custom', 'custom-lod', 'far', 'hlod'].includes(key),
      );
    }
    const family = materialFamily();
    expect(family.outputs['material/water/far']?.parent).toBe(family.guids.root);
    expect(family.outputs['material/water/hlod']?.parent).toBe(family.guids.far);
    expect(family.outputs['material/water/custom-lod']?.parent).toBe(family.guids.custom);
    expect(resolved.underwater.staticSwitches).toMatchObject({
      waterInfo: true,
      waterFixedHeight: false,
      waterFixedDepth: false,
    });
    expect(resolved['custom-underwater'].staticSwitches).toMatchObject({
      waterInfo: false,
      waterFixedHeight: true,
      waterFixedDepth: true,
    });
  });

  it('keeps root defaults and River normal scale independent of Ocean foam scale', () => {
    const resolved = resolvedFamily();
    for (const [name, value] of Object.entries({
      flowmapDepthBiasM: 0.64,
      flowmapDepthDensityPerM: 0.3,
      flowmapSpeed: 0.003,
      waveVelocityMaskThresholdMPerSec: 1,
      riverNormalTilingM: 5.12,
      foamTilingM: 15.36,
      simulationFoamContrast: 0,
      criticalAngleDot: 0.225,
      refractionBottomAmount: 1,
    }))
      expect(parameterValue(resolved.root, name), name).toBe(value);
    for (const key of ['river', 'river-to-lake', 'river-to-ocean', 'river-lod'] as const) {
      expect(parameterValue(resolved[key], 'flowmapDepthBiasM'), key).toBe(0.96);
      expect(parameterValue(resolved[key], 'flowmapDepthDensityPerM'), key).toBe(0.5);
      expect(parameterValue(resolved[key], 'flowmapSpeed'), key).toBe(0.002);
      expect(parameterValue(resolved[key], 'riverNormalTilingM'), key).toBe(15.36);
      expect(parameterValue(resolved[key], 'foamTilingM'), key).toBe(15.36);
    }
    expect(parameterValue(resolved.lake, 'simulationFoamContrast')).toBe(0.2);
    expect(parameterValue(resolved['lake-lod'], 'simulationFoamContrast')).toBe(0.2);
  });

  it('inherits the underside threshold independently of specular overrides', () => {
    const packageId = PackageId.parse('019fc0e7-1000-7000-8000-000000000004');
    if (!packageId.ok) throw packageId.error;
    const family = buildWaterMaterialFamily(packageId.value, 'material/water', {
      specular: 0.8,
      criticalAngleDot: 0.35,
      refractionBottomAmount: 0.25,
    });
    const table = Object.fromEntries(
      WATER_MATERIAL_FAMILY_KEYS.map((key) => [
        family.guids[key],
        family.outputs[`material/water/${key}`],
      ]),
    );
    for (const key of ['root', 'lake', 'ocean', 'custom', 'river-to-ocean'] as const) {
      const material = resolveMaterialAsset(family.guids[key], table).unwrap().asset;
      expect(material.parameters?.find(({ name }) => name === 'criticalAngleDot')?.type).toBe(
        'f32',
      );
      expect(parameterValue(material, 'specular'), key).toBe(0.8);
      expect(parameterValue(material, 'criticalAngleDot'), key).toBe(0.35);
      expect(parameterValue(material, 'refractionBottomAmount'), key).toBe(0.25);
    }
  });
});
