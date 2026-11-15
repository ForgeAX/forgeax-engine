import type { ShaderCatalog } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { resolveMaterialShaderArtifact } from '../assembly/material/assembly';
import { resolveMaterialShaderVariantSet } from '../assembly/material-shader-policy';
import {
  selectGpuDrivenSceneIndexVariant,
  selectHdrpPbrPrewarmVariants,
  selectProbePrewarmVariants,
  selectSkinPrewarmVariants,
} from '../assembly/shader-prewarm-policy';
import {
  type ReadyDeviceCapabilities,
  resolveEngineManifestEntries,
} from '../assembly/webgpu-ready-shaders';

describe('Engine manifest Water boot selection', () => {
  it.each([false, true])('selects Water draw axes only when explicitly requested: %s', (water) => {
    const variants = [true, false].map((value) => ({
      defines: {
        STORAGE_BUFFER_AVAILABLE: true,
        WATER_WAVES_AVAILABLE: value,
        WATER_INFO_RGBA16: value,
      },
    }));
    const requested = water ? 'WATER_WAVES_AVAILABLE=true+WATER_INFO_RGBA16=true' : undefined;
    const resolved = resolveMaterialShaderVariantSet(requested, variants, 'webgpu', true);
    if (water) expect(resolved).toBe('');
    else {
      expect(resolved).toContain('WATER_WAVES_AVAILABLE=false');
      expect(resolved).toContain('WATER_INFO_RGBA16=false');
    }
  });

  it.each([
    false,
    true,
  ])('keeps published direct draw source consistent with Water intent: %s', (water) => {
    const entry = { paramSchema: [] };
    const manifest = {
      variants: [true, false].map((value) => ({
        defines: { WATER_WAVES_AVAILABLE: value, WATER_INFO_RGBA16: value },
        definesKey: value ? '' : 'WATER_INFO_RGBA16=false+WATER_WAVES_AVAILABLE=false',
        composedWgsl: value ? 'water draw' : 'ordinary draw',
      })),
    };
    const shader = {
      findMaterialArtifact: () => ({ ok: true, value: entry }),
      materialShaderManifestEntry: () => manifest,
      materialProgram: (source: string) => {
        throw new Error(source);
      },
    } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];
    expect(() =>
      resolveMaterialShaderArtifact('game::mesh', shader, {
        address: 'direct',
        ...(water ? { variantSet: 'WATER_WAVES_AVAILABLE=true+WATER_INFO_RGBA16=true' } : {}),
      }),
    ).toThrow(water ? 'water draw' : 'ordinary draw');
  });
  it('keeps generic mesh prewarm selectors on their ordinary resource contract', () => {
    const variants = [true, false].flatMap((water) =>
      [true, false].flatMap((clustered) =>
        [true, false].map((probe) => ({
          definesKey: `${water}/${clustered}/${probe}`,
          composedWgsl: `${water}/${clustered}/${probe}`,
          defines: {
            STORAGE_BUFFER_AVAILABLE: true,
            CLUSTER_FORWARD_AVAILABLE: clustered,
            PROBE_BLEND_AVAILABLE: probe,
            GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true,
            SKINNING_DISABLED: false,
            WATER_WAVES_AVAILABLE: water,
            WATER_INFO_RGBA16: water,
          },
        })),
      ),
    );
    const entry = { variants } as Parameters<typeof selectSkinPrewarmVariants>[0];
    for (const selected of [
      selectSkinPrewarmVariants(entry, true),
      selectHdrpPbrPrewarmVariants(entry, true),
      selectProbePrewarmVariants(entry, true),
    ]) {
      expect(selected.length).toBeGreaterThan(0);
      expect(selected.every((v) => v.defines.WATER_WAVES_AVAILABLE === false)).toBe(true);
    }
    expect(
      selectGpuDrivenSceneIndexVariant(entry, true, true, true)?.defines.WATER_WAVES_AVAILABLE,
    ).toBe(false);
    expect(variants.filter((v) => v.defines.WATER_WAVES_AVAILABLE)).toHaveLength(4);
  });
  it.each([
    true,
    false,
  ])('keeps ordinary shadow layouts free of Water resources with storage=%s', (storageBuffer) => {
    const ordinary = {
      STORAGE_BUFFER_AVAILABLE: storageBuffer,
      SKINNING_DISABLED: true,
      WATER_WAVES_AVAILABLE: false,
      WATER_INFO_RGBA16: false,
    };
    const variants = [
      {
        defines: { ...ordinary, WATER_WAVES_AVAILABLE: true, WATER_INFO_RGBA16: true },
        definesKey: 'water',
        composedWgsl: 'water shadow',
      },
      { defines: ordinary, definesKey: 'ordinary', composedWgsl: 'ordinary shadow' },
    ];
    const shadow = {
      identifier: 'forgeax::default-shadow-caster',
      composedWgsl: 'canonical shadow',
      variants,
    };
    const registry = { materialShaderManifestEntries: () => [shadow] } as unknown as ShaderCatalog;
    const caps = {
      storageBuffer,
      atmosphere: false,
      extendedLighting: false,
      directionalPcss: false,
      projector: false,
    } as ReadyDeviceCapabilities;
    const resolved = resolveEngineManifestEntries(registry, [], 'null', caps);
    expect(resolved.shadowCaster?.wgsl).toBe('ordinary shadow');
    expect(shadow.variants).toBe(variants);
    expect(shadow.variants[0]?.composedWgsl).toBe('water shadow');
  });
});
